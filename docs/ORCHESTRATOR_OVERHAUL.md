# ADE Orchestrator Overhaul (Rebased)

Date: 2026-03-04  
Owner: Desktop orchestrator/runtime

## Scope Clarification
This is the canonical orchestrator execution roadmap and status doc.

This document supersedes stale orchestrator planning details in older roadmap docs.

## Phase Status

| Phase | Status | Notes |
|---|---|---|
| Phase 1 | Complete | MCP transport + runtime stability hardening |
| Phase 2 | Complete | Unified executor runtime cutover |
| Phase 3 | Complete | Phase engine + mission/runtime orchestration baseline |
| Phase 4 | Complete | Subagent delegation + team runtime consolidation |
| Phase 5 | Complete (2026-03-04) | Strict runtime validation enforcement, no bypass/sampling |
| Phase 6 | Ready | UI/observability polish on strict validation baseline |
| Phase 7 | Ready | Reflection protocol + retrospective synthesis |

## Strict Validation Baseline (Post-Phase 5)
Validation is now deterministic runtime contract enforcement.

1. Required validation is always enforced.
2. No sampled validation path exists in active behavior.
3. No completion-risk bypass flag exists in active behavior.
4. Phase transitions are hard-blocked when earlier required validation is missing.
5. Missing required validation emits explicit durable + live signals.

## Phase 5 Delivered (End-to-End)

### 1) Type and contract hard-cut
Implemented:
- Removed `"spot-check"` from active type surfaces.
- Removed `allowCompletionWithRisk` from mission settings/execution policy surfaces.
- Added runtime event type `validation_contract_unfulfilled`.

Primary files:
- `apps/desktop/src/shared/types/missions.ts`
- `apps/desktop/src/shared/types/orchestrator.ts`

### 2) UI dead-control removal
Implemented:
- Removed `Spot-check` validation option.
- Removed `ALLOW COMPLETION WITH RISK` toggle and payload wiring.

Primary files:
- `apps/desktop/src/renderer/components/missions/CreateMissionDialog.tsx`
- `apps/desktop/src/renderer/components/missions/MissionsPage.tsx`

### 3) Runtime autonomous validator spawning
Implemented:
- On succeeded step completion, runtime evaluates required validation obligations.
- For required + dedicated contract, runtime auto-spawns exactly one validator step per target step.
- Auto-validator carries linkage metadata:
  - `autoSpawnedValidation`
  - `targetStepId`
  - `targetStepKey`
  - phase metadata (`phaseKey`, `phaseName`, `phasePosition`)
- Dedupe guard prevents duplicate validator steps for the same target.

Primary file:
- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`

### 4) Phase transition hard-blocking
Implemented:
- `spawn_worker` keeps existing phase-order checks.
- Added required-validation preflight gate across earlier required phases.
- Rejection message:
  - `Phase "<name>" validation gate has not passed. <N> step(s) are missing required validation.`

Primary file:
- `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts`

### 5) Mid-run contract enforcement and visibility
Implemented:
- On step success without required validation pass:
  - Timeline event: `validation_contract_unfulfilled`
  - Runtime event: `validation_contract_unfulfilled`
  - Live run/step update reason emitted
- For required self-tier contracts:
  - Timeline event: `validation_self_check_reminder`
  - Coordinator-facing runtime `worker_message` reminder to call `report_validation`
- MCP runtime stream visibility:
  - Runtime category now includes validation contract signals for `stream_events`

Primary files:
- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`
- `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorQueries.ts`
- `apps/mcp-server/src/bootstrap.ts`

### 6) Execution policy simplification
Implemented:
- Removed completion-bypass branches from evaluation paths.
- Required missing phases and missing required validation remain blocking.
- Status model remains coherent (`active`, `paused`, `failed`, `succeeded`).

Primary files:
- `apps/desktop/src/main/services/orchestrator/executionPolicy.ts`
- `apps/desktop/src/main/services/orchestrator/missionLifecycle.ts`
- `apps/desktop/src/main/services/orchestrator/orchestratorContext.ts`

### 7) Coordinator prompt cleanup
Implemented:
- Replaced advisory tier text with strict runtime-contract guidance.
- Explicitly instructs coordinator not to attempt bypasses.

Primary file:
- `apps/desktop/src/main/services/orchestrator/coordinatorAgent.ts`

## Legacy/Dead Code Removed in Phase 5

Removed from active behavior:
- `spot-check` tier semantics and parsing in mission/orchestrator runtime flow.
- `allowCompletionWithRisk` mission setting, launch payload, and execution-policy branching.
- UI controls/state/plumbing for both removed semantics.
- Coordinator bypass behavior in completion paths.

Removed from tests/docs expectations:
- Legacy risk-bypass assertions.
- Legacy sampled-validation assertions.

## Runtime Event Contracts (Current)

### New durable runtime event
- `validation_contract_unfulfilled`
  - Persisted in runtime event bus
  - Reflected in mission state issue tracking
  - Streamable via MCP `stream_events` runtime category

