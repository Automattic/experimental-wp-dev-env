'use strict';

/**
 * The ticket card's answer when a ticket predates current trunk (#305, #385).
 * The main process performs the recorded-base comparison; unknown stays
 * silent. Since the bundled Git the notice offers the move itself, one click
 * that replays the ticket's work onto trunk (`branches:rebase`), and this
 * module also words its refusals: a conflict names the files and hands the
 * contributor the manual path, which is still the way to review the result.
 *
 * @param {Object}             root0
 * @param {string|number|null} root0.ticketId Ticket currently linked.
 * @param {boolean}            root0.behind   Whether its base differs from trunk.
 * @return {{title: string, body: string, action: string}|null}
 */
function ticketTrunkNotice({ ticketId = null, behind = false } = {}) {
	if (!ticketId || !behind) return null;
	return {
		title: 'Trunk has moved since this ticket started.',
		body: 'Newer patches may not apply cleanly. Move your work onto the current trunk here, or save a copy of it and start the ticket again.',
		action: 'Update this ticket to the current trunk'
	};
}

const MANUAL_PATH = (ticketId) => `Save a copy of your work, unlink the ticket, delete its work from the site, then link #${ticketId} again and apply the copy.`;

/**
 * What the panel says when the move is refused.
 *
 * @param {Object}             root0
 * @param {string}             [root0.code]      `rebase-conflict`, `no-base`, `on-trunk`, or anything main returns.
 * @param {string[]}           [root0.conflicts] Paths, for `rebase-conflict`.
 * @param {string}             [root0.error]     Main's sentence, used for codes this module has no words for.
 * @param {string|number|null} [root0.ticketId]
 * @return {string}
 */
function rebaseRefusal({ code = '', conflicts = [], error = '', ticketId = null } = {}) {
	const ticket = ticketId || 'the ticket';
	if (code === 'rebase-conflict') {
		const list = conflicts.length ? ` in: ${conflicts.join(', ')}` : '';
		return `Trunk changed the same lines as your work${list}. Nothing was moved. ${MANUAL_PATH(ticket)}`;
	}
	if (code === 'no-base') {
		return `The app does not know which trunk #${ticket} started from, so it cannot move the work safely. ${MANUAL_PATH(ticket)}`;
	}
	return error || 'Could not move the ticket onto the current trunk.';
}

module.exports = { ticketTrunkNotice, rebaseRefusal };
