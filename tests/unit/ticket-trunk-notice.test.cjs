'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ticketTrunkNotice, rebaseRefusal } = require('../../src/renderer/ticket-trunk-notice.cjs');

test('ticketTrunkNotice says what changed and offers the move (#305, #385)', () => {
	assert.deepStrictEqual(ticketTrunkNotice({ ticketId: 123, behind: true }), {
		title: 'Trunk has moved since this ticket started.',
		body: 'Newer patches may not apply cleanly. Move your work onto the current trunk here, or save a copy of it and start the ticket again.',
		action: 'Update this ticket to the current trunk'
	});
});

test('rebaseRefusal names the files that clash and hands over the manual path (#385)', () => {
	const sentence = rebaseRefusal({ code: 'rebase-conflict', conflicts: ['src/wp-login.php', 'src/wp-admin/about.php'], ticketId: 123 });
	assert.match(sentence, /src\/wp-login\.php, src\/wp-admin\/about\.php/);
	assert.match(sentence, /Nothing was moved/);
	assert.match(sentence, /link #123 again/);
	assert.match(rebaseRefusal({ code: 'rebase-conflict', ticketId: 123 }), /^Trunk and your work disagree\. Nothing was moved/);
	assert.match(rebaseRefusal({ code: 'no-base', ticketId: 123 }), /which trunk #123 started from/);
	assert.equal(rebaseRefusal({ code: 'legacy-site', error: 'the sentence' }), 'the sentence');
	assert.equal(rebaseRefusal({}), 'Could not move the ticket onto the current trunk.');
});

// The conflicts Git reports are not all "the same lines": a file trunk
// deleted, or one both sides created, is refused with the reason Git gives,
// not a sentence that is false for it (#351).
test('rebaseRefusal words each conflict by its kind, and a kind it has no words for generically (#351)', () => {
	const kinds = { 'src/a.php': 'content', 'src/b.php': 'content', 'src/gone.php': 'modify/delete', 'src/new.php': 'add/add', 'src/odd.php': 'rename/delete' };
	const sentence = rebaseRefusal({ code: 'rebase-conflict', conflicts: ['src/gone.php', 'src/a.php', 'src/new.php', 'src/odd.php', 'src/b.php'], kinds, ticketId: 123 });
	assert.strictEqual(sentence,
		'Trunk changed the same lines as your work in: src/a.php, src/b.php. '
		+ 'Deleted on one side and changed on the other: src/gone.php. '
		+ 'Trunk added a file your work also adds, with different content: src/new.php. '
		+ 'Trunk and your work disagree in: src/odd.php. '
		+ 'Nothing was moved. Save a copy of your work, unlink the ticket, delete its work from the site, then link #123 again and apply the copy.');
	// Without kinds (an older main, or a path Git gave no record for) the
	// path is still named, generically rather than as a clash it may not be.
	assert.match(rebaseRefusal({ code: 'rebase-conflict', conflicts: ['src/x.php'], ticketId: 1 }), /^Trunk and your work disagree in: src\/x\.php\. Nothing was moved/);
	assert.match(rebaseRefusal({ code: 'rebase-conflict', conflicts: ['src/x.php', 'src/y.php'], kinds: { 'src/x.php': 'modify/delete', 'src/y.php': 'modify/delete' }, ticketId: 1 }), /^Deleted on one side and changed on the other: src\/x\.php, src\/y\.php\./);
	// A kind naming an inherited property is not a clause: the path stays in
	// the sentence, generically, rather than vanishing from it.
	assert.match(rebaseRefusal({ code: 'rebase-conflict', conflicts: ['src/x.php'], kinds: { 'src/x.php': 'constructor' }, ticketId: 1 }), /^Trunk and your work disagree in: src\/x\.php\./);
});

test('ticketTrunkNotice stays silent without a ticket or a known move (#305)', () => {
	for (const state of [
		{ ticketId: null, behind: true },
		{ ticketId: 123, behind: false },
		{ ticketId: 123 }
	]) assert.equal(ticketTrunkNotice(state), null);
});
