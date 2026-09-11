const test = require('node:test');
const assert = require('node:assert/strict');

const {
	isEngineMismatch,
	createEngineMismatchDetector,
	shouldRetryWithRelaxedEngines,
	buildChildEnv,
	RELAXED_ENGINES_ENV
} = require('../../src/npm-runner.js');

// A run that failed on its own with an engines complaint — the one case that
// earns a retry. Individual tests override single fields from here.
const ENGINE_FAILURE = {
	code: 1,
	signal: null,
	sawEngineMismatch: true,
	alreadyRelaxed: false,
	cancelled: false
};

// Verbatim from the failure reported in issue #37.
const EBADENGINE_OUTPUT = `npm error code EBADENGINE
npm error engine Unsupported engine
npm error engine Not compatible with your version of node/npm: @eslint/compat@2.1.0
npm error notsup Not compatible with your version of node/npm: @eslint/compat@2.1.0
npm error notsup Required: {"node":"^20.19.0 || ^22.13.0 || >=24"}
npm error notsup Actual:   {"npm":"10.9.3","node":"v20.18.0"}`;

test('isEngineMismatch detects a real engines failure', () => {
	assert.equal(isEngineMismatch(EBADENGINE_OUTPUT), true);
	// npm may emit only the warning form on stderr before the error block.
	assert.equal(isEngineMismatch('npm warn EBADENGINE Unsupported engine'), true);
});

test('isEngineMismatch ignores failures with other causes', () => {
	// These must not trigger the retry — retrying would waste a full install
	// and hide the real problem behind a misleading "newer Node" message.
	assert.equal(isEngineMismatch('npm error code ENOTFOUND\nnpm error network request failed'), false);
	assert.equal(isEngineMismatch('npm error code ERESOLVE\nnpm error unable to resolve dependency tree'), false);
	assert.equal(isEngineMismatch('npm error code ENOSPC\nnpm error nospc no space left on device'), false);
	assert.equal(isEngineMismatch('npm error code E404\nnpm error 404 Not Found'), false);
	assert.equal(isEngineMismatch('Error: build failed with 3 errors'), false);
	assert.equal(isEngineMismatch(''), false);
	assert.equal(isEngineMismatch(undefined), false);
});

test('createEngineMismatchDetector survives a marker split across chunks', () => {
	// Child output arrives in arbitrary chunks, so the marker can straddle a
	// boundary. Missing it here would mean never retrying.
	const detector = createEngineMismatchDetector();
	assert.equal(detector.push('npm error code EBADEN'), false);
	assert.equal(detector.push('GINE\nnpm error engine Unsupported engine'), true);
	assert.equal(detector.found, true);
});

test('createEngineMismatchDetector survives a marker split across three chunks', () => {
	// Regression: the retained tail must come from the combined text, not just
	// the newest chunk, or a marker spread over three chunks is never seen.
	const detector = createEngineMismatchDetector();
	assert.equal(detector.push('EBA'), false);
	assert.equal(detector.push('DEN'), false);
	assert.equal(detector.push('GINE'), true);
	assert.equal(detector.found, true);
});

test('createEngineMismatchDetector latches and stays quiet on clean output', () => {
	const clean = createEngineMismatchDetector();
	clean.push('added 1294 packages in 47s\n');
	clean.push('found 0 vulnerabilities\n');
	assert.equal(clean.found, false);

	// Once seen, a later clean chunk must not clear the finding.
	const latched = createEngineMismatchDetector();
	latched.push(EBADENGINE_OUTPUT);
	latched.push('npm verbose exit 1\n');
	assert.equal(latched.found, true);
});

test('shouldRetryWithRelaxedEngines retries an engines failure once', () => {
	assert.equal(shouldRetryWithRelaxedEngines(ENGINE_FAILURE), true);
	// The retry itself must never spawn a third attempt.
	assert.equal(shouldRetryWithRelaxedEngines({ ...ENGINE_FAILURE, alreadyRelaxed: true }), false);
});

