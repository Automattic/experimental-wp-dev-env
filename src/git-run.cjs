'use strict';

/**
 * Runs the bundled Git (#384, phase 2 of #364). The one place the binary is
 * spawned: every caller hands in arguments and a working directory and gets
 * bytes back. No parsing here; each read keeps its parser next to it in
 * git-read.cjs, so a wrong flag and a wrong parser are found in the same file.
 *
 * `spawn`, not `execFile`: execFile buffers stdout against a `maxBuffer` and
 * kills the child silently when it overflows, and it hides the ChildProcess
 * that a cancellation needs. Here the cap is explicit, the overflow is an
 * error the caller sees, and `spawnGit` returns the child so `streamGit` can
 * read a clone's progress as it happens and hand the child to `killChildTree`.
 *
 * Two global options ride on every call:
 *
 * - `--no-optional-locks`: a read (`status`, `diff`) otherwise refreshes the
 *   index opportunistically, which writes `.git/index`. Reads must not write.
 * - `safe.directory=<cwd>`: with no system or global config in play
 *   (git-binary.cjs), a site on a folder Git considers "dubiously owned" fails
 *   every command with exit 128. The app only runs Git in directories it
 *   registered itself, so trusting exactly the one it is about to use is the
 *   narrow form; `*` is what a security review would flag.
 */

const { spawn: nodeSpawn } = require('child_process');
const { resolveGitBinary, buildGitEnv, BASE_ARGS, SPAWN_OPTIONS } = require('./git-binary.cjs');
const { killChildTree } = require('./kill-tree.js');
const { createProgressReader, failureReason } = require('./git-progress.cjs');

/**
 * Enough for any porcelain output the app asks for: `status -z` on a tree with
 * 20,000 dirty paths is about 1 MiB. The cap exists so a runaway command is an
 * error rather than an out-of-memory in the main process.
 */
const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;

class GitError extends Error {
	constructor(message, props) {
		super(message);
		this.name = 'GitError';
		Object.assign(this, props);
	}
}

/**
 * The subcommand in an argument list, for messages: the first entry that is
 * neither an option nor the value of a `-c key=value` pair.
 *
 * @param {string[]} args
 * @return {string}
 */
function subcommandOf(args) {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '-c' || args[i] === '-C') { i += 1; continue; }
		if (!args[i].startsWith('-')) return args[i];
	}
	return '(no subcommand)';
}

/**
 * Both spellings on Windows: Git compares the directory it resolved, which it
 * prints with forward slashes, and the value is multi-valued so listing the
 * native form too costs nothing and cannot be wrong.
 *
 * @param {string} cwd
 * @return {string[]}
 */
function safeDirectoryArgs(cwd) {
	const forward = cwd.replace(/\\/g, '/');
	const values = forward === cwd ? [cwd] : [cwd, forward];
	return values.flatMap((value) => ['-c', `safe.directory=${value}`]);
}

/**
 * Spawns the bundled Git and returns the child, for callers that stream
 * (progress on stderr) or that may need to kill it. Most callers want
 * `runGit`.
 *
 * @param {string[]}      args
 * @param {Object}        options
 * @param {string}        options.cwd        Required: Git never runs "wherever the
 *                                           app happens to be".
 * @param {Buffer|string} [options.input]    Written to stdin, then stdin is closed.
 * @param {Object}        [options.extraEnv] Passed to buildGitEnv.
 * @param {Function}      [options.spawn]    Injection point for tests.
 * @return {import('child_process').ChildProcess}
 */
function spawnGit(args, { cwd, input, extraEnv, spawn = nodeSpawn } = {}) {
	if (typeof cwd !== 'string' || cwd.length === 0) {
		throw new TypeError('spawnGit needs an explicit cwd');
	}
	const argv = [...BASE_ARGS, '--no-optional-locks', ...safeDirectoryArgs(cwd), ...args];
	return spawn(resolveGitBinary(), argv, {
		...SPAWN_OPTIONS,
		cwd,
		env: buildGitEnv({ extraEnv }),
		stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
	});
}

/**
 * Runs Git to completion. Resolves with `{ status, stdout, stderr }` where
 * stdout is a Buffer (blob contents are bytes, and `-z` output carries NULs)
 * and stderr is a string.
 *
 * Rejects with a GitError carrying `code`, `signal`, `stderr`, `args` and
 * `cwd` when the exit status is not in `okCodes`. Query commands that answer
 * "no" with exit 1 (`rev-parse --verify`, `symbolic-ref`, `config --get`)
 * pass `okCodes: [0, 1]` and read `status`. 128 is Git's "fatal" and always
 * surfaces; so does 129 (usage), which means a bug in the caller.
 *
 * @param {string[]} args
 * @param {Object}   options             As spawnGit, plus:
 * @param {number[]} [options.okCodes]
 * @param {number}   [options.maxStdout]
 * @return {Promise<{status: number, stdout: Buffer, stderr: string}>}
 */
