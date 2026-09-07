---
applyTo: "**"
---

# Automated review rules

What an automated reviewer should look for in this repo, and how to run that review. Written to be read by any agent, not one in particular — this is the single source of truth for the review standard, and it is deliberately the only copy of it.

`AGENTS.md` and `.claude/skills/self-review/SKILL.md` point here rather than restate it. Copilot needs no pointer: it reads `.github/instructions/*.instructions.md` natively, selecting them by matching the `applyTo` glob above against the files in a pull request, so `**` means every PR gets this. That is the whole reason the file lives at this path and not somewhere better-named — a pointer would not have reached it, and a second condensed copy would have drifted. CodeRabbit reaches it through `.coderabbit.yaml`, which loads this file as a code guideline for every non-draft pull request to `trunk`.

The procedure below assumes an agent that can run commands. Copilot and CodeRabbit cannot; they should skip to **Scope** and treat the rest as the standard to review against.

CodeRabbit runs this on every non-draft pull request to `trunk`. It is still the author's pass first, before a human or a bot reads the diff — which is the point: a finding fixed now costs one message, the same finding on the PR costs a review cycle. The producer is responsible for handing over a reviewable change, not the reviewer for reconstructing the context.

## Running the review

**1. Establish the diff.**

```bash
git fetch origin trunk
git diff --stat origin/trunk...HEAD
git diff origin/trunk...HEAD
```

Include uncommitted work if there is any (`git status --short`, `git diff`) — the author is about to commit it, so it is in scope.

**2. Run the deterministic layer first**, so mechanical findings never reach the judgement pass:

```bash
npm run lint
npm test
```

Both are repo-wide and both are clean on `trunk` — the lint backlog was cleared in #117, which is why `lint.yml` runs `eslint .` rather than linting only the changed files. So any failure here belongs to the branch. Report both results plainly.

If ESLint fails, `npm run lint:fix` handles the mechanical part. Check what it rewrote before committing: it is also repo-wide, so a rule that starts flagging untouched files would pull them into the diff. Do not hand-fix what the fixer handles.

**3. Review the five dimensions below.** Read the surrounding files, not just the diff — a diff rarely shows that a helper already handles the case, and the reporting bar requires verifying a finding before asserting it.

Where the tool allows it, run this pass with fresh context — a subagent given the diff and this file, rather than the session that wrote the code. CodeRabbit will run it again on the pull request, but a reviewer that already believes the change is correct is still the main way this pass stops working.

**4. Report, then offer.** Format below. Ask before changing anything: the author decides what is a real finding, which is the whole reason this happens before the PR rather than after.

## Scope

Review **judgement**, not style. ESLint (`eslint.config.mjs`, `npm run lint`) already covers formatting, unused variables, JSDoc, React hooks and the rest of the mechanical layer. Repeating those here buries the findings that matter. When style and process nits share space with substantive findings, authors learn to skim past them — and the substantive findings go with them.

Five dimensions, in priority order: **architecture · security · performance · cross-platform · tests**.

## What this app is

An Electron app that sets up a `wordpress-develop` environment with **zero prerequisites** — no Git, Node, npm or Docker on the host. Everything runs as JS/WASM inside the Electron process. Its users are Contributor Day newcomers on macOS and Windows, often on locked-down machines.

That premise is what most of the rules below protect. A change that quietly reintroduces a host dependency defeats the entire point of the project.

---

## 1. Architecture

Invariants. Breaking one is a `[fix here]` finding even when the code works on the author's machine.

**Child processes run on Electron's bundled Node, never the host's.** Spawns go through `process.execPath` with `ELECTRON_RUN_AS_NODE=1` in the environment (see `runNpmWithEngineRetry` and the `playground:start` handler in `src/main.js`, and `buildChildEnv`). A bare `spawn('node')` or `spawn('npm')` assumes a host toolchain that is not there. On Windows child `npm` processes find a `node` at all only because of the `PATH` shim built by `ensureNodeShimDir` — new spawns must inherit that environment rather than build their own. The one exception is the bundled Git, which is not a Node process and gets its own environment from `src/git-binary.cjs` (next invariant).

