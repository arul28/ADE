# Phase 8: Core Extraction + SpacetimeDB Evaluation (Deferred)

## Phase 8 -- Core Extraction + SpacetimeDB Evaluation (7-10 weeks)

> **Status: DEFERRED** — This phase activates ONLY if cr-sqlite (Phase 6) proves insufficient for multi-device sync. It is not on the default execution path.

Goal: If cr-sqlite encounters fundamental issues (sync reliability, conflict resolution, performance at scale), extract ADE's core services from the Electron shell and evaluate SpacetimeDB as an alternative real-time database with built-in sync.

### Trigger Conditions

This phase activates if Phase 6 reveals any of these issues:
- cr-sqlite changeset merge produces data corruption or silent conflicts.
- Sync latency exceeds acceptable thresholds (>500ms for interactive state).
- cr-sqlite WASM build is unstable or has memory issues in Electron.
- CRR marking causes performance regression on existing SQL operations.
- The cr-sqlite project becomes unmaintained or incompatible with sql.js updates.

If cr-sqlite works well, this phase is skipped entirely.

### Dependencies

- Phase 6 attempted (cr-sqlite evaluation complete with identified issues).
- Phase 5 complete.

### Part A: Core Extraction (`packages/core`)

#### Why Extraction is Needed
- cr-sqlite works as a SQLite extension — no extraction needed for that approach.
- SpacetimeDB is a completely different database — services can't use raw SQL against it.
- Extraction creates an abstraction layer between services and database, allowing the database implementation to be swapped.

#### Workstreams

##### W1: Repository Interface Layer
- Define a `Repository` interface for each domain: `LaneRepository`, `MissionRepository`, `TerminalRepository`, etc.
- Each repository encapsulates all SQL operations for its domain.
- Services call repository methods instead of raw SQL.
- Initial implementation: `SqliteRepository` that wraps existing raw SQL (no behavior change).

##### W2: Service Extraction
- Extract core services to `packages/core`:
  - Lane service, git service, conflict service, pack service
  - Mission service, orchestrator service, AI integration service
  - Memory service, terminal session service, automation service
- Each service depends on repository interfaces, not concrete database implementations.
- MCP server operates through core service contracts.

##### W3: IPC Adapter Split
- Break `registerIpc.ts` (234 channels) into domain-specific adapters.
- Each adapter maps IPC channels to core service methods.
- Desktop Electron shell becomes a thin transport layer over core.

##### W4: Parity Validation
- Full parity test suite: every IPC channel produces identical results through new adapters.
- Regression coverage for hot paths (lanes, PTY, git, conflicts, packs, missions).
- Performance benchmarks: extraction must not degrade response times.

### Part B: SpacetimeDB Evaluation

#### What SpacetimeDB Offers
- Real-time database with built-in subscription queries — clients subscribe to queries, get automatic updates when data changes.
- "Reducers" — server-side functions (like stored procedures) written in Rust/C# that run inside the database.
- All data in-memory with WAL persistence — extremely fast reads/writes.
- Built-in multi-client sync — no need for cr-sqlite, WebSocket sync, or changeset management.
- Self-hostable binary — can be bundled into Electron as a child process.
- Auto-generated client SDKs (TypeScript, Swift, C#) from table/reducer definitions.

#### Workstreams

##### W5: SpacetimeDB Schema Design
- Translate all 63 SQLite tables to SpacetimeDB table definitions.
- Design reducers for all write operations (mission lifecycle, lane management, agent state, etc.).
- Design subscription queries for each UI view (mission list, lane list, activity feed, etc.).
- Handle schema differences: SpacetimeDB uses different type system, no foreign keys (application-level enforcement).

##### W6: SpacetimeDB Repository Implementation
- Implement `SpacetimeDbRepository` for each domain, behind the same repository interfaces from Part A.
- Map repository methods to SpacetimeDB reducer calls (writes) and subscription queries (reads).
- Auto-generated TypeScript client SDK provides type-safe access.

##### W7: SpacetimeDB Runtime Integration
- Bundle SpacetimeDB server binary into Electron app as a child process.
- Start SpacetimeDB on app launch, connect via localhost.
- Handle process lifecycle: start, health check, graceful shutdown, crash recovery.
- Data migration: one-time migration tool to move data from SQLite to SpacetimeDB.

##### W8: Multi-Device with SpacetimeDB
- SpacetimeDB natively supports multiple connected clients with real-time sync.
- Brain runs the SpacetimeDB instance; other devices connect as clients.
- Subscription queries automatically push updates to all connected clients.
- No need for cr-sqlite, changeset extraction, or custom sync protocol.
- iOS client uses SpacetimeDB's auto-generated Swift SDK.

##### W9: Comparative Evaluation
- Run both approaches (cr-sqlite and SpacetimeDB) side by side using the repository abstraction.
- Measure: sync latency, conflict resolution accuracy, memory usage, developer experience.
- Evaluate: migration complexity, ongoing maintenance burden, community/support health.
- Decision gate: choose one approach and decommission the other.

##### W10: Validation
- Repository interface parity tests (both implementations produce same results).
- SpacetimeDB reducer tests for all write operations.
- Subscription query tests (correct data, timely updates).
- Multi-client sync tests (2-3 clients, concurrent writes, verify consistency).
- Migration tool tests (SQLite → SpacetimeDB data fidelity).
- Performance benchmarks (SpacetimeDB vs SQLite for ADE's workload patterns).

### Migration Scope Reference

For planning purposes, the current database footprint:
- **63 tables**, 149 foreign keys, 137 indexes
- **~926 SQL operations** across 40 service files
- **No ORM** — all raw SQL via `db.run()`, `db.get()`, `db.all()`
- **Single access point**: `kvDb.ts` with `AdeDb` interface
- **Estimated migration effort**: 7-10 weeks human, 1-2 weeks with agent swarm

### Exit criteria

- Core services extracted to `packages/core` with repository interface abstraction.
- Desktop behavior remains functionally equivalent through domain adapters.
- SpacetimeDB prototype demonstrates multi-device sync with ADE's full schema.
- Comparative evaluation produces clear recommendation with data.
- If SpacetimeDB is chosen: migration path is validated and cr-sqlite is decommissioned.
- If cr-sqlite is confirmed: SpacetimeDB evaluation is documented and Phase 6 approach is ratified.
