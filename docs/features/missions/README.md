# Missions

A mission is ADE's structured, multi-step execution primitive. It wraps a user goal in a durable run/step/attempt/intervention/artifact state machine while a coordinator agent plans, delegates, monitors, and finalizes. Missions are the heavy-orchestration path — the lighter paths are a CTO chat turn or an automation rule.

The runtime is feature-rich but the mission launcher and page shell now follow a staged-load model so the surface stays responsive even while orchestrator metadata warms up.

## Runtime ownership

Missions live in whichever runtime daemon owns the project. The coordinator agent loop, planner workers, implementation/testing/validation workers, intervention queue, recovery loop, and result-lane finalization all execute inside `ade serve`. For local projects that is the local daemon; for remote projects it is the remote runtime over SSH-tunneled JSON-RPC. The desktop renderer's mission UI (`MissionsPage`, `MissionDetailView`, chat channels, plan editor) is purely a view: it reads runs/steps/attempts/events through the active runtime binding, sends control RPCs (start, cancel, steer, intervene, approve), and renders coordinator/worker chat threads.

Caveats that follow from "runtime owns missions":

- Worker provider availability follows the runtime host. A remote Linux runtime cannot launch a worker that requires the macOS-only iOS Simulator; that worker has to run on a Mac runtime.
- Mission artifacts (including computer-use proof) write to the runtime host's project artifacts directory. Remote runs store proof on the remote machine.

## Source file map

### Core services (apps/desktop/src/main/services/)

