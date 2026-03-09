# ADE Orchestrator Overhaul (Rebased)

Date: 2026-03-06  
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

## Historical Doc Policy
- This file is authoritative for orchestrator Phases 5-7.
- `docs/final-plan/phase-3.md` is historical/superseded context only.
- `docs/architecture/AI_INTEGRATION.md` is architecture reference and must mirror active runtime contracts listed above.
