'use strict';

// A site the app will treat as a finished, working checkout — built as a real Git
// repository on disk, because the flows these journeys cover are Git operations
// and a stub would only prove the app can talk to a stub.
//
// The shape mirrors the fixture the integration suite uses
// (tests/unit/ticket-branches.integration.test.cjs), one level up: same trunk branch,
// same three tracked files, and the same gitignored `node_modules` standing in for
// the expensive substrate. That substrate is the point of half these assertions —
// reinstalling it costs a contributor minutes, so a ticket switch that quietly
// removes it is a regression the app would never report.
//
// Small enough that every test builds its own from scratch: nothing here is shared
// between tests, so no journey can be affected by the order it runs in.

const fs = require( 'node:fs' );
const os = require( 'node:os' );
const path = require( 'node:path' );
const { pathToFileURL } = require( 'node:url' );
const {
	gitOk: run,
	initRepo,
	commitFiles,
	currentBranch: headBranch,
	listBranches,
} = require( '../../unit/helpers/git.cjs' );

const TRUNK = 'trunk';
const AUTHOR = { name: 'e2e', email: 'e2e@example.test' };

/**
 * The substrate: gitignored, expensive to rebuild, and must survive everything.
 * A journey asserts on this file's contents, not merely on the directory existing,
 * so a checkout that deletes and recreates it still counts as a loss.
 */
const SUBSTRATE = path.join( 'node_modules', 'react', 'index.js' );
const SUBSTRATE_CONTENT = 'expensive to reinstall\n';

/**
 * Where WordPress's own source lives in a `wordpress-develop` checkout.
 *
 * Not cosmetic. Patches from Trac are often written against the layout core had
 * before everything moved under `src/`, so the app rewrites a path like
 * `wp-login.php` to `src/wp-login.php` on the way in (see `src/patch-plan.cjs`).
 * A fixture with its files at the root would have every patch land somewhere the
 * test never looks, and the test would fail for a reason that is not a bug.
 */
const LOGIN = path.join( 'src', 'wp-login.php' );
const DOOMED = path.join( 'src', 'doomed.php' );

const TRUNK_FILES = {
	'.gitignore': 'node_modules/\nbuild/\n',
	'src/wp-login.php': '<?php // trunk\n',
	'src/doomed.php': '<?php // to be deleted\n',
	// Applying a patch ends by rebuilding the site, the way it does in a real
	// checkout. Without a `build` script the chain fails after the patch is
	// already on disk, and a journey would be asserting on a half-finished
	// flow. It does nothing; what matters is that it exits 0 quickly.
	'package.json': JSON.stringify(
		{ name: 'e2e-fixture-site', version: '1.0.0', private: true, scripts: { build: 'node -e ""' } },
		null,
		2
	) + '\n',
};

/**
 * Creates a repository the app will list, open, and consider ready to work in.
 *
 * @param {Object}  session          A Session from ./app.cjs. The directory is
 *                                   registered with it, so it is removed after the
 *                                   app has stopped — doing it earlier fails on
 *                                   Windows, where a directory with open handles
 *                                   cannot be deleted.
 * @param {Object}  [options]
 * @param {string}  [options.label]  The name shown in the sidebar.
 * @param {boolean} [options.legacy] Shape the repository the way the old engine's shallow clone did (#385).
 * @param {boolean} [options.origin] Give the site an `origin` it can fetch from: a clone of it on disk (#385).
 * @return {Promise<{dir: string, baseOid: string, origin: ?string, settings: Object}>}
 */
async function makeSite( session, { label = 'e2e-site', legacy = false, origin = false } = {} ) {
	const dir = session.track( fs.mkdtempSync( path.join( os.tmpdir(), 'wpct-e2e-site-' ) ) );

	// initRepo gives it the shape the clone writes (git-clone.cjs): a site the
	// app supports has core.autocrlf pinned, so a switch writes LF on Windows
	// too and the byte-for-byte invariants mean the same on every platform.
	initRepo( dir, { branch: TRUNK } );
	fs.mkdirSync( path.join( dir, 'src' ), { recursive: true } );
	for ( const [ file, content ] of Object.entries( TRUNK_FILES ) ) {
		fs.writeFileSync( path.join( dir, file ), content );
	}
	const baseOid = commitFiles( dir, Object.keys( TRUNK_FILES ), 'trunk', { author: AUTHOR } );

	// What a site the old engine cloned looks like to the app (#385): the root
	// commit listed in .git/shallow, and a remote with no promisor. The app
	// detects it from exactly these two facts, so the fixture writes exactly
	// these two things.
	if ( legacy ) {
		fs.writeFileSync( path.join( dir, '.git', 'shallow' ), `${ baseOid }\n` );
		run( [ 'remote', 'add', 'origin', 'https://example.test/wordpress-develop.git' ], dir );
	}

	// Where "Update to latest trunk" fetches from (#385): a clone of the site
	// beside it, reached over `file://`, that a journey moves ahead with
	// `advanceOrigin`. A working clone rather than a bare one so the journey
	// can commit into it with the same binary the app ships.
	let originDir = null;
	if ( origin ) {
		originDir = session.track( fs.mkdtempSync( path.join( os.tmpdir(), 'wpct-e2e-origin-' ) ) );
		run( [ 'clone', '-q', '--config', 'core.autocrlf=false', '--', dir, originDir ], path.dirname( originDir ) );
		run( [ 'remote', 'add', 'origin', pathToFileURL( originDir ).href ], dir );
	}

	fs.mkdirSync( path.join( dir, 'node_modules', 'react' ), { recursive: true } );
	fs.writeFileSync( path.join( dir, SUBSTRATE ), SUBSTRATE_CONTENT );

	// What `site:status` reads to decide the site is installed and built, so the
	// app opens the working views instead of the setup wizard. The directory is
	// what is checked, not its contents.
	fs.mkdirSync( path.join( dir, 'build', 'wp-includes', 'js', 'dist' ), { recursive: true } );

	return { dir, baseOid, origin: originDir, settings: settingsFor( dir, label ) };
}

