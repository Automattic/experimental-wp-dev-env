const test = require('node:test');
const assert = require('node:assert/strict');

const { isRegisteredSite, deleteRegisteredSite, revealRegisteredSite, clearRegisteredSiteLog } = require('../../src/site-registry.js');

// A couple of paths the app might actually hold in its registry, one per platform
// shape, so the tests aren't accidentally tied to POSIX separators.
const REGISTERED = ['/Users/dev/sites/my-site', 'C:\\Users\\dev\\sites\\other'];

// Stands in for the store mutation and fse.remove, so "did this touch the store?"
// and "did this reach the disk?" are assertions rather than something the test has
// to take on trust.
function recorder(sites = REGISTERED) {
	const removed = [];
	const refused = [];
	let forgotten = 0;
	return {
		removed,
		refused,
		forgotten: () => forgotten,
		options: {
			sites,
			forget: () => { forgotten += 1; },
			remove: async (p) => { removed.push(p); },
			onRefused: (description) => { refused.push(description); }
		}
	};
}

test('a registered site is forgotten and removed', async () => {
	const rec = recorder();

	assert.equal(await deleteRegisteredSite('/Users/dev/sites/my-site', rec.options), true);

	assert.equal(rec.forgotten(), 1);
	assert.deepEqual(rec.removed, ['/Users/dev/sites/my-site']);
	assert.deepEqual(rec.refused, []);
});

test('a path the registry does not hold is neither forgotten nor removed', async () => {
	const rec = recorder();

	// A real directory, just not one this app created or adopted.
	assert.equal(await deleteRegisteredSite('/Users/dev/somewhere-else', rec.options), false);

	assert.equal(rec.forgotten(), 0);
	assert.deepEqual(rec.removed, []);
	assert.equal(rec.refused.length, 1);
});

test('the match is exact — a parent or child of a registered site is not registered', () => {
	// The registry stores paths verbatim, so removing a site must not become a
	// lever on the directory above it or a sibling beside it.
	assert.equal(isRegisteredSite('/Users/dev/sites/my-site', REGISTERED), true);
	assert.equal(isRegisteredSite('/Users/dev/sites', REGISTERED), false);
	assert.equal(isRegisteredSite('/Users/dev/sites/my-site/wp-content', REGISTERED), false);
	assert.equal(isRegisteredSite('/Users/dev/sites/my-site/', REGISTERED), false);
});

test('junk input is refused rather than thrown', async () => {
	for (const sitePath of ['', '   ', null, undefined, 42, {}, ['/Users/dev/sites/my-site']]) {
		const rec = recorder();
		assert.equal(await deleteRegisteredSite(sitePath, rec.options), false);
		assert.equal(rec.forgotten(), 0);
		assert.deepEqual(rec.removed, []);
	}

	// And with no registry at all, nothing is ever registered.
	assert.equal(isRegisteredSite('/Users/dev/sites/my-site', undefined), false);
});

// The path is about to be written into the file contributors attach to bug
// reports, and electron-log passes newlines through unchanged. Left as-is, a
// refused path could close the log line and open another one in the app's own
// timestamp-and-scope format — a log that describes events that never happened.
test('a refused path cannot forge a second log line', async () => {
	const rec = recorder();
	const forged = '/tmp/x\n[2026-08-06 10:00:00.000] [info]  (app) site deleted successfully';

	await deleteRegisteredSite(forged, rec.options);

	assert.equal(rec.refused.length, 1);
	assert.ok(!rec.refused[0].includes('\n'), 'the description must stay on one line');
	// Escaped, not dropped: the line still says what the caller actually sent.
	assert.ok(rec.refused[0].includes('/tmp/x\\x0a[2026-08-06'));
});

// --- revealRegisteredSite ------------------------------------------------
//
// `shell.openPath` is a smaller action than `fse.remove`, but it is the same
// kind of action — a local path handed to the OS — so it gets the same boundary.

function revealRecorder(sites = REGISTERED, error = '') {
	const revealed = [];
	const refused = [];
	return {
		revealed,
		refused,
		options: {
			sites,
			reveal: async (p) => { revealed.push(p); return error; },
			onRefused: (description) => { refused.push(description); }
		}
	};
}

test('a registered site is revealed', async () => {
	const rec = revealRecorder();

	assert.deepEqual(await revealRegisteredSite('/Users/dev/sites/my-site', rec.options), { ok: true });

	assert.deepEqual(rec.revealed, ['/Users/dev/sites/my-site']);
	assert.deepEqual(rec.refused, []);
});

test('a path the registry does not hold is not revealed', async () => {
	const rec = revealRecorder();

	const result = await revealRegisteredSite('/Users/dev/somewhere-else', rec.options);

	assert.equal(result.ok, false);
	assert.equal(result.reason, 'unregistered-site');
	assert.deepEqual(rec.revealed, []);
	assert.deepEqual(rec.refused, ['/Users/dev/somewhere-else']);
});

