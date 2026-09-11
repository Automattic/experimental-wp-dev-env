'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { siteUrl, adminUrl, adminerUrl } = require('../../src/renderer/site-urls.cjs');

// The shape server-runner.js actually produces: `http://127.0.0.1:${port}/`.
const RUNNING = 'http://127.0.0.1:8881/';

test('adminUrl: the admin of a running site (issue #248)', () => {
	assert.strictEqual(adminUrl(RUNNING), 'http://127.0.0.1:8881/wp-admin/');
});

test('adminUrl: keeps the trailing slash WordPress would redirect to (issue #248)', () => {
	assert.ok(adminUrl(RUNNING).endsWith('/wp-admin/'));
});

// The bug the old inline `.replace(/\/$/, '/')` could not catch: it swapped a
// trailing slash for a trailing slash.
test('adminUrl: a base without a trailing slash does not run the path together (issue #248)', () => {
	assert.strictEqual(adminUrl('http://127.0.0.1:8881'), 'http://127.0.0.1:8881/wp-admin/');
});

test('adminerUrl: matches what the Open Adminer button produced before (issue #248)', () => {
	assert.strictEqual(adminerUrl(RUNNING), 'http://127.0.0.1:8881/adminer.php');
});

test('adminerUrl: a base without a trailing slash is joined, not concatenated (issue #248)', () => {
	assert.strictEqual(adminerUrl('http://127.0.0.1:8881'), 'http://127.0.0.1:8881/adminer.php');
});

// '' keeps the renderer's existing falsy guard working on the derived URL,
// rather than yielding a link relative to the app.
test('no dev server yields no URL rather than a relative one (issue #248)', () => {
	assert.strictEqual(adminUrl(''), '');
	assert.strictEqual(adminerUrl(''), '');
	assert.strictEqual(siteUrl('', 'wp-admin/'), '');
});

test('a non-string base is treated as absent, not coerced (issue #248)', () => {
	assert.strictEqual(adminUrl(undefined), '');
	assert.strictEqual(adminUrl(null), '');
	assert.strictEqual(adminerUrl(undefined), '');
});

test('siteUrl: a leading slash on the path does not double up (issue #248)', () => {
	assert.strictEqual(siteUrl(RUNNING, '/wp-admin/'), 'http://127.0.0.1:8881/wp-admin/');
});

test('siteUrl: several slashes on either side still join once (issue #248)', () => {
	assert.strictEqual(siteUrl('http://127.0.0.1:8881//', '//wp-admin/'), 'http://127.0.0.1:8881/wp-admin/');
});

test('siteUrl: whitespace around a base is trimmed (issue #248)', () => {
	assert.strictEqual(siteUrl('  http://127.0.0.1:8881/  ', 'wp-admin/'), 'http://127.0.0.1:8881/wp-admin/');
});

test('siteUrl: an empty path yields the base with one trailing slash (issue #248)', () => {
	assert.strictEqual(siteUrl(RUNNING, ''), 'http://127.0.0.1:8881/');
});

// A port is part of the origin, and stripping it would point the link at :80.
test('siteUrl: the port survives (issue #248)', () => {
	assert.ok(adminUrl('http://127.0.0.1:39372/').startsWith('http://127.0.0.1:39372/'));
});
