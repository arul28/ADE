# Multi-Device Sync Architecture

> Roadmap reference: `docs/final-plan/phase-6.md` is the canonical Phase 6 plan.

> Last updated: 2026-03-21

> Status: **Phase 6 W1-W5 foundation is in place. Desktop live host/controller sync, device pairing, and QR pairing UX are implemented. iOS uses a pure-SQL CRR emulation layer (trigger-based change tracking against system SQLite) instead of the native cr-sqlite extension, avoiding all dynamic-library and code-signing restrictions on iOS. The vendored `crsqlite.xcframework` has been removed.**

This document describes ADE's multi-device sync architecture: cr-sqlite CRDT replication, the WebSocket sync protocol, the host/controller device model, and the security model for device communication.

---

## Table of Contents

- [Overview](#overview)
- [cr-sqlite CRDT Integration](#cr-sqlite-crdt-integration)
- [WebSocket Sync Protocol](#websocket-sync-protocol)
- [Device registry and host/controller model](#device-registry-and-hostcontroller-model)
- [Sync Topology and Changeset Flow](#sync-topology-and-changeset-flow)
- [Security Model](#security-model)
- [Implementation Status](#implementation-status)

---

## Overview

ADE syncs application state across devices using **cr-sqlite** (a SQLite CRDT extension) over a **WebSocket transport**. The design is local-first with zero cloud dependency:

- One reachable desktop-class machine is the **host** for a live ADE session. It runs agents, missions, orchestrator work, terminal sessions, and all execution side effects.
- Other connected devices are **controllers**. Phones are always controllers. A second desktop can either be its own independent ADE machine via Git, or explicitly attach as a controller to another host.
- State replication uses conflict-free replicated relations (CRRs) with last-writer-wins per column.
- Code syncs via git. Live ADE runtime state syncs only within a host/controller session. A small shared ADE scaffold/config layer also travels through tracked ADE files so another desktop clone does not look like a brand-new ADE project. Secrets never sync.

Architecture direction as of 2026-03-16:

- Treat "brain" as legacy internal naming for the live host machine.
- Narrow live ADE sync semantics to **host/controller**, not generalized multi-host active runtime ownership.
- If a second desktop wants to work independently, Git handles that. If it wants to observe/control another live machine, it connects as a controller.

Canonical note:

- Git is sufficient for independent desktop-to-desktop work on the same repo.
- Tracked ADE scaffold/config is the portability layer that makes another desktop clone feel like the same ADE project.
- Live ADE execution ownership is singular within a connected host/controller session.
- A second desktop can attach as a controller, but that is still controller-to-host, not multi-host cluster ownership.
- `brain*` field names that remain in the protocol or database are legacy internal compatibility names, not user-facing product language.

---

## cr-sqlite CRDT Integration

### Loading the Extension

- **Desktop**: loads `cr-sqlite` as a native loadable extension (`.dylib`) through the shared `openKvDb(...)` path in [`apps/desktop/src/main/services/state/kvDb.ts`](/Users/arul/ADE/apps/desktop/src/main/services/state/kvDb.ts). The W1 implementation uses Node's native `node:sqlite` driver plus a vendored `crsqlite.dylib` on desktop/macOS.
- **iOS**: uses a **pure-SQL CRR emulation layer** in [`apps/ios/ADE/Services/Database.swift`](/Users/arul/ADE/apps/ios/ADE/Services/Database.swift) instead of the native cr-sqlite extension. iOS system SQLite does not support `sqlite3_load_extension()`, `sqlite3_auto_extension()` is rejected on Apple platforms, and calling `sqlite3_crsqlite_init()` directly crashes because the SQLite API thunk pointer is nil in a loadable-extension-style binary. Rather than fighting these restrictions with a static-link wrapper, the iOS app implements the CRR contract entirely in SQL using triggers and custom SQLite functions registered via `sqlite3_create_function_v2()`:
  - **Metadata tables**: `crsql_master`, `crsql_site_id`, `crsql_changes`, and per-table `<table>__crsql_clock` tables are created as regular SQLite tables matching the cr-sqlite schema.
  - **Change tracking**: per-table INSERT/UPDATE/DELETE triggers automatically write to `crsql_changes` with Lamport-style versioning. Custom functions (`ade_next_db_version()`, `ade_local_site_id()`, `ade_capture_local_changes()`) provide the trigger context.
  - **Changeset exchange**: `exportChangesSince(version:)` and `applyChanges(_:)` read/write the same `crsql_changes` table format that the desktop cr-sqlite extension uses, so changesets are wire-compatible.
  - **CRR enablement**: `enableCrr(for:)` dynamically discovers tables from `sqlite_master` and installs triggers, matching desktop's dynamic CRR marking behavior.

  The previously vendored `crsqlite.xcframework` (which contained a dynamic framework with `_sqlite3_crsqlite_init` entrypoint) has been removed from the project. It was never linked or embedded in any build phase.

### CRR Marking

W1 marks all eligible non-virtual ADE tables as conflict-free replicated relations at startup:

```sql
SELECT crsql_as_crr('table_name');
```

**Excluded**:
- Virtual/internal tables such as `sqlite_%`, `crsql_%`, and `unified_memories_fts%`
- `unified_memories_fts` remains local-only and is rebuilt from synced `unified_memories`

The migration is dynamic rather than count-based: new future tables are discovered from `sqlite_master` and become CRRs automatically unless excluded as virtual/internal tables.

### Merge Semantics

- Last-writer-wins per column with Lamport timestamps.
- Each device has a unique local site ID stored at `.ade/secrets/sync-site-id`.
- `openKvDb(...).sync` exposes the W1 sync primitives used by later transport layers:
  - `getSiteId()`
  - `getDbVersion()`
  - `exportChangesSince(version)`
  - `applyChanges(changes)`
- Sync-managed tables support later `ALTER TABLE ... ADD COLUMN` through automatic `crsql_begin_alter` / `crsql_commit_alter` wrapping in the shared DB adapter.
- Engineering rule under CRR retrofit: app-level `ON CONFLICT(...)` upserts must target a table primary key only. Do not rely on secondary UNIQUE constraints for replicated tables, because the CRR retrofit strips non-PK uniqueness. Non-PK merge cases should use explicit select-then-update logic instead.

### Changeset Extraction and Application

```sql
-- Extract changes since a version
SELECT * FROM crsql_changes WHERE db_version > ?;

-- Apply remote changes
INSERT INTO crsql_changes(...);
```

After applying remote changesets that touch `unified_memories`, ADE rebuilds the local FTS index so memory search stays correct.

---

## WebSocket Sync Protocol

### Transport

- Host runs a WebSocket server (default port 8787) embedded in the Electron main process.
- JSON-framed cr-sqlite changesets with zlib compression for large batches.
- Heartbeat ping/pong at 30-second intervals for connection health.

### Connection Flow

1. Peer connects with host, port, and bootstrap token.
2. Host validates the bootstrap token.
3. Peer sends its current `db_version`.
4. Host sends all changesets since that version.
5. Continuous bidirectional sync begins.

### Sub-Protocols

| Sub-Protocol | Purpose | Used By |
|---|---|---|
| **Changeset sync** | Bidirectional cr-sqlite changeset exchange | All devices |
| **File access** | Request/response for file reads, directory listings, writes | iOS Files tab, desktop remote viewing |
| **Terminal stream** | Subscribe to terminal session output from host | iOS Work tab |
| **Chat stream** | Subscribe to agent chat transcript events from host. A `chat_subscribe` message sends a snapshot of recent transcript events and begins polling for new entries; `chat_unsubscribe` stops streaming. Incremental events are delivered as `chat_event` envelopes. | iOS Work tab, controller chat views |
| **Command routing** | Send execution commands to host | All non-host devices |

### Reconnection

Automatic reconnection with version-based catch-up on connection drops. Peers resume from their last known `db_version`, so no data is lost.

---

## Device registry and host/controller model

### Device Table

A synced `devices` table stores durable device metadata:

| Field | Description |
|---|---|
| `device_id` | Unique device identifier |
| `site_id` | Stable cr-sqlite site identifier |
| `name` | User-assigned device name |
| `platform` | `macOS`, `iOS`, `linux` |
| `device_type` | `desktop`, `phone`, `vps` |
| `last_seen` | Last connection timestamp |
| `last_host` / `last_port` | Last known manual-connect address |
| `ip_addresses` | LAN IPs |
| `tailscale_ip` | Tailscale IP (if available) |
| `metadata_json` | Future-safe operational metadata |

Host authority is stored separately in a synced singleton `sync_cluster_state` row:

| Field | Description |
|---|---|
| `cluster_id` | Singleton cluster key (`default`) |
| `brain_device_id` | Legacy internal field for the current host device |
| `brain_epoch` | Legacy internal handoff counter for host ownership |
| `updated_at` | Last handoff timestamp |
| `updated_by_device_id` | Device that last changed host ownership |

### Host designation

- Explicit user action: choose which desktop-class machine is the current live host in Settings > Sync.
- Only one host owns live ADE execution side effects at a time.
- Phones are controller-only.
- A second desktop can either stay independent and rely on Git, or connect to the active host as a controller.

Desktop nuance:

- A Mac that opens the repo independently without connecting is its own local ADE machine for execution.
- That does **not** make it part of the same live host/controller session as another Mac.
- The portability requirement is not "multi-host active-active execution". It is "a desktop clone should inherit the shared ADE scaffold/config layer from Git even before it connects to a live host."

### Host Transfer Protocol

1. Transfer preflight checks for live blockers: active missions, running chat turns, live PTY sessions, and running managed processes.
2. Paused missions, CTO history/idle threads, and idle or ended agent chats are treated as durable synced state and survive handoff.
3. Final sync flush completes.
4. `sync_cluster_state.brain_device_id` moves to the new device and `brain_epoch` increments.
5. New host starts the host lifecycle, old host demotes to controller/standalone as needed.

### Device Discovery

- W3 uses manual host/port/bootstrap-token entry in Settings > Sync.
- Numeric-code pairing and per-device secrets are implemented.
- mDNS discovery, QR pairing presentation/scanning, Tailscale address selection, and final network hardening remain follow-on W5 work.

---

## Sync Topology and Changeset Flow

### What Syncs Where

| Data Category | Sync Mechanism | Devices |
|---|---|---|
| All replicated ADE runtime tables in `.ade/ade.db` | cr-sqlite CRRs | All connected devices |
| Source code files | git push/pull | Desktop peers only |
| Shared ADE scaffold/config (`.ade/.gitignore`, `.ade/ade.yaml`, `cto/identity.yaml`, human-authored templates/skills, repo-backed workflow files when present) | git | Desktop peers only |
| Local overrides (`.ade/local.yaml`, `.ade/local.secret.yaml`) | **Never syncs** | Machine-specific |
| Worktrees, PTY processes, cache, transcripts, artifacts, sockets, secrets | **Never syncs** | Machine-specific |

Two connected devices therefore do **not** have identical `.ade/` folders:

- Git gives them the same tracked project scaffold.
- ADE sync gives them the same replicated application state.
- Each device still keeps its own local runtime directories.

Two disconnected desktop ADE machines also do **not** have a shared live host/controller session by default:

- code convergence happens through git
- the narrow shared ADE scaffold/config layer converges through tracked `.ade/`
- live mission/chat/process state converges only when they join the same ADE sync cluster

In W3, the recommended multi-desktop posture is:

- one machine acts as the **host** and owns execution plus local worktrees
- other desktops attach as **controllers**
- host handoff is optional, not required for day-to-day second-device use

That is not the entire desktop story anymore. W3 also requires a small "pick this repo up on another desktop without ADE bootstrap confusion" posture:

- a desktop that clones or pulls the repo should inherit the shared ADE scaffold/config/identity files from tracked `.ade/`
- joining a live host should improve freshness and expose live runtime state
- but it remains the only way another desktop learns the current live runtime state

### Shared ADE scaffold/config layer

The Git-tracked ADE layer in W3 is intentionally narrow. It exists so a normal desktop clone/pull carries the shared ADE setup without trying to make all ADE runtime state portable through Git.

This layer exists because:

- git is the portability mechanism for desktop code work
- WebSocket sync is the live-cluster mechanism for real-time ADE runtime state
- users still need the shared ADE setup on another desktop after a normal clone/pull

Examples that belong in this tracked layer:

- `.ade/.gitignore`
- `.ade/ade.yaml`
- `.ade/cto/identity.yaml`
- human-authored files under `.ade/templates/**`
- human-authored files under `.ade/skills/**`
- stable repo-backed workflow/config files under `.ade/workflows/linear/**` when present

Examples that do **not** belong in this tracked layer:

- DB-derived runtime rows
- generated CTO/context docs such as `cto/CURRENT.md`, `cto/MEMORY.md`, `cto/core-memory.json`, and `.ade/context/*.ade.md`
- agent/session logs, handoff logs, transcripts, caches, artifacts, worktrees, secrets, and connection state

Rule for future workstreams:

- if a new ADE feature creates low-churn, human-authored shared config or identity, it can define a tracked representation under `.ade/`
- if a feature only matters for a connected live host/controller session, keep it in ADE sync
- if a feature is machine-bound, keep it local

### Changeset Flow Diagram

```
┌──────────┐   changesets    ┌──────────┐   changesets    ┌──────────┐
│  iPhone  │ ◄─────────────► │  Host   │ ◄─────────────► │  Mac #2  │
│ (controller) │   WebSocket     │ (Mac #1) │   WebSocket     │ (controller) │
└──────────┘                 └──────────┘                 └──────────┘
                                  │
                                  │ code sync (git push/pull)
                                  ▼
                             ┌──────────┐
                             │  Mac #2  │
                             │ worktree │
                             └──────────┘
```

### Command Routing

- **State-only operations** (create lane metadata, update settings): write locally, cr-sqlite syncs.
- **Execution operations** (create worktree, run terminal command, create PR): send command to host via WebSocket. Host executes, state changes sync back.

The remote command service (`syncRemoteCommandService`) registers named actions that controllers can invoke. Agent chat commands include `chat.create`, `chat.send`, `chat.interrupt`, `chat.steer`, `chat.approve`, `chat.respondToInput`, `chat.resume`, `chat.updateSession`, `chat.dispose`, and `chat.models`. All chat commands are viewer-allowed and queueable, enabling full remote chat session control from companion devices.

---

## Security Model

### Device Pairing

- W3 uses a shared machine-local bootstrap token stored at `.ade/secrets/sync-bootstrap-token`.
- The current host surfaces that token in Settings > Sync for manual desktop-to-desktop connection.
- QR pairing, per-device secrets, OS keychain storage, and secure revoke remain W4 work.
- W3 should be treated as trusted-LAN-only scaffolding. The host currently listens on all interfaces and does not yet add W4 hardening such as per-device secrets, revocation, tighter network policy, or transport upgrades.

### Transport Security

- WebSocket connections are authenticated with the pairing token on every connection.
- Tailscale connections use WireGuard encryption (peer-to-peer, no cloud relay).
- LAN connections rely on pairing token validation. TLS is not required for localhost/LAN but can be added.
- In W3, this is still bootstrap-token auth rather than final pairing auth. Use it only on networks you trust. W4 is responsible for replacing this with secure pairing, revocation, and better network posture.

### Secret Isolation

- `.ade/local.secret.yaml` (API keys, external MCP configs) is machine-specific and never syncs.
- Linear credentials, GitHub tokens, and provider API keys remain on the host only.
- Each device stores its own pairing secret in its OS keychain.

### Agent Execution Isolation

- Agent processes (CTO heartbeats, worker activations, mission orchestration, embedding worker) run only on the host.
- Non-host devices never spawn agent processes.
- Commands from non-host devices are validated and executed by the host.

---

## Implementation Status

| Component | Status | Notes |
|---|---|---|
| cr-sqlite extension loading (desktop) | Implemented | Shared `openKvDb(...)` adapter with vendored `.dylib` |
| Pure-SQL CRR emulation (iOS) | Implemented | Trigger-based change tracking in `Database.swift`, wire-compatible with desktop cr-sqlite changesets |
| CRR marking for eligible tables | Implemented | Dynamic startup migration (desktop: `crsql_as_crr()`, iOS: `enableCrr(for:)` triggers) |
| Changeset extraction/application | Implemented | `AdeDb.sync.exportChangesSince/applyChanges` |
| WebSocket sync server | Implemented (desktop) | Phase 6 W2 |
| Sync protocol (JSON + zlib) | Implemented (desktop) | Phase 6 W2 |
| File access sub-protocol | Implemented (desktop) | Phase 6 W2 |
| Terminal stream sub-protocol | Implemented (desktop) | Phase 6 W2 |
| Device registry table | Implemented (desktop) | Phase 6 W3 |
| Desktop peer client + manual connect | Implemented (desktop) | Phase 6 W3 |
| Host election + transfer | Implemented (desktop) | Phase 6 W3 |
| Shared ADE scaffold/config portability for desktop clones | Implemented | Phase 6 W3 |
| Device pairing secrets + numeric-code pairing | Implemented (initial) | Phase 6 W4 |
| iOS local replicated database peer | Implemented (initial) | Phase 6 W4 |
| iOS Lanes / Files / Work / PRs local-first reads | Implemented (initial) | Phase 6 W4 |
| QR pairing UX | Implemented (initial) | Phase 6 W5 |
| Tailscale integration | Planned | Phase 6 W6+ |
| Command routing | Implemented (allowlisted subset for current phone tabs) | Phase 6 W4-W10 |
| Lane portability (desktop-to-desktop) | Planned | Phase 6 W11 |

**Overall status**: W1-W5 foundation is in place on both desktop and iOS. Desktop uses the native cr-sqlite extension for CRDT replication. iOS uses a pure-SQL CRR emulation layer (trigger-based change tracking against system SQLite) that produces wire-compatible changesets. The previously vendored `crsqlite.xcframework` has been removed -- it was a dynamic framework binary that could not be loaded on iOS due to platform restrictions on `sqlite3_load_extension()` and `sqlite3_auto_extension()`. W6+ continues with Tailscale integration, network hardening, and real-device dogfooding.

### Deferred follow-up

- W4 security hardening:
  - Finish the host network posture beyond trusted-LAN engineering use.
  - Add the intended revoke/discovery/QR UX around the already-implemented pairing-secret flow.
  - Revisit default host binding and discovery once the final pairing UX is in place.
- Pre-W5 performance work:
  - The `node:sqlite` adapter currently prepares statements per call.
  - This is acceptable for the current foundation, but statement caching should be revisited before heavier multi-peer sync loads arrive.
