const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = require('../../src/git-read.cjs');
const { git, tempDir } = require('./helpers/git.cjs');

// The read functions against a repository the bundled Git built, so the flag
// set each command uses is proven on this platform too, including the states
// only a user's own client produces. The parsers on their own are in
// git-read.test.cjs.


function makeRepo(t) {
	const dir = tempDir(t, 'toolkit-git-read-');
	assert.equal(git(['init', '-b', 'trunk'], dir).status, 0);
	fs.mkdirSync(path.join(dir, 'src'));
	fs.writeFileSync(path.join(dir, 'src', 'wp-login.php'), '<?php // login\n');
	fs.writeFileSync(path.join(dir, 'with space.txt'), 'spaced\n');
	fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"name":"x"}\n');
	fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
	assert.equal(git(['add', '.'], dir).status, 0);
	const commit = git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first'], dir);
	assert.equal(commit.status, 0, commit.stderr);
	return dir;
}

test('resolveRef, readCommitInfo and currentBranch on a fresh repository', async (t) => {
	const dir = makeRepo(t);
	const head = git(['rev-parse', 'HEAD'], dir).stdout;
	assert.equal(await read.resolveRef(dir, 'HEAD'), head);
	assert.equal(await read.resolveRef(dir, 'refs/heads/trunk'), head);
	assert.equal(await read.resolveRef(dir, 'refs/heads/nope'), null);

	const info = await read.readCommitInfo(dir, 'refs/heads/trunk');
	assert.equal(info.oid, head);
	const seconds = Number(git(['log', '-1', '--format=%ct'], dir).stdout);
	assert.equal(info.date, new Date(seconds * 1000).toISOString());
	await assert.rejects(read.readCommitInfo(dir, 'refs/heads/nope'), (error) => error.code === 128);

	assert.equal(await read.currentBranch(dir), 'trunk');
	assert.equal(git(['checkout', '-q', '--detach'], dir).status, 0);
	assert.equal(await read.currentBranch(dir), null);
});

test('listBranches sees a branch made by hand', async (t) => {
	const dir = makeRepo(t);
	assert.equal(git(['branch', 'ticket/60001'], dir).status, 0);
	assert.deepEqual((await read.listBranches(dir)).sort(), ['ticket/60001', 'trunk']);
});

test('statusRows: clean tree, then a modification, an untracked file, a deletion, and nothing ignored', async (t) => {
	const dir = makeRepo(t);
	assert.deepEqual(await read.statusRows(dir, { platform: 'darwin' }), []);

	fs.writeFileSync(path.join(dir, 'src', 'wp-login.php'), '<?php // edited\n');
	fs.writeFileSync(path.join(dir, 'new file.txt'), 'new\n');
	fs.unlinkSync(path.join(dir, 'with space.txt'));
	fs.mkdirSync(path.join(dir, 'node_modules', 'react'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'node_modules', 'react', 'index.js'), 'expensive\n');

	const rows = (await read.statusRows(dir, { platform: 'darwin' })).sort();
	assert.deepEqual(rows, [
		['new file.txt', 0, 2, 0],
		['src/wp-login.php', 1, 2, 1],
		['with space.txt', 1, 0, 1]
	]);
});

test('changesAgainst compares the worktree with a commit that is not HEAD', async (t) => {
	const dir = makeRepo(t);
	const base = git(['rev-parse', 'HEAD'], dir).stdout;
	// A second commit moves HEAD; the worktree then diverges from both.
	fs.writeFileSync(path.join(dir, 'src', 'wp-login.php'), '<?php // parked\n');
	assert.equal(git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'wip'], dir).status, 0);
	fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u\n');
	fs.unlinkSync(path.join(dir, 'package-lock.json'));

	assert.deepEqual((await read.changesAgainst(dir, 'HEAD', { platform: 'darwin' })).sort(), [
		['package-lock.json', 1, 0, 0],
		['untracked.txt', 0, 2, 0]
	]);
	assert.deepEqual((await read.changesAgainst(dir, base, { platform: 'darwin' })).sort(), [
		['package-lock.json', 1, 0, 0],
		['src/wp-login.php', 1, 2, 0],
		['untracked.txt', 0, 2, 0]
	]);
});

test('a path removed from the index but kept on disk is present, never a deletion', async (t) => {
	// `git rm --cached`: the file is on disk and the contributor still has it.
	// A deletion here is how a patch would delete it for them (#85).
	const dir = makeRepo(t);
	const base = git(['rev-parse', 'HEAD'], dir).stdout;
	assert.equal(git(['rm', '-q', '--cached', 'with space.txt'], dir).status, 0);
	assert.deepEqual(await read.statusRows(dir, { platform: 'darwin' }), [['with space.txt', 1, 2, 0]]);
	assert.deepEqual(await read.changesAgainst(dir, base, { platform: 'darwin' }), [['with space.txt', 1, 2, 0]]);
	// And a staged deletion is one that really is gone from disk.
	assert.equal(git(['rm', '-q', 'package-lock.json'], dir).status, 0);
	assert.deepEqual((await read.statusRows(dir, { platform: 'darwin' })).sort(), [
		['package-lock.json', 1, 0, 0],
		['with space.txt', 1, 2, 0]
	]);
});

test('readBlobs, blobOid and treeEntryMode read one commit without touching the worktree', async (t) => {
	const dir = makeRepo(t);
	const base = git(['rev-parse', 'HEAD'], dir).stdout;
	fs.writeFileSync(path.join(dir, 'src', 'wp-login.php'), '<?php // edited\n');

	const blobs = await read.readBlobs(dir, base, ['src/wp-login.php', 'with space.txt', 'nope.txt']);
	assert.equal(blobs.get('src/wp-login.php').toString('utf8'), '<?php // login\n');
	assert.equal(blobs.get('with space.txt').toString('utf8'), 'spaced\n');
	assert.equal(blobs.get('nope.txt'), null);
	assert.deepEqual(await read.readBlobs(dir, base, []), new Map());

	const oid = await read.blobOid(dir, base, 'package-lock.json');
	assert.equal(oid, git(['rev-parse', `${base}:package-lock.json`], dir).stdout);
	assert.equal(await read.blobOid(dir, base, 'nope.json'), null);

	assert.equal(await read.treeEntryMode(dir, base, 'src/wp-login.php'), '100644');
	assert.equal(await read.treeEntryMode(dir, base, 'src/nope.php'), null);
	// The worktree edit above is still there: reads write nothing.
	assert.equal(fs.readFileSync(path.join(dir, 'src', 'wp-login.php'), 'utf8'), '<?php // edited\n');
});

test('isLegacySite: shallow without a promisor is the old engine, anything else is not (#385)', async (t) => {
	const dir = makeRepo(t);
	assert.equal(await read.isLegacySite(dir), false, 'a full clone is never legacy');

	// What isomorphic-git\'s shallow clone leaves behind: the root commit listed
	// in .git/shallow and a remote with nothing but url and fetch.
	const head = git(['rev-parse', 'HEAD'], dir).stdout;
	fs.writeFileSync(path.join(dir, '.git', 'shallow'), `${head}\n`);
	assert.equal(git(['remote', 'add', 'origin', 'https://example.test/wordpress-develop.git'], dir).status, 0);
	assert.equal(await read.isLegacySite(dir), true);

	// The binary\'s partial clone writes the promisor; a shallow file beside it
	// would not make the site legacy.
	assert.equal(git(['config', '--local', 'remote.origin.promisor', 'true'], dir).status, 0);
	assert.equal(await read.isLegacySite(dir), false);
});
