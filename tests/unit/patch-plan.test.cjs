'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
	stripPathPrefix,
	mapToSrcLayout,
	parsePatchFiles,
	splitPatchSections,
	rewritePatchPaths,
	planApply
} = require('../../src/patch-plan.cjs');
const { updateStepStatuses, SKIP_INSTALL_MESSAGE, BUILD_BY_WATCHER_MESSAGE, planApplySteps, planWatchImpact, APPLY_STATE_TO_STEP } = require('../../src/renderer/update-plan.cjs');

// The four header shapes that actually reach the app. Kept verbatim rather than
// generated: the whole point of these tests is that real-world formatting —
// tabs before "(revision N)", missing a/ b/ prefixes, /dev/null sides — is
// handled, and a generator would only produce the shape we already expect.
const GITHUB_DIFF = `diff --git a/src/wp-includes/foo.php b/src/wp-includes/foo.php
index 384bf9e..dbfa038 100644
--- a/src/wp-includes/foo.php
+++ b/src/wp-includes/foo.php
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;

const TRAC_SVN_DIFF = `Index: src/wp-includes/foo.php
===================================================================
--- src/wp-includes/foo.php\t(revision 59234)
+++ src/wp-includes/foo.php\t(working copy)
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;

const OLD_LAYOUT_DIFF = `Index: wp-admin/admin.php
===================================================================
--- wp-admin/admin.php\t(revision 1)
+++ wp-admin/admin.php\t(working copy)
@@ -1,2 +1,2 @@
 x
-y
+Y
`;

const ADD_DIFF = `diff --git a/src/new.php b/src/new.php
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/new.php
@@ -0,0 +1,2 @@
+one
+two
`;

const DELETE_DIFF = `diff --git a/src/old.php b/src/old.php
deleted file mode 100644
--- a/src/old.php
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

const BINARY_DIFF = `diff --git a/src/x.png b/src/x.png
index 111..222 100644
Binary files a/src/x.png and b/src/x.png differ
`;

test('parsePatchFiles: a GitHub pull request diff resolves to a repo-relative path (issue #11)', () => {
	const res = parsePatchFiles(GITHUB_DIFF);
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.files.length, 1);
	assert.strictEqual(res.files[0].path, 'src/wp-includes/foo.php');
	assert.strictEqual(res.files[0].kind, 'modify');
});

// The bug this guards: Subversion patches carry no a/ b/ prefix, so stripping
// two characters unconditionally would write to "c/wp-includes/foo.php".
test('parsePatchFiles: a Subversion-style Trac attachment keeps its full path (issue #11)', () => {
	const res = parsePatchFiles(TRAC_SVN_DIFF);
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.files[0].path, 'src/wp-includes/foo.php');
});

test('parsePatchFiles: both formats agree on the same target path (issue #11)', () => {
	assert.strictEqual(
		parsePatchFiles(GITHUB_DIFF).files[0].path,
		parsePatchFiles(TRAC_SVN_DIFF).files[0].path
	);
});

test('parsePatchFiles: a patch against the pre-src layout is remapped (issue #11)', () => {
	const res = parsePatchFiles(OLD_LAYOUT_DIFF);
	assert.strictEqual(res.files[0].path, 'src/wp-admin/admin.php');
});

test('parsePatchFiles: added and deleted files are classified, not treated as renames (issue #11)', () => {
	const added = parsePatchFiles(ADD_DIFF).files[0];
	assert.strictEqual(added.kind, 'add');
	assert.strictEqual(added.path, 'src/new.php');

	const deleted = parsePatchFiles(DELETE_DIFF).files[0];
	assert.strictEqual(deleted.kind, 'delete');
	// A deletion's target is the file that exists today, not /dev/null.
	assert.strictEqual(deleted.path, 'src/old.php');
});

// --- empty files as real git writes them (#316) ----------------------------
//
// Real git carries an added or deleted empty file as headers alone: no
// `---`/`+++` pair at all, the fate on the `new file mode` / `deleted file
// mode` line. The fixtures below are verbatim `git diff` output (git 2.x in a
// scratch repo), inlined so the tests do not need a git binary; #311's own
// sections keep the `---`/`+++` pair and are covered in ipc-wiring.test.cjs.
const GIT_EMPTY_ADD_DIFF = `diff --git a/placeholder.php b/placeholder.php
new file mode 100644
index 0000000..e69de29
`;

const GIT_EMPTY_DELETE_NO_INDEX_DIFF = `diff --git a/was-empty.php b/was-empty.php
deleted file mode 100644
`;

