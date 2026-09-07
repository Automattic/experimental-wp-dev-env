// The Git binary the app ships, and the environment it must be spawned with.
//
// Phase 1 of #364 (#383): the binary is in the bundle and nothing calls it
// yet. Every later phase reaches Git through this module and nowhere else, so
// the two things a caller can get wrong — where the binary is, and what it
// inherits — are decided once, here.
//
// Layout is delegated to dugite rather than joined by hand. It differs per
// platform in three places at once: on Windows the binary is `cmd/git.exe`
// rather than `bin/git`, the exec path sits under `mingw64/libexec/git-core`,
// and `PATH` has to carry `mingw64/bin` and `mingw64/usr/bin` or the helpers
// Git shells out to are not found. On macOS, GIT_EXEC_PATH left unset makes
// `git --exec-path` read `//libexec/git-core`. dugite also rewrites
// `app.asar` to `app.asar.unpacked`, which is the other half of the
// `asarUnpack` rule in package.json — a binary cannot execute from inside
// the archive.
//
// This is deliberately not `buildChildEnv` from npm-runner.js. That env is
// for Node children: ELECTRON_RUN_AS_NODE turns the spawned Electron into
// Node, and NODE_OPTIONS preloads the Windows spawn patch into it. Neither
// means anything to Git, and both would leak into any process Git itself
// spawns (an editor, a hook, `ssh`), so they are stripped rather than
// inherited.

const dugite = require('dugite');

// Variables a Node child needs and a Git child must not see.
const NODE_ONLY_ENV = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

// Everything the bundled Git must be told, and nothing it should be allowed
// to inherit. #350's second invariant read forwards: a Git that picks up the
// host's system config, or stops to ask a human for credentials, is a Git
// whose behaviour the app cannot predict. Every fetch the app makes is
// anonymous over public HTTPS, so there is nothing to authenticate and
// nothing to prompt for.
const PINNED_ENV = {
	// dugite's own system gitconfig `include`s the host's /etc/gitconfig, so
	// without this a mentor's machine could change what the app does.
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_ASKPASS: '',
	// Clears any credential helper the global config might name, through the
	// one mechanism that overrides config from the environment.
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: 'credential.helper',
	GIT_CONFIG_VALUE_0: ''
};

// Spawn options every Git call site uses, matching spawnRunner in main.js:
// no shell (arguments are passed as an array, never interpolated), and no
// console window flashing up on Windows.
const SPAWN_OPTIONS = Object.freeze({ shell: false, windowsHide: true });

function resolveGitBinary({ processEnv = process.env } = {}) {
	return dugite.setupEnvironment({}, processEnv).gitLocation;
}

function buildGitEnv({ baseEnv = process.env, extraEnv = {} } = {}) {
	const base = { ...baseEnv };
	for (const name of NODE_ONLY_ENV) {
		delete base[name];
	}
	const { env } = dugite.setupEnvironment({ ...PINNED_ENV, ...extraEnv }, base);
	return env;
}

module.exports = {
	resolveGitBinary,
	buildGitEnv,
	SPAWN_OPTIONS,
	PINNED_ENV,
	NODE_ONLY_ENV
};
