# Linear Integration

ADE's Linear integration attaches a Linear workspace to the CTO autonomous
orchestration layer. It ingests issues from Linear, matches each issue against
user-defined workflow definitions, dispatches the matched work as an
employee chat session, worker run, or PR resolution, and closes the
issue back out (state transition, comment, artifact links) when the run
terminates.

This document describes the shape of the integration: who participates, which
services own what, which tables store state, and how the desktop app and the
headless ADE CLI run the same pipeline.

## Runtime ownership

The full Linear stack — credential service, GraphQL client, issue tracker,
template service, workflow file loader, flow policy, routing, intake,
outbound, dispatcher, sync, ingress, and closeout — runs inside the
runtime daemon that owns the project. The desktop renderer is a viewer
over `window.ade.cto.linear*` IPC channels, and the headless ADE CLI
hosts the same services through `apps/ade-cli/src/headlessLinearServices.ts`
so Linear-driven workflows can run in `ade serve` without the desktop
app open.

Both the desktop main process (for local projects) and the standalone
`ade serve` daemon load the same service modules out of
`apps/desktop/src/main/services/cto/`; the path reflects the source
tree, not where execution happens.

The webhook HTTP listener (`linearIngressService`), the relay poller,
and the reconciliation timer (`linearSyncService`) all bind on the
runtime host. A remote runtime behind a NAT therefore needs the relay
path even if the desktop machine has a public webhook URL.

## Who uses it

The integration is used by four distinct consumers:

1. **The CTO agent.** Linear workflows are authored, saved, and rolled back
   through the CTO tab's flow-policy surface, and the CTO agent is the
   default supervisor for review gates (`reviewerIdentityKey: "cto"`). Linear
   runs show up in the CTO's history and feed the `awaiting_human_review`
   and `awaiting_delegation` queues that operators resolve from the CTO tab.
2. **Lanes, commits, PRs, and chat.** A user can attach a Linear issue
   to a brand-new lane from `CreateLaneDialog` (the Linear issue picker
   in the always-open Advanced section), or to chat context from the
   composer's Linear attach affordance. Once a lane is connected to an
   issue, ADE auto-derives the branch name, prefixes commit messages
   with `Refs IDENT: …`, seeds the PR title (`IDENT: title`), and adds
   a `Fixes IDENT` / `Refs IDENT` magic word to the PR body so Linear
   links the PR back to the issue. There is also a top-bar
   `LinearQuickViewButton` that opens the same `LinearIssueBrowser`
   the chat composer uses, lets the operator filter / search across
   their Linear backlog, and turns any selected issue into a new
   lane in one click.
3. **The headless ADE CLI.** `apps/ade-cli/src/headlessLinearServices.ts`
   instantiates the full Linear service stack (sync, dispatcher, closeout,
   intake, ingress, routing, outbound, templates) so external callers can
   trigger and resolve Linear runs without the desktop UI running. The
   ADE CLI exposes these over JSON-RPC tools such as `listLinearWorkflows`,
   `resolveLinearRunAction`, `routeLinearIssueToCto`,
   `routeLinearIssueToWorker`, and `resolveLinearSyncQueueItem`.

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
| agentChatService /    |----------+         |
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
3. **Target** — what to create. `type` is one of
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

- `linearCredentialService.ts` — token + OAuth client + auth mode storage and health check. Reads/writes through the per-machine `SyncCredentialStore` (`~/.ade/secrets/`) when one is passed in, with a one-time migration from the legacy project-local `linear-token.v1.bin` / `linear-oauth-client.v1.bin` files; falls back to the legacy project-scoped path when the machine store is unavailable. Environment overrides (`ADE_LINEAR_API`, `LINEAR_API_KEY`, `ADE_LINEAR_TOKEN`, `LINEAR_TOKEN`) still take precedence.
- `linearOAuthService.ts` — OAuth authorization flow
- `linearClient.ts` — GraphQL client wrapper
- `linearIssueTracker.ts` — normalization into `NormalizedLinearIssue`
- `linearTemplateService.ts` — session template resolution
- `linearWorkflowFileService.ts` — YAML workflow files under
  `.ade/workflows/linear/**`. Every `save(config)` call invokes
  `ensureSharedAdeProjectScaffold(projectRoot)` first so a project that
  was previously local-only gets promoted to the shared `.ade/`
  scaffold (including the canonical `.ade/.gitignore` and
  `cto/identity.yaml`) the moment a Linear workflow is persisted.
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

