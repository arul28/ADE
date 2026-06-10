---
name: quality
description: >-
  Make the code correct, clean, and current. A thermo dual-review: a
  correctness/security track and a maintainability/code-judo track run in
  parallel, then a synthesis step dedupes, severity-ranks (Blocker/High/Medium/
  Low), verifies each finding against the real code, auto-applies the safe
  behavior-preserving fixes, re-reviews, and gates the rest. Grounded in ADE's
  own bug classes (runtime-backed null services, daemon action-domain wiring,
  cr-sqlite CRR, IPC contract drift, fast-tier loading).
---

# Quality Skill

The loop's quality gate: find the bugs, clean up the code. Run after the work is
implemented (`/context → work → /quality`), before `/test`. This skill is
correctness + maintainability only — docs, CLI, TUI, and mobile **parity** are
owned by `/test`'s parity passes, so it does not touch them.

Print a one-line phase status as you go (no banner). Update it after each phase:

```
quality · Phase 1 Thermo Dual-Review → Synthesize + Fix · ACTIVE
```

---

## Execution Model (parallel by default, teams on Claude)

Both tracks run **in parallel**. Reviewers **return findings** (severity +
`file:line` + evidence + proposed fix); they do **not** apply fixes — the
synthesis step owns all edits so dedupe and severity-gating happen in one place.

- **Any runtime** — spawn one agent per track; the lead runs synthesis.
- **Claude Code with agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`,
  already set in `.claude/settings.json`) — realize the tracks as a team, one
  teammate per track, lead runs synthesis. Per the global git-worktrees policy,
  do **not** pass worktree isolation. Never *require* a team to run this skill.

Each reviewer receives the same scoped context: `git diff main` plus the full
contents of the changed files — **including new untracked files**, which
`git diff main` omits — so it evaluates without guessing.

---

## Setup

```bash
git diff main --name-only          # tracked changes vs main
git status --short                 # NEW (untracked) files — git diff omits these
git diff main --stat | tail -20
git log main..HEAD --oneline
```

A new service or module added but not yet committed will not appear in
`git diff main`. Fold the untracked files from `git status` into the review set
and read their full contents — an unreviewed new file is the easiest place for a
Blocker to hide.

---

## Phase 1: Thermo Dual-Review → Synthesize + Fix

### Track A — Correctness & Security (always runs)

Apply both reference files:

1. **`references/correctness-security-review.md`** — diff-scoped audit for bugs,
   changes that break existing features (trace cross-app/IPC side effects),
   devex breakage, and the ADE security surface (computer-use policy &
   artifact ownership, plaintext secrets, runtime action allowlists, sync/CRR
   data integrity). Calibrate severity honestly; never present a finding with
   unfinished research.
2. **`references/ade-review-rules.md`** — ADE-specific correctness: runtime-backed
   null services on bypassed IPC routes, daemon action-domain wiring, cr-sqlite
   CRR constraints, IPC/preload/shared/renderer contract drift, fast-tier
   loading, Node/test-env gotchas, worktree path discipline.

Return prioritized findings. Mark each fix **unambiguous + behavior-preserving**
(synthesis may auto-apply) or **needs human judgment** (synthesis surfaces it).

### Track B — Maintainability (always runs)

Apply **`references/thermo-nuclear-review.md`** — the 7 structural standards:
structural simplification, file-size threshold (1k-line rule), spaghetti
prevention, design over acceptance, direct code, type/boundary clarity,
canonical layer logic.

For each finding: cite `file:line`, name the standard, describe the **judo move**
(the smallest change that resolves it structurally), and mark whether it is
behavior-preserving. This track is the simplification arm — its applied moves
are handled by the synthesis step below, not a separate phase.

### Synthesis (lead step, after both tracks finish)

1. **Collect** all findings from Tracks A and B.
2. **Dedupe** — when both tracks report the same `file:line`/issue, merge into
   one finding and weight it more heavily (overlap = higher signal).
3. **Severity-rank** every finding: **Blocker / High / Medium / Low** (see the
   definitions in `references/correctness-security-review.md`).
4. **Verify before applying.** Findings are advisory, not orders. For each one,
   confirm it against the real code path and adjacent files before touching
   anything. Reject unrealistic edge cases, speculative risks, and fixes that
   over-complicate. A finding you can't confirm in the code is dropped, not
   applied.
5. **Sweep the bug class.** When an accepted finding is a repeated pattern, scan
   the diff scope for sibling instances and fix them together — stop at touched
   surfaces and owner boundaries; no refactor beyond the class.
6. **Apply** the fixes that are **unambiguous and behavior-preserving** — safe
   correctness fixes and Track B judo moves. Every applied change must be
   verifiable by reading the diff; do not change behavior.
7. **Re-review until clean.** If step 6 changed code, re-run Track A on the *new*
   diff. New accepted findings → verify (4), apply (6), re-check. Stop when a
   pass yields no new accepted findings (cap 2 extra passes; anything still open
   goes to the gate). Catches fix-induced regressions before `/test` or `/ship`.
8. **Gate** — do NOT auto-apply Blockers or judgment-call findings. Surface them
   in the report for the author and for `/ship` to gate the merge on.
9. **Reconcile (optional)** — if a PR exists, *after* the independent audit, read
   the PR discussion and review-bot comments (`gh pr view --comments`, or the
   `ade-pr-workflows` skill). ADE's review bots are `@copilot` (first push) and
   `@codex` (later iterations) — never trust a bot finding as fact; confirm each
   against real code, then fold in valid ones and attribute them.

---

## Completion

Output a summary. The **Gate** section is what `/test` and `/ship` consume — list
every Blocker and High finding that was NOT auto-fixed.

```markdown
## Quality Summary

### Thermo Dual-Review
- Findings: [total] (Blocker [n] / High [n] / Medium [n] / Low [n])
- Auto-applied: [count] (safe correctness fixes + structural judo moves)
- Re-review passes: [n]

### Gate (not auto-fixed — for /test regression targets and /ship merge gate)
| Severity | file:line | Finding | Why not auto-fixed |
|---|---|---|---|
| Blocker | ... | ... | needs human judgment / product intent |
| High | ... | ... | ... |

Next: /test (turn each Blocker/High above into a named regression test).
```
