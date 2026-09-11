// How this app writes an attacker-influenced string into its own log file.
//
// Every guard module in src/ refuses some input — a URL whose scheme the app
// does not open, a path that is not a registered site, an application the app
// will not launch — and every refusal is logged, because a guard that trips
// silently is a guard nobody finds out about. The value being logged is
// attacker-influenced by hypothesis: that is why it was refused.
//
// Two things follow, and they are the whole of this module.
//
// It has to stay on one line. A newline in the value would otherwise let it
// write a second entry in the app's own timestamp-and-scope format, and a log
// that can be made to describe events that never happened is worse than no log.
// The control characters are escaped rather than dropped so the line still says
// what the caller actually sent.
//
// And it has to be bounded, so a very long value cannot flood the file.
// Truncation comes after escaping, since escaping is what decides the final
// length.
//
// This lived twice — once in external-url.js and once in site-registry.js, the
// second with a comment saying the third caller should be the one to move it
// here. editor-launch.js is that third caller.

// Line breaks, and everything else that would let a refused value end a log line
// and start another one.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

const MAX_DESCRIPTION_LENGTH = 120;

// A one-line, bounded rendering of a refused value, safe to concatenate into a
// log message. A non-string is described by its type rather than coerced, so a
// caller that passed the wrong thing entirely reads as that in the log instead
// of as an empty or `[object Object]` value.
function describeRefused(value) {
	if (typeof value !== 'string') return `<${value === null ? 'null' : typeof value}>`;

	const oneLine = value.replace(CONTROL_CHARACTERS, (c) => {
		const code = c.codePointAt(0);
		return code <= 0xff
			? `\\x${code.toString(16).padStart(2, '0')}`
			: `\\u${code.toString(16).padStart(4, '0')}`;
	});

	if (oneLine.length <= MAX_DESCRIPTION_LENGTH) return oneLine;
	return `${oneLine.slice(0, MAX_DESCRIPTION_LENGTH)}…`;
}

module.exports = {
	describeRefused
};
