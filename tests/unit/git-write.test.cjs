const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
	stagePaths,
	writeTree,
	commitTree,
	updateBranch,
	createBranchAt,
	pointHeadAt,
	deleteBranch,
	checkoutBranch,
	fetchBranch,
	unstagePaths,
	cleanUntracked,
	applyPatch
} = require('../../src/git-write.cjs');

// The argument lists, without a Git: `run` and `spawn` are injected and record
// what they were asked. The primitives meet the real binary in
// git-write.integration.test.cjs, and the flows built on them in
// ticket-branches.integration.test.cjs.

// A `run` that answers every call with `stdout` and records the argv and
// options it saw. `crlfArgs` asks `config --local --get core.autocrlf` first
// on Windows; `autocrlfUnset` scripts that answer.
function recordingRun({ stdout = '', autocrlfUnset = true } = {}) {
	const calls = [];
	const run = async (args, options) => {
		calls.push({ args, options });
		if (args[0] === 'config') return { status: autocrlfUnset ? 1 : 0, stdout: Buffer.from(autocrlfUnset ? '' : 'false\n'), stderr: '' };
		return { status: 0, stdout: Buffer.from(stdout), stderr: '' };
	};
	return { run, calls, last: () => calls[calls.length - 1] };
}

function fakeChild({ stderr = [], status = 0, signal = null, error = null } = {}) {
	const child = new EventEmitter();
	child.pid = 4242;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	setTimeout(() => {
		if (error) {
			child.emit('error', error);
			child.emit('close', null, null);
			return;
		}
		for (const chunk of stderr) child.stderr.write(chunk);
		child.stdout.end();
		child.stderr.end();
		setTimeout(() => child.emit('close', status, signal), 0);
	}, 0);
	return child;
}

function recordingSpawn(childOptions) {
	const calls = [];
	const spawn = (file, args, options) => {
		const child = fakeChild(childOptions);
		calls.push({ file, args, options, child });
		return child;
	};
	return { spawn, calls };
}

