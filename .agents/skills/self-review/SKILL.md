---
name: self-review
description: Review the current branch against this repo's architecture, security, performance, cross-platform and test-coverage rules before opening a PR. Use when the user asks to self-review, review my changes, check my branch before a PR, or says they are about to open a PR.
---

# Self-review

Run the repo's review standard against the working branch, **before** the PR exists.

Nothing runs this in CI. It is the only review a change gets before a human reads it, which is why it happens now rather than after: a finding fixed here costs one message, the same finding on the PR costs a review cycle.

## Procedure

**Read [`.github/instructions/code-review.instructions.md`](../../../.github/instructions/code-review.instructions.md) and follow it.** It is the specification for this task, not background reading — it carries the procedure (establish the diff, run `npm run lint` and `npm test`, then the five dimensions) as well as the invariants and the reporting bar. Do not restate it here; run it.

That file is the single copy of the standard. It lives under `.github/instructions/` so Copilot code review picks it up natively; every other agent, this one included, reaches it from here. Changes to how reviews work go there, not into this wrapper.

Two things this skill adds on top, both agent-neutral — apply whichever your agent can:

**Run the judgement pass in a fresh context.** The diff and the deterministic layer (`npm run lint`, `npm test`) run inline. The five dimensions should be reviewed by a context that did not write the change — a subagent, or a separate pass given only the diff and the instructions file. If the session that wrote the code also grades it, it reviews its own reasoning and finds it sound.

**Report, don't apply.** Surface findings in the chat. No GitHub comments, no files written — the PR does not exist yet. Then offer; the author decides what is a real finding.

## Notes

- This is the same skill as [`.claude/skills/self-review/`](../../../.claude/skills/self-review/), placed here because agents built on the Agent Skills open standard (Command Code and others) discover skills under `.agents/skills/` rather than `.claude/skills/`. Both are thin wrappers over the one instructions file — neither is a second copy of the standard.
- The repo-specific knowledge this adds over a generic review: Electron's bundled Node, the bundled Git binary, `electron-store`, loopback binding, the Windows spawn shims.
- If a finding reveals a rule the instructions file does not yet cover, say so. It is meant to accumulate what the project learns.
