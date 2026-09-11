'use strict';

/**
 * Deciding which patch on a ticket is the most recent — a pull request or a
 * Trac attachment (issue #109 / #11).
 *
 * A contributor arriving at a ticket wants to try the latest fix. Usually that
 * is a PR, and the PR list loads on its own, so the answer is known
 * immediately. Attachments load on demand (opening Trac costs the challenge),
 * so "latest" can only be judged across what is currently loaded: PRs alone
 * until the contributor asks for attachments, then both. When an uploaded patch
 * turns out to be newer than any PR, the UI says so explicitly rather than
 * leaving it buried under the attachments button.
 *
 * Kept pure and dependency-free so the comparison is unit tested without a DOM:
 * the renderer imports it, `node --test` requires it directly (same convention
 * as patch-plan.cjs / patch-sources.cjs).
 *
 * A PR used to be dated by `updatedAt`, on the reasoning that "most recently
 * touched" is usually also "newest code" — a fair trade for a comment. It does
 * not survive an event that touches every PR at once: an upstream force-push of
 * trunk restamped thousands of open PRs inside one window, and on #62064 the
 * nineteen seconds between two of those restamps were the entire basis on which
 * a patch from 2024 that no longer applies was crowned over one from 2026 that
 * does (#281). So a PR is now dated by its newest commit, resolved by
 * github-prs.js, and an unresolved one does not compete at all — falling back
 * to `updatedAt` would be falling back to the bug.
 *
 * Which leaves the cases where the honest answer is no pill rather than a
 * guess, all handled in pickLatest by the same comparison: a row that has not
 * been ruled out, and a margin too small to mean anything. The dates stay on
 * every row either way, so the contributor can still read them.
 */

/**
 * How close two patches have to be before "which is later" stops being an
 * answer worth putting a pill on. Two commits within the hour are one piece of
 * work, not a newer and an older fix.
 */
const NEAR_TIE_MS = 60 * 60 * 1000;

/**
 * Milliseconds for an attachment's upload time, or NaN when it cannot be known.
 * The absolute timestamp scraped from Trac's title attribute is a US-format
 * date string ("MM/DD/YYYY hh:mm:ss AM"); a relative fallback ("15 months
 * ago") is not comparable and must not win.
 *
 * The string carries no timezone, so it is anchored to UTC by hand rather than
 * left to Date.parse, which would read it in the machine's local zone. That
 * anchoring is what keeps the comparison machine-independent: two contributors
 * in different timezones must see the same patch marked latest. The absolute
 * instant may be off by the true Trac offset, but "which is newer" stays
 * consistent, which is the point.
 *
 * @param {Object} attachment
 * @return {number}
 */
function attachmentDateMs(attachment) {
	const text = attachment && typeof attachment.dateText === 'string' ? attachment.dateText : '';
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?/i.exec(text.trim());
	if (!m) return NaN;
	const [, mon, day, year, hh, mm, ss, ampm] = m;
	let hour = Number(hh);
	if (ampm) {
		const pm = ampm.toUpperCase() === 'PM';
		if (pm && hour !== 12) hour += 12;
		if (!pm && hour === 12) hour = 0;
	}
	return Date.UTC(Number(year), Number(mon) - 1, Number(day), hour, Number(mm), Number(ss));
}

/**
 * Milliseconds for a PR's newest commit, or NaN when it was never resolved.
 *
 * NaN keeps that PR out of the comparison entirely. `updatedAt` is still on the
 * object and is still the wrong answer; see the note at the top of this file.
 *
 * @param {Object} pr
 * @return {number}
 */
function prDateMs(pr) {
	const text = pr && typeof pr.commitDate === 'string' ? pr.commitDate : '';
	return text ? Date.parse(text) : NaN;
}

/**
 * The most recent patch across the loaded sources, or null when there is no
 * answer worth showing.
 *
 * Only applyable attachments (patch files) compete — a .txt is context, not a
 * fix. `attachments` being undefined means they have not been loaded yet, so
 * the answer is drawn from PRs alone; that is the normal, pre-attachment state.
 *
 * Null means "show nothing", and it covers three cases, not one: nothing is
 * datable, the PR ranking is incomplete, or the top two are too close to
 * separate. The last two are the point — a pill is a claim, and a wrong claim
 * sends a contributor into an apply that cannot succeed, which costs far more
 * than the pill was ever worth.
 *
 * An undated PR does not disqualify the answer; it competes as an upper bound.
 * That single rule replaces what used to be a special case, and it is worth
 * spelling out because getting it wrong cost this feature its pill on the
 * ordinary ticket:
 *
 * - A PR the walk *ruled out* is undated on purpose — the walk stopped early
 *   precisely because its `updatedAt` was already below a resolved date. Its
 *   bound therefore sits far below the winner, and the pill shows. Treating it
 *   as "unknown, so no answer" threw away the pill in exactly the cheap,
 *   one-lookup case the walk exists to produce.
 * - A PR the walk never *reached* — the cap, a failed lookup, a cache written
 *   before commit dates existed — carries the stamp that has not been ruled
 *   out, which in a force-push sweep sits at or above the winner. The near-tie
 *   check then suppresses the pill on its own.
 *
 * So both cases fall out of the same comparison, with no flag distinguishing
 * them. A PR with neither a date nor a usable stamp is unbounded, and takes the
 * answer with it.
 *
 * @param {Object}  root0
 * @param {Array}   [root0.prs]
 * @param {Array}   [root0.attachments]
 * @param {boolean} [root0.prRankComplete] False when the lookup walk stopped early.
 * @return {{kind: 'pr'|'attachment', key: (number|string), whenMs: number}|null}
 */
function pickLatest({ prs, attachments, prRankComplete } = {}) {
	let best = null;
	let runnerUpMs = -Infinity;
	const consider = (kind, key, whenMs) => {
		if (!Number.isFinite(whenMs)) return;
		if (!best || whenMs > best.whenMs) {
			if (best) runnerUpMs = Math.max(runnerUpMs, best.whenMs);
			best = { kind, key, whenMs };
			return;
		}
		runnerUpMs = Math.max(runnerUpMs, whenMs);
	};
	// A bound can only ever argue that the answer is too close to call. It never
	// becomes the answer: `updatedAt` is not a date this app is willing to put a
	// pill on, which is the whole of #281.
	const considerBound = (whenMs) => {
		runnerUpMs = Number.isFinite(whenMs) ? Math.max(runnerUpMs, whenMs) : Infinity;
	};

	for (const pr of Array.isArray(prs) ? prs : []) {
		const whenMs = prDateMs(pr);
		if (Number.isFinite(whenMs)) consider('pr', pr.number, whenMs);
		else considerBound(pr && pr.updatedAt ? Date.parse(pr.updatedAt) : NaN);
	}
	// A walk that broke on a failed lookup may not have left a usable bound on
	// the row it died at, so the flag still gets the last word.
	if (prRankComplete === false) return null;

	for (const att of Array.isArray(attachments) ? attachments : []) {
		if (!att.applyable) continue;
		consider('attachment', att.url || att.filename, attachmentDateMs(att));
	}

	if (!best) return null;
	if (best.whenMs - runnerUpMs < NEAR_TIE_MS) return null;
	return best;
}

module.exports = { NEAR_TIE_MS, attachmentDateMs, pickLatest };
