# Sync and Multi-Device

ADE syncs live runtime state across an ADE machine runtime and any connected
controllers (other Macs, iPhones) using **cr-sqlite** as a CRDT-backed
replication layer over a **WebSocket** transport. The design is local-first,
peer-to-peer, and has zero cloud dependency — two machines on the same LAN
(or Tailscale tailnet) converge their application state directly.

This README covers the sync model, the runtime/controller role split, what
does and does not travel, and the layers that implement it. Deep-dives:

- `crdt-model.md` — cr-sqlite CRR retrofit, schema implications, merge
  semantics, and the iOS pure-SQL emulation layer.
- `ios-companion.md` — the iPhone controller path: SwiftUI app, native
  SQLite, pairing, tab structure, command routing from phone to runtime.
- `remote-commands.md` — the `syncRemoteCommandService` registry that
  turns client actions into runtime-executed mutations.

## Where the sync authority runs

The sync authority is the machine-owned `ade serve` runtime in
`apps/ade-cli/`. The desktop renderer is just another client of that
runtime — it attaches through the local runtime connection pool, exactly
the same way `ade code` and the iOS app do.

This is the inversion to internalise: the desktop is no longer the
sync authority. A desktop window that is bound to a remote runtime is therefore
not the authority either; the remote `ade serve` on that machine owns the
authority role for projects opened on it.

The legacy in-process desktop sync host still exists in source for
diagnostics. It is **disabled by default** and only activates when
`ADE_ENABLE_DESKTOP_SYNC_HOST=1` is set (and the kill-switch
`ADE_DISABLE_SYNC_HOST=1` is not set). Production builds and dev
sessions both leave it off; everything below describes the runtime-hosted
path unless explicitly noted.

## Who participates

- **Machine runtime** — the per-channel, per-machine `ade serve` runtime. It owns agent
  execution, PTYs, worktrees, worker heartbeats, the orchestrator, and
  the sync WebSocket server. It can hold **multiple** open projects at
  once, with one active sync project port at a time; a phone picks which
  project to bind to via the machine project catalog and reconnects
  internally when it switches projects.
- **Desktop renderer** — a client of the local runtime over the
  runtime IPC bridge. The same renderer can also bind to a remote
  runtime (the remote-runtime feature), in which case sync state lives
  on the remote machine.
- **iOS app** — client/controller-only, always. Connects to a runtime over
  WebSocket using the same `SyncEnvelope` protocol the desktop uses
  internally.
- **Cluster state** — a singleton `sync_cluster_state` row with
  the legacy columns `brain_device_id` and `brain_epoch` tracks which
  device currently owns execution within a cluster.

The older terms "brain" and "host" still appear in code, schema, and
protocol types. In the current product vocabulary, they refer to the
same thing: the runtime that is the current **sync authority**.

## What syncs, what does not

| Data category | Sync mechanism | Devices |
|---|---|---|
| Replicated ADE runtime tables in `.ade/ade.db` | cr-sqlite CRRs over WebSocket | All connected devices |
| Source code files | `git push`/`git pull` | Desktop peers only |
| Shared ADE scaffold/config (`.ade/.gitignore`, `.ade/ade.yaml`, human-authored templates/skills, repo-backed workflow YAML under `.ade/workflows/linear/**`) | Git | Desktop peers only |
| Local overrides (`.ade/local.yaml`, `.ade/local.secret.yaml`) | **Never syncs** | Machine-specific |
| Worktrees, PTY processes, caches, transcripts, artifacts, sockets, secrets, connection drafts | **Never syncs** | Machine-specific |

Two devices in the same cluster do **not** have identical `.ade/`
folders. Git gives them the same tracked scaffold; sync gives them the
same replicated DB state; each device still has its own local runtime
directories.

Two disconnected desktops do **not** have a shared live session. They
converge code through Git and they converge the narrow tracked ADE
scaffold through Git, but live chat/process state converges
only when they join the same sync cluster (i.e. point at the same
running sync authority).

## Architecture layers

