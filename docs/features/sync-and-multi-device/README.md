# Sync and Multi-Device

ADE syncs live runtime state across a host desktop and any connected
controllers (other desktops, iPhones) using **cr-sqlite** as a CRDT-backed
replication layer over a **WebSocket** transport. The design is local-first,
peer-to-peer, and has zero cloud dependency — two machines on the same LAN
(or Tailscale tailnet) converge their application state directly.

This README covers the sync model, the host/controller role split, what
does and does not travel, and the layers that implement it. Deep-dives:

- `crdt-model.md` — cr-sqlite CRR retrofit, schema implications, merge
  semantics, and the iOS pure-SQL emulation layer.
- `ios-companion.md` — the iPhone controller path: SwiftUI app, native
  SQLite, pairing, tab structure, command routing from phone to host.
- `remote-commands.md` — the `syncRemoteCommandService` registry that
  turns controller actions into host-executed mutations. **Branch-modified
  at time of writing** (see that doc for specifics).

## Who participates

- **Host** — a desktop-class machine running ADE's full Electron main
  process. It owns agent execution, PTYs, worktrees, worker heartbeats,
  and the orchestrator. There is **one** host per live sync cluster at a
  time.
- **Controllers** — other connected devices. Phones are always
  controllers (they cannot be hosts). A second Mac can either be
  independent (Git-only, its own local ADE runtime) or deliberately
  attach to an existing host as a controller.
- **Cluster state** — a singleton `sync_cluster_state` row with
  `brain_device_id` and `brain_epoch` tracks which device currently
  owns execution. Handoff bumps `brain_epoch` and rewrites
  `brain_device_id`.

The name `brain_*` remains in the database and protocol as a legacy
internal identifier; it is not user-facing. All UI and current docs
use "host".

## What syncs, what does not

| Data category | Sync mechanism | Devices |
|---|---|---|
| Replicated ADE runtime tables in `.ade/ade.db` | cr-sqlite CRRs over WebSocket | All connected devices |
| Source code files | `git push`/`git pull` | Desktop peers only |
| Shared ADE scaffold/config (`.ade/.gitignore`, `.ade/ade.yaml`, `.ade/cto/identity.yaml`, human-authored templates/skills, repo-backed workflow YAML under `.ade/workflows/linear/**`) | Git | Desktop peers only |
| Local overrides (`.ade/local.yaml`, `.ade/local.secret.yaml`) | **Never syncs** | Machine-specific |
| Worktrees, PTY processes, caches, transcripts, artifacts, sockets, secrets, connection drafts | **Never syncs** | Machine-specific |

Two devices in the same cluster do **not** have identical `.ade/`
folders. Git gives them the same tracked scaffold; sync gives them the
same replicated DB state; each device still has its own local runtime
directories.

Two disconnected desktops do **not** have a shared live session. They
converge code through Git and they converge the narrow tracked ADE
scaffold through Git, but live mission/chat/process state converges
only when they join the same sync cluster.

## Architecture layers

```
┌────────────────────────────────────────────────────────────────┐
│ Renderer / iOS SwiftUI                                         │
│   - reads local SQLite (instant, offline)                      │
│   - writes: state-only → local, execution → remote command     │
└────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────────┐
│ Sync transport (ws)                                            │
│   - SyncEnvelope: hello, pairing, changeset_batch,             │
│     heartbeat, file_request/response, terminal_*, chat_*,      │
│     brain_status, command / command_ack / command_result       │
│   - JSON payloads; gzip+base64 above threshold (4KB default)   │
└────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────┐  ┌──────────────────────────┐
│ Host side                        │  │ Controller side          │
│   - syncHostService (WS server)  │  │   - syncPeerService (WS  │
│   - syncRemoteCommandService     │  │     client, auto-reconn) │
│   - deviceRegistryService        │  │   - local AdeDb          │
│   - AdeDb.sync                   │  │   - command queue        │
└──────────────────────────────────┘  └──────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────────┐
│ cr-sqlite CRDT layer                                           │
│   - desktop: loadable .dylib extension, crsql_as_crr()         │
│   - iOS: pure-SQL emulation in Database.swift                  │
│   - AdeDb.sync: getSiteId, getDbVersion,                       │
│     exportChangesSince, applyChanges                           │
└────────────────────────────────────────────────────────────────┘
```

Host-side service files
(`apps/desktop/src/main/services/sync/`):

- `syncHostService.ts` (1,137 lines) — WebSocket server, connection
  acceptance, hello/pairing handling, per-peer state, changeset fan-out,
  terminal/chat subscription bridging.
- `syncPeerService.ts` (464 lines) — WebSocket **client**. The host
  can run this too when it is a peer of a different host during a
  handoff rehearsal or controller-to-host role swap. On iOS, an
  equivalent Swift implementation lives in `apps/ios/ADE/Services/SyncService.swift`.
