'use strict';

// Colouring a linked pull request by its state (#227). No test renders the DOM
// here, so what is testable is the mapping the row reads its colours from, and
// that the row still reads it rather than restating the old grey text.

const test = require('node:test');
const assert = require('node:assert');
const { PR_STATE_BADGES, prStateBadge } = require('../../src/renderer/pr-state.cjs');

// The accessibility rule the design is built on: colour accompanies the word,
// it never replaces it. A pill with a colour and no label tells a contributor
// who cannot separate red from green less than the plain text it replaced.
test('every state keeps its word, not only its colour (issue #227)', () => {
	for (const [state, badge] of Object.entries(PR_STATE_BADGES)) {
		assert.strictEqual(badge.label, state, `${state} must be labelled with its own word`);
	}
});

test('the three states are told apart by colour, all three of them (issue #227)', () => {
	const backgrounds = Object.values(PR_STATE_BADGES).map((b) => b.background);
	const foregrounds = Object.values(PR_STATE_BADGES).map((b) => b.color);
	assert.strictEqual(new Set(backgrounds).size, 3, 'two states share a background, so they read as the same outcome');
	assert.strictEqual(new Set(foregrounds).size, 3, 'two states share a text colour');
});

// Red means "something failed" everywhere else in this window. A closed pull
// request is not a failure, so the closed pill must not be dressed as one: it
// wears GitHub's red, not the error pair the alert boxes are painted with.
test('the closed pill is not the error styling used elsewhere (issue #227)', () => {
	const closed = prStateBadge('closed');
	assert.notStrictEqual(closed.background, '#fcf0f1');
	assert.notStrictEqual(closed.color, '#d63638');
});

test('an unknown or missing state reads as open, the way the row has always behaved (issue #227)', () => {
	assert.deepStrictEqual(prStateBadge('draft'), PR_STATE_BADGES.open);
	assert.deepStrictEqual(prStateBadge(''), PR_STATE_BADGES.open);
	assert.deepStrictEqual(prStateBadge(undefined), PR_STATE_BADGES.open);
	assert.deepStrictEqual(prStateBadge(null), PR_STATE_BADGES.open);
	// GitHub answers in lower case, but a cached list should not lose its colour
	// over capitalisation either.
	assert.deepStrictEqual(prStateBadge('MERGED'), PR_STATE_BADGES.merged);
});
