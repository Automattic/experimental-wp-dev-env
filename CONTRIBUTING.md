# Contributing

Much of the work on this project happens with the support of AI coding agents. The quality bar is not held by trusting the agent — it is held by a small set of guardrails, some automated on every pull request, some run by the author before the PR exists. This page is the map of them.

If you are an agent, start with **[AGENTS.md](AGENTS.md)** — it is the canonical, tool-neutral set of instructions. This file is the human-facing companion: what the guardrails are and what you are expected to do before opening a PR.

## Checks that run on every pull request

Three GitHub Actions workflows run on every PR, and also on push to `trunk` so the default branch carries a status a branch-protection rule can require. None needs a secret, and none is credential-gated — everything here is safe to run on a public repository.

### Lint — [`.github/workflows/lint.yml`](.github/workflows/lint.yml)

ESLint over the **whole repo**: `eslint . --max-warnings=0`. A single warning fails the check. The backlog that once made a repo-wide run impractical was cleared (#117), so the check now covers every file rather than only the ones a PR touched.

It installs with `npm ci --ignore-scripts`, which skips lifecycle scripts — so linting **never executes the PR's code** (this repo's `postinstall` would otherwise pull the Electron binary, which the linter does not need). If ESLint flags something mechanical, `npm run lint:fix` handles it; check what it rewrote before committing, since it too is repo-wide.

### Tests — [`unit-tests.yml`](.github/workflows/unit-tests.yml) and [`e2e.yml`](.github/workflows/e2e.yml)

Everything runs on the **two platforms the app ships to, macOS and Windows**:

- **The fast suite** (`npm test`) — and on each platform it runs **twice**, once on the system Node pinned in `.nvmrc` and once on the Node that Electron bundles. That second pass is not redundant: child processes in this app run on Electron's own Node, and the two versions are set independently and have drifted before (#37/#46).
- **The end-to-end suites** (`npm run test:e2e`, and the packaged one) — on every pull request that is not a draft, as two jobs, because one takes seconds and the other packages the app first.

Every matrix uses `fail-fast: false`, so a Windows failure never hides the macOS result.

**[TESTING.md](TESTING.md) is the full picture** — what to run locally, the five layers the suite is made of, where a new test belongs, and how to read a failure. Read it before adding a test.

## The review standard, and who reads it

There is **one** source of truth for how a change is reviewed: **[`.github/instructions/code-review.instructions.md`](.github/instructions/code-review.instructions.md)**. It holds the five review dimensions (architecture, security, performance, cross-platform, tests), this project's specific invariants, and the procedure to run them. It is deliberately the only copy — everything else points at it rather than restating it, so nothing can drift.

Two things consume that one file:

### AI review on pull requests

**CodeRabbit** reviews a pull request when you comment `@coderabbitai review`; automatic review is off because the free open-source plan includes about one review per hour for the whole WordPress organisation. If it answers "Review rate limited", wait the time it names and ask once more. It is a GitHub App installed on the WordPress organisation, so it needs no secret in this repository. [`.coderabbit.yaml`](.coderabbit.yaml) points it at the same review standard the author runs, [`code-review.instructions.md`](.github/instructions/code-review.instructions.md), asks for that file's labelling on every finding, and keeps it to comments: it never approves or requests changes. Talk to it with `@coderabbitai` in a PR comment; `@coderabbitai help` lists the commands. Its "Learnings" live in CodeRabbit's dashboard, not in the repository, so anything worth keeping from there goes into the instructions file.

**Copilot code review** reads `.github/instructions/*.instructions.md` **natively**, selecting files by their `applyTo` glob (this one is `**`, so it applies to every PR). That is the entire reason the standard lives at this path and not somewhere better-named — Copilot follows no links, so a pointer would not have reached it. Copilot is **assigned manually** as a reviewer when a second reader is wanted; it is not automatic.

### The author's own pass — before you open the PR

The author runs the review against their branch **before** the PR exists — because a finding fixed now costs one message, and the same finding on the PR costs a full review cycle. This means running `npm run lint` and `npm test`, then reviewing the five dimensions against the diff.

How you invoke it depends on your agent:

