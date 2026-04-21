# Orchestration

The orchestrator is the runtime that drives missions. It owns runs, steps, attempts, claims, artifacts, gate reports, timeline events, and the coordinator-agent session that turns a natural-language goal into a multi-step plan and execution DAG.

## Source file map

All in `apps/desktop/src/main/services/orchestrator/`.

- `orchestratorService.ts` — row-level persistence and the low-level run state machine. `tickRun`, `completeAttempt`, claim acquisition, gate reports. ~8000 LOC. The most delicate file in the service layer.
- `aiOrchestratorService.ts` — the façade used by the rest of the app and by the AI surfaces. Wires mission + orchestrator + AI integration + memory + budget + conflict services. Owns top-level flows: `pauseMissionWithIntervention`, `steerMission`, run finalization, recovery.
- `coordinatorAgent.ts` — the coordinator brain. Provider-agnostic AI agent that runs until the mission is terminal. Owns planning lifecycle, tool execution, compaction, checkpointing.
- `coordinatorTools.ts` — the coordinator's tool surface: `spawn_worker`, `check_status`, `send_message_to_worker`, `ask_user`, `finalize_run`, `check_finalization_status`, `mark_phase_complete`, `request_lane`, `request_human_review`, DAG mutation helpers.
- `coordinatorSession.ts` — coordinator-session lifecycle (start, resume, checkpoint).
- `coordinatorEventFormatter.ts` — formats runtime events into human-readable messages for the coordinator chat thread.
- `missionLifecycle.ts` — mission-specific run start, approve, cancel, cleanup, steer, sync, lane provisioning, team manifest synthesis. Partial extraction from `aiOrchestratorService`; uses the deps-injection pattern so closures still live in the façade.
- `missionStateDoc.ts` — `.ade/missions/<missionId>/state.md` + coordinator checkpoint files (`checkpoint.json`). Used for resume and for the `check_finalization_status` tool.
- `executionPolicy.ts` — default `MissionExecutionPolicy`, merge rules (mission metadata > project config > fallback), run completion validation, phase-to-executor mapping.
- `adaptiveRuntime.ts` — `classifyTaskComplexity` heuristics (`trivial` / `simple` / `moderate` / `complex`), parallelism scaling, model downgrade rules.
- `delegationContracts.ts` — `DelegationContract` types and helpers. Each worker delegation carries a scope, allowed tools, and handoff shape.
- `workerDeliveryService.ts` — message delivery pipeline: coordinator -> worker chat, worker -> coordinator. Retry, idempotency, in-flight leases. Imports `WORKER_MESSAGE_RETRY_BUDGET`, `WORKER_MESSAGE_INFLIGHT_LEASE_MS`, `WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS`.
- `runtimeEventRouter.ts` — routes events from worker sessions and CLI output into the coordinator. Classifies events, creates interventions, triggers coordinator evaluation.
- `metaReasoner.ts` — higher-level reasoning helpers for coordinator decisions.
- `metricsAndUsage.ts` — token and cost accounting; `estimateTokenCost`.
- `recoveryService.ts` — tracked session state, recovery iteration policy (`DEFAULT_RECOVERY_LOOP_POLICY`).
- `workerTracking.ts` — worker session tracking, per-attempt artifact extraction (`extractAndRegisterArtifacts`), planning-phase plan-artifact persistence gate, and `planner_plan_missing` intervention auto-resolution on successful re-planning.
- `stepPolicyResolver.ts` — `ResolvedOrchestratorRuntimeConfig`, step-level policy merging, autopilot config, file-claim scope (`doFileClaimsOverlap`, `doesFileClaimMatchPath`), repo-relative path normalization.
- `baseOrchestratorAdapter.ts` — `buildFullPrompt` (the worker prompt builder), shell escaping, inline decoding.
- `providerOrchestratorAdapter.ts` — provider-specific launchers for Claude CLI, Codex CLI, and managed OpenCode-backed execution.
- `promptInspector.ts` — coordinator / planning / worker prompt inspectors for the mission UI.
- `runtimeInterventionsSteeringErrors.test.ts` — runtime intervention behavior tests.
- `planningFlowAndHandoffs.test.ts`, `planningGapsFixes.test.ts` — planning lifecycle tests.
- `hardeningMissions.test.ts` — mission hardening regression suite.
- `knowledgeConflictsBrowserCto.test.ts` — knowledge and browser-conflict tests.
- `stateCoherence.test.ts` — state coherence invariants (`VAL-STATE-*`).
- `worktreeIsolation.test.ts` — worktree isolation invariants (`VAL-ISO-*`).
- `orchestrationRuntime.test.ts` — end-to-end runtime integration tests.
- `orchestratorConstants.ts` — `DEFAULT_RECOVERY_LOOP_POLICY`, `DEFAULT_CONTEXT_VIEW_POLICIES`, `DEFAULT_ROLE_ISOLATION_RULES`, `DEFAULT_INTEGRATION_PR_POLICY`.
- `orchestratorContext.ts` — `OrchestratorContext` type (shared runtime state), pure helpers, constants (`TERMINAL_STEP_STATUSES`, `STEERING_DIRECTIVES_METADATA_KEY`, etc.), `parseJsonRecord`, `isRecord`, `nowIso`.
- `orchestratorQueries.ts` — row-to-typed-object mapping: `toRun`, `toStep`, `toAttempt`, `toClaim`, `toContextSnapshot`, `toHandoff`, `toArtifact`, `toTimelineEvent`, `toRuntimeEvent`, `toGateReport`; `normalizeEnvelope`, `classifyBlockingWarnings`, `validateStepGraphIntegrity`.
- `permissionMapping.ts` — `MissionProviderPermissions` -> provider allowed-tools; `mapPermissionToInProcess`.
- `teamRuntimeConfig.ts` / `teamRuntimeState.ts` — team manifest and runtime state.

