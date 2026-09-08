'use strict';

/**
 * Applying someone else's patch to a checkout (issue #11).
 *
 * Hunks are matched and written here by hand, with the `diff` package the app
 * already bundles for the generating side. This predates the bundled Git
 * (#364): whether `git apply` replaces it is the patch flow's decision (#385),
 * with tests/e2e/journeys/patch-apply.spec.js as the judge.
 *
 * The rule that shapes everything below is **all or nothing**. A patch that
 * half-applies is worse than one that does not apply at all: the contributor
 * would build it, test it, and draw conclusions from a tree that matches
 * neither trunk nor the patch. Every file is resolved in memory first — and
 * because a write can still fail on the way out (a directory that is really a
 * file, a read-only attribute, Windows holding a file open, a full disk), the
 * previous contents are captured during resolution and restored if any write
 * throws.
 */

const fs = require('fs');
const path = require('path');
const JsDiff = require('diff');
const { ensureAutocrlf } = require('./trunk-update');
const { normalizeEol } = require('./git-update.cjs');
const { parsePatchFiles } = require('./patch-plan.cjs');

/**
 * Resolves a patch's repo-relative path inside the site directory, refusing
 * anything that climbs out of it. A patch is untrusted input downloaded from a
 * ticket, and `../../` in a header would otherwise write anywhere on disk.
 *
 * `path.resolve` normalises `..` but not symlinks, and a checkout contains
 * plenty of those, so the deepest ancestor that exists is realpath-ed before
 * the comparison. Otherwise a path leading through a symlinked directory
 * passes a purely lexical check and lands outside the site folder.
 *
 * @param {string} dir
 * @param {string} relPath
 * @return {string|null} Absolute path, or null if it escapes the directory.
 */
