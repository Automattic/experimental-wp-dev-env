## WordPress Contributor Toolkit (Electron)

[![Unit tests](https://github.com/WordPress/contributor-toolkit/actions/workflows/unit-tests.yml/badge.svg?branch=trunk)](https://github.com/WordPress/contributor-toolkit/actions/workflows/unit-tests.yml) [![Latest release](https://img.shields.io/github/v/release/WordPress/contributor-toolkit)](https://github.com/WordPress/contributor-toolkit/releases/latest) [![Downloads](https://img.shields.io/github/downloads/WordPress/contributor-toolkit/total)](https://github.com/WordPress/contributor-toolkit/releases)

The [WordPress Contributor Toolkit](https://make.wordpress.org/core/2026/04/16/wordpress-core-dev-environment-toolkit-a-faster-path-to-your-first-core-contribution/) is a desktop Electron application (macOS on Apple Silicon, Windows, and Linux) that takes a contributor from nothing to a working WordPress core development environment, lets them try the work that already exists on a Trac ticket, and lets them send their own change back — as a pull request, a Trac attachment, or a patch for a mentor. No Git, Node.js, npm or Docker on the host, and no push credential written to disk.

![A site ready for work: Start dev server, Start build watch, Review & submit changes, the Trac ticket panel and the patch panel](https://wordpress.github.io/contributor-toolkit/screenshots/site-view.png)

### Why

One of the most common complaints from Contributor Day facilitators is this: participants spend the entire session trying to set up their local environment and never get to actually contribute.

Before writing a single line of code, a first-time WordPress core contributor typically needs to install Git, Node.js, npm, Docker, configure everything correctly, and troubleshoot whatever breaks along the way. At in-person events, this alone can take hours — sometimes the full day.

Setup is the first wall, not the only one. A newcomer with a running environment still has to find whether somebody already wrote a patch for the ticket, get that patch into their checkout, understand why it does not apply when it does not, and work out how to send a change back to a project that reviews on Trac but takes pull requests on GitHub. Each of those steps has its own tooling and its own way to fail quietly.

The toolkit aims to remove that whole path, not just its first step.

## What you can do with it

Each of these has a page in the user guide.

- **[Create a WordPress core development site](https://wordpress.github.io/contributor-toolkit/guide/creating-a-site)** with nothing installed on the host. The clone, the dependency install and the first build run as [one continuous chain](https://wordpress.github.io/contributor-toolkit/guide/setup-wizard) rather than four clicks.
- **[Link a Trac ticket](https://wordpress.github.io/contributor-toolkit/guide/trac-tickets)** and read its facts in the app — summary, status and resolution, type, milestone, component, keywords, age.
- **[Try the work that already exists on it](https://wordpress.github.io/contributor-toolkit/guide/applying-patches)**: the pull requests that reference the ticket and the patches attached to it, previewed and applied into the checkout, with a rebuild when one is needed. When a patch will not apply, the app says which regions failed and why, and leaves the checkout untouched.
- **[Hold work for several tickets in one site](https://wordpress.github.io/contributor-toolkit/guide/ticket-branches)**. Each ticket gets its own branch inside the site, so moving between them is a file swap of seconds instead of another clone and another install.
- **[Run the site](https://wordpress.github.io/contributor-toolkit/guide/running-the-site)** and debug it: a [debug log tab](https://wordpress.github.io/contributor-toolkit/guide/logs-and-debugging) with fatals surfaced instead of hidden behind the recovery screen, [the database](https://wordpress.github.io/contributor-toolkit/guide/database), [captured mail](https://wordpress.github.io/contributor-toolkit/guide/mail), and [a terminal](https://wordpress.github.io/contributor-toolkit/guide/terminal) using the Node.js runtime the app bundles.
- **[Send the change back](https://wordpress.github.io/contributor-toolkit/guide/submitting-changes)** — [a GitHub pull request](https://wordpress.github.io/contributor-toolkit/guide/submit-github-pr) opened through device sign-in with no credential on disk, [a patch attached to Trac](https://wordpress.github.io/contributor-toolkit/guide/submit-trac), or [a patch handed to a mentor](https://wordpress.github.io/contributor-toolkit/guide/submit-mentor) that keeps your name on the work.
- **[Keep the site current with trunk](https://wordpress.github.io/contributor-toolkit/guide/trunk-updates)** without recreating it, fetching only what changed.

## Documentation

**The user guide lives at <https://wordpress.github.io/contributor-toolkit/>** — installing the app, creating a site, working on a Trac ticket, applying patches and PRs, and submitting your changes as a pull request, a Trac attachment, or a patch for a mentor. What follows here is only what a contributor to *this repository* needs.

## Getting started

### Just using the app

Download the latest packaged build from the [Releases page](https://github.com/WordPress/contributor-toolkit/releases/latest) and follow [Getting started](https://wordpress.github.io/contributor-toolkit/guide/getting-started) in the user guide — it covers picking the right file per platform, the macOS Gatekeeper notes, and the first-contribution walkthrough.

### Build from source

Requirements: a recent Node.js to build the Electron app itself (runtime for the app is bundled).

```bash
npm install
npm start            # run Electron + renderer in watch mode

# Package installers (no publishing):
npm run dist         # all configured targets
npm run dist:win     # Windows (x64 by default)
npm run dist:win:arm64
```

The renderer is bundled by esbuild into `src/renderer/index.js` and `index.css`. Those are generated files, are not committed, and are rebuilt by `npm install`, `npm start` and every `npm run dist` — so there is no bundling step to remember after changing `src/renderer/index.jsx`. `npm run build:once` still exists if you want to rebuild on its own.

Output goes to `dist/`. On Linux, `npm run dist` creates AppImage, Snap, and DEB packages. macOS packages use the build machine's architecture, and the published macOS builds currently target Apple Silicon (`arm64`) only.

### App icon

This app uses the official WordPress “W mark” as its icon.

- Source SVG: `build/wordpress-wmark.svg`
- Packaged icons: `build/icon.icns` (macOS), `build/icon.png` (Linux), `build/icon.ico` (Windows)

Electron Builder picks these up via `build` configuration in `package.json`.

## Technical notes

How the app works from a user's point of view — the toolchain it bundles, keeping a site up to date with trunk, what SQLite does and doesn't cover — is documented in the [user guide](https://wordpress.github.io/contributor-toolkit/), not here.

### Why Electron?

* WordPress core relies on Node.js, npm, and webpack for its build system. Electron is an easy way to install Node.js on all major platforms.
* It's a single, self-contained file. It's easy to distribute and install – it can be distributed on a USB sticks if everything else fails.

### Ideas and future work

- Integrate Playground's XDebug.
- Explore bundling MySQL server with the app.
- Finish moving every Git flow onto the bundled Git binary (https://github.com/WordPress/contributor-toolkit/issues/364).
- Potentially integrate with Studio to benefit from PHP version selector, wp-cli integration and other Studio features.
- An ergonomic way of managing the git repository from the UI (commit, conflicts, pushes etc.) Or would it make sense to just endorse another git client?

### Download stats

Release downloads are the only usage signal this project has, and GitHub keeps no history of them, so a weekly workflow records the counts to a `metrics` branch. See [STATS.md](STATS.md) for how to read them and what they do and don't measure.

### Contributing

Much of the work here happens with the support of AI coding agents, and the quality bar is held by a set of guardrails rather than by trusting the agent. See [CONTRIBUTING.md](CONTRIBUTING.md) for what runs on every pull request (repo-wide lint, unit tests on macOS and Windows) and the single review standard to run yourself before opening one — as the `/self-review` skill in Claude Code, or by following the standard directly on any other agent.

### License

GPLv2 or later. See [LICENSE](LICENSE).

