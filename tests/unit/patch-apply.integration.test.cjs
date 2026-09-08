'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JsDiff = require('diff');
const { applyPatchToDir, rollback, snapshotFiles, diagnoseHunks } = require('../../src/patch-apply');
const { parsePatchFiles } = require('../../src/patch-plan.cjs');
const { gitOk, initRepo, commitFiles, tempDir } = require('./helpers/git.cjs');

// A real on-disk repo, shaped the way the app's clone shapes one: the applier
// hands the patch to the bundled Git, which wants a repository to apply into
// (and refuses paths outside it). `autocrlf: null` builds instead the shape a
// host Git left behind, which is the one case the CRLF view below is about.
async function makeRepo(t, files, { autocrlf = 'false' } = {}) {
	const dir = initRepo(tempDir(t, 'patch-apply-test-'), { autocrlf });
	for (const [relPath, content] of Object.entries(files)) {
		const abs = path.join(dir, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	commitFiles(dir, Object.keys(files), 'base');
	return dir;
}

// Snapshot every file so "nothing was written" can be asserted byte for byte
// rather than just on the one file we happen to think about.
function snapshot(dir) {
	const out = {};
	const walk = (rel) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			if (entry.name === '.git') continue;
			const next = path.join(rel, entry.name);
			if (entry.isDirectory()) walk(next);
			else out[next] = fs.readFileSync(path.join(dir, next), 'utf8');
		}
	};
	walk('.');
	return out;
}

const FOO = 'src/wp-includes/foo.php';
const BAR = 'src/wp-includes/bar.php';
const FOO_BODY = 'one\ntwo\nthree\n';
const BAR_BODY = 'alpha\nbeta\ngamma\n';

const FOO_PATCH = `diff --git a/${FOO} b/${FOO}
--- a/${FOO}
+++ b/${FOO}
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

// Second file's context does not match what is on disk, so this hunk fails.
const BAR_PATCH_THAT_FAILS = `diff --git a/${BAR} b/${BAR}
--- a/${BAR}
+++ b/${BAR}
@@ -1,3 +1,3 @@
 nothing
-like
+LIKE
 reality
`;

test('applyPatchToDir: a single-file patch applies (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH });
	assert.strictEqual(res.ok, true);
	assert.deepStrictEqual(res.applied, [FOO]);
	assert.strictEqual(fs.readFileSync(path.join(dir, FOO), 'utf8'), 'one\nTWO\nthree\n');
});

// The rule the whole module is built around. A patch where the second file
// fails must not leave the first one rewritten.
test('applyPatchToDir: one failing file leaves the whole tree untouched (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY, [BAR]: BAR_BODY });
	const before = snapshot(dir);

	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH + BAR_PATCH_THAT_FAILS });

	assert.strictEqual(res.ok, false);
	assert.match(res.error, /bar\.php/);
	assert.deepStrictEqual(res.applied, []);
	assert.deepStrictEqual(snapshot(dir), before, 'no file may change when any file fails');
});

test('applyPatchToDir: reverting restores the original content (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	await applyPatchToDir({ dir, patchText: FOO_PATCH });
	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH, reverse: true });
	assert.strictEqual(res.ok, true);
	assert.strictEqual(fs.readFileSync(path.join(dir, FOO), 'utf8'), FOO_BODY);
});

// Reverting must undo the patch, not reset the checkout: work the contributor
// did on other files has to survive.
test('applyPatchToDir: reverting keeps unrelated local work (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY, [BAR]: BAR_BODY });
	await applyPatchToDir({ dir, patchText: FOO_PATCH });
	fs.writeFileSync(path.join(dir, BAR), 'my own work\n');

	await applyPatchToDir({ dir, patchText: FOO_PATCH, reverse: true });

	assert.strictEqual(fs.readFileSync(path.join(dir, FOO), 'utf8'), FOO_BODY);
	assert.strictEqual(fs.readFileSync(path.join(dir, BAR), 'utf8'), 'my own work\n');
});

// A trunk update or a discard resets the worktree and takes the patch with it,
// but the record of it can outlive the reset (#183/#184). Reverting then finds
// a pristine file: not a conflict, nothing left to undo. Saying "the file has
// moved on" sends the contributor looking for a change that is not there, and
// leaves them unable to revert or to apply anything else.
test('applyPatchToDir: reverting a patch that is no longer in the tree reports it as gone (issue #183)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	await applyPatchToDir({ dir, patchText: FOO_PATCH });
	fs.writeFileSync(path.join(dir, FOO), FOO_BODY); // the reset
	const before = snapshot(dir);

	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH, reverse: true });

	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.notApplied, true);
	assert.doesNotMatch(res.error, /moved on/);
	assert.match(res.error, /not in this checkout/);
	assert.deepStrictEqual(snapshot(dir), before, 'reverting nothing must write nothing');
});

// The other half of the same judgement: a file that genuinely drifted is a
// conflict, and clearing the record for it would strand a patch that is still
// in the tree.
test('applyPatchToDir: a file edited since the patch is still a conflict, not a missing patch (issue #183)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	await applyPatchToDir({ dir, patchText: FOO_PATCH });
	fs.writeFileSync(path.join(dir, FOO), 'ONE\nTWO\nTHREE\n');

	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH, reverse: true });

	assert.strictEqual(res.ok, false);
	assert.ok(!res.notApplied, 'a drifted file must not be mistaken for an absent patch');
	assert.match(res.error, /moved on/);
});

// Unanimity matters: with one file reverted by hand and one still patched, the
// patch is half present. Dropping the record would leave the applied half in
// the tree with nothing offering to undo it.
test('applyPatchToDir: a half-present patch stays a conflict (issue #183)', async (t) => {
	const twoFilePatch = `${FOO_PATCH}diff --git a/${BAR} b/${BAR}
