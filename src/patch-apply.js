'use strict';

/**
 * Applying someone else's patch to a checkout (issue #11), on the bundled Git
 * (#385, decided 2026-09-08).
 *
 * `git apply` decides and writes: whether the patch fits is the same question
 * the mentor who receives a patch, or Trac's committer, will ask the same
 * tool. It is all or nothing on its own (a `--check` that fails names every
 * file that does not fit, and a real apply writes nothing when a hunk fails),
 * it refuses a path outside the tree or through a symlink, and it applies
 * binary sections that carry their data, renames, mode changes and empty
 * files. What this module keeps in JS is what Git does not give:
 *
 * - the rewrite of Trac's paths to today's layout (`rewritePatchPaths`), so
 *   `git apply -p1` lands them where the preview said;
 * - a binary section with no data ("Binary files differ"), which would fail
 *   the whole patch: left out and named as skipped, as the docs promise;
 * - the wording of a refusal: which files, and inside a file which regions
 *   and why (#282, #226), from `diagnoseHunks`, which matches hunks with the
 *   `diff` package one at a time and never writes;
 * - the "that patch is not here any more" answer (#183): a reverse that
 *   fails everywhere while the forward patch would apply cleanly;
 * - a snapshot of the files the patch names, taken before the write, so a
 *   write Git left half done (an I/O failure part-way: a file held open, a
 *   full disk; verified: Git does not roll those back) is put back.
 *
 * Probed on Git 2.53 before this shape was chosen: `--check` exit codes and
 * per-file reporting, `../` (128) and symlinks refused, a missing target and
 * an existing add refused by name, stdin with `-p1`, empty adds and deletes
 * with no hunks applied, a binary section with no data failing the patch, a
 * half write left in place.
 *
 * The one thing that got worse: a CRLF file in a checkout a host Git made on
 * macOS (rare: macOS hosts seldom set `core.autocrlf`) receives LF lines from
 * Git where the old applier matched its ending. On Windows the `core.autocrlf`
 * view `windowsArgs` gives every worktree command covers it, and a site the
 * app cloned is LF throughout.
 */

const fs = require('fs');
const path = require('path');
const JsDiff = require('diff');
const { normalizeEol } = require('./git-update.cjs');
const { parsePatchFiles, splitPatchSections, rewritePatchPaths } = require('./patch-plan.cjs');
const { applyPatch } = require('./git-write.cjs');
const { windowsArgs } = require('./git-read.cjs');

// How many sections are checked on their own to name what failed. Past this
// the breakdown is not something a panel can show, and every check is a Git
// spawn, which on a locked-down Windows laptop with a virus scanner is not
// free; the refusal itself was decided by the one check of the whole patch.
const SECTION_DETAIL_LIMIT = 20;

/**
 * Inverts one parsed file so a reverse can be worded: the kinds swap, the
 * paths swap, and the hunks are reversed for `diagnoseHunks`. Nothing here
 * reaches Git, which does its own `--reverse`.
 *
 * @param {Object} file
 * @return {Object}
 */
function reverseFile(file) {
	const reversed = JsDiff.reversePatch(file.patch);
	const INVERSE = { add: 'delete', delete: 'add' };
	const kind = INVERSE[file.kind] || file.kind;
	const oldPath = file.newPath;
	const newPath = file.oldPath;
	return {
		...file,
		kind,
		oldPath,
		newPath,
		path: kind === 'delete' ? oldPath : newPath,
		hunks: reversed.hunks || [],
		patch: reversed
	};
}

// How many failing regions carry their own lines, and how many lines each of
// those carries. Everything else is still counted and located — only the
// content is dropped. The whole diagnosis crosses IPC and then has to fit in a
// notice, and a patch that misses in forty places would otherwise send forty
// blocks of diff to a panel nobody can read.
const REGION_DETAIL_LIMIT = 3;
const REGION_LINE_LIMIT = 10;

/**
 * The `-`/`+` lines of one hunk — what that region was trying to change.
 * Context lines are dropped: they are what the region was looking for, not what
 * it wanted to do, and they are the bulk of the text.
 *
 * @param {Object} hunk
 * @return {{lines: Array<string>, more: number}}
 */