- `missions/missionService.ts` — the mission persistence layer. Missions, steps, interventions, artifacts, events. `createMission`, `addMissionStep`, `addIntervention`, `addArtifact`, `getMissionDetail`, `getMissionEvents`. Handles terminal-status guards (`TERMINAL_MISSION_STATUSES`), treats only `planning` / `in_progress` as dashboard-active, clears stale lane ownership when a referenced mission no longer exists, and releases mission-owned lanes during deletion.
- `missions/phaseEngine.ts` — phase cards, profiles, built-in phases (`planning`, `development`, `integration`, `testing`, `validation`, `closeout`, legacy `prAndConflicts`), `applyPhaseCardsToPlanSteps`, `validatePhaseSequence`, `groupMissionStepsByPhase`. `isDevelopmentLikePhaseKey` / `resolveDevelopmentPhaseKey` keep renamed implementation phases executable, while ordering constraints (`mustFollow`, `mustPrecede`, `mustBeFirst`, `mustBeLast`) keep Integration after Development and Closeout last.
- `missions/missionPreflightService.ts` — preflight checks: lane claim ownership, knowledge sync, human work digest, computer-use readiness, phase structure, budget estimates.
- `orchestrator/orchestratorService.ts` — runtime state machine: runs, steps, attempts, claims, artifacts, gate reports, timeline events. ~8000 LOC. Owns the tick loop and `completeAttempt`.
- `orchestrator/aiOrchestratorService.ts` — façade that ties missionService + orchestratorService + AI integration together. Owns `pauseMissionWithIntervention`, `steerMission`, recovery, `check_finalization_status`.
- `orchestrator/coordinatorAgent.ts` — the coordinator brain. Long-running AI agent that plans, spawns workers, monitors, advances phases, and finalizes. Lifecycle states: `booting`, `analyzing_prompt`, `fetching_project_context`, `launching_planner`, `waiting_on_planner`, `planner_launch_failed`, `stopped`.
- `orchestrator/coordinatorTools.ts` — tools the coordinator can call (plan DAG, spawn workers, check status, ask the user, finalize).
- `orchestrator/planningQuestionPolicy.ts` — shared policy that decides when Planning must ask and resolve a blocking question before the phase can exit. Used by the coordinator agent, coordinator tools, and run completion guards.
- `orchestrator/coordinatorSession.ts` — per-coordinator session state.
- `orchestrator/missionLifecycle.ts` — mission run start, approve, cancel, cleanup, steer, sync, lane provisioning, team manifest synthesis.
- `orchestrator/missionStateDoc.ts` — `.ade/missions/<missionId>/state.md` and coordinator checkpoint files.
- `orchestrator/missionBudgetService.ts` — budget telemetry: estimates, rollups by phase/worker/provider, hard caps, pressure levels.
- `orchestrator/executionPolicy.ts` — default `MissionExecutionPolicy`, merge rules (mission > project > fallback), completion evaluation, run/step validation.
- `orchestrator/adaptiveRuntime.ts` — `classifyTaskComplexity` (trivial/simple/moderate/complex), parallelism scaling, model downgrade.
- `orchestrator/workerDeliveryService.ts` — message delivery pipeline between coordinator and worker chats; retry, idempotency, in-flight leases.
- `orchestrator/workerTracking.ts` — post-attempt artifact extraction and the planning-question intervention path. `planner_natural_question` opens a `manual_input` intervention, and `planningQuestionPolicy.ts` still gates required planning clarification with `planner_required_question_missing` when configured.
- `orchestrator/delegationContracts.ts` — contracts between coordinator and workers (scope, allowed tools, handoff shape).
- `orchestrator/runtimeEventRouter.ts` — routes events from worker sessions and CLI output into the coordinator.
- `orchestrator/metaReasoner.ts` — higher-level reasoning for coordinator choices.
- `orchestrator/metricsAndUsage.ts` — token / cost accounting per run.
- `orchestrator/recoveryService.ts` — tracked session state, recovery iterations.
- `orchestrator/stepPolicyResolver.ts` — step-level policy merging, autopilot config, file-claim scope.
- `orchestrator/baseOrchestratorAdapter.ts` — `buildFullPrompt` + shell escaping.
- `orchestrator/providerOrchestratorAdapter.ts` — provider-specific worker launches (Claude CLI, Codex CLI, ADE CLI).
- `orchestrator/promptInspector.ts` — coordinator / planning / worker prompt inspectors for the mission detail UI.
- `orchestrator/missionStateDoc.ts` — state doc and coordinator checkpoint read/write.
- `orchestrator/teamRuntimeConfig.ts` / `teamRuntimeState.ts` — team manifest and runtime state.
- `orchestrator/permissionMapping.ts` — mission permission config to provider-specific tool permissions.
- `orchestrator/orchestratorQueries.ts` — row types, helpers for mapping DB rows to typed objects, normalization.
- `apps/ade-cli/src/cli.ts` — typed `ade missions` command group (`list`, `create`, `launch`, `start`, `resume`, `show`, `runs`, `graph`, `watch`) plus phase/planned-step JSON payload options for headless or socket-backed mission operations. Routes through the active runtime daemon; with `--socket` it talks to the desktop's local daemon, otherwise it spins up a headless project scope.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — exposes mission lifecycle and run-graph reads as project-scoped JSON-RPC actions consumed by both the desktop preload bridge (for remote bindings) and the CLI.

### Renderer

All under `apps/desktop/src/renderer/components/missions/`:

- `MissionsPage.tsx`, `MissionsHomeDashboard.tsx`, `MissionSidebar.tsx` — list shell, dashboard cards (active / completed split), sidebar entry, and `missionId` query-param synchronization for deep links. Active mission entries surface phase progress, an "N active" / "0 active" / "no active workers" worker count, and elapsed time. Recent dashboard rows always use a concrete View action because selecting a row does not rerun or retry the mission.
- `CreateMissionDialog.tsx` + `MissionCreateDialogHost.tsx` — staged-load create dialog. `phasesMatchProfile`, `applyModelToMissionPhases`, `withLowReasoning`, and `applyCodexLowFullAutoPresetToDraft` keep the phase override draft in sync with model/profile changes; `validatePhaseOrder` accepts development-like phase keys (`development_*`, `*_development`, `implementation`, `build`, `code`) so user-renamed phases still pass ordering checks. Defaults from mission settings include the default orchestrator model, permission config, and Smart Budget config.
- `MissionDetailView.tsx`, `MissionTabContainer.tsx`, `MissionHeader.tsx`, `MissionRunPanel.tsx`, `MissionControlOfficePanel.tsx`, `MissionActivePhasePanel.tsx`, `MissionLogsTab.tsx`, `MissionArtifactsTab.tsx`, `PromptInspectorCard.tsx` — mission detail tabs and chrome.
- `MissionChatV2.tsx`, `ChatChannelList.tsx`, `ChatMessageArea.tsx`, `ChatInput.tsx`, `MissionThreadMessageList.tsx`, `chatFilters.ts`, `missionChatChannelModel.ts` — conversations tab. Channel rows expose accessible names through `formatChannelAccessibleName` (e.g. `"Orchestrator, orchestrator channel"`); legacy badge/badge-color props were removed in favor of the accessible label.
- `PlanTab.tsx`, `PhaseCardEditor.tsx`, `missionPhaseDefaults.ts` — plan review and phase-card editing surface (validation gate evidence checklist, phase key editing for custom phases). Display-only task records are filtered out of executable step lists so task-planning rows do not inflate phase progress.
- `missionControlViewModel.ts`, `missionFeedPresentation.ts`, `missionThreadEventAdapter.ts`, `missionInterventionRouting.ts`, `missionWorkerPresentation.ts`, `missionHelpers.ts`, `chatFilters.ts` — pure derivations consumed by the UI.
- `useMissionRunView.ts`, `useMissionPolling.ts`, `useMissionsStore.ts`, `missionDialogDataCache.ts`, `missionCreateDialogStore.ts`, `MissionActiveContext.tsx` — store + hooks. `MissionTabContent` receives `runView` as a prop (computed once at the page level via `useMissionRunView`) instead of subscribing locally, so the panels share one polling source. The store is built with `createStore<MissionsStore>()(createMissionsState)` and `MissionsPage` instantiates its own copy via `createMissionsStore()` inside a `MissionsStoreProvider`, so multiple project tabs each get their own missions selection / chat-jump / prompt-inspector state. Components reach the scoped store via `useMissionsStoreApi()` for imperative `getState()` access; `useMissionsStore(selector)` reads from whichever store the surrounding provider holds (falling back to a module-level root store for any callers outside a provider). `MissionActiveContext` carries the page-level `active?: boolean` down so `MissionsWorkspace`, `MissionsProductionGate`, `MissionHeader`, `MissionChatV2`, `CompactUsageMeter`, `InterventionPanel`, and `OrchestratorActivityFeed` can short-circuit every polling / event-subscription effect when the missions surface is not the foreground project tab.
- `apps/desktop/src/renderer/components/chat/missionControlTextTools.ts` — coordinator-side rewrite that turns ADE mission-control text-tool envelopes into rendered tool events for `MissionThreadMessageList`. `isMissionControlToolName(name)` is the canonical predicate; the `mission-thread` presentation mode auto-rewrites events on mount via `rewriteMissionControlTextToolEvents`.
- `apps/desktop/src/renderer/perf/scenarios/missions.ts` — mission-tab performance scenario used by renderer perf probes. It seeds a large mission fixture, drives the missions route, and records tab-specific interaction timing.

### Validation contract

- `docs/validation-contract-m1-m2.md` — the behavioral test spec. Canonical list of required invariants with VAL-XXX identifiers.

## Runtime contract

### Planning is mandatory

Planning is the first-class initial phase. If a phase profile omits a planning phase, mission launch normalizes the selected phase deck with an injected Planning phase before execution begins. The coordinator:

1. Gathers project context (`fetching_project_context`).
2. Optionally asks clarifying questions.
3. Delegates to a planning worker (`launching_planner` -> `waiting_on_planner`).
4. Explicitly advances phases as plan steps complete.

A planning-startup guard prevents non-ADE tool drift during the prep phase. If the coordinator detects tool calls that don't belong to the planning setup (e.g. arbitrary ADE CLI calls during context fetch), they are trapped and routed into explicit recovery rather than silent fallback.