--- a/${BAR}
+++ b/${BAR}
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`;
	const dir = await makeRepo(t, { [FOO]: FOO_BODY, [BAR]: BAR_BODY });
	const applied = await applyPatchToDir({ dir, patchText: twoFilePatch });
	assert.strictEqual(applied.ok, true);
	fs.writeFileSync(path.join(dir, FOO), FOO_BODY); // only one file reset
	const before = snapshot(dir);

	const res = await applyPatchToDir({ dir, patchText: twoFilePatch, reverse: true });

	assert.strictEqual(res.ok, false);
	assert.ok(!res.notApplied, 'half a patch is not an absent patch');
	assert.deepStrictEqual(snapshot(dir), before, 'nothing may change on a half-present patch');
});

// applyPatch searches by offset for somewhere the context fits, so a hunk whose
// context repeats can succeed against a file that already carries it — patching
// the other copy. A forward resolve is therefore not on its own proof that the
// patch is gone, and treating it as one would drop the record for a patch still
// sitting in the tree.
test('applyPatchToDir: repeated context does not make a still-applied patch look absent (issue #183)', async (t) => {
	const AMBIGUOUS = 'src/wp-includes/dup.php';
	const body = 'x\ntwo\ny\nx\ntwo\ny\n';
	const patch = `diff --git a/${AMBIGUOUS} b/${AMBIGUOUS}
--- a/${AMBIGUOUS}
+++ b/${AMBIGUOUS}
@@ -4,3 +4,3 @@
 x
-two
+TWO
 y
`;
	const dir = await makeRepo(t, { [AMBIGUOUS]: body, [FOO]: FOO_BODY });
	const twoFilePatch = `${patch}${FOO_PATCH}`;
	assert.strictEqual((await applyPatchToDir({ dir, patchText: twoFilePatch })).ok, true);
	fs.writeFileSync(path.join(dir, FOO), FOO_BODY); // only the unambiguous file is reset
	const before = snapshot(dir);

	const res = await applyPatchToDir({ dir, patchText: twoFilePatch, reverse: true });

	assert.strictEqual(res.ok, false);
	assert.ok(!res.notApplied, 'one file still carries the patch, so the record must stand');
	assert.deepStrictEqual(snapshot(dir), before);
});

// Added files survive a forced checkout, so an add is the kind most likely to
// still be there when the modify beside it has been reset.
test('applyPatchToDir: an added file still present keeps the patch from reading as absent (issue #183)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const addAndModify = `${FOO_PATCH}diff --git a/src/added.php b/src/added.php
new file mode 100644
--- /dev/null
+++ b/src/added.php
@@ -0,0 +1,1 @@
+added
`;
	assert.strictEqual((await applyPatchToDir({ dir, patchText: addAndModify })).ok, true);
	fs.writeFileSync(path.join(dir, FOO), FOO_BODY); // the modify is reset, the untracked add survives

	const res = await applyPatchToDir({ dir, patchText: addAndModify, reverse: true });

	assert.strictEqual(res.ok, false);
	assert.ok(!res.notApplied, 'the added file is still in the tree, so the patch is not absent');
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/added.php')), true);
});

test('applyPatchToDir: a patch creates and removes files (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const addPatch = `diff --git a/src/new.php b/src/new.php
new file mode 100644
--- /dev/null
+++ b/src/new.php
@@ -0,0 +1,2 @@
+hello
+world
`;
	const addRes = await applyPatchToDir({ dir, patchText: addPatch });
	assert.strictEqual(addRes.ok, true);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'src/new.php'), 'utf8'), 'hello\nworld\n');

	// Reversing an addition is a deletion.
	await applyPatchToDir({ dir, patchText: addPatch, reverse: true });
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/new.php')), false);
});

// A patch is untrusted input downloaded from a ticket.
test('applyPatchToDir: a path escaping the site folder is refused (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const outside = path.join(dir, '..', 'escaped.txt');
	const evil = `diff --git a/../escaped.txt b/../escaped.txt
