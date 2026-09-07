'use strict';

// Shaping the working tree into tree-API entries (#167): the platform split
// for file modes, deletions, and the CRLF handling that keeps a Windows
// checkout from publishing a pull request where every line is rewritten.
//
// Both platform branches run from one machine by injecting `platform`, `stat`
// and `git` — the house pattern (tests/unit/win-spawn-patch.test.cjs), not `it.skip`,
// which would leave each OS's CI blind to the other's branch.

const test = require('node:test');
const assert = require('node:assert');
const {
	fileModeForEntry,
	buildPullRequestEntries,
	isProbablyBinary,
	blobSha,
	GIT_MODE_FILE,
	GIT_MODE_EXECUTABLE
} = require('../../src/pr-files.cjs');

const DIR = '/sites/wp';

// A fake `treeEntryMode` answering from the given path → mode map, the way
// git-read.cjs answers from one `ls-tree` on the path.
function fakeTreeWithModes(modes) {
	return async (dir, oid, filepath) => (Object.hasOwn(modes, filepath) ? modes[filepath] : null);
}

function deps(overrides = {}) {
	return {
		treeEntryMode: fakeTreeWithModes({}),
		fs: null,
		dir: DIR,
		headOid: 'head',
		platform: 'darwin',
		stat: async () => ({ mode: 0o644 }),
		...overrides
	};
}

test('isProbablyBinary: a NUL byte means binary; absence means nothing', () => {
	assert.strictEqual(isProbablyBinary(Buffer.from([0x89, 0x00, 0x4e])), true);
	assert.strictEqual(isProbablyBinary(Buffer.from('plain text\n')), false);
	assert.strictEqual(isProbablyBinary(null), false);
});

// POSIX: what is on disk decides, because it is what the contributor has.
test('on POSIX the working tree’s executable bit decides the mode', async () => {
	const executable = await fileModeForEntry(
		deps({ stat: async () => ({ mode: 0o755 }) }),
		{ path: 'tools/build.sh', inHead: true, inWorkdir: true }
	);
	assert.strictEqual(executable, GIT_MODE_EXECUTABLE);

	const plain = await fileModeForEntry(
		deps({ stat: async () => ({ mode: 0o644 }) }),
		{ path: 'src/wp-admin/a.php', inHead: true, inWorkdir: true }
	);
	assert.strictEqual(plain, GIT_MODE_FILE);
});

// Windows: there is no bit to read, so the mode git recorded in HEAD is the
// truth — the filesystem must not be consulted, or a 100755 file would be
// silently demoted on every Windows contributor's pull request.
test('on Windows the mode recorded in HEAD decides, and the filesystem is never asked', async () => {
	let statted = false;
	const mode = await fileModeForEntry(
		deps({
			platform: 'win32',
			stat: async () => { statted = true; return { mode: 0o644 }; },
			treeEntryMode: fakeTreeWithModes({ 'tools/build.sh': '100755' })
		}),
		{ path: 'tools/build.sh', inHead: true, inWorkdir: true }
	);
	assert.strictEqual(mode, GIT_MODE_EXECUTABLE);
	assert.strictEqual(statted, false);
});

test('an added file on Windows has no recorded mode and no bit: 100644', async () => {
	const mode = await fileModeForEntry(
		deps({ platform: 'win32', treeEntryMode: fakeTreeWithModes({}) }),
		{ path: 'new-file.php', inHead: false, inWorkdir: true }
	);
	assert.strictEqual(mode, GIT_MODE_FILE);
});

// A deletion's mode lookup must never stat the path — the file is gone.
test('a deletion reads its mode from HEAD without touching the missing path', async () => {
	let statted = false;
	const entries = await buildPullRequestEntries(
		[{ path: 'src/wp-includes/gone.php', inHead: true, inWorkdir: false, base: Buffer.from('x'), work: null }],
		deps({
			stat: async () => { statted = true; throw new Error('ENOENT'); },
			treeEntryMode: fakeTreeWithModes({ 'src/wp-includes/gone.php': '100644' })
		})
	);
	assert.deepStrictEqual(entries, [{
		path: 'src/wp-includes/gone.php',
		kind: 'delete',
		content: null,
		mode: '100644',
		// The blob the checkout held, so the staleness check can tell an
		// upstream change to this file from the deletion being proposed.
		baseBlobSha: blobSha(Buffer.from('x'))
	}]);
	assert.strictEqual(statted, false);
});

