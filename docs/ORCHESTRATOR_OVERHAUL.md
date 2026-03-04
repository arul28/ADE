# ADE Orchestrator Overhaul (Rebased)

Date: 2026-03-04  
Owner: Desktop orchestrator/runtime

## Scope Clarification
This document supersedes the stale Phase 2 notes in `docs/final-plan/` for orchestrator execution architecture.

The current target state is:
- One orchestrator AI worker executor kind: `unified`
- Three model classes supported together in a mission:
  - Claude CLI subprocess (CLI-wrapped model descriptors)
  - Codex CLI subprocess (CLI-wrapped model descriptors)
  - API/local in-process execution (non-CLI model descriptors)
- No active runtime registration or dispatch of legacy `claude`/`codex` orchestrator executor kinds

## Phase Status

### Phase 1
Complete previously (MCP transport + stability hardening).

### Phase 2 (Rebased)
Complete for runtime + tests.

Implemented outcomes:
1. Mission/orchestrator model flow is model-id-first (`modelId` canonical).
2. Legacy executor split removed:
   - `src/main/services/ai/claudeExecutor.ts` deleted
   - `src/main/services/ai/codexExecutor.ts` deleted
3. Legacy orchestrator adapters removed:
   - `src/main/services/orchestrator/claudeOrchestratorAdapter.ts` deleted
   - `src/main/services/orchestrator/codexOrchestratorAdapter.ts` deleted
4. Orchestrator runtime supports mixed model classes through unified routing:
   - CLI-wrapped descriptors -> subprocess path
   - API/local descriptors -> in-process unified AI path
5. Coordinator worker spawning/delegation is model-driven and unified-executor-aligned.
6. Planner/preflight paths now resolve executor behavior to unified runtime semantics.
7. Mission config defaults and executor normalizers no longer emit legacy executor kinds.
8. Regression tests updated for unified-only executor behavior in orchestrator paths.

### Phase 3 (Hard Cutover)
Complete for runtime, types, UI wiring, tests, and docs harmonization.

Implemented outcomes:
1. Orchestrator worker routing is `modelId`-only; legacy `metadata.model` reads are removed from runtime dispatch paths.
2. Unified AI-worker metadata contract is strict: missing/unknown `metadata.modelId` hard-fails at launch/dispatch.
3. Permission schema is class-based everywhere in orchestrator flow:
   - `permissionConfig.cli`
   - `permissionConfig.inProcess`
4. Legacy provider-bucket permission paths (`claude/codex/api`) are removed from orchestrator runtime contracts.
5. Mission preflight checks permission mode by model class:
   - CLI descriptors require `cli.mode=full-auto` for unattended runs
   - In-process descriptors require `inProcess.mode=full-auto`
6. Coordinator spawn/delegate paths inherit or require `modelId` explicitly and no longer apply silent model fallbacks.
7. AI integration defaults and orchestrator call paths are canonical-model-id driven.
8. Repo docs now describe unified executor/runtime behavior as authoritative.

## How Unified Works (Runtime Contract)
`unified` is now the single AI-worker executor kind in orchestrator runtime.

Execution flow:
1. A step carries `metadata.modelId` (or inherits from `metadata.phaseModel.modelId` / current phase runtime model).
2. Runtime resolves descriptor from registry (`resolveModelDescriptor`).
3. Runtime classifies model execution path by descriptor class:
   - CLI-wrapped descriptor -> subprocess adapter path (tracked terminal session)
   - Non-CLI descriptor (API/local) -> in-process `aiIntegrationService.executeViaUnified(...)`
4. Attempt completion envelope is normalized regardless of path.
5. Scheduler advances with the same DAG/state transitions independent of model class.

## Model-Class Support Matrix (Current)
| Surface | Claude CLI | Codex CLI | API/Key Models | Local Models |
|---|---|---|---|---|
| Worker execution (`executorKind=unified`) | ✅ subprocess | ✅ subprocess | ✅ in-process | ✅ in-process |
| Mixed models in same mission phases | ✅ | ✅ | ✅ | ✅ |
| Mission preflight availability checks | ✅ | ✅ | ✅ | ✅ |
| Unattended permission checks | ✅ (`cli.mode=full-auto`) | ✅ (`cli.mode=full-auto`) | ✅ (`inProcess.mode=full-auto`) | ✅ (`inProcess.mode=full-auto`) |

## Phase 3 Cleanup Status
Previously deferred cleanup work from the Phase 2 rebase is now closed:
1. Coordinator/session metadata paths are normalized to model-descriptor/model-id routing.
2. AI integration helper defaults are canonical-model-id based in orchestrator call paths.
3. Permission contracts use class-based schema (`cli` + `inProcess`) instead of provider buckets.
4. Docs that are historical are explicitly labeled non-authoritative; active architecture docs use unified contracts.

