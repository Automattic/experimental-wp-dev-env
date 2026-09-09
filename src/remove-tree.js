// Removes a directory tree, including the parts Git protects.
//
// A real Git marks its loose object files read-only, and what that does to a
// removal differs by platform — with a different hole in each default. On
// Windows, Node's own `fs.rm` chmods an entry it failed to delete and tries
// again (inherited from rimraf when core absorbed it), so the read-only file
// itself is survivable there; what has no answer is an entry something still
// holds open, because `fse.remove` passes no retry budget at all. On POSIX
// nothing clears a directory whose write bit is missing, so the same
// protected checkout fails with EACCES and no recovery of any kind. The #364
// spike hit EPERM on every packaged Windows run; the CI suite proves the
// POSIX half.
//
// Sites the old engine made got away with plain removal because isomorphic-git
// sets no attribute. Since #385 the app's own clone is a real Git, so every new
// site carries read-only objects from the first minute, the same as a mentor
// making a commit with their own tools — and `sites:delete` used to swallow
// whatever went wrong besides (#381).
//
// The shape: try the cheap removal first, and only when it fails with a
// permission error walk whatever survived, restore the write bit, and remove
// once more. The walk is the recovery path, so the common case pays nothing.
// Anything that still fails after that propagates: the caller decides what a
// failed deletion means, this module only refuses to hide one.

'use strict';

const fsDefault = require('fs');
const path = require('path');

/**
 * Pure decision: does this removal error call for clearing attributes and
 * retrying? Only a permission error does — anything else (a path that is a
 * file, a disk error) would fail the same way twice.
 *
 * @param {?Object} error
 * @return {boolean}
 */
function shouldClearAttributes(error) {
	return !!error && (error.code === 'EPERM' || error.code === 'EACCES');
}

/**
 * Adds the owner write bit to `target` and, if it is a directory, to
 * everything under it — the directory first, so the walk can enter it.
 * Additive on purpose: this runs when a removal has already failed once, and
 * it may fail again, so whatever survives has to keep the mode it came with.
 * Assigning a fixed mode instead would strip an executable's exec bit and
 * every group and other permission from a tree the caller is about to be told
 * still exists. Errors on individual entries are ignored: a path that cannot
 * be chmodded will fail the removal that follows, which is the honest place
 * for the failure to surface.
 *
 * @param {string} target
 * @param {Object} fs
 */
async function makeWritable(target, fs) {
	// One lstat answers all three questions: link or not, directory or not,
	// and what mode to add to. `lstat`, not `stat`, so a link is recognised
	// rather than resolved.
	let stats;
	try {
		stats = await fs.promises.lstat(target);
	} catch {
		return;
	}
	// chmod follows symlinks — there is no portable lchmod — so touching one
	// would change its target's mode, possibly outside this tree. `rm` does not
	// follow them when deleting, so they need no help anyway. The check sits at
	// the top of the recursion, which is also the root: a registered site path
	// can itself be a link, and the first `rm` can fail without unlinking it.
	if (stats.isSymbolicLink()) return;
	const isDirectory = stats.isDirectory();
	// A directory needs owner rwx for the walk to enter it and for the removal
	// to unlink inside it; a file only needs to stop being read-only.
	// eslint-disable-next-line no-bitwise -- adding a permission to a POSIX mode is what `|` is for; the same idiom as pr-files.cjs.
	const restored = stats.mode | (isDirectory ? 0o700 : 0o200);
	// The chmod and the readdir fail independently: a directory whose mode
	// cannot be changed may still be readable, and its children deserve the
	// pass either way.
	try { await fs.promises.chmod(target, restored); } catch {}
	if (!isDirectory) return;
	let entries;
	try {
		entries = await fs.promises.readdir(target);
	} catch {
		return;
	}
	for (const name of entries) {
		await makeWritable(path.join(target, name), fs);
	}
}

/**
 * Removes `dir` recursively, clearing read-only attributes if they are what
 * stands in the way. Resolves when the tree is gone (or never existed);
 * rejects with the underlying error when it could not be removed.
 *
 * @param {string} dir
 * @param {Object} [deps]    Injection point, so the tests can assert the
 *                           retry decision without staging a real EPERM.
 * @param {Object} [deps.fs]
 */
async function removeTree(dir, { fs = fsDefault } = {}) {
	// maxRetries 10 is inherited from the e2e teardown this replaces: an
	// ENOTEMPTY that only ever appeared on a macOS CI runner — a just-closed
	// app's last flush — needed that budget, and ENOTEMPTY is not a permission
	// code, so the attribute pass below does nothing for it. Retries are still
	// its only mitigation.
	const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
	try {
		await fs.promises.rm(dir, options);
	} catch (error) {
		if (!shouldClearAttributes(error)) throw error;
		await makeWritable(dir, fs);
		await fs.promises.rm(dir, options);
	}
}

module.exports = { shouldClearAttributes, removeTree };
