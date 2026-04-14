# Missions

A mission is ADE's structured, multi-step execution primitive. It wraps a user goal in a durable run/step/attempt/intervention/artifact state machine while a coordinator agent plans, delegates, monitors, and finalizes. Missions are the heavy-orchestration path — the lighter paths are a CTO chat turn or an automation rule.

The runtime is feature-rich but the mission launcher and page shell now follow a staged-load model so the surface stays responsive even while orchestrator metadata warms up.

## Source file map

### Core services (apps/desktop/src/main/services/)

- `missions/missionService.ts` — the mission persistence layer. Missions, steps, interventions, artifacts, events. `createMission`, `addMissionStep`, `addIntervention`, `addArtifact`, `getMissionDetail`, `getMissionEvents`. Handles terminal-status guards (`TERMINAL_MISSION_STATUSES`).
- `missions/phaseEngine.ts` — phase cards, profiles, built-in phases (`planning`, `development`, `testing`, `validation`, legacy `prAndConflicts`), `applyPhaseCardsToPlanSteps`, `validatePhaseSequence`, `groupMissionStepsByPhase`.
- `missions/missionPreflightService.ts` — preflight checks: knowledge sync, human work digest, computer-use readiness, budget estimates.
- `orchestrator/orchestratorService.ts` — runtime state machine: runs, steps, attempts, claims, artifacts, gate reports, timeline events. ~8000 LOC. Owns the tick loop and `completeAttempt`.
- `orchestrator/aiOrchestratorService.ts` — façade that ties missionService + orchestratorService + AI integration together. Owns `pauseMissionWithIntervention`, `steerMission`, recovery, `check_finalization_status`.
- `orchestrator/coordinatorAgent.ts` — the coordinator brain. Long-running AI agent that plans, spawns workers, monitors, advances phases, and finalizes. Lifecycle states: `booting`, `analyzing_prompt`, `fetching_project_context`, `launching_planner`, `waiting_on_planner`, `planner_launch_failed`, `stopped`.
- `orchestrator/coordinatorTools.ts` — tools the coordinator can call (plan DAG, spawn workers, check status, ask the user, finalize).
- `orchestrator/coordinatorSession.ts` — per-coordinator session state.
- `orchestrator/missionLifecycle.ts` — mission run start, approve, cancel, cleanup, steer, sync, lane provisioning, team manifest synthesis.
- `orchestrator/missionStateDoc.ts` — `.ade/missions/<missionId>/state.md` and coordinator checkpoint files.
- `orchestrator/missionBudgetService.ts` — budget telemetry: estimates, rollups by phase/worker/provider, hard caps, pressure levels.
- `orchestrator/executionPolicy.ts` — default `MissionExecutionPolicy`, merge rules (mission > project > fallback), completion evaluation, run/step validation.
- `orchestrator/adaptiveRuntime.ts` — `classifyTaskComplexity` (trivial/simple/moderate/complex), parallelism scaling, model downgrade.
- `orchestrator/workerDeliveryService.ts` — message delivery pipeline between coordinator and worker chats; retry, idempotency, in-flight leases.
- `orchestrator/delegationContracts.ts` — contracts between coordinator and workers (scope, allowed tools, handoff shape).
- `orchestrator/runtimeEventRouter.ts` — routes events from worker sessions and CLI output into the coordinator.
- `orchestrator/metaReasoner.ts` — higher-level reasoning for coordinator choices.
- `orchestrator/metricsAndUsage.ts` — token / cost accounting per run.
- `orchestrator/recoveryService.ts` — tracked session state, recovery iterations.
- `orchestrator/stepPolicyResolver.ts` — step-level policy merging, autopilot config, file-claim scope.
- `orchestrator/baseOrchestratorAdapter.ts` — `buildFullPrompt` + shell escaping.
- `orchestrator/providerOrchestratorAdapter.ts` — provider-specific worker launches (Claude CLI, Codex CLI, MCP).
- `orchestrator/promptInspector.ts` — coordinator / planning / worker prompt inspectors for the mission detail UI.
- `orchestrator/missionStateDoc.ts` — state doc and coordinator checkpoint read/write.
- `orchestrator/teamRuntimeConfig.ts` / `teamRuntimeState.ts` — team manifest and runtime state.
- `orchestrator/permissionMapping.ts` — mission permission config to provider-specific tool permissions.
- `orchestrator/orchestratorQueries.ts` — row types, helpers for mapping DB rows to typed objects, normalization.

### Renderer

- `apps/desktop/src/renderer/components/missions/` — mission launcher, detail views, plan / chat / artifacts / history panels, mission-run monitor. (See `orchestration.md` and `validation-gates.md` for the specific files used during orchestration.)

### Validation contract

- `docs/validation-contract-m1-m2.md` — the behavioral test spec. Canonical list of required invariants with VAL-XXX identifiers.

## Runtime contract

### Planning is mandatory

Planning is the first-class initial phase. If a phase profile omits a planning phase, `createBuiltInPhaseCards()` injects one before execution begins. The coordinator:

