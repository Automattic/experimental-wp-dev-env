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
//
// Nothing Git reads from the environment is inherited from the host either.
// dugite itself honours LOCAL_GIT_DIRECTORY and GIT_EXEC_PATH, so a mentor
// who exported either would swap the bundled binary for whatever they point
// at; GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE would redirect every command
// to a repository the app never chose; GIT_CONFIG_COUNT would inject config.
// Every `GIT_*` variable is therefore dropped before dugite sees the base env,
// and the ones the app relies on are set from PINNED_ENV afterwards. A caller
// that needs one more (GIT_TRACE while debugging, say) passes it as
// `extraEnv`; it cannot override a pinned value.

const dugite = require('dugite');

// Variables a Node child needs and a Git child must not see.
const NODE_ONLY_ENV = Object.freeze(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']);

// Host variables, on top of every `GIT_*`, that would change which Git runs
// or whether it stops to ask a human.
const HOST_ONLY_ENV = Object.freeze(['LOCAL_GIT_DIRECTORY', 'SSH_ASKPASS']);

// Everything the bundled Git must be told. #350's second invariant read
// forwards: a Git that picks up the host's config, or stops to ask a human
// for credentials, is a Git whose behaviour the app cannot predict. Every
// fetch the app makes is anonymous over public HTTPS, so there is nothing to
// authenticate and nothing to prompt for. No value here is an empty string:
// an empty variable is not guaranteed to survive a Windows environment block.
const PINNED_ENV = Object.freeze({
	// dugite's own system gitconfig `include`s the host's /etc/gitconfig, so
	// without this a mentor's machine could change what the app does. On
	// Windows this also drops MinGit's system config (autocrlf, the
	// credential manager, the SSL backend), which a later phase pins itself
	// with `-c` once a flow needs them.
	GIT_CONFIG_NOSYSTEM: '1',
	// The global config is the mentor's ~/.gitconfig: url.insteadOf,
	// core.hooksPath, commit.gpgsign or filter.lfs there would all change
	// what the app does (and LFS is trimmed from the bundle). Git documents
	// /dev/null as "no file" for this variable, and Git for Windows maps the
	// name itself, so the literal works on every platform.
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_TERMINAL_PROMPT: '0'
});

// Arguments every Git call site puts before its own. `credential.helper` is
// cleared here rather than through GIT_CONFIG_COUNT, whose value would have
// to be an empty string (see PINNED_ENV).
const BASE_ARGS = Object.freeze(['-c', 'credential.helper=']);

// Spawn options every Git call site uses, matching spawnRunner in main.js:
// no shell (arguments are passed as an array, never interpolated), no
// console window flashing up on Windows, and a process group of its own on
// POSIX so killChildTree can take the helpers Git forks (`git-remote-https`
// on a cancelled clone) down with it.
const SPAWN_OPTIONS = Object.freeze({
	shell: false,
	windowsHide: true,
	detached: process.platform !== 'win32'
});

function stripHostEnv(baseEnv) {
	const base = {};
	for (const [name, value] of Object.entries(baseEnv)) {
		if (name.startsWith('GIT_') || NODE_ONLY_ENV.includes(name) || HOST_ONLY_ENV.includes(name)) {
			continue;
		}
		base[name] = value;
	}
	return base;
}

function resolveGitBinary({ processEnv = process.env } = {}) {
	return dugite.setupEnvironment({}, stripHostEnv(processEnv)).gitLocation;
}

function buildGitEnv({ baseEnv = process.env, extraEnv = {} } = {}) {
	const { env } = dugite.setupEnvironment({ ...extraEnv, ...PINNED_ENV }, stripHostEnv(baseEnv));
	return env;
}

module.exports = {
	resolveGitBinary,
	buildGitEnv,
	BASE_ARGS,
	SPAWN_OPTIONS,
	PINNED_ENV,
	NODE_ONLY_ENV,
	HOST_ONLY_ENV
};
