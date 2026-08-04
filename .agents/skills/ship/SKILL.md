---
name: ship
description: >-
  Autonomous PR-to-merge loop. Polls CI and review bots, fixes failures, rebases
  only on real conflicts, and lands the PR on main. Soft cap of 5 normal
  iterations plus one force-finalize iteration that bypasses review and fixes
  only CI. Pure loop — it does not replace the baseline /quality or /test runs;
  run those first. It does revalidate quality after any ship-loop mutation so
  the final result is bound to the exact reviewed PR head and content tree.
  Opt-in --stack-ready runs the same loop for one layer of a coordinator-owned
  stack: it fixes and pushes its own layer but stops at ready-stacked instead of
  merging, rebasing, or running any gh stack command. Full phase logic lives
  in docs/playbooks/ship-lane.md.
---

# Ship Skill — Autonomous Merge Loop

Drive the current lane from "work is ready" to "merged on main" without manual
shepherding. **Pure loop:** `/ship` assumes you already ran `/quality` and
`/test` — it does not bundle them. It polls, fixes CI + review, rebases only when
there's a real conflict, and merges. It does not exit until the PR is merged or
the merge is genuinely blocked by repo policy.

Print a compact status line each iteration (no banner):

```
ship · iter 2/5 · PR #184 · POLL → DECIDE → FIX → MERGE · FIXING CI (test-desktop 3) + 2 comments
```

Stack mode prints the layer and its terminal instead of `MERGE`:

```
ship · stack 12 layer 2/5 · iter 2/5 · PR #1007 · POLL → DECIDE → FIX → READY · FIXING CI (windows-foundation) + 1 comment
```

**Invocation:** `/ship` (auto-detect state), `/ship <pr-number>`, or the opt-in
`/ship --stack-ready [<pr-number>] --base <direct-parent-branch>`.

### Stack-ready mode (opt-in only)

`--stack-ready` drives one layer of a coordinator-owned stack to *ready*, not to
*merged*. It is the same loop — Phase 0 through Phase 5, the same poll/fix
machinery, the same 5-iteration budget — with merging and every stack-wide
operation removed. Resolve the direct parent from `--base`, an existing PR's
`baseRefName`, then non-interactive `gh stack view --json`; normalize it with
the `/quality` rules. Persist `mode: "stack"` plus the complete stack binding:
stack number, size, position, expected parent branch, validated head SHA, base
SHA, content-tree SHA, test-evidence SHA, required and deferred proof scenarios,
proof links, and quality/test status.

**The lane owns its layer; the coordinator owns the stack.** The lane commits
and pushes its own layer branch, opens its PR against the resolved direct parent
when none exists, polls CI and review bots, fixes red CI and verified findings on
its own layer, reruns commit-bound quality revalidation against the exact
resulting head, and repeats until the layer is genuinely clean. A red check on
its own code is work to do, not a reason to stop.

The lane never merges, never enables auto-merge, never deletes a branch, never
rebases or restacks (`git rebase`, `gh stack sync --remote origin`, `gh stack
rebase --upstack --remote origin`, `gh stack push --remote origin`, and `gh
stack submit --auto --remote origin` are all coordinator-only), never retargets
a PR base, never touches another layer's branch or files, and never enters
force-finalize or any bypass-review path. Before any cap, force-finalize,
rebase, merge, or branch-deletion decision, branch on `mode == "stack"`.

Escalate only what the lane genuinely cannot do, with exact evidence:
`stack-coordinator-sync-required` (a restack or base retarget is needed — the
parent moved, a lower layer changed, or the PR base is not the direct parent),
`stack-coordinator-fix-required` (the fix belongs to a lower layer, or the
iteration budget is spent and the layer is still red),
`stack-coordinator-pr-required` (the parent branch is missing on `origin`, or PR
creation failed on auth or an unusable base ref), and
`stack-coordinator-merged` (the coordinator already landed it). The playbook's
**Stack escalation states** table is authoritative. None of them is a general
stop at the first red check.

Write `status: "ready-stacked"` only when the exact head is green,
review-terminal, quality-clean, test-clean, and every mandatory proof scenario
either has a current evidence link bound to the validated head or is recorded in
`deferredProofScenarios` against a named higher layer that exists in this stack.
The top layer defers nothing, and cumulative clean-host/cross-client/release
scenarios never masquerade as lower-layer evidence. A known-missing mandatory
scenario is `blocked` with the scenario ids listed — never `ready-stacked` with
a caveat. Missing or ambiguous stack metadata is `blocked`, not a fallback to
`main`.

Without `--stack-ready`, every existing `/ship` default and merge behavior is
unchanged: the base is `main`, green work proceeds through Phase 3c, and the
terminal success state is `done-clean` only after merge confirmation.

---

