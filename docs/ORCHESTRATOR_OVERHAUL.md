# ADE Orchestrator Overhaul (Rebased)

Date: 2026-03-10  
Owner: Desktop orchestrator/runtime

## Scope Clarification
This is the canonical orchestrator execution roadmap and status document.

This document supersedes stale orchestrator planning details in older roadmap docs.

## Phase Status

| Phase | Status | Notes |
|---|---|---|
| Phase 1 | Complete | MCP transport + runtime stability hardening |
| Phase 2 | Complete | Unified executor runtime cutover |
| Phase 3 | Complete | Phase engine + mission/runtime orchestration baseline |
| Phase 4 | Complete | Subagent delegation + team runtime consolidation |
| Phase 5 | Complete (2026-03-04) | Strict runtime validation enforcement, no bypass/sampling |
| Phase 6 | Complete (2026-03-04) | Strict validation UX + observability + hard legacy cut |
| Phase 7 | Complete (2026-03-05) | Reflection protocol + retrospective synthesis on strict baseline |
| Phase 8 | Complete (2026-03-08) | Adaptive execution, approval gates, multi-round deliberation, model downgrade |
| Phase 9 | Complete (2026-03-09) | UI architecture overhaul — Zustand store, component decomposition, feed quality |

## Strict Baseline (Post-Phase 6)

1. Validation remains deterministic runtime contract enforcement.
2. No sampled validation tier exists in active behavior.
3. Coordinator completion requests do not bypass runtime completion gates; success finalization still requires kernel validation.
4. Phase transitions are blocked when earlier required validation or required predecessor success is missing.
5. Worker spawning is phase-model-routed only (`explicit model override -> current phase model`).
6. Legacy statuses are unsupported by design:
   - Run status `succeeded_with_risk` removed.
   - Mission status `partially_completed` removed.
7. No migration/backfill behavior is provided for removed statuses or legacy team role model defaults.

## Phase 6 Delivered (2026-03-04)

Delivered:

- hard removal of legacy statuses (`succeeded_with_risk`, `partially_completed`) from runtime and UI,
- strict validation observability (`validation_contract_unfulfilled`, `validation_self_check_reminder`, `validation_auto_spawned`, `validation_gate_blocked`) across activity, timeline, runtime bus, and chat metadata,
- validator lineage visibility in the Work tab,
- phase-only worker model routing (`explicit override -> current phase model`),
- MCP/runtime observability updates for validation gate blocking,
- removal of stale compatibility branches and role-default fallback behavior.

## Active Contracts (Now Authoritative)

### Run and mission status contracts
- `OrchestratorRunStatus`:
  - `queued | bootstrapping | active | paused | completing | succeeded | failed | canceled`
- `MissionStatus`:
  - `queued | planning | in_progress | intervention_required | completed | failed | canceled`

### Timeline events (validation)
- `validation_contract_unfulfilled`
- `validation_self_check_reminder`
- `validation_auto_spawned`
- `validation_gate_blocked`

### Runtime bus events (validation)
- `validation_contract_unfulfilled`
- `validation_self_check_reminder`
- `validation_gate_blocked`

### Live runtime update reasons (validation)
- `validation_contract_unfulfilled`
- `validation_self_check_reminder`
- `validation_gate_blocked`

### Chat metadata contract
- Validation system messages carry:
  - `metadata.systemSignal = "validation_*"`

## Current Runtime Notes (2026-03-06)

These notes reflect the current Missions/orchestrator UX and runtime behavior beyond the original phase checklist:

