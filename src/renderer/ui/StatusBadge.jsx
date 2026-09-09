/*
 * One badge shape for every status the window shows.
 *
 * It replaces two things that meant the same and looked nothing alike: the
 * rounded pill in the site header (INITIALIZED / UNINITIALIZED) and the bare
 * uppercase words in the setup checklist (COMPLETED / IN PROGRESS / LOCKED).
 * Seeing both on one screen is a large part of why the app read as unconsidered.
 *
 * The colour never carries the meaning on its own — the word is always present,
 * the same rule pr-state.cjs is built on. A contributor who cannot separate green
 * from amber loses nothing here.
 *
 * The status-to-tone map is ../status-tone.cjs, unit-tested; this file is the
 * presentational half and follows the repo's convention of leaving that untested.
 */

import React from 'react';
import { statusTone } from '../status-tone.cjs';

/**
 * @param {Object}          props
 * @param {string}          props.status      A key from status-tone.cjs.
 * @param {React.ReactNode} [props.children]  Overrides the mapped label.
 * @param {string}          [props.className] Extra classes.
 */
export function StatusBadge( { status, children, className = '', ...rest } ) {
	const { label, tone } = statusTone( status );
	const classes = [ 'wpct-badge', `wpct-badge--${ tone }`, className ]
		.filter( Boolean )
		.join( ' ' );

	// An unrecognised status resolves to an empty label, so a caller that passes
	// its own text still renders — the badge degrades to neutral chrome around
	// whatever it was given rather than disappearing.
	return (
		<span className={ classes } { ...rest }>
			{ children || label }
		</span>
	);
}

export default StatusBadge;