**Git is the binary the app ships, never the host's.** Since #364 the app bundles Git through `dugite`, unpacked from `app.asar`. `require('dugite')` appears in exactly one file, `src/git-binary.cjs`; every Git spawn resolves the binary with its `resolveGitBinary`, takes its environment from `buildGitEnv`, its options from `SPAWN_OPTIONS` (which already sets `detached` the way section 4 asks), and starts its arguments with `BASE_ARGS`. That env drops every `GIT_*` variable the host had (dugite would otherwise honour `LOCAL_GIT_DIRECTORY` and `GIT_EXEC_PATH` and run a different Git), turns the host's system and global config off, and turns prompting off, so the host's shell or `~/.gitconfig` cannot change what the app does. A `spawn('git')` that relies on `PATH`, a hand-joined path into the dugite tree, a `GitProcess.exec` outside that file, a Git call given `buildChildEnv`'s environment, or one spawned without an explicit `cwd` is a regression. Parse only porcelain-stable output, with the flag that pins it (`--porcelain=v2`, `-z`, an explicit `--format`); parsing human-facing output is a finding however convenient. `src/git-run.cjs` is the only module that spawns the binary and `src/git-read.cjs` the only one that parses its output (`src/git-write.cjs` reading back the single object id `write-tree` and `commit-tree` print is not a parse); a new read belongs there, with a parser test on fixture bytes, not inline at a call site. Since #384 every read outside the write flows runs on the bundled Git and returns the same shapes the `isomorphic-git` calls returned (status rows included), so a facade signature that changes with the engine is a finding; the new-site clone (`src/git-clone.cjs`) and the ticket-branch writes (`src/ticket-branches.js` over the primitives in `src/git-write.cjs`: stage, commit-tree, update-ref, branch, checkout) run on it too, with `src/git-progress.cjs` as the one place that reads Git's human-facing progress lines, because there is no porcelain for progress; a second parser of those lines anywhere else is a finding. The remaining writes, the trunk update and patch apply, with the reads inside them, still run on `isomorphic-git` until #385 moves them, and patch and diff generation stays hand-rolled in `src/main.js` until the phase that moves it.

**`electron-store` is the only persistence layer.** No database, no sidecar JSON. It holds the site registry and per-site metadata and is the single source of truth for "known sites". A second store, a cache file, or state parked in a module-level variable that outlives a handler is architectural drift — flag it.

**Long-running output streams; it is not returned.** Installs, scripts and the Playground server push output to the renderer through correlated IDs (`installId`, `runId`, `sitePath`) over dedicated channels. See the handler pairs in `src/preload.js`. A new long-running operation that resolves its `invoke()` with accumulated output instead of streaming will look fine on a fast machine and hang the UI on a slow one.

**The renderer↔main boundary is fixed.** New surface means a `contextBridge` entry in `src/preload.js` plus an `ipcMain.handle` in `src/main.js`. `contextIsolation: true` and `nodeIntegration: false` are set on every `BrowserWindow` — the main window and both patch windows — and are not negotiable. Flag any window created without them, and any attempt to widen the bridge by exposing `ipcRenderer` itself rather than named functions.

**Failure paths are part of the architecture.** The users cannot debug: a swallowed error is "the button did nothing" at a Contributor Day, with nobody able to diagnose it. Every spawn handles both `error` and `close` — Node documents that exit events "may or may not" follow a spawn failure, and `runNpmWithEngineRetry` in `src/main.js` shows the expected shape. No silent `catch`: an error that never reaches the renderer's log stream did not happen, from the user's chair. And a setup that dies halfway must leave the site registry consistent — no phantom site in `electron-store` for a directory that was never finished.

**Renderer decisions live in modules, not in `index.jsx`.** `src/renderer/index.jsx` mounts itself at module scope and cannot be loaded without a DOM, so nothing in the suite can reach it: a decision made there is untestable by construction. Anything with more than one branch — a string the user reads, a path joined, a status derived, a command parsed — belongs in a `src/renderer/*.cjs` module with its own test, leaving the component holding JSX, state assignments and the call. `site-folder.cjs` and `open-failure.cjs` are the shape.

