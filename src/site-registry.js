// The gate in front of the recursive directory removal in `sites:delete`.
//
// `sites:delete` is handed a path and removes the tree at it — the least
// recoverable action reachable from the window. The renderer is the only caller
// and every call site passes a path the app itself registered, so nothing today
// misuses it. But the renderer also displays content the app does not author:
// child-process output from an install or a build, and the site being developed.
// This module is the step that keeps any future influence over that path from
// turning "delete this site" into "remove this directory".
//
// The `sites` array in the app's store is its own record of what it created or
// adopted, so it is the boundary: a request to remove anything not in it is not
// one the app should carry out. This is the same shape as external-url.js — a
// pure check, a safe log formatter, and a wrapper whose effects are injected so
// both branches can be tested without an Electron process.
//
// There is a second, shorter-lived record: the sites this process is creating
// right now (setup-tracker.js). A site's directory exists from the moment the
// app makes it, minutes before the clone finishes and the store hears about it,
// and the two verbs here want opposite answers about it — open it, yes; delete
// it, absolutely not. So `pending` widens `revealRegisteredSite` and is an
// outright refusal in `deleteRegisteredSite`. The asymmetry is the point.

const { describeRefused } = require('./safe-log');

// Every `reason` this module can answer `dir:show` with, same convention as
// REFUSAL_REASONS in editor-launch.js: the renderer's open-failure.cjs owes
// each of these a sentence, and its tests read this object rather than keeping
// a copy that could go stale.
const REVEAL_REASONS = {
	UNREGISTERED_SITE: 'unregistered-site',
	OPEN_FAILED: 'open-failed'
};

// True only for a path the app has on record. Exact string match, the same
// convention `sites:add`/`sites:delete` already use (`sites.includes(sitePath)`,
// `filter((p) => p !== sitePath)`): the registry stores the paths verbatim, so a
// parent, a child, or a differently-normalized form is deliberately not a match.
// Anything that is not a non-empty string is refused rather than throwing.
function isRegisteredSite(sitePath, sites) {
	if (typeof sitePath !== 'string' || sitePath === '') return false;
	if (!Array.isArray(sites)) return false;
	return sites.includes(sitePath);
}

// True for a path this app is responsible for right now: one it has on record,
// or one it is creating this very moment (see setup-tracker.js for why the
// second kind is deliberately not in the store).
//
// `pending` goes through the same exact-match predicate as `sites` rather than
// any looser comparison. It is a list of directories the app is writing into,
// so a prefix match would turn "this site is being cloned" into a lever on
// everything beneath it.
//
// This widens what may be *opened*. It must never be used to widen what may be
// removed — see `deleteRegisteredSite`, which refuses a pending path outright.
function isActionableSite(sitePath, { sites, pending } = {}) {
	return isRegisteredSite(sitePath, sites) || isRegisteredSite(sitePath, pending);
}

// The `sites:delete` handler's body, kept out of main.js so both sides of the
// guard can be tested without an Electron process. `remove` is the real tree
// removal in the app, and only after it succeeds does `forget` drop the path
// from the store. This order keeps a failed deletion visible and retryable. A
// path that is not registered performs neither: no store mutation and no
// removal, just a logged refusal.
async function deleteRegisteredSite(sitePath, { sites, pending, forget, remove, onRefused } = {}) {
	// Checked before the registry, and separately from it. A site whose clone is
	// still running is the one case where `remove` would delete a tree another
	// part of this process is actively writing into, so it is refused whether or
	// not it is registered. Until this existed the refusal came for free from the
	// path not being in `sites` yet; making the folder openable mid-clone is what
	// took that accident away.
	if (isRegisteredSite(sitePath, pending)) {
		if (typeof onRefused === 'function') onRefused(describeRefused(sitePath));
		return false;
	}

	if (!isRegisteredSite(sitePath, sites)) {
		if (typeof onRefused === 'function') onRefused(describeRefused(sitePath));
		return false;
	}

	await remove(sitePath);
	forget();
	return true;
}

// The `dir:show` handler's body. `shell.openPath` hands a local path to whatever
// the OS has registered for it, so "show this site in the file manager" is
// bounded the same way "delete this site" is — except that a site still being
// created counts here and does not there, since opening a folder mid-clone is
// what a contributor watching one wants and removing it is not. The reveal
// itself is injected, like `remove` above.
//
// `reveal` resolves to electron's own convention — the empty string on success,
// an error message otherwise — and that is passed through rather than reduced to
// a boolean, so the renderer can say what went wrong.
async function revealRegisteredSite(sitePath, { sites, pending, reveal, onRefused } = {}) {
	if (!isActionableSite(sitePath, { sites, pending })) {
		if (typeof onRefused === 'function') onRefused(describeRefused(sitePath));
		return { ok: false, reason: REVEAL_REASONS.UNREGISTERED_SITE };
	}

	const error = await reveal(sitePath);
	return error ? { ok: false, reason: REVEAL_REASONS.OPEN_FAILED, error } : { ok: true };
}

// The `wp-debug:clear` handler's body. Emptying a file is nowhere near as
// severe as a tree removal, but the shape is the same one this module exists for:
// the renderer names a path and the app then writes to a location derived from
// it. A path outside the registry would have the app truncating a file in a
// directory it never created.
//
// `truncate` is injected like `remove` and `reveal` above, and reports whether
// it succeeded rather than throwing, so the renderer can say that the pane was
// cleared and the file was not.
async function clearRegisteredSiteLog(sitePath, { sites, truncate, onRefused } = {}) {
	if (!isRegisteredSite(sitePath, sites)) {
		if (typeof onRefused === 'function') onRefused(describeRefused(sitePath));
		return { ok: false, reason: 'unregistered-site' };
	}

	return truncate(sitePath);
}

module.exports = {
	REVEAL_REASONS,
	isRegisteredSite,
	isActionableSite,
	revealRegisteredSite,
	deleteRegisteredSite,
	clearRegisteredSiteLog
};
