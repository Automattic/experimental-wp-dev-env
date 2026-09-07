// What the app says about a site an earlier version of it created (#385).
//
// The app's Git engine changed: sites are now partial clones made by the
// bundled Git, and the shallow clones the old engine made are refused on every
// write. Main returns the one-line refusal and the card shows the notice, and
// both read from here so the two never drift. Pure and dependency-free for the
// same reason as ticket-trunk-notice.cjs: the renderer bundle imports it,
// `node --test` requires it, and main requires it too.
'use strict';

const LEGACY_SITE_ERROR = 'This site was created by an earlier version of the app and cannot be changed by this one. '
	+ 'Create a new site to keep working; you can still export a patch of what is here, and delete this site.';

/**
 * The card's notice for a legacy site, or null for every other site.
 *
 * @param {Object}  [root0]
 * @param {boolean} [root0.legacy] What `site:status` reported.
 * @return {{title: string, body: string}|null}
 */
function legacySiteNotice({ legacy = false } = {}) {
	if (!legacy) return null;
	return {
		title: 'This site was created by an earlier version of the app.',
		body: 'The app now runs on a different Git engine, so linking tickets, applying patches, discarding changes and updating trunk are refused here. '
			+ 'Export your work as a patch, create a new site, apply the patch there, then delete this one.'
	};
}

module.exports = { LEGACY_SITE_ERROR, legacySiteNotice };
