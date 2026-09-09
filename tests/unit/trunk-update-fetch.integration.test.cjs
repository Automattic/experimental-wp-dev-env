'use strict';

// Integration tests for updateToLatestTrunk (src/trunk-update.js) — the
// fetch-and-checkout half of the update chain (issue #147). The discard half
// lives in trunk-update.integration.test.cjs.
//
// isomorphic-git cannot fetch from a file:// path, which is why this path was
// verified by hand for so long. It can fetch over plain HTTP, so the fixture
// below serves a real local repository over the smart HTTP protocol on
// 127.0.0.1. Nothing here touches the network: no external host is contacted
// and the sites are cloned from that loopback server.
//
// What the fixture cannot cover, so a manual check against GitHub is still
// worth doing before shipping a change here (as PR #111 did): it always
// answers NAK with a complete pack and ignores `have` negotiation, where a
// real server ACKs and sends a thin, ofs-delta'd pack that isomorphic-git has
// to fix up locally. That layer is exercised by the plumbing below, not by it.

const test = require('node:test');
const assert = require('node:assert');
const nodeHttp = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('isomorphic-git');
const gitHttp = require('isomorphic-git/http/node');
const { updateToLatestTrunk } = require('../../src/trunk-update.js');

const AUTHOR = { name: 'test', email: 'test@example.com' };

// --- git smart HTTP (upload-pack) fixture ---------------------------------
//
// Only what a depth-1 fetch of a single branch needs. Advertising
// `side-band-64k` is not optional: isomorphic-git parses everything after the
// NAK as side-band packets, so a raw packfile would be read as pkt-lines.
// `shallow` is what lets the client ask for `deepen 1` at all.

const FLUSH = Buffer.from('0000');

function pktLine(payload) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

function parsePktLines(buffer) {
	const lines = [];
	let i = 0;
	while (i + 4 <= buffer.length) {
		const length = parseInt(buffer.subarray(i, i + 4).toString('utf8'), 16);
		if (!length) { i += 4; continue; } // flush packet
		lines.push(buffer.subarray(i + 4, i + length).toString('utf8'));
		i += length;
	}
	return lines;
}

// The object set the request is entitled to: the tip's own tree when the
// client sent `deepen 1`, the whole reachable history when it asked for no
// depth. Serving the truncated set either way would hide the difference the
// depth decision makes, which is the thing under test.
async function reachableObjects(gitdir, oid, { depthOne }) {
	const oids = new Set();
	const walkTree = async (treeOid) => {
		oids.add(treeOid);
		const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
		for (const entry of tree) {
			if (entry.type === 'tree') await walkTree(entry.oid);
			else oids.add(entry.oid);
		}
	};

	let hasParents = false;
	const queue = [oid];
	const seen = new Set();
	while (queue.length) {
		const commitOid = queue.shift();
		if (seen.has(commitOid)) continue;
		seen.add(commitOid);
		oids.add(commitOid);
		const { commit } = await git.readCommit({ fs, gitdir, oid: commitOid });
		await walkTree(commit.tree);
		const parents = commit.parent || [];
		if (commitOid === oid) hasParents = parents.length > 0;
		if (!depthOne) queue.push(...parents);
	}
	return { oids: [...oids], hasParents };
}

async function serveRepo(t, gitdir) {
	const uploadPackRequests = [];
	const server = nodeHttp.createServer((req, res) => {
		respond(req, res).catch((e) => {
			res.statusCode = 500;
			res.end(String((e && e.message) || e));
		});
	});

	async function respond(req, res) {
		const url = new URL(req.url, 'http://127.0.0.1');

		if (req.method === 'GET' && url.pathname === '/repo.git/info/refs'
			&& url.searchParams.get('service') === 'git-upload-pack') {
			const head = await git.resolveRef({ fs, gitdir, ref: 'HEAD' });
			res.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
			res.end(Buffer.concat([
				pktLine('# service=git-upload-pack\n'),
				FLUSH,
				// Capabilities ride on the first ref line, after a NUL.
				pktLine(`${head} HEAD\0side-band-64k shallow\n`),
				pktLine(`${head} refs/heads/trunk\n`),
				FLUSH
			]));
			return;
		}

		if (req.method === 'POST' && url.pathname === '/repo.git/git-upload-pack') {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const lines = parsePktLines(Buffer.concat(chunks));
			uploadPackRequests.push(lines);
			const want = lines.filter((l) => l.startsWith('want ')).map((l) => l.split(' ')[1])[0];
			if (!want) {
				res.statusCode = 400;
				res.end('no want line');
				return;
			}
			const depthOne = lines.some((l) => l.startsWith('deepen '));
			const { oids, hasParents } = await reachableObjects(gitdir, want, { depthOne });
			const { packfile } = await git.packObjects({ fs, gitdir, oids, write: false });
			const out = [];
			// A truncated history is announced before the ack; a root commit
			// has nothing to truncate, and a client that asked for no depth is
			// not being truncated, so real servers stay quiet in both cases.
			if (depthOne && hasParents) out.push(pktLine(`shallow ${want}\n`));
			out.push(FLUSH, pktLine('NAK\n'));
			// Band 1 is packfile data.
			for (let i = 0; i < packfile.length; i += 8192) {
				out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(packfile.subarray(i, i + 8192))])));
			}
			out.push(FLUSH);
			res.setHeader('content-type', 'application/x-git-upload-pack-result');
			res.end(Buffer.concat(out));
			return;
		}

		res.statusCode = 404;
		res.end('not found');
	}

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise((resolve) => {
		// close() alone waits for every connection to go; a fetch abandoned
		// mid-response would hang the hook, and node --test has no timeout.
		server.closeAllConnections();
		server.close(resolve);
	}));
	return { url: `http://127.0.0.1:${server.address().port}/repo.git`, uploadPackRequests };
}

