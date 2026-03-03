# Phase 7: Core Extraction

## Phase 7 -- Core Extraction (`packages/core`) (5-7 weeks)

Goal: Decouple core runtime from Electron transport.

### Reference docs

- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — main process service graph (updated with decomposed services), IPC contract, registerIpc.ts concentration
- [architecture/SYSTEM_OVERVIEW.md](../architecture/SYSTEM_OVERVIEW.md) — component breakdown, IPC architecture
- [architecture/DATA_MODEL.md](../architecture/DATA_MODEL.md) — SQLite schema (transport-neutral extraction target)
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — aiIntegrationService and MCP server (must operate through core contracts)

### Dependencies

- Phase 3 complete (orchestrator autonomy + missions overhaul — see `phase-3.md`).
- Phases 5 and 6 complete.

### Workstreams

- Data/contracts:
  - Stabilize transport-neutral service contracts.
- Refactor:
  - Extract core services to `packages/core` (lanes, git, conflicts, packs, missions, orchestrator, AI integration, MCP server).
  - Break `registerIpc.ts` into domain adapters over shared core APIs.
  - Ensure `aiIntegrationService` and MCP server operate through core contracts, not Electron-specific bindings.
  - **Note (2026-03-02):** Significant groundwork for this phase was completed during Phase 3 Wave 4 (Codebase Refactoring). The AI orchestrator has been decomposed into 9 domain modules, the pack service into 4 builder modules, the type system into 17 domain files under `src/shared/types/`, and shared utilities consolidated in `src/main/services/shared/utils.ts` and `src/renderer/lib/`. These decompositions directly reduce the extraction surface area.
- Validation:
  - Parity tests for desktop adapter vs core behaviors.
  - Regression coverage for hot paths (lanes/pty/git/conflicts/packs).

### Exit criteria

- Core workflows run through transport-agnostic core package.
- Desktop behavior remains functionally equivalent.
- Domain adapters replace monolithic IPC registration structure.