This is the direction chosen in #216 over building a DOM harness, which was judged too much setup for the coverage it buys against a 4000-line component. The consequence is that it is enforced here, by review, and nowhere else — `no-unused-vars` catches a module whose last call site is deleted, but nothing catches a second code path that answers the same question inline. That is exactly what #180 was. Reopen the harness question if a bug ever lands in the assignments the modules cannot absorb.

**New dependencies are findings by default.** Native compilation or a host binary breaks the zero-prerequisite promise on user machines. A dependency with lifecycle scripts also needs an `allowScripts` entry in `package.json` — the mechanism already exists, and a missing entry means its install scripts silently don't run.

**Changing the shape of what `electron-store` holds needs a migration path.** Existing users have site registries on disk; a renamed or restructured key silently orphans their sites.

## 2. Security

The threat model is not a hostile user — it is a contributor's laptop on a conference or café network, running a WordPress with `admin`/`admin`.

**Validate what crosses IPC.** Every `ipcMain.handle` argument comes from the renderer and is untrusted input. Paths get used for file operations, URLs get opened.

> Worked example, kept because it shows the shape rather than a single bug: `url:open` in `src/main.js` used to pass its argument straight to `shell.openExternal()`, so `file://` and `javascript:` got through to the OS handler. It now goes through `src/external-url.js`, which refuses anything outside an http/https allow-list and — the part that is easy to miss — hands the OS the *parsed* address rather than the caller's string, because the URL parser strips control characters and a validator that checks one string while the caller opens another has not checked anything. Look for both halves in any new handler that takes a URL or a path.

**Servers stay on loopback.** `src/bind-loopback.js` patches `net.Server.prototype.listen` so Playground's servers bind to `127.0.0.1` instead of every interface. Any new listener that is created before that patch is applied, or that passes an explicit non-loopback host, exposes the contributor's site to the local network. This is what the file exists to prevent — read its header comment before deciding a change is safe.

**Never `shell: true`.** Existing spawns pass `shell: false` deliberately. A shell turns any path containing a space or a quote into a command-injection vector, and contributor directory names are user-chosen. The Windows `.cmd` shim path in `src/win-spawn-patch.js` is the one audited exception; new code should not add another.

**No secrets in the repo, and none in logs.** Pay particular attention to `scripts/azure-sign.cjs` and `fastlane/`. Signing credentials arrive as environment variables and must not be echoed into child-process output, which is streamed to the renderer and written to disk by `electron-log`.

**Untrusted archives and downloads.** Anything unzipped or fetched into a user directory should be checked for path traversal (`../` in archive entries) before extraction.

## 3. Performance

**The main process must not block.** It runs the UI. Synchronous filesystem calls, large `JSON.parse`, or hashing on a path that a handler can reach will freeze the whole window. `fs` sync calls during startup or inside an `ipcMain.handle` deserve a flag; the same call in a one-shot build script does not.

**Log output is unbounded by nature.** `npm install` on `wordpress-develop` produces a lot of it. Watch for per-chunk work that is quadratic, and for buffers that accumulate the full output with no ceiling — see `src/log-lines.js` for how line splitting is done today.

**Work should not scale with the site registry.** Anything that walks every known site, or stats every directory, on each render or each IPC call will degrade as a contributor accumulates sites.

Flag performance only where there is a plausible path to a user noticing it. Speculative micro-optimisation is noise.

## 4. Cross-platform

macOS and Windows are the primary targets; Linux artifacts are published too. CI runs the unit suite on macOS and Windows, but plenty gets past it.

**Paths.** Compose with `path.join` / `path.resolve`, never string concatenation with `/`. Do not compare paths case-sensitively — Windows and default macOS filesystems are case-insensitive. Do not assume a path has no spaces; contributors pick their own directories.

**Killing processes is platform-split.** POSIX relies on the child being a process-group leader (`detached: true`) so the whole tree can be signalled; Windows uses `taskkill /T`. Both live in `src/kill-tree.js`. A new spawn that does not set `detached` correctly, or that is terminated with a bare `child.kill()`, will leave orphaned processes on one platform or the other.

**Windows specifics.** Executables need their extension (`.cmd`, `.bat`, `.exe`) resolved; `EPERM` and `EINVAL` have Windows-specific causes. `src/win-spawn-patch.js` documents the traps that have already bitten — consult it rather than re-deriving them.