// --- fixtures --------------------------------------------------------------

async function commitInOrigin(origin, files, message) {
	for (const [filepath, contents] of Object.entries(files)) {
		fs.writeFileSync(path.join(origin, filepath), contents);
	}
	await git.add({ fs, dir: origin, filepath: Object.keys(files) });
	return git.commit({ fs, dir: origin, message, author: AUTHOR });
}

// An origin repo with a history behind its tip, served over HTTP, and a site
// cloned from it — the state a real site is in after setup, shallow for the
// sites the old engine made and complete for the ones the bundled Git makes.
//
// The history matters: a shallow clone of a repository whose tip is the root
// commit has nothing to truncate, so no `.git/shallow` is written and the
// fixture would not be the shallow site it claims to be.
async function makeSiteAndOrigin(t, { shallow = true } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trunk-update-fetch-test-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const origin = path.join(root, 'origin');
	fs.mkdirSync(origin);
	await git.init({ fs, dir: origin, defaultBranch: 'trunk' });
	const baseOid = await commitInOrigin(origin, { 'readme.txt': 'base\n' }, 'base');
	await commitInOrigin(origin, { 'wp-config.php': 'first\n', 'package-lock.json': '{"lockfileVersion":1}\n' }, 'first');

	const { url, uploadPackRequests } = await serveRepo(t, path.join(origin, '.git'));
	const dir = path.join(root, 'site');
	await git.clone({ fs, http: gitHttp, dir, url, ref: 'trunk', singleBranch: true, ...(shallow ? { depth: 1 } : {}), noTags: true });
	uploadPackRequests.length = 0; // the clone's request is not under test

	return { origin, dir, url, uploadPackRequests, baseOid };
}

// --- tests -----------------------------------------------------------------

test('updateToLatestTrunk: fetches the new trunk commit and resets the worktree (issue #147)', async (t) => {
	const { origin, dir, url, uploadPackRequests } = await makeSiteAndOrigin(t);
	const oldOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
	const newOid = await commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');

	const result = await updateToLatestTrunk({ dir, url });

	// The re-fetch stays shallow. Dropping `depth: 1` costs a contributor the
	// whole of wordpress-develop's history on every update, and nothing else
	// in this file would notice.
	assert.deepStrictEqual(uploadPackRequests.map((lines) => lines.filter((l) => l.startsWith('deepen '))),
		[['deepen 1\n']]);

	assert.strictEqual(result.upToDate, false);
	assert.strictEqual(result.oldOid, oldOid);
	assert.strictEqual(result.newOid, newOid);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8'), 'second\n');
	assert.strictEqual(await git.resolveRef({ fs, dir, ref: 'HEAD' }), newOid);
	const { commit } = await git.readCommit({ fs, dir, oid: newOid });
	assert.strictEqual(result.trunkDate, new Date(commit.committer.timestamp * 1000).toISOString());
});

