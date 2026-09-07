'use strict';

/**
 * Reads through the bundled Git (#384): every question the app asks a
 * repository without changing it, and the parser for each answer.
 *
 * Every command here asks for porcelain-stable output with the flag that pins
 * it (`--porcelain=v2`, `-z`, an explicit `--format`), and every parser is a
 * pure function over the bytes so it can be tested on fixture strings without
 * a repository. The read functions return the same shapes the isomorphic-git
 * calls they replace returned, so the facades that call them
 * (trunk-update.js, ticket-branches.js, pr-files.cjs, main.js) keep their
 * signatures and the renderer does not know the engine changed.
 *
 * Status rows keep the `[path, head, workdir, stage]` shape documented in
 * git-update.cjs. The mapping from `status --porcelain=v2` is at
 * `rowFromStatusEntry`; the one known divergence from isomorphic-git is
 * described there.
 */

const { runGit } = require('./git-run.cjs');

const NUL = 0;

/**
 * NUL-separated fields, as Buffers. A trailing NUL terminates the last field
 * rather than opening an empty one.
 *
 * @param {Buffer} buf
 * @return {Buffer[]}
 */
function splitNul(buf) {
	const fields = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === NUL) {
			fields.push(buf.subarray(start, i));
			start = i + 1;
		}
	}
	if (start < buf.length) fields.push(buf.subarray(start));
	return fields;
}

/**
 * The row `status --porcelain=v2` describes, in statusMatrix's vocabulary.
 * X is index against HEAD, Y is worktree against index; `.` means unchanged.
 *
 *   head    0 absent from HEAD, 1 present
 *   workdir 0 absent from disk, 1 identical to HEAD, 2 different
 *   stage   0 absent from index, 1 identical to HEAD, 2 staged change,
 *           3 staged change with further unstaged edits
 *
 * Known divergences, both only reachable through a user's own client: a file
 * staged and then edited back to its HEAD content is `workdir = 2` here (Y
 * reports it as modified against the index) where isomorphic-git, which
 * hashes, said 1; and a path removed from the index but kept on disk is one
 * "different" row here where isomorphic-git said identical. Every consumer
 * that acts on the file byte-compares afterwards (isCrlfOnlyChange,
 * classifyChangedFile), so only a count can differ.
 *
 * @param {string} xy
 * @param {string} filepath
 * @return {Array}
 */
function rowFromStatusEntry(xy, filepath) {
	const x = xy[0];
	const y = xy[1];
	// `A` in either column is a path HEAD does not have: staged as new (`A.`)
	// or intent-to-add (`.A`). `D.` is a deletion already staged, so the file
	// is gone from disk as well as from the index.
	const head = x === 'A' || y === 'A' ? 0 : 1;
	let workdir;
	if (y === 'D' || (x === 'D' && y === '.')) workdir = 0;
	else if (x === '.' && y === '.') workdir = 1;
	else workdir = 2;
	let stage;
	if (x === '.') stage = head;
	else if (x === 'D') stage = 0;
	else if (y === '.') stage = 2;
	else stage = 3;
	return [filepath, head, workdir, stage];
}

/**
 * `git status --porcelain=v2 -z` → status rows. Ignored entries (`!`) are not
 * requested; untracked (`?`) become `[path, 0, 2, 0]`; unmerged (`u`) are
 * reported as dirty on every axis, which is the conservative reading for an
 * app that never merges. Renames are not requested either (`--no-renames`),
 * but a `2` entry is still consumed whole, both of its paths, so a stray one
 * cannot shift every field after it.
 *
 * @param {Buffer} buf
 * @return {Array[]}
 */