- Planning is a built-in phase and should hand off quickly to a read-only planning worker; the coordinator should not spend long doing its own repo exploration first.
- Configured phase transitions remain explicit coordinator actions; runtime sync can summarize phase progress, but it should not silently advance `currentPhaseKey` across configured boundaries.
- After delegation, coordinator wake-ups should be driven by actionable runtime events, steering input, or worker escalation rather than constant idle reasoning.
- Coordinator-owned worker launches should flow through explicit delegation contracts so the runtime, not prompt wording, owns delegated-scope boundaries, launch recovery, and lifecycle projection.
- Missions chat is split by purpose: Global is the high-signal summary/broadcast thread, while worker and orchestrator channels are the detailed inspection surface.
- Worker/orchestrator thread panes now reuse the shared agent chat renderer, so tool/thinking/status UI should converge with the normal chat experience instead of maintaining a separate Missions-only renderer.
- Permission architecture is split: CLI-backed models rely primarily on provider-native permission modes for native behavior, while ADE separately scopes coordinator/MCP tool exposure; API-key and local models use ADE planning/coding tool profiles.

## Verification (Executed, 2026-03-04)

### Desktop tests
- `npm --prefix /Users/arul/ADE/apps/desktop run test -- src/main/services/orchestrator/coordinatorTools.test.ts src/main/services/orchestrator/executionPolicy.test.ts src/main/services/orchestrator/orchestratorService.test.ts src/main/services/orchestrator/aiOrchestratorService.test.ts src/main/services/missions/missionService.test.ts src/renderer/components/missions/MissionsPage.test.ts src/renderer/components/missions/missionHelpers.test.ts` ✅

### MCP tests
- `npm --prefix /Users/arul/ADE/apps/mcp-server run test -- src/mcpServer.test.ts` ✅

### Typecheck
- `npm --prefix /Users/arul/ADE/apps/desktop run typecheck` ✅
- `npm --prefix /Users/arul/ADE/apps/mcp-server run typecheck` ✅

### Repo assertions (source/docs scope)
- No active `succeeded_with_risk` in `apps/desktop/src` or `apps/mcp-server/src`.
- No active `partially_completed` in `apps/desktop/src` or `apps/mcp-server/src`.
- No role-default model fallback branches remain in orchestrator routing code.

## Phase 7 Delivered (2026-03-05)

Delivered:

- strict reflection ingestion via `reflection_add`,
- JSONL + DB persistence for reflections and retrospectives,
- deterministic post-run retrospective synthesis,
- cross-mission trend tracking (`resolved`, `still_open`, `worsened`),
- thresholded promotion of repeated patterns to memory candidates,
- runtime observability signals plus MCP observation coverage for retrospective data.

## Task 7 Operator Runbook

### What is generated automatically

- reflections in `.ade/reflections/<mission-id>.jsonl`,
- one retrospective per terminal run in DB plus `.ade/reflections/retrospectives/`,
- mission-state projection updates and `retrospective_generated` runtime signals.

### Fast verification after a mission

1. Confirm reflection ledger writes:
   - `ls .ade/reflections`
   - `tail -n 20 .ade/reflections/<mission-id>.jsonl`
2. Confirm retrospective artifact exists:
   - `ls .ade/reflections/retrospectives`
3. Confirm mission-state projection:
   - `cat .ade/mission-state-<run-id>.json`
4. Confirm trend/pattern persistence:
   - `sqlite3 .ade/ade.db "select id, run_id, status, pain_point_label from orchestrator_retrospective_trends order by created_at desc limit 20;"`
   - `sqlite3 .ade/ade.db "select pattern_label, occurrence_count, promoted_memory_id from orchestrator_reflection_pattern_stats order by occurrence_count desc limit 20;"`

### MCP queries for operational use
- `list_retrospectives` (mission-scoped retrospective history)
- `list_reflection_trends` (cross-mission pain-point trajectory with source linkage)
- `list_reflection_pattern_stats` (pattern repetition and candidate-promotion state)

### How to use outputs to improve the system
1. Prioritize top `worsened` trend rows as immediate runtime/prompt fixes.
2. Treat repeated `still_open` rows as structural backlog (workflow/tooling/model-routing debt).
3. Validate `resolved` rows to confirm prior interventions actually removed pain points.
4. Review `list_reflection_pattern_stats` for high-frequency patterns that crossed promotion threshold, then convert accepted candidates into durable memory/pack rules or orchestrator prompt updates.

