/**
 * A merge started outside the app, seen through the app (#352).
 *
 * A mentor's own Git leaves a merge half done in the checkout: unmerged
 * entries, MERGE_HEAD, markers in the files. Nothing the app runs makes that
 * state, and every forced checkout the app runs would erase it without a
 * word. The refusal starts in the main process and ends on the card, so only
 * a journey can say the contributor actually sees it: the banner naming the
 * file, the refused ticket link, the merge left exactly as it was, the state
 * read from the repository again after a restart, and the way out being the
 * terminal the state came from.
 *
 * The merge is made by the bundled Git before the app starts, the way a
 * terminal would make it. Assertions are marked INVARIANT or
 * CHARACTERISATION; see ticket-branches.spec.js for why.
 */

const fs = require( 'node:fs' );
const path = require( 'node:path' );
const { test, expect } = require( '../helpers/app.cjs' );
const { makeSite, read, exists, branches, currentBranch, LOGIN, SUBSTRATE, SUBSTRATE_CONTENT } = require( '../helpers/git-site.cjs' );
const { git, gitOk, commitFiles } = require( '../../unit/helpers/git.cjs' );

const TICKET = '60001';
const BANNER = 'A merge started outside the app is in progress.';
const MENTOR_LOGIN = '<?php // the mentor\'s fix\n';

/**
 * A branch that disagrees with trunk on the login file, merged into trunk
 * and left on its conflict: what `git merge mentor/fix` leaves behind.
 *
 * @param {string} dir
 */
function leaveMergeHalfDone( dir ) {
	gitOk( [ 'checkout', '-q', '-b', 'mentor/fix' ], dir );
	fs.writeFileSync( path.join( dir, LOGIN ), MENTOR_LOGIN );
	commitFiles( dir, [ LOGIN ], 'the mentor\'s fix' );
	gitOk( [ 'checkout', '-q', 'trunk' ], dir );
	fs.writeFileSync( path.join( dir, LOGIN ), '<?php // trunk moved too\n' );
	commitFiles( dir, [ LOGIN ], 'trunk moves' );
	const merge = git( [ 'merge', 'mentor/fix' ], dir );
	expect( merge.status ).toBe( 1 );
	expect( mergeHead( dir ) ).toBe( true );
}

const mergeHead = ( dir ) => fs.existsSync( path.join( dir, '.git', 'MERGE_HEAD' ) );
const hasMarkers = ( dir ) => /^<<<<<<< /m.test( read( dir, LOGIN ) );

test( 'a merge left half done by a terminal is named on the card, refuses the ticket link, survives a restart, and ends where it began', async ( { session } ) => {
	const site = await makeSite( session );
	leaveMergeHalfDone( site.dir );
	const markersBefore = read( site.dir, LOGIN );
	const { page } = await session.start( site.settings );

	// INVARIANT — the card says what is going on and names the file.
	const banner = page.getByRole( 'alert' ).filter( { hasText: BANNER } );
	await expect( banner ).toBeVisible( { timeout: 30_000 } );
	await expect( banner ).toContainText( 'conflicts in src/wp-login.php' );
	await expect( banner ).toContainText( 'git merge --abort' );

	// INVARIANT — linking a ticket is refused with the same sentence, and the
	// merge is left exactly as the terminal left it: no branch, MERGE_HEAD
	// still there, the markers still in the file.
	await page.getByLabel( 'Trac ticket number or URL' ).first().fill( TICKET );
	await page.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	// The refusal under the field is a second alert with the same sentence,
	// beside the banner: two on screen, where one is the banner alone.
	await expect( page.getByRole( 'alert' ).filter( { hasText: 'Finish it from a terminal' } ) ).toHaveCount( 2, { timeout: 30_000 } );
	expect( branches( site.dir ) ).not.toContain( `ticket/${ TICKET }` );
	expect( mergeHead( site.dir ) ).toBe( true );
	expect( read( site.dir, LOGIN ) ).toBe( markersBefore );
	expect( currentBranch( site.dir ) ).toBe( 'trunk' );

	// INVARIANT — the state is read from the repository, not remembered: a
	// fresh app finds it again.
	const { page: reopened } = await session.restart();
	await expect( reopened.getByRole( 'alert' ).filter( { hasText: BANNER } ) ).toBeVisible( { timeout: 30_000 } );
	expect( hasMarkers( site.dir ) ).toBe( true );

	// The way out is the terminal the state came from.
	gitOk( [ 'merge', '--abort' ], site.dir );
	expect( mergeHead( site.dir ) ).toBe( false );
	expect( hasMarkers( site.dir ) ).toBe( false );

	// INVARIANT — with the merge gone, the same link goes through and the
	// banner goes with it.
	await reopened.getByLabel( 'Trac ticket number or URL' ).first().fill( TICKET );
	await reopened.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	await expect( reopened.getByText( `#${ TICKET }`, { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
	await expect( reopened.getByRole( 'alert' ).filter( { hasText: BANNER } ) ).toHaveCount( 0 );
	expect( branches( site.dir ) ).toContain( `ticket/${ TICKET }` );
	// INVARIANT — the substrate was never touched.
	expect( read( site.dir, SUBSTRATE ) ).toBe( SUBSTRATE_CONTENT );
	expect( exists( site.dir, LOGIN ) ).toBe( true );
} );

test( 'a merge finished by a terminal before the app opens is not a merge in progress', async ( { session } ) => {
	const site = await makeSite( session );
	leaveMergeHalfDone( site.dir );
	// Resolved in an editor, staged and committed, as a mentor would.
	fs.writeFileSync( path.join( site.dir, LOGIN ), MENTOR_LOGIN );
	commitFiles( site.dir, [ LOGIN ], 'merged by hand' );
	expect( mergeHead( site.dir ) ).toBe( false );

	const { page } = await session.start( site.settings );
	await expect( page.getByLabel( 'Trac ticket number or URL' ).first() ).toBeVisible( { timeout: 30_000 } );
	// INVARIANT — no banner, and the ticket links.
	await expect( page.getByRole( 'alert' ).filter( { hasText: BANNER } ) ).toHaveCount( 0 );
	await page.getByLabel( 'Trac ticket number or URL' ).first().fill( TICKET );
	await page.getByRole( 'button', { name: 'Link ticket', exact: true } ).first().click();
	await expect( page.getByText( `#${ TICKET }`, { exact: true } ).first() ).toBeVisible( { timeout: 30_000 } );
	// CHARACTERISATION — the hand-made merge commit is the branch point the app
	// recorded, so the mentor's work is part of the site, not of the ticket.
	expect( read( site.dir, LOGIN ) ).toBe( MENTOR_LOGIN );
} );
