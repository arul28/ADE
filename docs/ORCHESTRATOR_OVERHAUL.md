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

**Status**: Not started

**What exists today**:
- `delegate_to_subagent` MCP tool exists (mcpServer.ts:691, coordinatorTools.ts:4029-4206) with parent-child linkage, model cascade resolution (explicit → role → parent → phase), lane inheritance, and budget enforcement.
- `spawn_worker` supports `dependsOn` arrays for DAG dependencies.
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var is injected for Claude CLI workers (unifiedOrchestratorAdapter.ts:262-268).
- `allowSubAgents`, `allowClaudeAgentTeams`, `allowParallelAgents` config flags exist in teamRuntimeConfig.ts and are surfaced in CreateMissionDialog.tsx.

**What's broken or missing**:

#### 4.1 Push-based result rollup for subagents

**Issue**: When a child subagent completes, the parent worker must manually call `get_worker_output` to retrieve the child's result (pull model). There is no automatic injection of the child's output into the parent's context. This means the parent can miss results, forget to check, or waste turns polling.

**Why it matters**: The Vercel AI SDK subagent pattern uses `toModelOutput` to automatically return subagent results into the parent's context. Every competing orchestrator (Cursor, Windsurf, Devin) auto-rolls up subagent results. The pull model forces the coordinator to micromanage result retrieval instead of focusing on high-level planning.

**Fix**: When a child step reaches terminal status (`succeeded`/`failed`), the orchestrator runtime should automatically push the result summary into the parent worker's pending messages (via the `get_pending_messages` MCP tool's message queue). The parent receives a system message like `"Sub-agent '{name}' completed: {summary}"` on its next turn without needing to call `get_worker_output`. The full output remains available via `get_worker_output` for detailed inspection.

**Source files**:
- `src/main/services/orchestrator/coordinatorTools.ts` — `delegate_to_subagent` at 4029, `get_worker_output` at 1739, `report_result` at 1919
- `src/main/services/orchestrator/workerDeliveryService.ts` — worker output delivery, result envelope handling
- `apps/mcp-server/src/mcpServer.ts` — `get_pending_messages` tool (line ~710+), message queue mechanism

#### 4.2 Streaming progress from child to parent

**Issue**: A parent worker delegates a subtask and then receives zero feedback until the child terminates. For long-running children (20+ minutes), the parent has no idea whether the child is progressing, stuck, or failing. The only signal is terminal completion.

**Why it matters**: The AI SDK subagent pattern uses `async function*` generators that yield streaming progress. Even without generators, intermediate status should flow from child to parent so the parent (or coordinator) can intervene early if a child is off-track.

**Fix**: When a child worker calls `report_status` via MCP, the status message should also be forwarded to the parent worker's pending messages with a `[sub-agent:{name}]` prefix. This gives the parent periodic heartbeat-like updates. The coordinator also receives these via the existing `stream_events` event buffer (event type `worker_status_reported`), maintaining its overview.

**Source files**:
- `apps/mcp-server/src/mcpServer.ts` — `report_status` tool handler, `get_pending_messages` handler
- `src/main/services/orchestrator/coordinatorTools.ts` — `report_status` at ~1850, status event emission

#### 4.3 Batch parallel delegation

**Issue**: To delegate 3 subtasks in parallel, the coordinator must make 3 sequential `delegate_to_subagent` calls. Each call creates a step, triggers autopilot, and returns. The coordinator cannot atomically express "run these 3 things in parallel and tell me when all finish."

**Why it matters**: The AI SDK uses `Promise.all` for parallel subagent execution. Sequential delegation is slower (3 round-trips) and doesn't let the coordinator express intent clearly. It also makes it harder to implement "wait for all N children" logic.

**Fix**: Add a `delegate_parallel` MCP tool that accepts an array of subtask specs (each with `name`, `prompt`, `modelId`, `role`). The handler calls `spawnWorkerStep` for each, links all children to the same parent, and returns all step keys in one response. The coordinator can then use `read_mission_status` to check if all children have completed. Optionally add a `dependsOnAll` field so downstream steps can depend on the entire batch completing.

**Source files**:
- `apps/mcp-server/src/mcpServer.ts` — tool registration for new `delegate_parallel` tool
- `src/main/services/orchestrator/coordinatorTools.ts` — `spawnWorkerStep` at 608 (reuse for batch), `delegate_to_subagent` at 4029 (pattern to follow)

