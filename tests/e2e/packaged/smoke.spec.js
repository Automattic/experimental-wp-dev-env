/**
 * Smoke test for the packaged app.
 *
 * Runs against an unsigned `electron-builder --dir` build, not the source tree.
 * The failures it exists to catch — asar layout, native module rebuilds, bundled
 * CLI resolution — do not reproduce under `npm start`.
 *
 * Build it first (see TESTING.md):
 *   npm run build:once && CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:dir
 *
 * It writes no state, so it deliberately does not use the session helper the
 * journeys are built on: there is no profile to seed and nothing to read back.
 */

const fs = require( 'node:fs' );
const path = require( 'node:path' );
const { execFileSync } = require( 'node:child_process' );
const { test, expect, _electron: electron } = require( '@playwright/test' );

const REPO_ROOT = path.join( __dirname, '..', '..', '..' );
const DIST = path.join( REPO_ROOT, 'dist' );

/**
 * Every key exposed through `contextBridge` in src/preload.js.
 *
 * This repo has no typecheck, so nothing else catches an `ipcMain.handle` added
 * in src/main.js and never bridged to the renderer. Adding an API means adding it
 * here too — that is the point, the list is meant to be edited deliberately.
 *
 * Do not try to derive it by reading src/preload.js. Two of these keys
 * (`signInToGithub`, `cancelGithubSignIn`) are spread in from an immediately
 * invoked function that closes over a listener, so they exist only once the file
 * has run. Anything that greps for the object's literal keys silently misses
 * them — which is the same class of gap this assertion exists to close, one
 * level up.
 */
const EXPECTED_API_KEYS = [
	'addSite',
	'applyPatch',
	'cancelGithubSignIn',
	'chooseDirectory',
	'choosePatchFile',
	'clearEmails',
	'clearWpDebug',
	'createPatchWindow',
	'deleteBranch',
	'deleteSite',
	'discardChanges',
	'discardToBase',
	'fetchPrDiff',
	'fetchTracAttachment',
	'getEmails',
	'getGithubAccount',
	'getPatch',
	'getProvenance',
	'getSiteStatus',
	'getSites',
	'getSitesWithMeta',
	'hasUnsubmittedWork',
	'isWorktreeDirty',
	'listBranches',
	'listEditors',
	'listTicketPatches',
	'listTracAttachments',
	'markSiteInitialized',
	'markUpdateComplete',
	'npmKill',
	'onNewEmail',
	'onSmtpStarted',
	'openExternal',
	'openInEditor',
	'openPullRequest',
	'platform',
	'playgroundWebAvailable',
	'previewPatch',
	'rebaseBranch',
	'revealWpDebug',
	'runNpmInstall',
	'runNpmScript',
	'savePatch',
	'setContributionEvent',
	'setSiteLabel',
	'setSiteTicket',
	'setSkipInitWizard',
	'setWporgHandle',
	'setupWordPress',
	'showSiteInFileManager',
	'signInToGithub',
	'signOutOfGithub',
	'startPlaygroundWeb',
	'startServer',
	'startSmtp',
	'startWpDebug',
	'stopPlaygroundWeb',
	'stopServer',
	'stopSmtp',
	'stopWpDebug',
	'subscribeCarriedWork',
	'subscribePullRequestProgress',
	'subscribeSetupProgress',
	'subscribeSetupStatus',
	'subscribeSwitchProgress',
	'switchBranch',
	'updateTrunk',
];

/**
 * Modules the app resolves at runtime that only exist if packaging worked.
 *
 * `fs-ext-extra-prebuilt` is the interesting one. It is a native module that the
 * bundled PHP runtime requires for file locking, it ships prebuilt binaries, and
 * it is listed in `allowScripts` because it still runs an install script to pick
 * one. A binary that is missing or built against the wrong ABI surfaces here and
 * nowhere else: `npm ci` exits 0 and packaging succeeds regardless.
 *
 * Asserted on both platforms, deliberately. An earlier draft of this test
 * excluded Windows on the grounds that the Playground CLI guarded the import
 * with a `win32` check — that guard is gone, the dependency is no longer
 * optional, and the runtime now carries a Windows-specific file-lock path that
 * requires it. Excluding Windows today would skip the one failure this
 * assertion exists to catch, on the platform where it is most likely.
 *
 * `npm/package.json` is spelled as the subpath the app itself resolves, in
 * four places (`src/main.js`, `src/install-runner.js`, `src/script-runner.js`),
 * to find the bundled npm CLI it runs installs and build scripts with. A
 * contributor with no npm on the machine is the whole premise of this app, so
 * losing it from the payload breaks the first thing they do — and the
 * allow-list in `build.files` is now the single statement of what ships, which
 * makes this the place to prove it still does.
 */
