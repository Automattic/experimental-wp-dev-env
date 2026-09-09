/*
 * A bounded region for a group of controls.
 *
 * Wherever the app reads as unfinished, the cause is usually a button with no
 * region: "Start dev server" in bare whitespace, "Skip initialization wizard"
 * dangling off a card's bottom edge. <ActionRow> is the region. It owns the gap
 * between its buttons too, which is why the global `button { margin-right: 8px }`
 * in index.html can eventually go — spacing between controls is a property of the
 * group they are in, not of every button in the window.
 *
 * `divided` draws the rule above the row. The rule is structure, not decoration:
 * it means "a new group starts here", so it goes between two groups and never
 * above the first or below the last.
 */

import React from 'react';

/**
 * @param {Object}          props
 * @param {boolean}         [props.divided]   Draw a hairline above the row.
 * @param {boolean}         [props.end]       Align the controls to the right.
 * @param {string}          [props.className] Extra classes.
 * @param {React.ReactNode} props.children
 */
export function ActionRow( { divided = false, end = false, className = '', children, ...rest } ) {
	const classes = [
		'wpct-action-row',
		divided ? 'wpct-action-row--divided' : '',
		end ? 'wpct-action-row--end' : '',
		className
	]
		.filter( Boolean )
		.join( ' ' );

	return (
		<div className={ classes } { ...rest }>
			{ children }
		</div>
	);
}

export default ActionRow;