function runGit(args, { okCodes = [0], maxStdout = DEFAULT_MAX_STDOUT, ...spawnOptions } = {}) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawnGit(args, spawnOptions);
		} catch (error) {
			reject(error);
			return;
		}

		const { cwd, input } = spawnOptions;
		const name = subcommandOf(args);
		const out = [];
		const err = [];
		let outBytes = 0;
		let overflow = false;
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};

		child.stdout.on('data', (chunk) => {
			if (overflow) return;
			outBytes += chunk.length;
			if (outBytes > maxStdout) {
				overflow = true;
				killChildTree(child);
				return;
			}
			out.push(chunk);
		});
		child.stderr.on('data', (chunk) => err.push(chunk));
		child.on('error', (error) => {
			fail(new GitError(`git ${name} could not start: ${error.message}`, {
				code: error.code, signal: null, stderr: '', args, cwd
			}));
		});
		child.on('close', (status, signal) => {
			if (settled) return;
			const stderr = Buffer.concat(err).toString('utf8');
			if (overflow) {
				fail(new GitError(`git ${name} produced more than ${maxStdout} bytes of output`, {
					code: 'stdout-overflow', signal, stderr, args, cwd
				}));
				return;
			}
			if (!okCodes.includes(status)) {
				const reason = stderr.split(/\r?\n/).find((line) => line.trim()) || (signal ? `killed by ${signal}` : 'no output');
				fail(new GitError(`git ${name} failed (${status === null ? signal : status}): ${reason}`, {
					code: status, signal, stderr, args, cwd
				}));
				return;
			}
			settled = true;
			resolve({ status, stdout: Buffer.concat(out), stderr });
		});

		if (input !== undefined) {
			// EPIPE means Git exited before reading all of stdin, which its exit
			// status already reports; anything else is a real write failure.
			child.stdin.on('error', (error) => {
				if (error.code !== 'EPIPE') fail(error);
			});
			child.stdin.end(input);
		}
	});
}

/**
 * Runs Git to completion while its stderr is read as it arrives: the shape
 * of a clone, a checkout and a fetch, the commands that take long enough to
 * report progress and that a quit may have to kill. `onProgress` receives
 * the parsed `{ phase, percent, loaded, total }` events (git-progress.cjs);
 * `onStderr` receives each raw chunk, for a caller that shows Git's own
 * lines; `onChild` receives the ChildProcess as soon as it exists, so it can
 * be handed to `killChildTree`. Stdout is drained and dropped: none of these
 * commands prints anything there that the app reads.
 *
 * Resolves with `{ stderr }` on exit 0 and rejects with a GitError otherwise,
 * its message carrying `failureReason`, Git's last `fatal:` or `error:` line,
 * rather than the first line of stderr the way `runGit` does: after a screen
 * of progress the reason is at the end.
 *
 * @param {string[]} args
 * @param {Object}   options
 * @param {string}   options.cwd
 * @param {Function} [options.onProgress]
 * @param {Function} [options.onStderr]
 * @param {Function} [options.onChild]
 * @param {Object}   [options.extraEnv]
 * @param {Function} [options.spawn]      Injection point for tests.
 * @return {Promise<{stderr: string}>}
 */
function streamGit(args, { cwd, onProgress = null, onStderr = null, onChild = null, extraEnv, spawn } = {}) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawnGit(args, { cwd, extraEnv, ...(spawn ? { spawn } : {}) });
		} catch (error) {
			reject(error);
			return;
		}
		if (onChild) onChild(child);

		const name = subcommandOf(args);
		const reader = createProgressReader((event) => { if (onProgress) onProgress(event); });
		const stderr = [];
		let settled = false;
		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk) => {
			const text = chunk.toString('utf8');
			stderr.push(text);
			reader.push(text);
			if (onStderr) onStderr(text);
		});
		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			reject(new GitError(`git ${name} could not start: ${error.message}`, { code: error.code, signal: null, stderr: '', args, cwd }));
		});
		child.on('close', (status, signal) => {
			if (settled) return;
			settled = true;
			reader.flush();
			const text = stderr.join('');
			if (status === 0) {
				resolve({ stderr: text });
				return;
			}
			reject(new GitError(`git ${name} failed (${status === null ? signal : status}): ${failureReason(text, signal)}`, { code: status, signal, stderr: text, args, cwd }));
		});
	});
}

module.exports = { spawnGit, runGit, streamGit, GitError, DEFAULT_MAX_STDOUT, subcommandOf, safeDirectoryArgs };
