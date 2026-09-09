'use strict';

// Integration tests for src/ticket-branches.js (#108) against real on-disk
// repositories — no mocking of either engine, same as the trunk-update suite.
// The fixture is built by isomorphic-git; the bundled Git reads it (#384) and
// now writes it too (#385), and isomorphic-git reads back what the binary
// wrote. That is the two-engine agreement check in both directions: a site
// the old engine made keeps working, and what the new one writes is a
// repository the old one still understands.
//
// The fixture mirrors what a site actually looks like: a `trunk` branch holding
// a wordpress-develop-shaped tree, plus a gitignored `node_modules` standing in
// for the expensive substrate a ticket switch must never touch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const git = require('isomorphic-git');
const {
	TRUNK,
	WIP_AUTHOR,
	WIP_MESSAGE,
	ticketBranchRef,
	ticketIdFromRef,
	currentBranchName,
	listTicketBranches,
	hasChangesAgainst,
	parkCurrentWork,
	startTicketBranch,
	switchToBranch,
	deleteTicketBranch,
	resumeSwitch,
	rebaseOntoTrunk
} = require('../../src/ticket-branches.js');
const { describeSwitchProgress } = require('../../src/switch-progress.cjs');
const { git: bundledGit, tempDir } = require('./helpers/git.cjs');

const AUTHOR = { name: 'test', email: 'test@example.com' };

async function makeSite(t) {
	// tempDir rather than a bare rmSync: the binary writes its objects
	// read-only, and on Windows rmSync answers that with EPERM (#381).
	const dir = tempDir(t, 'ticket-branches-test-');
	await git.init({ fs, dir, defaultBranch: TRUNK });
	// The shape the clone writes (git-clone.cjs): a site the app supports has
	// core.autocrlf pinned, so the binary's checkout writes LF on Windows too
	// and the byte-for-byte assertions mean the same on every platform.
	await git.setConfig({ fs, dir, path: 'core.autocrlf', value: false });
	fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nbuild/\n');
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // trunk\n');
	fs.writeFileSync(path.join(dir, 'doomed.php'), '<?php // to be deleted\n');
	await git.add({ fs, dir, filepath: ['.gitignore', 'wp-login.php', 'doomed.php'] });
	const baseOid = await git.commit({ fs, dir, message: 'trunk', author: AUTHOR });

	// The substrate: gitignored, expensive, and must survive every switch.
	fs.mkdirSync(path.join(dir, 'node_modules', 'react'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'node_modules', 'react', 'index.js'), 'expensive\n');
	return { dir, baseOid };
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const exists = (dir, file) => fs.existsSync(path.join(dir, file));

test('ticketBranchRef/ticketIdFromRef round-trip, and trunk is not a ticket (issue #108)', () => {
	assert.equal(ticketBranchRef(59234), 'ticket/59234');
	assert.equal(ticketIdFromRef('ticket/59234'), 59234);
	assert.equal(ticketIdFromRef(TRUNK), null);
	assert.equal(ticketIdFromRef('ticket/not-a-number'), null);
	assert.equal(ticketIdFromRef(undefined), null);
});

test('starting a ticket carries uncommitted work onto the new branch (issue #108)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	// "I started editing, then realised which ticket this is."
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // my fix\n');

	const started = await startTicketBranch(dir, 59234);
	assert.equal(started.ref, 'ticket/59234');
	assert.equal(started.baseOid, baseOid);
	assert.equal(await currentBranchName(dir), 'ticket/59234');
	assert.equal(read(dir, 'wp-login.php'), '<?php // my fix\n');
});

test('a second ticket on the same site refuses rather than clobbering the first (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	await startTicketBranch(dir, 59234);
	await assert.rejects(() => startTicketBranch(dir, 59234), (e) => e.code === 'branch-exists');
});

