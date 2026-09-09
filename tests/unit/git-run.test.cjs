const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { spawnGit, runGit, GitError, subcommandOf, safeDirectoryArgs } = require('../../src/git-run.cjs');
const { BASE_ARGS } = require('../../src/git-binary.cjs');

// The runner's contract, checked without a Git: `spawn` is injected and hands
// back a scripted child, so argv, stdio, exit-code handling, overflow and the
// spawn-failure path are all exercised on any machine. The real binary is
// driven in git-run.integration.test.cjs.

function fakeChild({ stdout = [], stderr = [], status = 0, signal = null, error = null, delay = 0 } = {}) {
	const child = new EventEmitter();
	// No pid: killChildTree declines to signal, so an overflow test cannot
	// reach a real process that happens to hold a fake pid on a CI runner.
	child.pid = 0;
	child.exitCode = null;
	child.signalCode = null;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new PassThrough();
	child.stdinChunks = [];
	child.stdin.on('data', (chunk) => child.stdinChunks.push(chunk));
	child.killed = false;
	child.kill = () => { child.killed = true; return true; };
	setTimeout(() => {
		if (error) {
			child.emit('error', error);
			child.emit('close', null, null);
			return;
		}
		for (const chunk of stdout) child.stdout.write(chunk);
		for (const chunk of stderr) child.stderr.write(chunk);
		child.stdout.end();
		child.stderr.end();
		setTimeout(() => {
			child.exitCode = status;
			child.signalCode = signal;
			child.emit('close', status, signal);
		}, 0);
	}, delay);
	return child;
}

function recordingSpawn(childOptions) {
	const calls = [];
	const spawn = (file, args, options) => {
		const child = fakeChild(childOptions);
		calls.push({ file, args, options, child });
		return child;
	};
	return { spawn, calls };
}

test('spawnGit refuses to run without an explicit cwd', () => {
	assert.throws(() => spawnGit(['status'], {}), TypeError);
	assert.throws(() => spawnGit(['status'], { cwd: '' }), TypeError);
});

test('every call carries the base arguments, no optional locks and the cwd as a safe directory', () => {
	const { spawn, calls } = recordingSpawn();
	spawnGit(['status', '--porcelain=v2'], { cwd: '/sites/demo', spawn });

	const [{ file, args, options }] = calls;
	assert.ok(path.isAbsolute(file));
	assert.deepEqual(args.slice(0, BASE_ARGS.length), [...BASE_ARGS]);
	assert.equal(args[BASE_ARGS.length], '--no-optional-locks');
	assert.ok(args.includes('safe.directory=/sites/demo'));
	assert.deepEqual(args.slice(-2), ['status', '--porcelain=v2']);
	assert.equal(options.cwd, '/sites/demo');
	assert.equal(options.shell, false);
	assert.equal(options.windowsHide, true);
	assert.equal(options.detached, process.platform !== 'win32');
	// The environment is the bundled Git's, never the host's.
	assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
	assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('a Windows cwd is trusted under both spellings', () => {
	assert.deepEqual(safeDirectoryArgs('C:\\Sites\\demo'), [
		'-c', 'safe.directory=C:\\Sites\\demo',
		'-c', 'safe.directory=C:/Sites/demo'
	]);
	assert.deepEqual(safeDirectoryArgs('/sites/demo'), ['-c', 'safe.directory=/sites/demo']);
});

test('the subcommand named in errors skips options and -c pairs', () => {
	assert.equal(subcommandOf(['-c', 'core.autocrlf=true', '--no-pager', 'status', '-z']), 'status');
	assert.equal(subcommandOf(['--version']), '(no subcommand)');
});

test('stdin is only opened when there is input, and the input is written whole', async () => {
	const { spawn, calls } = recordingSpawn({ stdout: ['ok\n'] });
	await runGit(['cat-file', '--batch'], { cwd: '/sites/demo', input: 'abc:path\0', spawn });
	assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
	// The scripted child recorded what reached its stdin.
	const written = Buffer.concat(calls[0].child.stdinChunks).toString('utf8');
	assert.equal(written, 'abc:path\0');
});

test('stdout comes back as bytes and stderr as text', async () => {
	const { spawn } = recordingSpawn({ stdout: [Buffer.from([0x61, 0x00, 0x62]), Buffer.from('c')], stderr: ['warning: x\n'] });
	const result = await runGit(['status'], { cwd: '/sites/demo', spawn });
	assert.equal(result.status, 0);
	assert.ok(Buffer.isBuffer(result.stdout));
	assert.deepEqual([...result.stdout], [0x61, 0x00, 0x62, 0x63]);
	assert.equal(result.stderr, 'warning: x\n');
});

test('an exit status outside okCodes rejects with the stderr and the arguments', async () => {
	const { spawn } = recordingSpawn({ status: 128, stderr: ['fatal: not a git repository\n'] });
	await assert.rejects(
		runGit(['rev-parse', 'HEAD'], { cwd: '/sites/demo', spawn }),
		(error) => {
			assert.ok(error instanceof GitError);
			assert.equal(error.code, 128);
			assert.equal(error.stderr, 'fatal: not a git repository\n');
			assert.deepEqual(error.args, ['rev-parse', 'HEAD']);
			assert.equal(error.cwd, '/sites/demo');
			assert.match(error.message, /^git rev-parse failed \(128\): fatal: not a git repository$/);
			return true;
		}
	);
});

test('okCodes lets a query answer "no" without throwing', async () => {
	const { spawn } = recordingSpawn({ status: 1 });
	const result = await runGit(['rev-parse', '--verify', '--quiet', 'nope'], { cwd: '/sites/demo', okCodes: [0, 1], spawn });
	assert.equal(result.status, 1);
	assert.equal(result.stdout.length, 0);
});

test('a spawn failure is a GitError with the system code, not an unhandled event', async () => {
	const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
	const { spawn } = recordingSpawn({ error: enoent });
	await assert.rejects(
		runGit(['status'], { cwd: '/sites/demo', spawn }),
		(error) => error instanceof GitError && error.code === 'ENOENT' && /could not start/.test(error.message)
	);
});

// The fake child has no pid, so this proves the rejection and that reading
// stops, not that the kill was sent; killChildTree's own tests cover that.
test('output past maxStdout rejects rather than growing without bound', async () => {
	const { spawn, calls } = recordingSpawn({ stdout: [Buffer.alloc(600, 0x41), Buffer.alloc(600, 0x41)], status: 0 });
	await assert.rejects(
		runGit(['status'], { cwd: '/sites/demo', maxStdout: 1000, spawn }),
		(error) => error instanceof GitError && error.code === 'stdout-overflow'
	);
	assert.equal(calls.length, 1);
});
