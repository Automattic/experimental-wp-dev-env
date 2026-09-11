// The deterministic half of PR review: everything a linter can decide without judgement.
//
// The judgement half — architecture, security, performance, cross-platform — lives in
// .github/instructions/code-review.instructions.md and is reviewed by an agent. Keeping
// the two apart is deliberate: style nits mixed into an agent's prompt bury its real
// findings.
//
// Built on @wordpress/eslint-plugin so this repo follows the same JS standards as
// wordpress-develop and gutenberg.
//
// Note on formatting: `configs.recommended` layers Prettier on top of
// `recommended-with-formatting`, but only when `prettier` is installed. It deliberately
// is not. Indentation here is mixed (tabs in src/*.js, four spaces in
// src/renderer/index.jsx and scripts/azure-sign.cjs), so enabling Prettier today would
// rewrite most of the tree and drown every real finding. .editorconfig steers new code;
// normalising the existing files is a separate job.

import globals from 'globals';
import wordpress from '@wordpress/eslint-plugin';

export default [
	{
		ignores: [
			// esbuild output. No longer committed (#120), but it sits next to its own source
			// in src/renderer/ after any build, so it still has to be ignored explicitly —
			// otherwise `eslint .` lints 55k lines of generated code on a developer machine
			// and nothing on a fresh CI checkout.
			'src/renderer/index.js',
			'build/',
			'dist/',
			'node_modules/',
			// Generated Playwright reports contain bundled JavaScript, not source.
			'playwright-report/',
			'test-results/',
			// VitePress build output and cache: generated code, same reasoning as
			// src/renderer/index.js above.
			'docs/.vitepress/dist/',
			'docs/.vitepress/cache/',
		],
	},

	...wordpress.configs.recommended,

	{
		languageOptions: {
			globals: globals.node,
		},
		settings: {
			react: { version: 'detect' },
		},
		rules: {
			// See the formatting note at the top. `prettier` is not a direct dependency,
			// but it arrives transitively under @wordpress/eslint-plugin and the preset
			// enables itself on mere presence — so switching it off has to be explicit.
			'prettier/prettier': 'off',

			// Ships in the same Prettier block, and is formatting too. The codebase
			// consistently writes single-line guards (`if (!url) return false;`); this
			// rule fires on 142 of them and says nothing about correctness.
			curly: 'off',

			// Electron and electron-builder are devDependencies by design: electron-builder
			// bundles them into the artifact rather than resolving them at runtime.
			'import/no-extraneous-dependencies': 'off',

			// The repo predates this config and documents intent in prose comments
			// rather than JSDoc blocks. Requiring them now would flag most of the tree
			// without making anything more correct.
			'jsdoc/require-param-description': 'off',
			'jsdoc/require-returns-description': 'off',
		},
	},

	{
		// Renderer: browser context, bundled by esbuild with the automatic JSX runtime,
		// so React needs no import to be in scope.
		files: [ 'src/renderer/**/*.{js,jsx,cjs}' ],
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
		rules: {
			'react/react-in-jsx-scope': 'off',
		},
	},

	{
		// The docs site is a nested npm package (docs/package.json) with its own
		// install. CI lints from the root, where `vitepress` was never installed, so
		// import/no-unresolved fires on an import that resolves perfectly well at the
		// only moment it runs — inside `npm run docs:build`. Everything else the rule
		// protects still applies to this file.
		files: [ 'docs/.vitepress/**/*.{js,mjs}' ],
		rules: {
			'import/no-unresolved': 'off',
		},
	},

	{
		files: [ 'tests/unit/**/*.{js,cjs,mjs}' ],
		languageOptions: {
			globals: { ...globals.node },
		},
	},

	{
		// End-to-end suite. Playwright's fixture API is `async ({ deps }, use) => {}`
		// — the test framework calls `use()` to hand the fixture to the test and
		// resumes afterwards for teardown. The React hooks rule sees a bare `use(...)`
		// and reads it as React's `use` hook called outside a component. There is no
		// React in this directory at all; the app under test is a separate process.
		files: [ 'tests/e2e/**/*.{js,cjs,mjs}' ],
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			'react-hooks/rules-of-hooks': 'off',
		},
	},

	{
		// Files whose stdout *is* their interface, so `no-console` is simply wrong
		// there. The runners are spawned as child processes (process.execPath +
		// ELECTRON_RUN_AS_NODE=1) and main.js reads their stdout/stderr back and
		// streams it to the renderer — deleting a console call would delete the
		// message. Everything under scripts/ is a CLI entry point that reports to
		// the terminal it was run from.
		//
		// Scoped to these files rather than switched off globally: in main.js,
		// preload.js and the renderer a stray console statement really is a
		// leftover, and the rule should keep catching it. scripts/ is a glob
		// because every file in there is an entry point; if a non-CLI helper ever
		// lands beside them, list the entry points instead.
		files: [
			'src/install-runner.js',
			'src/script-runner.js',
			'src/server-runner.js',
			'src/playground-web-runner.js',
			'scripts/**/*.cjs',
		],
		rules: {
			'no-console': 'off',
		},
	},
];