test('switching tickets and back restores files, including a deletion (issue #108)', async (t) => {
	const { dir, baseOid } = await makeSite(t);

	// Ticket one: edit a file, add a new one, delete a third.
	const first = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // ticket 59234\n');
	fs.writeFileSync(path.join(dir, 'new-file.php'), '<?php // brand new\n');
	fs.unlinkSync(path.join(dir, 'doomed.php'));

	// Ticket two: start from trunk, so it must see none of the above.
	await switchToBranch(dir, TRUNK, { baseOid: first.baseOid });
	const second = await startTicketBranch(dir, 61002);
	assert.equal(read(dir, 'wp-login.php'), '<?php // trunk\n');
	assert.equal(exists(dir, 'new-file.php'), false, 'ticket one\'s new file must not leak');
	assert.equal(exists(dir, 'doomed.php'), true, 'ticket one\'s deletion must not leak');
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // ticket 61002\n');

	// Back to ticket one: every one of the three edits returns.
	await switchToBranch(dir, first.ref, { baseOid: second.baseOid });
	assert.equal(read(dir, 'wp-login.php'), '<?php // ticket 59234\n');
	assert.equal(read(dir, 'new-file.php'), '<?php // brand new\n');
	assert.equal(exists(dir, 'doomed.php'), false, 'the deletion must survive the round trip');

	// And ticket two is still intact.
	await switchToBranch(dir, second.ref, { baseOid: first.baseOid });
	assert.equal(read(dir, 'wp-login.php'), '<?php // ticket 61002\n');
	assert.equal(baseOid, first.baseOid, 'both tickets branch from the same trunk snapshot');
});

test('the gitignored substrate survives every switch (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	const dep = path.join('node_modules', 'react', 'index.js');

	const first = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	await switchToBranch(dir, TRUNK, { baseOid: first.baseOid });
	const second = await startTicketBranch(dir, 61002);
	await switchToBranch(dir, first.ref, { baseOid: second.baseOid });

	assert.equal(read(dir, dep), 'expensive\n', 'node_modules must never be rewritten by a switch');
	// It must also stay out of the branch itself, or every switch would carry it.
	const tracked = await git.listFiles({ fs, dir, ref: first.ref });
	assert.equal(tracked.some((f) => f.startsWith('node_modules/')), false);
});

test('parking is idempotent: re-parking rewrites one WIP commit, never stacks (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	const { ref, baseOid } = await startTicketBranch(dir, 59234);

	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // first pass\n');
	const one = await parkCurrentWork(dir, { baseOid, author: AUTHOR });
	assert.equal(one.parked, true);

	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // second pass\n');
	const two = await parkCurrentWork(dir, { baseOid, author: AUTHOR });
	assert.equal(two.parked, true);
	assert.notEqual(one.oid, two.oid, 'the WIP commit is rewritten, not reused');

	const log = await git.log({ fs, dir, ref });
	assert.equal(log.length, 2, 'exactly one WIP commit on top of the branch point');
	assert.equal(log[0].commit.parent[0], baseOid, 'always reparented onto the branch point');
});

test('parking a tree with no changes does nothing (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	const { ref, baseOid } = await startTicketBranch(dir, 59234);
	const result = await parkCurrentWork(dir, { baseOid, author: AUTHOR });
	assert.equal(result.parked, false);
	assert.equal(result.oid, null);
	assert.equal((await git.log({ fs, dir, ref })).length, 1, 'no empty WIP commit was created');
});

test('trunk is never committed to — it is every branch\'s diff base (issue #108)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // loose work on trunk\n');
	await assert.rejects(
		() => parkCurrentWork(dir, { baseOid, author: AUTHOR }),
		(e) => e.code === 'trunk-is-read-only'
	);
	assert.equal((await git.log({ fs, dir, ref: TRUNK })).length, 1);
});

test('switching away from a dirty trunk refuses instead of destroying the work (issue #108)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	await switchToBranch(dir, TRUNK, { baseOid });

	// Work made on trunk cannot be parked, and checkout({force}) would eat it.
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // unsaved\n');
	await assert.rejects(() => switchToBranch(dir, ref, { baseOid }), (e) => e.code === 'dirty-trunk');
	assert.equal(read(dir, 'wp-login.php'), '<?php // unsaved\n', 'the refused switch left the work alone');
});

