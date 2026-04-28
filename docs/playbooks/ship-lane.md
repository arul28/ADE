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
- **Bounded with a force-finalize escape hatch.** Soft cap: 5 normal iterations of fix-and-poll. Exit earlier if clean or blocked. **At the cap, the loop must land the lane**: if the PR is not merged after iteration 5, run **one** additional force-finalize iteration (Phase 3d) that ignores all open review comments, fixes only CI failures so every required check goes green, then routes through Phase 3c (auto-merge). Only if iteration 6 cannot make CI green, or Phase 3c is genuinely blocked (base-branch policy + no admin rights + no auto-merge enabled), do you stop and leave a handoff comment for a human. The playbook's exit contract is "PR merged into `main`, or merge genuinely impossible" — never "PR green and parked".
- **Rebase budget rebate.** A rebase, merge-from-main, or conflict-resolution pass moves the current iteration count down by 2 before the next cap check, with a floor of 0. Example: if the lane is on iteration 4 and must rebase because `main` moved, record the rebase and continue as iteration 2.
- **Scoped checks.** Never run the full test suite between iterations. For CI, fix and rerun only the failing test file(s) or failing check target. For review-only changes, rerun only directly affected existing tests, plus the narrow package typecheck/lint when the touched surface needs it.
- **One push per iteration. Wait for BOTH signals before fixing anything.** Never push a CI-only fix while review bots are still running, and never push a review-only fix while CI is still running. Both signals must be **terminal** before the iteration commits — that is, every required check has a final conclusion AND every expected review bot has posted (or its status check has settled). This is not just an efficiency rule: **review-comment fixes routinely introduce new CI failures**, so applying them on a partial signal means the next push fails and you've thrown away the prior CI cycle. Wait for both, then dispatch ci-fix-agent and review-fix-agent in parallel with full knowledge of both, and combine their edits into one commit. If only one signal has landed when you wake, do not iterate — reschedule and sleep.
- **Default wait is 12 minutes.** After any push, schedule the next poll ~720s out (unless CI hasn't started at all — then 270s to stay in cache). 12 minutes is the **floor** that lets both CI shards and the slower review bots (Greptile, Copilot) finish. Re-entering before that almost always shows a partial state and produces the wrong decision. Only schedule shorter (270s) in Phase 0 immediately post-push to observe CI has kicked off.
- **Token-idle waits.** Waiting is done by the agent's native scheduler/resume primitive, or by a shell `sleep` followed by one-shot checks. Between wake-ups, agents should be asleep, not consuming model context or tokens.
- **Idempotent resume.** All state lives in `.ade/shipLane/<branch>.json`. A re-invocation reads that file and picks up where it left off.

## Fix discipline (read this; every fix-agent prompt should link here)

These two rules drive most of the cost and most of the regressions in this loop. The lead and every sub-agent must follow them.

### 1. Fix CI failures and review comments together, in one push, with both in view

Review-comment fixes routinely introduce new CI failures (different file gets touched, a mock drifts, a snapshot moves). If you push CI fixes while review-bot results are still pending, the next CI cycle re-fails on the review-driven changes and you've burned a 12-minute cycle for nothing. Same trap in reverse if you push review fixes while CI is still running.

Therefore:

- **Wait for both signals to be terminal** before doing any fix work. CI terminal = every required check has a final conclusion. Review-bots terminal = every expected bot has posted (or its status check has settled). If only one is back, sleep — don't iterate.
- **Decide holistically.** Read the failing CI list AND the new-comments list together before deciding what to change. A review comment that asks for "guard against null at line 42" and a CI failure in a test asserting null-handling on the same function are *one* fix, not two.
- **Dispatch `ci-fix-agent` and `review-fix-agent` in parallel** (Phase 3b.3), each with its own minimum scope but in the same iteration.
- **One commit, one push.** The lead reviews the combined diff, runs the narrow checks below, and pushes once. Never one push for CI and a second push for review feedback in the same iteration.

### 2. Never run a full test suite inside the loop — narrowest target only

Running `npm test` or a full vitest shard inside the fix loop is wrong. The full sharded run is a `/finalize` gate, not an iteration tool. Re-running 1,000 tests to verify a 5-line fix burns wall clock and prompt cache.

Therefore, when verifying a fix:

- **CI failure** → run only the failing test file: `npx vitest run path/to/that.test.ts`. If a shard reported multiple failures, run those specific files. Never re-run the whole shard.
- **Typecheck/lint/build failure** → run only the package-level command for the package whose file you touched (`cd apps/desktop && npx tsc --noEmit -p .`, etc.). Never run all three packages.
- **Review-only edits with no CI link** → run colocated/directly-affected tests when they exist (the `*.test.ts(x)` neighbor of the file you touched). Otherwise, run only the smallest package typecheck/lint that covers the touched surface. If you suspect adjacent tests might break, run only those *suspected* files — not the whole package.
- **Suite-wide rerun is forbidden inside the loop.** If you genuinely think the change is broad enough to need it, that's a signal the change is out of scope for an iteration; revert the speculative parts and narrow.

`ci-fix-agent` and `review-fix-agent` prompts should both cite this section by name and forbid the agent from running anything broader than the narrowest target that proves its fix.

---

## Concurrency model

Pick the richest available and **use it fully**:

1. **Agent teams** (e.g., Claude Code `TeamCreate` with `AGENT_TEAMS` enabled): **MANDATORY when available.** Spawn a team with a lead and role-specific sub-agents (poll, rebase, ci-fix, review-fix, conflict-resolver). Sub-agents return structured summaries so the lead's context never ingests full CI logs or comment threads.
2. **Parallel subagents** (e.g., Claude Code `Agent` tool, other CLIs with parallel task spawning): fall back here if teams aren't available. Spawn discrete subagents for poll, ci-fix, review-fix within a single iteration. Same context-keeping rules apply.
3. **Serial** (any CLI): absolute last resort. Run phases in order, in-process. Compact aggressively.

**Rule:** the lead reads poll-agent summaries, not raw API output. Fix agents receive minimum scope (failing test paths + error snippets, or comment bodies + file anchors) and return patches or direct edits. The lead commits and pushes; fix agents do not.

**Waiting rule:** agents never stay alive just to wait. A poll-agent performs one bounded poll and exits. Fix agents perform one bounded fix task and exit. The lead schedules a wake-up or records a blocked/done state, then exits the active turn.

## Common failure modes

These are operational mistakes this playbook explicitly guards against:

1. **Do not fix on a partial signal.** If CI has landed but review bots
   have not, or review bots have landed while CI is still running,
   reschedule and wait. Apply CI fixes and review-comment fixes only
   after both signals are terminal, then combine the edits into one
   commit.
2. **Normalize `SINCE` timestamps to UTC `Z`.** `git show
   --format=%cI` can return local timezone offsets while GitHub returns
   UTC timestamps. Normalize before comparing in `jq`, otherwise old
   comments can look new and trigger duplicate review-fix work.
3. **`done-clean` still merges.** A green PR with resolved review
   comments should route through Phase 3c auto-merge. Only mark
   `done-max` when normal merge, admin merge, and auto-merge are all
   genuinely blocked.
4. **Do not pass `--delete-branch` to `gh pr merge`.** It can try to
   checkout the base branch locally and fail when `main` is already
   checked out by another worktree. Delete the remote head ref after a
   successful merge, or rely on GitHub's automatic head-branch deletion.
5. **Do not commit scheduler lock drift.** If a stale
   `.claude/scheduled_tasks.lock` blocks rebase or checkout, stash that
   file instead of committing it into the lane.

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

1. **Find an `ade` binary.** Try in order, and stop at the first hit:
   1. `command -v ade` (PATH).
   2. `<repo-root>/apps/ade-cli/bin/ade` (project-local launcher, when committed).
   3. `node <repo-root>/apps/ade-cli/dist/cli.cjs` (project-local build output — present after `apps/ade-cli && npm run build`, which is what `/finalize` runs).
   If none exist, skip to the `gh` fallback at the bottom of this section. Whichever one wins, use it everywhere this playbook says `ade` for the remainder of the run, and record the resolved path under `adeBin` in the state file.
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

This is a one-shot poll. Do not use `gh pr checks --watch`, shell `while` loops, repeated sleeps, or minute-by-minute status checks. If CI/review is still pending, return `ciRunning: true` or `reviewBotsRunning: true` respectively, then let Phase 5 schedule the next wake.

**Wait for both CI and review bots before iterating.** The poll must treat these as two independent signals and only report "ready to fix" when **both** are terminal:

- **CI terminal** = every required check has a final conclusion (`success`, `failure`, `cancelled`, `skipped`, `neutral`). If any required check is still `QUEUED` or `IN_PROGRESS`, CI is not terminal.
- **Review bots terminal** = every expected review bot has either posted its review (`gh api repos/.../pulls/{N}/reviews` contains a submission newer than `lastPushSha`'s commit time for each bot) **or** its status check entry has settled. Expected bots for this repo include **Greptile** (appears as the `Greptile Review` status check — wait for it to leave `pending`), **CodeRabbit** (posts a status check and/or review), and **Copilot** (posts an issue comment after being pinged; allow ~3–5 min from the ping). Greptile in particular is slow enough that the 12-minute wait is driven primarily by it.

If either signal is still in flight, return "still waiting" and let Phase 5 reschedule. **Do not push a fix on a partial signal.**

When a CLI has no native scheduler but can run shell commands, the best fallback is one shell sleep followed by one bounded check. For example:

```bash
sleep 720 && gh pr checks 185 && gh run list --branch ade/cli-prs-fixes-747d7096 --limit 5
```

The shell can sleep without spending model tokens. The agent resumes reasoning only when that command returns.

### 1.1 PR and CI state

```bash
gh pr view "$PR_NUMBER" --json state,mergeable,mergeStateStatus,headRefOid,baseRefOid,isDraft
gh pr checks "$PR_NUMBER" --watch=false --json name,state,conclusion,link
```

If any check's `state` is `IN_PROGRESS` or `QUEUED`, note CI as still running.

### 1.2 Fetch new comments since last push

Use the commit timestamp of `lastPushSha` as the `since` filter (ISO 8601). Fall back to the state file's `lastPolledAt` if the commit isn't locally available.

**Normalize to UTC `Z` form before passing to jq.** `git show --format=%cI` returns local-tz strings like `2026-04-25T04:52:10-04:00`, while GitHub's `created_at` is UTC `2026-04-25T08:52:10Z`. jq's `>` is a string compare, not a date compare — `04:52:10-04:00` < `08:52:10Z` lexicographically, so a local-tz `SINCE` returns every old comment as "new" and triggers duplicate review-fix work on the next iteration. Always convert first:

```bash
SINCE_RAW=$(git show -s --format=%cI "$LAST_PUSH_SHA" 2>/dev/null)
SINCE=$(python3 -c "import sys,datetime; print(datetime.datetime.fromisoformat(sys.argv[1]).astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$SINCE_RAW")
# SINCE now looks like 2026-04-25T08:52:10Z

gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/comments" \
  --paginate -q "[.[] | select(.created_at > \"$SINCE\")]"

gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" \
  --paginate -q "[.[] | select(.created_at > \"$SINCE\")]"

gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" \
  --paginate -q "[.[] | select(.submitted_at != null and .submitted_at > \"$SINCE\")]"
```

Filter out any comment whose `id` is in `addressedCommentIds`.

### 1.3 Return structured summary

```json
{
  "merged": false,
  "behindMain": true,
  "isDraft": false,
  "ciRunning": false,
  "reviewBotsRunning": false,
  "pendingReviewBots": [],
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

`reviewBotsRunning` is `true` whenever `pendingReviewBots` is non-empty. Populate `pendingReviewBots` with any expected bot that has neither posted a review newer than `lastPushSha` nor has a settled status check (e.g., Greptile status still `pending`, Copilot has not commented within ~5 min of the ping).

`behindMain` is derived from `mergeStateStatus` being `BEHIND` or `DIRTY`, or from `git merge-base --is-ancestor origin/main HEAD` returning non-zero.

---

## Phase 2 — Decide

Pure logic on the poll summary:

| Condition | Action |
| --- | --- |
| `merged == true` | Exit `done-clean`; clear state file. |
| `behindMain == true` | Go to Phase 3a (rebase), apply the rebase budget rebate, then schedule/poll according to Phase 5. |
| `ciRunning == true` OR `reviewBotsRunning == true` | Do NOT iterate on a partial signal. Go to Phase 5 (schedule next wake). This applies even if the other signal already shows failures/comments — pushing a fix now means the next CI+review cycle races the fix and you likely re-push for the other half. |
| `ciFailed` empty, `newComments` empty, `ciRunning == false`, `reviewBotsRunning == false` | Go to **Phase 3c (auto-merge)**. Done-clean does not mean "stop and leave for human" — it means everything is green, and the lane should land on `main`. |
| Otherwise (both signals terminal, fix work exists) | Go to Phase 3b (fix). Fix CI failures and review comments **in the same iteration / same push**. |

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
- **Must follow "Fix discipline" §2 (top of this playbook): only run the narrowest target that proves the fix.** Verify each fix with `cd <app> && npx vitest run <specific file>` (or the package-level typecheck/lint when that's the failing job). Never re-run a full shard or full suite. Never run an unrelated package's checks.
- The companion `review-fix-agent` is editing files in parallel for the same iteration; assume the combined diff will be reviewed by the lead before commit.

**review-fix-agent** input:
- List of new comments: `{id, author, body, path, line}`
- Comment filter: address **every** comment that touches code — bot bugs, bot nits, human change-requests, human style nits. Skip only:
  - Pure questions with no change requested
  - Praise
  - Comments whose referenced line no longer exists in the current diff
  - IDs already in `addressedCommentIds`
- Repeated comments for the same already-fixed issue
- Record every comment id it addressed, resolved, or dismissed as stale/duplicate (for the lead to merge into state)
- **Must follow "Fix discipline" §2: after editing, only run the colocated `*.test.ts(x)` neighbor of files it touched, plus the smallest package-level typecheck/lint when the touched surface needs it.** Never run a full suite or shard. If a review fix touches the same file `ci-fix-agent` is editing, the lead resolves the conflict at commit time — do not coordinate edits live.

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

## Phase 3c — Auto-merge

Runs when Phase 2 routes here (everything terminal, no fix work, not behind, not already merged). The point of this playbook is "PR-to-merge", not "PR-to-green" — once green, the lane lands.

### 3c.1 Resolve repo merge style

```bash
gh api repos/{owner}/{repo} -q '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}'
```

Prefer the dominant style of the recent `main` history (look for `(#NNN)` suffixes → squash; merge-commit subjects → merge; otherwise rebase). Default to squash when ambiguous.

### 3c.2 Attempt the merge

```bash
gh pr merge "$PR_NUMBER" --squash
```

(Substitute `--merge` or `--rebase` per 3c.1.)

### 3c.3 Handle branch protection

If `gh pr merge` fails with `the base branch policy prohibits the merge` (typical when the repo requires a CODEOWNER review that the loop can't produce on its own), retry with admin override **only if the running user has admin rights on the repo**:

```bash
gh pr merge "$PR_NUMBER" --squash --admin
```

If the user is not a repo admin, do NOT use `--admin`. Fall back to:

```bash
gh pr merge "$PR_NUMBER" --squash --auto
```

`--auto` queues GitHub's native auto-merge; the PR will land on its own once the missing requirement is satisfied. If `--auto` is also rejected (the repo doesn't have auto-merge enabled), exit `blocked` with `exitReason: "merge-policy-blocked-no-auto"` and post a PR comment explaining what reviewer is needed.

### 3c.4 Branch deletion

**Do NOT pass `--delete-branch` to `gh pr merge`.** That flag triggers a local `git checkout` of the base branch, which fails if `main` is checked out in another worktree (common when /shipLane runs from a per-lane worktree). Instead, delete server-side after the merge succeeds:

```bash
gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$CURRENT_BRANCH"
```

Or simply skip deletion and rely on the repo's "Automatically delete head branches" setting if it's enabled.

### 3c.5 Confirm + finalize

```bash
gh pr view "$PR_NUMBER" --json state,mergedAt,mergeCommit
```

If `state == MERGED`, exit `done-clean`, clear `.ade/shipLane/<branch>.json`, and print the summary. Do NOT schedule another wake-up.

---

## Phase 3d — Force-finalize (iteration 6 only)

Runs at most once per lane, only when iteration 5 has just completed and the PR is still not merged. The point of this phase is to **land** the lane — review feedback is intentionally bypassed; CI must end green.

### 3d.1 Preconditions

- State file shows `iteration >= 5` AND `forceFinalize` is unset/false.
- `merged == false` from the latest poll.
- The previous wake's poll has BOTH signals terminal (CI conclusion known, review bots settled). If only the review-bots signal is back and CI is still running, sleep on the normal cadence and let CI settle first — force-finalize is a CI-fix pass, not a partial-signal push.

If preconditions fail (PR is merged, or this phase already ran), do not enter 3d.

### 3d.2 Snapshot review state, then ignore it

Capture every still-unaddressed `newComment.id` from the latest poll into `addressedCommentIds` in the state file. The bookkeeping is honest (we are choosing not to fix them); the next poll will not resurface them.

Do NOT spawn `review-fix-agent`. Do NOT edit code in response to review comments during this iteration.

### 3d.3 Dispatch ci-fix-agent only

Same input shape as Phase 3b.3, but with explicit constraints:

- Goal: every required check must end with conclusion `success` (or `skipped`/`neutral` if that's the historical norm for the check). No `failure`, no `cancelled`, no `timed_out`.
- Allowed fixes:
  - Production code edits to make tests pass.
  - Test edits when the production behavior is clearly correct and the test is the cause of the red signal — e.g. an outdated mock, an assertion that no longer matches an intentional UI change.
  - Lockfile re-syncs after dependency-related failures.
- Forbidden:
  - Deleting tests or whole test files.
  - Adding `.skip` / `it.skip` / `describe.skip` to side-step a failure.
  - Adding `.only` (would silently shrink coverage).
  - Disabling lint rules or relaxing tsconfig settings to clear errors.
  - Bypassing required checks via `gh pr merge --admin` without first making CI green. Admin merge is for branch-protection policy in Phase 3c, not for skipping red CI.
- Each fix is verified by re-running the narrow target (`npx vitest run <file>` / package typecheck / package lint) before reporting done.

### 3d.4 Lead commit + push

```bash
git status
git diff --stat
git commit -m "ship: iteration 6 (force-finalize, review skipped) — fix $CI_JOBS"
git push
```

Post the standard Phase 4 bot ping (`@copilot review but do not make fixes`). Update state:

```json
{
  "iteration": 6,
  "forceFinalize": true,
  "lastPushSha": "<new HEAD sha>",
  "addressedCommentIds": [<prev>, <every still-open new-comment id>],
  "lastPolledAt": "<ISO 8601 now>",
  "status": "running"
}
```

Schedule the next wake at the normal post-push cadence (270s if CI hasn't started, otherwise 720s).

### 3d.5 Next wake — merge, do not iterate further

When the next wake polls:

- `merged == true` → `done-clean`, exit.
- `behindMain == true` → run Phase 3a (rebase) once, push, schedule next wake. Do NOT count it as a new iteration; force-finalize already ran.
- CI terminal AND green → route **immediately** through Phase 3c (auto-merge). Do NOT wait on review bots; review is intentionally bypassed in this phase.
- CI terminal AND any required check still failing → exit `blocked`, `exitReason: "force-finalize-ci-failed"`, post a PR comment listing the failing job names + links. Do not start a seventh iteration.
- CI still running → sleep on the normal cadence; do not act on a partial signal.

There is no second force-finalize. Iteration 6 is one shot at landing the lane.

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

- `merged == true` (observed during this iteration) → set `status: done-clean`, exit.
- `iteration >= 5` AND `forceFinalize` unset/false AND not merged → run Phase 3d (force-finalize) on the next wake's fix turn. Do not exit; the cap is not a stop sign, it's a "land it now" trigger that switches the loop into review-ignoring CI-only mode.
- `forceFinalize == true` AND CI green AND not merged → route immediately through Phase 3c (auto-merge). Only if Phase 3c can't merge (policy blocked + no admin + auto-merge disabled) do you set `status: done-max` and leave a handoff comment.
- `forceFinalize == true` AND CI still red after the iteration-6 push → set `status: blocked`, `exitReason: "force-finalize-ci-failed"`, exit. Do not run a seventh iteration.
- Otherwise → schedule next wake.

### 5.3 Self-pace the next wake

Agent-CLI-agnostic guidance (Claude Code maps this to `ScheduleWakeup`; Codex in a terminal should usually use shell `sleep ... && <one-shot checks>`; other CLIs map it to their native sleep/resume):

- Just pushed, neither CI nor review has started yet → **270 seconds** (stay in prompt cache; next poll only confirms things have kicked off)
- CI running OR review bots still pending → **720 seconds** (12 min). This is the spec floor: CI shards typically finish in 3–5 min, Greptile in 5–10 min, Copilot within a few minutes of its ping. 12 min is what lets **both** land before the next poll.
- CI terminal AND review bots terminal, now waiting on human review → **1800 seconds** (30 min; cost-efficient)
- Unknown → **720 seconds** default

**Do not re-wake at 270s after the initial push-settled poll.** 270s is only useful to confirm CI started; after that, bump to 720s so review bots can post. Re-entering every 270s before Greptile finishes is exactly how you end up pushing a CI-only fix and wasting the next review cycle.

The cadence is a hint, not a live polling budget. Prefer longer sleeps over frequent checks. Each model or CLI may expose a different way to sleep, checkpoint, or resume; use the native one when it exists. If no native scheduler exists but shell commands can run, start a shell sleep followed by one bounded poll command, then let the shell wait without model activity. If neither scheduler nor shell sleep is available, write the updated state file and stop with a summary that names the next intended wake time; an external runner or human can re-invoke the playbook later. Do not emulate scheduling with an active model loop.

---

## Exit states

| status | meaning | next action |
| --- | --- | --- |
| `done-clean` | PR merged on `main` (Phase 3c succeeded, possibly after Phase 3d force-finalize) | clear state file; print summary |
| `done-max` | 5 normal iterations + 1 force-finalize iteration exhausted AND Phase 3c could not merge (policy block + no admin + no auto-merge) | leave state file; post PR handoff comment to human |
| `blocked` | Unrecoverable conflict, gate failure, API error, or `force-finalize-ci-failed` (iteration 6 could not turn CI green) | leave state file; post PR comment with reason |

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
- Replace `ScheduleWakeup` with your native resume mechanism (cron, setTimeout-equivalent, agent checkpoint). If you are operating like Codex in a terminal and have no native scheduler, use shell sleep plus one-shot checks, for example `sleep 720 && gh pr checks <PR> && gh run list --branch <branch> --limit 5`.
- Everything else — `gh`, `git`, `npx vitest`, `eslint`, `tsc` — is shell, and should work identically.
- This repo's shard count is **8** (`.github/workflows/ci.yml`). Always mirror that locally.