## Coordinator agent

The coordinator is a provider-agnostic AI agent that runs until the mission is terminal. Its dependencies (`CoordinatorAgentDeps`):

- `orchestratorService`, `missionService`, `projectConfigService`, `memoryService`, optional `getMissionBudgetStatus`.
- `runId`, `missionId`, `missionGoal`, `modelId`.
- Project context (`projectRoot`, `projectDocPaths`, `projectKnowledge`, `fileTree`).
- Available providers.
- Phase cards (for the coordinator prompt).
- Callbacks: `onDagMutation`, `onCoordinatorMessage`, `onCoordinatorEvent`, `onRunFinalize`, `onHardCapTriggered`, `onBudgetWarning`, `onPlanningStartupFailure`, `onCoordinatorRuntimeFailure`, `sendWorkerMessageToSession`.
- `missionLaneId`, `provisionLane`.
- `userRules: CoordinatorUserRules` — provider preference, cost mode, max parallel workers, allow-parallel-agents, allow-sub-agents, allow-claude-agent-teams, lane strategy, coordinator model, closeout contract, budget limits, recovery enabled/max iterations.

### Lifecycle states

`CoordinatorLifecycleState`:

- `booting` — initializing.
- `analyzing_prompt` — parsing the mission goal.
- `fetching_project_context` — loading project state.
- `launching_planner` — spawning the planning worker.
- `waiting_on_planner` — planner is running.
- `planner_launch_failed` — planner spawn failed; triggers retry or intervention.
- `stopped` — coordinator has shut down.

### Constants

- `BATCH_DELAY_MS = 200` — coalesces incoming events before processing.
- `MAX_TOOL_STEPS_PER_TURN = 25` — upper bound on tool calls per coordinator turn.
- `COMPACTION_THRESHOLD_RATIO = 0.50` — when to trigger context compaction.
- `MAX_CONVERSATION_HISTORY = 200` — max turns held in memory before compaction.
- `MAX_EVENT_RETRY_COUNT = 2` — retries per queued event.
- `CHECKPOINT_TURN_INTERVAL = 5` — checkpoint every N turns.

### Compaction

Uses `createCompactionMonitor` from `ai/compactionEngine`. When the conversation exceeds the compaction threshold, `compactConversation` builds a summarized transcript and resumes. The coordinator identity and phase prompt are re-injected after compaction (same pattern as CTO identity re-injection).

### Checkpointing