test('a patch diffed against baseOid contains the ticket\'s work, WIP commit and all (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	const { baseOid } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // committed work\n');
	await parkCurrentWork(dir, { baseOid, author: AUTHOR });

	// The whole point of recording baseOid: against HEAD the parked work has
	// vanished into the commit and the patch would come out empty.
	assert.equal(await hasChangesAgainst(dir, 'HEAD'), false);
	assert.equal(await hasChangesAgainst(dir, baseOid), true);

	// Uncommitted edits on top must show up in the same diff as the parked ones.
	fs.writeFileSync(path.join(dir, 'later.php'), '<?php // not parked yet\n');
	const changed = (await git.statusMatrix({ fs, dir, ref: baseOid }))
		.filter(([, head, workdir]) => head !== workdir)
		.map(([filepath]) => filepath);
	assert.deepEqual(changed.sort(), ['later.php', 'wp-login.php']);
});

test('deleting a ticket branch drops its work and leaves the site on trunk (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	const { ref, baseOid } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // abandoned\n');
	await parkCurrentWork(dir, { baseOid, author: AUTHOR });

	await deleteTicketBranch(dir, ref);
	assert.equal(await currentBranchName(dir), TRUNK);
	assert.equal(read(dir, 'wp-login.php'), '<?php // trunk\n', 'trunk\'s content is restored');
	assert.deepEqual(await listTicketBranches(dir), []);
});

test('deleting refuses trunk and anything the app did not create (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	await git.branch({ fs, dir, ref: 'my-own-branch', object: TRUNK });

	await assert.rejects(() => deleteTicketBranch(dir, TRUNK), (e) => e.code === 'not-a-ticket-branch');
	await assert.rejects(() => deleteTicketBranch(dir, 'my-own-branch'), (e) => e.code === 'not-a-ticket-branch');
	await assert.rejects(() => deleteTicketBranch(dir, 'ticket/99999'), (e) => e.code === 'no-such-branch');

	const branches = await git.listBranches({ fs, dir });
	assert.equal(branches.includes(TRUNK), true);
	assert.equal(branches.includes('my-own-branch'), true);
});

test('listTicketBranches reports the tickets in the site, never trunk (issue #108)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	assert.deepEqual(await listTicketBranches(dir), []);
	await startTicketBranch(dir, 59234);
	await switchToBranch(dir, TRUNK, { baseOid });
	await startTicketBranch(dir, 61002);
	assert.deepEqual((await listTicketBranches(dir)).sort(), ['ticket/59234', 'ticket/61002']);
});

test('switching to the branch already checked out is a no-op (issue #108)', async (t) => {
	const { dir } = await makeSite(t);
	const { ref, baseOid } = await startTicketBranch(dir, 59234);
	const result = await switchToBranch(dir, ref, { baseOid });
	assert.equal(result.switched, false);
	assert.equal(result.parked, false);
});

test('switching to a branch that does not exist refuses (issue #108)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	await assert.rejects(
		() => switchToBranch(dir, 'ticket/12345', { baseOid }),
		(e) => e.code === 'no-such-branch'
	);
});

// --- progress while the worktree is swapped (issue #173) -------------------

// A switch is a worktree scan and a full checkout: seconds of silence on a real
// wordpress-develop, during which the window is indistinguishable from hung.
// The stages below are what the panel turns into a sentence, so their order and
// their presence is the contract — particularly the park stages, which cover
// the stretch where the contributor's edits are not committed anywhere yet.
test('switchToBranch reports every stage of a park and a checkout (issue #173)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	await startTicketBranch(dir, 59234);
	await switchToBranch(dir, TRUNK, { baseOid });
	await startTicketBranch(dir, 61002);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work on 61002\n');

	const seen = [];
	await switchToBranch(dir, ticketBranchRef(59234), { baseOid, author: AUTHOR, onProgress: (p) => seen.push(p) });

	const stages = seen.map((p) => p.stage);
	assert.ok(stages.includes('scan'), stages.join(','));
	assert.ok(stages.includes('stage'), stages.join(','));
	assert.ok(stages.includes('commit'), stages.join(','));
	assert.equal(stages.indexOf('scan') < stages.indexOf('stage'), true, 'the scan comes before what it feeds');
	assert.equal(stages.indexOf('stage') < stages.indexOf('commit'), true);
	assert.equal(stages[stages.length - 1], 'done', 'the line has to reach the end');
	// Where it is going, on every payload, so the panel need not track it.
	assert.equal(seen.every((p) => p.to === ticketBranchRef(59234)), true);
	// And where the work being saved came from.
	assert.equal(seen.find((p) => p.stage === 'commit').from, ticketBranchRef(61002));
	// The staging stage is the one with an honest total.
	const staging = seen.filter((p) => p.stage === 'stage');
	assert.ok(staging.length > 0);
	assert.equal(staging.every((p) => Number.isFinite(p.total) && p.total > 0), true);
	// And it is the longest stretch of the park, so it has to keep naming the
	// ticket — a sentence that drops to "Saving your work…" for most of the wait
	// is the one that fails to stop someone force-quitting.
	assert.equal(staging.every((p) => p.from === ticketBranchRef(61002)), true);
	assert.equal(
		seen.every((p) => describeSwitchProgress(p).length > 0),
		true,
		'every payload has to render as something'
	);
	assert.match(describeSwitchProgress(staging[0]), /#61002/);
});

