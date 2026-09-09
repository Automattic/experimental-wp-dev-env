'use strict';

// Integration tests for src/trunk-update.js against real on-disk repositories.
// CRLF-smudged files are simulated by writing CRLF bytes directly, which is
// exactly what a host Git's autocrlf checkout leaves on disk.
//
// updateToLatestTrunk needs a remote to fetch from, so it lives in
// trunk-update-fetch.integration.test.cjs with its local HTTP git fixture.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('isomorphic-git');
const {
	collectDirtyFiles,
	discardChanges,
	discardToBase,
	readTrunkInfo
} = require('../../src/trunk-update.js');

const AUTHOR = { name: 'test', email: 'test@example.com' };

// The shape the clone writes (git-clone.cjs): with core.autocrlf pinned the
// binary's checkout writes LF on Windows too, so the byte-for-byte assertions
// on the discards mean the same on every platform.
async function makeRepo(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunk-update-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	await git.init({ fs, dir, defaultBranch: 'trunk' });
	await git.setConfig({ fs, dir, path: 'core.autocrlf', value: false });
	fs.writeFileSync(path.join(dir, 'text.txt'), 'line1\nline2\n');
	// Big5-style bytes: not valid UTF-8, the encoding-fixture case.
	fs.writeFileSync(path.join(dir, 'big5.txt'), Buffer.from([0xa4, 0xa4, 0x0a, 0xa4, 0xe5, 0x0a]));
	await git.add({ fs, dir, filepath: ['text.txt', 'big5.txt'] });
	await git.commit({ fs, dir, message: 'init', author: AUTHOR });
	return dir;
}

test('collectDirtyFiles: a pristine repo is clean (issue #94)', async (t) => {
	const dir = await makeRepo(t);
	assert.deepStrictEqual(await collectDirtyFiles(dir), []);
});

test('collectDirtyFiles: CRLF-smudged files, UTF-8 or not, are not dirty (issue #94)', async (t) => {
	const dir = await makeRepo(t);
	// What a native-git checkout with core.autocrlf=true leaves on disk.
	fs.writeFileSync(path.join(dir, 'text.txt'), 'line1\r\nline2\r\n');
	fs.writeFileSync(path.join(dir, 'big5.txt'), Buffer.from([0xa4, 0xa4, 0x0d, 0x0a, 0xa4, 0xe5, 0x0d, 0x0a]));
	assert.deepStrictEqual(await collectDirtyFiles(dir), []);
});

test('collectDirtyFiles: real edits and untracked files are detected (issue #94)', async (t) => {
	const dir = await makeRepo(t);
	fs.appendFileSync(path.join(dir, 'text.txt'), 'line3\n');
	fs.appendFileSync(path.join(dir, 'big5.txt'), Buffer.from([0xff, 0xfe]));
	fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');
	assert.deepStrictEqual((await collectDirtyFiles(dir)).sort(), ['big5.txt', 'text.txt', 'untracked.txt']);
});

test('discardChanges: restores tracked files and deletes untracked ones, even staged (issue #94)', async (t) => {
	const dir = await makeRepo(t);
	fs.appendFileSync(path.join(dir, 'text.txt'), 'local edit\n');
	fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');
	fs.writeFileSync(path.join(dir, 'staged-untracked.txt'), 'staged by patch generation\n');
	await git.add({ fs, dir, filepath: 'staged-untracked.txt' });

	await discardChanges(dir);

	assert.strictEqual(fs.readFileSync(path.join(dir, 'text.txt'), 'utf8'), 'line1\nline2\n');
	assert.strictEqual(fs.existsSync(path.join(dir, 'untracked.txt')), false);
	assert.strictEqual(fs.existsSync(path.join(dir, 'staged-untracked.txt')), false);
	assert.deepStrictEqual(await collectDirtyFiles(dir), []);
});