/**
 * Commits new content into the site's origin, so the next update has
 * something to fetch. Returns the new tip.
 *
 * @param {string}                 origin    The directory `makeSite` returned as `origin`.
 * @param {Object<string, string>} files     Path → content, relative to the repository.
 * @param {string}                 [message]
 * @return {string} The commit id trunk now points at in the origin.
 */
function advanceOrigin( origin, files, message = 'trunk moves on' ) {
	for ( const [ file, content ] of Object.entries( files ) ) {
		fs.mkdirSync( path.dirname( path.join( origin, file ) ), { recursive: true } );
		fs.writeFileSync( path.join( origin, file ), content );
	}
	return commitFiles( origin, Object.keys( files ), message, { author: AUTHOR } );
}

/**
 * The store contents that make the app open on this site with nothing in the way.
 *
 * Dates are relative to now rather than fixed: the staleness dot appears once a
 * snapshot is a fortnight old and joins the sidebar entry's accessible name when
 * it does, so a hardcoded date would quietly change what the selectors match,
 * months after anyone last read this file.
 *
 * @param {string} dir
 * @param {string} label
 * @return {Object}
 */
function settingsFor( dir, label ) {
	const yesterday = new Date( Date.now() - 24 * 60 * 60 * 1000 ).toISOString();
	return {
		sites: [ dir ],
		siteMeta: {
			[ dir ]: {
				initialized: true,
				createdAt: yesterday,
				label,
				trunkDate: yesterday,
				skipInitWizard: true,
			},
		},
		preferences: {},
	};
}

/**
 * @param {string} dir
 * @param {string} file
 * @return {string}
 */
const read = ( dir, file ) => fs.readFileSync( path.join( dir, file ), 'utf8' );

/**
 * @param {string} dir
 * @param {string} file
 * @return {boolean}
 */
const exists = ( dir, file ) => fs.existsSync( path.join( dir, file ) );

/**
 * @param {string} dir
 * @param {string} file
 * @param {string} content
 */
const write = ( dir, file, content ) => fs.writeFileSync( path.join( dir, file ), content );

/**
 * The branches that exist in the repository, read from disk rather than from the
 * app — so an assertion about a branch is about Git, not about what the app
 * believes.
 *
 * @param {string} dir
 * @return {string[]}
 */
const branches = ( dir ) => listBranches( dir );

/**
 * @param {string} dir
 * @return {string}
 */
const currentBranch = ( dir ) => headBranch( dir );

/**
 * Writes a unified diff to a file the app's dialog can be pointed at.
 *
 * Hand-written rather than produced by a Git library: what the app parses is a
 * patch file as it arrives from Trac or a pull request, and generating one with
 * the same code the app reads back would prove less than it looks.
 *
 * @param {Object}                                          session The session that will clean the file up.
 * @param {string}                                          name    File name, e.g. 'ticket-60001.patch'.
 * @param {Array<{file: string, from: string, to: string}>} hunks   One whole-line replacement per
 *                                                                  file: the line to find, and what
 *                                                                  replaces it.
 * @return {string} The path written.
 */
function makePatchFile( session, name, hunks ) {
	const dir = session.track( fs.mkdtempSync( path.join( os.tmpdir(), 'wpct-e2e-patch-' ) ) );
	const body = hunks
		.map(
			( { file, from, to } ) =>
				`--- a/${ file }\n+++ b/${ file }\n@@ -1 +1 @@\n-${ from }\n+${ to }\n`
		)
		.join( '' );
	const file = path.join( dir, name );
	fs.writeFileSync( file, body );
	return file;
}

module.exports = {
	makeSite,
	advanceOrigin,
	makePatchFile,
	settingsFor,
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
};
