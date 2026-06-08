# Linear Integration

CTO owns Linear intake, routing, dispatch, sync, and closeout. Automations never duplicate issue-routing work — they consume Linear as context or write to it as an action, but the canonical intake path runs through these services.

## Source file map

### Services (apps/desktop/src/main/services/cto/)

- `linearCredentialService.ts` — project-local token store (personal API key) under the active project's `.ade/secrets`. Exposes `getStatus`, `getTokenOrThrow`, `setToken`, `clearToken`.
- `linearOAuthService.ts` — PKCE loopback OAuth on port 19836. `SESSION_TTL_MS = 10 min`. Authorize at `linear.app/oauth/authorize`, exchange at `api.linear.app/oauth/token`.
- `linearClient.ts` — GraphQL client; used by both desktop and headless ADE CLI. Surfaces `getQuickView(connection)` (workspace + active project counters consumed by the top-bar quick view), `searchIssues(query)` (paginated issue search consumed by `LinearIssuePicker` and `LinearIssueBrowser`), and `fetchIssueComments(issueId)` (comment thread for the issue detail pane) alongside the existing `fetchIssueById` / `listProjects` / `listLabels` / `listUsers` calls. The shared GraphQL issue fragment also fetches cycle metadata (`id`, `name`, `startsAt`, `endsAt`), label colors, and richer child-issue data (`identifier`, `title`, full state).
- `linearIssueTracker.ts` + `issueTracker.ts` — issue cache, snapshot hashes, change detection. The `IssueTracker` interface includes the matching `getQuickView(connection)`, `searchIssues(query)`, and `fetchIssueComments(issueId)` shims so renderer-side surfaces have the same entry point as the dispatcher.
- `flowPolicyService.ts` — canonical `LinearWorkflowConfig` aggregate: intake rules, workflows, files, migration info, legacy config. File-backed via `linearWorkflowFileService`.
- `linearWorkflowFileService.ts` — persists workflows as YAML under the project's ADE config area.
- `linearTemplateService.ts` — template metadata registry.
- `linearIntakeService.ts` — `activeStateTypes` / `terminalStateTypes` enforcement; decides which issues flow into the pipeline.
- `linearRoutingService.ts` — evaluates triggers against a normalized issue, picks the highest-priority matching workflow, produces a `LinearWorkflowMatchResult` or an `awaiting_delegation` marker.
- `linearIngressService.ts` — optional realtime ingress. Auto-starts only when realtime config is present. Accepts relay or webhook payloads and forwards into the sync queue.
- `linearSyncService.ts` — polling loop. Short-circuits on idle.
- `linearDispatcherService.ts` — launches target runs, tracks run state across `linear_workflow_runs` + steps + events.
- `linearCloseoutService.ts` — success/failure Linear state transitions, comment posting, proof attachment.
- `linearOutboundService.ts` — raw outbound write helpers (state, comment, assignee updates).

### Renderer

- `renderer/components/cto/LinearConnectionPanel.tsx` — API key form, OAuth start, project picker.
- `renderer/components/cto/LinearSyncPanel.tsx` — workflow list (via `WorkflowListSidebar`), pipeline builder, sync dashboard, run timeline, "Watch It Live" monitor.
- `renderer/components/cto/pipeline/` — the visual builder (see `pipeline-builder.md`).
- `renderer/components/lanes/LinearIssuePicker.tsx`, `LinearIssueBadge.tsx`, `linearBrand.tsx` — shared issue picker, lane-list badge, and brand-token / icon family used by every Linear surface in the app.
- `renderer/components/app/LinearQuickViewButton.tsx`, `LinearIssueBrowser.tsx`, `LinearIssueResolveModals.tsx` — top-bar quick view that opens the full filter/search browser, lets the user create a lane straight from a Linear issue (`lanes.create` with `linearIssue` set), and persists per-project filter state under `ade.linear.quickView.filters.v1:<projectRoot>`. The issue browser supports multi-select with checkboxes (including shift-click range selection and select-all), batch lane creation, batch agent-resolve in new lanes, and batch resolve into an existing lane via dedicated batch modals in `LinearIssueResolveModals.tsx`. The issue detail pane renders the comment thread (via `getLinearIssueComments`) with markdown, and displays cycle and child-issue metadata. The quick-view button caches the last-fetched workspace summary for instant popover open and polls for Linear connection visibility on a 3-second interval until connected.
- `renderer/components/settings/LinearSection.tsx` — Settings > Integrations panel for managing the Linear token / OAuth session and surfacing the connected workspace.

