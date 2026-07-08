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
- `../web-client/README.md` — the hosted browser controller path: static
  Cloudflare Pages SPA, PIN pairing, WebCrypto DPoP, browser-safe sync
  transports, no local DB, and the `window.ade` adapter over remote commands.
- `remote-commands.md` — the `syncRemoteCommandService` registry that
  turns client actions into runtime-executed mutations.
- `push-notifications.md` — the APNs push + Live Activity pipeline:
  Cloudflare push relay, brain publisher, per-device prefs, and the
  Live Activity content-state contract.

Web client: the browser client is another controller of the same machine
runtime. It pairs through the sync service like iOS, but does not keep a local
SQLite replica; it uses changeset batches as invalidation signals and refreshes
state through remote commands, file requests, and chat/terminal streams.

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
- **Browser web client** — client/controller-only, hosted static SPA
  (`device_type: "browser"`). Pairs over the same sync WebSocket with
  PIN + per-device secret + WebCrypto DPoP, but keeps **no** local SQLite
  replica: it treats changeset batches as invalidation signals and reads
  through remote commands, file requests, and chat/terminal streams. See
  `../web-client/README.md`.
- **Cluster state** — a singleton `sync_cluster_state` row with
  the legacy columns `brain_device_id` and `brain_epoch` tracks which
  device currently owns execution within a cluster.

The older terms "brain" and "host" still appear in code, schema, and
protocol types. In the current product vocabulary, they refer to the
same thing: the runtime that is the current **sync authority**.

## Mobile compatibility contract

Mobile clients must be able to connect to older and newer ADE brains long enough
to show update state and invoke supported commands. The sync hello is therefore
additive: new host features are optional, and a missing feature puts the phone
in a limited mode instead of failing the WebSocket connection.

The shared contract lives in
`apps/desktop/src/shared/syncMobileCompatibility.ts`. The brain advertises
`features.mobileCompatibility` with a contract version, required mobile command
actions, and any missing actions. iOS treats an omitted feature as a legacy
limited host, preserves the connection, gates unsupported remote actions before
queueing/sending them, and shows update guidance from the host state. When a new
mobile release adds required host behavior, update the shared contract and the
iOS compatibility tests in the same branch.

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

Runtime support files outside `services/sync/`:

- `apps/ade-cli/src/eventBuffer.ts` — bounded runtime-event replay buffer
  used by multi-project RPC and desktop/TUI event streams. Retains up to
  10,000 events / 16 MB total / 1 MB per event by default, emits live
  subscribers best-effort even for oversize events, and returns
  `eventEpoch`, `gap`, and `oldestCursor` from `drain()` so clients can
  reset stale cursors when a daemon restarts or history was evicted.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — machine-level JSON-RPC
  surface for `projects.*`, `sync.*`, `runtimeEvents.*`, and project-scoped
  `ade/actions/call`. Runtime-event subscribe replies include the gap
  fields above; `projects.list` resolves host-side icons under a connect-path
  budget (64 icons / 12 MB per call) so large project registries cannot stall
  remote desktop or mobile catalog setup just to inline artwork.

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
  connection acceptance, hello/pairing handshakes (an `auth_failed`
  rejection is attributed with the rejecting machine's
  `host: { deviceId, name }` — read from `readBrainMetadata()` — so a
  client can only ever drop a saved pairing when the rejection came from
  the machine it is actually paired with), per-peer state,
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
  limiter, mobile compatibility advertisement (`features.mobileCompatibility`
  derived from the shared required-action contract), and the Tailscale Serve / mDNS
  publication paths. Runtime
  kind is one of `desktop-embedded`, `headless`, `remote-stdio`,
  `desktop`, `daemon`, or `remote`. It also owns the all-projects session
  roster push for the mobile Hub: per subscribed peer it tracks
  `rosterSubscribed` / `rosterSeq` / a `rosterBaseline` map, debounces
  rebuilds (trailing-edge with a hard cadence ceiling), and forces a
  coalesced flush after a remote command adds/removes a roster-visible
  lane or chat. The snapshot itself comes from an optional injected
  `SyncRosterProvider.buildSnapshot()`; a host without one (single-project
  desktop) never answers `roster_subscribe`. It also takes an optional
  `foreignChatProvider` (`SyncForeignChatTranscriptResolver`) that powers
  cross-project chat quick-look: a `chat_subscribe` naming a registered
  foreign project is resolved to that project's on-disk transcript path and
  streamed read-only (byte-capped tail snapshot plus a disk-tailing live
  pump, tracked per peer in `foreignChatTranscriptPaths`) with no runtime
  boot; the presence of the provider is what flips the advertised
  `crossProjectChat` hello feature flag.
