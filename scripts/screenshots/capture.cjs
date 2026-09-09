// Captures the documentation screenshots in docs/public/screenshots/.
//
//   npm run shots                        # fixture tier: fully automatic (builds the renderer first)
//   npm run shots -- --tier=live         # live tier: pauses per shot, maintainer drives
//   npm run shots -- --only=terminal     # one shot, by slug
//   npm run shots -- --tier=live --user-data=~/wpct-docs-profile   # live tier, own site list
//
// Fixture tier launches the repo's own Electron binary through playwright-core's
// Electron driver, pointed at a throwaway userData dir (TOOLKIT_USER_DATA_DIR —
// see the guarded hook in src/main.js), so the contributor's real site registry
// is never touched. One launch per fixture variant, and every shot starts from
// a freshly reloaded window, so no shot depends on the one before it.
//
// Live tier launches the app with no seeding at all: the harness prints what to
// set up, waits for Enter, and takes the picture — a camera with a timer, not
// automation. Screenshots taken this way show real paths; review each image
// before committing it. It defaults to the maintainer's own registry, and
// --user-data=<dir> points it at a separate profile instead — a site list kept
// for documentation, so a capture session neither adds to nor photographs the
// sites the maintainer actually works on.
//
// playwright-core rather than playwright: it ships the same Electron driver
// with no postinstall script and no browser download — the only browser needed
// is the Electron already in devDependencies. If #70 lands `@playwright/test`,
// this can require the driver from there instead and the direct dependency goes.
//
// It lives under scripts/ rather than tests/e2e/ because it is a CLI, not a test:
// tests/e2e/ is the Playwright `testDir`, and nothing here is run by `npm run test:e2e`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { _electron } = require('playwright-core');
const { buildFixture, cleanFixtureSites } = require('./fixtures.cjs');
const { shots } = require('./shots.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(repoRoot, 'docs', 'public', 'screenshots');

// Every image the same size, every run: a fixed window and DPR 1. Without the
// scale-factor switch a retina display doubles the pixel size of half the
// screenshots and the docs pages render them inconsistently.
//
// A shot can override the width with its own `window` — see `site-view-wide` in
// shots.cjs. Layout that only appears past a breakpoint is invisible to a
// harness with one window size, which is how the content column's width cap
// went unphotographed: at 1200px the window is narrower than the cap, so every
// image looked identical whether the cap was there or not.
const WINDOW = { width: 1200, height: 800 };
const ELECTRON_SWITCHES = ['--force-device-scale-factor=1', '--lang=en-GB'];

function parseArgs(argv) {
	const args = { tier: 'fixture', only: null, userData: null };
	for (const arg of argv.slice(2)) {
		if (arg.startsWith('--tier=')) args.tier = arg.slice('--tier='.length);
		else if (arg.startsWith('--only=')) args.only = arg.slice('--only='.length);
		else if (arg.startsWith('--user-data=')) args.userData = arg.slice('--user-data='.length);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (args.tier !== 'fixture' && args.tier !== 'live') {
		throw new Error(`--tier must be "fixture" or "live", got "${args.tier}"`);
	}
	// The fixture tier builds its own throwaway profile per variant; letting a
	// path in here would either be ignored or quietly overwrite a real one.
	if (args.userData && args.tier !== 'live') {
		throw new Error('--user-data only applies to --tier=live');
	}
	if (args.userData) {
		args.userData = path.resolve(expandHome(args.userData));
		fs.mkdirSync(args.userData, { recursive: true });
	}
	return args;
}

/**
 * `~` is the shell's, not Node's: an unexpanded one would become a literal directory.
 *
 * @param {string} p
 */
function expandHome(p) {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/') || p.startsWith(`~${path.sep}`)) return path.join(os.homedir(), p.slice(2));
	return p;
}

async function setWindow(app, bounds) {
	await app.evaluate(({ BrowserWindow }, size) => {
		const win = BrowserWindow.getAllWindows()[0];
		win.setBounds({ x: 40, y: 40, ...size });
	}, bounds);
}

async function launchApp(env) {
	const app = await _electron.launch({
		// From plain Node, require('electron') resolves to the binary's path —
		// the same trick scripts/run-tests-electron.cjs uses.
		executablePath: require('electron'),
		args: [...ELECTRON_SWITCHES, repoRoot],
		// Dates rendered by the app must not rewrite screenshots according to the
		// maintainer's locale or timezone.
		env: { ...process.env, TZ: 'UTC', ...env }
	});
	const page = await app.firstWindow();
	await setWindow(app, WINDOW);
	return { app, page };
}

// Freeze CSS animations and transitions, and rewind them to their first frame,
// so a shot is a function of the app's state and nothing else.
//
// Without this, three images changed on every run with no code change at all:
// the "Checking GitHub…" spinner is a CSS animation, and each capture caught it
// at a different angle. That is noise in any diff, and worse than noise in a
// stack of branches — a rebase hits a binary conflict on a file where nothing
// actually changed, and binary conflicts have no resolution but to pick a side.
const SHOT_OPTIONS = { animations: 'disabled' };

async function captureShot(page, shot) {
	const file = path.join(outDir, `${shot.slug}.png`);
	if (shot.target) {
		await shot.target(page).screenshot({ path: file, ...SHOT_OPTIONS });
	} else {
		await page.screenshot({ path: file, ...SHOT_OPTIONS });
	}
	console.log(`  ✓ ${shot.slug}.png`);
}

async function runFixtureTier(selected) {
	const variants = [...new Set(selected.map((s) => s.variant))];
	for (const variant of variants) {
		const { userDataDir } = buildFixture(variant);
		const { app, page } = await launchApp({ TOOLKIT_USER_DATA_DIR: userDataDir });
		try {
			for (const shot of selected.filter((s) => s.variant === variant)) {
				// Set unconditionally, not only when the shot asks for it: the
				// previous shot may have widened the window, and a shot that
				// silently inherits another's size is the bug this whole file
				// exists to avoid.
				//
				// Merged over WINDOW rather than substituted for it, for the
				// same reason. `setBounds` accepts a partial rectangle, so a
				// shot declaring only `{ width: 1600 }` — the natural thing to
				// write when only the width matters — would otherwise keep
				// whatever height the shot before it left, and `--only=<slug>`
				// would produce a different image than a full run.
				await setWindow(app, { ...WINDOW, ...shot.window });
				// Fresh renderer per shot: open menus and modals from the
				// previous shot cannot leak into this one.
				await page.reload();
				await shot.prepare(page);
				// Let @wordpress/components' open/close animations settle.
				await page.waitForTimeout(300);
				await captureShot(page, shot);
			}
		} finally {
			await app.close();
		}
	}
	cleanFixtureSites();
}

async function runLiveTier(selected, userData) {
	// Explicitly undefined rather than omitted: launchApp spreads process.env, so a
	// TOOLKIT_USER_DATA_DIR exported while debugging the fixture tier would silently
	// point the "real sites" tier at fixture state, and the images would be wrong in
	// a way only a careful look at the sidebar reveals. --user-data overrides it,
	// because a path typed on the command line is a decision, not a leftover.
	const { app, page } = await launchApp({ TOOLKIT_USER_DATA_DIR: userData || undefined });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
	try {
		console.log(
			userData
				? `\nLive tier: the app just opened against the site list in ${userData}.`
				: '\nLive tier: the app just opened against your real sites.'
		);
		console.log('Screenshots will show real paths — review every image before committing.\n');
		for (const shot of selected) {
			console.log(`\n${shot.slug}:\n  ${shot.instructions}`);
			await ask('  Press Enter when the screen is ready… ');
			await captureShot(page, shot);
		}
	} finally {
		rl.close();
		await app.close();
	}
}

async function main() {
	const args = parseArgs(process.argv);
	const selected = shots.filter(
		(s) => s.tier === args.tier && (!args.only || s.slug === args.only)
	);
	if (!selected.length) {
		const known = shots.filter((s) => s.tier === args.tier).map((s) => s.slug);
		throw new Error(`No ${args.tier}-tier shot matches. Known slugs: ${known.join(', ')}`);
	}
	// A `window` on a live shot does nothing — the maintainer owns the window in
	// that tier — and a silently ignored key is the shape of a wasted hour.
	const sized = selected.filter((s) => s.tier === 'live' && s.window);
	if (sized.length) {
		throw new Error(
			`Live-tier shots cannot set "window": ${sized.map((s) => s.slug).join(', ')}. ` +
				'The maintainer sizes the window in that tier.'
		);
	}
	fs.mkdirSync(outDir, { recursive: true });
	console.log(`Capturing ${selected.length} ${args.tier}-tier screenshot(s) into ${path.relative(repoRoot, outDir)}/`);
	if (args.tier === 'fixture') await runFixtureTier(selected);
	else await runLiveTier(selected, args.userData);
}

main().catch((err) => {
	console.error(err.stack || String(err));
	process.exit(1);
});
