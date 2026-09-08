'use strict';

/**
 * Git operations for the trunk update path (#94): the fetch-and-reset, the
 * two discards, and the reads the card needs around them. No Electron
 * dependency, so `node --test` can exercise it against real repositories
 * (same rationale as npm-runner.js). Everything runs on the bundled Git:
 * reads through git-read.cjs (#384), writes through the primitives in
 * git-write.cjs (#385). Nothing here ever reaches a git found on the host.
 *
 * The fetch asks for no depth and no filter. Every site the update can reach
 * is either a partial clone the app made, whose own config
 * (`remote.origin.promisor`) keeps the fetch partial, or a full clone
 * adopted from disk; a site the old engine made is shallow and is refused
 * before this module is called (`legacySiteBlock` in main.js), so there is
 * no site left whose history a depth-less fetch would pull in.
 *
 * `ensureAutocrlf` / `createCrlfCompatibleFs` are still exported for
 * patch-apply.js and `sites:add`, the last callers on isomorphic-git; they
 * leave with the patch flow. Nothing in this file uses them any more.
 *
 * main.js owns the IPC plumbing and electron-store writes; the pure
 * status-row/oid decision rules live in git-update.cjs.
 */

const path = require('path');
const fs = require('fs');
const {
	isDirtyFromStatusMatrix,
	staleStagedPaths,
	lockfileChangedFromBlobOids,
	normalizeEolBuffer
} = require('./git-update.cjs');
const { readCommitInfo, resolveRef, currentBranch, isAncestor, statusRows, readBlobs, blobOid } = require('./git-read.cjs');
const { fetchBranch, unstagePaths, updateBranch, checkoutBranch, cleanUntracked } = require('./git-write.cjs');

/**
 * Give isomorphic-git a Windows-only, in-memory view of core.autocrlf=true
 * when the repository has no explicit local value. Native Git may have
 * checked the worktree out as CRLF because of the contributor's global config,
 * which isomorphic-git does not read; without this view, statusMatrix reports
 * roughly 5,000 phantom modifications (isomorphic-git#1275).
 *
 * The wrapper intercepts only reads of Git's config file. It never writes the
 * repository, and explicit local values (true, false, or input) pass through
 * unchanged. Non-Windows platforms use the original filesystem untouched.
 *
 * @param {string}    dir
 * @param {Object}    [options]
 * @param {string}    [options.platform]
 * @param {typeof fs} [options.fileSystem]
 * @param {Function}  [options.onError]
 * @return {typeof fs}
 */
function createCrlfCompatibleFs(dir, {
	platform = process.platform,
	fileSystem = fs,
	onError = (error) => process.emitWarning(
		`Could not provide CRLF compatibility for ${dir}: ${String(error && error.message ? error.message : error)}`,
		{ code: 'WCT_CRLF_CONFIG' }
	)
} = {}) {
	if (platform !== 'win32') return fileSystem;

	const dotGitPath = path.resolve(dir, '.git');
	let configPath = path.join(dotGitPath, 'config');
	const promises = Object.create(fileSystem.promises);
	Object.defineProperty(promises, 'readFile', {
		enumerable: true,
		value: async (filepath, options) => {
			let content;
			try {
				content = await fileSystem.promises.readFile(filepath, options);
			} catch (error) {
				if (path.resolve(String(filepath)) === configPath) onError(error);
				throw error;
			}
			const resolvedPath = path.resolve(String(filepath));
			if (resolvedPath === dotGitPath) {
				const gitdir = String(content).match(/^gitdir:\s*(.+)\s*$/im);
				if (gitdir) configPath = path.resolve(dir, gitdir[1].trim(), 'config');
				return content;
			}
			if (resolvedPath !== configPath) return content;

			const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
			let inCore = false;
			const hasAutocrlf = text.split(/\r?\n/).some((line) => {
				const section = line.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
				if (section) {
					inCore = section[1].trim().toLowerCase() === 'core';
					return false;
				}
				return inCore && /^\s*autocrlf\s*=/.test(line.toLowerCase());
			});
			if (hasAutocrlf) return content;

			const compatible = `${text.replace(/\s*$/, '')}\n[core]\n\tautocrlf = true\n`;
			return Buffer.isBuffer(content) ? Buffer.from(compatible, 'utf8') : compatible;
		}
	});
	const compatibleFs = Object.create(fileSystem);
	Object.defineProperty(compatibleFs, 'promises', { enumerable: true, value: promises });
	return compatibleFs;
}

async function ensureAutocrlf(dir, options) {
	return createCrlfCompatibleFs(dir, options);
}

