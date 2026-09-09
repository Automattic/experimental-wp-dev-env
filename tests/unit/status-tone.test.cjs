'use strict';

// The one map behind every status badge in the window. Nothing renders the DOM
// in these tests, so what is testable is the map itself and the promise it makes
// to tokens.css: a status resolves to a tone name, and that tone is one the
// stylesheet actually draws.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATUS_TONES, statusTone } = require('../../src/renderer/status-tone.cjs');
const { setupStepLabel } = require('../../src/renderer/setup-steps.cjs');

const TOKENS_CSS = path.join(__dirname, '..', '..', 'src', 'renderer', 'styles', 'tokens.css');

// The reason the map exists: the header pill and the checklist's uppercase words
// were two visual languages for the same idea. Both vocabularies resolve here.
test('site states and checklist step states both resolve to a tone', () => {
	for (const status of ['initialized', 'uninitialized', 'complete', 'current', 'pending', 'locked']) {
		assert.ok(STATUS_TONES[status], `${status} is shown in the window and must map to a tone`);
	}
});

// The site states are the ones nothing else names, so this map has to.
test('the site states carry their own word', () => {
	assert.strictEqual(statusTone('initialized').label, 'Initialized');
	assert.strictEqual(statusTone('uninitialized').label, 'Uninitialized');
});

// setup-steps.cjs owns the step words, and makes a distinction this map cannot:
// the same `current` status reads "Ready" or "In progress" depending on whether
// the step's action is running (#257). Restating them here would be a second
// source of truth that disagrees with the first.
test('the checklist statuses carry no word, because setupStepLabel owns them', () => {
	for (const status of ['complete', 'current', 'pending', 'locked']) {
		assert.strictEqual(
			STATUS_TONES[status].label,
			'',
			`${status} must not restate the word setupStepLabel already owns`
		);
	}
	assert.notStrictEqual(setupStepLabel('current', false), setupStepLabel('current', true));
});

// A status the map has not been taught about is exactly the case where the app
// must not assert success or failure. Neutral, and the caller keeps its own text.
//
// The prototype keys are in this list because they were the hole: a plain
// `STATUS_TONES[key]` lookup reads through Object.prototype, so 'constructor'
// resolved to the Object constructor and '__proto__' to the prototype itself.
// Both carry no `tone`, which renders a badge classed `wpct-badge--undefined`.
// Only already-lowercase keys could reach it — the lookup lowercases first, so
// 'toString' was always safe and 'constructor' never was.
test('an unknown status is neutral and unlabelled, never green or red', () => {
	const unknown = ['exploded', '', null, undefined, 42, {}, 'constructor', '__proto__', 'tostring', 'valueof'];
	for (const input of unknown) {
		const resolved = statusTone(input);
		assert.strictEqual(resolved.tone, 'neutral', `${String(input)} must not claim an outcome`);
		assert.strictEqual(resolved.label, '', `${String(input)} must not invent a label`);
	}
});

// The badge's class is built as `wpct-badge--${tone}`, so a tone that is not a
// string does not degrade — it produces a class no stylesheet defines.
test('every resolved tone is a string, so no badge can render unstyled', () => {
	for (const input of ['constructor', '__proto__', 'complete', 'nonsense', '']) {
		assert.strictEqual(typeof statusTone(input).tone, 'string', `${String(input)} resolved to a non-string tone`);
	}
});

test('status lookup ignores case, as the callers pass it through unchanged', () => {
	assert.deepStrictEqual(statusTone('COMPLETE'), statusTone('complete'));
});

// Neither "not yet" state may be coloured as a problem. Amber here would tell a
// contributor that a step they have simply not reached has gone wrong.
test('pending and locked are neutral, because "not yet" is not a warning', () => {
	assert.strictEqual(statusTone('pending').tone, 'neutral');
	assert.strictEqual(statusTone('locked').tone, 'neutral');
});

// The map names tones; tokens.css draws them. A tone with no rule renders as an
// unstyled badge, which is the kind of break no unit test would otherwise catch.
test('every tone the map can return is drawn by tokens.css', () => {
	const css = fs.readFileSync(TOKENS_CSS, 'utf8');
	const tones = new Set(Object.values(STATUS_TONES).map((entry) => entry.tone));
	tones.add('neutral');
	for (const tone of tones) {
		assert.ok(
			css.includes(`.wpct-badge--${tone}`),
			`tokens.css has no .wpct-badge--${tone} rule, so that status would render unstyled`
		);
	}
});