const GIT_MIXED_EMPTY_DIFF = `diff --git a/edited.php b/edited.php
index c0d0fb4..83db48f 100644
--- a/edited.php
+++ b/edited.php
@@ -1,2 +1,3 @@
 line1
 line2
+line3
diff --git a/new file.php b/new file.php
new file mode 100644
index 0000000..e69de29
diff --git a/placeholder.php b/placeholder.php
new file mode 100644
index 0000000..e69de29
diff --git a/was-empty.php b/was-empty.php
deleted file mode 100644
index e69de29..0000000
`;

test('parsePatchFiles: a git-authored empty addition parses as an add (#316)', () => {
	const res = parsePatchFiles(GIT_EMPTY_ADD_DIFF);
	assert.strictEqual(res.ok, true, res.error);
	assert.deepStrictEqual(res.files.map((f) => [f.kind, f.path]), [['add', 'placeholder.php']]);
});

test('parsePatchFiles: a git-authored empty deletion parses as a delete, with or without an index line (#316)', () => {
	const res = parsePatchFiles(GIT_EMPTY_DELETE_NO_INDEX_DIFF);
	assert.strictEqual(res.ok, true, res.error);
	assert.deepStrictEqual(res.files.map((f) => [f.kind, f.path]), [['delete', 'was-empty.php']]);

	const withIndex = parsePatchFiles('diff --git a/was-empty.php b/was-empty.php\ndeleted file mode 100644\nindex e69de29..0000000\n');
	assert.strictEqual(withIndex.ok, true, withIndex.error);
	assert.deepStrictEqual(withIndex.files.map((f) => [f.kind, f.path]), [['delete', 'was-empty.php']]);
});

// The whole point of the fix: one empty-file section used to reject the entire
// patch when it came last, and to vanish silently when another section
// followed it — either way the unrelated files went with it. The full list is
// what proves both failure modes gone.
test('parsePatchFiles: one git-authored empty file does not take the rest of the patch down (#316)', () => {
	const res = parsePatchFiles(GIT_MIXED_EMPTY_DIFF);
	assert.strictEqual(res.ok, true, res.error);
	assert.deepStrictEqual(res.files.map((f) => [f.kind, f.path]), [
		['modify', 'edited.php'],
		// A path with a space stays whole: for an add or a delete both sides of
		// the `diff --git` line are the same path, so the split is unambiguous.
		['add', 'new file.php'],
		['add', 'placeholder.php'],
		['delete', 'was-empty.php']
	]);
});

test('parsePatchFiles: an empty add ahead of other sections keeps them all (#316)', () => {
	const res = parsePatchFiles(GIT_EMPTY_ADD_DIFF + GITHUB_DIFF);
	assert.strictEqual(res.ok, true, res.error);
	assert.deepStrictEqual(res.files.map((f) => [f.kind, f.path]), [
		['add', 'placeholder.php'],
		['modify', 'src/wp-includes/foo.php']
	]);
});

// A binary addition carries `new file mode` too. Its fate is the binary
// marker's, not the mode line's — rewriting it as an empty text add would
// report success while silently writing an empty file in an image's place.
test('parsePatchFiles: a binary addition with new file mode stays binary (#316)', () => {
	const res = parsePatchFiles('diff --git a/x.png b/x.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/x.png differ\n');
	assert.strictEqual(res.ok, true, res.error);
	assert.deepStrictEqual(res.files.map((f) => [f.kind, f.path]), [['binary', 'x.png']]);
});

test('parsePatchFiles: an undecodable quoted empty-file section rejects the whole mixed patch (#316)', () => {
	const quotedEmpty = 'diff --git "a/empty\\303\\251.txt" "b/empty\\303\\251.txt"\nnew file mode 100644\nindex 0000000..e69de29\n';
	const res = parsePatchFiles(quotedEmpty + GITHUB_DIFF);

	assert.strictEqual(res.ok, false);
	assert.match(res.error, /empty file path/i);
});

// jsdiff represents a binary file as an entry with no hunks. Left unchecked
// that reads as "a file with no changes", so applying would report success
// while silently skipping it.
test('parsePatchFiles: a binary file is reported as binary rather than an empty change (issue #11)', () => {
	const res = parsePatchFiles(BINARY_DIFF);
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.files[0].kind, 'binary');
});

