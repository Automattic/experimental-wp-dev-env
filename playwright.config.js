const { defineConfig } = require('@playwright/test');

// Electron only — no browsers are downloaded or launched, so there is no
// `projects` entry for a browser and no `npx playwright install` step anywhere.
//
// Two projects, because there are two different apps under test:
//
//   journeys  drives the *source tree* through the flows a contributor performs by
//             hand — link a ticket, apply a patch, switch branches. Fast, offline,
//             and it writes real state to a throwaway profile.
//   packaged  launches the *packaged artifact* (`electron-builder --dir`) and only
//             asks whether packaging worked. It writes no state.
//
// They are not interchangeable: the journeys mutate real Git repositories and need
// to be quick enough to run in a loop, and the packaging failures — asar layout,
// native module rebuilds, bundled CLI resolution — do not reproduce from source.
module.exports = defineConfig({
	testDir: 'tests/e2e',
	// Launching Electron is not safe to parallelise: workers would race over the
	// same packaged binary and, in the journeys, over the same fixture roots.
	workers: 1,
	fullyParallel: false,
	// A focused test must not silently shrink the suite in CI.
	forbidOnly: !!process.env.CI,
	// Locally a retry hides a flake you want to see; in CI it stops one flake from
	// blocking somebody else's pull request.
	retries: process.env.CI ? 1 : 0,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	reporter: process.env.CI ? [ [ 'list' ], [ 'html', { open: 'never' } ] ] : 'list',
	use: {
		trace: 'retain-on-failure',
	},
	projects: [
		{
			name: 'journeys',
			testDir: 'tests/e2e/journeys',
		},
		{
			name: 'packaged',
			testDir: 'tests/e2e/packaged',
			// Cold-starting a packaged app on a Windows runner is slow enough to
			// trip the default on its own, before any assertion runs.
			timeout: 120_000,
		},
	],
});