#### 4.4 Claude native team coordination with ADE guardrails

**Issue**: When `allowClaudeAgentTeams=true` and a Claude CLI worker uses native `TeamCreate`/`Task`/`SendMessage` tools, those native teammates are invisible to ADE's orchestrator. They don't appear in `getTeamMembers`, they don't respect budget caps, they don't report via MCP, and they have no ADE MCP server injected. The Claude native team runs completely outside ADE's control.

**Why it matters**: From the Kargar article — Claude's native teams support powerful peer-to-peer messaging and parallel task execution that ADE shouldn't re-implement. But without guardrails, a single Claude worker could spawn unbounded native teammates that burn through the budget. ADE needs to observe and constrain native teams, not ignore them.

**Fix**: Two-part solution:
1. **MCP injection for native teammates**: When a Claude CLI worker spawns with `allowClaudeAgentTeams=true`, the MCP config file (written by `writeMcpConfigFile`) should be placed in the worker's CWD so native teammates auto-inherit it. This gives native teammates access to `report_status` and `report_result` for progress tracking. The ADE MCP server can then observe native teammate activity through its standard audit trail.
2. **Budget-aware teammate detection**: The ADE MCP server's `report_status` handler should detect when a call comes from an unknown `callerId` (a native teammate not registered via `spawn_worker`). When detected, auto-register a team member record with `source: "claude-native"` so the orchestrator knows about it. Apply budget checks against the parent worker's allocation.

**Source files**:
- `src/main/services/orchestrator/unifiedOrchestratorAdapter.ts` — `writeMcpConfigFile` at 36, Claude CLI startup command at 232-271, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var at 262-268
- `apps/mcp-server/src/mcpServer.ts` — session identity resolution, `report_status` handler, `report_result` handler
- `src/main/services/orchestrator/teamRuntimeConfig.ts` — `DEFAULT_TEAM_TEMPLATE`, `normalizeAgentRuntimeFlags`
- `src/main/services/orchestrator/coordinatorTools.ts` — `trackTeamMember` at ~449, budget enforcement logic

**Dead code to remove in Phase 4**: None — Phase 4 is additive (new capabilities on top of existing infrastructure).

**External references**:
- https://ai-sdk.dev/docs/agents/subagents — `toModelOutput`, `Promise.all` for parallel, abort signal propagation
- https://code.claude.com/docs/en/agent-teams — Native team tools, teammate lifecycle, shutdown dance
- Medium article (Kargar, 2025) — Agent team lifecycle: TeamCreate → Task → SendMessage → TeamDelete; lead polls via sleep+ls; peer-to-peer messaging is lateral

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

**Status**: Not started

**What exists today**:
- `OrchestratorActivityFeed.tsx` — 50+ event types, real-time timeline streaming, category/severity filtering. ✅
- `WorkerTranscriptPane.tsx` — live transcript tail for running workers, polls every 2s. ✅
- `AgentPresencePanel.tsx` — left sidebar showing all steps with status, elapsed time, color-coded indicators. ✅
- `MissionChatV2.tsx` — tracks `OrchestratorWorkerState` array with status dots (spawned/working/completed/failed). ✅
- `StepDetailPanel.tsx` — worker allocation status, stale heartbeat detection (3-min threshold). ✅
- Per-phase model selection in `CreateMissionDialog.tsx` via `ModelProfileSelector` and `PhaseProfileCard`. ✅
- `OrchestratorDAG.tsx` — visual graph of steps and dependencies. ✅
- IPC plumbing for `getTeamMembers` exists (ipc.ts:307, preload.ts:511, registerIpc.ts:1850). ✅

**What's broken or missing**:

#### 6.1 Add TOOL_META entries for orchestrator MCP tools

**Issue**: `TOOL_META` in `AgentChatMessageList.tsx` has entries for Claude Code tools (Read, Write, Bash, etc.) and Codex tools (exec_command, apply_patch) but no entries for orchestrator coordination tools. When the coordinator calls `spawn_worker`, `delegate_to_subagent`, `read_mission_status`, `revise_plan`, `retry_step`, `skip_step`, `message_worker`, or `report_validation`, they show as generic wrench icons with raw tool names and unformatted JSON arguments.

