# Multi-Device Sync Architecture

> Roadmap reference: `docs/final-plan/phase-6.md` is the canonical Phase 6 plan.

> Last updated: 2026-03-15

> Status: **Phase 6 W1-W3 live cluster sync is implemented on desktop. W3 closes with a narrow Git-tracked ADE scaffold/config layer for desktop clones.**

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

ADE syncs application state across devices using **cr-sqlite** (a SQLite CRDT extension) over a **WebSocket transport**. The design is local-first with zero cloud dependency:

- One machine per connected cluster is the **brain** (runs agents, missions, orchestrator, AI compute).
- All other connected devices are **viewers/controllers** (real-time state, issue commands).
- State replication uses conflict-free replicated relations (CRRs) with last-writer-wins per column.
- Code syncs via git. Live app state syncs via cr-sqlite. A small shared ADE scaffold/config layer also travels through tracked ADE files so another desktop clone does not look like a brand-new ADE project. Secrets never sync.

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
- Only one brain per connected live cluster at a time.
- W3 supports desktop brains and desktop viewers. iOS remains future work.

Desktop nuance:

- A Mac that opens the repo independently without connecting is still a standalone desktop brain for its own local execution.
- That does **not** make it part of the same live cluster as another Mac.
- W3's portability requirement is therefore not "multi-brain active-active execution". It is only "a desktop clone should inherit the shared ADE scaffold/config layer from Git even before it connects to a live brain."

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
| All replicated ADE runtime tables in `.ade/ade.db` | cr-sqlite CRRs | All connected devices |
| Source code files | git push/pull | Desktop peers only |
| Shared ADE scaffold/config (`.ade/.gitignore`, `.ade/ade.yaml`, `cto/identity.yaml`, human-authored templates/skills, repo-backed workflow files when present) | git | Desktop peers only |
| Local overrides (`.ade/local.yaml`, `.ade/local.secret.yaml`) | **Never syncs** | Machine-specific |
| Worktrees, PTY processes, cache, transcripts, artifacts, sockets, secrets | **Never syncs** | Machine-specific |

Two connected devices therefore do **not** have identical `.ade/` folders:

- Git gives them the same tracked project scaffold.
- ADE sync gives them the same replicated application state.
- Each device still keeps its own local runtime directories.

Two disconnected desktop brains also do **not** have a shared live cluster by default:

- code convergence happens through git
- the narrow shared ADE scaffold/config layer converges through tracked `.ade/`
- live mission/chat/process state converges only when they join the same ADE sync cluster

In W3, the recommended multi-desktop posture is:

- one machine acts as the **brain** and owns execution plus local worktrees
- other desktops attach as **viewers/controllers**
- brain handoff is optional, not required for day-to-day second-device use

That is not the entire desktop story anymore. W3 also requires a small "pick this repo up on another desktop without ADE bootstrap confusion" posture:

- a desktop that clones or pulls the repo should inherit the shared ADE scaffold/config/identity files from tracked `.ade/`
- joining a live brain should improve freshness and expose live runtime state
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
- if a feature only matters for a connected live cluster, keep it in ADE sync
- if a feature is machine-bound, keep it local

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
| Shared ADE scaffold/config portability for desktop clones | Implemented | Phase 6 W3 |
| Device pairing (QR + keychain) | Planned — W2 currently uses bootstrap-token scaffolding only | Phase 6 W4 |
| Tailscale integration | Planned | Phase 6 W4 |
| Command routing | Planned — W2 ships `work.runQuickCommand` only for transport validation | Phase 6 W10 |
| Lane portability (desktop-to-desktop) | Planned | Phase 6 W11 |

**Overall status**: W1-W3 are now in place on desktop. ADE has a sync-capable local database, desktop WebSocket transport, device registry, Settings-based manual desktop peer connection, safe brain handoff with explicit blocker rules, and the narrow shared ADE scaffold/config layer for desktop clones. Real pairing, discovery, Tailscale, iOS clients, and broader command routing remain future Phase 6 work.

### Deferred follow-up

- W4 security hardening:
  - Replace the shared bootstrap token with per-device pairing secrets and OS keychain storage.
  - Add secure revocation and the intended W4 network posture for desktop peers.
  - Revisit default host binding and discovery once pairing is in place.
- Pre-W5 performance work:
  - The `node:sqlite` adapter currently prepares statements per call.
  - This is acceptable for W3, but statement caching should be revisited before iOS peers and heavier multi-peer sync loads arrive.