## Removed Legacy Runtime Behavior
- No runtime normalization from `claude`/`codex` -> executor dispatch.
- No adapter registration for `claude`/`codex` executor kinds.
- No legacy executor files in active AI integration flow.
- Runtime helpers parsing attempt/session executor kinds now recognize `unified|shell|manual` only.

## Verification
Executed on 2026-03-04:

- `npm --prefix apps/desktop run typecheck` ✅
- `npm --prefix apps/desktop test -- --run src/main/services/ai/aiIntegrationService.test.ts src/main/services/chat/agentChatService.test.ts src/main/services/orchestrator/orchestratorService.test.ts src/main/services/orchestrator/coordinatorTools.test.ts src/main/services/missions/missionPreflightService.test.ts src/main/services/orchestrator/aiOrchestratorService.test.ts src/main/services/missions/missionPlanningService.test.ts src/main/services/orchestrator/executionPolicy.test.ts` ✅

Passing total in this suite: 268 tests.

## Contract Guardrails (Post-Cutover)
- Keep worker executor-kind emission to `unified` for all AI workers.
- Keep `modelId` as required routing input for coordinator-driven worker creation/delegation.
- Preserve dual execution path behavior under unified runtime:
  - CLI-wrapped => subprocess adapter
  - API/local => in-process unified SDK
- Preserve fail-fast behavior for missing/unknown `modelId`.
- Do not add compatibility shims that revive legacy executor kinds or provider-bucket permissions.

---

### Phase 4: Subagent Delegation & Agent Teams

**Status**: Complete (2026-03-04)

Implemented outcomes:
1. **Single authoritative team-member data path**: team-member persistence/read normalization now flows through `teamRuntimeState.ts`; IPC `orchestratorGetTeamMembers` now reads from `aiOrchestratorService.getTeamMembers(...)`.
2. **Push-based child completion rollups**: terminal sub-agent attempts automatically push summary messages into the parent worker thread (`Sub-agent '<name>' completed (<status>): <summary>`), with run/attempt dedupe to prevent double delivery.
3. **Push-based child progress rollups + event-stream visibility**: successful `report_status` calls now emit normalized `worker_status_reported` runtime events and forward `[sub-agent:<name>]` progress messages to parent workers.
4. **Atomic batch delegation**: new coordinator tool `delegate_parallel` creates N validated child workers under one parent in a single call path, applies parent linkage metadata, enforces runtime guardrails, and starts autopilot once after batch creation.
5. **Claude-native teammate guardrails**:
   - Claude worker startup now mirrors ADE MCP config into worker CWD so native teammates can inherit MCP access.
   - MCP `report_status`/`report_result` paths auto-register unknown native callers as `source: "claude-native"` teammates when parent context is resolvable.
   - Native teammate registration enforces parent allocation caps (derived from run parallelism cap, fallback `4`).
6. **Tooling/prompt surface updates**: `delegate_parallel` is exposed in MCP tool specs, coordinator tool set, default team tool allowlist, and coordinator system prompt guidance.
7. **Type contract hard-cut**: `OrchestratorTeamMember` now surfaces `source` (`ade-worker` | `ade-subagent` | `claude-native`) and optional `parentWorkerId`.

Dead code removed in Phase 4:
- Duplicate team-member CRUD path removed from `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`:
  - `insertTeamMember(...)`
  - `updateTeamMemberStatus(...)`
  - `getTeamMembers(...)`
- IPC/team-member reads no longer go through the removed orchestratorService path; `registerIpc.ts` now uses `aiOrchestratorService.getTeamMembers(...)` directly.
- Legacy “Phase 4 is additive/no dead code removal” plan text removed from this document.

Additional hard-cut correctness fix completed during Phase 4:
- Inter-agent `agent` role messages are now parsed from persisted chat rows (`chatMessageService.ts`), enabling parent `get_pending_messages` visibility for forwarded sub-agent rollups.

Phase 4 verification (executed 2026-03-04):
- `npm --prefix apps/desktop run typecheck` ✅
- `npm --prefix apps/mcp-server run typecheck` ✅
- `npm --prefix apps/desktop run test -- src/main/services/orchestrator/coordinatorTools.test.ts src/main/services/orchestrator/aiOrchestratorService.test.ts` ✅ (100 tests)
- `npm --prefix apps/mcp-server run test -- src/mcpServer.test.ts` ✅ (58 tests)

Phase 1-4 audit pass (executed 2026-03-04, post Phase 4 implementation):
- No additional runtime regressions found in Phase 1-3 contracts:
  - No legacy orchestrator executor kinds (`claude`/`codex`) in active dispatch paths.
  - No provider-bucket permission schema paths (`permissionConfig.claude|codex|api`) in orchestrator runtime flow.