**`windowsHide: true` turns on the child's subsystem, not on whether anyone reads its output.** Node sets `CREATE_NO_WINDOW` and STARTUPINFO's "start hidden" together; which of the two the child honors is what differs. A console application takes the first and gets a console that is never displayed — the flashing fix, and why `src/kill-tree.js` sets it on `taskkill` even though nothing reads that output. A GUI application takes the second, and one that passes it through to its first window — Chromium does, so VS Code and Cursor both — launches invisible while the spawn still reports success (#181). So: set it on a console child; leave it off a child whose window is the point. `src/editor-launch.js` is the only case of the second kind.

**Line endings** matter when generating patches, which are destined for Trac.

**Electron's Node version is a real constraint.** It is set independently of `.nvmrc` and the two have drifted before (issues #37 / #46), which is why the suite runs twice. A change that depends on a newer Node API needs to hold on whichever of the two is older.

## 5. Tests

**A new feature or bugfix without a test is a finding.** Not a suggestion in a footer — a finding, with the same severity-and-scope labelling as everything else. The suite is `node --test` over `tests/unit/*.test.cjs`; new tests follow the patterns already there.

**A bugfix's test must reproduce the bug**: fail on the old code, pass on the new. A test written after the fix that never saw the bug proves far less — it pins the current behaviour, whatever that is, rather than the correction. When reviewing a bugfix, check whether the test would actually have caught it.

**Watch for tests that are green while proving nothing.** The known shapes in this repo:

- Mocking the very thing the test claims to verify.
- Asserting implementation details — exact log strings, call order of internals — instead of observable behaviour. These break on harmless refactors and survive real bugs.
- Passing on only one of the two Node runtimes. CI runs the suite on `.nvmrc`'s Node *and* on Electron's bundled Node because the two are set independently and have drifted; a test (or the code under it) that assumes the newer of the two is broken on the other.

**Platform-conditional code needs both branches tested — from one machine.** The house pattern is dependency injection, not skipping: `tests/unit/win-spawn-patch.test.cjs` exercises the Windows paths from macOS by injecting `platform`, lookup and env rather than reading `process.platform`. A new platform split tested with `it.skip` on the other OS is a coverage hole CI will never close, since the suite runs on both platforms but each skips the other's branch.

**Renderer logic is tested through its module, so check it has one.** A PR that puts a branch inside `src/renderer/index.jsx` has written code the suite cannot reach — see the invariant in §1. The finding is the missing module, not the missing test.

**Scope stays proportional.** Missing tests on a touched line of legacy code is `[follow-up]`, not `[fix here]` — the strong rule applies to what the PR introduces, not to everything it brushes against.

---

## How to report

**Every finding carries a dimension, a severity and a scope.**

- Scope is `[fix here]` or `[follow-up]`. Use `[follow-up]` for cross-cutting refactors and anything the PR did not introduce. This gives the author a defensible "noted, separate PR" rather than a finding that looks ignored.
- Severity: 🔴 high, 🟡 medium, 🔵 low.

**Structure**: counts first (`2 [fix here] · 1 [follow-up]`), then one finding per entry carrying its dimension, severity, scope, `file:line`, and what actually goes wrong. Style and process observations go last, grouped and brief — never mixed in among the findings.

Where this runs before the PR exists, that report goes in the chat: no GitHub comments, no files written. Where it runs on a PR, `[fix here]` findings become inline comments on the exact lines and the counts go in a single summary comment, with the style notes in a collapsed `<details>` block.

**On a re-run, reconcile — do not re-review from scratch.** Mark each earlier finding resolved, still open, or obsolete. Re-asserting a fixed finding is the fastest way to get the whole review ignored.

**Say when there is nothing.** "No findings across the five dimensions" in one line is a good review. Do not pad. Do not restate what the PR does — the author knows.

**Verify before claiming.** Read the surrounding file before asserting an invariant is broken; the diff alone often does not show that a helper already handles the case. A confident wrong finding costs more than a missed one.

**Never approve, request changes, or merge.** Post comments only. The human decides.
