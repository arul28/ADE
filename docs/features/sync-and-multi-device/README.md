# Sync and Multi-Device

DAEX syncs live runtime state between one machine runtime (`daex serve`, the
"brain") and its controllers: other computers, iPhones and the hosted web
client. Replication is **cr-sqlite** CRRs over a **WebSocket**. Routes are
ranked **LAN → Tailscale → DAEX Relay**. Relay is available while the machine
is signed in to a DAEX account, unless its owner turned DAEX Relay off for that
computer (*Per-computer relay switch*).

The CLI is `daex`; `ade` still works as an alias. Identifiers keep their old
names for compatibility: `ADE_*` env vars, `~/.ade/`, `.ade/ade.db`, the
`ade-adopt-v1` / `ade-dpop-v1` signing strings, the `X-ADE-*` headers, the
`"ADE1"` binary-frame magic, and the `_ade-sync._tcp` mDNS service.

Deep dives in this folder:

- [crdt-model.md](crdt-model.md) — CRR retrofit, merge rules, iOS pure-SQL emulation.
- [ios-companion.md](ios-companion.md) — the iPhone controller.
- [remote-commands.md](remote-commands.md) — the command registry controllers call.
- [devices-and-machines.md](devices-and-machines.md) — `daex devices`, `--machine`, `--code`.
- [cross-machine-agents.md](cross-machine-agents.md) — agents and the CLI across machines.
- [cross-machine-session-handoff.md](cross-machine-session-handoff.md) — moving a chat to another machine.
- [push-notifications.md](push-notifications.md) — account Activity, APNs and Live Activity.
- [web client](../web-client/README.md) — the browser controller.

## Source file map

The sync implementation lives in `apps/ade-cli/src/services/sync/`. The files
in `apps/desktop/src/main/services/sync/` are one-line re-exports (plus
`machineOnlySyncSnapshot.ts`, `syncStatusReaders.ts` and
`packagedSyncHostLaunchGate.ts`); do not edit them expecting the runtime to see
the change.

### Brain sync (`apps/ade-cli/src/services/sync/`)

- `syncService.ts` — per-project orchestrator: runtime, peer client, device
  registry, viewer draft, PIN store; port candidates (8787 first) and
  `tryMigrateToPort` back to 8787 every 15 s.
- `syncHostService.ts` — the per-project WebSocket host: hello and pairing,
  sealed adoption, codec and chunk framing, changeset export/ack, per-peer
  scheduling, chat/terminal streams, project catalog and switch, roster,
  foreign and personal chats. See *Sync protocol*.
- `sharedSyncListener.ts`, `syncListenerBind.ts`, `syncListenerPortController.ts`,
  `syncLoopbackProbe.ts`, `syncListenerPortInspect.ts`, `windowsPortHolders.ts` —
  the one brain-level listener all project hosts share: port choice, zombie
  reaping, loopback side door, socket handoff across project switches, Origin
  check, the attachment HTTP route.
- `brainProjectActionsSyncHandler.ts`, `brainRoutedCommands.ts`,
  `brainChatSubscriptions.ts` — the machine-wide fallback handler that answers
  before a project host is active.
- `syncHelloProtocol.ts` — the one `hello` / `pairing_request` parser for both
  ingresses (auth kinds `bootstrap`, `paired`, `account`, `account_sealed`,
  `guest`).
- `syncAccountHelloAuth.ts` — account-hello gates and rejection strings. "No
  usable pairing record" and "unknown device" answer the same, so the
  handshake is not an existence oracle.
- `adoptChannelHandshake.ts`, `machineIdentitySigningStore.ts` — the
  `ade-adopt-v1` host half and the machine's Ed25519 key
  (`~/.ade/secrets/machine-identity-signing.json`). Primitives:
  `apps/desktop/src/shared/sync/adoptChannelCrypto.ts`.
- `syncPairingStore.ts`, `syncPinStore.ts`, `syncSecurityStore.ts`,
  `brainMachineSyncStores.ts` — pairing records, the PIN, `requireDpop`, and the
  machine-level store set (one per secrets dir, shared by ingress and RPC).
- `syncPairFailureTracker.ts` — PIN failure limits (device, address, global).
- `pairedDeviceRejectionLimiter.ts` — throttles repeated paired-hello rejects
  from one device.
- `syncDpop.ts` — DPoP proof checks and the bounded nonce cache.
- `syncPeerCursorResolution.ts` — `resolveInitialPeerCursor` (see below).
- `changesetPump.ts`, `mobileReplicaReseed.ts` — batch chunking and the
  compact reseed for a far-behind phone.
- `syncProtocol.ts`, `syncBinaryFrame.ts` — envelope codec, protocol range,
  compression, chunk reassembly limits, ports 8787–8999.
- `syncRemoteCommandService.ts` and the `*RemoteCommands.ts` files (Apple,
  Android, provider accounts, automation rules, webhooks, machine update,
  analytics) — the command registry; see [remote-commands.md](remote-commands.md).
- `syncTerminalStreams.ts`, `syncTerminalSnapshotBarrier.ts`,
  `syncTerminalTargets.ts`, `appControlSyncStream.ts` — terminal and App Control
  streams.
- `syncChatWire.ts`, `syncChatTranscriptReads.ts`, `chatLogResume.ts` — chat
  wire compaction, transcript reads, `sinceSequence` resume.
- `rosterBuilder.ts`, `syncRosterFanout.ts` — the all-projects roster, read from
  each project's `.ade/ade.db` read-only so no project boots.
- `attachmentUploadService.ts` — HTTP attachment upload tickets.
- `deviceRegistryService.ts` — the `devices` table and `sync_cluster_state`.
- `syncHostSingleton.ts`, `syncHostStartupLoop.ts`, `syncHostRecovery.ts` — the
  machine-wide host lease, startup retries, and `sync.diagnoseHost` /
  `sync.recoverHost`.
- `hostInstanceGuard.ts` — keeps a copied DAEX home (a forked cloud box) from
  coming up as the machine it was copied from.
- `projectlessSyncSnapshot.ts`, `syncRouteHealth.ts`, `syncStatusEventPublisher.ts`
  — status with no project, route health, coalesced `sync-status` events.
