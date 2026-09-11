const path = require( 'node:path' );
const { defineConfig } = require( '@playwright/test' );
const defaults = require( '../../playwright.config.js' );

// Separate from both default projects: a full network install is opt-in only.
module.exports = defineConfig( defaults, {
	timeout: 45 * 60_000,
	retries: 0,
	outputDir: path.join( __dirname, '../../test-results/real-setup' ),
	reporter: [ [ 'list' ], [ 'html', {
		open: 'never',
		outputFolder: path.join( __dirname, '../../playwright-report/real-setup' ),
	} ] ],
	projects: [ { name: 'real-setup', testDir: path.join( __dirname, 'real-setup' ) } ],
} );
