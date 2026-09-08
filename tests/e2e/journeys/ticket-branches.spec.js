/**
 * Ticket branches, driven through the app (#361).
 *
 * The flow a contributor performs by hand at a Contributor Day: link a ticket,
 * edit something, link a second ticket, come back to the first. It is the flow
 * #350 moves wholesale, and the one whose failures are silent — the app does not
 * report work it quietly failed to restore.
 *
 * Assertions are marked as one of two kinds, and the distinction is the point of
 * the file:
 *
 *   INVARIANT      must hold under any model of how the app stores work. If one
 *                  of these goes red during #350, something is broken.
 *   CHARACTERISATION  true because of how the app stores things today. If one of
 *                  these goes red during #350, read it, decide whether the new
 *                  model is what you meant, and update it deliberately.
 *
 * Nothing here asserts on the ticket's Trac or pull-request panels. Linking a
 * ticket does start a GitHub lookup for its pull requests, so the app really
 * does reach the network at that moment — but an assertion that depends on a
 * third party being reachable is a flake waiting for a Monday morning, and none
 * of these need one. Trac itself is only read when the contributor asks for it.
 */

const fs = require( 'node:fs' );
const path = require( 'node:path' );
const { test, expect } = require( '../helpers/app.cjs' );
const {
	makeSite,
	read,
	write,
	exists,
	branches,
	currentBranch,
	TRUNK,
	SUBSTRATE,
	SUBSTRATE_CONTENT,
	LOGIN,
	DOOMED,
} = require( '../helpers/git-site.cjs' );

const MY_EDIT = '<?php // my fix for 60001\n';

/**
 * @param {string} dir
 * @param {string} file
 */
const remove = ( dir, file ) => fs.unlinkSync( path.join( dir, file ) );

/**
 * The panel row for one ticket, in the list of a site's tickets.
 *
 * Addressed by the ticket it offers to continue rather than by position. Every
 * row carries an identically labelled delete control, and the list is ordered by
 * how recently each ticket was used — so `.first()` picks whichever ticket the
 * app most recently touched, which is a different one depending on how far the
 * render has got. That is a test that deletes the wrong branch and then fails
 * somewhere else entirely.
 *
 * @param {Object} page
 * @param {string} ticket
 * @return {Object} The row locator.
 */
const ticketRow = ( page, ticket ) =>
	page
		.locator( 'div' )
		.filter( { has: page.getByRole( 'button', { name: `Continue working on #${ ticket }`, exact: true } ) } )
		.filter( { has: page.getByRole( 'button', { name: "Delete this ticket's work", exact: true } ) } )
		.last();

/**
 * Links a ticket through the panel, the way a contributor does.
 *
 * Unlinks first when something is already linked, because that is the only route
 * the app offers: once a ticket is linked its card shows that ticket's pull
 * requests and attachments, and the "Trac ticket number or URL" field is not on
 * screen at all. Unlinking is not throwing the ticket away — it parks the work
 * on its branch and returns the checkout to trunk — but it is a step, and a test
 * that skipped it would be testing a path no contributor can take.
 *
 * @param {Object} page
 * @param {string} ticket
 */
async function linkTicket( page, ticket ) {
	const unlink = page.getByRole( 'button', { name: 'Unlink', exact: true } );
	if ( await unlink.isVisible().catch( () => false ) ) {
		await unlink.click();
		await expect( page.getByLabel( 'Trac ticket number or URL' ).first() ).toBeVisible();
	}
	await page.getByLabel( 'Trac ticket number or URL' ).first().fill( ticket );
	await page.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	// The ticket number rendered as the panel's subject is the app saying it
	// finished. Waiting on it rather than on a timeout is what keeps this honest
	// on a Windows runner, where the checkout takes noticeably longer.
	await expect( page.getByText( `#${ ticket }`, { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
}

test( 'linking a ticket creates its branch and leaves trunk alone', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );

	await linkTicket( page, '60001' );

	// INVARIANT — the ticket is a branch in the repository, and it is the one
	// checked out. Whatever the app records about it is secondary to this.
	expect( branches( site.dir ) ).toContain( 'ticket/60001' );
	expect( currentBranch( site.dir ) ).toBe( 'ticket/60001' );

	// INVARIANT — the substrate survives. Reinstalling it costs a contributor
	// minutes, and nothing in the app would report that it had gone.
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );

	// CHARACTERISATION — the linked ticket and the branch it maps to are held in
	// the store, per site.
	const meta = session.readSettings().siteMeta[ site.dir ];
	expect( meta.tracTicket ).toBe( 60001 );
	expect( meta.currentBranch ).toBe( 'ticket/60001' );
} );