test('shouldRetryWithRelaxedEngines never restarts a cancelled run', () => {
	// Pressing "stop" makes the child exit non-zero with the engines warning
	// already in the log. Retrying there would restart work the user stopped.
	assert.equal(shouldRetryWithRelaxedEngines({ ...ENGINE_FAILURE, cancelled: true }), false);
	// On POSIX a kill also surfaces as a signal with a null exit code.
	assert.equal(
		shouldRetryWithRelaxedEngines({ ...ENGINE_FAILURE, code: null, signal: 'SIGTERM' }),
		false
	);
	assert.equal(
		shouldRetryWithRelaxedEngines({ ...ENGINE_FAILURE, code: null, signal: 'SIGKILL' }),
		false
	);
});

test('shouldRetryWithRelaxedEngines leaves other outcomes alone', () => {
	assert.equal(shouldRetryWithRelaxedEngines({ ...ENGINE_FAILURE, code: 0 }), false);
	assert.equal(shouldRetryWithRelaxedEngines({ ...ENGINE_FAILURE, sawEngineMismatch: false }), false);
});

test('buildChildEnv points child processes at Electron\'s Node', () => {
	const env = buildChildEnv({
		shimDir: '/shims',
		baseEnv: { PATH: '/usr/bin', HOME: '/home/test' },
		platform: 'darwin',
		execPath: '/Applications/App.app/Contents/MacOS/App'
	});

	assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
	assert.equal(env.NODE, '/Applications/App.app/Contents/MacOS/App');
	assert.equal(env.NODE_ENV, 'development');
	assert.equal(env.npm_config_production, 'false');
	// The shim must come first, or the system node (if any) wins.
	assert.equal(env.PATH, '/shims:/usr/bin');
	// Unrelated variables are preserved.
	assert.equal(env.HOME, '/home/test');
	// Engine checks are left alone unless explicitly relaxed.
	assert.equal(env.npm_config_engine_strict, undefined);
});

test('buildChildEnv sets both PATH casings and PATHEXT on Windows only', () => {
	const win = buildChildEnv({
		shimDir: 'C:\\shims',
		baseEnv: { PATH: 'C:\\Windows' },
		platform: 'win32',
		execPath: 'C:\\App\\App.exe'
	});
	assert.equal(win.PATH, 'C:\\shims;C:\\Windows');
	assert.equal(win.Path, 'C:\\shims;C:\\Windows');
	assert.match(win.PATHEXT, /\.CMD;/);
	assert.match(win.PATHEXT, /\.BAT;/);

	const posix = buildChildEnv({
		shimDir: '/shims',
		baseEnv: { PATH: '/usr/bin' },
		platform: 'linux',
		execPath: '/opt/app'
	});
	// A defined `Path` key on POSIX would shadow nothing but is misleading.
	assert.equal('Path' in posix, false);
	assert.equal(posix.PATHEXT, undefined);
});

test('buildChildEnv preloads the spawn patch on Windows, appending to NODE_OPTIONS', () => {
	const env = buildChildEnv({
		shimDir: 'C:\\shims',
		baseEnv: { PATH: 'C:\\Windows', NODE_OPTIONS: '--max-old-space-size=4096' },
		platform: 'win32',
		execPath: 'C:\\App\\App.exe',
		spawnPatchPath: 'C:\\shims\\win-spawn-patch.js',
		npmCliPath: 'C:\\App\\npm-cli.js',
		npxCliPath: 'C:\\App\\npx-cli.js'
	});

	// An inherited NODE_OPTIONS must survive: the build relies on its own flags.
	assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096 --require "C:/shims/win-spawn-patch.js"');
	assert.equal(env.WPTK_SPAWN_PATCH, '1');
	assert.equal(env.WPTK_NPM_CLI, 'C:\\App\\npm-cli.js');
	assert.equal(env.WPTK_NPX_CLI, 'C:\\App\\npx-cli.js');

	const noInherited = buildChildEnv({
		shimDir: 'C:\\shims',
		baseEnv: { PATH: 'C:\\Windows' },
		platform: 'win32',
		execPath: 'C:\\App\\App.exe',
		spawnPatchPath: 'C:\\shims\\win-spawn-patch.js'
	});
	assert.equal(noInherited.NODE_OPTIONS, '--require "C:/shims/win-spawn-patch.js"');
});