test('discardToBase: rewinds the branch to base, dropping parked WIP and edits (issue #270)', async (t) => {
	const dir = await makeRepo(t);
	const baseOid = await git.resolveRef({ fs, dir, ref: 'refs/heads/trunk' });
	await git.branch({ fs, dir, ref: 'ticket/36259', object: 'trunk', checkout: true });

	// Parked work: a committed WIP on top of the branch point — what the patch
	// modal measures as "your changes" but a plain discard would keep (#108).
	fs.writeFileSync(path.join(dir, 'text.txt'), 'parked work\n');
	await git.add({ fs, dir, filepath: 'text.txt' });
	await git.commit({ fs, dir, message: 'WIP', author: AUTHOR, parent: [baseOid] });
	// Uncommitted edits and an untracked file on top of the parked commit.
	fs.appendFileSync(path.join(dir, 'text.txt'), 'unsaved scribble\n');
	fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');

	await discardToBase(dir, baseOid);

	// The whole diff is gone: tree is the base tree, HEAD is the base commit
	// (parked WIP orphaned), still on the ticket branch, untracked file removed.
	assert.strictEqual(fs.readFileSync(path.join(dir, 'text.txt'), 'utf8'), 'line1\nline2\n');
	assert.strictEqual(fs.existsSync(path.join(dir, 'untracked.txt')), false);
	assert.strictEqual(await git.resolveRef({ fs, dir, ref: 'HEAD' }), baseOid);
	assert.strictEqual(await git.currentBranch({ fs, dir, fullname: false }), 'ticket/36259');
	assert.deepStrictEqual(await collectDirtyFiles(dir), []);
});

test('discardToBase: a base that is not an ancestor of HEAD does not rewind the branch (issue #270)', async (t) => {
	const dir = await makeRepo(t);
	const trunkStart = await git.resolveRef({ fs, dir, ref: 'refs/heads/trunk' });
	// A ticket branch with a committed WIP off the original trunk point.
	await git.branch({ fs, dir, ref: 'ticket/36259', object: 'trunk', checkout: true });
	fs.writeFileSync(path.join(dir, 'text.txt'), 'committed ticket work\n');
	await git.add({ fs, dir, filepath: 'text.txt' });
	const wip = await git.commit({ fs, dir, message: 'WIP', author: AUTHOR, parent: [trunkStart] });
	// Trunk advances to a commit that is a sibling of the ticket HEAD, not an
	// ancestor — the shape this guard must refuse.
	await git.checkout({ fs, dir, ref: 'trunk' });
	fs.writeFileSync(path.join(dir, 'other.txt'), 'unrelated trunk work\n');
	await git.add({ fs, dir, filepath: 'other.txt' });
	const trunkTip = await git.commit({ fs, dir, message: 'trunk moves on', author: AUTHOR, parent: [trunkStart] });
	await git.checkout({ fs, dir, ref: 'ticket/36259' });
	fs.appendFileSync(path.join(dir, 'text.txt'), 'unsaved scribble\n');

	await discardToBase(dir, trunkTip);

	// The non-ancestor base is refused: the branch is not rewound onto it, the
	// committed work survives, and only the uncommitted scribble is cleared.
	assert.strictEqual(await git.resolveRef({ fs, dir, ref: 'HEAD' }), wip, 'the ref is left at the WIP commit');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'text.txt'), 'utf8'), 'committed ticket work\n');
	assert.strictEqual(await git.currentBranch({ fs, dir, fullname: false }), 'ticket/36259');
});

test('readTrunkInfo: returns the HEAD oid and its committer date (issue #94)', async (t) => {
	const dir = await makeRepo(t);
	const { trunkOid, trunkDate } = await readTrunkInfo(dir);
	assert.strictEqual(trunkOid, await git.resolveRef({ fs, dir, ref: 'HEAD' }));
	const { commit } = await git.readCommit({ fs, dir, oid: trunkOid });
	assert.strictEqual(trunkDate, new Date(commit.committer.timestamp * 1000).toISOString());
});