### Self-tier reminder signal
- Timeline: `validation_self_check_reminder`
- Runtime message: `worker_message` (audience `coordinator`) with `report_validation` reminder

## Verification (Executed)

### Desktop tests
- `npm --prefix apps/desktop run test -- src/main/services/orchestrator/coordinatorTools.test.ts src/main/services/orchestrator/executionPolicy.test.ts src/main/services/orchestrator/aiOrchestratorService.test.ts` ✅
- `npm --prefix apps/desktop run test -- src/main/services/orchestrator/orchestratorService.test.ts` ✅

### MCP tests
- `npm --prefix apps/mcp-server run test -- src/mcpServer.test.ts` ✅

### Typecheck
- `npm --prefix apps/desktop run typecheck` ✅
- `npm --prefix apps/mcp-server run typecheck` ✅

### Added/updated test coverage for Phase 5
- Dedicated required step completion auto-spawns one validator.
- Duplicate auto-validator is not created for same target.
- Phase transition rejects when earlier required validation is missing.
- `validation_contract_unfulfilled` runtime event persists.
- Self-check reminder signal/message is emitted for coordinator.
- Legacy risk-bypass/sampled-validation test assumptions removed.

## Phase 6 (Ready): UI + Observability on Strict Validation

Status: Ready to execute.

### Phase 6.1 Validation signal UX
Build:
- Surface `validation_contract_unfulfilled` and `validation_self_check_reminder` clearly in mission activity/feed/chat contexts.
- Add explicit "validation gate blocked" rendering so users know why spawning/progression is denied.

Acceptance:
- A user can identify blocked validation obligations without opening raw runtime payloads.
- Validation-block reasons are visible in both timeline and chat-adjacent workflows.

### Phase 6.2 Team/runtime visibility consolidation
Build:
- Tighten Team Members + worker status surfaces to show validator lineage (`targetStepKey`, validator role/model).
- Ensure auto-spawned validator lifecycle is visually distinct from regular implementation workers.

Acceptance:
- Auto-spawned validators are discoverable and explainable in UI state.

### Phase 6.3 Role-model override UX (if still desired)
Build:
- Add per-role model override UI for team template roles.
- Persist override metadata and apply in coordinator/worker model resolution.

Acceptance:
- Role-level model overrides persist and are respected at spawn time.

### Phase 6 hard constraints
- Do not reintroduce sampled validation semantics.
- Do not add any risk-bypass completion path.
- Runtime remains source-of-truth; UI only surfaces/contracts state.

## Phase 7 (Ready): Reflection Protocol

Status: Ready to execute after/alongside Phase 6.

### 7.1 Reflection ingestion
Build:
- Add structured reflection ingestion (`reflection_add`) scoped to mission/run/step/role.
- Persist in DB + append-only `.ade/reflections/*.jsonl`.

### 7.2 Post-run retrospective synthesis
Build:
- Synthesize retrospective artifact on terminal runs from reflections + timeline + outcomes.
- Persist artifacts and emit runtime signal for refresh.

### 7.3 Cross-mission changelog
Build:
- Compare with previous retrospectives.
- Classify prior pain points (`resolved`, `still-open`, `worsened`).

### 7.4 Pattern promotion
Build:
- Promote stable reflection patterns into project memory candidates with dedupe.

Phase 7 hard constraints:
- Keep reflection additive; no degradation of strict Phase 5 validation contracts.

## Updated Dependencies

```text
Phase 1 ✅
Phase 2 ✅
Phase 3 ✅
Phase 4 ✅
   ↓
Phase 5 ✅ (strict validation baseline)
   ↓
Phase 6 (UI/observability on strict baseline)
   ↓
Phase 7 (reflection protocol + retrospectives)
```

## File Impact Summary (Next Work)

| File | Phase | Action |
|---|---|---|
| `apps/desktop/src/renderer/components/missions/MissionChatV2.tsx` | 6 | Render strict validation events/reminders clearly |
| `apps/desktop/src/renderer/components/missions/OrchestratorActivityFeed.tsx` | 6 | Explicit validation gate blocked/event visual language |
| `apps/desktop/src/renderer/components/missions/WorkTab.tsx` | 6 | Validator lineage + auto-spawned validator state |
| `apps/desktop/src/renderer/components/missions/CreateMissionDialog.tsx` | 6 | Optional per-role model override UI |
| `apps/mcp-server/src/mcpServer.ts` | 6 | Event stream/rendering support hardening for strict validation signals |
| `apps/desktop/src/main/services/memory/*` | 7 | Reflection storage, synthesis, promotion hooks |
| `apps/mcp-server/src/mcpServer.ts` | 7 | `reflection_add` tool + retrospective access surfaces |

## Documentation Reality Check
- This file is authoritative for orchestrator Phases 5-7.
- `docs/final-plan/phase-3.md` remains historical and non-authoritative.
- `docs/architecture/AI_INTEGRATION.md` is architecture reference; strict validation baseline is aligned to this document.