```
┌──────────────────────────────────────────────────────────────────┐
│ Renderer (Electron) / iOS SwiftUI                                │
│   - reads local SQLite (instant, offline)                        │
│   - writes: state-only → local; execution → remote command       │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ Desktop runtime IPC bridge (renderer → main → runtime)           │
│   - sync.* preload calls route through                           │
│     callProjectRuntimeSyncOr(method, params, fallback)           │
│   - prefers the remote runtime if the window is bound,           │
│     otherwise the local runtime                                  │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ ade-cli machine runtime (`ade serve`)                            │
│   - syncService — orchestrator, draft persistence, pin store     │
│   - syncHostService — WebSocket server, peers, project catalog   │
│   - syncRemoteCommandService — registry of executable actions    │
│   - deviceRegistryService — devices + cluster_state singleton    │
│   - hosts MULTIPLE projects per machine                          │
│   - exposes per-project sync ports behind one machine catalog     │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ Sync transport (ws)                                              │
│   - SyncEnvelope: hello, pairing, changeset_batch,               │
│     changeset_ack, heartbeat, file_request/response,             │
│     terminal_*, chat_*, brain_status (legacy name),              │
│     project_catalog/project_switch,                              │
│     command / command_ack / command_result                       │
│   - JSON payloads; gzip+base64 above threshold (4 KB default)    │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ cr-sqlite CRDT layer                                             │
│   - desktop/runtime: loadable .dylib extension, crsql_as_crr()   │
│   - iOS: pure-SQL emulation in Database.swift                    │
│   - AdeDb.sync: getSiteId, getDbVersion,                         │
│     exportChangesSince, applyChanges                             │
└──────────────────────────────────────────────────────────────────┘
```

## Source file map

The canonical sync implementation lives in the **ade-cli** runtime
package. The desktop tree only contains thin re-export proxies plus the
legacy fallback; do not edit the desktop copies expecting the runtime to
see your change.

Canonical files (`apps/ade-cli/src/services/sync/`):

- `syncService.ts` (~1,160 lines) — orchestrator that wires the runtime,
  peer client, device registry, draft persistence, pin store, and the
  per-project / per-runtime configuration. Builds the
  `projectCatalogProvider` so a runtime hosting multiple projects can
  hand a phone a catalog and react to `project_switch_request`. Accepts
  `forceHostRole` only as a legacy override; normal callers leave it
  false so a second runtime becomes a viewer instead of stealing the
  sync authority role.
- `syncHostService.ts` (~3,260 lines) — the WebSocket server. Owns
  connection acceptance, hello/pairing handshakes, per-peer state,
  changeset fan-out + ack tracking, terminal/chat subscription
  bridging, mobile terminal input/resize forwarding into subscribed
  PTYs, lane presence decoration, project catalog/switch envelopes,
  per-IP pairing rate limiter, and the Tailscale Serve / mDNS
  publication paths. Runtime kind is one of `desktop-embedded`,
  `headless`, `remote-stdio`, `desktop`, `daemon`, or `remote`.
- `syncPeerService.ts` (~580 lines) — WebSocket **client**. The runtime
  can run this too when it joins another runtime as a peer (handoff
  rehearsal, controller-to-authority swap). On iOS, an equivalent Swift
  implementation lives in `apps/ios/ADE/Services/SyncService.swift`.
- `syncProtocol.ts` (~150 lines) — envelope encode/decode with gzip
  threshold (`DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024`).
  Protocol version is `1`. Default host port is `8787`.
- `syncRemoteCommandService.ts` (~2,840 lines) — command registry
  (lanes, chat, git, PR, sessions, conflicts, files,
  `prs.getMobileSnapshot`, `lanes.presence.*`, `work.runQuickCommand`,
  `work.startCliSession`, `modelPicker.*`, …). Each registration carries a
  `SyncRemoteCommandDescriptor` with a **scope** label of
  `"runtime"` or `"project"`. The runtime rejects a `project`-scoped
  command when no project is open or when the caller did not bundle a
  matching `projectId` (see *Scope enforcement* below). Mobile /
  controller CLI launches resolve the target lane worktree before
  building provider argv/env so Agent Skill roots and
  `ADE_AGENT_SKILLS_DIRS` stay lane-aware.
  Model-picker commands read/write the same per-project CRR-backed
  favorites/recents store as desktop and the TUI; the sync service falls
  back to the DB-wired shared store when no explicit accessor is
  injected, so iOS never reads an empty process stub in production.
  Lane reparent commands parse the optional `stackBaseBranchRef`
  override and forward it to the runtime lane service so controllers can
  pick a specific branch to stack onto instead of always using the
  selected parent lane's branch.
