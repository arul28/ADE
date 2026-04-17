# Linear Dispatch and Sync

This doc covers the runtime half of the Linear integration: how issues enter
the sync loop, how the dispatcher walks a run through its steps, and how the
closeout service pushes the terminal outcome back to Linear. Workflow
authoring and presets are covered in `workflow-presets.md`.

## Overview

Three independent loops drive issue state into the dispatcher:

1. **Webhook HTTP listener** — `linearIngressService` binds a local HTTP
   server (when a local webhook is configured) and verifies Linear's
   HMAC signature per-request.
2. **Relay poller** — `linearIngressService` long-polls a relay service
   (`linearRelay.apiBaseUrl`, `linearRelay.remoteProjectId`,
   `linearRelay.accessToken` in `automationSecretService`) when configured.
3. **Reconciliation timer** — `linearSyncService` runs every
   `reconciliationIntervalSec` seconds (floor 15s, default 30s) and walks
   the intake-discovered issue list for drift, stalled runs, and missed
   events.

All three paths ultimately call `linearSyncService.processIssueUpdate(issueId)`
or `linearSyncService.runSyncNow()`, which is the single entry into
dispatcher work.

## Issue fetch and normalization

Source file: `apps/desktop/src/main/services/cto/linearIssueTracker.ts`.

`linearIssueTracker.fetchIssueById(id)` returns a `NormalizedLinearIssue`
(see `apps/desktop/src/shared/types/linearSync.ts:530`). Fields include:

- identifier, title, description, url
- `projectId`, `projectSlug`, `teamId`, `teamKey`
- `stateId`, `stateName`, `stateType`
- `previousStateId`, `previousStateName`, `previousStateType` — populated
  from the stored snapshot row so `stateTransitions` triggers can match
- `priority`, `priorityLabel` (`urgent|high|normal|low|none`)
- `labels`, `metadataTags`
- `assigneeId`, `assigneeName`, `ownerId`, `creatorId`, `creatorName`
- `blockerIssueIds`, `hasOpenBlockers`
- `raw._snapshotHash`, `raw._previousSnapshotHash` — used to skip
  reprocessing when a webhook fires but nothing material changed

Snapshots are stored in the `linear_issue_snapshots` table keyed by
`(project_id, issue_id)` with a payload JSON and a hash.

## The sync loop

File: `apps/desktop/src/main/services/cto/linearSyncService.ts`.

`createLinearSyncService({ ..., autoStart, hasCredentials, onIssueUpdated })`
returns:

- `runSyncNow()` — one reconciliation pass. Respects `hasCredentials`,
  `inFlight` guard, and `workflowEnabled(policy)`.
- `processIssueUpdate(issueId)` — single-issue hot path used by
  ingress. Fetches, merges `previousState*` from the prior snapshot,
  calls `routingService` via `processIssueSnapshot`, then
  `advanceRuns(policy)`. When a reconciliation pass is already in
  flight, the issue id is deferred into `pendingIssueIds` and drained
  at the end of the current pass by `replayPendingIssues` — so two
  webhooks arriving during one reconciliation still both apply
  without overlapping sync runs.
- `getDashboard()` — returns `LinearSyncDashboard` for the UI.
- `listQueue({ limit })` — `LinearSyncQueueItem[]` for the queue
  dashboard.
- `resolveQueueItem(args)` — accepts a `LinearSyncResolutionAction`
  (`approve`, `reject`, `retry`, `resume`, `cancel`, plus
  `employeeOverride`) from the UI or MCP tool.
- `getRunDetail(args)` — full `LinearWorkflowRunDetail` (run, steps,
  events, sync events).
- `dispose()` — clears reconciliation timer, drops retry queue.

The timer self-starts if `autoStart !== false` and
`hasCredentials?.() === true` at creation. The headless path in
`createHeadlessLinearServices()` passes `autoStart: false` because the
MCP server drives sync through explicit JSON-RPC calls, and the
ingress service calls `processIssueUpdate` directly when events arrive.

Sync state (`enabled`, `running`, `lastPollAt`, `lastError`,
`lastSuccessAt`, `lastSkipReason`) is kept in memory and emitted via
dashboard reads; it is not persisted between restarts.

### Sync events

Structured `LinearSyncEventRecord` rows are written to `linear_sync_events`
for observability. Event types in use:

- `issue_closed` — an issue reached a terminal state type; active runs
  for that issue are cancelled as a side effect.