1. Gathers project context (`fetching_project_context`).
2. Optionally asks clarifying questions.
3. Delegates to a planning worker (`launching_planner` -> `waiting_on_planner`).
4. Explicitly advances phases as plan steps complete.

A planning-startup guard prevents non-ADE tool drift during the prep phase. If the coordinator detects tool calls that don't belong to the planning setup (e.g. arbitrary external MCP calls during context fetch), they are trapped and routed into explicit recovery rather than silent fallback.

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

### Mission step bidirectional sync

`syncRunStepsFromMission()` pulls user-initiated mutations (cancel, skip) from the mission state back into orchestrator run state. The orchestrator picks the change up on its next tick.

### Cascade cleanup

On terminal state, the runtime calls `cleanupTeamResources()` (best-effort). Worker sessions, temporary worktrees, and team-scoped resources are torn down so they don't leak across runs.

### Mission detail warnings

Loading a mission returns `MissionDetailWarning[]` for records with invalid JSON in metadata. Each warning has `code` (`invalid_json` | `truncated_events`), `source`, `field`, `message`. The UI surfaces warnings instead of silently dropping records.

### Mission event pagination

`getMissionEvents({ missionId, limit?, before? })` returns `MissionEventsPage` with `events`, `nextCursor`, `hasMore`, and any deserialization `warnings`. Default page size 200; cursor encodes `createdAt::id`. Mission detail loads recent events eagerly and older events on demand.

### Queue deduplication

Queued missions use a claim-token mechanism to prevent duplicate starts from stale orchestrator events. `claimQueuedMissionStart()` acquires an exclusive token under `BEGIN IMMEDIATE`. Stale after 2 minutes. `queue_claim_token` + `queue_claimed_at` columns on the missions table support this. Missions with `autostart: false` in launch metadata are excluded from automatic queue processing.

## Mission detail surface

Four tabs:

- **Plan** — planner review summary (objective, strategy, complexity, assumptions, risks), DAG visualization, phase-grouped step list.
- **Chat** — paginated thread messages with cursor-based loading and "load older". Separate global summary thread and worker/orchestrator detail threads.
- **Artifacts** — orchestrator artifacts + broker-managed computer-use artifacts.
- **History** — timeline of run/step/attempt events, interventions, review decisions.

## Mission page loading

Staged loads. The mission list refreshes immediately; dashboard, settings, and model capability fetches are delayed incrementally. The create-dialog data is prewarmed in the background (phase profiles, phase items, AI auth/model availability). Live-refresh behavior is narrower: mission events refresh list/dashboard on a short coalesced debounce; orchestrator events refresh only the selected mission view on a longer debounce; backgrounded tabs skip most work until the renderer is visible.

## Mission creation

The `CreateMissionDialog` prewarms phase profiles and AI model availability. It does not include a PR-strategy selector (result-lane closeout is the only option). Budget telemetry is conditional:

- Smart budget telemetry only loads when Smart Budget is enabled.
- Subscription budget telemetry only loads when relevant providers are selected.
- API usage aggregation only loads when API-model budgeting is active.

Heavy sections (budget, team runtime, permissions, computer-use controls) mount after the dialog settles. `MissionSettingsDialog` only mounts when open; the host unmounts closed dialog content rather than leaving heavy hidden trees.

## Mission preflight and knowledge sync

Preflight (`missionPreflightService.ts`) checks the current project and runtime state before launch, including:

- knowledge-sync freshness (`HumanWorkDigestService`) — warn when human-authored code changed since the last digest.
- computer-use readiness (required proof kinds for the selected phase profile, available backends).
- mission policy (execution, finalization, computer-use, budget caps).
- budget estimates (`MissionPreflightBudgetEstimate`).

Preflight warnings surface in the launch dialog but do not block launch unless they are hard-blocking (missing required proof, missing model credentials, no lane selected).

## Mission-scoped memory

Workers write discoveries to the `mission` scope via `memoryAdd` during execution. On mission success, high-value mission memories are promoted to the `project` scope. Mission detail does not have its own memory browsing surface — all memory browsing lives in Settings > Memory.

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
- **Dual intervention creation paths** — `orchestratorService.completeAttempt()` and `runtimeEventRouter.routeEventToCoordinator()` both used to create interventions. `VAL-INTV-001` / `VAL-INTV-002` assert that they now dedupe. Any new code path that creates `failed_step` interventions must re-check existing-open-intervention.
- **Budget pause consistency** — token budget in `completeAttempt` and hard cap in `spawn_worker` must both flow through `pauseMissionWithIntervention`. See `VAL-BUDGET-001`.
- **`tickRun` must skip budget-paused runs** — `VAL-BUDGET-002`. Any refactor that replaces the skip check must preserve the invariant.
- **`finalizationPolicyKind` is always `"result_lane"`** for newly created missions. Don't re-introduce PR-strategy UI without coordinating with the closeout contract.
- **Mission `_snapshotHash` parity** with Linear is separate — don't confuse the two. Mission artifacts use orchestrator artifact tables; Linear workflow artifacts attach via the broker.