### Lane / commit / PR integration (developer-driven path)

The CTO autonomous pipeline is one consumer of Linear; the other is the human-in-the-loop developer flow. ADE attaches a `LaneLinearIssue` to a lane at create time (via the `LinearIssuePicker` in `CreateLaneDialog` or the `LinearIssueBrowser` opened from the top bar / chat composer) and persists it in `lane_linear_issues`. Once a lane is connected:

- `gitOperationsService.commitChanges` (and the AI commit-message generator) auto-prefix the subject with `Refs IDENT: …` via `shared/linearMagicWords.ts#ensureLinearCommitReference`.
- `prService.draftPrMetadata` / `createFromLane` and the renderer `CreatePrModal` default the PR title to `IDENT: title` (`buildLinearPrTitle`) and inject `Fixes IDENT` (closes the Linear issue when the PR merges) or `Refs IDENT` (links without closing) into the body via `ensureLinearPrReference`. The user toggles `closeLinearIssueOnMerge` from a checkbox in `CreatePrModal`; mobile drives the same flag through `syncRemoteCommandService`.
- `agentChatService` accepts an `AgentChatLinearIssueContextAttachment` (`type: "linear_issue"`) on session creation; `AgentChatPane` automatically attaches the lane's connected issue when chat opens (source `"lane_link"`), and the composer's Linear attach dialog adds manual attachments. Attachment helpers live in `shared/chatContextAttachments.ts`.