**Why it matters**: The coordinator chat is the primary window into what the orchestrator is doing. Without proper tool metadata, users see opaque JSON blobs instead of "Spawning worker 'implement-auth' on claude-sonnet-4-6" or "Delegating subtask to validator."

**Fix**: Add entries to `TOOL_META` for all coordinator tools. Follow the existing pattern of `{ label, icon, color, category, getTarget }`. Suggested groupings:
- **Orchestration** (cyan): `spawn_worker`, `delegate_to_subagent`, `delegate_parallel`, `request_specialist`
- **Planning** (purple): `revise_plan`, `read_mission_status`, `get_worker_output`
- **Recovery** (amber): `retry_step`, `skip_step`, `mark_step_complete`
- **Communication** (green): `message_worker`, `report_status`, `report_result`, `report_validation`

**Source files**:
- `src/renderer/components/chat/AgentChatMessageList.tsx` — `TOOL_META` at line 51, `getToolMeta()` at 81, tool rendering at 633-695

#### 6.2 Team member roster panel

**Issue**: The IPC handler `getTeamMembers` exists, the preload bridge exists, the types exist, `registerTeamMember()` is called when workers spawn. But no renderer component ever calls `getTeamMembers` or displays the data. During a running mission, users have zero visibility into the team composition — who's active, what roles they have, what models they're running, or their lifecycle status.

**Why it matters**: The orchestrator's power is in multi-agent coordination. If users can't see the team, they can't understand whether the orchestrator is using resources wisely, whether workers are stuck, or whether the right models are assigned to the right tasks.

**Fix**: Add a `TeamMembersPanel` component to the mission detail view. Poll `getTeamMembers` via the existing IPC bridge on a 3-5s interval. Display each member with:
- Name and role badge (coordinator/implementer/validator/specialist)
- Model tag (e.g., "claude-sonnet-4-6", "gpt-5.3")
- Status indicator (color-coded: green=active, yellow=idle, red=failed, gray=terminated)
- Claimed task count and current step key
- Parent-child relationships: indent sub-agents under their parent worker
- For `source: "claude-native"` members (Phase 4.4), show a native team badge

**Source files**:
- `src/shared/ipc.ts` — `orchestratorGetTeamMembers` channel at 307
- `src/preload/preload.ts` — `getTeamMembers` bridge at 511-512
- `src/main/services/ipc/registerIpc.ts` — handler at 1850-1856
- `src/shared/types/orchestrator.ts` — `OrchestratorTeamMember` type definition
- `src/renderer/components/lanes/LaneTerminalsPanel.tsx` — pattern to follow for live status panel
- `src/renderer/state/appStore.ts` — Zustand store for polling/caching team member state
- `src/renderer/browserMock.ts` — update mock to return realistic team member data

#### 6.3 Worker coordination event visibility

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

| What | Where | Why Remove |
|------|-------|-----------|
| `getTeamMembers` mock returning empty array | `browserMock.ts` | Replace with realistic mock data matching `OrchestratorTeamMember` shape for dev/test rendering |

**External references**:
- https://ai-sdk.dev/docs/agents/subagents — UI rendering: tool part states (`input-streaming`, `input-available`, `output-available`, `output-error`), detecting streaming vs complete

---

## Updated Phase Dependencies

```
Phase 1 ✅ ─┐
Phase 2 ✅ ─┤
Phase 3 ✅ ─┤
            ├─→ Phase 4 (Subagent Delegation & Teams)
            │       ↓
            ├─→ Phase 5 (Validation Enforcement)     ← can run parallel with Phase 4
            │       ↓
            └─→ Phase 6 (UI & Observability)          ← can start after Phase 4 begins
```

Phases 4 and 5 are independent and can be implemented in parallel.
Phase 6 can start as soon as Phase 4.1 (result rollup) lands — TOOL_META entries don't depend on validation enforcement.

## Updated File Impact Summary (Phases 4-6)