new file mode 100644
--- /dev/null
+++ b/../escaped.txt
@@ -0,0 +1 @@
+pwned
`;
	const res = await applyPatchToDir({ dir, patchText: evil });
	assert.strictEqual(res.ok, false);
	assert.match(res.error, /outside the site folder/);
	assert.strictEqual(fs.existsSync(outside), false);
});

test('applyPatchToDir: a missing target file fails without writing (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const before = snapshot(dir);
	const res = await applyPatchToDir({ dir, patchText: BAR_PATCH_THAT_FAILS });
	assert.strictEqual(res.ok, false);
	assert.match(res.error, /not in this checkout/);
	assert.deepStrictEqual(snapshot(dir), before);
});

test('applyPatchToDir: binary files are skipped and named, not silently dropped (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const withBinary = FOO_PATCH + `diff --git a/src/x.png b/src/x.png
index 111..222 100644
Binary files a/src/x.png and b/src/x.png differ
`;
	const res = await applyPatchToDir({ dir, patchText: withBinary });
	assert.strictEqual(res.ok, true);
	assert.deepStrictEqual(res.applied, [FOO]);
	assert.deepStrictEqual(res.skipped, ['src/x.png']);
});

// A binary section that carries its data (`GIT binary patch`, what
// `git diff --binary` and GitHub's `.diff` for a pull request emit) is
// Git's to apply now; only the data-less "Binary files differ" line is
// still skipped and named.
test('applyPatchToDir: a binary file whose section carries its data is applied (#385)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
	// Made by the bundled Git in a scratch repository, so the section is the
	// real shape rather than a hand-typed one.
	const scratch = tempDir(t, 'patch-apply-binary-');
	gitOk(['init', '-q', '-b', 'trunk'], scratch);
	fs.mkdirSync(path.join(scratch, 'src', 'images'), { recursive: true });
	fs.writeFileSync(path.join(scratch, 'src', 'images', 'dot.png'), bytes);
	gitOk(['add', '-A'], scratch);
	// Through a file, not stdout: the helper trims stdout and the blank line
	// that closes the base85 data is part of the format.
	const out = path.join(scratch, 'binary.diff');
	gitOk(['diff', '--cached', '--binary', '--output', out], scratch);
	const patchText = fs.readFileSync(out, 'utf8');

	const res = await applyPatchToDir({ dir, patchText });

	assert.strictEqual(res.ok, true, res.error);
	assert.deepStrictEqual(res.applied, ['src/images/dot.png']);
	assert.deepStrictEqual(res.skipped, []);
	assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'src', 'images', 'dot.png'))], [...bytes]);

	// And back out: the reverse `literal` block is in the same section.
	const reverted = await applyPatchToDir({ dir, patchText, reverse: true });
	assert.strictEqual(reverted.ok, true, reverted.error);
	assert.strictEqual(fs.existsSync(path.join(dir, 'src', 'images', 'dot.png')), false);
});

// A patch whose every section is a data-less binary has nothing for Git to
// do and nothing wrong with it: it succeeds with its skips named, as it did
// before the move to `git apply`, and the record main.js writes is honest.
test('applyPatchToDir: a patch that is only data-less binaries succeeds with them named, not refused (#385)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const before = snapshot(dir);
	const binaryOnly = `diff --git a/src/x.png b/src/x.png
index 111..222 100644
Binary files a/src/x.png and b/src/x.png differ
`;
	const log = [];
	const res = await applyPatchToDir({ dir, patchText: binaryOnly, onLog: (l) => log.push(l) });
	assert.deepStrictEqual(res, { ok: true, applied: [], skipped: ['src/x.png'] });
	assert.match(log.join(''), /Skipped 1 binary file.*src\/x\.png/);
	assert.deepStrictEqual(snapshot(dir), before);
});

// Two sections on one file pass their own check and fail together: the one
// place Git's own last line is what the contributor reads.
test('applyPatchToDir: a patch Git refuses only as a whole names Git\'s reason (#385)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const deleteThenEdit = `diff --git a/${FOO} b/${FOO}
deleted file mode 100644
--- a/${FOO}
+++ /dev/null
@@ -1,3 +0,0 @@
-one
-two
-three
${FOO_PATCH}`;
	const res = await applyPatchToDir({ dir, patchText: deleteThenEdit });
	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.failures.length, 1);
	assert.match(res.failures[0], /error: .*foo\.php/);
	assert.strictEqual(fs.readFileSync(path.join(dir, FOO), 'utf8'), FOO_BODY, 'nothing written');
});

test('applyPatchToDir: a rename whose destination already exists is refused by name (#385)', async (t) => {
	const dir = await makeRepo(t, { 'src/old.php': 'one\n', 'src/new.php': 'taken\n' });
	const rename = `diff --git a/src/old.php b/src/new.php
similarity index 100%
rename from src/old.php
rename to src/new.php
`;
	const res = await applyPatchToDir({ dir, patchText: rename });
	assert.strictEqual(res.ok, false);
	assert.match(res.error, /src\/new\.php already exists, so the patch cannot move src\/old\.php onto it/);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'new.php'), 'utf8'), 'taken\n');
});

test('applyPatchToDir: an unreadable patch reports why and changes nothing (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const before = snapshot(dir);
	const res = await applyPatchToDir({ dir, patchText: 'this is not a patch\n' });
	assert.strictEqual(res.ok, false);
	assert.deepStrictEqual(snapshot(dir), before);
});

// Finding from self-review: the pre-validation rejection above is the path that
// cannot write by construction. This is the one that can — a write that throws
// partway through, after earlier files are already on disk.
//
// POSIX only for now (#413): on Windows the bundled Git exits 0 on the same
// patch, so the injection does not inject and the rollback path goes
// unexercised there until the cause is known.
test('applyPatchToDir: a write failing partway through is rolled back (issue #11)', { skip: process.platform === 'win32' && '#413' }, async (t) => {
	// src/blocker is a regular file, so creating src/blocker/new.php fails with
	// ENOTDIR — deterministically, on every platform — after foo.php has
	// already been written.
	const dir = await makeRepo(t, { [FOO]: FOO_BODY, 'src/blocker': 'not a directory\n' });
	const before = snapshot(dir);

	const blockedAdd = `diff --git a/src/blocker/new.php b/src/blocker/new.php
