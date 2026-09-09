'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
	createProgressThrottle,
	mapCheckoutPhase,
	describeSwitchProgress
} = require('../../src/switch-progress.cjs');

// A clock the tests move by hand: throttling asserted without timers, so none
// of this can go flaky on a loaded CI runner.
function harness(options = {}) {
	let clock = 1000;
	const emitted = [];
	const throttle = createProgressThrottle({
		onEmit: (p) => emitted.push(p),
		now: () => clock,
		...options
	});
	return { emitted, throttle, advance: (ms) => { clock += ms; } };
}

// --- createProgressThrottle ------------------------------------------------

// A `git.checkout` of wordpress-develop calls onProgress thousands of times in
// well under a second. Sending each one would flood IPC with frames nobody can
// read, so within a stage they are coalesced.
test('throttle: repeats inside the interval are coalesced (issue #173)', () => {
	const { emitted, throttle, advance } = harness({ intervalMs: 100 });

	throttle.emit({ stage: 'apply', loaded: 1, total: 500 });
	throttle.emit({ stage: 'apply', loaded: 2, total: 500 });
	advance(30);
	throttle.emit({ stage: 'apply', loaded: 3, total: 500 });

	assert.deepStrictEqual(emitted.map((p) => p.loaded), [1]);
});

test('throttle: once the interval has passed the next event goes out (issue #173)', () => {
	const { emitted, throttle, advance } = harness({ intervalMs: 100 });

	throttle.emit({ stage: 'apply', loaded: 1, total: 500 });
	advance(100);
	throttle.emit({ stage: 'apply', loaded: 2, total: 500 });

	assert.deepStrictEqual(emitted.map((p) => p.loaded), [1, 2]);
});

// A stage is what the sentence on screen is made of, so it can never wait for
// the interval — the whole point is that the panel keeps saying what is
// happening.
test('throttle: a new stage is emitted immediately, interval or not (issue #173)', () => {
	const { emitted, throttle } = harness({ intervalMs: 100 });

	throttle.emit({ stage: 'scan', loaded: 1 });
	throttle.emit({ stage: 'commit', loaded: 1 });

	assert.deepStrictEqual(emitted.map((p) => p.stage), ['scan', 'commit']);
});

// The 87% rule: a progress line that stops partway and jumps to done is worse
// than no line at all, because it reads as a hang at exactly the moment the
// user is deciding whether to force-quit. The last suppressed event of a stage
// has to arrive before the next stage starts.
test('throttle: the last suppressed event of a stage survives into the next one (issue #173)', () => {
	const { emitted, throttle } = harness({ intervalMs: 100 });

	throttle.emit({ stage: 'apply', loaded: 1, total: 500 });
	throttle.emit({ stage: 'apply', loaded: 250, total: 500 });
	throttle.emit({ stage: 'apply', loaded: 500, total: 500 });
	throttle.emit({ stage: 'done' });

	assert.deepStrictEqual(
		emitted.map((p) => `${p.stage}:${p.loaded ?? ''}`),
		['apply:1', 'apply:500', 'done:'],
		'the 500/500 frame is what makes the line reach the end'
	);
});

test('throttle: flush emits what is pending, and only once (issue #173)', () => {
	const { emitted, throttle } = harness({ intervalMs: 100 });

	throttle.emit({ stage: 'apply', loaded: 1, total: 500 });
	throttle.emit({ stage: 'apply', loaded: 2, total: 500 });
	throttle.flush();
	throttle.flush();

	assert.deepStrictEqual(emitted.map((p) => p.loaded), [1, 2]);
});

test('throttle: flush with nothing pending emits nothing (issue #173)', () => {
	const { emitted, throttle } = harness({ intervalMs: 100 });

	throttle.flush();

	assert.deepStrictEqual(emitted, []);
});

// emit runs inside a stderr listener, once per progress line Git prints. A
// thenable would put a microtask between every one of those events for nobody
// to await, so the callback is synchronous by contract, not by accident.
test('throttle: emit is synchronous and returns nothing to await (issue #173)', () => {
	const { throttle } = harness();

	const result = throttle.emit({ stage: 'scan', loaded: 1 });

	assert.strictEqual(result, undefined);
	assert.strictEqual(typeof (result && result.then), 'undefined');
});

