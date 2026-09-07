const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = require('../../src/git-read.cjs');
const { git, tempDir } = require('./helpers/git.cjs');

// Two halves. The parsers are pure functions over bytes, so the first half
// feeds them the exact byte layouts Git documents for each porcelain format,
// including the shapes that only a hostile repository produces (a stray
// rename entry, a NUL inside a blob, a path with a space). The second half
// runs the read functions against a repository the bundled Git built, so the
// flag set each command uses is proven on this platform too.

const z = (...fields) => Buffer.from(fields.map((f) => `${f}\0`).join(''), 'utf8');

test('status v2: every XY combination lands on the documented row', () => {
	const cases = [
		['..', [1, 1, 1]],
		['.M', [1, 2, 1]],
		['.D', [1, 0, 1]],
		['M.', [1, 2, 2]],
		['MM', [1, 2, 3]],
		['MD', [1, 0, 3]],
		['A.', [0, 2, 2]],
		['AM', [0, 2, 3]],
		['AD', [0, 0, 3]],
		['D.', [1, 2, 0]],
		['T.', [1, 2, 2]],
		['.T', [1, 2, 1]]
	];
	for (const [xy, expected] of cases) {
		const [, head, workdir, stage] = read.rowFromStatusEntry(xy, 'f');
		assert.deepEqual([head, workdir, stage], expected, xy);
	}
});

test('status v2: ordinary, untracked, unmerged and a stray rename entry parse without drifting', () => {
	const buf = z(
		'1 .M N... 100644 100644 100644 aaaa bbbb src/wp-login.php',
		'? new file.txt',
		'2 R. N... 100644 100644 100644 cccc dddd R100 renamed.php', 'original.php',
		'u UU N... 100644 100644 100644 100644 eeee ffff gggg conflicted.php',
		'1 D. N... 100644 000000 000000 hhhh 0000 gone.php'
	);
	assert.deepEqual(read.parseStatusV2Z(buf), [
		['src/wp-login.php', 1, 2, 1],
		['new file.txt', 0, 2, 0],
		['renamed.php', 1, 2, 2],
		['conflicted.php', 1, 2, 3],
		['gone.php', 1, 2, 0]
	]);
});

test('status v2: an empty answer is an empty matrix', () => {
	assert.deepEqual(read.parseStatusV2Z(Buffer.alloc(0)), []);
});

test('name-status: A, M, T and D against a commit', () => {
	const buf = z('A', 'added.php', 'M', 'src/wp-login.php', 'T', 'link', 'D', 'gone.php');
	assert.deepEqual(read.parseNameStatusZ(buf), [
		['added.php', 0, 2, 0],
		['src/wp-login.php', 1, 2, 0],
		['link', 1, 2, 0],
		['gone.php', 1, 0, 0]
	]);
});

test('a -z list keeps spaces and drops the empty trailer', () => {
	assert.deepEqual(read.parseZList(z('a b', 'c')), ['a b', 'c']);
	assert.deepEqual(read.parseZList(Buffer.alloc(0)), []);
});

test('cat-file --batch: hits, a missing object and a blob with newlines and NUL bytes', () => {
	const body = Buffer.concat([Buffer.from('line 1\n'), Buffer.from([0, 0xff]), Buffer.from('\nend')]);
	const buf = Buffer.concat([
		Buffer.from(`1111111111111111111111111111111111111111 blob ${body.length}\n`), body, Buffer.from('\n'),
		Buffer.from('abc:no such file missing\n'),
		Buffer.from('2222222222222222222222222222222222222222 blob 0\n\n')
	]);
	const requests = ['abc:with space.txt', 'abc:no such file', 'abc:empty'];
	const answers = read.parseCatFileBatch(buf, requests);
	assert.deepEqual(answers.get('abc:with space.txt'), body);
	assert.equal(answers.get('abc:no such file'), null);
	assert.deepEqual(answers.get('abc:empty'), Buffer.alloc(0));
});

test('cat-file --batch-check: oid per request, null when missing', () => {
	const buf = Buffer.from('1111111111111111111111111111111111111111 blob 12\nabc:nope missing\n');
	const answers = read.parseCatFileBatchCheck(buf, ['abc:package-lock.json', 'abc:nope']);
	assert.equal(answers.get('abc:package-lock.json'), '1111111111111111111111111111111111111111');
	assert.equal(answers.get('abc:nope'), null);
});

test('ls-tree: one entry, or null for a path the tree does not have', () => {
	const entry = read.parseLsTreeZ(z('100755 blob 3333333333333333333333333333333333333333\tbin/run me.sh'));
	assert.deepEqual(entry, { mode: '100755', type: 'blob', oid: '3333333333333333333333333333333333333333', path: 'bin/run me.sh' });
	assert.equal(read.parseLsTreeZ(Buffer.alloc(0)), null);
});

test('crlfArgs: Windows adds autocrlf only when the repository does not say', async () => {
	const seen = [];
	const runWith = (status) => async (args, options) => { seen.push({ args, options }); return { status, stdout: Buffer.alloc(0), stderr: '' }; };
	assert.deepEqual(await read.crlfArgs('/site', { platform: 'win32', run: runWith(1) }), ['-c', 'core.autocrlf=true']);
	assert.deepEqual(await read.crlfArgs('/site', { platform: 'win32', run: runWith(0) }), []);
	assert.deepEqual(seen[0].args, ['config', '--local', '--get', 'core.autocrlf']);
	assert.deepEqual(seen[0].options.okCodes, [0, 1]);
	assert.deepEqual(await read.crlfArgs('/site', { platform: 'darwin', run: runWith(1) }), []);
	assert.equal(seen.length, 2, 'no config read off Windows');
});

// --- against a real repository ------------------------------------------

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
