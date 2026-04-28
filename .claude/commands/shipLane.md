---
name: shipLane
description: 'Autonomously drive a lane through CI + review until merged (automate → finalize → poll/fix loop, self-paced wake-ups, 5 normal iterations + 1 force-finalize iteration that ignores review and lands the merge)'
---

# Ship Lane Command

Drive the current lane from "work is ready" to "merged on main" without manual shepherding. The loop is bounded at 5 normal iterations; if it caps, a sixth force-finalize iteration runs that ignores all open review comments, fixes only the CI failures, and lands the merge. The command does not exit until the PR is merged or the merge is genuinely blocked by repo policy.

**Usage:**
- `/shipLane` — auto-detects state (existing PR on current branch, or needs initial push)
- `/shipLane <pr-number>` — operate on a specific PR (useful if you checked out a different branch mid-loop)

**Arguments:** $ARGUMENTS

---

## Source of truth

**Follow the playbook at `docs/playbooks/ship-lane.md`.** All phase logic, state schema, commands, decision rules, and bot-ping rules live there. This wrapper only defines how Claude Code's team + wake-up primitives map onto the playbook.

If you are re-invoked by a scheduled wake-up, read `.ade/shipLane/<sanitized-branch>.json` first. If `status == running`, skip Phase 0 and go straight to Phase 1.

---

## Execution mode: autonomous

This command runs end-to-end without user interaction. Do NOT:
- Ask the user to confirm, choose, or approve anything.
- Pause between phases to request direction.
- Stop on non-fatal warnings — log them and continue.
- Ask whether to apply a fix — apply, verify, commit.

The only user-visible output is the per-iteration summary and the final Phase 5 exit summary.

---

## Concurrency: TeamCreate is MANDATORY

Check the available tools. If `TeamCreate` is in scope, you MUST use it. Do not fall back to `Agent` calls when a team is available.

### Team composition

Create one team at the start of the invocation, reuse it across iterations.

```
ship-lane team
├── lead (this session's main agent)
├── poll-agent         — runs every iteration, returns structured summary only
├── rebase-agent       — spawned only when behindMain or conflicts exist
├── ci-fix-agent       — spawned only when CI failures exist
├── review-fix-agent   — spawned only when new valid comments exist
└── conflict-resolver  — spawned by rebase-agent for >5-file conflicts
```

Initial team setup should also create:
- `automate-agent` — invoked once in Phase 0 (only when there is no existing PR)
- `finalize-agent` — invoked once in Phase 0 (only when there is no existing PR)

### Delegation rules

- The lead NEVER reads raw CI logs or full comment threads. It reads the poll-agent's structured summary (see playbook §1.3).
- Fix agents get minimum scope: failing test paths + error snippets, or comment bodies + file anchors.
- Fix agents edit files directly; they do not commit.
- The lead commits and pushes after verifying `git diff`.
- Rebase-agent runs alone when active — no concurrent file edits from other agents.
- **Every `ci-fix-agent` and `review-fix-agent` prompt MUST cite the playbook's "Fix discipline" section** (the block near the top of `docs/playbooks/ship-lane.md`). Both rules in that section are load-bearing: (1) CI and review fixes ship in one combined push per iteration, after both signals are terminal, because review fixes routinely cause new CI failures; (2) verification only runs the narrowest target that proves the fix — never a full vitest shard or the full suite, never an unrelated package's checks.

### Fallback (TeamCreate not available)

If `TeamCreate` is genuinely not in scope for this session:

- Use parallel `Agent` tool calls for independent work (poll, ci-fix + review-fix in the same iteration).
- Use serial `Agent` calls for rebase (must run alone) and Phase 0 setup (automate then finalize).
- Same delegation rules apply — keep the lead's context clean by summarizing sub-agent output aggressively.

---

## Scheduling wake-ups

This wrapper is Claude Code-specific. Use `ScheduleWakeup` at the end of each iteration (playbook §5.3) with the same command re-invocation as the `prompt`:

```
ScheduleWakeup({
  delaySeconds: <270 | 720 | 1800 per playbook>,
  reason: "shipLane iter <N>: <CI running | waiting on review | just pushed>",
  prompt: "/shipLane $ARGUMENTS"
})
```

Pass `$ARGUMENTS` through so a PR-number argument is preserved across wake-ups.

Waiting must be token-idle. After scheduling a wake-up, stop the active agent turn completely and let the scheduler re-invoke this command later. Do not keep agents alive in polling loops, do not run `--watch` commands, and do not ask sub-agents to sleep while holding context. Poll only once per scheduled invocation, then either fix, exit, or schedule the next wake.

Other agent CLIs have their own sleep/resume mechanisms. If a Claude Code scheduler is not available, follow the playbook's generic guidance instead of copying `ScheduleWakeup` literally. For Codex-style terminal work, the recommended fallback is a shell sleep that does not involve the model, followed by one one-shot status command, for example:

```bash
sleep 720 && gh pr checks 185 && gh run list --branch ade/cli-prs-fixes-747d7096 --limit 5
```

That shell process can wait without spending model tokens; the agent should only resume reasoning after the command produces output.

Do NOT schedule a wake if `status` is `done-clean`, `done-max`, or `blocked` — print the summary and stop.

---

## Phase 0 safety rails (Claude Code specific)

Before running `automate-agent` and `finalize-agent` in Phase 0:

1. Confirm `$ARGUMENTS` is empty OR matches a PR number on the current branch. If the PR number is for a different branch, `git checkout` to that branch first.
2. Confirm `git status` is clean of foreign changes you don't expect. If the working tree has staged changes, commit them with `ship: checkpoint before automate/finalize` so the automate/finalize pipeline runs against a known baseline.
3. Confirm `origin` is a GitHub remote (`git remote get-url origin`) — `gh pr create` needs it.

If any rail fails, exit `blocked` with a clear reason in the state file and stop.

---

## ADE CLI discovery (Claude Code specific)

This wrapper consumes `ade` everywhere the playbook says to use it. If `command -v ade` returns nothing, do NOT immediately fall back to `gh`. Try the local build first:

```bash
ade_bin() {
  if command -v ade >/dev/null 2>&1; then
    echo "ade"
    return 0
  fi
  local repo_root
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  for candidate in \
    "$repo_root/apps/ade-cli/bin/ade" \
    "$repo_root/apps/ade-cli/dist/cli.cjs"; do
    if [ -x "$candidate" ] || [ -f "$candidate" ]; then
      case "$candidate" in
        *.cjs) echo "node $candidate"; return 0 ;;
        *)     echo "$candidate";       return 0 ;;
      esac
    fi
  done
  return 1
}
ADE=$(ade_bin) || ADE=""
```

Use `$ADE` in place of bare `ade` for the rest of the run. If the local build is missing too (`$ADE` empty), follow the playbook's normal `gh` fallback. Capture in the state file which path was used (`adeBin: "path"`, `prCreatedVia: "ade" | "gh"`).

---

## Force-finalize iteration (iteration 6)

The playbook caps the normal loop at 5 iterations. After iteration 5 records, the lead checks whether the PR is merged:

- If `merged == true` → done-clean, exit.
- If not merged → run **one** force-finalize iteration with these rules:
  1. **Ignore every open review comment.** Do not spawn `review-fix-agent`. Add every still-unaddressed `newComment.id` to `addressedCommentIds` so the iteration's accounting is honest.
  2. **CI fixes only.** Spawn `ci-fix-agent` against the failing checks. Its sole job is "make every required check pass". Test edits are allowed when the production code is clearly correct and the test is the cause of the red signal — but tests may not be deleted, skipped, or `.only`d. Do not weaken type/lint rules.
  3. **One push.** Lead commits with `ship: iteration 6 (force-finalize, review skipped)`, pushes, posts the standard Phase 4 bot ping, and schedules the next wake.
  4. **On the next wake**, run the normal Phase 1 poll. As soon as CI is terminal AND green, route immediately through Phase 3c (auto-merge). Do NOT wait on review bots — review feedback is intentionally bypassed for this iteration.
  5. If iteration-6 CI is still red after its push, exit `blocked` with `exitReason: "force-finalize-ci-failed"` and post a PR comment listing the failing jobs. Do not run a seventh iteration.
  6. If Phase 3c (`gh pr merge --squash`, then `--admin`, then `--auto`) all fail, exit `done-max` per the playbook — but only after the merge has been genuinely attempted.

The state file's `iteration` may exceed 5 (record `iteration: 6, forceFinalize: true`). Treat the cap check as "have we already done the force-finalize pass?"; if yes, do not start another.

The single exit contract for `/shipLane` is: **the PR is merged into `main`, OR the loop has run iteration 6 and the merge attempt is genuinely blocked by repo policy.** Any other early exit is a bug.

---

## Common failure modes (learned the hard way)

These are bugs from past runs. Don't reintroduce them.

1. **Don't fix on a partial signal.** When you wake and CI has landed but Greptile/CodeRabbit/Copilot haven't (or vice-versa), do **not** push fixes for the half that's ready — review-comment edits routinely cause new CI failures, so applying them on top of a half-known state means the next push fails and you've thrown away the prior CI cycle. Reschedule for 720s and wait. Only fix when both signals are terminal, then dispatch ci-fix-agent and review-fix-agent in parallel and combine their edits into one commit.

2. **Normalize `SINCE` to UTC `Z` form.** `git show --format=%cI` returns local-tz strings (e.g. `…-04:00`). GitHub returns UTC `…Z`. jq's `>` is a string compare, so a local-tz `SINCE` will return every old comment as "new" and trigger duplicate review-fix work on the next iteration. Pipe `SINCE` through `python3 … astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')` before passing to the gh queries. (See playbook §1.2.)

3. **Done-clean means merge, not stop.** When CI is green and review comments are resolved, route through Phase 3c (auto-merge) — `gh pr merge --squash`, retry with `--admin` if base-branch policy blocks the user (and they have admin rights), fall back to `--auto`, and only then mark `done-max` if all three options fail. The point of /shipLane is "PR → merged on main", not "PR → green and parked".

4. **Don't pass `--delete-branch` to `gh pr merge`.** That flag tries a local checkout of the base branch, which fails with `'main' is already used by worktree at …` whenever /shipLane runs from a per-lane worktree (i.e., always). Delete the head ref server-side instead: `gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/<branch>"`. Or just rely on the repo's "Automatically delete head branches" setting.

5. **Working-tree drift from agent worktrees.** If a stale `.claude/scheduled_tasks.lock` blocks a rebase, stash it (`git stash push -m "shipLane scheduler lock" .claude/scheduled_tasks.lock`) — don't commit it into the lane.

---

## References

- `docs/playbooks/ship-lane.md` — full phase logic (source of truth).
- `.claude/commands/automate.md` — invoked by `automate-agent` in Phase 0.
- `.claude/commands/finalize.md` — invoked by `finalize-agent` in Phase 0.
- `.github/workflows/ci.yml` — CI job names and shard count (`8`) that the local fallback tests mirror.