- `watch_only_match` — a `routing.watchOnly: true` workflow matched an
  issue. No run is created.
- `workflow_capacity_wait` — dispatch was deferred because
  `concurrency.maxActiveRuns` is saturated for the matched workflow.
- `issue_deduped` — a run already exists for this issue under the same
  workflow; the second event is a no-op under
  `concurrency.dedupeByIssue`.

The dashboard surfaces `watchOnlyHits` and `recentEvents` alongside the
queue counts so operators can see that rules fired without clicking
into individual runs.

## Intake and state-type handling

Intake is narrowly configurable via `LinearWorkflowConfig.intake`:

- `projectSlugs` — limit polling to specific Linear projects. Empty =
  all projects the token can see.
- `activeStateTypes` — defaults `["backlog", "unstarted", "started"]`;
  anything in this set is considered actionable.
- `terminalStateTypes` — defaults `["completed", "canceled"]`; reaching
  one of these types cancels active runs for the issue.

Normalization on save:

- Empty arrays fall back to the defaults.
- At least one active and one terminal state type is required; saving
  an empty intake is rejected by `linearIntakeService`.

## Routing and matching

File: `apps/desktop/src/main/services/cto/linearRoutingService.ts`.

Given a `NormalizedLinearIssue` and the current `LinearWorkflowConfig`:

1. Sort enabled workflows by descending `priority`.
2. For each workflow, build trigger groups from `triggers` fields.
3. Per-group, OR the values. A group with no values is ignored.
4. Across groups, AND. If every populated group has at least one
   matching value, the workflow is a candidate.
5. First matching workflow wins. `LinearWorkflowMatchResult` captures
   the chosen workflow, the reason, the matched signals, and the full
   candidate list (with per-workflow `matched`, `reasons`,
   `matchedSignals`, `missingSignals`) for dry-run UIs.
6. If `workflow.routing?.watchOnly === true`, a `watch_only_match` sync
   event is written and no run is created.

`LinearSyncPanel` exposes a simulator that calls routing with a
sample issue so authors can verify their triggers before enabling a
workflow.

## Dispatcher lifecycle

File: `apps/desktop/src/main/services/cto/linearDispatcherService.ts`
(2,736 lines — the largest service in the Linear stack).

`createLinearDispatcherService({ ... })` returns the dispatcher used by
`linearSyncService`. The key surface:

- `dispatchMatch(issue, match, policy)` — creates a
  `LinearWorkflowRun` row and enqueues step 0.
- `advanceRuns(policy)` — walks every non-terminal run through
  step completion / transition. This is called at the end of every
  `processIssueUpdate` and every `runSyncNow` cycle.
- `resolveQueueItem(args)` — operator-initiated action; applies
  `employeeOverride`, approves/rejects a review, resumes an
  `awaiting_delegation` run, cancels or retries a failed run.
- `cancelRun(runId, reason)` — terminal cancellation path.
- `hasActiveRuns()` — used to keep `processIssueUpdate` awake even
  without credentials so a running workflow can close out after token
  rotation.

### Step walker

A run's steps advance via `currentStepIndex`. For each step type:

- `comment_linear`, `set_linear_state`, `set_linear_assignee`,
  `apply_linear_label` — delegated to `linearOutboundService`. All
  outbound calls are wrapped in try/catch; failures log a warning and
  the run advances so transient Linear API errors do not derail the run.
- `launch_target` — creates the target artifact. Dispatches to
  `missionService` (mission), `agentChatService.createSession` /
  `ensureIdentitySession` (employee session), `workerAgentService`
  (worker run), or `prService` (PR resolution). The target id is
  stored on the run (`linkedMissionId`, `linkedSessionId`,
  `linkedWorkerRunId`, `linkedPrId`).
- `wait_for_target_status` — the run parks in `waiting_for_target`.
  `runtime_completed` accepts a missionService/workerAgent runtime
  success; `explicit_completion` requires the target to call back with
  an explicit completion (agent chat session end, worker run
  finalization).
- `wait_for_pr` — the run parks in `waiting_for_pr` until the linked PR
  is created and, if `reviewReadyWhen === "pr_ready"`, until the PR
  itself is review-ready. PR state flows from `prService` via
  `LinearWorkflowRun.prState`, `prChecksStatus`, `prReviewStatus`.
- `attach_artifacts` — uploads files or posts links through
  `linearOutboundService` and `computerUseArtifactBrokerService`.
  `artifactMode` decides between `links` and `attachments`.
