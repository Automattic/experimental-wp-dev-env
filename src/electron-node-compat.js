// Preloaded (via NODE_OPTIONS=--require) into every descendant Node process, so
// that the tools this app spawns see the plain Node they are actually running
// on.
//
// Why this is needed: the only `node` on PATH is the shim written by
// ensureNodeShimDir() in main.js, and that shim is Electron under
// ELECTRON_RUN_AS_NODE. Electron keeps `process.versions.electron` set in that
// mode, and a command-line tool built on yargs reads exactly that to decide
// where its arguments begin — `yargs/helpers.hideBin` reads "electron set,
// defaultApp unset" as a packaged Electron app and slices argv one element
// short. Every such tool then sees its own executable path as the first
// argument it was passed.
//
// For a task runner that extra argument is a command to run, so it runs itself
// with no arguments, and the copy it starts does the same, without end: a
// Gutenberg build reached ~1300 processes before the machine gave out (#275).
// The runaway processes are only the loudest form of the failure — the general
// one is that every yargs-based tool reached through the shim misreads its
// arguments, quietly.
//
// Deliberately self-contained (no requires at all): this file is copied into the
// temp shim dir and required from there, because --require into a path inside
// app.asar is not reliable under ELECTRON_RUN_AS_NODE.

// Only `versions.electron` is hidden, and the narrowness is load-bearing.
//
// `versions.chrome` was hidden alongside it at first — it is the other half of
// how the runtime describes itself — and that broke Gutenberg's bundling step
// outright, while the recursion it was meant to help with was already gone.
// Build tooling reads `chrome` to decide what it is compiling for, which is a
// question about the output, not about who is running the compiler. `versions.v8`
// carries an `-electron` suffix and is left alone for the same reason, plus a
// blunter one: tools parse it as a version number.
//
// So this hides the runtime from code asking "am I inside Electron?", and hides
// nothing from code asking "what can I emit?".
const ELECTRON_VERSION_KEYS = ['electron'];

// Returns the keys actually removed, so a caller (and the tests) can tell the
// difference between "nothing to hide" and "could not hide it". A frozen
// `versions` object would make the delete a silent no-op in sloppy mode, hence
// re-reading the key rather than trusting `delete`'s return value.
// A default parameter, not `proc || process`: falling back on a null argument
// would quietly strip the *current* process, which under the Electron test pass
// is the suite itself.
function hideElectronRuntime(proc = process) {
	const versions = proc && proc.versions;
	if (!versions) return [];
	const hidden = [];
	for (const key of ELECTRON_VERSION_KEYS) {
		if (versions[key] === undefined) continue;
		delete versions[key];
		if (versions[key] === undefined) hidden.push(key);
	}
	return hidden;
}

// Only self-applies when the app explicitly asked for it, so requiring this
// module from a test never mutates the test process.
if (process.env.WPTK_NODE_COMPAT === '1') {
	hideElectronRuntime(process);
}

module.exports = { hideElectronRuntime, ELECTRON_VERSION_KEYS };