const REQUIRED_MODULES = [ '@wp-playground/cli', 'fs-ext-extra-prebuilt', 'dugite', 'npm/package.json' ];

/**
 * electron-builder names the output directory after the platform *and* arch, so
 * the path differs between a CI runner and a contributor's laptop:
 * macos-latest is arm64 (`dist/mac-arm64`), an Intel Mac is `dist/mac`.
 */
function findPackagedBinary() {
	if ( ! fs.existsSync( DIST ) ) {
		throw new Error( `No ${ DIST } directory. Run \`npm run pack:dir\` first — see TESTING.md.` );
	}

	if ( process.platform === 'darwin' ) {
		const macDirs = fs.readdirSync( DIST ).filter( ( d ) => d === 'mac' || d.startsWith( 'mac-' ) );
		for ( const dir of macDirs ) {
			const appDir = path.join( DIST, dir );
			const app = fs.readdirSync( appDir ).find( ( d ) => d.endsWith( '.app' ) );
			if ( ! app ) continue;
			const macOsDir = path.join( appDir, app, 'Contents', 'MacOS' );
			const [ binary ] = fs.readdirSync( macOsDir );
			if ( binary ) return path.join( macOsDir, binary );
		}
		throw new Error( `No packaged .app under ${ DIST }. Looked in: ${ macDirs.join( ', ' ) || '(nothing)' }` );
	}

	if ( process.platform === 'win32' ) {
		const unpacked = path.join( DIST, 'win-unpacked' );
		if ( ! fs.existsSync( unpacked ) ) {
			throw new Error( `No ${ unpacked }. Run \`npm run pack:dir\` first — see TESTING.md.` );
		}
		const exe = fs.readdirSync( unpacked ).find( ( f ) => f.endsWith( '.exe' ) );
		if ( ! exe ) throw new Error( `No .exe in ${ unpacked }.` );
		return path.join( unpacked, exe );
	}

	throw new Error( `This smoke test only covers macOS and Windows, not ${ process.platform }.` );
}

let electronApp;
let firstWindow;

test.beforeAll( async () => {
	electronApp = await electron.launch( { executablePath: findPackagedBinary() } );
	firstWindow = await electronApp.firstWindow();
} );

test.afterAll( async () => {
	if ( ! electronApp ) return;

	// Grab the handle before closing — `process()` throws once the connection to
	// the app is gone.
	const proc = electronApp.process();

	// `close()` is known to hang on Windows when the app keeps child processes
	// alive, which this one does. Never let teardown wedge the run.
	await Promise.race( [
		electronApp.close().catch( () => {} ),
		new Promise( ( resolve ) => setTimeout( resolve, 5_000 ) ),
	] );

	if ( proc && proc.exitCode === null ) proc.kill();
} );

test( 'the packaged app boots and paints its first window', async () => {
	// Deliberately not asserting "no uncaught renderer errors": index.html installs
	// its own error handlers, and a `pageerror` listener attaches too late to be
	// reliable. A painted window covers the same failure class positively.
	await expect( firstWindow ).toHaveTitle( 'WordPress Contributor Toolkit' );

	// #root is in the static HTML, so its presence proves nothing — its children do.
	await expect( firstWindow.locator( '#root > *' ) ).not.toHaveCount( 0 );
	// `exact` matters: "WordPress Core" is also a substring of button labels and
	// step descriptions further down the page.
	await expect( firstWindow.getByText( 'WordPress Core', { exact: true } ) ).toBeVisible();
} );

test( 'the preload bridge exposes every expected key', async () => {
	const exposed = await firstWindow.evaluate( () =>
		( window.api ? Object.keys( window.api ) : [] ).sort()
	);

	expect( exposed ).toEqual( EXPECTED_API_KEYS );
} );

