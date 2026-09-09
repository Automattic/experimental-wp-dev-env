'use strict';

// The content column's width cap, and the screenshot that proves it works.
//
// This is a string assertion guarding something a reviewer will not catch by
// eye, for the same reason as color-scheme.test.cjs: the failure is invisible
// on the machine most people look at it on. The default screenshot window is
// 1200px wide with a 281px sidebar (280 plus its right border), which leaves a
// content area of 855px — the width every cropped panel screenshot in
// docs/public/screenshots/ comes out at, and narrower than the 880px cap. So at
// the size every other image is taken,
// removing the cap entirely changes nothing. Every PNG in the docs would look
// correct while the app ran headings and meta lines to the edge of a maximised
// window.
//
// Two things are pinned here. The cap itself, and the wide screenshot that is
// the only image able to show it. Deleting the shot would leave the cap
// working but unphotographed, which is the state this test was written to end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shots } = require('../../scripts/screenshots/shots.cjs');

const root = path.join(__dirname, '..', '..');
const TOKENS_CSS = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
const INDEX_JSX = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.jsx'), 'utf8');

const WIDE_SHOT = 'site-view-wide';

test('the content column is capped and centred', () => {
	const rule = TOKENS_CSS.match(/\.wpct-content-column\s*\{([^}]*)\}/);
	assert.ok(rule, 'tokens.css has no .wpct-content-column rule');
	assert.match(rule[1], /max-width:\s*var\(--wpct-content-max-width\)/, 'the column must read the cap token');
	assert.match(rule[1], /margin:\s*0 auto/, 'an uncentred cap leaves the content pinned to the left edge');
	assert.match(TOKENS_CSS, /--wpct-content-max-width:\s*\d+px/, 'the cap token has no value');
});

// The rule existing is worth nothing if the scrolling container stopped using it.
test('the scrolling content container still applies the column', () => {
	assert.match(INDEX_JSX, /className="wpct-content-column"/, 'no element uses .wpct-content-column');
});

// The cap replaced a hand-picked inline `maxWidth: 1040`. An inline style beats
// a stylesheet, so one reintroduced here would override the token silently.
//
// This catches the two values that have actually been used rather than any
// number: a general `maxWidth:` ban would fire on the unrelated inline widths
// elsewhere in the file. It is a guard against the specific historical mistake,
// not a proof that no inline cap exists.
test('the old hand-picked cap is not reintroduced inline', () => {
	assert.doesNotMatch(INDEX_JSX, /maxWidth:\s*(?:1040|880)\b/, 'the cap belongs in tokens.css, not in an inline style');
});

/**
 * The cap's value, as a number.
 *
 * Asserted rather than destructured so a deleted token fails with a sentence
 * instead of "Cannot read properties of null". The test above covers the same
 * ground, but these are independent cases and both run.
 */
function contentCap() {
	const match = TOKENS_CSS.match(/--wpct-content-max-width:\s*(\d+)px/);
	assert.ok(match, 'tokens.css no longer defines --wpct-content-max-width');
	return Number(match[1]);
}

test('a screenshot is taken wide enough for the cap to have an effect', () => {
	const wide = shots.find((shot) => shot.slug === WIDE_SHOT);
	assert.ok(wide, `${WIDE_SHOT} is the only shot that can show the cap; it must not be removed`);
	assert.ok(
		wide.window?.width,
		`${WIDE_SHOT} has no window override, so it is captured at the default width and shows nothing`
	);

	const cap = contentCap();
	// The sidebar's width and the content container's horizontal padding, read
	// from the two inline styles in index.jsx. They are duplicated here, and
	// there is nowhere better to put them until those styles move onto tokens in
	// a later phase — so the assertion is deliberately `>` with hundreds of
	// pixels of slack rather than an exact figure. It is asking "is this window
	// wide enough to prove anything", not "is the content area exactly N".
	const SIDEBAR = 280;
	const PADDING_EACH_SIDE = 32;
	const contentArea = wide.window.width - SIDEBAR - PADDING_EACH_SIDE * 2;
	assert.ok(
		contentArea > cap,
		`the ${WIDE_SHOT} window is ${wide.window.width}px, leaving about ${contentArea}px of content area — ` +
			`not wider than the ${cap}px cap, so the shot proves nothing`
	);
});

// `existsSync` alone would never fail again once the PNG was committed: an image
// captured before the cap regressed, or re-captured at the default width after
// someone edited the shot's `window`, would both pass. A PNG's pixel width lives
// in the IHDR chunk at bytes 16-20, so the committed file can be asked directly
// whether it is the wide one.
test('the committed wide screenshot really was captured wide', () => {
	const png = path.join(root, 'docs', 'public', 'screenshots', `${WIDE_SHOT}.png`);
	assert.ok(fs.existsSync(png), `${WIDE_SHOT}.png is missing — run "npm run shots"`);

	const wide = shots.find((shot) => shot.slug === WIDE_SHOT);
	const captured = fs.readFileSync(png).readUInt32BE(16);
	assert.equal(
		captured,
		wide.window.width,
		`${WIDE_SHOT}.png is ${captured}px wide but the shot declares ${wide.window.width}px — ` +
			'the image is stale; run "npm run shots"'
	);
});
