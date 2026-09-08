'use strict';

// Integration tests for updateToLatestTrunk (src/trunk-update.js), the
// fetch-and-checkout half of the update chain (issue #147). The discard half
// lives in trunk-update.integration.test.cjs.
//
// The origin is a repository on disk reached over `file://`, the transport
// the bundled Git has and isomorphic-git never had (which is why this suite
// once carried a loopback smart-HTTP server). The site is cloned from it by
// `cloneSite`, so it has the shape every site the app makes has: partial,
// promisor config, `core.autocrlf=false`. Nothing here touches the network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { updateToLatestTrunk } = require('../../src/trunk-update.js');
const { cloneSite } = require('../../src/git-clone.cjs');
const { git, tempDir } = require('./helpers/git.cjs');

const IDENTITY = ['-c', 'user.name=T', '-c', 'user.email=t@example.com'];

// --- fixtures --------------------------------------------------------------

function commitInOrigin(origin, files, message) {
	for (const [filepath, contents] of Object.entries(files)) {
		fs.writeFileSync(path.join(origin, filepath), contents);
	}
	assert.strictEqual(git(['add', '--', ...Object.keys(files)], origin).status, 0);
	assert.strictEqual(git([...IDENTITY, 'commit', '-q', '-m', message], origin).status, 0);
	return git(['rev-parse', 'HEAD'], origin).stdout;
}

const head = (dir) => git(['rev-parse', 'HEAD'], dir).stdout;

// An origin with a history behind its tip, and a site cloned from it the way
// the app clones: the state a real site is in after setup. The history
// matters: the point of the partial clone is that the commit the site
// started on stays reachable after every update.
async function makeSiteAndOrigin(t) {
	const origin = tempDir(t, 'trunk-update-fetch-origin-');
	assert.strictEqual(git(['init', '-q', '-b', 'trunk'], origin).status, 0);
	assert.strictEqual(git(['config', 'uploadpack.allowFilter', 'true'], origin).status, 0);
	const baseOid = commitInOrigin(origin, { 'readme.txt': 'base\n' }, 'base');
	commitInOrigin(origin, { 'wp-config.php': 'first\n', 'package-lock.json': '{"lockfileVersion":1}\n' }, 'first');

	const parent = tempDir(t, 'trunk-update-fetch-site-');
	const dir = path.join(parent, 'site');
	await cloneSite({ url: pathToFileURL(origin).href, dir });

	return { origin, dir, baseOid };
}

// --- tests -----------------------------------------------------------------

test('updateToLatestTrunk: fetches the new trunk commit and resets the worktree (issue #147)', async (t) => {
	const { origin, dir } = await makeSiteAndOrigin(t);
	const oldOid = head(dir);
	const newOid = commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');
	const log = [];

	const result = await updateToLatestTrunk({ dir, onLog: (line) => log.push(line) });

	assert.strictEqual(result.upToDate, false);
	assert.strictEqual(result.oldOid, oldOid);
	assert.strictEqual(result.newOid, newOid);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8'), 'second\n');
	assert.strictEqual(head(dir), newOid);
	assert.strictEqual(git(['symbolic-ref', '--short', 'HEAD'], dir).stdout, 'trunk');
	const seconds = Number(git(['log', '-1', '--format=%ct', newOid], dir).stdout);
	assert.strictEqual(result.trunkDate, new Date(seconds * 1000).toISOString());
	// Git's own fetch lines reach the log as printed, and the app's own
	// sentences frame them.
	const text = log.join('');
	assert.match(text, /^Fetching latest trunk…\n/);
	assert.match(text, /-> FETCH_HEAD/);
	assert.match(text, /Now on trunk as of /);
});

// A site the bundled Git cloned is partial, not shallow: it has the whole
// commit history, which is what gives every pull request a merge base
// (#351). The update must leave it that way: no shallow boundary, the
// promisor config intact, and the commit the site started on still
// reachable from the new tip.
test('updateToLatestTrunk: a site with full history is not made shallow by the update (issue #385)', async (t) => {
	const { origin, dir, baseOid } = await makeSiteAndOrigin(t);
	const firstOid = head(dir);
	const secondOid = commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');
	const thirdOid = commitInOrigin(origin, { 'wp-config.php': 'third\n' }, 'third');

	const result = await updateToLatestTrunk({ dir });

	assert.strictEqual(fs.existsSync(path.join(dir, '.git', 'shallow')), false, 'no shallow boundary is written');
	assert.strictEqual(git(['rev-parse', '--is-shallow-repository'], dir).stdout, 'false');
	assert.strictEqual(git(['config', '--local', '--get', 'remote.origin.promisor'], dir).stdout, 'true');
	assert.strictEqual(result.newOid, thirdOid);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8'), 'third\n');
	assert.deepStrictEqual(git(['rev-list', 'HEAD'], dir).stdout.split('\n'), [thirdOid, secondOid, firstOid, baseOid]);
});

// The remote is the checkout's own, not a URL fixed in the app (#359): a site
// adopted from a fork updates from that fork.
test('updateToLatestTrunk: fetches from the origin the checkout has, wherever it points (issue #359)', async (t) => {
	const { dir } = await makeSiteAndOrigin(t);
	const elsewhere = tempDir(t, 'trunk-update-fetch-elsewhere-');
	assert.strictEqual(git(['init', '-q', '-b', 'trunk'], elsewhere).status, 0);
	commitInOrigin(elsewhere, { 'readme.txt': 'base\n' }, 'base');
	const forkOid = commitInOrigin(elsewhere, { 'wp-config.php': 'from the fork\n' }, 'fork');
	assert.strictEqual(git(['remote', 'set-url', 'origin', pathToFileURL(elsewhere).href], dir).status, 0);

	const result = await updateToLatestTrunk({ dir });

	assert.strictEqual(result.newOid, forkOid);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8'), 'from the fork\n');
});

