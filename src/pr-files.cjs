'use strict';

/**
 * The working tree's changes, in the shape the GitHub tree API takes (#167).
 *
 * This is the second consumer of main.js's collectChangedFiles walk — the
 * first renders a `.diff` — and the two renderings must not disagree about
 * what changed. That parity is why the EOL handling here mirrors the patch
 * builder's instead of trusting the bytes on disk:
 *
 * A Windows checkout sits on disk as CRLF (`ensureAutocrlf` sets
 * core.autocrlf=true, and native-git checkouts arrive that way). Upstream's
 * blobs are LF-only. Uploading raw workdir bytes would publish a pull request
 * where every line of an edited file is rewritten — and worse, the non-UTF-8
 * files that statusMatrix's autocrlf handling misses (wordpress-develop's
 * encoding fixtures; see isCrlfOnlyChange in trunk-update.js) would appear as
 * changed files the contributor never touched. So text content is normalised
 * to LF before upload, and a file whose only difference is line endings is
 * not a change at all. Binary content — anything with a NUL byte on either
 * side — is carried byte-for-byte, which is the one thing the `.diff` cannot
 * do.
 *
 * Kept out of main.js and behind injected dependencies (platform, stat,
 * treeEntryMode) so both sides of the platform split below are exercised by
 * `node --test` from one machine — the house pattern, per
 * win-spawn-patch.test.cjs.
 */

const path = require('path');
const crypto = require('crypto');
const { normalizeEolBuffer } = require('./git-update.cjs');

// The two modes a file in this repo can have. Git records nothing else for a
// blob except symlinks, which statusMatrix reports as ordinary files and
// wordpress-develop does not use.
const GIT_MODE_FILE = '100644';
const GIT_MODE_EXECUTABLE = '100755';

/**
 * Git's own object id for a blob: sha1 over `blob <length>\0` and the bytes.
 *
 * Computed here rather than asked of GitHub, because the answer is already on
 * disk. The staleness check needs to know what upstream had at the commit the
 * contributor started from, and that is exactly the blob their checkout holds
 * — asking a fork about a commit it may not have heard of, to learn something
 * local git already knows, is a network round trip that can also be wrong.
 *
 * Raw bytes, not the EOL-normalised ones sent as content: this has to equal
 * the sha upstream recorded, and upstream recorded what it stored.
 *
 * @param {Buffer|null} content
 * @return {string|null} Null when the file did not exist at that commit.
 */
function blobSha(content) {
	if (!Buffer.isBuffer(content)) return null;
	return crypto
		.createHash('sha1')
		.update(`blob ${content.length}\0`)
		.update(content)
		.digest('hex');
}

/**
 * The same heuristic the patch builder uses: a NUL byte means binary. Null and
 * missing buffers are not binary — they are absence.
 *
 * @param {Buffer|null} buf
 * @return {boolean}
 */
function isProbablyBinary(buf) {
	return Buffer.isBuffer(buf) && buf.includes(0);
}

/**
 * The mode git recorded for one path in one commit: one `ls-tree` on the
 * path (git-read.cjs) rather than a walk of the whole commit, which for
 * wordpress-develop is tens of thousands of entries to answer a question
 * about five files.
 *
 * @param {Object} deps     `{ treeEntryMode, dir }`
 * @param {string} oid
 * @param {string} filepath
 * @return {Promise<string|null>}
 */
async function modeInCommit(deps, oid, filepath) {
	const { treeEntryMode, dir } = deps;
	return treeEntryMode(dir, oid, filepath);
}

/**
 * The executable bit, which git records and a tree entry has to carry.
 *
 * On POSIX the working tree is authoritative — it is what the contributor
 * actually has. Windows has no executable bit at all, so a file that arrived
 * as 100755 would be silently demoted to 100644 by anything that asked the
 * filesystem; there, the mode git already recorded in HEAD is the truth. An
 * added file on Windows has no recorded mode and no bit to read, so 100644 is
 * the only answer available, and the right one for source.
 *
 * @param {Object} deps `{ treeEntryMode, fs, dir, headOid, platform, stat }`
 * @param {Object} file One collectChangedFiles entry.
 * @return {Promise<string>}
 */
async function fileModeForEntry(deps, file) {
	const { dir, headOid, platform } = deps;
	const stat = deps.stat || deps.fs.promises.stat;
	if (platform !== 'win32' && file.inWorkdir) {
		try {
			const stats = await stat(path.join(dir, file.path));
			// eslint-disable-next-line no-bitwise -- 0o111 is the executable bit for owner, group and other; masking is how a POSIX mode is read.
			const executable = (stats.mode & 0o111) !== 0;
			return executable ? GIT_MODE_EXECUTABLE : GIT_MODE_FILE;
		} catch {
			// Fall through to the recorded mode.
		}
	}
	if (file.inHead && headOid) {
		const recorded = await modeInCommit(deps, headOid, file.path).catch(() => null);
		if (recorded) return recorded;
	}
	return GIT_MODE_FILE;
}

/**
 * collectChangedFiles entries → tree API entries.
 *
 * Deletions are entries with null content — the tree API expresses them as a
 * null sha, and it is why the pull request carries deletions the `.diff`
 * still drops (#174). Files present but unreadable are skipped, since the
 * alternatives are committing a deletion or an empty file under that path.
 *
 * @param {Array}  files
 * @param {Object} deps  `{ treeEntryMode, fs, dir, headOid, platform, stat }`
 * @return {Promise<Array<{path: string, kind: string, content: Buffer|null, mode: string}>>}
 */
async function buildPullRequestEntries(files, deps) {
	const entries = [];
	for (const file of files) {
		const mode = await fileModeForEntry(deps, file);
		if (!file.inWorkdir) {
			entries.push({ path: file.path, kind: 'delete', content: null, mode, baseBlobSha: blobSha(file.base) });
			continue;
		}
		if (!file.work) continue;

		const binary = isProbablyBinary(file.base) || isProbablyBinary(file.work);
		// Text goes up LF-normalised, exactly as the patch renders it; the
		// comparison happens on the same normalised bytes so a CRLF-only
		// difference is no difference. Binary is compared and carried raw.
		const base = binary || !file.base ? file.base : normalizeEolBuffer(file.base);
		const work = binary ? file.work : normalizeEolBuffer(file.work);
		if (base && base.equals(work)) continue;

		entries.push({
			path: file.path,
			kind: file.inHead ? 'modify' : 'add',
			content: work,
			mode,
			// What upstream had at the commit this checkout started from, which
			// is what the staleness check compares against.
			baseBlobSha: blobSha(file.base)
		});
	}
	return entries;
}

module.exports = {
	GIT_MODE_FILE,
	GIT_MODE_EXECUTABLE,
	isProbablyBinary,
	blobSha,
	modeInCommit,
	fileModeForEntry,
	buildPullRequestEntries
};
