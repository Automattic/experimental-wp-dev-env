'use strict';

// The bundled Git, for tests that drive it directly: build a repository, put
// it in a state the app never creates (a detached HEAD, a hand-made branch),
// or check what the app wrote. Not a test file: discovery is by `*.test.cjs`,
// so nothing here runs on its own (see the note at the top of
// ipc-wiring.test.cjs).

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

module.exports = { BINARY, ENV, GIT_VERSION, git, tempDir, removeRepo };
