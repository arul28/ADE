# Linear Integration

ADE's Linear integration attaches a Linear workspace to the CTO autonomous
orchestration layer. It ingests issues from Linear, matches each issue against
user-defined workflow definitions, dispatches the matched work as an ADE
mission, employee chat session, worker run, or PR resolution, and closes the
issue back out (state transition, comment, artifact links) when the run
terminates.

This document describes the shape of the integration: who participates, which
services own what, which tables store state, and how the desktop app and the
headless MCP server run the same pipeline.

## Who uses it

The integration is used by three distinct consumers:

1. **The CTO agent.** Linear workflows are authored, saved, and rolled back
   through the CTO tab's flow-policy surface, and the CTO agent is the
   default supervisor for review gates (`reviewerIdentityKey: "cto"`). Linear
   runs show up in the CTO's history and feed the `awaiting_human_review`
   and `awaiting_delegation` queues that operators resolve from the CTO tab.
2. **Missions.** When a Linear workflow's target type is `mission`, the
   dispatcher launches a mission through `missionService` /
   `aiOrchestratorService`, links the mission back to the
   `LinearWorkflowRun` row, and waits for mission completion before moving
   on to PR gates or closeout.
3. **The headless MCP server.** `apps/mcp-server/src/headlessLinearServices.ts`
   instantiates the full Linear service stack (sync, dispatcher, closeout,
   intake, ingress, routing, outbound, templates) so external callers can
   trigger and resolve Linear runs without the desktop UI running. The
   MCP server exposes these over JSON-RPC tools such as `listLinearWorkflows`,
   `resolveLinearRunAction`, `routeLinearIssueToCto`,
   `routeLinearIssueToMission`, and `resolveLinearSyncQueueItem`.

## Top-level shape

```
Linear (webhook / polled issues)
        |
        v
+--------------------+
| linearIngressService|      (webhook HTTP listener + relay poller)
+--------------------+
        |
        v
+--------------------+     fetchIssueById
| linearSyncService  | <---------------------+
+--------------------+                       |
        |                                    |
        v                                    |
+--------------------+    flow policy +      |
| linearRoutingService|   trigger match     |
+--------------------+                       |
        |                                    |
        v                                    |
+-----------------------+                    |
| linearDispatcherService| <-------+         |
+-----------------------+          |         |
        |                          |         |
        v                          |         |
+-----------------------+ launches |         |
| missionService /      |----------+         |
| agentChatService /    |                    |
| workerAgentService /  |                    |
| prService             |                    |
+-----------------------+                    |
        |                                    |
        v                                    |
+-----------------------+                    |
| linearCloseoutService |--------------------+
+-----------------------+   (comment / state / artifacts)
```

The two "inputs" into sync are: a relay/webhook event from
`linearIngressService` (calls `syncService.processIssueUpdate(issueId)`), or
the timer-based reconciliation pass inside `linearSyncService` itself that
polls intake on `reconciliationIntervalSec` (clamped to a 15s floor, default
30s).

## Dormant-until-configured

When no Linear token is stored, the entire pipeline sits idle. The sync
service is created with `autoStart: false` unless credentials are present,
and `hasCredentials: () => linearCredentialService.getStatus().tokenStored`
is passed in so every cycle short-circuits. No HTTP listener binds, no
reconciliation timer fires, no background CPU is consumed. Enabling the
integration is a deliberate act of storing a token (manual paste or OAuth)
in the CTO tab connection panel.

## Workflow model

A `LinearWorkflowDefinition` has six main parts:

1. **Triggers** — `assignees`, `labels`, `projectSlugs`, `teamKeys`,
   `priority`, `stateTransitions`, `owner`, `creator`, `metadataTags`. Values
   inside a trigger group are OR-ed together; populated groups are AND-ed.
   Empty groups are ignored.
2. **Routing** — `metadataTags` applied to the run and `watchOnly: true`
   which records a match but launches no work.
3. **Target** — what to create. `type` is one of `mission`,
   `employee_session`, `worker_run`, `pr_resolution`, `review_gate`. Other
   target fields set executor kind (`cto`/`employee`/`worker`), run mode
   (`autopilot`/`assisted`/`manual`), lane selection
   (`primary`/`fresh_issue_lane`/`operator_prompt`), session reuse policy,
   optional `downstreamTarget` for multi-stage chains, and `prStrategy` for
   targets that create PRs.
4. **Steps** — ordered `LinearWorkflowStep[]` the dispatcher walks through.
   Types are `comment_linear`, `set_linear_state`, `set_linear_assignee`,
   `apply_linear_label`, `launch_target`, `wait_for_target_status`,
   `wait_for_pr`, `attach_artifacts`, `request_human_review`,
   `complete_issue`, `reopen_issue`, `emit_app_notification`.