Phase cards can mark `askQuestions.requiredBeforeExit`. When enabled, Planning cannot transition to the next executable phase until a planner-owned manual-input question has been resolved or explicitly skipped. ADE also promotes that requirement when the mission prompt or planning instructions clearly demand required planning questions before implementation. Phase-approval interventions are separate from planning questions, so approval gates do not accidentally satisfy or block the clarification requirement.

### Planner launch reliability

Planner launches track attempts and classify failures via `classifyPlannerLaunchFailure`:

- Transient (network, timeout, resource contention) -> automatic retry with structured intervention logging.
- Permanent (config errors, missing capabilities) -> explicit intervention for the operator.
- All failure categories appear in the run timeline for observability.

### Root propagation

Worker tools resolve DB state from the canonical repo root while file access stays scoped to the lane worktree. This applies to both desktop-launched and headless-launched workers — the mission state query reads from the right database regardless of `cwd`, and file writes are restricted to the worktree. Validation target: `VAL-ISO-001` / `VAL-ISO-002`.

### Closeout contract: result-lane

All missions end in a **result lane** — one consolidated lane that contains the mission's changes. The coordinator assembles worker outputs into this lane and stops before PR creation. The user decides when to open a PR.

The previous multi-strategy model (integration / per-lane / queue / manual) is gone. `finalizationPolicyKind: "result_lane"` is set on every new mission; the `CreateMissionDialog` no longer exposes PR-strategy selection. The coordinator exposes a `check_finalization_status` tool that reads the mission state doc and reports contract satisfaction, execution completeness, and result-lane readiness.

### Terminal-status regression guard

When a mission reaches terminal status (`completed`, `failed`, `cancelled`), `transitionMissionStatus` refuses transitions back to non-terminal states. Attempts are logged and silently skipped. This prevents stale coordinator events from reopening completed missions.

### Step execution resilience

- **PR merge fallback** — 3-tier retry: attempt merge, retry on transient, fall back to draft PR, then request user intervention. Failed merges return `blocked`, not `failed`, so the run stays recoverable.
- **Stagnation detection** — Agents producing no output are tracked as potentially stagnant; elapsed silence is surfaced so the coordinator can intervene.
- **Review wait timeout** — Human review steps time out after 48 hours with reason `review_timeout`.
- **Turn-level timeout** — Individual agent turns are capped at 5 minutes via the abort infrastructure.
- **Autopilot timeout** — Autopilot polls every 15 seconds (single configurable constant, up from 5s).

### Planning question handling

A planner can pause the run by emitting an `awaiting_user_input` step
with `source === "planner_natural_question"` and a non-empty
`question`. `workerTracking.extractAndRegisterArtifacts` translates
that into a single `manual_input` intervention (`reasonCode:
"planner_natural_question"`) and a matching `pauseRun` so the
coordinator stops until the user answers.

Required planning clarification is still enforced separately by
`planningQuestionPolicy.ts`: if a planning phase exits without a
required answer, ADE records `planner_required_question_missing` and
keeps the run paused. Both `planner_natural_question` and
`planner_required_question_missing` are valid intervention reason codes.

### Mission step bidirectional sync

`syncRunStepsFromMission()` pulls user-initiated mutations (cancel, skip) from the mission state back into orchestrator run state. The orchestrator picks the change up on its next tick.

`syncMissionStepsFromRun()` is the other direction. It pairs orchestrator
run steps to mission steps via `runStep.missionStepId`, falling back to
`metadata.orchestratorStepId` / `metadata.stepKey` / matching titles so
steps recorded before the explicit join column was populated still
synchronize.

After step/phase sync, `syncMissionFromRun()` must re-read mission
detail before deriving a non-terminal mission status. Sync can add or
resolve interventions, so deriving status from a stale mission snapshot
can overwrite `intervention_required` back to `in_progress`. Only an
explicit `nextMissionStatus` bypasses that re-derive.

`ensureTerminalFailedRunIntervention()` then guarantees a terminal
`failed` run cannot leave the mission in a clean `failed` status without
a matching `failed_step` intervention: if no open `failed_step` row
exists, it adds one (with reason code `terminal_run_failed_step`),
moves the mission to `intervention_required` even though the run itself
is terminal, and `deriveMissionStatusFromRun` checks blocking
interventions before honouring `run.status === "failed"`.

