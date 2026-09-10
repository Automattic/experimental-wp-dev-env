// The changes note's sentence and placement, and the discard guards. All the
// branching lives in changes-note.cjs so this suite can reach it without a
// DOM; index.jsx only interleaves the parts with its two link buttons.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	changesNoteParts,
	discardOutcome,
	noteAfterDiscard,
	noteAfterProbe,
	discardBlocked,
	discardDisabledReason,
	DISCARD_CONFIRM_MESSAGE
} = require('../../src/renderer/changes-note.cjs');

test('changesNoteParts says nothing about a clean tree', () => {
	assert.equal(changesNoteParts({ dirty: false, changedCount: 0, tracTicket: null }), null);
	assert.equal(changesNoteParts({ dirty: false, changedCount: 3, tracTicket: '12345' }), null);
	assert.equal(changesNoteParts({}), null);
	assert.equal(changesNoteParts(), null);
});

test('changesNoteParts places an unticketed note by the buttons', () => {
	const parts = changesNoteParts({ dirty: true, changedCount: 3, tracTicket: null });
	assert.equal(parts.placement, 'buttons');
	assert.equal(parts.lead, 'You have 3 changes not assigned to any ticket. You can ');
});

test('changesNoteParts places a ticketed note in the ticket card and names the ticket', () => {
	const parts = changesNoteParts({ dirty: true, changedCount: 3, tracTicket: '12345' });
	assert.equal(parts.placement, 'ticket');
	assert.equal(parts.lead, 'You have 3 unsubmitted changes for ticket #12345. You can ');
});

test('changesNoteParts names the modal in the ticket card and the patch by the buttons', () => {
	// The ticket sentence already says where the changes go, so its link
	// borrows the modal's own name; by the buttons the link says what it
	// produces instead.
	assert.equal(changesNoteParts({ dirty: true, tracTicket: '12345' }).patchLabel, 'review and submit');
	assert.equal(changesNoteParts({ dirty: true, tracTicket: null }).patchLabel, 'create and save a patch');
});

test('changesNoteParts reassures about Unlink only where Unlink is', () => {
	const ticket = changesNoteParts({ dirty: true, changedCount: 1, tracTicket: '12345' });
	assert.equal(
		ticket.unlinkNote,
		'Unlinking this ticket doesn\'t affect your local changes for this ticket — they remain attached to it in this site, ready for when you link it again.'
	);
	assert.equal(changesNoteParts({ dirty: true, changedCount: 1, tracTicket: null }).unlinkNote, undefined);
});

test('changesNoteParts uses the singular for one change', () => {
	assert.equal(
		changesNoteParts({ dirty: true, changedCount: 1, tracTicket: null }).lead,
		'You have 1 change not assigned to any ticket. You can '
	);
	assert.equal(
		changesNoteParts({ dirty: true, changedCount: 1, tracTicket: '12345' }).lead,
		'You have 1 unsubmitted change for ticket #12345. You can '
	);
});

test('changesNoteParts stays true when the count is missing', () => {
	// A dirty answer can arrive without a usable count; "changes" is still
	// accurate where "0 changes" would be a lie next to a discard link.
	for (const changedCount of [undefined, 0, -1, 2.5]) {
		assert.equal(
			changesNoteParts({ dirty: true, changedCount, tracTicket: null }).lead,
			'You have changes not assigned to any ticket. You can '
		);
	}
	assert.equal(
		changesNoteParts({ dirty: true, tracTicket: '12345' }).lead,
		'You have unsubmitted changes for ticket #12345. You can '
	);
});

test('changesNoteParts always offers a discard, in the same words', () => {
	for (const tracTicket of [null, '12345']) {
		const parts = changesNoteParts({ dirty: true, changedCount: 2, tracTicket });
		assert.equal(parts.middle, ' or ');
		assert.equal(parts.discardLabel, 'discard your changes');
		assert.equal(parts.end, '.');
	}
});

test('the confirm message matches the dirty-update modal byte for byte', () => {
	// index.jsx used this literal before the note existed; one action, one
	// wording, wherever it is triggered from.
	assert.equal(DISCARD_CONFIRM_MESSAGE, 'Discard all local changes? This cannot be undone.');
});

test('discardOutcome passes a success through', () => {
	assert.deepEqual(discardOutcome({ ok: true }), { ok: true });
});

