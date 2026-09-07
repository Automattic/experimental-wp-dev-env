'use strict';

/**
 * Ticket branches (#108). A site is the expensive shared substrate — the clone,
 * `node_modules`, the build output — and a ticket is a cheap branch on top of
 * it. Switching tickets parks the current work, swaps the worktree, and leaves
 * the substrate untouched, so starting a second ticket costs seconds instead of
 * another clone and another install.
 *
 * No Electron dependency, so `node --test` can exercise it against real
 * repositories (same rationale as trunk-update.js). Everything here runs on
 * the bundled Git: reads through git-read.cjs (#384), writes through the
 * primitives in git-write.cjs (#385). main.js owns the IPC plumbing and the
 * electron-store writes.
 *
 * Two invariants hold everything else up:
 *
 * 1. **`trunk` is never committed to.** It stays the pristine snapshot every
 *    branch is diffed against. Work that starts on trunk is carried into a
 *    ticket branch instead (the branch is created and HEAD pointed at it
 *    without a checkout, so uncommitted edits come along for free).
 *
 * 2. **A ticket branch carries exactly one WIP commit**, always reparented onto
 *    the branch point. Parking writes the commit with `commit-tree -p baseOid`
 *    and moves the branch ref onto it, rather than committing onto the previous
 *    WIP commit, so re-parking rewrites that single commit instead of stacking
 *    a pile of saves the user never asked for — the history-nobody-asked-for
 *    risk #108 flags at the end.
 */

const { mapCheckoutPhase } = require('./switch-progress.cjs');
const { currentBranch, listBranches, resolveRef, statusRows, changesAgainst } = require('./git-read.cjs');
const { stagePaths, writeTree, commitTree, updateBranch, createBranchAt, pointHeadAt, deleteBranch, checkoutBranch } = require('./git-write.cjs');

/** The pristine snapshot branch. Never committed to, never deleted. */
const TRUNK = 'trunk';

/**
 * The one commit on a ticket branch. The message is never shown to the user —
 * the app's deliverable is a patch, not a history — but it makes the state
 * legible to anyone who opens the site in a real git client.
 */
const WIP_MESSAGE = 'Work in progress (WordPress Contributor Toolkit)';

/**
 * A commit needs an author, and there is no host `git config` to read one
 * from — a contributor having no git installed is the entire premise of the
 * app, and the bundled Git reads no host config either (git-binary.cjs). These
 * commits never leave the disk: the deliverable is the patch, and its real
 * author is the name on the Trac ticket.
 */
const WIP_AUTHOR = { name: 'WordPress Contributor Toolkit', email: 'noreply@localhost' };

/**
 * Branch name for a ticket. Trac ids are numeric, so this cannot collide with
 * `trunk` and needs no escaping.
 *
 * @param {number|string} ticketId
 */
function ticketBranchRef(ticketId) {
	return `ticket/${ticketId}`;
}

/**
 * The ticket id a branch name encodes, or null for anything else (`trunk`, or a
 * branch a user made by hand in their own git client).
 *
 * @param {string} ref
 */
function ticketIdFromRef(ref) {
	const match = /^ticket\/(\d+)$/.exec(String(ref || ''));
	return match ? Number(match[1]) : null;
}

/**
 * The checked-out branch name, or null in a detached HEAD — which the app never
 * creates, but a user poking at the site with their own git client can.
 *
 * @param {string} dir
 */
async function currentBranchName(dir) {
	return currentBranch(dir);
}

/**
 * Every branch in the site except `trunk`, newest-irrelevant order (the caller
 * sorts by its own `lastUsedAt`, which is what the switcher shows).
 *
 * @param {string} dir
 */
async function listTicketBranches(dir) {
	const branches = await listBranches(dir);
	return branches.filter((ref) => ref !== TRUNK);
}

/**
 * The trunk tip, which every ticket branches from and every patch is measured
 * against. A site with no `trunk` is one the app did not make and cannot work
 * in; that is an error with a code, not a null to trip over later.
 *
 * @param {string} dir
 */
async function trunkOid(dir) {
	const oid = await resolveRef(dir, TRUNK);
	if (!oid) {
		const error = new Error('This site has no trunk branch');
		error.code = 'no-trunk';
		throw error;
	}
	return oid;
}

