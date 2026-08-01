---
name: ship
description: >-
  Autonomous PR-to-merge loop. Polls CI and review bots, fixes failures, rebases
  only on real conflicts, and lands the PR on main. Soft cap of 5 normal
  iterations plus one force-finalize iteration that bypasses review and fixes
  only CI. Pure loop — it does not replace the baseline /quality or /test runs;
  run those first. It does revalidate quality after any ship-loop mutation so
  the final result is bound to the exact commit merged. Full phase logic lives
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

**Invocation:** `/ship` (auto-detect state) or `/ship <pr-number>`.

---

## Source of truth

**Follow `docs/playbooks/ship-lane.md`** — all phase logic, the state schema,
commands, decision rules, and bot-ping rules live there. This skill is the
runtime-neutral entrypoint and the ADE-specific deltas below. If re-invoked by a
scheduled wake, read the state file first; if `status == running`, skip Phase 0
and go to Phase 1.

The playbook's Phase 0 is **commit → push → open PR** only. Test generation and
the local-CI gate are NOT part of ship — that's `/test` (and optionally
`/finalize`) before you reach this skill.

## Precondition: `/quality` must be empty and bound to the merge commit

Before Phase 0, require a completed `/quality` result with an empty gate. Before
Phase 3c, also require `qualityValidatedSha` in the ship state to equal both
`git rev-parse HEAD` and the PR's current `headRefOid`. The result is valid only
for that exact commit; green CI on a later commit does not preserve it.

A non-empty gate **blocks the merge** — every row in it is a finding that was
verified as real and left unfixed, and by `/quality`'s contract the only two
things that may be there are a product decision the author owes, or a behavior
change this branch was not asked to make. Both need the author.

- Gate rows exist → do not merge. Surface them, state the decision needed, and
  stop with `blocked`. Do not merge and mention them afterwards.
- If `/quality` was never run on this lane, or its final gate result is not
  available in the lane handoff, stop with `blocked`; unknown is not empty.
- Any rebase, conflict resolution, Phase 3b edit, or force-finalize edit clears
  `qualityValidatedSha`. Run the playbook's single canonical **Commit-bound
  quality revalidation** procedure before pushing that mutation.
- Never enter Phase 3c with a missing or mismatched binding. Revalidate first;
  do not merge and disclose stale quality evidence afterwards.
- Bind every normal or admin merge attempt with
  `--match-head-commit "$QUALITY_VALIDATED_SHA"`. Persistent auto-merge is not
  allowed because a later push can replace the validated head while it remains
  armed.

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
  --fill` is the fallback, not the default. See the playbook's discovery protocol.
- **State file:** `.ade/shipLane/<branch-with-slashes-as-__>.json`. `status`:
  `running` | `done-clean` | `done-max` | `blocked`. Rebase rebates the iteration
  counter by 2 (floor 0).

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

**Rebase only on real conflicts.** `behindMain` alone does NOT trigger a rebase.
Only rebase/merge `main` when there is an actual conflict (`mergeStateStatus`
shows the PR is dirty/conflicting). If the branch is merely behind but cleanly
mergeable, skip the rebase and let the merge handle it — needless rebases burn
iterations and CI.

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
the ruleset's
non-linear-history rule can still reject `--admin`, in which case fall back to a
local merge + admin-bypass push (per AGENTS.md). Do NOT pass `--delete-branch`
(it fails from a worktree); delete the head ref server-side via
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
  `main`) → commit → push → open PR (`ade`, gh fallback) → write state →
  schedule first wake.
- **Phase 1 — Poll:** wait for CI terminal and every bot that actually started to
  become terminal. After one 12-minute grace window, classify bots with zero
  evidence as inactive/terminal-neutral. Return a structured summary (merged /
  conflicting / ciFailed / newComments). Don't fix on a partial signal.
- **Phase 2 — Decide:** merged → `done-clean`. Real conflict → Phase 3a rebase
  (rebate). CI or bots running → reschedule. Both terminal, no work → 3c merge.
  Both terminal, work exists, `iter < 5` → 3b fix. `iter >= 5`, not merged → 3d
  force-finalize.
- **Phase 3a Rebase / 3b Fix / 3c Merge / 3d Force-finalize** — per the playbook.
  Force-finalize runs once: ignore review comments (bookkeep their IDs), fix only
  CI, never delete/skip tests or weaken lint/tsconfig, then merge on green.
- **Phase 4/5:** post the iteration's `@codex review` ping after a fix push,
  update state, schedule the next wake (or stop per harness above).

---

## Exit states

| Status | Meaning |
|--------|---------|
| `done-clean` | PR merged on main |
| `done-max` | 5 normal + 1 force-finalize exhausted, merge genuinely blocked |
| `blocked` | Unrecoverable conflict, gate failure, API error, force-finalize CI failed, or a non-empty `/quality` gate awaiting an author decision |

Always print the final summary (PR, branch, iterations, status, reason,
per-iteration log, unaddressed items) on exit. Do NOT schedule a wake when
`status` is `done-clean` / `done-max` / `blocked`.