test('a reveal the OS declines is reported rather than swallowed', async () => {
	const rec = revealRecorder(REGISTERED, 'Failed to open path');

	const result = await revealRegisteredSite('/Users/dev/sites/my-site', rec.options);

	assert.equal(result.ok, false);
	assert.equal(result.reason, 'open-failed');
	assert.equal(result.error, 'Failed to open path');
});

// --- a site that is still being created ----------------------------------
//
// Creating a site clones wordpress-develop, which takes minutes, and the
// registry does not learn about the site until that finishes. The directory
// exists the whole time and the window shows it, so refusing to open it was the
// app declining to open a folder it had just created (#180).
//
// `pending` is the other half of the boundary: paths the main process is
// setting up right now, computed by main itself and never sent by the renderer.
// It widens what may be *opened*, and it narrows what may be *deleted* — a
// recursive remove of a tree the clone is still writing into is the one thing
// worse than the bug.

const PENDING = '/Users/dev/sites/being-cloned';

test('a site still being created is revealed', async () => {
	const rec = revealRecorder([]);

	const result = await revealRegisteredSite(PENDING, { ...rec.options, pending: [PENDING] });

	assert.deepEqual(result, { ok: true });
	assert.deepEqual(rec.revealed, [PENDING]);
	assert.deepEqual(rec.refused, []);
});

test('a site still being created is not deleted, registered or not', async () => {
	for (const sites of [[], [PENDING]]) {
		const rec = recorder(sites);

		assert.equal(await deleteRegisteredSite(PENDING, { ...rec.options, pending: [PENDING] }), false);

		assert.equal(rec.forgotten(), 0, 'the store must not be touched mid-clone');
		assert.deepEqual(rec.removed, [], 'the clone must not be removed from under itself');
		assert.equal(rec.refused.length, 1);
	}
});

// The asymmetry is the design, so it is asserted rather than assumed: being in
// flight is a reason to open and a reason not to delete.
test('pending never widens what may be deleted', async () => {
	const rec = recorder([]);

	assert.equal(await deleteRegisteredSite('/Users/dev/elsewhere', { ...rec.options, pending: [PENDING] }), false);

	assert.deepEqual(rec.removed, []);
});

test('a pending path is matched exactly, like a registered one', async () => {
	for (const near of ['/Users/dev/sites', `${PENDING}/wp-content`, `${PENDING}/`]) {
		const rec = revealRecorder([]);

		const result = await revealRegisteredSite(near, { ...rec.options, pending: [PENDING] });

		assert.equal(result.ok, false, near);
		assert.deepEqual(rec.revealed, []);
	}
});

test('no pending list at all behaves exactly as before', async () => {
	const rec = revealRecorder();

	assert.deepEqual(await revealRegisteredSite('/Users/dev/sites/my-site', rec.options), { ok: true });
	assert.equal((await revealRegisteredSite(PENDING, rec.options)).reason, 'unregistered-site');
});

// --- clearRegisteredSiteLog ---
//
// The Clear button under the debug.log panel empties build/wp-content/debug.log
// inside the named site. Less severe than the two above, same shape: the
// renderer names the path and the app writes at a location derived from it.

function clearRecorder(sites = REGISTERED, result = { ok: true }) {
	const truncated = [];
	const refused = [];
	return {
		truncated,
		refused,
		options: {
			sites,
			truncate: async (p) => { truncated.push(p); return result; },
			onRefused: (description) => { refused.push(description); }
		}
	};
}

test('a registered site has its log truncated', async () => {
	const rec = clearRecorder();

	assert.deepEqual(await clearRegisteredSiteLog('/Users/dev/sites/my-site', rec.options), { ok: true });

	assert.deepEqual(rec.truncated, ['/Users/dev/sites/my-site']);
	assert.deepEqual(rec.refused, []);
});

test('a path the registry does not hold has nothing truncated', async () => {
	const rec = clearRecorder();

	const result = await clearRegisteredSiteLog('/Users/dev/somewhere-else', rec.options);

	assert.equal(result.ok, false);
	assert.equal(result.reason, 'unregistered-site');
	assert.deepEqual(rec.truncated, [], 'a file was emptied in a directory the app never registered');
	assert.deepEqual(rec.refused, ['/Users/dev/somewhere-else']);
});

// A read-only or locked file is the case the panel has to report: it has already
// cleared itself by the time this answers, so a swallowed failure leaves the
// pane empty and the file full, and the lines reappear on the next start with
// no explanation.
test('a truncation the filesystem declines is passed back, not swallowed', async () => {
	const rec = clearRecorder(REGISTERED, { ok: false, reason: 'truncate-failed', error: 'EACCES' });

	const result = await clearRegisteredSiteLog('/Users/dev/sites/my-site', rec.options);

	assert.equal(result.ok, false);
	assert.equal(result.error, 'EACCES');
});
