'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
	initialConfirmations,
	confirmationReducer,
	prConfirmationMessage,
	deleteFailureMessage,
	MAX_NOTICES
} = require('../../src/renderer/confirmations.cjs');

test('a success confirmation speaks politely and clears itself (issue #253)', () => {
	const state = confirmationReducer(initialConfirmations, { type: 'add', content: 'Patch saved to my.patch' });

	assert.strictEqual(state.notices.length, 1);
	const [notice] = state.notices;
	assert.strictEqual(notice.content, 'Patch saved to my.patch');
	assert.strictEqual(notice.tone, 'success');
	assert.strictEqual(notice.politeness, 'polite', 'a confirmation must not interrupt the screen reader');
	assert.strictEqual(notice.explicitDismiss, false, 'a success must auto-dismiss');
});

test('the tone defaults to success when none is given', () => {
	const state = confirmationReducer(initialConfirmations, { type: 'add', content: 'Reverted' });

	assert.strictEqual(state.notices[0].tone, 'success');
});

test('an error confirmation speaks assertively and stays until dismissed (issue #253)', () => {
	const state = confirmationReducer(initialConfirmations, { type: 'add', content: 'Could not save', tone: 'error' });

	const [notice] = state.notices;
	assert.strictEqual(notice.tone, 'error');
	assert.strictEqual(notice.politeness, 'assertive', 'an error must be read out at once');
	assert.strictEqual(notice.explicitDismiss, true, 'an error must not vanish before it is read');
});

test('every confirmation gets a distinct id from a running counter', () => {
	let state = confirmationReducer(initialConfirmations, { type: 'add', content: 'First' });
	state = confirmationReducer(state, { type: 'add', content: 'Second' });

	assert.deepStrictEqual(state.notices.map((n) => n.id), [1, 2]);
});

test('a repeat of the confirmation already on top is ignored', () => {
	let state = confirmationReducer(initialConfirmations, { type: 'add', content: 'Up to date with trunk' });
	state = confirmationReducer(state, { type: 'add', content: 'Up to date with trunk' });

	assert.strictEqual(state.notices.length, 1, 'a double-click reads as one confirmation');
});

test('the same message with a different tone is not treated as a duplicate', () => {
	let state = confirmationReducer(initialConfirmations, { type: 'add', content: 'Saved' });
	state = confirmationReducer(state, { type: 'add', content: 'Saved', tone: 'error' });

	assert.strictEqual(state.notices.length, 2);
});

test('an empty message queues nothing', () => {
	const state = confirmationReducer(initialConfirmations, { type: 'add', content: '' });

	assert.strictEqual(state, initialConfirmations, 'the state is handed back untouched');
});

test('only the most recent confirmations are kept when a burst arrives', () => {
	let state = initialConfirmations;
	for (let i = 1; i <= MAX_NOTICES + 2; i += 1) {
		state = confirmationReducer(state, { type: 'add', content: `Step ${i}` });
	}

	assert.strictEqual(state.notices.length, MAX_NOTICES);
	assert.strictEqual(state.notices[0].content, `Step ${3}`, 'the oldest ones drop off the front');
	assert.strictEqual(state.notices[state.notices.length - 1].content, `Step ${MAX_NOTICES + 2}`);
});

test('removing a confirmation by id drops just that one', () => {
	let state = confirmationReducer(initialConfirmations, { type: 'add', content: 'First' });
	state = confirmationReducer(state, { type: 'add', content: 'Second' });
	state = confirmationReducer(state, { type: 'remove', id: 1 });

	assert.deepStrictEqual(state.notices.map((n) => n.content), ['Second']);
});

test('removing an id that matches nothing returns the same state object', () => {
	const state = confirmationReducer(initialConfirmations, { type: 'add', content: 'First' });
	const after = confirmationReducer(state, { type: 'remove', id: 999 });

	assert.strictEqual(after, state, 'no needless re-render for a no-op removal');
});

test('an opened pull request is confirmed by its number (issue #253)', () => {
	assert.strictEqual(
		prConfirmationMessage({ ok: true, number: 42 }),
		'Opened pull request #42'
	);
});

test('a dry run says no pull request was opened rather than "#undefined" (issue #253)', () => {
	assert.strictEqual(
		prConfirmationMessage({ ok: true, dryRun: true, branch: 'fix/thing' }),
		'Dry run — branch created, no pull request opened'
	);
});

test('a failed deletion says the listed site can be retried and names the code (#414)', () => {
	assert.strictEqual(
		deleteFailureMessage({ ok: false, reason: 'remove-failed', path: '/sites/demo', code: 'EPERM' }),
		'The site is still listed because its folder could not be deleted (EPERM). Close anything using it, then try again. Folder: /sites/demo'
	);
});

test('a deletion failure without a code still reads as a sentence (#414)', () => {
	assert.strictEqual(
		deleteFailureMessage({ ok: false, reason: 'remove-failed', path: '/sites/demo' }),
		'The site is still listed because its folder could not be deleted. Close anything using it, then try again. Folder: /sites/demo'
	);
});

test('a clean deletion, a refusal, and a malformed result all stay silent (issue #381)', () => {
	assert.strictEqual(deleteFailureMessage({ ok: true }), null);
	assert.strictEqual(deleteFailureMessage({ ok: false, refused: true }), null);
	assert.strictEqual(deleteFailureMessage({}), null);
	assert.strictEqual(deleteFailureMessage(), null);
});