| File | Phases | Action |
|------|--------|--------|
| `apps/mcp-server/src/mcpServer.ts` | 4, 5 | Add `delegate_parallel` tool, result-push to pending messages, auto-spawn validators, native team detection |
| `coordinatorTools.ts` | 4, 5 | Result rollup forwarding, status forwarding, validation gate in `spawn_worker`, batch delegation |
| `coordinatorAgent.ts` | 5 | Simplify validation tier system prompt (runtime enforces now) |
| `executionPolicy.ts` | 5 | Separate `allowCompletionWithRisk` from phase-gate blocking, validation contract mid-run checks |
| `orchestratorService.ts` | 5 | Step completion hook for auto-spawning validators, validation contract checks |
| `workerDeliveryService.ts` | 4 | Push child results to parent pending messages |
| `unifiedOrchestratorAdapter.ts` | 4 | MCP config placement for native teammate inheritance |
| `teamRuntimeConfig.ts` | 4, 6 | Native team source tracking, roleModelOverrides |
| `AgentChatMessageList.tsx` | 6 | Add TOOL_META entries for all orchestrator tools |
| `MissionChatV2.tsx` | 6 | Inline coordination events in chat thread |
| `CreateMissionDialog.tsx` | 6 | Per-role model selection UI |
| `MissionsPage.tsx` | 6 | Add TeamMembersPanel component |
| `appStore.ts` | 6 | Zustand state for team member polling |
| `browserMock.ts` | 6 | Realistic team member mock data |
| `orchestrator.ts` (types) | 4, 5, 6 | `source` field on team member, `roleModelOverrides` type |

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
            ├─→ Phase 4 (Subagent Delegation & Teams)
            │       ↓
            ├─→ Phase 5 (Validation Enforcement)     ← can run parallel with Phase 4
            │       ↓
            ├─→ Phase 6 (UI & Observability)          ← can start after Phase 4 begins
            │       ↓
            └─→ Phase 7 (Reflection Protocol)         ← can start after Phase 5
```

## Updated File Impact Summary (All Remaining Phases)

| File | Phases | Action |
|------|--------|--------|
| `apps/mcp-server/src/mcpServer.ts` | 4, 5, 7 | Add `delegate_parallel` tool, result-push, auto-spawn validators, native team detection, `reflection_add` tool |
| `coordinatorTools.ts` | 4, 5 | Result rollup forwarding, status forwarding, validation gate in `spawn_worker`, batch delegation |
| `coordinatorAgent.ts` | 5, 7 | Simplify validation tier prompt, add reflection guidance |
| `executionPolicy.ts` | 5 | Separate `allowCompletionWithRisk` from phase-gate blocking, validation contract mid-run checks |
| `orchestratorService.ts` | 5, 7 | Step completion hook for auto-spawning validators, post-mission reflection synthesis hook |
| `workerDeliveryService.ts` | 4 | Push child results to parent pending messages |
| `unifiedOrchestratorAdapter.ts` | 4 | MCP config placement for native teammate inheritance |
| `baseOrchestratorAdapter.ts` | 7 | Add reflection guidance to worker prompts |
| `teamRuntimeConfig.ts` | 4, 6 | Native team source tracking, roleModelOverrides |
| `memoryService.ts` | 7 | Add reflection entry storage, or create `reflectionService.ts` |
| New: `reflectionSynthesisEngine.ts` | 7 | Post-mission retrospective synthesis, changelog tracking, pattern promotion |
| `AgentChatMessageList.tsx` | 6 | Add TOOL_META entries for all orchestrator tools |
| `MissionChatV2.tsx` | 6 | Inline coordination events in chat thread |
| `CreateMissionDialog.tsx` | 6 | Per-role model selection UI |
| `MissionsPage.tsx` | 6 | Add TeamMembersPanel component |
| `appStore.ts` | 6 | Zustand state for team member polling |
| `browserMock.ts` | 6 | Realistic team member mock data |
| `orchestrator.ts` (types) | 4, 5, 6, 7 | `source` field on team member, `roleModelOverrides`, `ReflectionEntry`, `MissionRetrospective` types |

## Documentation Reality Check
- This file is the canonical source for all remaining Phase 3 work (orchestrator runtime, subagents, validation, UI, reflection).
- `docs/final-plan/phase-3.md` is superseded by this document — see disclaimer in that file.
- Other roadmap documents (`final-plan/README.md`, `architecture/AI_INTEGRATION.md`) have been trimmed to point here for orchestrator details.
- Historical planning context is preserved in original docs but marked non-authoritative for runtime contracts.
