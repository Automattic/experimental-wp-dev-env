/**
 * Updating a site to the latest trunk, driven through the app (#385).
 *
 * The update crosses every layer at once: the main process fetches from the
 * site's own origin and resets the checkout, the renderer runs the install
 * and build steps and clears the marker that says the update is incomplete,
 * and the store keeps the new snapshot. Only a journey can say the whole
 * chain ends where the contributor expects it to.
 *
 * The origin is a clone of the site on disk, moved ahead by the test; nothing
 * here reaches the network. The lockfile is left alone so the install step is
 * the one the app names as skipped: an `npm install`, even of nothing, is not
 * what this journey is about.
 *
 * Assertions are marked INVARIANT or CHARACTERISATION; see
 * ticket-branches.spec.js for why.
 */

const fs = require( 'node:fs' );
const path = require( 'node:path' );
const { test, expect } = require( '../helpers/app.cjs' );
const { makeSite, advanceOrigin, read, exists, currentBranch, SUBSTRATE, SUBSTRATE_CONTENT, LOGIN, TRUNK } = require( '../helpers/git-site.cjs' );

const NEWER_LOGIN = '<?php // newer trunk\n';

test( 'an update fetches from the site\'s origin, resets the checkout, rebuilds, and leaves the history whole', async ( { session } ) => {
	const site = await makeSite( session, { origin: true } );
	const newTip = advanceOrigin( site.origin, { 'src/wp-login.php': NEWER_LOGIN } );
	const { page } = await session.start( site.settings );
	await session.acceptConfirms();

	await expect( page.getByRole( 'button', { name: 'More', exact: true } ) ).toBeVisible( { timeout: 30_000 } );
	await page.getByRole( 'button', { name: 'More', exact: true } ).click();
	await page.getByRole( 'menuitem', { name: 'Update to latest trunk', exact: true } ).click();

	// INVARIANT — the chain ends with the app saying so, and with the summary
	// the guide describes: the install step was named as skipped.
	await expect( page.getByText( 'Updated to the latest trunk' ).first() ).toBeVisible( { timeout: 120_000 } );
	await expect( page.getByText( 'Dependencies unchanged', { exact: false } ).first() ).toBeVisible( { timeout: 30_000 } );
	await expect( page.getByText( 'Update incomplete', { exact: false } ) ).toHaveCount( 0 );

	// INVARIANT — the checkout is the origin's trunk now, still on trunk, and
	// the substrate survived the reset.
	expect( read( site.dir, LOGIN ) ).toBe( NEWER_LOGIN );
	expect( await currentBranch( site.dir ) ).toBe( TRUNK );
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );

	// INVARIANT — the update fetched, it did not truncate: no shallow boundary,
	// and the commit the site started on is still behind the new tip.
	expect( exists( site.dir, path.join( '.git', 'shallow' ) ) ).toBe( false );
	expect( fs.readFileSync( path.join( site.dir, '.git', 'FETCH_HEAD' ), 'utf8' ) ).toContain( newTip );

	// CHARACTERISATION — the registry holds the new snapshot and no
	// incomplete-update marker.
	const meta = session.readSettings().siteMeta[ site.dir ];
	expect( meta.trunkOid ).toBe( newTip );
	expect( meta.updateIncomplete ).toBeFalsy();
} );
