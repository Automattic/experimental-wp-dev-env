const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { killTreePlan, killChildTree, killChildTreeAndWait } = require('../../src/kill-tree.js');

test('killTreePlan on win32 builds a taskkill for the whole tree', () => {
	const plan = killTreePlan('win32', 1234);
	assert.equal(plan.type, 'command');
	assert.equal(plan.command, 'taskkill');
	// /T is the tree flag and /F forces: without them taskkill ends only the
	// root, which is the exact bug this module exists to fix.
	assert.deepEqual(plan.args, ['/pid', '1234', '/T', '/F']);
});

test('killTreePlan on POSIX targets the process group, with the bare pid as fallback', () => {
	const plan = killTreePlan('darwin', 1234);
	assert.equal(plan.type, 'signal');
	assert.equal(plan.signal, 'SIGTERM');
	assert.equal(plan.target, -1234);
	assert.equal(plan.fallback, 1234);
});

test('killTreePlan refuses pids that cannot name a live process', () => {
	// pid 0 would signal the caller's own group and -1 every process the user
	// owns — a bug here is catastrophic, so these must return null, not a plan.
	for (const pid of [0, -1, null, undefined, NaN, 1.5, '1234']) {
		assert.equal(killTreePlan('darwin', pid), null, `pid ${String(pid)}`);
		assert.equal(killTreePlan('win32', pid), null, `pid ${String(pid)}`);
	}
});

test('killChildTree on win32 runs the taskkill command', () => {
	const calls = [];
	const attempted = killChildTree({ pid: 42, exitCode: null, signalCode: null }, {
		platform: 'win32',
		spawnSync: (command, args) => { calls.push({ command, args }); },
		kill: () => { throw new Error('kill must not be used on win32'); }
	});
	assert.equal(attempted, true);
	assert.deepEqual(calls, [{ command: 'taskkill', args: ['/pid', '42', '/T', '/F'] }]);
});

test('killChildTree on POSIX signals the group, then falls back to the child alone', () => {
	const signalled = [];
	const attempted = killChildTree({ pid: 42, exitCode: null, signalCode: null }, {
		platform: 'darwin',
		spawnSync: () => { throw new Error('spawnSync must not be used on POSIX'); },
		kill: (target, signal) => {
			signalled.push({ target, signal });
			// First (group) attempt fails, as it does for a non-detached child.
			if (target < 0) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
		}
	});
	assert.equal(attempted, true);
	assert.deepEqual(signalled, [
		{ target: -42, signal: 'SIGTERM' },
		{ target: 42, signal: 'SIGTERM' }
	]);
});

test('killChildTree skips children that already exited', () => {
	for (const child of [null, undefined, { pid: null }, { pid: 42, exitCode: 0, signalCode: null }, { pid: 42, exitCode: null, signalCode: 'SIGTERM' }]) {
		const attempted = killChildTree(child, {
			platform: 'darwin',
			spawnSync: () => { throw new Error('must not spawn'); },
			kill: () => { throw new Error('must not signal'); }
		});
		assert.equal(attempted, false);
	}
});

test('killChildTree never throws when every mechanism fails', () => {
	const attempted = killChildTree({ pid: 42, exitCode: null, signalCode: null }, {
		platform: 'darwin',
		spawnSync: () => { throw new Error('boom'); },
		kill: () => { throw new Error('boom'); }
	});
	assert.equal(attempted, true);
});

function waitingChild() {
	return Object.assign(new EventEmitter(), {
		pid: 42,
		exitCode: null,
		signalCode: null
	});
}

test('killChildTreeAndWait resolves only after the child closes', async () => {
	const child = waitingChild();
	let settled = false;
	const stopped = killChildTreeAndWait(child, {
		platform: 'darwin',
		kill: () => {},
		timeoutMs: 1000
	}).then((result) => {
		settled = true;
		return result;
	});

	await new Promise(setImmediate);
	assert.equal(settled, false, 'sending the signal is not the same as closing');
	child.emit('close', 0, 'SIGTERM');
	assert.equal(await stopped, true);
});

test('killChildTreeAndWait listens before it sends the kill', async () => {
	const child = waitingChild();
	const stopped = await killChildTreeAndWait(child, {
		platform: 'darwin',
		kill: () => child.emit('close', 0, 'SIGTERM'),
		timeoutMs: 1000
	});

	assert.equal(stopped, true, 'a synchronous close must not be missed');
});

test('killChildTreeAndWait reports a child that does not close', async () => {
	const child = waitingChild();
	const stopped = await killChildTreeAndWait(child, {
		platform: 'darwin',
		kill: () => {},
		timeoutMs: 0
	});

	assert.equal(stopped, false);
	assert.equal(child.listenerCount('close'), 0, 'a timed-out wait must remove its listener');
});

test('killChildTreeAndWait still waits for close after exit', async () => {
	const child = Object.assign(waitingChild(), { exitCode: 0 });
	let settled = false;
	const stopped = killChildTreeAndWait(child, {
		platform: 'darwin',
		kill: () => { throw new Error('an exited child must not be signalled'); },
		timeoutMs: 1000
	}).then((result) => {
		settled = true;
		return result;
	});

	await new Promise(setImmediate);
	assert.equal(settled, false, 'exit can happen before stdio closes');
	child.emit('close', 0, null);
	assert.equal(await stopped, true);
});
