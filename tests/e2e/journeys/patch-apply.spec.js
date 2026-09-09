/**
 * Applying and reverting a patch, driven through the app (#361).
 *
 * The other half of a contributor's day: someone else's work arrives as a patch
 * file or a pull request, and it has to go onto the checkout and come off again
 * without taking anything of theirs with it. #350 changes what "applied" means —
 * today it is a layer the app holds, afterwards it is a commit — so what is
 * pinned here is the part that must survive either model.
 *
 * Assertions are marked INVARIANT or CHARACTERISATION; see ticket-branches.spec.js
 * for what the distinction buys during that refactor.
 *
 * The patch arrives from a local file through the app's own file dialog, answered
 * from the test. Nothing here fetches a pull request: that would put a third
 * party in the path of a test that is about the checkout.
 */

const { test, expect } = require( '../helpers/app.cjs' );
const {
	makeSite,
	makePatchFile,
	read,
	write,
	SUBSTRATE,
	SUBSTRATE_CONTENT,
	LOGIN,
	DOOMED,
} = require( '../helpers/git-site.cjs' );

const TRUNK_LOGIN = '<?php // trunk';
const PATCHED_LOGIN = '<?php // fixed by the patch';

/**
 * @param {Object} page
 * @param {string} ticket
 */
async function linkTicket( page, ticket ) {
	await page.getByLabel( 'Trac ticket number or URL' ).first().fill( ticket );
	await page.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	await expect( page.getByText( `#${ ticket }`, { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
}

/**
 * Chooses a patch file and confirms the preview the app shows before writing.
 *
 * @param {Object} session
 * @param {string} patchFile
 */
async function applyPatchFile( session, patchFile ) {
	const { page } = session;
	await session.answerFileDialog( [ patchFile ] );
	await page.getByRole( 'button', { name: 'or choose a .diff / .patch file…', exact: true } ).click();

	// The preview is a gate, not a formality: it is the app saying what it is
	// about to write, before anything is written. It names `src/wp-login.php`
	// though the patch says `wp-login.php`, because the app rewrites paths
	// written against core's pre-`src/` layout — see src/patch-plan.cjs.
	await expect( page.getByText( 'src/wp-login.php', { exact: true } ) ).toBeVisible( { timeout: 30_000 } );
	await page.getByRole( 'button', { name: 'Apply and rebuild', exact: true } ).click();
}

test( 'applying a patch file changes the checkout and records what was applied', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );
	await linkTicket( page, '60001' );

	const patch = makePatchFile( session, 'ticket-60001.patch', [
		{ file: 'wp-login.php', from: TRUNK_LOGIN, to: PATCHED_LOGIN },
	] );
	await applyPatchFile( session, patch );

	// The offer to undo is the app saying the apply finished, and it is on the
	// same card. Waiting for it beats waiting for a rebuild that a slower runner
	// may still be finishing.
	await expect( page.getByRole( 'button', { name: 'Revert this patch', exact: true } ) ).toBeVisible( {
		timeout: 60_000,
	} );

	// INVARIANT — the patch is on disk, in the working tree, not merely recorded.
	expect( read( site.dir, LOGIN ) ).toBe( `${ PATCHED_LOGIN }\n` );

	// INVARIANT — and it wrote nothing else. The substrate is what a rebuild
	// would be most likely to take with it.
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );
	expect( read( site.dir, DOOMED ) ).toBe( '<?php // to be deleted\n' );

	// CHARACTERISATION — today the applied patch is a record the app holds
	// against the branch, naming the files it touched. After #350 it should be a
	// commit; this assertion is the one that will say so.
	const meta = session.readSettings().siteMeta[ site.dir ];
	const applied = meta.branches[ 'ticket/60001' ].appliedPatch;
	expect( applied.label ).toBe( 'ticket-60001.patch' );
	// The rewritten path, not the one the patch named: what the record has to
	// describe is what changed on disk.
	expect( applied.files ).toEqual( [ 'src/wp-login.php' ] );
} );

