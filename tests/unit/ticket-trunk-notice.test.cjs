'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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
	assert.match(rebaseRefusal({ code: 'no-base', ticketId: 123 }), /which trunk #123 started from/);
	assert.equal(rebaseRefusal({ code: 'legacy-site', error: 'the sentence' }), 'the sentence');
	assert.equal(rebaseRefusal({}), 'Could not move the ticket onto the current trunk.');
});

test('ticketTrunkNotice stays silent without a ticket or a known move (#305)', () => {
	for (const state of [
		{ ticketId: null, behind: true },
		{ ticketId: 123, behind: false },
		{ ticketId: 123 }
	]) assert.equal(ticketTrunkNotice(state), null);
});

test('the ticket card renders the stale-ticket notice returned by status (#305)', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.jsx'), 'utf8');
	assert.match(source, /setTicketBehindTrunk\(Boolean\(s\?\.ticketBehindTrunk\)\)/);
	assert.match(source, /ticketTrunkNotice\(\{ ticketId: tracTicket, behind: ticketBehindTrunk \}\)/);
	assert.match(source, /staleTicketNotice\.title/);
	assert.match(source, /staleTicketNotice\.body/);
	assert.match(source, /staleTicketNotice\.action/);
	assert.match(source, /window\.api\.rebaseBranch\(sitePath\)/);
	assert.match(source, /setTicketError\(rebaseRefusal\(/);
	assert.match(
		source,
		/setTicketBehindTrunk\(false\);\s+setTracTicket\(res\.ticket\);/,
		'a switched ticket must not render with the previous ticket\'s stale flag'
	);
});
