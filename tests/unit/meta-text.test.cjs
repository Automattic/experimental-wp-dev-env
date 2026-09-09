'use strict';

// Two rules that a pre-PR review found, and that nothing else would catch twice.
//
// Both are stylesheet assertions for the same reason as color-scheme.test.cjs
// and content-column.test.cjs: the failure is invisible to whoever is looking.
// A reviewer sees a credentials line and reads the words, not the eight pixels
// between each of them; a chip's text passes or fails AA at a ratio nobody
// eyeballs. Reintroducing either would be a silent revert of a finding that has
// already been raised once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const TOKENS_CSS = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
const INDEX_JSX = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.jsx'), 'utf8');

/**
 * WCAG 2.x relative luminance, and the contrast ratio between two hex colours.
 *
 * Computed rather than hard-coded so the assertion follows the tokens: change
 * --wpct-text or --wpct-surface-subtle and this still measures the real pair.
 *
 * @param {string} hex
 * @return {number}
 */
function luminance(hex) {
	const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

function token(name) {
	const match = TOKENS_CSS.match(new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`, 'i'));
	assert.ok(match, `tokens.css no longer defines ${name}`);
	return match[1];
}

// The chip is a bordered grey box, so its text is not on the page background.
// --wpct-text-muted on --wpct-surface-subtle measures 4.44:1, which is under
// the threshold — that pairing was the original finding.
test('the path chip clears AA against its own background', () => {
	const rule = TOKENS_CSS.match(/\.wpct-chip\s*\{([^}]*)\}/);
	assert.ok(rule, 'tokens.css has no .wpct-chip rule');

	const colour = rule[1].match(/color:\s*var\((--[\w-]+)\)/);
	assert.ok(colour, '.wpct-chip must take its colour from a token');

	const ratio = contrast(token(colour[1]), token('--wpct-surface-subtle'));
	assert.ok(
		ratio >= 4.5,
		`the path chip is ${ratio.toFixed(2)}:1 against its background, under the 4.5:1 AA threshold at this size`
	);
});

// The rule this replaced was `.wpct-meta code`, which caught every code element
// in a meta line — including the `admin` and `password` in the dev-server
// credentials, which are words in a sentence rather than a value to copy.
test('the chip is a class, not every code element in a meta line', () => {
	assert.doesNotMatch(
		TOKENS_CSS,
		/\.wpct-meta\s+code\s*\{/,
		'a descendant selector chips words that are prose; .wpct-chip is opt-in for a reason'
	);
	assert.match(INDEX_JSX, /<code className="wpct-chip">/, 'nothing applies .wpct-chip');
});

// .wpct-meta is a flex row, so each contiguous run of text in it becomes its own
// anonymous flex item — a sentence comes out with a gap between every fragment,
// including before the full stop, each free to wrap alone. --flow opts back into
// normal inline flow.
test('prose in a meta line lays out as prose', () => {
	const rule = TOKENS_CSS.match(/\.wpct-meta--flow\s*\{([^}]*)\}/);
	assert.ok(rule, 'tokens.css has no .wpct-meta--flow rule');
	assert.match(rule[1], /display:\s*block/, '--flow exists to undo the flex row');

	// The rule has to win over .wpct-meta's `display: flex`. Equal specificity,
	// so source order decides it, and that is easy to break by moving a block.
	assert.ok(
		TOKENS_CSS.indexOf('.wpct-meta--flow') > TOKENS_CSS.indexOf('.wpct-meta {'),
		'.wpct-meta--flow must come after .wpct-meta or the flex row still wins'
	);
});

// The one call site, and the reason the prop exists at all.
test('the dev-server credentials line still asks for prose layout', () => {
	assert.match(
		INDEX_JSX,
		/<MetaText flow>Log in with/,
		'the credentials sentence must keep `flow`, or it renders gapped between every word'
	);
});