function changedLines(hunk) {
	const changed = (hunk.lines || []).filter((line) => line[0] === '+' || line[0] === '-');
	return {
		lines: changed.slice(0, REGION_LINE_LIMIT),
		more: Math.max(0, changed.length - REGION_LINE_LIMIT)
	};
}

/**
 * A line the contributor can search for to find this region in *their* file.
 *
 * The hunk's line numbers cannot serve: they are coordinates in the file as it
 * was when the patch was written, and on an old patch they miss by dozens —
 * precision that sends someone to the wrong place. A line of content survives
 * the drift, so the notice offers text for the editor's search instead.
 *
 * Which line to prefer depends on why the region failed — a region whose
 * surroundings moved usually still has the very line it wants to change, one
 * already applied has the *result* — but "usually" is not a promise, so every
 * candidate is checked against the file itself and the first one actually
 * present wins. Only when nothing from the hunk survives in the file does the
 * preference order alone decide, as the least-bad thing to show.
 *
 * @param {Object}  hunk
 * @param {boolean} alreadyApplied
 * @param {string}  text           Current file contents, EOL-normalised.
 * @return {string} A trimmed line, or '' when the hunk offers nothing usable.
 */
function anchorLine(hunk, alreadyApplied, text) {
	const lines = hunk.lines || [];
	const candidates = (marker) => lines
		.filter((line) => line[0] === marker && line.slice(1).trim())
		.map((line) => line.slice(1).trim().slice(0, 120));
	const preferred = alreadyApplied ? ['+', '-', ' '] : ['-', ' ', '+'];
	for (const marker of preferred) {
		// Longest present candidate, not first: the first line of a hunk is
		// often a bare brace, and "near `}`" locates nothing.
		const present = candidates(marker).filter((line) => text.includes(line));
		if (present.length) return present.reduce((a, b) => (b.length > a.length ? b : a));
	}
	for (const marker of preferred) {
		const [firstLine] = candidates(marker);
		if (firstLine) return firstLine;
	}
	return '';
}

/**
 * Which regions of a patch no longer fit a file, and why.
 *
 * `git apply` answers for the whole patch, so a patch that misses in one
 * place out of twenty is indistinguishable from one that misses everywhere —
 * and those are opposite decisions for the contributor (#282). Asking the
 * `diff` package the same question once per hunk is all it takes to tell
 * them apart.
 *
 * The reverse answers *why*: a region whose inverse fits is one whose change is
 * already in the file, so the patch is redundant there rather than stale (#226).
 *
 * **Evidence, not proof.** `applyPatch` searches by offset for somewhere the
 * context fits, so a region whose surroundings repeat can match in the wrong
 * place. That is acceptable for choosing what to say and is never acceptable
 * for deciding what to write — nothing here reaches a write; Git decided
 * already. Each hunk is also matched against the file as it is now, not as
 * earlier hunks would have left it, which is the only question that can be
 * asked when nothing is applied.
 *
 * @param {string} text Current file contents, EOL-normalised.
 * @param {Object} file Parsed patch file.
 * @return {?{total: number, regions: Array<Object>}} null when nothing to add.
 */
function diagnoseHunks(text, file) {
	const hunks = file.hunks || [];
	if (!hunks.length) return null;

	const regions = [];
	hunks.forEach((hunk, index) => {
		const single = { ...file.patch, hunks: [hunk] };
		if (JsDiff.applyPatch(text, single) !== false) return;
		const alreadyApplied = JsDiff.applyPatch(text, JsDiff.reversePatch(single)) !== false;
		const region = {
			index,
			// The patch's own coordinates, kept for logs and tests — the notice
			// leads with `anchor`, because on an old patch these numbers point at
			// where the code *used* to be, not where the contributor will find it.
			line: hunk.oldStart,
			status: alreadyApplied ? 'already-applied' : 'moved',
			anchor: anchorLine(hunk, alreadyApplied, text)
		};
		// Only the first few regions carry their lines; the rest are still named
		// and located, which is what the counts are built from.
		if (regions.length < REGION_DETAIL_LIMIT) {
			const { lines, more } = changedLines(hunk);
			region.lines = lines;
			if (more) region.more = more;
		}
		regions.push(region);
	});

	// A file can fail as a whole while every region passes alone: applied one at
	// a time they are matched against the unshifted file, and two that overlap
	// once applied do not. There is nothing useful to say about that, so the
	// caller keeps its original sentence rather than claiming zero conflicts.
	if (!regions.length) return null;
	return { total: hunks.length, regions };
}