- `syncProtocol.ts` (120 lines) — envelope encode/decode with gzip
  threshold (`DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024`).
  Protocol version is `1`. Default host port is `8787`.
- `syncService.ts` (714 lines) — orchestrator that wires host,
  peer, device registry, draft persistence, and exposes the IPC
  entry points used by the renderer Settings > Sync surface.
- `deviceRegistryService.ts` (427 lines) — reads/writes the synced
  `devices` table and `sync_cluster_state` singleton.
- `syncPairingStore.ts` (128 lines) — local pairing-secret storage
  per-peer for W4 pairing flow.
- `syncRemoteCommandService.ts` (1,207 lines) — command action
  registry (lanes, chat, git, PR, sessions, conflicts). Documented
  separately in `remote-commands.md`.

Client-side (iOS) service files (`apps/ios/ADE/Services/`):

- `Database.swift` (~2,200 lines) — native SQLite3 + pure-SQL CRR
  emulation (triggers + custom SQLite functions).
- `SyncService.swift` — WebSocket client, envelope encoding
  (zlib via `zlib`), command routing, keychain integration.
- `KeychainService.swift` — iOS Keychain Services for paired device
  secrets.

## Device registry and cluster state

A synced `devices` table keyed on `device_id` carries durable device
metadata. Fields (see `SyncDeviceRecord`):

| Field | Purpose |
|---|---|
| `device_id` | Unique device identifier |
| `site_id` | Stable cr-sqlite site id |
| `name` | User-assigned device name |
| `platform` | `macOS`, `iOS`, `linux`, `windows`, `unknown` |
| `device_type` | `desktop`, `phone`, `vps`, `unknown` |
| `created_at` / `updated_at` / `last_seen_at` | Timestamps |
| `last_host` / `last_port` | Last manual-connect address |
| `tailscale_ip` | Tailscale IP if available |
| `ip_addresses` (JSON array) | LAN IPs |
| `metadata_json` | Future-safe extension bag |

Host authority is separate: `sync_cluster_state` is a singleton row
keyed on `cluster_id = "default"` with `brain_device_id`,
`brain_epoch`, `updated_at`, `updated_by_device_id`.

## Host selection and transfer

Host designation is an explicit user action in Settings > Sync. Only
one host owns execution at a time. Phones are controller-only and
never elect to host.

Transfer:

1. Preflight blockers — active missions, running chat turns, live
   PTYs, running managed processes. Paused missions, CTO history/idle
   threads, and idle/ended chats are treated as durable synced state
   and survive a handoff.
2. Final sync flush on the old host.
3. `sync_cluster_state.brain_device_id` rewrites, `brain_epoch`
   increments.
4. New host starts its host lifecycle. Old host demotes.

A second desktop that simply pulls the repo without joining a sync
cluster is its own local ADE machine for execution — that is not the
same as being part of the cluster. Multi-host active-active execution
is not supported.

## Device discovery

- **W3**: manual host/port/bootstrap-token entry in Settings > Sync.
- **W4**: numeric-code pairing and per-device secrets (stored in OS
  keychain) are implemented.
- **W5**: QR pairing presentation/scanning shell shipped; needs more
  live validation.
- **W6+**: mDNS discovery, Tailscale address selection, and final
  network hardening remain open work.

The bootstrap token lives at `.ade/secrets/sync-bootstrap-token`. The
current host displays it under Settings > Sync for manual
desktop-to-desktop connection.

## Sync protocol (summary)

Envelopes are JSON with fields:

```ts
{
  version: 1,
  type: "hello" | "hello_ok" | "hello_error" | "pairing_request" |
        "pairing_result" | "changeset_batch" | "heartbeat" |
        "file_request" | "file_response" |
        "terminal_subscribe" | "terminal_unsubscribe" |
        "terminal_snapshot" | "terminal_data" | "terminal_exit" |
        "chat_subscribe" | "chat_unsubscribe" | "chat_event" |
        "brain_status" | "command" | "command_ack" | "command_result",
  requestId: string | null,
  compression: "none" | "gzip",
  payloadEncoding: "json" | "base64",
  payload: ...,
  uncompressedBytes?: number, // gzip only
}
```

Payloads above `DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES` (4 KB) are
gzipped and base64-encoded. `parseSyncEnvelope` rejects a mismatch
between `compression` and `payloadEncoding` and rejects unsupported
protocol versions.

Heartbeat interval is 30 seconds. Reconnection resumes from the
last-known `db_version` so no changesets are lost.

### Sub-protocols at a glance

