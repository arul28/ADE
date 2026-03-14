# P0 Fixes — Consolidated Design

## Status

| P0 | Description | Status |
|---|---|---|
| P0-5 | Coordinator killed on first worker completion | DONE — changed `event.reason === "completed"` to `"finalized"` in aiOrchestratorService.ts:8089. Also fixed fallback path at ~8131. |
| P0-4 | `resumeActiveTeamRuntimes()` never called | DONE — added call in main.ts after executor adapter registration. |
| P0-1 | Dead triage code, weak coordinator prompt | DONE — deleted `missionTriage.ts` and `budgetPressureService.ts`. Added scope-awareness guidance to coordinator system prompt in coordinatorAgent.ts. |
| P0-3 | Single-lane hardcoding, no dynamic lane creation | IN PROGRESS |
| P0-2 | Permission model broken for workers | IN PROGRESS |

---

## P0-3: Lane Intelligence

### Design Decisions (from discussion)

1. **The coordinator decides lane strategy.** No upfront lane strategy config needed. The coordinator reads the codebase, understands scope, and creates lanes as needed.

2. **RULE: Never modify the base lane directly.** Every mission creates at least one "mission lane" from the base lane. This keeps the base lane clean. Even a 1-file fix gets its own mission lane.

3. **Same-lane parallelism IS allowed.** Multiple workers can share a lane if they touch non-overlapping files. The coordinator decides this based on task analysis.

4. **Separate lanes for isolation.** When tasks might touch overlapping files or represent genuinely independent workstreams, the coordinator creates separate lanes.

5. **Smart grouping.** Sequential tasks share a lane. Independent workstreams get separate lanes. The coordinator groups related tasks, not one-lane-per-task.

6. **PR strategy determines merge behavior.** `per-lane` = separate PR per lane. `integration` = merge all into integration branch, one PR. `manual` = user handles it. This already exists.

7. **Lane lifecycle.** Mission-created lanes persist after mission completion for PR creation. Cleanup happens after PR merge (user action or sweep).

### Implementation Changes

#### 1. Remove single-lane hardcoding
**File:** `aiOrchestratorService.ts` ~lines 5694-5706
- Remove the hardcoded `strategy: "single_lane", maxParallelLanes: 1` fallback
- The lane strategy decision block should be simplified — the coordinator handles lane decisions via tools, not via this deterministic block

#### 2. Create mission lane at run start
**File:** `aiOrchestratorService.ts` — in the mission run startup flow
- When a mission run starts (coordinator V2 path), ALWAYS create at least one mission lane from the base lane
- Name it: `m-{missionId.slice(0,6)}-{slugify(missionTitle)}`
- Pass this lane ID to the coordinator as the "primary mission lane"
- The coordinator can then create additional lanes from this or from the base lane

