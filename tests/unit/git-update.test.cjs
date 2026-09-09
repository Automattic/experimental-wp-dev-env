'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
	isDirtyFromStatusMatrix,
	staleStagedPaths,
	lockfileChangedFromBlobOids,
	normalizeEol,
	normalizeEolBuffer
} = require('../../src/git-update.cjs');

test('isDirtyFromStatusMatrix: clean tree (issue #94)', () => {
	const matrix = [
		['a.php', 1, 1, 1],
		['b.php', 1, 1, 1]
	];
	assert.deepStrictEqual(isDirtyFromStatusMatrix(matrix), { dirty: false, changedCount: 0, files: [], rows: [] });
});

test('isDirtyFromStatusMatrix: modified, deleted and untracked files are dirty, and named (issue #94)', () => {
	assert.strictEqual(isDirtyFromStatusMatrix([['m.php', 1, 2, 1]]).dirty, true); // modified
	assert.strictEqual(isDirtyFromStatusMatrix([['d.php', 1, 0, 1]]).dirty, true); // deleted
	assert.strictEqual(isDirtyFromStatusMatrix([['u.php', 0, 2, 0]]).dirty, true); // untracked
	assert.deepStrictEqual(
		isDirtyFromStatusMatrix([['m.php', 1, 2, 1], ['ok.php', 1, 1, 1], ['u.php', 0, 2, 0]]).files,
		['m.php', 'u.php']
	);
});

test('isDirtyFromStatusMatrix: staged-but-identical to HEAD is clean — no patch hunks would result (issue #94)', () => {
	assert.deepStrictEqual(isDirtyFromStatusMatrix([['s.php', 1, 1, 3]]), { dirty: false, changedCount: 0, files: [], rows: [] });
});

test('isDirtyFromStatusMatrix: untracked file staged by a prior patch generation is dirty (issue #94)', () => {
	assert.strictEqual(isDirtyFromStatusMatrix([['new.php', 0, 2, 2]]).dirty, true);
});

test('isDirtyFromStatusMatrix: empty or missing matrix is clean (issue #94)', () => {
	assert.deepStrictEqual(isDirtyFromStatusMatrix([]), { dirty: false, changedCount: 0, files: [], rows: [] });
	assert.deepStrictEqual(isDirtyFromStatusMatrix(undefined), { dirty: false, changedCount: 0, files: [], rows: [] });
});

test('staleStagedPaths: picks only staged files absent from HEAD (issue #94)', () => {
	const matrix = [
		['tracked.php', 1, 2, 3],
		['staged-untracked.php', 0, 2, 2],
		['plain-untracked.php', 0, 2, 0],
		['staged-then-deleted.php', 0, 0, 3]
	];
	assert.deepStrictEqual(staleStagedPaths(matrix), ['staged-untracked.php', 'staged-then-deleted.php']);
});

test('lockfileChangedFromBlobOids: both absent -> unchanged (issue #94)', () => {
	assert.strictEqual(lockfileChangedFromBlobOids(null, null), false);
});

test('lockfileChangedFromBlobOids: presence differing -> changed (issue #94)', () => {
	assert.strictEqual(lockfileChangedFromBlobOids('abc', null), true);
	assert.strictEqual(lockfileChangedFromBlobOids(null, 'abc'), true);
});

test('lockfileChangedFromBlobOids: same oid -> unchanged, different oid -> changed (issue #94)', () => {
	assert.strictEqual(lockfileChangedFromBlobOids('abc', 'abc'), false);
	assert.strictEqual(lockfileChangedFromBlobOids('abc', 'def'), true);
});

test('normalizeEolBuffer: byte-level CRLF stripping works on non-UTF8 content (issue #94)', () => {
	// Big5-style bytes that are not valid UTF-8, with CRLF line endings —
	// the case any normalization that decodes the text first would skip.
	const crlf = Buffer.from([0xa4, 0xa4, 0x0d, 0x0a, 0xa4, 0xe5, 0x0d, 0x0a]);
	const lf = Buffer.from([0xa4, 0xa4, 0x0a, 0xa4, 0xe5, 0x0a]);
	assert.ok(normalizeEolBuffer(crlf).equals(lf));
	assert.ok(normalizeEolBuffer(lf).equals(lf));
	// Lone CR (not followed by LF) is preserved.
	const loneCr = Buffer.from([0x61, 0x0d, 0x62]);
	assert.ok(normalizeEolBuffer(loneCr).equals(loneCr));
	assert.ok(normalizeEolBuffer(Buffer.alloc(0)).equals(Buffer.alloc(0)));
});

test('normalizeEol: CRLF becomes LF, lone CR and LF are untouched (issue #94)', () => {
	assert.strictEqual(normalizeEol('a\r\nb\r\n'), 'a\nb\n');
	assert.strictEqual(normalizeEol('a\nb\n'), 'a\nb\n');
	assert.strictEqual(normalizeEol('a\rb'), 'a\rb');
	assert.strictEqual(normalizeEol(''), '');
});
