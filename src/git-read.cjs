'use strict';

/**
 * Reads through the bundled Git (#384): every question the app asks a
 * repository without changing it, and the parser for each answer.
 *
 * Every command here asks for porcelain-stable output with the flag that pins
 * it (`--porcelain=v2`, `-z`, an explicit `--format`), and every parser is a
 * pure function over the bytes so it can be tested on fixture strings without
 * a repository. The shapes the read functions return are the ones the engine
 * before the binary returned, kept on purpose so the facades that call them
 * (trunk-update.js, ticket-branches.js, pr-files.cjs, main.js) keep their
 * signatures and the renderer never learned the engine changed.
 *
 * Status rows keep the `[path, head, workdir, stage]` shape documented in
 * git-update.cjs. The mapping from `status --porcelain=v2` is at
 * `rowFromStatusEntry`, with the two rows it cannot express exactly.
 */

const fs = require('node:fs');
const path = require('node:path');
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
 * Two rows are coarser than the vocabulary allows, both only reachable
 * through a user's own client: a file staged and then edited back to its HEAD
 * content is `workdir = 2` here, because Y reports it as modified against the
 * index and this parser does not hash to find out otherwise; and a path
 * removed from the index but kept on disk is one "different" row rather than
 * an identical one. Every consumer that acts on the file byte-compares
 * afterwards (isCrlfOnlyChange, classifyChangedFile), so only a count can
 * differ.
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
 * `git status --porcelain=v2 -z` → the paths of its unmerged (`u`) entries,
 * once each, in Git's order. Every other record is skipped whole: a `2`
 * entry still consumes its second field, so a stray rename cannot shift the
 * fields of what follows.
 *
 * @param {Buffer} buf
 * @return {string[]}
 */
