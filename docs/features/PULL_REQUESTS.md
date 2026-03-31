# Pull requests

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-31

ADE's PR surface manages lane-backed pull requests, queue workflows, integration proposals, and GitHub inspection. The current implementation still centers on local git truth for simulation and merge planning, but the UI data-loading model is now much lighter than the earlier eager version.

---

## Core model

The PR feature still supports:

- lane-to-PR mapping
- stacked PRs through lane parent/child relationships
- queue automation state
- integration proposals backed by local simulation
- GitHub detail, checks, reviews, and comments

Integration and conflict prediction still rely on local git primitives rather than a remote-only simulator.

---

## GitHub data-loading model

The GitHub tab is now built around cached snapshots instead of repeated cold remote fetches.

### Current behavior

- the main process caches the GitHub snapshot for a short TTL
- the renderer also caches the snapshot so revisiting the tab can render immediately
- manual sync explicitly forces a refresh
- repeated in-flight snapshot requests are deduplicated

This keeps revisits from paying the full GitHub fetch cost every time while preserving a clear force-refresh path when the user asks for fresh data.

### What the snapshot contains

The snapshot still includes:

- repo pull requests
- external pull requests involving the current user
- lane linkage and ADE workflow metadata

The GitHub tab remains the read-only inspection and import/linking surface for remote PRs.

---

## PR context loading

The broader PR page no longer assumes every tab needs every workflow query.

Current behavior:

- queue state only loads for workflow-oriented tabs
- merge contexts load lazily
- selected PR detail still loads status, checks, reviews, and comments on demand
- background PR refresh runs on a 60-second default interval and uses fingerprint-based change detection to skip re-renders when nothing changed, only updating a stale subset instead of every PR on every cycle

This keeps the default PR surface from paying for queue/integration orchestration when the user is just browsing ordinary PRs.

---

## Integration proposals

ADE still supports saved integration proposals and committed integration workflows, but the interaction model is now more explicit.

### Manual simulation

Integration simulation is no longer auto-triggered just because the user entered the Integration tab or selected a PR.

Current behavior:

- simulation state resets when the selected PR changes
- actual simulation runs only when the user triggers it
- the rerun path remains available through the existing explicit actions

This avoids surprise expensive local simulation work and prevents stale proposals from silently re-running in the background.

### Local simulation path

Simulation continues to use local git operations such as:

- `git rev-parse`
- `git merge-tree`
- diff-based overlap checks

That keeps PR readiness and conflict prediction aligned with the actual local repo state.

---

## Queue and workflow state

Queue automation and committed integration workflows are still first-class PR concepts. The important change is that those states are now treated as **workflow-only data**, not data every PR screen must preload.

That is the main reason the normal PR and GitHub views feel less heavy than before.

---

## Merge bypass for blocked PRs

When GitHub reports a PR as not mergeable (e.g. due to branch protection rules), ADE now offers an explicit opt-in to attempt the merge anyway. This covers cases where the user's account has permission to bypass branch protection requirements even though the GitHub API reports `isMergeable: false`.

The UI surfaces a checkbox in the merge action area when the PR is open, has no merge conflicts, but is flagged as not mergeable. Checking it enables the merge button in a warning state. The merge request still goes through the normal GitHub merge API — GitHub itself decides whether the bypass is allowed.

---

## CI running indicator

PR list rows (Normal tab, GitHub tab) and the PR detail merge readiness panel now show a spinning indicator when CI checks are still running. The `PrCiRunningIndicator` component lives in `prVisuals.tsx` and supports both icon-only and labeled variants. The detail pane's check status row also uses it as a title accessory.

---

## PR notifications

Notification messages emitted by the polling service are now generic (not PR-specific) to work better as system notifications. The title no longer includes the PR number. The event payload now includes `prTitle`, `repoOwner`, `repoName`, `baseBranch`, and `headBranch` fields so consumers can format context-aware messages themselves.

---

## Post-merge cleanup resilience