## Phase 7 hard constraints
- Keep reflection additive only; do not weaken strict validation/runtime gate behavior.
- No implicit completion status expansion.
- No model-routing fallback reintroduction.

## Phase 7 Target Files (Initial)

| File/Area | Purpose |
|---|---|
| `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts` | Reflection ingestion + synthesis hooks |
| `apps/desktop/src/main/services/orchestrator/orchestratorService.ts` | Runtime/timeline trigger points for retrospective generation |
| `apps/desktop/src/main/services/orchestrator/missionStateDoc.ts` | Reflection + retrospective state projections |
| `apps/mcp-server/src/mcpServer.ts` | `reflection_add` MCP tool surface |
| `apps/mcp-server/src/mcpServer.test.ts` | Reflection tool + stream contract coverage |
| `apps/desktop/src/shared/types/orchestrator.ts` | Reflection/retrospective type contracts |

## Phase 8 Delivered (2026-03-08)

Delivered:

- adaptive task complexity classification (`classifyTaskComplexity` in `adaptiveRuntime.ts`) mapping task descriptions to `trivial | simple | moderate | complex` buckets via keyword and word-count heuristics,
- parallelism cap scaling (`scaleParallelismCap`) driven by `TeamComplexityAssessment.estimatedScope` (`small→1`, `medium→2`, `large→4`, `very_large→6`),
- model downgrade evaluation (`evaluateModelDowngrade`) at worker spawn time: when current provider usage exceeds `downgradeThresholdPct`, resolves a cheaper model tier via `resolveCheaperModel` (opus→sonnet, sonnet→haiku, gpt-5→gpt-4o, gpt-4o→gpt-4o-mini),
- approval gates on phase transitions: `requiresApproval` flag on `PhaseCard`, enforcement in `set_current_phase` tool — creates a blocking `phase_approval` intervention when leaving a phase that requires manual sign-off, prevents transition until the intervention is resolved,
- multi-round deliberation: `canLoop` / `loopTarget` on `PhaseCard.orderingConstraints` allowing phases to repeat back to a named target, `maxQuestions` bypass during planning (`resolvePlanningQuestionPolicy`), unbounded coordinator event loops driven by runtime events rather than a fixed iteration cap,
- mandatory planning enforcement: coordinator constructor injects a built-in `Planning` phase with `mustBeFirst: true` and `requiresApproval: true` when the user-configured phase list omits planning, plus `enforcePlanningFirstTurnDelegation` watchdog ensuring the coordinator's first turn spawns a read-only planning worker,
- error classification (`classifyErrorSource` in `missionHelpers.ts`): categorizes runtime errors into `ADE | Provider | Executor | Runtime` sources for targeted UX display (rate-limit/quota → Provider, spawn/process → Executor, sandbox/MCP → Runtime, otherwise → ADE),
- benign sandbox block pattern filtering (`BENIGN_SANDBOX_BLOCK_PATTERNS` in `orchestratorQueries.ts`): suppresses `~/.claude/plans/` write failures and `ExitPlanMode` Zod validation errors so they don't fail or retry worker attempts.

### Phase 8 contracts

- `TaskComplexity`: `"trivial" | "simple" | "moderate" | "complex"`
- `ModelDowngradeResult`: `{ downgraded, originalModelId, resolvedModelId, reason }`
- `PhaseCard.requiresApproval`: boolean — triggers `phase_approval` intervention on phase exit
- `PhaseCard.orderingConstraints.canLoop` / `loopTarget`: enables phase repetition
- `PhaseCard.askQuestions.maxQuestions`: caps planning questions (default 5, range 1-10)
- Error sources: `"ADE" | "Provider" | "Executor" | "Runtime"`

### Phase 8 hard constraints
- Mandatory planning is injected only when no `planning` phaseKey exists; it never overwrites user-configured planning phases.
- Approval gates are blocking: `set_current_phase` refuses the transition until the `phase_approval` intervention is resolved.
- Model downgrade is evaluated at spawn time only; it does not retroactively change running workers.
- Error classification is display-only; it does not affect retry policy or runtime gates.

