'use strict';

// The bundled Git, for tests that drive it directly: build a repository, put
// it in a state the app never creates (a detached HEAD, a hand-made branch),
// or check what the app wrote. Not a test file: discovery is by `*.test.cjs`,
// so nothing here runs on its own (see the note at the top of
// ipc-wiring.test.cjs).
//
// `git` runs one command and hands back its exit status; `gitOk` throws
// instead, and the fixture layer on top of it (`initRepo`, `commitFiles`,
// `resolveRef`, `currentBranch`, `listBranches`, `commitMeta`) is what every
// suite builds its repositories with since #386 retired the second engine.
// One place decides the two things a fixture has to match the app on: the
// identity a commit carries, and the `core.autocrlf=false` the app's clone
// writes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveGitBinary, buildGitEnv, BASE_ARGS, SPAWN_OPTIONS } = require('../../../src/git-binary.cjs');

const BINARY = resolveGitBinary();
const ENV = buildGitEnv();

// The Git dugite@3.2.3 embeds; a different one here means a different tree.
const GIT_VERSION = /^git version 2\.53\.0(?:$|[.\s])/;

/**
 * Runs one Git command synchronously and returns trimmed text.
 *
 * @param {string[]} args
 * @param {string}   cwd
 */
function git(args, cwd) {
	const result = spawnSync(BINARY, [...BASE_ARGS, ...args], { ...SPAWN_OPTIONS, cwd, env: ENV, encoding: 'utf8' });
	return {
		status: result.status,
		stdout: (result.stdout || '').trim(),
		stderr: (result.stderr || '').trim(),
		error: result.error ? result.error.message : null
	};
}

/**
 * The same command, with a failure that says so. A fixture that half built
 * itself is worth nothing: the test that follows fails somewhere else, on an
 * assertion that has no bearing on what went wrong.
 *
 * @param {string[]} args
 * @param {string}   cwd
 * @return {string} Trimmed stdout.
 */
function gitOk(args, cwd) {
	const result = git(args, cwd);
	if (result.status !== 0) {
		const why = result.error || result.stderr || `exited ${result.status}`;
		throw new Error(`git ${args.join(' ')} in ${cwd}: ${why}`);
	}
	return result.stdout;
}

// Who a fixture commit belongs to. Not WIP_AUTHOR from ticket-branches.js:
// the app's own identity is what the app writes, and a test that asserts it
// must not be handed it by the fixture that set the scene.
const FIXTURE_AUTHOR = Object.freeze({ name: 'test', email: 'test@example.com' });

const identityArgs = (author) => ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];

/**
 * A repository shaped the way the app's own clone shapes one (git-clone.cjs):
 * `trunk` as the initial branch and `core.autocrlf=false`, so the tree is LF
 * on every platform and a byte-for-byte assertion means the same thing on
 * Windows as it does here.
 *
 * `autocrlf: null` leaves the config unwritten, for the tests about a
 * checkout the app adopted rather than made.
 *
 * @param {string}  dir
 * @param {Object}  [options]
 * @param {string}  [options.branch]
 * @param {?string} [options.autocrlf]
 * @return {string} The directory, so a caller can build on one line.
 */
function initRepo(dir, { branch = 'trunk', autocrlf = 'false' } = {}) {
	gitOk(['init', '-b', branch], dir);
	if (autocrlf !== null) gitOk(['config', 'core.autocrlf', autocrlf], dir);
	return dir;
}

/**
 * Stages the paths given and commits them, exactly as the app commits: the
 * identity on the command line, nothing read from a config the test did not
 * write. Deletions count as paths, `add` records them.
 *
 * @param {string}          dir
 * @param {string|string[]} paths
 * @param {string}          message
 * @param {Object}          [options]
 * @param {Object}          [options.author]
 * @param {boolean}         [options.allowEmpty] For a commit that changes nothing on purpose.
 * @return {string} The new commit's oid.
 */
function commitFiles(dir, paths, message, { author = FIXTURE_AUTHOR, allowEmpty = false } = {}) {
	const files = Array.isArray(paths) ? paths : [paths];
	if (files.length) gitOk(['add', '--', ...files], dir);
	gitOk([...identityArgs(author), 'commit', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], dir);
	return resolveRef(dir, 'HEAD');
}

/**
 * @param {string} dir
 * @param {string} ref
 * @return {string} The oid the ref resolves to.
 */
const resolveRef = (dir, ref) => gitOk(['rev-parse', '--verify', ref], dir);

/**
 * The branch HEAD is on, or `HEAD` when it is detached.
 *
 * @param {string} dir
 * @return {string}
 */
const currentBranch = (dir) => gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], dir);

/**
 * @param {string} dir
 * @return {string[]} Local branch names, in Git's own order.
 */
const listBranches = (dir) =>
	gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], dir).split('\n').filter(Boolean);

/**
 * What a commit says about itself, for the assertions that used to read it
 * through a second engine's object parser.
 *
 * @param {string} dir
 * @param {string} ref
 * @return {{oid: string, parents: string[], author: Object, committer: Object, message: string, committerTimestamp: number}}
 */
function commitMeta(dir, ref) {
	const format = ['%H', '%P', '%an', '%ae', '%cn', '%ce', '%s', '%ct'].join('%x00');
	const [oid, parents, an, ae, cn, ce, message, ct] = gitOk(['log', '-1', `--format=${format}`, ref], dir).split('\0');
	return {
		oid,
		parents: parents ? parents.split(' ') : [],
		author: { name: an, email: ae },
		committer: { name: cn, email: ce },
		message,
		committerTimestamp: Number(ct)
	};
}

/**
 * A fresh directory under the OS temp dir, removed when the test ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {string}                          prefix
 */
function tempDir(t, prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => removeRepo(dir));
	return dir;
}

/**
 * Git writes its objects read-only, and on Windows `rmSync` answers that with
 * EPERM rather than deleting them (#381). Make everything writable first.
 *
 * @param {string} dir
 */
function removeRepo(dir) {
	const walk = (entry) => {
		const stat = fs.lstatSync(entry);
		if (stat.isDirectory()) {
			fs.chmodSync(entry, 0o777);
			for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));
		} else if (stat.isFile()) {
			fs.chmodSync(entry, 0o666);
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

module.exports = {
	BINARY,
	ENV,
	GIT_VERSION,
	FIXTURE_AUTHOR,
	git,
	gitOk,
	initRepo,
	commitFiles,
	resolveRef,
	currentBranch,
	listBranches,
	commitMeta,
	tempDir,
	removeRepo
};