// The trunk update writes into an append-only terminal, where one line per
// stage is informative and fifteen is spam. Same module, no second throttle.
test('throttle: an infinite interval reduces a switch to one line per stage (issue #173)', () => {
	const { emitted, throttle } = harness({ intervalMs: Infinity });

	throttle.emit({ stage: 'scan', loaded: 1 });
	throttle.emit({ stage: 'scan', loaded: 2 });
	throttle.emit({ stage: 'apply', loaded: 1, total: 9 });
	throttle.emit({ stage: 'apply', loaded: 5, total: 9 });
	throttle.flush();

	assert.deepStrictEqual(
		emitted.map((p) => `${p.stage}:${p.loaded}`),
		['scan:1', 'scan:2', 'apply:1', 'apply:5'],
		'stage changes and the flush get through; the middle of a stage does not'
	);
});

// --- mapCheckoutPhase ------------------------------------------------------

test('mapCheckoutPhase: the phase checkout actually emits, as git-progress.cjs lowercases it (issue #173)', () => {
	assert.deepStrictEqual(
		mapCheckoutPhase({ phase: 'updating files', percent: 7, loaded: 3, total: 40 }),
		{ stage: 'apply', loaded: 3, total: 40 }
	);
	assert.deepStrictEqual(
		mapCheckoutPhase({ phase: 'checking out files', loaded: 3, total: 40 }),
		{ stage: 'apply', loaded: 3, total: 40 }
	);
});

// Git owns these strings, not us. An upgrade that renames or adds one must
// degrade to a generic stage rather than an undefined that renders as
// "undefined" in front of a contributor.
test('mapCheckoutPhase: an unknown phase still produces a usable stage (issue #173)', () => {
	const mapped = mapCheckoutPhase({ phase: 'Reticulating splines', loaded: 1, total: 2 });

	assert.strictEqual(typeof mapped.stage, 'string');
	assert.ok(mapped.stage.length > 0);
	assert.strictEqual(typeof describeSwitchProgress(mapped), 'string');
});

// --- describeSwitchProgress ------------------------------------------------

// The sentence this whole issue exists for: someone who force-quits here loses
// work that is not committed anywhere yet, so the panel has to say that this is
// what it is doing, and for which ticket.
test('describeSwitchProgress: parking names the ticket being left (issue #173)', () => {
	const line = describeSwitchProgress({ stage: 'scan', from: 'ticket/59234', to: 'ticket/61002' });

	assert.match(line, /59234/);
	assert.doesNotMatch(line, /ticket\//, 'a branch ref is our word for it, not the contributor\'s');
});

test('describeSwitchProgress: leaving trunk talks about the work, not a branch name (issue #173)', () => {
	const line = describeSwitchProgress({ stage: 'scan', from: 'trunk', to: 'ticket/61002' });

	assert.strictEqual(typeof line, 'string');
	assert.doesNotMatch(line, /trunk/);
});

// A stage without a `total` (the old engine's analyze phase reported a running
// count and nothing else) has no honest percentage, and a made-up one is worse
// than none.
test('describeSwitchProgress: a percentage only when there is a total (issue #173)', () => {
	assert.doesNotMatch(describeSwitchProgress({ stage: 'analyze', loaded: 900 }), /%/);
	assert.doesNotMatch(describeSwitchProgress({ stage: 'apply', loaded: 5, total: 0 }), /%/);
	assert.match(describeSwitchProgress({ stage: 'apply', loaded: 25, total: 100 }), /25%/);
});

test('describeSwitchProgress: every stage says something, including one we do not know (issue #173)', () => {
	for (const stage of ['scan', 'stage', 'commit', 'analyze', 'apply', 'done', 'something-new']) {
		const line = describeSwitchProgress({ stage, loaded: 1, total: 2, from: 'trunk', to: 'ticket/1' });
		assert.strictEqual(typeof line, 'string', stage);
		assert.ok(line.length > 0, stage);
		assert.doesNotMatch(line, /undefined|NaN/, stage);
	}
});