- `request_human_review` — the run enters `awaiting_human_review`,
  assigns `supervisorIdentityKey`, and waits. Timeout is 48 hours;
  on timeout the step is marked failed with `review_timeout` and the
  run advances rather than stalling. `rejectAction` drives the
  rejection path (`cancel`, `reopen_issue`, or `loop_back` which
  resets `currentStepIndex` to `loopToStepId ?? "launch"`).
- `emit_app_notification` — broadcasts a
  `linear-workflow-notification` event via
  `ctoLinearWorkflowEvent` IPC. The renderer listens in `CtoPage` and
  shows it in the app notification feed.
- `complete_issue` / `reopen_issue` — terminal steps handled via
  `linearCloseoutService`.

### Multi-stage chaining

`LinearWorkflowTarget.downstreamTarget` can chain a second target after
the first. Execution context (`LinearWorkflowExecutionContext`) tracks
`activeStageIndex`, `totalStages`, and `downstreamPending`; when the
first stage completes, the dispatcher rewrites `target` to the
downstream target and restarts the step walker from the appropriate
stage. A worker run followed by a review gate is the archetypal shape.

### Employee fallback and delegation

When `resolveEmployeeTarget()` cannot find a matching ADE employee (by
worker id, slug, name, or one of the Linear identity aliases), the run
does **not** fail; it enters `awaiting_delegation` and emits a
`run.awaiting_delegation` event. Operators resolve it via the
`LinearSyncPanel` delegation dropdown or the
`resolveLinearSyncQueueItem` MCP tool, passing `employeeOverride` to
pick a specific identity.

### Retry, concurrency, dedup

- Retries use exponential back-off seeded by `retry.baseDelaySec`
  (default 30s) capped by `retry.maxAttempts` (default 3). A run in
  `retry_wait` stores the `retryAfter` timestamp; `releaseDueRetries`
  unblocks runs whose wait expired before each cycle.
- `concurrency.maxActiveRuns` gates per-workflow concurrency. When the
  cap is hit a `workflow_capacity_wait` sync event is emitted and the
  would-be run is deferred.
- `concurrency.perIssue` (default 1) prevents duplicate runs per
  issue/workflow pair. Duplicate attempts emit `issue_deduped`.
- `concurrency.dedupeByIssue` extends the dedup across workflows
  when true (global per-issue dedup).

### Snapshot refresh (v1 closeout hardening)

Before executing each step, the dispatcher refreshes the issue snapshot
from Linear via `issueTracker.fetchIssueById`. If the issue is no
longer in an active state type, the run is cancelled immediately with
an `issue_closed` reason. This covers the "operator moved the issue to
Done manually while the run was waiting" case.

### Closure notifications

When `finalizeRun` completes, the dispatcher sends a message to the
linked agent chat session (if any) informing it of the terminal
outcome and relevant artifact links. This is how employee sessions see
"your workflow just completed successfully" in-chat.

## Closeout

File: `apps/desktop/src/main/services/cto/linearCloseoutService.ts`.

`linearCloseoutService.apply(run, outcome, artifacts)`:

1. Resolves the symbolic state key (`done`, `in_progress`, `blocked`,
   `in_review`, `todo`) against the Linear workflow state catalog, or
   uses a raw state id/name when the config provides one.
2. Calls `linearOutboundService` to post a summary comment. Templates
   come from `closeout.successComment`/`failureComment` or
   `commentTemplate`.
3. Attaches proof artifacts. `artifactMode: "links"` posts URLs in the
   comment; `"attachments"` uploads via `linearOutboundService.uploadFile`.
   Repo-local paths and absolute paths outside the project root are
   both accepted, so temporary screenshots from `computer-use` sessions
   can be attached.
4. Applies `closeout.applyLabels` / `labels`.
5. Transitions the issue to `successState` or `failureState`.
6. If `resolveOnSuccess` is true, marks the run terminal with
   `terminalOutcome: "completed"`.
7. If `reopenOnFailure` is true, transitions the issue to the configured
   failure state but does not mark the run as completed, so operators
   can inspect and retry.

## Reconciliation details

`runSyncNow` walks:

1. `releaseDueRetries()` — promote `retry_wait` runs whose timer expired.
2. `advanceRuns(policy)` — step-walk every non-terminal run.
3. `intakeService.list(policy)` — pull a batch of candidate issues
   based on `intake.projectSlugs` and active state types.