## Source of truth

**Follow `docs/playbooks/ship-lane.md`** — all phase logic, the state schema,
commands, decision rules, and bot-ping rules live there. This skill is the
runtime-neutral entrypoint and the ADE-specific deltas below. If re-invoked by a
scheduled wake, read the state file first; if `status == running`, skip Phase 0
and go to Phase 1. If `status == ready-stacked`, revalidate the complete binding
first: when it holds, print the persisted coordinator handoff and exit without
scheduling or mutating anything; when it is stale, external movement exits
`stack-coordinator-sync-required` and this lane's own newer head re-enters the
loop at Phase 1.

The playbook's Phase 0 is **checkpoint → commit-bound quality revalidation →
push → open PR**. Baseline test generation and the local-CI gate are NOT part
of ship — that's `/test` (and optionally `/finalize`) before you reach this
skill.

## Precondition: `/quality` must be empty and bound to the final tree

Before Phase 0, require a completed `/quality` result with an empty gate. Before
Phase 3c, run the playbook's single canonical **Validate the current quality
binding** procedure. It binds the reviewed head, content tree, and base so
GitHub's squash/merge/rebase result has the reviewed tree. Green CI on a later
head or base does not preserve this binding.

A non-empty gate **blocks the merge** — every row in it is a finding that was
verified as real and left unfixed, and by `/quality`'s contract the only three
things that may be there are a product decision the author owes, a behavior
change this branch was not asked to make, or a capability whose Windows parity
is not achievable. All three need the author.

- Gate rows exist → do not merge. Surface them, state the decision needed, and
  stop with `blocked`. Do not merge and mention them afterwards.
- If `/quality` was never run on this lane, or its final gate result is not
  available in the lane handoff, stop with `blocked`; unknown is not empty.
- Any base movement, rebase, conflict resolution, Phase 3b edit, or
  force-finalize edit clears all three quality binding fields. In stack mode,
  this lane's own Phase 3b edit clears them and is rebound by revalidation on
  the head it then pushes; external movement of the parent, base, or head
  instead clears the complete stack binding and returns
  `stack-coordinator-sync-required` without rebasing. Run the
  playbook's single canonical **Commit-bound
  quality revalidation** procedure before pushing that mutation.
- Never enter Phase 3c with a missing or mismatched binding. Revalidate first;
  do not merge and disclose stale quality evidence afterwards.
- Bind every normal or admin merge attempt with
  `--match-head-commit "$QUALITY_VALIDATED_SHA"`. Persistent auto-merge is not
  allowed because a later push can replace the validated head while it remains
  armed.
- GitHub creates a new commit for squash/merge/rebase. The validation claim is
  deliberately about its exact content tree, not its not-yet-created commit
  OID. After merge, run the playbook's canonical **Confirm the validated merge
  result** procedure; a mismatch is never `done-clean`.

Severity is irrelevant here: a Medium in the gate blocks exactly as hard as a
Blocker, because presence in the gate means it needed a human, not that it was
minor.

---

## Execution Mode: Autonomous

Runs end-to-end without user interaction. Do NOT ask to confirm/choose/approve,
pause between phases, or ask whether to apply a fix — apply, verify, commit. The
only user-visible output is the per-iteration status line and the final summary.

---

## Repo facts (ADE)

- **Package manager:** `npm`; each app under `apps/` has its own `node_modules` +
  `package-lock.json` (no workspaces). Node 22 (`.nvmrc`).
- **CI:** `.github/workflows/ci.yml` — desktop tests shard **8-way**
  (`npx vitest run --shard=<n>/8`) plus `test-ade-cli`; a `ci-pass`/`ci-status`
  gate aggregates required jobs. Discover the required-check list live via
  `gh pr checks` / the `ade-pr-workflows` skill — do not hardcode.
- **PR creation:** prefer the `ade` CLI (registers the PR in ADE's tracking — lane
  ↔ PR link, check/comment inventory). `gh pr create --base main --head <branch>
  --fill` is the ordinary fallback; stack mode substitutes the persisted direct
  parent for `main`. See the playbook's discovery protocol.
- **State file:** `.ade/shipLane/<branch-with-slashes-as-__>.json`. `status`:
  `running` | `ready-stacked` | `done-clean` | `done-max` | `blocked`; it also
  records `mode` and the complete stack binding. Rebase rebates the iteration counter by 2
  (floor 0).

**Windows parity gate.** Windows parity is a default requirement for all new
code, so this gate runs on **every** lane, not only Windows-labelled ones.
Before Phase 3c (or `ready-stacked`), confirm the branch's behavior works on the
Windows build. If any capability on this branch cannot work on Windows and the
human has not already chosen what to do about it, **stop with `blocked`** — this
is the one product decision `/ship` never makes for itself, and force-finalize
does not clear it. `/ship` is autonomous, so "ask" here means exit blocked with
the question stated, not pause mid-loop. The blocked summary must give, per
capability:

