'use strict';

// The contents of the `node`, `npm` and `npx` shims the app writes onto PATH for
// every child process it starts (see ensureNodeShimDir in main.js). Pure string
// building, no fs and no electron, so the one property these shims must hold can
// be unit-tested without spawning anything.
//
// That property is the preload. The shims point at Electron running under
// ELECTRON_RUN_AS_NODE, and Electron keeps `process.versions.electron` set in
// that mode — which makes every yargs-based tool misread its own arguments and,
// for a task runner, spawn itself without end (#275, and see
// electron-node-compat.js for the mechanism).
//
// The preload is passed as an explicit `--require` argument rather than through
// NODE_OPTIONS. NODE_OPTIONS is how win-spawn-patch.js reaches descendants, and
// it is the right tool there — it has to reach a process several levels down that
// we never invoke ourselves. Here we are the one invoking the process, and
// measurement showed NODE_OPTIONS did not survive every chain reliably: an
// argument does, always, because it is not inherited at all. It also confines the
// patch to processes that actually go through the shim, instead of leaking into
// every unrelated Node process a build happens to start.

// Set alongside the flag so the preload only acts when the app asked for it —
// requiring the module in a test must not mutate the test's own process.
const COMPAT_FLAG = 'WPTK_NODE_COMPAT';

// `--require` is separated from the arguments the caller passed, so a shim
// invoked as `node -e …` still ends up as `node --require … -e …`.
function requireArgs(compatPath) {
	return compatPath ? `--require "${compatPath}" ` : '';
}

// POSIX shims are bash scripts. The compat path is interpolated into a quoted
// argument, so spaces are safe; unlike NODE_OPTIONS, nothing re-tokenises it.
function posixShim({ execPath, compatPath, cliPath = null }) {
	const flag = compatPath ? `${COMPAT_FLAG}=1 ` : '';
	const cli = cliPath ? `"${cliPath}" ` : '';
	return `#!/usr/bin/env bash\n${flag}ELECTRON_RUN_AS_NODE=1 "${execPath}" ${requireArgs(compatPath)}${cli}"$@"\n`;
}

// Windows shims are .cmd/.bat. Backslashes inside a quoted command-line argument
// are literal — the escaping problem that forces forward slashes in NODE_OPTIONS
// does not exist here, so the path goes in as the OS spells it.
function windowsShim({ execPath, compatPath, cliPath = null }) {
	const flag = compatPath ? `set ${COMPAT_FLAG}=1\r\n` : '';
	const cli = cliPath ? `"${cliPath}" ` : '';
	return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${flag}"${execPath}" ${requireArgs(compatPath)}${cli}%*\r\n`;
}

function nodeShim({ execPath, compatPath, platform = process.platform }) {
	const build = platform === 'win32' ? windowsShim : posixShim;
	return build({ execPath, compatPath });
}

function cliShim({ execPath, compatPath, cliPath, platform = process.platform }) {
	const build = platform === 'win32' ? windowsShim : posixShim;
	return build({ execPath, compatPath, cliPath });
}

module.exports = { nodeShim, cliShim, COMPAT_FLAG };
