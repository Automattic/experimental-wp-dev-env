const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { hideElectronRuntime, ELECTRON_VERSION_KEYS } = require('../../src/electron-node-compat.js');
const { COMPAT_FLAG } = require('../../src/node-shims.cjs');

const COMPAT_PATH = path.join(__dirname, '..', '..', 'src', 'electron-node-compat.js');

// The detection this patch exists to defeat, spelled out rather than described:
// `yargs/helpers.hideBin` slices process.argv from here, and reads "electron set,
// defaultApp unset" as a packaged Electron app whose argv carries no script path.
// Under ELECTRON_RUN_AS_NODE both halves hold while a script path *is* present,
// so every yargs-based tool starts reading one argument too early (#275).
function yargsArgvStart(proc) {
	const isElectronApp = Boolean(proc.versions && proc.versions.electron);
	const isBundledElectronApp = isElectronApp && !proc.defaultApp;
	return isBundledElectronApp ? 1 : 2;
}

function fakeElectronProcess() {
	return {
		versions: {
			node: '24.18.0',
			electron: '43.2.0',
			chrome: '150.0.7871.129',
			v8: '15.0.1240245-electron.0'
		}
	};
}

test('hideElectronRuntime makes an Electron runtime describe itself as Node', () => {
	const proc = fakeElectronProcess();

	assert.deepEqual(hideElectronRuntime(proc), ELECTRON_VERSION_KEYS);
	assert.equal(proc.versions.electron, undefined);
	// Node's own identity has to survive: this hides a runtime, it does not fake one.
	assert.equal(proc.versions.node, '24.18.0');
	// Left alone on purpose — tools parse it as a version number.
	assert.equal(proc.versions.v8, '15.0.1240245-electron.0');
});

// The bug itself, at the only layer where it can be pinned deterministically on
// both runtimes: not "a key is gone" but "argument parsing lands where it should".
test('hiding the runtime moves a yargs-style tool back onto its real arguments', () => {
	const proc = fakeElectronProcess();
	// What the shim actually produces: the Electron binary, the tool, its args.
	const argv = ['/path/to/Electron', '/site/node_modules/.bin/runner', 'npm run build:js'];

	assert.equal(yargsArgvStart(proc), 1);
	// One argument too few is sliced off, so the tool's own path arrives as the
	// first thing the user supposedly asked for. For a task runner that is a
	// command to run — itself, with no arguments — and the copy it starts does
	// the same, without end.
	assert.deepEqual(argv.slice(yargsArgvStart(proc)), [
		'/site/node_modules/.bin/runner',
		'npm run build:js'
	]);

	hideElectronRuntime(proc);

	assert.equal(yargsArgvStart(proc), 2);
	assert.deepEqual(argv.slice(yargsArgvStart(proc)), ['npm run build:js']);
});

// Widening this set is the tempting change — the runtime still describes itself
// as Chrome-flavoured — and it is the one that must not be made silently.
// Hiding `versions.chrome` as well fails Gutenberg's bundling step outright,
// because build tooling reads it to decide what to compile for. That question is
// about the output, not about who is running the compiler.
test('the Chrome version is deliberately left in place', () => {
	const proc = fakeElectronProcess();

	hideElectronRuntime(proc);

	assert.equal(proc.versions.chrome, '150.0.7871.129');
	assert.deepEqual(ELECTRON_VERSION_KEYS, ['electron']);
});

test('hideElectronRuntime reports honestly when there is nothing to hide', () => {
	const plainNode = { versions: { node: '24.18.0', v8: '13.6.233.10' } };

	assert.deepEqual(hideElectronRuntime(plainNode), []);
	assert.equal(plainNode.versions.node, '24.18.0');

	assert.deepEqual(hideElectronRuntime({}), []);
	assert.deepEqual(hideElectronRuntime(null), []);
});

// A frozen `versions` makes `delete` a silent no-op in sloppy mode. Claiming
// success there would be worse than failing: the caller would stop looking.
test('hideElectronRuntime does not claim a removal it could not make', () => {
	const frozen = { versions: Object.freeze({ node: '24.18.0', electron: '43.2.0' }) };

	assert.deepEqual(hideElectronRuntime(frozen), []);
	assert.equal(frozen.versions.electron, '43.2.0');
});

// Everything above works on a fake process. These two spawn a real child, so
// they also cover the wiring — and under `npm run test:electron` the child is
// Electron, which is the only place the bug can actually occur.
const REPORT_RUNTIME = 'process.stdout.write(JSON.stringify({'
	+ 'electron: process.versions.electron || null,'
	+ 'chrome: process.versions.chrome || null,'
	+ 'node: process.versions.node || null'
	+ '}))';

// Mirrors what the shim does: --require as an argument, plus the flag that lets
// the preload act. See node-shims.cjs.
function runtimeOfChild({ preload = true, flag = true } = {}) {
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
	delete env[COMPAT_FLAG];
	if (flag) env[COMPAT_FLAG] = '1';

	const args = preload ? ['--require', COMPAT_PATH, '-e', REPORT_RUNTIME] : ['-e', REPORT_RUNTIME];
	const result = spawnSync(process.execPath, args, {
		env,
		encoding: 'utf8',
		shell: false,
		windowsHide: true
	});
	assert.equal(result.status, 0, `child failed: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

test('a child started the way the shim starts one sees plain Node', () => {
	const runtime = runtimeOfChild();

	assert.equal(runtime.electron, null);
	assert.ok(runtime.node, 'the child still reports a Node version');
});

// Under `npm run test:electron` this is the assertion that would have caught the
// bug: without the preload the child really is an Electron pretending to be Node.
// On the system Node it is vacuous, and CI runs the suite on both.
test('without the preload the child still looks like Electron', (t) => {
	// Reported as skipped rather than passed: on the system Node this asserts
	// nothing, and a silent pass is how a one-runtime test goes unnoticed.
	if (!process.versions.electron) return t.skip('needs the Electron runtime');

	const runtime = runtimeOfChild({ preload: false });

	assert.equal(runtime.electron, process.versions.electron);
});

// The preload is loaded by anything that requires the module — including this
// suite. It must stay inert unless the app asked for it, or the Electron test
// pass would strip its own runtime out from under the other tests.
test('the preload stays inert without the flag the shim sets', (t) => {
	if (!process.versions.electron) return t.skip('needs the Electron runtime');

	const runtime = runtimeOfChild({ flag: false });

	assert.equal(runtime.electron, process.versions.electron);
});
