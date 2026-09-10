'use strict';

/**
 * The provenance a handed-off patch carries (issue #166).
 *
 * The mentor handoff exists for the contributor who will not create a GitHub
 * account today: they save a patch, someone else pushes it, and the props still
 * have to land on them. That only works if the file says who made it, against
 * what, and when — so a header goes in the file itself rather than only in its
 * name, which survives exactly until the first person renames the download.
 *
 * #166 defines the format and #107 adopts it, rather than the two inventing one
 * each. Everything here is therefore about the shape of those lines, not about
 * when they are added: today only the handoff save prepends them, because a
 * patch attached to Trac conventionally carries no header and widening that is
 * #107's call.
 *
 * Prepending is safe for every reader in this app and for the ones outside it.
 * `git apply` and `patch` scan forward to the first file header and ignore what
 * precedes it; this app's own reader, `scanSections` in patch-plan.cjs, reacts
 * only to `diff --git` and `Index:` lines. `#` is the comment marker Trac and
 * Subversion patches already use, so nothing downstream has to learn a new one.
 *
 * Pure and dependency-free apart from the ticket URL helper, so `node --test`
 * can require it directly.
 */

const { ticketUrl } = require('./renderer/trac-ticket.cjs');
const { isHandle } = require('./wporg-handle.cjs');

const TITLE = '# WordPress Contributor Toolkit patch';

// Enough of a commit to identify it, the length git itself abbreviates to.
const SHORT_OID_LENGTH = 7;

// A header line is a line. Anything that could end this one and start another —
// or a value long enough to bury the diff — is not something a header field
// gets to do. src/safe-log.js makes the same argument about the log file;
// `describeRefused` is not reused here because these values are not refusals:
// a field this rejects is dropped from the header rather than described in it.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const MAX_FIELD_LENGTH = 120;

// "WordCamp Europe 2026 Contributor Day" fits with room to spare. Past this it
// is not an event name any more, and the header is not the place for a story.
const MAX_EVENT_LENGTH = 80;

/**
 * A string safe to put after `# Field: `, or null if there is nothing to say.
 *
 * @param {unknown} value
 * @return {string|null}
 */
function field(value) {
	if (typeof value !== 'string') return null;
	const oneLine = value.replace(CONTROL_CHARACTERS, ' ').trim();
	if (!oneLine) return null;
	return oneLine.length <= MAX_FIELD_LENGTH ? oneLine : oneLine.slice(0, MAX_FIELD_LENGTH);
}

/**
 * The calendar day of an ISO timestamp. The clock time is noise for every
 * question this header answers — is this newer than mine, what trunk is it on.
 *
 * @param {unknown} iso
 * @return {string|null}
 */
function day(iso) {
	const value = field(iso);
	if (!value) return null;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString().slice(0, 10);
}

/**
 * Reading what a contributor typed when asked where they are contributing from
 * — "WordCamp Europe 2026", "Madrid WordPress Meetup", a company's own
 * contributor day.
 *
 * It is free text on purpose. There is no canonical list of these, most of them
 * are named the day they happen, and an event this app has never heard of is
 * exactly the one a first-time contributor is at. So the only rules are the
 * ones the header itself imposes: one line, and short enough to stay a label.
 *
 * @param {string} input
 * @return {{ok: true, name: string}|{ok: false, error: string}}
 */
function parseEventName(input) {
	const raw = typeof input === 'string' ? input.trim() : '';
	if (!raw) return { ok: false, error: 'Enter the event name, or leave it empty.' };
	if (CONTROL_CHARACTERS.test(raw)) {
		// `test` on a /g regex advances lastIndex; reset it so the next call
		// does not start reading from where this one stopped.
		CONTROL_CHARACTERS.lastIndex = 0;
		return { ok: false, error: 'The event name has to fit on one line.' };
	}
	CONTROL_CHARACTERS.lastIndex = 0;
	if (raw.length > MAX_EVENT_LENGTH) {
		return { ok: false, error: `Keep the event name under ${MAX_EVENT_LENGTH} characters.` };
	}
	return { ok: true, name: raw };
}

/**
 * A ticket id, or null. Both the header and the filename want the number and
 * neither wants to guess at a half-parsed one.
 *
 * @param {unknown} ticketId
 * @return {number|null}
 */
function ticketNumber(ticketId) {
	const id = Number(ticketId);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The header block for a handed-off patch, newline-terminated and ending in a
 * blank line, or '' when there is nothing worth saying.
 *
 * Every field is optional and an unknown one is left out rather than written as
 * "unknown": a mentor reading this needs to be able to trust the lines that are
 * there, and a site that has never been updated genuinely has no base revision
 * recorded.
 *
 * @param {Object}        details
 * @param {string}        [details.handle]      WordPress.org handle, already validated.
 * @param {string}        [details.event]       Where it was written — a WordCamp, a meetup.
 * @param {number|string} [details.ticketId]
 * @param {string}        [details.trunkOid]
 * @param {string}        [details.trunkDate]   ISO timestamp of the base commit.
 * @param {string}        [details.generatedAt] ISO timestamp for "now".
 * @return {string}
 */
function buildProvenanceHeader({ handle, event, ticketId, trunkOid, trunkDate, generatedAt } = {}) {
	const lines = [];

	const contributor = field(handle);
	if (contributor) lines.push(`# Contributor: ${contributor} (wordpress.org)`);

	// Next to the contributor because it is part of the same answer: who made
	// this, and where. A mentor collecting patches at a contributor day is
	// looking at a folder of files from one room on one afternoon, and the
	// organisers of that room are who this line is ultimately for.
	const where = field(event);
	if (where) lines.push(`# Event: ${where}`);

	const ticket = ticketNumber(ticketId);
	if (ticket) lines.push(`# Ticket: ${ticketUrl(ticket)}`);

	const oid = field(trunkOid);
	const based = day(trunkDate);
	if (oid || based) {
		const base = [oid ? oid.slice(0, SHORT_OID_LENGTH) : null, based].filter(Boolean).join(', ');
		lines.push(`# Base: trunk @ ${base}`);
	}

	const generated = day(generatedAt);
	if (generated) lines.push(`# Generated: ${generated}`);

	if (!lines.length) return '';
	return `${[TITLE, ...lines].join('\n')}\n\n`;
}

/**
 * The name a handed-off patch is saved under. The handle is in the filename as
 * well as the header because it is what a mentor sorts a folder of these by;
 * the header is what survives a rename.
 *
 * The Trac-conventional sequence name (`59234.2.diff`) is deliberately not here
 * — that needs to know what is already attached to the ticket, which is #107's
 * scope.
 *
 * @param {Object}        details
 * @param {string}        [details.handle]
 * @param {number|string} [details.ticketId]
 * @return {string}
 */
function handoffFilename({ handle, ticketId } = {}) {
	// Only a stored handle reaches the filename — it is a path component, and a
	// value that never passed `parseHandle` is not one this should be repairing.
	// Falling back to the name the app has always used is the honest failure: a
	// patch still gets saved, it just carries no claim about who made it.
	if (!isHandle(handle)) return 'wordpress.patch';

	const ticket = ticketNumber(ticketId);
	return ticket ? `${ticket}.${handle}.diff` : `${handle}.diff`;
}

module.exports = {
	TITLE,
	MAX_FIELD_LENGTH,
	MAX_EVENT_LENGTH,
	parseEventName,
	buildProvenanceHeader,
	handoffFilename
};
