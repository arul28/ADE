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
| `prService.ts` | PR CRUD, GitHub sync, merge context, draft descriptions, check/review/comment hydration, commit snapshots (`getCommits`), integration proposals, merge-into-existing-lane adoption, merge bypass, post-merge cleanup, standalone PR branch cleanup (`cleanupBranch`), deployment listing, review-thread reply/resolve/react mutations for the timeline, and the aggregate `getMobileSnapshot` that powers the iOS PRs tab |
| `prService.mobileSnapshot.test.ts` | Coverage for the mobile snapshot builder: stack chaining, capability gates, per-lane create eligibility, workflow-card aggregation |
| `prService.mergeInto.test.ts` | Coverage for integration proposals that preview or adopt an existing merge target lane, including dirty-worktree handling and drift metadata. |
| `prPollingService.ts` | 60 s polling loop, fingerprint-based change detection, notification emission. Writes `last_polled_at` per PR so callers can run delta polls on the next tick |
| `prSummaryService.ts` | AI PR summary generator; caches `PrAiSummary` per `(prId, headSha)` in `pull_request_ai_summaries` so pushes invalidate the cache |
| `queueLandingService.ts` | Merge queue state machine (`ALLOWED_TRANSITIONS`), landing loop, auto-resolve on conflicts |
| `integrationPlanning.ts` | `buildIntegrationPreflight` — validates source lanes for an integration proposal |
| `integrationValidation.ts` | `parseGitStatusPorcelain`, `hasMergeConflictMarkers` — shared helpers for integration flows |
| `issueInventoryService.ts` | Typed issue inventory, per-round convergence status, participant classification, thread re-open logic |
| `prIssueResolver.ts` | Builds issue-resolution prompts for the agent, launches chat session |
| `prRebaseResolver.ts` | Builds rebase-resolution prompts, launches chat session |
| `resolverUtils.ts` | Shared permission-mode mapping, recent commit reading, comment noise filter, and the `looksLikeResolutionAck` heuristic that flags resolved-looking replies on unresolved review threads |

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
| `tabs/IntegrationTab.tsx` | Integration (merge-plan) proposals and execution, including merge-into-lane selection, apply-and-resimulate, and adopted-lane cleanup messaging |
| `tabs/RebaseTab.tsx` | Lane rebase needs (base + queue + PR target) and attention items |
| `tabs/WorkflowsTab.tsx` | Container for queue/integration/rebase sub-tabs |
| `tabs/queueWorkflowModel.ts` | Pure model for queue tab rendering (active/history bucketing, guidance computation) |
| `detail/PrDetailPane.tsx` | Selected PR detail pane: status, checks, reviews, comments, merge readiness, bypass, convergence, resolver modals. Switches the Overview tab between the legacy grid and the Timeline+Rails layout based on `prsTimelineRailsEnabled`. Persists the selected sub-tab (`overview | convergence | files | checks | activity`) per PR in `localStorage` under `ade:prs:detailTabs:v1`, mirrored through the `detailTab` URL param so deep links restore the last-used tab |
| `detail/PrDetailTimelineRails.tsx` | Timeline+Rails overview: merges timeline events, commit rail (seeded from both `PrActivityEvent.commit_push` entries and the `getCommits` snapshot), status rail, deployment cards, AI summary, and command-palette navigation (`g c` / `g t` / `g f` and `[` / `]`) |
| `shared/PrTimeline.tsx` | Timeline column: synthesises `PrTimelineEvent`s from detail data, handles per-PR filters (`PrTimelineFilters`), renders grouped events |
| `shared/PrCommitRail.tsx`, `shared/PrStatusRail.tsx` | Right-hand rails on the timeline view: commit list, checks/reviews summary, deployment chips |
| `shared/PrCommandPalettes.tsx` | `g c` (commits) / `g t` (threads) / `g f` (files) palettes opened by the keyboard chord and by the timeline toolbar |
| `shared/PrAiSummaryCard.tsx` | AI summary card above the timeline; dismissible per PR (state in `PrsContext.dismissedAiSummaries`), with a "Regenerate" action wired to `prSummaryService.regenerateSummary` |
| `shared/PrReviewThreadCard.tsx`, `shared/PrBotReviewCard.tsx` | Rich thread cards for the timeline (bot-review collapse, reply box, resolve/react actions) |
| `shared/PrDeploymentCard.tsx` | Deployment row used in the status rail and on the timeline |
| `shared/PrConvergencePanel.tsx` | Auto-converge slide-over panel with issue inventory, agent session embed, pipeline settings |
| `shared/PrIssueResolverModal.tsx` | Launch issue resolution (checks/comments/both scopes) |
| `shared/PrAiResolverPanel.tsx` | AI resolver launch controls in Rebase/Integration flows, including additional-instructions passthrough |
| `shared/PrPipelineSettings.tsx` | Auto-converge pipeline settings per PR |
| `shared/PrLaneCleanupBanner.tsx` | Post-merge cleanup banner on the PR detail. Also renders a dedicated "PR branch cleanup" variant when the PR is linked to the primary lane but its head branch differs — the primary lane is never deleted, but the user can still delete the local and/or remote PR branch after confirming `delete <branch>` |
| `shared/IntegrationPrContextPanel.tsx` | Integration PR context panel |
| `shared/prVisuals.tsx` | CI running indicator, check/review badges, dot colors, activity derivation |
| `shared/rebaseNeedUtils.ts` | Rebase need dedup, route selection, upstream rebase chain |
| `shared/rebaseAttentionUtils.ts` | Auto-rebase attention items for the Rebase tab |
| `shared/lanePrWarnings.ts` | Pre-submit lane-health warnings |
| `shared/laneBranchTargets.ts` | Target branch resolution for PR creation |
| `ConflictFilePreview.tsx` | File-level conflict marker preview |
| `PrRebaseBanner.tsx` | Rebase banner on a PR |
| `PrConflictBadge.tsx` | Lightweight conflict chip |