Every `CHECKPOINT_TURN_INTERVAL` turns, the coordinator writes a checkpoint via `writeCoordinatorCheckpoint`. On resume, `readCoordinatorCheckpoint` restores conversation state. Checkpoint path is resolved via `getCoordinatorCheckpointPath`.

## Coordinator tools

`createCoordinatorToolSet` registers tools on the coordinator agent. Each tool has a schema (Zod), a handler, and a `CoordinatorExecutableTool` wrapper for permission checks (`checkCoordinatorToolPermission`). Highlights:

- `spawn_worker` — launches a worker attempt. Respects `allowParallelAgents` and the mission's max-parallel-workers cap. Honors role isolation rules (`DEFAULT_ROLE_ISOLATION_RULES`).
- `send_message_to_worker` — routes a message into an active worker chat via `sendWorkerMessageToSession`.
- `check_status` — reads run/step/attempt state.
- `ask_user` — creates a `manual_input` intervention.
- `mark_phase_complete` — advances the phase cursor.
- `request_human_review` — creates an `awaiting_human_review` intervention.
- `request_lane` — asks the orchestrator to provision a new lane via `provisionLane`.
- `finalize_run` — synthesizes the result lane and ends the run.
- `check_finalization_status` — reads `state.md` and returns contract-satisfaction, execution-completeness, and result-lane readiness.
- DAG mutation helpers — `add_step`, `add_dependency`, `remove_step`, `update_step_metadata`.

## Run graph

`OrchestratorRunGraph` contains:

- `run` (`OrchestratorRun`).
- `steps` (`OrchestratorStep[]`) with status, dependencies, fan-out variants.
- `attempts` (`OrchestratorAttempt[]`) per step.
- `claims` (`OrchestratorClaim[]`) — file-path and path-scope claims to prevent overlapping workers.
- `artifacts` (`OrchestratorArtifact[]`).
- `timelineEvents`.
- `runtimeEvents`.
- `gateReports` (validation gate outputs).
- `reflections` (`OrchestratorReflectionEntry[]`).

## Execution policy

`MissionExecutionPolicy` is the per-phase executor configuration:

- `planning.mode: "auto" | "off"`, `planning.model`.
- `implementation.model`.
- `testing.mode: "post_implementation" | "off"`, `testing.model`.
- `validation.mode: "optional" | "required" | "off"`, `validation.model`.
- `codeReview.mode`, `testReview.mode`, `prReview.mode`, `merge.mode` (all off by default).
- `prStrategy.kind` — default `"manual"`, but the closeout contract enforces `"result_lane"` finalization regardless.

`resolveExecutionPolicy({ missionMetadata, projectConfig, fallback })` merges by priority: mission metadata > project config > fallback > `DEFAULT_EXECUTION_POLICY`.

## Adaptive runtime

`classifyTaskComplexity(description)` returns one of `trivial` / `simple` / `moderate` / `complex` based on keyword heuristics plus word count and filename-reference count. This drives:

- parallelism caps — trivial/simple runs fewer parallel workers.
- model downgrade — simple tasks can switch to a smaller model to save budget.
- budget allocation — complex tasks pre-allocate a larger budget buffer.

## Delegation contracts

Every worker spawn creates a `DelegationContract`:

- Scope — what the worker is allowed to touch (file paths, lane, step ids).
- Allowed tools — enforced per provider via `permissionMapping.ts`.
- Handoff shape — what the worker must produce on completion.
- Failure policy — retry budget, fallback path.

`extractDelegationContract` / `updateDelegationContract` / `derivePlanningStartupStateFromContract` keep the contract in sync during runtime. `extractActiveDelegationContracts` surfaces the currently active contracts for the coordinator's "what's running" view.

## Planning artifact persistence and intervention recovery

`workerTracking.ts` owns the post-attempt artifact pass for every
worker completion. `extractAndRegisterArtifacts(ctx, { graph, attempt })`
walks the attempt's `resultEnvelope`, writes the canonical plan
markdown under `.ade/missions/<missionId>/plan.md`, registers it via
`registerArtifact`, and returns `{ planArtifactPersisted }`. The flag
is `true` only when the plan markdown was actually written **and**
the artifact row was registered in this attempt — `report_result.plan.markdown`
alone is insufficient, because the underlying `fs.writeFileSync` or
`registerArtifact` may have failed silently.

