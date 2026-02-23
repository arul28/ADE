# Missions Tab Overhaul Plan

## Context

After launching a mission, multiple issues were discovered:
- Parallel execution doesn't actually run in parallel (15s ramp-up delay)
- DAG visualization is broken (overlapping nodes, disconnected edges)
- Activity tab shows noisy internal events ("tick", "dynamic_cap")
- Progress bar appears inaccurate
- Timer keeps running for cancelled/failed missions
- Planner ignores test=none toggle and doesn't know ADE capabilities
- Channels tab only shows orchestrator, not worker agents
- Pre-mission config has UX issues (useless lane picker, priority dropdown, no model/thinking level selection)
- Usage dashboard shows zeros
- No lane cleanup button for cancelled missions
- No lane folders for organizing mission-created lanes
- No agent teams toggle

---

## Phase 1: Critical Backend Fixes

### 1A. Fix Parallel Execution Ramp-Up

**Root cause**: `orchestratorService.ts:4354` fires `startReadyAutopilotAttempts` as fire-and-forget after run creation. But `autopilotRunLocks` (line 4369) prevents re-entry, so the health sweep (every 15s) can't fill remaining parallel slots until the first call finishes.

**Files**: `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`, `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts`

**Changes**:
1. In `orchestratorService.ts:4369`, add lock-wait logic for `initial_ramp_up` reason — if lock held, wait up to 2s for release
2. In `aiOrchestratorService.ts` after line 5735, add a delayed second `startReadyAutopilotAttempts` call with reason `"initial_ramp_up"` (500ms delay)
3. Reduce `HEALTH_SWEEP_INTERVAL_MS` from 15000 to 5000

### 1B. Fix Timer for Terminal Missions

**File**: `apps/desktop/src/renderer/components/missions/MissionsPage.tsx`

1. Modify `formatElapsed` (line 230) to accept `endedAt` — use `completedAt` instead of `Date.now()` for terminal missions
2. Optimize tick interval (line 1694) to only run when mission is active

### 1C. Planner: Hard Test Constraint

**File**: `apps/desktop/src/main/services/missions/missionPlanningService.ts`

1. In `buildPlannerPrompt` (line 375), when testing.mode === "none", add hard constraint: "DO NOT generate any test/validation steps"
2. After plan parsing in `planMissionOnce`, strip test-type steps when testing disabled

### 1D. Planner: ADE Capabilities Context

**File**: `apps/desktop/src/main/services/missions/missionPlanningService.ts`

Add ADE capabilities section to `buildPlannerPrompt` describing lanes, merge conflict resolution, agent teams, MCP tools, context packs, integration chain

---

## Phase 2: UI Component Fixes

### 2A. Replace DAG with dagre Layout

**Files**: `apps/desktop/src/renderer/components/missions/OrchestratorDAG.tsx`, `apps/desktop/package.json`

1. Install `dagre` + `@types/dagre`
2. Replace `computeLayout` (lines 58-136) with dagre-based layout (`rankdir: "LR"`, proper nodesep/ranksep)
3. Keep all existing SVG node rendering (status colors, animations, phase tints, gate shapes)

### 2B. Clean Up Activity Feed

**File**: `apps/desktop/src/renderer/components/missions/MissionsPage.tsx`

1. Define `NOISY_EVENT_TYPES` set: `claim_heartbeat`, `context_pack_bootstrap`, `autopilot_parallelism_cap_adjusted`
2. Filter from narrative header recent events (line 2703) and latest meaningful event (line 2695)
3. Improve `narrativeForEvent` for better human-readable descriptions

### 2C. Fix Progress Bar

**Files**: `MissionsPage.tsx`, `PhaseProgressBar.tsx`

1. Add numeric label: "2 of 21 steps complete (10%)"
2. Add overall aggregate bar at top of PhaseProgressBar before per-phase breakdown

---

## Phase 3: Pre-Mission Config Revamp

### 3A. Model + Thinking Level Selector

**Files**: `apps/desktop/src/renderer/components/missions/PolicyEditor.tsx`, `apps/desktop/src/shared/types.ts`

Models (from SDK): Claude (opus-4-6, sonnet-4-6, sonnet-4-5, haiku-4-5) + Codex (gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-max, codex-mini-latest, o4-mini, o3)
Thinking: Claude (low/medium/high/max), Codex (low/medium/high/extra_high)

1. Add `thinkingLevel?: string` to policy phase types in `types.ts`
2. Replace 2-option model select with grouped optgroup dropdown showing all models
3. Add thinking level dropdown per phase row

### 3B. Remove Lane Picker + Priority Dropdown

**File**: `MissionsPage.tsx`

1. Replace lane dropdown with info card: "Missions automatically create dedicated lanes"
2. Remove priority dropdown, hardcode "normal"

### 3C. Add Agent Teams Toggle

**Files**: `PolicyEditor.tsx`, `types.ts`

1. Add `useAgentTeams?: boolean` to `MissionExecutionPolicy`
2. Add toggle switch at bottom of PolicyEditor

---

## Phase 4: Worker Channels + Usage + Lane Cleanup

### 4A. Create Worker Threads on Attempt Start

**File**: `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts`

After attempt starts with executorSessionId, proactively create worker chat thread using existing `ensureOrCreateThread`

### 4B. Usage Dashboard Improvements

**File**: `apps/desktop/src/renderer/components/missions/UsageDashboard.tsx`

Better empty state with explanation, add error state display. Data pipeline is correct; zeros appear because no AI calls completed yet.

### 4C. Lane Cleanup Button

**File**: `MissionsPage.tsx`

Add "Clean up lanes" button for failed/canceled missions. Collect laneIds from runGraph.steps, call `window.ade.lanes.deleteLane` for each.

### 4D. Dynamic Step Count Indicator

**File**: `MissionsPage.tsx`

Show "(plan adjusted from N steps)" when step count changes from original

---

## Phase 5: Lane Folders

### 5A. Add Folder Grouping to Lanes Tab

**Files**: `types.ts`, `laneService.ts` (migration), `LaneList.tsx`, `aiOrchestratorService.ts`

1. Add `folder: string | null` to `LaneSummary`
2. Add `folder` column via migration in `kvDb.ts`
3. Group lanes by folder in `LaneList.tsx` with collapsible sections
4. Orchestrator sets folder to "Mission #N - [title]" when creating lanes

---

## Verification

- **Phase 1**: Multiple workers start within 2s. Timer stops for cancelled. No test steps when testing=none.
- **Phase 2**: DAG nodes spaced properly, edges connect. Activity feed clean. Progress bar accurate.
- **Phase 3**: Model dropdowns show models + thinking. No lane picker or priority. Agent teams toggle works.
- **Phase 4**: Worker threads in Channels. Usage shows data after AI calls. Lane cleanup works.
- **Phase 5**: Mission lanes in folders. Folders collapsible.

Run `cd apps/desktop && npx tsc --noEmit` after each phase.