function parseStatusV2Z(buf) {
	const rows = [];
	const fields = splitNul(buf);
	// A path removed from the index but still on disk (`git rm --cached`)
	// comes back twice, as `1 D.` and again as `?`. One row, "present and
	// different": the byte compare downstream settles whether it really is.
	const merge = (row) => {
		const index = rows.findIndex(([filepath]) => filepath === row[0]);
		if (index === -1) rows.push(row);
		else rows[index] = [row[0], 1, 2, 0];
	};
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i].toString('utf8');
		const kind = entry[0];
		if (kind === '?') {
			merge([entry.slice(2), 0, 2, 0]);
		} else if (kind === '1') {
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			const parts = entry.split(' ');
			merge(rowFromStatusEntry(parts[1], parts.slice(8).join(' ')));
		} else if (kind === '2') {
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>, then <origPath>
			const parts = entry.split(' ');
			rows.push(rowFromStatusEntry(parts[1], parts.slice(9).join(' ')));
			i += 1;
		} else if (kind === 'u') {
			// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
			const parts = entry.split(' ');
			rows.push([parts.slice(10).join(' '), 1, 2, 3]);
		}
		// '!' (ignored) and '#' (headers) are never requested; skip anything else.
	}
	return rows;
}

/**
 * `git diff --name-status -z --no-renames <commit>` → status rows against
 * that commit, index column 0 because the index is not what was compared.
 * Statuses: A added, M modified, T type change, D deleted. Untracked files
 * are not in a diff; `parseZList` on `ls-files --others` supplies them.
 *
 * @param {Buffer} buf
 * @return {Array[]}
 */
function parseNameStatusZ(buf) {
	const rows = [];
	const fields = splitNul(buf);
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const status = fields[i].toString('utf8')[0];
		const filepath = fields[i + 1].toString('utf8');
		if (status === 'A') rows.push([filepath, 0, 2, 0]);
		else if (status === 'D') rows.push([filepath, 1, 0, 0]);
		else rows.push([filepath, 1, 2, 0]);
	}
	return rows;
}

/**
 * A `-z` list of paths (`ls-files -z`, `for-each-ref` with `%00`).
 *
 * @param {Buffer} buf
 * @return {string[]}
 */
function parseZList(buf) {
	return splitNul(buf).map((field) => field.toString('utf8')).filter((s) => s.length > 0);
}

/**
 * `git cat-file --batch` output, in request order → the object bytes per
 * request, or null where Git answered `missing`. Paths are decoded as UTF-8
 * here and everywhere below; a path that is not valid UTF-8 would round-trip
 * wrongly, and wordpress-develop has none. Requests are `<oid>:<path>`
 * strings; the caller supplies them in the same order it wrote them to stdin.
 *
 * Each answer is a header line `<sha> <type> <size>\n`, then `size` bytes,
 * then a newline; or `<request> missing\n`.
 *
 * @param {Buffer}   buf
 * @param {string[]} requests
 * @return {Map<string, Buffer|null>}
 */
function parseCatFileBatch(buf, requests) {
	const answers = new Map();
	let pos = 0;
	for (const request of requests) {
		const nl = buf.indexOf(10, pos);
		if (nl === -1) break;
		const header = buf.subarray(pos, nl).toString('utf8');
		pos = nl + 1;
		if (header.endsWith(' missing')) {
			answers.set(request, null);
			continue;
		}
		const size = Number(header.split(' ')[2]);
		// A `missing` echo of a path containing a newline does not end with
		// " missing" on its first line; every offset after it would be wrong,
		// so stop here and let the remaining requests read as absent.
		if (!Number.isFinite(size)) break;
		answers.set(request, Buffer.from(buf.subarray(pos, pos + size)));
		pos += size + 1;
	}
	return answers;
}

/**
 * `git cat-file --batch-check` output → the object id per request, or null.
 *
 * @param {Buffer}   buf
 * @param {string[]} requests
 * @return {Map<string, string|null>}
 */
function parseCatFileBatchCheck(buf, requests) {
	const answers = new Map();
	const lines = buf.toString('utf8').split('\n');
	requests.forEach((request, i) => {
		const line = lines[i] || '';
		answers.set(request, line.endsWith(' missing') || !line ? null : line.split(' ')[0]);
	});
	return answers;
}

