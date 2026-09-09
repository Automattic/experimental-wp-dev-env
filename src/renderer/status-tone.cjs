// Which tone a status word wears, for every status in the app.
//
// The window shows status in two places and, until now, in two visual languages:
// the site header drew a rounded pill with its own green/amber pair, while the
// setup checklist wrote COMPLETED, IN PROGRESS and LOCKED as bare uppercase text
// a few hundred pixels below it. Same idea, two shapes, so neither read as the
// canonical way this app says "state".
//
// This is the single map behind <StatusBadge>. It is a lookup, not a component,
// so it can be unit-tested — the repo's split is pure logic in .cjs with
// node:test, presentational JSX untested (see pr-state.cjs, setup-steps.cjs).
//
// Note that the tones are semantic, not colours: a caller asks for a status and
// gets a tone name, and tokens.css owns what that tone looks like. Adding a
// status here should never mean picking a hex value.
'use strict';

// Every status the window can show, mapped to a tone in tokens.css.
//
// `pending` and `locked` share the neutral tone deliberately. Both mean "not
// yet", and colouring either one amber would say something failed. What
// separates them for a reader is the word and the step's own affordance — a
// locked step's button is disabled — not the badge's colour.
//
// The checklist statuses carry no label here on purpose. `setupStepLabel` in
// setup-steps.cjs already owns those words, and it makes a distinction this map
// cannot see: the same `current` status reads "Ready" before its action runs and
// "In progress" while it is running (#257). Repeating the words here would be a
// second source of truth that is already wrong. Callers pass the label as the
// badge's children; this map only says what colour it wears.
const STATUS_TONES = {
	// Site states, shown in the header. Nothing else owns these words.
	initialized: { label: 'Initialized', tone: 'success' },
	uninitialized: { label: 'Uninitialized', tone: 'warning' },

	// Setup checklist step states, from computeSetupStepState in setup-steps.cjs.
	complete: { label: '', tone: 'success' },
	current: { label: '', tone: 'info' },
	pending: { label: '', tone: 'neutral' },
	locked: { label: '', tone: 'neutral' }
};

const NEUTRAL = { label: '', tone: 'neutral' };

/**
 * The label and tone for one status.
 *
 * An unrecognised status falls back to the neutral tone rather than throwing or
 * picking a colour: a status this map has not been taught about is precisely the
 * case where the app should not assert that something succeeded or failed. The
 * returned label is empty so the caller's own text is used verbatim.
 *
 * @param {string} status
 * @return {{label: string, tone: string}}
 */
function statusTone( status ) {
	const key = typeof status === 'string' ? status.toLowerCase() : '';
	// `Object.hasOwn`, not a plain lookup: a bare `STATUS_TONES[key]` reads
	// through Object.prototype, so `statusTone('constructor')` returned the
	// Object constructor and `statusTone('__proto__')` returned the prototype
	// itself. Both destructure to an undefined tone, which renders a badge
	// classed `wpct-badge--undefined` — unstyled, and carrying no word either.
	// Only already-lowercase prototype keys could reach it, since the lookup
	// lowercases first, but the guarantee this function documents has to hold
	// for every string rather than for most of them.
	return Object.hasOwn( STATUS_TONES, key ) ? STATUS_TONES[ key ] : NEUTRAL;
}

module.exports = { STATUS_TONES, statusTone };
