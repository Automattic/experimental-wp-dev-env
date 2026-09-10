'use strict';

/**
 * The queue behind the app's "that worked" confirmations (#253).
 *
 * Actions used to complete silently, or leave an inline sentence the
 * contributor may not be looking at, and none of the success notices reached a
 * screen reader. This is the one place a completed action is confirmed: a
 * transient message that `SnackbarList` renders and speaks. The reducer holds
 * the list; the renderer only dispatches and paints.
 *
 * Kept as a pure, dependency-free module so it can be unit tested without a
 * DOM: the renderer bundle imports it, `node --test` requires it directly. The
 * `id` comes from a running counter rather than a timestamp or random value so
 * the reducer stays deterministic under test.
 *
 * Tone drives accessibility, not just colour:
 *   - `success` speaks politely and clears itself on a timer — a confirmation
 *     the contributor does not have to act on.
 *   - `error` speaks assertively and stays until dismissed, so it is not gone
 *     before it has been read. Supported here so successes and errors can share
 *     one mechanism (#253). The first error emitter is the site deletion
 *     that half-happened (#381).
 */

// At most this many confirmations are kept on screen at once. A burst — a
// double-click, a chain of steps finishing together — collapses to the most
// recent few rather than stacking into a wall.
const MAX_NOTICES = 3;

const initialConfirmations = { seq: 0, notices: [] };

function politenessFor(tone) {
	return tone === 'error' ? 'assertive' : 'polite';
}

/**
 * @param {Object} state  The queue: `{ seq, notices }`.
 * @param {Object} action `{ type: 'add', content, tone }` or `{ type: 'remove', id }`.
 */
function confirmationReducer(state = initialConfirmations, action = {}) {
	switch (action.type) {
		case 'add': {
			const content = action.content;
			// Nothing to announce, nothing to queue.
			if (!content) return state;
			const tone = action.tone === 'error' ? 'error' : 'success';

			// Ignore a repeat of what is already on top: a double-click on Save
			// should read as one confirmation, not two identical ones.
			const newest = state.notices[state.notices.length - 1];
			if (newest && newest.content === content && newest.tone === tone) {
				return state;
			}

			const seq = state.seq + 1;
			const notice = {
				id: seq,
				content,
				tone,
				politeness: politenessFor(tone),
				explicitDismiss: tone === 'error'
			};
			const notices = [...state.notices, notice].slice(-MAX_NOTICES);
			return { seq, notices };
		}
		case 'remove': {
			const notices = state.notices.filter((n) => n.id !== action.id);
			// Referential stability matters to React: an id that matched nothing
			// should not hand back a fresh array and a needless re-render.
			if (notices.length === state.notices.length) return state;
			return { seq: state.seq, notices };
		}
		default:
			return state;
	}
}

/**
 * The confirmation line for a completed pull-request attempt (#253). A dry run
 * (WP_DEV_ENV_GITHUB_DRY_RUN) stops after the branch and opens no request, so it
 * says so rather than announcing a "pull request #undefined". Kept here, beside
 * the rest of the confirmation logic, because it is a user-read string chosen by
 * a branch — the kind that must not live untested in index.jsx.
 *
 * @param {{ dryRun?: boolean, number?: number }} res The main process's result.
 */
function prConfirmationMessage(res = {}) {
	if (res.dryRun) return 'Dry run — branch created, no pull request opened';
	return `Opened pull request #${res.number}`;
}

/**
 * The notice for a site deletion, or null when there is nothing to say (#381).
 *
 * Only a failure speaks. The registry entry now stays in place until the folder
 * is gone, so the message says the deletion can be retried after the contributor
 * releases whatever still holds the directory. It names the path and carries
 * the error code because "could not be deleted" without either is the kind of
 * report a mentor cannot act on.
 *
 * @param {{ ok?: boolean, reason?: string, path?: string, code?: string }} res The main process's result.
 */
function deleteFailureMessage(res = {}) {
	if (res.ok !== false || res.reason !== 'remove-failed') return null;
	const code = res.code ? ` (${res.code})` : '';
	return `The site is still listed because its folder could not be deleted${code}. Close anything using it, then try again. Folder: ${res.path}`;
}

module.exports = { initialConfirmations, confirmationReducer, prConfirmationMessage, deleteFailureMessage, MAX_NOTICES };
