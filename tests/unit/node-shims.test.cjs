const test = require('node:test');
const assert = require('node:assert/strict');

const { nodeShim, cliShim, COMPAT_FLAG } = require('../../src/node-shims.cjs');

const EXEC = {
	darwin: '/Applications/App.app/Contents/MacOS/App',
	win32: 'C:\\Program Files\\App\\App.exe'
};
const COMPAT = {
	darwin: '/tmp/electron-node-shims-42/electron-node-compat.js',
	win32: 'C:\\Users\\JuanMa\\AppData\\Local\\Temp\\electron-node-shims-42\\electron-node-compat.js'
};

// Every shim, on every platform, has to carry the preload. Missing it on one of
// them is exactly the shape of this bug: a build that runs away only through
// whichever entry point was forgotten.
test('every shim preloads the compat patch, on every platform', () => {
	for (const platform of ['darwin', 'win32']) {
		const shims = {
			node: nodeShim({ execPath: EXEC[platform], compatPath: COMPAT[platform], platform }),
			npm: cliShim({
				execPath: EXEC[platform],
				compatPath: COMPAT[platform],
				cliPath: 'npm-cli.js',
				platform
			})
		};

		for (const [name, script] of Object.entries(shims)) {
			assert.ok(
				script.includes(`--require "${COMPAT[platform]}"`),
				`${platform} ${name} shim does not preload the patch`
			);
			assert.ok(script.includes(COMPAT_FLAG), `${platform} ${name} shim does not set the flag`);
			assert.ok(script.includes('ELECTRON_RUN_AS_NODE=1'), `${platform} ${name} shim`);
		}
	}
});

// The caller's own arguments must arrive untouched and *after* ours — a shim
// invoked as `node -e …` has to end up as `node --require … -e …`, not the other
// way round, or the script never runs.
test('the preload precedes the arguments the caller passed', () => {
	const posix = nodeShim({ execPath: EXEC.darwin, compatPath: COMPAT.darwin, platform: 'darwin' });
	assert.ok(posix.endsWith('"$@"\n'));
	assert.ok(posix.indexOf('--require') < posix.indexOf('"$@"'));

	const win = nodeShim({ execPath: EXEC.win32, compatPath: COMPAT.win32, platform: 'win32' });
	assert.ok(win.trimEnd().endsWith('%*'));
	assert.ok(win.indexOf('--require') < win.indexOf('%*'));
});

// The npm/npx shims run a CLI script; it has to sit between the preload and the
// caller's arguments, or npm would read `--require` as one of its own.
test('a CLI shim keeps the preload, the CLI and the arguments in order', () => {
	const npm = cliShim({
		execPath: EXEC.darwin,
		compatPath: COMPAT.darwin,
		cliPath: '/app/node_modules/npm/bin/npm-cli.js',
		platform: 'darwin'
	});

	assert.ok(npm.indexOf('--require') < npm.indexOf('npm-cli.js'));
	assert.ok(npm.indexOf('npm-cli.js') < npm.indexOf('"$@"'));
});

// Paths are interpolated into quoted arguments, so a space must not split them.
// This is the failure mode that would only ever appear on someone else's machine.
test('a path with spaces stays one argument', () => {
	const spaced = '/Users/Juan Ma/Library/Application Support/electron-node-compat.js';
	const shim = nodeShim({ execPath: '/Apps/My App/App', compatPath: spaced, platform: 'darwin' });

	assert.ok(shim.includes(`--require "${spaced}"`));
	assert.ok(shim.includes('"/Apps/My App/App"'));
});

// Windows keeps its native separators here. Unlike NODE_OPTIONS — which Node
// re-tokenises, eating backslashes as escapes — a quoted command-line argument
// is taken literally, so there is nothing to work around.
test('the Windows shim keeps backslashes in the preload path', () => {
	const shim = nodeShim({ execPath: EXEC.win32, compatPath: COMPAT.win32, platform: 'win32' });

	assert.ok(shim.includes(`--require "${COMPAT.win32}"`));
	assert.ok(shim.includes('\\'));
	assert.ok(shim.startsWith('@echo off\r\n'));
});

// Copying the patch out of the bundle is best-effort. Without it the shim must
// still be a working shim — a build that cannot be patched has to keep running.
test('a shim without a patch to preload is still a valid shim', () => {
	const posix = nodeShim({ execPath: EXEC.darwin, compatPath: null, platform: 'darwin' });
	assert.equal(posix, `#!/usr/bin/env bash\nELECTRON_RUN_AS_NODE=1 "${EXEC.darwin}" "$@"\n`);
	assert.ok(!posix.includes(COMPAT_FLAG));

	const win = nodeShim({ execPath: EXEC.win32, compatPath: null, platform: 'win32' });
	assert.ok(!win.includes('--require'));
	assert.ok(!win.includes(COMPAT_FLAG));
	assert.ok(win.includes('%*'));
});
