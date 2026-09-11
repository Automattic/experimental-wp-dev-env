const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeExternalUrl, openExternalUrl, ALLOWED_URL_SCHEMES } = require('../../src/external-url.js');

test('a refused URL reaches the log escaped and bounded', async () => {
	const rec = recorder();
	await openExternalUrl(`file:///tmp/\n${'x'.repeat(500)}`, rec.options);
	assert.equal(rec.refused.length, 1);
	assert.ok(rec.refused[0].startsWith('file:///tmp/\\x0a'));
	assert.equal(rec.refused[0].length, 121);
	assert.ok(rec.refused[0].endsWith('…'));
});

// Stands in for shell.openExternal, so "did this reach the OS?" is an assertion
// rather than something the test has to take on trust.
function recorder() {
	const opened = [];
	const refused = [];
	return {
		opened,
		refused,
		options: {
			openExternal: async (url) => { opened.push(url); },
			onRefused: (description) => { refused.push(description); }
		}
	};
}

// The addresses the app actually passes today: Trac, the feedback form, the
// site and its admin on an ephemeral loopback port.
test('the addresses the app uses still open', async () => {
	const rec = recorder();

	for (const url of [
		'https://core.trac.wordpress.org',
		'http://127.0.0.1:39372/',
		'http://127.0.0.1:8881/wp-admin/',
		'https://docs.google.com/forms/d/e/1FAIpQLS/viewform'
	]) {
		assert.equal(await openExternalUrl(url, rec.options), true);
	}

	// What reaches the OS is the parsed `href`, so that the address that was
	// checked is the address that gets opened. For real callers that is the same
	// string they passed, give or take the trailing slash the parser adds to a
	// bare origin.
	assert.deepEqual(rec.opened, [
		'https://core.trac.wordpress.org/',
		'http://127.0.0.1:39372/',
		'http://127.0.0.1:8881/wp-admin/',
		'https://docs.google.com/forms/d/e/1FAIpQLS/viewform'
	]);
	assert.deepEqual(rec.refused, []);
});

// The reason the OS gets the parsed form. The URL parser strips tabs and
// newlines from anywhere in the input, including the middle of the scheme, so
// this string validates as http — and if the raw text were forwarded, the OS
// would be resolving an address nothing had checked.
test('control characters cannot split what is checked from what is opened', async () => {
	const rec = recorder();

	assert.equal(await openExternalUrl('ht\ntp://example.com/x', rec.options), true);
	assert.deepEqual(rec.opened, ['http://example.com/x']);

	assert.equal(normalizeExternalUrl('http://example.com/\tfoo'), 'http://example.com/foo');
});

test('a file: address never reaches the OS', async () => {
	const rec = recorder();

	// The Windows one is the case that matters most: the OS association for a
	// .exe is "run it", not "show it".
	for (const url of ['file:///etc/passwd', 'file:///C:/Windows/System32/cmd.exe']) {
		assert.equal(await openExternalUrl(url, rec.options), false);
	}

	assert.deepEqual(rec.opened, []);
	assert.equal(rec.refused.length, 2);
});

test('other schemes are refused too', async () => {
	const rec = recorder();

	for (const url of [
		'javascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		// Anything a third-party installer registered on the machine.
		'ms-msdt:/id PCWDiagnostic',
		'vscode://file/etc/hosts',
		'mailto:someone@example.com'
	]) {
		assert.equal(await openExternalUrl(url, rec.options), false);
	}

	assert.deepEqual(rec.opened, []);
	assert.equal(rec.refused.length, 5);
});

test('junk input is refused rather than thrown', async () => {
	const rec = recorder();

	for (const url of ['', '   ', null, undefined, 42, {}, ['https://example.com'], 'not a url']) {
		assert.equal(await openExternalUrl(url, rec.options), false);
	}

	assert.deepEqual(rec.opened, []);
});

test('the scheme is read off the parsed URL, not the raw string', () => {
	// Casing and leading whitespace are normalized by the URL parser before the
	// comparison, so they are neither a false refusal nor a way past the guard.
	assert.equal(normalizeExternalUrl('HTTPS://example.com'), 'https://example.com/');
	assert.equal(normalizeExternalUrl('  https://example.com'), 'https://example.com/');
	assert.equal(normalizeExternalUrl('FILE:///etc/passwd'), null);
	assert.equal(normalizeExternalUrl('  file:///etc/passwd'), null);
});

test('the allow-list is only http and https', () => {
	// A guard against widening it by accident: adding a scheme should be a
	// deliberate change with a reason, and this test is where that shows up.
	assert.deepEqual(ALLOWED_URL_SCHEMES, ['http:', 'https:']);
});