/**
 * Brings the index in line with the worktree: modified and untracked files
 * staged, deleted files removed. Deletions are the half the patch generator has
 * always dropped (#85) — here they have to work, or a file a contributor
 * removed would come back on the next switch.
 *
 * Only the rows the scan returned are handed to Git, so gitignored paths never
 * enter the index no matter how large `node_modules` and `build/` have grown,
 * and the machine-local excludes main.js writes stay excluded.
 *
 * @param {string}   dir
 * @param {Array}    [matrix]     status rows the caller already computed
 * @param {Function} [onProgress] told how far the staging has got (#173)
 */
async function stageWorktree(dir, matrix = null, onProgress = null) {
	// The caller has usually just scanned the worktree to decide whether there
	// was anything to park. On wordpress-develop that scan hashes thousands of
	// files, so it is passed in and reused rather than repeated.
	if (!matrix) matrix = await statusRows(dir);
	// The one stage of a park with a real total, and it comes free: the rows
	// worth staging are known before any of them is written. One `add` stages
	// them all, so the count moves from nothing to everything in one step.
	const pending = matrix.filter(([, head, workdir, stage]) => !(head === workdir && workdir === stage));
	if (onProgress) onProgress({ stage: 'stage', loaded: 0, total: pending.length });
	const staged = await stagePaths(dir, pending.map(([filepath]) => filepath));
	if (onProgress) onProgress({ stage: 'stage', loaded: staged, total: pending.length });
	return staged;
}

/**
 * Whether the worktree differs from the commit `ref` names. Used to decide
 * whether parking has anything to do, and to refuse a switch that would discard
 * uncommitted work sitting on trunk.
 *
 * @param {string} dir
 * @param {string} [ref]
 */
async function hasChangesAgainst(dir, ref = 'HEAD') {
	const { changed } = await scanWorktree(dir, ref);
	return changed;
}

/**
 * How many files differ from `ref` — the same scan, when the answer has to be
 * a number rather than a yes.
 *
 * Used where loose work is about to be carried into a new ticket branch (#108):
 * the app moves it silently otherwise, and "your 3 changes came with you" is
 * the difference between that reading as a feature and as a loss.
 *
 * @param {string} dir
 * @param {string} [ref]
 * @return {Promise<number>} Count of differing paths, gitignored ones excluded.
 */
async function countChangesAgainst(dir, ref = 'HEAD') {
	const { matrix } = await scanWorktree(dir, ref);
	return matrix.filter(([, head, workdir]) => head !== workdir).length;
}

/**
 * One worktree scan, and what the callers need from it. Split out because the
 * scan is the expensive part of every park and every switch: Git hashes every
 * file whose stat data went stale, and wordpress-develop has thousands.
 *
 * Against HEAD it is `git status`, which also fills the index column
 * `stageWorktree` reads; against any other commit (a ticket's branch point,
 * once work is parked) it is `git diff <commit>` plus the untracked files.
 *
 * @param {string} dir
 * @param {string} [ref]
 */
async function scanWorktree(dir, ref = 'HEAD') {
	const matrix = ref === 'HEAD' ? await statusRows(dir) : await changesAgainst(dir, ref);
	return { matrix, changed: matrix.some(([, head, workdir]) => head !== workdir) };
}

/**
 * Commits the worktree onto the current ticket branch as its single WIP commit,
 * reparented onto `baseOid` so re-parking rewrites rather than stacks.
 *
 * A no-op when nothing changed, so switching away from a ticket the user only
 * read does not churn the branch. Refuses to run on `trunk` (invariant 1) —
 * work that starts there is carried into a branch by `startTicketBranch`, not
 * committed where every other branch's diff base lives.
 *
 * @param {string}   dir
 * @param {Object}   root0
 * @param {string}   [root0.baseOid]    branch point; resolved from `trunk` when absent
 * @param {Object}   [root0.author]
 * @param {Function} [root0.onProgress] told which stage of the park is running (#173)
 */