- Gaps found and addressed:
  - Added coordinator-tool metadata rendering in `AgentChatMessageList.tsx` for orchestration tools (`spawn_worker`, `delegate_to_subagent`, `delegate_parallel`, `report_*`, recovery tools).
  - Added live Team Members roster to `WorkTab.tsx` (polling `getTeamMembers`) with status, model, role, `source`, and parent-child lineage display.
  - Team Members UI location decision applied: keep it in `Work` tab (no extra panel/tab added).
  - Long-mission roster hygiene decision applied: terminated members auto-collapse after timeout with explicit Show/Hide toggle.
  - Updated browser mock `getTeamMembers` to return realistic mixed-source data (`ade-worker`, `ade-subagent`, `claude-native`) for dev rendering parity.
  - Removed unused `missionId` field from `GetTeamMembersArgs` (dead IPC interface surface).
  - AI-first run bootstrap now persists explicit `autopilot.parallelismCap` at run creation (planner summary -> launch maxParallelWorkers -> fallback `4`), removing fallback-only startup ambiguity.

Owner decisions resolved (2026-03-04):
1. Team Members UI remains in `Work` tab (Option A).
2. Terminated members auto-collapse with a Show/Hide toggle (Option B).
3. Parent allocation fallback cap remains hardcoded at `4` for current phases.

---

### Phase 5: Validation Tier Enforcement

**Status**: Not started

**What exists today**:
- `resolveValidationTier()` (coordinatorTools.ts:389-404) returns `"none" | "self-check" | "spot-check" | "dedicated"`.
- `report_validation` MCP tool exists (mcpServer.ts:700) for validators to submit verdicts.
- Coordinator system prompt (coordinatorAgent.ts:674-678) describes validation tiers and instructs the AI to follow them.
- Phase ordering gates (`mustFollow`, `mustBeFirst`, `mustBeLast`) are **hard constraints** — `spawn_worker` rejects violations.
- `evaluateRunCompletionFromPhases()` (executionPolicy.ts) checks validation contracts at run completion, but blocking is conditional on `allowCompletionWithRisk`.
- Validator role exists in `DEFAULT_TEAM_TEMPLATE` with `capabilities: ["validator", "review", "testing"]` and `maxInstances: 4`.
- Phase 4 delegation/runtime substrate is complete:
  - `delegate_parallel` is available and enforced by team-runtime guardrails.
  - Parent workers receive automatic child progress + completion rollups via pending messages.
  - MCP runtime streams normalized `worker_status_reported` events.
  - Claude-native teammates are auto-registered/audited and capped per parent allocation.

**What's broken or missing**:

#### 5.1 Auto-spawn dedicated validators

