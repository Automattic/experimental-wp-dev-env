'use strict';

/**
 * Why a ticket action is unavailable, and what the dirty-trunk question says
 * (#409). Every ticket action on the card (link, switch, unlink, delete work,
 * move onto trunk, the four answers to the dirty-trunk question) shares one
 * gate; the move onto trunk rewrites the checked-out tree, so it adds the
 * discard's guards on top. Each branch that disables a control has a sentence
 * here, because a disabled control carrying its reason as `title` explains
 * nothing: Chromium shows no tooltip on a disabled element and assistive
 * technology skips one with the real `disabled` attribute. `ReasonedButton`
 * in `index.jsx` renders the sentence, and is the only sanctioned way to
 * disable a ticket action: a bare `disabled=` on one of these controls is
 * the bug this module exists to close.
 *
 * Ordered like `discardDisabledReason` in `changes-note.cjs`: the action
 * already underway first, then the processes the contributor can wait for or
 * stop, so a state with several guards true reports the one that will clear
 * on its own.
 *
 * @param {{ticketSaving?: boolean, deletingBranch?: string|null, updateState?: string,
 *          installing?: boolean, building?: boolean}} state
 * @return {string|null} Null when nothing blocks the action.
 */
function ticketActionDisabledReason({ ticketSaving, deletingBranch, updateState = 'idle', installing, building } = {}) {
	if (ticketSaving) return 'Wait for the current ticket change to finish.';
	if (deletingBranch) return "Wait for the ticket's work to finish deleting.";
	if (updateState !== 'idle') return 'Wait for the trunk update to finish.';
	if (installing) return 'Wait for the installation to finish.';
	if (building) return 'Wait for the build to finish.';
	return null;
}

/**
 * Why "Update this ticket to the current trunk" is unavailable: the shared
 * gate, then the guards a tree rewrite needs (a running dev server, a discard
 * in flight), the same ones the discard action checks.
 *
 * @param {{ticketSaving?: boolean, deletingBranch?: string|null, updateState?: string,
 *          installing?: boolean, building?: boolean, devServerActive?: boolean,
 *          discarding?: boolean}} state
 * @return {string|null}
 */
function rebaseDisabledReason(state = {}) {
	// `discarding` leads, as it does in `discardDisabledReason`: a discard is
	// already rewriting the tree, and reporting an install the contributor
	// could wait out would name the wrong thing. The rest of the shared gate
	// follows, then the dev server, which is the one the contributor has to
	// act on rather than wait for.
	if (state.discarding) return 'Wait for the discard to finish before updating the ticket.';
	const shared = ticketActionDisabledReason(state);
	if (shared) return shared;
	if (state.devServerActive) return 'Stop the dev server before updating the ticket.';
	return null;
}

/**
 * The dirty-trunk question (#234): trunk has uncommitted edits and the
 * contributor picked a ticket. The three answers change with `canCarry`: a
 * new ticket can take the edits along and otherwise starts clean, but an
 * existing ticket has parked work that the switch restores, so nothing
 * starts clean there and the answers say "continue on #N" instead.
 *
 * @param {Object}             root0
 * @param {number}             [root0.files]    How many files are dirty, 0 when unknown.
 * @param {boolean}            [root0.canCarry] Whether the edits can ride into the ticket.
 * @param {string|number|null} [root0.ticket]   Ticket being picked, for the labels.
 * @return {{question: string, carry: string|null, save: string, discard: string, cancel: string}}
 */
function dirtyTrunkQuestion({ files = 0, canCarry = false, ticket = null } = {}) {
	const count = files
		? `You have ${files === 1 ? '1 uncommitted change' : `${files} uncommitted changes`} on this site, not on any ticket yet.`
		: 'You have uncommitted changes on this site, not on any ticket yet.';
	const name = ticket ? `#${ticket}` : 'the ticket';
	if (canCarry) {
		return {
			question: `${count} What should happen to them?`,
			carry: `Take these edits into ${name}`,
			save: 'Save them as a patch, then start clean…',
			discard: 'Discard them and start clean',
			cancel: 'Cancel'
		};
	}
	return {
		question: `${count} What should happen to them? This ticket already has its own work here, so these edits cannot come along into it.`,
		carry: null,
		save: `Save them as a patch, then continue on ${name}…`,
		discard: `Discard them and continue on ${name}`,
		cancel: 'Cancel'
	};
}

module.exports = { ticketActionDisabledReason, rebaseDisabledReason, dirtyTrunkQuestion };
