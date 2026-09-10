// Preloaded (via NODE_OPTIONS=--require) into every descendant Node process on
// Windows so that a bare `spawn('node', …)` keeps working without a real node.exe.
//
// Why this is needed: the only `node` on PATH is the shim written by
// ensureNodeShimDir() in main.js, and on Windows that shim is a .cmd/.bat.
// Node >= 20.12.2 (CVE-2024-27980) refuses to spawn a .bat/.cmd unless
// `shell: true`, so wordpress-develop's Gruntfile — which does
// `grunt.util.spawn({ cmd: 'node', … })` with shell:false — dies with EINVAL.
// Grunt runs two levels below us (script-runner -> cmd.exe -> grunt.cmd -> node),
// so an inherited NODE_OPTIONS preload is the only way to reach it.
//
// The same preload also settles which `tar` the build gets (#373). wordpress-develop's
// tools/gutenberg/download.js extracts the Gutenberg artifact with a bare
// `spawn('tar', ['-xzf', 'C:\…', …])`, and Git for Windows puts GNU tar ahead of
// Windows's own bsdtar on PATH. GNU tar reads `C:` as a remote host and the build
// dies at gutenberg:verify. A `tar.cmd` in the shim dir would have to run through
// cmd.exe like any other script below, so the bare name is redirected here
// instead, straight to %SystemRoot%\System32\tar.exe, no shell and no quoting.
// It is the one tool the build spawns bare that a host install shadows with an
// incompatible one.
//
// Deliberately self-contained (Node built-ins only): this file is copied into the
// temp shim dir and required from there, because --require into a path inside
// app.asar is not reliable under ELECTRON_RUN_AS_NODE.

const path = require('path');
const fs = require('fs');

const SCRIPT_EXTENSIONS = ['.cmd', '.bat'];
// Args are handed to cmd.exe verbatim when shell:true, so anything cmd would
// interpret has to be quoted by us — Node does no quoting in shell mode.
const NEEDS_QUOTING = /[\s"&|<>^()%!]/;

// Strips the extension Windows would have resolved, so `node`, `node.cmd` and
// `C:\shims\node.bat` all collapse to the same name.
function shimName(file) {
	const base = path.win32.basename(String(file || '')).toLowerCase();
	const ext = path.win32.extname(base);
	if (ext === '.cmd' || ext === '.bat' || ext === '.exe') {
		return base.slice(0, -ext.length);
	}
	return base;
}

function hasDirectory(file) {
	const name = String(file || '');
	return name.includes('/') || name.includes('\\');
}

// Mirrors libuv's PATH/PATHEXT search closely enough to tell whether a bare
// command name would land on a script the OS cannot exec directly. Given a path
// with a directory it just reports whether that file exists.
function defaultLookup(file, env) {
	const name = String(file || '');
	if (!name) return null;
	const hasDir = hasDirectory(name);
	const candidateDirs = hasDir
		? [null]
		: String(env.Path || env.PATH || '').split(';').filter(Boolean);
	const pathExt = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
	const extensions = path.win32.extname(name) ? [''] : pathExt;
	for (const dir of candidateDirs) {
		for (const ext of extensions) {
			const candidate = (dir === null ? name : path.win32.join(dir, name)) + ext.toLowerCase();
			try {
				if (fs.existsSync(candidate)) return candidate;
			} catch {}
		}
	}
	return null;
}

function quoteForCmd(value) {
	const text = String(value);
	return NEEDS_QUOTING.test(text) ? `"${text}"` : text;
}

// Clones the caller's env (or inherits process.env) and forces Electron into
// Node mode, since the command we redirect to is electron.exe.
function withNodeMode(options) {
	const baseEnv = options && options.env ? options.env : process.env;
	return { ...options, env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' } };
}

// Decides how a child_process call must be rewritten. Returns null when the call
// is fine as-is. Pure and fully parameterised so it can be tested off-Windows.
function resolveSpawnTarget({
	file,
	args = [],
	options = {},
	platform = process.platform,
	execPath = process.execPath,
	npmCliPath = null,
	npxCliPath = null,
	env = process.env,
	lookup = defaultLookup
} = {}) {
	if (platform !== 'win32') return null;
	if (options.shell) return null;

	const name = shimName(file);

	// Preferred path: call Electron's binary directly. No shell, so no quoting
	// hazard, and it works even when the .cmd shim is missing entirely.
	if (name === 'node') {
		return { file: execPath, args: [...args], options: withNodeMode(options) };
	}
	if (name === 'npm' && npmCliPath) {
		return { file: execPath, args: [npmCliPath, ...args], options: withNodeMode(options) };
	}
	if (name === 'npx' && npxCliPath) {
		return { file: execPath, args: [npxCliPath, ...args], options: withNodeMode(options) };
	}

	// A bare `tar` goes to Windows's bsdtar, which understands drive letters. An
	// explicit path is somebody's deliberate choice and is kept; a Windows with no
	// System32\tar.exe (before 10 1803) falls through to the same handling as any
	// other command.
	if (name === 'tar' && !hasDirectory(file) && env.SystemRoot) {
		const systemTar = lookup(path.win32.join(env.SystemRoot, 'System32', 'tar.exe'), env);
		if (systemTar) {
			return { file: systemTar, args: [...args], options };
		}
	}

	// Fallback for every other .cmd/.bat shim (bin stubs of npm packages, etc.):
	// cmd.exe can run them, CreateProcess cannot.
	const resolved = path.win32.extname(String(file || ''))
		? String(file)
		: lookup(file, env);
	if (!resolved) return null;
	if (!SCRIPT_EXTENSIONS.includes(path.win32.extname(resolved).toLowerCase())) return null;

	return {
		// Always quoted: a resolved path cannot contain a quote character, and
		// site paths under "C:\Users\…\My Sites" routinely contain spaces.
		file: `"${resolved}"`,
		args: args.map(quoteForCmd),
		options: { ...options, shell: true }
	};
}

// child_process signatures are (file, args?, options?, callback?) with every
// tail argument optional, so the shape has to be re-derived before rewriting.
function rewriteArguments(callArgs, config) {
	const [file, ...rest] = callArgs;
	let args = [];
	let options = {};
	let tail = [];
	let index = 0;
	if (Array.isArray(rest[0])) {
		args = rest[0];
		index = 1;
	}
	if (rest[index] && typeof rest[index] === 'object') {
		options = rest[index];
		index += 1;
	}
	tail = rest.slice(index);

	const target = resolveSpawnTarget({ ...config, file, args, options });
	if (!target) return callArgs;
	return [target.file, target.args, target.options, ...tail];
}

const PATCH_MARKER = Symbol.for('wptk.winSpawnPatch');

function applyPatch(childProcess = require('child_process'), config = {}) {
	if (childProcess[PATCH_MARKER]) return childProcess;
	for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
		const original = childProcess[method];
		if (typeof original !== 'function') continue;
		childProcess[method] = function patched(...callArgs) {
			return original.apply(this, rewriteArguments(callArgs, config));
		};
	}
	childProcess[PATCH_MARKER] = true;
	return childProcess;
}

// Only self-applies when the app explicitly asked for it, so requiring this
// module from a test never mutates the test process.
if (process.env.WPTK_SPAWN_PATCH === '1') {
	applyPatch(require('child_process'), {
		npmCliPath: process.env.WPTK_NPM_CLI || null,
		npxCliPath: process.env.WPTK_NPX_CLI || null
	});
}

module.exports = { resolveSpawnTarget, applyPatch, defaultLookup, PATCH_MARKER };
