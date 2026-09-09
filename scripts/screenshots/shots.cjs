// The declarative list of documentation screenshots.
//
// Each entry is { slug, tier, variant, prepare, target, window }:
//   - slug: the output filename, docs/public/screenshots/<slug>.png — docs pages
//     reference these names, so renaming one is a docs change too;
//   - tier 'fixture': captured fully automatically against seeded state;
//     tier 'live': needs a real, initialized site and a maintainer at the
//     keyboard (the harness pauses and says what to set up);
//   - variant: which fixture the shot needs ('seeded' or 'empty');
//   - prepare(page): drives the UI to the state worth photographing. Selectors
//     go by the words on screen, same as the repo's hand-testing convention —
//     if a label changes, the shot fails loudly instead of photographing the
//     wrong thing;
//   - target (optional): a locator for an element screenshot instead of the
//     whole window. Panels read better cropped; whole-window shots orient;
//   - window (optional, fixture tier only): { width, height } for this shot
//     alone, merged over the harness default of 1200x800. Reach for it when the
//     layout worth showing only appears at another size — `site-view-wide` is
//     the case, and its comment explains why. Partial is fine: `{ width: 1600 }`
//     keeps the default height. The live tier ignores it, because there the
//     maintainer owns the window.
//
// Three shots that used to be fixture-tier are live-tier now, joining
// dev-server-running, and moving them back would photograph a screen the 1.0
// app never shows (#298). Each depends on state a seeded settings.json cannot
// express:
//   - dev-server-running: the site URL and the wp-admin link render only while
//     a dev server is serving, and fixture sites are empty directories;
//   - setup-wizard: the self-setup chain arms on the clone-finished edge, so a
//     site that was already in the registry when the app started never runs it;
//   - trac-ticket-panel, and site-view with it: a ticket's own facts come from
//     a live visit to its Trac page and are held in memory, never written to
//     the site's metadata.
// The price is that these four need a maintainer and a real site; the fixture
// tier still covers everything else.

/**
 * Clicks a site in the sidebar and waits for its view to settle.
 *
 * The wait is not cosmetic. Selecting a site with a linked ticket fires the
 * linked-pull-request lookup, which is a network call, and the panel shows a
 * spinner until it answers. Without waiting, whether a shot catches the spinner
 * or the result is a coin flip — the same run has produced site-view.png
 * mid-check and trac-ticket-panel.png already resolved, which is two different
 * answers to the same question in one set of docs images.
 *
 * It also made three PNGs change on every run with no code change at all. In a
 * stack of branches that is worse than noise: rebasing hits a binary conflict on
 * a file nothing actually changed, and a binary conflict has no resolution
 * except to pick a side and re-capture.
 *
 * Bounded and swallowed rather than awaited indefinitely: a site with no ticket
 * never shows the spinner at all, and a harness that hangs because GitHub is
 * slow is worse than one that photographs a spinner.
 *
 * @param {import('playwright-core').Page} page
 * @param {string}                         label
 */
async function selectSite(page, label) {
	await page.getByText(label, { exact: true }).first().click();
	await page
		.getByText('Checking GitHub…')
		.first()
		.waitFor({ state: 'hidden', timeout: 15000 })
		.catch(() => {});
}

/**
 * Locates a site-view card by its heading text (the cards are styled divs, not
 * landmarks). Every site's view is in the DOM at once — only the selected one
 * is visible — so the visibility filter is what picks the right card.
 *
 * @param {import('playwright-core').Page} page
 * @param {string}                         heading
 */
function card(page, heading) {
	return page
		.locator(`div:has(> div:text-is("${heading}"))`)
		.filter({ visible: true })
		.last();
}