test('updateToLatestTrunk: reports upToDate when the remote trunk has not moved (issue #147)', async (t) => {
	const { dir } = await makeSiteAndOrigin(t);
	const oid = head(dir);

	const result = await updateToLatestTrunk({ dir });

	assert.strictEqual(result.upToDate, true);
	assert.strictEqual(result.oldOid, oid);
	assert.strictEqual(result.newOid, oid);
	assert.strictEqual(result.lockfileChanged, false);
});

// The guard that keeps an installed node_modules alive across an update.
// Patch generation stages untracked files and never unstages them; a forced
// checkout deletes workdir files that are in the index but not in the target
// tree. Drop the staleStagedPaths sweep from updateToLatestTrunk and this
// test fails with the dependency gone from disk.
test('updateToLatestTrunk: an installed dependency left staged survives the reset (issue #147)', async (t) => {
	const { origin, dir } = await makeSiteAndOrigin(t);
	const installed = path.join(dir, 'node_modules', 'some-dep', 'index.js');
	fs.mkdirSync(path.dirname(installed), { recursive: true });
	fs.writeFileSync(installed, 'installed\n');
	assert.strictEqual(git(['add', '--', 'node_modules/some-dep/index.js'], dir).status, 0);
	commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');

	await updateToLatestTrunk({ dir });

	assert.strictEqual(fs.existsSync(installed), true);
	assert.strictEqual(fs.readFileSync(installed, 'utf8'), 'installed\n');
});

// lockfileChanged compares the two trunk snapshots, and is read before the
// worktree moves. Computing it after the reset would compare the new tree
// against itself and always report false — so the true case below is what
// pins the ordering.
test('updateToLatestTrunk: reports the lockfile change between the two trunk snapshots (issue #147)', async (t) => {
	const { origin, dir } = await makeSiteAndOrigin(t);

	commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'untouched lockfile');
	assert.strictEqual((await updateToLatestTrunk({ dir })).lockfileChanged, false);

	commitInOrigin(origin, { 'package-lock.json': '{"lockfileVersion":2}\n' }, 'bumped lockfile');
	assert.strictEqual((await updateToLatestTrunk({ dir })).lockfileChanged, true);
});

// Both children are handed out: a quit during a fetch of wordpress-develop,
// or during the checkout that follows, must find something to kill.
test('updateToLatestTrunk: hands the fetch and the checkout children to onChild (issue #385)', async (t) => {
	const { origin, dir } = await makeSiteAndOrigin(t);
	commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');
	const children = [];

	await updateToLatestTrunk({ dir, onChild: (child) => children.push(child) });

	assert.strictEqual(children.length, 2);
	for (const child of children) assert.strictEqual(typeof child.pid, 'number');
});

// stage tells the caller whether incomplete state has to be persisted.
test("updateToLatestTrunk: a failure before anything moves is tagged stage 'fetch' (issue #147)", async (t) => {
	const { dir } = await makeSiteAndOrigin(t);
	const oid = head(dir);
	assert.strictEqual(git(['remote', 'set-url', 'origin', pathToFileURL(path.join(dir, 'does-not-exist')).href], dir).status, 0);

	await assert.rejects(
		() => updateToLatestTrunk({ dir }),
		(e) => e.stage === 'fetch' && /^git fetch failed \(128\): fatal: /.test(e.message)
	);
	assert.strictEqual(head(dir), oid);
});

test("updateToLatestTrunk: a failure after HEAD moves is tagged stage 'checkout' (issue #147)", async (t) => {
	const { origin, dir } = await makeSiteAndOrigin(t);
	// Another client holds the index lock: the fetch and the ref write do not
	// need it, the checkout does, so the failure lands after trunk has moved.
	// (A directory in the way of a new file, the old fixture, is something
	// the real Git's forced checkout simply removes.)
	const newOid = commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');
	fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

	await assert.rejects(
		() => updateToLatestTrunk({ dir }),
		(e) => e.stage === 'checkout' && e.worktreeReset === true
	);
	// The ref moved over the old tree — this is why the caller has to persist.
	assert.strictEqual(git(['rev-parse', 'refs/heads/trunk'], dir).stdout, newOid);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8'), 'first\n');
});

// The pre-checkout half of `stage: 'checkout'`: the ref write can fail with
// every file untouched, here because another writer holds the ref's lock.
test("updateToLatestTrunk: a ref that cannot be written is tagged stage 'checkout' with the worktree untouched (issue #385)", async (t) => {
	const { origin, dir } = await makeSiteAndOrigin(t);
	commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');
	fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'trunk.lock'), '');

	await assert.rejects(
		() => updateToLatestTrunk({ dir }),
		(e) => e.stage === 'checkout' && e.worktreeReset === false
	);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8'), 'first\n');
});

// A fetch failure is the other end of the same contract: nothing moved, so
// nothing the caller holds about the worktree may be discarded.
test('updateToLatestTrunk: a fetch failure reports the worktree untouched (issue #183)', async (t) => {
	const { dir } = await makeSiteAndOrigin(t);
	assert.strictEqual(git(['remote', 'set-url', 'origin', pathToFileURL(path.join(dir, 'does-not-exist')).href], dir).status, 0);

	await assert.rejects(
		() => updateToLatestTrunk({ dir }),
		(e) => e.worktreeReset === false
	);
});
