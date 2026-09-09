'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

test('main and the card read the same module, and the card wires the notice to Create site (#385)', () => {
	const root = path.join(__dirname, '..', '..', 'src');
	const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
	assert.match(main, /require\('\.\/renderer\/legacy-site\.cjs'\)/);
	const source = fs.readFileSync(path.join(root, 'renderer', 'index.jsx'), 'utf8');
	assert.match(source, /setLegacy\(Boolean\(s\?\.legacy\)\)/);
	assert.match(source, /legacySiteNotice\(\{ legacy \}\)/);
	assert.match(source, /legacyNotice\.title/);
	assert.match(source, /legacyNotice\.body/);
	assert.match(source, /onCreateSite=\{\(\) => setCreateModalOpen\(true\)\}/, 'the banner\'s button opens the existing modal');
	assert.match(source, /onClick=\{onCreateSite\}>Create site</);
});