### Cascade cleanup

On terminal state, the runtime calls `cleanupTeamResources()` (best-effort). Worker sessions, temporary worktrees, and team-scoped resources are torn down so they don't leak across runs.

### Mission detail warnings

Loading a mission returns `MissionDetailWarning[]` for records with invalid JSON in metadata. Each warning has `code` (`invalid_json` | `truncated_events`), `source`, `field`, `message`. The UI surfaces warnings instead of silently dropping records.

### Mission event pagination

`getMissionEvents({ missionId, limit?, before? })` returns `MissionEventsPage` with `events`, `nextCursor`, `hasMore`, and any deserialization `warnings`. Default page size 200; cursor encodes `createdAt::id`. Mission detail loads recent events eagerly and older events on demand.

### Queue deduplication

Queued missions use a claim-token mechanism to prevent duplicate starts from stale orchestrator events. `claimQueuedMissionStart()` acquires an exclusive token under `BEGIN IMMEDIATE`. Stale after 2 minutes. `queue_claim_token` + `queue_claimed_at` columns on the missions table support this. Missions with `autostart: false` in launch metadata are excluded from automatic queue processing.

## Mission detail surface

Five flat tabs (`MissionTabNavigation` / `MissionTabContent` in `MissionTabContainer.tsx`):

- **Overview** — `MissionControlOfficePanel` summary card on top, then `MissionRunPanel` with phase progression and active workers. The phase chrome stays compact in the chat-focused layouts; non-chat tabs render the run-completion banner above the panels.
- **Conversations** — `MissionChatV2` shell with `ChatChannelList` (orchestrator + per-worker channels, each carrying `laneId`), `ChatMessageArea` rendering paginated thread messages via `MissionThreadMessageList`, and `ChatInput`. Internal coordinator-prompt boilerplate (`Start mission coordination.`, `Continue mission coordination.`, `RECOVERED TOOL CALLS`, the ADE Mission-Control transport block) is suppressed; mission-control text-tool calls are rewritten through `rewriteMissionControlTextToolEvents` so the user-facing transcript reads clean. Long worker reports with embedded `Changed Files` / `Tests Run` JSON are cleaned by `cleanMissionThreadText` and the changed file list is appended as plain bullets instead.
- **Plan** — planner review summary (objective, strategy, complexity, assumptions, risks) plus the phase-grouped step list with `PhaseCardEditor` cards. Each card edits the phase key, name, description, instructions, model + reasoning level, ask-questions toggle, required-before-exit clarification policy, and the validation gate (`tier`, `required`, criteria, `evidenceRequirements` checklist of `planning_document` / `research_summary` / `changed_files_summary` / `test_report` / `review_summary` / `risk_notes` / `final_outcome_summary` / `screenshot` / `browser_verification` / `video_recording` / `browser_trace` / `console_logs`). Built-in phases keep their key locked; custom phases get a slugified-on-input phase key field. Long phase step lists compact by default so large AutoResearch plans do not duplicate every step in both the phase grouping and the executable list.
- **Timeline** — runtime timeline (run/step/attempt events, interventions, review decisions) is summarized by `OrchestratorActivityFeed`. The raw `MissionLogsTab` view is gated behind a "Show raw logs" toggle so the default surface stays curated; activating the toggle reveals the legacy structured event list with the same intervention focus support.
- **Artifacts** — `MissionArtifactsTab` rendering orchestrator artifact groups (`buildMissionArtifactGroups`) plus broker-managed computer-use artifacts.

Tab navigation uses ARIA `role="tablist"` / `role="tab"` / `role="tabpanel"` with matching `aria-controls` / `aria-labelledby` ids. Tab buttons participate in keyboard navigation (`tabIndex={isActive ? 0 : -1}`).

## Mission page loading