- `syncCloudRelayStore.ts`, `syncCloudRelayStatus.ts`, `machineRelayTunnel.ts`,
  `relayTunnelAuthorityGate.ts`, `syncTunnelClientService.ts`,
  `syncRelaySelfProbe.ts`, `relayAuthorization.ts` — the Relay identity, the
  one tunnel client per machine, its gate, the end-to-end probe, and in-place
  lease renewal for Relay peers.
- `machineConnectionRoutes.ts` — this computer's connection routes and the
  per-computer relay switch (the preference file is in `syncCloudRelayStore.ts`).
- `resolveTailscaleCliPath.ts`, `tailscaleServeCommand.ts`,
  `tailnetHttpsServe.ts`, `tailscaleLocalStatus.ts` — Tailscale Serve publishing.
- `laneShare*.ts` — lane sharing on the host; see [lane sharing](../lanes/lane-sharing.md).
- `syncPeerService.ts` — the WebSocket client for a runtime that joins another
  as a viewer.

### Brain outside `services/sync/`

- `apps/ade-cli/src/multiProjectRpcServer.ts` — machine JSON-RPC: `projects.*`,
  `sync.*`, `runtimeEvents.*`, `ade/actions/call`, `personalChats.*`.
- `apps/ade-cli/src/eventBuffer.ts`, `runtimeEventVolume.ts` — runtime-event
  replay buffer (`eventEpoch`, `gap`, 1 MiB drain); App Control frames are
  transient and opt-in.
- `apps/ade-cli/src/services/personalChats/personalChatScope.ts` — personal
  (no-project) chats on both ingress paths.
- `apps/ade-cli/src/services/account/` — account session, directory, publisher:
  `accountAuthService.ts`, `accountSessionRotationJournal.ts`,
  `accountAttestationVerifier.ts`, `accountMachinePublisherService.ts`,
  `accountMachineDirectoryService.ts`, `hardwareAnchor.ts`,
  `machinePairingRepair.ts`, `machinePairingAutoRecovery.ts`,
  `machineRemovalRequest.ts`, `thisMachineRefusalText.ts`,
  `accountSettingsStore.ts`, `accountCacheStore.ts`, `accountVaultStore.ts`,
  `accountRuntimeLifecycle.ts`, `machineBridge.ts`.
- `apps/ade-cli/src/services/credentials/credentialStore.ts`,
  `osBoundKeyMaterial.ts` — the encrypted credential file
  (`.ade/secrets/credentials.json.enc`) shared by brain, CLI and desktop.
- `apps/ade-cli/src/services/power/` — battery and sleep truth
  (`machinePowerReader.ts`, `suspendGapDetector.ts`, `machinePowerMonitor.ts`,
  `sharedMachinePowerMonitor.ts`).
- `apps/ade-cli/src/services/push/` — Activity publishing; see
  [push-notifications.md](push-notifications.md).
- `apps/ade-cli/src/lib/fileStampedMemo.ts`, `services/sync/machineIdFile.ts` —
  in-memory reads of identity files (one async `stat` per read).
- `apps/ade-cli/src/cliDevices.ts`, `cliRemoteWork.ts` — `daex devices` and
  `--machine` calls.

### Account server and relays

- `apps/account-directory/src/directory.ts` — machine register, list, delete;
  phantom-row superseding; `withCloudTruth` for cloud computers.
- `apps/account-directory/src/callerToken.ts`, `pairingGrants.ts` — fresh
  interactive sign-in proof (`PAIRING_AUTH_FRESHNESS_MS`, 10 min) and
  single-use pairing grants (reserve, then consume or release).
- `apps/account-directory/src/deviceAuthorization.ts`, `activityRelay.ts`,
  `diagnostics.ts`, `githubApp/` — device sign-in page, relay hand-off,
  diagnostic upload sink, the DAEX GitHub App grant.
- `apps/push-relay/src/accountSettings.ts`, `accountVault.ts`, `attention.ts`,
  `liveActivity.ts` — account settings, vault, Activity.
- `apps/tunnel-relay/` — the Relay Worker.

### Desktop

- `apps/desktop/src/shared/types/sync.ts` — protocol DTOs, hello error codes,
  `describeUnpublishedAccountDirectory` (the only `{ summary, nextAction }`
  advice table for an unpublished machine), `isAccountDirectoryNoReply`.
- `apps/desktop/src/shared/accountDirectory.ts`, `accountMachineRefusal.ts`,
  `reconnectOutcome.ts`, `machinePresence.ts`, `types/power.ts`,
  `types/machineInventory.ts`, `types/syncHostRecovery.ts`,
  `syncHostRecoveryUi.ts`, `syncMobileCompatibility.ts`, `pairingQr.ts`,
  `rpcLiveness.ts`, `runtimeErrors.ts` — shared contracts.
- `apps/desktop/src/preload/preload.ts` — `window.ade.sync.*` routing.
- `apps/desktop/src/main/services/remoteRuntime/` — paired and SSH connections
  (`remoteConnectionPool.ts`, `remoteConnectionService.ts`,
  `attachmentUploadRoute.ts`, `attachmentUploadClient.ts`,
  `connectionDiagnosis.ts`); see [remote runtime](../remote-runtime/README.md).
- `apps/desktop/src/main/services/power/` — Electron `powerMonitor`, suspend
  and resume forwarded as `machine.reportPowerTransition`, keep-awake.
- `apps/desktop/src/main/services/account/` — vault reads, credential renewal
  lock, integration credential syncs, inventory refresh.
- `apps/desktop/src/main/services/attention/`, `renderer/components/activity/`,
  `renderer/state/activityStore.ts` — Activity; see
  [push-notifications.md](push-notifications.md).
- Connection UI: `renderer/components/app/ConnectionsPanel.tsx`,
  `TopBar.tsx`, `IntegrationBanners.tsx`;
  `renderer/components/remoteTargets/RemoteTargetList.tsx`,
  `remoteMachineModel.ts`, `machineSectionFold.ts`;
  `renderer/components/settings/SyncDevicesSection.tsx`,
  `useSyncConnections.ts`, `accountDirectorySummary.ts`,
  `BrainRepairButton.tsx`; `renderer/components/account/YourMacsCard.tsx`;
  `renderer/lib/localSyncStatusReader.ts`, `thisComputerOffline.ts`,
  `reconnectThisComputer.ts`, `accountSettingsSync.ts`.
- Cross-machine Work: `renderer/state/crossMachineLanes.ts`,
  `cloudSavedChats*.ts`, `cloudSavedTerminals.ts`, `adeCloudRestingReads.ts`;
  `renderer/components/terminals/useWorkMachineRouter.ts`, `useLanePrs.ts`.
