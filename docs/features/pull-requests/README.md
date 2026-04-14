# Pull requests

ADE's pull-request surface manages lane-backed PRs, stacked PR chains,
PR merge queues, integration (merge-plan) proposals, and GitHub
inspection. It treats local git state as the source of truth for
merge/integration simulation while keeping remote GitHub state warm
through layered caching.

This folder documents:

- [`stacking.md`](./stacking.md) — stacked PR chains, rebase ordering, queue-aware rebase targeting.
- [`queue.md`](./queue.md) — PR merge queue model and landing state machine.
- [`conflict-simulation.md`](./conflict-simulation.md) — how ADE predicts PR merge conflicts before the user hits Merge.

## Source file map

Main-process services (`apps/desktop/src/main/services/prs/`):

| File | Responsibility |
|------|---------------|
| `prService.ts` | PR CRUD, GitHub sync, merge context, draft descriptions, check/review/comment hydration, integration proposals, merge bypass, post-merge cleanup |
| `prPollingService.ts` | 60 s polling loop, fingerprint-based change detection, notification emission |
| `queueLandingService.ts` | Merge queue state machine (`ALLOWED_TRANSITIONS`), landing loop, auto-resolve on conflicts |
| `integrationPlanning.ts` | `buildIntegrationPreflight` — validates source lanes for an integration proposal |
| `integrationValidation.ts` | `parseGitStatusPorcelain`, `hasMergeConflictMarkers` — shared helpers for integration flows |
| `issueInventoryService.ts` | Typed issue inventory, per-round convergence status, participant classification, thread re-open logic |
| `prIssueResolver.ts` | Builds issue-resolution prompts for the agent, launches chat session |
| `prRebaseResolver.ts` | Builds rebase-resolution prompts, launches chat session |
| `resolverUtils.ts` | Shared permission-mode mapping, recent commit reading, comment noise filter |

Renderer components (`apps/desktop/src/renderer/components/prs/`):

| File | Responsibility |
|------|---------------|
| `PRsPage.tsx` | Top-level tab shell (GitHub vs Workflows) with URL-driven state |
| `state/PrsContext.tsx` | PR data provider (list, selection, queue groups, rebase needs, convergence runtime state) |
| `prsRouteState.ts` | URL ↔ page state mapping |
| `CreatePrModal.tsx` | Draft/queue/integration PR creation with lane warnings, branch name validation |
| `tabs/NormalTab.tsx` | Normal PR list |
| `tabs/GitHubTab.tsx` | Unified repo + external PR browser with label filters, CI badges, review indicators |
| `tabs/QueueTab.tsx` | Merge queue UI |
| `tabs/IntegrationTab.tsx` | Integration (merge-plan) proposals and execution |
| `tabs/RebaseTab.tsx` | Lane rebase needs (base + queue + PR target) and attention items |
| `tabs/WorkflowsTab.tsx` | Container for queue/integration/rebase sub-tabs |
| `tabs/queueWorkflowModel.ts` | Pure model for queue tab rendering (active/history bucketing, guidance computation) |
| `detail/PrDetailPane.tsx` | Selected PR detail pane: status, checks, reviews, comments, merge readiness, bypass, convergence, resolver modals |
| `shared/PrConvergencePanel.tsx` | Auto-converge slide-over panel with issue inventory, agent session embed, pipeline settings |
| `shared/PrIssueResolverModal.tsx` | Launch issue resolution (checks/comments/both scopes) |
| `shared/PrAiResolverPanel.tsx` | AI rebase launch controls in Rebase tab |
| `shared/PrPipelineSettings.tsx` | Auto-converge pipeline settings per PR |
| `shared/PrLaneCleanupBanner.tsx` | Post-merge cleanup banner on the PR detail |
| `shared/IntegrationPrContextPanel.tsx` | Integration PR context panel |
| `shared/prVisuals.tsx` | CI running indicator, check/review badges, dot colors, activity derivation |
| `shared/rebaseNeedUtils.ts` | Rebase need dedup, route selection, upstream rebase chain |
| `shared/rebaseAttentionUtils.ts` | Auto-rebase attention items for the Rebase tab |
| `shared/lanePrWarnings.ts` | Pre-submit lane-health warnings |
| `shared/laneBranchTargets.ts` | Target branch resolution for PR creation |
| `ConflictFilePreview.tsx` | File-level conflict marker preview |
| `PrRebaseBanner.tsx` | Rebase banner on a PR |
| `PrConflictBadge.tsx` | Lightweight conflict chip |

## Core model

`PrSummary` (selected fields, full type in `src/shared/types.ts`):