Detailed wiring lives in [`../linear-integration/README.md`](../linear-integration/README.md#lane-attachment-commit-references-and-pr-magic-words).

### Shared

- `apps/desktop/src/shared/types/linearSync.ts` — `LinearWorkflowDefinition`, `LinearWorkflowTarget`, `LinearWorkflowTrigger`, `LinearWorkflowStep`, run status, closeout types. `NormalizedLinearIssue` carries cycle metadata (`cycleId`, `cycleName`, `cycleStartsAt`, `cycleEndsAt`), per-label colors (`labelColors`), and structured child issues (`childIssues[]` with `identifier`, `title`, and full state).
- `apps/desktop/src/shared/types/cto.ts` — `CtoGetLinearIssueCommentsArgs` and `CtoLinearIssueComment` types for the issue-comment thread surface.
- `apps/desktop/src/shared/linearWorkflowPresets.ts` — visual plan translation.

### ADE runtime

- `apps/ade-cli/src/headlessLinearServices.ts` — instantiates the full Linear service stack inside the `ade serve` runtime. The runtime is first-class for Linear, not a read-only stub: it can intake issues, dispatch worker runs / runs / employee sessions, and close out tickets with the same code path the desktop renderer drives.

## Connection model

Two connection paths:

1. **Personal API key** (recommended first path). Entered in the Connection panel; validated by a `viewer` query; stored via `linearCredentialService` in the active project's `.ade/secrets`.
2. **OAuth** (the primary "Sign in with Linear" path; uses a bundled public client with PKCE). `startOAuth()` boots an ephemeral HTTP server on 19836 with a PKCE pair, returns the authorize URL for the renderer to open, and finalizes on callback. The *sign-in session* auto-expires after 10 minutes. The resulting **access token, which Linear expires ~24h after sign-in, is refreshed automatically**: `linearCredentialService.ensureFreshToken()` exchanges the stored `refresh_token` (via `linearTokenRefresh.ts`) when the token is at/near expiry — proactively before each GraphQL request and reactively on a 401 — rotating the refresh token on success. A rejected refresh token (`invalid_grant`) clears the connection so the user re-authorizes; transient failures leave the token in place. The headless `ade serve` credential service has the same refresh behavior.

The renderer's `LinearConnectionPanel` auto-surfaces whichever path is available. Most users connect via OAuth; the personal API key (which does not expire) is the alternative for headless/automation use.

## Workflow definition

`LinearWorkflowDefinition` (from `shared/types/linearSync.ts`) is the canonical per-workflow record:

- `id`, `name`, `description`, `enabled`, `priority`, `source` (`"repo"` or `"generated"`).
- `triggers` — trigger groups (assignees, labels, teamKeys, projectSlugs, priority, stateTransitions, owner, creator, metadataTags).
- `routing` — `watchOnly`, `metadataTags`.
- `target` — primary target; optionally chained via `downstreamTarget`.
- `steps` — runtime step sequence (`set_linear_state`, `launch_target`, `wait_for_target_status`, `wait_for_pr`, `request_human_review`, `emit_app_notification`, `complete_issue`, etc.).
- `closeout` — success state, failure state, proof attachment.
- `observability` — emitNotifications toggle, plus ingestion surface knobs.

Trigger matching rule: values inside a group are OR-ed, populated groups are AND-ed, highest `priority` wins. `routing.watchOnly === true` logs a match without dispatching.

## Target types

The dispatcher handles five target types:

| Target type | Launches | Notes |
| --- | --- | --- |
| `employee_session` | Direct CTO or employee chat with issue context | Uses `agentChatService.createSession`. Honors `sessionReuse` (fresh vs continue). |
| `worker_run` | Delegated isolated worker run | Uses `workerAgentService` + `workerTaskSessionService`. Fresh lane by default. |
| `pr_resolution` | PR-focused automation | Can spin up a worker depending on config. Applies PR convergence policy. |
| `review_gate` | Manual gate | No work launched; surfaces review request and waits on human decision. |

The dispatcher supports chained stages via `downstreamTarget` — e.g. a worker run feeding into a PR resolution. `getTargetStages(target)` walks the chain (mirror of `flattenTargetChain` in the pipeline builder).

## Run state

`linear_workflow_runs` stores everything needed to observe a run:

- workflow id/name/version/source, target type, status.
- current step index + id.
- `execution_lane_id`, `linked_session_id`, `linked_worker_run_id`, `linked_pr_id`.
- review state, supervisor identity key, review-ready reason.
- PR state, checks status, review status.
- retry count + next-retry timestamp.
- closeout state + terminal outcome.
- `source_issue_snapshot_json`, `route_context_json`, `execution_context_json`.
- timestamps.

Per-run step rows (`linear_workflow_run_steps`) track step status (`pending`, `running`, `waiting`, `completed`, `failed`, `skipped`). Per-run events (`linear_workflow_run_events`) are the observability timeline emitted via `emitRunEvent`.

## Employee and team routing

Workflows can route to any configured ADE employee, not just the CTO. The Team panel (`TeamPanel.tsx`) maps ADE workers to Linear identities (`AgentLinearIdentity`: linearUserIds, display names, aliases). When an issue's assignee resolves to a mapped employee, the dispatcher targets that employee's chat or worker.

Fallbacks:

- If `employeeIdentityKey` is set on the target, it wins unconditionally.
- If `employeeIdentityKey` is blank, dispatcher resolves via assignee-mapping.
- If no mapping resolves, the run enters `awaiting_delegation` with a UI dropdown in `LinearSyncPanel` to manually reassign before dispatch. No invalid launch is attempted.

The operator can explicitly reroute via `rerouteLinearRun` to change a queued run's target employee.

## Supervisor review

The visual plan's `supervisorMode` controls when a `request_human_review` step is inserted:

- `none` — no supervisor step.
- `after_work` — review after the target completes, before closeout.
- `before_pr` — review after work, before PR creation.
- `after_pr` — review after PR creation, before landing.

The run pauses in `awaiting_human_review` status and exposes approve / reject actions in the timeline. Reject can be configured via `rejectAction`: `loop_back` (rerun with context), `reopen_issue`, or `cancel`.

## Sync loop

`linearSyncService` runs at `reconciliationIntervalSec` (default reasonable cadence). On each cycle it:

1. Guards with `workflowEnabled(policy)` and `hasCredentials()`. If both fail and there are no active runs, the cycle is skipped entirely — disconnected Linear no longer burns CPU.
2. Fetches issues via `linearClient` (respecting intake active/terminal state types).
3. Computes snapshot deltas (`snapshotChanged`) using stored snapshot hashes.
4. For newly active or changed issues, calls `linearRoutingService.evaluate(issue)` to match workflows.
5. Dispatches new runs via `linearDispatcherService.createRun`.
6. Reconciles issue updates against existing runs (state transitions, PR links, closeout readiness).

Short-circuit rules:

- No enabled workflows + no active runs -> skip.
- No credentials + no active runs -> skip.
- No issues + no pending reconciliation -> skip without network call.

## Realtime ingress

`linearIngressService` is the optional realtime path. It only auto-starts when realtime config is present (relay endpoint or webhook secret). Otherwise it stays dormant. Events it receives are normalized to `LinearIngressEventRecord` and forwarded into the sync queue via the same issue-update processing path as the poll loop — there is no separate dispatch code for realtime vs polled events.

Headless mode supports the same ingress: `headlessLinearServices.ts` wires `linearIngressService` into the ADE CLI so external systems can push events into the headless runtime.

## Run observability

Per-run events flow into the LinearSyncPanel:

- **Queue dashboard** — counts by status (`pending`, `active`, `awaiting_delegation`, `awaiting_human_review`, `awaiting_pr`, `failed`, `completed`).
- **Run timeline** — ingress events, step starts/completions, review decisions, dispatcher errors.
- **Run detail** — target info, linked lane/session/PR, supervisor state, closeout.
- **"Watch It Live"** — 4-stage story (launched, target running, review gate, closed).

The LinearSyncPanel debounces follow-up refreshes so active sync stays observable without causing the whole CTO tab to churn on every queue event.

## Closeout

`linearCloseoutService` runs when a workflow reaches terminal success or failure:

- Transitions the Linear issue to the configured success or failure state.
- Posts a summary comment (optional template).
- Attaches proof artifacts:
  - From repo-local paths (resolved against the project root).
  - From absolute paths to external files (temporary screenshots, e.g. Ghost OS captures).
  - From broker-managed computer-use artifacts (see `../computer-use/README.md`).

## ADE runtime parity

`headlessLinearServices.ts` instantiates the same services inside the
`ade serve` runtime:

- `linearClient`, `linearIssueTracker`, `linearTemplateService`, `linearWorkflowFileService`.
- `flowPolicyService`, `linearRoutingService`, `linearIntakeService`, `linearOutboundService`, `linearCloseoutService`.
- `linearDispatcherService`, `linearSyncService`, `linearIngressService`.
- Plus `workerHeartbeatService`, `workerTaskSessionService`, `fileService`, `processService`, `prService`, and `automationSecretService` so the dispatcher's target launches actually run.

Daemon-side employee-session targets create reusable continuity chats
but are manual shells unless a live agent runtime is attached.
Worker-backed daemon targets fail fast with explicit errors when no
worker runtime is available, instead of stalling in a queued state.

## Simulation

Workflows support a simulation mode for testing triggers against real issues without dispatching. The routing service returns a `LinearWorkflowMatchResult` which the UI renders as "would fire" without invoking the dispatcher. This is how the config panel validates trigger logic before saving.

## Gotchas

- **Priority ordering is a deliberate tiebreaker.** Two workflows with the same priority and overlapping triggers produce undefined ordering; always set distinct priorities when overlap matters.
- **Trigger groups are AND-ed.** Populating a group accidentally (e.g. adding a single empty label value) can make the workflow match nothing.
- **`awaiting_delegation` is not a failure.** It is a waiting state; the UI surfaces a dropdown to assign. Don't auto-cancel these from cleanup paths.
- **Per-run events are append-only.** Don't mutate rows in `linear_workflow_run_events` from downstream code; use `appendEvent`.
- **Snapshot hashes drive sync.** If `_snapshotHash` semantics change in `linearIssueTracker`, run cycles may either miss updates or refire forever — validate both directions.
- **OAuth is loopback-only.** Port 19836 must be free; the service does not pick alternatives. Collisions surface as a startup error in the panel.

## Cross-links

- `README.md` — overall CTO shell.
- `pipeline-builder.md` — editing workflows visually.
- `workers.md` — how `worker_run` targets actually execute.
- `../automations/README.md` — why Automations don't duplicate Linear intake.
- `../computer-use/README.md` — proof artifacts attached during closeout.
