const test = require('node:test');
const assert = require('node:assert/strict');

const { describeRefused } = require('../../src/safe-log.js');

test('describeRefused escapes every log-breaking control character', () => {
	assert.equal(describeRefused('file:///a\rb'), 'file:///a\\x0db');
	assert.equal(describeRefused('file:///a\tb'), 'file:///a\\x09b');
	assert.equal(describeRefused('file:///a\u2028b'), 'file:///a\\u2028b');
	assert.equal(describeRefused('file:///a\u0000b'), 'file:///a\\x00b');
	assert.equal(describeRefused('file:///etc/passwd'), 'file:///etc/passwd');
});

test('describeRefused prevents a refused value from forging a second log entry', () => {
	const forged = 'file:///tmp/x\n[2026-08-06 10:00:00.000] [info]  (app) update completed successfully';
	const description = describeRefused(forged);

	assert.ok(!description.includes('\n'));
	assert.ok(description.includes('file:///tmp/x\\x0a[2026-08-06'));
});

test('describeRefused escapes before bounding its output', () => {
	const description = describeRefused(`file:${'\n'.repeat(500)}`);

	assert.equal(description.length, 121);
	assert.ok(description.endsWith('…'));
	assert.ok(!description.includes('\n'));
});

test('describeRefused describes non-string values by type', () => {
	assert.equal(describeRefused(null), '<null>');
	assert.equal(describeRefused(undefined), '<undefined>');
	assert.equal(describeRefused(42), '<number>');
	assert.equal(describeRefused({}), '<object>');
});
