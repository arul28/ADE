---
name: quality
description: >-
  Make the code correct, clean, and current. Opens the PR first so CI and
  review bots run during the review, then harvests their results before it
  finishes. A thermo dual-review: a
  correctness/security track and a maintainability/code-judo track run in
  parallel, then a synthesis step dedupes, severity-ranks (Blocker/High/Medium/
  Low), verifies each finding against the real code, and FIXES EVERY VERIFIED
  FINDING at any severity — re-reviewing only the fix delta, with a cap. Windows parity is a
  default requirement for all new code. Only findings needing a product
  decision, a behavior change this branch was not asked to make, or a
  capability whose Windows parity is not achievable, reach the merge-blocking
  gate. Grounded in ADE's
  own bug classes (runtime-backed null services, daemon action-domain wiring,
  cr-sqlite CRR, IPC contract drift, fast-tier loading).
---

# Quality Skill

The loop's quality gate: find the bugs, clean up the code. Run after the work is
implemented (`/context → work → /quality`), before `/test`. It opens the PR as
its first step so CI and the review bots run while it reviews, and it acts on
their results before it finishes. This skill is correctness + maintainability
only — docs, CLI, TUI, and mobile **parity** are
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

- **Subagent limits.** Follow the **Subagents** rules in `AGENTS.md`. A track
  agent is a leaf: it reviews its track itself and does not start parallel
  reviewers or other subagents. Put that sentence in each track's brief. When
  the user has asked to limit agents, run both tracks yourself, one after the
  other, and the delta re-reviews in step 7 are always yours.
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

**Windows parity is a default requirement, not a conditional check.** Every
change reviewed here must work on the Windows build of ADE. Windows is part of
"done"; it is never a follow-up. Review every changed file for Windows behavior
even when the diff looks unrelated to paths or processes — the regressions that
ship are the ones nobody thought to look for. `references/windows-quirks.md`
holds the concrete failure classes and the named helper that resolves each one;
read it before raising or dismissing a Windows finding.

When parity is **not achievable**, stop and gate it (Synthesis step 8, reason
three). Do not ship a half-working surface and do not quietly gate the whole
product. The decision procedure:

1. **Name the capability**, not the feature. "Native window screenshot capture",
   not "Computer Use".
2. **State the OS-level reason** it cannot work on Windows — the missing API,
   the absent primitive, the security model. "Not implemented yet" is not a
   parity blocker; that is work you owe.
3. **Say what macOS and Linux keep.** If they keep it, this is a per-platform
   divergence the human must approve, not an implementation detail.
4. **Present three options with a recommendation:**
   - **Hidden** — the surface does not exist on Windows. Nothing to discover, no
     explanation given. Right when the capability is not something a user would
     look for.
   - **Disabled with a reason shown** — the control is visible, inert, and says
     why. Right when a user would otherwise hunt for a missing feature, or when
     macOS docs/screenshots reference it.
   - **Removed** — deleted from the Windows build entirely, including its code
     path, settings, and IPC surface. Right when the half-feature carries real
     cost to keep.

   Hidden and disabled are different user experiences, so the human picks **per
   item** — never apply one answer across a batch.
5. **State the blast radius:** which settings, IPC routes, docs, and tests change
   under each option.

When the scoped diff touches filesystem paths, process launch, executable
resolution, IPC, SQLite/native modules, startup services, or Computer Use, these
additional checks apply:

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

## Step 0: Open the PR early

Before the review starts, follow **Early PR and harvests → Open** in
`docs/playbooks/ship-lane.md`: checkpoint commit, push, open the PR ready for
review (not a draft), and write the ship state with `status: "prepping"`. Then
start Phase 1 immediately — do not wait for CI or the bots.

Skip this step only when the branch is `main`, the tree holds changes that do
not belong to this lane, or the user asked for no PR. Say which one applied.
When a PR already exists, push the checkpoint only if HEAD is ahead of the
remote and the push rule allows it. When a ship state file already exists (a
re-run on a lane in `prepping` or `running`), keep its status, iteration, and
handled comment ids; the playbook's Open step 5 says which fields change.

Do not push again while the review runs. Each push restarts Greptile's
15–25-minute review.

---

## Phase 1: Thermo Dual-Review → Synthesize + Fix

### Track A — Correctness & Security (always runs)

Apply all three reference files:

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
   discipline, and the surface coverage sweep (entry points, clients,
   providers, reverse states, connection modes — rule 11).
3. **`references/windows-quirks.md`** — the Windows failure classes ADE has
   actually hit and the named helper that resolves each one. Windows parity is
   a default requirement (see **Windows parity rules** above), so this file
   applies to every diff, not only obviously path-or-process work.

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

