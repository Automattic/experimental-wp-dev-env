<!--
Title format: [Action] [what] [where or why]
  good — "Fix the patch panel's empty diff after a trunk update"
  bad  — "Fix bug", "Update component", "Changes"

A reviewer should understand this PR in five minutes. Everything above the
collapsed sections is what they read first: keep it short, and put depth in the
<details> blocks rather than deleting it. Delete the sections that genuinely do
not apply — an empty heading is worse than no heading.
-->

## Why

<!-- Two or three sentences. Which of these you are writing depends on the change:

FIXING SOMETHING — what breaks, for whom, and how it is triggered. The error
message, the sequence that produces it, what the contributor sees instead of
what they expected.

BUILDING SOMETHING — what a contributor cannot do today, and what they do
instead. The workaround is the argument: "starting a second ticket means another
clone and another install" says more than "we should support branches". If an
issue already made this case, one line and a link is enough — do not re-argue it.

CHANGING HOW WE WORK — process, tooling, docs. What went wrong often enough to be
worth a rule.
-->

## What changes

<!-- The approach, not a tour of the diff. What you changed at the level of
ideas, and the one or two decisions a reviewer would otherwise have to
reverse-engineer. Alternatives you rejected go in the collapsed section below.

For a fix, name the root cause — not just the symptom that goes away.

For a feature, say what is deliberately NOT in it. A reviewer who cannot tell a
missing piece from a rejected one will ask about every one of them. -->

## How to test this

<!-- Required on every PR, including ones with a green suite — this app fails in
places `node --test` cannot reach. See AGENTS.md for the full shape.

Platforms: any / macOS / Windows — and say why if it is not "any".
Buildkite builds signed artifacts for every branch with an open PR, so this can
be driven on a real machine without a local build. Check the build matches the
current head commit; force-pushing invalidates earlier ones. -->

**Starting state:**

1.
2.

**What must not have happened:**

<!-- The silent regressions. Work quietly discarded, node_modules quietly
rebuilt, a patch quietly missing a file. Name what would be easy not to notice.

Fixing something? Add the steps that used to reproduce the bug, so a reviewer can
watch them fail to reproduce it. And say which test covers it — the standard here
is that a bugfix's test fails on the old code, so name it and say you checked.

Building something? Walk the path a contributor actually takes, not the shortest
path to the new code. Include what happens when they do it wrong. -->

## Risks and limitations

<!-- Known gaps, what you deliberately did not do, what could not be tested by
hand and why. An honest limitation here is worth more than silence — it is the
thing a reviewer would otherwise find and have to ask about. -->

## Related

<!-- Fixes #123 / Part of #123 / Follow-up to #123. Use the GitHub keyword when
this actually closes the issue, so it closes on merge. -->

---

<details>
<summary>Design decisions and alternatives considered</summary>

<!-- Why this shape and not the obvious one. Approaches rejected, and what ruled
them out. If you departed from what an issue asked for, this is where you say so
and why — do not let a reviewer discover it from the diff. -->

</details>

<details>
<summary>Review outcome (required — see AGENTS.md)</summary>

<!-- Counts first, e.g. "3 [fix here] · 1 [follow-up] — all 3 fixed", then what
was fixed and what was deferred with its reason. A deferral is a decision, not
an omission. Put the headline count in one line up in "Risks and limitations" if
it changes how the PR should be read. -->

<!-- Follow "How to report" in .github/instructions/code-review.instructions.md.
For each reviewer, fill in the record below. Use "not run" or "partial" when
appropriate, with the reason or remaining scope; do not turn it into zero findings.
Update the record after subsequent changes have been checked. -->

- **Reviewer:**
- **Review status:** completed / partial / not run
- **Reviewed head SHA / base SHA:**
- **Changes since review:** none / `<previous SHA> → <current SHA>` checked; re-review outcome
- **Evidence:** review link, or local independent review result
- **Outcome:** findings resolved or deferred with reasons; remaining unreviewed scope, if any

</details>

<details>
<summary>Implementation notes</summary>

<!-- Anything a future reader would want and a reviewer does not need up front:
file-by-file detail, benchmarks, upstream quirks, links to the API docs that
settled a question. -->

</details>

<details>
<summary>Screenshots or recording</summary>

<!-- Required for anything with a visible surface — and a new feature almost
always has one. Before and after for a change; a short recording of the flow for
something new, because a still frame cannot show that a ticket switch takes
seconds rather than a rebuild.

Delete this block only if nothing on screen changed, and say so where it was. -->

</details>