// Nothing to park is the common case — switching away from a ticket you only
// read. The scan still runs and still costs, so it is still announced; the
// commit never happens and must not be claimed.
test('a clean branch reports the scan but never claims to commit (issue #173)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	await startTicketBranch(dir, 59234);
	await switchToBranch(dir, TRUNK, { baseOid });
	await startTicketBranch(dir, 61002);

	const seen = [];
	await switchToBranch(dir, ticketBranchRef(59234), { baseOid, onProgress: (p) => seen.push(p) });

	const stages = seen.map((p) => p.stage);
	assert.equal(stages[0], 'scan');
	assert.equal(stages.includes('commit'), false, 'nothing was committed, so nothing may say so');
	assert.equal(stages[stages.length - 1], 'done');
});

// Leaving trunk runs a full scan that usually ends in "nothing to do". Silent
// before this, and it is the same cost as any other scan.
test('leaving a clean trunk still reports its scan (issue #173)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	await startTicketBranch(dir, 59234);
	await switchToBranch(dir, TRUNK, { baseOid });

	const seen = [];
	await switchToBranch(dir, ticketBranchRef(59234), { baseOid, onProgress: (p) => seen.push(p) });

	assert.equal(seen[0].stage, 'scan');
	assert.equal(seen[0].from, TRUNK);
	assert.equal(seen[seen.length - 1].stage, 'done');
});

// A refused switch changed nothing, so it must not report a checkout it never
// ran, and must not say it is done.
test('a refused dirty-trunk switch reports the scan and stops there (issue #173)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	await startTicketBranch(dir, 59234);
	await switchToBranch(dir, TRUNK, { baseOid });
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // loose edits on trunk\n');

	const seen = [];
	await assert.rejects(
		() => switchToBranch(dir, ticketBranchRef(59234), { baseOid, onProgress: (p) => seen.push(p) }),
		(e) => e.code === 'dirty-trunk'
	);

	assert.deepEqual(seen.map((p) => p.stage), ['scan']);
});

// Progress is an addition, not a requirement: every existing caller passes no
// callback and must keep working.
test('a switch without a progress callback still works (issue #173)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');

	const result = await switchToBranch(dir, TRUNK, { baseOid, author: AUTHOR });

	assert.equal(result.switched, true);
	assert.equal(result.parked, true);
});

test('a detached HEAD, which only a user\'s own client makes, reads as no branch (issue #384)', async (t) => {
	const { dir } = await makeSite(t);
	assert.equal(await currentBranchName(dir), TRUNK);
	assert.equal(bundledGit(['checkout', '-q', '--detach'], dir).status, 0);
	assert.equal(await currentBranchName(dir), null);
});

test('a branch made by hand in a real git client shows up next to the app\'s own (issue #384)', async (t) => {
	const { dir } = await makeSite(t);
	await startTicketBranch(dir, 60001);
	assert.equal(bundledGit(['branch', 'ticket/60002'], dir).status, 0);
	assert.equal(bundledGit(['branch', 'experiment'], dir).status, 0);
	assert.deepEqual((await listTicketBranches(dir)).sort(), ['experiment', 'ticket/60001', 'ticket/60002']);
});