const shots = [
	{
		slug: 'empty-state',
		tier: 'fixture',
		variant: 'empty',
		prepare: async (page) => {
			await page.getByText('No sites yet.').first().waitFor();
		}
	},
	{
		slug: 'create-site-modal',
		tier: 'fixture',
		variant: 'empty',
		prepare: async (page) => {
			await page.getByRole('button', { name: 'Create WordPress Core site' }).click();
			await page.getByRole('dialog').getByText('Site name').waitFor();
		}
	},
	{
		// The content column's width cap, which no other shot can show: at the
		// default 1200px window the content area is 855px — the width every
		// cropped panel shot here comes out at — which is narrower than the
		// 880px cap, so the cap has no effect and the image looks the same with
		// or without it. This is the only shot that proves --wpct-content-max-width
		// does anything, and the only one that would catch its removal.
		//
		// Unlike its neighbours it is referenced by no docs page. It ships in
		// the VitePress build as a review artifact, deliberately: the cap is
		// otherwise unfalsifiable by eye, and test/content-column.test.cjs
		// asserts this image exists and was captured at the declared width.
		slug: 'site-view-wide',
		tier: 'fixture',
		variant: 'seeded',
		window: { width: 1600, height: 800 },
		prepare: async (page) => {
			await selectSite(page, 'my-first-patch');
			await page.getByRole('button', { name: 'Submit changes' }).waitFor();
		}
	},
	{
		slug: 'site-menu',
		tier: 'fixture',
		variant: 'seeded',
		prepare: async (page) => {
			await selectSite(page, 'my-first-patch');
			await page.getByRole('button', { name: 'More' }).click();
			await page.getByRole('menuitem', { name: 'Update to latest trunk' }).waitFor();
		}
	},
	{
		slug: 'stale-site-notice',
		tier: 'fixture',
		variant: 'seeded',
		prepare: async (page) => {
			await selectSite(page, 'older-site');
			await page.getByText(/days old/).first().waitFor();
		}
	},
	{
		slug: 'apply-patch-panel',
		tier: 'fixture',
		variant: 'seeded',
		target: (page) => card(page, 'Apply a patch or PR'),
		prepare: async (page) => {
			await selectSite(page, 'my-first-patch');
			await card(page, 'Apply a patch or PR').waitFor();
		}
	},
	{
		slug: 'terminal',
		tier: 'fixture',
		variant: 'seeded',
		target: (page) => card(page, 'Terminal'),
		prepare: async (page) => {
			await selectSite(page, 'my-first-patch');
			await card(page, 'Terminal').waitFor();
		}
	},
	{
		slug: 'debug-log',
		tier: 'fixture',
		variant: 'seeded',
		target: (page) => card(page, 'Logs'),
		prepare: async (page) => {
			await selectSite(page, 'my-first-patch');
			await page.getByRole('tab', { name: /debug\.log/ }).filter({ visible: true }).click();
			await page.getByText('PHP Notice', { exact: false }).filter({ visible: true }).first().waitFor();
		}
	},
	{
		slug: 'mail-panel',
		tier: 'fixture',
		variant: 'seeded',
		target: (page) => page.getByText('Welcome to WordPress Contributor Day').locator('../..'),
		prepare: async (page) => {
			await selectSite(page, 'my-first-patch');
			await page.getByRole('button', { name: 'Start dev server' }).click();
			await page.getByText('Welcome to WordPress Contributor Day').filter({ visible: true }).waitFor();
		}
	},
	{
		slug: 'update-incomplete',
		tier: 'fixture',
		variant: 'seeded',
		target: (page) => page.getByText('Update incomplete', { exact: true }).locator('../..'),
		prepare: async (page) => {
			await selectSite(page, 'needs-rebuild');
			await page.getByRole('button', { name: 'Retry install & build' }).waitFor();
		}
	},

	// ---- Live tier: real site, maintainer present. `instructions` is what the
	// harness prints before pausing.
	//
	// The first four are in the order one site passes through them, so a single
	// session — create the site, let it set itself up, run it, link a ticket —
	// takes all four without ever going backwards. Every path in these images is
	// published, so create the site somewhere with no username in it
	// (/private/tmp/wpct-docs/my-first-patch is what the committed ones show),
	// and name it to match the fixture-tier shots so the guide reads as one site.
	{
		slug: 'setup-wizard',
		tier: 'live',
		instructions:
			'Create a site and leave it alone. Shoot while the "Setting this site up for you — step N of 3" banner is up, with a step still to go, so the checklist shows a done step, a running one and a locked one.'
	},
	{
		slug: 'dev-server-running',
		tier: 'live',
		instructions:
			'When the build has finished, click "Start dev server and finish the wizard". Wait until the site URL, the wp-admin link and "Log in with admin / password" are visible.'
	},
	{
		slug: 'site-view',
		tier: 'live',
		instructions:
			'Stop the dev server, then link an open ticket that a pull request cites (65856 in the committed shot) and click "Read details from Trac", clearing the human-check once. Shoot the whole window: Start dev server, Start build watch, Review & submit changes, and the ticket panel below them.'
	},
	{
		slug: 'trac-ticket-panel',
		tier: 'live',
		target: (page) => card(page, 'Trac ticket'),
		instructions:
			'Same screen as site-view — the ticket facts read and the linked pull requests listed. This one is cropped to the Trac ticket card.'
	},
	{
		slug: 'submit-changes-diff',
		tier: 'live',
		target: (page) => page.locator('.patch-diff'),
		instructions:
			'On a site with edited files, click "Review & submit changes" and wait for the diff to finish generating.'
	},
	{
		slug: 'submit-destinations',
		tier: 'live',
		target: (page) => page.locator('.patch-destinations'),
		instructions:
			'In the "Review & submit changes" modal, wait until the three destination cards (pull request / Trac / mentor) are visible.'
	},
	{
		slug: 'github-sign-in',
		tier: 'live',
		target: (page) => page.getByText('Open a pull request', { exact: true }).locator('../..'),
		instructions:
			'In the "Open a pull request" destination, click "Sign in with GitHub" while signed out. Capture the card while it shows the device code; do not authorize it.'
	},
	{
		slug: 'trunk-update-progress',
		tier: 'live',
		target: (page) => page.getByText('Updating to latest trunk', { exact: true }).locator('../..'),
		instructions:
			'Start "Update to latest trunk" on a site and wait until the step list is mid-run.'
	},
	{
		slug: 'apply-patch-conflict',
		tier: 'live',
		target: (page) => card(page, 'Apply a patch or PR'),
		instructions:
			'On an isolated site, preview a patch or pull request that does not fit the checkout, click "Apply and rebuild", and wait until the panel confirms that the checkout was not changed.'
	}
];

module.exports = { shots };