/**
 * The commit the site's `trunk` branch points at; its committer date is the age
 * of the trunk snapshot. One object read, no network.
 *
 * Deliberately `trunk` and not `HEAD`: with ticket branches (#108) HEAD is a WIP
 * commit made minutes ago, so reading it would report the age of the
 * contributor's own work and the staleness dot would never light up. Falls back
 * to HEAD only for a repository with no `trunk` branch, which the app never
 * creates but a site adopted from disk can be.
 *
 * @param {string} dir
 */
async function readTrunkInfo(dir) {
	let info;
	try {
		info = await readCommitInfo(dir, 'refs/heads/trunk');
	} catch {
		info = await readCommitInfo(dir, 'HEAD');
	}
	return { trunkOid: info.oid, trunkDate: info.date };
}

async function readLockfileBlobOid(dir, oid) {
	try {
		return await blobOid(dir, oid, 'package-lock.json');
	} catch {
		return null;
	}
}

// Git's autocrlf handling is byte-based, but on macOS and Linux the app runs
// with no autocrlf at all, so a file a native-git checkout smudged to CRLF
// still reports as modified there. Confirm with a byte-level,
// encoding-agnostic comparison against the blob HEAD holds.
async function isCrlfOnlyChange(dir, filepath, headBlob) {
	if (!headBlob) return false;
	try {
		const work = await fs.promises.readFile(path.join(dir, filepath));
		return normalizeEolBuffer(headBlob).equals(normalizeEolBuffer(work));
	} catch {
		return false;
	}
}

/**
 * The files that genuinely differ from HEAD — status candidates minus
 * CRLF-only false positives. What this returns is what the dirty-tree dialog
 * lists, and it matches what patch generation would emit.
 *
 * @param {string} dir
 */
async function collectDirtyFiles(dir) {
	const matrix = await statusRows(dir);
	const headOid = await resolveRef(dir, 'HEAD');
	const { rows } = isDirtyFromStatusMatrix(matrix);
	const modified = rows.filter(([, head, workdir]) => head === 1 && workdir === 2).map(([filepath]) => filepath);
	// One spawn for every candidate blob rather than one per file.
	const headBlobs = headOid ? await readBlobs(dir, headOid, modified) : new Map();
	const files = [];
	for (const [filepath, head, workdir] of rows) {
		if (head === 1 && workdir === 2 && await isCrlfOnlyChange(dir, filepath, headBlobs.get(filepath))) continue;
		files.push(filepath);
	}
	return files;
}

/**
 * The forced checkout of the current branch followed by a clean: what both
 * discards end with. The checkout resets every tracked file and drops from
 * the index (and the disk) what was staged but is not in HEAD, the residue
 * patch generation leaves; the clean then removes what is untracked and not
 * ignored. In that order: a file that is only staged is invisible to
 * `clean` until the checkout has unstaged it. Ignored files (`node_modules`,
 * `build`) are not Git's to touch and survive both.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {Function} [options.onChild]
 * @return {Promise<string>} The branch that was reset.
 */
async function resetWorktree(dir, { onChild = null } = {}) {
	const ref = (await currentBranch(dir)) || 'trunk';
	await checkoutBranch(dir, ref, { onChild });
	await cleanUntracked(dir);
	return ref;
}

/**
 * Resets the worktree to HEAD. Files absent from HEAD are removed from the
 * index AND the workdir — a "discard" that leaves new files behind would put
 * them straight back into the next patch.
 *
 * Checks out whatever branch is current rather than `trunk` by name: with
 * ticket branches (#108) that would silently move the contributor to another
 * ticket. Discarding means "throw away my uncommitted edits", so parked work on
 * the branch survives — destroying a whole ticket is what deleting its branch
 * is for.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {Function} [options.onChild] Handed the checkout's ChildProcess.
 */
async function discardChanges(dir, { onChild = null } = {}) {
	await resetWorktree(dir, { onChild });
}

/**
 * Discards everything the patch modal shows — the whole diff against `baseOid`,
 * not just the uncommitted edits `discardChanges` rewinds. On a ticket branch
 * the modal measures from the branch point (#108/#239), so its "your changes"
 * includes the parked WIP commit; rewinding the branch ref to `baseOid` before
 * the forced checkout throws that commit away too, leaving the tree at the base
 * with "No changes" to show.
 *
 * Kept separate from `discardChanges` on purpose: the trunk-update dirty flow
 * and the switch-off-trunk flow must reset only uncommitted edits and preserve
 * parked ticket work, so they stay on `discardChanges`. This one is the modal's
 * "Discard all changes", where the contributor has asked for the whole thing to
 * go. The branch is not deleted and the ticket stays linked — the substrate
 * survives, only its work is rewound; deleting the branch is what "Delete this
 * ticket's work" is for.
 *
 * @param {string}   dir
 * @param {string}   baseOid           The commit the modal diffed against — the branch point.
 * @param {Object}   [options]
 * @param {Function} [options.onChild] Handed the checkout's ChildProcess.
 */