// --- what the bundled Git writes (issue #385) --------------------------------

test('the WIP commit carries the app\'s identity as author and committer, and its message (issue #385)', async (t) => {
	const { dir } = await makeSite(t);
	const { baseOid } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');

	const { oid } = await parkCurrentWork(dir, { baseOid });

	const { stdout } = bundledGit(['log', '-1', '--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%s', 'HEAD'], dir);
	assert.deepEqual(stdout.split('\0'), [oid, baseOid, WIP_AUTHOR.name, WIP_AUTHOR.email, WIP_AUTHOR.name, WIP_AUTHOR.email, WIP_MESSAGE]);
});

// A park is a commit of the whole worktree: afterwards HEAD, the index and the
// files on disk must agree, or the checkout that follows would have something
// to preserve and something to lose.
test('after a park the worktree is clean against HEAD, deletions included (issue #385)', async (t) => {
	const { dir } = await makeSite(t);
	const { baseOid } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	fs.writeFileSync(path.join(dir, 'added.php'), '<?php // added\n');
	fs.unlinkSync(path.join(dir, 'doomed.php'));

	await parkCurrentWork(dir, { baseOid });

	assert.equal(bundledGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], dir).stdout, '');
	assert.equal(bundledGit(['ls-tree', '--name-only', 'HEAD'], dir).stdout.split('\n').includes('doomed.php'), false, 'the deletion is in the commit');
});

// Status hands back raw names and `add` takes pathspecs, which glob unless
// told otherwise: a bracket or a star in a filename has to survive as itself.
test('files whose names look like globs, or hold spaces, are parked and restored literally (issue #385)', async (t) => {
	const { dir } = await makeSite(t);
	const first = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'weird[1].php'), '<?php // literal\n');
	fs.writeFileSync(path.join(dir, 'weird1.php'), '<?php // the glob would match this one too\n');
	fs.writeFileSync(path.join(dir, 'with space.php'), '<?php // spaced\n');

	await switchToBranch(dir, TRUNK, { baseOid: first.baseOid });
	assert.equal(exists(dir, 'weird[1].php'), false);
	assert.equal(exists(dir, 'with space.php'), false);
	await switchToBranch(dir, first.ref, { baseOid: first.baseOid });

	assert.equal(read(dir, 'weird[1].php'), '<?php // literal\n');
	assert.equal(read(dir, 'weird1.php'), '<?php // the glob would match this one too\n');
	assert.equal(read(dir, 'with space.php'), '<?php // spaced\n');
});

// Starting a ticket is a ref and a HEAD move, never a checkout: the index file
// is not rewritten, which is the cheapest proof that no file was either.
test('starting a ticket does not rewrite the index (issue #385)', async (t) => {
	const { dir } = await makeSite(t);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // loose\n');
	const before = fs.statSync(path.join(dir, '.git', 'index')).mtimeMs;

	await startTicketBranch(dir, 59234);

	assert.equal(fs.statSync(path.join(dir, '.git', 'index')).mtimeMs, before);
	assert.equal(read(dir, 'wp-login.php'), '<?php // loose\n');
});

// A second writer in the same site — a mentor's own client, an editor's git
// integration — holds the ref lock. The park must fail loudly rather than
// overwrite, and must not be mistaken for a half-done checkout: the `stage`
// tag is what makes withSwitchMarker refuse further parks, and nothing was
// swapped here.
test('a park that cannot take the ref lock rejects without claiming a checkout failed (issue #385)', async (t) => {
	const { dir } = await makeSite(t);
	const { ref, baseOid } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads', 'ticket'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'ticket', '59234.lock'), '');

	await assert.rejects(() => parkCurrentWork(dir, { baseOid }), (e) => {
		assert.equal(e.name, 'GitError');
		assert.match(e.message, /lock/);
		assert.equal(e.stage, undefined);
		return true;
	});
	assert.equal(bundledGit(['rev-parse', ref], dir).stdout, baseOid, 'the branch did not move');
	assert.equal(read(dir, 'wp-login.php'), '<?php // work\n', 'and the work is still on disk');
});