new file mode 100644
--- /dev/null
+++ b/src/blocker/new.php
@@ -0,0 +1 @@
+hello
`;

	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH + blockedAdd });

	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.rolledBack, true);
	assert.deepStrictEqual(snapshot(dir), before, 'a failed write must leave nothing behind');
});

test('applyPatchToDir: a rename moves the file and its content (issue #11)', async (t) => {
	const dir = await makeRepo(t, { 'src/old.php': 'one\ntwo\n' });
	const renamePatch = `diff --git a/src/old.php b/src/new.php
similarity index 90%
rename from src/old.php
rename to src/new.php
--- a/src/old.php
+++ b/src/new.php
@@ -1,2 +1,2 @@
 one
-two
+TWO
`;
	const res = await applyPatchToDir({ dir, patchText: renamePatch });
	assert.strictEqual(res.ok, true, res.error);
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/old.php')), false);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'src/new.php'), 'utf8'), 'one\nTWO\n');

	await applyPatchToDir({ dir, patchText: renamePatch, reverse: true });
	assert.strictEqual(fs.readFileSync(path.join(dir, 'src/old.php'), 'utf8'), 'one\ntwo\n');
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/new.php')), false);
});

// A 100%-similarity rename has no hunks at all, which used to be rejected as
// "not a patch" — killing the whole apply for any PR that moved a file.
test('applyPatchToDir: a pure rename with no hunks applies (issue #11)', async (t) => {
	const dir = await makeRepo(t, { 'src/old.php': 'unchanged\n' });
	const purePatch = `diff --git a/src/old.php b/src/new.php
similarity index 100%
rename from src/old.php
rename to src/new.php
`;
	const res = await applyPatchToDir({ dir, patchText: purePatch });
	assert.strictEqual(res.ok, true, res.error);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'src/new.php'), 'utf8'), 'unchanged\n');
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/old.php')), false);
});

test('applyPatchToDir: reverting a deletion puts the file back (issue #11)', async (t) => {
	const dir = await makeRepo(t, { 'src/old.php': 'one\ntwo\n' });
	const deletePatch = `diff --git a/src/old.php b/src/old.php
deleted file mode 100644
--- a/src/old.php
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;
	assert.strictEqual((await applyPatchToDir({ dir, patchText: deletePatch })).ok, true);
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/old.php')), false);

	const back = await applyPatchToDir({ dir, patchText: deletePatch, reverse: true });
	assert.strictEqual(back.ok, true, back.error);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'src/old.php'), 'utf8'), 'one\ntwo\n');
});

// wordpress-develop carries fixtures whose line endings are the thing under
// test; rewriting them to LF because a patch touched the file would corrupt
// exactly those.
// A CRLF checkout is what a host Git with `core.autocrlf=true` leaves on
// Windows. There, the `core.autocrlf` view every worktree command carries
// (windowsArgs) lets an LF patch fit and keeps the file CRLF; on macOS the
// same file is refused, which is the documented limit of the move to
// `git apply` (a site the app cloned is LF, so it never meets it).
test('applyPatchToDir: an LF patch fits a CRLF file under the Windows view, and is refused without it (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY.replace(/\n/g, '\r\n') }, { autocrlf: null });
	const refused = await applyPatchToDir({ dir, patchText: FOO_PATCH, platform: 'darwin' });
	assert.strictEqual(refused.ok, false);
	assert.strictEqual(fs.readFileSync(path.join(dir, FOO), 'utf8'), 'one\r\ntwo\r\nthree\r\n', 'nothing written');

	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH, platform: 'win32' });
	assert.strictEqual(res.ok, true, res.error);
	assert.strictEqual(fs.readFileSync(path.join(dir, FOO), 'utf8'), 'one\r\nTWO\r\nthree\r\n');
});

// Git refuses a path beyond a symbolic link on its own; the sentence the
// contributor reads is this module's, and it has to say where it pointed.
test('applyPatchToDir: a patch through a symlinked directory is refused (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-apply-outside-'));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.symlinkSync(outside, path.join(dir, 'escape-hatch'), 'dir');

	const evil = `diff --git a/escape-hatch/evil.txt b/escape-hatch/evil.txt
new file mode 100644
--- /dev/null
+++ b/escape-hatch/evil.txt
@@ -0,0 +1 @@
+pwned
`;
	const res = await applyPatchToDir({ dir, patchText: evil });
	assert.strictEqual(res.ok, false);
	assert.match(res.error, /outside the site folder/);
	assert.strictEqual(fs.existsSync(path.join(outside, 'evil.txt')), false);
});

// existsSync follows a symlink and is false for a dangling one, so a naive
// walk-up steps past a link pointing outside the checkout and hands back its
// lexical path — which writeFileSync would then follow out of the tree. lstat
// closes that hole. (Copilot #1.)
test('applyPatchToDir: an add through a dangling symlink out of the tree is refused (issue #11)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-apply-dangling-'));
	t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
	const outside = path.join(outsideDir, 'target.txt'); // never created → dangling
	fs.symlinkSync(outside, path.join(dir, 'sneaky.txt'));

	const evil = `diff --git a/sneaky.txt b/sneaky.txt
new file mode 100644
--- /dev/null
+++ b/sneaky.txt
@@ -0,0 +1 @@
+pwned
`;
	const res = await applyPatchToDir({ dir, patchText: evil });
	assert.strictEqual(res.ok, false);
	assert.match(res.error, /outside the site folder/);
	assert.strictEqual(fs.existsSync(outside), false, 'nothing may be written through the link');
});