Shared types and helpers:

- `apps/desktop/src/shared/types/linearSync.ts` — all `LinearWorkflow*`
  types, run statuses, event payloads, catalog types, the
  `NormalizedLinearIssue` shape (extended with `projectName`,
  `teamName`, `dueDate`, `estimate`, `archivedAt`, `completedAt`,
  `canceledAt`, `startedAt`), `LinearConnectionStatus` (extended with
  `organizationId` / `organizationName` / `organizationUrlKey` /
  `organizationLogoUrl` so controllers can render the workspace
  brand), and the legacy `LinearSyncConfig` kept for migration reads.
- `apps/desktop/src/shared/types/lanes.ts` — `LaneLinearIssue` (the
  lane-attached subset of a Linear issue that gets persisted with
  the lane row) plus the optional `linearIssue` field on
  `CreateLaneArgs` / `CreateChildLaneArgs` / `LaneSummary`. Also
  exports `LaneLinearIssueLink`, `LaneLinearIssueLinkRole`
  (`primary | worked | referenced | inferred`), and
  `LaneLinearIssueLinkSource` (`lane_create | lane_link |
  chat_attach | linear_open_issue | commit | pr_body | manual`),
  used for multi-issue lane linkage.
- `apps/desktop/src/shared/linearIssueBranch.ts` — pure helpers
  `linearIssueLaneName(issue)` ("IDENT title") and
  `linearIssueBranchName(issue)` (slugified, sanitised against git
  ref rules: `IDENT-title-slug`). `sanitizeLinearIssueBranchName`
  is the underlying ref-safety pass and is also exported.
- `apps/desktop/src/shared/linearMagicWords.ts` — pure helpers for
  the PR / commit Linear references: `linearPrMagicWord(closeOnMerge)`
  picks `Fixes` (closes the issue when the PR merges) or `Refs`
  (links without closing); `buildLinearPrTitle` /
  `buildLinearPrReference` build the strings; `ensureLinearPrReference`
  injects the magic word into a PR body if one isn't already there
  (with `preserveExisting: false` to overwrite an existing
  `Refs/Fixes <IDENT>` line); `ensureLinearCommitReference` prefixes
  a commit subject with `Refs IDENT: …` when missing. Multi-issue
  helpers (`LinearPrIssueReference`, `dedupeLinearPrIssueReferences`,
  `ensureLinearPrReferences`, `renderLinearPrIssueLinkSection`,
  `ensureLinearPrIssueLinkSection`) back the "Linked Linear issues"
  HTML-fenced markdown block that `prService.applyLinearPrLinkage`
  writes into PR bodies when a lane is linked to multiple issues.
- `apps/desktop/src/shared/chatContextAttachments.ts` — pure helpers
  for the chat composer's Linear context attachment surface:
  `makeLinearIssueContextAttachment(issue, source)`,
  `mergeChatContextAttachments`, `removeChatContextAttachment`,
  `chatContextAttachmentKey`, plus a defensive
  `normalizeLinearIssue` reader used when re-hydrating attachments
  from disk or wire payloads.
- `apps/desktop/src/shared/linearWorkflowPresets.ts` — default workflow
  presets, visual plan derivation, step rebuilding. See
  `workflow-presets.md`.

Renderer wiring:

- `apps/desktop/src/renderer/components/cto/LinearSyncPanel.tsx` — the main
  CTO-tab management surface (connection, workflow editor, queue,
  dashboard, ingress status).