5. **Closeout** — success/failure state keys (`done`, `in_progress`,
   `blocked`, `in_review`, `todo`, or a raw Linear state), labels,
   `reviewReadyWhen` (`work_complete` / `pr_created` / `pr_ready`),
   `artifactMode` (`links` or `attachments`).
6. **Retry / concurrency / observability** — `maxAttempts`, `baseDelaySec`,
   `maxActiveRuns`, `perIssue`, `dedupeByIssue`, `emitNotifications`,
   `captureIssueSnapshot`.

Workflow source is either `"repo"` (YAML files under
`.ade/workflows/linear/**`) or `"generated"` (built from the pipeline canvas
in the renderer).

Run statuses walk through:

```
queued
  -> in_progress
  -> waiting_for_target
  -> waiting_for_pr
  -> awaiting_human_review
  -> awaiting_delegation
  -> awaiting_lane_choice
  -> retry_wait
  -> completed | failed | cancelled
```

## Source file map

Core Linear services on desktop
(`apps/desktop/src/main/services/cto/`):

- `linearCredentialService.ts` — token storage + health check
- `linearOAuthService.ts` — OAuth authorization flow
- `linearClient.ts` — GraphQL client wrapper
- `linearIssueTracker.ts` — normalization into `NormalizedLinearIssue`
- `linearTemplateService.ts` — mission/session template resolution
- `linearWorkflowFileService.ts` — YAML workflow files under `.ade/`
- `flowPolicyService.ts` — versioned policy read/write, rollback, revisions
- `linearRoutingService.ts` — match triggers against an issue, pick workflow
- `linearIntakeService.ts` — issue discovery loop, snapshots, hashes
- `linearOutboundService.ts` — comments, artifact uploads, state transitions
- `linearCloseoutService.ts` — terminal outcome application to Linear
- `linearDispatcherService.ts` — run lifecycle, step walker, retries,
  concurrency, delegation, stage chaining
- `linearSyncService.ts` — reconciliation loop, `processIssueUpdate` entry
  point, dashboard, queue, sync events
- `linearIngressService.ts` — webhook HTTP listener + relay poller, hands
  off to `syncService.processIssueUpdate`

Shared types and workflow presets:

- `apps/desktop/src/shared/types/linearSync.ts` — all `LinearWorkflow*`
  types, run statuses, event payloads, catalog types, and the legacy
  `LinearSyncConfig` kept for migration reads
- `apps/desktop/src/shared/linearWorkflowPresets.ts` — default workflow
  presets, visual plan derivation, step rebuilding. See
  `workflow-presets.md`.

Renderer wiring:

- `apps/desktop/src/renderer/components/cto/LinearSyncPanel.tsx` — the main
  CTO-tab management surface (connection, workflow editor, queue,
  dashboard, ingress status)
- `apps/desktop/src/renderer/components/cto/pipeline/*` — the visual
  pipeline canvas with trigger, stage, closeout cards

IPC wiring (`apps/desktop/src/main/services/ipc/registerIpc.ts`):

- Channels are named in `apps/desktop/src/shared/ipc.ts` under
  `ctoGetLinearConnectionStatus`, `ctoSetLinearToken`, `ctoClearLinearToken`,
  `ctoGetLinearSyncDashboard`, `ctoRunLinearSyncNow`,
  `ctoListLinearSyncQueue`, `ctoResolveLinearSyncQueueItem`,
  `ctoGetLinearWorkflowRunDetail`, `ctoGetLinearIngressStatus`,
  `ctoListLinearIngressEvents`, `ctoEnsureLinearWebhook`,
  `ctoLinearWorkflowEvent` (renderer notification broadcast),
  `ctoStartLinearOAuth`, `ctoGetLinearOAuthSession`,
  `ctoSetLinearOAuthClient`, `ctoClearLinearOAuthClient`,
  `ctoGetLinearProjects`, `ctoGetLinearWorkflowCatalog`.

Headless MCP mode:

- `apps/mcp-server/src/headlessLinearServices.ts` —
  `createHeadlessLinearServices()` builds the full service stack
  (`linearClient`, `linearIssueTracker`, `linearTemplateService`,
  `linearWorkflowFileService`, `flowPolicyService`, `linearRoutingService`,
  `linearIntakeService`, `linearOutboundService`, `linearCloseoutService`,
  `linearDispatcherService`, `linearSyncService`, `linearIngressService`)
  plus a headless `agentChatService` and `workerHeartbeatService` that
  fail fast when agent execution is requested.
