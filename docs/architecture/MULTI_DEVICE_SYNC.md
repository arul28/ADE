# Multi-Device Sync Architecture

> Roadmap reference: `docs/final-plan/phase-6.md` is the canonical Phase 6 plan.

> Last updated: 2026-03-15

> Status: **Phase 6 planned, not yet implemented.**

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

- Desktop: cr-sqlite extension loaded into the existing sql.js WASM runtime used by `kvDb.ts`.
- iOS: cr-sqlite loaded as a native SQLite extension via SQLite.swift.
- Zero changes to existing SQL code required.

### CRR Marking

All database tables (currently 103) are marked as conflict-free replicated relations:

```sql
SELECT crsql_as_crr('table_name');
```

**Excluded**: The FTS4 virtual table (`unified_memories_fts`) is not a CRR. Each device rebuilds its FTS index locally from the synced `unified_memories` table.

### Merge Semantics

- Last-writer-wins per column with Lamport timestamps.
- Each device has a unique site ID for CRDT merge identity.
- New columns and new tables are handled transparently -- adding a table requires one `crsql_as_crr` call.

### Changeset Extraction and Application

```sql
-- Extract changes since a version
SELECT * FROM crsql_changes WHERE db_version > ?;

-- Apply remote changes
INSERT INTO crsql_changes(...);
```

After applying remote changesets that touch `unified_memories`, affected FTS rows are rebuilt.

---

## WebSocket Sync Protocol

### Transport

- Brain runs a WebSocket server (default port 8787) embedded in the Electron main process.
- JSON-framed cr-sqlite changesets with zlib compression for large batches.
- Heartbeat ping/pong at 30-second intervals for connection health.

### Connection Flow

1. Peer connects with pairing token + device type (desktop/iOS).
2. Brain validates the token against the device registry.
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

A `devices` table (itself synced via cr-sqlite) stores:

| Field | Description |
|---|---|
| `device_id` | Unique device identifier |
| `name` | User-assigned device name |
| `platform` | `macOS`, `iOS`, `linux` |
| `device_type` | `desktop`, `phone`, `vps` |
| `is_brain` | Whether this device is the brain |
| `last_seen` | Last connection timestamp |
| `ip_addresses` | LAN IPs |
| `tailscale_ip` | Tailscale IP (if available) |

### Brain Designation

- Explicit user action: "Make this device the brain" in Settings > Devices.
- Only one brain per project at a time.
- Phones cannot be brains.

### Brain Transfer Protocol

1. Current brain stops all agents and orchestrator processes.
2. Final sync flush to all connected peers.
3. Brain flag transfers to new device.
4. New brain starts accepting agent work.

### Device Discovery

- **LAN**: mDNS/Bonjour for zero-config discovery.
- **Cross-network**: Tailscale IPs used when LAN fails (optional, peer-to-peer WireGuard, no cloud relay).

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

- First-time: brain generates a QR code (encodes IP/port + one-time pairing token) or a 6-digit numeric code.
- Pairing establishes a shared secret stored in the OS keychain (macOS Keychain / iOS Keychain).
- After pairing, devices reconnect automatically -- no re-auth required.
- Revoking a device removes its pairing token and disconnects it.

### Transport Security

- WebSocket connections are authenticated with the pairing token on every connection.
- Tailscale connections use WireGuard encryption (peer-to-peer, no cloud relay).
- LAN connections rely on pairing token validation. TLS is not required for localhost/LAN but can be added.

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
| cr-sqlite extension loading | Planned | Phase 6 W1 |
| CRR marking for all tables | Planned | Phase 6 W1 |
| Changeset extraction/application | Planned | Phase 6 W1 |
| WebSocket sync server | Planned | Phase 6 W2 |
| Sync protocol (JSON + zlib) | Planned | Phase 6 W2 |
| File access sub-protocol | Planned | Phase 6 W2 |
| Terminal stream sub-protocol | Planned | Phase 6 W2 |
| Device registry table | Planned | Phase 6 W3 |
| Brain election + transfer | Planned | Phase 6 W3 |
| Device pairing (QR + keychain) | Planned | Phase 6 W4 |
| Tailscale integration | Planned | Phase 6 W4 |
| Command routing | Planned | Phase 6 W10 |
| Lane portability (desktop-to-desktop) | Planned | Phase 6 W11 |

**Overall status**: Not yet implemented. All components are planned for Phase 6. A cr-sqlite spike should be the first step to validate WASM compatibility and merge semantics.