async function discardToBase(dir, baseOid, { onChild = null } = {}) {
	const ref = (await currentBranch(dir)) || 'trunk';
	// Only rewind the ref when baseOid really is this branch's own history — its
	// point off trunk. A caller can hand over a commit that is not an ancestor of
	// HEAD; moving the ref onto it would orphan the branch's commits and
	// re-point it at unrelated work. When it is not an ancestor, or not a commit
	// this repository has, leave the ref alone and just reset the worktree to
	// HEAD — the uncommitted-only discard, which never throws away committed work.
	const head = await resolveRef(dir, 'HEAD');
	let rewind = false;
	if (baseOid !== head) {
		try { rewind = await isAncestor(dir, baseOid, head); } catch { rewind = false; }
	}
	if (rewind) {
		await updateBranch(dir, ref, baseOid);
	}
	await resetWorktree(dir, { onChild });
}

/**
 * Step 1 of the update chain: fetch the latest remote trunk and hard-reset
 * the site to it. Returns { upToDate, oldOid, newOid, lockfileChanged,
 * trunkDate }; throws with `error.stage` set to 'fetch' (nothing moved —
 * plain failure) or 'checkout' (HEAD moved over a partial tree — the caller
 * must persist the incomplete state).
 *
 * A thrown error also carries `error.worktreeReset`, true only once the forced
 * checkout has actually begun. `stage` is deliberately coarser: it covers the
 * index and ref work that precedes the checkout, and a caller that treats it as
 * "the working tree was reset" would discard state — an applied patch's record
 * — over a failure that touched no file.
 *
 * The fetch reads the checkout's own `origin` (#359): a site adopted from a
 * fork updates from that fork, and no URL is fixed here. Git's own progress
 * lines go to `onLog` as they are printed. The forced checkout resets tracked
 * files while untracked ones survive.
 *
 * @param {Object}   root0
 * @param {string}   root0.dir
 * @param {Function} [root0.onLog]
 * @param {Function} [root0.onChild] Handed the fetch's and the checkout's ChildProcess.
 */
async function updateToLatestTrunk({ dir, onLog = () => {}, onChild = null }) {
	let stage = 'fetch';
	let worktreeReset = false;
	try {
		const oldOid = await resolveRef(dir, 'HEAD');
		onLog('Fetching latest trunk…\n');
		const { oid: newOid } = await fetchBranch(dir, 'origin', 'trunk', { onStderr: onLog, onChild });

		if (newOid === oldOid) {
			const { trunkDate } = await readTrunkInfo(dir);
			onLog('\nAlready up to date.\n');
			return { upToDate: true, oldOid, newOid, lockfileChanged: false, trunkDate };
		}

		// Decide the install step before touching the worktree.
		const lockfileChanged = lockfileChangedFromBlobOids(
			await readLockfileBlobOid(dir, oldOid),
			await readLockfileBlobOid(dir, newOid)
		);

		stage = 'checkout';
		// Patch generation stages untracked files and never unstages them; a
		// forced checkout deletes workdir files that are in the index but
		// absent from the target tree, so drop those index entries first
		// (index-only — the workdir files survive).
		await unstagePaths(dir, staleStagedPaths(await statusRows(dir)));
		onLog(`\nResetting to latest trunk (${newOid.slice(0, 7)})…\n`);
		// `expected` makes a trunk that moved under this update (a second
		// writer) a loud failure with the tree untouched, not an overwrite.
		await updateBranch(dir, 'trunk', newOid, { expected: oldOid });
		// Everything above this line can fail with the working tree untouched —
		// the status walks a 5k-file checkout and update-ref only moves a ref.
		// From here on, files are being overwritten, so anything the tree used to
		// hold (an applied patch) has to be assumed gone even if the call throws.
		worktreeReset = true;
		await checkoutBranch(dir, 'trunk', {
			onChild,
			onProgress: (evt) => onLog(`${evt.phase || 'checkout'} ${evt.loaded || 0}/${evt.total || 0}\r`)
		});

		const { trunkDate } = await readTrunkInfo(dir);
		onLog(`\nNow on trunk as of ${trunkDate}.\n`);
		return { upToDate: false, oldOid, newOid, lockfileChanged, trunkDate };
	} catch (e) {
		if (e && typeof e === 'object') {
			e.stage = stage;
			e.worktreeReset = worktreeReset;
		}
		throw e;
	}
}

module.exports = {
	ensureAutocrlf,
	createCrlfCompatibleFs,
	readTrunkInfo,
	collectDirtyFiles,
	discardChanges,
	discardToBase,
	updateToLatestTrunk
};
