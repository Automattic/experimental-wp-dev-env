## Download stats

The app is distributed as release binaries, so downloads are the only usage signal there is — there is no npm install count, no Docker pull count, no telemetry in the app.

GitHub reports a running total per release asset and keeps **no history**: the API returns the number as it stands today and nothing about how it got there. So a [weekly workflow](.github/workflows/download-stats.yml) records that total and commits it to [`metrics`](https://github.com/WordPress/contributor-toolkit/tree/metrics), an orphan branch that shares no history with `trunk` and holds nothing but the data files.

### Reading the data

In the browser: [downloads.csv](https://github.com/WordPress/contributor-toolkit/blob/metrics/downloads.csv).

Locally, without switching branches:

```bash
git fetch origin metrics:metrics
git show metrics:downloads.csv
```

One row per asset per snapshot, so any release can be broken down by platform:

```csv
date,tag,asset,downloads,asset_id
2026-09-07,"v1.0.1","wordpress-contributor-toolkit-1.0.1-mac-arm64.dmg",12,293445711
2026-09-07,"v1.0.0","wordpress-contributor-toolkit-1.0.0-win-x64.exe",31,281129055
```

`asset_id` is GitHub's own id for the uploaded file, and it is what makes a replaced file legible: the counter belongs to the upload, not to the name, so the same filename re-uploaded is a new id starting again at zero. Snapshots taken before that column existed have four fields and keep them.

**The number is cumulative per asset, not per week.** Two consecutive rows for the same asset are running totals; subtract them to get the change between those dates.

A few things the data answers directly:

```bash
# Raw total across every release on the most recent snapshot, prereleases included and
# withdrawn assets forgotten, that is, the number the badge deliberately does not show
git show metrics:downloads.csv | awk -F, -v d="$(git show metrics:downloads.csv | tail -1 | cut -d, -f1)" \
  '$1 == d { gsub(/"/, "", $4); sum += $4 } END { print sum }'

# One asset over time
git show metrics:downloads.csv | grep 'mac-arm64.dmg'
```

### The badge

`badge.json`, on the same branch, holds the number the README badge shows, in the format a [shields.io endpoint badge](https://shields.io/badges/endpoint-badge) reads. It is **not** the total GitHub reports, and it is deliberately neither the larger nor the smaller number:

- **Stable tags only.** Release candidates and betas are excluded, by the `-` in the tag rather than by GitHub's `prerelease` flag, which is set on `v0.1.1` by mistake. A download of `rc.1` two months after 1.0.0 shipped is not somebody adopting the app. They hold 18 downloads between them, frozen since the snapshot of 2026-08-24.
- **Withdrawn assets still count.** An asset that disappears from the snapshots keeps whatever it had earned. Four macOS `.dmg` files were replaced when the signing key was rotated, and the live API now reports nothing for the 89 downloads that preceded that.
- **A re-upload is a new asset, not a correction.** The replacement is counted on top of what the old file had, matched by `asset_id` rather than by guessing from a counter that went down. A counter that does go down is bad data and fails the run, because GitHub cannot produce one.

[`scripts/download-total.cjs`](scripts/download-total.cjs) does this, over the whole of `downloads.csv`, every time the workflow runs. To reproduce it:

```bash
git show metrics:downloads.csv > downloads.csv
node scripts/download-total.cjs downloads.csv
```

The consequence worth knowing: the badge moves once a week, when the workflow runs, not the moment someone downloads something.

### What the numbers are not

**They count HTTP requests, not people.** A re-download, a `curl` in a CI script, a retry after a dropped connection and a bot crawling the releases page each add one. Treat them as an interest signal, not an install count.

**Source archives and clones are not included.** Only uploaded release assets are counted — the auto-generated `.zip`/`.tar.gz` and `git clone` are not.

**The counter belongs to the asset, not the release.** Deleting a release file and re-uploading it restarts that file at zero, which is part of why these snapshots exist: they are the only record that survives a rename. It has already happened once, to the three artifacts replaced on the v0.1.2 draft, and again to the macOS `.dmg` files when the signing key was rotated. Since the snapshots record `asset_id`, a future one is visible rather than merely suspected.

**History starts when the workflow did.** Everything before the first snapshot is unrecoverable — GitHub never stored it.