### Phase 8 Target Files

| File/Area | Purpose |
|---|---|
| `apps/desktop/src/main/services/orchestrator/adaptiveRuntime.ts` | `classifyTaskComplexity`, `scaleParallelismCap`, `evaluateModelDowngrade` |
| `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts` | Approval gate enforcement in `set_current_phase`, planning question policy, phase ordering |
| `apps/desktop/src/main/services/orchestrator/coordinatorAgent.ts` | Mandatory planning injection in constructor, `enforcePlanningFirstTurnDelegation` watchdog |
| `apps/desktop/src/main/services/orchestrator/orchestratorQueries.ts` | `BENIGN_SANDBOX_BLOCK_PATTERNS` for sandbox error suppression |
| `apps/desktop/src/renderer/components/missions/missionHelpers.ts` | `classifyErrorSource` for error source categorization |
| `apps/desktop/src/shared/types/missions.ts` | `PhaseCard.requiresApproval`, `canLoop`, `loopTarget`, `maxQuestions` type contracts |

## Phase 9 Delivered (2026-03-09)

Delivered:

- Zustand store consolidation (`useMissionsStore` — 724 lines) replacing ~45 `useState` hooks spread across mission components with a single normalized store providing fine-grained selectors via `useShallow`,
- component decomposition: `MissionsPage` reduced from ~2437 to 341 lines, `MissionChatV2` from ~1755 to 332 lines, extracted `MissionSidebar`, `MissionDetailView`, `MissionHeader`, `ChatChannelList`, `ChatMessageArea`, `ChatInput`, `InterventionPanel`, `OrchestratorActivityFeed`, `ActivityNarrativeHeader`, `ManageMissionDialog`, `MissionSettingsDialog`, `MissionCreateDialogHost` as standalone components,
- consolidated IPC: `getFullMissionView` (`ade.missions.getFullMissionView`) replacing 5+ sequential IPC round-trips (mission detail + run graph + dashboard + checkpoint + config) with a single batched call,
- event consolidation: `initEventSubscriptions` in store centralizing mission and orchestrator event listeners with debounced refresh timers, replacing per-component `useEffect` event wiring,
- virtualized lists: `@tanstack/react-virtual` integration in `MissionSidebar` for mission list rendering, preventing DOM bloat with large mission counts,
- usage meters: `CompactUsageMeter` in `MissionHeader` displaying per-provider usage percentages with color coding (`usagePercentColor`), per-mission cost, and reset countdown formatting (`formatResetCountdown`),
- intervention UX: `InterventionPanel` component with structured rendering of `phase_approval`, `manual_input`, and `worker_delivery` interventions plus lifecycle actions (Stop, Cancel, Archive) via `getAvailableLifecycleActions`,
- feed quality: `collapseFeedMessages` grouping consecutive duplicate events by `eventType` + `stepId` into collapsed entries with count, `computeProgress` excluding superseded/retry steps from progress calculation, `NOISY_EVENT_TYPES` set filtering `scheduler_tick`, `claim_heartbeat`, `autopilot_parallelism_cap_adjusted` from the activity feed,
- sidebar persistence: sidebar width persisted to `localStorage` under `ade.missions.sidebarWidth` with min/max bounds and auto-collapse below 900px viewport width.

### Phase 9 contracts

- `MissionsState`: Zustand store shape with core domain (`missions`, `selectedMission`, `runGraph`, `dashboard`), loading/error, settings, and UI state slices
- `initEventSubscriptions`: returns cleanup function; manages debounced IPC event listeners for mission and orchestrator channels
- `getFullMissionView`: single IPC call returning `MissionRunView` with detail + graph + dashboard + checkpoint
- `collapseFeedMessages<T>`: generic dedup of feed events → `CollapsedFeedMessage<T>[]`
- `computeProgress`: `{ completed, total, pct }` excluding task-shell and superseded steps
- `NOISY_EVENT_TYPES`: `Set<string>` for feed filtering
- `classifyErrorSource`: `(message: string) => "ADE" | "Provider" | "Executor" | "Runtime"`