test('discardOutcome carries the recount of what survived the discard (#239)', () => {
	// On a ticket branch the parked work survives a discard, and the reply
	// says how much. Dropping that here would leave the card marking the tree
	// clean over work that is still there — the silence #239 is about.
	assert.deepEqual(
		discardOutcome({ ok: true, dirty: true, changedCount: 2 }),
		{ ok: true, dirty: true, changedCount: 2 }
	);
	assert.deepEqual(
		discardOutcome({ ok: true, dirty: false, changedCount: 0 }),
		{ ok: true, dirty: false, changedCount: 0 }
	);
});

test('discardOutcome always carries a message on failure', () => {
	assert.deepEqual(discardOutcome({ ok: false, error: 'EACCES' }), {
		ok: false,
		message: 'Failed to discard changes: EACCES'
	});
	assert.deepEqual(discardOutcome({ ok: false }), {
		ok: false,
		message: 'Failed to discard changes: Unknown error'
	});
	assert.deepEqual(discardOutcome(null), {
		ok: false,
		message: 'Failed to discard changes: Unknown error'
	});
});

test('noteAfterDiscard keeps the note over work the discard did not take (#239)', () => {
	// The case the recount exists for: on a ticket branch the parked WIP
	// survives the reset, so the card must not go quiet over it.
	assert.deepEqual(
		noteAfterDiscard({ ok: true, dirty: true, changedCount: 2 }),
		{ dirty: true, changedCount: 2 }
	);
	assert.deepEqual(
		noteAfterDiscard({ ok: true, dirty: false, changedCount: 0 }),
		{ dirty: false, changedCount: 0 }
	);
});

test('noteAfterDiscard falls back to clean when the reply carries no recount (#239)', () => {
	// What the old markTreeClean asserted unconditionally. A reply without a
	// recount — the count itself failed — must not invent a dirty note; the
	// next probe is what corrects it either way.
	assert.deepEqual(noteAfterDiscard({ ok: true }), { dirty: false, changedCount: 0 });
	assert.deepEqual(noteAfterDiscard({ ok: false, message: 'EACCES' }), { dirty: false, changedCount: 0 });
	assert.deepEqual(noteAfterDiscard(undefined), { dirty: false, changedCount: 0 });
	// A count that arrives unusable next to a true `dirty` still leaves the
	// note honest — "you have changes", with no number (see changesNoteParts).
	assert.deepEqual(
		noteAfterDiscard({ ok: true, dirty: true, changedCount: undefined }),
		{ dirty: true, changedCount: 0 }
	);
});

test('noteAfterProbe clears an old count when the base cannot be measured (#308)', () => {
	assert.deepEqual(
		noteAfterProbe({ dirty: true, changedCount: 4 }, { ok: false, error: 'Unknown ticket base' }),
		null
	);
	assert.deepEqual(
		noteAfterProbe(null, { ok: true, dirty: true, changedCount: 2 }),
		{ dirty: true, changedCount: 2 }
	);
});
test('discardBlocked holds the discard while anything is rewriting the tree', () => {
	// The same states that block starting a trunk update: a force checkout
	// under a running install, build or dev server corrupts both.
	assert.equal(discardBlocked({}), false);
	assert.equal(discardBlocked(), false);
	for (const flag of ['isUpdating', 'installing', 'building', 'devServerActive', 'discarding']) {
		assert.equal(discardBlocked({ [flag]: true }), true, flag);
	}
});

test('discardDisabledReason explains every state that makes discard unavailable', () => {
	assert.equal(discardDisabledReason({ patchLoading: true, patchHasChanges: true }), 'Wait for your changes to finish loading.');
	assert.equal(discardDisabledReason({ patchLoadFailed: true, patchHasChanges: false }), 'Changes could not be loaded.');
	assert.equal(discardDisabledReason({ patchHasChanges: false }), 'There are no changes to discard.');
	assert.equal(discardDisabledReason({ patchHasChanges: true, discarding: true }), 'Changes are already being discarded.');
	assert.equal(discardDisabledReason({ patchHasChanges: true, isUpdating: true }), 'Wait for the trunk update to finish before discarding changes.');
	assert.equal(discardDisabledReason({ patchHasChanges: true, installing: true }), 'Wait for the installation to finish before discarding changes.');
	assert.equal(discardDisabledReason({ patchHasChanges: true, building: true }), 'Wait for the build to finish before discarding changes.');
	assert.equal(discardDisabledReason({ patchHasChanges: true, devServerActive: true }), 'Stop the dev server before discarding changes.');
	assert.equal(discardDisabledReason({ patchHasChanges: true }), null);
});

test('discardDisabledReason reports the operation in progress before secondary blockers', () => {
	assert.equal(
		discardDisabledReason({ patchLoading: true, patchHasChanges: false, discarding: true, devServerActive: true }),
		'Changes are already being discarded.'
	);
});