// The other half of the same contract: a checkout that fails is tagged with
// the stage and both ends of the switch, which is what main.js records so the
// site is not parked over a half-swapped worktree. Another writer holding the
// index lock is the realistic trigger; the scan before it runs without the
// lock (`--no-optional-locks`), so the refusal is the checkout's own.
test('a checkout that fails is tagged with the stage and both branches (issue #385)', async (t) => {
	const { dir } = await makeSite(t);
	const { ref, baseOid } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	await switchToBranch(dir, TRUNK, { baseOid });
	fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

	await assert.rejects(() => switchToBranch(dir, ref, { baseOid }), (e) => {
		assert.equal(e.name, 'GitError');
		assert.match(e.message, /index\.lock/);
		assert.equal(e.stage, 'checkout');
		assert.equal(e.from, TRUNK);
		assert.equal(e.to, ref);
		return true;
	});
	assert.equal(await currentBranchName(dir), TRUNK, 'HEAD stayed where it was');
	assert.equal(read(dir, 'wp-login.php'), '<?php // trunk\n', 'and so did the worktree');
});

// The checkout is a child process the quit sweep has to be able to reach; the
// switch and the delete both hand it out, the way the clone does.
test('a switch and a delete hand their checkout child to the caller (issue #385)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	const children = [];

	await switchToBranch(dir, TRUNK, { baseOid, onChild: (child) => children.push(child) });
	await switchToBranch(dir, ref, { baseOid, onChild: (child) => children.push(child) });
	await deleteTicketBranch(dir, ref, { onChild: (child) => children.push(child) });

	assert.equal(children.length, 3);
	for (const child of children) assert.equal(typeof child.pid, 'number');
});

// The index states a contributor's own client leaves behind, which the status
// rows report differently from the old engine (git-read.cjs documents each):
// the park has to end in the same place regardless — one commit of what is on
// disk, and a clean tree against it.
test('a park absorbs intent-to-add, rm --cached and staged-then-reverted files into one commit of the worktree (issue #385)', async (t) => {
	const { dir } = await makeSite(t);
	const { baseOid } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'intent.php'), '<?php // intent to add\n');
	assert.equal(bundledGit(['add', '-N', 'intent.php'], dir).status, 0);
	assert.equal(bundledGit(['rm', '--cached', '-q', 'doomed.php'], dir).status, 0, 'removed from the index, kept on disk');
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // staged\n');
	assert.equal(bundledGit(['add', 'wp-login.php'], dir).status, 0);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // trunk\n');

	const { parked } = await parkCurrentWork(dir, { baseOid });

	assert.equal(parked, true);
	assert.equal(bundledGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], dir).stdout, '', 'clean against the WIP commit');
	const tree = bundledGit(['ls-tree', '--name-only', 'HEAD'], dir).stdout.split('\n').sort();
	assert.deepEqual(tree, ['.gitignore', 'doomed.php', 'intent.php', 'wp-login.php'], 'what is on disk is what was committed');
	assert.equal(bundledGit(['show', 'HEAD:wp-login.php'], dir).stdout, '<?php // trunk', 'the reverted file was committed as it is on disk, not as it was staged');
	assert.equal(bundledGit(['rev-list', '--count', 'HEAD'], dir).stdout, '2', 'one WIP commit on the branch point');
});