function parseUnmergedZ(buf) {
	const paths = [];
	const fields = splitNul(buf);
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i].toString('utf8');
		if (entry[0] === '2') { i += 1; continue; }
		if (entry[0] !== 'u') continue;
		// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
		const filepath = entry.split(' ').slice(10).join(' ');
		if (!paths.includes(filepath)) paths.push(filepath);
	}
	return paths;
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
 * `git merge-tree --write-tree -z` output → the merged tree, the paths that
 * conflicted, and what kind of conflict each is. The first field is the
 * tree oid (written even when there are conflicts, with conflict markers
 * inside); then, only on a conflict, one field per conflicting index entry,
 * `<mode> <oid> <stage>\t<path>`, until an empty field closes that section.
 * The informational messages after it are for a human and never read.
 *
 * The stages are the kind (#351), the same way `git status` and every merge
 * tool read them: stage 1 is the base, 2 ours, 3 theirs. All three present
 * is a `content` clash; 2 and 3 with no base is `add/add`, both sides
 * created the path; a base with only one side left is `modify/delete`,
 * whichever side deleted. Those three are what a ticket and a moving trunk
 * produce, and what the refusal has words for; any other combination (a
 * rename tangle, a type change) keeps no kind and reads generically. Nothing
 * here depends on Git's wording: the record layout is the porcelain, and a
 * `--name-only` listing would have thrown the stages away.
 *
 * @param {Buffer} buf
 * @return {{tree: string, conflicts: string[], kinds: Object<string, string>}}
 */
function parseMergeTreeZ(buf) {
	const fields = splitNul(buf).map((field) => field.toString('utf8'));
	const tree = (fields[0] || '').trim();
	const conflicts = [];
	// No prototype: a conflicted path named `__proto__` is a path, not a
	// property, and `stages[p]` must not read Object.prototype for it.
	const stages = Object.create(null);
	for (let i = 1; i < fields.length; i++) {
		if (fields[i].length === 0) break;
		const tab = fields[i].indexOf('\t');
		if (tab === -1) continue;
		const stage = Number(fields[i].slice(0, tab).split(' ')[2]);
		const entryPath = fields[i].slice(tab + 1);
		if (!conflicts.includes(entryPath)) conflicts.push(entryPath);
		if (!stages[entryPath]) stages[entryPath] = new Set();
		stages[entryPath].add(stage);
	}
	// Built without a prototype for the same reason, then spread into a
	// plain object (the spread defines own properties, `__proto__` included).
	const kinds = Object.create(null);
	for (const p of conflicts) {
		const has = (...want) => want.every((stage) => stages[p].has(stage)) && stages[p].size === want.length;
		if (has(1, 2, 3)) kinds[p] = 'content';
		else if (has(2, 3)) kinds[p] = 'add/add';
		else if (has(1, 2) || has(1, 3)) kinds[p] = 'modify/delete';
	}
	return { tree, conflicts, kinds: { ...kinds } };
}

/**
 * The Windows-only `core.autocrlf` view, one `-c` per command, for the
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
 * Everything a command that walks the worktree needs on Windows for a site
 * the old engine made: the autocrlf view above, and `core.longpaths`, which
 * the clone writes into a site the binary made (git-clone.cjs) and nothing
 * wrote into the others. wordpress-develop has paths past MAX_PATH; the old
 * engine reached them through Node's long-path-aware `fs`, and the binary
 * refuses them with "Filename too long" unless told. Passed unconditionally
 * on Windows: a repeated value costs nothing and saves a second config read.
 * Off Windows both are empty.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]
 * @return {Promise<string[]>} Arguments to place before the subcommand.
 */
async function windowsArgs(dir, { platform = process.platform, run = runGit } = {}) {
	if (platform !== 'win32') return [];
	return [...await crlfArgs(dir, { platform, run }), '-c', 'core.longpaths=true'];
}

/**
 * Whether the old engine made this site (#385).
 *
 * Two shapes, told apart by what each clone wrote into the repository. The
 * bundled Git clones partial (`--filter=blob:none`, git-clone.cjs): the
 * remote carries `remote.origin.promisor` and the repository is never
 * shallow, because nothing the app runs afterwards passes `--depth` (the
 * trunk update fetches with no depth and no filter, trunk-update.js).
 * isomorphic-git cloned shallow: `.git/shallow` is there and
 * no promisor was ever written. The app stopped writing to those sites when
 * its writes moved to the binary, since the two engines disagree on what a
 * shallow checkout may do; the site card says so and offers a new site.
 *
 * `.git/shallow` is the first gate so the common cases, a site the binary
 * made or one adopted from a full clone, answer without spawning anything.
 * Known false positive: a shallow clone made outside the app and then
 * adopted, which the app never created and could not update either.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {Function} [options.run]
 * @return {Promise<boolean>}
 */
async function isLegacySite(dir, { run = runGit } = {}) {
	if (!fs.existsSync(path.join(dir, '.git', 'shallow'))) return false;
	const { status } = await run(['config', '--local', '--get', 'remote.origin.promisor'], { cwd: dir, okCodes: [0, 1] });
	return status === 1;
}

/**
 * What Git records under `.git` while an operation waits for a human, and
 * the kind each file stands for: the list `git status` itself reads. The
 * rebase directories are there as well as `REBASE_HEAD` because a rebase
 * stopped at an `edit` has the directory and no conflict to name.
 */
const IN_PROGRESS_MARKERS = [
	['merge', 'MERGE_HEAD'],
	['rebase', 'REBASE_HEAD'],
	['rebase', 'rebase-merge'],
	['rebase', 'rebase-apply'],
	['cherry-pick', 'CHERRY_PICK_HEAD'],
	['revert', 'REVERT_HEAD']
];

/**
 * Whether a merge, rebase, cherry-pick, revert or three-way apply started
 * outside the app is waiting in this checkout (#352), and on which paths.
 * Nothing the app runs leaves the index unmerged; a contributor's or a
 * mentor's own Git does, and every forced checkout the app's writes run
 * erases that state without a word. So the writes ask this first.
 *
 * Read from the repository each time, never remembered: the unmerged
 * entries from the same `status` line `statusRows` runs (untracked files
 * are not walked, they cannot be unmerged), and the head files Git keeps
 * while the operation is open. A head file with no unmerged path left is a
 * merge resolved in an editor and not yet committed, still in progress:
 * committing it as a WIP would lose the merge, a checkout would drop it.
 * Unmerged entries with no head file are what `git apply --3way` leaves.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]
 * @return {Promise<?{kind: string, paths: string[]}>} `kind` is `merge`,
 *   `rebase`, `cherry-pick`, `revert` or `apply`; null when nothing is open.
 */
async function mergeInProgress(dir, { platform = process.platform, run = runGit } = {}) {
	const win = await windowsArgs(dir, { platform, run });
	const { stdout } = await run([...win, 'status', '--porcelain=v2', '-z', '--untracked-files=no', '--no-renames'], { cwd: dir });
	const paths = parseUnmergedZ(stdout);
	const marker = IN_PROGRESS_MARKERS.find(([, name]) => fs.existsSync(path.join(dir, '.git', name)));
	if (!marker && paths.length === 0) return null;
	return { kind: marker ? marker[0] : 'apply', paths };
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
 * The URL a remote points at, or null when the repository has no such
 * remote. What the trunk update fetches from is the checkout's own
 * `origin`, so a site adopted from disk without one is told before the
 * fetch runs rather than by Git's stderr.
 *
 * @param {string}   dir
 * @param {string}   remote
 * @param {Object}   [options]
 * @param {Function} [options.run]
 * @return {Promise<?string>}
 */
async function remoteUrl(dir, remote, { run = runGit } = {}) {
	const { status, stdout } = await run(['config', '--local', '--get', `remote.${remote}.url`], { cwd: dir, okCodes: [0, 1] });
	return status === 0 ? stdout.toString('utf8').trim() : null;
}

/**
 * Whether `ancestor` is reachable from `descendant`: `merge-base
 * --is-ancestor` answers with exit 0 or 1 and prints nothing. An oid Git
 * does not have is a fatal (128) and rejects; the caller decides whether an
 * unknown commit means "no".
 *
 * @param {string}   dir
 * @param {string}   ancestor
 * @param {string}   descendant
 * @param {Object}   [options]
 * @param {Function} [options.run]
 * @return {Promise<boolean>}
 */
async function isAncestor(dir, ancestor, descendant, { run = runGit } = {}) {
	const { status } = await run(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: dir, okCodes: [0, 1] });
	return status === 0;
}

/**
 * A three-way merge of `theirs` onto `ours` from `base`, as a tree object
 * (#385): what replaying a ticket's single WIP commit onto a moved trunk
 * needs. `merge-tree --write-tree` writes objects and nothing else, no ref,
 * no index, no file, so it sits with the reads; the tree it returns is
 * unreachable until a caller commits it. Exit 1 means the merge has
 * conflicts, and `conflicts` names the paths; the tree then carries markers
 * and is not something the app writes anywhere. An oid Git does not have is
 * a fatal and rejects.
 *
 * @param {string}   dir
 * @param {Object}   root0
 * @param {string}   root0.base
 * @param {string}   root0.ours
 * @param {string}   root0.theirs
 * @param {Object}   [options]
 * @param {Function} [options.run]
 * @return {Promise<{tree: string, conflicted: boolean, conflicts: string[], kinds: Object<string, string>}>}
 */
async function mergeTree(dir, { base, ours, theirs }, { run = runGit } = {}) {
	// No lazy fetch: on a partial clone a blob none of the three sides has
	// checked out would be pulled from the promisor mid-merge, with no
	// timeout to bound it. Refusing with Git's reason beats waiting on a
	// network the contributor may not have.
	const { status, stdout } = await run(['merge-tree', '--write-tree', '-z', `--merge-base=${base}`, ours, theirs], { cwd: dir, okCodes: [0, 1], extraEnv: { GIT_NO_LAZY_FETCH: '1' } });
	const parsed = parseMergeTreeZ(stdout);
	// The exit code is the answer; the paths are the detail. A conflict Git
	// reports in a shape the parser does not read is still a conflict.
	return { tree: parsed.tree, conflicted: status === 1, conflicts: status === 1 ? parsed.conflicts : [], kinds: status === 1 ? parsed.kinds : {} };
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
	const crlf = await windowsArgs(dir, { platform, run });
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
	const crlf = await windowsArgs(dir, { platform, run });
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
	parseUnmergedZ,
	parseNameStatusZ,
	parseZList,
	parseCatFileBatch,
	parseCatFileBatchCheck,
	parseLsTreeZ,
	parseMergeTreeZ,
	crlfArgs,
	windowsArgs,
	isLegacySite,
	mergeInProgress,
	resolveRef,
	isAncestor,
	mergeTree,
	remoteUrl,
	readCommitInfo,
	currentBranch,
	listBranches,
	statusRows,
	changesAgainst,
	readBlobs,
	blobOid,
	treeEntryMode
};
