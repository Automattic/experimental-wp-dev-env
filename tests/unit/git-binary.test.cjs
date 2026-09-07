const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveGitBinary, buildGitEnv, SPAWN_OPTIONS } = require('../../src/git-binary.cjs');

// What the bundled Git is told before it runs — the environment #350's second
// invariant depends on. These are pure: nothing here spawns anything, so the
// shape can be checked on any machine with the base env injected, including
// the one a Node child would have been given.

test('the resolved binary lives inside the dugite package, not on the host', () => {
	const binary = resolveGitBinary({ processEnv: {} });
	const inside = path.join('node_modules', 'dugite', 'git') + path.sep;
	assert.ok(binary.includes(inside), `${binary} does not point into the bundled tree`);
	assert.ok(path.isAbsolute(binary));
});

test('the environment pins system config off and prompting off', () => {
	const env = buildGitEnv({ baseEnv: { HOME: '/home/mentor', PATH: '/usr/bin' } });
	assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
	assert.equal(env.GIT_TERMINAL_PROMPT, '0');
	assert.equal(env.GIT_ASKPASS, '');
	assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
	assert.equal(env.GIT_CONFIG_VALUE_0, '');
	// Layout is dugite's to decide; it must have decided something.
	assert.ok(env.GIT_EXEC_PATH, 'GIT_EXEC_PATH is unset');
	assert.ok(path.isAbsolute(env.GIT_EXEC_PATH));
	// The base env still comes through — Git needs HOME for its global config.
	assert.equal(env.HOME, '/home/mentor');
});

test('a Node child environment does not leak into Git', () => {
	const env = buildGitEnv({
		baseEnv: {
			PATH: '/usr/bin',
			ELECTRON_RUN_AS_NODE: '1',
			NODE_OPTIONS: '--require /tmp/win-spawn-patch.js'
		}
	});
	assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
});

test('a caller can add to the environment but not silently unpin it', () => {
	const env = buildGitEnv({ baseEnv: {}, extraEnv: { GIT_TRACE: '1' } });
	assert.equal(env.GIT_TRACE, '1');
	assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
});

test('spawn options never open a shell and never show a console on Windows', () => {
	assert.equal(SPAWN_OPTIONS.shell, false);
	assert.equal(SPAWN_OPTIONS.windowsHide, true);
	assert.ok(Object.isFrozen(SPAWN_OPTIONS));
});