1. the exact capability that cannot work and the OS-level reason;
2. whether macOS/Linux keep it;
3. **hidden** (absent on Windows) vs **disabled with a reason shown** (visible,
   inert, explained) vs **removed** (deleted from the Windows build), with your
   recommendation.

Hidden and disabled are different user experiences; the author picks per item.
A `/quality` gate row with reason three carries this content already — surface
it verbatim rather than re-deriving it. Never merge a lane whose Windows
behavior is unknown; unknown is not parity. Failure classes and the canonical
helpers: `../quality/references/windows-quirks.md`.

**Windows proof gate.** For a Windows-relevant stack entry, require the native
Windows foundation check to be terminal-green on the bound head. Require the
packaged Windows check when packaging or native bundle contents changed.
Computer Use evidence is capability-specific: native OS capture/control may be
explicitly blocked while App Control and proof ingestion remain supported and
tested. Clean-host Stable/Beta coexistence, second-account pipe denial,
restart/reboot, installed-update, and GUI artifacts remain named external proof
blockers until captured; never mark them proven from simulated tests. A stack
entry cannot reach `ready-stacked` while any of them is required at its position
and still uncaptured — record it as `blocked` with the scenario id, or defer it
to a named higher layer in `deferredProofScenarios`.

---

## ADE deltas to the playbook

**Every push restarts the review bots — Greptile especially.** Pushing a new
commit re-triggers Greptile and Codex from scratch; an in-progress Greptile
review (`Greptile Review` status stuck `pending`/`IN_PROGRESS`, often 15-25 min)
is *cancelled and restarted* by the next push, so a rapid fix-every-iteration
cadence means Greptile never actually lands a re-review. Consequences:
- **Batch all fixes for an iteration into ONE push**, then genuinely wait for
  Greptile to reach a terminal state before pushing again. Do not push a follow-up
  while its status check is still `pending` — you'll just reset its ~20-min clock.
- Codex re-reviews fast (~3-5 min) and tends to surface the *next* instance of a
  bug class each round (e.g. you pinned 2 of 4 cleanups → it flags the other 2).
  **Sweep the whole class in one iteration** (every cleanup pinned, every mutating
  call guarded) so you don't trade N fast Codex rounds for N Greptile restarts.
- When deciding to merge: a perpetually-restarted Greptile that never completed
  on the latest commit is not a "still reviewing" signal to wait on forever — it's
  a signal you pushed too often. Once Codex is clean and CI is green on a commit
  you have NOT pushed over, let Greptile finish that commit, then merge.

**No bot signal means off, not pending.** A review bot blocks Phase 1 only when
there is positive evidence that it started for the current head: a
queued/pending/in-progress check, a review, a trigger acknowledgement, or a
current-head comment. After one full 12-minute post-push grace window, if every
available ADE and GitHub surface shows no check, review, acknowledgement, or
comment for that bot, classify it as `inactive` / `not-triggered`, treat that as
terminal-neutral, and continue. Record it under `inactiveReviewBots`, never
`pendingReviewBots`. Do not schedule a second wait for a bot with zero evidence.
If branch protection requires an absent check, Phase 3c will surface that as a
merge-policy block.

**Rebase only on real conflicts or a stale quality base.** `behindBase` alone
does not normally trigger a rebase. The one safety exception is base movement
after quality validation: the final tree is no longer the reviewed head tree,
so ordinary merge mode rebases and reruns the canonical quality procedure even
when GitHub reports a clean merge. Stack mode instead invalidates the current
and upstack bindings and returns `stack-coordinator-sync-required`; it never
rebases and never pushes another layer, though it does push its own layer branch
in Phase 0 and Phase 3b. Otherwise, skip needless rebases.

**Bot pings by iteration.** Never ping GitHub Copilot and never treat Copilot as
an expected review signal; quota exhaustion otherwise leaves the loop waiting
forever. Initial PR pushes do not need a direct review ping. Subsequent
fix-iteration re-pushes → `@codex review`. For a >250-file diff, also ping
`@greptile` and `@coderabbit` (separate comments). Phase 1 still waits for the
expected review signals to settle before fixing. This is the playbook's Phase 4
rule — defer to it for exact bodies.

**Merge needs admin.** `main` is ruleset-guarded —
`gh pr merge --squash --match-head-commit "$QUALITY_VALIDATED_SHA"` will show
BLOCKED. Retry with
`gh pr merge --admin --squash --match-head-commit "$QUALITY_VALIDATED_SHA"`;
the ruleset's non-linear-history rule can still reject `--admin`. Do not fall
back to a locally-created commit: it would not be the reviewed and CI-tested PR
merge result. Exit blocked if both direct `gh` paths fail. After a successful
merge, run **Confirm the validated merge result**. Do NOT
pass `--delete-branch` (it fails from a worktree); delete the head ref server-side via
`gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/<branch>"`.