```ts
type PrSummary = {
  id: string;
  laneId: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  githubUrl: string;
  title: string;
  state: PrState;          // open | closed | merged
  baseBranch: string;
  headBranch: string;
  checksStatus: PrChecksStatus;    // passing | failing | pending | unknown
  reviewStatus: PrReviewStatus;    // approved | changes_requested | review_required | ...
  labels: PrLabel[];
  isBot: boolean;
  commentCount: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

`PrStatus` adds live fields not cached on the summary row
(mergeability, behind-by, merge conflicts, activity events).

## IPC surface

Selected channels exposed through `preload.ts`:

- `ade.prs.createFromLane`, `ade.prs.createQueue`, `ade.prs.createIntegration`
- `ade.prs.listAll`, `ade.prs.listProposals`, `ade.prs.listQueueStates`
- `ade.prs.land`, `ade.prs.landStack`, `ade.prs.landStackEnhanced`, `ade.prs.landQueueNext`
- `ade.prs.getMergeContext`, `ade.prs.getStatus`, `ade.prs.getChecks`, `ade.prs.getReviews`, `ade.prs.getComments`, `ade.prs.getFiles`
- `ade.prs.updateDescription`, `ade.prs.updateTitle`, `ade.prs.updateBody`, `ade.prs.setLabels`, `ade.prs.requestReviewers`, `ade.prs.submitReview`, `ade.prs.close`, `ade.prs.reopen`
- `ade.prs.getReviewThreads`, `ade.prs.replyToReviewThread`, `ade.prs.resolveReviewThread`
- `ade.prs.issueResolutionStart`, `ade.prs.issueResolutionPreview`
- `ade.prs.rebaseResolutionStart`
- `ade.prs.convergenceStateGet`, `ade.prs.convergenceStateSave`, `ade.prs.convergenceStateDelete`
- `ade.prs.getGitHubSnapshot` — merged repo + external PR snapshot
- `ade.prs.simulateIntegration`, `ade.prs.createIntegrationLaneForProposal`, `ade.prs.commitIntegration`, `ade.prs.cleanupIntegrationWorkflow`

## GitHub data-loading model

The GitHub tab renders a unified list of repo PRs and external PRs
involving the current user, sorted by creation date. A scope filter
(`all` / `ade` / `external`) replaces the previous separate toggle.

Caching layers:

1. **Main process cache** — GitHub snapshot is cached for a short TTL
   inside `prService`; repeated in-flight snapshot requests are
   deduplicated.
2. **Renderer cache** — `PrsContext` holds the last snapshot so
   revisiting the tab renders immediately.
3. **Manual sync** — a "Refresh" action forces a fresh pull.

Snapshot contents include `labels` (name, color, description),
`isBot`, and `commentCount` fields so filters can run locally.

## Background polling

`prPollingService` runs at a 60 s default interval (clamped to
5 s–5 min, jittered ±10%). Each tick:

1. Pulls the current PR list via `prService`.
2. Computes a fingerprint per PR (excluding volatile timing fields:
   `lastSyncedAt`, `createdAt`, `updatedAt`, `projectId`).
3. Diffs against last seen fingerprints; only changed PRs trigger
   events/UI updates.
4. Emits `PrEventPayload` for state transitions (checks failing,
   review requested, changes requested, merge ready).

Notification titles are generic (not PR-specific) so they display
well as system notifications. The event payload includes `prTitle`,
`repoOwner`, `repoName`, `baseBranch`, `headBranch` so consumers can
format context-aware messages themselves.

## PR context loading

The PR page no longer assumes every tab loads every workflow query:

- Queue state loads only for workflow-oriented tabs.
- Merge contexts load lazily per selected PR.
- Selected PR detail (status, checks, reviews, comments) loads on
  demand.
- Background refresh updates only the stale subset using
  fingerprints, not every PR on every cycle.

## Merge bypass

When GitHub reports a PR as not mergeable (typically branch
protection), ADE surfaces an explicit opt-in to attempt the merge
anyway. The detail pane shows a checkbox when the PR is open, has
no merge conflicts, but is flagged `isMergeable: false`. The merge
request still goes through GitHub's merge API — GitHub itself
decides whether the bypass is allowed.

## Post-merge cleanup

After a successful GitHub merge, cleanup runs inside an outer
try-catch so a cleanup failure does not mask the successful merge:

- branch deletion
- group membership removal
- lane archiving (if configured)
- base branch fetch
- cache invalidation
- rebase-needs scan

Individual failures log as warnings; the operation is marked
succeeded with a `cleanupError` metadata field when anything went
wrong.

## PR issue resolution

ADE supports agent-driven resolution of PR issues for two scopes:

- `checks` — after all checks have completed and at least one failed
- `comments` — unresolved review threads (non-outdated)
- `both` — combined

`prIssueResolver.ts` assembles a structured prompt from live PR
state (failing checks + workflow run detail, unresolved threads with
compact summaries, changed files, recent commits) and launches a
chat agent session scoped to the lane worktree. The session gets
four workflow tools:

| Tool | Purpose |
|------|---------|
| `prRefreshIssueInventory` | Re-pull checks / threads / comments |
| `prRerunFailedChecks` | Re-trigger failed GitHub Actions check runs |
| `prReplyToReviewThread` | Post a reply on a review thread |
| `prResolveReviewThread` | Mark a review thread resolved |

`prRefreshIssueInventory` evaluates checks with failure-first
priority: if any check has `conclusion === "failure"`, the status is
`"failing"` regardless of other checks.

## Convergence loop

`issueInventoryService.ts` tracks PR issues (failing checks,
unresolved review threads, issue comments) in the `pr_issue_inventory`
table. It classifies by source (CodeRabbit, Codex, Copilot, human,
ADE), extracts severity from emoji/text patterns, and computes a
per-round `ConvergenceStatus`.

Thread tracking fields: `thread_comment_count`,
`thread_latest_comment_id`, `thread_latest_comment_author`,
`thread_latest_comment_at`, `thread_latest_comment_source`.

Runtime state (`pr_convergence_state` table):

```ts
type ConvergenceRuntimeState = {
  autoConvergeEnabled: boolean;
  status: ConvergenceStatus;        // idle, launching, running, polling, paused, converged, merged, failed, cancelled, stopped
  pollerStatus: PollerStatus;       // idle, scheduled, polling, waiting_for_checks, waiting_for_comments, paused, stopped
  currentRound: number;
  activeSessionId: string | null;
  activeLaneId: string | null;
  activeHref: string | null;
  pauseReason: string | null;
  errorMessage: string | null;
  lastStartedAt, lastPolledAt, lastPausedAt, lastStoppedAt: string | null;
};
```

`PipelineSettings` (per PR): `autoMerge`, `mergeMethod`, `maxRounds`,
`onRebaseNeeded` (`pause | auto_rebase`). Default `maxRounds = 5`.

The auto-converge poller waits for CI to finish and comments to
stabilize (2 consecutive polls with same count) before starting the
next round.

## Renderer wiring

- `PRsPage` parses URL state via `parsePrsRouteState` and writes it
  back with `buildPrsRouteSearch`. Active tab, workflow sub-tab,
  selected PR, queue group, lane, and rebase item are all encoded.
- `PrsContext` owns PR list, queue states, rebase needs, proposals,
  and convergence runtime state. It caches convergence state per PR
  and exposes `loadConvergenceState` / `saveConvergenceState` /
  `resetConvergenceState`.
- `PrDetailPane` is where most rich behavior concentrates:
  convergence panel (slide-over), issue resolver modal, rebase
  banner, check/review/comment sections with running indicators
  (`PrCiRunningIndicator`), merge readiness with bypass checkbox,
  PR markdown rendered with `rehype-sanitize` after `rehype-raw`.
- `GitHubTab` renders the unified repo+external list; filter tab
  counts respect the active scope.

## CTO operator tools

The CTO agent has five dedicated tools for orchestrating convergence
programmatically:

| Tool | Purpose |
|------|---------|
| `getPullRequestConvergence` | Read runtime state + settings + inventory summary |
| `updatePullRequestConvergencePipeline` | Edit pipeline settings |
| `updatePullRequestConvergenceRuntime` | Edit runtime state |
| `startPullRequestConvergenceRound` | Launch the next convergence round |
| `stopPullRequestConvergence` | Stop the active run, interrupt chat session, persist stopped state |

The MCP server also exposes the issue inventory service to external
tool consumers.

## Gotchas

- **Branch name validation in `CreatePrModal`** runs before submission
  and rejects invalid git ref characters. Skipping this produces
  opaque errors from the GitHub API.
- **`rehype-sanitize` must run after `rehype-raw`** in the PR body
  renderer. Flipping the order lets attacker-controlled HTML through.
- **Fingerprint exclusion list.** `getPrFingerprint` omits four
  fields. Adding a new volatile field without updating the exclusion
  list causes polling to emit notifications on every tick.
- **Queue transitions use `ALLOWED_TRANSITIONS`.** Invalid
  transitions are logged and rejected rather than silently applied.
  Cancel path force-fails entries in non-skippable states.
- **Post-merge cleanup is best-effort.** Never wrap the merge itself
  in the same try-catch; the merge must be reported succeeded even
  if cleanup fails.
- **Conflict marker parser handles CRLF.** `parseConflictMarkers`
  matches both `\n` and `\r\n`. Windows checkouts depend on this.
- **Convergence auto-advance needs two stable comment polls.**
  Shortening this to one causes the poller to race GitHub's comment
  propagation.
- **Review thread resolution uses GraphQL.** `prService`'s GraphQL
  path backs `getReviewThreads`, `replyToReviewThread`, and
  `resolveReviewThread`. The REST API does not expose all the
  required fields.
