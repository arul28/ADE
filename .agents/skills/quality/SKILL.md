---
name: quality
description: >-
  Make the code correct, clean, and current. A thermo dual-review: a
  correctness/security track and a maintainability/code-judo track run in
  parallel, then a synthesis step dedupes, severity-ranks (Blocker/High/Medium/
  Low), verifies each finding against the real code, and FIXES EVERY VERIFIED
  FINDING at any severity — re-reviewing until clean. Only findings needing a
  product decision, or a behavior change this branch was not asked to make,
  reach the merge-blocking gate. Grounded in ADE's
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

Each reviewer receives the same scoped context: `git diff "$QUALITY_REVIEW_BASE"`
plus the full
contents of the changed files — **including new untracked files**, which
the tracked diff omits — so it evaluates without guessing.

---

## Setup

**Invocation:** `/quality [feature] [--base <ref>]`. `--base` is the explicit
direct-parent binding for a stacked layer. Resolve the base in this order:

1. a validated `--base <ref>` argument;
2. an existing PR's `baseRefName`;
3. the current entry's parent from non-interactive `gh stack view --json`;
4. `ADE_REVIEW_BASE_REF` from a trusted ship state file;
5. `main` for the unchanged ordinary workflow.

Do not stop discovery after reading an existing PR. Still inspect `gh stack
view --json`: a current branch present in that stack makes its PR base exact,
including a bottom layer based on `main`. A PR with a non-default base is also
an exact direct-parent binding. Only an ordinary unstacked PR targeting the
repository default branch keeps `QUALITY_EXACT_BASE=false` and the historical
merge-base behavior. When both PR and stack metadata exist, their parent names
and SHAs must agree.

Normalize `refs/heads/<name>`, `refs/remotes/origin/<name>`, `origin/<name>`, and
plain `<name>` to one plain branch name. Reject another remote, symbolic refs,
revision syntax (`..`, `~`, `^`, `:`), an empty value, or a name that fails
`git check-ref-format --branch`; never concatenate an unvalidated ref into a
command. Fetch the normalized name into its exact remote-tracking ref:

```bash
# QUALITY_BASE_REF is the validated, normalized plain branch name selected
# above. QUALITY_EXACT_BASE is true for --base, stack metadata, or trusted
# stack ship state, a non-default PR base, or a PR confirmed in gh-stack;
# ordinary unstacked /quality against the default branch keeps it false.
git check-ref-format --branch "$QUALITY_BASE_REF"
git fetch origin "refs/heads/$QUALITY_BASE_REF:refs/remotes/origin/$QUALITY_BASE_REF"
QUALITY_BASE_SHA=$(git rev-parse "origin/$QUALITY_BASE_REF")
if [ "$QUALITY_EXACT_BASE" = true ]; then
  git merge-base --is-ancestor "$QUALITY_BASE_SHA" HEAD || {
    echo "stack-coordinator-sync-required: direct parent is not an ancestor of HEAD"
    exit 1
  }
  QUALITY_REVIEW_BASE="$QUALITY_BASE_SHA"
else
  QUALITY_REVIEW_BASE=$(git merge-base HEAD "$QUALITY_BASE_SHA")
fi
git diff "$QUALITY_REVIEW_BASE" --name-only
git status --short                 # NEW (untracked) files — git diff omits these
git diff "$QUALITY_REVIEW_BASE" --stat | tail -20
git log "$QUALITY_REVIEW_BASE"..HEAD --oneline
```

For stack metadata, also require its reported parent SHA to equal
`QUALITY_BASE_SHA`; a name match alone is insufficient. The base must be the
**direct parent** of the current stack entry, not `main`
and not the root of the stack. Record the normalized parent branch, fetched
parent SHA, merge-base, reviewed head SHA, and content-tree SHA. If the parent
cannot be fetched or sources disagree, stop; silently widening or narrowing a
stacked review is not valid evidence. A parent-head or branch change invalidates
this result and every result above it in the stack.

Run quality once per layer against its direct parent. For the fifth/top layer,
also run both review tracks cumulatively against `origin/main`; the layer passes
only when both the incremental and cumulative gates are empty. Record both
bindings. A lower-parent change cascades invalidation through all higher-layer
bindings, so the coordinator must sync/rebase the stack and rerun them in order.

A new service or module added but not yet committed will not appear in
the tracked diff. Fold the untracked files from `git status` into the review set
and read their full contents — an unreviewed new file is the easiest place for a
Blocker to hide.

### Windows parity rules

When the scoped diff touches filesystem paths, process launch, executable
resolution, IPC, SQLite/native modules, startup services, or Computer Use:

