'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LEGACY_SITE_ERROR, legacySiteNotice } = require('../../src/renderer/legacy-site.cjs');

test('legacySiteNotice names the cause and the way out (#385)', () => {
	const notice = legacySiteNotice({ legacy: true });
	assert.equal(notice.title, 'This site was created by an earlier version of the app.');
	assert.match(notice.body, /Export your work as a patch, create a new site/);
	assert.match(notice.body, /then delete this one/);
});

test('legacySiteNotice stays silent for every other site (#385)', () => {
	assert.equal(legacySiteNotice({ legacy: false }), null);
	assert.equal(legacySiteNotice({}), null);
	assert.equal(legacySiteNotice(), null);
});

test('the refusal main returns says what still works (#385)', () => {
	assert.match(LEGACY_SITE_ERROR, /earlier version of the app/);
	assert.match(LEGACY_SITE_ERROR, /export a patch/);
	assert.match(LEGACY_SITE_ERROR, /delete this site/);
});