// Regression for the MODULE_NOT_FOUND this shipped with: Node tokenises
// NODE_OPTIONS with shell-like rules, so a backslash inside the quotes is eaten
// as an escape and the preload path arrives mangled (C:UsersJuanMa…). Asserting
// on the exact string above is not enough — that is precisely the assertion that
// passed while the app was broken — so pin the property that actually matters.
test('buildChildEnv never leaves a backslash in the NODE_OPTIONS preload path', () => {
	const env = buildChildEnv({
		shimDir: 'C:\\Users\\JuanMa\\AppData\\Local\\Temp\\electron-node-shims-9832',
		baseEnv: { PATH: 'C:\\Windows' },
		platform: 'win32',
		execPath: 'C:\\App\\App.exe',
		spawnPatchPath: 'C:\\Users\\JuanMa\\AppData\\Local\\Temp\\electron-node-shims-9832\\win-spawn-patch.js'
	});

	assert.equal(env.NODE_OPTIONS.includes('\\'), false);
	assert.match(env.NODE_OPTIONS, /--require "C:\/Users\/JuanMa\/.*\/win-spawn-patch\.js"$/);
});

test('buildChildEnv leaves NODE_OPTIONS alone off Windows or without a patch', () => {
	// The .cmd shim problem is Windows-only; POSIX shims are executable scripts.
	const posix = buildChildEnv({
		shimDir: '/shims',
		baseEnv: { PATH: '/usr/bin' },
		platform: 'darwin',
		execPath: '/opt/app',
		spawnPatchPath: '/shims/win-spawn-patch.js'
	});
	assert.equal(posix.NODE_OPTIONS, undefined);
	assert.equal(posix.WPTK_SPAWN_PATCH, undefined);

	// Copying the patch is best-effort; without it we must stay as we were.
	const noPatch = buildChildEnv({
		shimDir: 'C:\\shims',
		baseEnv: { PATH: 'C:\\Windows', NODE_OPTIONS: '--enable-source-maps' },
		platform: 'win32',
		execPath: 'C:\\App\\App.exe'
	});
	assert.equal(noPatch.NODE_OPTIONS, '--enable-source-maps');
	assert.equal(noPatch.WPTK_SPAWN_PATCH, undefined);
});

// The spawn patch re-attaches the compat preload to the spawns it redirects
// (see win-spawn-patch.js), and this is how it learns where the file is. A
// native path: it travels as an argument, never through NODE_OPTIONS, so the
// backslash problem above does not apply.
test('buildChildEnv hands the spawn patch the compat preload path on Windows only', () => {
	const win = buildChildEnv({
		shimDir: 'C:\\shims',
		baseEnv: { PATH: 'C:\\Windows' },
		platform: 'win32',
		execPath: 'C:\\App\\App.exe',
		spawnPatchPath: 'C:\\shims\\win-spawn-patch.js',
		nodeCompatPath: 'C:\\shims\\electron-node-compat.js'
	});
	assert.equal(win.WPTK_NODE_COMPAT_PATH, 'C:\\shims\\electron-node-compat.js');

	const noCompat = buildChildEnv({
		shimDir: 'C:\\shims',
		baseEnv: { PATH: 'C:\\Windows' },
		platform: 'win32',
		execPath: 'C:\\App\\App.exe',
		spawnPatchPath: 'C:\\shims\\win-spawn-patch.js'
	});
	assert.equal(noCompat.WPTK_NODE_COMPAT_PATH, undefined);

	const posix = buildChildEnv({
		shimDir: '/tmp/shims',
		baseEnv: { PATH: '/usr/bin' },
		platform: 'darwin',
		execPath: '/App/Electron',
		nodeCompatPath: '/tmp/shims/electron-node-compat.js'
	});
	assert.equal(posix.WPTK_NODE_COMPAT_PATH, undefined);
});

test('buildChildEnv applies extraEnv last so the retry can relax engines', () => {
	const env = buildChildEnv({
		shimDir: '/shims',
		baseEnv: { PATH: '/usr/bin' },
		platform: 'darwin',
		execPath: '/opt/app',
		extraEnv: RELAXED_ENGINES_ENV
	});
	assert.equal(env.npm_config_engine_strict, 'false');
	// Relaxing engines must not disturb the rest of the environment.
	assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
	assert.equal(env.PATH, '/shims:/usr/bin');
});