#### 3. Add `provision_lane` coordinator tool
**File:** `coordinatorTools.ts`
- New tool: `provision_lane`
- Parameters: `name` (string), `description` (optional string), `baseLaneId` (optional — defaults to mission's base lane)
- Calls `laneService.createChild({ parentLaneId: baseLaneId, name, description })`
- Returns: `{ ok: true, laneId: string, name: string }`
- The coordinator uses this when it decides tasks need separate lanes

#### 4. Expose `filesChanged` in `get_worker_output`
**File:** `coordinatorTools.ts` ~line 1402
- The `get_worker_output` tool currently returns summary/status/errors but NO files changed
- Worker tracking (`workerTracking.ts`) captures `filesChanged` in the digest
- Surface this data in `get_worker_output` response so the coordinator can track what workers actually modified
- Also surface from `collectTouchedRepoPaths` (runs `git status --porcelain` on the lane worktree)

#### 5. Update coordinator system prompt
**File:** `coordinatorAgent.ts`
- Already added scope-awareness guidance (done in P0-1)
- Add lane-specific guidance:
  - "You MUST create at least one mission lane before spawning workers. Never work directly in the base lane."
  - "Use `provision_lane` to create lanes. Use the same lane for sequential tasks. Use separate lanes for independent workstreams."
  - Document the `provision_lane` tool in the Tool Quick Reference table
- Also add the missing tools to the quick reference (provision_lane, transfer_lane, skip_step, update_mission_state, read_mission_state, insert_milestone, request_specialist)

---

## P0-2: Permission Model

### Design Decisions (from discussion)

1. **No global permission settings.** Permissions are per-chat-pane and per-mission only.

2. **CLI models mirror native app options:**
   - Claude CLI: Ask / Accept Edits / Plan / Bypass Permissions (maps to `--permission-mode`)
   - Codex CLI: Default / Full Access / Custom config.toml (maps to `--approval-mode` + `--sandbox`)

3. **API/local models use ADE's own sandbox:** Configurable allow/deny lists for bash commands, protected files, path sandboxing. Applied at the tool execution layer.

4. **Workers default to full autonomy:** Claude workers default to `bypassPermissions` (not `acceptEdits` which hangs). Codex workers already default to `full-auto`.

5. **Mid-run permission changes via intervention:** When a worker hits a permission block, the coordinator creates a permission-specific intervention. The user can choose to restart the worker with different permissions. This requires killing and respawning the worker (CLI flags are static).

6. **Pre-mission launch includes permission selection:** Same permission options as chat panes, per-provider. Warning shown if not full-auto: "Workers may pause for approval."

### Implementation Changes

#### 1. Fix Claude worker default
**File:** `unifiedOrchestratorAdapter.ts` ~line 222
- Change default from `"acceptEdits"` to `"bypassPermissions"`
- This is the most critical fix — acceptEdits causes workers to hang waiting for bash approval

#### 2. Add sandbox config type and defaults
**File:** New type in `shared/types/config.ts`
```typescript
export type WorkerSandboxConfig = {
  blockedCommands: string[];      // regex patterns always blocked
  safeCommands: string[];         // regex patterns always allowed
  protectedFiles: string[];       // regex patterns for files that can't be modified
  allowedPaths: string[];         // paths workers can access (default: project root)
  blockByDefault: boolean;        // if true, unknown commands are blocked
};
```

**File:** New file or in orchestrator constants — `defaultSandboxConfig`
- Base list derived from sandbox.py (without personal AWS/MCP stuff):
  - blockedCommands: rm -rf /, sudo, eval, curl|sh, chmod 777, mkfs, dd, shutdown, reboot, fork bomb
  - safeCommands: npm, pnpm, yarn, git status/diff/log, ls, node, vitest, eslint, prettier, tsc
  - protectedFiles: .env, secrets.json, credentials.json, .pem, .key, .git/
  - allowedPaths: ["./"] (project root)
  - blockByDefault: false (allow unknown commands — safer to start permissive and tighten)

#### 3. Add sandbox enforcement for API model tools
**File:** Wherever API model tool calls are executed (universalTools.ts or equivalent)
- Before executing bash commands for API models, run through sandbox config
- Check blocked patterns first, then safe patterns, then path validation
- If blocked: return error to model, don't execute
- CLI models skip this (they have their own permission systems)

#### 4. Add permission-specific intervention
**File:** Mission intervention types + coordinator tools
- Add intervention metadata for permission issues: `{ source: "permission_blocked", provider, currentMode, suggestedMode }`
- When coordinator detects a worker failed due to permission, create intervention with permission upgrade option
- UI renders permission selection in the intervention card (future — can start with text-based)

#### 5. Update mission launch dialog
**File:** `CreateMissionDialog.tsx`
- Add per-provider permission selection in "Worker Permissions" section
- Claude: dropdown with Ask / Accept Edits / Plan / Bypass
- Codex: dropdown with Default / Full Access / Custom
- API: dropdown with Plan / Edit / Full-Auto
- Show warning banner if not full-auto: "Workers using restricted permissions may pause for approval"
- Store selections in mission config, pass to worker spawn

---

## File Touch Map (for parallelization)

### P0-3 (Lanes) touches:
- `aiOrchestratorService.ts` — remove single-lane hardcoding, add mission lane creation
- `coordinatorTools.ts` — add `provision_lane` tool, enhance `get_worker_output`
- `coordinatorAgent.ts` — update system prompt with lane guidance + tool reference

### P0-2 (Permissions) touches:
- `unifiedOrchestratorAdapter.ts` — fix Claude default
- `shared/types/config.ts` — add WorkerSandboxConfig type
- Sandbox config defaults (new file or constants)
- `CreateMissionDialog.tsx` — permission selection UI
- Coordinator tools (permission intervention) — minor addition

### Overlap:
- `coordinatorTools.ts` is touched by both (P0-3 adds provision_lane, P0-2 adds permission intervention)
- Solution: P0-3 agent owns coordinatorTools.ts. P0-2 agent handles everything else and provides the coordinatorTools.ts changes needed to the lead for integration.
