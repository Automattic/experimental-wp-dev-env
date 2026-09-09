const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { cloneSite } = require('../../src/git-clone.cjs');
const { git, tempDir } = require('./helpers/git.cjs');

// A real clone by the bundled Git, from a local repository over `file://`
// (a transport isomorphic-git never had, which is why the trunk-update suite
// still carries a loopback HTTP server). Offline; the partial-clone filter
// needs the source to allow it, which GitHub does and this fixture opts into.

function makeSource(t) {
	const src = tempDir(t, 'toolkit-clone-src-');
	assert.equal(git(['init', '-q', '-b', 'trunk'], src).status, 0);
	const commit = (msg) => assert.equal(git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', msg], src).status, 0);
	fs.mkdirSync(path.join(src, 'src'));
	fs.writeFileSync(path.join(src, 'src', 'wp-login.php'), '<?php // one\n');
	assert.equal(git(['add', '.'], src).status, 0);
	commit('one');
	fs.writeFileSync(path.join(src, 'src', 'wp-login.php'), '<?php // two\n');
	commit('two');
	assert.equal(git(['config', 'uploadpack.allowFilter', 'true'], src).status, 0);
	return src;
}

test('a site is cloned partial, on trunk, with the config the app relies on, and reports progress', async (t) => {
	const src = makeSource(t);
	const parent = tempDir(t, 'toolkit clone dest-');
	const dir = path.join(parent, 'wp site');
	const events = [];
	let child = null;

	const result = await cloneSite({ url: pathToFileURL(src).href, dir, onProgress: (e) => events.push(e), onChild: (c) => { child = c; } });
	assert.equal(result.dir, dir);
	assert.ok(child && typeof child.pid === 'number', 'the child was handed out for the quit sweep');

	// The checkout is trunk at its tip, with the whole history and no shallow
	// boundary, and the blob of the older commit was not fetched.
	assert.equal(fs.readFileSync(path.join(dir, 'src', 'wp-login.php'), 'utf8'), '<?php // two\n');
	assert.equal(git(['symbolic-ref', '--short', 'HEAD'], dir).stdout, 'trunk');
	assert.equal(git(['rev-parse', '--is-shallow-repository'], dir).stdout, 'false');
	assert.equal(git(['rev-list', '--count', 'HEAD'], dir).stdout, '2');
	const missing = git(['rev-list', '--objects', '--missing=print', 'HEAD'], dir).stdout.split('\n').filter((l) => l.startsWith('?'));
	assert.equal(missing.length, 1, 'exactly the older blob is left on the server');

	const config = git(['config', '--local', '--list'], dir).stdout.split('\n');
	for (const expected of ['core.autocrlf=false', 'core.symlinks=false', 'remote.origin.promisor=true', 'remote.origin.partialclonefilter=blob:none']) {
		assert.ok(config.includes(expected), `${expected} missing from:\n${config.join('\n')}`);
	}
	if (process.platform === 'win32') assert.ok(config.includes('core.longpaths=true'));

	// Progress came through as phases with counts; a local clone is quick, so
	// only the shape is asserted, not which phases showed up.
	assert.ok(events.length > 0, 'no progress events');
	for (const e of events) {
		assert.match(e.phase, /^[a-z ]+$/);
		assert.ok(Number.isInteger(e.loaded) && Number.isInteger(e.total) && e.total >= e.loaded);
	}
});

test('a clone that cannot start its transport rejects with Git\'s reason, and says nothing about progress', async (t) => {
	const parent = tempDir(t, 'toolkit-clone-fail-');
	const dir = path.join(parent, 'site');
	const events = [];
	await assert.rejects(
		cloneSite({ url: pathToFileURL(path.join(parent, 'no-such-repo')).href, dir, onProgress: (e) => events.push(e) }),
		(error) => {
			assert.equal(error.name, 'GitError');
			assert.equal(error.code, 128);
			assert.match(error.message, /^git clone failed \(128\): fatal:/);
			assert.ok(error.stderr.length > 0);
			return true;
		}
	);
	assert.deepEqual(events, []);
});
