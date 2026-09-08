---
name: self-review
description: Review the current branch against this repo's architecture, security, performance, cross-platform and test-coverage rules before opening a PR. Use when the user asks to self-review, review my changes, check my branch before a PR, or says they are about to open a PR.
---

# Self-review

Run the repo's review standard against the working branch, **before** the PR exists.

Nothing runs this in CI. It is the only automated pass a change gets before a human reads it, which is why it happens now rather than after: a finding fixed here costs one message, the same finding on the PR costs a review cycle.

## Procedure

**Read `.github/instructions/code-review.instructions.md` and follow it.** It is the specification for this task, not background reading — it carries the procedure (establish the diff, run `npm run lint` and `npm test`, then the five dimensions) as well as the invariants and the reporting bar. Do not restate it here; run it.

That file sits under `.github/instructions/` so Copilot code review picks it up natively rather than needing a condensed second copy. It is the only copy of the standard; changes to how reviews work go there, not here.

Two things this skill adds on top:

**Dispatch the judgement pass to a subagent.** Steps 1-2 of the procedure — the diff and the deterministic layer — run inline. Step 3, the five dimensions, goes to an `Explore` subagent given the diff and the instructions file, and nothing else from this conversation. If the session that wrote the code also reviews it, it reviews its own reasoning and finds it sound. Collect the subagent's findings and report them.

**Report in the chat and stop there.** No GitHub comments, no files written — the PR does not exist yet. Then offer; do not apply. The author decides what is a real finding.

## Notes

- Complements the built-in `/code-review` and `/security-review`. What this adds is the repo-specific knowledge: Electron's bundled Node, the bundled Git and its primitives, `electron-store`, loopback binding, the Windows spawn shims.
- If a finding reveals a rule the instructions file does not yet cover, say so. It is meant to accumulate what the project learns.