- Chat handoff: `main/services/chat/crossMachineHandoff*.ts`,
  `handoffGitBundle.ts`; see
  [cross-machine-session-handoff.md](cross-machine-session-handoff.md).
- Hosted web wire: `renderer/webclient/sync/wireProtocol.ts`, `connection.ts`.

### iOS (`apps/ios/ADE/`)

- `Services/SyncService.swift` (+ `SyncService+*.swift`) — the WebSocket
  client, pairing, sealed adoption, command routing.
- `Services/SyncConnectionRace.swift`, `SyncRecoveryPolicy.swift` — the route
  race, route memory, reconnect and roam policy.
- `Services/MachineFleet.swift`, `MachineConnection.swift`,
  `MachineConnection+Terminal.swift`, `TerminalStreamClient.swift` — connected
  machines and their roster sockets (eight-machine limit).
- `Services/Database.swift`, `Resources/DatabaseBootstrap.sql` — native SQLite
  with pure-SQL CRR emulation.
- `Services/KeychainService.swift`, `SyncMachineWake.swift` — secrets and
  presence (must match `machinePresence.ts`).

## Gotchas

- **Sync carries state; actions go to the owning machine.** A command about a
  chat, lane, terminal or session goes to the machine that owns it, by its pin
  (see [remote runtime](../remote-runtime/README.md#gotchas--fragile-areas)).
  Account-wide things (Activity, vault, account settings, DAEX Cloud) come from
  the account server and take no pin.
- **The runtime owns sync; the desktop is a client.** A window bound to a remote
  runtime is not the authority for that project. Reach the sync service through
  the runtime bridge, not the renderer or Electron main.
- **Relay ownership is machine-wide.** Any runtime can bind a listener, but only
  the holder of the sync host lease may dial Relay or publish to the directory
  (the relay keeps one control socket per `machineKey` and evicts the old one
  with `4505`). New machine-exclusive work gates on `holdsSyncHostSingleton()`
  and rides out the 5 s release grace.
- **A project is never a precondition for machine-level work.** Hosting phone
  sync, publishing and Relay gate on the lease plus a bound listener. Copy that
  says "open a project to publish" is wrong; advice lives in
  `describeUnpublishedAccountDirectory`.
- **Port 8787 is canonical.** Bind order tries 8787 first even when `lastPort`
  is 8788, and a fallback listener keeps trying to move back. The "DAEX is
  already running with phone sync" dialog is the cross-channel case (Stable vs
  Alpha) and is intended.
- **Project-scoped commands need `projectId`.** A brain hosts many projects and
  has no current one; a missing id is `missing_project`. The catalog id and the
  DB-local project id are accepted as aliases.
- **CRR retrofit strips non-PK UNIQUE constraints.** Upserts on synced tables
  target the primary key only.
- **iOS sends unpacked primary keys.** `kvDb.ts` `normalizeIncomingCrsqlChange`
  repacks them before insert; skipping it makes phone edits silently not apply.
- **Rolling schema removals are filtered before apply.** `kvDb.ts` drops rows
  for tables that no longer exist locally; an all-ignored batch is a no-op.
- **iOS has no cr-sqlite binary.** Any cr-sqlite feature DAEX depends on must be
  implementable in SQL triggers on iOS.
- **A host-side check does not guard a replicated column.** A controller writing
  the column can win the merge. Stop the controller writing it and drop it from
  that peer's inbound changesets (see *Host-authoritative columns*).
- **Mobile exclusion is an outbound filter; local-only CRR is not.**
  `MOBILE_CHANGESET_EXCLUDED_TABLES` only drops rows going to phones (acks still
  advance). `LOCAL_ONLY_CRR_EXCLUDED_TABLES` changes CRR metadata and has an
  apply hazard ([crdt-model.md](crdt-model.md#apply)). Exclude a table from
  phones only if the phone has another way to get it (for example
  `pull_request_snapshots` via `prs.refresh`); check the iOS queries and the
  required-command set first.
- **Wire and stored transcript share one compaction policy**
  (`shared/chatEventCompaction.ts`), so it must be idempotent. Dropping a wire
  field nobody decodes is safe; adding or reshaping one needs a capability gate.
- **A live `chat.send` that timed out is ambiguous.** iOS queues and replays a
  send made while offline, but does not resend one it already attempted; it
  restores the draft and asks the user to check the transcript.
- **The pairing PIN is user-managed.** No expiry, no rotation. Only its PBKDF2
  hash persists, so after a restart the host can verify but not show it. Clear
  it from the This computer card to stop new direct pairings.
- **`ADE_ENABLE_DESKTOP_SYNC_HOST=1` is a dev-only diagnostics hatch.** It runs
  the legacy in-process host beside the brain; packaged builds ignore it.
- **`brain_*` and `sync.connectToBrain` are legacy names.** Say "sync authority"
  and "runtime connection" in new code and docs.

### Another program on the sync port's loopback address

macOS and Windows let a program bind `127.0.0.1:<port>` while DAEX holds
`*:<port>`; it then gets all local traffic for that port (often `wrangler dev`,
whose default is also 8787). Relay is unaffected (pipes are handed over in
process), LAN is unaffected (peers reach the wildcard bind), and Tailscale
Serve needs a working loopback route.

The public port does not move for a loopback shadow, because phones redial on a
port change. The listener opens a **side door**: a second server on
`127.0.0.1:<free port>` validated by the same identity probe; Tailscale Serve
forwards there (`getLoopbackPort()`, `loopbackPort`, `shadowedBy`). It re-checks
every 30 s (`SYNC_LISTENER_SELF_HEAL_INTERVAL_MS`) and closes the side door once
loopback answers as DAEX again. The port moves only when a foreign program
answers on one of this machine's LAN addresses, a loopback-only bind is
shadowed, or the side door cannot open. Connected sockets survive a move. Logs:
`sync_listener.loopback_side_door_opened` / `_closed`,
`sync_listener.moved_off_shadowed_port`.

## Where the sync authority runs

The authority is the machine's `daex serve` brain. The desktop renderer, iOS
and web are clients. Windows x64 hosts sync like macOS and Linux (named pipe for
local RPC, `crsqlite.dll`); Linux ships `crsqlite.so` in the standalone
tarball. `crdtSyncAvailable` blocks pairing when the extension is missing.

### The machine-wide sync host lease

`syncHostSingleton.ts` owns an advisory lock file at
`$TMPDIR/ade-sync-host-<uid>.json` (`ADE_SYNC_HOST_LOCK_PATH` overrides) with
pid, channel, home, project root and port. A project scope takes it when its
sync service starts; a projectless brain takes a `projectRoot: null` lease. The
brain also holds it beside a scope that follows another machine (a viewer), so
the machine still hosts and publishes; machine-wide sync calls then answer for
the machine (`machineWideSyncService`).

The relay tunnel and the directory publisher gate on the lease.
`holdsSyncHostSingleton()` reports it; a loss is debounced by
`SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS` (5 s) because a project switch stops the
old host before starting the new one.

#### Two DAEX apps on one computer

One machine has one sync host. A second app (Stable and Alpha, each with its own
`ADE_HOME`) takes no lease, binds nothing and publishes nothing. Its status is
`no_active_sync_scope` with the owner app and pid ("Quit that DAEX to let this
one host sync"). `watchSyncHostAuthorityForRehost` retries when the other owner
exits. The `sync_not_started` state shows **Start sync**
(`account.startSyncHost`). To test the second app over Relay, quit the owner.

#### A brain started by hand

A `daex serve` started beside the installed service brain starts with sync off
(`serviceBrainPidBesideHandRunBrain()` in `apps/ade-cli/src/serviceManager/index.ts`;
log `sync.host_left_to_service_brain`). The service brain (launchd job pid,
systemd MainPID, or the Windows supervisor's child) always keeps sync. A dev
test machine (`npm run dev:machine`) has its own home and lease.

### Hosting sync, and publishing, with no project

A brain with the lease and a bound listener hosts phone sync, publishes and
dials Relay with an empty `~/.ade/projects.json` (normal for a headless box or a
new install). `projectlessSyncSnapshot.ts` builds the snapshot; the runtime name
and Tailscale Serve belong to a project scope and read as absent. Relay failure
never blocks startup (`sync.projectless_relay_start_failed`).

#### One ingress implementation, two ingress paths

The project host and the brain fallback share `syncHelloProtocol.ts`,
`syncAccountHelloAuth.ts` and `brainMachineSyncStores.ts`, so gate order,
strings and codes match and a PIN set over RPC works at once.

#### `sync.*` on a machine with no project

`multiProjectRpcServer.ts` routes `sync.*` through `withSyncService`: the
project-scoped service when one owns sync, else `ProjectlessSyncControls`.
PIN, `forgetDevice`, `requireDpop` and relay status work; `listDevices` returns
`[]` and `getRuntimeName` `null`; `setRuntimeName`, `updateLocalDevice` and
transfer readiness need a project. Lane presence waits for the host.

## Who participates

- **Machine runtime** — per-channel, per-machine `daex serve`. Owns agents,
  PTYs, worktrees and the sync server; several projects behind one listener.
- **Desktop renderer** — client of the local or a remote runtime.
- **iOS app** — always a client.
- **Web client** — always a client (`device_type: "browser"`). Adopts a
  same-account machine through the directory and Relay, then uses a per-device
  secret and WebCrypto DPoP. No SQLite replica: changesets are invalidation
  signals.
- **Cloud computers** — `daex serve` brains on DAEX Cloud, one per cloud lane.
  While one sleeps, the account server answers reads for it.
- **Lane share guest** — another account; Relay only, `auth.kind: "guest"`,
  default-refuse access to one lane, no changesets or catalog
  ([lane sharing](../lanes/lane-sharing.md#the-guest-connection)).
- **Cluster state** — the `sync_cluster_state` row (`brain_device_id`,
  `brain_epoch`) names the device that executes.

## Connection route policy

Native controllers rank current LAN, then current Tailscale, then Relay (only
with a fresh matching account proof). The desktop pool walks them in phases
(`buildPairedEndpointCandidates`); iOS races them (Relay joins a few hundred ms
behind the lead direct candidate, or first when it is the proven route for the
current network). First-time adoption uses direct routes only when the
directory row has a verifiable host signing key; an unsigned host is Relay-only.
The web client normally has only Relay.

Each native connect keeps one correlation id and at most eight attempt records
(no paths, tokens or error text). Directory requests send
`X-ADE-Correlation-ID`.

## Mobile compatibility contract

`apps/desktop/src/shared/syncMobileCompatibility.ts`: the brain advertises
`features.mobileCompatibility` (required and missing actions). A missing host
feature puts the phone in a limited mode; the socket stays up.
`MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS` lists additive commands newer
phones feature-detect (each with a comment on the fallback). The brain rejects
iOS builds below `MIN_SUPPORTED_MOBILE_APP_BUILD` with
`protocol_version_mismatch` / `updateTarget: "client"`. When a phone release
needs new host behavior, update the contract and the iOS compatibility tests
together.

## What syncs, what does not

| Data | Mechanism | Who |
|---|---|---|
| Replicated tables in `.ade/ade.db` | cr-sqlite over WebSocket | All connected devices |
| Source code | Git | Desktop peers |
| Shared scaffold (`.ade/.gitignore`, templates, `.ade/workflows/linear/**`) | Git | Desktop peers |
| Account settings (launch defaults, quick slots, new-lane defaults, lane templates, CTO home, automation rules) | Account settings store via the push relay, last writer wins per key | Every signed-in client |
| Passwords and provider API keys | Account vault via the push relay; never readable from a browser | Every computer; iPhone through its own routes |
| Cloud lanes' chats, CLI copies, Git summaries | Account server | Every client, no computer awake |
| `.ade/local.yaml`, `.ade/local.secret.yaml` | Never | — |
| Worktrees, PTYs, caches, transcripts, artifacts, sockets, machine secrets | Never | — |
| Analytics ids and consent | Never (paired-client consent is per socket) | — |
| PR detail bodies (`pull_request_snapshots`) | Desktops replicate; phones fetch via `prs.refresh` | — |
| Chat continuation on another machine | Git + bounded handoff capsule | Connected desktops |
| Personal chats | Runtime commands + `chatScope: "personal"` stream | Controllers of the owning machine |

Two devices in one cluster do not have identical `.ade/` folders. Live state
converges only through one running sync authority.

### Host-authoritative columns are peer-scoped

`terminal_sessions.settled_at`, `settle_override`, `settle_source`,
`activity_status_json` and `activity_status_changed_at`
(`HOST_AUTHORITATIVE_COLUMNS_BY_TABLE` in `syncHostService.ts`) are host
decisions. The host drops them from inbound changesets **from phone peers
only**:

- A paired desktop runs the same `sessionService` gate, so its writes still
  replicate; moved settle columns are re-asserted through the receiving host's
  gate ([settle-teardown-design.md](../terminals-and-sessions/settle-teardown-design.md)).
- `isMobilePeer` reads the pairing record, so a phone cannot claim to be a
  desktop.
- The drop is silent and per column; the batch still acks `ok`, and the phone
  heals on the next `work.listSessions`.

### The host never exports from an uncorroborated peer cursor

A replica names its resume point in `hello.peer.dbVersionBySite`; an inflated
claim would lose rows for good. The host records what it delivered in the
host-local `sync_peer_changeset_watermarks` table and
`resolveInitialPeerCursor` (`syncPeerCursorResolution.ts`) seeds the cursor as
`min(claimed, watermark)`, or `0` when there is no watermark (one full,
idempotent replay). A rewind logs `sync_host.peer_cursor_rewound`. iOS advances
its cursor only from a batch's `toDbVersion`.

## DAEX Cloud and the account server

Every account has DAEX Cloud: one machine in every machine list and "Run on"
menu. Each cloud lane has its own cloud computer running the same brain; it
sleeps when idle. The account server (`apps/account-directory`) keeps what can
be read while it sleeps:

| Data | Written by | Read by |
|---|---|---|
| Saved chats (encrypted, after each turn) | Cloud computers | Work |
| CLI and shell copies (last 5,000 lines) | Cloud computers | Work |
| Git summary at rest | Cloud computers, before sleep | Files, Git, History |
| Project overview | Server | Lanes, Work |
| Fork capsules for deleted computers | Idle cleanup | The chat's next computer |
| Account lane index | Every brain | Lane mentions only |
| CTO account copy | The CTO home | CTO page |

Own computers never upload chats, sessions or Git summaries.

- **Reading never wakes a computer.** Files and History read GitHub at the
  lane's branch; PRs, issues and checks go through the account; nothing polls.
- **Doing wakes it, and the UI does not wait.** A message to a sleeping or
  deleted cloud chat goes to the account queue
  (`POST /cloud/chats/:machineKey/:chatId/messages`); the computer claims it
  once (`clientSendId`). A chat whose computer was deleted continues on a new one
  (fork-continue: Claude, Codex and OpenCode restore a native capsule; other
  providers replay the transcript).
- **Refusals** (out of hours, too many awake, blocked, over disk) show the
  server's sentence; reads still work.
- **Git identity**: the account's GitHub noreply identity, else
  `NEUTRAL_GIT_IDENTITY` (`apps/ade-cli/src/services/github/cloudGitIdentity.ts`);
  never replaces a value a person set.

See [DAEX Cloud](../ade-cloud/README.md) and the
[web client](../web-client/README.md#ade-cloud-reads).

## Architecture layers

1. **Clients** (renderer, iOS, web) read local state; state-only writes go
   local, execution goes as a remote command.
2. **Desktop bridge** — project-scoped `window.ade.sync.*` calls go through
   `callProjectRuntimeSyncOr`: `IPC.remoteRuntimeCallSync` for a remote-bound
   window, else `IPC.localRuntimeCallSync`. `window.ade.sync.getLocalStatus` always
   asks this machine's brain, read only through `localSyncStatusReader.ts`
   (coalesced, 1–30 s backoff on `degradedReason`, `{ force: true }` for reads a
   person asked for, last issued wins). During a project switch sync mutations
   fail with "Project is switching"; reads work.
3. **Machine runtime** — `syncService`, `syncHostService`,
   `syncRemoteCommandService`, `deviceRegistryService`, one shared listener.
4. **Transport** — `SyncEnvelope` over WebSocket (below).
5. **CRDT** — loadable cr-sqlite on desktop/runtime; pure-SQL emulation on iOS
   (`AdeDb.sync`: `getSiteId`, `getDbVersion`, `exportChangesSince`,
   `applyChanges`).

## Multi-project runtimes and project switching

The brain exposes every project opened on the machine as one catalog behind one
listener. The phone pairs once and stays on the same port across switches.

1. `hello` → `hello_ok` with the catalog.
2. `project_switch_request` → `prepareProjectConnection` opens the target scope
   and answers `project_switch_result` with the current port.
3. `completeProjectConnection` stops the old host and starts the new one on the
   same port; the new host adopts open sockets. A failed switch restores the old
   host.
4. A project that follows another machine cannot be hosted here.
   `switchSyncHost` with `purpose: "host"` refuses before touching the old host;
   `purpose: "serve"` (status and roster reads, the startup loop) adopts the
   scope as-is. With no host, `resolveActiveSyncHost` picks the most recent
   project whose folder still exists, else hosts machine-level sync
   (`sync.host_project_missing`).

The viewer draft (`sync-peer-draft.json`) records the `projectSiteId` that made
it; other projects ignore it.

Runtime-scoped project envelopes (`project_browse_request`, `_open_`,
`_create_`, `_clone_`, `_list_my_github_repos_`, `_default_parent_dir_`,
`_forget_`) are served by the active host or the brain fallback, so a phone can
add a first project on a fresh machine. Catalogs over 768 KB stream as
`project_catalog_chunk`.

## Scope enforcement

Each command is registered `"runtime"` or `"project"`. A project command with
no `projectId` is `missing_project`; with no open project, `project_not_open`.
A phone must finish `project_switch` before project commands.

## Device registry and cluster state

`devices` (keyed by `device_id`; see `SyncDeviceRecord`) holds name, platform,
`device_type` (`desktop`, `phone`, `vps`, `browser`, `unknown`), addresses,
Tailscale IP and `metadata_json` (peer app version and build from the hello).
`sync_cluster_state` is the singleton (`cluster_id = "default"`) naming the
authority. When a runtime joins another as a viewer it clears both tables and
discards their unpublished DELETEs so it cannot erase the authority's registry.

## Sync authority selection and transfer

Transfer is explicit; no client elects itself and phones never do. Preflight
blocks on running turns and live PTYs; the old authority flushes,
`brain_device_id` changes and `brain_epoch` increments, the new one starts. A
desktop that only pulls the repo is its own machine. Active-active execution is
not supported.

## Account directory and connection leases

The directory is discovery, not liveness authority. The publisher
(`accountMachinePublisherService.ts`) runs only while the brain holds the lease;
a 30 s heartbeat keeps `online` inside a 90 s window and carries the token-free
provider inventory (`types/machineInventory.ts`). It publishes only validated
routes: LAN needs a `kind: "lan"` candidate; `relay` needs a validated bridge
and a passing end-to-end probe. A row stays connectable after `online` lapses
while a verified secure endpoint remains; the authenticated hello is the final
check. Each row carries the machine's Ed25519 `pubkey`; without it publishing
fails closed (`machine_key_unavailable`). The outcome is
`routeHealth.accountDirectory` in `sync.getStatus`, `daex sync status` and the
This computer card.

Sleep is stated, not inferred. `0006_machine_power.sql` adds `power`,
`sleep_state` and `sleep_state_at`; the register upsert coalesces them. On
suspend the desktop calls `machine.reportPowerTransition` within 2 s and the
brain publishes once; headless brains infer suspend from a late 15 s tick
(`suspendGapDetector.ts`). Clients age the announcement
(`resolveMachinePresence`, 10-minute window).

A 401 forces one token refresh and one retry; only a repeated 401/403 is
`auth_expired`. Rename is `PATCH /account/machines/:machineKey` with
`customName` (80 chars); display is `customName`, then hostname.

### Cloud computers in the directory

`withCloudTruth` (`directory.ts`) makes a resting cloud computer answer
`online: false`, `sleepState: "asleep"`, and adds `cloud: { state, stateAt }`
(`awake`, `waking`, `updating`, `asleep`, `stopped`, `deleting`). Clients show
these rows as DAEX Cloud.

### One computer, one row

Rows are keyed `(user_id, machine_key)` and the key lives in a file, so losing
the file makes a second row.

- `sync-cloud-relay.json` is written atomically and mirrored to `.bak`; an
  unreadable file is not "no identity"; a new key is minted only when both
  copies yield nothing.
- Rotation (only on a claim `409`) is capped at two per 24 h, counted in the
  file (`MAX_IDENTITY_ROTATIONS_PER_WINDOW`). With the budget spent the machine
  says "This computer needs to be reconnected to your DAEX account."
- A register with fresh sign-in proof whose `deviceId` or `hardwareId` matches
  other rows retires them (at most five), moves the newest custom name, and
  returns `supersededMachineKeys`. `hardwareId` (`hardwareAnchor.ts`) is a hash
  of the OS machine id salted with the account id and the DAEX home, so it
  survives a wiped `~/.ade` but never merges accounts or Stable with Alpha.

### Getting back on after a refusal

Removal records a revocation before deleting the row, so a removed machine
cannot re-register with its old token. Getting back needs an access token whose
interactive sign-in is under ten minutes old, or a single-use pairing grant from
a device-flow sign-in. `machinePairingAutoRecovery.ts` runs the same action as
**Reconnect this computer** after 1 min, 5 min, then hourly (three repairs per
six hours), and leaves a revocation younger than ten minutes alone so a
deliberate removal stands.

A refusal is a `403` with `machine_revoked` or
`pairing_authentication_required`, decoded only by `readAccountRefusalCode`.
The This computer card, banner and `daex setup` share
`describeUnpublishedAccountDirectory`. A `5xx` reads as an account service
problem; no reply at all reads as "no internet connection".

`account.deleteMachine` is for people only: it refuses a caller whose identity
names a chat or run (`callerIdentityIsAgent`) and needs
`confirmation: "REMOVE"`. `daex machines remove` from an agent's shell instead
raises a user-only card in that chat (`machineRemovalRequest.ts`) and exits 0
(`removed`), 2 (`kept` / `timed_out`) or 3 (`pending_approval`).

Sign-out removes directory visibility and Relay authorization but keeps the
device-bound paired secret for LAN/Tailscale; forgetting the machine deletes
trust. Relay peers that advertise `relayReauthorizeV1` renew their account
authorization in place (`relayAuthorization.ts`); older peers close at token
expiry.

### Adopting a manual pairing into an account

A record with `accountOwnerUserId: null` (QR, Nearby/PIN or SSH pairing) is
adopted when the same `deviceId` sends an account hello: the host sets the owner
and returns credentials.

- The hello must carry a DPoP proof against the key already pinned on that
  record (`isValidDpopPublicKey`); a keyless record or one owned by another
  account is refused.
- A client may send the `pairedSecret` it holds (desktop and web, only inside the
  sealed channel or over Relay). If it matches, nothing is minted and
  `accountPairing` is omitted. Otherwise the new secret is **staged**
  (`pendingRotation`) and promoted by the first hello that uses it; older
  unproven secrets move to `displacedAccountSecretHashes` (16). Log:
  `sync_host.account_pairing_secret` (`kept`, `staged`, `minted`).
- Adoption is deferred while a PIN re-pair is pending.
- `localTrustOrigin` is sticky: sign-out (`revokeAccountOwnedExcept`) demotes
  such a record to local trust instead of deleting it.

## Device discovery

- **Machines**: Connections › Machines pairs with a same-account machine (no
  PIN), Nearby + PIN, or Advanced SSH. There is no share link or manual address
  + PIN form.
- **Phone pairing**: account sign-in (no PIN), or QR / Nearby + the user-set
  6-digit PIN (`~/.ade/secrets/sync-pin.json`). Failed PINs are limited per
  device, per address and globally (`syncPairFailureTracker.ts`: 10 failures →
  2-minute cooldown per device/address).
- **QR payload**: version 3, encoded as
  `https://ade-app.dev/pair#<base64url(JSON)>` (`PAIRING_QR_URL_BASE` in
  `apps/desktop/src/shared/pairingQr.ts`; the fragment never reaches a server).
  It carries machine identity, port, address candidates, `relayUrl`, and an
  advisory `pinConfigured`; never a code.
- **Address candidates**: LAN IPs, saved `lastHost` (classified as `lan` or
  `tailscale` when it matches), Tailscale IP, loopback, and a `relay` candidate
  while the account lease is current. Paired phones learn the relay URL from
  `hello_ok` / `brain_status` (`cloudRelayWssUrl`).
- **mDNS**: `_ade-sync._tcp` with addresses, runtime kind/version and project
  count in TXT, republished only when the signature changes. macOS also runs a
  native `dns-sd -R` child and kills orphans from a crashed session.
- **Pairing files** live under `~/.ade/secrets/` (`sync-device-id`,
  `sync-bootstrap-token`, `sync-pin.json`, `sync-paired-devices.json`).
- **Tailscale Serve**: with a usable CLI (`ADE_TAILSCALE_CLI` or the macOS app
  path) the brain runs per-node `tailscale serve` to the live port
  (`SyncRoleSnapshot.tailnetDiscovery`), then reclaims stale DAEX entries
  (`sync_host.tailnet_serve_reclaimed`) so the port does not ratchet upward.

## Sync protocol (summary)

Envelopes are JSON: `version`, `type`, optional `projectId`, `requestId`,
`compression` (`none` | `gzip` | `deflate`), `payloadEncoding`, `payload`,
`uncompressedBytes`. Types are listed in `SyncEnvelope`
(`apps/desktop/src/shared/types/sync.ts`): hello and pairing, account
challenge, changesets, heartbeat, file, terminal, chat, roster, launch events,
`brain_status`, project catalog and switch, commands, `rpc_*` and `fwd_*`
(paired desktops), `envelope_chunk`.

Types and `hello_ok.features` keys are additive inside
`SYNC_PROTOCOL_MIN_SUPPORTED...SYNC_PROTOCOL_VERSION` (`1...1`); unknown types
are ignored. A version outside the range gets an uncompressed `hello_error`
`protocol_version_mismatch` with `updateTarget`, then close `4406`.
`hello_ok.projectHost` carries the project-host readiness snapshot.

#### Fast connects on slow links

Each is gated so old and new sides keep the old behavior:

- `X-ADE-Hello` upgrade header (direct routes only) saves a round trip.
- `hello.pipelined` (host says how many it ran in `features.pipelinedHello`).
- `commandRoutingDigest` / `projectCatalogDigest` skip unchanged lists.
- Roster head rows and `roster_chats_request` pages (`rosterChatPagesV1`);
  roster resume by `sinceSeq`.
- Changeset ack window (`changesetAckWindowV1`, up to 8 batches / 1 MiB).
- Conditional read arguments (`ifNoneMatch`, `acceptDelta`, `headRows`, …) that
  old hosts ignore.

#### `hello_error` codes are the contract; the message is not

Branch on `SyncHelloErrorPayload.code`, never on the text:

| Code | Client action |
| --- | --- |
| `repair_required`, `auth_failed` | Pair again (only if `host.deviceId` matches the pairing held). |
| `account_not_signed_in`, `account_verification_failed`, `host_update_required`, `account_session_changed` | Fix the account or update that machine. Never drop the pairing. |
| `relay_account_required` | Sign in on this device. |
| `connection_attempt_superseded` | Another route won; drop quietly. |
| `invalid_hello` | Client bug or version skew. |
| `protocol_version_mismatch` | Update the side in `updateTarget`. |

A client drops saved credentials only when the rejecting `host.deviceId`
matches the paired machine; an unattributed rejection (a stranger on a reused
address) keeps the pairing. Pairing errors are `invalid_pin`, `pin_not_set`,
`pairing_failed`.

Compression is negotiated: the client offers `hello.compression`, the host picks
`deflate` (512 B threshold) in `hello_ok`, both switch after that frame. No offer
keeps legacy gzip at 4 KiB (web: plain JSON). Decode is capped at 25 MiB.
Envelopes over 720 KiB are split into `envelope_chunk`s when both sides declared
`chunkedEnvelopes`; reassembly allows 8 sets, 512 parts, 32 MiB and expires
after 30 s.

#### Chat attachments ride HTTP, not the envelope stream

`hello_ok.features.attachmentUploadV1` (`{ enabled, path, maxBytes }`) is sent
only when `chat.createAttachmentUpload` is registered. The client mints a
ticket over the socket, then `POST`s raw bytes with `Authorization: Bearer
<ticket>` to the same port over HTTP. A ticket names one project and extension,
lives two minutes and is spent before the first body byte. A relay route, an SSH
target or an old host falls back to `chat.saveTempAttachment` (images, 10 MB).
iOS uses the legacy path for images.

### Chunked staging for file-shaped attachments

Documents and videos over Relay use the command channel:
`chat.beginTempFileAttachment` → `chat.appendTempFileAttachmentChunk` (512 KiB
slices) → `chat.finishTempFileAttachment` (or `chat.abortTempFileAttachment`),
owned by `apps/ade-cli/src/services/fileAttachment.ts`. The 50 MB ceiling
(`MAX_CHAT_ATTACHMENT_BYTES`) is enforced server-side on the running total.
Bytes land in a `.part` file renamed only on finish; sessions are in memory with
a 5-minute idle TTL, and `begin` sweeps orphaned `.part` files.
`chat.getAttachmentChunk` reads back for previews; it does not sniff MIME, so
callers must keep the path inside the project.

### Transport readiness and path truth

- **Relay readiness.** Controllers open `/connect/<machineKey>?ready=2`; the
  Worker sends `accepted` (v2) at once and `ready` only once the brain's pipe is
  owned by the sync host. `hello` before `ready` is forbidden. No `accepted` in
  time means an old Worker: retry on a fresh URL without `ready`. Messages are
  bound to a connection epoch, so a stale pipe cannot attach to a new control.
- **The race.** iOS staggers candidates by 250 ms, at most three at once, a
  10-second budget; the first `hello_ok` wins. All candidates share one
  `peer.connectionAttempt`; the host rejects late losers as
  `connection_attempt_superseded`. `hello_ok.connectionTransport` (`direct` |
  `relay`) is the host's truth about the path.
- **Heartbeats** every 60 s; desktops close after two misses, phones after six
  (`MOBILE_SYNC_HEARTBEAT_MISS_LIMIT`).
- **Cursors** are per host database (`remoteDbVersionBySite` keyed by
  `serverDbSiteId`), so switching hosted projects neither replays nor skips. A
  batch never splits rows of one `db_version`.
- **Acks.** Batches stay pending until `changeset_ack`; after six failures the
  sender rebuilds from the same `fromDbVersion` with smaller windows (host down
  to 16 rows / 16 KB; iOS down to one row / 4 KB). A phone more than 5,000
  versions behind with ack and chunk support gets one compact `catchup` batch
  (≤10,000 rows / 4 MiB).
- **Command dedupe.** Phone commands are cached by `commandId` (30 min, 512
  entries, plus a persisted journal) so a retry after reconnect does not run
  twice.

### Sub-protocols at a glance

| Sub-protocol | Notes |
|---|---|
| Changesets | 250-row / 256 KB batches; compact reseed for far-behind phones. |
| Files | On-demand reads, listings, writes. Desktop-local `external` workspaces are never exposed to phones. |
| Terminals | Offset-stamped snapshot plus live output behind a snapshot barrier; `sinceOffset` resume; acked, deduped input (`inputId`); the desktop size returns after the last phone leaves. |
| Chat stream | Per-session `seq` with a 500-event / 2 MB replay buffer; `sinceSeq` replay or snapshot; byte-capped tail snapshot clamped to the client's `maxBytes`; `turnActive` in the ack; `chat_history` paging only for a subscribed session. |
| Durable chat log (`chatLogV2`) | Readers use the durable `.ade/transcripts/chat/<id>.jsonl`. `sinceSequence` + `generation` resume up to 2 MB, else a snapshot with `gap: true` (`row_too_large` when a too-big row hides part of the range; [transcript-and-turns.md](../chat/transcript-and-turns.md#a-row-too-large-to-page)). `historyGeneration` increases on in-place rewrites. `beforeSequence` paging. |
| Roster | All projects' chats, shells and CLI sessions without booting projects; `roster_snapshot` then `roster_delta`; identity-bound chats (CTO) left out. |
| Commands | `command` → `command_ack` + `command_result`. |
| Projects | Catalog, switch, and runtime-scoped project actions. |
| Paired desktop runtime | Runtime JSON-RPC over `rpc_*`; loopback port forwards over `fwd_*` with pause/resume. Needs the host grant from same-account adoption or Nearby PIN. |
| Lane presence | `lanes.presence.announce` / `release`; `LaneSummary.devicesOpen`, 60 s TTL. |

## Command routing and execution isolation

Controllers never run agents. State-only writes replicate as changesets;
execution (worktrees, terminals, PRs, chat sends) goes as a `command` the
runtime runs. Each action has a `SyncRemoteCommandPolicy` (`viewerAllowed`,
`requiresApproval`, `localOnly`, `queueable`) and a scope; clients read the
runtime's descriptors and gate on them.

`viewerAllowed: false` covers anything that hands out or mints a credential
(`sync.getWebPairingInfo`, `sync.getDesktopPairingInfo`,
`cto.setLinearToken`, `cto.clearLinearToken`). `projectConfig.get` / `.save`
stay viewer-allowed but drop `ai.apiKeys` and `providers` on read and keep the
on-disk values on write. Full list: [remote-commands.md](remote-commands.md).

## External session import commands

`work.listExternalSessions`, `work.getExternalSessionDetail` (120-event pages)
and `work.importExternalSession` (queueable; `target: "cli"` or `"chat"`) are
viewer-allowed. The runtime does discovery, validation and resume on the host;
the controller never reads provider files. The phone reaches only the one sync
host on the shared port, so mobile testing needs the feature on that host. See
[External Session Import](../terminals-and-sessions/external-session-import.md).

## Security model

- **DPoP pairing.** Each device keeps a P-256 key (Secure Enclave on iOS).
  `pairing_request` pins the public key; every paired `hello` signs
  `ade-dpop-v1\n deviceId\n sha256(pairedSecret)\n ts\n nonce`. Once a key is on
  record the host fails closed and refuses bootstrap-token hellos for that
  device. `requireDpop` (`ADE_SYNC_REQUIRE_DPOP`) also refuses keyless devices.
  The brain fallback path runs the same check.
- **Plaintext `account` bearer** is accepted only on `relay-bridge`
  provenance, which only in-process code can set (`acceptRelayPipe`). Direct
  routes use `paired` auth or sealed adoption.
- **Sealed adoption (`ade-adopt-v1`).** `account_challenge` (nonce, X25519
  key) → `account_challenge_ok` (host X25519 key, Ed25519 signature over
  `ade-adopt-v1 | hostDeviceId | nonce | clientEph | hostEph | ts | aead`). The
  client verifies against the directory `pubkey` before sending anything, then
  sends `account_sealed`; credentials return in a sealed `hello_ok`. The AEAD is
  the first mutual choice (`chacha20-poly1305`, `aes-256-gcm`) and is signed, so
  it cannot be downgraded. Clients that omit the list get unsigned ChaCha
  (`sync_host.legacy_adoption_aead_unbound`). It protects the credentials, not
  the later session.
- **PIN pairing** unlocks a durable per-device secret; later connections use the
  secret.
- **Account-owned credentials** sync through the vault (provider keys,
  `linear_refresh_token` with a per-device `refreshOwner`, a pasted GitHub token,
  a `gh` login); access tokens, env tokens and CLI refresh tokens stay on their
  machine. The DAEX GitHub App grant lives in the account directory, which hands
  machines short-lived tokens.
- **Transport.** LAN is not TLS; the runtime listens on all interfaces (trusted
  LAN/tailnet posture). Tailscale adds WireGuard.
- **Relay.** The brain keeps an HMAC-signed outbound control to
  `apps/tunnel-relay`. TLS ends at the relay, so the relay operator can read
  paired secrets and payloads; treat it as trusted. Relay runs only with a
  current account lease **and** the sync host lease. Each Relay hello carries a
  fresh Clerk token matching the host's account. The `relay` route is published
  only after an end-to-end self-probe; a JSON ping every 180 s catches "zombie"
  controls the edge still answers.
- **Lane share guests** see only the shared lane; their account token goes only
  to the account directory.
- **One-release trust reset.** Desktop, iOS and web each removed old pairing
  state once behind a marker. Do not broaden or rerun it.

## Per-computer relay switch

The owner can turn DAEX Relay off per computer (Settings › Account, the row's
details). The setting is `sync-relay-preference.json` beside the relay identity;
absent or unreadable means on. Off closes the control within a second, stops
advertising the relay URL, and reports `relay.enabled: false, turnedOff: true` so
no banner fires. DAEX MCP rides the same control, so it is off too. The switch
is read and changed on the computer it belongs to
(`account.getConnectionRoutes` / `account.setRelayEnabled`; for another
computer, over its live paired connection via
`apps/desktop/src/main/services/account/accountConnectionRoutes.ts`).
