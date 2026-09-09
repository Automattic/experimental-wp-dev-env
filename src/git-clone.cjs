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
 * Progress arrives on stderr as the lines Git prints for a human, parsed by
 * git-progress.cjs, the one place the app reads non-porcelain output.
 */

const path = require('path');
const { spawnGit, GitError } = require('./git-run.cjs');
const { createProgressReader, failureReason } = require('./git-progress.cjs');

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
			const reason = failureReason(text, signal);
			reject(new GitError(`git clone failed (${status === null ? signal : status}): ${reason}`, { code: status, signal, stderr: text, args, cwd }));
		});
	});
}

module.exports = { DEFAULT_BRANCH, cloneArgs, cloneSite };
