'use strict';

/**
 * Pure helpers for the trunk update path (issue #94), operating on the app's
 * status rows and on blob oids. Kept dependency-free so `node --test` can
 * require them directly while the git I/O stays in git-read.cjs and main.js.
 *
 * Status row shape (isomorphic-git's statusMatrix vocabulary, which
 * git-read.cjs keeps producing from `git status --porcelain=v2`):
 * [filepath, head, workdir, stage] where
 * head: 0 absent, 1 present; workdir: 0 absent, 1 identical, 2 different;
 * stage: 0 absent, 1 identical, 2 modified-staged, 3 modified-unstaged.
 */

/**
 * A worktree is dirty when any file's working copy differs from HEAD. The
 * stage column is deliberately ignored: a file staged but byte-identical to
 * HEAD produces no patch hunks, so warning about it would show a scary
 * modal for a no-op.
 *
 * These are exactly the rows the patch generator walks — including deletions,
 * which it used to drop (#85). A binary among them is named above the diff
 * rather than diffed, so the count here can still exceed the number of file
 * sections in the patch.
 *
 * @param {Array} matrix
 */
function isDirtyFromStatusMatrix(matrix) {
	const rows = (matrix || []).filter(([, head, workdir]) => head !== workdir);
	return { dirty: rows.length > 0, changedCount: rows.length, files: rows.map(([filepath]) => filepath), rows };
}

/**
 * Files staged but absent from HEAD — the residue patch generation leaves
 * behind (it stages untracked files and never unstages). checkout({force})
 * deletes workdir files that are in the index but not in the target tree, so
 * these must be removed from the index (index-only) before a reset or the
 * user's untracked files get destroyed.
 *
 * @param {Array} matrix
 */
function staleStagedPaths(matrix) {
	return (matrix || [])
		.filter(([, head, , stage]) => head === 0 && stage !== 0)
		.map(([filepath]) => filepath);
}

/**
 * Whether package-lock.json changed between two trunk snapshots, from the
 * blob oids on each side (null when the file is absent in that tree).
 *
 * @param {string|null} oldBlobOid
 * @param {string|null} newBlobOid
 */
function lockfileChangedFromBlobOids(oldBlobOid, newBlobOid) {
	if (!oldBlobOid && !newBlobOid) return false;
	if (!oldBlobOid || !newBlobOid) return true;
	return oldBlobOid !== newBlobOid;
}

/**
 * Normalizes CRLF to LF. wordpress-develop's blobs are LF-only, but a site
 * checked out by native git on Windows (default core.autocrlf=true) has CRLF
 * on disk — without normalization every text file diffs on every line.
 * Matches git's autocrlf read-side behavior: lone \r is left alone.
 *
 * @param {string} text
 */
function normalizeEol(text) {
	return String(text).replace(/\r\n/g, '\n');
}

/**
 * Byte-level CRLF→LF normalization for Buffers. isomorphic-git's autocrlf
 * handling only normalizes files that decode as valid UTF-8, so non-UTF8
 * text fixtures (e.g. wordpress-develop's Big5/Latin-1 encoding tests)
 * smudged to CRLF by a native-git checkout still hash as modified. This
 * works on raw bytes, so encoding doesn't matter.
 *
 * @param {Buffer|Uint8Array} buf
 */
function normalizeEolBuffer(buf) {
	const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	const out = Buffer.alloc(src.length);
	let j = 0;
	for (let i = 0; i < src.length; i++) {
		if (src[i] === 13 && src[i + 1] === 10) continue;
		out[j++] = src[i];
	}
	return out.subarray(0, j);
}

module.exports = { isDirtyFromStatusMatrix, staleStagedPaths, lockfileChangedFromBlobOids, normalizeEol, normalizeEolBuffer };