// The way out of a switch that died in its checkout (#385). The branch being
// left parked before any file moved, so finishing is the forced checkout
// alone: parking again would write the half-swapped tree over that WIP
// commit. Retrying to the same destination and going back to trunk are the
// same operation with a different ref.
test('resumeSwitch finishes a failed switch without parking the half-swapped tree over the WIP (issue #385)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	await switchToBranch(dir, TRUNK, { baseOid });
	const wip = await git.resolveRef({ fs, dir, ref });
	// What a checkout that died part-way leaves: HEAD still on trunk, a file
	// that already holds the destination's content, and one that does not.
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	fs.writeFileSync(path.join(dir, 'doomed.php'), 'half swapped\n');

	const result = await resumeSwitch(dir, ref);

	assert.deepEqual(result, { switched: true, from: TRUNK, to: ref, parked: false });
	assert.equal(await currentBranchName(dir), ref);
	assert.equal(await git.resolveRef({ fs, dir, ref }), wip, 'the WIP commit was not rewritten');
	assert.equal(read(dir, 'wp-login.php'), '<?php // work\n');
	assert.equal(await hasChangesAgainst(dir), false, 'the tree is the destination, nothing left over');

	// And back to trunk from a mixed tree, with the ticket's commit intact.
	fs.writeFileSync(path.join(dir, 'doomed.php'), 'mixed again\n');
	const back = await resumeSwitch(dir, TRUNK);
	assert.equal(back.parked, false);
	assert.equal(await currentBranchName(dir), TRUNK);
	assert.equal(read(dir, 'wp-login.php'), '<?php // trunk\n');
	assert.equal(await git.resolveRef({ fs, dir, ref }), wip);

	// Already on the destination: still a repair, not a no-op.
	fs.writeFileSync(path.join(dir, 'wp-login.php'), 'stray\n');
	const same = await resumeSwitch(dir, TRUNK);
	assert.equal(same.switched, false);
	assert.equal(read(dir, 'wp-login.php'), '<?php // trunk\n');
});

// --- rebaseOntoTrunk (#385) -------------------------------------------------

// Trunk moves on while the ticket is parked or checked out: the fixture
// commits on trunk with isomorphic-git, the way the other suites move a
// fixture's history, without touching the ticket branch.
async function moveTrunk(dir, files, { returnTo = null } = {}) {
	await git.checkout({ fs, dir, ref: TRUNK, force: true });
	for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
	await git.add({ fs, dir, filepath: Object.keys(files) });
	const oid = await git.commit({ fs, dir, message: 'trunk moves on', author: AUTHOR });
	if (returnTo) await git.checkout({ fs, dir, ref: returnTo, force: true });
	return oid;
}

const wipOf = async (dir, ref) => {
	const oid = await git.resolveRef({ fs, dir, ref });
	const { commit } = await git.readCommit({ fs, dir, oid });
	return { oid, parents: commit.parent, message: commit.message.trim() };
};

test('rebaseOntoTrunk replays the single WIP commit onto the new trunk and keeps every invariant (issue #385)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // trunk\n// my work\n');
	await switchToBranch(dir, TRUNK, { baseOid });
	const newTrunk = await moveTrunk(dir, { 'doomed.php': '<?php // trunk changed this\n' });
	await switchToBranch(dir, ref, { baseOid });
	const stages = [];

	const result = await rebaseOntoTrunk(dir, ref, { baseOid, onProgress: (p) => stages.push(p.stage) });

	assert.deepEqual({ rebased: result.rebased, from: result.from, to: result.to, parked: result.parked }, { rebased: true, from: baseOid, to: newTrunk, parked: false });
	const wip = await wipOf(dir, ref);
	assert.equal(wip.oid, result.oid);
	assert.deepEqual(wip.parents, [newTrunk], 'one commit, parented on the new trunk');
	assert.equal(wip.message, WIP_MESSAGE);
	assert.equal(await currentBranchName(dir), ref);
	assert.equal(read(dir, 'wp-login.php'), '<?php // trunk\n// my work\n', 'the work is still there');
	assert.equal(read(dir, 'doomed.php'), '<?php // trunk changed this\n', 'and trunk\'s change arrived');
	assert.equal(read(dir, 'node_modules/react/index.js'), 'expensive\n');
	assert.equal(await hasChangesAgainst(dir), false, 'the tree is the rebased WIP, nothing loose');
	assert.equal(await hasChangesAgainst(dir, TRUNK), true, 'and it still differs from trunk by the work');
	assert.ok(stages.includes('rebase') && stages[stages.length - 1] === 'done', stages.join(','));
	assert.equal(await git.resolveRef({ fs, dir, ref: TRUNK }), newTrunk, 'trunk itself was not touched');
});