- Treat Windows as a first-class runtime. Verify drive letters, native and mixed
  separators, UNC paths, quoting, `PATHEXT` and executable discovery. Audit
  PowerShell, `cmd.exe`, and Git Bash invocation separately for argument loss,
  shell injection, and environment drift. Require process-tree termination,
  per-user/per-channel named-pipe ACL isolation, Stable/Beta identity isolation,
  semantic runtime readiness (not merely a live supervisor PID), stale-PID
  cleanup, bounded supervisor restart/backoff, and packaged native dependencies.
- Trace installer, updater, signing, Windows Firewall, Relay, and capability-gate
  effects. Verify IPC/preload/shared contracts, CLI/RPC, SQLite/CRR, mobile,
  hosted web, and release-manifest compatibility rather than treating a native
  host fix as isolated.
- Require platform gates to state the capability, not infer the whole product
  is unsupported. Native screenshot/video/OS GUI automation may be blocked on
  Windows while App Control and proof-file ingestion remain available.
- Trace the same change through macOS and Linux owners and tests. A Windows fix
  that regresses launchd, Unix sockets, POSIX executable lookup, or graceful
  Linux capability degradation is a correctness finding.
- Separate code-backed evidence from external proof. Native Windows tests and
  CI can prove contracts; installed Stable/Beta isolation, second-account pipe
  denial, clean-host restart, and GUI evidence remain explicit blockers until
  captured on the corresponding hosts.

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
   CRR constraints, mobile-host compatibility, IPC/preload/shared/renderer
   contract drift, fast-tier loading, Node/test-env gotchas, worktree path
   discipline.

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
6. **Apply every finding you accepted in step 4 — all of them, whatever the
   severity.** Verified means valid; valid means fix it. Medium and Low are not a
   backlog, and "behavior-preserving" describes *how* you apply a fix, not which
   findings earn one. This is the entire point of the skill: a run that surfaces
   real problems and leaves them in the code has cost the user tokens and
   returned nothing.

   Fix correctness findings and Track B judo moves alike. If a fix is genuinely
   large (a multi-file extraction, a schema migration), it is still yours to do —
   do it here, in this run, not "as a follow-up".
7. **Re-review until clean.** If step 6 changed code, re-run **both mandatory
   tracks, A and B,** on the *new* diff. New accepted findings → verify (4),
   apply (6), re-check with both tracks again. Stop only when the same pass
   yields no new accepted findings from either track. A re-review count is never
   a reason to defer a verified finding or move it to the gate. This catches
   fix-induced correctness regressions and maintainability debt before `/test`
   or `/ship`.
8. **Gate — the narrow exception, not the escape hatch.** Only two kinds of
   accepted finding may go to the gate unfixed:
   - it needs a **product decision you cannot make** (which of two valid
     behaviors the user wants), or
   - the fix is **not behavior-preserving** and changing behavior is not what
     this branch was asked to do.

   "Structural", "large", "risky", "pre-existing", "out of scope for this PR",
   and "worth doing deliberately" are **not** gate reasons — those are fixes you
   owe. If you gate a finding, the report must say which of the two reasons
   applies and what decision you need. Anything in the Gate table blocks the
   merge until the author resolves it; `/ship` treats a non-empty gate as a stop.

   A finding you neither fixed nor gated is a bug in your run.
9. **Reconcile (optional)** — if a PR exists, *after* the independent audit, read
   the PR discussion and review-bot comments (`gh pr view --comments`, or the
   `ade-pr-workflows` skill). ADE's review bots are `@copilot` (first push) and
   `@codex` (later iterations) — never trust a bot finding as fact; confirm each
   against real code, then fold in valid ones and attribute them.

---

## Completion

Output a summary. The **Gate** section is what `/test` and `/ship` consume, and a
non-empty gate blocks the merge. List only findings you could not fix for one of
the two permitted reasons — not findings you chose to defer.

```markdown
## Quality Summary

### Thermo Dual-Review
- Findings: [total] (Blocker [n] / High [n] / Medium [n] / Low [n])
- Auto-applied: [count] (safe correctness fixes + structural judo moves)
- Re-review passes: [n]

### Gate (MERGE-BLOCKING — every row needs an author decision)
Only two reasons belong here: a product decision you cannot make, or a fix that
is not behavior-preserving on a branch that was not asked to change behavior.
Empty is the expected outcome. "Structural / large / out of scope" is not a
gate reason — those get fixed above.

When empty, print exactly:

- Empty.

Do not print a table. When non-empty, replace `- Empty.` with a table containing
only real findings and these columns: Severity, file:line, Finding, Which gate
reason, Decision needed. Never leave an example or placeholder row that another
skill could mistake for a live gate.

Next: /test (itemize every accepted correctness finding and give each a named
regression test or explicit alternate verification).

**Before you print this:** every accepted finding is either in "Auto-applied" or
the Gate section. If one is in neither, go back to step 6 and fix it.
```