**UI primitives (whenever the diff touches `apps/desktop/src/renderer/**`).**
Run `npm run lint:ci` in `apps/desktop`. Every `ade-ui/*` warning in a
file this branch touched is a finding to fix, not just the ones the ratchet
fails on. Fix it by moving to the primitive the message names, then run
`npm run lint:baseline` so the lower count is locked in. Never raise the
baseline to make a violation pass. Then read the touched UI by eye for
hand-rolled notice or dialog styling the lint cannot see: a card that copies
the banner look (tone border plus icon tile) instead of `<Banner>`, a
corner card instead of `showToast`, a custom scrim and panel instead of
`<Dialog>`, a class constant carrying `fixed` or `z-[N]`, a toast
`durationMs` or banner tone that contradicts `docs/design/notices.md`.
Cite the doc section in the finding.

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
   **Capability-claim check.** Treat prose about permissions, timing, provider
   support, lifecycle, or automatic notifications as a claim to verify, not as
   evidence. Find the implementation path and the test that pins it. If the
   behavior is load-bearing and no test pins it, list it for `/test` as a
   coverage gap. Do not add the test in `/quality`. `/test` adds one only when
   it can name the behavior, the failure that turns the test red, and why no
   existing test already catches that.
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
7. **Re-review the fix delta, with a cap.** If step 6 changed code, re-run
   **both mandatory tracks, A and B,** on the *fix delta* — the changes step 6
   made, with the full touched files as context. The rest of the branch was
   already reviewed in this run; do not review it again. New accepted findings
   → verify (4), apply (6), and re-check the new fix delta. This catches
   fix-induced correctness regressions and maintainability debt before `/test`
   or `/ship`.

   **Cap: one full review, then at most two delta re-reviews.** If the second
   delta re-review still finds a Blocker, High, or Medium, fix it and run one
   last delta check. Do not loop further:
   - Fix a Blocker, High, or Medium from the last check, but leave it out of
     the reviewed range: set `qualityReviewedSha` (step 10) to the commit
     before that fix, so the next delta review at push time covers it.
   - List a Low from the last check under **Leftovers** in the summary. It is
     not a gate row and does not block `/ship`.

   A long chain of re-reviews usually chases fix-induced regressions, not real
   progress. The cap never moves a finding to the gate; only step 8's three
   reasons do that.
8. **Gate — the narrow exception, not the escape hatch.** Only three kinds of
   accepted finding may go to the gate unfixed:
   - it needs a **product decision you cannot make** (which of two valid
     behaviors the user wants), or
   - the fix is **not behavior-preserving** and changing behavior is not what
     this branch was asked to do, or
   - **Windows parity is not achievable** for a capability this branch adds or
     touches. Halt and ask; do not decide this one yourself. The row must carry
     the full decision procedure from **Windows parity rules** above: the exact
     capability, the OS-level reason, whether macOS/Linux keep it, and the
     hide / disable-with-reason / remove options with your recommendation. A
     capability that merely *has not been ported yet* is not this reason — that
     is a fix you owe under step 6.

   "Structural", "large", "risky", "pre-existing", "out of scope for this PR",
   and "worth doing deliberately" are **not** gate reasons — those are fixes you
   owe. If you gate a finding, the report must say which of the three reasons
   applies and what decision you need. Anything in the Gate table blocks the
   merge until the author resolves it; `/ship` treats a non-empty gate as a stop.

   A finding you neither fixed nor gated is a bug in your run.
9. **Harvest the PR (mandatory when a PR exists).** *After* the independent
   review, follow **Early PR and harvests → Harvest** in the ship playbook.
   Read whatever CI jobs and review bots (Greptile, Codex, CodeRabbit) have
   finished on the pushed head, and do not wait for the rest. Drop comments
   this run already fixed. Verify each remaining comment like a Track A/B
   finding (step 4), then fix it (step 6) and re-review the fix delta (step 7).
   Rerun each failed CI test file locally. Fix the failures the code causes, and
   pass the failures the test itself causes to `/test`.
10. **Commit and apply the push rule.** Commit the reviewed tree
    (`quality: apply review fixes`) and record its SHA as `qualityReviewedSha`
    in the ship state — but only when every change in that commit passed a
    clean review. When step 7's cap left a final fix unreviewed, keep
    `qualityReviewedSha` at the commit before that fix, so the delta review at
    push time covers it. Stage only this lane's files; never commit changes that
    belong to another lane. When Step 0 was skipped and no ship state exists,
    only commit, print `qualityReviewedSha` in the summary, and do not push —
    `/ship` Phase 0 reads it from the summary. If every signal on the remote head is terminal, run the
    playbook's Commit-bound quality revalidation. When `qualityReviewedSha`
    is HEAD, the delta is empty and this only binds and pushes. When the cap
    left a fix outside it, review that delta first, like any other push. This starts round 2, which runs while `/test`
    works. If a bot is still in flight, hold the commit and let `/test` push
    it.

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
- Reviewed head: `qualityReviewedSha` [sha]
- Leftovers (Low, found by the last capped check): [list | none]

### PR harvest
- PR: #[n] ([opened by this run | existing | skipped — reason])
- CI: [n failed → n fixed here, n passed to /test | all green | n jobs still running]
- Bots: [n comments → n fixed, n already fixed, n rejected with reason | pending: names]
- Push: [pushed [sha], round 2 running | held — [bot] in flight on [sha]]
- For /test: [failing test files caused by the test itself, and coverage gaps from step 4 | none]

### Gate (MERGE-BLOCKING — every row needs an author decision)
Only three reasons belong here: a product decision you cannot make; a fix that
is not behavior-preserving on a branch that was not asked to change behavior; or
a capability whose Windows parity is not achievable. Empty is the expected
outcome. "Structural / large / out of scope" is not a gate reason — those get
fixed above.

When empty, print exactly:

- Empty.

Do not print a table. When non-empty, replace `- Empty.` with a table containing
only real findings and these columns: Severity, file:line, Finding, Which gate
reason, Decision needed. Never leave an example or placeholder row that another
skill could mistake for a live gate. A Windows-parity row's "Decision needed"
cell must state the capability, the OS-level reason, macOS/Linux status, and the
hide / disable-with-reason / remove options with your recommendation.

Next: /test (pass it the "For /test" list and the accepted correctness
findings; it adds a test only where no existing test would catch the bug).

**Before you print this:** every accepted finding is in "Auto-applied", the
Gate section, or (Low from the last capped check only) Leftovers. If one is in neither, go back to step 6 and fix it.
```
