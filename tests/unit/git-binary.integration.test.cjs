const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BINARY, GIT_VERSION, git, tempDir } = require('./helpers/git.cjs');

// The bundled Git actually runs, from the source tree, on whatever platform
// runs this suite — and `npm run test:electron` repeats it on Electron's own
// Node, which is the one the app will spawn it from. Offline throughout.
//
// These are the checks that catch a trim gone wrong: `files` in package.json
// only affects the packaged build, but the unpacked tree these run against is
// what that trim is applied to, so a helper Git needs that is missing here is
// missing everywhere.
//
// The developer's own ~/.gitconfig is deliberately in play: buildGitEnv has
// to keep it out (a `commit.gpgsign` there would otherwise fail the commit
// below), and nothing here works around it.

test('the bundled binary is present and runs', () => {
	assert.ok(fs.existsSync(BINARY), `${BINARY} is missing`);
	const result = git(['--version'], os.tmpdir());
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.match(result.stdout, GIT_VERSION);
});

test('the exec path Git was told about exists and is populated', () => {
	// On macOS an unset GIT_EXEC_PATH reads back as `//libexec/git-core`; on
	// Windows a wrong one means every subcommand that is a separate helper is
	// "not a git command". Either way the directory has to be there.
	const result = git(['--exec-path'], os.tmpdir());
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.ok(fs.existsSync(result.stdout), `${result.stdout} does not exist`);
	assert.ok(fs.readdirSync(result.stdout).length > 0, `${result.stdout} is empty`);
});

test('neither the host system nor the host global gitconfig is read', (t) => {
	// GIT_CONFIG_NOSYSTEM keeps the host's /etc/gitconfig out and
	// GIT_CONFIG_GLOBAL=/dev/null its ~/.gitconfig; the latter also proves
	// that literal is accepted on this platform. Git reports the files it
	// would read through `config --show-origin`; with both scopes off, the
	// only entries left are the repository's own and the `-c` overrides.
	const dir = tempDir(t, 'toolkit-git-noconfig-');
	assert.equal(git(['init', '-b', 'trunk'], dir).status, 0);
	const result = git(['config', '--list', '--show-origin', '--show-scope'], dir);
	assert.equal(result.status, 0, result.stderr || result.error);
	const scopes = new Set(result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')[0]));
	assert.ok(!scopes.has('system'), `system config was read:\n${result.stdout}`);
	assert.ok(!scopes.has('global'), `global config was read:\n${result.stdout}`);
	assert.match(result.stdout, /command\t.*credential\.helper=$/m);
});

test('a repository can be created and committed to under a path with a space', (t) => {
	const dir = path.join(tempDir(t, 'toolkit git space-'), 'repo dir');
	fs.mkdirSync(dir, { recursive: true });

	assert.equal(git(['init', '-b', 'trunk'], dir).status, 0);
	fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
	assert.equal(git(['add', 'README.md'], dir).status, 0);
	const commit = git([
		'-c', 'user.name=Toolkit',
		'-c', 'user.email=toolkit@example.com',
		'commit', '-m', 'first'
	], dir);
	assert.equal(commit.status, 0, commit.stderr || commit.error);

	const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
	assert.equal(head.stdout, 'trunk');
});
