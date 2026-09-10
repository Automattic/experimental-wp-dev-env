'use strict';

/**
 * Git's progress lines, and its reason for failing, read off stderr. The one
 * place the app parses non-porcelain output: Git has no machine format for
 * progress, the lines have had the same shape for fifteen years, and a line
 * that does not parse is dropped rather than shown. Shared by the clone
 * (git-clone.cjs) and the checkout (git-write.cjs), which print the same
 * `Phase:  42% (1234/5678)` shape; the environment pins `LC_ALL=C`
 * (git-binary.cjs) so the words are the ones these patterns expect.
 */

// `Receiving objects:  42% (1234/5678), 12.00 MiB | 3.00 MiB/s`, with or
// without the `remote: ` prefix the server-side phases carry.
const PROGRESS_LINE = /^(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+(\d+)% \((\d+)\/(\d+)\)/;

/**
 * One progress event per phase line, from a chunk that may hold several
 * lines and may end mid-line. Git separates updates to the same phase with
 * `\r` and phases with `\n`; both end a segment here.
 *
 * @param {string} text
 * @return {Array<{phase: string, percent: number, loaded: number, total: number}>}
 */
function parseProgressLines(text) {
	const events = [];
	for (const segment of text.split(/[\r\n]/)) {
		const match = PROGRESS_LINE.exec(segment);
		if (!match) continue;
		events.push({
			phase: match[1].toLowerCase(),
			percent: Number(match[2]),
			loaded: Number(match[3]),
			total: Number(match[4])
		});
	}
	return events;
}

/**
 * Feeds chunks in, emits complete progress lines out, and holds back the
 * tail that has not ended yet so a percentage split across two chunks is not
 * reported twice, or wrongly.
 *
 * @param {Function} onEvent
 * @return {{push: Function, flush: Function}}
 */
function createProgressReader(onEvent) {
	let pending = '';
	const emit = (text) => {
		for (const event of parseProgressLines(text)) onEvent(event);
	};
	return {
		push(chunk) {
			pending += chunk;
			const cut = Math.max(pending.lastIndexOf('\r'), pending.lastIndexOf('\n'));
			if (cut === -1) return;
			emit(pending.slice(0, cut + 1));
			pending = pending.slice(cut + 1);
		},
		flush() {
			if (pending) emit(pending);
			pending = '';
		}
	};
}

/**
 * Git's reason for a failed command, for the error message. Its `fatal:` (or
 * `error:`) line is not always the last one: "Please make sure you have the
 * correct access rights and the repository exists." follows it. Falls back to
 * the last line that is not a progress update, then to the signal.
 *
 * @param {string}  stderr
 * @param {?string} [signal]
 * @return {string}
 */
function failureReason(stderr, signal = null) {
	const lines = String(stderr || '').split(/[\r\n]/).filter((line) => line.trim() && !PROGRESS_LINE.test(line));
	return lines.filter((line) => /^(fatal|error):/.test(line)).pop() || lines.pop() || (signal ? `killed by ${signal}` : 'no output');
}

module.exports = { parseProgressLines, createProgressReader, failureReason };