- `apps/desktop/src/renderer/components/cto/pipeline/*` — the visual
  pipeline canvas with trigger, stage, closeout cards.
- `apps/desktop/src/renderer/components/lanes/LinearIssuePicker.tsx` —
  shared issue picker mounted inside `CreateLaneDialog`. Loads
  filters via `ade.cto.getLinearIssuePickerData` (projects + states
  + assignees in one call) and pages issues with
  `ade.cto.searchLinearIssues`. Exports a row component
  (`LinearIssueRow`) and pure label helpers reused by the chat
  composer's Linear attach dialog and the top-bar quick-view.
- `apps/desktop/src/renderer/components/lanes/LinearIssueBadge.tsx` —
  compact lane-list badge showing the connected issue's
  identifier / state / priority. Clicking opens chat with the issue
  pre-attached as context, falling back to the public Linear URL
  when chat is unavailable.
- `apps/desktop/src/renderer/components/lanes/linearBrand.tsx` —
  shared Linear brand tokens (`LINEAR_BRAND` palette) and icon
  family (`LinearMark`, `LinearStateIcon`, `LinearPriorityIcon`).
- `apps/desktop/src/renderer/components/app/LinearQuickViewButton.tsx`
  — top-bar button (rendered in `TopBar.tsx` when
  `LinearConnectionStatus.connected === true`). Opens a popover
  hosting the shared `LinearIssueBrowser`; selecting an issue
  creates a new lane via `lanes.create` with `linearIssue` set,
  refreshes the lane store, and selects the new lane.
- `apps/desktop/src/renderer/components/app/LinearIssueBrowser.tsx`
  — full filter/search surface. Reads `ade.cto.getLinearQuickView`
  for the workspace summary and `ade.cto.searchLinearIssues` for
  paginated results. Persists per-project filter state in
  `localStorage` under `ade.linear.quickView.filters.v1:<projectRoot>`.
- `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx`
  — the composer's Linear attach affordance opens a
  `LinearIssueContextDialog` that hosts the same
  `LinearIssueBrowser` and emits an
  `AgentChatLinearIssueContextAttachment` (`type: "linear_issue"`)
  through the chat session's `contextAttachments` array.
  `AgentChatPane` automatically attaches the lane's connected
  issue when a chat opens on a Linear-connected lane (via
  `initialLinearIssueContext`, source `"lane_link"`), and the
  composer pins it to the dialog so the user can see what's
  already linked.
- `apps/desktop/src/renderer/components/prs/CreatePrModal.tsx` —
  reads `lane.linearIssue`, defaults the PR title to
  `buildLinearPrTitle`, and uses `ensureLinearPrReference` against
  the body whenever the user toggles the
  `closeLinearIssueOnMerge` checkbox so the magic word stays in
  sync with `Fixes` / `Refs`.
- `apps/desktop/src/renderer/components/settings/LinearSection.tsx`
  — Settings > Integrations panel for connecting Linear. Reads /
  writes via `ade.cto.getLinearConnectionStatus`,
  `ade.cto.setLinearToken`, `ade.cto.startLinearOAuth`, and
  `ade.cto.clearLinearToken`. Surfaces connection state, project
  list, and a docs-style hint card describing the issue-routing /
  CTO-workflow value props.

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
  `ctoGetLinearProjects`, `ctoGetLinearWorkflowCatalog`,
  `ctoGetLinearQuickView` (workspace summary used by the top-bar
  quick view), `ctoGetLinearIssuePickerData` (one-shot
  projects + states + assignees catalog for `LinearIssuePicker`),
  and `ctoSearchLinearIssues` (paginated issue search consumed by
  both `LinearIssuePicker` and `LinearIssueBrowser`).
