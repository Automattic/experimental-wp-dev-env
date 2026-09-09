/**
 * Moving a ticket's work onto the current trunk, driven through the app (#385).
 *
 * After an update the ticket card says trunk has moved and, since the bundled
 * Git, offers to move the work itself. The move crosses every layer: main
 * replays the ticket's single WIP commit onto trunk and rewrites the checkout,
 * the store records the new base, and the card's notice goes away because
 * status now finds the ticket current. A conflict is the other half of the
 * contract: refused with the file named, nothing moved.
 *
 * The origin is a clone of the site on disk, moved ahead by the test; the
 * update that makes the ticket stale runs through the app too, so the state
 * the button meets is the one a contributor has. Nothing here reaches the
 * network.
 *
 * Assertions are marked INVARIANT or CHARACTERISATION; see
 * ticket-branches.spec.js for why.
 */

const { test, expect } = require( '../helpers/app.cjs' );
const { makeSite, advanceOrigin, read, write, currentBranch, SUBSTRATE, SUBSTRATE_CONTENT, LOGIN, DOOMED } = require( '../helpers/git-site.cjs' );

const TICKET = '60001';
const MY_LOGIN = '<?php // my work on the ticket\n';
const NOTICE = 'Trunk has moved since this ticket started.';
const BUTTON = 'Update this ticket to the current trunk';

/**
 * Links the ticket, edits a file on it, and updates the site so trunk moves
 * ahead of the ticket's base: the state in which the notice appears.
 *
 * @param {Object} session
 * @param {Object} site
 * @param {Object} originChange Files to commit into the origin before the update.
 */
async function makeTicketBehindTrunk( session, site, originChange ) {
	const { page } = session;
	await page.getByLabel( 'Trac ticket number or URL' ).first().fill( TICKET );
	await page.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	await expect( page.getByText( `#${ TICKET }`, { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
	write( site.dir, LOGIN, MY_LOGIN );
	// Park the edit on the ticket (unlink, then continue) so the update meets
	// a clean tree: the edit is the ticket's work, not something to save or
	// discard at the update's dirty-tree question.
	await page.getByRole( 'button', { name: 'Unlink', exact: true } ).click();
	await page.getByRole( 'button', { name: `Continue working on #${ TICKET }`, exact: true } ).click( { timeout: 30_000 } );
	await expect( page.getByText( `#${ TICKET }`, { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
	const newTip = advanceOrigin( site.origin, originChange );

	await page.getByRole( 'button', { name: 'More', exact: true } ).click();
	await page.getByRole( 'menuitem', { name: 'Update to latest trunk', exact: true } ).click();
	await expect( page.getByText( 'Updated to the latest trunk' ).first() ).toBeVisible( { timeout: 120_000 } );
	await expect( page.getByText( NOTICE ) ).toBeVisible( { timeout: 30_000 } );
	return newTip;
}

test( 'the notice moves the ticket onto the current trunk in one click, keeping the work and the substrate', async ( { session } ) => {
	const site = await makeSite( session, { origin: true } );
	await session.start( site.settings );
	const { page } = session;
	const newTip = await makeTicketBehindTrunk( session, site, { 'src/doomed.php': '<?php // trunk moved this\n' } );

	await page.getByRole( 'button', { name: BUTTON, exact: true } ).click();

	// INVARIANT — the ticket is current now, and says nothing more about it.
	await expect( page.getByText( NOTICE ) ).toHaveCount( 0, { timeout: 60_000 } );
	await expect( page.getByRole( 'alert' ) ).toHaveCount( 0 );

	// INVARIANT — the work survived, trunk's change arrived, the substrate
	// was never touched, and the ticket is still the one checked out.
	expect( read( site.dir, LOGIN ) ).toBe( MY_LOGIN );
	expect( read( site.dir, DOOMED ) ).toBe( '<?php // trunk moved this\n' );
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );
	expect( await currentBranch( site.dir ) ).toBe( `ticket/${ TICKET }` );

	// CHARACTERISATION — the registry holds the new base.
	const meta = session.readSettings().siteMeta[ site.dir ];
	expect( meta.branches[ `ticket/${ TICKET }` ].baseOid ).toBe( newTip );
} );

test( 'a move that would overlap trunk\'s changes is refused by name, and nothing moves', async ( { session } ) => {
	const site = await makeSite( session, { origin: true } );
	await session.start( site.settings );
	const { page } = session;
	await makeTicketBehindTrunk( session, site, { 'src/wp-login.php': '<?php // trunk rewrote the same line\n' } );
	const baseBefore = session.readSettings().siteMeta[ site.dir ].branches[ `ticket/${ TICKET }` ].baseOid;

	await page.getByRole( 'button', { name: BUTTON, exact: true } ).click();

	// INVARIANT — refused with the file, the notice still there, the work as
	// it was, and the base where it was.
	await expect( page.getByText( 'Trunk changed the same lines as your work in: src/wp-login.php', { exact: false } ) ).toBeVisible( { timeout: 60_000 } );
	await expect( page.getByText( NOTICE ) ).toBeVisible();
	expect( read( site.dir, LOGIN ) ).toBe( MY_LOGIN );
	expect( session.readSettings().siteMeta[ site.dir ].branches[ `ticket/${ TICKET }` ].baseOid ).toBe( baseBefore );
} );
