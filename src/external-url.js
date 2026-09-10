// The gate in front of `shell.openExternal`.
//
// `openExternal` hands an address to whatever application the OS has registered
// for its scheme, which is a much wider action than "show this page in the
// browser". A `file:` address opens an arbitrary local path in its associated
// application — on Windows that can mean running it rather than viewing it —
// and every other scheme registered on the machine is reachable the same way.
//
// The renderer is the only caller and every call site passes an http/https
// address, so nothing today misuses it. But the renderer also displays content
// the app does not author: child-process output from an install or a build, and
// the site being developed. The server URL the app auto-opens is itself parsed
// out of the Playground server's stdout. This module is the step that keeps any
// future influence over that string from turning into an action on the
// contributor's machine.
//
// Widen ALLOWED_URL_SCHEMES only for a scheme the app actually needs, and only
// after asking what the OS does with it.

const { describeRefused } = require('./safe-log');

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

// Returns the address to open, or null if it is not one this app opens.
//
// Scheme is read off the parsed URL rather than the raw string, so casing and
// leading whitespace ('FILE:', ' file:') are normalized before the comparison
// instead of being a way around it. An address Node can't parse is refused
// rather than passed on to the OS to interpret.
//
// What comes back is the parser's own `href`, not the caller's string. Checking
// one string and opening a different one is the gap this module exists to
// close: the URL parser strips tabs and newlines from anywhere in the input,
// including the middle of the scheme, so 'ht\ntp://example.com' validates as
// http while the OS would receive an address its own parser resolves by its own
// rules. Returning the normalized form means the address that was checked is
// the address that gets opened. For every caller in this app the two are
// identical but for a trailing slash.
function normalizeExternalUrl(url) {
	if (typeof url !== 'string' || url.trim() === '') return null;

	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) return null;

	return parsed.href;
}

// A refused address is attacker-influenced by hypothesis, and it is about to be
// written into the file contributors attach to bug reports, so it has to stay on
// one line and it has to be bounded. safe-log.js is where both live, and why.
function describeRefusedUrl(url) {
	return describeRefused(url);
}

// The `url:open` handler's body, kept out of main.js so both sides of the guard
// can be tested without an Electron process: `openExternal` is the real
// `shell.openExternal` in the app and a recording stub in the tests.
async function openExternalUrl(url, { openExternal, onRefused } = {}) {
	const target = normalizeExternalUrl(url);

	if (target === null) {
		if (typeof onRefused === 'function') onRefused(describeRefusedUrl(url));
		return false;
	}

	await openExternal(target);
	return true;
}

module.exports = {
	ALLOWED_URL_SCHEMES,
	normalizeExternalUrl,
	describeRefusedUrl,
	openExternalUrl
};