**Fix discipline (every fix agent must follow):** (1) Fix CI and review together
in one push, only after BOTH signals are terminal — review fixes routinely cause
new CI failures. (2) Never run a full vitest shard or the whole suite inside the
loop; run only the failing test file or the touched package's check. This is the
playbook's "Fix discipline" block — cite it to every ci-fix / review-fix agent.

**Worktree path discipline.** Every `Edit`/`Write` MUST target the lane worktree
path (`.ade/worktrees/<lane>/...`). After edits and before commit, `git status`
from the worktree — if it's empty but you "just edited," you wrote to the wrong
tree.

---

## Concurrency

Use `TeamCreate` if available (one team, reused across iterations: a poll agent,
plus ci-fix / review-fix / rebase / conflict-resolver agents spawned on demand);
per the global git-worktrees policy, do **not** pass worktree isolation. Fallback
to parallel `Agent` calls. The lead reads only the poll agent's structured
summary, never raw CI logs or full threads; fix agents edit, the lead commits.

---

## Scheduling wake-ups (harness-dependent — pick one, stick with it)

**Claude Code CLI (interactive terminal):** `ScheduleWakeup` is honored — the
scheduler re-invokes `/ship $ARGUMENTS` later. Use it at the end of each
iteration with the playbook cadence (270s just-pushed / 720s CI or bots running /
1800s waiting on human review).

**ADE Work chat (Claude Agent SDK):** Work confidently inside the current turn,
but treat `ScheduleWakeup` as unavailable in this harness. It does not start a
later turn by itself, and `run_in_background` notifications are not a reliable
self-resume signal. Either:
- Poll synchronously inside the current turn (one bounded foreground
  `until ... ; do sleep N; done`), then fix/merge/exit; or
- Stop the turn cleanly, write the state file with `status: running`, and tell
  the user exactly when to re-ping `/ship` for the next iteration.

---

## The loop (summary — full detail in the playbook)

- **Phase 0 (first run):** safety rails (clean tree, GitHub origin, refuse
  `main`) → checkpoint → canonical commit-bound quality revalidation → push →
  open PR (`ade`, gh fallback) → verify the provisional binding → write state →
  schedule first wake.
- **Phase 1 — Poll:** wait for CI terminal and every bot that actually started to
  become terminal. After one 12-minute grace window, classify bots with zero
  evidence as inactive/terminal-neutral. Return a structured summary (merged /
  conflicting / ciFailed / newComments). Don't fix on a partial signal.
- **Phase 2 — Decide:** merged → run **Confirm the validated merge result** and
  only then set `done-clean`. Real conflict → Phase 3a rebase (rebate). CI or
  bots running → reschedule. Both terminal, no work → 3c merge.
  Both terminal, work exists, `iter < 5` → 3b fix. `iter >= 5`, not merged → 3d
  force-finalize.
- **Phase 3a Rebase / 3b Fix / 3c Merge / 3d Force-finalize** — per the playbook.
  Force-finalize runs once: ignore review comments (bookkeep their IDs), fix only
  CI, never delete/skip tests or weaken lint/tsconfig, then merge on green.
- **Phase 4/5:** post the iteration's `@codex review` ping after a fix push,
  update state, schedule the next wake (or stop per harness above).
- **Stack mode:** the same phases run, minus 3a, 3c.1–3c.5, and 3d. Phase 2
  routes remaining fix work to 3b and terminal-green to 3c.0
  (`ready-stacked`); the spent iteration budget escalates via
  `stack-coordinator-fix-required` instead of forcing.

---

## Exit states

| Status | Meaning |
|--------|---------|
| `ready-stacked` | Opt-in stacked layer is green, review-terminal, quality/test-clean, and every mandatory proof scenario is linked to the validated head or validly deferred to a named higher layer. The lane fixed its own layer; the coordinator owns restacking, base retargeting, submission, and landing |
| `done-clean` | PR merged on main |
| `done-max` | 5 normal + 1 force-finalize exhausted, merge genuinely blocked |
| `blocked` | Unrecoverable conflict, gate failure, API error, force-finalize CI failed, a non-empty `/quality` gate awaiting an author decision, an unresolved Windows parity decision (hide / disable / remove), a missing mandatory proof scenario, or a `stack-coordinator-*` escalation |

Always print the final summary (PR, branch, iterations, status, reason,
per-iteration log, unaddressed items) on exit. Do NOT schedule a wake when
`status` is `ready-stacked` / `done-clean` / `done-max` / `blocked`.