- `deviceRegistryService.ts` (~670 lines) — synced `devices` table and
  `sync_cluster_state` singleton. When the local runtime joins another
  runtime as a viewer (`syncService.connect`), it wipes its existing
  `devices` and `sync_cluster_state` rows and then calls
  `db.sync.discardUnpublishedChangesForTables(["devices",
  "sync_cluster_state"])` so the resulting CRR DELETE rows are
  suppressed from outbound changesets. `syncService.connect` then calls
  `syncPeerService.acknowledgeLocalDbVersion()` to advance the
  outbound cursor past the suppressed range, ensuring a fresh viewer
  cannot accidentally erase the authority runtime's registry. See
  `crdt-model.md` for the underlying suppression mechanism.
- `syncPairingStore.ts` — validates `pairing_request` envelopes
  against `syncPinStore`, mints the durable per-device secret, and
  persists it into the `paired_devices` row (SQLite).
- `syncPinStore.ts` — on-disk storage for the user-set 6-digit
  pairing PIN at `~/.ade/secrets/sync-pin.json`, chmodded `0600`. The
  runtime never rotates the PIN; the operator sets or clears it from
  Settings > Sync.
- `resolveTailscaleCliPath.ts` — Tailscale CLI discovery used for the
  tailnet `tailscale serve` publication path.

Desktop client adapter (`apps/desktop/src/main/services/sync/`):

Every file in this directory is a one-line re-export of the canonical
ade-cli module, e.g. `syncHostService.ts` reads `export * from
"../../../../../ade-cli/src/services/sync/syncHostService";`. They exist
so the desktop's internal imports keep resolving while the canonical
implementation lives in the ADE runtime. The legacy in-process host
path in `apps/desktop/src/main/main.ts` (gated by
`ADE_ENABLE_DESKTOP_SYNC_HOST=1`) calls these re-exports and runs an
embedded runtime *inside* the Electron main process — kept only for
diagnostics. The unit tests next to the proxies still exercise the same
canonical code through the re-export.

Sync IPC routing in the renderer
(`apps/desktop/src/preload/preload.ts`): every `window.ade.sync.*` call
goes through `callProjectRuntimeSyncOr(method, params, localFallback)`,
which:

1. Resolves the active project binding. If the window is bound to a
   remote runtime, the call goes over `IPC.remoteRuntimeCallSync` to
   the remote runtime.
2. Otherwise, it calls `IPC.localRuntimeCallSync` against the local
   runtime. In-process sync IPC is used only when no runtime binding is
   available, such as tests or diagnostics.

During project transitions, mutating sync methods (`sync.setPin`,
`sync.clearPin`, `sync.connectToBrain`, lane-presence updates, model-picker
favorites/recents writes, and similar state changes) fail with the same
"Project is switching" guard used by project runtime actions. Read/status
calls can still refresh after the new binding is established. Remote sync calls
replay only for the explicit retry-safe allowlist (status/discovery/device/PIN reads,
lane-presence announce, and model-picker reads); other sync mutations surface
connection errors rather than being replayed after reconnect.

`sync.connectToBrain` is a legacy API name. New docs should call this a
runtime connection or sync authority connection.

The shared protocol DTOs (`SyncEnvelope`, controller-originated
`terminal_input` / `terminal_resize`, the mobile CLI launcher payload —
`SyncCliLaunchProvider`, `SyncStartCliSessionArgs`,
`SyncStartCliSessionResult` — and so on) live in
`apps/desktop/src/shared/types/sync.ts`. The CLI launcher's
provider-to-argv translation is shared with the desktop Work tab
through `apps/desktop/src/shared/cliLaunch.ts`.

iOS service files (`apps/ios/ADE/Services/`):

- `Database.swift` — native SQLite3 + pure-SQL CRR emulation (triggers
  + custom SQLite functions). Offline caches for files workspaces,
  directory listings, file contents, session pin/runtime state, chat
  snapshots, PR mobile snapshot persistence, and integration proposal
  fields mirrored from desktop schema.
