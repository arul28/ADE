# ADE Orchestrator Overhaul (Rebased)

Date: 2026-03-04  
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
| Phase 7 | Ready | Reflection protocol + retrospective synthesis on strict baseline |

## Strict Baseline (Post-Phase 6)

1. Validation remains deterministic runtime contract enforcement.
2. No sampled validation tier exists in active behavior.
3. No completion-risk bypass exists in active behavior.
4. Phase transitions are blocked when earlier required validation is missing.
5. Worker spawning is phase-model-routed only (`explicit model override -> current phase model`).
6. Legacy statuses are unsupported by design:
   - Run status `succeeded_with_risk` removed.
   - Mission status `partially_completed` removed.
7. No migration/backfill behavior is provided for removed statuses or legacy team role model defaults.

## Phase 6 Delivered (End-to-End, 2026-03-04)

### 1) Strict status model hard-cut (legacy removal)
Delivered:
- Removed run status `succeeded_with_risk` from runtime typing and execution/finalization branches.
- Removed mission status `partially_completed` from mission typing, transitions, lifecycle, and UI helpers/banners.
- Removed all active UI display branches for removed statuses.

Primary files:
- `apps/desktop/src/shared/types/orchestrator.ts`
- `apps/desktop/src/main/services/orchestrator/executionPolicy.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`
- `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorQueries.ts`
- `apps/desktop/src/shared/types/missions.ts`
- `apps/desktop/src/main/services/missions/missionService.ts`
- `apps/desktop/src/main/services/orchestrator/missionLifecycle.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorContext.ts`
- `apps/desktop/src/renderer/components/missions/CompletionBanner.tsx`
- `apps/desktop/src/renderer/components/missions/MissionsPage.tsx`
- `apps/desktop/src/renderer/components/missions/missionHelpers.ts`

### 2) Validation signal UX + gate-blocked observability
Delivered:
- Activity feed now renders explicit validation signal events with dedicated labels/severity:
  - `validation_contract_unfulfilled`
  - `validation_self_check_reminder`
  - `validation_auto_spawned`
  - `validation_gate_blocked`
- Removed stale activity-feed display paths for dead events (`completion_risk`, `completion_diagnostic`).
- `spawn_worker` now appends durable timeline event `validation_gate_blocked` when required validation gate blocks spawn.
- Runtime bus now persists `validation_gate_blocked` and emits live run/step update reason `validation_gate_blocked`.
- AI orchestrator emits explicit validation system chat messages for validation runtime reasons with normalized `metadata.systemSignal`.
- Mission chat now renders dedicated “Validation System” bubble styling when `metadata.systemSignal` is present.

Primary files:
- `apps/desktop/src/renderer/components/missions/OrchestratorActivityFeed.tsx`
- `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`
- `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts`
- `apps/desktop/src/renderer/components/missions/MissionChatV2.tsx`

### 3) Team/runtime visibility consolidation
Delivered:
- Added validator lineage panel in Work tab derived from step metadata.
- Displays validator linkage + lifecycle signals:
  - `autoSpawnedValidation`
  - `targetStepKey`
  - validator role/model
  - validator step status and target status linkage
- Validator entries are visually distinct from general worker/team entries.

Primary file:
- `apps/desktop/src/renderer/components/missions/WorkTab.tsx`

### 4) Phase-only model routing hard cut (replacing old role override path)
Delivered:
- Coordinator tool model resolution now enforces:
  - `explicit override -> current phase model` only.
- Removed role-default and parent-model fallback routing from:
  - `spawn_worker`
  - `request_specialist`
  - `delegate_to_subagent`
  - `delegate_parallel`
  - `revise_plan` new-step model resolution fallback path
- Auto-spawn validator model selection now uses phase model path only (no role-default candidate).
- Removed role `defaultModel` surface from team runtime template parsing/default config.

Primary files:
- `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`
- `apps/desktop/src/shared/types/orchestrator.ts`
- `apps/desktop/src/main/services/orchestrator/teamRuntimeConfig.ts`

### 5) MCP observability hardening
Delivered:
- MCP runtime stream bridge now includes `validation_gate_blocked` alongside existing validation runtime signals.
- `stream_events` runtime contract test coverage updated.

Primary files:
- `apps/mcp-server/src/bootstrap.ts`
- `apps/mcp-server/src/mcpServer.test.ts`

### 6) Dead code and compatibility branches removed
Delivered:
- Removed obsolete status branches, stale event rendering branches, and role-default routing behavior in active runtime code paths.
- Legacy compatibility behavior intentionally not retained (single-user dev environment, no migration/backfill requirement).

## Active Contracts (Now Authoritative)

### Run and mission status contracts
- `OrchestratorRunStatus`:
  - `queued | bootstrapping | active | paused | completing | succeeded | failed | canceled`
- `MissionStatus`:
  - `queued | planning | plan_review | in_progress | intervention_required | completed | failed | canceled`

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

## Phase 7 (Execution-Ready): Reflection Protocol on Strict Baseline

Status: Ready to execute.

### 7.1 Reflection ingestion contract
Build:
- Introduce structured reflection ingestion tool contract (`reflection_add`) scoped by mission/run/step/role.
- Persist to DB + append-only `.ade/reflections/*.jsonl` ledger.
- Normalize schema versioning and required fields (timestamp, scope, signalType, observation, recommendation).

Acceptance:
- Reflections can be ingested deterministically from coordinator/runtime workflows.
- Malformed reflections are rejected with typed errors (no silent coercion).

### 7.2 Post-run retrospective synthesis
Build:
- On terminal run, synthesize retrospective artifact from:
  - timeline
  - runtime events
  - structured reflections
  - mission outcome/state doc
- Persist retrospective artifact and emit runtime refresh signal.

Acceptance:
- Every terminal run can produce one deterministic retrospective artifact.
- Retrospective contains explicit sections for wins, failures, unresolved risks, and follow-up actions.

### 7.3 Cross-mission changelog
Build:
- Compare retrospectives across missions.
- Classify prior pain points as:
  - `resolved`
  - `still_open`
  - `worsened`
- Persist trend records for mission dashboard consumption.

Acceptance:
- Cross-mission trend data is queryable and linkable to source retrospectives.

### 7.4 Pattern promotion to memory candidates
Build:
- Promote repeated stable retrospective patterns to memory-candidate records with dedupe.
- Gate promotion on confidence/repetition thresholds.

Acceptance:
- Duplicate/noisy patterns are not repeatedly promoted.
- Promoted candidates are traceable to originating retrospectives.

### Phase 7 hard constraints
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

## Historical Doc Policy
- This file is authoritative for orchestrator Phases 5-7.
- `docs/final-plan/phase-3.md` is historical/superseded context only.
- `docs/architecture/AI_INTEGRATION.md` is architecture reference and must mirror active runtime contracts listed above.