async function parkCurrentWork(dir, { baseOid, author = WIP_AUTHOR, onProgress = null } = {}) {
	const branch = await currentBranchName(dir);
	if (!branch || branch === TRUNK) {
		const error = new Error('Refusing to commit on trunk — it is the diff base for every ticket');
		error.code = 'trunk-is-read-only';
		throw error;
	}

	// Announced before the scan rather than after it: `git status` reports
	// nothing while it runs and is about a third of a switch, so this is the
	// stretch that would otherwise be silent — and the stretch during which the
	// contributor's edits are not committed anywhere yet.
	if (onProgress) onProgress({ stage: 'scan', from: branch });
	const { matrix, changed } = await scanWorktree(dir);
	if (!changed) return { parked: false, branch, oid: null };

	// Resolved rather than required so a branch whose baseOid was lost (a store
	// wiped by hand, a site adopted from disk) still parks against something
	// sane instead of throwing.
	const parent = baseOid || await trunkOid(dir);
	// Read before anything is written: the ref move below refuses if the
	// branch no longer points here, so a second writer in the same site (a
	// mentor's own client, say) fails loudly rather than being overwritten.
	const headOid = await resolveRef(dir, 'HEAD');
	// `from` added here rather than inside stageWorktree: staging is the
	// longest stretch of a park, and without it the sentence loses the ticket
	// number for exactly the seconds it most needs to name it.
	await stageWorktree(dir, matrix, onProgress && ((p) => onProgress({ from: branch, ...p })));
	if (onProgress) onProgress({ stage: 'commit', from: branch });
	// The tree the index now describes, one commit for it with exactly the
	// branch point as parent, and the branch moved onto that commit. HEAD, the
	// index and the worktree agree afterwards, so the checkout that usually
	// follows has nothing to preserve and nothing to lose.
	const tree = await writeTree(dir);
	const oid = await commitTree(dir, { tree, parent, message: WIP_MESSAGE, author });
	await updateBranch(dir, branch, oid, { expected: headOid || undefined });
	return { parked: true, branch, oid };
}

/**
 * Creates the branch for a ticket at the current trunk tip and checks it out,
 * returning the `baseOid` the caller must record — the diff base for every
 * patch this branch ever produces.
 *
 * Uncommitted work in the tree comes along: the branch is created at trunk's
 * commit and HEAD is pointed at it, with no checkout at all, so no file is
 * rewritten. That is why this is instant, why `node_modules` survives, and it
 * is deliberate — "I started editing, then realised which ticket this is" is
 * the common case, and the alternative would be to throw the edits away.
 *
 * @param {string}        dir
 * @param {number|string} ticketId
 */
async function startTicketBranch(dir, ticketId) {
	const ref = ticketBranchRef(ticketId);
	const existing = await listBranches(dir);
	if (existing.includes(ref)) {
		const error = new Error(`Already working on ticket #${ticketId} in this site`);
		error.code = 'branch-exists';
		throw error;
	}
	const baseOid = await trunkOid(dir);
	await createBranchAt(dir, ref, TRUNK);
	await pointHeadAt(dir, ref);
	return { ref, baseOid, ticketId: ticketIdFromRef(ref) };
}

/**
 * Parks the current ticket and checks out `ref`.
 *
 * The guard that matters: leaving *trunk* while it is dirty. Parking cannot
 * rescue that work (invariant 1) and a forced checkout would overwrite it, so
 * this refuses with `code: 'dirty-trunk'` and lets the caller offer the two
 * honest options — start a ticket for the work, or discard it. Silently
 * destroying edits is the one outcome this feature must never produce.
 *
 * Progress (#173) is reported through `onProgress` in this module's own
 * vocabulary — `scan`, `stage`, `commit`, then the checkout's own phase mapped
 * by switch-progress.cjs. The scans are announced before they start, because
 * `git status` says nothing while it runs and is roughly a third of a switch.
 *
 * `deleteTicketBranch` checks out too and is deliberately left silent: it runs
 * under a different busy flag in the panel, so covering it would mean a second
 * progress surface for a rarely-used destructive action.
 *
 * @param {string}   dir
 * @param {string}   ref
 * @param {Object}   [root0]
 * @param {string}   [root0.baseOid]    branch point of the branch being left
 * @param {Object}   [root0.author]
 * @param {Function} [root0.onProgress] told which stage is running (#173)
 * @param {Function} [root0.onChild]    handed the checkout's ChildProcess, so
 *                                      a quit can end it (killChildTree)
 */
