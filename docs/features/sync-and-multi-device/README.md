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
  once behind a single brain-level WebSocket listener on a stable port;
  a phone picks which project to bind to via the machine project
  catalog, and when the hosted project changes the new project's host
  service **adopts** the open sockets instead of dropping them.
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
│   - one brain-level shared listener (sharedSyncListener);        │
│     per-project host services adopt peers across switches        │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ Sync transport (ws)                                              │
│   - SyncEnvelope: hello, pairing, changeset_batch,               │
│     changeset_ack, heartbeat, file_request/response,             │
│     terminal_*, chat_*, brain_status (legacy name),              │
│     project_catalog/project_switch/project actions,              │
│     command / command_ack / command_result,                      │
│     envelope_chunk                                               │
│   - JSON payloads; gzip+base64 above threshold (4 KB default),   │
│     with inflate capped at 25 MB before auth processing          │
│   - encoded envelopes >720 KB sliced into envelope_chunk frames  │
│     for peers declaring the "chunkedEnvelopes" capability        │
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
- `syncHostService.ts` — the per-project WebSocket host. Owns
  connection acceptance, hello/pairing handshakes, per-peer state,
  changeset fan-out + ack tracking (bounded, windowed exports — see
  `crdt-model.md`), chat-first scheduling (chat events are pumped before
  background changesets, and peers with active chat subscriptions get
  smaller background batches / backpressure deferral when the WebSocket
  send buffer is already backed up), the mobile changeset diet
  (`MOBILE_CHANGESET_EXCLUDED_TABLES`: high-churn tables the phone
  never reads — `attempt_transcripts`, `operations`, `ai_usage_log`,
  `budget_usage_records`, `automation_runs`,
  `automation_action_results` — are filtered from phone changesets
  while ack watermarks still advance), the host-authoritative table
  filter (`SYNC_HOST_AUTHORITATIVE_TABLES`: `sync_cluster_state` — the
  CRR that governs brain ownership — never crosses the CRR boundary in
  either direction, so a peer can neither receive it nor author a
  winning `crsql_changes` row that would flip `brain_device_id`; brain
  handover stays on the explicit host-transfer RPC), the inbound
  changeset-batch ceilings (`MAX_INBOUND_CHANGESET_ROWS` / `_BYTES` ≈
  40× the outbound 250-row / 256 KB caps, i.e. ~10k rows / ~10 MB; an
  oversized `changeset_batch` is rejected with a `changeset_too_large`
  ack before any `applyChanges` so one giant batch cannot seize the DB
  inside its `BEGIN IMMEDIATE` transaction), the per-session chat-event seq
  + replay buffer, terminal/chat subscription bridging, offset-stamped
  mobile terminal streams, `sinceOffset` delta snapshots, scrollback
  paging via `terminal_history`, mobile terminal input/resize forwarding
  into subscribed PTYs, desktop-size restore after the last phone
  detaches, lane presence decoration, project catalog/switch envelopes,
  runtime-scoped project action envelopes (browse/open/create/clone/
  list GitHub repos/default parent directory/forget), project-id alias
  matching between the machine catalog id and the hosted DB id, per-IP pairing rate
  limiter, and the Tailscale Serve / mDNS
  publication paths. Runtime
  kind is one of `desktop-embedded`, `headless`, `remote-stdio`,
  `desktop`, `daemon`, or `remote`.
- `sharedSyncListener.ts` — the brain-level WebSocket listener shared
  across per-project host services. Binds once (preferred-port retry:
  ~8 attempts over ~3.2 s on the saved port before falling back to a
  port scan, so a brain restart does not drift the port phones saved)
  and is handed between hosts on project switch: the new host adopts
  the open sockets — peer metadata carried over, pairing auth
  re-validated against the pairing store, changeset cursors recomputed
  from the peer's per-site cursor map, chat/terminal subscriptions and
  transcript offsets riding the handoff snapshot, and frames buffered
  during the handoff window replayed — so phones survive project
  switches without reconnecting. Sockets left unowned park with
  buffered frames and close with code 4002 after a 30 s grace. A
  machine-wide fallback handler may accept new sockets when no project
  host owns the listener, but it is suppressed during the handoff grace
  after a project host detaches so reconnecting phones still park for
  adoption by the next project host. A self-owned server path remains
  for tests/standalone hosts.