Shared contracts:

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/shared/types/prs.ts` | PR DTOs and integration proposal contracts, including `preferredIntegrationLaneId`, `mergeIntoHeadSha`, `integrationLaneOrigin`, and `additionalInstructions` fields. |
| `apps/desktop/src/shared/types/conflicts.ts` | Conflict resolver DTOs; `PrepareResolverSessionArgs.additionalInstructions` is appended to generated resolver prompts. |
| `apps/desktop/src/shared/ipc.ts` / `apps/desktop/src/preload/preload.ts` | PR IPC constants and renderer bridge for proposal simulation, update, commit, resolver, and cleanup flows. |

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
- `ade.prs.getMergeContext`, `ade.prs.getStatus`, `ade.prs.getChecks`, `ade.prs.getReviews`, `ade.prs.getComments`, `ade.prs.getFiles`, `ade.prs.getCommits`
- `ade.prs.cleanupBranch` — delete a merged/closed PR's local and/or remote branch without touching the lane (protected against deleting any primary-lane branch)
- `ade.prs.updateDescription`, `ade.prs.updateTitle`, `ade.prs.updateBody`, `ade.prs.setLabels`, `ade.prs.requestReviewers`, `ade.prs.submitReview`, `ade.prs.close`, `ade.prs.reopen`
- `ade.prs.getReviewThreads`, `ade.prs.replyToReviewThread`, `ade.prs.resolveReviewThread`
- `ade.prs.postReviewComment`, `ade.prs.setReviewThreadResolved`, `ade.prs.reactToComment` — GraphQL-backed mutations used by the timeline's thread cards
- `ade.prs.getDeployments` — deployments for the PR's head SHA, with the latest status status URL and environment URL
- `ade.prs.getAiSummary` / `ade.prs.regenerateAiSummary` — cached/forced `PrAiSummary` per `(prId, headSha)`
- `ade.prs.launchIssueResolutionFromThread` — launch an agent chat pre-focused on a specific review thread (used by the thread card's "Resolve with agent" action)
- `ade.prs.issueResolutionStart`, `ade.prs.issueResolutionPreview`
- `ade.prs.rebaseResolutionStart`
- `ade.prs.convergenceStateGet`, `ade.prs.convergenceStateSave`, `ade.prs.convergenceStateDelete`
- `ade.prs.getGitHubSnapshot` — merged repo + external PR snapshot
- `ade.prs.simulateIntegration`, `ade.prs.createIntegrationLaneForProposal`, `ade.prs.commitIntegration`, `ade.prs.cleanupIntegrationWorkflow`

Integration merge-into flow uses these existing channels with widened
DTOs:

- `ade.prs.simulateIntegration` accepts `mergeIntoLaneId`. Pairwise
  child-vs-child checks still use `baseBranch`, while the sequential
  preview starts at the selected lane's current HEAD and returns
  `mergeIntoHeadSha`.
- `ade.prs.updateIntegrationProposal` can set
  `preferredIntegrationLaneId`, store `mergeIntoHeadSha`, and clear an
  existing integration binding when the merge target changes.
- `ade.prs.createIntegrationLaneForProposal` and
  `ade.prs.commitIntegration` accept `allowDirtyWorktree`; commit can
  also receive `preferredIntegrationLaneId` to override the stored
  preference.
- `ade.prs.aiResolutionStart` and issue-resolution launch args accept
  `additionalInstructions`, which are appended to the generated
  resolver prompt after the structured context.

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

PR rows in `tabs/GitHubTab.tsx` and queue member rows in `tabs/QueueTab.tsx`
render the linked lane's color through `LaneAccentDot` (resolved from the
app store via `useLaneColorById` / a `Map<laneId, color>`); the rest of the
row text inherits the lane color so a glance correlates a PR with its lane
across the queue / GitHub / Workflows tabs.

## GitHub connectivity model

`getStatus()` in `apps/desktop/src/main/services/github/githubService.ts`
returns a `GitHubStatus` shaped to be the single source of truth for
"GitHub is usable here" — UI banners and badges read `status.connected`
rather than re-deriving from individual fields.

Fields:

- `tokenStored`, `tokenDecryptionFailed`, `tokenType` — `classic` |
  `fine-grained` | `unknown`. Set from token prefix on save.
- `userLogin`, `scopes`, `checkedAt` — outcome of `validateToken` (calls
  `GET /user`). Classic tokens populate `scopes` from
  `x-oauth-scopes`; fine-grained tokens never return that header so
  `scopes` is empty.
- `repo` — auto-detected origin owner/name.
- `repoAccessOk: boolean | null`, `repoAccessError: string | null` —
  result of an explicit `GET /repos/{owner}/{name}` probe
  (`probeRepoAccess`). `null` means no probe was run (no repo to
  probe, or `getStatus` returned early on a token-error path).
- `connected: boolean` — computed by `computeConnected`:
  - `false` if token is missing or `userLogin` is null.
  - For `fine-grained` tokens: requires the repo probe to pass (or no
    repo to probe). This is the only reliable check because fine-grained
    permissions are not introspectable from headers; a token can
    authenticate as a user yet 403 every PR-tab call.
  - For `classic` tokens: requires `getGitHubTokenAccessState(scopes)`
    to report `hasRequiredAccess`.
  - For `unknown` token prefixes: best-effort — `userLogin` is enough.

Status is cached in-memory for 30 s. The cache is bypassed when the
caller passes `getStatus({ forceRefresh: true })` (Settings'
"REFRESH" button does this so the user can fix permissions on
github.com and immediately re-check). When the cache is hit but the
auto-detected `repo` has changed, `repoAccessOk` is reset to `null`
because the cached probe no longer applies.

Status changes broadcast through the `ade.github.statusChanged` IPC
channel (`window.ade.github.onStatusChanged`) every time
`setToken` / `clearToken` is called. `AppShell` subscribes so the
unconnected-banner state reflects the latest status the moment
Settings saves a new token — fixing the prior bug where Settings said
CONNECTED while the AppShell banner still said disconnected.

`renderer/components/settings/GitHubSection.tsx` distinguishes:

- `tokenAuthenticated` — token decrypted and `userLogin` is populated.
- `isConnected` (`status.connected` from the backend) — the actual
  "GitHub is usable" gate. Drives the green CONNECTED / amber LIMITED
  ACCESS / muted NOT CONNECTED label and any saved-and-verified
  notice.
- A repo-probe-failed inline error renders when the token authenticated
  but the probe came back 403/404, with copy that asks the user to
  grant Contents (Read), Pull requests (Read and write), and Metadata
  (Read) on the active repo (fine-grained tokens) or to make sure the
  classic token has access to the repo.

`AppShell.describeGithubBanner(status)` mirrors the same three-way
split for the banner copy: "not connected" / "cannot access
{owner}/{repo}" / "missing required permissions".

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

In-app, the App Shell renders these events as PR toasts. Their
"View PR" action now navigates straight into the PR detail drawer
on `/prs` via `buildPrsRouteSearch`, with `selectedPrId` set to the
event's PR id and `detailTab` chosen from the event kind:
`checks_failing` → `checks`, `changes_requested` /
`review_requested` → `activity`, everything else → drawer overview.
This replaces the older "select lane + open lane inspector merge
tab" route, which depended on the lane being currently focused and
forced the user to leave the PRs surface to follow up on a PR
event.

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

### Standalone PR branch cleanup

`prService.cleanupBranch` is a second cleanup entry point scoped to the
PR branch itself rather than a lane. It is reachable from
`PrLaneCleanupBanner` when the PR is linked to the primary lane but its
head branch differs, which happens after a manual import / re-link.
Guarantees:

- refuses to run unless the PR is `merged` or `closed`
- refuses to delete any branch that matches a primary lane's branch ref
- local deletion uses `git branch -D` after `git show-ref --verify`
- remote deletion uses `git push <remote> --delete` after `git ls-remote
  --heads` confirms the branch exists on the remote
- returns a `CleanupPrBranchResult` with independent `localDeleted` /
  `remoteDeleted` booleans and per-side error strings; partial failures
  log `prs.branch_cleanup_partial_failure` but do not throw

`linkToLane` also now guards against cross-linking: linking a PR to a
lane whose branch ref does not match the PR's head branch throws
instead of silently linking mismatched branches.

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

The generated prompt frames each session as one bounded Path-to-Merge
round: the agent makes a coherent set of fixes for the current
inventory, commits and pushes, and stops with a concise final note
(what changed, what was validated, whether it pushed, and any blocker).
The agent is explicitly told not to wait indefinitely for CI or
advisory review bots — ADE's poller will observe post-push comments
and launch the next round if new actionable work appears.

## Convergence loop

`issueInventoryService.ts` tracks PR issues (failing checks,
unresolved review threads, issue comments) in the `pr_issue_inventory`
table. It classifies by source (CodeRabbit, Codex, Copilot, human,
ADE), extracts severity from emoji/text patterns, and computes a
per-round `ConvergenceStatus`.

Thread tracking fields: `thread_comment_count`,
`thread_latest_comment_id`, `thread_latest_comment_author`,
`thread_latest_comment_at`, `thread_latest_comment_source`.

A thread is treated as `fixed` when GitHub reports it as resolved or
outdated, **or** when the latest reply on an unresolved thread from a
non-bot author pattern-matches as a resolution acknowledgement
(`looksLikeResolutionAck` in `resolverUtils.ts`). The helper rejects
obvious negations ("not fixed", "still not resolved", etc.) before it
accepts phrases like "fixed", "addressed", "no longer applies",
"clear-to-merge", or "CI green". Bot sources (CodeRabbit, Copilot,
Codex) still use the original resolved/outdated signal only.

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
next round. Auto-merge additionally requires a non-empty check list: if
GitHub returns zero checks for the PR, the poller pauses with
`Auto-merge paused because GitHub returned no check data for this PR.`
instead of merging on vacuously-true "all checks passed".

Detail-pane inventory sync is now skipped entirely for merged or
closed PRs — `syncInventory()` returns early, `refreshDetailSurface`
omits the inventory leg, and `PrConvergencePanel` receives a
`terminalState` signal so the panel renders the terminal summary
instead of offering auto-converge controls. `newIssueCount` also zeroes
for terminal PRs so sticky action-bar badges don't attach to a dead PR.

## Integration merge target adoption

An integration proposal can target an existing lane instead of always
creating a fresh `integration-*` child lane:

1. The user selects a merge target lane in `IntegrationTab` or
   `CreatePrModal`. The selected lane cannot be one of the proposal's
   source lanes and cannot be the primary lane.
2. Simulation persists `preferredIntegrationLaneId` plus the selected
   lane's `mergeIntoHeadSha`. This lets the UI warn when the adopted
   lane has drifted since the last preview.
3. Pairwise conflict checks between source lanes remain anchored to the
   proposal's `baseBranch`; additional merge-tree checks compare the
   adopted lane HEAD against each source lane so existing work on the
   target lane is represented.
4. Creating/committing the proposal either reuses the adopted lane
   (`integrationLaneOrigin: "adopted"`) or creates an ADE-owned lane
   (`"ade-created"`). Cleanup messaging follows that origin: deleting a
   proposal keeps adopted lanes by default.

The corresponding database columns are
`integration_proposals.preferred_integration_lane_id` and
`integration_proposals.merge_into_head_sha`. iOS mirrors both in its
bootstrap schema and `IntegrationProposal` model so synced PR workflow
cards can display the same state.

## Timeline + Rails overview (PRs tab redesign)

`PrDetailPane` renders two different layouts for the Overview tab
depending on `prsTimelineRailsEnabled` in `PrsContext`:

- **Legacy grid** — the original checks/reviews/comments cards.
- **Timeline + Rails** — `PrDetailTimelineRails` with a central event
  timeline (`PrTimeline`), a commit rail, a status/deployments rail,
  and an AI summary card.

Per-PR state (all persisted to `localStorage` under
`ade:prs:timelineFiltersByPrId`, `ade:prs:dismissedAiSummaries`,
`ade:prs:timelineRailsEnabled`):

- `PrTimelineFilters` — which event types to show (description,
  commits, reviews, threads, comments, checks, deployments, labels,
  merges).
- `dismissedAiSummaries[prId]` — whether the AI summary card is
  collapsed for this PR.
- `viewerLogin` — authenticated GitHub login used to highlight
  reactions the viewer already placed.

Deep linking: `prsRouteState` carries `eventId`, `threadId`,
`commitSha`, and `detailTab` in the URL. `PRsPage` preserves them as
long as the URL still points at the selected PR and drops them when the
PR changes. `PrDetailPane` reads them on mount to scroll / open the
right card and to pick the right sub-tab. `PRsPage` also writes the
most recent `/prs...` path to `localStorage` via `writeStoredPrsRoute`
scoped per project root, so the top-bar `TabNav` can route back to the
user's last PR selection when they click the PRs tab from elsewhere.

Commit sources: `buildTimelineEvents` folds in commits from two
streams — `PrActivityEvent.commit_push` entries and the
`getCommits(prId)` snapshot. Commits that appear in both are
deduplicated by SHA, with the activity path taking precedence (so
force-push metadata survives). Commit rows render as a full-width
"commit divider" instead of an inline timeline entry, so they visually
separate review / comment activity into before/after-commit bands.

Keyboard shortcuts (bound only when Timeline+Rails is active and the
Overview tab is selected):

| Chord | Action |
|------|--------|
| `g c` | Open the commit palette |
| `g t` | Open the unresolved-threads palette |
| `g f` | Open the changed-files palette |
| `[` / `]` | Prev / next unresolved thread |

## AI summary cache

`prSummaryService` generates a `PrAiSummary` (summary text, risk
areas, reviewer hotspots, unresolved concerns) via the AI integration
service and caches it in `pull_request_ai_summaries` keyed by
`(pr_id, head_sha)`. Pushing new commits advances `head_sha`
(maintained by `prService.upsertFromGithub`) so the next read misses
and the summary regenerates. `regenerateSummary` forces a rebuild
regardless of cache state.

## Delta polling cursor

`prPollingService` writes `last_polled_at` on every PR after a
successful tick. The cursor is exposed via `getLastPolledAt(prId)` so
downstream services that hit GitHub with `since=` parameters (review
threads, comments) can skip work they already saw. The cursor is
best-effort — failures log a warning and do not abort the tick.

## Renderer wiring

- `PRsPage` parses URL state via `parsePrsRouteState` and writes it
  back with `buildPrsRouteSearch`. Active tab, workflow sub-tab,
  selected PR, queue group, lane, and rebase item are all encoded.
- `PrsContext` owns PR list, queue states, rebase needs, proposals,
  convergence runtime state, and the Timeline+Rails UI state
  (`prsTimelineRailsEnabled`, `timelineFiltersByPrId`,
  `dismissedAiSummaries`, `viewerLogin`, `detailReviewThreads`,
  `detailDeployments`, `detailAiSummary`). It caches convergence state
  per PR and exposes `loadConvergenceState` / `saveConvergenceState` /
  `resetConvergenceState`, plus `setTimelineFilters`,
  `setAiSummaryDismissed`, and `regeneratePrAiSummary`.
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

The ADE CLI exposes the issue inventory service to terminal-capable
agent workflows.

## Mobile snapshot

`prService.getMobileSnapshot()` produces a `PrMobileSnapshot` for the
iOS PRs tab in one call (exposed over sync as
`prs.getMobileSnapshot`). Types live in
`apps/desktop/src/shared/types/prs.ts`.

```ts
type PrMobileSnapshot = {
  generatedAt: string;
  prs: PrSummary[];
  stacks: PrStackInfo[];                              // lane chains with >=1 PR
  capabilities: Record<string, PrActionCapabilities>; // per-PR action gates
  createCapabilities: PrCreateCapabilities;           // which lanes can create
  workflowCards: PrWorkflowCard[];                    // queue/integration/rebase
  live: boolean;                                      // false → phone banner
};
```

Builder responsibilities:

- **Stacks** (`buildStackInfos` / `collectStackMembers`) — walks
  `laneService.list` in parent → child order, tagging each member
  with `role` (`root | middle | leaf`), `depth`, and linked PR fields
  when a PR exists for the lane. Stacks without any PRs are dropped.
- **Capabilities** (`capabilitiesForPr`) — gates `canMerge` on
  `state === "open"` and non-failing checks; blocks merges on drafts
  and closed/merged PRs with an explicit `mergeBlockedReason`.
  `requiresLive` is always true today — all listed actions need a
  live host.
- **Create eligibility** (`buildCreateCapabilities`) — enumerates
  non-primary, non-archived lanes, marks lanes as ineligible when an
  open/draft PR already exists, and resolves the default base branch
  through `resolveStableLaneBaseBranch`.
- **Workflow cards** (`buildWorkflowCards`) — pulls non-terminal
  queue entries from `queue_landing_state` joined with `pr_groups`,
  active integration proposals via `listIntegrationWorkflows({ view:
  "active" })`, and undismissed rebase suggestions from
  `rebaseSuggestionService`. Failures in any source log a warning
  and skip that card category rather than failing the whole snapshot.

The snapshot is read-only; create/merge/close/comment actions go
through the existing command surface (`prs.createFromLane`,
`prs.land`, `prs.close`, `prs.addComment`, `prs.rerunChecks`,
`prs.draftDescription`). The mobile client calls `getMobileSnapshot`
on open and re-fetches on focus or after a successful mutation.

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
