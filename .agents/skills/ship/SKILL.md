---
name: ship
description: >-
  Autonomous PR-to-merge loop. Polls CI and review bots, fixes failures, rebases
  only on real conflicts, and lands the PR on main. Soft cap of 5 normal
  iterations plus one force-finalize iteration that bypasses review and fixes
  only CI. Pure loop — it does NOT run /quality or /test; run those first. Full
  phase logic lives in docs/playbooks/ship-lane.md.
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

**Rebase only on real conflicts.** `behindMain` alone does NOT trigger a rebase.
Only rebase/merge `main` when there is an actual conflict (`mergeStateStatus`
shows the PR is dirty/conflicting). If the branch is merely behind but cleanly
mergeable, skip the rebase and let the merge handle it — needless rebases burn
iterations and CI.

**Bot pings by iteration.** First push (Phase 0 / initial PR) → `@copilot review
but do not make fixes`. Subsequent fix-iteration re-pushes → `@codex review`. For
a >250-file diff, also ping `@greptile` and `@coderabbit` (separate comments).
Phase 1 still waits for the review signal to settle before fixing. This is the
playbook's Phase 4 rule — defer to it for exact bodies.

**Merge needs admin.** `main` is ruleset-guarded — `gh pr merge --squash` will
show BLOCKED. Retry with `gh pr merge --admin --squash`; the ruleset's
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

**ADE Work chat (Claude Agent SDK):** `ScheduleWakeup` is **NOT honored** — the
host only advances on a fresh user message, and `run_in_background` task
notifications flush on the next user turn, not autonomously. So do NOT pretend to
self-resume. Either:
- Poll synchronously inside the current turn (one bounded foreground
  `until ... ; do sleep N; done`), then fix/merge/exit; or
- Stop the turn cleanly, write the state file with `status: running`, and tell
  the user to re-ping `/ship` when they want the next iteration.

Do not start a background poller and claim it will wake you — it won't.

---

## The loop (summary — full detail in the playbook)

- **Phase 0 (first run):** safety rails (clean tree, GitHub origin, refuse
  `main`) → commit → push → open PR (`ade`, gh fallback) → `@copilot` ping →
  write state, schedule first wake.
- **Phase 1 — Poll:** wait for BOTH CI terminal AND review bots terminal. Return
  a structured summary (merged / conflicting / ciFailed / newComments). Don't fix
  on a partial signal.
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
| `blocked` | Unrecoverable conflict, gate failure, API error, or force-finalize CI failed |

Always print the final summary (PR, branch, iterations, status, reason,
per-iteration log, unaddressed items) on exit. Do NOT schedule a wake when
`status` is `done-clean` / `done-max` / `blocked`.