After a successful GitHub merge, cleanup operations (branch deletion, group membership removal, lane archiving, base branch fetch, cache invalidation, rebase-needs scan) are wrapped in an outer try-catch so that a failure in any cleanup step does not mask the successful merge. The operation is marked as succeeded regardless, with a `cleanupError` metadata field when something went wrong. Individual cleanup failures are logged as warnings.

The Create PR modal validates branch names against invalid git ref characters before submission. All three PR creation modes (normal, queue, integration) display lane warning panels alongside the draft checkbox, surfacing rebase needs and other lane health issues before submission. Error messages from failed GitHub API calls are cleaned of internal IPC prefixes before display, and the PR service wraps creation failures with contextual head/base branch information for clearer diagnostics. GitHub API error responses now extract nested error detail messages (from the `errors` array in the response body) and append them to the thrown error, improving visibility of issues such as duplicate PR or branch protection failures.

The PR detail pane renders markdown body content with `rehype-sanitize` applied after `rehype-raw`, stripping potentially unsafe HTML from PR descriptions fetched from GitHub.

---

## Queue landing state machine

The queue landing service enforces an explicit state transition table (`ALLOWED_TRANSITIONS`) for queue entry states. Invalid transitions are logged and rejected rather than silently applied. The `markEntryLanded` helper centralizes the landed-entry bookkeeping (state, position advance, active-PR reset). The cancel path now force-fails entries that are in non-skippable states (e.g., `landing`, `resolving`) with a warning rather than leaving them in an inconsistent state.

---

## Current product contract

The current PR experience follows these rules:

- use local git state for merge/integration truth
- load normal PR browsing data first
- load workflow state only when the user is actually in a workflow view
- never auto-run expensive integration simulation just from tab selection
- make GitHub revisits warm through layered caching
- include rebase needs and auto-rebase statuses in the main refresh batch

That preserves the full PR feature set while keeping the common browse-and-review path much cheaper.

---

## PR issue resolution

ADE now supports agent-driven resolution of PR issues directly from the PR detail surface. This covers two categories of actionable PR issues:

- **Failing CI checks** — available once all check runs have completed and at least one has failed.
- **Unresolved review threads** — non-outdated GitHub review threads that still require action.

### How it works

The user opens the issue resolver modal from the PR detail pane and selects a scope (`checks`, `comments`, or `both`). ADE assembles a structured prompt from the live PR state (failing checks with workflow run detail, unresolved review threads with compact summaries, changed files, recent commits, and PR context), then launches a chat agent session in the lane worktree with that prompt.

The prompt assembly is handled by `prIssueResolver.ts` in the main process. The shared availability logic in `prIssueResolution.ts` determines which scopes are selectable based on current check and thread state.

### Agent tools for issue resolution

Chat agents working on PR issue resolution have access to four dedicated workflow tools in addition to the standard workflow tool set:

| Tool | Purpose |
|---|---|
| `prRefreshIssueInventory` | Fetch the latest checks, review threads, and comments so the agent can re-evaluate what still needs fixing |
| `prRerunFailedChecks` | Re-trigger failed GitHub Actions check runs after applying fixes |
| `prReplyToReviewThread` | Post a reply on a GitHub review thread |
| `prResolveReviewThread` | Mark a GitHub review thread as resolved |

These tools keep the agent loop self-contained: the agent can inspect issues, fix code, reply to reviewers, rerun CI, and resolve threads without leaving the ADE runtime.

### Review thread management

The PR service exposes review thread data through a dedicated GraphQL-backed `getReviewThreads` method and supports thread replies and resolution via `replyToReviewThread` and `resolveReviewThread`. These are available through IPC for both the renderer UI and agent tool surfaces. Review thread comments and PR reviews now include `authorAvatarUrl` / `reviewerAvatarUrl` fields for richer UI presentation.

### Queue-aware rebase