A `planner_plan_missing` intervention (`interventionType: "failed_step"`,
`reasonCode: "planner_plan_missing"`) is opened when the planner
completes without a usable plan. `resolvePlannerPlanMissingInterventionsAfterPlanningSuccess`
is the matching auto-resolver: on any successful planning-phase
attempt (`stepType === "planning" | "analysis"` or
`phaseKey === "planning"`), if and only if `planArtifactPersisted` is
`true`, it resolves every open `planner_plan_missing` intervention on
the mission and emits a runtime event
(`eventType: "intervention_resolved"`,
`eventKey: "intervention_resolved:<id>:planner_plan_recovered"`).

The resolver is intentionally cross-run: any later successful
planning attempt can clear a stale intervention that was recorded by
a previous run. Without the `planArtifactPersisted` gate the resolver
could clear the intervention when the plan was never actually
written, so the persistence check is load-bearing — do not relax it
to just checking `report_result.plan`.

## Runtime event routing

`runtimeEventRouter.routeEventToCoordinator()` classifies an incoming event (worker output, CLI signal, test result, gate report) and decides whether to:

- append it to the coordinator thread verbatim,
- create an intervention,
- trigger a coordinator evaluation,
- or update run / step / attempt status directly.

This is the critical path for dedup: both this router and `orchestratorService.completeAttempt` can create interventions, so both code paths must check for an existing-open intervention before inserting (see `VAL-INTV-001`).

## Worker delivery

`workerDeliveryService` handles delivering a coordinator message to an active worker chat. It uses:

- Retry with backoff (`computeWorkerRetryBackoffMs`).
- In-flight leases (`WORKER_MESSAGE_INFLIGHT_LEASE_MS`) to prevent double delivery.
- Stale-fail threshold (`WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS`) to unstick orphaned leases.
- Queued replay (`replayQueuedWorkerMessages`) on worker reconnect.
- Error normalization (`normalizeDeliveryError`, `isBusyDeliveryError`, `isNoActiveTurnError`).

## Recovery loop

`RecoveryLoopPolicy` (default in `orchestratorConstants.ts`) controls:

- Whether recovery is enabled.
- Max iterations.
- Per-iteration budget.
- Whether to switch provider/model on retry.

`recoveryService.getTrackedSessionState()` tracks per-session recovery progress. `RecoveryLoopState` is persisted on the run so recovery survives restarts.

## Prompt inspectors

`promptInspector.ts` exposes three builders:

- `buildCoordinatorPromptInspector(args)` — what the coordinator sees.
- `buildPlanningPromptPreview(args)` — what the planner sees.
- `buildWorkerPromptInspector(args)` — what a worker sees (per attempt).

The mission UI renders these for debugging and transparency.

## Gotchas

- **`missionLifecycle.ts` is not self-contained.** It declares types and re-exports signatures but the actual closures live in `aiOrchestratorService.ts`. Follow the `deps` parameter pattern when adding functionality.
- **Compaction must re-inject identity.** If you skip re-injection after compaction, the coordinator drifts into generic-chatbot behavior mid-mission.
- **DAG mutations are event-driven.** The coordinator emits `DagMutationEvent`s; the orchestratorService applies them. Don't mutate run-graph rows directly from coordinator code.
- **Role isolation rules block cross-role writes.** `DEFAULT_ROLE_ISOLATION_RULES` prevents, e.g., the QA worker from editing implementation files. Adjust with care; `roleIsolationValidation` tests cover the invariants.
- **File claims overlap detection is recursive.** `doFileClaimsOverlap` and `doesFileClaimMatchPath` use `normalizeRepoRelativePath`; any path normalization change must round-trip through the test suite.
- **`tickRun` must remain idempotent.** It is the main liveness loop; changes that introduce side effects per tick will compound over time.

## Cross-links

- `README.md` — mission overview and runtime contract.
- `validation-gates.md` — VAL-XXX assertions grouped by area.
- `workers.md` — worker pool, concurrency, role isolation.
- `../cto/README.md` — the CTO can launch missions via `startMission` operator tool; CTO tool surface is separate from the coordinator tool surface.
- `../computer-use/README.md` — mission preflight and run monitoring read from the computer-use broker.
