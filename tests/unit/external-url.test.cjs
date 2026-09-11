const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeExternalUrl, describeRefusedUrl, openExternalUrl, ALLOWED_URL_SCHEMES } = require('../../src/external-url.js');

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

test('a refusal reports the address, truncated', async () => {
	const rec = recorder();
	const long = `file:///${'a'.repeat(500)}`;

	await openExternalUrl(long, rec.options);

	assert.equal(rec.refused.length, 1);
	assert.ok(rec.refused[0].length < 200, 'the log line should not carry a 500-character address');
	assert.ok(rec.refused[0].startsWith('file:///aaa'), 'enough of the address to diagnose the caller');
});

// The address is about to be written into the file contributors attach to bug
// reports, and electron-log passes newlines through unchanged. Left as-is, a
// refused address could close the log line and open another one in the app's own
// timestamp-and-scope format — a log that describes events that never happened.
test('a refused address cannot forge a second log line', async () => {
	const rec = recorder();
	const forged = 'file:///tmp/x\n[2026-08-06 10:00:00.000] [info]  (app) update completed successfully';

	await openExternalUrl(forged, rec.options);

	assert.equal(rec.refused.length, 1);
	assert.ok(!rec.refused[0].includes('\n'), 'the description must stay on one line');
	// Escaped, not dropped: the line still says what the caller actually sent.
	assert.ok(rec.refused[0].includes('file:///tmp/x\\x0a[2026-08-06'));
});

test('every control character is escaped, not just newlines', () => {
	// Carriage return alone ends a line in some viewers, and U+2028/U+2029 do it
	// in others, so the whole class is escaped rather than the obvious member.
	assert.equal(describeRefusedUrl('file:///a\rb'), 'file:///a\\x0db');
	assert.equal(describeRefusedUrl('file:///a\tb'), 'file:///a\\x09b');
	assert.equal(describeRefusedUrl('file:///a\u2028b'), 'file:///a\\u2028b');
	assert.equal(describeRefusedUrl('file:///a\u0000b'), 'file:///a\\x00b');
	// Ordinary addresses are untouched.
	assert.equal(describeRefusedUrl('file:///etc/passwd'), 'file:///etc/passwd');
});

test('truncation is applied to the escaped form', () => {
	// Escaping expands the string, so truncating first would let an address of
	// control characters land in the log several times over the cap.
	const description = describeRefusedUrl(`file:${'\n'.repeat(500)}`);

	assert.ok(description.length <= 121, `escaped description was ${description.length} characters`);
	assert.ok(!description.includes('\n'));
});