Rebase suggestions for queued PRs are now queue-aware. The conflict service calls `fetchQueueTargetTrackingBranches()` before scanning rebase needs, then uses `resolveQueueRebaseOverride()` per lane to determine the correct comparison ref. When a lane belongs to an active merge queue, the rebase targets the queue's tracking branch rather than the lane's static base branch. Queue group context is propagated into the rebase need for display in the rebase UI. AI-assisted rebase (`rebaseLane`) also respects the queue override, and the rebase request accepts `modelId` and `reasoningEffort` parameters for finer control over the AI rebase agent. Permission is set via provider-native fields (`unifiedPermissionMode`).

For non-queued stacked lanes, the conflict service now uses `resolveLaneRebaseTarget()` to determine the comparison ref. When the parent lane is a primary lane, the comparison ref resolves to `origin/<branch>` (the remote tracking branch) rather than the local HEAD. This keeps conflict prediction and rebase suggestions consistent with the lane service's own rebase behavior, which targets the remote tracking branch for primary parents.

---

## Queue workflow model

Queue tab state management is now extracted into a dedicated model (`queueWorkflowModel.ts`) that handles:

- active/history bucketing of queue groups
- current member selection based on landing state or open PR position
- manual land warning generation from PR status
- queue guidance computation (idle, ready, warning, blocked, success tones with action recommendations)

This keeps queue tab rendering logic testable and separated from the component tree.

---

## PR route state

PR page tab navigation is now URL-driven through `prsRouteState.ts`. The route state encodes the active tab, workflow sub-tab, selected PR, queue group, and lane into URL search parameters. This makes PR tab state shareable and preserves selection across navigation.

---

## Conflict marker parsing

The PR service's conflict marker parser (`parseConflictMarkers`) now handles `\r\n` line endings alongside `\n`, improving compatibility with Windows-style line endings in conflict files. The parser is extracted as a shared utility used by both `readConflictFilePreviewFromWorktree` and integration merge flows.

---

## Workflow tool checks status logic

The `prRefreshIssueInventory` workflow tool now evaluates checks status with a failure-first priority: if any check has `conclusion === "failure"`, the status is `"failing"` regardless of other check states. Previously, a mix of passing and failing checks could incorrectly report `"passing"` when all-success was checked first.

---

## Issue inventory and convergence loop

ADE tracks PR issues (failing CI checks, unresolved review threads, and issue comments) in a structured inventory backed by the `pr_issue_inventory` table. The `issueInventoryService` syncs from live GitHub data, classifies issues by source (CodeRabbit, Codex, Copilot, human, ADE), extracts severity from comment text and emoji patterns, and computes a round-based convergence status.

### Convergence model

The inventory operates in rounds. Each round:

1. Sync the current checks, review threads, and comments into the inventory.
2. Send unresolved items to an agent for resolution.
3. After the agent completes, re-sync to see what was fixed and what is new.
4. Repeat until all issues are resolved, the round cap is reached, or convergence stalls.

The `ConvergenceStatus` tracks per-round statistics (new, fixed, dismissed counts), whether progress is being made (`isConverging`), and whether auto-advance is possible (`canAutoAdvance`). The default maximum is 5 rounds.

### Pipeline settings

The `PipelineSettings` type configures the auto-converge pipeline per PR:

- `autoMerge` -- whether to auto-merge after convergence completes
- `mergeMethod` -- merge commit, squash, rebase, or repo default
- `maxRounds` -- convergence round cap
- `onRebaseNeeded` -- pause convergence or auto-rebase when the branch falls behind

Settings are persisted per PR in the key-value store and editable from the convergence panel.

### Convergence panel

The `PrConvergencePanel` is a slide-over panel in the PR detail pane. It displays the issue inventory grouped by severity, convergence progress (round indicator, fix/dismiss/escalate counts), an embedded agent chat pane for the active resolution session, and pipeline settings controls.

The auto-converge mode polls GitHub after each agent session completes. It waits for CI checks to finish and comment counts to stabilize (2 consecutive polls with the same count) before triggering the next round. A pause reason banner surfaces when convergence is blocked by rebase needs or round limits.
