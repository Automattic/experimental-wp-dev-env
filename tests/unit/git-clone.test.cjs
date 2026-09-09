const test = require('node:test');
const assert = require('node:assert/strict');

const { cloneArgs } = require('../../src/git-clone.cjs');

// The argument list, without a Git. The progress reader it shares with the
// checkout is tested in git-progress.test.cjs; the clone itself runs in
// git-clone.integration.test.cjs.

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