/**
 * The top-level entries `build.files` in package.json allows into the payload.
 *
 * `files` is a positive list since #399, so this is the same list read from
 * the other side: what the packer was told to take is what the artifact must
 * contain, no more and no less. It was an exclusion list before, and the cost
 * of that shape was #390 (a signing key swept into every macOS artifact) and
 * #387 (Playwright traces and a nested VitePress `dist/` shipping from
 * whichever machine built last). Neither had to be predicted by name to be
 * caught here: anything not on this list fails the assertion.
 *
 * Adding an entry means adding it to package.json *and* here, deliberately.
 * That is the point — widening what ships is a visible decision, not a
 * directory that ships itself. The two lists are held together by the drift
 * test below, so an edit to one and not the other fails without needing an
 * artifact that demonstrates it.
 *
 * `local-playground-web` is optional: src/main.js serves it when present, it
 * is not in the repository, and the canary asserts nothing about it beyond
 * "allowed if it turns up".
 */
const REQUIRED_TOP_LEVEL_ENTRIES = [ 'node_modules', 'package.json', 'src' ];
const OPTIONAL_TOP_LEVEL_ENTRIES = [ 'local-playground-web' ];

function unexpectedEntries( entries ) {
	const allowed = new Set( [ ...REQUIRED_TOP_LEVEL_ENTRIES, ...OPTIONAL_TOP_LEVEL_ENTRIES ] );
	return entries.filter( ( name ) => ! allowed.has( name ) );
}

/**
 * The top-level entry each positive `build.files` pattern lets in.
 *
 * `node_modules` never appears in the list: electron-builder collects
 * production dependencies itself and applies only the `!` patterns to them, so
 * it is added here to make the two sides comparable.
 */
function allowedByPackageJson() {
	const { build } = require( path.join( REPO_ROOT, 'package.json' ) );
	const fromPatterns = build.files
		.filter( ( pattern ) => ! pattern.startsWith( '!' ) )
		.map( ( pattern ) => pattern.split( '/' )[ 0 ] );

	return [ ...new Set( [ 'node_modules', ...fromPatterns ] ) ].sort();
}

function resourcesDirOf( binary ) {
	return process.platform === 'darwin'
		? path.join( binary, '..', '..', 'Resources' ) // Contents/MacOS/<binary> -> Contents/Resources
		: path.join( path.dirname( binary ), 'resources' );
}

test( 'the allow-list in this file still matches build.files', () => {
	// Closes the direction the payload assertions cannot see. They catch an entry
	// that ships and should not; this catches the lists themselves drifting apart
	// — a pattern removed from package.json that the test still expects, or a
	// pattern added there that nobody mirrored here. The literal lists above stay
	// the thing a human edits, deliberately: this only asserts they agree.
	expect( [ ...REQUIRED_TOP_LEVEL_ENTRIES, ...OPTIONAL_TOP_LEVEL_ENTRIES ].sort() )
		.toEqual( allowedByPackageJson() );
} );

test( 'app.asar carries exactly the allow-listed top-level entries', async () => {
	// Read through Electron's asar-aware fs, from inside the packaged main
	// process, so the listing is the archive's own root and not the directory
	// electron-builder packed it from.
	const entries = await electronApp.evaluate( ( { app } ) => {
		const nodeRequire = process.mainModule.require;
		const appFs = nodeRequire( 'node:fs' );

		return appFs.readdirSync( app.getAppPath() ).sort();
	} );

	expect( unexpectedEntries( entries ), 'entries in app.asar that build.files does not allow' ).toEqual( [] );
	for ( const required of REQUIRED_TOP_LEVEL_ENTRIES ) {
		expect( entries, `${ required } is missing from app.asar` ).toContain( required );
	}

	// The one negative pattern in the allow-list. `src/**/*` would otherwise
	// carry the un-bundled entry point into the archive beside the esbuild
	// output that replaces it, and a root listing cannot see one level down.
	const rendererEntries = await electronApp.evaluate( ( { app } ) => {
		const nodeRequire = process.mainModule.require;
		const appFs = nodeRequire( 'node:fs' );
		const appPath = nodeRequire( 'node:path' );

		return appFs.readdirSync( appPath.join( app.getAppPath(), 'src', 'renderer' ) ).sort();
	} );

	expect( rendererEntries, 'the esbuild sources are replaced by the bundle, not shipped beside it' )
		.not.toContain( 'index.jsx' );
	expect( rendererEntries, 'the renderer bundle is missing — was `npm run build:once` run before packaging?' )
		.toEqual( expect.arrayContaining( [ 'index.html', 'index.js', 'index.css' ] ) );
} );