test('parsePatchFiles: empty and unreadable input is rejected with a reason (issue #11)', () => {
	for (const empty of ['', '   ', null, undefined]) {
		const res = parsePatchFiles(empty);
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error, 'The patch is empty.');
	}
	const notAPatch = parsePatchFiles('this is just prose, not a diff at all\n');
	assert.strictEqual(notAPatch.ok, false);
});

test('parsePatchFiles: CRLF line endings parse the same as LF (issue #11)', () => {
	const crlf = GITHUB_DIFF.replace(/\n/g, '\r\n');
	const res = parsePatchFiles(crlf);
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.files[0].path, 'src/wp-includes/foo.php');
});

test('parsePatchFiles: a multi-file patch yields one entry per file (issue #11)', () => {
	const res = parsePatchFiles(GITHUB_DIFF + ADD_DIFF + DELETE_DIFF);
	assert.strictEqual(res.ok, true);
	assert.deepStrictEqual(res.files.map((f) => f.kind), ['modify', 'add', 'delete']);
});

test('stripPathPrefix: only strips when both sides are prefixed (issue #11)', () => {
	assert.deepStrictEqual(
		stripPathPrefix('a/src/foo.php', 'b/src/foo.php'),
		{ oldPath: 'src/foo.php', newPath: 'src/foo.php' }
	);
	assert.deepStrictEqual(
		stripPathPrefix('src/foo.php', 'src/foo.php'),
		{ oldPath: 'src/foo.php', newPath: 'src/foo.php' }
	);
	// /dev/null counts as agreement — an added file has only one real side.
	assert.deepStrictEqual(
		stripPathPrefix('/dev/null', 'b/src/new.php'),
		{ oldPath: '/dev/null', newPath: 'src/new.php' }
	);
});

test('stripPathPrefix: an old Subversion trunk/ prefix is dropped (issue #11)', () => {
	assert.deepStrictEqual(
		stripPathPrefix('trunk/wp-admin/admin.php', 'trunk/wp-admin/admin.php'),
		{ oldPath: 'wp-admin/admin.php', newPath: 'wp-admin/admin.php' }
	);
});

test('mapToSrcLayout: modern paths are left alone (issue #11)', () => {
	for (const p of ['src/wp-includes/foo.php', 'tests/phpunit/bar.php', 'tools/baz.js']) {
		assert.strictEqual(mapToSrcLayout(p), p);
	}
});

test('mapToSrcLayout: root-level build files stay at the root (issue #11)', () => {
	for (const p of ['package.json', 'Gruntfile.js', '.editorconfig', 'wp-cli.yml', 'wp-tests-config-sample.php']) {
		assert.strictEqual(mapToSrcLayout(p), p);
	}
});

// wp-cli.yml and wp-config-sample.php both start with "wp-" but did not move.
// This is the case the bare wp-* rule gets wrong without the exception list.
test('mapToSrcLayout: wp-prefixed files move to src, except the ones that did not (issue #11)', () => {
	assert.strictEqual(mapToSrcLayout('wp-admin/admin.php'), 'src/wp-admin/admin.php');
	assert.strictEqual(mapToSrcLayout('wp-includes/post.php'), 'src/wp-includes/post.php');
	assert.strictEqual(mapToSrcLayout('wp-cli.yml'), 'wp-cli.yml');
	assert.strictEqual(mapToSrcLayout('wp-config-sample.php'), 'wp-config-sample.php');
});

test('mapToSrcLayout: the loose root files that did move are remapped (issue #11)', () => {
	assert.strictEqual(mapToSrcLayout('index.php'), 'src/index.php');
	assert.strictEqual(mapToSrcLayout('xmlrpc.php'), 'src/xmlrpc.php');
	assert.strictEqual(mapToSrcLayout('license.txt'), 'src/license.txt');
});

test('mapToSrcLayout: an unrecognised path is left alone rather than guessed (issue #11)', () => {
	assert.strictEqual(mapToSrcLayout('some/other/thing.php'), 'some/other/thing.php');
});

test('planApply: only files the contributor already edited count as conflicts (issue #11)', () => {
	const { files } = parsePatchFiles(GITHUB_DIFF + ADD_DIFF);
	const plan = planApply({ files, dirtyPaths: ['src/wp-includes/foo.php', 'src/unrelated.php'] });
	assert.deepStrictEqual(plan.paths, ['src/wp-includes/foo.php', 'src/new.php']);
	assert.deepStrictEqual(plan.conflicts, ['src/wp-includes/foo.php']);
});

