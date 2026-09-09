'use strict';

/**
 * What a ticket switch is doing while it does it (issue #173).
 *
 * Switching tickets is a worktree scan and a full checkout — seconds of silence
 * on a real `wordpress-develop`, during which the window looks hung. The
 * natural responses are clicking again or force-quitting, and force-quitting
 * part-way through a checkout leaves the half-swapped worktree that
 * `withSwitchMarker` exists to recover from. This module is the vocabulary for
 * saying what is happening instead.
 *
 * Two jobs, kept together because they are two ends of one contract: the
 * throttle that decides which events are worth sending, and the sentence the
 * panel shows for one. Pure and dependency-free, so `node --test` drives it
 * directly while both the main process and the renderer bundle require it.
 */

// A checkout of ~1500 files calls back about 4400 times in 143ms. At 100ms
// between frames a switch produces a couple of dozen sends — enough for the
// line to move, few enough that the IPC channel stays a channel.
const DEFAULT_INTERVAL_MS = 100;

// Git's own phase names, lowercased by git-progress.cjs, which belong to it
// and not to us. Pinned here so a Git upgrade that renames one breaks a single
// lookup rather than leaking a foreign vocabulary into the UI. `Updating
// files` is what checkout has said since 2.x; the older name is kept in case
// a site's own hooks or filters ever surface it.
const CHECKOUT_PHASES = {
	'updating files': 'apply',
	'checking out files': 'apply'
};

/**
 * Coalesces a flood of progress events down to what is worth sending.
 *
 * A stage change always goes out immediately — the stage *is* the sentence on
 * screen, and making it wait for the interval is what produces a line that
 * describes the previous thing. Within a stage, events are held to one per
 * interval.
 *
 * The rule that matters most is the one that keeps a line from stopping at 87%
 * and jumping to done: whatever was suppressed last is flushed when the stage
 * changes, and again by `flush()` at the end. A progress line that freezes is
 * read as a hang, which is the exact failure this is meant to prevent.
 *
 * `emit` is deliberately synchronous and returns nothing: it is called from a
 * stderr listener for every progress line Git prints, and a promise here would
 * add a microtask between every one of those events for nobody to await.
 *
 * @param {Object}   options
 * @param {Function} options.onEmit       Called with each payload that survives.
 * @param {number}   [options.intervalMs] Minimum gap within a stage. `Infinity`
 *                                        reduces a switch to one event per
 *                                        stage, for an append-only log.
 * @param {Function} [options.now]        Clock, injected so tests need no timers.
 * @return {{emit: Function, flush: Function}} The emitter and its final flush.
 */
function createProgressThrottle({ onEmit, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now } = {}) {
	let lastStage = null;
	let lastAt = -Infinity;
	let pending = null;

	const send = (payload) => {
		pending = null;
		lastStage = payload.stage;
		lastAt = now();
		if (onEmit) onEmit(payload);
	};

	return {
		emit(payload) {
			if (!payload) return;
			if (payload.stage !== lastStage) {
				if (pending) send(pending);
				send(payload);
				return;
			}
			if (now() - lastAt >= intervalMs) {
				send(payload);
				return;
			}
			pending = payload;
		},
		flush() {
			if (pending) send(pending);
		}
	};
}

/**
 * One of Git's checkout progress events (git-progress.cjs), in this app's
 * vocabulary. Git reports one phase, with a total, once the files to write are
 * known; the `analyze` stage the old engine reported before that has no
 * counterpart and is simply never emitted now, which `describeSwitchProgress`
 * tolerates like any other absent stage.
 *
 * @param {{phase: string, loaded: number, total: number}} event
 * @return {{stage: string, loaded: number, total: ?number}} Our shape.
 */
function mapCheckoutPhase(event = {}) {
	return {
		stage: CHECKOUT_PHASES[event.phase] || 'apply',
		loaded: event.loaded,
		total: event.total
	};
}

/**
 * A ticket number from a branch ref, or null for trunk and anything else.
 *
 * @param {?string} ref
 */
function ticketOf(ref) {
	const match = /^ticket\/(\d+)$/.exec(String(ref || ''));
	return match ? match[1] : null;
}

/**
 * What the panel says for one progress event.
 *
 * The parking sentences name the ticket being left, which is the point of the
 * whole feature: they are what stops someone force-quitting during the seconds
 * when their edits are not committed anywhere yet. Branch refs never reach the
 * screen — a contributor knows `#59234`, not `ticket/59234`.
 *
 * @param {Object}  progress
 * @param {string}  progress.stage
 * @param {number}  [progress.loaded]
 * @param {number}  [progress.total]
 * @param {?string} [progress.from]   Branch being left.
 * @param {?string} [progress.to]     Branch being entered.
 * @return {string} A sentence, never empty, for any stage including a new one.
 */
function describeSwitchProgress({ stage, loaded, total, from, to } = {}) {
	const saving = () => {
		const leaving = ticketOf(from);
		return leaving ? `your work on #${leaving}` : 'your work';
	};
	const entering = () => {
		const id = ticketOf(to);
		return id ? ` for #${id}` : '';
	};

	switch (stage) {
		case 'scan':
			return `Saving ${saving()}…`;
		case 'stage':
			return `Saving ${saving()}… ${withCount(loaded, total)}`;
		case 'commit':
			return `Saving ${saving()}…`;
		case 'rebase':
			return `Moving ${saving()} onto the current trunk…`;
		case 'analyze':
			return 'Checking which files change…';
		case 'apply':
			return `Swapping files${entering()}… ${withCount(loaded, total)}`;
		case 'done':
			return ticketOf(to) ? `Ready to work on #${ticketOf(to)}` : 'Ready';
		default:
			// A stage this version does not know — a newer Git, or a caller
			// ahead of this module. Saying something true and vague beats
			// rendering nothing where a sentence was.
			return 'Working…';
	}
}

/**
 * The trailing "42%" or "1,200 files", or nothing when neither is knowable.
 *
 * @param {?number} loaded
 * @param {?number} total
 */
function withCount(loaded, total) {
	if (Number.isFinite(total) && total > 0 && Number.isFinite(loaded)) {
		return `${Math.min(100, Math.round((loaded / total) * 100))}%`;
	}
	if (Number.isFinite(loaded)) return `${loaded.toLocaleString()} files`;
	return '';
}

module.exports = {
	DEFAULT_INTERVAL_MS,
	createProgressThrottle,
	mapCheckoutPhase,
	describeSwitchProgress
};
