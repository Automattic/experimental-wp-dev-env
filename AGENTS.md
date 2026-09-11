# AGENTS.md

Instructions for AI coding agents working in this repository. Tool-neutral and canonical — `CLAUDE.md` points here rather than repeating it.

## Where things are, whatever agent you use

Two files, and neither is specific to one tool despite what their paths suggest:

**The review standard** — [`.github/instructions/code-review.instructions.md`](.github/instructions/code-review.instructions.md). The five dimensions, this project's invariants, the procedure to run them, and the reporting format. Read it directly if your agent has not already.

It sits under `.github/instructions/` because Copilot code review reads that directory natively and follows no links out of it. Anywhere better-named would have meant maintaining a condensed second copy for Copilot, which would drift. CodeRabbit is pointed at the same file by `.coderabbit.yaml`. Every other agent reaches it from here.

**The review as a skill** — a thin `SKILL.md` wrapper over the file above, in two locations because no single skills directory is read by every agent:

- [`.claude/skills/self-review/`](.claude/skills/self-review/) — Claude Code and Copilot. In Claude Code it is `/self-review`.
- [`.agents/skills/self-review/`](.agents/skills/self-review/) — the Agent Skills open-standard path that Command Code and others scan.

Both are pointers to the one instructions file, not copies of the standard. If your agent looks somewhere else again (`.github/skills/`, `.cursor/skills/`, `.codex/skills/`, or its own convention), add a wrapper there or skip it entirely and follow the instructions file — that is where all the content lives. The wrapper only adds two things: run the judgement pass in a fresh context, and report without touching GitHub.

In Codex, `/review` is the built-in user-facing review command. Whenever `/review` runs, read and follow [`.github/instructions/code-review.instructions.md`](.github/instructions/code-review.instructions.md) in full as the review standard. `self-review` is the local skill name, not a Codex command; do not tell users to invoke `self-review`.

There is deliberately no per-tool copy of the *standard*. A wrapper is a few lines that defer to it; duplicating the standard itself is the thing to avoid — if you find yourself doing that, fix the pointer, not the number of copies.

## What this is

An Electron desktop app ("WordPress Contributor Toolkit") that sets up a full WordPress core (`wordpress-develop`) dev environment with zero prerequisites — no Git, Node, npm, or Docker required on the host. Everything is bundled and run as JS/WASM inside the Electron process. Built to fix a Contributor Day problem: newcomers burning the whole session on local setup instead of contributing. Still labeled "experimental."

Its first audience is a first-time contributor with no Git on the machine; an experienced Git user is served second, and only where it costs the first nothing.

## Before opening a pull request

Run the review in `.github/instructions/code-review.instructions.md` against the branch, and fix or consciously defer every finding. Summarise the outcome in the pull request description — counts, what was fixed, what was left as a follow-up and why.

Before reporting a GitHub workflow complete, verify every requested final state on GitHub — for example, distinguish a merged pull request from one that is merely closed, and confirm that an issue was closed by the intended pull request rather than only by a comment.

CodeRabbit reviews a pull request against the same file when asked with `@coderabbitai review`, configured in `.coderabbit.yaml`; automatic review is off because the free open-source plan includes about one review per hour for the whole WordPress organisation. It comments only and never approves. That does not replace the author's pass: a finding fixed before the PR costs one message, the same finding on the PR costs a review cycle, and a human reviewer should not be the first reader of a diff the author never checked.

That file carries the procedure as well as the standard. Follow it rather than improvising a review.

### The pull request description follows the template

[`.github/pull_request_template.md`](.github/pull_request_template.md) is the shape, and GitHub loads it into every new pull request automatically — including ones opened with `gh pr create`, as long as you do not pass a `--body` that replaces it. Fill it in rather than writing your own structure.