test('planApply: a clean tree has no conflicts (issue #11)', () => {
	const { files } = parsePatchFiles(GITHUB_DIFF);
	assert.deepStrictEqual(planApply({ files, dirtyPaths: [] }).conflicts, []);
});

test('planApply: binary files with no data are listed as unsupported, ones that carry their bytes are not (issue #11, #385)', () => {
	const { files } = parsePatchFiles(GITHUB_DIFF + BINARY_DIFF);
	assert.deepStrictEqual(planApply({ files }).unsupported, ['src/x.png']);
	const withData = 'diff --git a/src/y.png b/src/y.png\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 8\nPcmeAS@N;KiWMT#Y3Bdt%\n\nliteral 0\nHcmV?d00001\n\n';
	const parsed = parsePatchFiles(GITHUB_DIFF + BINARY_DIFF + withData);
	assert.deepStrictEqual(parsed.files.map((f) => [f.path, f.kind, Boolean(f.hasBinaryData)]), [
		['src/wp-includes/foo.php', 'modify', false], ['src/x.png', 'binary', false], ['src/y.png', 'binary', true]
	]);
	assert.deepStrictEqual(planApply({ files: parsed.files }).unsupported, ['src/x.png']);
	assert.deepStrictEqual(planApply({ files: parsed.files }).paths, ['src/wp-includes/foo.php', 'src/x.png', 'src/y.png']);
});

