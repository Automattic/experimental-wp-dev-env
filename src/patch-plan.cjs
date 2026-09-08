'use strict';

/**
 * Reading a patch before applying it (issue #11): what files it touches, where
 * those files live in today's checkout, and what applying it would disturb.
 *
 * Patches reach the app from three places that do not agree on a format:
 * attachments on a Trac ticket (Subversion style, no `a/` `b/` prefixes, paths
 * sometimes against the pre-`src/` layout), `.diff` files from a
 * wordpress-develop pull request (git style, `a/` `b/` prefixes), and the app's
 * own generated patches (`createTwoFilesPatch` output, `a/` `b/` prefixes but
 * no `diff --git` line). Everything downstream works in repo-relative paths, so
 * normalising happens here, once.
 *
 * Lives at `src/` rather than `src/renderer/` because both the main process and
 * the applier consume it — same placement as git-update.cjs — and it keeps the
 * `diff` package out of the renderer bundle. The renderer-facing half of this
 * feature (the step chain) is in renderer/update-plan.cjs instead.
 */

const JsDiff = require('diff');
const { normalizeEol } = require('./git-update.cjs');

// Files that stayed at the repo root when core moved everything else under
// src/. A patch naming one of these is already correct for today's layout.
const ROOT_FILES = [
	'.editorconfig',
	'.gitignore',
	'.jshintrc',
	'.travis.yml',
	'Gruntfile.js',
	'package.json',
	'phpunit.xml.dist',
	'wp-cli.yml',
	'wp-config-sample.php',
	'wp-tests-config-sample.php'
];

// Files that did move under src/ despite not being wp-* prefixed, so the
// wp-* rule below would miss them.
const SRC_FILES = ['index.php', 'license.txt', 'readme.html', 'xmlrpc.php'];

// Directories that only ever existed in the modern layout.
const MODERN_DIRS = ['src/', 'tests/', 'tools/'];

/**
 * Strips the leading `a/` and `b/` that git puts on diff headers.
 *
 * Deliberately conditional: Subversion-style patches from Trac carry no prefix
 * at all, so stripping unconditionally would turn `wp-admin/admin.php` into
 * `admin.php` and write to the wrong place. Both sides have to look prefixed
 * before either is trusted — `/dev/null` counts as agreement, since an added or
 * deleted file only has one real side.
 *
 * @param {string} oldName
 * @param {string} newName
 * @return {{oldPath: string, newPath: string}}
 */