function resolveInside(dir, relPath) {
	let root;
	try { root = fs.realpathSync(path.resolve(dir)); } catch { root = path.resolve(dir); }

	const lexical = path.resolve(root, relPath);
	// Walk up to the nearest existing entry, resolve that for real, then put the
	// not-yet-existing remainder back on. lstat, not existsSync: existsSync
	// follows links and reports a dangling symlink as absent, so the walk would
	// step past a symlink pointing outside the checkout and hand back its lexical
	// path — which the writer would then follow out of the tree.
	let existing = lexical;
	const trailing = [];
	const entryExists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
	while (!entryExists(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		trailing.unshift(path.basename(existing));
		existing = parent;
	}
	// The deepest existing entry is realpath-ed for real. A symlink here that
	// dangles (realpath throws) or resolves outside root is an escape, not a
	// path to write through — fail closed rather than falling back to lexical.
	let realExisting;
	try { realExisting = fs.realpathSync(existing); } catch { return null; }
	const abs = path.join(realExisting, ...trailing);

	if (abs !== root && !abs.startsWith(root + path.sep)) return null;
	return abs;
}

/**
 * The line ending a file already uses, so applying a patch does not silently
 * rewrite a genuinely-CRLF file to LF. wordpress-develop carries fixtures whose
 * line endings are the thing under test.
 *
 * @param {string} text
 * @return {string}
 */
function dominantEol(text) {
	const crlf = (text.match(/\r\n/g) || []).length;
	if (!crlf) return '\n';
	const lf = (text.match(/\n/g) || []).length;
	return crlf * 2 >= lf ? '\r\n' : '\n';
}

/**
 * Inverts one parsed file so the patch can be undone.
 *
 * Reversing through `formatPatch` would be simpler but wrong: it emits the
 * headers swapped (`--- b/…`, `+++ a/…`), which no longer look like a git
 * patch to the prefix-stripping in patch-plan.cjs, and the paths come back
 * carrying a literal `b/`. Reversing the hunks while keeping the paths already
 * resolved on the way in avoids the round trip entirely.
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
 * `JsDiff.applyPatch` answers for a whole file at once, so a patch that misses
 * in one place out of twenty is indistinguishable from one that misses
 * everywhere — and those are opposite decisions for the contributor (#282).
 * Asking the same question once per hunk is all it takes to tell them apart.
 *
 * The reverse answers *why*: a region whose inverse fits is one whose change is
 * already in the file, so the patch is redundant there rather than stale (#226).
 * That is the same reasoning `patchIsAbsent` uses below, asked per region.
 *
 * **Evidence, not proof.** `applyPatch` searches by offset for somewhere the
 * context fits, so a region whose surroundings repeat can match in the wrong
 * place. That is acceptable for choosing what to say and is never acceptable
 * for deciding what to write — nothing here reaches a write. Each hunk is also
 * matched against the file as it is now, not as earlier hunks would have left
 * it, which is the only question that can be asked when nothing is applied.
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
 * Kept in a single place because three branches of `resolveFile` produce it and
 * the tests match on its wording.
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
 * Works out what one file's new content should be, without touching disk.
 * Also captures what is there now, so a failed write can be rolled back.
 *
 * `diagnose` is off for `patchIsAbsent`, which only ever reads `.error` — every
 * file it asks about is expected to resolve, and diagnosing the ones that do not
 * would be work whose answer is discarded.
 *
 * @param {string}  dir
 * @param {Object}  file
 * @param {Object}  [options]
 * @param {boolean} [options.diagnose]
 * @return {Object}
 */
function resolveFile(dir, file, { diagnose = true } = {}) {
	// The three "no longer applies" branches below share this: the sentence, and
	// the per-region detail behind it when there is any.
	const conflict = (label, text) => {
		const diagnosis = diagnose ? diagnoseHunks(text, file) : null;
		const error = conflictSentence(label, diagnosis);
		// The sentence rides along inside the conflict as well, so the panel can
		// line each detail up with its entry in `failures` without re-deriving it.
		return diagnosis ? { error, conflict: { path: label, error, ...diagnosis } } : { error };
	};

	const target = resolveInside(dir, file.path);
	if (!target) return { error: `${file.path} points outside the site folder` };

	if (file.kind === 'delete') {
		if (!fs.existsSync(target)) return { error: `${file.path} is already gone, so the patch cannot remove it` };
		const previous = fs.readFileSync(target);
		// Validate the file still matches what the patch expects to remove, so an
		// edit made after the preview fails all-or-nothing rather than being
		// silently deleted with the contributor's changes in it.
		if (file.hunks && file.hunks.length) {
			const text = normalizeEol(previous.toString('utf8'));
			if (JsDiff.applyPatch(text, file.patch) === false) return conflict(file.path, text);
		} else if (previous.length) {
			// A deletion with no hunk is the removal of an *empty* file (#311) —
			// there was nothing to describe, which is also the whole claim it
			// makes about the old side. A file that has content since is not the
			// file the patch described, and removing it would discard work no
			// hunk ever mentioned. `git apply` refuses this outright ("removal
			// patch leaves file contents"); so does this.
			return conflict(file.path, normalizeEol(previous.toString('utf8')));
		}
		return { op: 'delete', abs: target, path: file.path, previous };
	}

	if (file.kind === 'add') {
		if (fs.existsSync(target)) return { error: `${file.path} already exists, so the patch cannot add it` };
		const content = JsDiff.applyPatch('', file.patch);
		if (content === false) return { error: `${file.path} could not be created from the patch` };
		return { op: 'write', abs: target, path: file.path, content, previous: null };
	}

	if (file.kind === 'rename') {
		const source = resolveInside(dir, file.oldPath);
		if (!source) return { error: `${file.oldPath} points outside the site folder` };
		if (!fs.existsSync(source)) return { error: `${file.oldPath} is not in this checkout, so the patch cannot move it` };
		if (fs.existsSync(target)) return { error: `${file.newPath} already exists, so the patch cannot move ${file.oldPath} onto it` };
		const originalBuf = fs.readFileSync(source);
		// A 100%-similarity rename has no hunks: the bytes move unchanged, so they
		// are carried as a Buffer. Git emits binary renames with no binary marker,
		// so this path is reachable for them — decoding through utf8 would corrupt
		// the file. Decode to text only when hunks actually need applying.
		let content = originalBuf;
		if (file.hunks.length) {
			const original = originalBuf.toString('utf8');
			const text = normalizeEol(original);
			const applied = JsDiff.applyPatch(text, file.patch);
			if (applied === false) return conflict(file.oldPath, text);
			content = applied.replace(/\n/g, dominantEol(original) === '\r\n' ? '\r\n' : '\n');
		}
		return {
			op: 'rename', abs: target, from: source, path: file.path, content,
			previous: null, previousFrom: originalBuf
		};
	}

	if (!fs.existsSync(target)) return { error: `${file.path} is not in this checkout, so the patch does not fit it` };

	// Matching happens on LF, the way the generating side normalises, so a CRLF
	// checkout does not make every context line miss — but the file is written
	// back with the endings it already had.
	const raw = fs.readFileSync(target, 'utf8');
	const normalized = normalizeEol(raw);
	const applied = JsDiff.applyPatch(normalized, file.patch);
	if (applied === false) return conflict(file.path, normalized);
	const content = dominantEol(raw) === '\r\n' ? applied.replace(/\n/g, '\r\n') : applied;
	return { op: 'write', abs: target, path: file.path, content, previous: Buffer.from(raw, 'utf8') };
}

/**
 * Whether the checkout looks like the patch was never applied — every file it
 * names sits at its pre-patch state.
 *
 * Only asked when a reverse has already failed, and only to tell two failures
 * apart: a file that drifted since the patch was written, and a file that is
 * pristine because something reset the tree (a trunk update, a discard) and
 * took the patch with it. The second one is not a conflict, it is a stale
 * record, and saying "the file has moved on" about an untouched file sends the
 * contributor looking for a change that is not there.
 *
 * The question is answered by resolving the patch *forwards*: resolveFile
 * already encodes what each kind needs — a modify whose hunks still match, an
 * add whose target is absent, a delete whose target is present — so there is no
 * second matching implementation to keep in step. Nothing is written; this only
 * ever runs on the failure path, where the checkout is already being left
 * alone. It has to be unanimous: a patch that is half in the tree is a real
 * conflict, and dropping its record would strand the applied half.
 *
 * Unanimity here is necessary but not sufficient, which is why the caller also
 * requires that nothing reversed. `JsDiff.applyPatch` searches by offset for a
 * place the context fits, so a hunk whose context repeats in the file can
 * "apply forwards" to a file that already has it — patching the other copy.
 * The caller's guard is what keeps that from reading as an absent patch.
 *
 * @param {string} dir
 * @param {Array}  files Forward (un-reversed) parsed files.
 * @return {boolean}
 */
function patchIsAbsent(dir, files) {
	const text = files.filter((f) => f.kind !== 'binary');
	if (!text.length) return false;
	return text.every((f) => !resolveFile(dir, f, { diagnose: false }).error);
}

/**
 * Puts back everything a failed run had already written.
 *
 * Returns the paths it could not restore. The same full-disk, lock, or
 * permission condition that broke a write can also break its undo, and the
 * caller must not claim a clean restore when the tree is actually unknown.
 *
 * @param {Array} done
 * @return {Array<string>} paths whose rollback failed (empty when fully restored)
 */
function rollback(done) {
	const errors = [];
	// Removing something that was never created — already gone, or its parent is
	// not even a directory — is the desired end state, not a failure. Actions are
	// registered before they mutate (so a half-done one is still undoable), which
	// means rollback can see ones that never ran; only a content restoration that
	// cannot be written back is a real, unrecoverable loss.
	const removeQuietly = (target) => {
		try { fs.rmSync(target, { force: true }); }
		catch (e) { if (!e || (e.code !== 'ENOTDIR' && e.code !== 'ENOENT')) throw e; }
	};
	for (const action of done.reverse()) {
		try {
			if (action.op === 'rename' && action.previousFrom !== null) {
				fs.mkdirSync(path.dirname(action.from), { recursive: true });
				fs.writeFileSync(action.from, action.previousFrom);
				removeQuietly(action.abs);
				continue;
			}
			if (action.previous === null) {
				removeQuietly(action.abs);
				continue;
			}
			fs.mkdirSync(path.dirname(action.abs), { recursive: true });
			fs.writeFileSync(action.abs, action.previous);
		} catch (e) {
			errors.push(`${action.path}: ${String(e && e.message ? e.message : e)}`);
		}
	}
	return errors;
}

/**
 * Applies (or reverses) a patch across a checkout.
 *
 * Binary files are skipped and named rather than failing the whole patch: a
 * text diff cannot carry their content, and refusing an otherwise-good pull
 * request over an image would help nobody. Everything else is all or nothing.
 *
 * @param {Object}   root0
 * @param {string}   root0.dir
 * @param {string}   root0.patchText
 * @param {boolean}  [root0.reverse]
 * @param {Function} [root0.onLog]
 * @return {Promise<Object>}
 */
async function applyPatchToDir({ dir, patchText, reverse = false, onLog = () => {} }) {
	const parsed = parsePatchFiles(patchText);
	if (!parsed.ok) return { ok: false, error: parsed.error };

	await ensureAutocrlf(dir);

	const files = reverse ? parsed.files.map(reverseFile) : parsed.files;
	const actions = [];
	const skipped = [];
	const failures = [];
	const conflicts = [];

	for (const file of files) {
		if (file.kind === 'binary') {
			skipped.push(file.path);
			continue;
		}
		// Diagnosed on a reverse too (#306). The ticket's other patches are still
		// no answer to a revert that failed, but the *reason* it failed is: a
		// revert only fails because the contributor's own edits are on the
		// patch's lines, and naming how many of them, and where, is the whole
		// difference between an explanation and a generic error.
		const resolved = resolveFile(dir, file);
		if (resolved.error) {
			failures.push(resolved.error);
			if (resolved.conflict) conflicts.push(resolved.conflict);
			continue;
		}
		actions.push(resolved);
	}

	if (failures.length) {
		// A reverse that fails on a checkout still holding the pre-patch content
		// is not a conflict: the patch is gone and only the record of it is left.
		// Naming that is what lets the caller drop the record instead of leaving
		// the contributor with a patch they can neither revert nor replace.
		//
		// `!actions.length` — not a single file reversed — is the load-bearing
		// half. A file that is still patched can nonetheless resolve forwards
		// when its hunk context repeats, because applyPatch finds the other
		// copy; requiring that nothing at all reversed means a half-present
		// patch keeps its record and its conflict.
		if (reverse && !actions.length && patchIsAbsent(dir, parsed.files)) {
			const error = 'That patch is not in this checkout any more — something reset it, probably a trunk update or a discard. Nothing was reverted.';
			onLog(`\n${error}\n`);
			return { ok: false, notApplied: true, error, applied: [], skipped };
		}
		onLog(`\nThe patch was not applied — the checkout is unchanged.\n${failures.map((f) => `  • ${f}\n`).join('')}`);
		// `failures` carries every file, not just the first: the panel used to show
		// `error` alone and send the rest to the terminal, where a contributor has
		// no reason to be looking (#282). `conflicts` is the same failures with
		// their regions, for the ones that have any.
		return { ok: false, error: failures[0], failures, conflicts, applied: [], skipped };
	}

	if (!actions.length && !skipped.length) {
		return { ok: false, error: 'The patch does not change any files.', applied: [], skipped };
	}

	// Every file resolved cleanly, so the writes below are the first thing to
	// touch the working tree — and the only place a partial result could still
	// appear, which is what the rollback is for.
	const done = [];
	try {
		for (const action of actions) {
			// Registered before its mutations, not after: a rename that writes its
			// destination and then throws removing the source would otherwise be
			// invisible to rollback and leave a partial patch behind. Undoing an
			// action whose mutations had not started yet is harmless.
			done.push(action);
			if (action.op === 'delete') {
				fs.rmSync(action.abs, { force: true });
			} else if (action.op === 'rename') {
				fs.mkdirSync(path.dirname(action.abs), { recursive: true });
				fs.writeFileSync(action.abs, action.content);
				fs.rmSync(action.from, { force: true });
			} else {
				fs.mkdirSync(path.dirname(action.abs), { recursive: true });
				fs.writeFileSync(action.abs, action.content);
			}
		}
	} catch (e) {
		const recovery = rollback(done);
		const message = `writing ${String(e && e.message ? e.message : e)}`;
		if (recovery.length) {
			onLog(`\nThe patch could not be written, and the checkout could not be fully put back — it is in an unknown state. Could not undo: ${recovery.join('; ')}\n`);
			return { ok: false, error: message, applied: [], skipped, rolledBack: false, recovery };
		}
		onLog(`\nThe patch could not be written, so the checkout was put back as it was: ${message}\n`);
		return { ok: false, error: message, applied: [], skipped, rolledBack: true };
	}

	// New files are deliberately left unstaged. Staging them is what leaves the
	// residue that updateToLatestTrunk has to clear before a force checkout
	// (see staleStagedPaths in git-update.cjs), and an unstaged new file still
	// shows up in the patch the contributor generates afterwards.
	const applied = actions.map((a) => a.path);
	onLog(`\n${reverse ? 'Reverted' : 'Applied'} ${applied.length} file${applied.length === 1 ? '' : 's'}.\n`);
	if (skipped.length) {
		onLog(`Skipped ${skipped.length} binary file${skipped.length === 1 ? '' : 's'} the app cannot apply: ${skipped.join(', ')}\n`);
	}

	return { ok: true, applied, skipped };
}

module.exports = { applyPatchToDir, resolveInside, reverseFile, dominantEol, rollback, diagnoseHunks };
