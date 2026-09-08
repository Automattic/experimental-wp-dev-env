'use strict';

// Integration tests for src/trunk-update.js against real on-disk repositories.
// Windows line-ending scenarios are simulated by writing CRLF bytes directly,
// which is exactly what a native-git autocrlf checkout leaves on disk.
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
	createCrlfCompatibleFs,
	discardChanges,
	discardToBase,
	readTrunkInfo
} = require('../../src/trunk-update.js');

const AUTHOR = { name: 'test', email: 'test@example.com' };

async function makeRepo(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunk-update-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	await git.init({ fs, dir, defaultBranch: 'trunk' });
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

for (const platform of ['darwin', 'linux']) {
	test(`CRLF compatibility: ${platform} leaves an unset local core.autocrlf untouched (issue #341)`, async (t) => {
		const dir = await makeRepo(t);
		const compatibleFs = createCrlfCompatibleFs(dir, { platform });

		assert.strictEqual(await git.getConfig({ fs: compatibleFs, dir, path: 'core.autocrlf' }), undefined);
		assert.strictEqual(await git.getConfig({ fs, dir, path: 'core.autocrlf' }), undefined);
	});
}

for (const value of [undefined, 'true', 'false', 'input']) {
	test(`CRLF compatibility: Windows preserves local core.autocrlf=${value ?? 'unset'} (issue #341)`, async (t) => {
		const dir = await makeRepo(t);
		if (value !== undefined) {
			await git.setConfig({ fs, dir, path: 'core.autocrlf', value });
		}

		const compatibleFs = createCrlfCompatibleFs(dir, { platform: 'win32' });
		const visibleValue = await git.getConfig({ fs: compatibleFs, dir, path: 'core.autocrlf' });

		assert.strictEqual(visibleValue, value ?? 'true');
		assert.strictEqual(await git.getConfig({ fs, dir, path: 'core.autocrlf' }), value);
	});
}

test('CRLF compatibility: Windows normalizes a CRLF checkout without persisting config (issue #341)', async (t) => {
	const dir = await makeRepo(t);
	fs.writeFileSync(path.join(dir, 'text.txt'), 'line1\r\nline2\r\n');
	const compatibleFs = createCrlfCompatibleFs(dir, { platform: 'win32' });

	const matrix = await git.statusMatrix({ fs: compatibleFs, dir });

	assert.deepStrictEqual(matrix.find(([filepath]) => filepath === 'text.txt'), ['text.txt', 1, 1, 1]);
	assert.strictEqual(await git.getConfig({ fs, dir, path: 'core.autocrlf' }), undefined);
});

test('CRLF compatibility: a worktree file named config is not altered in memory (issue #341)', async (t) => {
	const dir = await makeRepo(t);
	fs.writeFileSync(path.join(dir, 'config'), 'ordinary worktree content\n');
	const compatibleFs = createCrlfCompatibleFs(dir, { platform: 'win32' });

	assert.strictEqual(
		await compatibleFs.promises.readFile(path.join(dir, 'config'), 'utf8'),
		'ordinary worktree content\n'
	);
});

test('CRLF compatibility: a gitdir file receives the same non-persistent view (issue #341)', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocrlf-gitdir-test-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const dir = path.join(root, 'worktree');
	const gitdir = path.join(root, 'actual-git');
	fs.mkdirSync(dir);
	fs.mkdirSync(gitdir);
	fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../actual-git\n');
	fs.writeFileSync(path.join(gitdir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
	const compatibleFs = createCrlfCompatibleFs(dir, { platform: 'win32' });

	await compatibleFs.promises.readFile(path.join(dir, '.git'), 'utf8');
	const visibleConfig = await compatibleFs.promises.readFile(path.join(gitdir, 'config'), 'utf8');

	assert.match(visibleConfig, /autocrlf = true/);
	assert.doesNotMatch(fs.readFileSync(path.join(gitdir, 'config'), 'utf8'), /autocrlf/);
});

test('CRLF compatibility: config read failures are logged and remain failures (issue #341)', async (t) => {
	const dir = await makeRepo(t);
	const errors = [];
	const failingFs = Object.create(fs);
	const promises = Object.create(fs.promises);
	promises.readFile = async (filepath, options) => {
		if (path.resolve(filepath) === path.resolve(dir, '.git', 'config')) {
			const error = new Error('config is unreadable');
			error.code = 'EACCES';
			throw error;
		}
		return fs.promises.readFile(filepath, options);
	};
	Object.defineProperty(failingFs, 'promises', { enumerable: true, value: promises });
	const compatibleFs = createCrlfCompatibleFs(dir, {
		platform: 'win32',
		fileSystem: failingFs,
		onError: (error) => errors.push(error)
	});

	await assert.rejects(
		compatibleFs.promises.readFile(path.join(dir, '.git', 'config'), 'utf8'),
		{ code: 'EACCES' }
	);
	assert.strictEqual(errors.length, 1);
	assert.match(errors[0].message, /config is unreadable/);
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
