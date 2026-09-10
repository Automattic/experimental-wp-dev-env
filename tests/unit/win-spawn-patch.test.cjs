const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveSpawnTarget, applyPatch, defaultLookup, PATCH_MARKER } = require('../../src/win-spawn-patch.js');

// The Windows shim layout ensureNodeShimDir() writes, as the patch sees it.
const WIN = {
	platform: 'win32',
	execPath: 'C:\\App\\App.exe',
	npmCliPath: 'C:\\App\\resources\\app.asar\\node_modules\\npm\\bin\\npm-cli.js',
	npxCliPath: 'C:\\App\\resources\\app.asar\\node_modules\\npm\\bin\\npx-cli.js',
	env: { Path: 'C:\\shims;C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' },
	lookup: (file) => {
		const known = {
			node: 'C:\\shims\\node.cmd',
			grunt: 'C:\\site\\node_modules\\.bin\\grunt.cmd',
			mysqld: 'C:\\tools\\mysqld.exe',
			// Windows's own bsdtar, present since Windows 10 1803.
			'c:\\windows\\system32\\tar.exe': 'C:\\Windows\\System32\\tar.exe'
		};
		return known[String(file).toLowerCase()] || null;
	}
};

const SYSTEM_TAR = 'C:\\Windows\\System32\\tar.exe';

// The exact call wordpress-develop's Gruntfile makes in gutenberg:verify.
test('a bare `node` spawn is redirected to Electron in Node mode, without a shell', () => {
	const target = resolveSpawnTarget({
		...WIN,
		file: 'node',
		args: ['tools/gutenberg/utils.js'],
		options: { stdio: 'inherit' }
	});

	assert.equal(target.file, 'C:\\App\\App.exe');
	assert.deepEqual(target.args, ['tools/gutenberg/utils.js']);
	assert.equal(target.options.stdio, 'inherit');
	assert.equal(target.options.env.ELECTRON_RUN_AS_NODE, '1');
	// No shell means no quoting hazard — that is the point of this branch.
	assert.ok(!target.options.shell);
});

test('node.cmd and NODE.EXE resolve to the same redirect as bare node', () => {
	for (const file of ['node.cmd', 'C:\\shims\\node.bat', 'NODE.EXE']) {
		const target = resolveSpawnTarget({ ...WIN, file, args: ['x.js'] });
		assert.equal(target.file, 'C:\\App\\App.exe', file);
		assert.deepEqual(target.args, ['x.js'], file);
	}
});

test('npm and npx are redirected to their JS CLIs', () => {
	const npm = resolveSpawnTarget({ ...WIN, file: 'npm', args: ['ci'] });
	assert.deepEqual(npm.args, [WIN.npmCliPath, 'ci']);
	assert.equal(npm.file, WIN.execPath);

	const npx = resolveSpawnTarget({ ...WIN, file: 'npx.cmd', args: ['wp-scripts', 'build'] });
	assert.deepEqual(npx.args, [WIN.npxCliPath, 'wp-scripts', 'build']);
});

test('npm falls through to the shell branch when no npm CLI path is known', () => {
	const target = resolveSpawnTarget({
		...WIN,
		npmCliPath: null,
		file: 'npm',
		args: ['ci'],
		lookup: () => 'C:\\shims\\npm.cmd'
	});
	assert.equal(target.options.shell, true);
	assert.equal(target.file, '"C:\\shims\\npm.cmd"');
});

test('the caller\'s env is cloned, never mutated', () => {
	const callerEnv = { PATH: 'C:\\Windows' };
	const target = resolveSpawnTarget({ ...WIN, file: 'node', args: [], options: { env: callerEnv } });

	assert.equal(target.options.env.PATH, 'C:\\Windows');
	assert.equal(target.options.env.ELECTRON_RUN_AS_NODE, '1');
	assert.equal(callerEnv.ELECTRON_RUN_AS_NODE, undefined);
});

test('any other .cmd shim gets shell:true with cmd-safe quoting', () => {
	const target = resolveSpawnTarget({
		...WIN,
		file: 'grunt',
		args: ['build', '--base=C:\\My Sites\\wp', 'plain']
	});

	assert.equal(target.options.shell, true);
	assert.equal(target.file, '"C:\\site\\node_modules\\.bin\\grunt.cmd"');
	// Only the argument cmd.exe would mis-split is quoted.
	assert.deepEqual(target.args, ['build', '"--base=C:\\My Sites\\wp"', 'plain']);
});

test('commands that Windows can exec directly are left alone', () => {
	assert.equal(resolveSpawnTarget({ ...WIN, file: 'mysqld', args: [] }), null);
	assert.equal(resolveSpawnTarget({ ...WIN, file: 'C:\\tools\\thing.exe', args: [] }), null);
	// Unresolvable name: leave it be so the caller sees the real ENOENT.
	assert.equal(resolveSpawnTarget({ ...WIN, file: 'nonesuch', args: [] }), null);
});