- `IssueTracker` (`apps/desktop/src/main/services/cto/issueTracker.ts`)
  grew matching `getQuickView(connection)` and
  `searchIssues(query)` methods, both forwarded to `linearClient`
  by `linearIssueTracker.ts`. `IssueTrackerIssueSearchQuery` covers
  project / state-types / assignee / priority / free-text / cursor
  pagination filters; the result is `{ issues, pageInfo }`.

Headless ADE CLI mode:

- `apps/ade-cli/src/headlessLinearServices.ts` —
  `createHeadlessLinearServices()` builds the full service stack
  (`linearClient`, `linearIssueTracker`, `linearTemplateService`,
  `linearWorkflowFileService`, `flowPolicyService`, `linearRoutingService`,
  `linearIntakeService`, `linearOutboundService`, `linearCloseoutService`,
  `linearDispatcherService`, `linearSyncService`, `linearIngressService`)
  plus a headless `agentChatService` and `workerHeartbeatService` that
  fail fast when agent execution is requested.
- `apps/ade-cli/src/adeRpcServer.ts` registers the Linear JSON-RPC tools
  at `listLinearWorkflows`, `getLinearRunStatus`, `resolveLinearRunAction`,
  `cancelLinearRun`, `routeLinearIssueToCto`,
  `routeLinearIssueToWorker`, `rerouteLinearRun`,
  `getLinearSyncDashboard`, `runLinearSyncNow`, `listLinearSyncQueue`,
  `resolveLinearSyncQueueItem`, `getLinearWorkflowRunDetail`.

Deeper reading:

- `dispatch-and-sync.md` — issue fetch, routing, dispatcher lifecycle,
  closeout, reconciliation, relay/webhook ingress
- `workflow-presets.md` — how presets produce and round-trip to the
  visual plan in the pipeline builder

## Lane attachment, commit references, and PR magic words

The Linear pipeline above is fully autonomous: it runs chats /
workers without the human ever opening a lane manually. Most
day-to-day developer work, though, starts the other way around — the
human picks a Linear ticket and creates a lane to work on it. ADE
exposes that path in three places that all share the same primitives:

- **Create a lane from a Linear issue.** `CreateLaneDialog`'s Advanced
  section hosts a "Connect Linear issue" affordance backed by
  `LinearIssuePicker`. Selecting an issue auto-derives the lane name
  (`linearIssueLaneName` → `IDENT title`) and the branch name
  (`linearIssueBranchName` → `ident-title-slug`, sanitised against
  git ref rules), pre-fills the create form, and locks the
  "Import existing branch" tab while an issue is connected. The
  same picker is launched from the top-bar `LinearQuickViewButton`
  and from the chat composer's Linear attach dialog so all three
  entry points produce identical lane shapes.
- **`lane_linear_issues` table.** `laneService.create` /
  `createChild` accept `linearIssue?: LaneLinearIssue`; when set,
  the issue payload (`id`, `identifier`, `title`, project / team /
  state / priority / labels / assignee / creator / due / estimate /
  branch name / timestamps) is upserted into `lane_linear_issues`
  keyed by `(project_id, lane_id)`. `LaneSummary.linearIssue` is
  hydrated on every `list` / `get`. The service also enforces a
  collision check: if the resolved branch already exists locally
  or as `origin/<branch>`, lane creation throws
  `Branch "…" already exists. Detach the Linear issue or choose
  a different issue.`.
- **Commit message prefix.** When a lane has a connected issue,
  `gitOperationsService.commitChanges` (and the commit-message
  generator) auto-prefixes the subject with `Refs IDENT: …` via
  `ensureLinearCommitReference`. Subjects that already mention the
  identifier are left alone.
- **PR title + body magic word.** `prService.draftPrMetadata` /
  `createFromLane` and the renderer `CreatePrModal` use
  `buildLinearPrTitle(issue)` (`IDENT: title`) as the default PR
  title and `ensureLinearPrReference(body, issue, closeOnMerge)`
  to inject `Fixes IDENT` (closes the Linear issue when the PR
  merges) or `Refs IDENT` (links without closing) into the PR
  description. The user toggles `closeLinearIssueOnMerge` from a
  checkbox in `CreatePrModal`; the same flag is forwarded by
  `syncRemoteCommandService` so phones drive the same behaviour.