- **Claude Code** ships this as the [`/self-review`](.claude/skills/self-review/) skill. It adds one thing worth knowing: it hands the judgement pass to a **fresh subagent**, given only the diff and the standard. If the session that wrote the code also grades it, it reviews its own reasoning and finds it sound — so the review runs in a context that did not write the change. It reports in the chat and touches nothing on GitHub; you decide what is a real finding.
- **Open-standard agents** (Command Code and others that scan `.agents/skills/`) find the same review as [`/self-review`](.agents/skills/self-review/), a wrapper mirroring the Claude Code one.
- **Any other agent** — no wrapper sits on the path it reads, so there is no `/self-review` command to find. Point it at [`code-review.instructions.md`](.github/instructions/code-review.instructions.md) directly, or just follow the standard yourself. That file is where all the content lives; the skill is only a wrapper over it. If your agent reads a skills directory nobody has wrapped yet, adding a pointer there is a few lines — see [AGENTS.md](AGENTS.md).

## What is *not* a PR gate

Worth knowing so you don't wait on them:

- **Buildkite signed builds** produce Windows, Linux, and macOS artifacts for every branch with an open PR, so a change is testable on a real machine without a local build. Force-pushing a branch invalidates earlier artifacts — check the build matches the current head commit before testing.
- **Download stats** ([`download-stats.yml`](.github/workflows/download-stats.yml)) is a weekly cron that records release-asset counts to a `metrics` branch. It is not related to PR quality.

## Before you open a pull request

In an agent-assisted change your agent runs steps 1–3 — it invokes the review, applies or defers the findings, and drafts the PR summary. Your job is to see that they happen and that the summary is honest; you own the result even though the agent produced it.

1. **Run the review standard** against your branch — [`code-review.instructions.md`](.github/instructions/code-review.instructions.md). In Claude Code that is the `/self-review` skill; on any other agent, follow the file directly.
2. **Fix or consciously defer** every finding — a deferral is a decision, not an omission.
3. **Summarise the outcome in the PR description**: what the checks reported, what you fixed, and what you left as a follow-up and why.
4. **Write a "How to test this" section** — a starting state, numbered steps naming what to click, the expected result of each, and what must *not* have happened. Required on every PR, including ones with green tests: this app fails in places the suite cannot reach, and a reviewer should never have to guess how to drive the change. The shape is spelled out in [AGENTS.md](AGENTS.md#every-pull-request-says-how-to-test-it-by-hand).
5. Open the PR and, when it is ready for review, comment `@coderabbitai review`; CodeRabbit reviews it against the same standard; optionally **assign Copilot** as a further reader.

GitHub fills every new pull request with [the template](.github/pull_request_template.md); steps 3 and 4 have their place in it already. It is built so a reviewer gets the change in five minutes — Why, What changes, How to test this, Risks, Related stay visible and everything deeper goes in a collapsed `<details>` block. Move detail out of the way rather than dropping it. The same template covers a fix, a feature and a process change; it flags the few places where the three want different things.

Nothing enforces steps 1–4. Skipping them means a human reviewer is the first person to read the diff — which is exactly the cost this process exists to avoid.

## The documentation site

The user guide under `docs/` is a VitePress site, deployed to GitHub Pages by `.github/workflows/docs.yml` on every push to trunk that touches it.

It is a **separate npm package** with its own lockfile, so a root `npm ci` does not install it and the commands below fail with `vitepress: not found` until you run this once:

```bash
npm ci --prefix docs
```

- `npm run docs:dev` — live-reloading editing server. Pages are served at their `.html` paths (`/guide/getting-started.html`); the bare directory URL the banner prints does not resolve in dev, only in the built site.
- `npm run docs:build` — what CI runs. It fails on dead links, so run it before pushing.
- `npm run docs:preview` — serves the built site exactly as GitHub Pages will, clean URLs and all. This is the one to check a change against before opening a PR.

Its screenshots are captured by `npm run shots` (see `scripts/screenshots/`), not by CI: the harness launches the app against a seeded, throwaway site registry and photographs each screen at a fixed size. **A PR that changes what a documented screen looks like re-runs `npm run shots` and commits the new images** — nothing automated catches a stale screenshot. Shots the fixture registry cannot reach (a running dev server, a real diff) are listed in the live tier: `npm run shots -- --tier=live` pauses per shot while you set the real screen up, and those images show real paths, so look at each one before committing it.