- `brainProjectActionsSyncHandler.ts` — machine-wide fallback sync
  handler used by `ade serve` before any project host is active. It
  authenticates the same PIN / paired-secret / bootstrap paths as the
  per-project host, applies the same failed-PIN cooldown, and serves
  project catalog plus runtime-scoped project actions so a phone can
  add/open/create/clone/remove a project even from the project-home state.
- `changesetPump.ts` — batch-chunk selection for changeset fan-out.
  Splits an export into `changeset_batch` envelopes at ~256 KB / 250
  rows while never splitting rows that share a `db_version` (the ack
  watermark is version-granular).
- `syncPeerService.ts` (~580 lines) — WebSocket **client**. The runtime
  can run this too when it joins another runtime as a peer (handoff
  rehearsal, controller-to-authority swap). On iOS, an equivalent Swift
  implementation lives in `apps/ios/ADE/Services/SyncService.swift`.
- `syncProtocol.ts` — envelope encode/decode with gzip
  threshold (`DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024`)
  plus a bounded inflate cap
  (`MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES = 25 * 1024 * 1024`), and
  envelope chunking: an encoded envelope above
  `DEFAULT_SYNC_MAX_FRAME_BYTES` (720 KB) is sliced into
  `envelope_chunk` frames for peers that declared the
  `chunkedEnvelopes` hello capability
  (`SYNC_CHUNKED_ENVELOPES_CAPABILITY`); legacy peers get the single
  full frame. Protocol version is `1`. Default host port is `8787`.
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
  Lane snapshot commands accept decoration flags so mobile can refresh
  runtime/session buckets without recomputing conflict status, rebase
  suggestions, or auto-rebase status on every light refresh; lane detail
  uses the scoped lane-summary path instead of forcing a full lane list.
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
  unregistered-worktree discovery, and local project-list hiding for
  "Remove from list" so cached DB rows and runtime catalog rows for
  the same root disappear together.
- `KeychainService.swift` — iOS Keychain Services for paired device
  secrets (per-machine token shelf included).
- `LiveActivityCoordinator.swift` — owns the single workspace
  `Activity<ADESessionAttributes>` lifecycle.

iOS widget files (under `apps/ios/`):

- `ADE/App/DeepLinkRouter.swift`.
- `ADEWidgets/ADELiveActivity.swift`, `ADEWorkspaceWidget.swift`,
  `ADELockScreenWidget.swift`, `ADEControlWidget.swift` (Control
  Center widgets, iOS 18+).
- `ADE/Shared/ADESharedModels.swift`, `ADE/Models/RemoteModels.swift`,
  `ADE/Resources/DatabaseBootstrap.sql` (generated from desktop
  `kvDb.ts`).

## Multi-project runtimes and project switching

The machine runtime knows **every** project the user has opened on that machine
(within retention) and exposes them as a single catalog. The mobile
transport is one brain-level WebSocket listener on a stable port; one
project's host service owns the connected peers at a time. The phone
pairs with the machine once, sees the catalog, and stays on the same
port across project switches. Desktop SSH remote recents are not part of
this phone catalog: the catalog is local to the paired machine/runtime, so
remote-machine paths are filtered out before mobile summaries are built. The
phone flow:

1. Phone connects and sends `hello`. The runtime responds with
   `hello_ok` containing the current project catalog (when supported).
2. The phone renders the catalog as a project home — recent projects
   marked available/cached/unavailable, with `MobileProjectSummary`
   metadata (icon, lane snippets) supplied by the runtime.
3. The user taps a project → phone sends `project_switch_request`.
   The runtime's `prepareProjectConnection` only opens the target
   project scope and replies with the **current** port in a
   `project_switch_result` (fresh `connection` payload or
   `connection: null`, meaning reuse existing pairing credentials).
