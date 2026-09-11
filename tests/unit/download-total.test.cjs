// The download total behind the README badge. The cases worth protecting are the ones the live
// GitHub number gets wrong: an asset that was withdrawn, and an asset whose counter was
// restarted by a re-upload.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	assetKey,
	isStableTag,
	platformOf,
	parseCsv,
	readSnapshots,
	downloadTotals,
	badge
} = require('../../scripts/download-total.cjs');

const HEADER = 'date,tag,asset,downloads,asset_id\n';

// `id` omitted writes a four-field row, which is what every snapshot taken before the id column
// existed looks like.
function csv(...rows) {
	const body = rows
		.map(([date, tag, asset, downloads, id]) =>
			id === undefined
				? `${date},"${tag}","${asset}",${downloads}`
				: `${date},"${tag}","${asset}",${downloads},${id}`
		)
		.join('\n');
	return `${HEADER + body}\n`;
}

test('assetKey separates two uploads of the same filename', () => {
	// The point of the id: a file deleted and re-uploaded under its own name is a different
	// counter, and nothing in the name says so.
	const name = 'app-mac-arm64.dmg';
	assert.notEqual(
		assetKey({ id: '11', tag: 'v1.0.0', asset: name }),
		assetKey({ id: '22', tag: 'v1.0.0', asset: name })
	);
});

test('assetKey falls back to the name when a snapshot predates the id column', () => {
	assert.equal(
		assetKey({ id: '', tag: 'v1.0.0', asset: 'app.dmg' }),
		assetKey({ tag: 'v1.0.0', asset: 'app.dmg' })
	);
});

test('assetKey does not let one asset collide with another through its key', () => {
	// Concatenating the two fields, with or without a separator a filename could contain,
	// would make these two the same asset.
	assert.notEqual(assetKey({ tag: 'v1.0.0', asset: 'a' }), assetKey({ tag: 'v1.0.0a', asset: '' }));
	assert.notEqual(assetKey({ tag: 'v1', asset: 'a,b' }), assetKey({ tag: 'v1,a', asset: 'b' }));
});

test('isStableTag rejects the semver prerelease suffix', () => {
	assert.equal(isStableTag('v1.0.0-rc.2'), false);
	assert.equal(isStableTag('v1.0.0-beta.1'), false);
	assert.equal(isStableTag('v1.0.0'), true);
	assert.equal(isStableTag('v1.1.0'), true);
});

test('isStableTag keeps v0.1.1, whose assets are the v0.1.0 binaries', () => {
	// GitHub flags that tag as a prerelease and it was never published as a release, but the
	// files under it are v0.1.0 builds. Filtering on the flag would drop 42 downloads of the
	// app as it then stood.
	assert.equal(isStableTag('v0.1.1'), true);
});

test('platformOf reads the platform off the file extension', () => {
	assert.equal(platformOf('wordpress-contributor-toolkit-1.0.1-mac-arm64.dmg'), 'macOS');
	assert.equal(platformOf('wordpress-contributor-toolkit-1.0.1-win-x64.exe'), 'Windows');
	assert.equal(platformOf('wordpress-contributor-toolkit-1.0.1-linux-x86_64.AppImage'), 'Linux');
});

test('parseCsv keeps a comma that lives inside a quoted field', () => {
	const rows = parseCsv('date,tag,asset,downloads\n2026-09-07,"v1.0.0","a,b.dmg",3\n');
	assert.deepEqual(rows[1], ['2026-09-07', 'v1.0.0', 'a,b.dmg', '3']);
});

test('readSnapshots refuses a corrupt row rather than dropping it', () => {
	// A dropped row is a badge that is quietly too low. Failing the run is the only way anyone
	// finds out.
	assert.throws(() => readSnapshots(`${HEADER}2026-09-07,"v1.0.0","app.exe",notanumber\n`), /row 2/);
	assert.throws(() => readSnapshots(`${HEADER}2026-09-07,"v1.0.0"\n`), /row 2/);
});

test('downloadTotals counts the gain between snapshots, not the snapshots', () => {
	const text = csv(
		['2026-08-31', 'v1.0.1', 'app-win-x64.exe', 10, '7'],
		['2026-09-07', 'v1.0.1', 'app-win-x64.exe', 11, '7']
	);
	assert.equal(downloadTotals(text).total, 11);
});

test('downloadTotals keeps the count of an asset that was withdrawn', () => {
	// The .dmg files deleted during the signing-key rotation. They stop appearing in the
	// snapshots; the people who downloaded them did not stop existing.
	const text = csv(
		['2026-08-17', 'v1.0.0', 'app-mac-arm64.dmg', 21, '1'],
		['2026-08-17', 'v1.0.0', 'app-win-x64.exe', 18, '2'],
		['2026-08-24', 'v1.0.0', 'app-win-x64.exe', 31, '2']
	);
	const { total, byPlatform } = downloadTotals(text);
	assert.equal(byPlatform.macOS, 21);
	assert.equal(total, 52);
});

test('downloadTotals counts a re-upload on top of what the file had under its old id', () => {
	// The case a falling counter used to stand in for, and the reason the id is recorded: here
	// the replacement passes the old count before the next Monday, so nothing ever falls.
	const text = csv(
		['2026-08-17', 'v1.0.0', 'app-mac-arm64.dmg', 47, '1'],
		['2026-08-31', 'v1.0.0', 'app-mac-arm64.dmg', 50, '2']
	);
	assert.equal(downloadTotals(text).total, 97);
});

test('downloadTotals hands a running count over when an asset first gains an id', () => {
	// The week the snapshot started recording ids. Without the handover every asset alive that
	// week is counted twice, permanently.
	const text = csv(
		['2026-08-31', 'v1.0.1', 'app-win-x64.exe', 10],
		['2026-09-07', 'v1.0.1', 'app-win-x64.exe', 11, '7'],
		['2026-09-14', 'v1.0.1', 'app-win-x64.exe', 13, '7']
	);
	assert.equal(downloadTotals(text).total, 13);
});

test('downloadTotals refuses a counter that fell, which GitHub cannot produce', () => {
	const text = csv(
		['2026-08-31', 'v1.0.1', 'app-win-x64.exe', 10, '7'],
		['2026-09-07', 'v1.0.1', 'app-win-x64.exe', 4, '7']
	);
	assert.throws(() => downloadTotals(text), /fell from 10 to 4/);
});

test('downloadTotals leaves release candidates and betas out', () => {
	const text = csv(
		['2026-09-07', 'v1.0.1', 'app-win-x64.exe', 11, '1'],
		['2026-09-07', 'v1.0.0-rc.2', 'app-rc-win-x64.exe', 5, '2'],
		['2026-09-07', 'v1.0.0-beta.1', 'app-beta-win-x64.exe', 2, '3']
	);
	assert.equal(downloadTotals(text).total, 11);
	assert.equal(downloadTotals(text, { stableOnly: false }).total, 18);
});

test('downloadTotals reads the snapshots in date order, whatever order the rows arrive in', () => {
	const text = csv(
		['2026-09-07', 'v1.0.1', 'app-win-x64.exe', 11, '7'],
		['2026-08-31', 'v1.0.1', 'app-win-x64.exe', 10, '7']
	);
	assert.equal(downloadTotals(text).total, 11);
});

test('badge emits the shields endpoint document the workflow commits', () => {
	assert.deepEqual(badge(220), {
		schemaVersion: 1,
		label: 'downloads',
		message: '220',
		color: 'blue'
	});
});
