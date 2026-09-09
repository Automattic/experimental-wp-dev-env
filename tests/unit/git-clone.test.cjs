const test = require('node:test');
const assert = require('node:assert/strict');

const { cloneArgs, parseProgressLines, createProgressReader } = require('../../src/git-clone.cjs');

// The argument list and the progress reader, without a Git. The clone itself
// runs in git-clone.integration.test.cjs.

test('the clone is partial, single-branch on trunk, and writes the repository config it relies on', () => {
	const args = cloneArgs({ url: 'https://example.test/wp.git', dir: '/sites/wp', platform: 'darwin' });
	assert.equal(args[0], 'clone');
	assert.ok(args.includes('--filter=blob:none'), 'partial clone');
	assert.ok(!args.some((a) => a.startsWith('--depth')), 'not shallow');
	assert.ok(args.includes('--single-branch'));
	assert.deepEqual(args.slice(args.indexOf('--branch'), args.indexOf('--branch') + 2), ['--branch', 'trunk']);
	assert.ok(args.includes('--progress'));
	const configs = args.filter((a, i) => args[i - 1] === '--config');
	assert.deepEqual(configs, ['core.autocrlf=false', 'core.symlinks=false']);
	// `--` before the url: a url or a directory starting with `-` is data.
	assert.deepEqual(args.slice(-3), ['--', 'https://example.test/wp.git', '/sites/wp']);
});

test('Windows also gets long paths, which wordpress-develop needs', () => {
	const args = cloneArgs({ url: 'u', dir: 'C:\\Sites\\wp', platform: 'win32' });
	assert.ok(args.includes('core.longpaths=true'));
	assert.ok(!cloneArgs({ url: 'u', dir: '/s', platform: 'linux' }).includes('core.longpaths=true'));
});

test('progress lines parse with and without the remote: prefix, and other lines are dropped', () => {
	const text = [
		"Cloning into '/sites/wp'...",
		'remote: Enumerating objects: 4, done.        ',
		'remote: Counting objects:  25% (1/4)        \rremote: Counting objects: 100% (4/4), done.        ',
		'Receiving objects:  42% (1234/5678), 12.00 MiB | 3.00 MiB/s',
		'Resolving deltas: 100% (10/10), done.',
		'Updating files:  50% (100/200)',
		'warning: something unrelated'
	].join('\n');
	assert.deepEqual(parseProgressLines(text), [
		{ phase: 'counting objects', percent: 25, loaded: 1, total: 4 },
		{ phase: 'counting objects', percent: 100, loaded: 4, total: 4 },
		{ phase: 'receiving objects', percent: 42, loaded: 1234, total: 5678 },
		{ phase: 'resolving deltas', percent: 100, loaded: 10, total: 10 },
		{ phase: 'updating files', percent: 50, loaded: 100, total: 200 }
	]);
});

test('a percentage split across two chunks is reported once, whole', () => {
	const seen = [];
	const reader = createProgressReader((e) => seen.push(e));
	reader.push('Receiving objects:  4');
	assert.deepEqual(seen, [], 'nothing until the line ends');
	reader.push('2% (1234/5678)\rReceiving objects:  5');
	assert.deepEqual(seen, [{ phase: 'receiving objects', percent: 42, loaded: 1234, total: 5678 }]);
	reader.push('0% (2900/5678)\n');
	assert.equal(seen.length, 2);
	assert.equal(seen[1].percent, 50);
	reader.push('Updating files: 100% (200/200)');
	reader.flush();
	assert.equal(seen[2].phase, 'updating files');
});