- `rosterBuilder.ts` — builds the machine-wide all-projects session roster
  (`SyncRosterProject[]`) consumed by the Hub: agent chats, their attached
  shell rows, and **standalone CLI (tracked terminal) sessions — live and
  ended** (`run-shell` infrastructure rows are excluded, mirroring
  `isRunOwnedSession` on desktop/iOS). Opens each project's
  `<root>/.ade/ade.db` **read-only** with `node:sqlite` (no cr-sqlite, no
  runtime boot — the same cheap cross-project read pattern as
  `recentProjectSummary.ts`) and merges cached `chat-sessions/*.json`, so an
  all-projects feed never activates every project. Live running/awaiting
  status is overlaid only for scopes already booted on the runtime; a booted
  scope also overlays **PTY liveness** for CLI rows (they never appear in
  `agentChatService`, so `ptyService.hasLivePty` is what flips them to
  `running`). `attentionCount` (which drives hub badges and attention-first
  project sorting) counts only chat rows and shells attached to a chat — a
  standalone CLI session that exited non-zero must not pin its project to
  the top forever, since mobile has no way to clear it. Previews
  are hard-truncated (~120 chars). Also exports
  `createForeignChatTranscriptResolver({ projectRegistry })` — the resolver
  behind cross-project chat quick-look and its security boundary: it maps a
  `(registered foreign project, sessionId)` pair to that session's transcript
  JSONL path, rejecting unsafe session ids and any path that would escape the
  project's `.ade` transcripts dir, and returning null for unknown projects
  (never booting a runtime). `ade serve` wires it as the host's
  `foreignChatProvider`.
- `sharedSyncListener.ts` — the brain-level WebSocket listener shared
  across per-project host services. Binds once (preferred-port retry:
  ~8 attempts over ~3.2 s on the saved port before falling back to a
  port scan, so a brain restart does not drift the port phones saved)
  and is handed between hosts on project switch: the new host adopts
  the open sockets — peer metadata carried over, pairing auth
  re-validated against the pairing store, changeset cursors recomputed
  from the peer's per-site cursor map, chat/terminal/roster subscriptions
  and transcript offsets riding the handoff snapshot, and frames buffered
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
  per-project host, applies the same failed-PIN cooldown, attributes its
  `auth_failed` rejections with the same `host: { deviceId, name }`
  identity the per-project host sends (so a phone that reaches this
  fallback over a stale address still won't destroy a pairing it can't
  attribute), and serves
  project catalog plus runtime-scoped project actions so a phone can
  add/open/create/clone/remove a project even from the project-home state.
  It also answers `command` envelopes: when no project host owns the peer
  (host restarting, or blocked by a conflicting sync listener) it replies
  immediately with a `command_result` carrying
  `error.code: "host_unavailable"` instead of silently dropping the
  command — a dropped command used to leave the phone staring at a 30 s
  timeout with a vague "took too long" banner. iOS treats that code as
  transient (retryable and queueable, like a timeout), so queued
  operations survive host restarts instead of being deleted on replay.