/**
 * Every file `src/**\/*` puts in the archive, checked against the repository.
 *
 * The root assertion above cannot see one level down, and `src/**\/*` is
 * recursive: anything sitting under `src/` at build time ships. Enumerating the
 * runtime files by hand would rebuild the maintenance problem the allow-list
 * exists to remove — a list of eighty entries edited under time pressure is the
 * exclusion list again, wearing a different sign. So the expected set is derived
 * from Git instead, and moves with the repository on its own:
 *
 *   tracked under src/, minus the esbuild entry point the bundle replaces,
 *   plus the two build outputs that replace it.
 *
 * A credential, a scratch file, a coverage report or a stray build artefact
 * written anywhere under `src/` is untracked, so it is not in the expected set,
 * so it fails here — by name, without anyone having predicted it.
 */
test( 'app.asar carries exactly the repository files src/**/* allows', async () => {
	const tracked = execFileSync( 'git', [ 'ls-files', 'src' ], { cwd: REPO_ROOT, encoding: 'utf8' } )
		.split( '\n' )
		.filter( Boolean )
		.map( ( file ) => file.replace( /\\/g, '/' ) );

	// The esbuild entry point is excluded by `build.files`; its outputs are
	// gitignored, because they are built rather than committed (#120).
	const expected = [
		...tracked.filter( ( file ) => file !== 'src/renderer/index.jsx' ),
		'src/renderer/index.js',
		'src/renderer/index.css',
	].sort();

	const shipped = await electronApp.evaluate( ( { app } ) => {
		const nodeRequire = process.mainModule.require;
		const appFs = nodeRequire( 'node:fs' );
		const appPath = nodeRequire( 'node:path' );
		const root = app.getAppPath();

		const walk = ( dir ) => appFs.readdirSync( dir, { withFileTypes: true } ).flatMap( ( entry ) => {
			const full = appPath.join( dir, entry.name );
			return entry.isDirectory() ? walk( full ) : [ appPath.relative( root, full ).split( appPath.sep ).join( '/' ) ];
		} );

		return walk( appPath.join( root, 'src' ) ).sort();
	} );

	expect( shipped ).toEqual( expected );
} );

test( 'app.asar.unpacked carries only allow-listed top-level entries', () => {
	// The unpacked tree is what `asarUnpack` and the native-module unpack pull
	// back out of the archive, so it can only ever hold a subset of the same
	// list. Plain Node fs: this side is on disk. `node_modules` is required
	// because the bundled Git lives there and the spawn test below needs it.
	const unpackedRoot = path.join( resourcesDirOf( findPackagedBinary() ), 'app.asar.unpacked' );
	expect( fs.existsSync( unpackedRoot ), `${ unpackedRoot } is missing` ).toBe( true );

	const entries = fs.readdirSync( unpackedRoot ).sort();

	expect( unexpectedEntries( entries ), 'entries in app.asar.unpacked that build.files does not allow' ).toEqual( [] );
	expect( entries ).toContain( 'node_modules' );
} );

test( 'the packaged payload has no .codesigning directory outside app.asar', () => {
	// The allow-list above already rules the directory out of app.asar's root and
	// out of app.asar.unpacked's. This walk runs on plain Node fs, which is not
	// asar-aware, over the whole payload, so it also covers the places neither
	// listing reaches: extra resources or files, and framework helpers. The key
	// is the one thing worth looking for by name (#390).
	const binary = findPackagedBinary();
	const packagedRoot = process.platform === 'darwin'
		? path.join( binary, '..', '..', '..' ) // Contents/MacOS/<binary> -> the .app bundle
		: path.dirname( binary ); // win-unpacked/<exe> -> win-unpacked

	const offenders = [];
	const walk = ( dir ) => {
		for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {
			if ( entry.name === '.codesigning' ) {
				offenders.push( path.join( dir, entry.name ) );
			} else if ( entry.isDirectory() ) {
				walk( path.join( dir, entry.name ) );
			}
		}
	};
	walk( packagedRoot );

	expect( offenders ).toEqual( [] );
} );