test('stagePaths hands Git exactly the paths, NUL-separated on stdin, taken literally, with deletions included', async () => {
	const { run, last } = recordingRun();
	const paths = ['wp-login.php', 'weird[1]*.php', 'with space.txt', 'doomed.php'];

	const count = await stagePaths('/sites/wp', paths, { platform: 'darwin', run });

	assert.equal(count, 4);
	const { args, options } = last();
	assert.deepEqual(args, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul']);
	assert.equal(options.cwd, '/sites/wp');
	assert.equal(options.input.toString('utf8'), 'wp-login.php\0weird[1]*.php\0with space.txt\0doomed.php\0');
});

test('stagePaths with nothing to stage runs nothing', async () => {
	const { run, calls } = recordingRun();
	assert.equal(await stagePaths('/sites/wp', [], { platform: 'darwin', run }), 0);
	assert.deepEqual(calls, []);
});

test('on Windows the CRLF view and long paths prefix the commands that touch the index or the worktree, and only those', async () => {
	const { run, calls } = recordingRun({ stdout: 'abc\n' });

	await stagePaths('C:\\Sites\\wp', ['a.php'], { platform: 'win32', run });
	const add = calls.find((c) => c.args.includes('add'));
	assert.deepEqual(add.args.slice(0, 4), ['-c', 'core.autocrlf=true', '-c', 'core.longpaths=true']);

	const { spawn, calls: spawns } = recordingSpawn();
	await checkoutBranch('C:\\Sites\\wp', 'ticket/1', { platform: 'win32', run, spawn });
	const checkout = spawns[0].args;
	const at = checkout.indexOf('core.autocrlf=true');
	assert.deepEqual(checkout.slice(at - 1, at + 4), ['-c', 'core.autocrlf=true', '-c', 'core.longpaths=true', 'checkout']);

	// Object and ref writes see no worktree and get no prefix.
	calls.length = 0;
	await writeTree('C:\\Sites\\wp', { run });
	await commitTree('C:\\Sites\\wp', { tree: 't', parent: 'p', message: 'm', author: { name: 'n', email: 'e' }, run });
	await updateBranch('C:\\Sites\\wp', 'ticket/1', 'abc', { run });
	for (const { args } of calls) assert.ok(!args.includes('core.autocrlf=true') && !args.includes('core.longpaths=true'), `${args.join(' ')} carries the worktree view`);
});

test('an explicit local core.autocrlf is left alone, as it is for the reads; long paths are always asked for', async () => {
	const { run, last } = recordingRun({ autocrlfUnset: false });
	await stagePaths('C:\\Sites\\wp', ['a.php'], { platform: 'win32', run });
	assert.deepEqual(last().args.slice(0, 3), ['-c', 'core.longpaths=true', '--literal-pathspecs']);
});

test('writeTree and commitTree return the object id Git printed, and the commit carries exactly one parent and the identity given', async () => {
	const { run, last } = recordingRun({ stdout: '0123456789abcdef0123456789abcdef01234567\n' });

	assert.equal(await writeTree('/sites/wp', { run }), '0123456789abcdef0123456789abcdef01234567');
	assert.deepEqual(last().args, ['write-tree']);

	const author = { name: 'WordPress Contributor Toolkit', email: 'noreply@localhost' };
	const oid = await commitTree('/sites/wp', { tree: 'tree1', parent: 'base1', message: 'Work in progress', author, run });
	assert.equal(oid, '0123456789abcdef0123456789abcdef01234567');
	assert.deepEqual(last().args, [
		'-c', 'user.name=WordPress Contributor Toolkit',
		'-c', 'user.email=noreply@localhost',
		'commit-tree', 'tree1', '-p', 'base1', '-m', 'Work in progress'
	]);
	assert.equal(last().args.filter((a) => a === '-p').length, 1, 'one parent, never a stack');
});

test('updateBranch writes the full ref, and passes the expected old value when given one', async () => {
	const { run, last } = recordingRun();
	await updateBranch('/sites/wp', 'ticket/59234', 'new1', { run });
	assert.deepEqual(last().args, ['update-ref', 'refs/heads/ticket/59234', 'new1']);
	await updateBranch('/sites/wp', 'ticket/59234', 'new1', { expected: 'old1', run });
	assert.deepEqual(last().args, ['update-ref', 'refs/heads/ticket/59234', 'new1', 'old1']);
});

test('createBranchAt, pointHeadAt and deleteBranch are the ref commands, nothing that touches files', async () => {
	const { run, calls } = recordingRun();
	await createBranchAt('/sites/wp', 'ticket/1', 'trunk', { run });
	await pointHeadAt('/sites/wp', 'ticket/1', { run });
	await deleteBranch('/sites/wp', 'ticket/1', { run });
	assert.deepEqual(calls.map((c) => c.args), [
		['branch', '--', 'ticket/1', 'trunk'],
		['symbolic-ref', 'HEAD', 'refs/heads/ticket/1'],
		['branch', '-D', '--', 'ticket/1']
	]);
	for (const { options } of calls) assert.equal(options.cwd, '/sites/wp');
});

test('checkoutBranch forces, asks for progress, reports it from stderr and hands the child out', async () => {
	const { run } = recordingRun();
	const { spawn, calls } = recordingSpawn({
		stderr: ['Updating files:  50% (100/200)\rUpdating files: 100% (200/200), done.\n']
	});
	const seen = [];
	let child = null;

	const result = await checkoutBranch('/sites/wp', 'ticket/1', { platform: 'darwin', run, spawn, onProgress: (e) => seen.push(e), onChild: (c) => { child = c; } });

	assert.deepEqual(result, { ref: 'ticket/1' });
	const { args, options } = calls[0];
	assert.deepEqual(args.slice(-4), ['checkout', '--force', '--progress', 'ticket/1']);
	assert.equal(options.cwd, '/sites/wp');
	assert.equal(options.stdio[0], 'ignore');
	assert.equal(child.pid, 4242);
	assert.deepEqual(seen.map((e) => [e.phase, e.loaded, e.total]), [['updating files', 100, 200], ['updating files', 200, 200]]);
});

test('a failed checkout rejects with a GitError carrying the fatal line and the stderr', async () => {
	const { run } = recordingRun();
	const { spawn } = recordingSpawn({
		status: 1,
		stderr: ['error: Your local changes would be overwritten\n', 'fatal: cannot switch\n']
	});

	await assert.rejects(
		checkoutBranch('/sites/wp', 'ticket/1', { platform: 'darwin', run, spawn }),
		(error) => {
			assert.equal(error.name, 'GitError');
			assert.equal(error.code, 1);
			assert.match(error.message, /^git checkout failed \(1\): fatal: cannot switch$/);
			assert.match(error.stderr, /local changes/);
			assert.equal(error.cwd, '/sites/wp');
			return true;
		}
	);
});

test('a checkout whose Git never started rejects the same way', async () => {
	const { run } = recordingRun();
	const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
	const { spawn } = recordingSpawn({ error: enoent });

	await assert.rejects(
		checkoutBranch('/sites/wp', 'ticket/1', { platform: 'darwin', run, spawn }),
		(error) => error.name === 'GitError' && error.code === 'ENOENT'
	);
});

test('fetchBranch asks for one branch of one remote with progress, no depth and no filter, and reads FETCH_HEAD back', async () => {
	const { spawn, calls } = recordingSpawn({ stderr: ['Receiving objects: 100% (4/4), done.\n'] });
	const chunks = [];
	let child = null;

	const result = await fetchBranch('/sites/wp', 'origin', 'trunk', {
		spawn, onStderr: (t) => chunks.push(t), onChild: (c) => { child = c; },
		resolve: async (dir, ref) => { assert.equal(dir, '/sites/wp'); assert.equal(ref, 'FETCH_HEAD'); return 'new1'; }
	});

	assert.deepEqual(result, { oid: 'new1' });
	const { args, options } = calls[0];
	assert.deepEqual(args.slice(-6), ['fetch', '--progress', '--no-tags', '--', 'origin', 'trunk']);
	// The URL is the site's own config, so `ext::` and friends are closed
	// before it is read; what the app fetches over stays open.
	const protocols = args.filter((a, i) => args[i - 1] === '-c' && a.startsWith('protocol.'));
	assert.deepEqual(protocols, ['protocol.allow=never', 'protocol.https.allow=always', 'protocol.http.allow=always', 'protocol.file.allow=always']);
	assert.ok(!args.some((a) => /^--depth|^--filter|^--unshallow/.test(a)), 'the site config decides how much comes down');
	assert.ok(!args.includes('core.autocrlf=true') && !args.includes('core.longpaths=true'), 'a fetch touches no worktree');
	assert.equal(options.cwd, '/sites/wp');
	assert.equal(child.pid, 4242);
	assert.deepEqual(chunks, ['Receiving objects: 100% (4/4), done.\n']);
});

test('fetchBranch with nothing in FETCH_HEAD afterwards is an error, not an undefined oid', async () => {
	const { spawn } = recordingSpawn();
	await assert.rejects(
		fetchBranch('/sites/wp', 'origin', 'trunk', { spawn, resolve: async () => null }),
		(error) => error.name === 'GitError' && error.code === 'no-fetch-head'
	);
});

test('unstagePaths hands Git exactly the paths on stdin, literally, through reset rather than rm --cached, and runs nothing for none', async () => {
	const { run, calls, last } = recordingRun();

	assert.equal(await unstagePaths('/sites/wp', ['node_modules/dep/index.js', 'weird[1].txt'], { platform: 'darwin', run }), 2);
	assert.deepEqual(last().args, ['--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul', '--']);
	assert.equal(last().options.input.toString('utf8'), 'node_modules/dep/index.js\0weird[1].txt\0');

	calls.length = 0;
	assert.equal(await unstagePaths('/sites/wp', [], { platform: 'darwin', run }), 0);
	assert.deepEqual(calls, []);
});

test('cleanUntracked removes untracked files and directories but never what is ignored, and both index commands get the Windows prefix', async () => {
	const { run, calls } = recordingRun();

	await cleanUntracked('/sites/wp', { platform: 'darwin', run });
	assert.deepEqual(calls[calls.length - 1].args, ['clean', '-fd']);
	assert.ok(!calls[calls.length - 1].args.includes('-x') && !calls[calls.length - 1].args.includes('-ffd'));

	calls.length = 0;
	await cleanUntracked('C:\\Sites\\wp', { platform: 'win32', run });
	await unstagePaths('C:\\Sites\\wp', ['a.php'], { platform: 'win32', run });
	for (const { args } of calls.filter((c) => c.args[0] !== 'config')) {
		assert.deepEqual(args.slice(0, 4), ['-c', 'core.autocrlf=true', '-c', 'core.longpaths=true'], args.join(' '));
	}
});

test('applyPatch hands the patch to Git on stdin with -p1, checks or reverses on request, and carries the Windows view', async () => {
	const { run, calls } = recordingRun();
	const patch = '--- a/src/wp-login.php\n+++ b/src/wp-login.php\n@@ -1 +1 @@\n-a\n+b\n';

	const applied = await applyPatch('/sites/wp', patch, { platform: 'darwin', run });
	assert.deepEqual(applied, { ok: true, status: 0, stderr: '' });
	assert.deepEqual(calls[0].args, ['apply', '--whitespace=nowarn', '-p1', '-']);
	assert.equal(calls[0].options.cwd, '/sites/wp');
	assert.equal(calls[0].options.input.toString('utf8'), patch);
	assert.deepEqual(calls[0].options.okCodes, [0, 1, 128], 'exit 1 and 128 are answers, not throws');
	assert.ok(!calls[0].args.includes('--index') && !calls[0].args.includes('--3way'), 'the index is never touched');

	await applyPatch('/sites/wp', patch, { check: true, reverse: true, platform: 'darwin', run });
	assert.deepEqual(calls[1].args, ['apply', '--whitespace=nowarn', '-p1', '--check', '--reverse', '-']);

	calls.length = 0;
	await applyPatch('C:\\Sites\\wp', patch, { platform: 'win32', run });
	const apply = calls.find((c) => c.args.includes('apply'));
	assert.deepEqual(apply.args.slice(0, 4), ['-c', 'core.autocrlf=true', '-c', 'core.longpaths=true']);
});

test('applyPatch reports a patch that does not fit, or that Git refuses, as not ok with the stderr kept', async () => {
	const answers = [{ status: 1, stderr: 'error: patch failed: a.php:1\n' }, { status: 128, stderr: "error: invalid path '../x'\n" }];
	const run = async () => ({ ...answers.shift(), stdout: Buffer.alloc(0) });
	assert.deepEqual(await applyPatch('/sites/wp', 'x', { platform: 'darwin', run }), { ok: false, status: 1, stderr: 'error: patch failed: a.php:1\n' });
	assert.deepEqual(await applyPatch('/sites/wp', 'x', { platform: 'darwin', run }), { ok: false, status: 128, stderr: "error: invalid path '../x'\n" });
});