test('planApply: an install is needed only when the lockfile is touched (issue #11)', () => {
	assert.strictEqual(planApply({ files: parsePatchFiles(GITHUB_DIFF).files }).needsInstall, false);

	const lockDiff = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "x": 1
+  "x": 2
 }
`;
	assert.strictEqual(planApply({ files: parsePatchFiles(lockDiff).files }).needsInstall, true);
});

// Renaming the lockfile away removes it just as much as editing it does, so a
// rebuild is still needed — the rename's source side has to count, not only its
// destination. (Copilot #12.)
test('planApply: renaming the lockfile away still needs an install (issue #11)', () => {
	const renameAway = `diff --git a/package-lock.json b/package-lock.json.bak
similarity index 100%
rename from package-lock.json
rename to package-lock.json.bak
`;
	assert.strictEqual(planApply({ files: parsePatchFiles(renameAway).files }).needsInstall, true);
});

test('planApplySteps: the install step is named even when skipped (issue #11)', () => {
	const steps = planApplySteps({ needsInstall: false });
	assert.deepStrictEqual(steps.map((s) => s.key), ['apply', 'install', 'build']);
	assert.strictEqual(steps[1].skipped, true);
	assert.strictEqual(steps[1].skipMessage, SKIP_INSTALL_MESSAGE);
	assert.strictEqual(planApplySteps({ needsInstall: true })[1].skipped, false);
});

// The apply chain reuses the update chain's renderer helper by passing its own
// state map; this is what proves the third parameter actually drives it.
test('planApplySteps: updateStepStatuses drives the apply chain too (issue #11)', () => {
	const steps = planApplySteps({ needsInstall: false });
	const at = (state) => updateStepStatuses(steps, state, APPLY_STATE_TO_STEP).map((s) => s.status);

	assert.deepStrictEqual(at('applying'), ['current', 'pending', 'pending']);
	assert.deepStrictEqual(at('building'), ['complete', 'skipped', 'current']);
	assert.deepStrictEqual(at('done'), ['complete', 'skipped', 'complete']);
	// An unknown state must not mark anything complete.
	assert.deepStrictEqual(at('idle'), ['pending', 'pending', 'pending']);
});

test('planApplySteps: the update chain is unaffected by the new state map (issue #11)', () => {
	const steps = planApplySteps({ needsInstall: true });
	// 'fetching' belongs to the update chain, not this one.
	assert.deepStrictEqual(
		updateStepStatuses(steps, 'fetching', APPLY_STATE_TO_STEP).map((s) => s.status),
		['pending', 'pending', 'pending']
	);
});

// #262: when a build watch is running it recompiles src/ on save, so the build
// step is shown skipped, naming the watch as the thing doing the recompile.
test('planApplySteps: the build step is skipped and attributed to the watch (issue #262)', () => {
	const steps = planApplySteps({ needsInstall: false, buildByWatcher: true });
	assert.strictEqual(steps[2].key, 'build');
	assert.strictEqual(steps[2].skipped, true);
	assert.strictEqual(steps[2].skipMessage, BUILD_BY_WATCHER_MESSAGE);
	// Default (no watch) still runs the build, exactly as before.
	assert.strictEqual(planApplySteps({ needsInstall: false })[2].skipped, false);
});

// This is the bug in #262: with a watch running, a src-only patch must NOT run
// its own build (the watch does it) and must NOT pause the watch.
test('planWatchImpact: a src-only patch under a running watch neither builds nor pauses (issue #262)', () => {
	assert.deepStrictEqual(
		planWatchImpact({ needsInstall: false, watcherActive: true }),
		{ pauseWatcher: false, runBuild: false }
	);
});

// No watch running: nothing is recompiling on save, so the build has to run.
test('planWatchImpact: a src-only patch with no watch runs the build itself (issue #262)', () => {
	assert.deepStrictEqual(
		planWatchImpact({ needsInstall: false, watcherActive: false }),
		{ pauseWatcher: false, runBuild: true }
	);
});

// A lockfile change needs install + a full build, which need the build
// directory and node_modules to themselves — so a live watch is paused.
test('planWatchImpact: a lockfile-changing patch builds, and pauses a live watch (issue #262)', () => {
	assert.deepStrictEqual(
		planWatchImpact({ needsInstall: true, watcherActive: true }),
		{ pauseWatcher: true, runBuild: true }
	);
	// With no watch to collide with, it builds but has nothing to pause.
	assert.deepStrictEqual(
		planWatchImpact({ needsInstall: true, watcherActive: false }),
		{ pauseWatcher: false, runBuild: true }
	);
});

// Missing flags must behave as the safe default: run the build, pause nothing.
test('planWatchImpact: missing flags build and pause nothing (issue #262)', () => {
	assert.deepStrictEqual(planWatchImpact(), { pauseWatcher: false, runBuild: true });
	assert.deepStrictEqual(planWatchImpact({}), { pauseWatcher: false, runBuild: true });
});

// Every deletion fixture above carries a `diff --git` line, which this app's
// own generator does not emit — it produces bare createTwoFilesPatch sections
// (issue #85). So the shape the app most needs to read back was the one shape
// not covered here: a mentor applying a handoff patch reads exactly this.
test('parsePatchFiles: a deletion in this app\'s own generated shape is a delete (issue #85)', () => {
	const generated = `===================================================================
--- a/src/old.php\t
+++ /dev/null\t
@@ -1,2 +0,0 @@
-one
-two
`;

	const res = parsePatchFiles(generated);
	assert.strictEqual(res.ok, true, res.error);
	assert.strictEqual(res.files[0].kind, 'delete');
	assert.strictEqual(res.files[0].path, 'src/old.php');
});

// --- what Git is handed (#385) --------------------------------------------
//
// `git apply -p1` reads the paths off the headers, so the rewrite the parser
// applies to its result has to be applied to the text as well, and the two
// have to agree: the preview names the file, Git writes it.

test('rewritePatchPaths: every header shape lands on the path the parser reports (#385)', () => {
	for (const text of [GITHUB_DIFF, TRAC_SVN_DIFF, OLD_LAYOUT_DIFF, ADD_DIFF, DELETE_DIFF]) {
		const rewritten = rewritePatchPaths(text);
		const [file] = parsePatchFiles(text).files;
		const [section] = splitPatchSections(rewritten);
		assert.strictEqual(section.path, file.path, text.split('\n')[0]);
		assert.match(rewritten, new RegExp(`\\+\\+\\+ ${file.kind === 'delete' ? '/dev/null' : `b/${file.path.replace(/[.]/g, '\\.')}`}`));
	}
	// The Trac shapes, spelled out: no prefix and an old layout both become a/ b/ under src/.
	assert.match(rewritePatchPaths(OLD_LAYOUT_DIFF), /^--- a\/src\/wp-admin\/admin\.php\n\+\+\+ b\/src\/wp-admin\/admin\.php$/m);
	assert.match(rewritePatchPaths(OLD_LAYOUT_DIFF), /^Index: src\/wp-admin\/admin\.php$/m);
	assert.match(rewritePatchPaths(TRAC_SVN_DIFF), /^--- a\/src\/wp-includes\/foo\.php\n\+\+\+ b\/src\/wp-includes\/foo\.php$/m, 'the tab and revision note go with the prefix');
	// Hunk content that starts like a header is content.
	const tricky = 'diff --git a/src/x.php b/src/x.php\n--- a/src/x.php\n+++ b/src/x.php\n@@ -1,2 +1,2 @@\n-- one\n+-- two\n';
	assert.strictEqual(rewritePatchPaths(tricky), tricky);
});

test('rewritePatchPaths: renames, the old trunk/ prefix and /dev/null with a trailing tab (#385)', () => {
	const rename = 'diff --git a/wp-admin/old.php b/wp-admin/new.php\nsimilarity index 90%\nrename from wp-admin/old.php\nrename to wp-admin/new.php\n--- a/wp-admin/old.php\n+++ b/wp-admin/new.php\n@@ -1 +1 @@\n-a\n+b\n';
	assert.strictEqual(rewritePatchPaths(rename), 'diff --git a/src/wp-admin/old.php b/src/wp-admin/new.php\nsimilarity index 90%\nrename from src/wp-admin/old.php\nrename to src/wp-admin/new.php\n--- a/src/wp-admin/old.php\n+++ b/src/wp-admin/new.php\n@@ -1 +1 @@\n-a\n+b\n');
	assert.match(rewritePatchPaths('Index: trunk/wp-login.php\n--- trunk/wp-login.php\t(revision 1)\n+++ trunk/wp-login.php\t(working copy)\n@@ -1 +1 @@\n-a\n+b\n'), /^--- a\/src\/wp-login\.php\n\+\+\+ b\/src\/wp-login\.php$/m);
	// jsdiff writes a tab after the name, /dev/null included.
	assert.match(rewritePatchPaths('--- a/gone.php\t\n+++ /dev/null\t\n@@ -1,1 +0,0 @@\n-x\n'), /^--- a\/gone\.php\n\+\+\+ \/dev\/null$/m);
	assert.throws(() => rewritePatchPaths('diff --git "a/we\\303\\251.php" "b/we\\303\\251.php"\n--- "a/we\\303\\251.php"\n+++ "b/we\\303\\251.php"\n@@ -1 +1 @@\n-a\n+b\n'), /quoted or ambiguous/);
});

test('splitPatchSections: one section per file, binary data told apart from a data-less marker, prose before the first dropped (#385)', () => {
	const binaryWithData = 'diff --git a/src/x.png b/src/x.png\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 8\nPcmeAS@N;KiWMT#Y3Bdt%\n\nliteral 0\nHcmV?d00001\n\n';
	const text = `# two files are not in this patch\n${GITHUB_DIFF}${BINARY_DIFF}${binaryWithData}${ADD_DIFF}`;
	const sections = splitPatchSections(text);
	assert.deepStrictEqual(sections.map((s) => [s.path, s.from, s.isBinary, s.hasBinaryData]), [
		['src/wp-includes/foo.php', 'src/wp-includes/foo.php', false, false],
		['src/x.png', 'src/x.png', true, false],
		['src/x.png', 'src/x.png', true, true],
		['src/new.php', '', false, false]
	]);
	assert.strictEqual(sections.map((s) => s.text).join(''), text.slice(text.indexOf('diff --git')), 'the sections are the text, minus the prose');
	// The app's own output has no diff --git line: a section starts at its ---.
	const own = '===================================================================\n--- a/gone.php\t\n+++ /dev/null\t\n@@ -1,1 +0,0 @@\n-x\n===================================================================\n--- /dev/null\t\n+++ b/new.php\t\n@@ -0,0 +1,1 @@\n+y\n';
	assert.deepStrictEqual(splitPatchSections(own).map((s) => [s.path, s.from]), [['gone.php', 'gone.php'], ['new.php', '']]);
	// A rename names both ends.
	assert.deepStrictEqual(splitPatchSections('diff --git a/src/old.php b/src/new.php\nsimilarity index 100%\nrename from src/old.php\nrename to src/new.php\n').map((s) => [s.path, s.from]), [['src/new.php', 'src/old.php']]);
});

// jsdiff drops a section with no hunks whenever another follows it, which
// used to lose a binary or a pure rename placed before a text file. Parsing
// section by section makes the file list the section list.
test('parsePatchFiles: a binary or a pure rename ahead of a text file is not swallowed (#385)', () => {
	const rename = 'diff --git a/src/old.php b/src/new.php\nsimilarity index 100%\nrename from src/old.php\nrename to src/new.php\n';
	const { files } = parsePatchFiles(BINARY_DIFF + rename + GITHUB_DIFF + BINARY_DIFF);
	assert.deepStrictEqual(files.map((f) => [f.kind, f.path]), [
		['binary', 'src/x.png'], ['rename', 'src/new.php'], ['modify', 'src/wp-includes/foo.php'], ['binary', 'src/x.png']
	]);
	assert.strictEqual(files[1].oldPath, 'src/old.php');
});
