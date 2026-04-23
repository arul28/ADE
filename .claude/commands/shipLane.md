---
name: shipLane
description: 'Autonomously drive a lane through CI + review until ready or capped (automate → finalize → poll/fix loop, self-paced wake-ups, max 10 iterations)'
---

# Ship Lane Command

Drive the current lane from "work is ready" to "merged on main" without manual shepherding.

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

## References

- `docs/playbooks/ship-lane.md` — full phase logic (source of truth).
- `.claude/commands/automate.md` — invoked by `automate-agent` in Phase 0.
- `.claude/commands/finalize.md` — invoked by `finalize-agent` in Phase 0.
- `.github/workflows/ci.yml` — CI job names and shard count (`8`) that the local fallback tests mirror.