function stripPathPrefix(oldName, newName) {
	const isNull = (name) => name === '/dev/null';
	const looksPrefixed = (name, letter) => isNull(name) || new RegExp(`^${letter}/`).test(name);
	const bothPrefixed = looksPrefixed(oldName, 'a') && looksPrefixed(newName, 'b');
	const drop = (name) => (isNull(name) || !bothPrefixed ? name : name.slice(2));
	// `Index: trunk/wp-…` is what an older Subversion checkout produced; the
	// branch name is not part of the repo-relative path either way.
	const dropTrunk = (name) => (isNull(name) ? name : name.replace(/^trunk\//, ''));
	return { oldPath: dropTrunk(drop(oldName)), newPath: dropTrunk(drop(newName)) };
}

/**
 * Rewrites a path written against the pre-src/ layout to where that file lives
 * today. A patch attached to a ticket years ago still names `wp-admin/…`.
 *
 * @param {string} filePath
 * @return {string}
 */
function mapToSrcLayout(filePath) {
	if (!filePath || filePath === '/dev/null') return filePath;
	if (MODERN_DIRS.some((dir) => filePath.startsWith(dir))) return filePath;
	if (ROOT_FILES.includes(filePath)) return filePath;
	if (SRC_FILES.includes(filePath)) return `src/${filePath}`;
	if (filePath.startsWith('wp-')) return `src/${filePath}`;
	// Unrecognised: leave it alone rather than guess a move that would write
	// outside the tree the contributor expects.
	return filePath;
}

/**
 * The raw patch cut into its per-file sections, each with its own text, so
 * one file can be checked on its own (`git apply --check` on a section) and
 * a binary section with no data can be left out of what Git is handed.
 *
 * A section starts at a `diff --git` or `Index:` line, or, for a patch with
 * neither (this app's own output, a hand-written minimal patch), at its
 * `---` line. Text before the first section (a Trac comment, this app's
 * "files not in this patch" block) belongs to no section and is dropped: it
 * is prose, and `git apply` ignores it too.
 *
 * `path` is the file the section ends on; `from` the one it starts from
 * (the same file for a modify, the source of a rename, empty for an add).
 *
 * @param {string} text EOL-normalised patch text.
 * @return {Array<{path: string, from: string, text: string, isBinary: boolean, hasBinaryData: boolean}>}
 */
function splitPatchSections(text) {
	const lines = text.split('\n');
	// A text that ends in a newline splits into a trailing empty string that
	// is not a line; every real line, an empty one included, gets its newline
	// back below.
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	const sections = [];
	let current = null;
	const startsSection = (line, i) => {
		if (line.startsWith('diff --git ') || line.startsWith('Index: ')) return true;
		// A bare `---` opens a section only when the previous line did not
		// (a `diff --git` section has its own `---` inside).
		if (line.startsWith('--- ') && lines[i + 1] && lines[i + 1].startsWith('+++ ')) {
			return !current || current.sawHeader;
		}
		return false;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (startsSection(line, i)) {
			current = { path: '', from: '', lines: [], isBinary: false, hasBinaryData: false, sawHeader: false };
			sections.push(current);
			const git = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/.exec(line);
			const svn = /^Index: (.+)$/.exec(line);
			if (git) { current.from = git[1]; current.path = git[2] || git[1]; }
			else if (svn) { current.path = svn[1].trim(); current.from = current.path; }
			else { current.from = line.slice(4).replace(/^[ab]\//, '').replace(/\t.*$/, ''); current.path = current.from; }
		}
		if (!current) continue;
		current.lines.push(line);
		const named = (l) => l.slice(4).replace(/\t.*$/, '');
		if (line.startsWith('+++ ')) {
			current.sawHeader = true;
			const to = named(line);
			current.path = to === '/dev/null' ? current.path : to.replace(/^[ab]\//, '');
		} else if (line.startsWith('--- ') && !current.sawHeader) {
			const from = named(line);
			current.from = from === '/dev/null' ? '' : from.replace(/^[ab]\//, '');
			if (!current.path) current.path = current.from;
		}
		const renameFrom = /^rename from (.+)$/.exec(line);
		if (renameFrom) current.from = renameFrom[1].trim();
		const renameTo = /^rename to (.+)$/.exec(line);
		if (renameTo) current.path = renameTo[1].trim();
		if (/^Binary files .* differ$/.test(line)) current.isBinary = true;
		if (/^GIT binary patch$/.test(line)) { current.isBinary = true; current.hasBinaryData = true; }
	}
	const clean = (p) => (p === '/dev/null' ? '' : p);
	return sections.map(({ path: sectionPath, from, lines: sectionLines, isBinary, hasBinaryData }) => ({
		path: clean(sectionPath),
		from: clean(from),
		text: `${sectionLines.join('\n')}\n`,
		isBinary,
		hasBinaryData
	}));
}

// The header lines that carry a path, and how the path sits in each.
const PATH_LINES = [
	[/^(--- )(.+)$/, 'a'],
	[/^(\+\+\+ )(.+)$/, 'b'],
	[/^(rename from )(.+)$/, ''],
	[/^(rename to )(.+)$/, ''],
	[/^(copy from )(.+)$/, ''],
	[/^(copy to )(.+)$/, '']
];

/**
 * The patch with every path rewritten to where the file lives today, in the
 * `a/`/`b/` form `git apply -p1` reads (#385). The same rules
 * `parsePatchFiles` applies (`stripPathPrefix`, `mapToSrcLayout`), applied to
 * the text instead of to the parsed result, so what Git is handed names the
 * same files the preview showed. Everything that is not a path header,
 * binary data included, passes through byte for byte. A `--- ` line inside
 * a hunk is a context line whose content starts with `-- `, not a header;
 * the one that opens a file always has `+++ ` on the next line.
 *
 * Quoted paths (Git's C-style escapes for unusual characters) are refused
 * with the sentence the empty-file reader already uses: decoding them is
 * outside the narrow reader (#316), and a path Git would read differently
 * from the preview is worse than a refusal.
 *
 * @param {string} text EOL-normalised patch text.
 * @return {string}
 */
function rewritePatchPaths(text) {
	const lines = text.split('\n');
	const out = [];
	const rewrite = (raw, letter) => {
		// jsdiff and Subversion put a tab and a note after the name
		// (`\t(revision 59234)`, or a bare tab); the name ends at the tab.
		const stripped = raw.replace(/\t.*$/, '');
		if (stripped === '/dev/null') return stripped;
		if (stripped.startsWith('"')) throw new Error('The empty file path is quoted or ambiguous.');
		const { newPath } = stripPathPrefix(`a/${stripped.replace(/^[ab]\//, '')}`, `b/${stripped.replace(/^[ab]\//, '')}`);
		const mapped = mapToSrcLayout(newPath);
		return letter ? `${letter}/${mapped}` : mapped;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const git = /^diff --git (.+)$/.exec(line);
		if (git) {
			const rest = git[1];
			if (rest.startsWith('"')) throw new Error('The empty file path is quoted or ambiguous.');
			let sides = null;
			// The one unambiguous split of `a/X b/Y`: when both sides are
			// the same path (an add, a delete, a modify) the length fixes
			// it; otherwise the first ` b/` after `a/` is the seam, which
			// is right for every path without ` b/` inside it.
			const same = samePathFromGitDiffLine(line);
			if (same) sides = [same, same];
			else {
				const seam = rest.indexOf(' b/');
				if (rest.startsWith('a/') && seam > 2) sides = [rest.slice(2, seam), rest.slice(seam + 3)];
			}
			if (sides) out.push(`diff --git a/${mapToSrcLayout(sides[0].replace(/^trunk\//, ''))} b/${mapToSrcLayout(sides[1].replace(/^trunk\//, ''))}`);
			else out.push(line);
			continue;
		}
		const svn = /^Index: (.+)$/.exec(line);
		if (svn) {
			out.push(`Index: ${mapToSrcLayout(svn[1].trim().replace(/^trunk\//, ''))}`);
			continue;
		}
		let done = false;
		for (const [pattern, letter] of PATH_LINES) {
			const m = pattern.exec(line);
			if (!m) continue;
			// `--- ` is a header only when `+++ ` follows; `+++ ` only when
			// `--- ` preceded. Anything else is hunk content.
			if (letter === 'a' && !(lines[i + 1] || '').startsWith('+++ ')) break;
			if (letter === 'b' && !(lines[i - 1] || '').startsWith('--- ')) break;
			out.push(`${m[1]}${rewrite(m[2], letter)}`);
			done = true;
			break;
		}
		if (!done) out.push(line);
	}
	return out.join('\n');
}

/**
 * The one path named by a `diff --git a/<path> b/<path>` line whose two sides
 * are the same file — the only shape an added or deleted file can have.
 *
 * The line has no delimiter, so a path containing a space makes it ambiguous in
 * general (`git apply` itself refuses such a line without `---`/`+++` to cross-
 * check). But when both sides are the same path — and for an add or a delete
 * they always are — the split is fixed by the line's length, so even
 * `a/new file.php b/new file.php` reads back exactly. Git quotes a path only
 * for characters beyond plain spaces; the quoted form carries C-style escapes,
 * so it is left unparsed rather than guessed at.
 *
 * @param {string} line A `diff --git ` line.
 * @return {string|null} The repo-relative path, or null when it cannot be read
 *                       with certainty.
 */
function samePathFromGitDiffLine(line) {
	const rest = line.slice('diff --git '.length);
	if (!rest.startsWith('a/')) return null;
	const length = (rest.length - 5) / 2;
	if (!Number.isInteger(length) || length < 1) return null;
	const filePath = rest.slice(2, 2 + length);
	if (rest.slice(2 + length, 5 + length) !== ' b/' || rest.slice(5 + length) !== filePath) return null;
	return filePath;
}

/**
 * Rewrites the sections real git emits for an empty file added or deleted into
 * the shape the rest of this parser already reads (#311).
 *
 * An empty file has no line to diff, so git writes its section as headers
 * alone and — unlike this app's own generator — omits the `---`/`+++` pair
 * entirely; the file's fate is carried by `new file mode` / `deleted file
 * mode`. jsdiff cannot see those: such a section comes back as `{hunks: []}`
 * with no filenames when it is last in the patch, and is silently swallowed
 * when another section follows it. Either way one empty file used to take the
 * whole patch down (or vanish from it) — every unrelated file included.
 *
 * Supplying the pair git left out, before jsdiff parses, is the whole fix: the
 * section then parses like the app's own empty-file sections, and everything
 * downstream — classification, layout mapping, `planApply`, the applier and
 * its guards — treats both origins identically because they are identical.
 *
 * Deliberately narrow: a section is only rewritten when it carries a
 * new/deleted file mode line, has no `---`/`+++`/hunk of its own, is not
 * binary and not a rename, and its `diff --git` line names one unambiguous
 * path. Anything else is left byte-for-byte alone.
 *
 * @param {string} text EOL-normalised patch text.
 * @return {string}
 */
function supplyEmptyFileHeaders(text) {
	const lines = text.split('\n');
	const out = [];
	let i = 0;
	while (i < lines.length) {
		out.push(lines[i]);
		if (!lines[i].startsWith('diff --git ')) { i++; continue; }
		let mode = '';
		let opaque = false;
		let end = i + 1;
		while (end < lines.length && !lines[end].startsWith('diff --git ') && !lines[end].startsWith('Index: ')) {
			const line = lines[end];
			if (/^new file mode /.test(line)) mode = 'add';
			else if (/^deleted file mode /.test(line)) mode = 'delete';
			else if (/^(--- |\+\+\+ |@@ |GIT binary patch|rename (?:from|to) )/.test(line) || /^Binary files .* differ$/.test(line)) opaque = true;
			end++;
		}
		const section = lines.slice(i + 1, end);
		// The injected pair goes at the section's end, where git itself puts
		// it — but ahead of any trailing blank line, which jsdiff would read
		// as a phantom context line.
		let tail = section.length;
		while (tail > 0 && section[tail - 1] === '') tail--;
		out.push(...section.slice(0, tail));
		const filePath = mode && !opaque ? samePathFromGitDiffLine(lines[i]) : null;
		// jsdiff can silently omit a mode-only section it cannot name when a
		// normal section follows. Refuse the whole patch instead of reporting a
		// partial success. Decoding Git's quoted C-style paths is deliberately
		// outside the narrow 1.0 reader (#316).
		if (mode && !opaque && !filePath) {
			throw new Error('The empty file path is quoted or ambiguous.');
		}
		if (filePath) {
			out.push(
				mode === 'add' ? '--- /dev/null' : `--- a/${filePath}`,
				mode === 'add' ? `+++ b/${filePath}` : '+++ /dev/null'
			);
		}
		out.push(...section.slice(tail));
		i = end;
	}
	return out.join('\n');
}

/**
 * @param {Object} file    A jsdiff parsePatch entry.
 * @param {string} oldPath
 * @param {string} newPath
 * @return {string}
 */
function classify(file, oldPath, newPath) {
	if (oldPath === '/dev/null') return 'add';
	if (newPath === '/dev/null') return 'delete';
	if (oldPath !== newPath) return 'rename';
	return 'modify';
}

/**
 * Parses a patch into the files it touches, with paths normalised to
 * repo-relative form for today's layout.
 *
 * @param {string} text
 * @return {{ok: true, files: Array}|{ok: false, error: string}}
 */
function parsePatchFiles(text) {
	const raw = typeof text === 'string' ? text : '';
	if (!raw.trim()) return { ok: false, error: 'The patch is empty.' };

	// Normalise line endings on the way in so hunk context matches what the
	// applier reads off disk, which is normalised the same way.
	const normalized = normalizeEol(raw);

	// One section at a time. jsdiff swallows a section with no hunks (a
	// binary, a pure rename, an empty file) whenever another section follows
	// it, so parsing the whole text would drop files; cut first, parse each,
	// and the file list is the section list.
	const sections = splitPatchSections(normalized);
	if (!sections.length) return { ok: false, error: 'No file changes found in the patch.' };

	const files = [];
	for (const section of sections) {
		if (section.isBinary) {
			const binaryPath = mapToSrcLayout(stripPathPrefix(section.path, section.path).newPath);
			files.push({ kind: 'binary', oldPath: binaryPath, newPath: binaryPath, path: binaryPath, hunks: [], patch: { hunks: [] }, hasBinaryData: section.hasBinaryData });
			continue;
		}
		let parsed;
		try {
			// Real git carries an empty file added or deleted as headers alone,
			// with no `---`/`+++` pair for jsdiff to read (#311) — supplying it
			// here is what lets this section be seen at all.
			parsed = JsDiff.parsePatch(supplyEmptyFileHeaders(section.text));
		} catch (e) {
			return { ok: false, error: `Could not read the patch: ${String(e && e.message ? e.message : e)}` };
		}
		const file = parsed && parsed[0];
		if (!file) return { ok: false, error: 'No file changes found in the patch.' };

		if (!file.hunks || file.hunks.length === 0) {
			// An empty file added or deleted has no line on either side, so its
			// section is headers alone (#311). `/dev/null` still says which of
			// the two it was — the same rule classify() applies to a hunked
			// section.
			if (file.oldFileName === '/dev/null' || file.newFileName === '/dev/null') {
				const empty = stripPathPrefix(file.oldFileName || '', file.newFileName || '');
				const emptyKind = classify(file, empty.oldPath, empty.newPath);
				const emptyTarget = emptyKind === 'delete' ? empty.oldPath : empty.newPath;
				files.push({
					kind: emptyKind,
					oldPath: mapToSrcLayout(empty.oldPath),
					newPath: mapToSrcLayout(empty.newPath),
					path: mapToSrcLayout(emptyTarget),
					hunks: [],
					patch: file
				});
				continue;
			}
			// jsdiff kept nothing, so the section's own headers are the only
			// evidence of what this was: a pure rename names two files.
			if (section.from && section.path && section.from !== section.path) {
				const oldPath = mapToSrcLayout(section.from);
				const newPath = mapToSrcLayout(section.path);
				files.push({ kind: 'rename', oldPath, newPath, path: newPath, hunks: [], patch: file });
				continue;
			}
			return { ok: false, error: 'That does not look like a patch — no file changes found.' };
		}

		const oldName = file.oldFileName || file.index || '';
		const newName = file.newFileName || file.index || '';
		const { oldPath, newPath } = stripPathPrefix(oldName, newName);
		const kind = classify(file, oldPath, newPath);
		const target = kind === 'delete' ? oldPath : newPath;
		files.push({
			kind,
			oldPath: mapToSrcLayout(oldPath),
			newPath: mapToSrcLayout(newPath),
			path: mapToSrcLayout(target),
			hunks: file.hunks,
			patch: file
		});
	}

	return { ok: true, files };
}

/**
 * What applying these files would mean for a given checkout.
 *
 * `conflicts` is the honest version of the dirty-tree question: applying a
 * patch is not destructive the way a hard reset is, so the only changes worth
 * mentioning are the ones on files the contributor has already edited.
 *
 * @param {Object}   root0
 * @param {Array}    root0.files
 * @param {string[]} [root0.dirtyPaths]
 * @return {{paths: string[], conflicts: string[], unsupported: string[], needsInstall: boolean}}
 */
function planApply({ files, dirtyPaths = [] } = {}) {
	const list = Array.isArray(files) ? files : [];
	const paths = list.map((f) => f.path).filter(Boolean);
	// A rename disturbs the file it moves away from as well as the one it
	// creates, so both sides count when looking for collisions.
	const touched = new Set(paths);
	for (const f of list) {
		if (f.kind === 'rename' && f.oldPath) touched.add(f.oldPath);
	}
	const dirty = new Set(dirtyPaths);
	return {
		paths,
		conflicts: [...touched].filter((p) => dirty.has(p)),
		// A binary section with no data ("Binary files differ") cannot be
		// applied from a text diff; one that carries its bytes is applied like
		// any other file (#385). Naming the first kind is the difference
		// between "this patch is partly unapplied" and a silent gap.
		unsupported: list.filter((f) => f.kind === 'binary' && !f.hasBinaryData).map((f) => f.path || '(unnamed binary file)'),
		// Same rule the trunk update uses (#94): the lockfile moving is what
		// makes an install necessary rather than merely possible.
		needsInstall: touched.has('package-lock.json')
	};
}

module.exports = {
	ROOT_FILES,
	SRC_FILES,
	stripPathPrefix,
	mapToSrcLayout,
	parsePatchFiles,
	splitPatchSections,
	rewritePatchPaths,
	planApply
};