- `SyncService.swift` — WebSocket client, envelope encoding (zlib),
  command routing, keychain integration, PIN-based pairing, lane
  presence announcements, terminal subscribe/unsubscribe tracking,
  terminal input/resize senders, mobile CLI launch/continuation,
  PR mobile snapshot fetch, live chat-event push listener, lane
  reparent payload building with the optional stack base-branch
  override, project home/catalog state, active-project scoping,
  unregistered-worktree discovery, and APNs push-token registration
  to the runtime.
- `KeychainService.swift` — iOS Keychain Services for paired device
  secrets (per-machine token shelf included).
- `LiveActivityCoordinator.swift` — owns the single workspace
  `Activity<ADESessionAttributes>` lifecycle and forwards
  push-to-start / per-activity update tokens to the runtime.

Notification services (`apps/desktop/src/main/services/notifications/`):

- `apnsService.ts` — HTTP/2 APNs client, ES256 JWT signing,
  `ApnsKeyStore` (`.p8` persisted via Electron `safeStorage` in the
  desktop process or an `EncryptedFileCredentialStore` rooted at
  `.ade/secrets/` when the runtime runs headless on a remote machine),
  `Http2ApnsTransport` (injectable via `ApnsTransport` for tests).
- `apnsBridgeService.ts` — exposes the `notifications_apns` ADE action
  domain (`getStatus`, `saveConfig`, `uploadKey`, `clearKey`,
  `sendTestPush`) so a desktop window bound to a remote runtime
  configures APNs against the remote runtime instead of the local
  Electron process. ade-cli `bootstrap.ts` constructs the service +
  key store and re-applies any persisted config on startup so push
  works without a desktop attached.
- `notificationMapper.ts` — pure domain-event → `MappedNotification`
  mapping across 13 categories in 4 families (chat, cto, pr, system).
- `notificationEventBus.ts` — `publishChatEvent`, `publishPrEvent`,
  `publishSystemEvent`, `sendTestPush`. Routes
  to APNs (alert + Live Activity update pushes) and/or in-app WS
  delivery, filtered by per-device `NotificationPreferences`.

iOS notification / widget files (under `apps/ios/`):

- `ADE/App/AppDelegate.swift`, `ADE/App/NotificationCategories.swift`,
  `ADE/App/DeepLinkRouter.swift`, `ADE/Models/NotificationPreferences.swift`.
- `ADENotificationService/NotificationService.swift` —
  `UNNotificationServiceExtension` (brand prefix, `threadIdentifier`,
  `interruptionLevel` / `relevanceScore`).
- `ADEWidgets/ADELiveActivity.swift`, `ADEWorkspaceWidget.swift`,
  `ADELockScreenWidget.swift`, `ADEControlWidget.swift` (Control
  Center widgets, iOS 18+).
- `ADE/Shared/ADESharedModels.swift`, `ADE/Models/RemoteModels.swift`,
  `ADE/Resources/DatabaseBootstrap.sql` (generated from desktop
  `kvDb.ts`).

## Multi-project runtimes and project switching

The machine runtime knows **every** project the user has opened on that machine
(within retention) and exposes them as a single catalog. The current
mobile transport is still per-active-project behind that machine: the
phone pairs with the machine once, sees the catalog, and reconnects to
the selected project's sync port when the user switches projects. The
phone flow:

1. Phone connects and sends `hello`. The runtime responds with
   `hello_ok` containing the current project catalog (when supported).
2. The phone renders the catalog as a project home — recent projects
   marked available/cached/unavailable, with `MobileProjectSummary`
   metadata (icon, lane snippets) supplied by the runtime.
3. The user taps a project → phone sends `project_switch_request`.
   The runtime's `prepareProjectConnection` runs, the runtime activates
   that project locally, and returns a `project_switch_result` with
   either a fresh `connection` payload or `connection: null` (the
   phone should reuse its existing pairing credentials and reconnect
   against the now-active project endpoint).
4. After the runtime acknowledges the switch, `completeProjectConnection`
   runs so the runtime can persist the new active project.

Project catalog snapshots are also chunked
(`MAX_PROJECT_CATALOG_ENVELOPE_BYTES = 768 KB`,
`maxProjectCatalogChunkBytes = 192 KB`) so a runtime with many projects
streams the catalog in `project_catalog_chunk` envelopes.

## Scope enforcement

`syncRemoteCommandService.register(action, policy, handler, scope)`
labels every command as `"runtime"` (machine-wide; doesn't need a
project binding) or `"project"` (must run inside an open project).
At dispatch time:

- If the command is `project`-scoped and the runtime has a `hostProjectId`
  but the caller did not include `requestedProjectId`, the runtime rejects
  the command with `"requires projectId"` (`code: missing_project`).
- If the command is `project`-scoped and the runtime has no project open,
  the runtime rejects it with `"requires an open project on this ADE
  machine"` (`code: project_not_open`).

A phone bound to a runtime-hosted catalog therefore must complete the
`project_switch` handshake before invoking project-scoped commands.

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

Sync authority is separate: `sync_cluster_state` is a singleton row
keyed on `cluster_id = "default"` with `brain_device_id`,
`brain_epoch`, `updated_at`, `updated_by_device_id`.

## Sync authority selection and transfer

Sync authority designation is an explicit user action in Settings > Sync. Only
one runtime owns execution at a time. Phones are controller-only and
never elect themselves.

Transfer:

1. Preflight blockers — running chat turns, live PTYs, running managed
   processes. CTO history/idle threads and idle/ended chats are treated as durable synced state
   and survive a handoff.
2. Final sync flush on the old authority runtime.
3. `sync_cluster_state.brain_device_id` rewrites, `brain_epoch`
   increments.
4. New authority runtime starts its sync lifecycle. Old authority runtime demotes.

A second desktop that simply pulls the repo without joining a sync
cluster is its own local ADE machine for execution — that is not the
same as being part of the cluster. Multi-runtime active-active execution
is not supported.

## Device discovery

- **Machine-to-machine**: manual address/port/bootstrap-token entry in
  Settings > Sync. The machine bootstrap token lives under
  `~/.ade/secrets` and legacy project-local tokens are migrated there
  on startup.
- **Project switch handoff carries auth.** `SyncProjectConnectionPayload`
  distinguishes `authKind: "bootstrap" | "paired"` and may carry a
  `pairedDeviceId` instead of a raw `token`. When a phone follows a
  desktop project switch, `prepareProjectConnection` returns the
  payload, `completeProjectConnection` runs after the runtime has
  acknowledged the switch, and the iOS client falls back to its
  per-machine saved token (keyed by machine identity / route / name in
  `KeychainService.tokenAccount`) when the desktop did not bundle a
  fresh credential.
- **Phone pairing**: user-set **6-digit PIN** stored on the runtime at
  `~/.ade/secrets/sync-pin.json`. The PIN is owned by the human
  operator — the runtime does not rotate it, does not time-expire it,
  and does not mint a one-shot code. The phone enters the same digits
  the user typed in the machine's Settings > Sync > Phone pairing sheet.
  Failed PIN attempts increment a per-IP counter; after 5 failures
  the runtime rejects further attempts from that IP for 10 minutes
  (`PAIR_FAILURE_THRESHOLD = 5`, `PAIR_COOLDOWN_MS = 10 * 60_000` in
  `syncHostService.ts`).
- **QR payload**: `SyncPairingQrPayload` is **version 2**. It carries
  machine identity, port, and address candidates only — it no longer
  embeds a pairing code or expiry. The phone still needs the PIN
  manually.
- **Address candidates**: the runtime advertises LAN IPs, the saved
  `lastHost` (when it matches the current set), the Tailscale IP, and
  `127.0.0.1` (`SyncAddressCandidateKind` includes `loopback`).
- **mDNS**: `publishLanDiscovery` builds a TXT record whose
  `addresses` CSV includes the Tailscale IP alongside LAN IPs. It also
  advertises `runtimeKind`, `runtimeVersion`, `projects`, and
  `projectCount`, so mobile can show a machine-first picker before it
  hydrates the full project catalog over the paired WebSocket. The runtime
  keeps a signature of `{ hostName, port, txt }` and re-publishes the
  announcement only when the signature changes, to avoid churn while IP
  addresses fluctuate. On macOS the runtime also forks a `dns-sd -R
  <serviceName> _ade-sync._tcp local <port> ...` child
  (`publishNativeLanDiscovery`) so the native mDNSResponder advertises
  the service alongside the Node-side `bonjour-service` registration —
  iOS Bonjour browsers see the machine even when the userland advertiser
  is throttled. The native child is killed on shutdown
  (`stopNativeLanDiscovery`). On startup the runtime also runs
  `parseNativeLanDiscoveryProcessList` to detect orphaned `dns-sd -R`
  processes from a previous ADE session that crashed without cleanup,
  and kills them before starting its own advertisement.
