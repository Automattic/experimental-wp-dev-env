/**
 * The engine's own test (#360).
 *
 * Not a journey: it asserts nothing about ticket branches or patches. It asserts
 * that the four things every journey depends on actually work, so that when a
 * journey fails it is about the flow and not about the harness.
 *
 *   1. The app launches from the source tree and paints.
 *   2. It uses the throwaway profile, and nothing else.
 *   3. What it persists survives closing and reopening it.
 *   4. A native file dialog can be answered from the test.
 *
 * If this file is red, no other journey's result means anything.
 */

const fs = require( 'node:fs' );
const os = require( 'node:os' );
const path = require( 'node:path' );
const { test, expect } = require( '../helpers/app.cjs' );

// Directories made during a test, removed after it. The profile is the session
// fixture's problem; these are the fake sites and patch files pointed at from it.
// The site's name is on screen twice — the sidebar entry and the heading of the
// open site — so neither can be reached by text alone. Roles tell them apart, and
// say which half of the app the assertion is about.
const sidebarEntry = ( page, label ) => page.getByRole( 'button', { name: label, exact: true } );
const openSiteHeading = ( page, label ) => page.getByRole( 'heading', { name: label, exact: true } );

const scratch = [];
test.afterEach( () => {
	while ( scratch.length ) fs.rmSync( scratch.pop(), { recursive: true, force: true } );
} );

/**
 * A site directory the app can list without being able to read Git metadata from
 * it. The renderer tolerates that — it shows the site with no snapshot date
 * rather than crashing — which is enough for everything below. Journeys build a
 * real repository instead.
 *
 * @param {Object} session The session that will list it, and clean it up.
 * @param {string} label
 * @return {{dir: string, settings: Object}} The directory, and settings that list it.
 */
function makeListedSite( session, label ) {
	const yesterday = new Date( Date.now() - 24 * 60 * 60 * 1000 ).toISOString();
	const dir = session.track( fs.mkdtempSync( path.join( os.tmpdir(), 'wpct-e2e-site-' ) ) );
	fs.mkdirSync( path.join( dir, 'wp-content' ), { recursive: true } );
	return {
		dir,
		settings: {
			sites: [ dir ],
			siteMeta: {
				[ dir ]: {
					initialized: true,
					createdAt: yesterday,
					label,
					// Relative to now, not a fixed date. The staleness dot appears
					// once a snapshot is a fortnight old, and it joins the sidebar
					// entry's accessible name when it does — so a hardcoded date
					// would quietly change what the selectors below match, months
					// after anyone touched this file.
					trunkDate: yesterday,
					skipInitWizard: true,
				},
			},
			preferences: {},
		},
	};
}

test( 'the app launches from source and lists the site it was seeded with', async ( { session } ) => {
	const site = makeListedSite( session, 'engine-check' );
	const { page } = await session.start( site.settings );

	await expect( page ).toHaveTitle( 'WordPress Contributor Toolkit' );
	// #root is in the static HTML, so its presence proves nothing — its children do.
	await expect( page.locator( '#root > *' ) ).not.toHaveCount( 0 );

	// `exact`, because the sidebar heading "WordPress Core" is a substring of
	// several button labels further down the page.
	await expect( sidebarEntry( page, 'engine-check' ) ).toBeVisible();
	await expect( page.getByText( 'No sites yet.', { exact: true } ) ).toHaveCount( 0 );
} );

test( 'the app writes to the throwaway profile and not to the real one', async ( { session } ) => {
	const { app } = await session.start();

	// The launch guard already refuses to proceed otherwise, so this is here to
	// make the guarantee visible as a test rather than only as a helper's
	// precondition — the whole suite is unsafe to run the day it stops holding.
	const inUse = await app.evaluate( ( { app: electronApp } ) => electronApp.getPath( 'userData' ) );
	expect( path.resolve( inUse ) ).toBe( path.resolve( session.userDataDir ) );

	// And it is genuinely this app's store: the seeded file is the one it read.
	expect( session.readSettings() ).toHaveProperty( 'sites' );
} );

