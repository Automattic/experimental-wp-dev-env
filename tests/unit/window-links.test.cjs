const test = require('node:test');
const assert = require('node:assert/strict');

const { openLinksExternally } = require('../../src/window-links.js');

// Stands in for a window's webContents, so the gestures can be replayed without
// an Electron process - the same approach external-url.test.cjs takes with the
// shell.
function fakeWebContents() {
	const listeners = {};
	return {
		windowOpenHandler: null,
		setWindowOpenHandler(handler) { this.windowOpenHandler = handler; },
		on(event, listener) { (listeners[event] ||= []).push(listener); },
		// Replays a gesture; returns whether the navigation was cancelled.
		emit(event, url) {
			let prevented = false;
			const fakeEvent = { preventDefault() { prevented = true; } };
			for (const listener of listeners[event] || []) listener(fakeEvent, url);
			return prevented;
		}
	};
}

function recorder() {
	const opened = [];
	const refused = [];
	return {
		opened,
		refused,
		deps: {
			openExternal: async (url) => { opened.push(url); },
			onRefused: (description) => { refused.push(description); }
		}
	};
}

// The hand-off is a promise the synchronous handlers cannot await.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a middle click opens the browser instead of a window (#284)', async () => {
	const wc = fakeWebContents();
	const rec = recorder();
	openLinksExternally(wc, rec.deps);

	const result = wc.windowOpenHandler({ url: 'http://127.0.0.1:39372/wp-admin/' });
	await settled();

	assert.deepEqual(result, { action: 'deny' });
	assert.deepEqual(rec.opened, ['http://127.0.0.1:39372/wp-admin/']);
});

test('a click no handler cancelled still opens the browser', async () => {
	const wc = fakeWebContents();
	const rec = recorder();
	openLinksExternally(wc, rec.deps);

	assert.equal(wc.emit('will-navigate', 'https://core.trac.wordpress.org/ticket/284'), true);
	await settled();

	assert.deepEqual(rec.opened, ['https://core.trac.wordpress.org/ticket/284']);
});

test('a redirect cannot move the app window either', async () => {
	// will-redirect covers the 3xx and <meta refresh> that never fire
	// will-navigate - a login redirect on the site would land here.
	const wc = fakeWebContents();
	const rec = recorder();
	openLinksExternally(wc, rec.deps);

	assert.equal(wc.emit('will-redirect', 'https://wordpress.org/'), true);
	await settled();

	assert.deepEqual(rec.opened, ['https://wordpress.org/']);
});

test("the app's own page is left alone", async () => {
	// Cancelling this would stop the app window reloading, and a file: address is
	// not one to hand to the browser.
	const wc = fakeWebContents();
	const rec = recorder();
	openLinksExternally(wc, rec.deps);

	assert.equal(wc.emit('will-navigate', 'file:///Applications/toolkit/renderer/index.html'), false);
	await settled();

	assert.deepEqual(rec.opened, []);
	assert.deepEqual(rec.refused, []);
});

test('a scheme the app does not open is refused, and opens no window', async () => {
	const wc = fakeWebContents();
	const rec = recorder();
	openLinksExternally(wc, rec.deps);

	assert.deepEqual(wc.windowOpenHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
	await settled();

	assert.deepEqual(rec.opened, []);
	assert.equal(rec.refused.length, 1);
});

test('a failed open is reported, not swallowed', async () => {
	// shell.openExternal rejects when the OS has nothing registered. Nothing else
	// is in a position to catch it, and an unreported failure is a link that did
	// nothing.
	const wc = fakeWebContents();
	const failures = [];
	openLinksExternally(wc, {
		openExternal: async () => { throw new Error('no handler'); },
		onFailed: (url, error) => { failures.push([url, error.message]); }
	});

	wc.emit('will-navigate', 'https://example.com/');
	wc.windowOpenHandler({ url: 'https://example.com/' });
	await settled();

	assert.deepEqual(failures, [
		['https://example.com/', 'no handler'],
		['https://example.com/', 'no handler']
	]);
});

test('a failure with no reporter still does not crash the app', async () => {
	const wc = fakeWebContents();
	openLinksExternally(wc, { openExternal: async () => { throw new Error('no handler'); } });

	wc.emit('will-navigate', 'https://example.com/');
	await settled();
});