for ( const moduleName of REQUIRED_MODULES ) {
	test( `the packaged app can resolve ${ moduleName }`, async () => {
		const resolved = await electronApp.evaluate( ( { app }, name ) => {
			// The `require` in scope here carries no `.resolve` — only a per-module
			// require wrapper does. Build one anchored at the app's own package.json,
			// inside app.asar, so resolution happens exactly where src/main.js would
			// do it.
			//
			// Anchored there rather than at `process.mainModule.filename`, which is
			// what an earlier draft used: Electron does not keep that pointed at the
			// entry script, and partway through a run it reads back as the bare
			// string 'electron'. The test then fails on the *first* module it checks
			// and passes when run alone — a packaging test going red for a reason
			// that has nothing to do with packaging, which is the worst kind.
			const nodeRequire = process.mainModule ? process.mainModule.require : require;
			const { createRequire } = nodeRequire( 'module' );
			const { join } = nodeRequire( 'path' );
			const req = createRequire( join( app.getAppPath(), 'package.json' ) );
			try {
				return { ok: true, path: req.resolve( name ), appPath: app.getAppPath() };
			} catch ( error ) {
				return { ok: false, error: String( error && error.message ), appPath: app.getAppPath() };
			}
		}, moduleName );

		expect( resolved, `${ moduleName } failed to resolve from ${ resolved.appPath }: ${ resolved.error }` )
			.toHaveProperty( 'ok', true );
		expect( resolved.path ).toBeTruthy();
	} );
}

/**
 * The bundled Git (#383) is the first binary this app executes out of its own
 * bundle, and the first `asarUnpack` rule in package.json exists for it. Both
 * can only go wrong here: `npm ci` and packaging exit 0 whether or not the
 * tree was unpacked, kept its exec bits, or kept the helpers `git` shells out
 * to. Resolved through src/git-binary.cjs inside the packaged main process,
 * exactly as a caller will once one exists. Offline, and it writes nothing.
 */
/**
 * The native file-lock module, loaded for real.
 *
 * The resolve loop above proves the package is reachable; it does not load
 * the binary. This does, through the same `require` the PHP runtime uses.
 * The module tries its prebuilt binaries first and, when none matches the
 * running Electron, falls back to `build/Release/fs_ext.node` — the one file
 * `electron-builder install-app-deps` compiles on the build machine. Both
 * paths end here: if the fallback went missing, or was built against the
 * wrong ABI, `flockSync` is not a function and nothing else in this suite
 * would have noticed.
 */
test( 'the packaged app can load the native file-lock module', async () => {
	const result = await electronApp.evaluate( ( { app } ) => {
		const nodeRequire = process.mainModule ? process.mainModule.require : require;
		const { createRequire } = nodeRequire( 'module' );
		const { join } = nodeRequire( 'path' );
		const req = createRequire( join( app.getAppPath(), 'package.json' ) );
		try {
			const fsExt = req( 'fs-ext-extra-prebuilt' );
			return {
				ok: typeof fsExt.flockSync === 'function',
				source: typeof fsExt.getNativeModuleSource === 'function' ? fsExt.getNativeModuleSource() : 'unknown',
				electron: process.versions.electron,
			};
		} catch ( error ) {
			return { ok: false, error: String( error && error.message ) };
		}
	} );

	expect( result, `native module did not load under Electron ${ result.electron }: ${ result.error }` )
		.toHaveProperty( 'ok', true );
	expect( [ 'prebuilt', 'local' ] ).toContain( result.source );
} );

/**
 * The native module's build directory ships the binary and nothing else.
 *
 * On Windows, `install-app-deps` leaves MSVC's whole working set beside the
 * `.node` it produced — `.iobj`, `.ipdb`, `.lib`, `.exp`, the `.vcxproj`
 * pair and a tree of `.tlog` logs under `obj/` — and electron-builder's
 * default excludes miss every one of them by an extension (`obj` is not
 * `iobj`, `csproj` is not `vcxproj`). Three `!` rules in package.json trim
 * them; this is where a rule that stops matching, or one that overreaches
 * into the binary itself, shows up. macOS leaves only the binary behind, so
 * the assertion is the same on both platforms and only Windows can fail it.
 */