The rule it is built around: **a reviewer understands the change in five minutes.** So what stays visible is Why, What changes, How to test this, Risks, Related — and everything else goes in a `<details>` block, collapsed by default. Depth is not the enemy of a readable PR; depth *in the way* is. Do not delete detail to hit the five minutes, move it.

**One template, not one per kind of change.** GitHub shows no picker when a pull request is opened — selecting among several requires appending `?template=name.md` to the URL, which nobody remembers, so the default loads anyway. The template is written to serve a fix, a feature and a process change equally, and calls out the three places where they genuinely differ: a fix names its root cause and the test that fails without it, a feature names what it deliberately leaves out and shows its surface, and either way the testing steps follow the path a contributor actually takes.

That includes the review outcome AGENTS.md requires below: it lives in a collapsed block, with the headline count surfaced in **Risks and limitations** when it changes how the PR should be read.

Titles are `[Action] [what] [where or why]` — "Fix the patch panel's empty diff after a trunk update", not "Fix bug".

If the diff is over ~800 lines, the first question is whether it should be two pull requests. A stacked pair reviews faster than one that nobody wants to start.

### Every pull request says how to test it by hand

A **How to test this** section is required, not optional, and a green test suite does not replace it. This app's failures live where the unit tests cannot go: a real clone of `wordpress-develop`, a `node_modules` that takes minutes to install, an OS file dialog, a Windows path with a space in it. The suite proves the logic; only a person driving the app proves the feature.

Write it for someone who did not write the change and does not know where the button is. That means:

- **A starting state.** "A site with a linked ticket and an uncommitted edit", not "a site". Say how to reach it if it is not the state the app opens in.
- **Numbered steps naming what to click**, in the words on screen.
- **The expected result after each step that has one**, stated so it can come out false. "The patch contains only `wp-login.php`" — not "the patch looks right".
- **What must NOT have happened.** Most of this project's regressions are silent: work quietly discarded, `node_modules` quietly rebuilt, a patch quietly missing a file. Name the thing that would be easy not to notice.
- **The platforms it needs.** Default to "any" and say so; call out macOS or Windows explicitly when the change touches paths, spawning, line endings, or signing. Buildkite builds signed artifacts for every branch with an open PR, so a reviewer can test on a real machine without building — check the build matches the current head commit, since force-pushing invalidates earlier ones.
- **What cannot be tested by hand, and why.** An honest "the mid-switch recovery needs a checkout to fail part-way, which I could not stage" is worth more than silence.

**A journey can carry this section, and when one does, do not also write out the clicks.** "A green test suite does not replace it" is about the unit suite, which never opens a window; a layer-4 journey drives the same app through the same flow a person would, on both platforms, on every non-draft pull request. So when the change is covered by a journey that walks the reported path, name that journey and the command that runs it, say it is red without the change, and spend the section on what the journey cannot reach instead — a real `wordpress-develop` clone, an `npm install` that takes minutes, an OS dialog, a Windows path with a space. A bug that lives in none of those is one a person does not need to reproduce by hand. Writing the journey is the better use of the same effort, and [TESTING.md](TESTING.md) says which ones belong in the default suite.

If a change genuinely has no user-visible surface — a refactor, a CI fix — say that, and give the command that demonstrates it instead. The section is never simply absent.

For the human-facing version of all this — the CI checks each PR runs and the guardrails in prose — see [`CONTRIBUTING.md`](CONTRIBUTING.md). It points back here; it does not restate the standard.

## Markdown in this repository

**Do not hard-wrap prose. One paragraph is one line, however long.** Markdown imposes no line limit — a wrapped paragraph and a single long line render identically — so the wrapping is a convention, and this repository's convention is not to. Every `.md` here follows it: `README.md`, `docs/`, this file, `TESTING.md`, `CONTRIBUTING.md`, the review instructions and the templates.

The reasons are editing, not rendering. A long line reflows to whatever width the reader's editor or screen has, it pastes into an issue or a chat without arriving pre-chopped, and a one-word edit does not reshuffle the six lines beneath it into a diff that claims they changed. The cost is a diff that marks the whole paragraph as changed; `git diff --word-diff`, and GitHub's own intra-line highlighting, both narrow that back down to the words.