/**
 * `git ls-tree -z <tree-ish> -- <path>` → the entry, or null when the path is
 * not in that tree. Format: `<mode> <type> <oid>\t<path>`.
 *
 * @param {Buffer} buf
 * @return {?{mode: string, type: string, oid: string, path: string}}
 */
function parseLsTreeZ(buf) {
	const first = splitNul(buf)[0];
	if (!first || first.length === 0) return null;
	const text = first.toString('utf8');
	const tab = text.indexOf('\t');
	if (tab === -1) return null;
	const [mode, type, oid] = text.slice(0, tab).split(' ');
	return { mode, type, oid, path: text.slice(tab + 1) };
}

/**
 * The Windows-only view createCrlfCompatibleFs gives isomorphic-git, for the
 * binary: a site checked out by a host Git with a global `autocrlf = true`
 * sits on disk as CRLF, its repository config says nothing, and the app's Git
 * reads no global config (git-binary.cjs). Without this, `status` reports
 * every text file. An explicit local value passes through untouched (#341).
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]
 * @return {Promise<string[]>} Arguments to place before the subcommand.
 */
async function crlfArgs(dir, { platform = process.platform, run = runGit } = {}) {
	if (platform !== 'win32') return [];
	const { status } = await run(['config', '--local', '--get', 'core.autocrlf'], { cwd: dir, okCodes: [0, 1] });
	return status === 1 ? ['-c', 'core.autocrlf=true'] : [];
}

/**
 * The commit a ref points at, or null when it does not resolve.
 *
 * @param {string} dir
 * @param {string} ref
 * @return {Promise<?string>}
 */
async function resolveRef(dir, ref) {
	const { status, stdout } = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir, okCodes: [0, 1] });
	return status === 0 ? stdout.toString('utf8').trim() : null;
}

/**
 * A commit's id and committer date, as the ISO string the app has always
 * stored. `%ct` is the epoch second, so the string is UTC regardless of the
 * committer's own offset, which is what `%cI` would have carried.
 *
 * @param {string} dir
 * @param {string} ref
 * @return {Promise<{oid: string, date: string}>} Throws when the ref is missing.
 */
async function readCommitInfo(dir, ref) {
	const { stdout } = await runGit(['log', '-1', '--format=%H%x00%ct', ref, '--'], { cwd: dir });
	const [oid, seconds] = stdout.toString('utf8').trim().split('\0');
	return { oid, date: new Date(Number(seconds) * 1000).toISOString() };
}

/**
 * The checked-out branch, or null when HEAD is detached. `symbolic-ref
 * --quiet` answers a detached HEAD with exit 1; `rev-parse --abbrev-ref`
 * would print the literal `HEAD` instead, and `--short` abbreviates against
 * tags, so the prefix is stripped here.
 *
 * @param {string} dir
 * @return {Promise<?string>}
 */
async function currentBranch(dir) {
	const { status, stdout } = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: dir, okCodes: [0, 1] });
	if (status !== 0) return null;
	return stdout.toString('utf8').trim().replace(/^refs\/heads\//, '');
}

/**
 * Every local branch name. Ref names cannot contain a newline (or a space, or
 * control characters: `git check-ref-format`), so the default one-per-line
 * output is already unambiguous.
 *
 * @param {string} dir
 * @return {Promise<string[]>}
 */