async function switchToBranch(dir, ref, { baseOid, author = WIP_AUTHOR, onProgress = null, onChild = null } = {}) {
	const from = await currentBranchName(dir);
	if (from === ref) return { switched: false, from, to: ref, parked: false };

	const branches = await listBranches(dir);
	if (!branches.includes(ref)) {
		const error = new Error(`No such branch: ${ref}`);
		error.code = 'no-such-branch';
		throw error;
	}

	// Every payload carries where the switch is going, so the panel can name the
	// destination without tracking it separately; the park stages add where it
	// came from, which is the ticket whose work is being saved.
	const report = onProgress ? (p) => onProgress({ to: ref, ...p }) : null;

	let parked = false;
	if (from === TRUNK) {
		// A full scan that usually ends in "nothing to do" and occasionally in a
		// refusal — silent either way without this.
		if (report) report({ stage: 'scan', from });
		if (await hasChangesAgainst(dir)) {
			const error = new Error('Uncommitted work on trunk would be lost by switching');
			error.code = 'dirty-trunk';
			throw error;
		}
	} else if (from) {
		({ parked } = await parkCurrentWork(dir, { baseOid, author, onProgress: report }));
	}

	// Tagged with the stage it died in, the same contract updateToLatestTrunk
	// uses, because the two halves fail very differently.
	//
	// Git writes HEAD only after every file operation has succeeded. A failure
	// part-way — an EPERM on Windows from an editor or an antivirus holding a
	// file is the realistic trigger — therefore leaves HEAD on the branch we
	// are leaving, over a half-swapped worktree. Parking again in that state
	// would commit the mixed tree over the good WIP commit and, because parking
	// rewrites rather than appends, put the real work out of reach. The caller
	// has to record that and refuse to park until it is reconciled.
	try {
		await checkoutBranch(dir, ref, {
			...(report ? { onProgress: (p) => report(mapCheckoutPhase(p)) } : {}),
			...(onChild ? { onChild } : {})
		});
	} catch (e) {
		if (e && typeof e === 'object') {
			e.stage = 'checkout';
			e.from = from;
			e.to = ref;
		}
		throw e;
	}
	if (report) report({ stage: 'done', from });
	return { switched: true, from, to: ref, parked };
}

/**
 * Deletes a ticket branch and everything committed on it — the "delete this
 * ticket's work" action, which under this model is a branch deletion and not a
 * site reset (#108).
 *
 * Refuses `trunk` outright: it is the diff base for every other branch and the
 * only thing standing between the user and a re-clone. Same shape of guard as
 * `isRegisteredSite` in site-registry.js, and for the same reason — the
 * destructive call gets a boundary in front of it rather than trusting callers.
 *
 * @param {string}   dir
 * @param {string}   ref
 * @param {Object}   [root0]
 * @param {Function} [root0.onChild] handed the checkout's ChildProcess, if one runs
 */
async function deleteTicketBranch(dir, ref, { onChild = null } = {}) {
	if (ref === TRUNK || ticketIdFromRef(ref) === null) {
		const error = new Error(`Refusing to delete ${ref === TRUNK ? 'trunk' : 'a branch the app did not create'}`);
		error.code = 'not-a-ticket-branch';
		throw error;
	}
	const branches = await listBranches(dir);
	if (!branches.includes(ref)) {
		const error = new Error(`No such branch: ${ref}`);
		error.code = 'no-such-branch';
		throw error;
	}

	// Leaving the branch checked out while deleting it would strand HEAD on a
	// ref that no longer exists; going to trunk first also restores the worktree
	// the user expects to be looking at afterwards. The checkout is forced
	// because the branch being discarded is dirty by definition.
	if (await currentBranchName(dir) === ref) {
		await checkoutBranch(dir, TRUNK, onChild ? { onChild } : {});
	}
	await deleteBranch(dir, ref);
	return { deleted: true, ref };
}

module.exports = {
	TRUNK,
	WIP_MESSAGE,
	WIP_AUTHOR,
	ticketBranchRef,
	ticketIdFromRef,
	currentBranchName,
	listTicketBranches,
	stageWorktree,
	scanWorktree,
	hasChangesAgainst,
	countChangesAgainst,
	parkCurrentWork,
	startTicketBranch,
	switchToBranch,
	deleteTicketBranch
};