Staged loads. The mission list refreshes immediately; dashboard, settings, and model capability fetches are delayed incrementally. The create-dialog data is prewarmed in the background through `prewarmCreateMissionDialogCache()` instead of duplicate page-level phase fetches. Live-refresh behavior is narrower: mission events refresh list/dashboard on a short coalesced debounce; orchestrator events refresh only the selected mission view on a longer debounce; backgrounded tabs skip most work until the renderer is visible. Selecting a mission updates `?missionId=` and opening a mission from a deep link selects it once the list has loaded.

## Mission creation

The `CreateMissionDialog` prewarms phase profiles and AI model availability. It does not include a PR-strategy selector (result-lane closeout is the only option). New launch drafts inherit Smart Budget defaults from `ai.orchestrator.smartBudget` so mission-specific model configs and preflight estimates use the same thresholds the settings dialog shows. Budget telemetry is conditional:

- Smart budget telemetry only loads when Smart Budget is enabled.
- Subscription budget telemetry only loads when relevant providers are selected.
- API usage aggregation only loads when API-model budgeting is active.

Heavy sections (budget, team runtime, permissions, computer-use controls) mount after the dialog settles. `MissionSettingsDialog` only mounts when open; the host unmounts closed dialog content rather than leaving heavy hidden trees.

## Mission preflight

Preflight (`missionPreflightService.ts`) checks the current project and runtime state before launch, including:

- lane-claim ownership — blocks launches when the selected lane is archived, rebasing, already owned by another live mission, or already recorded as a result lane.
- computer-use readiness (required proof kinds for the selected phase profile, available backends).
- mission policy (execution, finalization, computer-use, budget caps) and phase structural ordering.
- budget estimates (`MissionPreflightBudgetEstimate`).

Preflight warnings surface in the launch dialog but do not block launch unless they are hard-blocking (missing required proof, missing model credentials, no lane selected).

## Cross-links

- `orchestration.md` — coordinator, steps, graph, DAG mutations, delegation contracts, fan-out.
- `validation-gates.md` — behavioral assertions from `docs/validation-contract-m1-m2.md`.
- `workers.md` — mission workers: pool, concurrency, delegation, role isolation.
- `../cto/linear-integration.md` — a `target.type === "mission"` Linear workflow dispatches through `aiOrchestratorService`.
- `../automations/README.md` — automations can launch missions via the `mission` execution surface.
- `../computer-use/README.md` — mission preflight, run monitoring, and artifact review all consume broker-managed artifacts.

## Current product contract

- Mission list stays usable immediately.
- Don't fetch launch-only metadata until the user is actually launching.
- Don't compute budget telemetry unless budget controls are active.
- Mount advanced launcher/settings UI only when needed.
- Live mission updates focus on the selected mission, not the whole dashboard.
- Preserve the durable run/step/artifact model under a lighter UI shell.

## Gotchas and fragile areas

- **`missionLifecycle.ts` uses the deps-injection pattern** because the extraction from `aiOrchestratorService.ts` is partial — many functions re-declare type contracts and get their implementations via the deps arg. Don't assume the file contains the full logic; follow the imports back to `aiOrchestratorService`.
- **Dual intervention creation paths** — `orchestratorService.completeAttempt()`, `runtimeEventRouter.routeEventToCoordinator()`, and `ensureTerminalFailedRunIntervention()` (called from `syncMissionFromRun`) all open `failed_step` interventions. `VAL-INTV-001` / `VAL-INTV-002` assert that they dedupe. Any new code path that creates `failed_step` interventions must re-check existing-open-intervention.
- **Budget pause consistency** — token budget in `completeAttempt` and hard cap in `spawn_worker` must both flow through `pauseMissionWithIntervention`. See `VAL-BUDGET-001`.
- **`tickRun` must skip budget-paused runs** — `VAL-BUDGET-002`. Any refactor that replaces the skip check must preserve the invariant.
- **`finalizationPolicyKind` is always `"result_lane"`** for newly created missions. Don't re-introduce PR-strategy UI without coordinating with the closeout contract.
- **Mission `_snapshotHash` parity** with Linear is separate — don't confuse the two. Mission artifacts use orchestrator artifact tables; Linear workflow artifacts attach via the broker.
