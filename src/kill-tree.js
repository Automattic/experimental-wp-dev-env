// Kills a spawned child together with its descendants.
//
// The processes worth stopping are rarely the direct child: the runners spawn
// npm, which spawns a shell, which spawns grunt, which spawns node. A plain
// child.kill() signals only the first link, so quitting the app left watchers
// and servers running (#83).
//
// Two platform mechanisms, chosen by killTreePlan so the decision is testable
// without spawning anything:
//
// - win32: `taskkill /pid <pid> /T /F` — the only stock way to end a process
//   tree on Windows, where signals do not exist and job objects are not
//   available to an already-spawned tree.
// - POSIX: signal the process group (negative pid). This requires the child to
//   have been spawned with `detached: true`, which makes it a group leader its
//   descendants stay inside; falls back to signalling the child alone when the
//   group signal fails (e.g. the child was not detached).

'use strict';

/**
 * Pure decision: how to kill the tree rooted at `pid` on `platform`.
 * Returns null for a pid that cannot identify a live process.
 *
 * @param {string} platform
 * @param {number} pid
 * @return {?Object}
 */
function killTreePlan(platform, pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (platform === 'win32') {
		return { type: 'command', command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
	}
	return { type: 'signal', signal: 'SIGTERM', target: -pid, fallback: pid };
}

/**
 * Applies killTreePlan to a ChildProcess. Never throws: this runs during
 * quit, where a failure to kill one child must not stop the sweep of the rest.
 * Returns true when a kill was attempted.
 *
 * @param {?Object}  child
 * @param {Object}   [deps]           Injection points, so the tests can assert
 *                                    the plan without spawning anything.
 * @param {string}   [deps.platform]
 * @param {Function} [deps.spawnSync]
 * @param {Function} [deps.kill]
 * @return {boolean}
 */
function killChildTree(child, {
	platform = process.platform,
	spawnSync = require('child_process').spawnSync,
	kill = process.kill
} = {}) {
	if (!child || !child.pid) return false;
	// exitCode/signalCode are set once the child has exited; nothing to do then.
	if (child.exitCode !== null || child.signalCode) return false;
	const plan = killTreePlan(platform, child.pid);
	if (!plan) return false;
	if (plan.type === 'command') {
		try { spawnSync(plan.command, plan.args, { windowsHide: true }); } catch {}
		return true;
	}
	try {
		kill(plan.target, plan.signal);
	} catch {
		try { kill(plan.fallback, plan.signal); } catch {}
	}
	return true;
}

/**
 * Stops a process tree and waits until the ChildProcess has fully closed.
 * `close`, rather than the successful signal attempt, is the boundary callers
 * need before removing a working directory the process may still hold open.
 *
 * Returns false when the child cannot be signalled or does not close within the
 * timeout. The caller decides whether that means retry, refusal, or best effort.
 *
 * @param {?Object} child
 * @param {Object}  [deps]           killChildTree options plus the wait limit.
 * @param {number}  [deps.timeoutMs]
 * @return {Promise<boolean>}
 */
function killChildTreeAndWait(child, { timeoutMs = 5000, ...killDeps } = {}) {
	if (!child || typeof child.once !== 'function' || typeof child.removeListener !== 'function') {
		return Promise.resolve(false);
	}
	const exited = (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode;

	return new Promise((resolve) => {
		let timer = null;
		let settled = false;
		const finish = (stopped) => {
			if (settled) return;
			settled = true;
			child.removeListener('close', onClose);
			if (timer !== null) clearTimeout(timer);
			resolve(stopped);
		};
		const onClose = () => finish(true);

		// Listen first: taskkill is synchronous on Windows, and a very short-lived
		// child can close before killChildTree returns.
		child.once('close', onClose);
		if (!exited && !killChildTree(child, killDeps)) {
			finish(false);
			return;
		}
		if (settled) return;
		const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5000;
		timer = setTimeout(() => finish(false), waitMs);
	});
}

module.exports = { killTreePlan, killChildTree, killChildTreeAndWait };