// The other half of the same decision, and the reason it cannot stay a
// constant (#385). A site the bundled Git cloned is partial, not shallow: it
// has the whole commit history, which is what gives every pull request a
// merge base (#351). Ask for `deepen 1` there and isomorphic-git applies the
// server's `shallow <newTip>` line before the packfile is written, fails to
// read the tip it was just told about, and records the boundary anyway — so
// the first update a contributor runs throws away the history the clone paid
// for. On the old code this test fails on both assertions below.
test('updateToLatestTrunk: a site with full history is not made shallow by the update (issue #385)', async (t) => {
	const { origin, dir, url, uploadPackRequests, baseOid } = await makeSiteAndOrigin(t, { shallow: false });
	const firstOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
	const secondOid = await commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');
	const thirdOid = await commitInOrigin(origin, { 'wp-config.php': 'third\n' }, 'third');

	const result = await updateToLatestTrunk({ dir, url });

	assert.deepStrictEqual(uploadPackRequests.map((lines) => lines.filter((l) => l.startsWith('deepen '))), [[]],
		'no depth is negotiated for a repository that is not shallow');
	assert.strictEqual(fs.existsSync(path.join(dir, '.git', 'shallow')), false,
		'and no shallow boundary is written');

	assert.strictEqual(result.newOid, thirdOid);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8'), 'third\n');
	// The history is still walkable, which is the whole point of the partial
	// clone: the commit the site started on is reachable from the new tip.
	const log = await git.log({ fs, dir, ref: 'HEAD' });
	assert.deepStrictEqual(log.map((entry) => entry.oid), [thirdOid, secondOid, firstOid, baseOid]);
});

test('updateToLatestTrunk: reports upToDate when the remote trunk has not moved (issue #147)', async (t) => {
	const { dir, url } = await makeSiteAndOrigin(t);
	const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' });

	const result = await updateToLatestTrunk({ dir, url });

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
	const { origin, dir, url } = await makeSiteAndOrigin(t);
	const installed = path.join(dir, 'node_modules', 'some-dep', 'index.js');
	fs.mkdirSync(path.dirname(installed), { recursive: true });
	fs.writeFileSync(installed, 'installed\n');
	await git.add({ fs, dir, filepath: 'node_modules/some-dep/index.js' });
	await commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'second');

	await updateToLatestTrunk({ dir, url });

	assert.strictEqual(fs.existsSync(installed), true);
	assert.strictEqual(fs.readFileSync(installed, 'utf8'), 'installed\n');
});

// lockfileChanged compares the two trunk snapshots, and is read before the
// worktree moves. Computing it after the reset would compare the new tree
// against itself and always report false — so the true case below is what
// pins the ordering.
test('updateToLatestTrunk: reports the lockfile change between the two trunk snapshots (issue #147)', async (t) => {
	const { origin, dir, url } = await makeSiteAndOrigin(t);

	await commitInOrigin(origin, { 'wp-config.php': 'second\n' }, 'untouched lockfile');
	assert.strictEqual((await updateToLatestTrunk({ dir, url })).lockfileChanged, false);

	await commitInOrigin(origin, { 'package-lock.json': '{"lockfileVersion":2}\n' }, 'bumped lockfile');
	assert.strictEqual((await updateToLatestTrunk({ dir, url })).lockfileChanged, true);
});

// stage tells the caller whether incomplete state has to be persisted.
test("updateToLatestTrunk: a failure before anything moves is tagged stage 'fetch' (issue #147)", async (t) => {
	const { dir, url } = await makeSiteAndOrigin(t);
	const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' });

	await assert.rejects(
		() => updateToLatestTrunk({ dir, url: `${url}/does-not-exist` }),
		(e) => e.stage === 'fetch'
	);
	assert.strictEqual(await git.resolveRef({ fs, dir, ref: 'HEAD' }), oid);
});

test("updateToLatestTrunk: a failure after HEAD moves is tagged stage 'checkout' (issue #147)", async (t) => {
	const { origin, dir, url } = await makeSiteAndOrigin(t);
	// The new trunk turns `blocked` into a file; the site holds that path as a
	// directory, so the checkout cannot complete but the fetch already has.
	const newOid = await commitInOrigin(origin, { blocked: 'now a file\n' }, 'second');
	fs.mkdirSync(path.join(dir, 'blocked'));
	fs.writeFileSync(path.join(dir, 'blocked', 'in-the-way.txt'), 'x\n');

	await assert.rejects(
		() => updateToLatestTrunk({ dir, url }),
		(e) => e.stage === 'checkout' && e.worktreeReset === true
	);
	// HEAD moved over a partial tree — this is why the caller has to persist.
	assert.strictEqual(await git.resolveRef({ fs, dir, ref: 'HEAD' }), newOid);
});

// A fetch failure is the other end of the same contract: nothing moved, so
// nothing the caller holds about the worktree may be discarded. The
// pre-checkout half of `stage: 'checkout'` — statusMatrix and writeRef, which
// can fail with every file untouched — cannot be provoked portably from here
// (it needs a filesystem permission trick Windows ignores), so the decision
// that hangs off the flag is tested at the caller instead, in
// tests/unit/ipc-wiring.test.cjs.
test("updateToLatestTrunk: a fetch failure reports the worktree untouched (issue #183)", async (t) => {
	const { dir, url } = await makeSiteAndOrigin(t);

	await assert.rejects(
		() => updateToLatestTrunk({ dir, url: `${url}/does-not-exist` }),
		(e) => e.worktreeReset === false
	);
});
