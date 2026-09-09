/*
 * A section of the page: a heading, the actions that belong to that heading, and
 * the content below both.
 *
 * The complaint this answers is that buttons and links float in space. A control
 * has to sit in a region, and the region has to be the thing it acts on —
 * otherwise the eye cannot tell what "Refresh" refreshes. <Section> is the outer
 * half of that: it owns a heading row, and anything passed as `actions` is
 * anchored to that row rather than left to drift near it.
 *
 * The styling lives in ../styles/tokens.css. These components are wrappers over
 * class names, not style objects, so one token edit lands everywhere at once.
 */

import React from 'react';

/**
 * @param {Object}          props
 * @param {React.ReactNode} [props.title]          Heading text. Rendered as `level`.
 * @param {React.ReactNode} [props.titleAdornment] A control that acts on the title itself.
 * @param {React.ReactNode} [props.meta]           Supporting lines under the heading.
 * @param {React.ReactNode} [props.actions]        Controls that belong to the heading.
 * @param {number}          [props.level]          Heading level, 1–6. Defaults to 2.
 * @param {boolean}         [props.plain]          Drop the card chrome, keep the rhythm.
 * @param {string}          [props.className]      Extra classes.
 * @param {React.ReactNode} [props.children]       The section's content.
 */
export function Section( {
	title,
	titleAdornment,
	meta,
	actions,
	level = 2,
	plain = false,
	className = '',
	children,
	...rest
} ) {
	// Heading level is a prop because the site header is the page's h1 while
	// every other section sits under it. Nesting is a document-structure
	// question, and hard-coding h2 here would have made the page unnavigable by
	// heading for anyone using a screen reader.
	const Heading = `h${ Math.min( Math.max( level, 1 ), 6 ) }`;
	const classes = [ 'wpct-section', plain ? 'wpct-section--plain' : '', className ]
		.filter( Boolean )
		.join( ' ' );

	return (
		<section className={ classes } { ...rest }>
			{ title || meta || actions ? (
				<div className="wpct-section__header">
					<div className="wpct-section__heading">
						{ title ? (
							// The adornment sits beside the heading rather than
							// inside it: a rename pencil acts on the title, but
							// it is not part of the document's outline, and a
							// screen reader announcing "Rename site" as heading
							// text would be reading furniture as content.
							<div className="wpct-section__title-row">
								<Heading className="wpct-section__title">{ title }</Heading>
								{ titleAdornment }
							</div>
						) : null }
						{ meta }
					</div>
					{ actions ? (
						<div className="wpct-action-row">{ actions }</div>
					) : null }
				</div>
			) : null }
			{ children ? (
				<div className="wpct-section__body">{ children }</div>
			) : null }
		</section>
	);
}

export default Section;