async function listBranches(dir) {
	const { stdout } = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd: dir });
	return stdout.toString('utf8').split('\n').filter((line) => line.length > 0).map((ref) => ref.replace(/^refs\/heads\//, ''));
}

/**
 * The worktree against HEAD, every non-ignored file, in status rows. This is
 * the scan every park and every dirty check runs.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]      Injection point for tests.
 * @return {Promise<Array[]>}
 */
async function statusRows(dir, { platform = process.platform, run = runGit } = {}) {
	const crlf = await crlfArgs(dir, { platform, run });
	const { stdout } = await run([...crlf, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'], { cwd: dir });
	return parseStatusV2Z(stdout);
}

/**
 * The worktree against an arbitrary commit (a ticket's branch point, which is
 * not HEAD once work is parked), in status rows with the index column 0.
 * `git diff <commit>` compares by content, so a file whose stat data is stale
 * is hashed rather than reported; untracked files come from `ls-files`.
 *
 * @param {string}   dir
 * @param {string}   ref
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]      Injection point for tests.
 * @return {Promise<Array[]>}
 */
async function changesAgainst(dir, ref, { platform = process.platform, run = runGit } = {}) {
	const crlf = await crlfArgs(dir, { platform, run });
	const diff = await run([...crlf, 'diff', '--name-status', '-z', '--no-renames', ref, '--'], { cwd: dir });
	const others = await run([...crlf, 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: dir });
	const rows = parseNameStatusZ(diff.stdout);
	const byPath = new Map(rows.map((row, index) => [row[0], index]));
	for (const filepath of parseZList(others.stdout)) {
		const index = byPath.get(filepath);
		if (index === undefined) {
			byPath.set(filepath, rows.length);
			rows.push([filepath, 0, 2, 0]);
		} else if (rows[index][2] === 0) {
			// The diff called it deleted because it left the index (`git rm
			// --cached`), but the file is on disk. Reporting a deletion here is
			// how a patch would delete a file the contributor still has (#85).
			rows[index] = [filepath, 1, 2, 0];
		}
	}
	return rows;
}

/**
 * The bytes of several paths at one commit, in a single spawn. Raw object
 * content: no line-ending conversion, exactly what `readBlob` returned.
 *
 * @param {string}   dir
 * @param {string}   oid
 * @param {string[]} filepaths
 * @return {Promise<Map<string, Buffer|null>>} Keyed by path; null when absent.
 */
async function readBlobs(dir, oid, filepaths) {
	if (filepaths.length === 0) return new Map();
	const requests = filepaths.map((filepath) => `${oid}:${filepath}`);
	const { stdout } = await runGit(['cat-file', '--batch', '-z'], { cwd: dir, input: `${requests.join('\0')}\0` });
	const byRequest = parseCatFileBatch(stdout, requests);
	return new Map(filepaths.map((filepath, i) => [filepath, byRequest.get(requests[i]) ?? null]));
}

/**
 * The blob id of one path at one commit, or null when absent.
 *
 * @param {string} dir
 * @param {string} oid
 * @param {string} filepath
 * @return {Promise<?string>}
 */
async function blobOid(dir, oid, filepath) {
	const request = `${oid}:${filepath}`;
	const { stdout } = await runGit(['cat-file', '--batch-check', '-z'], { cwd: dir, input: `${request}\0` });
	return parseCatFileBatchCheck(stdout, [request]).get(request);
}

/**
 * The mode a tree records for one path, or null when the path is not there.
 * One `ls-tree` on the path rather than a walk of the whole commit.
 *
 * @param {string} dir
 * @param {string} oid
 * @param {string} filepath
 * @return {Promise<?string>}
 */
async function treeEntryMode(dir, oid, filepath) {
	const { stdout } = await runGit(['ls-tree', '-z', oid, '--', filepath], { cwd: dir });
	const entry = parseLsTreeZ(stdout);
	return entry ? entry.mode : null;
}

module.exports = {
	splitNul,
	rowFromStatusEntry,
	parseStatusV2Z,
	parseNameStatusZ,
	parseZList,
	parseCatFileBatch,
	parseCatFileBatchCheck,
	parseLsTreeZ,
	crlfArgs,
	resolveRef,
	readCommitInfo,
	currentBranch,
	listBranches,
	statusRows,
	changesAgainst,
	readBlobs,
	blobOid,
	treeEntryMode
};
