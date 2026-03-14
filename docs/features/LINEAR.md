# Linear Integration

ADE's Linear integration connects a Linear workspace to the CTO's
autonomous workflow engine. It ingests issues, matches them against
user-defined workflows, dispatches work to ADE agents, and closes out
completed tasks -- updating Linear issue state, comments, and labels
along the way.

## Setup

1. **API key** -- Provide a Linear API key (personal or OAuth) in the
   CTO tab's Linear connection panel. The key is stored locally; a
   health check confirms the viewer identity.
2. **Polling baseline** -- Once connected, ADE reconciles existing
   issues on a configurable interval (`reconciliationIntervalSec`).
   This covers any events missed between app launches.
3. **Real-time ingress (optional)** -- ADE can listen for Linear
   webhooks via a local endpoint or a relay service. When configured,
   webhook ingress delivers issue events in near-real-time instead of
   waiting for the next reconciliation pass. Status is reported per
   endpoint (`localWebhook`, `relay`) in `LinearIngressStatus`.

**Dormant-until-configured**: When no API key is stored, the entire
ingress pipeline is idle. No timers fire, no HTTP listeners bind, and
no background CPU is consumed. The integration activates only after
a successful connection check.

## Workflow System

Workflows are the core abstraction. Each `LinearWorkflowDefinition`
describes when and how ADE should act on an issue:

- **Triggers** -- Match on assignees, labels, projects, teams,
  priority, state transitions, owner, creator, or metadata tags.
- **Target** -- What ADE creates to do the work. Target types include
  `mission`, `employee_session`, `worker_run`, `pr_resolution`, and
  `review_gate`. Each target specifies an executor kind (`cto`,
  `employee`, `worker`), run mode (`autopilot`, `assisted`, `manual`),
  PR strategy, lane selection, and session reuse policy.
- **Steps** -- An ordered sequence of actions the dispatcher walks
  through: comment on Linear, set issue state, launch the target, wait
  for completion, attach artifacts, request human review, and close out.
  Step types are defined in `LinearWorkflowStepType`.
- **Closeout policy** -- Determines what happens when work finishes:
  which Linear state to transition to on success/failure, whether to
  reopen on failure, comment templates, label application, and when
  review-readiness is signaled (`work_complete`, `pr_created`,
  `pr_ready`).

Workflows are versioned and can originate from YAML files in the repo
(`source: "repo"`) or be generated through the UI (`source: "generated"`).

### Matching

When an issue event arrives, the dispatcher evaluates every enabled
workflow in priority order. The first workflow whose triggers match
wins. `LinearWorkflowMatchResult` captures which workflow matched,
why, and a preview of the steps that will execute -- useful for the
dry-run simulator exposed in the UI.

## Dispatcher Service

`linearDispatcherService` owns the run lifecycle:

- Creates a `LinearWorkflowRun` row for each matched issue.
- Walks the run through its step sequence, advancing
  `currentStepIndex` as each step completes.
- Delegates to `linearCloseoutService` for terminal outcomes
  (success or failure state transitions, comments, artifact links).
- Handles retry logic with configurable back-off, concurrency limits
  per-issue and globally, and deduplication.

Run statuses: `queued -> in_progress -> waiting_for_target ->
waiting_for_pr -> awaiting_human_review -> awaiting_delegation ->
completed | failed | cancelled`.

### Dispatcher Hardening (v1 Closeout)

The v1 closeout addressed four dispatcher reliability issues:

1. **Snapshot refresh**: Before executing steps, the dispatcher now
   refreshes the issue snapshot from Linear. If the issue is no longer
   open, the run is cancelled automatically. This prevents work on
   stale or already-resolved issues.

2. **Employee fallback**: When `resolveEmployeeTarget()` finds no
   matching employee, the run enters `awaiting_delegation` status
   instead of crashing. A `run.awaiting_delegation` event is emitted,
   and the workflow waits for manual assignment via the dynamic
   delegation UI in LinearSyncPanel.

3. **PR null-check**: The condition for skipping PR creation now
   correctly checks for explicit `manual` mode in `prStrategy.kind`,
   rather than incorrectly skipping when `prStrategy` is absent.

4. **Closure notifications**: When `finalizeRun` completes, a message
   is sent to the linked agent chat session informing it that the
   workflow completed or failed, with the final run status and any
   relevant artifact links.

5. **Review wait timeout**: `request_human_review` steps now time out
   after 48 hours. When the timeout fires, the step is marked failed
   with a `review_timeout` reason and the run advances rather than
   blocking indefinitely.

6. **Outbound error handling**: All outbound Linear comment operations
   (status updates, artifact links, closure messages) are wrapped in
   try-catch. Failures log a warning instead of crashing the run,
   so a transient Linear API error does not derail an otherwise
   successful workflow.

## Closeout Service

`linearCloseoutService` applies the terminal outcome to Linear:

- Resolves state IDs from symbolic keys (`done`, `in_progress`,
  `blocked`, `in_review`, `todo`).
- Posts a summary comment and attaches proof artifacts (links or
  file attachments depending on `artifactMode`).
- Accepts repo-local artifacts and absolute local files outside the
  project root, so temporary screenshots or verification captures can
  still be linked or uploaded during closeout.
- Transitions the issue to the configured success or failure state.

## LinearSyncPanel UI

The **LinearSyncPanel** in the CTO tab provides a full management
surface:

- **Connection status** -- Shows viewer identity, token health, and
  ingress endpoint status (webhook listening, relay health).
- **Workflow editor** -- Create, edit, and preview workflows with a
  visual step builder. A dry-run simulator lets you test trigger
  matching against a sample issue before going live.
- **Queue dashboard** -- Live counts of queued, dispatched, retrying,
  escalated, awaiting delegation, and failed items. Each queue item
  links to its workflow run detail with step-by-step timeline.
- **Dynamic delegation** -- Runs in `awaiting_delegation` status
  expose a dropdown that lets users pick an employee override,
  reassigning the work without restarting the workflow.
- **Run detail view** -- Drill into a specific run to see steps,
  events, review state, linked PR status, and supervisor notes.
- **Setup checklist** -- Guides first-time users through API key
  entry, workflow creation, and ingress configuration.

## Relationship to CTO

The CTO agent is the human-facing orchestrator that sits above Linear
sync. When a Linear issue is dispatched:

1. The CTO (or a designated employee/worker) receives the work as a
   mission, session, or worker run depending on the workflow target.
2. If the workflow includes a `request_human_review` step with a
   `reviewerIdentityKey`, the CTO can approve, reject, or loop the
   issue back for rework.
3. The CTO's flow-policy controls (save, rollback, revision history)
   govern which workflows are active at any given time.

Linear integration does not require CTO to be running -- workflows
execute autonomously once configured. But the CTO provides the
supervisory layer for review gates, escalations, and policy changes.
