const test = require('node:test');
const assert = require('node:assert/strict');

const { runGit } = require('../../src/git-run.cjs');
const { git, tempDir } = require('./helpers/git.cjs');

// The runner against the real binary: the scripted-child tests in
// git-run.test.cjs prove the contract, this proves the pieces meet.

test('the real binary answers through runGit inside a repository', async (t) => {
	const dir = tempDir(t, 'toolkit-git-run-');
	assert.equal(git(['init', '-b', 'trunk'], dir).status, 0);
	const { status, stdout } = await runGit(['rev-parse', '--git-dir'], { cwd: dir });
	assert.equal(status, 0);
	assert.equal(stdout.toString('utf8').trim(), '.git');

	const missing = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/nope'], { cwd: dir, okCodes: [0, 1] });
	assert.equal(missing.status, 1);

	await assert.rejects(runGit(['rev-parse', '--verify', 'refs/heads/nope'], { cwd: dir }), (error) => error.code === 128);
});