// The 🔴 case: a CRLF checkout. Edited text goes up LF-normalised — matching
// what the `.diff` renders and what upstream stores — not as a full-file
// rewrite.
test('text content is uploaded LF-normalised, as the patch renders it', async () => {
	const entries = await buildPullRequestEntries(
		[{
			path: 'src/wp-admin/a.php',
			inHead: true,
			inWorkdir: true,
			base: Buffer.from('line1\nline2\n'),
			work: Buffer.from('line1\r\nline2\r\nline3\r\n')
		}],
		deps()
	);
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0].content.toString('utf8'), 'line1\nline2\nline3\n');
});

// The phantom-change case: statusMatrix's autocrlf handling misses non-UTF-8
// files, so a file whose only difference is line endings reaches this walk.
// It must not become a pull request entry — the contributor never touched it,
// and the `.diff` does not list it either.
test('a CRLF-only difference is not a change', async () => {
	const entries = await buildPullRequestEntries(
		[{
			path: 'tests/phpunit/data/encoded.php',
			inHead: true,
			inWorkdir: true,
			base: Buffer.from('caf\xe9\nline2\n', 'latin1'),
			work: Buffer.from('caf\xe9\r\nline2\r\n', 'latin1')
		}],
		deps()
	);
	assert.deepStrictEqual(entries, []);
});

// Binary is the opposite contract: carried byte-for-byte, no normalisation —
// a 0x0d inside a PNG is data, not a line ending.
test('binary content is compared and carried raw', async () => {
	const bytes = Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0xff]);
	const entries = await buildPullRequestEntries(
		[{ path: 'a.png', inHead: false, inWorkdir: true, base: null, work: bytes }],
		deps()
	);
	assert.strictEqual(entries.length, 1);
	assert.ok(entries[0].content.equals(bytes), 'the bytes must survive untouched');

	const unchanged = await buildPullRequestEntries(
		[{ path: 'b.png', inHead: true, inWorkdir: true, base: bytes, work: Buffer.from(bytes) }],
		deps()
	);
	assert.deepStrictEqual(unchanged, []);
});

test('a file present but unreadable is skipped, not deleted and not emptied', async () => {
	const entries = await buildPullRequestEntries(
		[{ path: 'locked.php', inHead: true, inWorkdir: true, base: Buffer.from('x'), work: null }],
		deps()
	);
	assert.deepStrictEqual(entries, []);
});

test('adds and modifies carry their kind', async () => {
	const entries = await buildPullRequestEntries(
		[
			{ path: 'new.php', inHead: false, inWorkdir: true, base: null, work: Buffer.from('a\n') },
			{ path: 'old.php', inHead: true, inWorkdir: true, base: Buffer.from('a\n'), work: Buffer.from('b\n') }
		],
		deps()
	);
	assert.deepStrictEqual(entries.map((e) => [e.path, e.kind]), [['new.php', 'add'], ['old.php', 'modify']]);
	// A file the contributor is adding has no base blob; a modified one does.
	assert.strictEqual(entries[0].baseBlobSha, null);
	assert.strictEqual(entries[1].baseBlobSha, blobSha(Buffer.from('a\n')));
});

// The sha has to be git's, not any hash: it is compared against what GitHub
// reports for the same file, and a different scheme would make every file look
// changed. This is the value `git hash-object` prints for an empty blob and for
// "hello\n" — both fixed by the format, not by this implementation.
test('blobSha computes git’s own object id', () => {
	assert.strictEqual(blobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
	assert.strictEqual(blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
	// No file at that commit is not a hash of nothing.
	assert.strictEqual(blobSha(null), null);
});
