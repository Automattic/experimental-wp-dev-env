// Which sites this process is creating right now.
//
// Creating a site clones `wordpress-develop`, which takes minutes. The window
// shows the site immediately, and it should: the directory exists from the
// first moment, and a contributor watching a clone has every reason to open the
// folder and look. But `dir:show` and `editor:open` are gated on the `sites`
// registry, and the registry does not learn about the site until the clone
// finishes — so for the whole clone the app refused to open a folder it had
// created itself (#180).
//
// The fix is not to register it early. `sites` is persisted, and a half-cloned
// directory written into it survives the crash or the quit that the
// unregister-on-failure path cannot catch — a phantom site for a directory that
// was never finished, which is the thing AGENTS.md's architecture rules single
// out. It would also widen the allow-list for the recursive delete in
// `sites:delete` to include a tree the clone is still writing into.
//
// So this is the other half of the boundary, and the distinction it draws is
// **liveness against truth**. The store answers "which sites exist"; this
// answers "what is this process doing right now". They differ in lifetime, and
// that is the point: an entry here cannot outlive the process, so a restart
// mid-clone lands back on exactly today's behaviour instead of a new broken
// state that has to be reconciled.
//
// It sits beside six existing per-site maps in main.js that hold liveness the
// same way — `playgroundServers`, `runningInstalls`, `runningScripts`,
// `runIdByDirectory`, `wpDebugWatchers`, `smtpServers` — and its entries are
// the shortest-lived of them all: one handler call, released in a `finally`.
//
// Pure, so both halves are testable without an Electron process.
//
// On what the keys are, precisely, because the next widening of
// `isActionableSite` will be argued from it: a key is
// `path.join(destDir, uniqueName)`. The leaf is main's — `findAvailableDirName`
// picks a name that does not exist yet, from a string with path separators
// already stripped — but `destDir` is the renderer's, straight off the
// `wordpress:setup` invoke. So this is not "a path main computed from nothing";
// it is "a directory main is about to create and clone into, under a parent the
// contributor chose in a file dialog".
//
// That is enough for what it is used for. Being here says the app is writing
// into that directory right now, which is a fact about this process regardless
// of who named it, and the same call would register the same path in the store
// minutes later. It would not be enough to justify widening anything
// destructive, which is why `deleteRegisteredSite` refuses these outright
// rather than treating them as a second registry.

'use strict';

function createSetupTracker() {
	const inFlight = new Set();

	// True when this call is the one that claimed the path. False for a path
	// already being set up — two windows can resolve the same directory name
	// before either creates it, and two clones interleaving in one tree is worse
	// than the second one refusing.
	function begin(sitePath) {
		if (typeof sitePath !== 'string' || sitePath === '') return false;
		if (inFlight.has(sitePath)) return false;
		inFlight.add(sitePath);
		return true;
	}

	function end(sitePath) {
		return inFlight.delete(sitePath);
	}

	function has(sitePath) {
		return typeof sitePath === 'string' && sitePath !== '' && inFlight.has(sitePath);
	}

	// A copy. The array is handed to the guards as their `pending` list, and a
	// guard that could be widened by whoever it is guarding is not a guard.
	function paths() {
		return [...inFlight];
	}

	// Runs `work` with the path tracked, and releases it however that ends. The
	// release is the whole reason this is a function rather than two calls: a
	// clone that throws is exactly when a forgotten `end` would leave the site
	// permanently undeletable, and exactly when the caller is thinking about
	// something else.
	async function track(sitePath, work) {
		if (!begin(sitePath)) {
			throw new Error(`A setup is already running for ${sitePath}`);
		}
		try {
			return await work();
		} finally {
			end(sitePath);
		}
	}

	return { begin, end, has, paths, track };
}

module.exports = { createSetupTracker };
