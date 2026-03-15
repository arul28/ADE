# Multi-Device Sync Architecture

> Roadmap reference: `docs/final-plan/phase-6.md` is the canonical Phase 6 plan.

> Last updated: 2026-03-15

> Status: **Phase 6 W1-W3 implemented on desktop. W3 ships device registry, desktop peer connection, manual bootstrap-token connect, and safe brain handoff.**

This document describes ADE's multi-device sync architecture: cr-sqlite CRDT replication, the WebSocket sync protocol, the brain/viewer device model, and the security model for device communication.

---

## Table of Contents

- [Overview](#overview)
- [cr-sqlite CRDT Integration](#cr-sqlite-crdt-integration)
- [WebSocket Sync Protocol](#websocket-sync-protocol)
- [Device Registry and Brain/Viewer Model](#device-registry-and-brainviewer-model)
- [Sync Topology and Changeset Flow](#sync-topology-and-changeset-flow)
- [Security Model](#security-model)
- [Implementation Status](#implementation-status)

---

## Overview

ADE syncs all application state across devices using **cr-sqlite** (a SQLite CRDT extension) over a **WebSocket transport**. The design is local-first with zero cloud dependency:

- One machine per project is the **brain** (runs agents, missions, orchestrator, AI compute).
- All other connected devices are **viewers/controllers** (real-time state, issue commands).
- State replication uses conflict-free replicated relations (CRRs) with last-writer-wins per column.
- Code syncs via git. App state syncs via cr-sqlite. Secrets never sync.

---

## cr-sqlite CRDT Integration

### Loading the Extension

- Desktop and headless MCP load `cr-sqlite` through the shared `openKvDb(...)` path in [`apps/desktop/src/main/services/state/kvDb.ts`](/Users/admin/Projects/ADE/apps/desktop/src/main/services/state/kvDb.ts).
- The current W1 implementation uses Node's native `node:sqlite` driver plus a vendored `crsqlite` loadable extension on desktop/macOS.
- iOS remains a future native extension integration in W5.

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

- Brain runs a WebSocket server (default port 8787) embedded in the Electron main process.
- JSON-framed cr-sqlite changesets with zlib compression for large batches.
- Heartbeat ping/pong at 30-second intervals for connection health.

### Connection Flow

1. Peer connects with host, port, and bootstrap token.
2. Brain validates the bootstrap token.
3. Peer sends its current `db_version`.
4. Brain sends all changesets since that version.
5. Continuous bidirectional sync begins.

### Sub-Protocols

| Sub-Protocol | Purpose | Used By |
|---|---|---|
| **Changeset sync** | Bidirectional cr-sqlite changeset exchange | All devices |
| **File access** | Request/response for file reads, directory listings, writes | iOS Files tab, desktop remote viewing |
| **Terminal stream** | Subscribe to terminal session output from brain | iOS Work tab |
| **Command routing** | Send execution commands to brain | All non-brain devices |

### Reconnection

Automatic reconnection with version-based catch-up on connection drops. Peers resume from their last known `db_version`, so no data is lost.

---

## Device Registry and Brain/Viewer Model

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

Brain authority is stored separately in a synced singleton `sync_cluster_state` row:

| Field | Description |
|---|---|
| `cluster_id` | Singleton cluster key (`default`) |
| `brain_device_id` | Current brain device |
| `brain_epoch` | Monotonic handoff counter |
| `updated_at` | Last handoff timestamp |
| `updated_by_device_id` | Device that last changed brain ownership |

### Brain Designation

- Explicit user action: "Make this device the brain" in Settings > Sync.
- Only one brain per project at a time.
- W3 supports desktop brains and desktop viewers. iOS remains future work.

### Brain Transfer Protocol

1. Transfer preflight checks for live blockers: active missions, running chat turns, live PTY sessions, and running managed processes.
2. Paused missions, CTO history/idle threads, and idle or ended agent chats are treated as durable synced state and survive handoff.
3. Final sync flush completes.
4. `sync_cluster_state.brain_device_id` moves to the new device and `brain_epoch` increments.
5. New brain starts the host lifecycle, old brain demotes to viewer/standalone as needed.

### Device Discovery

- W3 uses manual host/port/bootstrap-token entry in Settings > Sync.
- mDNS discovery, Tailscale address selection, QR pairing, and secure revocation remain W4 work.

---

## Sync Topology and Changeset Flow

### What Syncs Where

| Data Category | Sync Mechanism | Devices |
|---|---|---|
| All 103 database tables | cr-sqlite CRRs | All devices (desktop + iOS) |
| Source code files | git push/pull | Desktop peers only |
| `.ade/agents/`, `.ade/context/`, `.ade/local.yaml` | git | Desktop peers only |
| `.ade/local.secret.yaml` | **Never syncs** | Machine-specific |
| PTY processes, worktree dirs, cache, transcripts | **Never syncs** | Machine-specific |

### Changeset Flow Diagram

```
┌──────────┐   changesets    ┌──────────┐   changesets    ┌──────────┐
│  iPhone  │ ◄─────────────► │  Brain   │ ◄─────────────► │  Mac #2  │
│ (viewer) │   WebSocket     │ (Mac #1) │   WebSocket     │ (viewer) │
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
- **Execution operations** (create worktree, run terminal command, create PR): send command to brain via WebSocket. Brain executes, state changes sync back.

---

## Security Model

### Device Pairing

- W3 uses a shared machine-local bootstrap token stored at `.ade/secrets/sync-bootstrap-token`.
- The current brain surfaces that token in Settings > Sync for manual desktop-to-desktop connection.
- QR pairing, per-device secrets, OS keychain storage, and secure revoke remain W4 work.
- W3 should be treated as trusted-LAN-only scaffolding. The host currently listens on all interfaces and does not yet add W4 hardening such as per-device secrets, revocation, tighter network policy, or transport upgrades.

### Transport Security

- WebSocket connections are authenticated with the pairing token on every connection.
- Tailscale connections use WireGuard encryption (peer-to-peer, no cloud relay).
- LAN connections rely on pairing token validation. TLS is not required for localhost/LAN but can be added.
- In W3, this is still bootstrap-token auth rather than final pairing auth. Use it only on networks you trust. W4 is responsible for replacing this with secure pairing, revocation, and better network posture.

### Secret Isolation

- `.ade/local.secret.yaml` (API keys, external MCP configs) is machine-specific and never syncs.
- Linear credentials, GitHub tokens, and provider API keys remain on the brain only.
- Each device stores its own pairing secret in its OS keychain.

### Agent Execution Isolation

- Agent processes (CTO heartbeats, worker activations, mission orchestration, embedding worker) run only on the brain.
- Non-brain devices never spawn agent processes.
- Commands from non-brain devices are validated and executed by the brain.

---

## Implementation Status

| Component | Status | Notes |
|---|---|---|
| cr-sqlite extension loading | Implemented | Shared `openKvDb(...)` adapter |
| CRR marking for eligible tables | Implemented | Dynamic startup migration |
| Changeset extraction/application | Implemented | `AdeDb.sync.exportChangesSince/applyChanges` |
| WebSocket sync server | Implemented (desktop) | Phase 6 W2 |
| Sync protocol (JSON + zlib) | Implemented (desktop) | Phase 6 W2 |
| File access sub-protocol | Implemented (desktop) | Phase 6 W2 |
| Terminal stream sub-protocol | Implemented (desktop) | Phase 6 W2 |
| Device registry table | Implemented (desktop) | Phase 6 W3 |
| Desktop peer client + manual connect | Implemented (desktop) | Phase 6 W3 |
| Brain election + transfer | Implemented (desktop) | Phase 6 W3 |
| Device pairing (QR + keychain) | Planned — W2 currently uses bootstrap-token scaffolding only | Phase 6 W4 |
| Tailscale integration | Planned | Phase 6 W4 |
| Command routing | Planned — W2 ships `work.runQuickCommand` only for transport validation | Phase 6 W10 |
| Lane portability (desktop-to-desktop) | Planned | Phase 6 W11 |

**Overall status**: W1-W3 are now in place on desktop. ADE has a sync-capable local database, desktop WebSocket transport, device registry, Settings-based manual desktop peer connection, and safe brain handoff with explicit blocker rules. Real pairing, discovery, Tailscale, iOS clients, and broader command routing remain future Phase 6 work.

### Deferred follow-up

- W4 security hardening:
  - Replace the shared bootstrap token with per-device pairing secrets and OS keychain storage.
  - Add secure revocation and the intended W4 network posture for desktop peers.
  - Revisit default host binding and discovery once pairing is in place.
- Pre-W5 performance work:
  - The `node:sqlite` adapter currently prepares statements per call.
  - This is acceptable for W3, but statement caching should be revisited before iOS peers and heavier multi-peer sync loads arrive.