### Phase 9 hard constraints
- Store is the single source of truth for mission UI state; components must not maintain shadow copies via local `useState` for data that belongs in the store.
- `initEventSubscriptions` must be called exactly once per mount (via `useEffect` in `MissionsPage`); double-subscription causes duplicate refreshes.
- `getFullMissionView` is the only IPC path for loading a selected mission's runtime state; individual detail/graph/dashboard calls are removed from hot paths.
- `collapseFeedMessages` and `computeProgress` are pure functions tested in `missionUxUtils.test.ts`; they must remain side-effect-free.

### Phase 9 Target Files

| File/Area | Purpose |
|---|---|
| `apps/desktop/src/renderer/components/missions/useMissionsStore.ts` | Zustand store (724 lines) — all mission UI state + actions |
| `apps/desktop/src/renderer/components/missions/MissionsPage.tsx` | Page shell (341 lines) — layout, sidebar/detail split, event subscription init |
| `apps/desktop/src/renderer/components/missions/MissionChatV2.tsx` | Chat container (332 lines) — channel list, message area, input |
| `apps/desktop/src/renderer/components/missions/MissionDetailView.tsx` | Detail pane — tabs, activity feed, work/chat/settings routing |
| `apps/desktop/src/renderer/components/missions/MissionHeader.tsx` | Header bar — status badge, `CompactUsageMeter`, lifecycle actions |
| `apps/desktop/src/renderer/components/missions/MissionSidebar.tsx` | Sidebar — virtualized mission list, search filter, context menu |
| `apps/desktop/src/renderer/components/missions/InterventionPanel.tsx` | Intervention cards — approval, input, delivery rendering |
| `apps/desktop/src/renderer/components/missions/OrchestratorActivityFeed.tsx` | Activity feed — collapsed events, narrative header |
| `apps/desktop/src/renderer/components/missions/missionHelpers.ts` | Pure helpers — `collapseFeedMessages`, `computeProgress`, `NOISY_EVENT_TYPES`, `classifyErrorSource` |
| `apps/desktop/src/shared/ipc.ts` | `missionsGetFullMissionView` IPC channel definition |

## Historical Doc Policy
- This file is authoritative for orchestrator Phases 5-9.
- `docs/final-plan/phase-3.md` is historical/superseded context only.
- `docs/architecture/AI_INTEGRATION.md` is architecture reference and must mirror active runtime contracts listed above.

## Kernel Hardening (2026-03-09)

Applied after Phase 7 close to tighten orchestrator invariants discovered during integration testing.

### Forced Finalize Removal
- `complete_mission` no longer accepts a `force` parameter.
- Completion always routes through runtime validation gates; the coordinator cannot bypass required validation, outstanding interventions, or in-progress steps.
- Mission completion is gated on all configured phase requirements (validation, predecessor success, evidence closeout).

### Phase Gating Semantics
- `mustBeFirst` phases now require **successful** completion, not merely terminal status. A failed or cancelled first phase blocks all downstream phases.
- Optional phase failures are now tracked as risk factors in completion evaluation (previously silently ignored).
- Phase transitions remain explicit coordinator actions enforced by runtime policy.

### Intervention Keying
- `resolveIntervention` now validates by `interventionId`, not positional matching.
- Worker delivery interventions carry source message linkage for traceability.
- Stale in-flight delivery attempts are failed deterministically after a configurable lease timeout.

### Idempotent Replay
- Worker message delivery uses in-flight lease tracking to prevent duplicate delivery.
- Queued worker messages replay on startup reconciliation and on agent chat turn-completion signals.
- Retry budget with exponential backoff prevents infinite retry loops; exhausted retries open recovery interventions.

### MCP Tool Visibility
- MCP tool listing now correctly scopes tools to the coordinator's configured tool set rather than exposing the full internal tool surface.
- Planning-mode tool profiles restrict write operations during the planning phase.
