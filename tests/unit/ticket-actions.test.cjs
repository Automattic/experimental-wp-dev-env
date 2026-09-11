'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ticketActionDisabledReason, rebaseDisabledReason, dirtyTrunkQuestion } = require('../../src/renderer/ticket-actions.cjs');

// A disabled control with no reason is the bug (#409): the ticketActionsBlocked
// gate used to disable the card's buttons silently. Every branch of it has a
// sentence, and an idle app has none.
test('ticketActionDisabledReason has a sentence for every branch of the gate and none when idle (#409)', () => {
	assert.equal(ticketActionDisabledReason(), null);
	assert.equal(ticketActionDisabledReason({ ticketSaving: false, deletingBranch: null, updateState: 'idle', installing: false, building: false }), null);
	assert.match(ticketActionDisabledReason({ ticketSaving: true }), /ticket change to finish/);
	assert.match(ticketActionDisabledReason({ deletingBranch: 'refs/heads/ticket-1' }), /finish deleting/);
	for (const updateState of ['fetching', 'installing', 'building']) {
		assert.match(ticketActionDisabledReason({ updateState }), /trunk update to finish/, updateState);
	}
	assert.match(ticketActionDisabledReason({ installing: true }), /installation to finish/);
	assert.match(ticketActionDisabledReason({ building: true }), /build to finish/);
});

// Several guards go true at once while state settles; the one already
// underway wins so the sentence does not flicker between reasons.
test('ticketActionDisabledReason reports the action underway before a process it could wait for', () => {
	assert.match(ticketActionDisabledReason({ ticketSaving: true, updateState: 'fetching', installing: true }), /ticket change/);
	assert.match(ticketActionDisabledReason({ deletingBranch: 'x', building: true }), /deleting/);
	assert.match(ticketActionDisabledReason({ updateState: 'building', building: true }), /trunk update/);
});

// The move onto trunk rewrites the checked-out tree, so it is gated like a
// discard on top of the shared gate. Both extra guards name the button.
test('rebaseDisabledReason adds the tree-rewrite guards after the shared gate (#409)', () => {
	assert.equal(rebaseDisabledReason(), null);
	assert.equal(rebaseDisabledReason({ devServerActive: false, discarding: false }), null);
	assert.equal(rebaseDisabledReason({ devServerActive: true }), 'Stop the dev server before updating the ticket.');
	assert.equal(rebaseDisabledReason({ discarding: true }), 'Wait for the discard to finish before updating the ticket.');
	// The shared gate still leads: a trunk update with the dev server running
	// reports the update, which clears on its own.
	assert.match(rebaseDisabledReason({ updateState: 'fetching', devServerActive: true }), /trunk update/);
	assert.match(rebaseDisabledReason({ discarding: true, devServerActive: true }), /discard/);
});

test('dirtyTrunkQuestion counts the files and offers the carry for a new ticket (#234)', () => {
	const one = dirtyTrunkQuestion({ files: 1, canCarry: true, ticket: 123 });
	assert.equal(one.question, 'You have 1 uncommitted change on this site, not on any ticket yet. What should happen to them?');
	assert.equal(one.carry, 'Take these edits into #123');
	assert.equal(one.save, 'Save them as a patch, then start clean…');
	assert.equal(one.discard, 'Discard them and start clean');
	assert.equal(one.cancel, 'Cancel');
	assert.match(dirtyTrunkQuestion({ files: 3, canCarry: true }).question, /^You have 3 uncommitted changes/);
	assert.equal(dirtyTrunkQuestion({ canCarry: true }).carry, 'Take these edits into the ticket');
	assert.match(dirtyTrunkQuestion({ canCarry: true }).question, /^You have uncommitted changes on this site/);
});

// An existing ticket has parked work that the switch restores, so "start
// clean" is false for it: the answers say what actually happens (#409).
test('dirtyTrunkQuestion says "continue on #N" and drops the carry when the ticket has parked work (#409)', () => {
	const parked = dirtyTrunkQuestion({ files: 2, canCarry: false, ticket: 123 });
	assert.equal(parked.carry, null);
	assert.match(parked.question, /already has its own work here, so these edits cannot come along into it\.$/);
	assert.equal(parked.save, 'Save them as a patch, then continue on #123…');
	assert.equal(parked.discard, 'Discard them and continue on #123');
	assert.equal(parked.cancel, 'Cancel');
	assert.doesNotMatch(parked.save + parked.discard, /start clean/);
	assert.equal(dirtyTrunkQuestion({ canCarry: false }).discard, 'Discard them and continue on the ticket');
	// The default is the safe reading: no carry offered unless main said so.
	assert.equal(dirtyTrunkQuestion({}).carry, null);
});