- `apps/mcp-server/src/mcpServer.ts` registers the Linear JSON-RPC tools
  at `listLinearWorkflows`, `getLinearRunStatus`, `resolveLinearRunAction`,
  `cancelLinearRun`, `routeLinearIssueToCto`, `routeLinearIssueToMission`,
  `routeLinearIssueToWorker`, `rerouteLinearRun`,
  `getLinearSyncDashboard`, `runLinearSyncNow`, `listLinearSyncQueue`,
  `resolveLinearSyncQueueItem`, `getLinearWorkflowRunDetail`.

Deeper reading:

- `dispatch-and-sync.md` — issue fetch, routing, dispatcher lifecycle,
  closeout, reconciliation, relay/webhook ingress
- `workflow-presets.md` — how presets produce and round-trip to the
  visual plan in the pipeline builder

## Database tables (selected)

All state is kept in `.ade/ade.db` and replicated through cr-sqlite like any
other ADE table. Key tables the Linear stack writes:

- `linear_workflow_runs` — one row per `LinearWorkflowRun`
- `linear_workflow_run_steps` — per-step status for a run
- `linear_workflow_run_events` — step events, milestones, errors
- `linear_issue_snapshots` — last-seen payload hash per issue for
  change detection in `processIssueUpdate`
- `linear_sync_events` — `issue_closed`, `watch_only_match`,
  `workflow_capacity_wait`, `issue_deduped` observability records

Workflow definitions themselves live either inline in the flow policy
(stored in the project config row, versioned via `flowPolicyService`
revisions) or on disk under `.ade/workflows/linear/**` when a YAML file
exists for the workflow id.

## Observability

The sync service appends `LinearSyncEventRecord` entries for every major
lifecycle moment. The dashboard exposes `watchOnlyHits`, `recentEvents`,
queue counters (`queued`, `dispatched`, `retrying`, `escalated`,
`awaitingDelegation`, `failed`), and per-queue-item route metadata
(`routeReason`, `matchedSignals`, `routeTags`, `stalledReason`,
`waitingFor`, `employeeOverride`, `activeTargetType`). Drill-down to a run
exposes step history, sync events alongside ingress events, linked PR
status, and supervisor notes.

## Relationship to CTO

The CTO agent is the supervisory layer. Linear workflows run autonomously
once configured, but:

- `request_human_review` steps default `reviewerIdentityKey: "cto"`.
- Runs in `awaiting_delegation` expose a dropdown in `LinearSyncPanel`
  that sets `employeeOverride`, rerouting a queued run without
  restarting.
- The flow-policy versioning (save/rollback/revision list) governs which
  workflows are active at any given time.
- Linear integration does not require the CTO process to be running. A
  workflow run and its dispatcher progress independently of CTO
  heartbeats; CTO just provides the review surface.

## Gotchas

- **Dormant-until-configured.** Until a token is stored, nothing fires.
  The ingress HTTP server does not bind. Tests should stub
  `hasCredentials` accordingly.
- **Webhook signing secrets are stored via `automationSecretService`**
  under references like `linearRelay.accessToken`. Missing/invalid secrets
  disable the relay path and `LinearIngressStatus.relay.status` becomes
  `error`.
- **Headless MCP worker targets fail fast.** In
  `createHeadlessWorkerHeartbeatService` the wakeup always returns
  `status: "failed"` with the message *"Headless MCP mode does not
  support worker-backed Linear targets yet."* Workflows targeting
  `worker_run` are not a supported headless path; use
  `employee_session`, `mission`, or `pr_resolution` instead.
- **OAuth client config is per-app, not per-project.** Token storage is
  `storageScope: "app"` in `LinearConnectionStatus`. Switching projects
  does not change which Linear workspace is attached unless the token is
  rotated.
- **Issue closure cancels runs.** When an issue reaches a state whose
  type is in `intake.terminalStateTypes` (default: `completed`,
  `canceled`), `linearSyncService` emits an `issue_closed` sync event and
  cancels any active run for that issue. This is how "I fixed it
  manually in Linear" propagates into ADE.
- **Reconciliation interval is clamped.** `reconciliationIntervalSec`
  has a minimum of 15 seconds in `linearSyncService` regardless of
  configured value.
- **Review wait has a 48-hour timeout.** `request_human_review` steps
  time out with a `review_timeout` reason rather than blocking the run
  indefinitely. A stalled supervisor does not stall the dispatcher
  globally.
- **Non-PK uniqueness is stripped by CRR retrofit.** Linear tables do
  not rely on secondary UNIQUE constraints for upserts; dispatcher
  merges use explicit select-then-update instead of
  `ON CONFLICT(some_unique_col)`.
