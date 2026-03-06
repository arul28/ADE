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
| Phase 7 | Complete (2026-03-05) | Reflection protocol + retrospective synthesis on strict baseline |

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
- Legacy runtime paths are removed; minimal read-compat remains for historical mission rows (`plan_review` maps to `in_progress`).

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

## Phase 7 (Shipped): Reflection Protocol on Strict Baseline

Status: Complete (2026-03-05).

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

#

## Phase 7 Delivered (2026-03-05)

Delivered:
- Added strict reflection ingestion contract (`reflection_add`) with typed validation errors, required recommendation/context/timestamp fields, and run/mission/step/attempt scope enforcement.
- Persisted reflections to DB (`orchestrator_reflections`) and append-only JSONL ledger under `.ade/reflections/<mission-id>.jsonl` with transaction rollback on ledger-write failure.
- Added deterministic, idempotent post-run retrospective synthesis for terminal runs (including cancel/fallback finalization paths), persisted in DB (`orchestrator_retrospectives`) and JSON artifact files under `.ade/reflections/retrospectives/`.
- Implemented cross-mission changelog persistence (`orchestrator_retrospective_trends`) including `resolved` / `still_open` / `worsened` classifications with source retrospective linkage.
- Implemented pattern repetition tracking (`orchestrator_reflection_pattern_stats` + `orchestrator_reflection_pattern_sources`) with thresholded promotion to memory candidates and dedupe.
- Emitted runtime observability signals (`reflection_added`, `retrospective_generated`) and projected reflection/retrospective state into mission state docs.
- Added MCP observation coverage (`list_retrospectives`, `list_reflection_trends`, `list_reflection_pattern_stats`) and expanded runtime/migration test coverage for reflection protocol behavior.

## Task 7 Operator Runbook

### What is generated automatically
- During run execution, structured reflections are written to:
  - `.ade/reflections/<mission-id>.jsonl`
- On terminal run (`succeeded` / `failed` / `canceled`), one deterministic retrospective is generated per run:
  - DB row in `orchestrator_retrospectives` (`id = retro:<run-id>`)
  - Artifact file in `.ade/reflections/retrospectives/`
  - Runtime event `retrospective_generated`
  - Mission state projection in `.ade/mission-state-<run-id>.json` (`reflections`, `latestRetrospective`)

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

## Historical Doc Policy
- This file is authoritative for orchestrator Phases 5-7.
- `docs/final-plan/phase-3.md` is historical/superseded context only.
- `docs/architecture/AI_INTEGRATION.md` is architecture reference and must mirror active runtime contracts listed above.