- **Machine-scoped pairing state**: phone pairing files live under the
  machine ADE home (`~/.ade/secrets/`): `sync-device-id`,
  `sync-bootstrap-token`, `sync-pin.json`, and
  `sync-paired-devices.json`. On upgrade, legacy per-project copies
  under `<project>/.ade/secrets/` are copied or merged into the machine
  store, with paired devices deduped by `deviceId`.
- **Tailscale Serve tailnet discovery**: when the runtime sees a usable
  `tailscale` CLI (via `ADE_TAILSCALE_CLI` or the macOS default
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`), it publishes
  the sync WebSocket port on the tailnet under the service name
  `svc:ade-sync` (`SYNC_TAILNET_DISCOVERY_SERVICE_NAME`) at the
  default port `8787` (`SYNC_TAILNET_DISCOVERY_SERVICE_PORT`). Status
  flows out through `SyncRoleSnapshot.tailnetDiscovery`
  (`SyncTailnetDiscoveryStatus`: `disabled | publishing | published |
  pending_approval | unavailable | failed`) plus `error` / `stderr`
  tails. The runtime tracks a `tailnetServeSignature` so re-publishing
  is a no-op when the `(serviceName, port, target)` tuple hasn't
  changed.

## Sync protocol (summary)

Envelopes are JSON with fields:

```ts
{
  version: 1,
  type: "hello" | "hello_ok" | "hello_error" | "pairing_request" |
        "pairing_result" | "changeset_batch" | "changeset_ack" |
        "heartbeat" | "file_request" | "file_response" |
        "terminal_subscribe" | "terminal_unsubscribe" |
        "terminal_snapshot" | "terminal_data" | "terminal_exit" |
        "terminal_input" | "terminal_resize" |
        "chat_subscribe" | "chat_unsubscribe" | "chat_event" |
        "brain_status" |
        "project_catalog_request" | "project_catalog" |
        "project_catalog_chunk" |
        "project_switch_request" | "project_switch_result" |
        "command" | "command_ack" | "command_result",
  projectId?: string | null, // present on project-scoped envelopes
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

`SyncHelloErrorPayload.code` is trimmed to `auth_failed |
invalid_hello`. `SyncPairingResultPayload.error.code` is one of
`invalid_pin | pin_not_set | pairing_failed`.

Heartbeat interval is 30 seconds. Desktop peers close after **two**
consecutive missed heartbeats; mobile peers get a wider grace window
(`MOBILE_SYNC_HEARTBEAT_MISS_LIMIT = 6`) because iOS can briefly suspend
foreground networking during app and route transitions. Reconnection
resumes from the last-known `db_version` so no changesets are lost.
Runtime-side batching keeps every row for a given `db_version` in the same
`changeset_batch`; otherwise an ack for a partial transaction would
advance the receiver past unsent rows.

`changeset_batch` envelopes carry a `batchId`; legacy batches without
one are decoded with a deterministic fallback so older desktops can
still sync. The receiver replies with a `changeset_ack` once
`applyChanges` commits (or with an error code on failure). The runtime and
phone keep outbound batches pending until the ack lands, retransmitting
on timeout so a dropped wifi blip cannot lose a batch.
`pendingChangesetPeerCount` is surfaced through `brain_status` for
diagnostics; `brain_status` is a legacy envelope name.

Mobile-originated `command` envelopes are deduplicated through a
short-lived `mobileCommandResultCache` (TTL 30 minutes, 512 entries)
plus a persisted journal, so a phone that retries the same
`commandId` after a reconnect receives the cached `command_ack` /
`command_result` instead of double-executing the action. Persisted
results are intentionally narrow: `work.runQuickCommand` and
`work.startCliSession` keep only the returned `sessionId` / `ptyId`
(and the `TerminalSessionSummary` for CLI launches), while failed
commands store a generic failure message instead of the original
payload.

### Sub-protocols at a glance

| Sub-protocol | Purpose | Used by |
|---|---|---|
| Changeset sync | Bidirectional cr-sqlite row exchange | All devices |
| File access | On-demand file reads, listings, writes | iOS Files, desktop remote viewing |
| Terminal stream/control | Subscribe to PTY output from the runtime; send input bytes and viewport resize events back to the subscribed PTY | iOS Work tab |
| Chat stream | Agent chat transcript events (subscribe snapshot + live `chat_event` push from the runtime's `agentChatService.subscribeToEvents` fan-out; polling survives as the reconnect-catchup path) | iOS Work tab, controller chat |
| Command routing | Send named actions (`chat.send`, `lanes.create`, `git.push`, `prs.getMobileSnapshot`, etc.) | Controller devices |
| Project switching | `project_catalog` + `project_switch_request/result` for multi-project runtimes | iOS project home |
| Runtime status | Runtime broadcasts cluster/version status (`brain_status` is the legacy envelope name) | All devices |
| Lane presence | Controllers call `lanes.presence.announce` / `lanes.presence.release`; the runtime decorates `LaneSummary.devicesOpen` for 60 s TTL | iOS Lanes tab; desktop runtime presence heartbeat |

## Command routing and execution isolation

Controllers never run agent processes. CTO heartbeats and worker
activations are runtime-exclusive.

Two categories of controller write:

- **State-only** (create lane metadata row, update a setting): written
  locally, propagates through cr-sqlite changesets.
- **Execution** (create worktree, run a terminal command, create a
  PR, send a chat message): issued as a `command` envelope to the
  runtime, which runs it and replies with `command_ack` + `command_result`.
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

Plus a scope (`runtime` or `project`) on the descriptor. The
runtime-declared policy and scope are the authority: the iOS app reads
descriptors over the wire and gates UI actions accordingly. Hardcoded
mobile assumptions would be stale after a runtime-side policy change, so
the phone trusts the runtime.

See `remote-commands.md` for the full action set and the runtime /
project scope split.

## Security model

- **Pairing**: two independent paths. Machine-to-machine pairing uses
  the shared bootstrap token from the machine secrets directory.
  Phone pairing uses a **user-set 6-digit PIN** stored in
  `~/.ade/secrets/sync-pin.json` on the runtime machine. The runtime never auto-rotates
  or TTLs the PIN; the user sets it through Settings > Sync and clears
  it when they want to stop accepting new pairings. The PIN unlocks
  generation of a durable per-device secret that the phone stores in
  its Keychain; subsequent connections use that paired secret, not the
  PIN.
- **Rate limiting**: the runtime tracks failed `pairing_request` attempts
  per remote IP. Five failures put that IP into a 10-minute cooldown
  during which new pairing requests are rejected without touching the
  PIN store.
- **Secrets never sync.** `.ade/local.secret.yaml` (provider API keys,
  ADE CLI configs) is per-machine. Linear tokens stay in the active
  project's machine-local `.ade/secrets`; GitHub tokens and AI provider
  tokens stay on the runtime machine.
- **Transport**: WebSocket auth via PIN / paired secret / bootstrap
  token on every connection. Tailscale WireGuard encryption applies
  when over tailnet; LAN connections rely on pairing token validation.
  TLS is not enforced for localhost/LAN; the runtime listens on all
  interfaces (intended for trusted LAN and tailnets).
- **Secret isolation**: each device stores its own pairing secret in
  its OS keychain.
- **Execution isolation**: the ADE runtime runs agents; controllers do not.

## Current implementation status

| Component | Status |
|---|---|
| Sync service owned by `ade serve` runtime | Implemented |
| Desktop in-process sync host | Disabled by default (`ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics) |
| Multi-project runtime + `project_switch` handshake | Implemented |
| `SyncRemoteCommandDescriptor.scope` (`runtime` / `project`) gating | Implemented |
| cr-sqlite extension loading (desktop/runtime) | Implemented |
| Pure-SQL CRR emulation (iOS) | Implemented |
| CRR marking for eligible tables | Implemented (dynamic startup) |
| Changeset extraction/application | Implemented |
| WebSocket sync server | Implemented |
| Sync protocol (JSON + zlib) | Implemented |
| File access sub-protocol | Implemented |
| Terminal stream sub-protocol | Implemented |
| Chat stream sub-protocol | Implemented |
| Device registry table | Implemented |
| Desktop peer client + manual connect | Implemented |
| Sync authority transfer | Implemented |
| Shared ADE scaffold portability for desktop clones | Implemented |
| PIN-based phone pairing + per-device secrets | Implemented |
| Live chat-event push from runtime | Implemented |
| Mobile project catalog + project switch handoff | Implemented |
| Lane presence decoration (`devicesOpen`) | Implemented |
| PR mobile snapshot (`prs.getMobileSnapshot`) | Implemented |
| iOS local replicated DB | Implemented |
| iOS Lanes / Files / Work / PRs / Settings tabs | Implemented |
| QR pairing UX | Implemented (payload v2; PIN entered separately) |
| Tailscale integration | Implemented (address candidate + mDNS TXT + `tailscale serve` publication under `svc:ade-sync`) |
| Lane portability desktop-to-desktop | Planned |

## Gotchas

- **The runtime owns sync. Desktop is a client.** A desktop window bound
  to a remote runtime is *not* the sync authority for that project; the remote
  runtime is. Code that wants the sync service must reach into the
  runtime IPC bridge, not into the renderer or the Electron main
  process.
- **`ADE_ENABLE_DESKTOP_SYNC_HOST` is a diagnostics escape hatch.** If
  you turn it on, both an in-process host and the standing runtime can be
  alive simultaneously on the same machine — that's intentional for
  comparing behaviors, but production builds should never run with
  that flag set.
- **Project-scoped commands need `projectId`.** A runtime hosting
  multiple projects has no implicit "current project". Forward the
  active `projectId` on every project-scoped command or the runtime
  rejects with `code: missing_project`.
- **CRR retrofit strips non-PK UNIQUE constraints.** Upserts on
  synced tables must target the primary key only. Use explicit
  select-then-update for non-PK merge cases.
- **Bootstrap token must match on every connection.** A changed token
  invalidates all existing connections until paired devices are
  re-provisioned.
- **The runtime listens on all interfaces.** Treat the current posture as
  trusted-LAN/tailnet only; TLS is not enforced for localhost/LAN.
  Revocation works per paired device via Settings > Sync > Forget.
- **The pairing PIN is user-managed, not ADE-managed.** There is no
  expiry and no rotation. A machine that leaves the PIN set is
  perpetually pairable by anyone on the network who knows the digits
  (subject to the per-IP rate limiter). Clearing the PIN from
  Settings > Sync is how you stop accepting new pairings; already-paired
  devices keep their per-device secret and remain connected.
- **`brain_*` is legacy naming.** In new docs and code comments prefer
  "sync authority" or "machine runtime"; existing database column names
  are kept for compatibility.
- **iOS and desktop do not share the cr-sqlite binary.** iOS uses a
  pure-SQL emulation because Apple platforms reject
  `sqlite3_load_extension()` and `sqlite3_auto_extension()`. Changeset
  wire format is identical; cr-sqlite feature parity is **not**
  guaranteed — any desktop-only cr-sqlite feature that ADE grows to
  depend on must also be implementable in SQL triggers on iOS.
- **iOS sends unpacked primary keys; the desktop/runtime path repacks
  them.** The iOS emulation captures `crsql_changes.pk` as the raw
  scalar (a string, integer, or already-bytes value) instead of the
  cr-sqlite packed type-tagged byte string desktop emits. On the
  receive side, `apps/desktop/src/main/services/state/kvDb.ts`
  applies `normalizeIncomingCrsqlChange` to every inbound row before
  the `crsql_changes` insert: bytes that already look packed are
  passed through, while raw strings / ints / `0` / `1` are wrapped
  into the matching `packedCrsqlPrimaryKey` byte layout the native
  cr-sqlite extension expects. Skipping this step is how phone-side
  edits silently fail to apply on the desktop.
- **Rolling schema removals are filtered before apply.** Peers on older
  builds may still export changes for dropped local tables such as
  `unified_memories` and its FTS side tables. `kvDb.ts` filters those
  rows, plus rows for tables that no longer exist locally, before
  opening the apply transaction. A batch that contains only ignored
  tables is a no-op and preserves the local database version.
- **Controller command queues replay on reconnect.** If the runtime
  advertises `chat.send` as queueable and the user sends while the
  desktop is reconnecting, the iOS app stores the command locally with
  a queued delivery state and replays on reconnect. Do not assume
  synchronous semantics from the phone side.
