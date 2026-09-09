'use strict';

/**
 * The writes the bundled Git makes inside an existing repository (#385): the
 * index, a tree, a commit, a ref, a checkout. Primitives only, one Git
 * command each, with no knowledge of tickets or trunk; ticket-branches.js
 * composes them and owns the invariants. Same split as git-read.cjs, and for
 * the same reason: an argument list is testable on an injected runner, a
 * flow is testable on a real repository, and mixing the two hides which one
 * broke.
 *
 * Every command that touches the index or the worktree is prefixed with
 * `windowsArgs`, what git-read.cjs gives sites the old engine made on Windows
 * (the `core.autocrlf` view and `core.longpaths`); a site the binary cloned
 * carries both in its own config, and off Windows the prefix is empty.
 *
 * Nothing here is a porcelain command with output to parse except `write-tree`
 * and `commit-tree`, which print exactly one object id; `checkout` reports its
 * progress on stderr through git-progress.cjs, the same lines the clone reads.
 */

const { spawnGit, runGit, GitError } = require('./git-run.cjs');
const { windowsArgs } = require('./git-read.cjs');
const { createProgressReader, failureReason } = require('./git-progress.cjs');

const oidOf = ({ stdout }) => stdout.toString('utf8').trim();

/**
 * Stages exactly `paths`: modifications and additions are added, deletions
 * are removed from the index (`-A` scoped to a pathspec does all three).
 * The paths are the ones a status scan returned, byte for byte, so they are
 * fed on stdin NUL-separated and taken literally: a `*`, `?` or `[` in a
 * filename is a character, not a glob.
 *
 * @param {string}   dir
 * @param {string[]} paths
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]
 * @return {Promise<number>} How many paths were handed to Git.
 */
async function stagePaths(dir, paths, { platform = process.platform, run = runGit } = {}) {
	if (!paths.length) return 0;
	const win = await windowsArgs(dir, { platform, run });
	await run([...win, '--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
		cwd: dir,
		input: Buffer.from(`${paths.join('\0')}\0`, 'utf8')
	});
	return paths.length;
}

/**
 * The tree object the index describes.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {Function} [options.run]
 * @return {Promise<string>}
 */
async function writeTree(dir, { run = runGit } = {}) {
	return oidOf(await run(['write-tree'], { cwd: dir }));
}

/**
 * A commit object for `tree` with exactly the parent given, written to the
 * object store and nothing else: no ref moves, so a caller decides where it
 * lands (`updateBranch`). Author and committer are the same identity, passed
 * per call because the bundled Git reads no host config and the repository
 * has none to give.
 *
 * @param {string}                        dir
 * @param {Object}                        root0
 * @param {string}                        root0.tree
 * @param {string}                        root0.parent
 * @param {string}                        root0.message
 * @param {{name: string, email: string}} root0.author
 * @param {Function}                      [root0.run]
 * @return {Promise<string>}
 */
async function commitTree(dir, { tree, parent, message, author, run = runGit }) {
	const identity = ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];
	return oidOf(await run([...identity, 'commit-tree', tree, '-p', parent, '-m', message], { cwd: dir }));
}

/**
 * Points `refs/heads/<branch>` at `oid`. With `expected`, Git refuses unless
 * the ref still holds that value, so a second writer (a mentor's own client
 * in the same site) fails loudly instead of being overwritten.
 *
 * @param {string}   dir
 * @param {string}   branch
 * @param {string}   oid
 * @param {Object}   [options]
 * @param {string}   [options.expected]
 * @param {Function} [options.run]
 */
async function updateBranch(dir, branch, oid, { expected, run = runGit } = {}) {
	await run(['update-ref', `refs/heads/${branch}`, oid, ...(expected ? [expected] : [])], { cwd: dir });
}

/**
 * Creates `ref` at `startPoint` without checking it out.
 *
 * @param {string}   dir
 * @param {string}   ref
 * @param {string}   startPoint
 * @param {Object}   [options]
 * @param {Function} [options.run]
 */
async function createBranchAt(dir, ref, startPoint, { run = runGit } = {}) {
	await run(['branch', '--', ref, startPoint], { cwd: dir });
}

/**
 * Moves HEAD to `ref` and touches nothing else: the index and the worktree
 * stay exactly as they are, which is what carries uncommitted edits onto a
 * branch just created at the same commit.
 *
 * @param {string}   dir
 * @param {string}   ref
 * @param {Object}   [options]
 * @param {Function} [options.run]
 */
async function pointHeadAt(dir, ref, { run = runGit } = {}) {
	await run(['symbolic-ref', 'HEAD', `refs/heads/${ref}`], { cwd: dir });
}

/**
 * Deletes `ref` whether or not it is merged anywhere.
 *
 * @param {string}   dir
 * @param {string}   ref
 * @param {Object}   [options]
 * @param {Function} [options.run]
 */
async function deleteBranch(dir, ref, { run = runGit } = {}) {
	await run(['branch', '-D', '--', ref], { cwd: dir });
}

/**
 * Checks `ref` out, overwriting tracked files that differ. Ignored and
 * untracked files are not Git's to touch and survive. Progress comes from
 * stderr as `{ phase, percent, loaded, total }` (`updating files` is the
 * phase a checkout reports); a small checkout prints none at all.
 *
 * Git writes HEAD last, after every file operation succeeded, so a failure
 * part-way leaves HEAD where it was over a partly swapped worktree. The
 * rejection carries Git's own reason; what to record about that state is
 * the caller's (ticket-branches.js tags it with the stage).
 *
 * @param {string}   dir
 * @param {string}   ref
 * @param {Object}   [options]
 * @param {Function} [options.onProgress]
 * @param {Function} [options.onChild]    Handed the ChildProcess.
 * @param {string}   [options.platform]
 * @param {Function} [options.run]        For `crlfArgs`.
 * @param {Function} [options.spawn]      Injection point for tests.
 * @return {Promise<{ref: string}>}
 */
async function checkoutBranch(dir, ref, { onProgress = null, onChild = null, platform = process.platform, run = runGit, spawn } = {}) {
	const win = await windowsArgs(dir, { platform, run });
	// No `--` before the ref: after it, checkout reads a pathspec, not a branch.
	const args = [...win, 'checkout', '--force', '--progress', ref];
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawnGit(args, { cwd: dir, ...(spawn ? { spawn } : {}) });
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
			reject(new GitError(`git checkout could not start: ${error.message}`, { code: error.code, signal: null, stderr: '', args, cwd: dir }));
		});
		child.on('close', (status, signal) => {
			if (settled) return;
			settled = true;
			reader.flush();
			if (status === 0) {
				resolve({ ref });
				return;
			}
			const text = stderr.join('');
			reject(new GitError(`git checkout failed (${status === null ? signal : status}): ${failureReason(text, signal)}`, { code: status, signal, stderr: text, args, cwd: dir }));
		});
	});
}

module.exports = {
	stagePaths,
	writeTree,
	commitTree,
	updateBranch,
	createBranchAt,
	pointHeadAt,
	deleteBranch,
	checkoutBranch
};