**Issue**: When a phase has `validationTier: "dedicated"`, the coordinator is told via system prompt to "always spawn a validator worker after each implementation step completes." But this is purely advisory — nothing enforces it. The coordinator can skip validation entirely and move to the next phase (as long as phase ordering constraints aren't violated).

**Why it matters**: Validation tiers were designed to provide quality guarantees. A `"dedicated"` tier means the mission creator explicitly wants every piece of work reviewed before proceeding. If the coordinator ignores this, the quality guarantee is hollow.

**Fix**: When a step in a `dedicated`-tier phase completes successfully, the orchestrator runtime (not the coordinator AI) should auto-queue a validator step. The validator step:
- Uses the `"validator"` role from the team template
- Has `dependsOn: [completedStepKey]` so it runs after the implementation step
- Gets the completed step's output injected into its prompt
- Must call `report_validation` with a pass/fail verdict
- Blocks the phase's completion until the validation verdict is received

For `"spot-check"`, the runtime randomly selects a subset of completed steps (e.g., 30-50%) for validation instead of all.

**Source files**:
- `src/main/services/orchestrator/coordinatorTools.ts` — `resolveValidationTier` at 389, `spawnWorkerStep` at 608, phase resolution at ~736
- `src/main/services/orchestrator/coordinatorAgent.ts` — system prompt validation tier section at ~674
- `src/main/services/orchestrator/teamRuntimeConfig.ts` — validator role in `DEFAULT_TEAM_TEMPLATE`
- `src/main/services/orchestrator/orchestratorService.ts` — step completion handling, where auto-spawn logic would hook in

#### 5.2 Make validation gates block phase transitions

**Issue**: `evaluateRunCompletionFromPhases()` in executionPolicy.ts checks validation contracts, but blocking depends on `allowCompletionWithRisk`. If `allowCompletionWithRisk` is true (which it can be by default), a phase with `validationGate.required === true` can complete without validation — the missing validation is logged as a risk factor but doesn't block.

**Why it matters**: `allowCompletionWithRisk` was a pragmatic escape hatch, but it undermines the purpose of required validation gates. If a mission creator marks a validation gate as required, it should be actually required — not "required unless we feel like risking it."

**Fix**: Split the concern:
- **Run completion**: `allowCompletionWithRisk` can still allow the run to finish with unresolved risk factors (for pragmatic reasons).
- **Phase transition**: Make validation gates hard at the phase boundary regardless of `allowCompletionWithRisk`. If Phase 2 has `validationGate.required === true` and no passing `report_validation` exists for that phase's steps, `spawn_worker` rejects any Phase 3 step with: `"Phase 2 validation gate has not passed. {N} steps are missing required validation."` This adds a new check alongside the existing `validatePhaseOrdering()` constraints.

**Source files**:
- `src/main/services/orchestrator/executionPolicy.ts` — `evaluateRunCompletionFromPhases` at ~218, `allowCompletionWithRisk` logic at ~233, phase diagnostics
- `src/main/services/orchestrator/coordinatorTools.ts` — `validatePhaseOrdering` at ~851, `spawn_worker` tool handler at ~954
- `src/shared/types/orchestrator.ts` — `PhaseCard`, `ValidationTierBehavior`, validation contract types

#### 5.3 Validation contract enforcement during execution

**Issue**: Steps can have `metadata.validationContract.required === true` but the contract is only checked at run completion by `evaluateRunCompletion()`. During active execution, a step can succeed without its required validation contract being fulfilled — the orchestrator only discovers this at the very end.

**Why it matters**: Late discovery of unfulfilled validation contracts means the coordinator wasted time on downstream work that depends on unvalidated results. Early enforcement lets the coordinator course-correct immediately.

**Fix**: After each step reaches terminal status, check its validation contract. If `required === true` and no `report_validation` exists for that step:
- Emit a `validation_contract_unfulfilled` event to the event buffer (visible via `stream_events`).
- If the step's phase has `validationTier: "dedicated"`, the auto-spawned validator (from 5.1) handles this automatically.
- If the tier is `"self-check"`, push a message to the coordinator's pending messages: `"Step '{key}' has a required validation contract. Please validate and call report_validation."`.

**Source files**:
- `src/main/services/orchestrator/executionPolicy.ts` — validation contract checking at 254-288
- `src/main/services/orchestrator/coordinatorTools.ts` — `report_validation` handler, step metadata validation contract fields
- `src/main/services/orchestrator/orchestratorService.ts` — step completion event handling

**Dead code to remove in Phase 5**:

| What | Where | Why Remove |
|------|-------|-----------|
| Advisory-only validation tier text in coordinator system prompt | `coordinatorAgent.ts:674-678` | Replace with a shorter note: "Validation tiers are enforced by the runtime. Dedicated validators are auto-spawned. Do not skip validation gates." The detailed per-tier instructions become unnecessary once the runtime enforces them. |
| `allowCompletionWithRisk` for phase transitions | `executionPolicy.ts:233` | The flag remains for run-level completion but should no longer affect phase-to-phase gate blocking (see 5.2). Refactor to separate run-completion risk tolerance from phase-gate enforcement. |

**External references**:
- `src/shared/types/orchestrator.ts` — `ValidationTierBehavior`, `PhaseCard.validationGate`, `OrchestratorStep.metadata.validationContract`

---

### Phase 6: UI & Observability

**Status**: In progress (bootstrap wiring landed during Phase 1-4 audit)

**What exists today**:
- `OrchestratorActivityFeed.tsx` — 50+ event types, real-time timeline streaming, category/severity filtering. ✅
- `WorkerTranscriptPane.tsx` — live transcript tail for running workers, polls every 2s. ✅
- `AgentPresencePanel.tsx` — left sidebar showing all steps with status, elapsed time, color-coded indicators. ✅
- `MissionChatV2.tsx` — tracks `OrchestratorWorkerState` array with status dots (spawned/working/completed/failed). ✅
- `StepDetailPanel.tsx` — worker allocation status, stale heartbeat detection (3-min threshold). ✅
- Per-phase model selection in `CreateMissionDialog.tsx` via `ModelProfileSelector` and `PhaseProfileCard`. ✅
- `OrchestratorDAG.tsx` — visual graph of steps and dependencies. ✅
- IPC plumbing for `getTeamMembers` exists (ipc.ts:307, preload.ts:511, registerIpc.ts:1850). ✅
- `AgentChatMessageList.tsx` now has coordinator TOOL_META coverage for core orchestration tools (`spawn_worker`, `delegate_*`, `report_*`, recovery actions). ✅
- `WorkTab.tsx` now surfaces a live Team Members roster (role/model/status/source + parent-child lineage), including `claude-native` teammates. ✅
- `browserMock.ts` now returns realistic team member mock data for renderer-only browser sessions. ✅

**What's broken or missing**:

#### 6.1 Coordinator tool metadata in chat (Completed)

Implemented in audit pass:
- Added explicit TOOL_META entries for coordinator orchestration/planning/recovery/communication tools.
- Coordinator operations now render with contextual labels and cleaner targets instead of generic wrench output.

#### 6.2 Team member roster visibility (Completed)

Implemented in audit pass:
- Added Team Members roster rendering in `WorkTab.tsx`, polling `getTeamMembers` on a 5s cadence.
- Roster includes status, role, model, source badge (`ade-worker` / `ade-subagent` / `claude-native`), claimed task count, and parent-child indentation.
- Browser mock now returns mixed-source team members so this UI path is testable in non-Electron renderer sessions.

#### 6.3 Worker coordination event visibility (Remaining)

**Issue**: `AgentChatMessageList` shows tool calls in the coordinator's chat thread but doesn't surface team coordination events: when a worker spawns, when a subagent is delegated, when a worker sends a message to another worker, when a native Claude teammate joins. The `OrchestratorActivityFeed` shows events but in a timeline format separate from the chat — users have to context-switch between the chat and the timeline to understand what's happening.

**Why it matters**: The chat is the natural place to show coordination activity. Users read the coordinator's reasoning and want to see its actions (spawning, delegating, messaging) inline, not in a separate panel.

**Fix**: Add system-message-style entries to the coordinator chat thread for key coordination events:
- `step_status_changed` with status `running` → "Worker 'implement-auth' started (claude-sonnet-4-6)"
- `step_status_changed` with status `succeeded` → "Worker 'implement-auth' completed: {summary}"
- `step_status_changed` with status `failed` → "Worker 'implement-auth' failed: {error}"
- `worker_status_reported` → "Worker 'implement-auth': {status message}"
These are already in the event buffer — just render them inline in the chat feed when the coordinator thread is active.

**Source files**:
- `src/renderer/components/missions/MissionChatV2.tsx` — coordinator chat thread, worker state tracking
- `src/renderer/components/missions/OrchestratorActivityFeed.tsx` — EVENT_CONFIG with event types and rendering
- `apps/mcp-server/src/mcpServer.ts` — `stream_events` tool, event buffer ring

#### 6.4 Per-role model selection in mission settings

**Issue**: `CreateMissionDialog.tsx` has per-phase model selection via `ModelProfileSelector` (standard, fast-cheap, max-quality, codex-only, claude-only profiles). But there's no per-role model customization. The team template defines roles (coordinator, implementer, validator, specialist) each with a `defaultModel`, but users can't override these. A user who wants validators on Haiku and implementers on Opus has no way to configure this.

**Why it matters**: Different roles have different cost/quality tradeoffs. Validators don't need expensive models — they're checking work, not creating it. Implementers benefit from the best available model. Per-role model selection lets users optimize cost without sacrificing quality where it matters.

**Fix**: Add a "Team Configuration" expandable section to `CreateMissionDialog.tsx` that shows the roles from the active team template. Each role gets a model selector (using `UnifiedModelSelector` component) that overrides the template's `defaultModel`. Store overrides in the mission launch metadata under `teamRuntime.roleModelOverrides: Record<string, string>`. The coordinator's `spawn_worker` MCP handler reads these overrides when resolving the model for a role.

**Source files**:
- `src/renderer/components/missions/CreateMissionDialog.tsx` — team runtime config UI, `allowParallelAgents`/`allowSubAgents` toggles at 1439-1481
- `src/renderer/components/missions/ModelProfileSelector.tsx` — existing per-phase model selector pattern
- `src/renderer/components/shared/UnifiedModelSelector.tsx` — model selector dropdown component
- `src/main/services/orchestrator/teamRuntimeConfig.ts` — `DEFAULT_TEAM_TEMPLATE` role definitions, `parseRoleDefinition`
- `src/shared/types/missions.ts` — mission launch metadata structure

**Dead code to remove in Phase 6**:

- Completed during audit pass:
  - Removed empty `getTeamMembers` mock path in `browserMock.ts`; replaced with realistic `OrchestratorTeamMember` fixtures.

**External references**:
- https://ai-sdk.dev/docs/agents/subagents — UI rendering: tool part states (`input-streaming`, `input-available`, `output-available`, `output-error`), detecting streaming vs complete

---

## Updated Phase Dependencies

```
Phase 1 ✅ ─┐
Phase 2 ✅ ─┤
Phase 3 ✅ ─┤
            ├─→ Phase 4 ✅ (Subagent Delegation & Teams)
            │       ↓
            ├─→ Phase 5 (Validation Enforcement)      ← active critical path
            │       ↓
            └─→ Phase 6 (UI & Observability)           ← can run in parallel once Phase 5 contracts stabilize
```

Phase 4 is fully delivered and no longer a planning dependency.
Phase 5 is the next mandatory implementation track; Phase 6 can proceed in parallel with late Phase 5 work once validation event contracts are stable.

## Updated File Impact Summary (Remaining Phase 5-6 Work)

| File | Phases | Action |
|------|--------|--------|
| `apps/mcp-server/src/mcpServer.ts` | 5 | Auto-spawn validator orchestration hooks, phase-gate/validation event emission |
| `coordinatorTools.ts` | 5 | Validation gate blocking in `spawn_worker`, `report_validation` execution-path enforcement |
| `coordinatorAgent.ts` | 5 | Simplify validation tier system prompt (runtime enforces now) |
| `executionPolicy.ts` | 5 | Separate `allowCompletionWithRisk` from phase-gate blocking, validation contract mid-run checks |
| `orchestratorService.ts` | 5 | Step completion hook for auto-spawning validators, validation contract checks |
| `teamRuntimeConfig.ts` | 6 | Role model override wiring and runtime defaults |
| `MissionChatV2.tsx` | 6 | Inline coordination events in chat thread |
| `CreateMissionDialog.tsx` | 6 | Per-role model selection UI |
| `orchestrator.ts` (types) | 5, 6 | Validation contract/gate surface + `roleModelOverrides` typing |

---

### Phase 7: Reflection Protocol

**Status**: Not started

**What exists today**:
- `memoryService.ts` — Full SQL-backed memory system with scopes (user/project/lane/mission), categories (fact/preference/pattern/decision/gotcha), importance levels, candidate→promoted→archived lifecycle, deduplication, and confidence scoring.
- `memory_add` MCP tool (mcpServer.ts:202-226) — Agents already write observations during execution. Rate-limited (10 calls/60s). Auto-creates shared facts when `runId` is present.
- `orchestrator_shared_facts` table — Per-run fact storage with step-level granularity and fact types (api_pattern/schema_change/config/architectural/gotcha).
- `compactionEngine.ts` — Proven pattern for post-execution processing: conversation summarization + fact extraction + `preCompactionWriteback()` to shared facts table. This is the template for reflection synthesis.
- Post-mission hook point at `orchestratorService.ts:5395-5402` — Detects terminal run status (`succeeded`/`succeeded_with_risk`/`failed`/`canceled`), runs cleanup. This is where reflection synthesis hooks in.
- `appendRunNarrative()` (orchestratorService.ts:393) — Stores structured `{ stepKey, summary, at }` entries in mission metadata. Precedent for structured per-step summaries.
- Mission artifact system — `MissionArtifactRow` table for persisting arbitrary artifacts per mission.

**What's missing**: No reflection log, no retrospective synthesis, no changelog tracking, no reflection MCP tool, no UI for viewing reflections.

#### 7.1 Add reflection_add MCP tool and storage

**Issue**: Agents have `memory_add` for general project memories, but no structured way to record mission-specific observations about workflow friction, capability gaps, or improvement ideas. These observations are different from factual memories — they're meta-observations about the system itself that should feed into self-improvement.

**Why it matters**: Without structured reflection, the same mistakes repeat across missions. If an agent consistently hits the same limitation ("test suite takes 3 minutes, slowing iteration"), that signal is lost when the mission ends. Reflection captures these signals for systematic improvement.

**Fix**:
1. Add `reflection_entries` table: `id`, `mission_id`, `run_id`, `step_id`, `agent_role` (coordinator/implementer/validator), `phase`, `type` (wish/frustration/idea/pattern/limitation), `description`, `context`, `created_at`.
2. Add `reflection_add` MCP tool with schema: `{ type: "wish"|"frustration"|"idea"|"pattern"|"limitation", description: string, context?: string }`. The MCP server resolves `mission_id`, `run_id`, `step_id`, and `agent_role` from the session identity env vars (already available via `ADE_MISSION_ID`, `ADE_RUN_ID`, `ADE_STEP_ID`).
3. Also write to `.ade/reflections/<mission-id>.jsonl` as append-only file for portability.
4. Add reflection guidance to the coordinator system prompt and worker prompts: "When you encounter friction, capability gaps, or discover useful patterns, call `reflection_add` with the observation. Don't stop to reflect — note it alongside normal work."

**Implementation approach**: Follow the `memory_add` MCP tool pattern exactly — input validation, session identity resolution, database write, rate limiting (10 calls/60s). The reflection service is a thin layer over the existing memory infrastructure.

**Source files**:
- `apps/mcp-server/src/mcpServer.ts` — Add `reflection_add` tool alongside existing `memory_add` (line ~1100)
- `src/main/services/memory/memoryService.ts` — Add `addReflectionEntry()` and `getReflectionLog()` methods, or create a dedicated `reflectionService.ts` in the same directory
- `src/main/services/orchestrator/coordinatorAgent.ts` — Add reflection guidance to system prompt
- `src/main/services/orchestrator/baseOrchestratorAdapter.ts` — Add reflection guidance to `buildFullPrompt()` for worker prompts

#### 7.2 Post-mission retrospective synthesis

**Issue**: After a mission completes, all the raw data exists (reflection entries, shared facts, run narrative, step outcomes, timeline events) but nobody synthesizes it. The observations from 7.1 accumulate without analysis. There's no "what went well, what didn't, what to improve" summary.

**Why it matters**: Retrospectives turn raw observations into actionable insights. They identify recurring pain points, suggest concrete improvements, and track whether previous issues have been resolved. Without synthesis, reflections are just noise.

**Fix**: Create `reflectionSynthesisEngine.ts` following the `compactionEngine.ts` pattern:
1. `synthesizeRetrospective(missionId, runId)` function that:
   - Reads all reflection entries for the mission
   - Reads shared facts from the run
   - Reads run narrative summaries
   - Reads step outcomes (succeeded/failed/retried counts)
   - Calls an AI model (Claude Haiku — cheap, fast) with a synthesis prompt
   - Returns a `MissionRetrospective` object
2. Hook into mission completion at `orchestratorService.ts:5395` — after `cleanupCoordinatorCheckpointFile`, call `synthesizeRetrospective()`.
3. Persist retrospective to `.ade/reflections/retrospectives/<missionId>.json` and as a mission artifact.
4. Emit a `retrospective_synthesized` runtime event so the UI can refresh.

**Retrospective structure**:
```typescript
interface MissionRetrospective {
  missionId: string;
  runId: string;
  generatedAt: string;
  topPainPoints: string[];          // Ranked by frequency/impact
  topImprovements: string[];        // Actionable suggestions
  patternsToCapture: string[];      // Candidates for project memory promotion
  estimatedImpact: string;          // "If addressed, X would improve by Y"
  changelog: ChangelogEntry[];      // What changed since last retrospective
  stats: { reflectionCount: number; stepCount: number; failedSteps: number; retriedSteps: number; };
}
```

**Source files**:
- New file: `src/main/services/memory/reflectionSynthesisEngine.ts` — follow `compactionEngine.ts` pattern
- `src/main/services/orchestrator/orchestratorService.ts` — Post-completion hook at ~5395
- `src/main/services/ai/compactionEngine.ts` — Reference pattern: AI summarization + fact extraction + JSON parsing with graceful fallback

#### 7.3 Changelog tracking across missions

**Issue**: Each retrospective is standalone. There's no tracking of whether a previous pain point has been resolved, is still open, or has worsened. The system can't show improvement trajectory.

**Why it matters**: The changelog is the feedback loop. Without it, the same improvements get suggested repeatedly with no record of progress. With it, users can see "3 missions ago we identified slow tests as a pain point → 2 missions ago we added test caching → this mission: tests are fast, issue resolved."

**Fix**:
1. `synthesizeRetrospective()` reads the most recent previous retrospective for the same project.
2. The synthesis prompt includes previous pain points and asks the AI to classify each as: `resolved`, `still-open`, or `worsened`.
3. Each `ChangelogEntry` records: `previousPainPoint`, `status`, `fixApplied?`, `currentState`.
4. Changelogs accumulate — each retrospective's changelog references the previous one.

**Source files**:
- `src/main/services/memory/reflectionSynthesisEngine.ts` — Add changelog comparison logic
- `.ade/reflections/retrospectives/` — Directory of retrospective JSONs, read by changelog comparison

#### 7.4 Promote reflection patterns to project memory

**Issue**: Agents discover codebase-specific patterns during missions ("this codebase uses barrel exports — always check index.ts") that get stored as reflections with `type: "pattern"`. These are valuable for future missions but are currently siloed in the reflection log.

**Why it matters**: Patterns discovered via reflection should become persistent project knowledge. The memory system already has a promotion flow (candidate → promoted → archived) with deduplication. Reflection patterns are the input; promoted memories are the output.

**Fix**: During retrospective synthesis, patterns flagged as `patternsToCapture` are auto-written to the memory system via `memoryService.addMemory()` with:
- `scope: "project"`
- `category: "pattern"`
- `importance: "medium"` (promoted to "high" if seen across multiple missions)
- `status: "candidate"` (auto-promoted if confidence threshold met)
- `source_run_id` linking back to the originating mission

The memory system's existing deduplication prevents duplicates across missions. Confidence scoring lets frequently-rediscovered patterns auto-promote.

**Source files**:
- `src/main/services/memory/reflectionSynthesisEngine.ts` — Pattern promotion step after synthesis
- `src/main/services/memory/memoryService.ts` — `addMemory()` with dedup and promotion logic (already exists)

**Dead code to remove in Phase 7**: None — Phase 7 is entirely additive.

**External references**:
- `src/main/services/ai/compactionEngine.ts` — Proven pattern for AI synthesis + fact extraction + pre-compaction writeback. Follow the same prompt engineering approach.
- `docs/final-plan/phase-3.md` lines 1017-1084 — Original Task 7 specification (reflection log types, retrospective structure, changelog entries, learning pack integration). Design intent is sound; implementation approach updated here to build on existing infrastructure.

---

## Integration Testing

Integration testing is a delivery gate on every phase, not a standalone phase. Each phase ships with its own test coverage:

| Phase | Test Coverage Required |
|-------|----------------------|
| Phase 4 | Subagent result rollup (verify parent receives child output), parallel delegation (verify N children run concurrently), Claude native team detection (verify auto-registration), budget enforcement during delegation |
| Phase 5 | Auto-spawned validators (verify spawn on dedicated tier), phase gate blocking (verify spawn rejection when gate not passed), validation contract mid-run checks (verify event emission), `allowCompletionWithRisk` separation from phase gates |
| Phase 6 | TOOL_META rendering (verify icons/labels for each orchestrator tool), TeamMembersPanel data flow (verify IPC → component), model selector integration (verify role overrides persist) |
| Phase 7 | Reflection entry write/read, retrospective synthesis (mock AI, verify structure), changelog comparison (verify status classification), pattern promotion to memory (verify dedup) |

Test infrastructure already exists:
- `coordinatorTools.test.ts` — 268 tests covering orchestrator tool behavior
- `executionPolicy.test.ts` — Phase completion and validation contract tests
- `mcpServer.test.ts` — MCP tool contract tests
- `aiOrchestratorService.test.ts` — Orchestrator service integration tests

---

## Updated Phase Dependencies (Complete)

```
Phase 1 ✅ ─┐
Phase 2 ✅ ─┤
Phase 3 ✅ ─┤
            ├─→ Phase 4 ✅ (Subagent Delegation & Teams)
            │       ↓
            ├─→ Phase 5 (Validation Enforcement)      ← next mandatory gate
            │       ↓
            ├─→ Phase 6 (UI & Observability)           ← parallelizable with late Phase 5 work
            │       ↓
            └─→ Phase 7 (Reflection Protocol)          ← starts after Phase 5 contract enforcement lands
```

## Updated File Impact Summary (All Remaining Phases)

| File | Phases | Action |
|------|--------|--------|
| `apps/mcp-server/src/mcpServer.ts` | 5, 7 | Auto-spawn validator/event contracts, gate enforcement wiring, `reflection_add` tool |
| `coordinatorTools.ts` | 5 | Validation gate blocking in `spawn_worker`, `report_validation` orchestration |
| `coordinatorAgent.ts` | 5, 7 | Simplify validation tier prompt, add reflection guidance |
| `executionPolicy.ts` | 5 | Separate `allowCompletionWithRisk` from phase-gate blocking, validation contract mid-run checks |
| `orchestratorService.ts` | 5, 7 | Step completion hook for auto-spawning validators, post-mission reflection synthesis hook |
| `baseOrchestratorAdapter.ts` | 7 | Add reflection guidance to worker prompts |
| `teamRuntimeConfig.ts` | 6 | Role model override defaults and parsing |
| `memoryService.ts` | 7 | Add reflection entry storage, or create `reflectionService.ts` |
| New: `reflectionSynthesisEngine.ts` | 7 | Post-mission retrospective synthesis, changelog tracking, pattern promotion |
| `MissionChatV2.tsx` | 6 | Inline coordination events in chat thread |
| `CreateMissionDialog.tsx` | 6 | Per-role model selection UI |
| `orchestrator.ts` (types) | 5, 6, 7 | Validation contract surfaces, `roleModelOverrides`, `ReflectionEntry`, `MissionRetrospective` types |

## Documentation Reality Check
- This file is the canonical source for all remaining Phase 3 work (orchestrator runtime, subagents, validation, UI, reflection).
- `docs/final-plan/phase-3.md` is superseded by this document — see disclaimer in that file.
- Other roadmap documents (`final-plan/README.md`, `architecture/AI_INTEGRATION.md`) have been trimmed to point here for orchestrator details.
- Historical planning context is preserved in original docs but marked non-authoritative for runtime contracts.