4. After the result is flushed, `completeProjectConnection` runs: the
   old host stops first and the new host starts on the same port under
   the preferred-port retry, adopting any sockets that stayed open.
   A phone that initiated the switch tears down and reconnects against
   the same port; a phone that was merely connected while another
   client switched projects is adopted in place and never disconnects.
   If the switch fails, the previous host is restored so the listener
   is never left unowned.

The project home can also manage machine projects without first binding
to a project DB. `project_browse_request`,
`project_default_parent_dir_request`, `project_open_request`,
`project_create_request`, `project_clone_request`,
`project_list_my_github_repos_request`, and `project_forget_request`
are runtime-scoped envelopes.
When a project host is active, `syncHostService` handles them; when no
project host owns the shared listener, `brainProjectActionsSyncHandler`
handles the same envelopes so the phone can add a first project or
remove stale recents on a headless or freshly-started machine. On the
phone, removal also stores host-scoped local hidden keys by project id
and normalised root path so a cached DB row and a remote catalog row for
the same project do not reappear until the user opens/selects that
project again.

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
- If the runtime was opened from the machine project registry with one id
  and the project DB already contains a different persisted project id,
  the host accepts either id as an alias for the same open project. This
  keeps older mobile caches and DB-scoped command payloads from being
  misrouted as `project_not_open`.
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
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`), it runs a
  plain per-node `tailscale serve` against the **live** sync port
  (target `tcp://127.0.0.1:<port>`); the tagged-node `svc:ade-sync`
  Service form is not used because it requires tagged nodes and pinned
  a constant port that never matched the live socket. Status
  flows out through `SyncRoleSnapshot.tailnetDiscovery`
  (`SyncTailnetDiscoveryStatus`: `disabled | publishing | published |
  pending_approval | unavailable | failed`) plus `error` / `stderr`
  tails. The runtime tracks a `tailnetServeSignature` (`serve:<port>`)
  so re-publishing is a no-op while the port hasn't changed.

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
        "terminal_input" | "terminal_resize" | "terminal_history" |
        "chat_subscribe" | "chat_unsubscribe" | "chat_event" |
        "brain_status" |
        "project_catalog_request" | "project_catalog" |
        "project_catalog_chunk" |
        "project_switch_request" | "project_switch_result" |
        "command" | "command_ack" | "command_result" |
        "envelope_chunk",
  projectId?: string | null, // present on project-scoped envelopes
  requestId: string | null,
  compression: "none" | "gzip",
  payloadEncoding: "json" | "base64",
  payload: ...,
  uncompressedBytes?: number, // gzip only
}
```

Payloads above `DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES` (4 KB) are
gzipped and base64-encoded. `parseSyncEnvelope` caps gzip inflate at
`MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES` (25 MB), rejects declared
oversize gzip envelopes before inflate, rejects a mismatch between
`compression` and `payloadEncoding`, and rejects unsupported protocol
versions.

Encoded envelopes larger than 720 KB
(`DEFAULT_SYNC_MAX_FRAME_BYTES`) are sliced into `envelope_chunk`
frames (base64 parts keyed by `chunkId`/`index`) for peers that
declared the `chunkedEnvelopes` capability in `hello`; the receiver
reassembles before normal decode. iOS declares the capability and
raises its socket receive budget to 32 MiB, so chat / terminal
snapshots, `file_response`, and large `command_result` payloads can
no longer kill the connection with "Message too long".

`SyncHelloErrorPayload.code` is trimmed to `auth_failed |
invalid_hello`. `SyncPairingResultPayload.error.code` is one of
`invalid_pin | pin_not_set | pairing_failed`.

Heartbeat interval is 30 seconds. Desktop peers close after **two**
consecutive missed heartbeats; mobile peers get a wider grace window
(`MOBILE_SYNC_HEARTBEAT_MISS_LIMIT = 6`) because iOS can briefly suspend
foreground networking during app and route transitions. Reconnection
resumes from a **per-host-DB cursor**: `hello_ok` carries the host
DB's `serverDbSiteId`, the phone keys its inbound cursor by that site
(`remoteDbVersionBySite`) and sends the full map in `hello`, and the
host picks its own site's entry (falling back to the legacy single
cursor for older clients). Each hosted project DB has its own
`db_version` sequence, so the per-site map is what keeps a brain that
switches hosted projects from replaying everything or skipping
backlog. Runtime-side batching keeps every row for a given `db_version`
in the same `changeset_batch`; otherwise an ack for a partial
transaction would advance the receiver past unsent rows.

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
| File access | On-demand project/worktree file reads, listings, writes | iOS Files, desktop remote viewing |
| Terminal stream/control | Subscribe to PTY output from the runtime; send input bytes and viewport resize events back to the subscribed PTY | iOS Work tab |
| Chat stream | Agent chat transcript events. Each `chat_event` carries a host-assigned per-session monotonic `seq` backed by a capped replay buffer (500 events / 2 MB per session, 64-session LRU). `chat_subscribe` accepts `sinceSeq`: gaps the buffer covers replay as ordinary events; uncoverable gaps fall back to a snapshot, and a non-resumed ack tells the client to drop its stale seq watermark (seq epochs restart at 1 on a new host). The ack also carries `turnActive` from the live agent chat service — snapshots are byte-capped tails, so a long turn's `status: started` event can fall outside the window and the flag is what lets a mid-turn subscriber render streaming/stop affordances without waiting on the changeset pump (a full ack without the flag tells the client to drop any latched hint) | iOS Work tab, controller chat |
| Command routing | Send named actions (`chat.send`, `lanes.create`, `git.push`, `prs.getMobileSnapshot`, etc.) | Controller devices |
| Project switching | `project_catalog` + `project_switch_request/result` for multi-project runtimes | iOS project home |
| Project actions | Runtime-scoped project browser plus open/create/clone/list-GitHub-repos/default-parent-dir/forget envelopes. Available from the active project host or the machine-wide fallback handler before a project is selected | iOS project home |
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
- **External local files stay desktop-local.** Files opened in the desktop
  from Finder / OS open-file events or local drag-and-drop are registered as
  `external` workspaces on that desktop process. The sync host filters those
  workspaces out of mobile `listWorkspaces` responses and rejects mobile file
  requests that target them, so pairing a phone does not expose arbitrary
  local folders.

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
| Mobile project actions (browse/open/create/clone/list GitHub repos/remove from list) | Implemented |
| Brain-level shared listener (peers adopted across project switches) | Implemented |
| Chunked envelopes (`envelope_chunk`, 720 KB frame budget) | Implemented |
| Per-host-DB sync cursors (`serverDbSiteId` / `remoteDbVersionBySite`) | Implemented |
| Resumable chat streams (per-session `seq` + `sinceSeq` replay buffer) | Implemented |
| Mobile changeset diet (heavy never-read tables filtered for phones) | Implemented |
| Lane presence decoration (`devicesOpen`) | Implemented |
| PR mobile snapshot (`prs.getMobileSnapshot`) | Implemented |
| iOS local replicated DB | Implemented |
| iOS Lanes / Files / Work / PRs / Settings tabs | Implemented |
| QR pairing UX | Implemented (payload v2; PIN entered separately) |
| Tailscale integration | Implemented (address candidate + mDNS TXT + per-node `tailscale serve` publication on the live sync port) |
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
  rejects with `code: missing_project`. The host accepts the runtime
  catalog id and the DB-local project id as aliases for the same open
  project when both are known.
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
- **Controller command queues replay on reconnect and on live-send
  timeouts.** If the runtime advertises `chat.send` as queueable and the user
  sends while the desktop is reconnecting, or the send request times out while
  the socket still appears connected, the iOS app stores the command locally
  with a queued delivery state and replays it with the same `commandId`. Do not
  assume synchronous semantics from the phone side.
