const fs = require( 'node:fs' );
const os = require( 'node:os' );
const path = require( 'node:path' );
const { finished } = require( 'node:stream/promises' );
const { test, expect } = require( '../helpers/app.cjs' );

test( 'a new site downloads, installs, builds and serves WordPress', async ( { session, request }, testInfo ) => {
	test.skip( process.env.TOOLKIT_REAL_SETUP !== '1', 'Set TOOLKIT_REAL_SETUP=1 to allow a real network install.' );
	const parent = session.track( fs.mkdtempSync( path.join( os.tmpdir(), 'wpct-real-setup-' ) ) );
	const sitePath = path.join( parent, 'real-setup' );
	const { app, page } = await session.start();
	const logPath = testInfo.outputPath( 'app.log' );
	fs.mkdirSync( path.dirname( logPath ), { recursive: true } );
	const log = fs.createWriteStream( logPath );
	const proc = app.process();
	const onOutput = ( chunk ) => log.write( chunk );
	proc.stdout.on( 'data', onOutput );
	proc.stderr.on( 'data', onOutput );

	try {
		await test.step( 'Create a site in an isolated temporary directory', async () => {
			await session.answerFileDialog( [ parent ] );
			await page.getByRole( 'button', { name: 'Create WordPress Core site', exact: true } ).click();
			const modal = page.getByRole( 'dialog', { name: 'Create WordPress Core site' } );
			await modal.getByLabel( 'Site name', { exact: true } ).fill( 'real-setup' );
			await modal.getByLabel( 'Site location', { exact: true } ).press( 'Enter' );
			await modal.getByRole( 'button', { name: 'Create site', exact: true } ).click();
		} );

		await test.step( 'Wait for the real clone, npm install and full build', async () => {
			// INVARIANT: the app completes the automatic chain without retry clicks.
			// WordPress mirrors the same success message in its live region.
			await expect( page.getByText( 'This site is ready to work on', { exact: true } ).first() ).toBeVisible( {
				timeout: 40 * 60_000,
			} );
			const status = await page.evaluate( ( dir ) => window.api.getSiteStatus( dir ), sitePath );
			expect( status.hasNodeModules ).toBe( true );
			expect( status.hasBuilt ).toBe( true );
			await testInfo.attach( 'site-status.json', {
				body: JSON.stringify( status, null, 2 ), contentType: 'application/json',
			} );
		} );

		await test.step( 'Start the dev server and verify WordPress over HTTP', async () => {
			await page.getByRole( 'button', { name: 'Start dev server and finish the wizard', exact: true } ).click();
			const adminLink = page.getByRole( 'link', { name: 'wp-admin', exact: true } );
			await expect( adminLink ).toBeVisible( { timeout: 3 * 60_000 } );
			const adminUrl = new URL( await adminLink.getAttribute( 'href' ) );
			// INVARIANT: probe only the local server this app just started.
			expect( adminUrl.protocol ).toBe( 'http:' );
			expect( [ '127.0.0.1', 'localhost' ] ).toContain( adminUrl.hostname );
			await expect( async () => {
				const response = await request.get( new URL( '/wp-login.php', adminUrl ).href, { timeout: 15_000 } );
				expect( response.status() ).toBe( 200 );
				const html = await response.text();
				// INVARIANT: PHP serves the WordPress login form, not just an open port.
				expect( html ).toContain( 'id="loginform"' );
				expect( html ).toContain( 'name="log"' );
			} ).toPass( { timeout: 60_000, intervals: [ 2_000, 5_000 ] } );
			await page.getByRole( 'button', { name: 'Stop build watch', exact: true } ).click();
			await page.getByRole( 'button', { name: 'Stop dev server', exact: true } ).click();
		} );
	} finally {
		// The session fixture captures failure evidence, quits (killing child
		// processes) and removes only its own profile and tracked temp directory.
		proc.stdout.off( 'data', onOutput );
		proc.stderr.off( 'data', onOutput );
		log.end();
		await finished( log );
		await testInfo.attach( 'app.log', { path: logPath, contentType: 'text/plain' } );
	}
} );
