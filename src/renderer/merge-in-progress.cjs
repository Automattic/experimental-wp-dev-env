// What the app says about a merge started outside it (#352).
//
// Nothing the app runs leaves the index unmerged; a contributor's or a
// mentor's own Git does, with `git merge`, `git rebase`, `git cherry-pick`,
// `git revert` or `git apply --3way` in the checkout. While that operation is
// open, every app write that would reset the worktree refuses (main.js,
// `mergeInProgressBlock`) and the site card shows the notice, and both read
// from here so the two never drift. The app offers no way to finish or abandon
// it: the state was made at a terminal, so the sentence names the terminal
// commands that end it, per kind. Pure and dependency-free for the same reason
// as legacy-site.cjs: the renderer bundle imports it, `node --test` requires
// it, and main requires it too.
'use strict';

/**
 * How each kind of operation ends, in Git's own words. `finish` is the step
 * once the files are resolved; `resolve` says what to do with the files
 * first, when any are still unmerged.
 */
const KINDS = {
	merge: { name: 'A merge', resolve: 'resolve the files, then git add them and run git commit', finish: 'git commit', abandon: 'git merge --abort' },
	rebase: { name: 'A rebase', resolve: 'resolve the files, then git add them and run git rebase --continue', finish: 'git rebase --continue', abandon: 'git rebase --abort' },
	'cherry-pick': { name: 'A cherry-pick', resolve: 'resolve the files, then git add them and run git cherry-pick --continue', finish: 'git cherry-pick --continue', abandon: 'git cherry-pick --abort' },
	revert: { name: 'A revert', resolve: 'resolve the files, then git add them and run git revert --continue', finish: 'git revert --continue', abandon: 'git revert --abort' },
	apply: { name: 'A three-way patch apply', resolve: 'resolve the files, then git add them', finish: 'git add the files', abandon: 'git restore --staged --worktree -- <the files>' }
};

const LISTED = 5;

/**
 * "a, b and c", or "a, b, c and 4 more files" past the first few: the card is
 * not a file list, and the terminal that made the state can print one.
 *
 * @param {string[]} paths
 * @return {string}
 */
function listPaths(paths) {
	const shown = paths.slice(0, LISTED);
	const rest = paths.length - shown.length;
	if (rest > 0) return `${shown.join(', ')} and ${rest} more ${rest === 1 ? 'file' : 'files'}`;
	if (shown.length <= 1) return shown.join('');
	return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * The notice for a checkout with an operation open, as the card shows it,
 * or null for every other checkout. The title names the operation; the body
 * names the files still unmerged and the two ways out.
 *
 * @param {Object}                           [root0]
 * @param {?{kind: string, paths: string[]}} [root0.mergeInProgress] What `site:status` reported.
 * @return {{title: string, body: string}|null}
 */
function mergeInProgressNotice({ mergeInProgress = null } = {}) {
	if (!mergeInProgress) return null;
	const kind = KINDS[mergeInProgress.kind] || KINDS.merge;
	const paths = Array.isArray(mergeInProgress.paths) ? mergeInProgress.paths : [];
	const title = `${kind.name} started outside the app is in progress.`;
	const state = paths.length > 0
		? `It has conflicts in ${listPaths(paths)}. Finish it from a terminal (${kind.resolve})`
		: `Its conflicts are resolved but it is not finished. Finish it from a terminal (${kind.finish})`;
	return {
		title,
		body: `${state} or abandon it (${kind.abandon}) before using the app on this site. Until then, linking tickets, applying patches, discarding changes and updating trunk are refused here.`
	};
}

/**
 * The one-line refusal main returns from every write while the operation is
 * open: the notice, as a sentence.
 *
 * @param {{kind: string, paths: string[]}} mergeInProgress
 * @return {string}
 */
function mergeInProgressError(mergeInProgress) {
	const notice = mergeInProgressNotice({ mergeInProgress });
	return `${notice.title} ${notice.body}`;
}

/**
 * The refusal when the read itself failed: the app does not know whether an
 * operation is open, and a write that guessed "no" would erase one. Nothing
 * was changed, so trying again is the whole advice.
 *
 * @param {*} reason The error the read threw.
 * @return {string}
 */
function mergeCheckFailedError(reason) {
	const why = reason && reason.message ? String(reason.message).trim() : String(reason || '').trim();
	return 'The app could not check whether a merge is in progress in this checkout, so nothing was changed. '
		+ 'If a Git command is running in it from a terminal, let it finish, then try again.'
		+ (why ? ` (${why})` : '');
}

module.exports = { mergeInProgressNotice, mergeInProgressError, mergeCheckFailedError };