- `syncHostStartupLoop.ts` — retry loop around mobile sync host startup
  for the brain. Same-channel singleton conflicts (update races, restart
  overlap, a stale sibling) always retry — the loop may evict a stale
  same-channel squatter, but only when this brain is the channel's
  installed runtime service child. A conflict with **another channel's**
  live brain is rethrown only on the first attempt, so brain startup can
  fail loudly with quit instructions; after the first attempt (the brain
  is already serving) cross-channel conflicts keep retrying on the slow
  cadence and auto-recover the moment the foreign owner exits, instead of
  permanently giving up and stranding paired phones on the ingress
  fallback.
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
- `syncRemoteCommandService.ts` (~3,280 lines) — command registry
  (lanes, chat, git, PR, sessions, conflicts, files,
  `prs.getMobileSnapshot`, `lanes.presence.*`, `work.runQuickCommand`,
  `work.startCliSession`, `work.listExternalSessions`,
  `work.importExternalSession`, `modelPicker.*`, …). Each registration
  carries a `SyncRemoteCommandDescriptor` with a **scope** label of
  `"runtime"` or `"project"`. The runtime rejects a `project`-scoped
  command when no project is open or when the caller did not bundle a
  matching `projectId` (see *Scope enforcement* below). Mobile /
  controller CLI launches resolve the target lane worktree before
  building provider argv/env so Agent Skill roots and
  `ADE_AGENT_SKILLS_DIRS` stay lane-aware. External-session imports share
  the desktop external-session service and DTOs: list returns provider
  summaries and import returns either a tracked CLI PTY id or a native ADE
  chat id. See
  [External Session Import](../terminals-and-sessions/external-session-import.md)
  for the provider storage formats, host/runtime requirements, and mobile
  testing constraints.
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
  `lanes.create` calls that omit `baseBranch` / `startPoint` /
  `parentLaneId` (hub-composer auto-create, the mobile create sheet's
  default) resolve a **remote-first default base** on the host before
  creation: the project's `git.newLaneBaseSource` config (effective
  default `"remote"`) selects between a bounded remote fetch +
  `origin/<primary base>` mapping and the legacy local primary tip; the
  resolution helper is `apps/desktop/src/shared/defaultRemoteLaneBase.ts`
  (shared with the desktop create-lane dialog's renderer-side default).
- `deviceRegistryService.ts` (~670 lines) — synced `devices` table and
  `sync_cluster_state` singleton. Peer app provenance — `appVersion`,
  `appBuild`, `bundleIdentifier` — carried on `SyncPeerMetadata` (parsed from
  the `hello` payload in `syncHostService`/`brainProjectActionsSyncHandler`,
  where iOS populates them from its `Bundle.main` info dictionary) is persisted
  into each device's `metadata_json` bag when the registry upserts the peer.
  When the local runtime joins another
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
- `syncDpop.ts` — device-bound pairing (DPoP) helpers: the canonical
  signing string builder, `evaluatePairedHelloDpop` (validates a
  `SyncDpopProof` against the stored P-256 public key and TOFU-adopts an
  offered key for legacy devices), and `createSyncDpopNonceCache` (bounded
  per-host replay guard). Shared by `syncHostService` and the brain
  ingress handler.
- `syncSecurityStore.ts` — machine-level sync security posture stored at
  `~/.ade/secrets/sync-security.json` (chmod `0600`). Owns the
  `requireDpop` flag with the `ADE_SYNC_REQUIRE_DPOP=1|0` env override; both
  the per-project host and the brain ingress handler read it.
- `syncCloudRelayStore.ts` — persists the cloud tunnel-relay identity +
  enablement at `~/.ade/secrets/sync-cloud-relay.json` (lazily-minted
  32-hex `machineKey` + HMAC `secret`, chmod `0600`). **Default
  `enabled: true`** — a file without the field reads as enabled. An
  `enabled: false` is honored only when the sibling `enabledSetByUser`
  marker is also written; `setEnabled()` (the desktop kill-switch or
  `ade sync relay disable`) writes that marker, so a deliberate off
  survives upgrades. A pre-default-on build's implicit `enabled: false`
  (persisted on first run before relay-everywhere shipped, no marker)
  therefore migrates to enabled instead of stranding old machines off
  the relay. Derives the phone-facing
  `wss://<relay>/connect/<machineKey>` URL and the canonical host/pipe
  HMAC signing strings shared with the `apps/tunnel-relay` worker.
- `syncTunnelClientService.ts` — the brain-side tunnel client. When the
  cloud relay is enabled it keeps an outbound WebSocket registered with
  the relay worker (HMAC-signed host/pipe upgrades, exponential backoff
  with jitter capped at 60 s) so phones off the LAN/tailnet can dial the
  machine through the relay; the normal ADE sync hello/pairing then runs
  end-to-end over the piped connection.

Push publisher (`apps/ade-cli/src/services/push/`) — the APNs push +
Live Activity pipeline (`pushPublisherService.ts`,
`pushRegistrationStore.ts`, `pushRelayClient.ts`). See
`push-notifications.md` for the full topology.

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

Runtime-event IPC uses the same local/remote binding path. `RemoteRuntimeStreamEventsResult`
includes `eventEpoch`, `gap`, and `oldestCursor`; preload resets its cursor and
dedupe cache on epoch changes, and when a poll/subscription reports `gap: true`
it triggers the normal project-binding refresh path so renderer projections
recover from an evicted replay window instead of assuming the cursor was exact.

`sync.connectToBrain` is a legacy API name. New docs should call this a
runtime connection or sync authority connection.

The shared protocol DTOs (`SyncEnvelope`, controller-originated
`terminal_input` / `terminal_resize`, the mobile CLI launcher payload —
`SyncCliLaunchProvider`, `SyncStartCliSessionArgs`,
`SyncStartCliSessionResult` — the external session aliases
`SyncListExternalSessionsArgs` / `SyncImportExternalSessionArgs`, and so on)
live in
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
  external-session list/import commands for Work,
  PR mobile snapshot fetch, live chat-event push listener, lane
  reparent payload building with the optional stack base-branch
  override, project home/catalog state, active-project scoping,
  unregistered-worktree discovery, and local project-list hiding for
  "Remove from list" so cached DB rows and runtime catalog rows for
  the same root disappear together.
- `KeychainService.swift` — iOS Keychain Services for paired device
  secrets (per-machine token shelf included).

iOS widget files (under `apps/ios/`):

- `ADE/App/DeepLinkRouter.swift`.
- `ADEWidgets/ADELockScreenWidget.swift`.
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
| `device_type` | `desktop`, `phone`, `vps`, `browser`, `unknown` (`browser` is the hosted web client — see `../web-client/README.md`) |
| `created_at` / `updated_at` / `last_seen_at` | Timestamps |
| `last_host` / `last_port` | Last manual-connect address |
| `tailscale_ip` | Tailscale IP if available |
| `ip_addresses` (JSON array) | LAN IPs |
| `metadata_json` | Future-safe extension bag; holds `dbVersion` plus peer app provenance (`appVersion`, `appBuild`, `bundleIdentifier`) when the peer advertised them in `hello` |

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
  `~/.ade/secrets/sync-pin.json` as a PBKDF2 hash. The PIN is owned by
  the human operator — the runtime does not rotate it, does not
  time-expire it, and does not mint a one-shot code. The runtime keeps
  plaintext only in the current process after the user sets/generates
  it (or after legacy migration), so after a restart the host can verify
  pairings with the existing digits if the user still knows them. It
  cannot display or copy those digits until the user generates or sets a
  new PIN. The phone enters the same digits the user
  typed in the machine's Settings > Sync > Phone pairing sheet.
  Failed PIN attempts increment a per-IP counter; after 5 failures
  the runtime rejects further attempts from that IP for 10 minutes
  (`PAIR_FAILURE_THRESHOLD = 5`, `PAIR_COOLDOWN_MS = 10 * 60_000` in
  `syncHostService.ts`).
- **QR payload**: `SyncPairingQrPayload` is **version 3**, encoded as a
  single **smart pairing URL** (`https://ade-app.dev/pair#<base64url(JSON)>`,
  codec in `apps/desktop/src/shared/pairingQr.ts`). The payload rides the
  URL fragment, so it is scannable by the system camera and safe to open
  in a browser without the JSON ever reaching a web server. It carries
  machine identity, port, and address candidates (plus the cloud-relay
  `relayUrl` when enabled) — it never embeds a pairing code or expiry, so
  the phone still needs the PIN manually. Newer payload versions parse
  leniently: the iOS scanner (`PairingQrPayload.swift`) accepts any
  version ≥ 3 as long as the fields it understands are present.
- **Address candidates**: the runtime advertises LAN IPs, the saved
  `lastHost` (when it matches the current set), the Tailscale IP,
  `127.0.0.1`, and — unless the relay kill-switch is off — a
  `relay`-kind candidate carrying a full
  `wss://…/connect/<machineKey>` URL. `SyncAddressCandidateKind` is
  `lan | saved | tailscale | loopback | relay`; iOS treats relay as an
  automatic fallback and promotes it when the phone has no Tailscale
  tunnel (see the transport race in `ios-companion.md`). Already-paired
  phones also learn the relay URL from `hello_ok` / `brain_status`
  (`cloudRelayWssUrl`) and persist it with the host profile for
  reconnects.
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
        "roster_subscribe" | "roster_unsubscribe" |
        "roster_snapshot" | "roster_delta" |
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
invalid_hello`. An `auth_failed` payload also carries an optional
`host: { deviceId, name }` naming the machine that rejected the hello —
both the project host and the brain-level fallback handler send it. This
is the client's only safe basis for destroying a saved pairing: a phone
drops its credentials **only** when the rejecting `host.deviceId` matches
the paired machine's identity. An unattributed rejection (older host, or
a stranger machine reached over a reused DHCP lease / mDNS alias / stale
Tailscale candidate) keeps the pairing and the client moves on to other
routes. `SyncPairingResultPayload.error.code` is one of
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
| Chat stream | Agent chat transcript events. Each `chat_event` carries a host-assigned per-session monotonic `seq` backed by a capped replay buffer (500 events / 2 MB per session); per-session history is evicted with a 64-session LRU so a phone that has opened many chats cannot pin unbounded host memory. `chat_subscribe` accepts `sinceSeq`: gaps the buffer covers replay as ordinary events; uncoverable gaps fall back to a snapshot, and a non-resumed ack tells the client to drop its stale seq watermark (seq epochs restart at 1 on a new host). The snapshot is a byte-capped tail: `chat_subscribe` also carries the client's `maxBytes`, and the host clamps the snapshot's `getChatEventHistory` budget to `min(host cap, maxBytes)` — for a mobile-sized budget even the newest oversize event is dropped rather than force-included, so a phone never receives a snapshot larger than it asked for. Snapshot events are marked as already-sent to that peer, so the follow-on live pump does not re-deliver the overlap. The ack also carries `turnActive` from the live agent chat service — because the snapshot is a byte-capped tail, a long turn's `status: started` event can fall outside the window and the flag is what lets a mid-turn subscriber render streaming/stop affordances without waiting on the changeset pump (a full ack without the flag tells the client to drop any latched hint). **Cross-project "quick look":** `chat_subscribe` / `chat_unsubscribe` accept an optional `projectId` / `projectRootPath` override. When it names a registered project OTHER than the socket's active one — and the host advertised the `crossProjectChat` feature flag — the host serves that session's transcript **read-only straight off the foreign project's `.ade` transcript JSONL** (byte-capped tail snapshot, then the pump tails the same file for live events), with no project switch and no runtime boot for that project. Such sessions have no live agent chat service here, so `turnActive` is omitted and the client derives turn state from the streamed `status` events. The transcript resolver is the security boundary — it validates the project is registered and confines the path to that project's transcripts dir. A host without a foreign-chat provider never sets `crossProjectChat`, so the phone falls back to a full project activation. A `session_meta_updated` `chat_event` carrying a client's permission/interaction/mode change also rides this stream, so a mode switch made on one client (desktop ↔ iOS) patches every subscribed client's cached summary and composer controls live without a refetch | iOS Work tab, iOS Hub, controller chat |
| Chat roster | Machine-wide all-projects projection of every project's lanes + work sessions grouped by lane — agent chats, their attached shell rows, and standalone CLI (tracked terminal) sessions, live **and** ended (`run-shell` infrastructure rows excluded) — so the mobile Hub renders every project's sessions at once **without activating each project**. `roster_subscribe` (handshake mirrors `chat_subscribe`, with an optional `sinceSeq`) → `roster_snapshot` then incremental `roster_delta` (`changed` upserts whole project entries, `removed` lists dropped `projectId`s). Un-booted projects are read cheaply from disk — each project's `<root>/.ade/ade.db` (read-only, no cr-sqlite / no runtime boot) plus `.ade/cache/chat-sessions/*.json` — so their session status is limited to the last-persisted `idle`/`ended`/`awaiting`; live `running`/`awaiting` fidelity is overlaid only for scopes currently booted on the runtime (booted scopes also overlay PTY liveness so a live standalone CLI session reads `running`). `attentionCount` counts awaiting/failed **chat** rows and their attached shells only — standalone CLI failures never count, so a long-dead CLI exit can't pin a project to the top of the hub. Rows carry `toolType` so the phone routes chat rows to the chat surface and CLI rows to the terminal path. Transcripts are excluded from the roster (they load on demand when a chat opens): on a host advertising `crossProjectChat` the phone opens a foreign-project chat as a read-only cross-project quick look (see the Chat stream row) without activating that project; CLI rows never take the quick look (no chat JSONL — they always activate + open the terminal), and only on older hosts lacking the flag does opening a chat fall back to activating the project's full sync. Oversized snapshots ride the generic `envelope_chunk` path. A host without a roster provider (single-project desktop) simply never answers `roster_subscribe`, so the phone falls back to the active project only | iOS Hub |
| Command routing | Send named actions (`chat.send`, `lanes.create`, `git.push`, `prs.getMobileSnapshot`, `work.listExternalSessions`, `work.importExternalSession`, etc.) | Controller devices |
| Project switching | `project_catalog` + `project_switch_request/result` for multi-project runtimes | iOS project home |
| Project actions | Runtime-scoped project browser plus open/create/clone/list-GitHub-repos/default-parent-dir/forget envelopes. Available from the active project host or the machine-wide fallback handler before a project is selected | iOS project home |
| Runtime status | Runtime broadcasts cluster/version status (`brain_status` is the legacy envelope name) | All devices |
| Lane presence | Controllers call `lanes.presence.announce` / `lanes.presence.release`; the runtime decorates `LaneSummary.devicesOpen` for 60 s TTL | iOS Lanes tab; desktop runtime presence heartbeat |

## Command routing and execution isolation

Controllers never run agent processes. Agent runtimes and CTO chat
turns are runtime-exclusive.

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

## External session import commands

Paired controllers can browse and import provider-native CLI sessions through
the same runtime command registry that starts Work CLI sessions. The full
feature detail lives in
[External Session Import](../terminals-and-sessions/external-session-import.md).

| Command | Policy | Purpose |
|---|---|---|
| `work.listExternalSessions` | `viewerAllowed: true` | Returns `ExternalSessionSummary[]` from the runtime's external-session service. Payload mirrors `ExternalSessionListArgs` (`providers`, `laneId`, `cwd`, `scope`, `limit`). |
| `work.importExternalSession` | `viewerAllowed: true`, `queueable: true` | Imports one external session into a lane as either `target: "cli"` (`ExternalSessionImportResult.kind = "cli"`, with `sessionId`/`ptyId`) or `target: "chat"` (`kind = "chat"`, with `chatSessionId`). Payload mirrors `ExternalSessionImportArgs` (`provider`, `sessionId`, `laneId`, `target`, `mode`, optional `model`/`permissionMode`). |

These commands are viewer-allowed for the same reason as
`work.startCliSession`: a paired phone or desktop controller is already a
trusted controller for the runtime machine. The controller never reads provider
session files or launches provider CLIs locally; it sends a command envelope,
and the sync authority runtime does discovery, cwd validation, chat transcript
seeding, PTY creation, and provider resume/fork execution on the host.

The feature must be present on the host brain the controller is paired to.
Desktop can point at an isolated lane-built brain with an isolated `ADE_HOME`,
but mobile normally cannot because there is one sync host on the shared
port/mDNS/tunnel surface. Real mobile E2E therefore requires the paired host to
contain the external-session service and `work.*` commands, either because the
feature is merged or because a deliberately isolated-port host is running.

## Security model

- **Device-bound pairing (DPoP)**: iOS keeps a P-256 key in the Secure
  Enclave. `pairing_request` registers the public key
  (`SyncPairingRecord.dpopPublicKey`), and every paired `hello` must then
  carry a fresh signed challenge (`SyncDpopProof`: nonce + timestamp,
  signature over `ade-dpop-v1\n deviceId\n sha256(pairedSecret)\n ts\n
  nonce` — see `syncDpop.ts`). Binding the secret hash scopes proofs to
  one host; a bounded nonce cache kills same-host replays. Legacy paired
  devices upgrade on their next connect (TOFU adoption of the offered
  key); once a key is on record the host fails closed, and bootstrap-token
  hellos for that deviceId are rejected (no downgrade path). The
  machine-level `sync-security.json` store (`requireDpop`, env override
  `ADE_SYNC_REQUIRE_DPOP`) additionally rejects paired hellos from
  devices that never registered a key. The same DPoP evaluation binds on
  the **brain ingress path** too (`brainProjectActionsSyncHandler` — the
  machine-wide fallback handler that answers before any project host is
  active), so a paired hello cannot skip proof-of-possession by racing a
  connection during a host restart. Keys are not restorable from
  device backups — a restored phone re-pairs with the PIN.
- **Pairing**: two independent paths. Machine-to-machine pairing uses
  the shared bootstrap token from the machine secrets directory.
  Phone pairing uses a **user-set 6-digit PIN** stored as a PBKDF2 hash in
  `~/.ade/secrets/sync-pin.json` on the runtime machine. The runtime never
  auto-rotates or TTLs the PIN; the user sets it through Settings > Sync
  and clears it when they want to stop accepting new pairings. Plaintext is
  process-local and intentionally unrecoverable after restart, so Settings
  and CLI surfaces treat `hasPin() && getPin() == null` as "configured but
  hidden". They still allow pairing with the existing PIN if the user knows
  it, and tell the user to generate/set a new PIN only if they need to
  display or copy one. The PIN unlocks generation of a durable per-device
  secret that the phone stores in its Keychain; subsequent connections use that
  paired secret, not the PIN.
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
- **Cloud tunnel relay (on by default; Settings > Sync is the
  kill-switch)**: the brain keeps an outbound HMAC-authenticated tunnel
  to the `apps/tunnel-relay` Cloudflare Worker so a phone off the
  LAN/tailnet can dial the machine over TLS with zero configuration.
  Phones prefer direct routes when they are currently usable; when an
  iPhone has no Tailscale tunnel and holds a saved relay URL, reconnect
  dials the relay ahead of stale saved LAN/Tailscale sweeps. The relay
  only pipes bytes: the normal ADE hello / PIN / paired-secret / DPoP
  handshake still runs end-to-end, so the relay never sees pairing
  credentials in the clear.
  The `machineKey` is an unguessable 32-hex identifier and the tunnel
  upgrades are HMAC-signed with a per-machine secret. Operators who
  never want traffic relayed flip the single "ADE relay" control in
  Settings > Sync (or `ade sync relay disable`); a deliberate off is
  recorded with an `enabledSetByUser` marker in `sync-cloud-relay.json`
  and preserved across upgrades, while a legacy build's implicit
  (unmarked) off migrates to on. The live relay URL is also advertised to
  already-paired phones in `hello_ok` / `brain_status`
  (`cloudRelayWssUrl`), so devices paired before the relay existed learn
  the route without re-scanning a QR.
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
| All-projects chat roster sub-protocol (`roster_subscribe`/`snapshot`/`delta`, mobile Hub) | Implemented |
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
| QR pairing UX | Implemented (payload v3 smart URL + iOS camera scanner; PIN entered separately) |
| Device-bound pairing (DPoP, Secure Enclave P-256) | Implemented (host + brain ingress; `requireDpop` / `ADE_SYNC_REQUIRE_DPOP`) |
| Cloud tunnel relay (off-LAN transport, `relay` candidate) | Implemented, default on with Settings kill-switch (`syncTunnelClientService` + `apps/tunnel-relay`) |
| Push notifications + Live Activities (APNs relay) | Implemented (see `push-notifications.md`; on-device E2E needs a physical iPhone) |
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
  devices keep their per-device secret and remain connected. Because
  only the hash persists, a restarted runtime can report that a PIN is
  configured but cannot reveal it.
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
