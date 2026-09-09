'use strict';

/**
 * Git operations for the trunk update path (#94). No Electron dependency, so
 * `node --test` can exercise it against real repositories (same rationale as
 * npm-runner.js). Reads go through the bundled Git (git-read.cjs, #384);
 * the writes below still run on isomorphic-git until #385 moves them, flow
 * by flow. Nothing here ever reaches a git found on the host.
 *
 * main.js owns the IPC plumbing and electron-store writes; the pure
 * status-row/oid decision rules live in git-update.cjs.
 */

const path = require('path');
const fs = require('fs');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const {
	isDirtyFromStatusMatrix,
	staleStagedPaths,
	lockfileChangedFromBlobOids,
	normalizeEolBuffer
} = require('./git-update.cjs');
const { readCommitInfo, resolveRef, statusRows, readBlobs, blobOid } = require('./git-read.cjs');

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
 * @param {string} dir
 */
async function discardChanges(dir) {
	const gitFs = await ensureAutocrlf(dir);
	const matrix = await git.statusMatrix({ fs: gitFs, dir });
	for (const [filepath, head, workdir] of matrix) {
		if (head === 0) {
			try { await git.remove({ fs: gitFs, dir, filepath }); } catch {}
			if (workdir !== 0) {
				try { await fs.promises.unlink(path.join(dir, filepath)); } catch {}
			}
		}
	}
	const ref = (await git.currentBranch({ fs: gitFs, dir, fullname: false })) || 'trunk';
	await git.checkout({ fs: gitFs, dir, ref, force: true });
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
 * @param {string} dir
 * @param {string} baseOid The commit the modal diffed against — the branch point.
 */
async function discardToBase(dir, baseOid) {
	const gitFs = await ensureAutocrlf(dir);
	const matrix = await git.statusMatrix({ fs: gitFs, dir });
	for (const [filepath, head, workdir] of matrix) {
		if (head === 0) {
			try { await git.remove({ fs: gitFs, dir, filepath }); } catch {}
			if (workdir !== 0) {
				try { await fs.promises.unlink(path.join(dir, filepath)); } catch {}
			}
		}
	}
	const ref = (await git.currentBranch({ fs: gitFs, dir, fullname: false })) || 'trunk';
	// Only rewind the ref when baseOid really is this branch's own history — its
	// point off trunk. A caller can hand over a commit that is not an ancestor of
	// HEAD; moving the ref onto it would
	// orphan the branch's commits and re-point it at unrelated work. When it is
	// not an ancestor, leave the ref alone and just reset the worktree to HEAD —
	// the uncommitted-only discard, which never throws away committed work.
	const head = await git.resolveRef({ fs: gitFs, dir, ref: 'HEAD' });
	let rewind = false;
	if (baseOid !== head) {
		try { rewind = await git.isDescendent({ fs: gitFs, dir, oid: head, ancestor: baseOid }); } catch { rewind = false; }
	}
	if (rewind) {
		await git.writeRef({ fs: gitFs, dir, ref: `refs/heads/${ref}`, value: baseOid, force: true });
	}
	await git.checkout({ fs: gitFs, dir, ref, force: true });
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
 * Shallow-clone safe: a depth-1 re-fetch negotiates a new shallow tip, and
 * the forced checkout resets tracked files while untracked ones survive.
 *
 * @param {Object}   root0
 * @param {string}   root0.dir
 * @param {string}   root0.url
 * @param {Function} [root0.onLog]
 */
async function updateToLatestTrunk({ dir, url, onLog = () => {} }) {
	const gitFs = await ensureAutocrlf(dir);
	let stage = 'fetch';
	let worktreeReset = false;
	try {
		const oldOid = await git.resolveRef({ fs: gitFs, dir, ref: 'HEAD' });
		onLog('Fetching latest trunk…\n');
		const fetchResult = await git.fetch({
			fs: gitFs, http, dir, url,
			ref: 'trunk',
			singleBranch: true,
			depth: 1,
			tags: false,
			onProgress: (evt) => onLog(`${evt.phase || 'fetch'} ${evt.loaded || 0}/${evt.total || 0}\r`)
		});
		let newOid = fetchResult && fetchResult.fetchHead;
		if (!newOid) newOid = await git.resolveRef({ fs: gitFs, dir, ref: 'refs/remotes/origin/trunk' });

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
		// Patch generation stages untracked files and never unstages them;
		// checkout({force}) deletes workdir files that are in the index but
		// absent from the target tree, so drop those index entries first
		// (index-only — the workdir files survive).
		const matrix = await git.statusMatrix({ fs: gitFs, dir });
		for (const filepath of staleStagedPaths(matrix)) {
			try { await git.remove({ fs: gitFs, dir, filepath }); } catch {}
		}
		onLog(`\nResetting to latest trunk (${newOid.slice(0, 7)})…\n`);
		await git.writeRef({ fs: gitFs, dir, ref: 'refs/heads/trunk', value: newOid, force: true });
		// Everything above this line can fail with the working tree untouched —
		// statusMatrix walks a 5k-file checkout and writeRef only moves a ref.
		// From here on, files are being overwritten, so anything the tree used to
		// hold (an applied patch) has to be assumed gone even if the call throws.
		worktreeReset = true;
		await git.checkout({
			fs: gitFs, dir, ref: 'trunk', force: true,
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