test('rebaseOntoTrunk parks loose edits into the WIP first, and a ticket with no work just moves its start (issue #385)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	const newTrunk = await moveTrunk(dir, { 'doomed.php': '<?php // v2\n' }, { returnTo: ref });
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // loose edit\n');

	const result = await rebaseOntoTrunk(dir, ref, { baseOid });

	assert.equal(result.parked, true);
	const wip = await wipOf(dir, ref);
	assert.deepEqual(wip.parents, [newTrunk]);
	assert.equal(read(dir, 'wp-login.php'), '<?php // loose edit\n');
	assert.equal(read(dir, 'doomed.php'), '<?php // v2\n');

	// A second ticket that never had work: its ref simply starts from trunk.
	// Started from a clean trunk, or the first ticket's tree would ride into
	// it as loose edits (#234) and be parked as work.
	await switchToBranch(dir, TRUNK, { baseOid: newTrunk });
	const second = await startTicketBranch(dir, 61002);
	await switchToBranch(dir, TRUNK, { baseOid: second.baseOid });
	const newer = await moveTrunk(dir, { 'doomed.php': '<?php // v3\n' });
	const moved = await rebaseOntoTrunk(dir, second.ref, { baseOid: second.baseOid });
	assert.equal(moved.rebased, true);
	assert.equal(await git.resolveRef({ fs, dir, ref: second.ref }), newer);
	assert.equal(await currentBranchName(dir), TRUNK, 'a branch that is not checked out is not checked out afterwards either');
});

test('rebaseOntoTrunk is a no-op when trunk has not moved (issue #385)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	const result = await rebaseOntoTrunk(dir, ref, { baseOid });
	assert.deepEqual(result, { rebased: false, from: baseOid, to: baseOid, parked: false, oid: null });
	assert.equal(read(dir, 'wp-login.php'), '<?php // work\n', 'nothing was parked or checked out');
	await assert.rejects(rebaseOntoTrunk(dir, ref, {}), (e) => e.code === 'no-base');
});

test('rebaseOntoTrunk refuses a conflict with the paths and moves nothing (issue #385)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // my version\n');
	await switchToBranch(dir, TRUNK, { baseOid });
	const before = await wipOf(dir, ref);
	await moveTrunk(dir, { 'wp-login.php': '<?php // trunk version\n' }, { returnTo: ref });
	const indexBefore = fs.statSync(path.join(dir, '.git', 'index')).mtimeMs;

	await assert.rejects(rebaseOntoTrunk(dir, ref, { baseOid }), (e) => {
		assert.equal(e.code, 'rebase-conflict');
		assert.deepEqual(e.conflicts, ['wp-login.php']);
		return true;
	});

	assert.deepEqual(await wipOf(dir, ref), before, 'the WIP commit is untouched');
	assert.equal(read(dir, 'wp-login.php'), '<?php // my version\n');
	assert.equal(fs.statSync(path.join(dir, '.git', 'index')).mtimeMs, indexBefore, 'no checkout ran');
	assert.equal(await currentBranchName(dir), ref);
});

// The ref moves before the checkout, so a checkout that cannot start leaves
// the branch rebased over the old tree: tagged like a switch, so the caller's
// marker and `resumeSwitch(ref)` finish it.
test('rebaseOntoTrunk tags a checkout that fails with the stage, the ref already moved (issue #385)', async (t) => {
	const { dir, baseOid } = await makeSite(t);
	const { ref } = await startTicketBranch(dir, 59234);
	fs.writeFileSync(path.join(dir, 'wp-login.php'), '<?php // work\n');
	await switchToBranch(dir, TRUNK, { baseOid });
	const newTrunk = await moveTrunk(dir, { 'doomed.php': '<?php // v2\n' });
	await switchToBranch(dir, ref, { baseOid });
	fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

	await assert.rejects(rebaseOntoTrunk(dir, ref, { baseOid }), (e) => e.stage === 'checkout' && e.from === ref && e.to === ref && e.movedTo === newTrunk);

	assert.deepEqual((await wipOf(dir, ref)).parents, [newTrunk], 'the branch is on the new trunk');
	assert.equal(read(dir, 'doomed.php'), '<?php // to be deleted\n', 'the tree is still the old one');
	fs.unlinkSync(path.join(dir, '.git', 'index.lock'));
	await resumeSwitch(dir, ref);
	assert.equal(read(dir, 'doomed.php'), '<?php // v2\n');
	assert.equal(read(dir, 'wp-login.php'), '<?php // work\n');
});
