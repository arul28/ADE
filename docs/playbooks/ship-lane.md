# Ship Lane — Autonomous PR-to-Merge Playbook

This playbook drives a single lane (branch) from "work is ready" to "merged on `main`" without human shepherding. Any agent CLI (Claude Code, Codex, etc.) can follow it. Claude Code invokes it via `/shipLane`; other CLIs can invoke it directly by reading this file.

## When to use

Run this playbook once per lane, when the code on the branch is done (or nearly done) and you want the agent to handle:

- First-time commit + push + PR creation (if no PR exists yet)
- Polling CI and review comments
- Fixing valid review comments and CI failures
- Rebasing when teammates merge into `main` ahead of you
- Repeating until the PR is clean, capped, or a human is required

## Execution contract

- **Autonomous.** Do not pause for user confirmation mid-loop.
- **Bounded.** Hard cap: 5 iterations. Exit earlier if clean or blocked. At the cap, do not auto-merge; leave a handoff comment that explains why the loop stopped and what remains, if anything.
- **Rebase budget rebate.** A rebase, merge-from-main, or conflict-resolution pass moves the current iteration count down by 2 before the next cap check, with a floor of 0. Example: if the lane is on iteration 4 and must rebase because `main` moved, record the rebase and continue as iteration 2.
- **Scoped checks.** Never run the full test suite between iterations. For CI, fix and rerun only the failing test file(s) or failing check target. For review-only changes, rerun only directly affected existing tests, plus the narrow package typecheck/lint when the touched surface needs it.
- **Token-idle waits.** Waiting is done by scheduler/resume, not by live polling loops. Between wake-ups, agents should be asleep, not consuming model context or tokens.
- **Idempotent resume.** All state lives in `.ade/shipLane/<branch>.json`. A re-invocation reads that file and picks up where it left off.

## Concurrency model

Pick the richest available and **use it fully**:

1. **Agent teams** (e.g., Claude Code `TeamCreate` with `AGENT_TEAMS` enabled): **MANDATORY when available.** Spawn a team with a lead and role-specific sub-agents (poll, rebase, ci-fix, review-fix, conflict-resolver). Sub-agents return structured summaries so the lead's context never ingests full CI logs or comment threads.
2. **Parallel subagents** (e.g., Claude Code `Agent` tool, other CLIs with parallel task spawning): fall back here if teams aren't available. Spawn discrete subagents for poll, ci-fix, review-fix within a single iteration. Same context-keeping rules apply.
3. **Serial** (any CLI): absolute last resort. Run phases in order, in-process. Compact aggressively.

**Rule:** the lead reads poll-agent summaries, not raw API output. Fix agents receive minimum scope (failing test paths + error snippets, or comment bodies + file anchors) and return patches or direct edits. The lead commits and pushes; fix agents do not.

**Waiting rule:** agents never stay alive just to wait. A poll-agent performs one bounded poll and exits. Fix agents perform one bounded fix task and exit. The lead schedules a wake-up or records a blocked/done state, then exits the active turn.

## State file

Path: `.ade/shipLane/<sanitized-branch>.json` (sanitize by replacing `/` with `__`).

```json
{
  "branch": "ade/chat-title-summaries-xyz",
  "prNumber": 1234,
  "iteration": 2,
  "lastPushSha": "abc123...",
  "addressedCommentIds": [987654, 987655],
  "status": "running",
  "startedAt": "2026-04-23T14:30:00Z",
  "lastPolledAt": "2026-04-23T15:12:00Z",
  "exitReason": null
}
```

`status` values: `running`, `done-clean`, `done-max`, `blocked`.

The `iteration` value is the active turn budget counter, not a raw count of pushes. Normal fix iterations increment it by 1. Rebase/merge/conflict recovery decrements it by 2 first, then the current pass records its result. Never let it go below 0.

---

## Phase 0 — Setup (first invocation only)

Skip this phase if `.ade/shipLane/<branch>.json` exists with `status: running`.

### 0.1 Detect current state

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$CURRENT_BRANCH" = "main" ] && { echo "refusing to ship main"; exit 1; }

