'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeTerminalBusy } = require('../../src/renderer/terminal-hints.cjs');

test('an idle terminal is free, so the hint links stay clickable (issue #182)', () => {
	assert.strictEqual(computeTerminalBusy({}), false);
	assert.strictEqual(computeTerminalBusy(), false, 'no flags at all must not read as busy');
});

test('a command typed at the prompt makes the terminal busy (issue #182)', () => {
	// The regression this file exists for: the first version of the predicate
	// read only the checklist and chain flags, none of which move when the
	// contributor types a command themselves. `npm run watch` set the terminal
	// state machine's `running` flag and nothing else, so the hint links kept
	// rendering as enabled while the prompt refused every click — and watch
	// never exits, so it stayed that way for the whole session.
	assert.strictEqual(computeTerminalBusy({ terminalRunning: true }), true);
});

test('the checklist buttons make the terminal busy without claiming the prompt (issue #182)', () => {
	// runInstallWithTerminal / runBuildWithTerminal stream into the terminal but
	// never set its `running` flag, so these two flags are load-bearing rather
	// than redundant.
	assert.strictEqual(computeTerminalBusy({ installing: true }), true);
	assert.strictEqual(computeTerminalBusy({ building: true }), true);
});

test('a dev server and its watcher hold the terminal for the whole session', () => {
	assert.strictEqual(computeTerminalBusy({ starting: true }), true);
	assert.strictEqual(computeTerminalBusy({ running: true }), true);
});

test('the update and apply chains hold the terminal', () => {
	assert.strictEqual(computeTerminalBusy({ isUpdating: true }), true);
	assert.strictEqual(computeTerminalBusy({ isApplying: true }), true);
});

test('any one flag is enough — none of them cancels another out', () => {
	const flags = ['terminalRunning', 'installing', 'building', 'starting', 'running', 'isUpdating', 'isApplying'];
	for (const flag of flags) {
		const allOthersFalse = Object.fromEntries(flags.map((f) => [f, f === flag]));
		assert.strictEqual(computeTerminalBusy(allOthersFalse), true, `${flag} alone must read as busy`);
	}
});

test('the result is a boolean, not whichever flag happened to be truthy', () => {
	// The value is spread into a prop, so a leaked string or object would render.
	assert.strictEqual(computeTerminalBusy({ installing: 'yes' }), true);
	assert.strictEqual(computeTerminalBusy({ installing: undefined }), false);
});
