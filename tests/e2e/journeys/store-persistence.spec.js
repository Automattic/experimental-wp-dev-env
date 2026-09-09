/**
 * What survives closing the app (#361).
 *
 * The only test in the repository that exercises the real persistence layer.
 * Everywhere else `electron-store` is a stand-in: the wiring tests hand the main
 * process a fake, and the integration tests never reach it at all. So this is the
 * only place that can tell "the app persisted this" from "the app still had it in
 * memory", which is exactly the distinction a change to how state is stored
 * breaks without anything else noticing.
 *
 * Each test does its work, closes the app, opens it again against the same
 * profile untouched, and asks what came back. Assertions are marked INVARIANT or
 * CHARACTERISATION; see ticket-branches.spec.js for why.
 */

const { test, expect } = require( '../helpers/app.cjs' );
const {
	makeSite,
	makePatchFile,
	read,
	write,
	currentBranch,
	SUBSTRATE,
	SUBSTRATE_CONTENT,
	LOGIN,
} = require( '../helpers/git-site.cjs' );

const TRUNK_LOGIN = '<?php // trunk';
const PATCHED_LOGIN = '<?php // fixed by the patch';
const MY_EDIT = '<?php // my work on 60001\n';

/**
 * @param {Object} page
 * @param {string} ticket
 */
async function linkTicket( page, ticket ) {
	await page.getByLabel( 'Trac ticket number or URL' ).first().fill( ticket );
	await page.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	await expect( page.getByText( `#${ ticket }`, { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
}

test( 'the linked ticket and its work are still there after a restart', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );

	await linkTicket( page, '60001' );
	write( site.dir, LOGIN, MY_EDIT );

	const { page: reopened } = await session.restart();

	// INVARIANT — the app opens where the contributor left it. Coming back to a
	// site that has forgotten which ticket it was on is the cheapest possible way
	// to lose somebody's afternoon.
	await expect( reopened.getByText( '#60001', { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );

	// INVARIANT — and it did not touch the checkout on the way past. A restart is
	// not a switch.
	expect( currentBranch( site.dir ) ).toBe( 'ticket/60001' );
	expect( read( site.dir, LOGIN ) ).toBe( MY_EDIT );
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );
} );

test( 'an applied patch is still applied after a restart, and still revertable', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );
	await linkTicket( page, '60001' );

	const patch = makePatchFile( session, 'ticket-60001.patch', [
		{ file: 'wp-login.php', from: TRUNK_LOGIN, to: PATCHED_LOGIN },
	] );
	await session.answerFileDialog( [ patch ] );
	await page.getByRole( 'button', { name: 'or choose a .diff / .patch file…', exact: true } ).click();
	await expect( page.getByText( 'src/wp-login.php', { exact: true } ) ).toBeVisible( { timeout: 30_000 } );
	await page.getByRole( 'button', { name: 'Apply and rebuild', exact: true } ).click();
	await expect( page.getByRole( 'button', { name: 'Revert this patch', exact: true } ) ).toBeVisible( {
		timeout: 60_000,
	} );

	const { page: reopened } = await session.restart();

	// INVARIANT — the app still knows somebody else's work is on this checkout,
	// and still offers to take it off. Forgetting that leaves a contributor
	// unable to tell their own changes from the patch's, and about to submit
	// both as theirs.
	await expect( reopened.getByRole( 'button', { name: 'Revert this patch', exact: true } ) ).toBeVisible( {
		timeout: 30_000,
	} );
	expect( read( site.dir, LOGIN ) ).toBe( `${ PATCHED_LOGIN }\n` );

	// INVARIANT — and the offer is real, not just rendered. Reverting after a
	// restart puts the checkout back.
	await reopened.getByRole( 'button', { name: 'Revert this patch', exact: true } ).click();
	await expect( reopened.getByRole( 'button', { name: 'Revert this patch', exact: true } ) ).toHaveCount( 0, {
		timeout: 60_000,
	} );
	// The button leaves the moment the revert starts, so it is not the signal
	// that the revert finished. The next-step line is: it names the operation
	// while it runs and moves on once the status has been reloaded, which
	// happens after the checkout and the record are both written.
	await expect( reopened.getByText( 'A patch is being applied or reverted.' ) ).toHaveCount( 0, { timeout: 60_000 } );
	expect( read( site.dir, LOGIN ) ).toBe( `${ TRUNK_LOGIN }\n` );
} );

test( "a site's tickets survive a restart, with the base each patch is measured against", async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );

	await linkTicket( page, '60001' );
	write( site.dir, LOGIN, MY_EDIT );
	await page.getByRole( 'button', { name: 'Unlink', exact: true } ).click();
	await expect( page.getByLabel( 'Trac ticket number or URL' ).first() ).toBeVisible();
	await linkTicket( page, '60002' );

	const { page: reopened } = await session.restart();

	// INVARIANT — both tickets come back, and the parked one is still offered.
	// A ticket that survives in Git but not in the app is work a contributor
	// cannot reach from the interface.
	await expect( reopened.getByText( '#60002', { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
	// Matched on the sentence rather than on a button label: the row for another
	// ticket reads "Continue working on #N" when nothing is linked and "You also
	// have work on #N — switch" when something is, and after this restart
	// something is.
	await expect( reopened.getByText( /You also have work on #60001/ ).first() ).toBeVisible( {
		timeout: 30_000,
	} );

	// CHARACTERISATION — and each branch keeps the commit its patch is measured
	// from. Losing this is what #317 was: a ticket whose base is unknown can no
	// longer say what the contributor changed.
	const meta = session.readSettings().siteMeta[ site.dir ];
	expect( meta.branches[ 'ticket/60001' ].baseOid ).toBe( site.baseOid );
	expect( meta.branches[ 'ticket/60002' ].baseOid ).toBe( site.baseOid );
} );