// The exact call wordpress-develop's tools/gutenberg/download.js makes (#373).
// With Git for Windows on PATH a bare `tar` is GNU tar, which reads `C:` as a
// remote host; Windows's own bsdtar in System32 handles the drive letter.
test('a bare `tar` spawn is redirected to System32 bsdtar, args and options intact', () => {
	const options = { stdio: ['ignore', 'inherit', 'inherit'] };
	const target = resolveSpawnTarget({
		...WIN,
		file: 'tar',
		args: ['-xzf', 'C:\\site\\.gutenberg\\artifact.tgz', '-C', 'C:\\site\\.gutenberg\\src'],
		options
	});

	assert.equal(target.file, SYSTEM_TAR);
	assert.deepEqual(target.args, ['-xzf', 'C:\\site\\.gutenberg\\artifact.tgz', '-C', 'C:\\site\\.gutenberg\\src']);
	assert.deepEqual(target.options, options);
	// Not Electron: no shell, and no Node-mode env rewrite either.
	assert.ok(!target.options.shell);
	assert.equal(target.options.env, undefined);

	for (const file of ['tar.exe', 'TAR']) {
		assert.equal(resolveSpawnTarget({ ...WIN, file, args: [] }).file, SYSTEM_TAR, file);
	}
});

test('without System32\\tar.exe a bare `tar` gets the same handling as any other command', () => {
	// A tar.exe found on PATH is left alone, so whatever tar the host has still
	// runs: today's failure, but not a new one.
	const gnu = resolveSpawnTarget({
		...WIN,
		lookup: (file) => (String(file).toLowerCase() === 'tar' ? 'C:\\Program Files\\Git\\usr\\bin\\tar.exe' : null),
		file: 'tar',
		args: ['-xzf', 'a.tgz']
	});
	assert.equal(gnu, null);

	// A tar.cmd on PATH still reaches the shell fallback; the tar branch must not
	// swallow the call on its way there.
	const script = resolveSpawnTarget({
		...WIN,
		lookup: (file) => (String(file).toLowerCase() === 'tar' ? 'C:\\tools\\tar.cmd' : null),
		file: 'tar',
		args: ['-xzf', 'a.tgz']
	});
	assert.equal(script.options.shell, true);
	assert.equal(script.file, '"C:\\tools\\tar.cmd"');

	assert.equal(resolveSpawnTarget({ ...WIN, lookup: () => null, file: 'tar', args: [] }), null);
});

// The tar branch hands defaultLookup a full path, so its job there is plain
// existence, not a PATH search. Pinned on a real file: the other tar tests all
// inject lookup, and this is the one thing the production path relies on.
test('defaultLookup with a path that has a directory reports whether that file exists', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wptk-tar-lookup-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const present = path.join(dir, 'tar.exe');
	fs.writeFileSync(present, '');

	const env = { Path: 'C:\\somewhere-else', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
	assert.equal(defaultLookup(present, env), present);
	assert.equal(defaultLookup(path.join(dir, 'missing.exe'), env), null);
});

test('an explicit path to some other tar is not rewritten', () => {
	const gitTar = 'C:\\Program Files\\Git\\usr\\bin\\tar.exe';
	assert.equal(resolveSpawnTarget({ ...WIN, file: gitTar, args: ['-xzf', 'a.tgz'] }), null);
});

test('a call that already asked for a shell is left alone', () => {
	assert.equal(
		resolveSpawnTarget({ ...WIN, file: 'node', args: ['x.js'], options: { shell: true } }),
		null
	);
});

test('nothing is rewritten off Windows', () => {
	for (const platform of ['darwin', 'linux']) {
		assert.equal(resolveSpawnTarget({ ...WIN, platform, file: 'node', args: ['x.js'] }), null, platform);
	}
});

test('applyPatch rewrites spawn arguments in every optional-argument shape', () => {
	const calls = [];
	const fake = {
		spawn: (...args) => { calls.push(args); return 'spawned'; },
		spawnSync: (...args) => { calls.push(args); },
		execFile: (...args) => { calls.push(args); },
		execFileSync: (...args) => { calls.push(args); }
	};
	applyPatch(fake, { platform: 'win32', execPath: WIN.execPath, lookup: WIN.lookup, env: WIN.env });

	assert.equal(fake.spawn('node', ['a.js']), 'spawned');
	assert.deepEqual(calls[0][0], WIN.execPath);
	assert.deepEqual(calls[0][1], ['a.js']);

	// No args array, no options.
	fake.spawn('node');
	assert.deepEqual(calls[1][1], []);

	// Trailing callback (execFile) must survive the rewrite.
	const cb = () => {};
	fake.execFile('node', ['a.js'], { cwd: 'C:\\site' }, cb);
	assert.equal(calls[2][2].cwd, 'C:\\site');
	assert.equal(calls[2][3], cb);
});

test('applyPatch is idempotent so a duplicated --require cannot double-wrap', () => {
	let depth = 0;
	const fake = { spawn: () => { depth += 1; } };
	applyPatch(fake, { platform: 'darwin' });
	const afterFirst = fake.spawn;
	applyPatch(fake, { platform: 'darwin' });

	assert.equal(fake.spawn, afterFirst);
	assert.equal(fake[PATCH_MARKER], true);
	fake.spawn('node');
	assert.equal(depth, 1);
});
