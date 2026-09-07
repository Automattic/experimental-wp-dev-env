const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stagePaths, writeTree, commitTree, updateBranch, createBranchAt, pointHeadAt, deleteBranch, checkoutBranch } = require('../../src/git-write.cjs');
const { git, tempDir } = require('./helpers/git.cjs');

// The primitives against the real binary: the argument tests prove what is
// asked, this proves Git does what the names promise. The flows built on top
// live in ticket-branches.integration.test.cjs.

const IDENTITY = ['-c', 'user.name=T', '-c', 'user.email=t@example.com'];

function makeRepo(t) {
	const dir = tempDir(t, 'toolkit git-write-');
	git(['init', '-q', '-b', 'trunk'], dir);
	fs.writeFileSync(path.join(dir, 'kept.txt'), 'kept\n');
	fs.writeFileSync(path.join(dir, 'doomed.txt'), 'doomed\n');
	fs.writeFileSync(path.join(dir, 'weird[1]*.txt'), 'literal\n');
	git(['add', '.'], dir);
	git([...IDENTITY, 'commit', '-q', '-m', 'first'], dir);
	return { dir, base: git(['rev-parse', 'HEAD'], dir).stdout };
}

test('stagePaths stages a modification, an addition and a deletion, and a glob-looking name is one file', async (t) => {
	const { dir } = makeRepo(t);
	fs.writeFileSync(path.join(dir, 'kept.txt'), 'changed\n');
	fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
	fs.writeFileSync(path.join(dir, 'w.txt'), 'would match the glob\n');
	fs.unlinkSync(path.join(dir, 'doomed.txt'));
	fs.writeFileSync(path.join(dir, 'weird[1]*.txt'), 'still literal\n');

	await stagePaths(dir, ['kept.txt', 'new.txt', 'doomed.txt', 'weird[1]*.txt']);

	const { stdout } = git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], dir);
	// `<type> <XY> ... <path>` per entry; the path is the last field.
	const byPath = Object.fromEntries(stdout.split('\0').filter(Boolean).map((e) => {
		const fields = e.split(' ');
		return [fields[fields.length - 1], fields.slice(0, 2).join(' ')];
	}));
	assert.deepEqual(byPath, {
		'kept.txt': '1 M.',
		'doomed.txt': '1 D.',
		'new.txt': '1 A.',
		'weird[1]*.txt': '1 M.',
		'w.txt': '? w.txt'
	}, 'the bracketed name was staged as itself, and the file its glob would match was not');
});

test('write-tree, commit-tree and update-ref make one commit with the parent asked for, under the identity given', async (t) => {
	const { dir, base } = makeRepo(t);
	fs.writeFileSync(path.join(dir, 'kept.txt'), 'changed\n');
	await stagePaths(dir, ['kept.txt']);

	const tree = await writeTree(dir);
	const author = { name: 'WordPress Contributor Toolkit', email: 'noreply@localhost' };
	const oid = await commitTree(dir, { tree, parent: base, message: 'Work in progress', author });
	await updateBranch(dir, 'trunk', oid, { expected: base });

	assert.equal(git(['rev-parse', 'HEAD'], dir).stdout, oid);
	assert.equal(git(['log', '-1', '--format=%P%x00%an%x00%ae%x00%cn%x00%ce%x00%s', 'HEAD'], dir).stdout,
		[base, author.name, author.email, author.name, author.email, 'Work in progress'].join('\0'));
	assert.equal(git(['status', '--porcelain=v2'], dir).stdout, '', 'index, HEAD and worktree agree');
});

test('update-ref with a stale expected value refuses rather than overwriting', async (t) => {
	const { dir, base } = makeRepo(t);
	const tree = await writeTree(dir);
	const oid = await commitTree(dir, { tree, parent: base, message: 'x', author: { name: 'a', email: 'a@b' } });

	await assert.rejects(updateBranch(dir, 'trunk', oid, { expected: '0000000000000000000000000000000000000001' }), (e) => e.name === 'GitError' && e.code === 128);
	assert.equal(git(['rev-parse', 'HEAD'], dir).stdout, base);
});

test('createBranchAt and pointHeadAt move HEAD without touching the index or the worktree', async (t) => {
	const { dir, base } = makeRepo(t);
	fs.writeFileSync(path.join(dir, 'kept.txt'), 'loose edit\n');
	const indexBefore = fs.statSync(path.join(dir, '.git', 'index')).mtimeMs;

	await createBranchAt(dir, 'ticket/1', 'trunk');
	await pointHeadAt(dir, 'ticket/1');

	assert.equal(git(['symbolic-ref', '--short', 'HEAD'], dir).stdout, 'ticket/1');
	assert.equal(git(['rev-parse', 'ticket/1'], dir).stdout, base);
	assert.equal(fs.readFileSync(path.join(dir, 'kept.txt'), 'utf8'), 'loose edit\n');
	assert.equal(fs.statSync(path.join(dir, '.git', 'index')).mtimeMs, indexBefore, 'the index was not rewritten');
});

test('checkoutBranch restores tracked files, leaves ignored ones alone, and deleteBranch removes the ref', async (t) => {
	const { dir } = makeRepo(t);
	fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
	git(['add', '.gitignore'], dir);
	git([...IDENTITY, 'commit', '-q', '-m', 'ignore'], dir);
	fs.mkdirSync(path.join(dir, 'node_modules'));
	fs.writeFileSync(path.join(dir, 'node_modules', 'expensive.js'), 'expensive\n');
	await createBranchAt(dir, 'ticket/2', 'trunk');
	fs.writeFileSync(path.join(dir, 'kept.txt'), 'dirty\n');

	const phases = [];
	await checkoutBranch(dir, 'ticket/2', { onProgress: (e) => phases.push(e.phase) });

	assert.equal(git(['symbolic-ref', '--short', 'HEAD'], dir).stdout, 'ticket/2');
	assert.equal(fs.readFileSync(path.join(dir, 'kept.txt'), 'utf8'), 'kept\n', 'forced: the dirty file was reset');
	assert.equal(fs.readFileSync(path.join(dir, 'node_modules', 'expensive.js'), 'utf8'), 'expensive\n');
	for (const phase of phases) assert.match(phase, /^[a-z ]+$/);

	await checkoutBranch(dir, 'trunk');
	await deleteBranch(dir, 'ticket/2');
	assert.equal(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], dir).stdout, 'trunk');
});

test('a checkout of a ref that does not exist rejects with Git\'s reason', async (t) => {
	const { dir } = makeRepo(t);
	await assert.rejects(checkoutBranch(dir, 'ticket/404'), (e) => {
		assert.equal(e.name, 'GitError');
		assert.match(e.message, /^git checkout failed \(1\): error: pathspec 'ticket\/404'/);
		return true;
	});
});