test('readTrunkInfo: reports the trunk snapshot, not the ticket branch HEAD (issue #108)', async (t) => {
	const dir = await makeRepo(t);
	const trunkTip = await git.resolveRef({ fs, dir, ref: 'refs/heads/trunk' });

	// A ticket branch with parked work: HEAD is now a commit made seconds ago.
	// Reading it would date the checkout by the contributor's own work, and the
	// staleness dot (#94) would never light up no matter how old trunk got.
	await git.branch({ fs, dir, ref: 'ticket/59234', object: 'trunk', checkout: true });
	fs.writeFileSync(path.join(dir, 'text.txt'), 'work in progress\n');
	await git.add({ fs, dir, filepath: 'text.txt' });
	const wip = await git.commit({ fs, dir, message: 'WIP', author: AUTHOR, parent: [trunkTip] });

	const { trunkOid } = await readTrunkInfo(dir);
	assert.notStrictEqual(trunkOid, wip, 'the WIP commit is not the trunk snapshot');
	assert.strictEqual(trunkOid, trunkTip);
});

test('discardChanges: stays on the ticket branch and keeps its parked work (issue #108)', async (t) => {
	const dir = await makeRepo(t);
	const trunkTip = await git.resolveRef({ fs, dir, ref: 'refs/heads/trunk' });
	await git.branch({ fs, dir, ref: 'ticket/59234', object: 'trunk', checkout: true });
	fs.writeFileSync(path.join(dir, 'text.txt'), 'parked work\n');
	await git.add({ fs, dir, filepath: 'text.txt' });
	await git.commit({ fs, dir, message: 'WIP', author: AUTHOR, parent: [trunkTip] });

	// Uncommitted edits on top of the parked work — the only thing discard
	// should remove. Checking out `trunk` by name here would silently move the
	// contributor to another ticket and take their parked work off screen.
	fs.writeFileSync(path.join(dir, 'text.txt'), 'unsaved scribble\n');
	fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');

	await discardChanges(dir);

	assert.strictEqual(await git.currentBranch({ fs, dir, fullname: false }), 'ticket/59234');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'text.txt'), 'utf8'), 'parked work\n');
	assert.strictEqual(fs.existsSync(path.join(dir, 'untracked.txt')), false);
});

// What a discard must leave alone: the substrate `.gitignore` names and what
// `.git/info/exclude` names (the app writes the latter for its own files).
// `clean` without `-x` is the whole of that promise.
test('discardChanges: ignored and excluded files survive, staged and untracked ones do not (issue #385)', async (t) => {
	const dir = await makeRepo(t);
	fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
	await git.add({ fs, dir, filepath: '.gitignore' });
	await git.commit({ fs, dir, message: 'ignore', author: AUTHOR });
	fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'installed\n');
	fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'excluded.txt\n');
	fs.writeFileSync(path.join(dir, 'excluded.txt'), 'mine\n');
	fs.mkdirSync(path.join(dir, 'new-dir'));
	fs.writeFileSync(path.join(dir, 'new-dir', 'file.txt'), 'new\n');
	fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
	await git.add({ fs, dir, filepath: 'staged.txt' });
	fs.appendFileSync(path.join(dir, 'text.txt'), 'edit\n');
	const children = [];

	await discardChanges(dir, { onChild: (child) => children.push(child) });

	assert.strictEqual(fs.readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'installed\n');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'excluded.txt'), 'utf8'), 'mine\n');
	assert.strictEqual(fs.existsSync(path.join(dir, 'new-dir')), false);
	assert.strictEqual(fs.existsSync(path.join(dir, 'staged.txt')), false);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'text.txt'), 'utf8'), 'line1\nline2\n');
	assert.deepStrictEqual(await collectDirtyFiles(dir), []);
	assert.strictEqual(children.length, 1, 'the checkout child was handed out');
});

test('discardToBase: a base this repository does not have does not rewind the branch (issue #385)', async (t) => {
	const dir = await makeRepo(t);
	const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
	fs.appendFileSync(path.join(dir, 'text.txt'), 'scribble\n');

	await discardToBase(dir, '0000000000000000000000000000000000000001');

	assert.strictEqual(await git.resolveRef({ fs, dir, ref: 'HEAD' }), head);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'text.txt'), 'utf8'), 'line1\nline2\n');
});
