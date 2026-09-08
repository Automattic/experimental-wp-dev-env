const test = require('node:test');
const assert = require('node:assert/strict');

const read = require('../../src/git-read.cjs');

// The parsers are pure functions over bytes, so these feed them the exact
// byte layouts Git documents for each porcelain format, including the shapes
// only a hostile repository produces (a stray rename entry, a NUL inside a
// blob, a path with a space). The same commands against a repository the
// bundled Git built are in git-read.integration.test.cjs.

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
		['D.', [1, 0, 0]],
		['T.', [1, 2, 2]],
		['.T', [1, 2, 1]],
		// Intent-to-add: not in HEAD, on disk, a placeholder in the index.
		['.A', [0, 2, 0]]
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
		['gone.php', 1, 0, 0]
	]);
});

test('status v2: a path removed from the index but kept on disk is one row, not two', () => {
	// `git rm --cached keep.php` makes Git report the path twice.
	const buf = z('1 D. N... 100644 000000 000000 hhhh 0000 keep.php', '? keep.php', '? other.txt');
	assert.deepEqual(read.parseStatusV2Z(buf), [
		['keep.php', 1, 2, 0],
		['other.txt', 0, 2, 0]
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

test('cat-file --batch: a missing echo with a newline in the path stops the parse instead of poisoning it', () => {
	const buf = Buffer.from('HEAD:b\nnope.txt missing\n1111111111111111111111111111111111111111 blob 2\nhi\n');
	const answers = read.parseCatFileBatch(buf, ['HEAD:b\nnope.txt', 'HEAD:ok.txt']);
	assert.equal(answers.get('HEAD:b\nnope.txt'), undefined);
	assert.equal(answers.get('HEAD:ok.txt'), undefined);
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

test('windowsArgs: long paths ride along with the autocrlf view on Windows, and nothing does elsewhere', async () => {
	const runWith = (status) => async () => ({ status, stdout: Buffer.alloc(0), stderr: '' });
	assert.deepEqual(await read.windowsArgs('/site', { platform: 'win32', run: runWith(1) }), ['-c', 'core.autocrlf=true', '-c', 'core.longpaths=true']);
	assert.deepEqual(await read.windowsArgs('/site', { platform: 'win32', run: runWith(0) }), ['-c', 'core.longpaths=true']);
	assert.deepEqual(await read.windowsArgs('/site', { platform: 'darwin', run: runWith(1) }), []);
});

test('on Windows the autocrlf view and long paths reach the status and diff commands themselves', async () => {
	// A dropped spread here would be green on every other platform and bring
	// back the ~5,000 phantom modifications of a CRLF checkout.
	const argv = [];
	const run = async (args) => {
		argv.push(args);
		return { status: args[0] === 'config' ? 1 : 0, stdout: Buffer.alloc(0), stderr: '' };
	};
	await read.statusRows('/site', { platform: 'win32', run });
	await read.changesAgainst('/site', 'abc', { platform: 'win32', run });
	const commands = argv.filter((args) => args[0] !== 'config');
	assert.equal(commands.length, 3);
	for (const args of commands) {
		assert.deepEqual(args.slice(0, 4), ['-c', 'core.autocrlf=true', '-c', 'core.longpaths=true'], args.join(' '));
	}
	assert.deepEqual(commands.map((args) => args[4]), ['status', 'diff', 'ls-files']);
});


test('isLegacySite reads no config when the repository is not shallow (#385)', async () => {
	const seen = [];
	const run = async (args, options) => { seen.push({ args, options }); return { status: 1, stdout: Buffer.alloc(0), stderr: '' }; };
	// A directory with no .git/shallow: the answer is known without a spawn.
	assert.equal(await read.isLegacySite(__dirname, { run }), false);
	assert.deepEqual(seen, []);
});

test('merge-tree -z --name-only: the tree, then the conflicted paths once each, the messages dropped (#385)', () => {
	assert.deepEqual(read.parseMergeTreeZ(Buffer.from('abc123\0')), { tree: 'abc123', conflicts: [] });
	assert.deepEqual(read.parseMergeTreeZ(Buffer.from('abc123\n')), { tree: 'abc123', conflicts: [] });
	const conflicted = z('abc123', 'src/wp-login.php', 'src/wp-login.php', 'with space.txt', '', '1', 'src/wp-login.php', 'Auto-merging', 'Auto-merging src/wp-login.php\n', '2', 'src/wp-login.php', 'with space.txt', 'CONFLICT (contents)', 'CONFLICT (content): Merge conflict\n');
	assert.deepEqual(read.parseMergeTreeZ(conflicted), { tree: 'abc123', conflicts: ['src/wp-login.php', 'with space.txt'] });
	assert.deepEqual(read.parseMergeTreeZ(Buffer.alloc(0)), { tree: '', conflicts: [] });
});

test('mergeTree is one merge-tree call whose exit code says whether the tree is usable (#385)', async () => {
	const calls = [];
	const run = async (args, options) => {
		calls.push({ args, options });
		return args.includes('bad') ? { status: 1, stdout: z('t2', 'a.php', ''), stderr: '' } : { status: 0, stdout: Buffer.from('t1\0'), stderr: '' };
	};
	assert.deepEqual(await read.mergeTree('/sites/wp', { base: 'b', ours: 'o', theirs: 'good' }, { run }), { tree: 't1', conflicts: [] });
	assert.deepEqual(await read.mergeTree('/sites/wp', { base: 'b', ours: 'o', theirs: 'bad' }, { run }), { tree: 't2', conflicts: ['a.php'] });
	assert.deepEqual(calls[0].args, ['merge-tree', '--write-tree', '-z', '--name-only', '--merge-base=b', 'o', 'good']);
	assert.deepEqual(calls[0].options, { cwd: '/sites/wp', okCodes: [0, 1] });
});

test('remoteUrl is one config read, null when the remote is not there (#385)', async () => {
	const run = async (args, options) => {
		assert.deepEqual(options, { cwd: '/sites/wp', okCodes: [0, 1] });
		return args[3] === 'remote.origin.url' ? { status: 0, stdout: Buffer.from('https://example.test/wp.git\n'), stderr: '' } : { status: 1, stdout: Buffer.alloc(0), stderr: '' };
	};
	assert.equal(await read.remoteUrl('/sites/wp', 'origin', { run }), 'https://example.test/wp.git');
	assert.equal(await read.remoteUrl('/sites/wp', 'upstream', { run }), null);
});

test('isAncestor is one merge-base question, answered by the exit code (#385)', async () => {
	const calls = [];
	const run = async (args, options) => { calls.push({ args, options }); return { status: args.includes('yes') ? 0 : 1, stdout: Buffer.alloc(0), stderr: '' }; };
	assert.equal(await read.isAncestor('/sites/wp', 'yes', 'head1', { run }), true);
	assert.equal(await read.isAncestor('/sites/wp', 'no', 'head1', { run }), false);
	assert.deepEqual(calls[0].args, ['merge-base', '--is-ancestor', 'yes', 'head1']);
	assert.deepEqual(calls[0].options, { cwd: '/sites/wp', okCodes: [0, 1] });
});
