/**
 * A site the old engine made, seen through the app (#385).
 *
 * The app's Git engine changed and the sites the old one cloned are refused on
 * every write. The refusal starts in the main process and ends on the card, so
 * only a journey can say the contributor actually sees it: the banner, the
 * refused ticket link, the way out (a new site), and that the way out is open
 * (deleting the old site still works).
 *
 * Assertions are marked INVARIANT or CHARACTERISATION; see
 * ticket-branches.spec.js for why.
 */

const { test, expect } = require( '../helpers/app.cjs' );
const { makeSite, exists, branches, LOGIN } = require( '../helpers/git-site.cjs' );

test( 'a site the old engine made is read, refused on every write, and can still be deleted', async ( { session } ) => {
	const site = await makeSite( session, { legacy: true } );
	const { page } = await session.start( site.settings );
	const confirmsAnswered = await session.acceptConfirms();

	// INVARIANT — the card says why the site cannot be used and where to go.
	await expect( page.getByText( 'This site was created by an earlier version of the app.' ) ).toBeVisible( { timeout: 30_000 } );

	// INVARIANT — linking a ticket is refused with the same sentence, and the
	// repository is left as it was: no branch, no checkout.
	await page.getByLabel( 'Trac ticket number or URL' ).first().fill( '60001' );
	await page.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	await expect( page.getByRole( 'alert' ).filter( { hasText: 'earlier version of the app' } ).first() ).toBeVisible( { timeout: 30_000 } );
	expect( await branches( site.dir ) ).not.toContain( 'ticket/60001' );
	expect( exists( site.dir, LOGIN ) ).toBe( true );

	// INVARIANT — the way out is one click away: the banner opens the create
	// modal the sidebar button opens.
	await page.getByRole( 'button', { name: 'Create site', exact: true } ).click();
	await expect( page.getByRole( 'dialog', { name: 'Create WordPress Core site' } ) ).toBeVisible();
	await page.keyboard.press( 'Escape' );
	await expect( page.getByRole( 'dialog', { name: 'Create WordPress Core site' } ) ).toHaveCount( 0 );

	// INVARIANT — deleting is not behind the refusal.
	await page.getByRole( 'button', { name: 'More', exact: true } ).click();
	await page.getByRole( 'menuitem', { name: 'Delete this site', exact: true } ).click();
	await expect( page.getByText( 'No sites yet.' ).first() ).toBeVisible( { timeout: 30_000 } );
	expect( await confirmsAnswered() ).toBe( 1 );
	// CHARACTERISATION — the registry forgot it.
	expect( session.readSettings().sites ).toEqual( [] );
} );