| Sub-protocol | Purpose | Used by |
|---|---|---|
| Changeset sync | Bidirectional cr-sqlite row exchange | All devices |
| File access | On-demand file reads, listings, writes | iOS Files, desktop remote viewing |
| Terminal stream | Subscribe to PTY output from host | iOS Work tab |
| Chat stream | Agent chat transcript events (snapshot + incremental) | iOS Work tab, controller chat |
| Command routing | Send named actions (`chat.send`, `lanes.create`, `git.push`, etc.) | All non-host devices |
| Brain status | Host broadcasts cluster/version status | All devices |

## Command routing and execution isolation

Controllers never run agent processes. CTO heartbeats, worker
activations, mission orchestration, and the embedding worker are
host-exclusive.

Two categories of controller write:

- **State-only** (create lane metadata row, update a setting): written
  locally, propagates through cr-sqlite changesets.
- **Execution** (create worktree, run a terminal command, create a
  PR, send a chat message): issued as a `command` envelope to the
  host, which runs it and replies with `command_ack` + `command_result`.
  State changes the command produced flow back through normal
  changeset sync.

Every command action has a `SyncRemoteCommandPolicy`:

```ts
{
  viewerAllowed: boolean;
  requiresApproval?: boolean;
  localOnly?: boolean;
  queueable?: boolean;
}
```

The host-declared policy is the authority: the iOS app reads
descriptors via `chat.models`, `lanes.list`, etc. and gates UI
actions accordingly. Hardcoded mobile assumptions would be stale
after a host-side policy change, so the phone trusts the host.

See `remote-commands.md` for the full action set and a note on the
current branch modifications to `syncRemoteCommandService.ts`.

## Security model

- **Pairing**: W3 shared bootstrap token from
  `.ade/secrets/sync-bootstrap-token`. W4 added numeric-code pairing
  and per-device secrets.
- **Secrets never sync.** `.ade/local.secret.yaml` (provider API keys,
  external MCP configs) is per-machine. Linear tokens, GitHub tokens,
  and AI provider tokens stay on the host.
- **Transport**: WebSocket auth via pairing/bootstrap token on every
  connection. Tailscale WireGuard encryption applies when over
  tailnet; LAN connections rely on pairing token validation. TLS is
  not enforced for localhost/LAN. Currently (W3) the host listens on
  all interfaces — intended for trusted LAN until W4 hardening
  lands.
- **Secret isolation**: each device stores its own pairing secret in
  its OS keychain.
- **Execution isolation**: the host runs agents; controllers do not.

## Current implementation status

| Component | Status |
|---|---|
| cr-sqlite extension loading (desktop) | Implemented |
| Pure-SQL CRR emulation (iOS) | Implemented |
| CRR marking for eligible tables | Implemented (dynamic startup) |
| Changeset extraction/application | Implemented |
| WebSocket sync server | Implemented (desktop) |
| Sync protocol (JSON + zlib) | Implemented |
| File access sub-protocol | Implemented |
| Terminal stream sub-protocol | Implemented |
| Chat stream sub-protocol | Implemented |
| Device registry table | Implemented |
| Desktop peer client + manual connect | Implemented |
| Host election + transfer | Implemented |
| Shared ADE scaffold portability for desktop clones | Implemented |
| Numeric-code pairing + per-device secrets | Implemented |
| iOS local replicated DB | Implemented |
| iOS Lanes / Files / Work / PRs / Settings tabs | Implemented |
| QR pairing UX (shell) | Implemented; needs live validation breadth |
| Tailscale integration | Planned |
| Lane portability desktop-to-desktop | Planned |

## Gotchas

- **CRR retrofit strips non-PK UNIQUE constraints.** Upserts on
  synced tables must target the primary key only. Use explicit
  select-then-update for non-PK merge cases.
- **FTS indexes don't sync.** `unified_memories_fts` is local-only
  and is rebuilt after applying remote changes that touched
  `unified_memories`.
- **Bootstrap token must match on every connection.** A changed token
  invalidates all existing connections until paired devices are
  re-provisioned.
- **The host listens on all interfaces in W3.** Treat the current
  posture as trusted-LAN only. W4 hardening (tighter binding,
  per-device secrets for revocation) is in progress.
- **`brain_*` is legacy naming.** In new code prefer "host" / "cluster
  owner" nomenclature; database column names are kept for
  compatibility.
- **iOS and desktop do not share the cr-sqlite binary.** iOS uses a
  pure-SQL emulation because Apple platforms reject
  `sqlite3_load_extension()` and `sqlite3_auto_extension()`. Changeset
  wire format is identical; cr-sqlite feature parity is **not**
  guaranteed — any desktop-only cr-sqlite feature that ADE grows to
  depend on must also be implementable in SQL triggers on iOS.
- **Controller command queues replay on reconnect.** If the user
  fires a `chat.send` while disconnected, the iOS app stores the
  command locally with a "pending sync" indicator and replays on
  reconnect. Do not assume synchronous semantics from the phone side.
