'use strict';

/**
 * The writes the bundled Git makes inside an existing repository (#385): the
 * index, a tree, a commit, a ref, a checkout, a fetch, a clean. Primitives
 * only, one Git command each, with no knowledge of tickets or trunk;
 * ticket-branches.js and trunk-update.js compose them and own the
 * invariants. Same split as git-read.cjs, and for the same reason: an
 * argument list is testable on an injected runner, a flow is testable on a
 * real repository, and mixing the two hides which one broke.
 *
 * Every command that touches the index or the worktree is prefixed with
 * `windowsArgs`, what git-read.cjs gives sites adopted from a host Git on
 * Windows (the `core.autocrlf` view and `core.longpaths`); a site the binary
 * cloned carries both in its own config, and off Windows the prefix is empty.
 *
 * Nothing here is a porcelain command with output to parse except `write-tree`
 * and `commit-tree`, which print exactly one object id; `checkout` and `fetch`
 * report their progress on stderr through `streamGit`, the same lines the
 * clone reads.
 */

const { runGit, streamGit, GitError } = require('./git-run.cjs');
const { windowsArgs, resolveRef } = require('./git-read.cjs');

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
	await streamGit([...win, 'checkout', '--force', '--progress', ref], { cwd: dir, onProgress, onChild, spawn });
	return { ref };
}

/**
 * Fetches one branch from one remote and resolves with the commit it now
 * points at, read back from `FETCH_HEAD`. No `--depth` and no `--filter`: a
 * site the app made carries `remote.origin.promisor` in its own config, so
 * the fetch is partial by itself, and a full clone adopted from disk fetches
 * the way its owner's Git would. `--no-tags` keeps wordpress-develop's tags
 * (one per release) off a site that never needs them.
 *
 * Git's progress goes to `onStderr` as it is printed, `remote: Counting
 * objects` and `Receiving objects` included, because those lines are already
 * what a terminal should show; `onProgress` gets the parsed events for a
 * caller that wants a number.
 *
 * @param {string}   dir
 * @param {string}   remote
 * @param {string}   branch
 * @param {Object}   [options]
 * @param {Function} [options.onStderr]
 * @param {Function} [options.onProgress]
 * @param {Function} [options.onChild]    Handed the ChildProcess.
 * @param {Function} [options.spawn]      Injection point for tests.
 * @param {Function} [options.resolve]    Injection point for tests: reads FETCH_HEAD.
 * @return {Promise<{oid: string}>}
 */
async function fetchBranch(dir, remote, branch, { onStderr = null, onProgress = null, onChild = null, spawn, resolve = resolveRef } = {}) {
	await streamGit(['fetch', '--progress', '--no-tags', '--', remote, branch], { cwd: dir, onStderr, onProgress, onChild, spawn });
	const oid = await resolve(dir, 'FETCH_HEAD');
	if (!oid) throw new GitError(`git fetch left no FETCH_HEAD for ${remote} ${branch}`, { code: 'no-fetch-head', signal: null, stderr: '', args: ['fetch', remote, branch], cwd: dir });
	return { oid };
}

/**
 * Takes exactly `paths` out of the index, leaving the files on disk: what
 * `reset` with a pathspec does, and the counterpart of `stagePaths`, fed the
 * same way (NUL-separated on stdin, literal). A path absent from HEAD is
 * simply dropped from the index; one present in HEAD goes back to HEAD's
 * entry. `rm --cached` would refuse a path whose staged content matches
 * neither HEAD nor the worktree, which is not a refusal anyone here wants.
 *
 * @param {string}   dir
 * @param {string[]} paths
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]
 * @return {Promise<number>} How many paths were handed to Git.
 */
async function unstagePaths(dir, paths, { platform = process.platform, run = runGit } = {}) {
	if (!paths.length) return 0;
	const win = await windowsArgs(dir, { platform, run });
	await run([...win, '--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul', '--'], {
		cwd: dir,
		input: Buffer.from(`${paths.join('\0')}\0`, 'utf8')
	});
	return paths.length;
}

/**
 * Removes every untracked file and directory that is not ignored. Without
 * `-x`, what `.gitignore` and `.git/info/exclude` name stays (`node_modules`,
 * `build`); without a second `-f`, a nested repository stays too.
 *
 * @param {string}   dir
 * @param {Object}   [options]
 * @param {string}   [options.platform]
 * @param {Function} [options.run]
 */
async function cleanUntracked(dir, { platform = process.platform, run = runGit } = {}) {
	const win = await windowsArgs(dir, { platform, run });
	await run([...win, 'clean', '-fd'], { cwd: dir });
}

module.exports = {
	stagePaths,
	unstagePaths,
	writeTree,
	commitTree,
	updateBranch,
	createBranchAt,
	pointHeadAt,
	deleteBranch,
	checkoutBranch,
	fetchBranch,
	cleanUntracked
};
