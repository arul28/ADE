# Sync and Multi-Device

ADE syncs live runtime state across an ADE machine runtime and any connected
controllers (other computers, iPhones) using **cr-sqlite** as a CRDT-backed
replication layer over a **WebSocket** transport. The design is local-first:
eligible routes are preferred in **LAN → Tailscale → Relay** order for
desktop-to-runtime and iOS connections. The account-gated cloud
tunnel relay is eligible whenever the machine is signed in to an ADE account,
unless its owner turned **ADE Relay** off for that computer in Settings ›
Account (see *Per-computer relay switch* below). Two
machines on the same LAN (or Tailscale tailnet) converge their application
state directly.

This README covers the sync model, the runtime/controller role split, what
does and does not travel, and the layers that implement it. Deep-dives:

- `crdt-model.md` — cr-sqlite CRR retrofit, schema implications, merge
  semantics, and the iOS pure-SQL emulation layer.
- `ios-companion.md` — the iPhone controller path: SwiftUI app, native
  SQLite, pairing, tab structure, command routing from phone to runtime.
- `../web-client/README.md` — the hosted browser controller path: static
  Cloudflare Pages SPA, account sign-in and directory adoption, WebCrypto DPoP,
  browser-safe sync transports, no local DB, and the `window.ade` adapter over
  remote commands.
- `remote-commands.md` — the `syncRemoteCommandService` registry that
  turns client actions into runtime-executed mutations.
- [`devices-and-machines.md`](./devices-and-machines.md) — the one model
  agents learn for using a device on any machine: the words (machine, device,
  source, lane, "your code there"), `ade devices`, `devices use|current`,
  `--machine`, `--code synced|as-is|fresh`, `--clone`,
  `--no-code`, `--to` on `chat handoff|move`, MCP, and the ADE Cloud iPhone.
- `cross-machine-agents.md` — agents and the CLI on other machines:
  `--machine`, `--all-machines`, children that wake parents across machines and
  projects, remote device drive with proof filed back (the implementation
  under `devices-and-machines.md`).
- `cross-machine-session-handoff.md` — moving a Work chat to another
  machine: the brain-owned move record and its states, agent and CLI control,
  approval, the source banner and send routing, the Git contract (clean and
  published, or uncommitted work carried as a bundle), the bounded context
  capsule, destination setup, and idempotent recovery.
- `push-notifications.md` — Activity's account-wide source of truth and
  its APNs + Live Activity pipeline: machine publishers, the Cloudflare
  consolidation relay, desktop/web/iOS reads, native Mac presentation,
  per-device policy, exact routing, acknowledgments, and ownership fences.

Web client: the browser client is another controller of the same machine
runtime. New hosted connections are account-only: the browser signs in, chooses
a same-account machine from the directory, and receives DPoP-bound paired
credentials through Relay. It does not keep a local SQLite replica; it uses
changeset batches as invalidation signals and refreshes state through remote
commands, file requests, and chat/terminal streams. For ADE Cloud it reads
the account server and GitHub (see *ADE Cloud and the account server*).

Fresh controller launches require an ADE account. A device paired earlier
may use its explicitly labeled direct/local recovery path while signed out, but
that path is not a guest account and never becomes an account-wide view.

Account Activity deliberately does **not** follow that selected machine or
project binding. Every signed-in brain publishes all of its active projects to
the account relay, while signed-in desktop, hosted web, and iOS read
the consolidated account stream through an account-scoped path. Navigation and
actions still carry the owning machine/project/session so the client can adopt
or select the correct destination. Without an account, a client may show only a
truthfully labeled local or explicitly connected-machine snapshot; it must
never present that subset as the account view.


The brain rejects iOS builds older than `MIN_SUPPORTED_MOBILE_APP_BUILD` with `protocol_version_mismatch` and `updateTarget: client`, then closes the connection. The phone asks the user to update ADE.

## Where the sync authority runs

The sync authority is the machine-owned `ade serve` runtime in
`apps/ade-cli/`. The desktop renderer is a client of that runtime through the
local runtime connection pool, as the iOS app is. A desktop window bound to a
remote runtime is not the authority either; the remote `ade serve` is.

The legacy in-process desktop sync host is off. It runs only with
`ADE_ENABLE_DESKTOP_SYNC_HOST=1` (and without `ADE_DISABLE_SYNC_HOST=1`).

Windows x64 can host sync like macOS and Linux: a per-user, per-channel named
pipe for local RPC and `vendor/crsqlite/win32-x64/crsqlite.dll` for CRR.
Linux x64 and arm64 ship `crsqlite.so` in the standalone tarball. The typed
`crdtSyncAvailable` status blocks pairing when the extension is missing, and
Connections shows reinstall guidance. macOS computer use and the iOS
Simulator do not gate Windows pairing.

### The machine-wide sync host lease

Hosting phone sync is exclusive per machine. `syncHostSingleton.ts` owns an
advisory lock file at `$TMPDIR/ade-sync-host-<uid>.json` (override
`ADE_SYNC_HOST_LOCK_PATH`) with the owner's pid, channel, home, project root
and port. A project scope takes it when its sync service starts. A projectless
brain with the shared listener takes a `projectRoot: null` lease and drops it
when a scope takes over.

Two subsystems gate on the lease, not on a bound listener:

- the relay tunnel (`syncTunnelClientService`), because the relay keeps one
  host socket per `machineKey` and evicts the previous one with close code
  `4505`;
- the account-directory publisher (`accountMachinePublisherService`), because
  a runtime that does not host sync must not advertise endpoints.

`holdsSyncHostSingleton()` reports authority, and
`onSyncHostSingletonAuthorityChanged()` reports changes. A loss is debounced
by `SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS` (5 s), because
`ProjectScopeRegistry.performSyncHostSwitch` stops the old host before it
starts the new one. Without the grace, each project switch would restart the
relay tunnel and the publisher.

#### Two ADE apps on one computer

One machine has one sync host. A second ADE app (for example the release
build and an Alpha build, each with its own `ADE_HOME`) takes no lease, binds
no listener and publishes nothing. It does not retry into ownership and does
not stop the other app.

- `getStatus` reports `no_active_sync_scope` with the owner app and pid in
  `skipReason`. Connections says "another ADE app on this computer owns sync
  for this machine (ADE Alpha, pid 9253)" and "Quit that ADE to let this one
  host sync." `ade doctor` shows the same sentence.
- A brain that loses the lease does not stay a viewer.
  `watchSyncHostAuthorityForRehost` runs the startup loop again when a loss
  outlives the grace, so the other owner's exit hands sync back.
