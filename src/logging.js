// The app's on-disk log. This is the only module that touches electron-log, so
// the rest of the codebase depends on this module's exports rather than on the
// library.
//
// Why a file at all: in a packaged GUI build the main process has no terminal,
// so every console.* call and every byte of child-process stdout/stderr goes
// nowhere. Child output is forwarded to the renderer over IPC, which means a
// spawn that fails before producing output — or a renderer that never renders
// what it received — leaves no trace whatsoever. "Nothing happened" and "the
// spawn failed with EPERM" then look identical, and there is nothing to attach
// to a bug report.

const path = require('path');
const { inspect } = require('util');
const { app } = require('electron');
const log = require('electron-log/main');
const { createLineBuffer } = require('./log-lines');

// Friendly platform names rather than process.platform's own values: 'win32'
// reads as 32-bit to most people, and this string ends up in front of
// contributors rather than only in code.
const PLATFORM_NAMES = {
	darwin: 'macos',
	win32: 'windows',
	linux: 'linux'
};

// Not electron-log's default of main.log. The point of this file is that people
// attach it to bug reports, at which moment it is separated from the app-named
// folder that would otherwise identify it — so the name has to stand alone in a
// list of attachments. The platform is in there because a single issue thread
// often collects logs from several contributors, and which OS a log came from is
// the first thing anyone reading it needs to know.
function logFileName(platform = process.platform) {
	return `wordpress-contributor-toolkit-${PLATFORM_NAMES[platform] || platform}.log`;
}

// Rotated to <name>.old.log past this size, so an app left running through many
// npm installs cannot grow the file without bound.
const MAX_LOG_SIZE = 5 * 1024 * 1024;

let initialized = false;

function initLogging() {
	if (initialized) return;
	initialized = true;

	// Must run before the first BrowserWindow is constructed: this preloads the
	// IPC bridge that lets renderer output reach this file. Called later it
	// silently does nothing for windows that already exist. spyRendererConsole
	// is what captures the renderer's own console.* — the blind spot behind the
	// class of bug where the main process is fine and the UI simply never shows
	// what it was sent.
	log.initialize({ spyRendererConsole: true });

	log.transports.file.resolvePathFn = () => path.join(app.getPath('logs'), logFileName());
	log.transports.file.maxSize = MAX_LOG_SIZE;

	// Redirects the existing console.* calls throughout the main process into
	// the log without editing their call sites. They keep printing to stdout in
	// development via the console transport.
	Object.assign(console, log.functions);

	// There were no uncaughtException/unhandledRejection handlers at all, so a
	// main-process crash previously produced an empty log — the exact moment the
	// log is most wanted. showDialog is off deliberately: at a Contributor Day a
	// modal error box derails the session, and the stack is in the file anyway.
	log.errorHandler.startCatching({ showDialog: false });

	writeHeader();
}

// A version/platform block at the top of each run. Nearly every bug report needs
// it and nearly no reporter thinks to include it; asking for the log file should
// be enough on its own.
function writeHeader() {
	emit('app', 'info', '--- session start ---');
	emit('app', 'info', `app ${app.getVersion()} (${app.getName()})`);
	emit('app', 'info', `electron ${process.versions.electron} · node ${process.versions.node} · chrome ${process.versions.chrome}`);
	emit('app', 'info', `platform ${process.platform} ${process.arch} · ${process.env.NODE_ENV || 'production'}`);
	emit('app', 'info', `log file ${getLogFilePath()}`);
}

// Absolute path to the current log file, for the Help menu entries. Resolving it
// through the transport rather than recomputing it keeps the menu honest if the
// path logic ever changes.
function getLogFilePath() {
	return log.transports.file.getFile().path;
}