- **Multi-issue PR linkage.** Lanes can accumulate additional Linear
  issues beyond the primary one (see `linearIssueLinks` on
  `LaneSummary`). `prService.applyLinearPrLinkage` collects the
  primary issue plus every `linearIssueLinks` entry with
  `includeInPr === true`, deduplicates by issue id, and writes both
  per-issue magic words (`Fixes` / `Refs IDENT`) and a single
  HTML-commented "Linked Linear issues" markdown block into the PR
  body:

    ```markdown
    <!-- ade:linear-links v=1 -->
    ### Linked Linear issues

    - [ADE-123: Make X faster](https://linear.app/...) - closes on merge
    - [ADE-456: Track usage](https://linear.app/...) - referenced
    <!-- /ade:linear-links -->
    ```

    The block is idempotent: subsequent saves match the
    `<!-- ade:linear-links v=N -->` open / close comments and replace
    the contents in place rather than appending. Pure helpers
    (`renderLinearPrIssueLinkSection`, `ensureLinearPrIssueLinkSection`,
    `ensureLinearPrReferences`, `dedupeLinearPrIssueReferences`) live in
    `apps/desktop/src/shared/linearMagicWords.ts`.
- **Chat context attachment.** Chats opened on a lane with a
  connected issue automatically receive an
  `AgentChatLinearIssueContextAttachment` (`type: "linear_issue"`,
  `source: "lane_link"`) via `AgentChatPane`'s
  `initialLinearIssueContext`. The composer also supports manual
  attachment through `LinearIssueContextDialog`, which reuses
  `LinearIssueBrowser`. Helpers live in
  `shared/chatContextAttachments.ts`. When a chat attaches one or
  more Linear issues at run time, `agentChatService` calls
  `laneService.linkLinearIssues({ issues, role: "worked", source:
  "chat_attach", includeInPr: true, evidence: { chatSessionId } })`
  so the attached issues survive across PR creation and show up in
  the rendered "Linked Linear issues" block.
- **Top-bar quick view.** `TopBar` mounts
  `LinearQuickViewButton` whenever `LinearConnectionStatus.connected`
  is true. The popover shows `CtoLinearQuickView` (workspace +
  active project counters) plus the shared
  `LinearIssueBrowser`; clicking an issue creates a fresh lane via
  `lanes.create`, refreshes the lane store, and selects the new
  lane.

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
- `lane_linear_issues` — issue payload attached to a lane at
  create time, keyed by `(project_id, lane_id)`. Used by lane
  hydration, `LinearIssueBadge`, commit-message prefixing, and PR
  defaults.
- `lane_linear_issue_links` — additional Linear issues attached to a
  lane after creation (chat composer attachments, future commit /
  PR-body scanners, manual link UI). Keyed by `(project_id, lane_id,
  issue_id)` with `role`, `source`, `include_in_pr`,
  `close_on_merge`, and a JSON `evidence` blob. Hydrated into
  `LaneSummary.linearIssueLinks` and combined with the primary
  `linearIssue` by `prService.applyLinearPrLinkage` to render the
  PR's "Linked Linear issues" block.
- `linear_issue_claims` — active-claim ledger (one active row per
  `(project_id, issue_id)`) so two lanes don't try to drive the
  same issue simultaneously.

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
- **Headless ADE CLI worker targets fail fast.** In
  `createHeadlessWorkerHeartbeatService` the wakeup always returns
  `status: "failed"` with the message *"Headless ADE CLI mode does not
  support worker-backed Linear targets yet."* Workflows targeting
  `worker_run` are not a supported headless path; use
  `employee_session` or `pr_resolution` instead.
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
