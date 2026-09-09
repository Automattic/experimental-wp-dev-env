const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProgressLines, createProgressReader, failureReason } = require('../../src/git-progress.cjs');

// The one non-porcelain parser, fed the exact lines Git prints. Shared by the
// clone and the checkout; each caller's own arguments are tested beside it.

test('progress lines parse with and without the remote: prefix, and other lines are dropped', () => {
	const text = [
		"Cloning into '/sites/wp'...",
		'remote: Enumerating objects: 4, done.        ',
		'remote: Counting objects:  25% (1/4)        \rremote: Counting objects: 100% (4/4), done.        ',
		'Receiving objects:  42% (1234/5678), 12.00 MiB | 3.00 MiB/s',
		'Resolving deltas: 100% (10/10), done.',
		'Updating files:  50% (100/200)',
		'warning: something unrelated'
	].join('\n');
	assert.deepEqual(parseProgressLines(text), [
		{ phase: 'counting objects', percent: 25, loaded: 1, total: 4 },
		{ phase: 'counting objects', percent: 100, loaded: 4, total: 4 },
		{ phase: 'receiving objects', percent: 42, loaded: 1234, total: 5678 },
		{ phase: 'resolving deltas', percent: 100, loaded: 10, total: 10 },
		{ phase: 'updating files', percent: 50, loaded: 100, total: 200 }
	]);
});

test('a percentage split across two chunks is reported once, whole', () => {
	const seen = [];
	const reader = createProgressReader((e) => seen.push(e));
	reader.push('Receiving objects:  4');
	assert.deepEqual(seen, [], 'nothing until the line ends');
	reader.push('2% (1234/5678)\rReceiving objects:  5');
	assert.deepEqual(seen, [{ phase: 'receiving objects', percent: 42, loaded: 1234, total: 5678 }]);
	reader.push('0% (2900/5678)\n');
	assert.equal(seen.length, 2);
	assert.equal(seen[1].percent, 50);
	reader.push('Updating files: 100% (200/200)');
	reader.flush();
	assert.equal(seen[2].phase, 'updating files');
});

test('the failure reason is the fatal line even when Git keeps talking after it', () => {
	const stderr = [
		'Receiving objects:  42% (1234/5678)',
		"fatal: unable to access 'https://example.test/': Could not resolve host",
		'Please make sure you have the correct access rights',
		'and the repository exists.'
	].join('\n');
	assert.equal(failureReason(stderr), "fatal: unable to access 'https://example.test/': Could not resolve host");
});

test('without a fatal line the last non-progress line is the reason, then the signal, then nothing', () => {
	assert.equal(failureReason('Updating files:  50% (1/2)\nsomething odd happened\n'), 'something odd happened');
	assert.equal(failureReason('Updating files:  50% (1/2)\r', 'SIGTERM'), 'killed by SIGTERM');
	assert.equal(failureReason('', null), 'no output');
});
