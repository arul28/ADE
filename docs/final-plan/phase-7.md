# Phase 7: Core Extraction

## Phase 7 -- Core Extraction (`packages/core`) (5-7 weeks)

Goal: Decouple core runtime from Electron transport.

### Reference docs

- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — main process service graph, IPC contract, registerIpc.ts concentration
- [architecture/SYSTEM_OVERVIEW.md](../architecture/SYSTEM_OVERVIEW.md) — component breakdown, IPC architecture
- [architecture/DATA_MODEL.md](../architecture/DATA_MODEL.md) — SQLite schema (transport-neutral extraction target)
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — aiIntegrationService and MCP server (must operate through core contracts)

### Dependencies

- Phase 3 completion package complete (W13-W22 in `phases-1-3.md`).
- Phases 5 and 6 complete.

### Workstreams

- Data/contracts:
  - Stabilize transport-neutral service contracts.
- Refactor:
  - Extract core services to `packages/core` (lanes, git, conflicts, packs, missions, orchestrator, AI integration, MCP server).
  - Break `registerIpc.ts` into domain adapters over shared core APIs.
  - Ensure `aiIntegrationService` and MCP server operate through core contracts, not Electron-specific bindings.
- Validation:
  - Parity tests for desktop adapter vs core behaviors.
  - Regression coverage for hot paths (lanes/pty/git/conflicts/packs).

### Exit criteria

- Core workflows run through transport-agnostic core package.
- Desktop behavior remains functionally equivalent.
- Domain adapters replace monolithic IPC registration structure.
