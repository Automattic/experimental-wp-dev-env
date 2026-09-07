const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveGitBinary, buildGitEnv, BASE_ARGS, SPAWN_OPTIONS } = require('../../src/git-binary.cjs');

// What the bundled Git is told before it runs — the environment #350's second
// invariant depends on. These are pure: nothing here spawns anything, so the
// shape can be checked on any machine with the base env injected, including
// the one a Node child would have been given and the one a mentor who has
// tuned their own Git would hand the app.

const BUNDLED = path.join('node_modules', 'dugite', 'git') + path.sep;

test('the resolved binary lives inside the dugite package, not on the host', () => {
	const binary = resolveGitBinary({ processEnv: {} });
	assert.ok(binary.includes(BUNDLED), `${binary} does not point into the bundled tree`);
	assert.ok(path.isAbsolute(binary));
});

test('a host that points at its own Git still gets the bundled one', () => {
	// dugite honours LOCAL_GIT_DIRECTORY and GIT_EXEC_PATH from the process
	// env; both would swap the binary or its helpers for the host's.
	const hostEnv = {
		PATH: '/opt/homebrew/bin:/usr/bin',
		LOCAL_GIT_DIRECTORY: '/opt/homebrew',
		GIT_EXEC_PATH: '/opt/homebrew/libexec/git-core'
	};
	const binary = resolveGitBinary({ processEnv: hostEnv });
	assert.ok(binary.includes(BUNDLED), `${binary} was taken from LOCAL_GIT_DIRECTORY`);

	const env = buildGitEnv({ baseEnv: hostEnv });
	assert.ok(env.GIT_EXEC_PATH.includes(BUNDLED), `${env.GIT_EXEC_PATH} was inherited`);
	assert.equal(env.LOCAL_GIT_DIRECTORY, undefined);
});

test('a host that points at its own Git through the real process env still gets the bundled one', () => {
	// The test above hands the module a base env with the variables absent,
	// which is exactly the case dugite's resolvers answer from process.env:
	// their parameters default to it, so a stripped variable is read back from
	// the host. This one sets the real process env, the way an exported
	// variable reaches the app, and asks with no base env at all.
	const saved = { LOCAL_GIT_DIRECTORY: process.env.LOCAL_GIT_DIRECTORY, GIT_EXEC_PATH: process.env.GIT_EXEC_PATH };
	process.env.LOCAL_GIT_DIRECTORY = path.join(path.sep, 'review-host-git');
	process.env.GIT_EXEC_PATH = path.join(path.sep, 'review-host-helpers');
	try {
		const binary = resolveGitBinary();
		assert.ok(binary.includes(BUNDLED), `${binary} was taken from the process env`);
		const env = buildGitEnv();
		assert.ok(env.GIT_EXEC_PATH.includes(BUNDLED), `${env.GIT_EXEC_PATH} was taken from the process env`);
		assert.equal(env.LOCAL_GIT_DIRECTORY, undefined);
		// And the neutralised pair leaves no empty string behind (Windows may
		// drop those from the block): one is removed, the other resolved. The
		// rest of the env is the host's, empty values and all.
		assert.notEqual(env.GIT_EXEC_PATH, '');
		assert.ok(!('LOCAL_GIT_DIRECTORY' in env));
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	}
});

test('the environment pins host config off and prompting off', () => {
	const env = buildGitEnv({ baseEnv: { HOME: '/home/mentor', PATH: '/usr/bin' } });
	assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
	assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
	assert.equal(env.GIT_TERMINAL_PROMPT, '0');
	// Layout is dugite's to decide; it must have decided something.
	assert.ok(env.GIT_EXEC_PATH, 'GIT_EXEC_PATH is unset');
	assert.ok(path.isAbsolute(env.GIT_EXEC_PATH));
	// The rest of the base env still comes through.
	assert.equal(env.HOME, '/home/mentor');
	assert.ok(env.PATH.includes('/usr/bin'));
	// No pinned value is an empty string: Windows may drop it from the block.
	for (const [name, value] of Object.entries(env)) {
		assert.notEqual(value, '', `${name} is pinned to an empty string`);
	}
});

test('no GIT_* variable and no askpass reaches Git from the host, whatever its case', () => {
	// Windows environment names are case-insensitive: `git_dir` is GIT_DIR.
	const env = buildGitEnv({
		baseEnv: {
			PATH: '/usr/bin',
			GIT_DIR: '/somewhere/else/.git',
			git_work_tree: '/somewhere/else',
			Git_Index_File: '/somewhere/else/.git/index',
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'core.hooksPath',
			GIT_CONFIG_VALUE_0: '/somewhere/hooks',
			GIT_ASKPASS: '/usr/local/bin/ask',
			ssh_askpass: '/usr/local/bin/ask',
			local_git_directory: '/opt/homebrew'
		}
	});
	for (const name of ['GIT_DIR', 'git_work_tree', 'Git_Index_File', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_ASKPASS', 'ssh_askpass', 'local_git_directory']) {
		assert.equal(env[name], undefined, `${name} leaked through`);
	}
	assert.ok(env.GIT_EXEC_PATH.includes(BUNDLED));
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

test('a caller can add to the environment but cannot unpin or redirect it', () => {
	const env = buildGitEnv({ baseEnv: {}, extraEnv: { GIT_TRACE: '1' } });
	assert.equal(env.GIT_TRACE, '1');
	assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');

	for (const extraEnv of [
		{ GIT_CONFIG_NOSYSTEM: '0' },
		{ git_config_global: '/home/mentor/.gitconfig' },
		{ GIT_DIR: '/somewhere/else/.git' },
		{ GIT_CONFIG_COUNT: '1' },
		{ GIT_ASKPASS: '/usr/local/bin/ask' },
		{ LOCAL_GIT_DIRECTORY: '/opt/homebrew' }
	]) {
		assert.throws(() => buildGitEnv({ baseEnv: {}, extraEnv }), TypeError, JSON.stringify(extraEnv));
	}
});

test('the base arguments clear the credential helper and are frozen', () => {
	assert.deepEqual([...BASE_ARGS], ['-c', 'credential.helper=']);
	assert.ok(Object.isFrozen(BASE_ARGS));
});

test('spawn options never open a shell, hide the console on Windows and lead a group on POSIX', () => {
	assert.equal(SPAWN_OPTIONS.shell, false);
	assert.equal(SPAWN_OPTIONS.windowsHide, true);
	assert.equal(SPAWN_OPTIONS.detached, process.platform !== 'win32');
	assert.ok(Object.isFrozen(SPAWN_OPTIONS));
});
