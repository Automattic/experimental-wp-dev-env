const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = require('../../src/git-read.cjs');
const { git, tempDir, removeRepo } = require('./helpers/git.cjs');

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

test('isAncestor: the branch point is an ancestor of the tip, not the other way round, and an unknown oid rejects (#385)', async (t) => {
	const dir = makeRepo(t);
	const base = git(['rev-parse', 'HEAD'], dir).stdout;
	fs.writeFileSync(path.join(dir, 'with space.txt'), 'changed\n');
	assert.equal(git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'second'], dir).status, 0);
	const tip = git(['rev-parse', 'HEAD'], dir).stdout;

	assert.equal(await read.isAncestor(dir, base, tip), true);
	assert.equal(await read.isAncestor(dir, tip, base), false);
	assert.equal(await read.isAncestor(dir, tip, tip), true, 'a commit is its own ancestor');
	await assert.rejects(read.isAncestor(dir, '0000000000000000000000000000000000000001', tip), (error) => error.code === 128);
});

test('mergeTree merges two sides from a base without touching the index or the worktree, and names what conflicts (#385)', async (t) => {
	const dir = makeRepo(t);
	const commit = (msg) => { assert.equal(git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', msg], dir).status, 0); return git(['rev-parse', 'HEAD'], dir).stdout; };
	const base = git(['rev-parse', 'HEAD'], dir).stdout;
	fs.writeFileSync(path.join(dir, 'src', 'wp-login.php'), '<?php // login\n// theirs\n');
	const theirs = commit('theirs');
	assert.equal(git(['reset', '-q', '--hard', base], dir).status, 0);
	fs.writeFileSync(path.join(dir, 'with space.txt'), 'ours\n');
	const ours = commit('ours');
	const indexBefore = fs.statSync(path.join(dir, '.git', 'index')).mtimeMs;

	const clean = await read.mergeTree(dir, { base, ours, theirs });
	assert.equal(clean.conflicted, false);
	assert.deepEqual(clean.conflicts, []);
	assert.equal(git(['show', `${clean.tree}:src/wp-login.php`], dir).stdout, '<?php // login\n// theirs');
	assert.equal(git(['show', `${clean.tree}:with space.txt`], dir).stdout, 'ours');
	assert.equal(fs.statSync(path.join(dir, '.git', 'index')).mtimeMs, indexBefore, 'the index was not written');
	assert.equal(git(['status', '--porcelain=v2'], dir).stdout, '', 'nor the worktree');

	// base == ours: nothing to merge, theirs' tree comes back as it is.
	const same = await read.mergeTree(dir, { base, ours: base, theirs });
	assert.equal(same.tree, git(['rev-parse', `${theirs}^{tree}`], dir).stdout);

	fs.writeFileSync(path.join(dir, 'src', 'wp-login.php'), '<?php // login\n// ours too\n');
	const clash = commit('clash');
	const conflicted = await read.mergeTree(dir, { base, ours: clash, theirs });
	assert.equal(conflicted.conflicted, true);
	assert.deepEqual(conflicted.conflicts, ['src/wp-login.php']);
	assert.match(conflicted.tree, /^[0-9a-f]{40}$/, 'a tree is still written, with markers, for whoever wants it');
	await assert.rejects(read.mergeTree(dir, { base, ours: '0000000000000000000000000000000000000001', theirs }), (e) => e.code === 128);
});

// #351's acceptance bar for the one three-way merge the app performs: the
// files `mergeTree` names are the files `git merge` leaves unmerged, and the
// markers in the tree it writes sit on the same lines as the markers `git
// merge` leaves in a worktree. One fixture per conflict shape a ticket and a
// moving trunk actually produce; the clean shapes prove the app refuses
// nothing Git would accept.
const MERGE_BASE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const withLine = (text, n, replacement) => text.split('\n').map((l, i) => (i === n - 1 ? replacement : l)).join('\n');
const markerRegions = (text) => {
	const regions = [];
	let start = -1;
	text.split('\n').forEach((line, i) => {
		if (line.startsWith('<<<<<<<')) start = i + 1;
		if (line.startsWith('>>>>>>>') && start !== -1) { regions.push(`${start}-${i + 1}`); start = -1; }
	});
	return regions;
};

const MERGE_SHAPES = [
	{ name: 'same lines', ours: { 'a.php': withLine(MERGE_BASE, 10, 'line 10 OURS') }, theirs: { 'a.php': withLine(MERGE_BASE, 10, 'line 10 THEIRS') }, conflicts: ['src/a.php'] },
	{ name: 'same file, far apart', ours: { 'a.php': withLine(MERGE_BASE, 3, 'line 3 OURS') }, theirs: { 'a.php': withLine(MERGE_BASE, 25, 'line 25 THEIRS') }, conflicts: [] },
	{ name: 'same file, adjacent lines', ours: { 'a.php': withLine(MERGE_BASE, 10, 'line 10 OURS') }, theirs: { 'a.php': withLine(MERGE_BASE, 12, 'line 12 THEIRS') }, conflicts: [] },
	{ name: 'rename on trunk, modify on the ticket', ours: { 'a.php': null, 'b.php': MERGE_BASE }, theirs: { 'a.php': withLine(MERGE_BASE, 15, 'line 15 THEIRS') }, conflicts: [] },
	{ name: 'delete on trunk, modify on the ticket', ours: { 'a.php': null }, theirs: { 'a.php': withLine(MERGE_BASE, 15, 'line 15 THEIRS') }, conflicts: ['src/a.php'] },
	{ name: 'modify on trunk, delete on the ticket', ours: { 'a.php': withLine(MERGE_BASE, 15, 'line 15 OURS') }, theirs: { 'a.php': null }, conflicts: ['src/a.php'] },
	{ name: 'same new path on both sides', ours: { 'new.php': '<?php // ours\n' }, theirs: { 'new.php': '<?php // theirs\n' }, conflicts: ['src/new.php'] },
	{ name: 'three regions, one clashing', ours: { 'a.php': withLine(MERGE_BASE, 15, 'line 15 OURS') }, theirs: { 'a.php': withLine(withLine(withLine(MERGE_BASE, 3, 'line 3 THEIRS'), 15, 'line 15 THEIRS'), 27, 'line 27 THEIRS') }, conflicts: ['src/a.php'] }
];

for (const shape of MERGE_SHAPES) {
	test(`mergeTree names the files and regions git merge would, ${shape.name} (#351)`, async (t) => {
		const dir = makeRepo(t);
		const author = ['-c', 'user.name=T', '-c', 'user.email=t@example.com'];
		const writeSide = (files) => {
			for (const [name, content] of Object.entries(files)) {
				const abs = path.join(dir, 'src', name);
				if (content === null) fs.rmSync(abs);
				else fs.writeFileSync(abs, content);
			}
			assert.equal(git(['add', '-A'], dir).status, 0);
			assert.equal(git([...author, 'commit', '-q', '-m', 'side'], dir).status, 0);
			return git(['rev-parse', 'HEAD'], dir).stdout;
		};
		fs.writeFileSync(path.join(dir, 'src', 'a.php'), MERGE_BASE);
		assert.equal(git(['add', '-A'], dir).status, 0);
		assert.equal(git([...author, 'commit', '-q', '-m', 'base'], dir).status, 0);
		const base = git(['rev-parse', 'HEAD'], dir).stdout;
		const theirs = writeSide(shape.theirs);
		assert.equal(git(['reset', '-q', '--hard', base], dir).status, 0);
		const ours = writeSide(shape.ours);

		// What Git itself would show: a real merge in a throwaway worktree,
		// the unmerged paths from the index and the markers from disk.
		const worktree = path.join(dir, '..', `${path.basename(dir)}-merge`);
		assert.equal(git(['worktree', 'add', '-q', '--detach', worktree, ours], dir).status, 0);
		// The fixture's own cleanup registered first and runs first, taking
		// the repository with it, so the worktree is removed as a directory
		// (with #381's read-only objects in mind) rather than through Git.
		t.after(() => removeRepo(worktree));
		const merge = git([...author, 'merge', '--no-ff', '--no-commit', theirs], worktree);
		const unmerged = git(['diff', '--name-only', '--diff-filter=U'], worktree).stdout.split('\n').filter(Boolean);
		assert.equal(merge.status, unmerged.length ? 1 : 0, merge.stderr);

		const result = await read.mergeTree(dir, { base, ours, theirs });
		assert.deepEqual(unmerged, shape.conflicts, 'the fixture produces the shape it claims');
		assert.equal(result.conflicted, unmerged.length > 0);
		assert.deepEqual(result.conflicts, unmerged, 'same files');
		// Same kind, too: the word `git merge` prints in `CONFLICT (…)` for
		// each path is the one the app hands the refusal (#351).
		const printed = {};
		for (const line of merge.stdout.split('\n')) {
			const m = line.match(/^CONFLICT \(([^)]+)\): (?:Merge conflict in (.+)|(\S+) deleted in)/);
			if (m) printed[m[2] || m[3]] = m[1];
		}
		assert.deepEqual(result.kinds, printed, 'same kinds');
		for (const relPath of unmerged) {
			const onDisk = fs.existsSync(path.join(worktree, relPath)) ? fs.readFileSync(path.join(worktree, relPath), 'utf8') : null;
			const inTree = git(['show', `${result.tree}:${relPath}`], dir);
			// Git's merge leaves the modified side in place when the other side
			// deleted it: no markers on either side, and that is the agreement.
			assert.deepEqual(inTree.status === 0 ? markerRegions(inTree.stdout) : [], onDisk === null ? [] : markerRegions(onDisk), `same regions in ${relPath}`);
		}
	});
}