test( 'the native module build directory carries only its binary', () => {
	const release = path.join(
		resourcesDirOf( findPackagedBinary() ),
		'app.asar.unpacked', 'node_modules', 'fs-ext-extra-prebuilt', 'build', 'Release'
	);
	expect( fs.existsSync( release ), `${ release } is missing` ).toBe( true );

	expect( fs.readdirSync( release ).sort() ).toEqual( [ 'fs_ext.node' ] );
} );

test( 'the packaged app can spawn the bundled Git', async () => {
	const result = await electronApp.evaluate( ( { app } ) => {
		const nodeRequire = process.mainModule ? process.mainModule.require : require;
		const { createRequire } = nodeRequire( 'module' );
		const { join } = nodeRequire( 'path' );
		const appFs = nodeRequire( 'fs' );
		const { spawnSync } = nodeRequire( 'child_process' );
		const req = createRequire( join( app.getAppPath(), 'package.json' ) );
		const { resolveGitBinary, buildGitEnv, BASE_ARGS, SPAWN_OPTIONS } = req( './src/git-binary.cjs' );

		const binary = resolveGitBinary();
		const env = buildGitEnv();
		const run = ( args ) => {
			const r = spawnSync( binary, [ ...BASE_ARGS, ...args ], { ...SPAWN_OPTIONS, env, encoding: 'utf8' } );
			return {
				status: r.status,
				stdout: ( r.stdout || '' ).trim(),
				stderr: ( r.stderr || '' ).trim(),
				error: r.error ? String( r.error.message ) : null,
			};
		};
		const version = run( [ '--version' ] );
		const execPath = run( [ '--exec-path' ] );

		return {
			binary,
			binaryExists: appFs.existsSync( binary ),
			version,
			execPath,
			execPathExists: execPath.status === 0 && appFs.existsSync( execPath.stdout ),
		};
	} );

	// A path still inside app.asar means the unpack rule did not apply, and
	// the binary would fail to spawn for a reason unrelated to Git.
	expect( result.binary, 'resolved into app.asar rather than app.asar.unpacked' ).toContain( 'app.asar.unpacked' );
	expect( result.binaryExists, `${ result.binary } is not on disk` ).toBe( true );
	expect( result.version, JSON.stringify( result.version ) ).toHaveProperty( 'status', 0 );
	expect( result.version.stdout ).toMatch( /^git version 2\.53\.0(?:$|[.\s])/ );
	expect( result.execPathExists, `exec path ${ result.execPath.stdout } is missing` ).toBe( true );
} );

test( 'the packaged Git tree carries neither the credential manager nor git-lfs', () => {
	// The trim in package.json's `files` removes ~120 MB the app cannot reach:
	// every fetch it makes is anonymous over public HTTPS. `files` filters
	// what goes into the asar and, through the unpack rule, what comes back
	// out — so this is where a rewritten glob that stopped matching shows up.
	// Plain Node fs, rooted at the unpacked tree, on both platforms.
	const gitRoot = path.join( resourcesDirOf( findPackagedBinary() ), 'app.asar.unpacked', 'node_modules', 'dugite', 'git' );
	expect( fs.existsSync( gitRoot ), `${ gitRoot } is missing` ).toBe( true );

	const offenders = [];
	const walk = ( dir ) => {
		for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {
			const full = path.join( dir, entry.name );
			if ( /^git-credential-manager|^git-credential-helper-selector|^git-lfs|^createdump|^Avalonia|SkiaSharp|HarfBuzzSharp|^gcmcore|^msalruntime|^av_libglesv2|^(Microsoft|System|Atlassian|GitHub|GitLab|MicroCom)\..*\.dll$/.test( entry.name ) ) {
				offenders.push( full );
			} else if ( entry.isDirectory() ) {
				walk( full );
			}
		}
	};
	walk( gitRoot );

	expect( offenders ).toEqual( [] );
} );