- The `sync_not_started` state shows **Start sync** on the This-machine card
  (`thisComputerAction` → `account.startSyncHost`, the same
  `recoverSyncHostConnection` as the phone's "Fix connection"). The card then
  says "No ADE on this computer is hosting sync right now".
  `repairMachinePairing` on a non-host says to start sync first.
- To test the second app over the relay, quit the owner first.
- A startup conflict logs its quit instructions once, then one line with a
  count at most every ten minutes.

#### A brain started by hand

An `ade serve` that a person, an agent or a test starts beside the installed
brain does not host sync. `runServe` asks
`serviceBrainPidBesideHandRunBrain()` (`apps/ade-cli/src/serviceManager/index.ts`)
for the channel's service brain (launchd on macOS; the systemd unit or the
detached supervisor on Linux; the supervisor's pid record on Windows). If that
brain is alive and is another process, this brain starts with sync off, prints
"ADE: sync disabled because the installed ADE brain (pid …) hosts phone sync
on this computer", and logs `sync.host_left_to_service_brain`. `--no-sync`
silences the line.

The service brain always keeps sync:

- Windows: its parent is the supervisor the pid record names.
- macOS: launchd's pid for the job must be this brain. A parent of pid 1
  proves nothing, because launchd adopts every orphan.
- Linux: the unit's MainPID is this brain or its parent (a wrapper).
- Each `systemctl` or `launchctl` lookup has a 2 s limit; no answer leaves
  sync on. A dead service brain does not count.
- A dev test machine (`npm run dev:machine`) has its own home and lease and
  keeps sync.

### Hosting sync, and publishing, with no project

A brain that holds the lease and has the shared listener bound hosts phone
sync, publishes itself and dials the relay with an empty
`~/.ade/projects.json`. That is the normal state of a headless box and of a
new install.

- `projectlessSyncSnapshot.ts` builds the `SyncRoleSnapshot`. Hosting means
  the lease **and** a bound port; a listener without the lease reports
  `buildDegradedProjectlessSyncSnapshot`. A hosting snapshot has the real
  port, the identity from `~/.ade/secrets/sync-device-id` and `sync-site-id`,
  `pairingConnectInfo` and relay health.
- The publisher gates on `listenerBound` and `pairingConnectInfo`, so
  `runServe`'s `getSnapshot` uses the projectless builder whenever this brain
  holds the lease, and null only when it does not.
- **"Open a project" is never the fix for an unpublished machine.**
  `no_active_sync_scope` means another ADE process holds the lease. The
  per-state advice is in `describeUnpublishedAccountDirectory`
  (`apps/desktop/src/shared/types/sync.ts`).
- The runtime name and Tailscale Serve belong to a project scope, so the
  snapshot reports them absent ("Open a project to publish this machine on
  your tailnet."). The pairing PIN is machine-level: the snapshot reports its
  real state, and exposes the PIN and bootstrap token under the same
  `hosting` gate. Publishing does not need a PIN; account membership is the
  auth path.
- `machineRelayTunnel.ts` builds the relay tunnel for both paths; `runServe`
  builds it on the event that takes the projectless lease. Relay is never a
  precondition: a failure logs `sync.projectless_relay_start_failed` and
  startup goes on.

#### One ingress implementation, two ingress paths

- `syncHelloProtocol.ts` — the one parser for `hello` and `pairing_request`
  (`bootstrap`, `paired`, `account`, `account_sealed`, `connectionAttempt`).
- `syncAccountHelloAuth.ts` — the account-hello gates (attestation, same
  account, device key, pairing mint or rotate, commit lock) and the
  rejection messages. The brain leaves the connection-arbitration and
  sealed-adoption options unset; the gate order, strings and codes are
  shared.
- `brainMachineSyncStores.ts` — the machine-level PIN, pairing and security
  stores, one set per secrets directory (key `pathKey(resolvedDir)`, so
  `C:\Users\…` and `\\?\C:\Users\…` share one set). The ingress handler and RPC
  must share the instances, so a PIN set over RPC works at once.

#### `sync.*` on a machine with no project

`multiProjectRpcServer.ts` routes `sync.*` through `withSyncService`: the
project-scoped service when one owns sync, else the `ProjectlessSyncControls`
(`createProjectlessSyncControls`, on `brainMachineSyncStores`). Without
controls (tests, embedded runtimes) a call fails with "Sync service is not
available. Register a project first."

- With a fallback: `sync.getPin`, `setPin`, `generatePin`, `clearPin`,
  `sync.forgetDevice`, `sync.getRequireDpop`, `setRequireDpop`,
  `sync.getCloudRelayStatus`.
- Empty answers: `sync.refreshDiscovery` (the machine snapshot),
  `sync.listDevices` (`[]`), `sync.getRuntimeName` (`null`).
- Still the register-a-project error: `sync.setRuntimeName`,
  `sync.updateLocalDevice`, transfer readiness.
- Lane presence is accepted and waits for the sync host.
- `machineSyncStatusWithPin` echoes a just-written PIN on the snapshot,
  because the store reports only a code it set itself.

`buildSyncCloudRelayStatus` (`syncCloudRelayStatus.ts`) is the one relay
status for both paths. Its `accountSignedIn` gate is ownership, not
usability; see
[remote runtime → Account state and reachability](../remote-runtime/README.md#account-state-and-reachability).

## Who participates

- **Machine runtime** — the per-channel, per-machine `ade serve`. It owns
  agents, PTYs, worktrees and the sync WebSocket server. It holds several
  open projects behind one listener on a stable port. A phone picks a
  project from the machine catalog; when the hosted project changes, the new
  host **adopts** the open sockets.
- **Desktop renderer** — a client of the local runtime, or of a remote
  runtime (then sync state lives on that machine).
- **iOS app** — always a client, over the same `SyncEnvelope` protocol.
- **Browser web client** — always a client (`device_type: "browser"`). It
  adopts a same-account machine through the directory and Relay, then
  reconnects with a per-device secret and WebCrypto DPoP. It keeps **no**
  SQLite replica: changesets are invalidation signals. A four-client pool
  bounds live sockets. For ADE Cloud it reads the account server and GitHub.
  See `../web-client/README.md`.
- **Cloud computers** — `ade serve` brains on ADE Cloud, one for each cloud
  lane, sync authorities while awake. While one sleeps, the account server
  answers reads for it.
- **Lane share guest** — another account that the owner shared one lane
  with. It connects over Relay only with
  `auth: { kind: "guest", deviceId, ticket, dpop }` (a one-use ticket the host
  redeems with its owner's token, and a DPoP proof). It gets no changesets,
  catalog, roster or runtime RPC, only a default-refuse list for the granted
  lane, and no pairing record. See
  [lane sharing](../lanes/lane-sharing.md#the-guest-connection).
- **Cluster state** — the singleton `sync_cluster_state` row
  (`brain_device_id`, `brain_epoch`) names the device that owns execution.

"Brain" and "host" in code, schema and protocol types mean the **sync
authority**.

## Connection route policy

Every native paired controller ranks routes the same way:

1. current LAN endpoints;
2. current Tailscale endpoints;
3. ADE Relay, only with a fresh matching account proof.

- Current discovery beats stale saved metadata; recent successes break ties.
- The desktop pool walks the ranking in phases
  (`buildPairedEndpointCandidates`). iOS races the plan: Relay joins a few
  hundred milliseconds behind the leading direct candidate, or first when it
  is the proven route for the current network (see *Route ranking, route
  memory, and roaming* in `ios-companion.md`).
- First-time adoption also uses LAN → tailnet → Relay when the directory row
  has a verifiable host signing key, because `ade-adopt-v1` seals the account
  credential. An unsigned legacy host is Relay-only; ADE never sends a
  plaintext account bearer to an unverified direct peer.
- The hosted web client applies the same ranking to routes a browser may
  dial, which in production is normally Relay only.

Each native connect keeps one random correlation id and at most eight
attempts (route kind, host and port, start, duration, outcome, coarse failure
class; no paths, tokens or error text). The id goes on Relay dials and tunnel
logs. Directory requests send `X-ADE-Correlation-ID`; the Worker validates or
replaces it, returns it, and logs route, method, status class and duration.

## Mobile compatibility contract

Phones must reach older and newer brains long enough to show update state and
run supported commands. The hello is additive: a missing host feature puts the
phone in a limited mode, and the socket stays up.

`apps/desktop/src/shared/syncMobileCompatibility.ts` holds the contract. The
brain advertises `features.mobileCompatibility` (version, required actions,
missing actions). iOS treats an omitted feature as a limited legacy host,
gates unsupported actions before it sends them, and shows update guidance.
When a phone release needs new host behavior, update the contract and the iOS
compatibility tests in the same branch.

The **optional** list (`MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS`) holds
additive commands that newer phones feature-detect, so a host without them is
not `limited`. Each entry has a comment with what the phone does without it
(for example: the Linear connection commands, `cto.getAttention`, the
session lifecycle commands, the new-lane launch commands).
`machine.updateImpact` and `machine.updateAndRestart` ("Update & restart" for
a computer from a phone or ADE Web) are optional too: only a brain started by
`ade serve` that can update itself registers them, and a client that does not
see them keeps its "update ADE there" fallback.
See `remote-commands.md` and `../linear-integration/README.md`.

## What syncs, what does not

| Data category | Sync mechanism | Devices |
|---|---|---|
| Replicated ADE runtime tables in `.ade/ade.db` | cr-sqlite CRRs over WebSocket | All connected devices |
| Source code files | `git push`/`git pull` | Desktop peers only |
| Shared ADE scaffold/config (`.ade/.gitignore`, human-authored templates/skills, repo-backed workflow YAML under `.ade/workflows/linear/**`) | Git | Desktop peers only |
| Account settings: launch defaults, quick slots, new-lane defaults, lane templates, CTO home, automation rules (filed under `repo:<origin>`) | Account settings store through the relay, last writer wins per key; automation rules are a rule key and a home key per rule, and only a rule's home computer runs it | Every computer and phone signed in to the account; the web reads and writes them too |
| Passwords and provider API keys (`provider_api_key`) | Account vault through the push relay; never readable from a browser | Every computer, ADE Cloud too; the iPhone through its own routes |
| Cloud lanes' chats, CLI/shell copies, Git summaries, lane index | Account server (see *ADE Cloud and the account server*) | Every client, with no computer awake |
| Local overrides (`.ade/local.yaml`, `.ade/local.secret.yaml`), including automation rules scoped to one chat or in a project with no remote | **Never syncs** | Machine-specific |
| Worktrees, PTY processes, caches, transcripts, artifacts and proof, sockets, machine-only secrets, connection drafts | **Never syncs** | Machine-specific |
| Product-analytics installation IDs, consent, budgets/deduplication state, and the local `usage_events` export ledger | **Never syncs** | Machine/browser/iOS-client specific; paired-client consent is socket-scoped |
| PR detail bodies (`pull_request_snapshots`: `files_json`, `comments_json`, `reviews_json`) | Desktop peers replicate them; phones fetch them on demand via `prs.refresh` instead | Desktop peers only |
| Cross-machine Work chat continuation | Explicit Git publication + bounded handoff capsule over a connected machine runtime; not CRDT replication | Connected ADE desktops |
| Personal chat summaries/transcripts/attachments | Runtime commands + `chatScope: "personal"` transcript stream; not active-project CRR changesets | Controllers connected to the owning machine brain |

Two devices in one cluster do **not** have identical `.ade/` folders: Git
gives them the tracked scaffold, sync gives them the replicated DB, and each
keeps its own local directories. Two disconnected desktops share no live
session; live state converges only through one running sync authority.

### Host-authoritative columns are peer-scoped

A few columns on replicated tables are host decisions:
`terminal_sessions.settled_at`, `settle_override`, `settle_source`,
`activity_status_json` and `activity_status_changed_at`
(`HOST_AUTHORITATIVE_COLUMNS_BY_TABLE` in `syncHostService.ts`).
`sessionService` decides settlement against live work and stamps activity
reports. cr-sqlite merges last-writer-wins per column, so a controller's
optimistic `settled_at` would merge in even when the host refused the settle.

The host drops those columns from inbound changesets **from phone peers
only**:

- **It is peer-scoped on purpose.** A paired desktop runs the same
  `sessionService` gate, so its writes must keep replicating. They are not
  applied blind: `applyChanges` reports settle columns that moved, and the
  receiving host re-asserts them through its own gate, so they get its
  lifecycle revision (see
  [settle-teardown-design.md](../terminals-and-sessions/settle-teardown-design.md) §6d).
- **A paired phone cannot opt out.** `isMobilePeer` reads the **pairing
  record** for record-backed peers, so `deviceType: "desktop"` in the hello
  does not help. A bootstrap-token peer is still classified from its hello,
  so this is a compatibility guard; the host-local lifecycle revision is the
  real closure. Current iOS never writes these columns
  (`PendingSessionSettleStates.swift` is a local overlay).
- The drop is silent and per column. The rest of the batch applies, including
  the phone's own snooze fields (`snoozed_until`, `snoozed_at`, `woke_*`). The
  batch still acks `ok`, because a rejecting ack would stall the peer's
  cursor. The phone's value heals when `refreshWorkSessions` replaces the
  rows from `work.listSessions`.

See [terminals and sessions](../terminals-and-sessions/README.md#gotchas).

### The host never exports from an uncorroborated peer cursor

A replica peer names its resume point in `hello.peer.dbVersionBySite`. The
host exports `db_version > cursor`, so an inflated claim would lose rows for
good.

- The host records what it delivered in
  `sync_peer_changeset_watermarks(peer_device_id, host_site_id, db_version,
  updated_at)`. It is host-local (`LOCAL_ONLY_CRR_EXCLUDED_TABLES`), keyed by
  peer and host site. `syncHostService` writes it on an `ok` ack, on the
  immediate advance for a peer without `changesetAck`, and on an empty-window
  advance, at most once a second per peer, and flushes it on socket close. A
  database with the older single-column table recreates it.
- `resolveInitialPeerCursor` (`syncPeerCursorResolution.ts`) seeds
  `lastKnownServerDbVersion` on the first hello, on handoff adoption and on
  every reconnect:
  - with a watermark for this peer and host site: `min(claimed, watermark)`.
    The watermark is a **ceiling, never a floor**, so a reset phone's lower
    claim replays;
  - with no watermark: `0`, whatever the claim says. A poisoned claim usually
    sits below `hostDbVersion`, so there is no "looks plausible" branch.
    `claimExceededHostDbVersion` is log detail only.
- A device with no watermark gets a full replay once per host site (CRR apply
  is idempotent). The row is written on resolve and raised on each ack.
- A rewind logs `sync_host.peer_cursor_rewound` (`claimed`, `resolved`, the
  reason, `claimExceededHostDbVersion`). Handoff adoption clamps the deposited
  cursor by the watermark too.
- On the peer, `HostConnectionProfile.cursorSchemaVersion` clears an older
  profile's cursors once, and the merge takes the host's batch boundary, not
  the `max`. iOS `advanceRemoteDbCursor` advances only from the batch's
  `toDbVersion`, never from its own write clock.

## ADE Cloud and the account server

ADE works with no computer of your own. ADE Cloud is one machine that every
signed-in account has, and it shows in every machine list and every "Run on"
menu on web, iPhone and desktop. Behind it, each cloud lane has its own cloud
computer. A cloud computer runs the same `ade serve` brain as an own
computer, and it sleeps when it is idle. Clients never show a cloud computer
by its own name.

The account server (`apps/account-directory`) is the second source of truth
next to sync. It keeps what a person can read while a cloud computer sleeps:

| Data | Written by | Read by |
|---|---|---|
| Saved chats (encrypted, after each turn; subagent chats too) | Cloud computers only | Work on every client |
| CLI session and shell copies (shells keep the last 5,000 lines) | Cloud computers only | Work |
| Git summary at rest (branch, ahead/behind, changed files with line counts) | Cloud computers, before sleep | Files, Git panel, History |
| Project overview (lanes and computers of one repository) | The server, from the rows above | Lanes, Work |
| Fork capsules for chats whose computer is deleted | Idle cleanup, before the delete | The next computer of that chat |
| Account lane index (name, branch, machine, PR number; one row for each lane on each machine) | Every brain, own computers too | Lane mentions only (PR rows, notifications, CTO, search) |
| CTO account copy | The CTO home | The CTO page |

Own computers never upload chats, sessions or Git summaries. The lane index
does not fill the Lanes tab.

**Reading never wakes a computer.** Files and History read GitHub at the
lane's branch. PRs, issues, branches and checks read GitHub through the
account. Linear and Jira go through the account server with the account's
own sign-in. Usage, account settings and automations come from the account.
A client reads these with the existing triggers (open, focus, a send); none
of them polls.

**Doing wakes the computer, and the UI does not wait.** A send, a terminal,
an edit, opening a changed file or its diff, and a Git action wake the
lane's computer. A message to an asleep or deleted cloud chat or CLI goes to
the account's queue (`POST /cloud/chats/:machineKey/:chatId/messages`). The
server keeps it, wakes the computer, and the computer claims it and reports
it once (`clientSendId`). A chat whose computer was deleted continues on a
new computer in the same chat row (fork-continue): Claude, Codex and OpenCode
restore a native capsule; the other ten providers replay the saved
transcript.

**Refusals.** A wake that the server refuses (out of hours, too many awake,
blocked, deleting, over the plan's disk) shows the server's sentence on every
client. Reading still works. A blocked account can read and export its saved
chats, read-only. A cloud computer that idle cleanup will delete shows a
"Deleting soon" notice in its lane's chats, with **Keep it**. A Linear event
or a webhook for a sleeping computer wakes it.

**Account sync.** These follow the account to every computer:

- Passwords (the account vault), including provider API keys in one store
  (`provider_api_key`) and the Qwen DashScope key. A browser can never read
  the vault: the push relay answers a browser only on the routes in
  `BROWSER_ACCOUNT_ROUTES` (`apps/push-relay/src/relay.ts`), and no vault
  route is on that list.
- Provider sign-ins carry to cloud computers. ADE proxy logins carry as
  access-only copies (no refresh token), and only to cloud computers.
- Account settings through the push relay: launch defaults
  (`chat.launchDefaults.v1`), quick slots (`quickSlots.v1`), new-lane
  defaults, lane templates, the CTO home and automation rules.

Personal (no-project) chats stay on their machine and do not show while it
is offline. Moving a lane or chat onto ADE Cloud is not built.

**Git identity on cloud computers.** At join, a cloud computer sets Git's
`user.name` and `user.email` from the account's GitHub noreply identity, else
`ADE Cloud <cloud@users.noreply.ade-app.dev>`. It never replaces a value that
a person set.

See [ADE Cloud](../ade-cloud/README.md) for the server routes and the
[web client](../web-client/README.md#ade-cloud-reads) for the client side.

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
│   - negotiated deflate above 512 B; no offer keeps the exact     │
│     legacy encoder (gzip at 4 KB, or web JSON)                   │
│   - compressed payloads ride a binary frame ("ADE1" magic, u32   │
│     header length, header JSON, raw bytes) for peers declaring   │
│     "binaryEnvelopes"; everyone else keeps base64-in-JSON        │
│   - permessage-deflate on both listeners; when a peer negotiates │
│     it the application codec is skipped (stacking measures worse │
│     than either layer alone)                                     │
│   - decode capped at 25 MB; reassembly capped and expires at 30 s│
│   - encoded envelopes >720 KB sliced bidirectionally after the   │
│     host confirms the peer's "chunkedEnvelopes" capability;      │
│     binary peers slice into binary chunks (no base64 re-tax)     │
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

The iOS companion keeps a focused machine connection and a separate roster
connection to each connected machine. `MachineFleet` owns the connected set,
the open project's machines (every paired machine with a copy is kept live,
with no pick), the eight-machine limit, and foreground/background lifecycle; `MachineConnection`
owns each roster socket and its bounded retry state. The Lanes and PRs screens
read each live machine's checkout on demand, while chat, file, and CTO commands
carry that machine and project identity back to the owning runtime.

- `apps/ios/ADE/Services/MachineFleet.swift` and `MachineConnection.swift` —
  account-wide connected machines and their lightweight roster sockets.
- `apps/ios/ADE/Services/TerminalStreamClient.swift` and
  `MachineConnection+Terminal.swift` — the terminal stream state (handlers,
  offsets, queued input, acks) that the focused connection and each roster
  connection share, and the roster connection's terminal transport
  (`features.rosterTerminal`).
- `apps/ios/ADE/Services/SyncService+RemoteLanes.swift` and
  `apps/ios/ADE/Views/Lanes/LaneRemoteMachines.swift` — machine-qualified lane
  reads and stale-result handling for the Lanes tab.
- `apps/ios/ADE/Views/PRs/PrRemoteMachines.swift` — machine-qualified PR-to-lane
  links for the PR list and detail screens.
- `apps/ios/ADE/Services/SyncService+CtoHome.swift` — shared repository CTO
  home selection and fail-closed routing when its machine is offline.

Runtime support files outside `services/sync/`:

- `apps/desktop/src/main/services/remoteWork/remoteWorkCopyService.ts` — the
  work copy a chat on another machine runs commands in here: a hidden git
  worktree per chat, its guarded sync, and its cleanups (see
  [cross-machine agents](cross-machine-agents.md)). `apps/ade-cli/src/cliRemoteWork.ts`
  builds what a `--machine` call sends for it, and moves `ade files push|pull`
  chunks; `remoteWork/remoteWorkFiles.ts` is the host side of those transfers.
  `remoteWork/remoteWorkScratch.ts` makes and sweeps the empty folders a
  `--no-code` command runs in (`<ADE_HOME>/remote-work/scratch/`).
- `apps/ade-cli/src/cliDevices.ts` — `ade devices` (list, `use`, `current`)
  and the device commands following a chat's choice; the ids, the choice's
  shape and the subcommand parse ADE MCP's command check shares live in
  `apps/desktop/src/shared/types/deviceSources.ts` (see
  [devices and machines](devices-and-machines.md)).
- `apps/desktop/src/shared/rpcLiveness.ts` — whether a connection that went
  quiet still answers (`probeRpcLiveness`), shared by the desktop's
  `remoteConnectionPool.ts` and the brains' machine link pool
  (`apps/ade-cli/src/services/account/machineBridge.ts`).
- `apps/desktop/src/main/services/state/crsqliteExtension.ts` and
  `apps/ade-cli/scripts/package-native-deps.mjs` — loadable cr-sqlite for every
  published runtime (`darwin-*`, `linux-*`, `win32-x64`). The packager copies the
  matching payload into the standalone native tarball so `install.sh` brains
  resolve it from `$ADE_HOME/runtime/<target>/vendor/crsqlite/`.
- `apps/ade-cli/src/services/account/accountAuthService.ts` and
  `accountAttestationVerifier.ts` — the shared Clerk session and Relay-token
  verifier.
  - An access token is used only before its signed expiry; a 401 may force
    one refresh.
  - Refresh rotation is safe across processes: an `invalid_grant` waits
    briefly for a peer's rotated token, and stale credentials are
    compare-and-deleted only when no peer replaced them. A rotation persists
    before userinfo enrichment; a subject change fails closed.
  - Attestation errors tell expired tokens and verifier or JWKS outages
    (retry) from account mismatch, bad tokens and configuration (no retry).
  - The device flow sends this machine's key and name (`getMachineName`, for
    example "MacBook Pro · Alpha", after `resolveDeviceDisplayNameSettled`)
    and keeps the single-use pairing grant in memory for 10 minutes
    (`consumePairingGrant`; cleared on sign-out). A removed machine needs that
    grant, so Reconnect and `ade machines reconnect` use the device flow.
  - `apps/account-directory/src/deviceAuthorization.ts` shows **Confirm this
    sign-in** with a read-only code for a link with `user_code` (the desktop),
    and the typed form for the bare page (the CLI). Validation is the same.
  - The Connections popover shows Reconnect only in `ThisComputerStatus` (the
    "This machine" card): one sentence from the advice table, one button
    named by the refusal code ("Sign in again", "Reconnect this computer",
    "Retry", "Repair"), and "Open sign-in page" while a device sign-in waits.
    The Account card, the shell banner and Settings share one flow
    (`lib/reconnectThisComputer.ts`, `useReconnectThisComputer`).
  - A rejected grant is **marked dead, not deleted** (`rejectedAt`,
    `needsReauth`, `rejectedReason`). `sessionState` is `active`,
    `signed_out`, `expired` or `unreadable`; see
    [onboarding and settings → Account session state](../onboarding-and-settings/README.md#account-session-state-is-a-four-state-not-a-boolean).
- `apps/ade-cli/src/services/account/accountSessionRotationJournal.ts` — the
  crash-safe journal for refresh rotation. Clerk consumes the old grant at
  once, so a crash before the new one is saved would look like a revoked
  session. The journal marks an exchange as started for one token
  generation and clears it when the replacement is saved; a leftover entry
  makes the next `invalid_grant` not definitive. `tryBegin` compare-and-swaps
  the entry, so a live peer's exchange is waited out, not raced; a dead
  peer's entry is taken over. It is `account.session.rotation.v1` in the same
  file-backed bucket as the session, so the brain and the CLI both see it.
- `apps/ade-cli/src/services/account/accountMachineDirectoryService.ts` —
  list, delete, rename and adoption for the runtime.
  - Rename writes `customName`; clearing it shows the reported hostname.
  - A 401 forces one refresh and one retry; a final 401 or 403 is
    `auth_expired`, transport and server failures are `unavailable`. One
    correlation id covers both requests.
  - Adoption checks the account owner and session generation before and
    after pairing, and rolls back a new credential if a sign-out wins.
  - `online` is a presence lease; a machine with a verified Relay endpoint
    stays connectable after it.
  - Removal is terminal: the directory records a revocation, deletes the row
    and asks the relay to purge the machine's Activity. A failed purge is
    `AccountMachineActivityPurgeError` (`machineRemoved: true`). Getting back
    on needs `machinePairingRepair.ts` with a fresh sign-in or a spent pairing
    grant, by hand or through `machinePairingAutoRecovery.ts` after the
    ten-minute quiet window. See `push-notifications.md`.
- `apps/desktop/src/renderer/webclient/workspace/WebMachineSessionManager.ts`,
  `workspace/webWorkspaceModel.ts` and `adapter/federated.ts` — the web's
  machine rows, four-client pool and per-binding adapters; see the
  [web client](../web-client/README.md).
- `apps/ade-cli/src/services/account/accountMachinePublisherService.ts` — the
  one publisher of this machine to the account directory.
  - **Lifetime.** `runServe` starts it only while the brain holds the sync
    host lease, and disposes it after a loss longer than
    `SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS`; a new lease builds a new one. The
    snapshot is the active scope's `syncService.getStatus()`, else
    `buildProjectlessSyncSnapshot`. `no_active_sync_scope` means this brain
    does not hold the lease.
  - **Routes.** It derives the machine key from the relay store and publishes
    only validated LAN, Tailscale and relay routes, coalesced. A LAN endpoint
    needs a candidate of `kind: "lan"` (`buildAddressCandidates` classifies a
    saved `lastHost` that matches a current address). The `relay` endpoint
    needs `relayBridgeValidated` and an end-to-end verdict
    (`relayEndToEndVerifiedAt` with no `relayEndToEndFailure`); a route with a
    live end-to-end failure is never kept.
  - **Identity.** Each row has the machine's Ed25519 key as `pubkey`
    (`ed25519:<base64>`, `machineIdentitySigningStore`); without it the
    publication fails closed (`machine_key_unavailable`), because clients
    verify it before a sealed adoption. Each registration also has
    `deviceId` and, when available, `hardwareId` (read on the publish path,
    salted by the account id). A failed anchor read is "no anchor". A reply
    with `supersededMachineKeys` goes to `confirmSupersededMachineKeys` on the
    same store, and the rows this machine retired log
    `account.machine_identity_superseded_confirmed`.
  - **Name and install.** `publishedMachineName` adds ` · Alpha` for Alpha.
    `describeAdeInstall` sends `channel` (`stable` only for `~/.ade`) and
    `adeHome` (relative to the home folder, never a username); the Worker
    stores them (`0011_machine_install.sql`) and returns them.
    `accountMachineRowLabel` shows "MacBook Pro · ADE Alpha".
  - **Timing.** A 30 s heartbeat keeps the row in the 90 s online window (an
    unchanged heartbeat updates only `last_seen_at`) and carries the
    token-free provider and model inventory. Failures retry after 1, 2, 5, 10
    and 20 s; a 401 forces one refresh. Sign-in, relay changes
    (`onPublicationStateChanged`), a Relay identity recovery, and the 5 s
    route-signature observer (`ACCOUNT_MACHINE_RELAY_STATE_POLL_MS`) request a
    coalesced publish, which becomes the new heartbeat anchor. Each
    publication reads the snapshot and token again.
  - **Status.** The last outcome is `routeHealth.accountDirectory` in
    `sync.getStatus`, `ade sync status` and the This computer card (origin,
    HTTP status, `lastHttpReason` from at most 512 bytes of the Worker's
    `error` or `message`, times, route count). It never logs the bearer.
  - **Analytics.** Only two episodes, through `episodeAnalytics.ts` (one event
    while a condition holds, 24 h dedupe): `ade_publish_failing` after two
    minutes (`code`, `leg`, and for the token leg a `cause` from
    `ACCOUNT_PUBLISH_FAILURE_CAUSES`), and `ade_account_session_unreadable`
    (`code` from `getSessionReadFailureReason()`). A refresh that throws while
    signed in is `transport_error` with backoff, not `token_unreadable`. See
    [logging](../../logging.md).
  - **Directory origin.** The publisher and the desktop derive the directory
    from the same Clerk issuer resolver. `ADE_ACCOUNT_DIRECTORY_URL` passes
    the trusted-origin parser. A packaged runtime (`ADE_RUNTIME_PACKAGED=1`)
    ignores an override to the development directory, rejects credentials
    pinned to a development issuer or client, and treats rejected env
    credentials as absent. `ADE_ALLOW_DEVELOPMENT_CLERK=1` is the testing
    escape. Source checkouts keep their overrides.
- `apps/desktop/src/shared/types/machineInventory.ts` — the bounded, token-free
  summary/detail contract for provider accounts, model counts, and harness
  presets that can cross the account-directory boundary.
- `apps/desktop/src/main/services/account/accountMachineInventoryLiveRefresh.ts`
  — the connected-peer-only detail refresh used when a desktop expands an
  account-directory machine row; it never pairs or reconnects an offline peer.
- `apps/ade-cli/src/services/account/hardwareAnchor.ts` — machine identity that
  a reinstall cannot destroy. The machine key and device id live under
  `~/.ade`, so a wiped home would mint both again and leave a phantom row.
  The OS still knows the machine: `IOPlatformUUID` (`ioreg`), `MachineGuid`
  (the GLOBALROOT-resolved `reg.exe`, never a bare `reg`), `/etc/machine-id`
  or the dbus fallback.
  - **The raw id never leaves the process.** The wire value is
    `sha256("ade-machine-anchor-v2:" + userId + ":" + rawUuid + ":" +
    adeHomePath)`, so two accounts on one computer get unrelated values.
  - **An anchor names an ADE install, not a chassis.** The canonical ADE home
    is folded in (lowercased through `canonicalWindowsPath` on Windows), so
    Stable, Alpha and a second OS user differ, and a reinstall at the same
    path matches.
  - **It is optional.** A VM, a hardened image or a refused spawn gives null,
    and callers behave as with no anchor. The probe has a 2 s limit and is
    cached for the process, null too. `normalizeHardwareAnchorUuid` rejects
    empty and all-zero values. A v1-hashed row dedups on `device_id`.
- `apps/ade-cli/src/services/account/machinePairingAutoRecovery.ts` — automatic
  recovery from "this computer is not in your account any more", for
  machines nobody looks at. It polls the publisher every 15 s and runs the
  same brain action as **Reconnect this computer**, so a real removal is
  still refused.
  - An episode starts on a latched `machine_revoked` or
    `pairing_authentication_required` (decoded by `accountMachineRefusal.ts`),
    or on `snapshot_failed` for two minutes (one cycle only). Attempts run
    after 1 minute, 5 minutes, then hourly.
  - A revocation younger than `PAIRING_AUTO_REPAIR_REVOCATION_QUIET_MS`
    (10 minutes, the same as the Worker's `PAIRING_AUTH_FRESHNESS_MS`) is
    left alone, because a repair then would undo the user's removal.
  - The budget is a persisted 6-hour allowance in the identity file. With no
    account session it does not try.
  - Logs: `account.machine_auto_repair_episode_started`, `_started`,
    `_failed`, `account.machine_auto_repaired`, `_budget_exhausted`,
    `_episode_ended`.
  - `onGaveUp` (`cli.ts`) sends the diagnostic report and calls
    `recordPairingRecoveryGaveUp`, so publisher health has
    `recoveryGaveUpAt` beside `revokedAt` until the next success or episode.
    The desktop banner names the date, offers **Reconnect this computer**,
    and after a give-up adds "ADE stopped trying to reconnect it on its
    own."
- `apps/ade-cli/src/services/account/thisMachineRefusalText.ts` — the CLI's
  words for a refusal: the removal day (ISO), whether auto repair stopped,
  and `ade machines reconnect`. `readThisMachineRefusalFromWire` reads it; a
  partial record from an older brain is no refusal. It appears in
  `ade auth status` (`thisComputerRefusal` in JSON), `ade sync status --text`
  and the `ade doctor` **Publish health** row (`doctorPublishHealthFromSync`).
  See the [ADE CLI README](../../../apps/ade-cli/README.md).
- `apps/desktop/src/shared/reconnectOutcome.ts` — one sentence for what a
  reconnect did (`describeReconnectOutcome`, `reconnectNeedsFreshSignIn`,
  `readReconnectResult`), read by the desktop and
  `ade machines reconnect --text`. A fresh sign-in reads "Confirm it's you".
- `apps/desktop/src/shared/accountMachineRefusal.ts` — `readAccountRefusalCode`,
  the one decoder of a directory refusal, and `readThisMachineRefusal`
  (`revokedAt`, `recoveryGaveUpAt`). **403 only**; an unknown 403 is
  `"other"`. The server's text in `lastHttpReason` goes no further.
- `apps/ade-cli/src/services/power/` — the machine's power and sleep truth.
  - `machinePowerReader.ts`: macOS `pmset -g batt`; Windows one PowerShell
    call (`root/wmi BatteryStatus`, else `Win32_Battery`, through
    `resolveTrustedWindowsTool`, `windowsHide: true`); Linux
    `/sys/class/power_supply` with no spawn. No battery means `battery`
    **absent**, never `0%`; an unreadable read is `null` and overwrites
    nothing.
  - `suspendGapDetector.ts`: a 15 s tick that reports a suspend when it fires
    more than 60 s late (`overdueBy + tickMs`). It gives Linux and headless
    brains sleep detection.
  - `machinePowerMonitor.ts`: a `MachinePowerSource` (`getPower`,
    `getSleepState`, `getSleepStateAt`, `getSuspendGapMs`, `subscribe`) with
    `suspend`, `resume` and `power-change` events marked `announced` or
    inferred. It polls every 60 s, and anchors an announced suspend apart from
    the gap detector.
  - `sharedMachinePowerMonitor.ts`: one monitor per brain.
    `borrowSharedMachinePowerSource()` gives a wrapper that cannot dispose it.
    Users: the publisher, the chat service, and the RPC for the desktop's
    pre-suspend beat.
- `apps/desktop/src/main/services/power/` — the desktop half.
  `powerStateService.ts` adds Electron's `powerMonitor` (singleton
  `getPowerStateService()`). `machinePowerBrainBridge.ts` forwards only
  `suspend` (one attempt) and `resume` (four retries, 750 ms) as
  `machine.reportPowerTransition` within 2 s; a generation counter stops a
  stale resume after a newer suspend. `brainKeepAwakeService.ts` holds the
  opt-in keep-awake lock, which stays after the desktop quits;
  `keepAwakeService.ts` and `systemSleepConfig.ts` handle GUI authorization and
  OS timers. See
  [onboarding and settings](../onboarding-and-settings/README.md#keeping-the-machine-awake).
- `apps/desktop/src/shared/types/power.ts` and
  `apps/desktop/src/shared/machinePresence.ts` — the shared vocabulary.
  `MachinePower` is `{ battery?: { percent, charging }; onExternalPower }`
  (`toMachinePowerRecord`, `fromMachinePowerRecord`).
  `resolveMachinePresence`: a fresh `asleep` beats `connected`, then
  `connected`, `online`, a heartbeat inside
  `MACHINE_SLEEP_INFERENCE_WINDOW_MS` (10 minutes) as `asleep`, else
  `offline`. `connectedMachineIds` keeps `machineKey` and `deviceId` sets
  apart (only `machine_key` is unique). `machinePowerPhrase` ("82% battery",
  "plugged in", "on battery"), `machineStatusLine`, `machineActionLabel`
  ("Wake" or "Connect"). `apps/ios/ADE/Services/SyncMachineWake.swift` must
  match it exactly.
- `apps/ade-cli/src/services/credentials/credentialStore.ts` — the account
  session's credential store.
  - `EncryptedFileCredentialStore` owns `.ade/secrets/credentials.json.enc`
    (AES-GCM), read by the brain, the CLI and the desktop.
    `ElectronSafeStorageCredentialStore` owns `credentials.safe.enc`.
  - `FILE_BACKED_CREDENTIAL_KEYS` (`account.session.v1`,
    `sync.bootstrapToken.v1`) stay in the file store, because the brain
    cannot read safeStorage. The migration copies the other keys, prunes the
    copies, and keeps `.machine-key`. Writing a file-backed key to the
    safeStorage store throws. An `unreadable` legacy store aborts the
    migration.
  - Reads try the OS-bound key, then the bare machine key (a hit there is
    rewritten). If both fail, it drops the cached key material once per 30 s
    and retries, then reports `getLastReadState() === "unreadable"` with
    `decrypt_failure`, `no_os_key_material` or `store_format`. It never
    writes an empty store over ciphertext it cannot read. The Electron store
    reports the same for an aborted migration (see
    [GitHub connection status](../onboarding-and-settings/README.md#github-connection-status-has-the-same-third-state)).
- `apps/ade-cli/src/services/credentials/osBoundKeyMaterial.ts` — the
  machine-local secret behind the file store's key. `add-generic-password`
  runs **without** `-U`, so a process that loses the create race adopts the
  winner's item. An inconclusive `security` result (timeout, locked, denied)
  fails closed and mints nothing. Only the synchronous path may create; the
  asynchronous path reads. The read path backs off on any miss; the create
  path backs off only when the keychain was unavailable, so `not_found`
  never blocks first-run creation.
- `apps/push-relay/src/accountSettings.ts` and
  `apps/push-relay/migrations/0008_account_settings.sql` — the account settings
  store (non-secret). It is in the push relay because the relay already takes
  authenticated writes from the brain, iOS and the web; the directory's only
  write route is the machine heartbeat.
  - One row per setting; last writer wins **per key**, so an offline machine
    cannot revert keys it never saw.
  - The Worker stamps `updated_at`; the caller's `changedAt` is diagnostic.
  - Machine-scoped settings never arrive. A per-computer setting (the Apple
    device options) keys the device into the name,
    `device.<syncDeviceId>.<key>` (`accountDeviceSettingKey`), because the
    relay accepts only the `all` and `repo:` scopes. The brain reads its own
    key first, then the old account-wide key (`readAppleDeviceSetting` in
    `apps/ade-cli/src/bootstrap.ts`).
- `apps/desktop/src/shared/accountSettingsScope.ts`,
  `apps/desktop/src/renderer/lib/accountSettingsSync.ts` and
  `useAccountSettingsSync.ts` — the renderer half.
  `accountSettingScopeKey` builds keys for `account` and `account-repo`;
  `accountDeviceSettingKey` is null until the device id is known.
  `accountSettingsSync.ts` is a local-first write-through engine with per-key
  stamps and a retry queue; its registry is the only list of what travels.
  The brain emits `account_settings_changed` after a pull, and the renderer
  hydrates at once. The renderer's 30 s tick forces a relay pass only before
  the first merge or with a queued edit; otherwise it reads the brain's cache.
  A remote change normally arrives within one publisher heartbeat (30 s).
- `apps/ade-cli/src/services/account/accountSettingsStore.ts` and
  `accountCacheStore.ts` — the machine's copy, with the shared owner, epoch,
  queue, cursor and encrypted-cache parts. Reads never use the network. A
  write goes to the cache, answers at once and queues; `sync()` uploads, then
  pulls.
  - Rules, each with a test: **upload before pull**; **a pulled row must be
    strictly newer** than the cached one; **the queue clears by sequence**,
    not by timestamp; **a truncated pull is not `ready`**; **a PUT that landed
    drops its seqs** even when a later DELETE cannot be sent.
  - A write that cannot reach disk rolls back and fails. A cache of another
    account is discarded.
  - The store is keyed by machine ADE directory, shared by every project
    scope, and exists only when sync is on (`--no-sync` has none).
  - **When it pulls.** The relay returns settings and vault **change marks**
    (`accountChanges`, kept in `accountChangeMarks.ts`) on each publish. A
    moved mark pulls at once. Else a 30 s tick pulls only with queued edits,
    after a failed or missing sync, with marks older than 90 s, or every
    5 minutes. A skipped tick still reports `ready`. "Already synced" is bound
    to the account and cache epoch. A mark is
    `<newest updated_at>#<rows at that instant>`.
  - **Backoff.** 30 s doubling to 10 minutes, at least 60 s after a relay
    429, per account, over every trigger; it does not report `ready`. An
    explicit `sync()` still tries once.
  - The vault store uploads about 250 ms after a write. `sync({ maxAgeMs })`
    answers from a fresh cache.
- `apps/ade-cli/src/services/account/accountVaultStore.ts` — the machine's
  vault cache, `account-vault.json.enc` (atomic, machine-key encrypted,
  `0600`). A legacy `account-vault.json` is read for migration and removed.
  Writes check the owner and cache generation, so a late write after
  sign-out is dropped.
- `apps/desktop/src/main/services/account/accountVaultRead.ts`,
  `rotatingCredentialOwner.ts`, `credentialRenewalLock.ts` and
  `integrationCredentialStorage.ts` — shared by the integration credential
  syncs (`github/githubPatAccountSync.ts`, `github/githubGhAccountSync.ts`,
  `cto/linearAccountSync.ts`, `jira/jiraCredentialService.ts`).
  `readAccountVaultItem` reads one item; each sync compares it with its
  machine copy.
  - `githubGhAccountSync.ts` keeps a github.com `gh` login as its own item
    (`all` / `integration` / `github-cli`), apart from the pasted token
    (`github`). The machine that last published a `gh` login owns the copy
    and releases it at a `gh` logout. "Remove from my account" writes
    `removed`. An adopted copy lives only in `github.ghAccountToken.v1`, never
    in `gh`'s files, and is tried last (`shared/githubOperationCredential.ts`).
    `gh` and `git` in agent shells, CLI sessions and chats get it too when
    they have no sign-in of their own and the repository owner has no ADE
    GitHub App installation (`github/githubSessionEnv.ts`): the App token
    first, then this copy. So `gh` works on an ADE Cloud computer for an
    organization without the App.
  - The ADE GitHub App sign-in is not a vault item. The account directory
    holds it (`apps/account-directory/src/githubApp/`, D1
    `github_app_grants`): it runs the web flow, seals the refresh token with
    `GITHUB_APP_TOKEN_KEY`, and gives machines only short-lived access tokens
    (`POST /github/app/token`). GitHub's callback shows a confirm page naming
    the ADE account and the login; only its one-time POST saves the grant.
  - Machines cache the token in `github.accountAppToken.v1`
    (`shared/github/accountAppTokenClient.ts`) and use it as `account_app`
    after their own sign-ins and before a `gh` copy. When GitHub refuses it,
    the install check and relay poll ask once for a different token and
    retry once (at most once a minute per refused token; "Check again" always
    asks). The "Connected to your ADE account as @login" line reads again
    when its answer is older than 30 s. A legacy device-flow sign-in moves to
    the account (`POST /github/app/adopt`). Without
    `GITHUB_APP_CLIENT_SECRET` the routes answer 503.
  - `credentialRenewalLock.ts`: one process at a time renews a rotating
    credential (an exclusive lock file with a heartbeat, removed only by its
    holder).
- `apps/push-relay/src/accountVault.ts` and
  `apps/push-relay/migrations/0009_account_vault.sql` — the vault routes and
  per-item table. Values are encrypted before they leave the brain, and
  viewer-allowed clients (browsers) never get them.
- `apps/desktop/src/main/services/account/accountVaultBridge.ts` and
  `accountMigrationRunner.ts` — the desktop bridge to the brain vault and the
  receipt-backed sign-in migration of provider API keys, Linear OAuth
  credentials, and old project secrets into Passwords & Secrets. It is
  write-confirmed per account and source, and keeps device-origin values. A
  pending or failed source retries on a later vault-ready tick.
- `apps/ade-cli/src/services/account/accountRuntimeLifecycle.ts` — on each
  vault-ready tick, moves old project secrets
  (`.ade/secrets/project-secrets.v1.enc` and old `project_secret` vault rows)
  into Passwords & Secrets (`projectSecretService.migrateLegacy`). A newer
  value there wins; an old copy is removed only after the new one is saved.
  See [Passwords & Secrets](../passwords/README.md).
- `account_settings` (`list`, `get`, `set`, `remove`, `sync`) and
  `account_vault` (the same plus `pendingKeys`) action domains — how the
  desktop, the CLI and iOS reach the stores through the brain. Vault calls are
  host and CTO policy-gated.
- `apps/account-directory/src/directory.ts` — machine register, list and
  delete.
  - The list reads the 500 most recently seen rows, orders online first,
    adds `withCloudTruth` for cloud computers, and exposes `Server-Timing`.
    Each request gets a validated or new `X-ADE-Correlation-ID`, echoed and
    logged once.
  - **Superseding phantoms.** Rows are keyed `(user_id, machine_key)`, so a
    rotated identity file makes a second row. A register whose `deviceId` or
    `hardwareId` matches other rows deletes them (at most
    `MAX_SUPERSEDED_MACHINES`, five, oldest first) and returns
    `supersededMachineKeys` (omitted when empty). Both ids are forgeable, so
    this needs the same proof as un-revoking. The newest superseded
    `custom_name` moves to a survivor that has none. The move and the deletes
    are one `DB.batch()`. Superseded keys get no `revoked_machines` row and no
    relay purge.
- `apps/account-directory/src/callerToken.ts` — Clerk token checks and
  *proven-recent interactive authentication*. `pairing: true` is a client
  boolean, so it proves nothing; the authentication **time** does, because a
  refresh renews `exp` and `iat` but not the moment a person signed in.
  `PAIRING_AUTH_FRESHNESS_MS` (10 minutes) reads `auth_time` or Clerk's
  `fva`, never `iat`, and fails closed; the pairing grant is the second path.
  It declares its own env slice to avoid an import cycle with
  `directory.ts`.
- `apps/account-directory/src/pairingGrants.ts` — single-use grants. A spend
  has **two phases**: an atomic `UPDATE ... SET reserved_at` with every rule in
  its `WHERE` (`changes === 1`), then a scoped `DELETE` when the relay agrees,
  or `SET reserved_at = null` when it does not, so a relay outage does not
  burn the grant. A release restores the row as it was, `expires_at` too. A
  reservation older than `PAIRING_GRANT_RESERVATION_MS` (60 s) counts as
  free.
- `apps/account-directory/src/activityRelay.ts`, `logging.ts`,
  `trustedOrigin.ts` — the relay hand-off (revocation clear, Activity purge),
  log helpers and CORS rules. Each refusal logs one line,
  `directory.register_refused`, `.remove_refused` or `.supersede_refused`,
  with the wire `code`, an optional `reason` (`no_proof`, `grant_rejected`, or
  the relay's text) and the correlation id, and is also a Sentry warning
  (Workers Logs sample 10%). Ids appear as 8-character prefixes. There is no
  admin restore route; support uses a D1 statement.
- `apps/account-directory/src/diagnostics.ts` — `POST /diagnostics/upload`,
  the write-only R2 sink for the report dialog and `ade report-issue --send`.
  `index.ts` matches it before the directory router, because it is not
  account-scoped. Authentication is optional but never downgraded. The body
  is capped at 512 KB (header and counted stream). Quotas: five a day per
  user or `cf-connecting-ip`, and `DIAGNOSTICS_DAILY_GLOBAL_LIMIT` (default
  400 a UTC day, `diagnostics_upload_days`, refunded when the `put` fails,
  `503` when D1 is down), because clients also send automatically. The two
  `429` bodies differ (`rate limited`, `daily diagnostics budget exhausted`).
  Uploads may carry `auto` and `failureCode`. See
  [storage and recovery → Diagnostic reports](../storage-and-recovery/README.md#diagnostic-reports-the-report-dialog)
  and `apps/account-directory/README.md`.
- `apps/desktop/src/shared/accountDirectory.ts` — the directory origin,
  bounded response decoding, route allowlist, machine selection and endpoint
  validation for the desktop, the brain and the web. A 401 forces one
  refresh; a final 401 or 403 is `auth_expired` with the Worker's short
  reason. `accountMachineConnectionState` is `available` with any verified
  secure endpoint, even after `online` lapses.

- `apps/ade-cli/src/eventBuffer.ts` — the runtime-event replay buffer (10,000
  events, 16 MB, 1 MB per event). Live subscribers get oversize events too.
  `drain()` returns `eventEpoch`, `gap` and `oldestCursor`, so clients reset
  after a restart or eviction. Transient events (App Control frames) are
  never kept, and `gap` is judged against the newest evicted id. A drain is
  one RPC reply, capped at 1 MiB (`DEFAULT_EVENT_BUFFER_DRAIN_MAX_BYTES`): it
  returns at least one event and sets `hasMore`. `filter` returns one
  category; the cursor still moves past skipped events.
- `apps/ade-cli/src/runtimeEventVolume.ts` — `isHighVolumeRuntimeEvent` (App
  Control `frame` events, 80–350 KB each) and `runtimeEventFrameLaneId`. The
  screencast runs only while something shows or records the lane
  (`appControl.setFrameDemand`). Frames are transient, a client that is
  behind skips to each lane's newest frame, and frames are opt-in per
  subscription (only a desktop on its own local runtime asks). Runtime RPC
  rides `rpc_data`, a required send, so queued frames could close the peer
  with 4001.
- `apps/ade-cli/src/services/sync/chatLogResume.ts` — answers a `chat_subscribe`
  `sinceSequence` by reading the chat's durable transcript backwards
  (`chatTranscriptHistoryPager.ts`): the missed events, or a `gap` with a reason
  (including `row_too_large`, when an oversized row's stand-in sits in the range).
- `apps/ade-cli/src/services/sync/syncStatusEventPublisher.ts` — coalesces
  `sync-status` events (a ~5 KB `SyncRoleSnapshot` each). An equal snapshot is
  dropped; inside `SYNC_STATUS_PUBLISH_INTERVAL_MS` (250 ms) the newest
  replaces the waiting one. The first snapshot after a quiet period goes at
  once. An unserializable snapshot always counts as new.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — the machine JSON-RPC surface:
  `projects.*`, `sync.*` (with `sync.runSelfProbe`, the relay end-to-end
  probe), `runtimeEvents.*`, `ade/actions/call`, `personalChats.call` and
  `personalChats.streamEvents`.
  - `sync.getStatus` with no scope uses `getProjectlessSyncSnapshot`, else
    `buildDegradedProjectlessSyncSnapshot`.
  - `projects.list` resolves at most 24 icons within 750 ms (128 KiB each,
    512 KiB in all).
  - `projects.getHandoffStoragePreflight` checks the parent path, write
    access, a collision, free space and Git access before a handoff clone.
  - `projects.add`, `create`, `clone` and `setCatalogVisibility` take
    `catalogVisibility: "recent" | "system"` and `registrationSource`
    (default `SYSTEM_PROJECT_REGISTRATION`). `projectRegistry.ts` is version
    2; the v1 upgrade marks recent desktop roots and Git checkouts `recent`.
    `add()` promotes to `recent` but never demotes. Desktop action routing
    reuses a cached registration, so a routine action cannot overwrite an
    explicit one.
- `apps/ade-cli/src/services/personalChats/personalChatScope.ts` — lazy
  machine-owned personal runtime injected into both sync ingress paths. It
  validates personal session ownership and exposes the durable transcript path
  and active-turn state used by `chatScope: "personal"` subscriptions.

Desktop connection UI:

- `apps/desktop/src/shared/types/sync.ts` — the account-directory state union,
  `isSyncAccountDirectoryState` (narrows an RPC string), and
  `describeUnpublishedAccountDirectory`, the **only** `{ summary, nextAction }`
  advice table (Connections and `ade setup`). Never show `skipReason` to a
  user. A surface with a button for the fix (**Repair** for
  `token_unreadable`) drops `nextAction`.
  - `sync_disabled`: sync is off; nothing to wait for.
  - `sync_not_started`: sync should run and has not come up yet ("other
    devices can't reach this computer yet", `ade doctor`). The Machines panel
    treats it as inactive (`PUBLISH_INACTIVE_STATES`), not failing.
  - `unpublishedMachineLabel` guards with `isSyncAccountDirectoryState`; an
    unknown state reads "Signed in — sync state isn't available on this
    computer yet".
- `apps/desktop/src/renderer/components/settings/accountDirectorySummary.ts` —
  the Connections line `Signed in — <summary>`. A refusal of this computer
  (`readThisMachineRefusal`) replaces it ("This computer was removed from
  your account on 14 August"). Another machine's snapshot passes null.
- `apps/desktop/src/renderer/components/remoteTargets/RemoteTargetList.tsx` —
  the Machines tab. A publish refused by the directory names the refusal and
  shows **Reconnect this computer** (`useThisComputerRefusal`,
  `useReconnectThisComputer`).
- `apps/desktop/src/renderer/components/app/IntegrationBanners.tsx` — the
  `relay-offline` and `this-computer-offline` banners in `AppBannerHost`.
  `AppShell` seeds `routeHealth.relay` from `sync.getLocalStatus` (this
  machine's relay) through `localSyncStatusReader`, then follows the
  `sync-status` broadcast and commits only when a field the banner reads
  changed; from the same snapshot it keeps one boolean,
  `isAccountDirectoryNoReply(routeHealth.accountDirectory)`.
- `apps/desktop/src/renderer/lib/thisComputerOffline.ts` — the outage rules
  both surfaces share. `deriveRelayOutageState` is `"suppressed"` at once (an
  ownership conflict never recovers alone) and `"down"` after
  `RELAY_OUTAGE_GRACE_MS` (2 minutes) from `relayControlFailingSinceMs`;
  `useRelayGraceRerender` arms one timer for that moment.
  `deriveThisComputerOffline` is true when the relay is `"down"` and the
  account-directory request gets no reply: then the banner says "This
  computer is offline" once and drops the relay banner and GitHub's
  network-failure banner (an unreadable credential store still shows), and
  the Machines tab (`useThisComputerOffline`) drops each machine's red dot and
  "may be asleep" card when its connect never reached it
  (`connectNeverReachedMachine`; a LAN connect that stalled on the handshake
  keeps its card). Both legs are Cloudflare Workers, so a network that blocks
  `workers.dev` looks the same; the copy names the VPN, proxy or firewall
  case. The dismiss keys are global; the relay one is keyed by the outage
  state.
- `isAccountDirectoryNoReply` (`shared/types/sync.ts`) reads the publisher
  health's `failedLeg`: only the HTTP leg's timeout or transport error is
  "no reply" and reads "no internet connection". The same `transport_error`
  on the token leg (a sign-in service answering 429/5xx, a refresh another
  process holds) reads "can't refresh your ADE sign-in", and the setup leg
  (the publisher failing on this computer) "ADE couldn't publish this
  computer". A brain built before `failedLeg` sends none and is read as the
  HTTP leg.
- `apps/desktop/src/renderer/components/app/ConnectionsPanel.tsx` — the
  top-bar Connections panel (Machines, Phone, Web). It passes the current
  route to the Account page so a sign-in returns there. The control ends with
  the account avatar (**Account Settings**). Order: Cursor, Linear, Usage,
  Activity, Connections; narrow windows fold them into one menu.
- `apps/desktop/src/renderer/components/remoteTargets/RemoteTargetList.tsx` and
  `remoteMachineModel.ts` — the one **This computer** card and the only
  wording of publication state. `describeThisComputerCard` gives one sentence
  from `describeUnpublishedAccountDirectory` and one button from
  `thisComputerAction` (`Reconnect this computer`, `Sign in again`, `Retry`,
  `Repair`), with a status dot and the version chip. It is the only reconnect
  control. A device sign-in shows the code and **Cancel**, or the URL with
  **Copy link**. `hideDirectorySummary` keeps `ThisMacCard` from repeating the
  sentence.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx` — the
  `"phone"` and `"web"` variants under the **This computer** card.
  - The card draws the machine-identity tile and version chip
    (`MachineIdentity.tsx`), and owns the PIN manager and the phone QR. Phone
    explains sign-in, QR + PIN and Nearby + PIN; Web is account sign-in only.
    When only the PIN's PBKDF2 hash is known, the card can set a new PIN.
  - It says "sync has not started" once, not twice. The internal "no active
    sync project scope" reads "Other devices can reach this computer once a
    project is open in ADE".
  - Load failures show one recovery step and keep the raw message under
    **Technical details** (open a project; install this build and reopen it;
    restart ADE).
  - `isBrainAccountSessionFailure(...)` (`token_unreadable`) shows **Repair**;
    the re-read after it is forced. A refusal of this computer shows
    **Reconnect this computer** or **Confirm it's you**, only for the local
    machine. `window.ade.sync.getLocalStatus(...)` lets a remote-bound window
    still show this computer.
  - **Stop following \<machine\>** shows when the project's own routed
    status (`useSyncConnections().projectStatus`) follows another machine.
    The confirm names what ADE forgets and needs the tick "I understand this
    computer will host sync for \<project\>". It re-reads the status and
    sends `sync.disconnectFromBrain` only if the project still follows; it
    does nothing if the window changed project. A brain refusal reads "This
    computer is already hosting sync for \<project\>. Nothing was stopped."
    A project still loading gets "This project isn't loaded yet. Open it and
    try again." The button is hidden in a remote-bound window, with no
    project, and on the web.
- `apps/desktop/src/renderer/lib/localSyncStatusReader.ts` — the one reader of
  `ade.sync.getLocalStatus`: concurrent reads join, a `degradedReason` backs
  off 1 s to 30 s, `{ force: true }` skips the backoff, and the last issued
  read wins (`isDegradedSyncSnapshot`, `localSyncStatusBackoffMs`).
- `apps/desktop/src/renderer/components/settings/useSyncConnections.ts` —
  reads the binding's `sync.getStatus` and the machine's
  `sync.getLocalStatus` (forced for person-driven reads). The This computer
  card always shows the local snapshot. `isRemoteBound` compares the two
  `localDevice.deviceId`s; then device controls are read-only, the list shows
  this computer's live `connectedPeers` (`peerToRuntimeDeviceState`), and
  offline-paired rows are not shown. `refresh()` re-reads both without a
  spinner.
- `apps/desktop/src/renderer/hooks/useBrainRepair.ts` and
  `components/settings/BrainRepairButton.tsx` — **Repair** for a brain that
  cannot read the account session: `account.repairSession`, else
  `window.ade.app.restartBackgroundService()`, which resolves when the new
  service answers a ping. `repair.available` feature-detects (no web, no
  mock). A failure shows "Repair didn't finish." with the reason, and a
  **Restart ADE** button if the service stayed down. `disabled` lets
  Reconnect block it. Used by the This Mac card, the Machines publish row and
  `YourMacsCard`.
- `apps/desktop/src/renderer/components/account/YourMacsCard.tsx` — Account
  **Your computers**. If this computer is missing, or publisher health shows a
  refusal while the list is stale, it offers `thisComputerAction` beside
  **Repair** with `describeThisComputerMissing` copy (absence is not proof of
  removal). The version line names the brain's version, or says it fell back
  to the package version. Rows use `MachineIdentity.tsx`. See
  [onboarding and settings](../onboarding-and-settings/README.md).
- `apps/desktop/src/shared/runtimeErrors.ts` — the shared runtime error
  messages and predicates; reuse them instead of new regexes.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` — the Connections
  control, its summary, and requests that open a tab. Browser peers have
  `deviceType === "browser"`.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.test.tsx`
  and `apps/desktop/src/renderer/components/app/TopBar.test.tsx`.

Cross-machine Work union:

- `apps/desktop/src/renderer/state/crossMachineLanes.ts` — the renderer's
  repository-scoped view of each connected machine's lanes, bounded session
  preview and PR rows in the Work sidebar. It is not CRDT replication and does
  not change the tab's binding.
  - PRs live on the machine that owns the lane, so each slice reads
    `pr.listAll` with its lanes (in parallel on a cadence tick). A failed PR
    read keeps the last rows. `decodeForeignPrs` and `decodeForeignLanes`
    drop a row they cannot fully decode (`id`, `laneId`, `headBranch`,
    `githubPrNumber`, `githubUrl`, `state`). A new PR shows once the owner's
    poller maps it; a pinned chat asks the owner for a reconcile on mount and
    focus. See
    [Pull requests](../pull-requests/README.md#which-machine-answers-a-pr-read).
  - A chat created against another binding is filed in that machine's slice
    at once and replaced by the owner's row.
  - Foreign lanes use the local filing and collapse rules. `isActiveBinding`
    decides where a lane renders; `isThisMachine` decides the amber elsewhere
    glyph.
  - A connection snapshot forces a status read only when the reachable
    machines or their projects (id, root, origin) change (a content
    signature). The main process broadcasts a snapshot only when more than
    `lastAttemptedAt` changed. Stamp-only news republishes at most every
    10 s.
  - `requestCrossMachineLanesForMachine(machineId)` forgets that machine's
    lane and status read times together and schedules one coalesced refresh;
    with no subscriber it does nothing.
  - An offline own computer lists no lanes. Cloud computers, resting ones and
    saved cloud copies always list. A cloud lane's main checkout is left
    out.
- `apps/desktop/src/renderer/state/cloudSavedChatsSync.ts`,
  `cloudSavedChats.ts`, `cloudSavedTerminals.ts`, `adeCloudRestingReads.ts` —
  the Work and Lanes rows of cloud computers that are not live here, read
  from the account server (saved chats, CLI and shell copies, the project
  overview). On the desktop, `adeCloudRestingReads.ts` gives the preload the
  list of resting cloud connections (`adeCloud.setRestingTargets`); the
  preload then answers their file, Git and diff reads from the account and
  never wakes them. Their `lane.list`, `session.list` and `chat.listSessions`
  still go to the computer. See the
  [web client](../web-client/README.md#ade-cloud-reads).
- `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx`,
  `SessionListPane.tsx` and `apps/desktop/src/renderer/lib/terminalAttention.ts`
  — file local and foreign chats through `effectiveSessionFilingBuckets`
  (over `sessionFilingBucket`). Controls read the local cache, then the
  cross-machine snapshot, with bounded render-only deadline timers.
- `apps/desktop/src/renderer/components/terminals/useWorkMachineRouter.ts` —
  per-session machine routing. A CLI or shell on another machine opens **in
  place** with its owning binding as the session pin, like a chat: PTY calls,
  preview, transcript and subscriptions go to the owner. The tab switches only
  when the window does not have that binding open. Local sessions have a
  `null` pin.
- `apps/desktop/src/renderer/components/terminals/useLanePrs.ts` and
  `apps/desktop/src/renderer/lib/lanePrBadge.ts` — the lane→PR map. Handoff
  copies lane ids, so keys name the machine: `bound:<laneId>`
  (`boundMachineLanePrs`), `<machineId>:<laneId>` (`lanePrsForMachine`), and
  `any:<laneId>` (`laneHasAnyPr`, the Has PR filter only). A lane has
  `active` and `previous` rows; the badge rolls them up without hiding a worse
  state. A session narrows to its explicit PR links. A badge is foreign when
  a foreign row exists (an unreachable machine has no pin), and `openLanePr`
  sends a foreign PR to GitHub.

Cross-machine Work chat handoff:

- `apps/desktop/src/main/services/chat/crossMachineHandoffOrchestrator.ts` —
  the source brain's move: the durable record per chat (approval, queued
  until the turn ends, sending checkpoints, continued / failed / cancelled /
  unknown), the outbox capsule that retry and restart reuse, agent permission
  mapping, and the copy for the approval card and ended notice.
- `apps/desktop/src/main/services/chat/crossMachineHandoffSource.ts` — the kv
  move store, the outbox files, and `inspectLane`, the one source check that
  returns every blocker with its fix.
- `apps/desktop/src/main/services/chat/handoffGitBundle.ts` — opt-in transfer
  of uncommitted and unpushed work: private-index snapshot, bundle of what
  origin lacks, LFS and submodule refusal, apply with full rollback, and the
  GitHub auth header env.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`,
  `CrossMachineHandoffBanner.tsx` — the source banner for every move state,
  the arrival banner on the destination, and the routed send after a chat
  continues elsewhere.
- `apps/desktop/src/renderer/components/chat/CrossMachineHandoffModal.tsx`
  and `CrossMachineHandoffChooseStage.tsx` — the setup UI, a thin client of
  `getCrossMachineHandoffOptions`, `previewCrossMachineHandoff` and
  `startCrossMachineHandoff`.
- `apps/desktop/src/renderer/components/terminals/CrossMachineMoveSubmenu.tsx`
  — **Hand off › Another machine ▸** in the session menu, with quick brief.
- `apps/desktop/src/renderer/components/chat/crossMachineHandoffPresentation.tsx`
  — the modal's pure presentation half: permission tone and icon lookups and
  the `CheckRow` component.
- `apps/ios/ADE/Views/Work/WorkCrossMachineHandoffViews.swift`,
  `WorkSessionHandoffSheets.swift`, and
  `apps/ios/ADE/Services/SyncService+SessionHandoff.swift` — the phone's
  handoff sheet, in-chat card, send gate, and session long-press menu.
- `apps/desktop/src/renderer/components/shared/BlockedAction.tsx` and
  `apps/desktop/src/renderer/components/shared/PermissionModePicker.tsx` —
  cross-surface primitives the modal reuses rather than reimplementing: the
  reason-carrying blocked-action button/list, and the composer's permission
  pill.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — the wiring of
  the orchestrator, capsule creation and validation, destination preflight,
  deterministic lane/chat acceptance, durable replay record, and source notice;
  it also owns the one-call session metadata regeneration action for bound chats.
- `apps/desktop/src/shared/crossMachineHandoff.ts` and
  `apps/desktop/src/shared/types/chat.ts` — portable Git identity/sanitization,
  untrusted response decoders, capsule DTO, preflight/result contracts, and the
  shared session-metadata field/result DTOs.
- `apps/desktop/src/main/services/remoteRuntime/remoteConnectionPool.ts`,
  `remoteConnectionService.ts` and `apps/desktop/src/main/services/ipc/runtimeBridge.ts`
  — destination capability checks, storage preflight, route pinning, paired
  and SSH JSON-RPC, per-request timeouts, and reconciliation of
  non-replayable actions. The pool keeps each paired target's
  `SyncRuntimeTransport` (`hello.features` and `endpoint` are needed for
  `getAttachmentUploadRoute`).
  - When ADE on the machine goes away, the status has `recovery`:
    `reconnecting` (the installed app's 30 s maintenance, or bounded redials of
    1 s then backoff for at most 10 minutes), or `waiting_for_user` (auto
    reconnect off or redials done). Disconnect, Cancel, Remove and quit end
    the redials.
  - A link taken by another ADE app on this computer is `held_elsewhere`,
    never redialed, with "Use it here". The words come from
    `connectionDiagnosis.ts` (`describeLinkHeldByOtherAdeApp`,
    `RELAY_HELD_BY_OTHER_ADE_APP`, `describeHostWentAway`).
- `apps/desktop/src/main/services/remoteRuntime/attachmentUploadRoute.ts` and
  `attachmentUploadClient.ts` — the client half of streamed attachment upload.
  `resolveRemoteAttachmentUploadRoute` needs three facts, and any missing one
  falls back to base64: `features.attachmentUploadV1`,
  `hello_ok.connectionTransport === "direct"` (a relay carries only frames),
  and a `ws:`/`wss:` endpoint (the HTTP origin is the same with the scheme
  swapped). SSH targets return null. `uploadRemoteAttachment` streams the
  file from disk with the ticket as its only credential, bounds the reply
  read, and stops after 5 minutes.
- `apps/desktop/src/preload/preload.ts` — source project-runtime routing plus
  the renderer bridge for machine-level project setup and destination actions,
  including the bound `agentChat.regenerateSessionMetadata` call.
- `apps/desktop/src/shared/types/syncHostRecovery.ts` — the host readiness and
  repair contract: `SyncHostOwnerKind`, `SyncHostReadinessState` (`ready`,
  `starting`, `conflict`, `unavailable`), `SyncHostConflictPublic`,
  `SyncHostReadinessSnapshot`, `SyncHostRecoveryStep`,
  `SyncHostRecoveryResult`, `sync.diagnoseHost`, `sync.recoverHost`, and the
  exact conflict and redacted-detail copy. Clients rebuild a snapshot from it
  when a `host_unavailable` error names a conflict without one.
  `SyncHelloOkPayload.projectHost` and `SyncCommandResultPayload.error` reuse
  it.
- `apps/desktop/src/shared/syncHostRecoveryUi.ts` — the client half (Swift
  mirrors it): parsers, the retry ladder (`PROJECT_HOST_SILENT_RETRY_MS`,
  2/4/8 s), `projectHostShouldTakeOverImmediately`,
  `projectHostBlockedReason` (`unauthorized` for the redacted sentence, else
  `unidentified`), and the transport codes a deliberate restart produces.

Canonical files (`apps/ade-cli/src/services/sync/`):

- `productAnalyticsRemoteCommand.ts` — treats browser/phone analytics input as
  untrusted, binds the peer surface and canonical host project, strips claimed
  identity fields, and applies the peer's consent bit before dispatch. Paired
  consent never changes the machine-wide preference.
- `appleRemoteCommands.ts` — the `apple.*` remote commands for the phone and
  the hosted web client. `apple.invoke` is controller-only and calls one
  `ios_simulator` method by name. It refuses any method outside the
  `ios_simulator` action allowlist (`APPLE_AGENT_ACTIONS` plus
  `APPLE_USER_ONLY_ACTIONS`). See [Apple device](../apple-device/README.md).
- `providerAccountRemoteCommands.ts` — the runtime-scoped
  `providerAccounts.*` commands over the `provider_instances` domain, so the
  phone and browser manage the host's Claude and Codex logins. `list`,
  `getSettings` and `refresh` are viewer-allowed; the rest are
  controller-only (`PROVIDER_ACCOUNT_REMOTE_COMMANDS` in `shared/types/sync.ts`).
  See [remote commands](remote-commands.md#action-categories).

- `syncService.ts` — the orchestrator: runtime, peer client, device registry,
  draft persistence, PIN store and per-project configuration. It builds the
  `projectCatalogProvider` for `project_switch_request`. `forceHostRole` is a
  legacy override; normal callers leave it false. Port candidates come from
  `buildSyncHostPortCandidates` (8787 first; a sticky `lastPort` of 8788
  next). Off 8787, it tries `tryMigrateToPort` at 2 s and every 15 s, and on
  success updates `lastPort` and the lease, refreshes discovery and
  republishes.
- `syncRouteHealth.ts` — `deriveListenerHealth` and `buildRelayRouteHealth`,
  the one description of a machine's inbound routes, used by
  `syncService.getStatus` and `buildProjectlessSyncSnapshot`. Connections and
  `ade doctor` show its strings, and the publisher gates on its booleans. The
  differences between the paths are parameters. A loopback check counts only
  while it names the bound port.
- `projectlessSyncSnapshot.ts` — see *Hosting sync, and publishing, with no
  project*. Optional `pin` and `bootstrapToken` are gated on `hosting`.
- `syncHelloProtocol.ts` — the one `hello` and `pairing_request` parser for
  both ingresses. It maps a legacy top-level `token` to
  `auth: { kind: "bootstrap" }` and validates five auth shapes (`bootstrap`,
  `paired`, `account`, `account_sealed`, and `guest`, which keeps only
  `deviceId`, a ticket and a DPoP proof, and is refused with an account
  token, relay token or secret). It bounds the relay token and parses
  `connectionAttempt` (`CONNECTION_ATTEMPT_ID_MAX_CHARS`,
  `CONNECTION_ATTEMPT_MAX_FUTURE_MS`), `dbVersionBySite` and the codec offer.
- `syncPeerCursorResolution.ts` — `resolveInitialPeerCursor`; see
  [The host never exports from an uncorroborated peer cursor](#the-host-never-exports-from-an-uncorroborated-peer-cursor).
- `syncAccountHelloAuth.ts` — the account-hello gates and rejection strings
  (`SYNC_REPAIR_REQUIRED_MESSAGE`, `SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE`,
  `SYNC_ACCOUNT_VERIFY_UNAVAILABLE_MESSAGE`, `SYNC_ACCOUNT_NOT_SIGNED_IN_MESSAGE`,
  `SYNC_ACCOUNT_DEVICE_MISMATCH_MESSAGE`, `SYNC_ACCOUNT_KEYLESS_RECORD_MESSAGE`,
  `SYNC_ACCOUNT_OTHER_OWNER_MESSAGE`, `SYNC_ACCOUNT_PAIRING_WRITE_FAILED_MESSAGE`,
  `SYNC_ACCOUNT_VERIFY_FAILED_MESSAGE`). "No usable pairing record" and
  "unknown device" give the same answer, so the handshake is not an existence
  oracle.
- `pairedDeviceRejectionLimiter.ts` — a per-`deviceId` throttle for repeated
  paired-hello rejections (a phone whose pairing the host forgot keeps racing
  every route). It samples warnings and delays later rejects, with one
  cadence for every reason. Both ingresses share it.
- `brainMachineSyncStores.ts` — the projectless PIN, pairing and security
  stores (`sync-pin.json`, `sync-paired-devices.json`, `sync-security.json`
  under `~/.ade/secrets/`), memoized by `pathKey`, plus
  `generateMachinePairingPin` and `createProjectlessSyncControls`.
- `machineRelayTunnel.ts` — `createMachineRelayTunnel`, the machine's one
  relay client and its authority gate, for `createAdeRuntime` and the
  projectless `runServe`. Two clients on one `machineKey` would evict each
  other (`4505`) forever, so the client is cached per relay config path and a
  later project scope adopts it. The host listener attaches outside the
  factory, before the gate. Its account lease asks "is this machine still
  theirs": `retainedAccountOwnerId` keeps the tunnel through an `expired` or
  `unreadable` session (`expiresAt: null`); only `signed_out` drops it. See
  [remote runtime → Account state and reachability](../remote-runtime/README.md#account-state-and-reachability).
- `syncHelloTelemetry.ts` — the dialed machine's report of each hello it
  accepted or rejected, from both the project host and the brain's fallback.
  Bounds what an unauthenticated peer can put in a log line.
- `syncTerminalStreams.ts` — phone terminal streams for both ingresses
  (barrier, offset resume, data, history, resize, acked input). Another open
  project's session goes to that project's runtime, and later envelopes must
  name the same project. The desktop PTY size comes back only when no ingress
  watches it. `syncTerminalSnapshotBarrier.ts` is the pure barrier;
  `syncTerminalTargets.ts` finds a project's runtime without booting it.
- `syncHostService.ts` — the per-project WebSocket host.
  - **Hello and pairing.** An `auth_failed` names the rejecting machine
    (`host: { deviceId, name }` from `readBrainMetadata()`), so a client drops
    a pairing only when its own machine refused it.
  - **Sealed account adoption (`ade-adopt-v1`).** `account_challenge` →
    `account_challenge_ok` → a `hello` with `auth.kind: "account_sealed"`. The
    host signs the client's nonce over an ephemeral X25519 exchange with its
    `machineIdentitySigningStore` key, unseals the account credentials, and
    returns the paired credentials in a sealed `hello_ok`.
    - The AEAD is the first mutual choice of the client's `supportedAeads`
      and `supportedAdoptChannelAeads()`, echoed and signed. A packaged
      Electron without ChaCha20-Poly1305 gets `aes-256-gcm`. No overlap is a
      rejection, never a downgrade.
    - A client that omits `supportedAeads` gets `chacha20-poly1305`, unsigned,
      and the host logs `sync_host.legacy_adoption_aead_unbound`.
      `ALLOW_LEGACY_UNBOUND_ADOPTION_AEAD` is the gate to remove that path.
    - A single-use challenge is required. Well-formed challenges charge no
      limiter; malformed ones charge a per-IP and a global cooldown.
    - `account_sealed` is the only account path allowed on a direct LAN or
      tailnet route. A plaintext `account` bearer needs the `relay-bridge`
      origin.
  - **Framing.** The client offers codecs in `hello`; the host picks `deflate`
    in a legacy-encoded `hello_ok`, and both sides switch after that frame.
    It reassembles authenticated `envelope_chunk`s and chunks outbound frames
    for peers with `chunkedEnvelopes`. A protocol-range miss gets an
    uncompressed `hello_error`, then close code `4406`.
  - **Changesets.** Bounded, windowed exports with ack tracking and
    smaller-batch recovery (see `crdt-model.md`).
    - `MOBILE_CHANGESET_EXCLUDED_TABLES` drops tables the phone never reads
      (`attempt_transcripts`, `operations`, `ai_usage_log`,
      `budget_usage_records`, `automation_runs`, `automation_action_results`,
      `pull_request_snapshots`, seven event logs, `cto_session_logs`, and
      `usage_machine_rollups`, `usage_machine_rollup_meta`,
      `lane_usage_tombstones`, which the phone reads through
      `usage.getAdeStats`). Ack watermarks still advance.
    - A replica phone more than 5,000 versions behind gets one bounded
      `catchup` batch, then incremental delivery after its `changeset_ack`.
    - `SYNC_HOST_AUTHORITATIVE_TABLES` (`sync_cluster_state`) never crosses
      the CRR boundary, so no peer can flip `brain_device_id`.
    - `HOST_AUTHORITATIVE_COLUMNS_BY_TABLE` drops the settle and activity
      columns of `terminal_sessions` from phone changesets only (see
      [Host-authoritative columns](#host-authoritative-columns-are-peer-scoped)).
    - Inbound ceilings `MAX_INBOUND_CHANGESET_ROWS` and `_BYTES` (about 10k
      rows, 10 MB): a bigger batch gets `changeset_too_large` before
      `applyChanges`.
  - **Per-peer scheduling.**
    - Up to `MAX_CONCURRENT_PEER_READS = 4` reads overlap. Every other
      envelope is a barrier, so a read sees every earlier write of that peer.
      `isConcurrentReadEnvelope` counts only file reads and `get*`, `list*`,
      `read*`, `search*` commands as reads (`git.fetch` is a write). A read
      waits for the barrier before it takes a slot; freed slots go FIFO. The
      handler timeout starts when the handler starts.
    - Each peer has its own chat and changeset chain. Foreground work defers
      background changesets for at most 2 s.
  - **Chat wire.** `compactChatEventEnvelopeForSync` applies
    `compactChatEventForWire` (`shared/chatEventCompaction.ts`, the stored
    transcript's policy) to live sends, snapshots and replay, and drops
    `tool_result.structured` and `toolResultMeta` (see
    [chat → Persisted transcript](../chat/transcript-and-turns.md#persisted-transcript)).
    `foldChatEventEnvelopesForReplay` (`shared/chatReplayFold.ts`) folds clean
    streaming deltas in a `chat_subscribe` snapshot for `foldedReplay` peers;
    overlapping deltas and the replay-buffer resume path are not folded. See
    also the slim wire ([iOS Companion](ios-companion.md#slim-mobile-chat-wire)).
  - **Streams.** The per-session chat seq and replay buffer; offset-stamped
    terminal streams with a snapshot barrier and `sinceOffset` deltas;
    `terminal_history` and `chat_history` paging (`chat_history` checks the
    existing subscription); acked, deduped terminal input; phone input and
    resize into PTYs, and the desktop size back after the last phone leaves.
  - **Projects.** Lane presence, catalog and switch envelopes, runtime-scoped
    project actions (browse, open, create, clone, GitHub repos, default
    parent, forget), and catalog-id to hosted-id aliasing.
  - **Other.** The per-IP pairing limiter; `features.mobileCompatibility`;
    Tailscale Serve and mDNS. The runtime kind is `desktop-embedded`,
    `headless`, `remote-stdio`, `desktop`, `daemon` or `remote`. A successful
    project command records a usage event with `mobile`, `web` or `desktop`
    attribution.
  - **Roster.** It pushes the all-projects roster per subscribed peer
    (`rosterSubscribed`, `rosterSeq`, `rosterBaseline`), debounced with a
    ceiling and flushed after a command that adds or removes a lane or chat.
    Without a `SyncRosterProvider` it never answers `roster_subscribe`.
  - **Foreign and personal chats.** A `foreignChatProvider` streams another
    project's transcript read-only from disk (`crossProjectChat`). A
    `personalChatScope` adds `personalChats` and serves only subscriptions
    that carry `chatScope: "personal"`.
- `rosterBuilder.ts` — the machine-wide all-projects roster
  (`SyncRosterProject[]`): chats, their shells, and standalone CLI sessions,
  live and ended. Identity-bound chats (the CTO) and their children are left
  out.
  - Projects: `catalogVisibility: "recent"` plus the host's own project
    (`hostProjectId`).
  - It opens each `<root>/.ade/ade.db` **read-only** with `node:sqlite` and
    merges `chat-sessions/*.json`, so no project boots. Booted scopes add live
    status and PTY liveness (`ptyService.hasLivePty`). A CLI that reports
    turns (`ptyService.getTrackedCliTurn`) reads `idle` or `awaiting`; a
    Claude CLI with background agents reads `running` until the last stops
    (`backgroundAgentCount`).
  - `attentionCount` counts chats, chat shells and live agent CLIs that wait
    on the person; a CLI that exited non-zero never counts. `runningCount`
    leaves out snoozed chats.
  - Rows may carry `snoozedUntil`, `snoozedAt`, `activityStatus` and
    `activityStatusChangedAt`. Previews are about 120 characters.
  - `createForeignChatTranscriptResolver({ projectRegistry })` maps a
    registered foreign project and session id to its transcript, refuses
    unsafe ids and paths outside the project's transcripts folder, and never
    boots a runtime. `ade serve` wires it as `foreignChatProvider`.
- `sharedSyncListener.ts` — the brain-level WebSocket listener shared by the
  project hosts.
  - **Port.** 8787 first (`buildSyncHostPortCandidates`), with up to about 8
    retries over 3.2 s before the rest of the scan; a confirmed live holder
    skips the retries with one warning. `tryMigrateToPort(8787)` binds 8787
    beside a fallback listener and closes the old one (single-shot probes).
  - **Upgrades.** Only on `/`. A present Origin must be
    `https://app.ade-app.dev` or a local Vite origin. No Origin is fine for
    iOS, CLI peers and the relay bridge (whose proof header is checked
    apart).
  - **Zombie reaping.** On `EADDRINUSE` in 8787–8999 (`SYNC_HOST_MAX_PORT`),
    a stale ADE brain holding the port is confirmed twice by pid and start
    time, stopped (`sync_listener.zombie_reaped`), and the port retried once.
    Only this process is excluded (launchd's main pid is often the wedged
    one). Another channel's brain is left alone.
  - Port diagnosis is `syncListenerPortInspect.ts`, also used by the
    `ade doctor` Sync-port row. Doctor says it cannot see a root-owned
    holder, such as a stranded `tailscale serve` (`tailscale serve status`,
    `netstat -an -p tcp`); the next tailnet publish reclaims it.
  - **Handoff.** On a project switch the new host adopts the sockets (peer
    metadata, re-checked pairing auth, cursors from the per-site map,
    subscriptions and offsets, frames buffered meanwhile). Unowned sockets
    park and close with 4002 after 30 s. The machine fallback handler does
    not take sockets during that grace.
  - **Attachment route.** Plain HTTP requests go to
    `getAttachmentUploadRegistry().handleRequest` first, else the loopback
    426 probe. There is **one registry per listener**, shared by all binds
    and hosts, so a ticket works after a port migration.
- `attachmentUploadService.ts` — that registry. A peer that finished `hello`
  mints a ticket over the command channel and sends it as the bearer of
  `POST /ade-attachments/upload`. A ticket names one project root and one
  extension, lives two minutes, and is consumed before the first body byte.
  Expired tickets are pruned on use (no timer). The body streams to a `.part`
  file, renamed only when complete; the byte counter is the real limit. The
  name comes from `stagedAttachmentDestPath`.
- `apps/ade-cli/src/services/fileAttachment.ts` — chunked base64 staging and
  `readAttachmentChunk` for previews; see
  [Chunked staging for file-shaped attachments](#chunked-staging-for-file-shaped-attachments).
- `syncListenerPortInspect.ts` — `inspectSyncListenerPort`, the port-holder
  probe for zombie reaping and `ade doctor`.
- `brainProjectActionsSyncHandler.ts` — the machine-wide fallback handler
  before a project host is active.
  - It takes a `secretsDir` and resolves stores through
    `resolveBrainMachineSyncStores`, parses with `syncHelloProtocol` and
    gates account helloes with `syncAccountHelloAuth`, so the web can reach a
    brain with no project. An `account_sealed` hello gets "pair with a code,
    or open a project" as `account_session_changed` (the pairing is kept).
  - It runs PIN, paired-secret and bootstrap auth with the same cooldown,
    and attributes `auth_failed` with `host: { deviceId, name }`.
  - Routed commands use the host's peer-queue rule
    (`MAX_CONCURRENT_PEER_READS`, `commandWriteBarrier`).
  - It serves the project catalog and project actions, the
    `PersonalChatScope` (personal snapshots and `chat_history` paging),
    and the same codec and protocol-mismatch behavior.
  - A `command` with no project host gets a `command_result` with
    `error.code: "host_unavailable"` and a typed snapshot (`reason`,
    `conflict`, `recoveryEligible`). Clients retry a starting failure, then
    offer **Fix connection** for a verified conflict. iOS treats the code as
    transient, so queued work survives.
  - It answers `sync.diagnoseHost` (redacted for unauthorized peers) and
    `sync.recoverHost` (only for a pairing with the runtime-host grant or
    `syncHostRecoveryGranted`; advertised only to those peers).
    `hello_ok.projectHost` carries the snapshot on every connection.
- `syncHostSingleton.ts` — the lease (see *The machine-wide sync host lease*):
  the lock file, conflict diagnosis against live listeners
  (`SyncHostSingletonConflictError`), `updatePort` and `dispose`, and the
  process-wide authority registry. `processStartedAt` comes from the OS
  process clock on every platform (PowerShell `StartTime` on Windows), as
  `defaultProcessMatchesOwner` reads it; anything else makes a live lease
  look like PID reuse. `isSameChannelSyncHostOwner` compares homes
  case-insensitively on Windows and macOS, case-sensitively on Linux.
- `syncHostRecovery.ts` — host readiness and the one-tap repair behind
  `sync.diagnoseHost` and `sync.recoverHost`.
  - `diagnoseSyncHostReadiness` gives a snapshot with card-ready `headline`
    and `body`; PIDs, sockets and command lines stay in `technicalDetail`.
  - `classifySyncHostOwnerKind` names `development`, `installed` or `unknown`
    for macOS bundles, Windows per-user and machine-wide installs, `/opt`
    Linux packages and AppImages.
  - A conflict is `recoveryEligible` only with a parseable process start time
    and an owner that is a development runtime or this channel's installed
    one. `redactSyncHostReadinessSnapshot` is what an unauthorized peer gets.
  - `recoverSyncHostConnection` is **serialized** (a second caller joins) and
    bounded by a 90 s deadline. It runs diagnose → stop → wait → start →
    restart → prove, re-resolves the owner before the kill, never targets this
    brain, and reports `restarting` when it restarts the brain. It tracks the
    last 32 capped operation ids.
  - `skipListenerScan` keeps the hello path and `host_unavailable` replies on
    the lock alone, because the scan runs `lsof` or PowerShell synchronously.
    Only `sync.diagnoseHost` scans.
  - `ade brain status` uses it (`--scan-listeners` opts into the scan); the
    CLI injects the running brain's listener health and excludes its pid.
    `cli.ts` wires `startSyncHost`, `restartBrain` and `prove` into
    `configureSyncHostRecovery`.
- `syncHostStartupLoop.ts` — the retry loop around sync host startup.
  - Same-channel conflicts always retry; the loop may evict a stale
    same-channel squatter only when this brain is the installed service
    child. Another channel's live brain is rethrown on the first attempt only
    (with quit instructions); later it retries slowly and recovers when that
    owner exits.
  - A takeover is followed by one immediate attempt after
    `clearHeldFailures` → `clearSyncHostPhaseBackoff`. If it meets the same
    owner again, the loop waits its normal delay, so stray brains cannot
    drive a tight retry loop.
  - Sync reads (`sync.listDevices`, `getPin`, `getRuntimeName`,
    `getCloudRelayStatus`, `getRequireDpop`) go through `readSyncService`
    (`multiProjectRpcServer.ts`) and answer from a ready scope without
    re-entering activation. `sync.getStatus` answers from the named
    project's ready scope, the host's, any booted scope, else the machine;
    it never starts a host. Lane presence (`sync.setActiveLanePresence`) is
    held and resent on each scope-ready or host-switch notice; an older list
    never comes back.
  - Each failure goes through `classifyStorageFault`
    (`storage/storageErrnoClassifier.ts`). A storage fault takes the slow
    30 s cadence and quotes the classified sentence. Logs:
    `sync.host_start_failed` and `sync.host_start_recovered`, deduped with
    the human line. `recordStorageFault` keeps a last-failure record
    (`component: "sync_host"`). After 3 storage faults in a row,
    `onSustainedStorageFault` sends one automatic report per loop (see
    [auto-send](../storage-and-recovery/README.md#auto-send)).
- `changesetPump.ts` — batch-chunk selection for changeset fan-out.
  Splits an export into `changeset_batch` envelopes at ~256 KB / 250
  rows while never splitting rows that share a `db_version` (the ack
  watermark is version-granular).
- `mobileReplicaReseed.ts` — the compact state for an iOS replica more than
  5,000 versions behind: at most 1,000 rows scanned per poll, 10,000 rows and
  4 MiB in all, else normal replay. Exports run off the event loop
  (`exportChangesSinceOffThread`). A phone at cursor 0 gets its first batch
  before the compact one.
- `syncPeerService.ts` — the WebSocket **client**, for a runtime that joins
  another as a peer. iOS has `apps/ios/ADE/Services/SyncService.swift`.
- `syncProtocol.ts` — the Node envelope codec and protocol range
  (`SYNC_PROTOCOL_MIN_SUPPORTED...SYNC_PROTOCOL_VERSION`), the mismatch error,
  close code `4406`, `DEFAULT_SYNC_HOST_PORT` (8787), `SYNC_HOST_MAX_PORT`
  (8999) and `buildSyncHostPortCandidates`.
- `syncBinaryFrame.ts` — the binary container ("ADE1", u32 header length,
  header JSON, raw body) and the magic sniff. Legacy gzip at 4 KiB
  (`DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES`) for peers without negotiation;
  `deflate` at 512 B (`SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES`). Decode
  cap `MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES` (25 MiB). Above
  `DEFAULT_SYNC_MAX_FRAME_BYTES` (720 KiB) envelopes may be chunked;
  reassembly allows eight sets, 512 parts, a 128-byte `chunkId` and 32 MiB,
  and expires after 30 s.
- `abortSignal.ts` — `runWithAbortSignal` and `abortSignalError`, the shared
  `AbortError` wiring for command paths.
- `syncRemoteCommandService.ts` — the command registry (lanes, chat, git, PRs,
  sessions, conflicts, files, usage, `prs.getMobileSnapshot`,
  `lanes.presence.*`, `work.*`, `chat.recoverCodexTurn`,
  `chat.regenerateSessionMetadata`, `modelPicker.*`, …). Each registration
  has a `SyncRemoteCommandDescriptor` with **scope** `"runtime"` or
  `"project"`; a project command needs an open project and a matching
  `projectId` (see *Scope enforcement*).
  - **Attachments.** `chat.createAttachmentUpload` mints a ticket from the
    host's one `AttachmentUploadRegistry` for phones and browsers (a paired
    desktop reaches it over runtime RPC through
    `syncHostService.issueAttachmentUploadTicket`). There is no remote
    `chat.copyTempAttachment`, because it takes any absolute path.
  - **Handoff.** `chat.prepareCrossMachineHandoff`,
    `chat.validateCrossMachineSource`, `chat.preflightCrossMachineDestination`,
    `chat.fastForwardCrossMachineHandoffLane` (a re-validated `--ff-only`
    catch-up), `chat.acceptCrossMachineHandoff` and
    `chat.markCrossMachineHandoff`. Acceptance is not queueable and is keyed
    by the capsule's id and fingerprint. The desktop reaches the destination
    over multi-project RPC (`rpc_data`, or `ade rpc --stdio` over SSH), so the
    command responder timeout does not bound it.
  - Stalled-turn recovery is viewer-allowed, not queueable. Remote Codex CLI
    launches add the opted-in Computer Use MCP client. Controller CLI
    launches resolve the lane worktree first, so `ADE_AGENT_SKILLS_DIRS` is
    lane-aware.
  - External-session import returns the new ids and the persisted summary,
    which controllers install before they navigate; see
    [External Session Import](../terminals-and-sessions/external-session-import.md).
  - **Usage.** `usage.getAdeStats` (viewer-allowed; `scope` `account`,
    `machine` or `project`; `force` only for a user Refresh).
    `usage.getUsageRollup` returns this machine's day × provider × model
    aggregates only; `null` means not ready, and the caller records a
    retryable failure. Between brains, `usage.getUsageRollup` and
    `usage.getLiveQuota` are machine-level RPC to machines already connected
    (no dial, no pairing). `usage.getQuotaSnapshot` reads cached limits;
    `usage.refreshQuota` runs the quota-only path with no interactive auth.
  - Model-picker commands use the machine's CRR-backed store. Recents live
    there. Favorites live on the ADE account (`/account/model-favorites`);
    iOS reads the machine's favorites only when it is signed out or the
    account server predates that route.
  - `personalChats.*` (from `PERSONAL_CHAT_ACTIONS`, `scope: "runtime"`) call
    `PersonalChatScope`. Only `personalChats.send` is queueable.
    `isPersonalChatActionViewerAllowed` denies `createScheduledWork` and
    `resumeUsageLimitNow` (it spends the owner's quota).
  - `lanes.create` uses account and repository defaults
    (`lanes.getNewLaneDefaults`, `lanes.setNewLaneDefaults`).
  - New-lane launches (`chat.startLaunch` … `chat.completeLaunchClient`) are
    brain-owned and push `chat_launch_event`; see
    [Remote commands › New-lane launch commands](remote-commands.md#new-lane-launch-commands).
- `deviceRegistryService.ts` — the synced `devices` table and the
  `sync_cluster_state` singleton. Peer `appVersion`, `appBuild` and
  `bundleIdentifier` from the hello go into `metadata_json`. When the runtime
  joins another as a viewer (`syncService.connect`), it clears both tables,
  suppresses the DELETEs with
  `db.sync.discardUnpublishedChangesForTables(["devices",
  "sync_cluster_state"])`, and calls
  `syncPeerService.acknowledgeLocalDbVersion()`, so it cannot erase the
  authority's registry (see `crdt-model.md`). Identity reads return cached
  values while `scutil` `ComputerName` and the Tailscale name refresh in the
  background (single-flight, kept 30 s, `windowsHide`).
  `localSyncDeviceDefaults()` names the machine without a project DB.
- `syncPairingStore.ts` — validates `pairing_request` against `syncPinStore`,
  mints the per-device secret and stores it in `paired_devices`.
  - Each `SyncPairingRecord` has `accountOwnerUserId` (null for a QR, PIN or
    SSH pairing) and the sticky `localTrustOrigin`.
    `pairPeerViaAccount` mints or rotates from a verified same-account
    attestation. `isValidDpopPublicKey` is shared with `syncHostService`.
  - `revokeAccountOwnedExcept` (sign-out or account switch) deletes other
    accounts' records and demotes `localTrustOrigin` records to local trust.
    See *Adopting a manual pairing into an account*.
  - `syncHostRecoveryGranted` (behind **Fix connection**) is minted only for a
    same-account attested phone or browser. Like `runtimeHostGranted`, a
    rotation may drop it but never regains it.
- `syncPinStore.ts` — the 6-digit PIN at `~/.ade/secrets/sync-pin.json`
  (`0600`). The runtime never rotates it; the This computer card sets it.
- `resolveTailscaleCliPath.ts` — Tailscale CLI discovery used for the
  tailnet `tailscale serve` publication path.
- `syncDpop.ts` — DPoP: the signing string, `evaluatePairedHelloDpop`
  (checks a proof against the stored P-256 key; TOFU for legacy devices), and
  `createSyncDpopNonceCache` (256 nonces per device, 4,096 in all; a device
  evicts only its own; a full cache fails closed with
  `nonce_cache_saturated`). `syncDpopKeyThumbprint` (RFC 7638) binds a lane
  share ticket.
- `laneShareGuestHost.ts`, `laneShareGuestGates.ts`, `laneShareGuestPolicy.ts`,
  `laneShareGuestCommandPrep.ts`, `laneShareGuestScrub.ts`,
  `laneShareGuestQueue.ts`, `laneShareGuestTypes.ts`,
  `laneShareGrantService.ts`, `laneShareHostService.ts`,
  `laneShareMoveService.ts`, `laneShareError.ts` — lane sharing on the host:
  the guest connection and its default-refuse gates, the grant list read from
  the account directory (only while a guest is connected), the owner's
  `lane_share` actions, and moving a chat to the other person. The sync host
  hands a `guest` hello to `laneShareGuestHost`. See
  [lane sharing](../lanes/lane-sharing.md).
- `syncSecurityStore.ts` — `~/.ade/secrets/sync-security.json` (`0600`) with
  `requireDpop` (`ADE_SYNC_REQUIRE_DPOP=1|0` overrides).
- `machineIdentitySigningStore.ts` — the machine's Ed25519 key pair at
  `~/.ade/secrets/machine-identity-signing.json` (`0600`, lazy, regenerated if
  corrupt). The public key is the directory `pubkey`; the private key signs
  the `ade-adopt-v1` challenge.
- `apps/desktop/src/shared/sync/adoptChannelCrypto.ts` — the `ade-adopt-v1`
  primitives: X25519 keys, the challenge signature input, HKDF-SHA256, AEAD
  `seal`/`unseal` with bound AAD, Ed25519 sign and verify, SPKI↔raw.
  `ADOPT_CHANNEL_AEADS` is `chacha20-poly1305`, then `aes-256-gcm`;
  `supportedAdoptChannelAeads()` probes the backend (cached). The chosen AEAD
  is in the signature input (`aead`), so it cannot be downgraded.
- `syncCloudRelayStatus.ts` — `buildSyncCloudRelayStatus`, the one relay
  status for the scoped and machine paths. Without `accountSignedIn` the live
  fields are off and `lastError` is the sign-in prompt.
- `syncCloudRelayStore.ts` — the relay identity at
  `~/.ade/secrets/sync-cloud-relay.json` (32-hex `machineKey` and HMAC
  `secret`, `0600`).
  - **An identity is never discarded while any copy on disk holds it.** The
    file is written with `writeFileAtomic` (temp, fsync, rename, directory
    fsync except on Windows, no pre-unlink) and then mirrored to `.bak`. A
    parse failure is a failure, not "no identity". Resolution keeps a key
    from either copy; only a pair that yields nothing may mint, logged as
    `corrupt_file_remint`.
  - Every mint, rotation or recovery logs one
    `sync_cloud_relay.identity_rotated` line.
  - Only a claim answer of exactly `409` can rotate: an exclusive lock, a
    compare-and-swap of the expected key, at most twice per 24 h
    (`MAX_IDENTITY_ROTATIONS_PER_WINDOW`). The budget is **in the file**; an
    unreadable budget reads as spent. Network, auth, upgrade and bridge
    failures never rotate.
  - The file also holds `pairingAutoRepairs` (three per six hours) and up to
    five `previousMachineKeys` for `confirmSupersededMachineKeys`.
  - Legacy `enabled` fields are removed on read; there is no kill switch.
  - It derives `wss://<relay>/connect/<machineKey>` and the host and pipe
    HMAC strings shared with `apps/tunnel-relay`. The worker places the
    Durable Object near the machine on creation only.
- `relayTunnelAuthorityGate.ts` — `createRelayTunnelAuthorityGate` starts the
  tunnel only while this process hosts the shared listener **and** holds the
  lease, and stops it after the 5 s grace. Each start re-attaches the host
  listener (else a restart would have a control socket and no bridge).
  Winning the lease again calls `clearControlSuppression()`, only after an
  observed release. `dispose()` unsubscribes without stopping the shared
  client. `bootstrap.ts` builds one gate per scope.
- `syncTunnelClientService.ts` — the brain's relay client. With a current
  account lease it keeps an outbound control socket (HMAC-signed upgrades) so
  controllers off the LAN can dial in.
  - **Backoff.** Decorrelated jitter with a 1 s floor and a 60 s cap
    (`computeBackoffMs`). Connect is single-flight; a token refresh error
    keeps the route until the last known lease expiry. Sign-out, a missing
    lease, a switch or expiry closes everything.
  - **In-process pipe.** TLS ends at the relay, which can read the traffic.
    Each pipe becomes the peer socket in process (`openInProcessTunnel` →
    `SharedSyncListener.acceptRelayPipe`) with `relay-bridge` provenance, the
    host's `maxPayload` and backpressure. The relay never dials
    `127.0.0.1:<port>`, so another program on that port cannot intercept it.
    The loopback bridge with a proof header is only for a listener without
    `acceptRelayPipe`.
  - **Bridge validation.** `attachHostListener()` (called by the gate on each
    start, not at construction, because the shared client is often built by
    a scope with no listener) supplies the port, nonce and proof, hooks
    `onLoopbackValidated` (`sync_tunnel.bridge_validation_failed`) and
    validates at once. `validateCurrentBridge()` runs on control open and on
    each loopback validation, serialized; `openTunnel` checks again. This
    sets `relayBridgeValidated` without waiting for a client.
  - **Liveness.** WebSocket pings every 30 s with a 10 s deadline, plus a JSON
    `{t:"ping"}` every 180 s (`CONTROL_JSON_PING_INTERVAL_MS`) with a 30 s pong
    deadline (`CONTROL_JSON_PONG_DEADLINE_MS`), because a dead Durable Object
    can leave the edge answering pings. A JSON miss records "relay control
    unreachable at relay (zombie socket)" and logs
    `sync_tunnel.zombie_control_detected`.
  - **End to end.** `runSelfProbe()` dials like a ready-v2 controller
    (`probeRelayEndToEnd`), debounced about 2 s after ready or a bridge
    re-validation. Its verdict (`relayEndToEndVerifiedAt`,
    `relayEndToEndFailure`, `relayEndToEndRoundTripMs`) gates the published
    `relay` endpoint. A failure ends the control as a zombie; `4503`
    `CLOSE_TOO_MANY` proves liveness and gives no verdict.
  - **Failed opens** send `{t:"reject"}`. A real setup error blocks
    publication until a fresh tunnel is ready (cancelled candidates do not).
    App close codes pass through; others become `4000`.
  - **`4505` (`RELAY_CLOSE_CONTROL_REPLACED`).** Another process has the same
    `machineKey`. Retry at a 60 s floor (`CONTROL_REPLACED_RETRY_BASE_MS`) at
    most 3 times (`MAX_CONTROL_REPLACED_REATTEMPTS`), then `controlSuppressed`
    with "Another ADE process owns the relay connection for this machine."
    The dial itself checks suppression. It re-arms after 10 minutes
    (`CONTROL_REPLACED_REARM_MS`), on `clearControlSuppression()`, and after a
    stable control. Events: `sync_tunnel.control_replaced`,
    `.control_replaced_stopped`, `.control_suppression_cleared`, and one
    `ade_relay_suppressed` analytics event per episode.
  - **`409` claim conflict.** The store rotates; with the budget spent the
    client latches `identityRotationCapped` and reports
    `RELAY_IDENTITY_ROTATION_CAPPED_MESSAGE` ("This computer needs to be
    reconnected to your ADE account."), ranked above the raw text in
    `syncRouteHealth.ts`. The next good claim clears it.
  - **Observability.** Upgrade rejections keep the status and at most 512
    bytes; closes keep code, reason and whether it opened. Events:
    `sync_tunnel.claimed`, `.claim_failed`, `.control_open`, `.control_error`,
    `.control_close`, `.self_probe_ok`, `.self_probe_failed`,
    `.self_probe_at_capacity`, `.zombie_control_detected`.
    `routeHealth.relay` has `skipReason`, `lastControlError`, the verdict,
    `lastControlOpenAt`, `lastBridgeValidationAt`, `relayControlSuppressed`,
    `relayControlSuppressedReason` and `relayControlFailingSinceMs` (the start
    of the current outage). Suppression outranks every other reason in
    `ade doctor` and the banner.
- `syncRelaySelfProbe.ts` — `probeRelayEndToEnd`, the stateless relay
  round-trip check used by the tunnel client's `runSelfProbe`. It opens
  `wss://<relay>/connect/<machineKey>?ready=2`, requires an `accepted` v2 first
  frame then a `ready` v2 second frame within a 15 s timeout, and reports
  `{ ok, roundTripMs }` on success. A close before `ready` is a failure, but a
  `4503` `CLOSE_TOO_MANY` close (the relay's at-capacity signal, sent only for a
  registered control) is flagged `atCapacity` so the caller treats it as
  liveness proof rather than a zombie/failure. Timeout and cancellation cleanup
  keeps the probe's error handler installed while terminating a still-connecting
  WebSocket because `ws` emits that termination error asynchronously. The
  failure is therefore contained in the probe result and cannot escape as an
  uncaught exception that terminates the machine runtime.
- `headlessProjectLaneCount.ts` — `headlessProjectLaneCount(rootPath)`, the one
  lane count both the project-open path and the machine's project catalog use.
  `laneService.list` counts rows without checking the worktree still exists, so
  a project with one deleted lane reported N on open and N−1 in the catalog —
  a visible flicker on the phone and in the browser's recents. The catalog path
  fills counts in only for projects whose root is actually present on this
  machine, skipping disk work for roots that are not.
- `relayAuthorization.ts` — lease renewal for already-authenticated Relay
  peers. A capable controller refreshes before expiry with a DPoP signature
  bound to the exact token bytes, device id, host challenge, timestamp, and
  nonce. The host checks account owner/generation on both sides of remote
  verification and accepts only a later token expiry with at least 30 seconds
  remaining. Expired tokens and verifier outages are retryable; account/key/
  proof mismatches close the peer. Successful nonce receipts are bounded and
  included in socket-handoff state so retrying a response lost during project
  handoff is idempotent. Legacy peers that do not advertise renewal close at
  token expiry; capable peers have only the advertised short grace window.

Account Activity and push:

- `apps/ade-cli/src/services/push/pushPublisherService.ts` — owns the publish
  lifecycle for one bounded machine contribution across every project hosted by
  the brain: run/PR/session-removal tracking, the protocol-2 publish, the
  signed-out/degraded machine-snapshot fallback, and the durable machine-revoked
  gate (`getMachineRevocation` / `clearMachineRevocation`) that a removed machine
  latches so it stops delivering across restarts. The 30 s heartbeat rebuilds
  the roster and skips the write via `activityRosterFingerprint` when nothing
  moved; after four unchanged rebuilds the rebuild backs off to at most every
  two minutes while presence posts stay on cadence. `refreshChatRunMeta`
  re-reads a live chat run's session summary on one bounded 10 s cadence
  (`CHAT_META_REFRESH_MS`, stamped as `chatMetaCheckedAt`) for its **title** as
  well as its planning mode — neither is announced on the chat event stream, and
  a first resolution that latched left every renamed chat wearing its birth
  title. First read and refresh share one `applyChatSummary`. An
  `approval_request` is classified with the shared `isQuestionKind`: a question
  publishes as `waiting_for_input` with no Approve/Deny notification category,
  everything else (including an event with no `requestKind`) stays
  `waiting_for_approval`.
- `apps/ade-cli/src/services/push/attentionItemBuilder.ts` — the Activity
  projection itself, lifted out of the publisher's closure so it can be
  exercised with a plain context record instead of a booted publisher.
  `(runs, recentRuns, prActivities, roster) → AttentionItem[]`: identity-chat and
  child-shell filtering, phase derivation (including holding a completed turn at
  `running` while background subagents live, and demoting a snoozed running chat
  to `stale`/`idle` unless it is failed or needs-you), the title/preview tables, the
  2 h / 24 h / 7-day lifetimes, and `attentionProjectRef`. The `needs_you`
  privacy preview reads "An ADE agent needs you." — the same two words the status
  label and the title suffix use.
- `apps/ade-cli/src/services/push/pushRegistrationStore.ts` — durable device,
  delivery, machine-revocation, and machine-acknowledgment state. Machine
  acknowledgments are keyed by account owner + item and remain pending until a
  later successful account publish can reconcile them.
- `apps/ade-cli/src/services/push/pushRelayClient.ts` — authenticated relay
  client with one safe forced token refresh after a 401 and account-owner
  fences across asynchronous requests.
- `apps/desktop/src/main/services/attention/attentionAccountCoordinator.ts` —
  desktop account-first read/ack/presence/preferences coordinator. It bypasses
  the selected project or remote-machine binding and uses the local machine
  runtime only as an explicitly labeled fallback. It chunks bulk acknowledgments
  at 64 through the shared `runAcknowledgmentChunks` and returns the three-way
  `acknowledged` / `stale` / `unreached` outcome.
- `apps/desktop/src/main/services/attention/remoteProjectIdentity.ts` —
  reconciles the two project-id spaces an Activity click-through crosses. Root
  paths are compared with rules taken from the path's own shape rather than
  `process.platform`, because the path belongs to a machine that may not run this
  OS; a case-folded match is accepted only when unambiguous.
- `apps/desktop/src/main/services/attention/attentionOpenErrors.ts` — turns a
  failed pair / connect / open into one sentence the user can act on, keeping the
  raw error as `cause`. The signed-out and unreachable patterns are deliberately
  narrow: a bare `session` or `401` match sent users to fix an account that was
  fine.
- `apps/desktop/src/main/services/deeplinks/localProjectResolution.ts` and
  `projectNavigationWindowSelection.ts` — resolving a link's project against this
  machine (exact id → carried root path → recomputed canonical id) and choosing
  which window may host it. A remote project never rebinds the focused window.
- `apps/ade-cli/src/services/push/activityFingerprint.ts` — the two identities
  every item carries. The *content* fingerprint is what the row looks like with
  elapsed durations and token/file counters normalized away, so progress churn
  does not rewrite account state; the *alert* fingerprint is the stable identity
  of one phase entry, so a re-published item cannot re-alert a phone that
  already heard about it. `chatActivityMode` is in the content fingerprint (it is
  a visible distinction) and deliberately out of the alert fingerprint, because
  planning and working flip several times a turn and neither flip is a new phase
  worth notifying about. `activityRosterFingerprint` hashes the selected and
  overflow ids plus those per-item publish fingerprints so a heartbeat can skip
  the D1 write when the roster did not move; item `revision` is excluded because
  it is a republish timestamp.
- `apps/desktop/src/shared/types/attention.ts` — cross-client item, snapshot,
  destination, availability, and preference contract.
  `ATTENTION_CONTRACT_VERSION` is the *item* contract; the publish protocol
  version is separate (see `push-notifications.md`). It also owns the
  acknowledgment mechanics every shell shares:
  `ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT` (64, derived from the relay's own
  bound), `chunkAttentionAcknowledgmentItemIds`, `runAcknowledgmentChunks` (with
  the abort-on-first-failing-chunk policy), and
  `AttentionAcknowledgmentOutcome`.
- `apps/desktop/src/shared/attention/activityBoardColumn.ts` and
  `activityBoardColumn.cases.json` — the four states every Activity surface
  counts by (needs you, working, waiting, done; the Work board's columns), and
  the fixture that pins the TypeScript, Swift and relay copies of the rule. The
  brain writes the column on each agent item as `boardColumn`; see
  [push-notifications.md › The four states](push-notifications.md#the-four-states).
- `apps/desktop/src/shared/attention/activityStateGroup.cases.json` — the
  conformance fixture for the six-group table. Only the relay uses it, to
  fill the Live Activity's legacy `groups` field for old iOS builds, so the
  relay and the iOS mirror run these cases.
- `apps/desktop/src/shared/activityCatalog.ts` — one table naming every
  Activity event: its group (agents / pull requests), its icon key, and its
  default delivery policy. Desktop settings, the Activity columns, and the
  delivery defaults read this instead of each keeping a private switch.
- `apps/desktop/src/renderer/state/activityStore.ts` — the renderer's account
  snapshot. Mutations are fenced on the loaded account owner and, per item, on
  the alert fingerprint the user actually had on screen; the old
  source-revision fence is gone, because revision advances on every publish and
  a live agent outran any poll. Rollback follows the three-way outcome:
  `stale` and `unreached` each roll back only their own rows, with different
  copy.
- `apps/desktop/src/renderer/components/activity/useActivitySync.ts` — the
  single account poller, mounted in `AppShell` so the header control stays
  truthful while `/activity` is closed. It also loads the account's Activity
  preferences, and clears the localStorage keys the removed notch left behind.
- `apps/desktop/src/renderer/components/activity/ActivityPanel.tsx` — the one
  Activity panel, in two sizes: a Sessions / Inbox switch with counts, the All /
  Needs you / Working / Waiting / Done chips, the rows grouped by column with
  Done folded into one "N done" line, and the Inbox list
  (`ActivityInboxList.tsx`, PR/CI and review outcomes grouped by project).
- `apps/desktop/src/renderer/components/activity/HeaderActivityControl.tsx` —
  the global-header count (the Needs you column, failures included) and the
  compact panel in its popover, mounted only while open.
- `apps/desktop/src/renderer/components/activity/ActivityPane.tsx` — the
  expanded panel behind "Open all": `ActivityFilters.tsx` (machine / project /
  chat type / model), multi-select with bulk Mark seen / Dismiss / Open, and
  `ActivityDetailSheet.tsx`.
- `apps/desktop/src/renderer/components/activity/ActivitySectionHeader.tsx`,
  `activitySectionCollapse.ts`, `ActivityColumnMark.tsx`,
  `ActivityAllClear.tsx`, and `useAllClearBeat.ts` — the shared section header
  (a toggle only where a section folds: Done, and the Inbox project groups),
  per-surface collapsed-section memory for those Inbox groups, the column glyphs
  (with the red warning mark for a failed agent), and the all-clear beat that
  fires on the transition to zero raised hands and never on arrival.
- `apps/desktop/src/renderer/components/activity/ActivityCard.tsx` and
  `ActivityCardSkeleton.tsx` — the row and its fixed-height placeholder. The
  card deliberately does **not** reuse `terminals/SessionCard`: an Activity row
  frequently belongs to another machine, and `SessionCard`'s settle/snooze
  controls call this Mac's local session service, where a non-unique session id
  could land the mutation on a same-id local session. The status vocabulary is
  shared instead through the pure `terminals/SessionStatusLabel.tsx`, extracted
  from `SessionStatusSlot` for exactly this reason. Read the comment at the top
  of `ActivityCard.tsx` before "simplifying" it.
- `apps/desktop/src/renderer/components/activity/activityPresentation.ts` — how
  a column looks (`ACTIVITY_COLUMN_PRESENTATION`), the red mark
  (`activityItemFailed`), a waiting row's reason (`activityWaitingReasonLabel`),
  a row's column-based state (`activityRowStatus`), plus the per-item phase
  presentation and the detail sheet's `activityStateSentence` /
  `activityStateElapsed`.
- `apps/desktop/src/renderer/components/activity/activityPriority.ts` — the
  projection every surface reads: `activityFeedItems` (agents only),
  `activitySections` (one per Work-board column, empties included),
  `activityNotificationItems` (non-agent, inbox-eligible), and the counts and
  phrases the trigger, chips and footer share.
- `apps/desktop/src/renderer/components/activity/useProgressiveRows.ts` — the
  bounded row budget (60, stepped by 60) that keeps long columns cheap.
- `apps/desktop/src/renderer/components/activity/ActivitySettingsPopover.tsx` —
  the gear in both the popover and the pane. It mounts
  `settings/ActivitySettingsControls.tsx` in its `popover` variant, which
  `settings/NotificationsSection.tsx` also mounts, so the Settings page and the
  in-surface gear cannot drift. Every row saves on change; there is no Save
  button, which the popover it replaced did have.
- `apps/desktop/src/renderer/lib/legacyRoutes.ts` — `LEGACY_ROUTE_ALIASES`
  maps `/attention` to `/activity`. ADE's shell matches top-level surfaces with
  pathname predicates rather than `<Route>` elements, so there is no
  router-level redirect to hang a rename on; this is the route-level twin of
  `settingsManifest.ts`'s `LEGACY_TAB_ALIASES`.
- `apps/desktop/src/renderer/webclient/adapter/attention.ts` — direct browser
  account-relay reader plus signed-out paired-host fallback through
  `attention.getMachineSnapshot` / `attention.acknowledgeMachine`.
- `apps/push-relay/src/attention.ts` and `attentionAuth.ts` — account merge,
  Clerk verification, acknowledgments, presence/preferences, APNs fan-out,
  machine removal/revocation and pairing restore, and the cron-only expiry and
  orphaned-machine sweeps.
- `apps/push-relay/src/liveActivity.ts` — the account-wide Live Activity
  projection (state-group tally, roster caps, privacy redaction, start lease, and
  the per-device APNs start/update/end loop), split out of `attention.ts`.
- `apps/push-relay/src/attentionShared.ts` — the environment, bounds, and helper
  vocabulary both of those need, existing to break the import cycle the split
  would otherwise create. It is where the relay declares `chatActivityMode` on
  its parsed item.
- `apps/ade-cli/src/services/account/machinePairingRepair.ts` — re-pairing this
  machine after removal. It owns the order the two halves lift in: the directory
  publish first, the durable push gate only after the directory accepts, because
  a machine back on the roster but silently undelivering is worse than one that
  is plainly gone.

See `push-notifications.md` for the full topology and delivery policy.

Desktop client adapter (`apps/desktop/src/main/services/sync/`):

Each file here is a one-line re-export of the canonical ade-cli module, so
desktop imports still resolve. The legacy in-process host in
`apps/desktop/src/main/main.ts` (`ADE_ENABLE_DESKTOP_SYNC_HOST=1`) uses them
for diagnostics only.

Sync IPC routing in the renderer (`apps/desktop/src/preload/preload.ts`):
project-scoped `window.ade.sync.*` calls go through
`callProjectRuntimeSyncOr(method, params, localFallback)`. A window bound to
a remote runtime uses `IPC.remoteRuntimeCallSync`; otherwise
`IPC.localRuntimeCallSync`. In-process sync IPC runs only with no runtime
binding (tests, diagnostics).

`window.ade.sync.getLocalStatus(args?)` is the exception: main sends
`sync.getStatus` through the machine-level `LocalRuntimeConnectionPool`,
never the window's remote binding. The This computer card and local device
controls use it, only through `renderer/lib/localSyncStatusReader.ts`.

- The `sync-status` broadcast is an invalidation, so every subscriber
  re-reads. The reader **coalesces** them into one invoke and **backs off**
  (1 s doubling to 30 s) after an unhealthy read.
- Main states "unhealthy": `buildMachineOnlySyncSnapshot` sets
  `degradedReason`. Do not infer it from route health, which is all-down on
  a healthy standalone machine. `sync.local_status_degraded` logs at most
  once a minute per reason.
- Reads a person asked for pass `{ force: true }` (opening Connections,
  **Try again**, after a device change, after **Repair**). The reader settles
  **last-issued-wins**.

During a project switch, sync mutations (`sync.setPin`, `sync.clearPin`,
`sync.connectToBrain`, lane presence, model-picker writes) fail with
"Project is switching"; reads still work. Remote sync calls replay only for
the retry-safe allowlist (status, discovery, device and PIN reads, lane
presence announce, model-picker reads).

Runtime-event IPC uses the same binding path. On an `eventEpoch` change
preload resets its cursor and dedupe cache; on `gap: true` it runs the normal
binding refresh.

`sync.connectToBrain` is a legacy name; say "runtime connection".

The shared protocol DTOs (`SyncEnvelope`, `terminal_input`,
`terminal_resize`, `SyncCliLaunchProvider`, `SyncStartCliSessionArgs`,
`SyncStartCliSessionResult`, `SyncListExternalSessionsArgs`,
`SyncImportExternalSessionArgs`, `PersonalChatRemoteCommandAction`) live in
`apps/desktop/src/shared/types/sync.ts`. CLI argv comes from
`apps/desktop/src/shared/cliLaunch.ts`.

Hosted-web wire client (`apps/desktop/src/renderer/webclient/sync/`):

- `wireProtocol.ts` — browser envelope encode/decode through
  `CompressionStream` / `DecompressionStream`, negotiated `deflate`, outbound
  chunk framing, bounded inbound chunk reassembly with the same 30-second
  expiry, and strict integer protocol-range validation.
- `connection.ts` — advertises `deflate` and `chunkedEnvelopes` in `hello`,
  applies the host's `hello_ok` selections to later sends, serializes async
  compression/chunk writes to preserve envelope order, clears partial chunks on
  disconnect, and surfaces protocol mismatch as a terminal update error.

iOS service files (`apps/ios/ADE/Services/`):

- `Database.swift` — native SQLite3 + pure-SQL CRR emulation (triggers
  + custom SQLite functions). Offline caches for files workspaces,
  directory listings, file contents, session pin/runtime state, chat
  snapshots, PR mobile snapshot persistence, the CRR-safe
  and the `pull_request_chat_sessions` relationship table.
- `SyncService.swift` — WebSocket client, legacy gzip plus negotiated
  zlib-wrapped deflate envelope encoding, bidirectional bounded chunk framing
  and 30-second reassembly expiry, typed protocol-range mismatch presentation,
  command routing, keychain integration, PIN-based pairing, the sealed
  `ade-adopt-v1` account-adoption client (challenge/verify against the
  directory `pubkey`, sealed `account_sealed` hello, and LAN → Tailscale →
  Relay route fallback with per-stage progress and a PIN-pairing fallback), lane
  presence announcements, terminal subscribe/unsubscribe tracking,
  terminal input/resize senders, mobile CLI launch/continuation,
  external-session list/import commands for Work,
  PR mobile snapshot fetch (including active/previous lane PR projection),
  live chat-event push listener, subscription-scoped
  `chat_history` request/response tracking with an 8-second non-disconnecting
  timeout and legacy command fallback, lane
  lane creation defaults and
  override, project hub/catalog state, active-project scoping,
  and local project-list hiding for
  "Remove from list" so cached DB rows and runtime catalog rows for
  the same root disappear together.
- `SyncConnectionRace.swift` — the single happy-eyeballs race that dials
  direct and Relay candidates together: candidate plan construction, stagger /
  concurrency / overall budget, the Relay join delay and the separate
  `accepted` / `ready` deadlines, the coarse network fingerprint (`wired`,
  `wifi:<own IPv4 /24>`, `cell`) and MRU-capped per-network route memory,
  per-endpoint failure memory, and the single-flight registry that prevents two
  concurrent `/connect` dials for one machine.
- `SyncRecoveryPolicy.swift` — deterministic reconnect, request-timeout, and
  heartbeat-silence policy, plus the roam-trigger policy: a real
  interface-set change (failover) or a periodic upgrade probe toward a strictly
  better transport class are the only reasons a healthy connection is re-raced.
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
2. The phone renders the catalog as a project hub — recent projects
   marked available/cached/unavailable, with `MobileProjectSummary`
   metadata (icon, lane snippets) supplied by the runtime.
3. The user taps a project → phone sends `project_switch_request`.
   The runtime's `prepareProjectConnection` only opens the target
   project scope and replies with the **current** port in a
   `project_switch_result` (fresh `connection` payload or
   `connection: null`, meaning reuse existing pairing credentials).
4. After the result is flushed, `completeProjectConnection` runs: the
   old host stops first and the new host starts on the same port under
   the 8787-first preferred-port retry, adopting any sockets that stayed open.
   A phone that initiated the switch tears down and reconnects against
   the same port; a phone that was merely connected while another
   client switched projects is adopted in place and never disconnects.
   If the switch fails, the previous host is restored so the listener
   is never left unowned.
5. A project that follows another machine's brain cannot be hosted here.
   `prepareProjectConnection` asks the target's sync service
   (`getHostBlocker`) before it answers, and replies `ok: false` with the
   reason. `switchSyncHost` asks the same question, and what it does with the
   answer depends on what its caller asked for (`purpose`):

   - `"host"` (the default — this phone project handoff) **refuses**, before
     the previous host is touched and before either phase runs. Without this
     check the old host released the machine-wide lease, the target never took
     it, and every connected client dropped until the switch timed out. Both
     phases await the one shared role-refresh drain, and for a viewer project
     that drain dials the other machine (`activation` is
     `setHostStartupEnabled(true)`). That dial is bounded to 5s
     (`VIEWER_CONNECT_TIMEOUT_MS`), so checking the blocker first means a
     refused switch never dials.
   - `"serve"` (status, roster and document reads, via `resolveActiveSyncHost`,
     and the brain's startup loop) **adopts the scope as-is**. With no host
     yet, `resolveActiveSyncHost` takes the most recently opened project whose
     folder and `.ade` data are still there, and with none it returns null, so
     the startup loop hosts machine-level sync without a project. A scratch
     project in a folder a restart wiped (`/tmp`) once kept a brain retrying
     it for minutes with no sync for phones or other machines. Each skipped
     project is logged once per brain as `sync.host_project_missing`, with the
     same "isn't there" sentence. A laptop
     following a desktop is a supported, working configuration and a viewer
     already owns sync here, so refusing it would break reads that work.
     Nothing is activated for it — there is no host here to start — and this
     explicit switch skips the initialization phase. A cold runtime still
     initializes sync in the background, however, and its saved peer dial is
     bounded the same way. When another project already hosts, the current host
     keeps its lease, its discovery and its place as the sync host; the
     followed project is only read.

The saved viewer connection (`sync-peer-draft.json`) is in the machine-wide
pairing directory, but joining another brain is a choice about one project
database. The draft records the `projectSiteId` of the project that made it,
and every other project ignores it. A draft written before that tag applies
only to a project whose cluster record already names another machine's
brain. A project with no cluster record (for example, one first opened from
the phone) becomes its own host instead of a viewer of an unrelated machine.

The hosted browser uses the same machine catalog and project-switch protocol
behind a different shell. Its permanent Hub chooses a machine, while the top
bar persists logical repository tabs. Same-origin checkouts on different
machines share one repository tab and expose machine choice inside that tab.
Changing tabs reconnects a Parked machine if necessary, switches the runtime to
the bound project, and installs the adapter keyed to that exact binding. Only
the active hosted project surface mounts; inactive tabs retain navigation and
binding metadata rather than live renderer subscriptions.

The project hub can also manage machine projects without first binding
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

To make the next switch land faster, `ProjectScopeRegistry.prewarmRecentScopes`
does a one-shot background warm-up of at most two most-recently-used project
scopes after startup. Prewarming calls `get(projectId, { touch: false })` so it
never rewrites registry recency, excludes the already-warm active host, and is
suppressed while a sync-host switch is in flight (`syncHostTransitionDepth > 0`)
or after disposal; a failed prewarm is swallowed so a later real open retries
`get()` normally and surfaces its own error. The sync-host switch itself is now
wrapped in a `syncHostTransitionDepth` guard so overlapping prepares/switches
don't race the prewarm or each other.

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

Sync authority transfer is an explicit runtime operation; no client elects
itself automatically. Only one runtime owns execution at a time. Phones are
controller-only and never elect themselves.

Transfer:

1. Preflight blockers — running chat turns and live PTYs. CTO
   history/idle threads and idle/ended chats are treated as durable synced state
   and survive a handoff.
2. Final sync flush on the old authority runtime.
3. `sync_cluster_state.brain_device_id` rewrites, `brain_epoch`
   increments.
4. New authority runtime starts its sync lifecycle. Old authority runtime demotes.

A second desktop that simply pulls the repo without joining a sync
cluster is its own local ADE machine for execution — that is not the
same as being part of the cluster. Multi-runtime active-active execution
is not supported.

## Account directory and connection leases

The account directory is discovery, not durable liveness authority. The
runtime publishes every 30 seconds into a 90-second directory presence lease;
the `online` bit expires when those heartbeats stop, but a previously validated
secure Relay endpoint is still worth an authenticated dial. Machine-selection
surfaces therefore distinguish "no current heartbeat" from "no usable endpoint" and
keep a row connectable while at least one directory-verified secure route
remains. The authenticated hello is the final availability and identity check.

Sleep is a **stated fact**, not an inference from silence: a closed laptop
lid and a healthy laptop both stop heartbeating. Migration
`0006_machine_power.sql` adds three nullable columns to `machines`:

- `power` — JSON `{"batteryPercent": 0-100 | null, "charging": bool | null,
  "onExternalPower": bool | null}`. `batteryPercent` is null, never `0`, on a
  machine with no battery.
- `sleep_state` — `'awake' | 'asleep'`, as last announced by the machine itself.
- `sleep_state_at` — epoch ms at which `sleep_state` last changed, deliberately
  distinct from `last_seen_at`.

All three are optional on the wire and the register upsert **coalesces** rather
than overwrites them, so an old host heartbeating alongside a new one cannot
blank what the new one stored, and one dropped field cannot erase known state.
Power is advisory: a malformed value degrades to unknown and never rejects the
machine registration. Because `sleep_state` coalesces forward it has no path
back to NULL, which is why clients age the announcement rather than trusting it
forever (`resolveMachinePresence`, above).

The announcement happens in the beat *before* the machine goes dark. On a
desktop host, Electron's `suspend` event reaches `machinePowerBrainBridge`,
which calls the brain's `machine.reportPowerTransition` RPC (`cto` role
required; `kind: "suspend" | "resume"`, optional `budgetMs` clamped to at least
250 ms) inside a 2-second budget; the brain notes the announced suspend and
awaits one bounded `publishPowerStateNow()` HTTPS write, coalesced so a single
suspend produces a single write. On resume the brain notes the wake and lets
the publisher's own subscription push an immediate "awake" rather than waiting
out the 30-second heartbeat. A host with no wiring for this (a headless brain,
a Linux box) answers `{accepted: false, reason: "unsupported"}` and falls back
to the heartbeat-gap detector, which infers the same transition with no
platform-specific code.

Directory list, delete, rename, and publish operations retry one 401 with a
forced access-token refresh. Only a repeated 401/403 is classified as
`auth_expired`; timeouts, server failures, and temporary token-verifier/JWKS
failures remain retryable and do not erase pairing trust. Rename is an
owner-scoped `PATCH /account/machines/:machineKey` with an additive, nullable
`customName` capped at 80 characters. Registration updates the reported
hostname and reachability lease but never overwrites that custom name. Clients
preserve both values and use `customName`, then the reported hostname, as the
display precedence.

### Cloud computers in the directory

A cloud computer's directory row also reads the account server's record of
that computer (`withCloudTruth` in `apps/account-directory/src/directory.ts`):

- A resting computer (asleep, stopped, or deleting) answers `online: false`
  and `sleepState: "asleep"`, whatever its last heartbeat says. Released
  clients already read that as "asleep, wake to reach it".
- Every cloud row adds `cloud: { state, stateAt }`, where `state` is `awake`,
  `waking`, `updating`, `asleep`, `stopped` or `deleting`.

So every client and the awake-computer cap read the same state. Clients show
these rows as ADE Cloud, never as separate machines.

### One computer, one row

A directory row is keyed `(user_id, machine_key)`, and the machine key lives in
a file. Anything that replaces that file — a reinstall, a wiped config
directory, a restored backup, a relay claim conflict this machine recovered
from — therefore produces a *second row for one physical computer*. The owner
sees two, deletes the one that looks stale, and half the time that is the live
install. Three mechanisms, each in a different layer, keep that from happening:

- **The key is hard to lose.** `sync-cloud-relay.json` is written durably and
  mirrored to a `.bak` sibling, an unreadable file is distinguished from an
  absent one, and a machine key is preserved from whichever copy still holds it.
  A new identity is minted only when both copies yield nothing.
- **Reading it never blocks the brain.** The brain reads the identity, the
  relay preference and `sync-device-id` on hot paths (every Attention build,
  every account-directory publish), and on Windows one synchronous read of a
  file under `~/.ade/secrets` waited up to 22 s behind an antivirus scan. Each
  process reads them once and keeps them in memory (`FileStampedMemo`,
  `apps/ade-cli/src/lib/fileStampedMemo.ts`; `machineIdFile.ts` for the id
  files), re-checking with one async `stat` per read. A write in the process
  (a rotation, a repair, a relay toggle) is what every store reads next; a
  write by another process is seen once that check lands, normally the next
  read. The credential store is the exception: it holds rotating tokens
  several processes coordinate through, so `getSync` keeps a synchronous
  `stat` per call (a `stat` is not scanned) and only moves its expiry re-read
  off the event loop.
- **Rotations are budgeted and the budget is persisted.** Two per rolling 24
  hours, counted in the identity file itself so a crash loop cannot mint one row
  per boot. A machine that spends the budget stops minting and says so — "This
  computer needs to be reconnected to your ADE account" — instead of retrying.
- **The directory dedups what still gets through.** A register call that carries
  proof of a fresh interactive sign-in (or spends a pairing grant) and whose
  `deviceId` or `hardwareId` matches other rows on the account retires those
  rows, folds the most recent user-typed `custom_name` onto the survivor, and
  returns the retired keys. `hardwareId` is what covers the case `deviceId`
  cannot: both the machine key and the device id live under `~/.ade`, so a full
  wipe mints both afresh and matches nothing, while a per-account hash of an
  OS-level machine identifier survives it. It is salted with the account id and
  folded with the ADE home path, so it can neither correlate two accounts nor
  merge an Alpha install into Stable's row, and a host that cannot read one simply
  omits it.

### Getting back on after a refusal

Removal is deliberately durable: the directory records a revocation before
deleting the row, so a removed machine that still holds a valid account token
cannot simply re-register itself. Getting back on needs a credential a removed
machine cannot mint — either an access token whose *interactive* authentication
happened within the last ten minutes, or the single-use pairing grant minted at
the end of a device-flow sign-in. Spending a grant is two-phase (reserve, then
consume or release), so a relay outage during the hand-off does not burn the
one credential a reinstalled machine has.

`machinePairingAutoRecovery` runs the
same brain action the **Reconnect this computer** button runs, on a slow
budgeted schedule (1 minute, 5 minutes, then hourly; three repairs per rolling
six hours, persisted), for the two refusal codes and for a publish leg wedged in
`snapshot_failed`. It widens nothing — a genuine removal is refused exactly as
it would be interactively — and it holds off entirely while a revocation is less
than ten minutes old, which is the same window in which the directory would
still accept the machine's existing sign-in. Waiting that window out means the
only repair this loop can land is one granted on stale-but-valid grounds: a
stale row, a key rotation, a directory hiccup. A deliberate removal stands, and
recovering from it needs the user's next interactive sign-in. While the
directory refuses the machine, the desktop shows a lasting banner ("This
computer was removed from your account on 14 August", with **Reconnect this
computer**, or **Confirm it's you** when the directory wants a fresh sign-in).
When the loop gives up, the banner says so, rather than only a diagnostic
toast. The browser page of that confirmation names the computer that asked
("A computer named MacBook Pro · Alpha asked to sign in to ADE") when the
client sent its name.

Removal itself asks twice. Every Remove confirmation (desktop sheet and web
client) names the install ("MacBook Pro · ADE Alpha") and warns when the
machine reported in during the last five minutes. The `account.deleteMachine`
action is for people only. It refuses a caller whose identity names a chat, run,
step or attempt (`callerIdentityIsAgent` in `apps/ade-cli/src/runtimeRoles.ts`),
the CTO included. It also refuses without `confirmation: "REMOVE"`
(`ADE_ACCOUNT_DELETE_MACHINE_CONFIRMATION`), the same token `ade machines remove
--confirm REMOVE` takes and forwards. The identity is the caller's own claim,
so this stops the ordinary agent path, not a process that strips its
environment. The desktop Account page and the web client remove through the
directory directly, behind their own dialogs.

**Removing a computer from a chat.** A caller that names a chat
(`ade machines remove <name|key|id>` from an agent's shell) does not get the
refusal. The brain that holds the chat raises a card in it
(`apps/ade-cli/src/services/account/machineRemovalRequest.ts`) and the command
waits for the answer:

- The card shows the computer's name, platform, install, last-seen time and
  online state, and what removal does. The buttons are Keep and Remove.
- An online computer, or the computer that runs the chat, needs a second
  "Remove anyway". Remove without it keeps the card open.
- The card is user-only (`MACHINE_REMOVAL_REQUEST_METADATA_KEY` in
  `isUserOnlyConsentCard`): an agent, a peer chat, the CTO tools, a lane-share
  guest and the subagent relay are refused, and the card takes no typed answer.
- The removal runs inside the person's accepted answer, on the brain that holds
  the chat, with the same directory call as the person's own removal. The
  answer travels to that brain with the chat's pin, so "this computer" on the
  card means the chat's computer, not the window's.
- The command exits 0 for `removed`, 2 for `kept` or `timed_out`, and 3 for
  `pending_approval` (another chat already has a card open for that computer;
  the same chat asking again joins its card).
- Stopping the turn, deleting the chat or archiving it closes the card, and the
  agent gets `kept`. A removal that the person started before the card closed
  still reports `removed`.
- A brain that does not hold the chat refuses with a message that sends the
  person to the Account page.

A refusal must not read like an outage. When the directory reaches a decision it
answers a `403` with a machine-readable code — `machine_revoked` or
`pairing_authentication_required` — carried on the publisher health's
`lastHttpReason`. The Connections popover decodes it with
`readAccountRefusalCode` (in `shared/accountMachineRefusal.ts`) instead of
showing an outage line: the This-machine line and the
publish-failing banner say "this computer was removed from your ADE account" or
"sign in again to reconnect this computer", and the banner offers a
**Reconnect this computer** or **Sign in again** button that presses the same
brain repair the Account page does. The shared copy table
(`describeUnpublishedAccountDirectory` in `shared/types/sync.ts`) and the shared
reconnect orchestration (`runMachinePairingReconnect`, which escalates to the
device-flow sign-in only when the refusal demands it) keep the pane, the banner,
and `ade setup` from drifting. Any other HTTP failure (a `5xx`) says "ADE's
account service is having trouble right now", and a request that gets no reply
at all (a timeout or transport error) says "no internet connection": the
directory sits on Cloudflare's edge, which answers even when the service behind
it is down, so silence means this computer is offline.

Every refusal the Worker issues is also logged with its wire code, a finer
`reason`, the correlation id, and 8-character identifier prefixes, because by
the time a locked-out user asks for help the request itself is long gone.

Account adoption captures the account owner/session generation and rechecks it
before and after credential persistence so a late result cannot recreate trust
after sign-out or an account switch. Once the host has minted a device-bound
paired secret, that host-issued direct trust is distinct from the account
session that found the machine: sign-out removes directory visibility and
Relay authorization but does not delete the secret needed for LAN/Tailscale
reconnect. Forgetting the machine is the explicit trust-deletion boundary.
Signing into a different account cannot use the previous account's directory
or Relay lease.

Hosted web exposes both trust scopes without conflating them. Removing a
machine from the ADE account deletes the owner-scoped directory row. Forgetting
it on this browser deletes only the local environment, paired secret, and DPoP
material; an account machine can appear again from the directory and be
adopted later. Account rename updates `customName` and leaves browser trust
unchanged.

Relay has two related but distinct leases. The machine's control tunnel may
survive a transient refresh failure only until its last known account-token
expiry; sign-out, owner change, or expiry closes the control and active pipes.
Each paired Relay peer also carries its own short-lived account authorization.
Peers advertising `relayReauthorizeV1` renew that authorization in place with
a DPoP-bound fresh token; terminal identity/proof failures close the peer,
while expiry/verifier-unavailable results can retry inside the advertised
grace. Older peers close exactly when their initial token expires.

### Adopting a manual pairing into an account

A device can hold a pairing record that predates the account: `SyncPairingRecord`
with `accountOwnerUserId: null` is a QR, Nearby/PIN, or SSH pairing made by hand
at the Mac. When that same `deviceId` presents an account-authenticated hello,
the host **adopts** the record instead of leaving it local: it sets the account
owner, mints a fresh device-bound secret, and returns it in `accountPairing`.
This is what lets a signed-in device that no longer holds its manual secret
recover over the network rather than requiring a physical trip back to the Mac.

Adoption never leaves the two ends on different secrets. The new secret travels
only inside `hello_ok`, so a link that drops before the device saves it used to
leave the host on the new secret and the device on the old one, with "pair it
again" on every connect. Now, for a record that already exists:

- The account hello may carry `pairedSecret`, the secret the device already
  holds for this host (desktop and web send it; iOS does not yet and gets the
  staging below). The desktop sends it only to the host identity that issued
  it, and only inside the sealed adoption channel, after the host signed the
  challenge with its device id. Web sends it over the relay route that
  already carries the same secret in every paired hello. When it matches the committed
  or the staged secret, the host keeps that secret, applies the account's
  ownership and grants, and omits `accountPairing`. Nothing is minted, so no
  reply can be lost.
- Otherwise (an older client, or one that lost its secret) the new secret is
  **staged** behind the committed one (`pendingRotation`, `secretOnly: true`).
  Ownership and grants apply at once, because the attestation is the proof;
  only the secret waits. The first hello that authenticates with the new secret
  promotes it and retires the old one. The staged secret has no expiry window:
  the device has no follow-up to arm one with, and the old secret was valid
  before the adoption anyway. A paired hello still needs the record's pinned
  DPoP key.
- A later staging (another adoption, or a PIN re-pair) does not take an
  unproven adoption secret away: it moves to `displacedAccountSecretHashes`
  (newest first, at most sixteen) and still authenticates and promotes like
  the staged one. The host keeps only hashes, so it cannot hand an unproven
  secret out again; the bound covers a device that lost many replies in a
  row. Proving the staged secret clears the list. Proving a displaced one
  keeps the staged rotation (a PIN re-pair waiting for `pairing_commit` keeps
  its window) and the entries issued after it. A phone that saved one
  adoption's secret and lost the next replies keeps working.

Each account hello that reaches the store logs
`sync_host.account_pairing_secret` (`sync_ingress.` on the brain) with
`outcome` `kept`, `staged` or `minted`, never the secret.

A first-time account pairing (no record) still writes straight through: the
device holds no secret that a lost reply could strand. On the client,
`reconcileStaleAccountCommit` puts a prior record back only when it holds the
secret the host kept; after a host that minted a new secret, it removes the
record instead of saving one the host refuses.

Adoption is an authorization decision and it is gated on evidence, not on the
caller's claim:

- The hello must carry a DPoP proof that verifies against the P-256 key already
  **pinned on that record**. The pinned key is the only evidence that the
  signing-in device is the same physical device that paired manually, so a
  record with no valid pinned key is refused outright (`sync_host` logs
  `sync_host.account_existing_keyless_rejected`). Both the host guard and
  `syncPairingStore.writeNewPairingRecord` test key *validity* rather than
  truthiness via `isValidDpopPublicKey`, so a blank or whitespace-only field
  cannot slip past one guard and land in `evaluatePairedHelloDpop`'s
  legacy TOFU branch, where the proof would be checked against a
  caller-supplied key.
- The Clerk attestation must be verified and re-captured under the commit lock,
  and a record already owned by a **different** account is still refused.
- Unlike first-time adoption, the pinned key and `createdAt` are preserved; the
  hello's offered key is ignored.

Adoption is **deferred** while a PIN re-pair is staged on the record and the
device has not acknowledged it (`pairingStore.hasPendingPinRotation`). An
earlier adoption's staged secret does not defer: it never expires, so it would
block every later adoption of that record. Adoption
would replace the staged secret and leave the device's `pairing_commit` with
nothing to promote. That hello answers
`hello_ok` without `accountPairing` and logs
`sync_host.account_adoption_deferred_pending_rotation`; a device mid-re-pair
holds a working secret by definition, and every client treats an omitted
`accountPairing` as "keep the credential you already have".

Adoption grants the account a way to *use* a pairing; it does not rewrite who
created it. `SyncPairingRecord.localTrustOrigin` records that the underlying
trust started as the user's own physical act at the Mac, and is sticky once set.
The sign-out / account-switch sweep (`revokeAccountOwnedExcept`) therefore does
not delete such a record — it **demotes** it back to `accountOwnerUserId: null`
so it returns to pure local trust and stays usable on LAN/Tailscale. Demotion,
not merely skipping the delete, is what keeps it usable: every reconnect path
rejects a record whose owner no longer matches the signed-in account, so a
surviving-but-stale owner is the same dead end in a different place. A later
same-account hello re-adopts the demoted record through the same gate. A
successful adoption logs `sync_host.account_legacy_pairing_upgraded`.

## Device discovery

- **Machine-to-machine**: pair or connect from **Connections > Machines** with
  a same-account machine, Nearby/network discovery + PIN, or Advanced SSH.
  Account machines appear automatically after sign-in and adopt without a PIN;
  Nearby is the only direct PIN-pairing entry point. There is no Share/pairing
  link or manual address + PIN surface. The saved result is a per-device
  DPoP-bound secret; legacy machine bootstrap tokens remain internal
  compatibility state, not a user pairing path.
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
  new PIN. The **This computer** card in Connections exposes the
  generate-new-PIN recovery path; the phone enters the same digits shown there
  after scanning the QR or choosing the machine from Nearby. ADE account
  sign-in is the primary PIN-less phone path through the directory and Relay.
  Failed PIN attempts increment a per-IP counter; after 5 failures
  the runtime rejects further attempts from that IP for 10 minutes
  (`PAIR_FAILURE_THRESHOLD = 5`, `PAIR_COOLDOWN_MS = 10 * 60_000` in
  `syncHostService.ts`).
- **QR payload**: `SyncPairingQrPayload` is **version 3**, encoded as a
  single **smart pairing URL** (`https://ade-app.dev/pair#<base64url(JSON)>`,
  codec in `apps/desktop/src/shared/pairingQr.ts`). This URL is internal wire
  encoding for the system camera / App Clip path, not a user-facing link to
  copy or paste. The payload rides the URL fragment, so the JSON never reaches
  a web server. It carries
  machine identity, port, and address candidates (plus the cloud-relay
  `relayUrl` when the host is signed in) — it never embeds a pairing code or expiry, so
  the phone still needs the PIN manually. It may also carry an additive optional
  `pinConfigured` Boolean (`PairingQrPayload` in
  `apps/desktop/src/shared/pairingQr.ts`, mirrored by `PairingQrPayload.swift`):
  a hint that the host already has a pairing PIN set, so the scanner can steer a
  no-PIN host toward the generate-a-PIN step instead of a dead-end PIN prompt.
  The hint is advisory only — the live `pairing_result` (`pin_not_set`) stays
  authoritative if the PIN changes after the QR was minted. Newer payload
  versions parse leniently: the iOS scanner accepts any version ≥ 3 as long as
  the fields it understands are present, and both codecs treat a non-Boolean
  `pinConfigured` as absent.
- **Address candidates**: the runtime advertises LAN IPs, the saved
  `lastHost`, the Tailscale IP,
  `127.0.0.1`, and — while the host has a current ADE account lease — a
  `relay`-kind candidate carrying a full
  `wss://…/connect/<machineKey>` URL. `SyncAddressCandidateKind` is
  `lan | saved | tailscale | loopback | relay`, but the saved `lastHost` is now
  emitted with the **kind it actually is**: `buildAddressCandidates` classifies
  it as `lan` when it matches a current LAN IP, `tailscale` when it matches the
  Tailscale IP or DNS name, and only falls back to the opaque `saved` kind for a
  host that no longer matches the live address set. This is what lets the account
  directory publish a LAN-backed saved host as a real LAN endpoint. iOS treats
  Relay as one more authenticated candidate in the same happy-eyeballs race as
  the direct LAN/Tailscale routes — ranked behind them, but not gated on their
  exhaustion (see the transport race in
  `ios-companion.md`). Already-paired
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
  so re-publishing is a no-op while the port hasn't changed. Because
  `serve --bg` outlives the process that registered it, each successful publish
  is followed by a best-effort reclaim (`staleAdeTailnetServePorts` +
  `reclaimStaleTailnetServes`, logged as `sync_host.tailnet_serve_reclaimed`):
  `tailscale serve status --json` is scanned for ADE's exact signature — a port
  in the sync range forwarding to `127.0.0.1` on the **same** port — and every
  match other than the live one is turned off. Without it, a restart or
  force-kill strands an entry that Tailscale keeps bound on the tailnet address,
  ADE's next wildcard bind fails `EADDRINUSE` against its own leftover and walks
  one port higher, and the port ratchets upward on every start. A hand-rolled
  `tailscale serve` forwarding anywhere else is never touched, and the live port
  is re-checked inside the loop because reclaiming frees exactly the low ports a
  concurrently restarting host prefers.

## Sync protocol (summary)

Envelopes are JSON with fields:

```ts
{
  version: number, // integer inside MIN_SUPPORTED...CURRENT
  type: "hello" | "hello_ok" | "hello_error" | "pairing_request" |
        "pairing_result" |
        "account_challenge" | "account_challenge_ok" |
        "account_challenge_error" |
        "changeset_batch" | "changeset_ack" |
        "heartbeat" | "file_request" | "file_response" |
        "terminal_subscribe" | "terminal_unsubscribe" |
        "terminal_snapshot" | "terminal_data" | "terminal_exit" |
        "terminal_input" | "terminal_resize" | "terminal_history" |
        "chat_subscribe" | "chat_unsubscribe" | "chat_event" |
        "chat_history" | "chat_tool_result" |
        "roster_subscribe" | "roster_unsubscribe" |
        "roster_snapshot" | "roster_delta" |
        "roster_chats_request" | "roster_chats" |
        "chat_launch_event" |
        "brain_status" |
        "project_catalog_request" | "project_catalog" |
        "project_catalog_chunk" |
        "project_switch_request" | "project_switch_result" |
        "command" | "command_ack" | "command_result" |
        "rpc_open" | "rpc_data" | "rpc_close" |
        "fwd_open" | "fwd_data" | "fwd_close" |
        "fwd_pause" | "fwd_resume" |
        "envelope_chunk",
  projectId?: string | null, // present on project-scoped envelopes
  requestId: string | null,
  compression: "none" | "gzip" | "deflate",
  payloadEncoding: "json" | "base64",
  payload: ...,
  uncompressedBytes?: number, // gzip/deflate only
}
```

Envelope types and `hello_ok.features` keys remain additive inside the
supported protocol interval
`SYNC_PROTOCOL_MIN_SUPPORTED...SYNC_PROTOCOL_VERSION` (currently `1...1`).
Receivers decode the common envelope first and dispatch only the types they
implement; an otherwise valid unknown type is ignored rather than closing the
connection. This is how iOS and hosted-web clients safely coexist with the
desktop-only `rpc_*` and `fwd_*` extensions. The paired desktop treats missing
`features.rpcChannel` or `features.portForward` exactly like `false` and does
not attempt that channel, while legacy phone/browser clients continue on their
existing mobile command surface when those keys are absent or present.

`hello_ok.projectHost` is additive in the same way: it carries this
connection's project-host readiness snapshot, and an older host simply omits
it. A client that receives nothing there learns the same thing it always did —
from the first command that fails with `host_unavailable`. The point of the
field is that socket-up is not the same as a usable project host, so a client
does not have to send a command to find out.

#### Fast connects on slow links

These parts of the connect are additive. Each one has a gate, so an old app on
a new brain and a new app on an old brain both keep the old behavior.

| Contract | Gate | What it saves |
| --- | --- | --- |
| Hello in the upgrade request (`X-ADE-Hello`, `v1.` + base64url, at most 12 KB) | Direct routes only; the host never reads it on a relay route. The client also sends the same hello as a frame, and a new host drops that copy by its request id. | One round trip before `hello_ok`. |
| `hello.pipelined` (the first requests ride in the hello) | `hello_ok.features.pipelinedHello.accepted` says how many the host runs; the client sends the rest itself. | One round trip per first request. |
| `commandRoutingDigest` / `actionGroups` | The hello's digest; capability `commandRoutingGroupsV1`. | The command list on a reconnect (`actionsUnchanged`), and about three quarters of it on a cold connect. |
| `projectCatalogDigest` | The hello's digest. | The catalog on a reconnect (`projectCatalogUnchanged`). |
| Roster head rows and `roster_chats_request` pages | Capability `rosterChatPagesV1`; `hello_ok.features.roster.chatPages`. | Older chats until a screen asks for them. |
| Roster resume by seq (`roster_subscribe.sinceSeq`) | The same paired device; a seq that another live socket uses is never resumed. | A full roster snapshot on a reconnect. |
| Changeset ack window (up to 8 batches, 1 MiB buffered) | Capability `changesetAckWindowV1`; it opens 3 s after hello and stays at one batch while a chat is busy. | Idle link time during a cold catch-up. |
| Conditional reads (`conditional`, `ifNoneMatch`, `acceptDelta`, `omitNullFields`, `headRows`, `activeOnly`, `allowCachedStatus`) | Arguments; an old host ignores them and answers as before. | Lists that did not change, and null fields. |

The host also answers a phone's first changeset batch at once (it holds the
project row that the first screen waits for), then holds catch-up for the first
seconds after hello, so the first chat page is not queued behind it. The phone
measures its handshake (dial to `hello_ok`); at 700 ms or more it asks for a
smaller first chat page and loads older events before the user scrolls to them.

An integer version below the floor or above the current version is different
from an additive unknown type. The host sends an uncompressed
`hello_error` with `code: "protocol_version_mismatch"`,
`receivedVersion`, `minSupportedVersion`, `currentVersion`, and
`updateTarget: "client" | "host"`, then closes with code `4406`. The
project host and machine-level fallback use the same response path. Browser and
iOS clients treat the error as terminal and name the side that needs an update
instead of silently dropping or retrying the connection. Non-integer versions
remain malformed envelopes.

#### `hello_error` codes are the contract; the message is not

A rejected handshake carries a structured `code`, and clients must branch on it.
The message beside it is prose for a human and may be reworded at any time, so
pattern-matching it is a defect. `SyncHelloErrorPayload` (in
`apps/desktop/src/shared/types/sync.ts`) currently defines:

| Code | What it means | What the client should do |
| --- | --- | --- |
| `repair_required` | The host has no usable pairing record for this device. | Pair again. This is the one rejection the user can act on directly. |
| `auth_failed` | The older, generic form of the same thing. | Treat exactly as `repair_required`. |
| `account_not_signed_in` | The target computer is not signed in to an ADE account. | Sign in to the same ADE account on that computer. Never destroy a saved pairing. |
| `account_verification_failed` | The target computer could not verify its ADE account session. | Check ADE's account state on that computer, then retry. Never destroy a saved pairing. |
| `host_update_required` | The host cannot verify ADE accounts yet. | Update ADE **on that machine**. Never destroy a saved pairing. |
| `account_session_changed` | The host's account session moved under the handshake, or the ingress cannot finish this sign-in shape. | Sign in / retry. Never destroy a saved pairing. |
| `relay_account_required` | The route needs an account-authenticated hello. | Sign in on this device. |
| `connection_attempt_superseded` | Another route won the same attempt. | Nothing is wrong; drop this attempt quietly. |
| `invalid_hello` | The payload was malformed. | Client bug or version skew. |
| `protocol_version_mismatch` | Version floor/ceiling, as above. | Update the side named by `updateTarget`. |

`account_not_signed_in`, `account_verification_failed`,
`host_update_required`, and `account_session_changed` exist because
`auth_failed` reads as "pair again" on every client, and that is the wrong — and
destructive — instruction for a target whose account is unavailable, whose
session cannot be verified, whose host is too old, or whose session moved
mid-handshake. Where a rejection *can* legitimately lead a client to drop a
saved pairing, the host also attributes itself with
`hello_error.host: { deviceId, name }`, and the client only acts when that
identity matches the pairing it holds.

Application compression is negotiated in the authenticated handshake. A new
iOS or hosted-web client offers an ordered `hello.compression` list; the host
selects the first mutual codec and returns
`hello_ok.compression: { codec, thresholdBytes }`. The current common codec is
zlib-wrapped `deflate`, and the selected threshold is 512 payload bytes. The
`hello` and selection-bearing `hello_ok` themselves retain legacy encoding;
both directions switch only after `hello_ok` is sent. If the offer is absent or
has no overlap, the selection is omitted and every implementation keeps its
pre-negotiation behavior byte-for-byte: Node/iOS legacy paths use gzip above
their existing 4 KiB threshold, while hosted web continues to send plain JSON.
There is no static dictionary and no zstd dependency.

`parseSyncEnvelope` accepts legacy gzip and negotiated deflate, caps decoded
output at `MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES` (25 MiB), rejects a declared
oversize before decompression, verifies `uncompressedBytes`, and rejects a
mismatch between `compression` and `payloadEncoding`.

Encoded envelopes larger than 720 KiB (`DEFAULT_SYNC_MAX_FRAME_BYTES`) are
sliced into `envelope_chunk` frames (base64 parts keyed by
`chunkId`/`index`) only after the client declared `chunkedEnvelopes` and the
host confirmed `hello_ok.features.chunkedEnvelopes`. That confirmation makes
the framing bidirectional: the host, iOS, and hosted web can all split outbound
envelopes, and each receiver reassembles the original encoded envelope before
normal decompression/JSON decode. A peer that does not advertise the capability
still receives and sends the exact single-frame legacy traffic.

Reassembly is bounded independently of the socket receive limit: at most eight
concurrent chunk sets, 512 parts per set, 128 UTF-8 bytes per `chunkId`, and
32 MiB aggregate decoded buffering. An incomplete set expires after 30 seconds
on Node, hosted web, and iOS; disconnect/reset clears it immediately. iOS also
keeps its WebSocket `maximumMessageSize` at 32 MiB. This protects large chat /
terminal snapshots, `file_response`, and `command_result` payloads without
letting abandoned chunk sets retain memory indefinitely.

#### Chat attachments ride HTTP, not the envelope stream

A chat attachment large enough to matter should not travel as base64 inside a
command payload: it inflates by a third, is buffered in memory on both ends, and
lands under the same 25 MiB decoded-envelope cap and 720 KiB framing as every
other message. So a host that can accept a file *as a file* says so, and a
client that can send one that way does.

The advertisement is `hello_ok.features.attachmentUploadV1`, an additive
capability carrying `{ enabled: true, path, maxBytes }`. The host emits it only
when its remote command service actually registered
`chat.createAttachmentUpload` — the route is useless without the mint — so an
injected or custom command service that omits the command also omits the
advertisement rather than promising an endpoint nothing serves.

Using it is two legs, in this order and only this order:

1. **Mint over the authenticated socket.** `chat.createAttachmentUpload` (sync
   command channel, for phones and browsers) or the action registry's
   `chat.createAttachmentUpload` (runtime RPC channel, for a paired desktop)
   returns `{ ticket, path, maxBytes, expiresAtMs }`. Both reach the host's one
   ticket registry.
2. **POST the body.** `POST <origin><path>` with
   `Authorization: Bearer <ticket>` and the raw bytes as
   `application/octet-stream`. The origin is the sync endpoint with `ws:`/`wss:`
   swapped for `http:`/`https:` — the sync HTTP server and the WebSocket share
   one port. The response is `{ path }`, the staged absolute path on the host.

The HTTP leg carries no standing authority: it never sees the pairing secret,
the ticket is consumed before a single body byte is read, and an unspent ticket
expires on its own after two minutes. The ticket names the route path and the
capability names the origin; a client composes them rather than trusting either
alone.

Three cases fall back to `chat.saveTempAttachment` with the legacy
image-only 10 MB contract, and all three are ordinary outcomes rather than
errors: a host predating the capability, a **relay-routed** connection (the
relay brokers WebSocket frames and cannot forward an HTTP POST to the host's own
listener — `hello_ok.connectionTransport` is the host's own statement of which
it is), and an SSH target, which is not a paired sync transport at all. **iOS
stays on the legacy path for images** and is not offered the route;
`workChatInputAttachmentMaxBytes` in `WorkChatAttachmentTray.swift` mirrors the
legacy constant for that reason.

### Chunked staging for file-shaped attachments

Documents and videos fit neither route above. `chat.saveTempAttachment` sniffs
the bytes for an image MIME and rejects anything else, and the HTTP upload needs
a direct TCP leg to the host's listener — which is exactly what a phone on the
cloud relay does not have. So there is a third contract, over the command
channel every client already has:
`chat.beginTempFileAttachment` → `chat.appendTempFileAttachmentChunk` (×N) →
`chat.finishTempFileAttachment`, with `chat.abortTempFileAttachment` for a
cancelled send. `apps/ade-cli/src/services/fileAttachment.ts` owns it and
`syncRemoteCommandService.ts` holds one registry per host, so every chunk of one
upload lands in the same session map.

Its rules:

- Same 50 MB product ceiling (`MAX_CHAT_ATTACHMENT_BYTES`) as the HTTP route,
  reached in 512 KiB raw slices (~683 KiB once base64-inflated) so every chunk
  is its own payload well under the transport's 25 MiB envelope cap.
- The running total is enforced **server-side**. A client that understates the
  size in `begin` still hits the ceiling on append; the declared size is a hint,
  not the bound.
- Bytes land in a `.part` file that is renamed to its UUID destination only on
  `finish` (through `commitStagedAttachmentPart`, so the Windows
  sharing-violation retry applies), so a torn upload never leaves a half file
  where the chat can pick it up.
- Sessions live in memory only, keyed by a `randomUUID` returned only to their
  creator, TTL-bounded (5 minutes idle) and count-bounded, pruned on every call.
  They are deliberately *not* bound to the peer that created them: the command
  channel is already authenticated and peer-scoped, and the execution context
  carries no peer identity to bind to — the same model as the HTTP route's
  tickets.
- `begin` also sweeps `.part` files older than the session TTL that the map can
  no longer account for. Those are the bytes a host restart or an abandoned
  `begin` leaves behind; without the sweep they sit in the project's attachments
  directory, visible in the Files tab, with nothing in memory that names them.
- The staged ref carries type `File`, so the agent receives a path exactly as it
  does on desktop.

`chat.getAttachmentChunk` is the read mirror — same chunk size, same
server-owned bound — so a client can pull a staged PDF or video back for an
in-thread preview without a 50 MB payload. Unlike `chat.getImageDataUrl` it does
**not** sniff for an image MIME, which is the point, so the caller must have
already constrained the path to the project root.

### Transport readiness and path truth

Relay controllers negotiate bridge readiness before sending an ADE envelope.
They first open `wss://…/connect/<machineKey>?ready=2`. A current Worker sends
`{"t":"accepted","v":2}` immediately, then sends
`{"t":"ready","v":2}` only after the runtime control pipe is open and the
sync host owns it (handed over in process, in the same tick as the pipe's
`open`). ADE `hello` is forbidden before `ready`.
If no `accepted` arrives within the short negotiation window, the controller
abandons that socket and retries the same route on a **fresh** URL without the
`ready` parameter for an old Worker. It never sends a legacy hello on the
ready-v2 socket: a delayed `accepted` would reinterpret that hello as illegal
pre-ready data. Once `accepted` arrives there is no downgrade; the attempt
waits for `ready` within the overall authenticated-hello budget or fails.

The Worker and brain bind control, pipe, ready, and reject messages to a random
connection epoch. A replacement control supersedes the old epoch, so a stale
pipe cannot attach to a new controller. Legacy Workers retain only a bounded
pre-ready buffer; ready-v2 paths buffer no ADE data before the bridge exists.
In the other direction the Worker holds host bytes that reach a pipe before
its pair is ready (in memory: 64 frames / 4 MiB per pipe, 16 MiB per machine,
sized for a stream's config + keyframe) and flushes them to the client after
its `ready`. The brain's pre-open buffer (`MAX_PENDING_TUNNEL_BYTES`) is the
same 4 MiB. Only the Apple device stream needs it: its loopback
socket speaks first. A lost or overflowing buffer closes the pair.

iOS races authenticated candidates rather than declaring victory at TCP or
WebSocket open: attempts are staggered by 250 ms, limited to three concurrent
candidates and a 10-second overall budget, and the first successful
`hello_ok` wins. Every candidate in one race carries the same monotonic
`peer.connectionAttempt` id/start time. The host serializes commits for that
device and rejects a late loser as `connection_attempt_superseded`, preventing
a slower route from evicting the winner. Finally, `hello_ok.connectionTransport`
is the host-observed `direct | relay` truth after authentication; controllers
use it for diagnostics/policy rather than inferring the path solely from a
cached candidate label.

The `hello_error` union includes the pairing, account, protocol, and route
codes in the table above. An `auth_failed` payload also carries an optional
`host: { deviceId, name }` naming the machine that rejected the hello — both
the project host and the brain-level fallback handler send it. This is the
client's only safe basis for destroying a saved pairing: a phone drops its
credentials **only** when the rejecting `host.deviceId` matches the paired
machine's identity. An unattributed rejection (older host, or a stranger
machine reached over a reused DHCP lease / mDNS alias / stale Tailscale
candidate) keeps the pairing and the client moves on to other routes.
`SyncPairingResultPayload.error.code` is one of
`invalid_pin | pin_not_set | pairing_failed`.

Heartbeat interval is 60 seconds. Desktop peers close after **two**
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
on timeout so a dropped wifi blip cannot lose a batch. After six failed sends
or acknowledgements, the sender abandons only that encoded batch — it does
**not** advance the last-acknowledged cursor. It backs off, rebuilds from the
same `fromDbVersion` with progressively smaller row/byte windows, and resets
normal limits only after a successful ack. Host and desktop-peer recovery
bottom out at 16 rows / 16 KB with 250 ms–4 s backoff; iOS starts at 64 rows /
64 KB, shrinks to one row / 4 KB, and backs off up to 30 seconds. A single
`db_version` transaction may exceed a target, because it is never split.
`pendingChangesetPeerCount` is surfaced through `brain_status` for
diagnostics; `brain_status` is a legacy envelope name.

An iOS replica advertising both `changesetAck` and `chunkedEnvelopes` takes a
compact path when its host cursor is strictly more than 5,000 versions behind:
the host sends one logical `reason: "catchup"` batch containing the bounded
current CRR state, split into `envelope_chunk` transport frames when necessary.
Its cursor still advances only after the batch ACK; later writes use ordinary
incremental batches. Oversized compact state falls back to the bounded replay
above. Local diagnostics use `sync_host.mobile_replica_reseed_started`,
`_ready`, `_skipped`, `_sent`, and `_fallback`; these polling mechanics are not
product analytics.

Mobile-originated `command` envelopes are deduplicated through a
short-lived `mobileCommandResultCache` (TTL 30 minutes, 512 entries)
plus a persisted journal, so a phone that retries the same
`commandId` after a reconnect receives the cached `command_ack` /
`command_result` instead of double-executing the action. Persisted
results are intentionally narrow: `work.runQuickCommand`,
`work.runShellBlock` and `work.startCliSession` keep only the returned
`sessionId` / `ptyId`
(and the `TerminalSessionSummary` for CLI launches), while failed
commands store a generic failure message instead of the original
payload.

### Sub-protocols at a glance

| Sub-protocol | Purpose | Used by |
|---|---|---|
| Changeset sync | Bidirectional cr-sqlite row exchange. Normal delivery uses bounded 250-row / 256 KB incremental batches; an ACK- and chunk-capable iOS replica strictly more than 5,000 versions behind may instead receive one ACK-gated compact current-state reseed (10,000 rows / 4 MiB maximum) before incremental delivery resumes | All devices |
| File access | On-demand project/worktree file reads, listings, writes | iOS Files, desktop remote viewing |
| Terminal stream/control | Subscribe to a logical-offset transcript snapshot plus live PTY output. The host installs a snapshot barrier before capture, queues concurrent data/exit events (256 events / 2 MB), trims overlap at UTF-8 boundaries, and recaptures up to four times when the snapshot did not reach the queued watermark; it closes instead of flushing a gap or unreconstructable overflow. Web/iOS clients drop duplicate ranges, trim overlap, and issue one guarded `sinceOffset` recovery subscribe when a live chunk starts beyond their watermark. A delta appends only the missing suffix; a full snapshot is authoritative replacement even when its end equals the current watermark. ACK-capable input uses stable `inputId`s and a bounded host dedupe ledger so reconnect/timeout retry cannot type twice; legacy hosts receive one-shot input with no ambiguous retry. Viewport resize remains subscription-scoped and the last desktop size is restored after the last mobile viewer detaches | iOS Work tab, hosted web Work terminal |
| Chat stream | Agent chat transcript events plus subscribed byte-cursor scrollback. Each `chat_event` carries a host-assigned per-session monotonic `seq` backed by a capped replay buffer (500 events / 2 MB per session). The host carries sequence high-water marks through shared-listener rehydration and seeds a recreated buffer from the agent event sequence persisted in session metadata/transcript state, so it never reuses a `(sessionId, seq)` pair. The field remains optional and old clients keep working unchanged. `chat_subscribe` accepts `sinceSeq`: gaps the buffer covers replay as ordinary events; uncoverable gaps fall back to an authoritative snapshot. Optional live sends are marked delivered only after the WebSocket accepts the frame; a backpressured peer keeps its transcript offset in place and the pump stops at the first failed event so later chunks cannot overtake the missing one. A per-session hydration barrier blocks both the live broadcaster and transcript pump while a snapshot is captured. The pump resumes after the ack from the logical byte offset recorded before capture, so appends racing a slow snapshot arrive after the ack without a gap; snapshot overlap is removed by the normal delivery-key dedupe. The snapshot is a byte-capped tail: `chat_subscribe` also carries the client's `maxBytes`, and the host clamps the snapshot's `getChatEventHistory` budget to `min(host cap, maxBytes)` — for a mobile-sized budget even the newest oversize event is dropped rather than force-included, so a phone never receives a snapshot larger than it asked for. Modern acks also return `cursorKind: "byte"`, `tailStartOffset`, and authoritative `hasOlderHistory`. A host advertising `chatHistoryPaging` accepts `chat_history` only for an already-subscribed session and matching project/personal/foreign scope; it reads the same authorized transcript path without switching projects or booting a runtime. Transient failures return `unavailable: true` and preserve the requested cursor. Snapshot and older-page transcript reads use asynchronous filesystem/zlib work; same-session tail reads coalesce, while archived gzip inflations are globally admitted with only the active inflate and newest queued destination retained. Small archives use a bounded memory cache; a larger archive is inflated at most once into an unlinked, process-private temporary file under a 256 MiB logical-size/LRU budget and a temporary-volume free-space guard, after which pages are random-access disk reads. Request cancellation propagates through queued work, file reads, and inflates, so disconnected clients cannot leave expensive transcript jobs running. Both event-history paging and the legacy `chat.getTranscript` route use append-stable logical byte cursors; the latter advertises `cursorKind: "byte"` so clients do not treat an offset as a dense entry index. Hosted-web and iOS older pages are capped at 256 KiB and a failed read preserves its byte cursor for retry. Snapshot events are marked as already-sent to that peer, so the follow-on live pump does not re-deliver the overlap. The ack also carries `turnActive` from the live agent chat service — because the snapshot is a byte-capped tail, a long turn's `status: started` event can fall outside the window and the flag is what lets a mid-turn subscriber render streaming/stop affordances without waiting on the changeset pump (a full ack without the flag tells the client to drop any latched hint). The additive foreign-scope protocol remains available to controller reads, but iOS Hub taps activate the owning project before opening the chat. A `session_meta_updated` `chat_event` carrying a client's permission/interaction/mode change also rides this stream, so a mode switch made on one client (desktop ↔ iOS) patches every subscribed client's cached summary and composer controls live without a refetch | iOS Work tab, iOS Hub, controller chat |
| Durable chat log (`chatLogV2`) | Hosts advertise `features.chatLogV2 { enabled, resumeMaxBytes }`. Every history reader of an active-project chat — snapshot, hydration offset, transcript pump, `chat_tool_result`, `chat_history` — uses the one file the chat service resolves (the durable, uncapped `.ade/transcripts/chat/<id>.jsonl`), so live updates continue past the legacy 8 MB session-row transcript. `chat_subscribe` accepts `sinceSequence` (the durable envelope `sequence`, valid across host restarts) plus `generation`: when the generation matches and every persisted event after `sinceSequence` fits in 2 MB, the ack is `{resumed: true, resumeKind: "sequence"}` and those events follow in order as required-send `chat_event`s (a socket that cannot take them is closed rather than left with a hole); otherwise the host sends a normal snapshot with `gap: true`. When the walk back to `sinceSequence` crosses a row too large to page (its stand-in has no sequence, see [transcript-and-turns.md](../chat/transcript-and-turns.md#a-row-too-large-to-page)), the reply is `ok` only if every sequence in (since, newest] was actually read; otherwise the gap reason is `row_too_large` and the client takes a snapshot instead of keeping a silent hole. The hydration barrier and delivery-key dedupe apply exactly as for snapshots. Unsequenced (transient) events stay live-only. Each chat persists a `historyGeneration` (starts at 1) that increases on any in-place transcript rewrite (splice repair today); acks, `chat_history` pages and roster chat rows carry it, the ack also carries `maxSequence`, and the `session_meta_updated {historyInvalidated}` event carries the new generation. A `chatLogV2: true` subscribe moves the snapshot cut back to the nearest `user_message` or turn `status: started` (at most one extra budget) and reports unresolved approvals older than the window in `pinnedEvents` instead of splicing them into `events`. `chat_history` accepts `beforeSequence` as an alternative to `beforeOffset` (binary search over the transcript for the cut, then the same byte-capped page). Folded replay rows carry `sequenceStart` (the first folded delta). Roster agent-chat rows carry `maxSequence` and `historyGeneration` (live counter for booted projects, persisted sidecar otherwise). Durable resume and generations cover active-project chats; personal and cross-project quick looks get turn-aligned snapshots and `beforeSequence` paging but always answer a `sinceSequence` with a gap snapshot | iOS Work tab |
| Chat roster | Machine-wide all-projects projection of every project's lanes + work sessions grouped by lane — agent chats, their attached shell rows, and standalone CLI (tracked terminal) sessions, live **and** ended — so the mobile Hub renders every project's sessions at once **without activating each project**. Identity-bound chats (including each project's CTO) and all attached descendants are excluded from this ordinary roster; the optional `identityKey` marker lets clients reject stale or legacy leaked rows. `roster_subscribe` (handshake mirrors `chat_subscribe`, with an optional `sinceSeq`) → `roster_snapshot` then incremental `roster_delta` (`changed` upserts whole project entries, `removed` lists dropped `projectId`s). Un-booted projects are read cheaply from disk — each project's `<root>/.ade/ade.db` (read-only, no cr-sqlite / no runtime boot) plus `.ade/cache/chat-sessions/*.json` — so their session status is limited to the last-persisted `idle`/`ended`/`awaiting`; live `running`/`awaiting` fidelity is overlaid only for scopes currently booted on the runtime (booted scopes also overlay PTY liveness so a live standalone CLI session reads `running`). `attentionCount` counts awaiting/failed **chat** rows and their attached shells only — standalone CLI failures never count, so a long-dead CLI exit can't pin a project to the top of the hub. Rows carry `toolType` so the phone routes chat rows to the chat surface and CLI rows to the terminal path. Roster session rows may also carry the normalized fixed-value `activityStatus` report and `activityStatusChangedAt`; this refines the Work card status slot without changing the roster phase or Activity group. Transcripts are excluded from the roster and load on demand after a row tap activates the owning project; the Hub cover exposes switching/hydration progress and an error with Retry instead of silently ignoring an unhydrated project. Oversized snapshots ride the generic `envelope_chunk` path. A host without a roster provider (single-project desktop) simply never answers `roster_subscribe`, so the phone falls back to the active project only | iOS Hub |
| Command routing | Send named actions (`chat.send`, `lanes.create`, `git.push`, `prs.getMobileSnapshot`, `work.listExternalSessions`, `work.getExternalSessionDetail`, `work.importExternalSession`, etc.) | Controller devices |
| Project switching | `project_catalog` + `project_switch_request/result` for multi-project runtimes | iOS project hub |
| Project actions | Runtime-scoped project browser plus open/create/clone/list-GitHub-repos/default-parent-dir/forget envelopes. Available from the active project host or the machine-wide fallback handler before a project is selected | iOS project hub |
| Paired desktop runtime | Full newline-delimited runtime JSON-RPC over `rpc_open` / `rpc_data` / `rpc_close`, plus host-loopback TCP previews over `fwd_open` / `fwd_data` / `fwd_close`, with `fwd_pause` / `fwd_resume` flow control. Same-account adoption or a Nearby PIN pairing obtains the required host grant internally; there is no user-facing Share link. Client-claimed device metadata never authorizes either channel | ADE desktop remote machines |
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

`viewerAllowed: false` is the gate for anything that hands a paired viewer a
credential or lets it mint one. `sync.getWebPairingInfo` and
`sync.getDesktopPairingInfo` return the raw pairing PIN and a ready-to-use
pairing URL, so a viewer could onboard further devices without the owner;
`cto.setLinearToken` / `cto.clearLinearToken` are direct credential-store
writes that accept an arbitrary secret — or wipe the owner's — from whatever
device is on the socket. Paired viewers get the interactive
`*LinearMobileOAuth` pair instead, whose token Linear mints against a
host-issued session. The registry is the gate here, not the absence of client
wiring.

`projectConfig.get` and `projectConfig.save` stay viewer-allowed but redact:
`ai.apiKeys` holds live provider API keys and the top-level `providers` bag is
an unvalidated passthrough that historically carried the same, so reads drop
both and writes keep whatever is already on disk. The write side matters as
much as the read side, because every Settings section saves a get → edit → save
round trip of the whole file — a redacted read fed back verbatim would
otherwise erase the host's keys.

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
| `work.getExternalSessionDetail` | `viewerAllowed: true` | Returns one session's `ExternalSessionDetail` for the phone's import preview: a 120-event page of `events` (mobile-wire compacted, without `resultTruncatedForMobile`), `hasOlder`, and `olderCursor`. Payload: `provider`, `sessionId`, optional `before` (a previous `olderCursor`). `messages` is sent empty whenever `events` is non-empty. |
| `work.importExternalSession` | `viewerAllowed: true`, `queueable: true` | Imports one external session into a lane as either `target: "cli"` (`ExternalSessionImportResult.kind = "cli"`, with `sessionId`/`ptyId` and, when available, persisted `session`) or `target: "chat"` (`kind = "chat"`, with `chatSessionId` and required persisted `chatSummary`). Payload mirrors `ExternalSessionImportArgs` (`provider`, `sessionId`, `laneId`, `target`, `mode`, optional `model`/`permissionMode`). |

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

- **Lane share guests**: a guest of another account reaches only the lane
  the owner shared, through the host's own rights table and default-refuse
  gates. Its account token goes only to the account directory; the host sees
  a one-use ticket bound to the guest's DPoP key. The trust statements are in
  `apps/account-directory/README.md`, "Lane sharing", and the mechanism in
  [lane sharing](../lanes/lane-sharing.md).
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
- **Account bearer transport (plaintext `account`)**: every
  `hello.auth.kind = "account"` is
  accepted only when the socket came from ADE's in-process cloud-relay
  bridge. The tunnel client hands each relay pipe to the listener through
  `acceptRelayPipe`, which only code in the brain process can call, so the
  `relay-bridge` provenance cannot be claimed from the network. (The legacy
  loopback bridge instead attaches a private, per-process 256-bit proof to its
  WebSocket upgrade, which the listener checks with a constant-time
  comparison.) The provenance survives parked-socket host handoffs. A direct
  connection without it fails closed. The
  runtime rejects the plaintext `account` bearer on LAN, tailnet, loopback, and
  every other
  direct route before verifying the bearer, even when that device already has
  a pairing record. Existing devices use `auth.kind = "paired"` with their
  durable per-device secret and pinned DPoP key on direct routes; PIN pairing
  remains available on LAN. This guarantees ADE does not send or accept the
  Clerk account bearer over plaintext direct sync. It does not sender-bind a
  bearer stolen outside ADE: generic bearer replay through a TLS relay remains
  possible until the account session/token is sender-constrained to a device
  key or equivalent platform attestation.
- **Sealed account adoption (`ade-adopt-v1`)**: the account credential can also
  reach a machine over a **direct** LAN/tailnet route — not just the relay —
  without ever exposing the bearer in plaintext, using a sealed handshake keyed
  to the host's published `pubkey`. The client sends `account_challenge` with a
  nonce and an ephemeral X25519 public key; the host replies
  `account_challenge_ok` with its own X25519 ephemeral key and an Ed25519
  signature (from `machineIdentitySigningStore`) over the canonical
  `ade-adopt-v1 | hostDeviceId | nonce | clientEph | hostEph | ts[ | aead]`
  string. The
  client **verifies that signature against the directory-published `pubkey`
  before releasing any credential**, so a machine cannot be impersonated on a
  LAN. Both sides derive the same AEAD session key via HKDF-SHA256 over the
  X25519 shared secret and nonce; the client then sends a `hello` with
  `auth.kind = "account_sealed"` carrying the sealed account attestation, and
  the host returns the minted paired credentials in a sealed `hello_ok`. The
  seal cipher is **negotiated**: the client advertises the AEADs its crypto
  backend supports (`chacha20-poly1305`, `aes-256-gcm`), the host chooses the
  first it also supports, echoes it in `account_challenge_ok`, and **binds the
  chosen AEAD into the signed challenge string** so it cannot be downgraded on
  the wire — this is what lets a packaged Electron whose bundled BoringSSL lacks
  ChaCha20-Poly1305 adopt over `aes-256-gcm` instead of failing. A client whose
  advertised set does not overlap the host's is rejected. Legacy clients that
  omit the AEAD list remain compatible by falling back to
  `chacha20-poly1305`, but their chosen AEAD is not yet signature-bound; the
  host emits a warn-level `sync_host.legacy_adoption_aead_unbound` record so
  the supported-client floor can be measured before that path is disabled. The
  challenge is single-use and TTL-bounded (60 s); it is required before a sealed
  hello is accepted. `ade-adopt-v1` protects the exchanged *credentials* (bearer,
  DPoP proof, minted secret), not the confidentiality of the subsequent session:
  after adopting over a plaintext `ws://` route the ongoing sync stream has the
  same on-path exposure as any other direct paired reconnect. See the client
  connect-flow narrative in
  [Remote Runtime](../remote-runtime/README.md#connect-flow).
- **Pairing**: direct machine-to-machine Nearby and phone QR/Nearby pairing use
  the same user-approved PIN + DPoP flow. The desktop synthesizes its Nearby
  pairing input from discovery; it does not expose a Share link or manual
  address field. Legacy shared bootstrap-token hellos are rejected over Relay.
  New hosted-browser connections instead require account sign-in and adopt a
  directory machine through Relay; only browser environments paired before
  account-only pairing keep their saved local/direct reconnect path. Direct pairing
  uses a **user-set 6-digit PIN** stored as a PBKDF2 hash in
  `~/.ade/secrets/sync-pin.json` on the runtime machine. The runtime never
  auto-rotates or TTLs the PIN; the user manages it from the **This computer** card
  in Connections and clears it when they want to stop accepting new pairings.
  Plaintext is
  process-local and intentionally unrecoverable after restart, so Connections
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
- **Only explicitly account-owned credentials sync.** `.ade/local.secret.yaml`
  and device-only credentials remain per-machine. Account-scoped AI provider
  keys use the `provider_api_key` vault kind, Linear OAuth refresh tokens use
  `linear_refresh_token` with a per-device `refreshOwner` so only one machine
  exchanges the rotating grant. Secrets are Passwords & Secrets items, sealed
  under the account's vault key; a "this computer only" secret never syncs. Local credential stores retain
  provenance and purge account-origin values on sign-out or account switch;
  access tokens, a machine's own GitHub App device-flow sign-in, environment
  GitHub tokens and vendor CLI refresh credentials stay on the machine that
  owns them. A pasted GitHub token and a github.com `gh` login follow the
  account (scope `all`, kind `integration`, keys `github` and `github-cli`).
  The account's GitHub App sign-in lives in the account directory, which
  gives machines short-lived access tokens only.
- **Transport**: WebSocket auth via PIN / paired secret / bootstrap
  token on every connection. Tailscale WireGuard encryption applies
  when over tailnet; LAN connections rely on pairing token validation.
  TLS is not enforced for localhost/LAN; the runtime listens on all
  interfaces (intended for trusted LAN and tailnets).
- **Cloud tunnel relay (account-gated, no user toggle)**: the brain keeps an
  outbound HMAC-authenticated tunnel to the `apps/tunnel-relay` Cloudflare
  Worker so a phone off the
  LAN/tailnet can dial the machine over TLS with zero configuration.
  Phones rank authenticated direct routes LAN → Tailscale ahead of Relay but
  race all of them together, so a stale saved LAN/Tailscale endpoint cannot hold
  Relay off; the whole race is bounded by one 10-second budget. The relay
  pipes WebSocket bytes after terminating TLS. The normal ADE hello / PIN /
  paired-secret / DPoP handshake still runs inside that pipe, but it is not
  end-to-end encrypted: the relay can read paired secrets and runtime/sync
  payloads. Treat the relay operator as trusted for confidentiality. Adding
  end-to-end payload encryption to the relay path is planned security work.
  The host opens and advertises Relay only while its ADE account lease is
  current **and** it holds the machine-wide sync host lease. The relay Durable
  Object keeps one host control socket per `machineKey`, so relay ownership is
  a machine-level singleton, not a per-process capability; a runtime without
  the lease neither dials the relay nor publishes to the directory. Every paired Relay hello — including first-time PIN pairing — must
  also carry a fresh short-lived Clerk token whose subject matches the account
  signed in on the host; the proof is never persisted. Direct LAN/Tailscale
  hellos do not need an account token. Sign-out, account switch, expiry, or a
  refresh failure after the last known lease has expired closes Relay peers and
  removes directory access; a transient refresh exception while that lease is
  current leaves the route intact. The device-bound paired secret remains
  available for direct LAN/Tailscale reconnect regardless of whether it was
  minted after PIN pairing or sealed same-account adoption. A verified
  same-owner account hello with the pinned DPoP key may rotate the paired secret
  so a lost credential-delivery response can be retried safely, and may adopt a
  still-local QR/PIN/SSH record for the same device into the account. That
  adoption is authorized by the DPoP proof against the key already pinned on
  that record plus a verified same-account attestation; a record with no valid
  pinned key, and a record owned by a different account, are both refused. It
  never converts provenance — `localTrustOrigin` keeps the record out of the
  sign-out delete sweep, which demotes it back to local trust instead.
  The `machineKey` is an unguessable 32-hex identifier and the tunnel
  upgrades are HMAC-signed with a per-machine secret. Relay availability
  follows the host's account session: sign-in starts and advertises it, and
  sign-out stops it. The identity file drops the old `enabled` /
  `enabledSetByUser` fields when it is read. The per-computer switch lives in
  its own file (below). The live relay URL is also advertised to
  already-paired phones in `hello_ok` / `brain_status`
  (`cloudRelayWssUrl`), so devices paired before the relay existed learn
  the route without re-scanning a QR. Relay publication is **honest**: the host
  advertises a `relay` endpoint in the account directory only after an
  end-to-end self-probe (`syncRelaySelfProbe`) confirms a controller-shaped dial
  actually round-trips back through its own bridge, and it keeps that route
  live with an application-level `{t:"ping"}`/`{t:"pong"}` control keepalive
  that catches "zombie" controls the Cloudflare edge still answers at the
  transport layer after the Durable Object has died (see
  `syncTunnelClientService.ts`). A control that connects but cannot round-trip,
  or that goes zombie, is torn down and never publishes a relay route.
- **Secret isolation**: each device stores its own pairing secret in
  its OS keychain.
- **One-release trust reset**: the first packaged desktop launch carrying the
  migration removes only old remote-target/pairing/runtime-host grant files and
  confirms a background-service restart before committing its marker. iOS
  removes connection tokens plus machine-scoped profiles/cursors/queued state
  only after Keychain clearing succeeds. Hosted web removes old IndexedDB
  environments and selection once. Account sessions, stable machine/device and
  DPoP identities, pairing PINs, projects, SSH files, analytics choices, and
  unrelated browser state are preserved. New pairings created after each
  marker follow the normal local/account ownership lifetime.
- **Execution isolation**: the ADE runtime runs agents; controllers do not.
- **External local files stay desktop-local.** Files opened in the desktop
  from Finder / OS open-file events or local drag-and-drop are registered as
  `external` workspaces on that desktop process. The sync host filters those
  workspaces out of mobile `listWorkspaces` responses and rejects mobile file
  requests that target them, so pairing a phone does not expose arbitrary
  local folders.

## Per-computer relay switch

Each computer's owner can turn ADE Relay off for that computer from Settings ›
Account (the row's details, behind a warning that names what stops working).
The setting is `sync-relay-preference.json` beside the relay identity file;
absent or unreadable means on, so a damaged file never cuts a computer off.
Off means the tunnel client treats the computer as ineligible
(`isRelayEnabled` → `RELAY_TURNED_OFF_MESSAGE`, control socket and tunnels
closed within a second), the relay URL is never advertised (pairing
info, `hello_ok`, the account directory), and route health reports
`relay.enabled: false, turnedOff: true` so no relay-offline banner fires.
Turning it on dials at once. The tunnel learns of the change, and of account
sign-in and sign-out, from events (`subscribeEligibilityChanges`), and checks
about 300 ms later so that an answer sent over the relay leaves first. The
account-lease poll is a 5 s backstop for what has no event, such as a lease a
token refresh lost. ADE MCP rides the same control socket, so it is off for
that computer too.

The switch is read and changed on the computer it belongs to:
`account.getConnectionRoutes` / `account.setRelayEnabled` through
`account.call` on this computer's brain, and as runtime remote commands for
any other computer, reached by account machine key over its live paired
connection (`accountConnectionRoutes.ts` in desktop main). A computer that is
not connected from here shows what the account directory last published and
cannot be changed until it is.

## Gotchas

### Another program on the sync port's loopback address

macOS and Windows let a second program bind `127.0.0.1:<port>` while ADE holds
`*:<port>`, and that program then gets all local traffic for the port. The
usual offender is `wrangler dev`, whose default port is ADE's 8787. What each
route needs from loopback:

- **Relay:** nothing. Pipes are handed to the host in process.
- **LAN:** nothing. Peers reach the wildcard bind, so the account directory
  publishes LAN whenever the listener is bound (`listenerBound`), not only
  when loopback validates.
- **Tailscale:** everything. Serve forwards to 127.0.0.1, so Tailscale
  publishes only while some local route answers as this listener.

**The public port does not move for a loopback shadow.** A phone that sees its
machine's port change redials (seen on a real iPhone: a Wi-Fi socket dropped
110 ms after a move), so the listener keeps its port and opens a **side door**:
a second server bound on exactly `127.0.0.1:<free port>` (one of the 24 ports
above; never an OS-assigned one, so a stale Tailscale entry left by a crash is
still recognized by its shape, `adeLoopbackForwardPort`), wired like the main
one (`createServerPair`) and validated
with the same identity probe. `getLoopbackPort()` returns it, the validation
status records it as `loopbackPort` (with `shadowedBy`, program name only), and
Tailscale Serve (`--tcp` and the HTTPS route) forwards there while the
tailnet-facing port stays the sync port. The listener re-checks every
`SYNC_LISTENER_SELF_HEAL_INTERVAL_MS` (30 s; one local HTTP request per
address) and on `healNow()`; it records only the final verdict, so a working
side door never flaps Tailscale. When loopback answers as ADE again the side
door closes (its sockets kept until they close). Logs:
`sync_listener.loopback_side_door_opened` / `_closed`. A startup bind on a
wildcard accepts a loopback-shadowed candidate for the same reason.

The port **does** move (`sync_listener.loopback_shadowed_at_runtime`, then
`sync_listener.moved_off_shadowed_port` and `onPortChanged`) only when it has
to: another program answers on one of this machine's own LAN addresses (the
self-check probes each external IPv4 address; only a foreign answer counts,
never a timeout or refusal), a loopback-only bind is shadowed, or the side door
cannot open. Already-connected sockets stay up through any move: the old
server stops accepting but its upgraded sockets are kept. The scope's sync
service (or the projectless brain) updates the lease port, the device row,
Bonjour, Tailscale Serve and the directory. The move back to the preferred
port (normally 8787) once it frees is the hosting scope's sync service's job
(every 15 s while it hosts); with no project host attached, the listener's own
30 s self-check does it. The move back validates its
candidate without touching the live port's status, so it cannot flap the route.
A project host never refuses to start over a shadow
(`sync_host.loopback_shadowed_hosting_degraded`). A loopback-only bind
(`ADE_SYNC_BIND_HOST=127.0.0.1`) has nothing else to serve, so one whose every
candidate is shadowed fails to bind and the startup loop retries.

- **Phone-sync port 8787 is canonical.** Bind order always tries 8787 first,
  even when device-registry `lastPort` is 8788. Zombie reap may terminate a
  same-channel wedged predecessor still holding 8787 (excluding only this
  process pid). A live listener that landed on a fallback keeps probing
  `tryMigrateToPort(8787)` so phones that saved 8787 reconnect without a
  restart. The "ADE is already running with phone sync" dialog is the
  cross-channel case (ADE vs ADE Alpha) and is intentional.

- **Cross-machine session handoff is not database sync or provider-session
  migration.** It publishes the exact Git commit and sends a bounded,
  sanitized capsule to a compatible destination runtime. Provider-native
  thread ids, full transcripts, terminals, artifacts, caches, secrets, and
  dirty worktree data remain on the source. See
  [the handoff contract](./cross-machine-session-handoff.md).

- **The release trust reset is deliberate and non-recurring.** Do not broaden
  it into a general cache/account wipe or rerun it on dev launches. Desktop's
  pending marker exists so a failed service restart is retried without deleting
  newly created pairings again; iOS writes its marker only after connection
  tokens clear; web scopes its version marker to the environment store.

- **A table only leaves `MOBILE_CHANGESET_EXCLUDED_TABLES` territory if the
  phone has another way to get it.** The diet is not "drop what looks big" — it
  is "drop what the phone re-fetches anyway." `pull_request_snapshots` is the
  clearest case: 11.2 MB of a 28.1 MB synced project DB (39.7%), and iOS reads it in
  exactly one query (the per-PR detail behind `fetchPullRequestSnapshot(prId:)`)
  which it populates on demand through `prs.refresh` →
  `replacePullRequestHydration` (the argument-less form carries only open PRs
  and PRs on live lanes, capped at 6 MiB; see `remote-commands.md`). That works for every paired build, however old,
  because `prs.refresh` and `prs.getMobileSnapshot` are both in the **required**
  remote-command set. Lists and badges are unaffected — the slim `pull_requests`
  rows still replicate. Devices paired before an exclusion keep the rows they
  already have (nothing deletes them); they simply stop receiving updates
  through the changeset pump. Excluding a table the phone reads with no
  on-demand path would silently blank a surface, so check the iOS queries and
  the required-command set before adding one. The seven event-log tables added
  alongside the PR cache clear that bar the other way: they have *no* iOS read
  path at all (the only reference anywhere under `apps/ios/` is the
  `DatabaseBootstrap.sql` `create table`), so nothing on the phone can render
  them and there is nothing to re-fetch.

- **The mobile diet is an outbound filter; a local-only conversion is not.**
  They look similar and their failure modes are opposite. Excluding a table
  from `MOBILE_CHANGESET_EXCLUDED_TABLES` only drops rows on the way out to a
  phone — CRR metadata is untouched, existing rows on paired devices are left
  alone, and the peer's ack watermark still advances through the filtered
  versions, so there is no apply hazard for a peer on any build. Moving a table
  into `LOCAL_ONLY_CRR_EXCLUDED_TABLES` changes what cr-sqlite knows about the
  table and *does* have an apply hazard, which is why `applyChanges` skips
  inbound rows for those tables (see
  [the CRDT model](./crdt-model.md#apply)). Do not reason about one from the
  other. Related but independent: whether the host prunes a table is a third,
  orthogonal question — `linear_ingress_events` and `worker_agent_runs` are on
  the mobile-exclusion list yet deliberately never age-pruned on the host.

- **A host-side check does not guard a replicated column.** If the host decides
  a value, a controller writing that same column into its own replica can win
  the merge and undo the decision — the check was never reached. The fix is to
  stop the controller writing it (a local, non-persisted overlay is what buys
  the optimistic feel) and to drop the column from that peer's inbound
  changesets, not to add another host-side check. Both halves are needed: the
  client change fixes new builds, the host filter covers every paired device
  still on an old one. See
  [Host-authoritative columns](#host-authoritative-columns-are-peer-scoped).

- **The wire and the stored transcript share one chat-event compaction policy,
  and the wire runs storage compaction first.** `compactChatEventEnvelopeForSync`
  is an adapter; the policy is `shared/chatEventCompaction.ts`. Two
  implementations with two cap tables is what this replaced, and they drifted:
  the wire only redacted inline images, so a multi-megabyte event went out live
  and came back small after reconnect hydration. Compaction is applied to events
  that are already compacted (hydration, the replay ring), so it must be
  idempotent. Dropping a field from the wire (`tool_result.structured`,
  `toolResultMeta`) is safe without a capability gate only because no client
  decodes it; anything that *adds* or reshapes a wire field still needs one.

- **The runtime owns sync. Desktop is a client.** A desktop window bound
  to a remote runtime is *not* the sync authority for that project; the remote
  runtime is. Code that wants the sync service must reach into the
  runtime IPC bridge, not into the renderer or the Electron main
  process.
- **Relay ownership is machine-wide, so "has a listener" is never the test.**
  Any runtime can bind an ephemeral sync listener — a dev `ade serve`, a
  headless one-shot, an embedded fallback. Only one may dial the relay or
  publish to the account directory, because the relay Durable Object keeps one
  host control socket per `machineKey` and evicts the previous holder with
  close code `4505`. New machine-exclusive subsystems must gate on
  `holdsSyncHostSingleton()` (through `relayTunnelAuthorityGate` or the same
  authority subscription), and must tolerate the momentary `false` that a
  project switch produces by riding it out for
  `SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS` rather than reacting on the edge.
- **A project is not a precondition for anything machine-level.** Hosting phone
  sync, publishing to the account directory, and dialing the relay all gate on
  the sync-host lease plus a bound shared listener — never on an open or
  registered project. Copy that tells a user to open a project in order to link
  or publish a machine is wrong, and per-state advice belongs in
  `describeUnpublishedAccountDirectory` rather than in each surface.
- **`ADE_ENABLE_DESKTOP_SYNC_HOST` is a diagnostics escape hatch.** If
  you turn it on, both an in-process host and the standing runtime can be
  alive simultaneously on the same machine — that's intentional for
  comparing behaviors, but production builds should never run with
  that flag set. A packaged build drops the in-process project runtime from
  main, so the flag only works from a dev build; set it there.
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
  Revocation works per paired device from the appropriate **Connections** tab.
- **The pairing PIN is user-managed, not ADE-managed.** There is no
  expiry and no rotation. A machine that leaves the PIN set is
  perpetually pairable by anyone on the network who knows the digits
  (subject to the per-IP rate limiter). Clearing the PIN from the **This computer**
  card in Connections is how you stop accepting new direct pairings;
  already-paired
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
- **Controller command queues replay on reconnect, but an attempted live chat
  send is ambiguity-sensitive.** If the runtime advertises `chat.send` as
  queueable and the user submits while already offline, iOS stores the command
  locally and replays it with the same `commandId`. After a live `chat.send` was
  attempted, however, a timeout or transport loss does not prove that the host
  failed to start the turn. iOS therefore does not queue or resend that message:
  it restores the draft and asks the user to check the transcript before a
  manual retry. Do not assume synchronous semantics from the phone side.

### Machine inventory

The Accounts page shows a token-free provider inventory summary on each machine
row. The 30-second account-directory heartbeat carries provider account and
model counts plus the number of saved harness presets. Expanding a row fetches
the live account labels, optional email and plan, and preset bindings through
`account.getMachineInventory`.

Live detail is requested only for an online machine that is already paired and
connected; expanding a row never creates a pairing. Reads are capped at twelve
machines and rate-limited to one attempt per machine every 30 seconds. Offline
rows keep their heartbeat counts and say “Details unavailable while offline.”
Older runtimes that do not implement the command are reported as an update
compatibility issue, while authorization failures remain ordinary access
errors. Inventory payloads exclude config-home paths, executable paths, and
credentials.
