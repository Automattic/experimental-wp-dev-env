'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mergeInProgressNotice, mergeInProgressError, mergeCheckFailedError } = require('../../src/renderer/merge-in-progress.cjs');

test('mergeInProgressNotice names the operation, the files and both ways out (#352)', () => {
	const notice = mergeInProgressNotice({ mergeInProgress: { kind: 'merge', paths: ['src/wp-login.php', 'src/doomed.php'] } });
	assert.equal(notice.title, 'A merge started outside the app is in progress.');
	assert.match(notice.body, /conflicts in src\/wp-login\.php and src\/doomed\.php\./);
	assert.match(notice.body, /Finish it from a terminal \(resolve the files, then git add them and run git commit\)/);
	assert.match(notice.body, /abandon it \(git merge --abort\)/);
	assert.match(notice.body, /linking tickets, applying patches, discarding changes and updating trunk are refused/);
});

test('mergeInProgressNotice words each kind with its own commands (#352)', () => {
	const cases = [
		['rebase', 'A rebase', 'git rebase --continue', 'git rebase --abort'],
		['cherry-pick', 'A cherry-pick', 'git cherry-pick --continue', 'git cherry-pick --abort'],
		['revert', 'A revert', 'git revert --continue', 'git revert --abort'],
		['apply', 'A three-way patch apply', 'git add them', 'git restore --staged --worktree']
	];
	for (const [kind, name, finish, abandon] of cases) {
		const notice = mergeInProgressNotice({ mergeInProgress: { kind, paths: ['a.php'] } });
		assert.ok(notice.title.startsWith(name), kind);
		assert.ok(notice.body.includes(finish), `${kind}: ${notice.body}`);
		assert.ok(notice.body.includes(abandon), kind);
	}
	// A kind this module has no words for is still a refusal, worded as a merge.
	assert.match(mergeInProgressNotice({ mergeInProgress: { kind: 'bisect', paths: ['a.php'] } }).body, /git merge --abort/);
});

test('a merge resolved in an editor but not committed is still in progress, with the finishing step alone (#352)', () => {
	const notice = mergeInProgressNotice({ mergeInProgress: { kind: 'merge', paths: [] } });
	assert.match(notice.body, /^Its conflicts are resolved but it is not finished\. Finish it from a terminal \(git commit\) or abandon it \(git merge --abort\)/);
	assert.doesNotMatch(notice.body, /conflicts in/);
});

test('the file list is capped, and one file reads as one (#352)', () => {
	const many = mergeInProgressNotice({ mergeInProgress: { kind: 'merge', paths: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } });
	assert.match(many.body, /conflicts in a, b, c, d, e and 2 more files\./);
	const six = mergeInProgressNotice({ mergeInProgress: { kind: 'merge', paths: ['a', 'b', 'c', 'd', 'e', 'f'] } });
	assert.match(six.body, /and 1 more file\./);
	assert.match(mergeInProgressNotice({ mergeInProgress: { kind: 'merge', paths: ['only.php'] } }).body, /conflicts in only\.php\./);
});

test('mergeInProgressNotice stays silent for every other checkout (#352)', () => {
	assert.equal(mergeInProgressNotice({ mergeInProgress: null }), null);
	assert.equal(mergeInProgressNotice({}), null);
	assert.equal(mergeInProgressNotice(), null);
});

test('the refusal main returns is the notice as one sentence, with no em dash (#352)', () => {
	const state = { kind: 'merge', paths: ['src/wp-login.php'] };
	const notice = mergeInProgressNotice({ mergeInProgress: state });
	assert.equal(mergeInProgressError(state), `${notice.title} ${notice.body}`);
	assert.doesNotMatch(mergeInProgressError(state), /—/);
});

test('main and the card read the same module (#352)', () => {
	const root = path.join(__dirname, '..', '..', 'src');
	const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
	assert.match(main, /require\('\.\/renderer\/merge-in-progress\.cjs'\)/);
	assert.match(main, /mergeInProgressError\(state\)/);
	const source = fs.readFileSync(path.join(root, 'renderer', 'index.jsx'), 'utf8');
	assert.match(source, /setMergeInProgress\(s\?\.mergeInProgress \|\| null\)/);
	assert.match(source, /mergeInProgressNotice\(\{ mergeInProgress \}\)/);
	assert.match(source, /mergeNotice\.title/);
	assert.match(source, /mergeNotice\.body/);
});

test('a read that failed refuses the write and says nothing changed (#352)', () => {
	const error = mergeCheckFailedError(new Error('index.lock exists'));
	assert.match(error, /could not check whether a merge is in progress/);
	assert.match(error, /nothing was changed/);
	assert.match(error, /\(index\.lock exists\)$/);
	assert.doesNotMatch(mergeCheckFailedError(null), /\(/);
});