/**
 * The one sentence for a file the patch no longer fits.
 *
 * Kept in a single place because the tests match on its wording.
 *
 * @param {string}  label     Path to name.
 * @param {?Object} diagnosis From `diagnoseHunks`, or null.
 * @return {string}
 */
function conflictSentence(label, diagnosis) {
	if (!diagnosis) {
		return `${label} has moved on since the patch was written, so it no longer applies`;
	}
	const failed = diagnosis.regions.length;
	const { total } = diagnosis;
	if (failed === total) {
		return `${label} has moved on since the patch was written, so none of its ${total} change${total === 1 ? '' : 's'} still fits`;
	}
	return `${label} has moved on since the patch was written: ${failed} of its ${total} changes no longer fit, and the other ${total - failed} do`;
}

/**
 * Whether a repo-relative path stays inside the site folder, symlinks
 * followed. Git is what refuses an escape (`../`, a path beyond a symbolic
 * link) before any write; this only chooses the sentence for one it refused,
 * and reads nothing but directory entries.
 *
 * @param {string} dir
 * @param {string} relPath
 * @return {boolean}
 */
function staysInside(dir, relPath) {
	let root;
	try { root = fs.realpathSync(path.resolve(dir)); } catch { root = path.resolve(dir); }
	const lexical = path.resolve(root, relPath);
	// Walk up to the nearest existing entry and resolve that for real, so a
	// path through a symlinked directory is judged by where it lands. lstat,
	// not existsSync: a dangling link reads as absent to existsSync and the
	// walk would step past it.
	let existing = lexical;
	const trailing = [];
	const entryExists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
	while (!entryExists(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		trailing.unshift(path.basename(existing));
		existing = parent;
	}
	let realExisting;
	try { realExisting = fs.realpathSync(existing); } catch { return false; }
	const abs = path.join(realExisting, ...trailing);
	return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Why one file Git refused does not fit, in the contributor's terms: the
 * target's presence for an add, a delete, a rename, a modify; otherwise the
 * regions that miss. Reads only.
 *
 * @param {string} dir
 * @param {Object} file Parsed (and, on a reverse, reversed) patch file.
 * @return {{error: string, conflict?: Object}}
 */
function explainRefusal(dir, file) {
	const conflict = (label, text) => {
		const diagnosis = diagnoseHunks(text, file);
		const error = conflictSentence(label, diagnosis);
		// The sentence rides along inside the conflict as well, so the panel can
		// line each detail up with its entry in `failures` without re-deriving it.
		return diagnosis ? { error, conflict: { path: label, error, ...diagnosis } } : { error };
	};
	const exists = (relPath) => fs.existsSync(path.join(dir, relPath));
	const currentText = (relPath) => normalizeEol(fs.readFileSync(path.join(dir, relPath), 'utf8'));

	if (!staysInside(dir, file.path) || (file.kind === 'rename' && !staysInside(dir, file.oldPath))) {
		return { error: `${file.path} points outside the site folder` };
	}
	if (file.kind === 'delete') {
		if (!exists(file.path)) return { error: `${file.path} is already gone, so the patch cannot remove it` };
		return conflict(file.path, currentText(file.path));
	}
	if (file.kind === 'add') {
		if (exists(file.path)) return { error: `${file.path} already exists, so the patch cannot add it` };
		return { error: `${file.path} could not be created from the patch` };
	}
	if (file.kind === 'rename') {
		if (!exists(file.oldPath)) return { error: `${file.oldPath} is not in this checkout, so the patch cannot move it` };
		if (exists(file.newPath)) return { error: `${file.newPath} already exists, so the patch cannot move ${file.oldPath} onto it` };
		return conflict(file.oldPath, currentText(file.oldPath));
	}
	if (!exists(file.path)) return { error: `${file.path} is not in this checkout, so the patch does not fit it` };
	return conflict(file.path, currentText(file.path));
}

/**
 * Resolve a snapshot path without traversing a symlink below the checkout.
 * The root itself may use an OS alias (such as macOS /var).
 *
 * @param {string}  dir
 * @param {string}  relPath
 * @param {boolean} snapshot Whether to treat paths behind links as absent.
 * @return {?string}
 */
function entryPath(dir, relPath, snapshot = false) {
	const root = fs.realpathSync(dir);
	const abs = path.resolve(root, relPath);
	const relative = path.relative(root, abs);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error('Path is outside the checkout');
	}
	let parent = root;
	for (const part of relative.split(path.sep).slice(0, -1)) {
		parent = path.join(parent, part);
		let stat;
		try { stat = fs.lstatSync(parent); }
		catch (e) {
			if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break;
			throw e;
		}
		if (stat.isSymbolicLink()) {
			// Git may replace this link with a directory. Its future children
			// have no pre-patch entries here; never snapshot the link's target.
			if (snapshot) return null;
			throw new Error(`Parent is a symbolic link: ${parent}`);
		}
		if (!stat.isDirectory()) break;
	}
	return abs;
}

/**
 * Read the entry itself, never a symlink's target. Null means absent.
 *
 * @param {string} abs
 * @return {?Object}
 */
function snapshotEntry(abs) {
	let stat;
	try { stat = fs.lstatSync(abs); }
	catch (e) {
		if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
		throw e;
	}
	if (stat.isSymbolicLink()) return { type: 'symlink', target: fs.readlinkSync(abs) };
	if (stat.isDirectory()) return { type: 'directory' };
	if (!stat.isFile()) throw new Error('Unsupported filesystem entry');
	// eslint-disable-next-line no-bitwise -- Keep only filesystem permission bits.
	return { type: 'file', bytes: fs.readFileSync(abs), mode: stat.mode & 0o777 };
}

/**
 * What the entries a patch names hold, so a partial write can be put back.
 *
 * @param {string}   dir
 * @param {string[]} relPaths
 * @return {Map<string, ?Object>}
 */
function snapshotFiles(dir, relPaths) {
	const snapshot = new Map();
	for (const relPath of relPaths) {
		if (!relPath || snapshot.has(relPath)) continue;
		const abs = entryPath(dir, relPath, true);
		snapshot.set(relPath, abs === null ? null : snapshotEntry(abs));
	}
	return snapshot;
}

/**
 * Restore entries without following changed links. Nonempty directories and
 * paths behind a symlink are refused rather than risking unrelated files.
 *
 * @param {string}               dir
 * @param {Map<string, ?Object>} snapshot
 * @return {Array<string>} Paths whose rollback failed.
 */
function rollback(dir, snapshot) {
	const errors = [];
	for (const [relPath, previous] of snapshot) {
		try {
			const abs = entryPath(dir, relPath);
			const now = snapshotEntry(abs);
			// Leave entries Git never changed alone, including their mtimes.
			if (previous === null && now === null) continue;
			if (previous && now && previous.type === now.type) {
				if (previous.type === 'directory') continue;
				if (previous.type === 'symlink' && previous.target === now.target) continue;
				if (previous.type === 'file' && previous.mode === now.mode && previous.bytes.equals(now.bytes)) continue;
			}
			if (now) {
				if (now.type === 'directory') fs.rmdirSync(abs);
				else fs.unlinkSync(abs);
			}
			if (previous === null) continue;
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			if (previous.type === 'symlink') fs.symlinkSync(previous.target, abs);
			else if (previous.type === 'directory') fs.mkdirSync(abs);
			else {
				fs.writeFileSync(abs, previous.bytes, { flag: 'wx', mode: previous.mode });
				fs.chmodSync(abs, previous.mode);
			}
		} catch (e) {
			errors.push(`${relPath}: ${String(e && e.message ? e.message : e)}`);
		}
	}
	return errors;
}

/**
 * Applies (or reverses) a patch across a checkout.
 *
 * Binary files whose section carries no data are skipped and named rather
 * than failing the whole patch: a "Binary files differ" line cannot carry
 * their content, and refusing an otherwise-good pull request over an image
 * would help nobody. A binary section with its data applies like any other.
 * Everything else is all or nothing.
 *
 * @param {Object}   root0
 * @param {string}   root0.dir
 * @param {string}   root0.patchText
 * @param {boolean}  [root0.reverse]
 * @param {Function} [root0.onLog]
 * @param {string}   [root0.platform] For the Windows worktree view; injection point for tests.
 * @return {Promise<Object>}
 */
async function applyPatchToDir({ dir, patchText, reverse = false, onLog = () => {}, platform = process.platform }) {
	const parsed = parsePatchFiles(patchText);
	if (!parsed.ok) return { ok: false, error: parsed.error };

	let text;
	try {
		text = rewritePatchPaths(normalizeEol(patchText));
	} catch (e) {
		return { ok: false, error: `Could not read the patch: ${String(e && e.message ? e.message : e)}` };
	}
	const sections = splitPatchSections(text);
	const skipped = [];
	const applicable = [];
	for (const section of sections) {
		if (section.isBinary && !section.hasBinaryData) {
			skipped.push(section.path || '(unnamed binary file)');
			continue;
		}
		applicable.push(section);
	}
	// The forward files, and the way each will be worded: reversed when the
	// patch is being taken out (#306).
	const files = reverse ? parsed.files.map(reverseFile) : parsed.files;
	const wordable = files.filter((file) => file.kind !== 'binary');
	const fileFor = (section) => wordable.find((file) => file.path === section.path || file.oldPath === section.path) || null;

	if (!applicable.length) {
		if (!skipped.length) return { ok: false, error: 'The patch does not change any files.', applied: [], skipped };
		// Only binaries with no data: nothing for Git to do, and nothing wrong
		// with the patch either. Named, not refused, as the docs promise.
		onLog(`\nSkipped ${skipped.length} binary file${skipped.length === 1 ? '' : 's'} the app cannot apply: ${skipped.join(', ')}\n`);
		return { ok: true, applied: [], skipped };
	}
	const applyText = applicable.map((section) => section.text).join('');
	// The worktree view (the `core.autocrlf` view and long paths on Windows)
	// resolved once: it is a `git config` read on Windows, and the refusal
	// path below checks section by section.
	const prefix = await windowsArgs(dir, { platform });

	const check = await applyPatch(dir, applyText, { check: true, reverse, platform, prefix });
	if (!check.ok) {
		const failures = [];
		const conflicts = [];
		let failing = 0;
		let checked = 0;
		for (const section of applicable) {
			if (checked >= SECTION_DETAIL_LIMIT) {
				const rest = applicable.length - checked;
				failures.push(`${rest} more file${rest === 1 ? ' was' : 's were'} not checked one by one`);
				break;
			}
			checked += 1;
			const own = await applyPatch(dir, section.text, { check: true, reverse, platform, prefix });
			if (own.ok) continue;
			failing += 1;
			const file = fileFor(section);
			const explained = file ? explainRefusal(dir, file) : { error: `${section.path || 'a file'} has moved on since the patch was written, so it no longer applies` };
			failures.push(explained.error);
			if (explained.conflict) conflicts.push(explained.conflict);
		}
		if (!failures.length) {
			// Every section passes alone and the whole does not: two sections
			// that touch the same file, or a shape Git only refuses in
			// combination. Git's own last line is the truest thing to say.
			failures.push(check.stderr.split(/\r?\n/).filter((line) => line.trim()).pop() || 'The patch does not apply.');
		}
		// A reverse that fails on a checkout still holding the pre-patch content
		// is not a conflict: the patch is gone and only the record of it is left.
		// Naming that is what lets the caller drop the record instead of leaving
		// the contributor with a patch they can neither revert nor replace. It
		// has to be unanimous (#183): every section fails to reverse, and the
		// whole patch would apply forwards, so a patch that is half in the tree
		// keeps its record and its conflict.
		if (reverse && checked === applicable.length && failing === applicable.length) {
			const forward = await applyPatch(dir, applyText, { check: true, reverse: false, platform, prefix });
			if (forward.ok) {
				const error = 'That patch is not in this checkout any more — something reset it, probably a trunk update or a discard. Nothing was reverted.';
				onLog(`\n${error}\n`);
				return { ok: false, notApplied: true, error, applied: [], skipped };
			}
		}
		onLog(`\nThe patch was not applied — the checkout is unchanged.\n${failures.map((f) => `  • ${f}\n`).join('')}`);
		// `failures` carries every file, not just the first: the panel used to show
		// `error` alone and send the rest to the terminal, where a contributor has
		// no reason to be looking (#282). `conflicts` is the same failures with
		// their regions, for the ones that have any.
		return { ok: false, error: failures[0], failures, conflicts, applied: [], skipped };
	}

	// Git found every file fits, so the write below is the first thing to touch
	// the working tree — and the only place a partial result could still appear
	// (an I/O failure part-way, which Git does not undo), which the snapshot is
	// for. Both ends of every section: a rename names the file it moves away
	// from as well as the one it makes.
	const touched = applicable.flatMap((section) => [section.from, section.path]).filter(Boolean);
	let snapshot;
	try { snapshot = snapshotFiles(dir, touched); }
	catch (e) {
		const error = `Could not snapshot the checkout before applying the patch: ${e.message}`;
		onLog(`\n${error}\n`);
		return { ok: false, error, applied: [], skipped };
	}
	const written = await applyPatch(dir, applyText, { reverse, platform, prefix });
	let writeError = written.ok ? null : written.stderr.split(/\r?\n/).filter((line) => line.trim()).pop() || `git apply exited ${written.status}`;
	// Windows Git can exit 0 without creating a file beneath a regular-file
	// parent (#413). Check the actual destinations before claiming success.
	// Git still decides the contents; this only detects an omitted write.
	if (written.ok) {
		const destinations = new Set(applicable.map((section) => reverse ? section.from : section.to).filter(Boolean));
		for (const relPath of destinations) {
			try {
				// A symlink is itself a written entry, even if its target is absent.
				await fs.promises.lstat(path.join(dir, relPath));
			} catch (e) {
				writeError = `could not verify ${relPath} after git apply: ${e.message}`;
				break;
			}
		}
	}
	if (writeError) {
		const recovery = rollback(dir, snapshot);
		const message = `writing ${writeError}`;
		if (recovery.length) {
			onLog(`\nThe patch could not be written, and the checkout could not be fully put back — it is in an unknown state. Could not undo: ${recovery.join('; ')}\n`);
			return { ok: false, error: message, applied: [], skipped, rolledBack: false, recovery };
		}
		onLog(`\nThe patch could not be written, so the checkout was put back as it was: ${message}\n`);
		return { ok: false, error: message, applied: [], skipped, rolledBack: true };
	}

	// New files are deliberately left unstaged (no `--index`). Staging them is
	// what leaves the residue that updateToLatestTrunk has to clear before a
	// force checkout (see staleStagedPaths in git-update.cjs), and an unstaged
	// new file still shows up in the patch the contributor generates afterwards.
	const applied = applicable.map((section) => {
		const file = fileFor(section);
		return file ? file.path : section.path;
	});
	onLog(`\n${reverse ? 'Reverted' : 'Applied'} ${applied.length} file${applied.length === 1 ? '' : 's'}.\n`);
	if (skipped.length) {
		onLog(`Skipped ${skipped.length} binary file${skipped.length === 1 ? '' : 's'} the app cannot apply: ${skipped.join(', ')}\n`);
	}

	return { ok: true, applied, skipped };
}

module.exports = { applyPatchToDir, reverseFile, rollback, snapshotFiles, diagnoseHunks };
