'use strict';

/**
 * Creating a site: the clone of `wordpress-develop` through the bundled Git
 * (#385, flow 1 of phase 3 of #364). The first write the binary makes, and
 * the one with the narrowest blast radius: a repository that did not exist
 * before.
 *
 * Partial, not shallow. `--filter=blob:none` brings the whole history down
 * (commits and trees, about 57 MB for wordpress-develop) and fetches a blob
 * only when something asks for it, which a checkout of HEAD does and nothing
 * the app does afterwards needs. What that buys is a merge base for every
 * pull request without a full clone (#351), and a route `isomorphic-git`
 * never had. A shallow clone would be smaller by that 57 MB and have no
 * history at all. Measured in the #364 spike: 5.2 s for the history alone.
 *
 * The repository's own config is written at clone time, so a site the binary
 * made never depends on the CRLF view git-read.cjs synthesises for sites the
 * old engine made: `core.autocrlf=false` keeps the tree LF on every platform,
 * which is what wordpress-develop's blobs are and what the patch builder
 * assumes; `core.symlinks=false` matches what the old engine wrote; and on
 * Windows `core.longpaths=true` because the tree has paths past MAX_PATH.
 *
 * Progress arrives on stderr as the lines Git prints for a human, which is
 * the one place the app reads non-porcelain output: Git has no machine
 * format for progress, the lines have had the same shape for fifteen years,
 * and a line that does not parse is dropped rather than shown.
 */

const path = require('path');
const { spawnGit, GitError } = require('./git-run.cjs');

/**
 * The branch a new site checks out. `trunk` is the pristine snapshot every
 * ticket branch is diffed against (ticket-branches.js).
 */
const DEFAULT_BRANCH = 'trunk';

/**
 * @param {Object} root0
 * @param {string} root0.url
 * @param {string} root0.dir        Must not exist yet, or be empty.
 * @param {string} [root0.branch]
 * @param {string} [root0.platform]
 * @return {string[]}
 */
function cloneArgs({ url, dir, branch = DEFAULT_BRANCH, platform = process.platform }) {
	return [
		'clone',
		'--filter=blob:none',
		'--single-branch',
		'--branch', branch,
		'--progress',
		'--config', 'core.autocrlf=false',
		'--config', 'core.symlinks=false',
		...(platform === 'win32' ? ['--config', 'core.longpaths=true'] : []),
		'--',
		url,
		dir
	];
}

// `Receiving objects:  42% (1234/5678), 12.00 MiB | 3.00 MiB/s`, with or
// without the `remote: ` prefix the server-side phases carry.
const PROGRESS_LINE = /^(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+(\d+)% \((\d+)\/(\d+)\)/;

/**
 * One progress event per phase line, from a chunk that may hold several
 * lines and may end mid-line. Git separates updates to the same phase with
 * `\r` and phases with `\n`; both end a segment here.
 *
 * @param {string} text
 * @return {Array<{phase: string, percent: number, loaded: number, total: number}>}
 */
function parseProgressLines(text) {
	const events = [];
	for (const segment of text.split(/[\r\n]/)) {
		const match = PROGRESS_LINE.exec(segment);
		if (!match) continue;
		events.push({
			phase: match[1].toLowerCase(),
			percent: Number(match[2]),
			loaded: Number(match[3]),
			total: Number(match[4])
		});
	}
	return events;
}

/**
 * Feeds chunks in, emits complete progress lines out, and holds back the
 * tail that has not ended yet so a percentage split across two chunks is not
 * reported twice, or wrongly.
 *
 * @param {Function} onEvent
 * @return {{push: Function, flush: Function}}
 */
function createProgressReader(onEvent) {
	let pending = '';
	const emit = (text) => {
		for (const event of parseProgressLines(text)) onEvent(event);
	};
	return {
		push(chunk) {
			pending += chunk;
			const cut = Math.max(pending.lastIndexOf('\r'), pending.lastIndexOf('\n'));
			if (cut === -1) return;
			emit(pending.slice(0, cut + 1));
			pending = pending.slice(cut + 1);
		},
		flush() {
			if (pending) emit(pending);
			pending = '';
		}
	};
}

/**
 * Clones `url` into `dir`. Resolves when the checkout is complete; rejects
 * with a GitError carrying Git's stderr when it is not, in which case `dir`
 * holds whatever Git left and the caller decides what to do with it.
 *
 * @param {Object}   root0
 * @param {string}   root0.url
 * @param {string}   root0.dir
 * @param {string}   [root0.branch]
 * @param {Function} [root0.onProgress] `{ phase, percent, loaded, total }`
 * @param {Function} [root0.onChild]    Handed the ChildProcess, so a quit can
 *                                      kill it (killChildTree).
 * @param {string}   [root0.platform]
 * @param {Function} [root0.spawn]      Injection point for tests.
 * @return {Promise<{dir: string}>}
 */
function cloneSite({ url, dir, branch = DEFAULT_BRANCH, onProgress = null, onChild = null, platform = process.platform, spawn } = {}) {
	return new Promise((resolve, reject) => {
		const args = cloneArgs({ url, dir, branch, platform });
		// The parent is the working directory: `dir` may not exist yet, and a
		// clone is the one command whose target is an argument, not the cwd.
		const cwd = path.dirname(dir);
		let child;
		try {
			child = spawnGit(args, { cwd, ...(spawn ? { spawn } : {}) });
		} catch (error) {
			reject(error);
			return;
		}
		if (onChild) onChild(child);

		const reader = createProgressReader((event) => { if (onProgress) onProgress(event); });
		const stderr = [];
		let settled = false;
		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk) => {
			const text = chunk.toString('utf8');
			stderr.push(text);
			reader.push(text);
		});
		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			reject(new GitError(`git clone could not start: ${error.message}`, { code: error.code, signal: null, stderr: '', args, cwd }));
		});
		child.on('close', (status, signal) => {
			if (settled) return;
			settled = true;
			reader.flush();
			if (status === 0) {
				resolve({ dir });
				return;
			}
			const text = stderr.join('');
			// Git's reason is its `fatal:` (or `error:`) line, which is not always
			// the last one: "Please make sure you have the correct access rights
			// and the repository exists." follows it. Fall back to the last line
			// that is not a progress update.
			const lines = text.split(/[\r\n]/).filter((line) => line.trim() && !PROGRESS_LINE.test(line));
			const reason = lines.filter((line) => /^(fatal|error):/.test(line)).pop() || lines.pop() || (signal ? `killed by ${signal}` : 'no output');
			reject(new GitError(`git clone failed (${status === null ? signal : status}): ${reason}`, { code: status, signal, stderr: text, args, cwd }));
		});
	});
}

module.exports = { DEFAULT_BRANCH, cloneArgs, parseProgressLines, createProgressReader, cloneSite };