Line breaks still mean something everywhere else, and none of this touches them: list items, table rows, headings, fenced code, VitePress `:::` containers, YAML frontmatter and the body of an HTML comment all keep the shape they have.

## Commands

See `package.json` scripts. To run a single test file (not exposed as a script): `node --test tests/unit/azure-sign.test.cjs`.

Do not run Electron or E2E tests from a worktree without its own `node_modules`. Install dependencies in that worktree first, and do not rely on `NODE_PATH` from another worktree for Electron tests.

Prefer the simplest fix for reproducible user-facing failures. Do not add defensive state or branches for hypothetical edge cases unless a test demonstrates a realistic path.

**Scope guards by what the app itself can do.** A state the app cannot produce through its own flows is out of scope by default: a rebase, a multi-commit cherry-pick or a `git am` left half done from a terminal, a checkout adopted from a linked worktree. The app must not destroy such a state when it meets one (#352), and saying "I do not understand this repository" is a valid answer; modelling each one, or offering to finish it, is not. Prefer one honest refusal over a family of cases, and record the cases you deliberately left out in the PR's Risks section rather than as issues.

**[TESTING.md](TESTING.md) is the canonical description of the suite** — the five layers it is made of, which one a new test belongs in, what each layer is blind to, and how to read a failure. Read it before adding or moving a test; do not restate it elsewhere.

When writing manual test instructions, inspect the current renderer flow first and distinguish actions that happen automatically after linking a ticket from controls used only to retry or refresh them. Do not tell a tester to click a control when the app already starts that operation.

Every command you hand a person names the directory to run it from, or says that it does not matter. Every manual pass you ask for names the platform, Windows or macOS, or says that either works, and the exact build it runs against: the Buildkite build number and commit, or "the current head". A tester who has to ask either question has already lost the round trip the instructions were meant to save.

When asked to add an existing pull request to an existing stack, preserve its commits and change its base to the head branch of the current top PR. Do not move commits into an earlier PR unless the user explicitly asks to rewrite the stack.

## Architecture notes (non-obvious)

- **Child processes run on Electron's own Node, not the system Node.** `npm install`, `npm run <script>`, and the Playground server are spawned via `process.execPath` + `ELECTRON_RUN_AS_NODE=1` — this is the mechanism behind "zero prerequisites." On Windows this requires shimming `node`/`npm`/`npx` into `PATH` so child `npm` processes can find a `node` binary at all.
- **Git has no host dependency.** The app ships its own Git binary via `dugite` (#364), unpacked from `app.asar` and resolved only through `src/git-binary.cjs`, which also builds the environment it runs with (host system and global config off, prompting off, no `GIT_*` variable inherited from the host and nothing from a Node child). `require('dugite')` lives in that one file; `src/git-run.cjs` is the only place the binary is spawned, and `src/git-read.cjs` holds every read and its parser. Spawning a `git` found on `PATH`, or calling dugite's `GitProcess` from anywhere else, is a regression. As of #384 every read outside the write flows (status, branches, history, blobs, the patch walk) runs on the bundled binary, and since #385's first flow so does the new-site clone (`src/git-clone.cjs`: partial, `--filter=blob:none`, repo config written at clone time); Ticket branches (park, start, switch, delete, and the move onto the current trunk, one three-way `merge-tree` of the single WIP commit read in `src/git-read.cjs` and committed by the primitives) write through `src/git-write.cjs`, one Git command per primitive, with the checkout's progress read by `src/git-progress.cjs`, the single parser of Git's human-facing lines that the clone shares; the trunk update (`src/trunk-update.js`: fetch from the site's own `origin`, update-ref, forced checkout; the two discards: forced checkout plus `clean -fd`) writes through the same primitives, with `streamGit` in `src/git-run.cjs` as the one runner for the commands that report progress; patch apply and revert (`src/patch-apply.js`) run on `git apply` through the same primitives, all or nothing by Git's own rule, with the Trac path rewrite, the per-hunk wording of a refusal and the snapshot that undoes a half-written apply kept in JS and never writing on their own. Since #386 the app has one Git engine: `isomorphic-git` is gone from `package.json` (it reaches the bundle only as a transitive dependency of `@wp-playground/storage`), and every test fixture is built by the bundled binary. The suites that used to build theirs with the old engine go through the fixture layer in `tests/unit/helpers/git.cjs`; the suites that cover a single primitive (`git-read`, `git-write`, `git-clone`, `git-run`, the fetch suite) still call the binary directly, because a fixture built by the layer above the primitive under test would beg the question. A site the old engine cloned (shallow, no `remote.origin.promisor`) is detected by `isLegacySite` in `src/git-read.cjs` and refused by every write handler in `main.js` through `legacySiteBlock` (`code: 'legacy-site'`); only reads, the patch export of the checked-out branch, opening a pull request and deletion still work there, and the sentence both sides show lives in `src/renderer/legacy-site.cjs`. A merge, rebase, cherry-pick, revert or three-way apply started outside the app and left unfinished is read by `mergeInProgress` in `src/git-read.cjs` (the `u` records of `status --porcelain=v2` plus the head files and rebase directories `git status` itself reads under `.git`, never remembered in process) and refused by `mergeInProgressBlock` (`code: 'merge-in-progress'`) in front of the trunk update, both discards, linking and unlinking a ticket, switching, the move onto trunk, applying and reverting a patch, and deleting the ticket that is checked out; the sentence naming the files and the terminal commands that end it lives in `src/renderer/merge-in-progress.cjs`, and the app offers no action of its own for it (#352). Only porcelain-stable output (`--porcelain=v2`, `-z`, explicit `--format`) is ever parsed. Patch/diff generation is done by hand in `main.js`, not `git diff`: one status scan against the branch point each ticket recorded (#108), nothing staged, and `/dev/null` naming whichever side of an addition or a deletion does not exist — the app reads its own patches back when a mentor applies one, and that filename is the only thing its parser reads an add or a delete from (#85).
- **`electron-store` is the only persistence layer** — no separate DB. It holds the site registry and per-site metadata; treat it as the single source of truth for "known sites." **Nothing may yield between reading the store and writing it back.** The `get` and `set` are synchronous, so the event loop is the only thing serialising writers, and it only serialises them while nothing awaits in between. A writer that reads, awaits anything, and then writes what it read hands back a snapshot another writer has moved on from, and that writer's change is gone (#172). The value that made it matter is a ticket branch's recorded base, the one thing a branch cannot recompute. Handlers that write a fixed set of top-level keys do this inline and are fine as they are; a change that has to be computed from the record, or that replaces a nested map such as `branches`, goes through `changeSiteMeta` in `src/main.js`, which takes a function of the record and applies it at the moment of the write. Computing that value from an earlier read is the bug, whichever helper writes it.
- Long-running child-process output (installs, scripts, server) is streamed to the renderer via correlated IDs (`installId`/`runId`), not returned synchronously — expect async event handlers, not return values, when tracing that flow.

## Signing & CI

- **Buildkite builds signed Windows, Linux and macOS artifacts for every branch that has an open PR.** So a branch is testable on a real machine without building locally — and for a stacked PR, the artifact from the topmost branch exercises the whole stack. Force-pushing a branch invalidates earlier artifacts: check the build corresponds to the current head commit before testing.
- Windows signing (Azure Trusted Signing via `scripts/azure-sign.cjs`) is skipped automatically when its required env vars aren't set — this is intentional for local dev, not a bug.
- macOS signing/notarization uses fastlane + match against Automattic's Developer ID; `verify_code_signing` lane must pass before shipping.