4. For each issue, `processIssueSnapshot` compares the previous
   snapshot hash; if unchanged, skip routing but still advance runs.
5. Emit state-change events where `previousStateType` transitions to a
   terminal state type so `issue_closed` fires with full prior context.

## Ingress

File: `apps/desktop/src/main/services/cto/linearIngressService.ts`.

Two paths:

### Local webhook

- Bound as an HTTP server on a chosen port; URL surfaced in
  `LinearIngressStatus.localWebhook.url`.
- Verifies Linear's `linear-signature` HMAC header using the stored
  signing secret, with `timingSafeEqual` against the expected value.
- On valid delivery: persists a `LinearIngressEventRecord`, calls
  `onEvent(event)` which in turn calls
  `linearSyncService.processIssueUpdate(issueId)`.
- Signing secrets are stored via `automationSecretService` (encrypted
  app-scoped storage).

### Relay

- Long-polls a configured relay service that re-broadcasts Linear
  webhooks when the desktop is behind NAT or offline for a period.
- `ensureRelayWebhook(force)` provisions (or re-provisions) the relay
  endpoint and stores `endpointId` + `webhookUrl` + `signingSecret`
  through `automationSecretService`. Backoff is 15s when relay is
  disabled, 5s on error.
- Ingress status becomes `status: "ready"` once events flow, `"error"`
  with `lastError` populated when HMAC verification or network fails.

## IPC and MCP surface

Desktop IPC (renderer → main), from `apps/desktop/src/shared/ipc.ts`:

- Connection: `ctoGetLinearConnectionStatus`, `ctoSetLinearToken`,
  `ctoClearLinearToken`, `ctoStartLinearOAuth`,
  `ctoGetLinearOAuthSession`, `ctoSetLinearOAuthClient`,
  `ctoClearLinearOAuthClient`
- Workflow editor: `ctoGetLinearWorkflowCatalog`,
  `ctoGetLinearProjects`, `ctoRunProjectScan`
- Sync: `ctoGetLinearSyncDashboard`, `ctoRunLinearSyncNow`,
  `ctoListLinearSyncQueue`, `ctoResolveLinearSyncQueueItem`,
  `ctoGetLinearWorkflowRunDetail`
- Ingress: `ctoGetLinearIngressStatus`, `ctoListLinearIngressEvents`,
  `ctoEnsureLinearWebhook`
- Broadcast: `ctoLinearWorkflowEvent` (main → renderer)

MCP tool surface from `apps/mcp-server/src/mcpServer.ts`:

- `listLinearWorkflows`, `getLinearRunStatus`, `resolveLinearRunAction`,
  `cancelLinearRun`, `routeLinearIssueToCto`,
  `routeLinearIssueToMission`, `routeLinearIssueToWorker`,
  `rerouteLinearRun`
- `getLinearSyncDashboard`, `runLinearSyncNow`, `listLinearSyncQueue`,
  `resolveLinearSyncQueueItem`, `getLinearWorkflowRunDetail`

## Gotchas

- **`hasCredentials` guard matters for idle machines.** If the token is
  cleared while a run is mid-flight, `processIssueUpdate` will still
  pass through because `dispatcherService.hasActiveRuns()` is true.
  Once active runs drain the pipeline becomes fully dormant.
- **Outbound Linear failures do not fail the run.** Every comment /
  state-transition / artifact call is wrapped in try/catch with a
  warning log. A 502 from Linear during closeout leaves the run in a
  `completed` state on the ADE side but may leave the issue with its
  prior state in Linear. Reconciliation will repair on the next cycle
  by reading the authoritative issue state, which is one of the
  reasons reconciliation still runs even after webhook ingress is
  healthy.
- **`processIssueSnapshot` trusts the snapshot hash.** If an external
  webhook arrives with an identical `_snapshotHash`, routing is
  skipped. Force a re-route by calling `runSyncNow` or by clearing the
  snapshot row.
- **Worker targets are not supported in headless MCP mode.** The
  headless `workerHeartbeatService` always returns
  `status: "failed"` with the message *"Headless MCP mode does not
  support worker-backed Linear targets yet."* Design headless
  workflows around `mission`, `employee_session`, or `pr_resolution`
  targets.
- **`fresh_issue_lane` requires a lane-safe base ref.** When the target
  wants a fresh lane per issue, lane creation uses the base branch
  from the config; lane names include the issue identifier. Stale
  `fresh_issue_lane` directories accumulate if runs never reach
  completion and the operator does not archive them.