test( 'reverting puts the checkout back and leaves unrelated work alone', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );
	await linkTicket( page, '60001' );

	// The contributor's own work, in a file the patch does not touch. Reverting
	// somebody else's patch must not reach it.
	write( site.dir, DOOMED, '<?php // my own work in progress\n' );

	const patch = makePatchFile( session, 'ticket-60001.patch', [
		{ file: 'wp-login.php', from: TRUNK_LOGIN, to: PATCHED_LOGIN },
	] );
	await applyPatchFile( session, patch );
	const revert = page.getByRole( 'button', { name: 'Revert this patch', exact: true } );
	await expect( revert ).toBeVisible( { timeout: 60_000 } );

	await revert.click();
	await expect( revert ).toHaveCount( 0, { timeout: 60_000 } );
	// The button leaves the moment the revert starts, so it is not the signal
	// that the revert finished. The next-step line is: it names the operation
	// while it runs and moves on once the status has been reloaded, which
	// happens after the checkout and the record are both written.
	await expect( page.getByText( 'A patch is being applied or reverted.' ) ).toHaveCount( 0, { timeout: 60_000 } );

	// INVARIANT — the patched file is back, byte for byte.
	expect( read( site.dir, LOGIN ) ).toBe( `${ TRUNK_LOGIN }\n` );

	// INVARIANT — and the contributor's own edit survived both directions. This
	// is the failure that costs somebody their afternoon and reports nothing.
	expect( read( site.dir, DOOMED ) ).toBe( '<?php // my own work in progress\n' );
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );

	// CHARACTERISATION — the record goes with it.
	const meta = session.readSettings().siteMeta[ site.dir ];
	expect( meta.branches[ 'ticket/60001' ].appliedPatch ).toBeFalsy();
} );

test( 'a patch that does not fit is refused, and writes nothing', async ( { session } ) => {
	const site = await makeSite( session );
	const { page } = await session.start( site.settings );
	await linkTicket( page, '60001' );

	// The contributor has already edited the line the patch expects to find.
	const mine = '<?php // I got here first\n';
	write( site.dir, LOGIN, mine );

	const patch = makePatchFile( session, 'ticket-60001.patch', [
		{ file: 'wp-login.php', from: TRUNK_LOGIN, to: PATCHED_LOGIN },
	] );
	await session.answerFileDialog( [ patch ] );
	await page.getByRole( 'button', { name: 'or choose a .diff / .patch file…', exact: true } ).click();
	await expect( page.getByText( 'src/wp-login.php', { exact: true } ) ).toBeVisible( { timeout: 30_000 } );

	// INVARIANT — the app warns before writing, not after. A contributor about
	// to drop somebody else's patch onto their own edits is told so while they
	// can still stop.
	await expect(
		page.getByRole( 'alert' ).filter( { hasText: 'You have your own edits to src/wp-login.php' } )
	).toBeVisible();

	await page.getByRole( 'button', { name: 'Apply and rebuild', exact: true } ).click();

	// INVARIANT — the refusal says the checkout was not touched, names the file,
	// and says how much of the patch failed. Asserted on the alert rather than on
	// the page: the preview above is still on screen and already names the file,
	// so a looser locator would pass whether or not the app reported anything.
	const failure = page.getByRole( 'alert' ).filter( { hasText: 'The checkout was not changed' } );
	await expect( failure ).toBeVisible( { timeout: 60_000 } );
	await expect( failure ).toContainText( 'src/wp-login.php' );

	// INVARIANT — all or nothing. A half-applied patch leaves a contributor with
	// a tree neither they nor the app can explain.
	expect( read( site.dir, LOGIN ) ).toBe( mine );
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );

	// INVARIANT — and nothing is offered to undo, because nothing was done.
	await expect( page.getByRole( 'button', { name: 'Revert this patch', exact: true } ) ).toHaveCount( 0 );
} );