test( 'state written by the app survives closing and reopening it', async ( { session } ) => {
	const site = makeListedSite( session, 'before-restart' );
	const { page } = await session.start( site.settings );
	await expect( sidebarEntry( page, 'before-restart' ) ).toBeVisible();

	// Renaming goes through the app's own persistence path, so this proves the
	// round trip the journeys rely on: the app wrote it, the app read it back.
	// Anything asserted only within one launch could be memory, not storage.
	await page.evaluate(
		( [ sitePath, label ] ) => window.api.setSiteLabel( sitePath, label ),
		[ site.dir, 'after-restart' ]
	);
	// No assertion on the sidebar here, deliberately. The rename went straight to
	// the main process, which does not push an update back to a renderer that did
	// not ask for one — so the old name stays on screen until something reloads.
	// That is the app's business; what this test is about is the write reaching
	// disk, and the reader for that is the relaunch below.

	const { page: reopened } = await session.restart();
	await expect( sidebarEntry( reopened, 'after-restart' ) ).toBeVisible();
	await expect( openSiteHeading( reopened, 'after-restart' ) ).toBeVisible();
	expect( session.readSettings().siteMeta[ site.dir ].label ).toBe( 'after-restart' );
} );

test( 'a native file dialog can be answered from the test', async ( { session } ) => {
	const patchDir = session.track( fs.mkdtempSync( path.join( os.tmpdir(), 'wpct-e2e-patch-' ) ) );
	const patchFile = path.join( patchDir, 'engine.patch' );
	fs.writeFileSync( patchFile, '--- a/wp-login.php\n+++ b/wp-login.php\n' );

	const { page } = await session.start();
	await session.answerFileDialog( [ patchFile ] );

	// Straight through the app's real handler, which opens the dialog, reads the
	// file and returns its text — so this covers the whole path a journey uses to
	// bring a patch in, not just that the stub was installed.
	const chosen = await page.evaluate( () => window.api.choosePatchFile() );
	expect( chosen.filePath ).toBe( patchFile );
	expect( chosen.name ).toBe( 'engine.patch' );
	expect( chosen.text ).toContain( 'wp-login.php' );
} );

test( 'a failed site deletion stays visible, reports the failure, and can be retried (#414)', async ( { session } ) => {
	const site = makeListedSite( session, 'delete-retry' );
	const { app, page } = await session.start( site.settings );
	const confirmsAnswered = await session.acceptConfirms();

	// Hold the IPC reply in the main process. This keeps the UI operation pending
	// without shipping a test-only delay or relying on filesystem timing.
	await app.evaluate( ( { ipcMain } ) => {
		ipcMain.removeHandler( 'sites:delete' );
		ipcMain.handle( 'sites:delete', ( _event, sitePath ) => new Promise( ( resolve ) => {
			globalThis.__toolkitDeleteRequest = { resolve, sitePath };
		} ) );
	} );

	await page.getByRole( 'button', { name: 'More', exact: true } ).click();
	await page.getByRole( 'menuitem', { name: 'Delete this site', exact: true } ).click();

	// The row speaks while the call is outstanding, and the only delete action is
	// disabled so a second request cannot race the first one.
	await expect( page.getByText( 'Deleting…', { exact: true } ) ).toBeVisible();
	await page.getByRole( 'button', { name: 'More', exact: true } ).click();
	await expect( page.getByRole( 'menuitem', { name: 'Deleting…', exact: true } ) ).toBeDisabled();
	await page.getByRole( 'button', { name: 'More', exact: true } ).click();

	await app.evaluate( () => {
		const request = globalThis.__toolkitDeleteRequest;
		if ( ! request ) throw new Error( 'The renderer never reached sites:delete' );
		request.resolve( { ok: false, reason: 'remove-failed', path: request.sitePath, code: 'EBUSY' } );
	} );

	const failure = `The site is still listed because its folder could not be deleted (EBUSY). Close anything using it, then try again. Folder: ${ site.dir }`;
	await expect( page.getByText( failure, { exact: true } ) ).toBeVisible();
	await expect( sidebarEntry( page, 'delete-retry' ) ).toBeVisible();
	await expect( page.getByText( 'Deleting…', { exact: true } ) ).toHaveCount( 0 );

	await page.getByRole( 'button', { name: 'More', exact: true } ).click();
	await expect( page.getByRole( 'menuitem', { name: 'Delete this site', exact: true } ) ).toBeEnabled();
	expect( await confirmsAnswered() ).toBe( 1 );
	expect( session.readSettings().sites ).toEqual( [ site.dir ] );
} );
