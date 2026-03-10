# Architecture

Architectural decisions, patterns, and key file locations for ADE mission system.

**What belongs here:** Service patterns, module boundaries, IPC architecture, state machine documentation, key type locations.

---

## Project Structure

- `apps/desktop/` — Electron app (main process + renderer)
  - `src/main/services/` — Main process services (trusted)
  - `src/renderer/components/` — React components (untrusted, communicates via IPC)
  - `src/shared/types/` — Shared TypeScript types
- `apps/mcp-server/` — MCP server (out of scope for this mission)
- `apps/web/` — Web app (out of scope)

## Key Files — Mission System

### Main Process Services
| File | Lines | Purpose |
|---|---|---|
| `orchestratorService.ts` | ~10500 | State machine, run/step/attempt CRUD, autopilot, tick |
| `aiOrchestratorService.ts` | ~9400 | Coordinator lifecycle, worker spawn, steer, recovery |
| `coordinatorTools.ts` | ~5860 | 40+ coordinator AI tools (spawn_worker, complete_mission, etc.) |
| `coordinatorAgent.ts` | ~1350 | Coordinator AI agent, system prompt, planning flow |
| `missionService.ts` | ~3600 | Mission CRUD, interventions, state transitions |
| `baseOrchestratorAdapter.ts` | ~500 | Worker prompt construction, buildFullPrompt() |
| `missionLifecycle.ts` | ~1050 | Run management, hook dispatch |
| `workerTracking.ts` | ~1090 | Worker state management |
| `recoveryService.ts` | ~410 | Failure recovery, health sweep |
| `phaseEngine.ts` | ~300 | Phase cards, built-in phases, profiles |
| `executionPolicy.ts` | ~1170 | Step execution policy, gates |
| `conflictService.ts` | ~1200 | Conflict detection, AI resolution, prediction |
| `prService.ts` | ~800 | PR creation, integration PRs, queue landing |
| `laneService.ts` | ~1750 | Lane CRUD, worktrees, rebase |
| `ctoStateService.ts` | ~600 | CTO identity, core memory, sessions |
| `unifiedMemoryService.ts` | ~800 | Memory CRUD, search, shared facts |

### Renderer Components
| File | Lines | Purpose |
|---|---|---|
| `MissionsPage.tsx` | ~2437 | Main missions tab (MEGA-COMPONENT — being refactored) |
| `MissionChatV2.tsx` | ~1755 | Chat component (being refactored) |
| `MissionRunPanel.tsx` | ~645 | Run status, workers, interventions |
| `missionHelpers.ts` | ~400 | Constants, types, utilities |
| `missionControlViewModel.ts` | ~200 | View model derivation |

### Shared Types
| File | Purpose |
|---|---|
| `shared/types/missions.ts` | Mission types, step types, intervention types |
| `shared/types/orchestrator.ts` | Run, step, attempt, worker, reflection types (~1687 lines) |
| `shared/types/conflicts.ts` | Conflict, rebase, resolution types |
| `shared/types/lanes.ts` | Lane types |
| `shared/types/prs.ts` | PR, integration proposal types |
| `shared/types/cto.ts` | CTO types |
| `shared/types/memory.ts` | Memory types |

## Patterns

### Service Factory Pattern
```typescript
export function createMyService({ dep1, dep2 }: { dep1: Dep1Type; dep2: Dep2Type }) {
  // private state
  return { publicMethod1, publicMethod2 };
}
```

### IPC Pattern (4 files)
1. `ipc.ts` — Channel name constants
2. `registerIpc.ts` — Main process handler registration
3. `preload.ts` — Preload bridge exposure
4. `global.d.ts` — Type declarations for `window.ade`

### State Machine
- `MissionStatus`: queued → planning → in_progress → intervention_required → completed/failed/canceled
- `OrchestratorRunStatus`: queued → bootstrapping → active → paused → completing → succeeded/failed/canceled
- `OrchestratorStepStatus`: pending → ready → running → succeeded/failed/blocked/skipped/superseded/canceled

### Database
- SQLite via sql.js (WASM), single file at `.ade/ade.db`
- Schema in `kvDb.ts` → `migrate()` function
- UUID TEXT primary keys
- Manual flush strategy (125ms debounce)