gh pr view --json number,state,headRefOid,baseRefName 2>/dev/null
```

If a PR exists for the current branch, skip to 0.4 (bot pings) with `prNumber` captured.

### 0.2 Pre-push preparation (no existing PR)

Run two sub-agents **serially** (automate first, then finalize):

1. **automate-agent** — follows `.claude/commands/automate.md` (or wherever its sibling lives for non-Claude CLIs). Generates tests for untested new code on the branch.
2. **finalize-agent** — follows `.claude/commands/finalize.md`. Runs simplification, doc updates, lock-file sync, typecheck, lint, sharded tests, build.

If either exits with failure, abort Phase 0 and record `status: blocked`, `exitReason: "phase-0-gate-failed"`.

### 0.3 Commit + push + create PR

Commit and push first — both paths below need the remote branch to exist:

```bash
git add -A
git diff --cached --quiet || git commit -m "ship: prepare lane for review"
git push -u origin "$CURRENT_BRANCH"
```

**PR creation: prefer the ADE CLI.** Opening the PR via `ade` registers it in ADE's PR tracking (lane ↔ PR link, check/comment inventory, review-thread state). `gh pr create` is the fallback, not the default. Falling back too eagerly defeats the purpose — do it only after you've genuinely confirmed the ADE path is broken.

### Discovery protocol (for the agent — not a script)

The `ade` surface evolves. Don't assume flag names or output shapes from this playbook; discover them live.

1. **Is `ade` on PATH?** `command -v ade`. If not, skip to the fallback.
2. **Confirm the PR subcommand exists.** `ade --help` (or `ade -h`). Look for `prs` (or whatever the current noun is — the help text is authoritative, this playbook is not).
3. **Read the exact create invocation.** `ade prs --help` then `ade prs create --help`. Note the actual required flags — expect something like `--lane <id>`, `--base <branch>`, and an output format flag (`--json`, `--text`, or global `--json`). Do not trust any specific invocation this playbook gives you; trust the help output.
4. **Resolve current branch → lane id.**
   - `ade lanes list --json` (or whatever the help shows) and filter by the field that holds the branch name (commonly `branchRef` or `branch`).
   - If the branch isn't a registered lane, read `ade lanes --help` to find the import/register subcommand (commonly `ade lanes import --branch <name>`). Run it, then re-list.
   - If import's flag names differ from what you expect, re-read the help. Don't guess.
5. **Create the PR** with the exact invocation the help documented. Read any error carefully — they mean different things:
   - **Usage error** (unknown flag, missing arg) → re-read `--help`, fix, retry. Do not fall back yet.
   - **"PR already exists for lane"** → recover the existing PR number via `ade prs list --lane <id>` (or equivalent) and skip to Phase 0.4.
   - **Auth error** (token expired, permission denied) → exit with `status: blocked`, `exitReason: "ade-auth-failed"`. Do NOT silently fall back; surface to the user.
   - **Genuine internal error, reproducible after retry** → only now fall back.
6. **Capture the PR number.** The create command's output format varies (JSON, plain number, URL). If you can't extract it reliably, run `ade prs list --lane <id> --json` as a cross-check. If ADE's output is opaque after reasonable effort, `gh pr view --json number -q .number` is a safe cross-check since the PR now exists on GitHub.

Only after steps 1–6 have been genuinely attempted should the fallback run:

```bash
gh pr create --base main --head "$CURRENT_BRANCH" --fill
PR_NUMBER=$(gh pr view --json number -q .number)
```

Record in the state file which path was used (`prCreatedVia: "ade" | "gh"`). If the `gh` path fired, mention it in the final summary so the user can run `ade prs inventory <PR_NUMBER>` to reconcile.

### 0.4 Post initial bot pings

See Phase 4 rules — always `@copilot review but do not make fixes`; add `@greptile` and `@coderabbit` if the diff touches more than 250 files.

### 0.5 Write initial state

```json
{
  "branch": "<CURRENT_BRANCH>",
  "prNumber": <PR_NUMBER>,
  "iteration": 0,
  "lastPushSha": "<current HEAD sha>",
  "addressedCommentIds": [],
  "status": "running",
  "startedAt": "<ISO 8601 now>",
  "lastPolledAt": null,
  "exitReason": null
}
```

Then schedule the first wake-up (see Phase 5).

---

## Phase 1 — Poll

Runs on every wake-up. Delegate to a **poll-agent** so the lead's context stays clean. The poll-agent runs these calls and returns a single structured summary.

This is a one-shot poll. Do not use `gh pr checks --watch`, shell `while` loops, repeated sleeps, or minute-by-minute status checks. If CI/review is still pending, return `ciRunning: true` or no actionable comments, then let Phase 5 schedule the next wake.

### 1.1 PR and CI state

```bash
gh pr view "$PR_NUMBER" --json state,mergeable,mergeStateStatus,headRefOid,baseRefOid,isDraft
gh pr checks "$PR_NUMBER" --watch=false --json name,state,conclusion,link
```

If any check's `state` is `IN_PROGRESS` or `QUEUED`, note CI as still running.

### 1.2 Fetch new comments since last push

Use the commit timestamp of `lastPushSha` as the `since` filter (ISO 8601). Fall back to the state file's `lastPolledAt` if the commit isn't locally available.

```bash
SINCE=$(git show -s --format=%cI "$LAST_PUSH_SHA" 2>/dev/null)

gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/comments" \
  --paginate -q "[.[] | select(.created_at > \"$SINCE\")]"

gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" \
  --paginate -q "[.[] | select(.created_at > \"$SINCE\")]"

gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" \
  --paginate -q "[.[] | select(.submitted_at > \"$SINCE\")]"
```

Filter out any comment whose `id` is in `addressedCommentIds`.

### 1.3 Return structured summary

```json
{
  "merged": false,
  "behindMain": true,
  "isDraft": false,
  "ciRunning": false,
  "ciFailed": [
    { "name": "test-desktop (3)", "link": "https://github.com/.../runs/123" }
  ],
  "newComments": [
    {
      "id": 987700,
      "author": "copilot-pull-request-reviewer",
      "body": "Consider guarding against null here.",
      "path": "apps/desktop/src/main/services/x.ts",
      "line": 42,
      "type": "diff-line"
    }
  ],
  "pollHeadSha": "<current PR head sha>"
}
```

`behindMain` is derived from `mergeStateStatus` being `BEHIND` or `DIRTY`, or from `git merge-base --is-ancestor origin/main HEAD` returning non-zero.

---

## Phase 2 — Decide

Pure logic on the poll summary:

| Condition | Action |
| --- | --- |
| `merged == true` | Exit `done-clean`; clear state file. |
| `behindMain == true` | Go to Phase 3a (rebase), apply the rebase budget rebate, then schedule/poll according to Phase 5. |
| `ciFailed` empty, `newComments` empty, `ciRunning == true` | No fix work. Go to Phase 5 (schedule next wake). |
| `ciFailed` empty, `newComments` empty, `ciRunning == false` | Exit `done-clean`. |
| Otherwise | Go to Phase 3b (fix). |

---

## Phase 3a — Rebase / merge

```bash
git fetch origin
git rebase origin/main
```

**On conflict:** the lead resolves using full repo context. The agent has the codebase; it reads both sides of each conflict and produces a merged result. If the conflict spans many files or touches shared contracts (IPC types, DB schema, sync payloads), the lead spawns a **conflict-resolver sub-agent** with:

- The conflicted file list
- The two divergent diffs per file (`git diff :1:<path> :2:<path>` base→ours, `git diff :1:<path> :3:<path>` base→theirs)
- The branch's feature context (`git log main..HEAD --oneline`)
- Explicit instruction to preserve both sides' intent rather than picking one

If rebase becomes unrecoverable (agent's own judgment):

```bash
git rebase --abort
git merge origin/main
```

Resolve merge conflicts the same way. If the merge is **still** unrecoverable, exit `blocked` with `exitReason: "conflict-unrecoverable"` and post a PR comment flagging a human, listing the files involved.

### Post-resolution validation

Before pushing, run tests scoped to touched files only:

```bash
# Touched since rebase started
CHANGED=$(git diff --name-only ORIG_HEAD HEAD | grep -E '\.(ts|tsx)$')

# Run colocated test files that exist
for f in $CHANGED; do
  TEST="${f%.ts}.test.ts"
  [ -f "$TEST" ] && echo "$TEST"
done | sort -u | xargs -r -I{} sh -c 'cd apps/desktop && npx vitest run {}'

# If typescript touched, typecheck the package
echo "$CHANGED" | grep -q "^apps/desktop/" && (cd apps/desktop && npx tsc --noEmit -p .)
echo "$CHANGED" | grep -q "^apps/ade-cli/" && (cd apps/ade-cli && npm run typecheck)
```

Then:

```bash
git push --force-with-lease
```

Before bookkeeping, apply the **rebase budget rebate**:

```json
{
  "iteration": "max(0, previous iteration - 2)"
}
```

Post bot pings (Phase 4), update state (Phase 5), and schedule the next wake. Do not immediately repoll after a rebase push; let CI and review bots run while the agent is asleep.

---

## Phase 3b — Fix

### 3b.1 Parse failed CI

For each failed check:

```bash
RUN_ID=$(gh run list --branch "$CURRENT_BRANCH" --limit 1 --json databaseId -q '.[0].databaseId')
gh run view "$RUN_ID" --log-failed
```

Extract:

- Failing test file paths (grep for `FAIL` in vitest output, `error` in tsc/eslint output)
- Exact error snippets (stack trace + surrounding lines)
- Which shard (e.g., `test-desktop (3)` → failing files only ran on shard 3)

Only investigate and rerun the failing target. If a shard fails because of one file, rerun that file, not the whole shard. If a typecheck/lint/build job fails, rerun that exact package-level command only after fixing the reported files.

### 3b.2 Review-comment hygiene

Before dispatching review fixes:

- Group comments by normalized finding: same file, nearby line, same author, and materially same body. Treat repeats as one issue.
- Drop stale comments whose line no longer exists or whose requested change is already present in the current diff.
- If a review thread can be resolved with the available GitHub/ADE tooling, resolve it as soon as the fix is present or the comment is stale/duplicate.
- Add every handled, stale, or duplicate comment id to `addressedCommentIds` so future iterations do not keep revisiting it.

Do not linger on repeated bot feedback. Fix the underlying issue once, mark old copies handled/resolved when possible, and move on.

### 3b.3 Dispatch fix sub-agents in parallel

If both CI fixes and review-comment fixes are needed, spawn them **in parallel** (each scoped to its own minimum input):

**ci-fix-agent** input:
- Failing test file paths
- Error snippets (not full logs)
- Allowed to read any source file, but MUST NOT rewrite tests unless the test is genuinely wrong
- Must verify each fix with `cd <app> && npx vitest run <specific file>` before reporting done
- Must not run the full suite or an entire CI shard when the failing file is known

**review-fix-agent** input:
- List of new comments: `{id, author, body, path, line}`
- Comment filter: address **every** comment that touches code — bot bugs, bot nits, human change-requests, human style nits. Skip only:
  - Pure questions with no change requested
  - Praise
  - Comments whose referenced line no longer exists in the current diff
  - IDs already in `addressedCommentIds`
- Repeated comments for the same already-fixed issue
- Record every comment id it addressed, resolved, or dismissed as stale/duplicate (for the lead to merge into state)

Both agents edit files directly. They do not commit; only the lead commits.

### 3b.4 Lead verification + commit

```bash
git status
git diff --stat
```

The lead reviews the combined diff. If anything is surprising (unrelated files touched, enormous diffs), the lead can revert specific hunks with `git checkout -- <file>` before committing.

Re-run only the narrow checks that matter:

- For CI fixes, rerun the failing test file(s) or exact failing check target.
- For review-only fixes, rerun colocated/directly affected tests when they exist; otherwise run the smallest package typecheck/lint that covers the touched surface.
- Do not run the full desktop or CLI suite inside the loop.

Commit with a message that lists what was addressed:

```bash
git commit -m "ship: iteration $N — fix $CI_JOBS, address #$COMMENT_IDS"
git push
```

Post bot pings (Phase 4), update state (Phase 5), and schedule the next wake. Do not restart Phase 1 immediately after a push; give CI and review bots time to run while the agent is asleep.

---

## Phase 4 — Post-push bot pings

Runs after **any** push (initial or re-push). Always:

```bash
gh pr comment "$PR_NUMBER" --body "@copilot review but do not make fixes"
```

If the PR touches more than 250 files:

```bash
FILE_COUNT=$(gh pr diff "$PR_NUMBER" --name-only | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -gt 250 ]; then
  gh pr comment "$PR_NUMBER" --body "@greptile review"
  gh pr comment "$PR_NUMBER" --body "@coderabbit review"
fi
```

These are separate comments (not a single body) so each bot handler parses its own mention reliably.

---

## Phase 5 — Bookkeeping + schedule next wake

### 5.1 Update state

```json
{
  "iteration": <prev + 1, after any rebase/conflict rebate>,
  "lastPushSha": "<new HEAD sha>",
  "addressedCommentIds": [<prev list>, <new ids handled this iteration>],
  "lastPolledAt": "<ISO 8601 now>",
  "status": "running"
}
```

### 5.2 Decide exit vs next wake

- `iteration >= 5` → set `status: done-max`, `exitReason: "iteration-cap-reached"`, post a PR handoff comment explaining why the loop stopped and listing remaining unaddressed CI/review items, if any. Do not auto-merge at the cap; leave the PR open for a human to merge or rerun the lane.
- `merged == true` (observed during this iteration) → set `status: done-clean`, exit.
- Otherwise → schedule next wake.

### 5.3 Self-pace the next wake

Agent-CLI-agnostic guidance (Claude Code maps this to `ScheduleWakeup`; other CLIs map it to their equivalent sleep/resume):

- Just pushed, CI hasn't started yet → **270 seconds** (stay in prompt cache)
- CI running → **720 seconds** (12 min — the user's spec)
- CI done, waiting on human review → **1800 seconds** (30 min; cost-efficient)
- Unknown → **720 seconds** default

The cadence is a hint, not a live polling budget. Prefer longer sleeps over frequent checks. If the environment has a real scheduler/resume primitive, use it and end the active turn. If no scheduler exists, write the updated state file and stop with a summary that names the next intended wake time; an external runner or human can re-invoke the playbook later. Do not emulate scheduling with an active model loop.

---

## Exit states

| status | meaning | next action |
| --- | --- | --- |
| `done-clean` | PR merged OR green + no unaddressed comments | clear state file; print summary |
| `done-max` | 5 iterations exhausted | leave state file; post PR handoff comment to human; do not auto-merge |
| `blocked` | Unrecoverable conflict, gate failure, or API error | leave state file; post PR comment with reason |

## Summary output (always print on exit)

```
## Ship Lane Summary

- PR: #<number> — <title>
- Branch: <branch>
- Iterations: <0..5>
- Status: <done-clean | done-max | blocked>
- Reason: <one line>

### Per-iteration log
1. pushed <sha-short> — fixed <job list>, addressed <count> comments
2. rebased onto main, pushed <sha-short>
3. ...

### Unaddressed items (if done-max / blocked)
- <comment id or CI job>: <one-line reason>
```

---

## Notes for non-Claude agent CLIs

- Replace `TeamCreate` with your native team/task spawning primitive. If none exists, run phases serially and compact aggressively between phases.
- Replace `ScheduleWakeup` with your native resume mechanism (cron, setTimeout-equivalent, agent checkpoint).
- Everything else — `gh`, `git`, `npx vitest`, `eslint`, `tsc` — is shell, and should work identically.
- This repo's shard count is **8** (`.github/workflows/ci.yml`). Always mirror that locally.
