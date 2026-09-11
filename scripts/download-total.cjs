// The download total behind the README badge, computed from `downloads.csv` on the `metrics`
// branch rather than from a live query to GitHub.
//
// Summing today's `download_count` across today's assets, which is what a live shields badge
// does, gets the number wrong twice over.
//
// It undercounts, because the counter belongs to the asset and dies with it. Four macOS `.dmg`
// files were deleted and re-uploaded when the signing key was rotated, so 89 downloads that
// really happened are gone from the API. They survive only in the snapshots, which is the whole
// reason the snapshots exist.
//
// And it overcounts, because it includes release candidates and betas. A download of `rc.1` two
// months after 1.0.0 shipped is not somebody adopting the app, and counting it as adoption is
// the kind of flattery that makes the number worth nothing.
//
// So the badge counts stable tags only, and counts every download an asset ever recorded,
// including after the asset itself is gone.

const fs = require('node:fs');

// GitHub's asset id is unique per upload, so a replaced file is a different id and its fresh
// counter cannot be confused with the old one's. Snapshots taken before the id was recorded fall
// back to the name, which is as much as they can say.
function assetKey({ id, tag, asset }) {
	return id ? `id:${id}` : JSON.stringify([tag, asset]);
}

// A prerelease is the semver suffix, not GitHub's `prerelease` flag: v0.1.1 is flagged
// prerelease on the API and is a real release with real users.
function isStableTag(tag) {
	return !tag.replace(/^v/, '').includes('-');
}

function platformOf(assetName) {
	const name = assetName.toLowerCase();
	if (name.endsWith('.dmg')) return 'macOS';
	if (name.endsWith('.exe')) return 'Windows';
	return 'Linux';
}

// Minimal RFC 4180 reader. The file is written by `jq @csv`, which quotes every string field
// and doubles any quote inside it.
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;

	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];

		if (quoted) {
			if (char !== '"') {
				field += char;
			} else if (text[i + 1] === '"') {
				field += '"';
				i += 1;
			} else {
				quoted = false;
			}
			continue;
		}

		if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && text[i + 1] === '\n') i += 1;
			row.push(field);
			if (row.length > 1 || row[0] !== '') rows.push(row);
			row = [];
			field = '';
		} else {
			field += char;
		}
	}

	row.push(field);
	if (row.length > 1 || row[0] !== '') rows.push(row);

	return rows;
}

// A row this cannot read is a corrupt snapshot, and a corrupt snapshot silently dropped is a
// badge that is quietly too low with nothing to show for it. Refuse instead: the workflow fails
// the run rather than committing a wrong number that nobody can tell is wrong.
function readSnapshots(csvText) {
	const rows = parseCsv(csvText);
	const body = rows[0] && rows[0][0] === 'date' ? rows.slice(1) : rows;

	return body.map((row, index) => {
		const [date, tag, asset, downloads, id] = row;
		const count = Number(downloads);

		if (row.length < 4 || !date || !tag || !asset || !Number.isInteger(count) || count < 0) {
			throw new Error(`downloads.csv: unreadable row ${index + 2}: ${JSON.stringify(row)}`);
		}

		return { date, tag, asset, downloads: count, id: id || '' };
	});
}

// Every download each asset ever recorded, whether or not the asset is still published.
// An asset missing from a snapshot is not zero: it was withdrawn, and what it earned stands.
function downloadTotals(csvText, { stableOnly = true } = {}) {
	const entries = readSnapshots(csvText).filter((entry) => !stableOnly || isStableTag(entry.tag));
	const dates = [...new Set(entries.map((entry) => entry.date))].sort();
	const byDate = new Map(dates.map((date) => [date, new Map()]));

	for (const entry of entries) {
		byDate.get(entry.date).set(assetKey(entry), entry);
	}

	const previous = new Map();
	const byPlatform = { macOS: 0, Windows: 0, Linux: 0 };
	let total = 0;

	for (const date of dates) {
		for (const [key, entry] of byDate.get(date)) {
			// The week the snapshot started recording ids, an asset already in the history
			// changes key. Hand its running count over rather than start it again, or every
			// asset alive that week is counted twice, for good.
			const nameKey = JSON.stringify([entry.tag, entry.asset]);
			if (key !== nameKey && !previous.has(key) && previous.has(nameKey)) {
				previous.set(key, previous.get(nameKey));
				previous.delete(nameKey);
			}

			const before = previous.get(key) ?? 0;

			// GitHub's counters only go up, and a replaced asset gets a new id rather than a
			// reset one, so there is no reading this as anything but bad data.
			if (entry.downloads < before) {
				throw new Error(
					`downloads.csv: ${entry.tag} ${entry.asset} fell from ${before} to ${entry.downloads} on ${date}`
				);
			}

			previous.set(key, entry.downloads);
			byPlatform[platformOf(entry.asset)] += entry.downloads - before;
			total += entry.downloads - before;
		}
	}

	return { total, byPlatform };
}

function badge(total) {
	return { schemaVersion: 1, label: 'downloads', message: String(total), color: 'blue' };
}

module.exports = { assetKey, isStableTag, platformOf, parseCsv, readSnapshots, downloadTotals, badge };

// `node scripts/download-total.cjs downloads.csv` prints the total; `--badge` prints the
// shields endpoint document the workflow commits.
if (require.main === module) {
	const args = process.argv.slice(2);
	const wantsBadge = args.includes('--badge');
	const path = args.find((arg) => !arg.startsWith('--'));

	if (!path) {
		console.error('usage: download-total.cjs <downloads.csv> [--badge]');
		process.exit(1);
	}

	const { total, byPlatform } = downloadTotals(fs.readFileSync(path, 'utf8'));

	if (wantsBadge) {
		console.log(JSON.stringify(badge(total)));
	} else {
		console.log(String(total));
		console.error(
			`macOS ${byPlatform.macOS}  Windows ${byPlatform.Windows}  Linux ${byPlatform.Linux}`
		);
	}
}