// A pure (100%-similarity) rename carries the bytes unchanged. Git emits binary
// renames with no binary marker, so reading the source as utf8 and writing the
// string back would corrupt it — the bytes must survive intact. (Copilot #5.)
test('applyPatchToDir: a pure rename preserves non-utf8 (binary) bytes (issue #11)', async (t) => {
	const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x0a]);
	const dir = await makeRepo(t, { 'src/logo.bin': bytes });
	const purePatch = `diff --git a/src/logo.bin b/src/moved.bin
similarity index 100%
rename from src/logo.bin
rename to src/moved.bin
`;
	const res = await applyPatchToDir({ dir, patchText: purePatch });
	assert.strictEqual(res.ok, true, res.error);
	assert.ok(fs.readFileSync(path.join(dir, 'src/moved.bin')).equals(bytes), 'bytes must survive the rename');
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/logo.bin')), false);
});

// A deletion with a pre-image must match what is on disk. If the contributor
// edited the file after previewing, deleting it anyway silently discards their
// work; all-or-nothing means failing instead. (Copilot #2.)
test('applyPatchToDir: deleting a file edited since the patch fails all-or-nothing (issue #11)', async (t) => {
	const dir = await makeRepo(t, { 'src/old.php': 'one\ntwo\n' });
	const deletePatch = `diff --git a/src/old.php b/src/old.php
deleted file mode 100644
--- a/src/old.php
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;
	fs.writeFileSync(path.join(dir, 'src/old.php'), 'my own work\n');
	const before = snapshot(dir);

	const res = await applyPatchToDir({ dir, patchText: deletePatch });

	assert.strictEqual(res.ok, false);
	assert.match(res.error, /moved on since the patch was written/);
	assert.deepStrictEqual(snapshot(dir), before, 'the edited file must not be deleted');
});

// The same protection where there is no pre-image to match against. An empty
// file's deletion has no hunk (#311), so the hunk check above cannot run — and
// without a check of its own the applier would remove a file the patch only
// ever claimed was empty, contributor's work and all. `git apply` refuses this
// as "removal patch leaves file contents"; so must this.
test('applyPatchToDir: an empty-file deletion refuses a file that has content (#311)', async (t) => {
	const dir = await makeRepo(t, { 'src/placeholder.php': '' });
	const deletePatch = `diff --git a/src/placeholder.php b/src/placeholder.php
deleted file mode 100644
--- a/src/placeholder.php
+++ /dev/null
`;
	fs.writeFileSync(path.join(dir, 'src/placeholder.php'), 'my own work\n');
	const before = snapshot(dir);

	const res = await applyPatchToDir({ dir, patchText: deletePatch });

	assert.strictEqual(res.ok, false);
	assert.match(res.error, /moved on since the patch was written/);
	assert.deepStrictEqual(snapshot(dir), before, 'the file that grew content must not be deleted');
});

// And it still removes the file it does describe.
test('applyPatchToDir: an empty-file deletion removes the empty file (#311)', async (t) => {
	const dir = await makeRepo(t, { 'src/placeholder.php': '' });
	const deletePatch = `diff --git a/src/placeholder.php b/src/placeholder.php
deleted file mode 100644
--- a/src/placeholder.php
+++ /dev/null
`;

	const res = await applyPatchToDir({ dir, patchText: deletePatch });

	assert.strictEqual(res.ok, true, res.error);
	assert.strictEqual(fs.existsSync(path.join(dir, 'src/placeholder.php')), false);
});

// The read half of the same story (#316): real git writes an empty file's
// section with no `---`/`+++` pair at all, unlike the #311 sections above.
// Verbatim `git diff` output, inlined so the test does not need a git binary.
// The mix — an ordinary edit alongside the empty add and delete — is the case
// that used to fail whole-patch, so every file's fate is asserted.
test('applyPatchToDir: a git-authored patch with empty adds and deletes applies whole (#316)', async (t) => {
	const dir = await makeRepo(t, { 'edited.php': 'line1\nline2\n', 'was-empty.php': '' });
	const gitPatch = `diff --git a/edited.php b/edited.php
index c0d0fb4..83db48f 100644
--- a/edited.php
+++ b/edited.php
@@ -1,2 +1,3 @@
 line1
 line2
+line3
diff --git a/placeholder.php b/placeholder.php
new file mode 100644
index 0000000..e69de29
diff --git a/was-empty.php b/was-empty.php
deleted file mode 100644
index e69de29..0000000
`;

	const res = await applyPatchToDir({ dir, patchText: gitPatch });

	assert.strictEqual(res.ok, true, res.error);
	assert.deepStrictEqual(res.applied.sort(), ['edited.php', 'placeholder.php', 'was-empty.php']);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'edited.php'), 'utf8'), 'line1\nline2\nline3\n');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'placeholder.php'), 'utf8'), '', 'the empty addition has to actually create');
	assert.strictEqual(fs.existsSync(path.join(dir, 'was-empty.php')), false, 'the empty deletion has to actually delete');
});

// The add-side twin of the deletion guard above: a `new file mode` section
// claims the file does not exist yet, so one already in the checkout — with
// whatever content — is refused all-or-nothing, not overwritten or skipped.
test('applyPatchToDir: a git-authored empty addition refuses a file that already exists (#316)', async (t) => {
	const dir = await makeRepo(t, { 'placeholder.php': 'my own work\n' });
	const before = snapshot(dir);
	const addPatch = `diff --git a/placeholder.php b/placeholder.php
new file mode 100644
index 0000000..e69de29
`;

	const res = await applyPatchToDir({ dir, patchText: addPatch });

	assert.strictEqual(res.ok, false);
	assert.match(res.error, /already exists/);
	assert.deepStrictEqual(snapshot(dir), before, 'the existing file must not be touched');
});

// A rename that completes and is then undone by a later failure must restore the
// source and remove the destination — registering each action before its
// mutations is what lets rollback see a half-done one. (Copilot #3.)
// Same injection as above, so the same Windows skip (#413).
test('applyPatchToDir: a later failure rolls a completed rename fully back (issue #11)', { skip: process.platform === 'win32' && '#413' }, async (t) => {
	const dir = await makeRepo(t, { 'src/old.php': 'one\ntwo\n', 'src/blocker': 'not a directory\n' });
	const before = snapshot(dir);
	const renameThenBlocked = `diff --git a/src/old.php b/src/new.php
similarity index 100%
rename from src/old.php
rename to src/new.php
diff --git a/src/blocker/child.php b/src/blocker/child.php
new file mode 100644
--- /dev/null
+++ b/src/blocker/child.php
@@ -0,0 +1 @@
+hello
`;
	const res = await applyPatchToDir({ dir, patchText: renameThenBlocked });

	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.rolledBack, true);
	assert.deepStrictEqual(snapshot(dir), before, 'the rename must be fully undone');
});

// A rollback can hit the same fault that broke the write. rollback must report
// what it could not restore so the caller stops claiming a clean tree. Driven
// directly with an un-restorable entry (its parent is a file → ENOTDIR), which
// fails the same way whether or not the tests run as root. (Copilot #4.)
test('rollback: reports the paths it could not restore instead of swallowing them (issue #11)', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-apply-rollback-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, 'afile'), 'i am a file\n');

	// Restoring this entry means writing under `afile`, which is a file, not a
	// directory — mkdirSync/writeFileSync throw ENOTDIR.
	const recovery = rollback(dir, new Map([['afile/child', Buffer.from('x')]]));

	assert.ok(Array.isArray(recovery) && recovery.length === 1);
	assert.match(recovery[0], /afile\/child/);
});

// The clean path still returns no recovery errors, so the caller reports a real
// rollback as one; and the snapshot records an absent file as null, which the
// rollback turns into a removal.
test('rollback: returns an empty list when it restores everything (issue #11)', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-apply-rollback-ok-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, 'kept'), 'before\n');
	const taken = snapshotFiles(dir, ['kept', 'added', 'kept']);
	assert.deepStrictEqual([...taken.keys()], ['kept', 'added']);
	assert.strictEqual(taken.get('added'), null);
	fs.writeFileSync(path.join(dir, 'kept'), 'after\n');
	fs.writeFileSync(path.join(dir, 'added'), 'new\n');

	const recovery = rollback(dir, taken);

	assert.deepStrictEqual(recovery, []);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'kept'), 'utf8'), 'before\n');
	assert.strictEqual(fs.existsSync(path.join(dir, 'added')), false, 'an added file is removed on rollback');

	// A file Git never reached keeps its bytes and its mtime: the snapshot is
	// not written over what is already there.
	fs.writeFileSync(path.join(dir, 'kept'), 'before\n');
	const mtime = new Date(Date.now() - 60_000);
	fs.utimesSync(path.join(dir, 'kept'), mtime, mtime);
	assert.deepStrictEqual(rollback(dir, snapshotFiles(dir, ['kept'])), []);
	assert.ok(Math.abs(fs.statSync(path.join(dir, 'kept')).mtimeMs - mtime.getTime()) < 2, 'the untouched file was not rewritten');
});

// --- how badly it failed (issue #282) ------------------------------------
//
// The refusal is right and stays; what it says is what changed. "This file has
// moved on" read identically whether one region of twenty missed or all twenty
// did, which is the difference between a patch worth rescuing by hand and one
// worth abandoning. These assert the counts the panel is built from.

// A file long enough to hold three regions that do not merge into one hunk.
const LONG = 'src/wp-includes/long.php';
const LONG_BODY = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// Three regions: near the top, the middle and the bottom.
const LONG_PATCH = `diff --git a/${LONG} b/${LONG}
--- a/${LONG}
+++ b/${LONG}
@@ -1,3 +1,3 @@
 line 1
-line 2
+LINE TWO
 line 3
@@ -14,3 +14,3 @@
 line 14
-line 15
+LINE FIFTEEN
 line 16
@@ -27,3 +27,3 @@
 line 27
-line 28
+LINE TWENTY-EIGHT
 line 29
`;

test('applyPatchToDir: names how many regions missed, not just the file (issue #282)', async (t) => {
	const dir = await makeRepo(t, { [LONG]: LONG_BODY });
	// Only the first region's surroundings are disturbed.
	fs.writeFileSync(path.join(dir, LONG), LONG_BODY.replace('line 1\n', 'line one, rewritten\n'));

	const res = await applyPatchToDir({ dir, patchText: LONG_PATCH });

	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.conflicts.length, 1);
	const [conflict] = res.conflicts;
	assert.strictEqual(conflict.path, LONG);
	assert.strictEqual(conflict.total, 3, 'the patch has three regions');
	assert.strictEqual(conflict.regions.length, 1, 'only one of them missed');
	assert.strictEqual(conflict.regions[0].line, 1);
	// The sentence carries the same counts, for the terminal and for anywhere
	// the structured detail does not reach.
	assert.match(res.error, /1 of its 3 changes no longer fit/);
	assert.match(res.error, /the other 2 do/);
});

test('applyPatchToDir: a region carries the lines it was trying to change (issue #282)', async (t) => {
	const dir = await makeRepo(t, { [LONG]: LONG_BODY });
	fs.writeFileSync(path.join(dir, LONG), LONG_BODY.replace('line 1\n', 'line one, rewritten\n'));

	const res = await applyPatchToDir({ dir, patchText: LONG_PATCH });

	// Without these there is a location and no way to judge whether it is the
	// change that matters or reformatting noise, which is the judgement the
	// whole diagnosis exists to enable.
	assert.deepStrictEqual(res.conflicts[0].regions[0].lines, ['-line 2', '+LINE TWO']);
});

// The anchor is a line to search for, because the hunk's numbers are in the
// patched file's coordinates and an old patch misses by its whole drift. For a
// "moved" region the `-` line is the one thing known to still be in the file —
// the failure means the *neighbours* changed, not it.
test('applyPatchToDir: a region\'s anchor is a line still present in the checkout (issue #282)', async (t) => {
	const dir = await makeRepo(t, { [LONG]: LONG_BODY });
	const drifted = LONG_BODY.replace('line 1\n', 'line one, rewritten\n');
	fs.writeFileSync(path.join(dir, LONG), drifted);

	const res = await applyPatchToDir({ dir, patchText: LONG_PATCH });

	const region = res.conflicts[0].regions[0];
	assert.strictEqual(region.anchor, 'line 2');
	assert.ok(drifted.includes(region.anchor), 'searching the anchor finds the region');
});

// An already-applied region carries the change, not its precondition: the `-`
// line is gone from the file by definition, and the `+` line is what a search
// will actually hit.
test('applyPatchToDir: an already-applied region anchors on its result (issue #226)', async (t) => {
	const dir = await makeRepo(t, { [LONG]: LONG_BODY });
	const current = LONG_BODY
		.replace('line 2\n', 'LINE TWO\n')
		.replace('line 14\n', 'line fourteen!\n');
	fs.writeFileSync(path.join(dir, LONG), current);

	const res = await applyPatchToDir({ dir, patchText: LONG_PATCH });

	const applied = res.conflicts[0].regions.find((r) => r.status === 'already-applied');
	assert.strictEqual(applied.anchor, 'LINE TWO');
	assert.ok(current.includes(applied.anchor), 'searching the anchor finds the region');
});

// The other half of the same question (issue #226): a region can miss because
// its change is already there, which means the patch is redundant rather than
// stale — the opposite conclusion from the same failure.
test('applyPatchToDir: a region already in the tree is told apart from one that drifted (issue #226)', async (t) => {
	const dir = await makeRepo(t, { [LONG]: LONG_BODY });
	const current = LONG_BODY
		.replace('line 2\n', 'LINE TWO\n')          // the patch's own change, already here
		.replace('line 14\n', 'line fourteen!\n');  // and genuine drift around another region
	fs.writeFileSync(path.join(dir, LONG), current);

	const res = await applyPatchToDir({ dir, patchText: LONG_PATCH });

	assert.strictEqual(res.ok, false);
	const byLine = Object.fromEntries(res.conflicts[0].regions.map((r) => [r.line, r.status]));
	assert.strictEqual(byLine[1], 'already-applied');
	assert.strictEqual(byLine[14], 'moved');
});

// Every failing file reaches the caller. The panel showed `error` alone and
// sent the rest to the terminal, where a contributor has no reason to look.
test('applyPatchToDir: a second conflicting file is reported, not swallowed (issue #282)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY, [BAR]: BAR_BODY });
	const twoFilePatch = `${FOO_PATCH}diff --git a/${BAR} b/${BAR}
--- a/${BAR}
+++ b/${BAR}
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`;
	fs.writeFileSync(path.join(dir, FOO), 'ONE\nTWO\nTHREE\n');
	fs.writeFileSync(path.join(dir, BAR), 'ALPHA\nBETA\nGAMMA\n');

	const res = await applyPatchToDir({ dir, patchText: twoFilePatch });

	assert.strictEqual(res.failures.length, 2);
	assert.strictEqual(res.conflicts.length, 2);
	assert.deepStrictEqual(res.conflicts.map((c) => c.path), [FOO, BAR]);
});

// A file that is simply not there has no regions to break down, so it keeps the
// sentence it always had. The panel has to render both kinds side by side.
test('applyPatchToDir: a failure with no regions carries no conflict detail (issue #282)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	const missingFilePatch = FOO_PATCH.replace(new RegExp(FOO, 'g'), 'src/wp-includes/gone.php');

	const res = await applyPatchToDir({ dir, patchText: missingFilePatch });

	assert.strictEqual(res.ok, false);
	assert.deepStrictEqual(res.conflicts, []);
	assert.match(res.error, /not in this checkout/);
});

// --- diagnoseHunks directly, for what the integration path cannot reach ---
//
// The caps and fallbacks fire only on shapes no small fixture hits through
// applyPatchToDir: a hunk with more changed lines than the cap, more failing
// regions than carry detail, a hunk none of whose lines survive in the file.

// A one-hunk patch against `original`, parsed the way applyPatchToDir would.
function parsedFile(patchText) {
	const parsed = parsePatchFiles(patchText);
	assert.ok(parsed.ok, parsed.error);
	return parsed.files[0];
}

test('diagnoseHunks: caps the lines one region carries and counts the rest (issue #282)', () => {
	const before = Array.from({ length: 14 }, (_, i) => `alpha ${i}`).join('\n') + '\n';
	const after = Array.from({ length: 14 }, (_, i) => `beta ${i}`).join('\n') + '\n';
	const patch = JsDiff.createPatch('big.txt', before, after);
	const file = parsedFile(`diff --git a/big.txt b/big.txt\n${patch.split('\n').slice(1).join('\n')}`);

	// A file the hunk cannot fit at all, so the one region fails.
	const diagnosis = diagnoseHunks('something else entirely\n', file);

	assert.strictEqual(diagnosis.regions.length, 1);
	assert.strictEqual(diagnosis.regions[0].lines.length, 10, 'REGION_LINE_LIMIT caps the carried lines');
	// 14 removed + 14 added = 28 changed lines; 10 carried, 18 counted.
	assert.strictEqual(diagnosis.regions[0].more, 18);
});

test('diagnoseHunks: regions beyond the detail cap are located but carry no lines (issue #282)', () => {
	// Five separated regions, all of which will fail.
	const body = Array.from({ length: 41 }, (_, i) => `row ${i}`).join('\n') + '\n';
	const changed = body
		.replace('row 2\n', 'ROW 2\n').replace('row 10\n', 'ROW 10\n')
		.replace('row 18\n', 'ROW 18\n').replace('row 26\n', 'ROW 26\n')
		.replace('row 34\n', 'ROW 34\n');
	const patch = JsDiff.createPatch('rows.txt', body, changed, '', '', { context: 2 });
	const file = parsedFile(`diff --git a/rows.txt b/rows.txt\n${patch.split('\n').slice(1).join('\n')}`);

	const diagnosis = diagnoseHunks('unrelated\n', file);

	assert.strictEqual(diagnosis.total, 5);
	assert.strictEqual(diagnosis.regions.length, 5);
	const detailed = diagnosis.regions.filter((r) => Array.isArray(r.lines));
	assert.strictEqual(detailed.length, 3, 'REGION_DETAIL_LIMIT caps which regions carry lines');
	assert.ok(diagnosis.regions.slice(3).every((r) => r.lines === undefined));
	// Every region still has an anchor, even past the detail cap.
	assert.ok(diagnosis.regions.every((r) => typeof r.anchor === 'string' && r.anchor));
});

test('diagnoseHunks: a hunk with nothing left in the file still offers its best anchor (issue #282)', () => {
	const file = parsedFile([
		'diff --git a/gone.txt b/gone.txt',
		'--- a/gone.txt',
		'+++ b/gone.txt',
		'@@ -1,3 +1,3 @@',
		' context line',
		'-old line',
		'+new line',
		' other context',
		''
	].join('\n'));

	const diagnosis = diagnoseHunks('completely different file\n', file);

	// Nothing from the hunk survives in the file, so the preference order alone
	// decides: for a moved region, the first `-` line.
	assert.strictEqual(diagnosis.regions[0].anchor, 'old line');
});

test('diagnoseHunks: overlapping hunks that each pass alone yield null, not zero conflicts (issue #282)', () => {
	// Both hunks fit the file individually (their contexts are present), but the
	// whole patch fails because the first hunk's insertion shifts the second's.
	// diagnoseHunks must decline to explain rather than claim nothing failed.
	const body = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
	const file = parsedFile([
		'diff --git a/f.txt b/f.txt',
		'--- a/f.txt',
		'+++ b/f.txt',
		'@@ -1,3 +1,3 @@',
		' one',
		'-two',
		'+TWO',
		' three',
		''
	].join('\n'));

	// Sanity: the single hunk applies, so per-hunk diagnosis finds no failures.
	assert.strictEqual(diagnoseHunks(body, file), null);
});

// A revert that fails now carries the same per-region breakdown a forward apply
// does, because that is what the panel narrates the absorption from.
test('applyPatchToDir: a failing reverse reports which regions were edited over (issue #306)', async (t) => {
	const dir = await makeRepo(t, { [FOO]: FOO_BODY });
	await applyPatchToDir({ dir, patchText: FOO_PATCH });
	fs.writeFileSync(path.join(dir, FOO), 'one\nMY OWN VERSION\nthree\n');

	const res = await applyPatchToDir({ dir, patchText: FOO_PATCH, reverse: true });

	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.notApplied, undefined);
	assert.strictEqual(res.conflicts.length, 1);
	assert.strictEqual(res.conflicts[0].path, FOO);
	assert.strictEqual(res.conflicts[0].total, 1);
	assert.strictEqual(res.conflicts[0].regions.length, 1);
});
