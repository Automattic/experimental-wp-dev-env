// Keeps links in the app window opening in the contributor's browser (#284).
//
// Each link cancels its own navigation in its onClick handler. That covers a
// plain click, but a middle click fires `auxclick`, which a click handler never
// sees — so Chromium's "open in a new window" default ran and the site loaded
// inside a bare app window with no address bar. Cmd/Ctrl+click was fine, since
// that does arrive as a click the handler can cancel.
//
// Refusing once for the whole window fixes it for every link, including ones
// added later. The address goes out through external-url.js, the same gate the
// renderer's own openExternal calls use.

const { isAllowedExternalUrl, openExternalUrl } = require('./external-url');

/**
 * Keeps a window on its own page and sends any link it opens to the browser.
 *
 * @param {import('electron').WebContents} wc
 * @param {Object}                         [deps]
 * @param {Function}                       [deps.openExternal] `shell.openExternal` in the app, a stub in tests.
 * @param {Function}                       [deps.onRefused]    Called with a description of a refused address.
 * @param {Function}                       [deps.onFailed]     Called with the address and error when opening fails.
 */
function openLinksExternally(wc, { openExternal, onRefused, onFailed } = {}) {
	// These events are synchronous and ignore what the handler returns, so the
	// hand-off cannot be awaited. The failure is reported rather than dropped:
	// openExternal rejects when the OS has no handler for the address, and from
	// the contributor's chair that is a link that did nothing.
	const handOff = (url) => {
		Promise.resolve(openExternalUrl(url, { openExternal, onRefused })).catch((error) => {
			if (typeof onFailed === 'function') onFailed(url, error);
		});
	};

	// Middle click, Cmd/Ctrl+click, target="_blank", window.open. A child window
	// is never this app's UI, so it is denied whatever the address is.
	wc.setWindowOpenHandler(({ url }) => {
		handOff(url);
		return { action: 'deny' };
	});

	// A click no handler cancelled, or a script navigation. Only http/https is
	// taken over: the app's own page is a file: URL and has to stay loadable.
	const sendToBrowser = (event, url) => {
		if (!isAllowedExternalUrl(url)) return;
		event.preventDefault();
		handOff(url);
	};
	// will-navigate is the click. will-redirect is the 3xx or <meta refresh>
	// that does not fire it, and would otherwise move the window.
	wc.on('will-navigate', sendToBrowser);
	wc.on('will-redirect', sendToBrowser);
}

module.exports = { openLinksExternally };
