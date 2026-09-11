'use strict';

/**
 * Whether the Terminal is occupied, and so cannot take a prefilled command.
 *
 * The hints offer to type `npm run build` / `npm install` at the prompt, which
 * is only honest while the prompt is free. Getting this predicate wrong in the
 * permissive direction is what makes them dead controls: the click is refused
 * by the prompt's own guard, so a link that looks enabled does nothing at all.
 *
 * Two independent families of flag have to be consulted, which is the whole
 * reason this is not a one-liner at the call site:
 *
 * - `terminalRunning` mirrors the terminal state machine's own `running` flag.
 *   That flag lives in a ref, so React never re-renders on it; the renderer
 *   keeps a state copy in step with every write. It is the only thing that
 *   covers a command the contributor typed themselves — and `npm run watch`,
 *   `dev` and `grunt` never exit, so a gap here persists for the session.
 * - `installing` / `building` are set by the setup checklist's buttons, which
 *   stream into the terminal without ever claiming the prompt. Nothing in
 *   `terminalRunning` sees them.
 *
 * The remaining flags name flows that do set `terminalRunning` today. They are
 * listed anyway rather than trusted transitively: a future path that sets one
 * without claiming the prompt would otherwise reopen exactly the hole this
 * module exists to close.
 *
 * @param {Object}  flags
 * @param {boolean} [flags.terminalRunning] A command typed at the prompt, or any
 *                                          flow that claimed it, is running.
 * @param {boolean} [flags.installing]      The checklist's npm install is running.
 * @param {boolean} [flags.building]        The checklist's npm run build is running.
 * @param {boolean} [flags.starting]        The dev server is starting.
 * @param {boolean} [flags.running]         The dev server and its watcher are up.
 * @param {boolean} [flags.isUpdating]      The trunk-update chain owns the terminal.
 * @param {boolean} [flags.isApplying]      The apply-patch chain owns the terminal.
 * @return {boolean} True when the prompt is not free.
 */
function computeTerminalBusy(flags = {}) {
	return Boolean(
		flags.terminalRunning
		|| flags.installing
		|| flags.building
		|| flags.starting
		|| flags.running
		|| flags.isUpdating
		|| flags.isApplying
	);
}

module.exports = { computeTerminalBusy };
