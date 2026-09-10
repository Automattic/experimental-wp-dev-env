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

// One clause per kind of conflict Git reports, in the contributor's terms
// (#351). `content` is the classic clash; the other two are what a mentor
// looking at the same merge would call them, and "changed the same lines"
// would be false for both. `modify/delete` is the same word whichever side
// deleted (trunk removing a file the ticket edits, or the ticket removing
// one trunk edits), so its clause names no side. Anything Git names that is
// not listed here (`rename/delete`, `rename/rename`, `distinct types`)
// reads generically.
const KIND_CLAUSES = {
	content: (paths) => `Trunk changed the same lines as your work in: ${paths.join(', ')}`,
	'modify/delete': (paths) => `Deleted on one side and changed on the other: ${paths.join(', ')}`,
	'add/add': (paths) => `Trunk added ${paths.length === 1 ? 'a file' : 'files'} your work also adds, with different content: ${paths.join(', ')}`
};
const OTHER_CLAUSE = (paths) => `Trunk and your work disagree in: ${paths.join(', ')}`;

/**
 * What the panel says when the move is refused.
 *
 * @param {Object}             root0
 * @param {string}             [root0.code]      `rebase-conflict`, `no-base`, `on-trunk`, or anything main returns.
 * @param {string[]}           [root0.conflicts] Paths, for `rebase-conflict`.
 * @param {Object}             [root0.kinds]     Path → kind of conflict, for `rebase-conflict`; a path with no kind reads generically.
 * @param {string}             [root0.error]     Main's sentence, used for codes this module has no words for.
 * @param {string|number|null} [root0.ticketId]
 * @return {string}
 */
function rebaseRefusal({ code = '', conflicts = [], kinds = {}, error = '', ticketId = null } = {}) {
	const ticket = ticketId || 'the ticket';
	if (code === 'rebase-conflict') {
		// No paths means Git reported the conflict in a shape the parser did
		// not read: the one case where the app knows least, so it claims least.
		if (!conflicts.length) return `Trunk and your work disagree. Nothing was moved. ${MANUAL_PATH(ticket)}`;
		const grouped = new Map();
		for (const p of conflicts) {
			// Own property only: a kind that names something inherited
			// (`constructor`) must not slip into a group nothing renders.
			const kind = kinds && Object.hasOwn(KIND_CLAUSES, kinds[p]) ? kinds[p] : 'other';
			if (!grouped.has(kind)) grouped.set(kind, []);
			grouped.get(kind).push(p);
		}
		// Known kinds first, in the order they are declared, so the classic
		// clash leads when the list is mixed.
		const clauses = [...Object.keys(KIND_CLAUSES), 'other']
			.filter((kind) => grouped.has(kind))
			.map((kind) => (KIND_CLAUSES[kind] || OTHER_CLAUSE)(grouped.get(kind)));
		return `${clauses.join('. ')}. Nothing was moved. ${MANUAL_PATH(ticket)}`;
	}
	if (code === 'no-base') {
		return `The app does not know which trunk #${ticket} started from, so it cannot move the work safely. ${MANUAL_PATH(ticket)}`;
	}
	return error || 'Could not move the ticket onto the current trunk.';
}

module.exports = { ticketTrunkNotice, rebaseRefusal };