test( 'unlinking parks a ticket, and the next one starts from trunk', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );

	await linkTicket( page, '60001' );
	write( site.dir, LOGIN, MY_EDIT );

	await linkTicket( page, '60002' );

	// INVARIANT — the second ticket starts from trunk. Seeing the first ticket's
	// edit here would mean two tickets' work ending up in one patch, which is
	// the failure a contributor discovers only when a reviewer asks about it.
	expect( read( site.dir, LOGIN ) ).toBe( '<?php // trunk\n' );
	expect( currentBranch( site.dir ) ).toBe( 'ticket/60002' );
	expect( branches( site.dir ) ).toEqual(
		expect.arrayContaining( [ TRUNK, 'ticket/60001', 'ticket/60002' ] )
	);

	// INVARIANT — still there, after a second checkout of the same directory.
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );

	// INVARIANT — both tickets are offered in the panel, so the parked one is
	// reachable rather than merely present in the repository.
	await expect( page.getByText( '#60001', { exact: false } ).first() ).toBeVisible();
} );

test( 'switching back to a ticket restores its work byte for byte', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );

	await linkTicket( page, '60001' );
	write( site.dir, LOGIN, MY_EDIT );
	// A deletion too: an edit that comes back while a deletion does not is a
	// partially restored tree, which is worse than an obvious failure.
	remove( site.dir, DOOMED );

	await linkTicket( page, '60002' );
	expect( exists( site.dir, DOOMED ) ).toBe( true );

	// Back to the first ticket, through the row the panel offers for it.
	await page.getByRole( 'button', { name: 'switch', exact: true } ).click();
	await expect
		.poll( () => currentBranch( site.dir ), { timeout: 20_000 } )
		.toBe( 'ticket/60001' );

	// INVARIANT — both halves of the work return: the edit and the deletion.
	expect( read( site.dir, LOGIN ) ).toBe( MY_EDIT );
	expect( exists( site.dir, DOOMED ) ).toBe( false );
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );
} );

test( "deleting a ticket's work removes only that ticket", async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );
	const confirmsAnswered = await session.acceptConfirms();

	await linkTicket( page, '60001' );
	write( site.dir, LOGIN, MY_EDIT );
	await linkTicket( page, '60002' );

	// Unlink first: the list of a site's tickets deliberately leaves out the one
	// currently linked — its card is the panel above — so the delete control for
	// a ticket only exists once you are not on it. A contributor deleting the
	// ticket they are working on takes this same route.
	await page.getByRole( 'button', { name: 'Unlink', exact: true } ).click();

	const row = ticketRow( page, '60002' );
	await expect( row ).toBeVisible();
	await row.getByRole( 'button', { name: "Delete this ticket's work", exact: true } ).click();

	await expect
		.poll( () => branches( site.dir ), { timeout: 30_000 } )
		.not.toContain( 'ticket/60002' );

	// INVARIANT — it deletes only what was asked for. The other ticket's work is
	// untouched, the checkout is on trunk, and the substrate is still there.
	expect( branches( site.dir ) ).toContain( 'ticket/60001' );
	expect( currentBranch( site.dir ) ).toBe( TRUNK );
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );

	// INVARIANT — and the deleted ticket is gone from the panel, not merely from
	// the repository. A row still offering to continue work that no longer
	// exists is a dead end.
	await expect(
		page.getByRole( 'button', { name: 'Continue working on #60002', exact: true } )
	).toHaveCount( 0 );
	await expect(
		page.getByRole( 'button', { name: 'Continue working on #60001', exact: true } )
	).toBeVisible();

	// INVARIANT — it asked first. A destructive action that skips the
	// confirmation is a bug even when it deletes the right thing.
	expect( await confirmsAnswered() ).toBe( 1 );

	// CHARACTERISATION — the store drops the branch's record with it, and keeps
	// the other one, including the base commit its patch is measured against.
	const meta = session.readSettings().siteMeta[ site.dir ];
	expect( Object.keys( meta.branches ) ).toEqual( [ 'ticket/60001' ] );
	expect( meta.branches[ 'ticket/60001' ].baseOid ).toBe( site.baseOid );
} );