// Every event this module writes goes through `emit` below, because the value
// of the log rests on one property: every line in it was written by this app,
// with this app's own timestamp and scope in front of it. (The console.*
// redirection installed in initLogging does not pass through here — those call
// sites log strings this app wrote itself.)
//
// Nothing this module is handed is trustworthy enough to skip that. Child
// output is whatever npm, grunt or the site under development printed. Messages
// carry inbound email subjects (the `smtp` scope in main.js), paths a
// contributor chose, and the refused URLs and paths that external-url.js and
// site-registry.js escape precisely so they cannot forge an entry — a guarantee
// that only holds if this module does not undo it one caller later.
//
// A newline is the forgery: written verbatim it ends the app's entry and starts
// a line the reader has no way to tell from a real one. It is handled by
// splitting rather than escaping, so a stack trace still reads as a stack trace
// — one entry per frame, each honestly stamped — instead of a single line of
// literal \n. Everything else in this class is escaped: a lone CR, an ANSI
// sequence or U+2028 begins a new line in one viewer or another, which is the
// same forgery through a different reader.
//
// This is the same escaping as `describeRefused` (safe-log.js), which describes a single value
// for a caller; this one is the writer itself and bounds a whole line, so the
// limits differ — a spawn message with a long path is legitimately longer than
// a refused URL. Keeping the escape identical matters more than sharing it.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

// Generous enough that no message this app writes is truncated — the longest are
// spawn lines carrying two paths — and small enough that one pathological line
// of child output (a build printing a minified bundle) cannot fill the file and
// rotate away the session header that makes the rest worth reading.
const MAX_LINE_LENGTH = 2000;

// Scopes are short by construction ('npm:install', 'playground:<dir>#<hash>'),
// so this only bounds the one that is not: `path.basename(sitePath)` of a
// directory the contributor named.
const MAX_SCOPE_LENGTH = 80;

function escapeControlCharacters(text) {
	return text.replace(CONTROL_CHARACTERS, (c) => {
		const code = c.codePointAt(0);
		return code <= 0xff
			? `\\x${code.toString(16).padStart(2, '0')}`
			: `\\u${code.toString(16).padStart(4, '0')}`;
	});
}

// Truncation comes after escaping, since escaping is what decides the final
// length.
function bound(text, limit) {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// A non-string is inspected rather than coerced: `String({})` is '[object
// Object]', which says nothing. `breakLength` keeps the common shapes on one
// line; where inspect wraps anyway (an Error, a long array) the split below
// still stamps each line, so the guarantee does not depend on this.
function asText(message) {
	return typeof message === 'string' ? message : inspect(message, { breakLength: Infinity, depth: 3 });
}

// The lines to write for one message, one log entry each.
function toLogLines(message) {
	return asText(message).split('\n').map((line) => bound(escapeControlCharacters(line), MAX_LINE_LENGTH));
}

function safeScope(scope) {
	return bound(escapeControlCharacters(asText(scope)), MAX_SCOPE_LENGTH);
}

function emit(scope, level, message) {
	const scoped = log.scope(safeScope(scope));
	for (const line of toLogLines(message)) {
		scoped[level](line);
	}
}

// One line buffer per (scope, stream). Chunks arrive mid-line, so writing them
// raw would fragment single messages across timestamped entries.
const buffers = new Map();

function bufferFor(scope, type) {
	const key = `${scope}:${type}`;
	if (!buffers.has(key)) buffers.set(key, createLineBuffer());
	return buffers.get(key);
}

// Mirrors a chunk of child-process output into the log. Callers keep sending the
// same chunk to the renderer over IPC as before — this is an addition, never a
// replacement, so the UI is unaffected.
function logChildOutput(scope, type, chunk) {
	const level = type === 'stderr' ? 'warn' : 'info';
	for (const line of bufferFor(scope, type).push(chunk)) {
		emit(scope, level, line);
	}
}

// Call when the child closes, to emit any line it left unterminated and drop the
// buffers — scopes are keyed by site path or run id and would otherwise
// accumulate for the lifetime of the app.
function flushChildOutput(scope) {
	for (const type of ['stdout', 'stderr']) {
		const key = `${scope}:${type}`;
		const buf = buffers.get(key);
		if (!buf) continue;
		for (const line of buf.flush()) {
			emit(scope, type === 'stderr' ? 'warn' : 'info', line);
		}
		buffers.delete(key);
	}
}

// Structured events around a child process: the spawn itself and its exit code.
// These matter more than the output — a spawn that dies immediately (EPERM on
// Windows) produces no stdout at all, and that silence is the bug.
function logEvent(scope, message) {
	emit(scope, 'info', message);
}

function logError(scope, message) {
	emit(scope, 'error', message);
}

module.exports = {
	initLogging,
	getLogFilePath,
	logChildOutput,
	flushChildOutput,
	logEvent,
	logError
};
