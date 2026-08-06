# Sync and Multi-Device

ADE syncs live runtime state across an ADE machine runtime and any connected
controllers (other computers, iPhones) using **cr-sqlite** as a CRDT-backed
replication layer over a **WebSocket** transport. The design is local-first:
eligible routes are preferred in **LAN → Tailscale → Relay** order for
desktop-to-runtime, ADE Code, and iOS connections. The account-gated cloud
tunnel relay is an always-eligible byte transport whenever the machine is
signed in to an ADE account; there is no separate relay toggle. Two
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
- `cross-machine-session-handoff.md` — the clean/published Git contract,
  bounded context capsule, destination setup, route confirmation, and
  idempotent recovery used by **Send to machine**.
- `push-notifications.md` — Activity's account-wide source of truth and
  its APNs + Live Activity pipeline: machine publishers, the Cloudflare
  consolidation relay, desktop/web/ADE Code/iOS reads, native Mac presentation,
  per-device policy, exact routing, acknowledgments, and ownership fences.

Web client: the browser client is another controller of the same machine
runtime. New hosted connections are account-only: the browser signs in, chooses
a same-account machine from the directory, and receives DPoP-bound paired
credentials through Relay. It does not keep a local SQLite replica; it uses
changeset batches as invalidation signals and refreshes state through remote
commands, file requests, and chat/terminal streams. Browser environments paired
before this release can still reconnect over their saved local/direct routes,
but the hosted client no longer creates non-account pairings.

Account Activity deliberately does **not** follow that selected machine or
project binding. Every signed-in brain publishes all of its active projects to
the account relay, while signed-in desktop, hosted web, ADE Code, and iOS read
the consolidated account stream through an account-scoped path. Navigation and
actions still carry the owning machine/project/session so the client can adopt
or select the correct destination. Without an account, a client may show only a
truthfully labeled local or explicitly connected-machine snapshot; it must
never present that subset as the account view.

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

Windows x64 can own the same machine sync authority as macOS/Linux. It uses a
per-user/channel named pipe for local RPC and the packaged
`vendor/crsqlite/win32-x64/crsqlite.dll` for CRR replication. The typed
`crdtSyncAvailable` status prevents pairing when the extension is unavailable;
Connections surfaces the failure with reinstall/restart guidance. Native
macOS computer use and iOS Simulator are separate capabilities and do not gate
Windows phone pairing, App Control, browser control, or proof ingestion.

### The machine-wide sync host lease

Hosting phone sync is exclusive per machine, and that exclusivity is a real
lease, not a convention. `syncHostSingleton.ts` owns an advisory lock file at
`$TMPDIR/ade-sync-host-<uid>.json` (override: `ADE_SYNC_HOST_LOCK_PATH`)
recording the owning pid, channel, project root, and bound port. A project
scope acquires it when its sync service starts; a projectless brain that binds
the shared listener with no active scope acquires a `projectRoot: null` lease
of its own and drops it the moment a scope takes over, so the lock file always
names the real owner.

The lease is also the answer to *"is it me?"* for every other machine-exclusive
subsystem. Two of them gate on holding it:

- **the relay tunnel** (`syncTunnelClientService`), because the relay Durable
  Object keeps exactly one host control socket per `machineKey` and evicts the
  previous holder with close code `4505`; and
- **the account-directory publisher** (`accountMachinePublisherService`),
  because publishing endpoints means "reach me here", and a runtime that does
  not host sync would be pointing controllers at nothing.

Holding a *listener* is not sufficient for either — a dev `ade serve`, a
headless one-shot, or an embedded fallback can bind an ephemeral listener
without ever winning the lease. `holdsSyncHostSingleton()` reports current
process authority and `onSyncHostSingletonAuthorityChanged()` publishes
transitions (none-held → held and held → none-held only), because the lease is
acquired well after process start and can be released again.

Authority transitions are debounced by
`SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS` (5 s) on the *loss* edge.
`ProjectScopeRegistry.performSyncHostSwitch` deactivates the outgoing sync host
before activating the target, so within one brain authority legitimately reads
false for the width of a project switch. A real loss of authority outlives that
window; a handoff never does. Without the grace, every project switch would
stop and restart the machine's relay tunnel and tear down and rebuild the
directory publisher (`ade doctor` would report "Account-directory publishing
has not started" in the gap).

### Hosting sync, and publishing, with no project

A project is not a precondition for anything machine-level. A brain that holds
the lease and has the shared listener bound hosts phone sync, publishes itself
to the account directory, and dials the relay with nothing in
`~/.ade/projects.json`. That is the normal state of a headless box and of any
machine between the installer finishing and the user opening their first
repository.

`projectlessSyncSnapshot.ts` builds the `SyncRoleSnapshot` for that state.
Hosting is the lease **and** a bound port: a runtime that bound a listener
without winning the lease is not the machine's sync host and reports the honest
all-down shape (`buildDegradedProjectlessSyncSnapshot`) instead of claiming a
host that does not exist. When it is hosting, the snapshot carries the real
listener port, the machine identity read from `~/.ade/secrets/sync-device-id` /
`sync-site-id`, real `pairingConnectInfo`, and real relay route health.

Those last two fields are why this matters beyond diagnostics. The
account-directory publisher gates on `listenerBound` and `pairingConnectInfo`,
so a projectless brain fed a hardcoded all-down placeholder could never publish
itself — a signed-in machine with an empty project registry simply never
appeared in the user's account, and `ade doctor` reported it unreachable while
it was serving phones fine. `runServe`'s publisher `getSnapshot` now falls back
to the projectless builder whenever this brain holds the lease, and returns null
only when it genuinely does not.

Two consequences follow for copy anywhere in the product:

- **"Open a project" is never the fix for an unpublished machine.** It was
  before; it is not now. The `no_active_sync_scope` publisher state is now only
  reachable when *another* ADE process on this computer holds the machine-wide
  lease — and that process is the one publishing the machine. Telling the user
  to open a project would hand them an action that cannot change anything. The
  per-state advice lives in one table,
  `describeUnpublishedAccountDirectory` in `apps/desktop/src/shared/types/sync.ts`.
- **A projectless brain still has no project-scoped state to report.** The
  runtime name and Tailscale Serve publication belong to a project scope, so the
  snapshot reports them absent rather than inventing them (the tailnet row reads
  "Open a project to publish this machine on your tailnet."). The pairing PIN is
  *not* in that category: it is the only nearby-pairing path a projectless
  machine has, so the snapshot reports its real state from the same
  machine-level store the ingress handler verifies against, and the plaintext
  PIN plus the machine bootstrap token are exposed under the same
  `hosting` gate the scoped host applies. Hardcoding "no PIN" here is what made
  a fresh install look unpairable even after one had been set. Publication to
  the account directory still does not require a pairing PIN: account
  membership is the auth path, and the PIN is the fallback for nearby devices
  that are not signed in.

The relay half is symmetric. `createAdeRuntime` builds the relay tunnel per
project scope, so with no scope nothing dialed it and such a machine was
LAN-only. `machineRelayTunnel.ts` is now the one construction both paths use;
`runServe` builds it lazily on the same event that takes the projectless lease.
Relay is an extra route, never a precondition for hosting sync, so a failure to
build it is logged (`sync.projectless_relay_start_failed`) and startup
continues.

#### One ingress implementation, two ingress paths

A projectless machine and a project-scoped machine accept the *same* clients,
so the handshake they run is one implementation with options, not two similar
ones. Two shared modules replaced the copies that used to drift within a
release:

- `syncHelloProtocol.ts` — the one parser for `hello` and `pairing_request`.
  The brain's fallback handler previously carried a narrower hand-rolled copy
  that understood only `bootstrap` and `paired` auth, so every newer auth shape
  (the web client's `account` hello, the desktop's `account_sealed` adoption)
  was answered with a flat "Invalid hello payload." on exactly the machine those
  clients are meant to reach. The copy also dropped `connectionAttempt`, leaving
  route arbitration blind on that path.
- `syncAccountHelloAuth.ts` — the account-hello gate chain (attestation,
  same-account check, device-key validity, pairing mint/rotate, commit-lock
  discipline) plus the canonical rejection messages. The real differences are
  options: the brain has no connection arbitration and no sealed adoption, so it
  leaves those options unset. Everything else — gate order, strings, codes — is
  shared, which is what stopped the two ingresses from returning different codes
  for the same cause.

`brainMachineSyncStores.ts` is the matching state half: the machine-level PIN,
pairing, and security stores, created once per secrets directory and handed to
every surface. Pairing identity belongs to the machine, not the caller, so the
ingress handler and the RPC surface must hold the same instances — a PIN
generated over RPC is only live immediately if the socket that verifies it reads
the same in-memory store. The map key is `pathKey(resolvedDir)` so a Windows
path spelled `C:\Users\…` and `\\?\C:\Users\…` cannot hand out two store sets
for one directory.

#### `sync.*` on a machine with no project

Every `sync.*` RPC method used to resolve a project-scoped sync service and fail
with "Sync service is not available. Register a project first." A machine that
had never opened a project therefore could not set its pairing PIN — so it could
not be paired at all, despite hosting sync perfectly well. `ade sync pin
generate` and the desktop's `ade.sync.setPin` both hit that wall.

`multiProjectRpcServer.ts` now routes those methods through `withSyncService`:
the project-scoped service when one owns sync, otherwise the
`ProjectlessSyncControls` the brain injects (`createProjectlessSyncControls`,
backed by `brainMachineSyncStores`). A handler built *without* controls (tests,
embedded runtimes) still fails loudly with the old error rather than pretending
to host.

Only the methods a bare machine can honestly answer have a fallback:
`sync.getPin` / `setPin` / `generatePin` / `clearPin`, `sync.forgetDevice`,
`sync.getRequireDpop` / `setRequireDpop`, and `sync.getCloudRelayStatus`. The
rest answer with the honest empty shape rather than an error:
`sync.refreshDiscovery` returns the machine snapshot as-is (there is no
project-published discovery to re-run), `sync.listDevices` returns an empty list
(the machine pairing file is keyed by device id with no listing API, and the
runtime state that fills that list is a project's device registry), and
`sync.getRuntimeName` returns `null` because a runtime name is a per-project
setting. Mutating project-scoped methods (`sync.setRuntimeName`,
`sync.updateLocalDevice`, transfer readiness, lane presence) keep failing with
the register-a-project error, which is the truth for them. A
just-written PIN is echoed back on the returned snapshot by
`machineSyncStatusWithPin`, because a store only reports a plaintext code it set
itself and the snapshot builder may read through a different handle — without
it, setting a PIN returned a snapshot claiming there wasn't one.

Relay status is likewise one projection: `buildSyncCloudRelayStatus` in
`syncCloudRelayStore.ts`, used by both the scoped and machine paths so the
desktop and the CLI cannot tell two different relay stories about one machine.
Its `accountSignedIn` gate is *ownership*, not usability — see
[remote runtime → Account state and reachability](../remote-runtime/README.md#account-state-and-reachability).

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
  (`device_type: "browser"`). Adopts a same-account machine through the
  directory and Relay, then reconnects with a per-device secret + WebCrypto
  DPoP. It keeps **no** local SQLite replica: it treats changeset batches as
  invalidation signals and reads through remote commands, file requests, and
  chat/terminal streams. Its workspace Hub may retain catalogs and open project
  bindings for many machines, but a four-client pool bounds live WebSockets;
  least-recently-used non-active machines become Parked and reconnect on
  demand. Saved pre-release local pairings remain a reconnect compatibility
  path. See `../web-client/README.md`.
- **Cluster state** — a singleton `sync_cluster_state` row with
  the legacy columns `brain_device_id` and `brain_epoch` tracks which
  device currently owns execution within a cluster.

The older terms "brain" and "host" still appear in code, schema, and
protocol types. In the current product vocabulary, they refer to the
same thing: the runtime that is the current **sync authority**.

## Connection route policy

Every native paired controller ranks routes the same way:

1. current LAN endpoints;
2. current Tailscale/tailnet endpoints;
3. ADE Relay, only with a fresh matching account proof.

Within the LAN and tailnet tiers, current discovery outranks stale saved
metadata and recent successful endpoints break ties. ADE Code and the desktop
paired-runtime pool walk that ranking as sequential phases through
`buildPairedEndpointCandidates`. iOS races the whole ranked plan at once
instead: the same preference decides who is dialed first, but a Relay candidate
joins the race a few hundred milliseconds behind the leading direct candidate
rather than waiting for every direct route to exhaust, and is dialed
immediately when it leads the ranking — which it does when it is the proven
route for the network the phone is on. iOS also keeps per-network route memory
and per-endpoint failure memory; see *Route ranking, route memory, and roaming*
in `ios-companion.md`. First-time same-account adoption also
uses LAN → tailnet → Relay when the directory row contains a verifiable host
signing key, because the `ade-adopt-v1` sealed challenge protects the account
credential on direct routes. An unsigned legacy directory host is Relay-only;
ADE never sends a plaintext account bearer to an unverified LAN/tailnet peer.

The hosted HTTPS web client applies the same ranking to routes the browser may
legally dial, but browsers cannot open insecure `ws://` LAN/Tailscale sockets
from `https://app.ade-app.dev`. In production that eligibility filter normally
leaves Relay only; local HTTP development and previously verified secure
direct endpoints can exercise the direct phases.

Successful and failed native paired-runtime connects retain one random
correlation id plus at most eight privacy-safe ordered attempts. An attempt
contains route kind, host + optional port, start time, duration, outcome, and a
coarse failure class; paths, query strings, tokens, pairing secrets, and raw
error text are excluded. The same correlation id is forwarded on Relay dials
and appears in tunnel lifecycle logs. Account-directory list/register/delete
requests send `X-ADE-Correlation-ID`; the Worker validates or replaces it,
returns it on every response, exposes it to the trusted web origin, and writes
one structured completion record with route, method, status class, and
duration.

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

Alongside the required set the file keeps an **optional** list
(`MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS`) for additive commands newer
phones feature-detect but that older mobile builds never call — so their absence
must not put a host in `limited`. The four Linear connection commands
(`cto.startLinearMobileOAuth`, `cto.completeLinearMobileOAuth`,
`cto.setLinearToken`, `cto.clearLinearToken`) that let the phone connect,
reconnect, and disconnect Linear are optional: a brain that predates them simply
doesn't advertise them, and the iOS Linear pane hides those affordances locally
instead of erroring. `cto.getAttention` — the read-only probe behind the phone's
CTO tab badge, needed because the CTO chat is excluded from every session roster
and cannot be derived from the chat list — is optional on the same logic: the
phone feature-detects it and otherwise leaves the badge dark, and requiring it
would flip every already-shipped brain into `limited` mode. The
session-lifecycle commands
(`session.settleSessions`, `session.unsettleSessions`,
`session.setSettleOverride`, `session.snoozeSession`, `session.wakeSession`,
`session.clearWokeMarker`) are optional for the same reason: the phone
feature-detects them before showing settle and snooze controls, while an older
mobile build that never calls them must not push a newer host into `limited`.
See `remote-commands.md` and `../linear-integration/README.md`.

## What syncs, what does not

| Data category | Sync mechanism | Devices |
|---|---|---|
| Replicated ADE runtime tables in `.ade/ade.db` | cr-sqlite CRRs over WebSocket | All connected devices |
| Source code files | `git push`/`git pull` | Desktop peers only |
| Shared ADE scaffold/config (`.ade/.gitignore`, `.ade/ade.yaml`, human-authored templates/skills, repo-backed workflow YAML under `.ade/workflows/linear/**`) | Git | Desktop peers only |
| Local overrides (`.ade/local.yaml`, `.ade/local.secret.yaml`) | **Never syncs** | Machine-specific |
| Worktrees, PTY processes, caches, transcripts, artifacts, sockets, secrets, connection drafts | **Never syncs** | Machine-specific |
| Product-analytics installation IDs, consent, budgets/deduplication state, and the local `usage_events` export ledger | **Never syncs** | Machine/browser/iOS-client specific; paired-client consent is socket-scoped |
| Cross-machine Work chat continuation | Explicit Git publication + bounded handoff capsule over a connected machine runtime; not CRDT replication | Connected ADE desktops |
| Personal chat summaries/transcripts/attachments | Runtime commands + `chatScope: "personal"` transcript stream; not active-project CRR changesets | Controllers connected to the owning machine brain |

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
│   - negotiated deflate+base64 above 512 B; no offer keeps the    │
│     exact legacy encoder (gzip at 4 KB, or web JSON)             │
│   - decode capped at 25 MB; reassembly capped and expires at 30 s│
│   - encoded envelopes >720 KB sliced bidirectionally after the   │
│     host confirms the peer's "chunkedEnvelopes" capability       │
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

- `apps/ade-cli/src/services/account/accountAuthService.ts` and
  `accountAttestationVerifier.ts` — the shared desktop/runtime Clerk session
  and Relay-token verifier. Access tokens are used only while their signed
  expiry is current; callers can force one refresh after an authenticated
  service returns 401. Refresh-token rotation is cross-process safe: an
  `invalid_grant` briefly waits for a desktop/runtime peer to publish its
  rotated replacement, and stale credentials are compare-and-deleted only
  when the store can prove that no peer replaced them. A successful rotation
  is persisted before best-effort userinfo enrichment, and subject changes
  across the old token, new token, or userinfo fail closed. Attestation errors
  distinguish expired tokens and temporary verifier/JWKS outages from account
  mismatch, invalid tokens, and configuration failures so lease owners retry
  only transient failures. The device-authorization flow also carries this
  machine's key to the directory and, on completion, keeps the single-use
  pairing grant the directory minted — in memory only, with a 10-minute TTL, read
  once through `consumePairingGrant` and cleared on sign-out. That grant is the
  proof a removed machine needs to re-pair, which is why the desktop's Reconnect
  affordance and `ade machines reconnect` both run the device flow rather than
  the loopback PKCE flow. A definitively rejected grant is **marked dead, not
  deleted** (`rejectedAt` / `needsReauth` / `rejectedReason` on the stored
  record) and `sessionState` reports `active | signed_out | expired |
  unreadable` so every surface can say which it is; see
  [onboarding and settings → Account session state](../onboarding-and-settings/README.md#account-session-state-is-a-tri-state-not-a-boolean).
- `apps/ade-cli/src/services/account/accountSessionRotationJournal.ts` — the
  crash-safe journal that makes a rotating refresh grant recoverable. The
  identity provider consumes the old grant the instant the exchange is accepted,
  but the replacement is only durable once written back; a crash inside that
  window burns the token family and the next refresh gets a perfectly truthful
  `invalid_grant` indistinguishable from a revoked session. The journal records
  that an exchange *started* against a specific token generation and is cleared
  once the replacement is durable, so a surviving entry means "the stored token
  may already have been consumed" and the following `invalid_grant` is not
  definitive. It is stored as `account.session.rotation.v1`, a sibling of the
  session record, and is deliberately kept in the same file-backed credential
  bucket — migrating it into the Electron-only store would hide an interrupted
  desktop rotation from the brain and the CLI, which is exactly the process pair
  it exists to coordinate.
- `apps/ade-cli/src/services/account/accountMachineDirectoryService.ts` —
  account-machine list/delete/rename/adoption for ADE Code and the runtime.
  Rename writes the account-owned `customName` field without changing the
  hostname reported by publisher heartbeats; clearing the custom name restores
  the reported hostname as the display fallback. Directory 401 responses
  trigger one forced token refresh and exact request retry; a final 401/403 is
  `auth_expired`, while transport/server failures remain `unavailable`.
  Adoption fences persistence against the captured account owner and session
  generation before and after pairing, rolling back a newly written
  account-owned credential if sign-out or an account switch wins the race. The
  directory's `online` field is a short presence lease, not a transport verdict:
  a machine with a verified secure Relay endpoint remains connectable after
  that presence bit expires. Every HTTP operation carries one bounded
  correlation id across the initial request and its one auth-refresh retry, so
  a user-visible failure can be joined to the Worker's structured lifecycle
  record without logging an account token or response body. Removal is terminal:
  the directory records a revocation before deleting the machine row and then
  asks the relay to purge that machine's Activity, and a failed purge surfaces as
  a typed `AccountMachineActivityPurgeError` (`machineRemoved: true`) rather than
  a clean success. Getting back on requires `machinePairingRepair.ts` and proof
  of a fresh interactive sign-in — see `push-notifications.md`.
- `apps/desktop/src/renderer/webclient/workspace/WebMachineSessionManager.ts`
  and `workspace/webWorkspaceModel.ts` — hosted-browser directory/session
  projection. `mergeWebMachines` merges account rows with browser-saved
  environments and cached catalogs into one row per physical machine, rendered
  by `WebConnectionsChip.tsx` (the top-bar popover that replaced the Hub page),
  while the manager serializes admission into a four-client pool, reports
  Live/Reconnecting/Parked/Offline, retains parked catalogs, and reconnects a
  parked machine when its project or Chats surface is selected.
- `apps/desktop/src/renderer/webclient/adapter/federated.ts` — maps the shared
  renderer's remote-runtime and project APIs onto that pool. Workspace state is
  persisted per account; each project-scoped adapter is keyed by machine +
  project so delayed bound operations cannot cross a runtime switch.
- `apps/ade-cli/src/services/account/accountMachinePublisherService.ts` — the
  single machine-brain publisher for the account directory. It derives the
  stable machine key from the cloud-relay store, publishes only currently
  validated LAN/Tailscale/relay routes, coalesces overlapping work, and sends
  the account bearer only to the trusted HTTPS directory origin. `runServe`
  constructs and starts it only while the brain holds the machine-wide sync
  host lease, and disposes it after authority has been lost for longer than
  `SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS` (a project switch never qualifies);
  the publisher cannot be restarted after dispose, so a later lease acquisition
  builds a fresh one. A second brain publishing its own endpoints would point
  phones at a runtime that does not host sync. Its snapshot source is the active
  project scope's `syncService.getStatus()` when there is one and
  `buildProjectlessSyncSnapshot` when there is not, so a machine with an empty
  project registry publishes on the same terms as any other — see *Hosting sync,
  and publishing, with no project*. It reports `no_active_sync_scope` only when
  this brain does not hold the lease at all. The published
  machine `name` is suffixed by package channel (`publishedMachineName`): a Beta
  build advertises `<name> · Beta` and an Alpha build `<name> · Alpha`, while a
  stable build (or an already-suffixed name) is left untouched, so the same
  physical computer running two channels shows as two distinguishable directory rows.
  A LAN endpoint is only emitted for an address candidate whose `kind` is `lan`;
  because `syncPairingConnectInfo.buildAddressCandidates` now classifies the
  saved `lastHost` as `lan`/`tailscale` when it matches the current address set
  (instead of the opaque `saved` kind that was silently dropped from the
  directory), a machine's LAN routes publish correctly. Each row also carries
  the machine's long-lived Ed25519 identity key as `pubkey`
  (`ed25519:<base64>`, from `machineIdentitySigningStore`); the publisher fails
  the publication closed (`machine_key_unavailable`) rather than advertise a
  row with a missing key, because that key is what a client verifies before
  trusting a sealed `ade-adopt-v1` adoption over a non-relay route (see
  *Sealed account adoption* in the Security model). The `relay` endpoint is
  gated on `routeHealth.relay.relayBridgeValidated`, which the tunnel client now
  sets proactively (see `syncTunnelClientService.ts`), **and** on the tunnel
  client's end-to-end verdict — a present `relayEndToEndVerifiedAt` with no
  `relayEndToEndFailure` — so a control that connects but cannot actually
  round-trip through the relay never publishes a `relay` endpoint. A verified
  route can be retained across a transient drop, but a route with a live
  end-to-end failure is never retained. The relay route therefore appears
  in the directory without waiting for an external client to open the first
  tunnel. A 30-second heartbeat keeps the Worker row inside its 90-second online
  window. Failed publications retry after 1, 2, 5, 10, then 20 seconds so a
  short outage normally recovers within the lease, and a 401 forces one token
  refresh before the publication is classified as expired. These operational
  retries and status polls are local logs, not product analytics. Two failure
  *episodes* are the exception, and both go through
  `apps/ade-cli/src/services/account/episodeAnalytics.ts` — a shared
  edge-triggered helper that emits at most one event while a condition holds and
  re-arms only once it clears, with a 24-hour deduplication window on top.
  `ade_publish_failing` covers a publication that has been failing for at least
  two minutes; `ade_account_session_unreadable` covers the brain being unable to
  read the account session at all (`sessionReadState === "unreadable"`, or a
  status read that threw), carrying only a coarse `code` for the read path
  (`decrypt_failure`, `no_os_key_material`, `store_format`, `session_parse`,
  `read_error`, `unknown`) that `accountAuthService.getSessionReadFailureReason()`
  supplies. See [logging](../../logging.md).
  Successful account sign-in also requests an immediate publish; the brain
  observes both its local auth event and cross-process credential-file changes
  from desktop sign-in. Separately, a lightweight 2-second observer computes a
  signature for the publish-relevant relay control/bridge state and reachable
  endpoints. Its first valid snapshot and every later change trigger a
  coalesced publish, so a
  newly validated or lost relay route reaches the directory without waiting for
  the heartbeat. A triggered write becomes the new heartbeat anchor rather than
  causing a duplicate write at the old deadline. A confirmed Relay
  identity-conflict recovery also requests
  another publish as soon as the replacement control route validates. Every
  publication re-reads the active sync snapshot and token so a brain started
  before sign-in still recovers. The last typed
  publisher outcome is exposed as `routeHealth.accountDirectory` in
  `sync.getStatus`, `ade sync status`, and the desktop This computer card, including
  the selected directory origin, HTTP status, bounded classified HTTP reason,
  timestamps, and reachable-route count. A non-success response contributes
  `lastHttpReason` and the same reason in `skipReason`; the parser consumes at
  most 512 bytes, accepts the Worker's fixed JSON `error` / `message` field (or
  short plain text), strips control/extra whitespace, and never logs or embeds
  the account bearer. The publisher and desktop account bridge derive the
  official directory from the same project-aware Clerk issuer resolver, while
  the machine-owned `ADE_ACCOUNT_DIRECTORY_URL` override remains fail-closed
  behind the trusted-origin parser. In a packaged runtime, an explicit override
  of that publisher URL to ADE's development directory is ignored and resolves
  to the production directory instead. This follows the same atomic packaged
  Clerk policy as OAuth and attestation resolution: the distributed CLI/brain
  and Electron entry points set `ADE_RUNTIME_PACKAGED=1`; development Clerk
  hosts cannot produce a mixed development/production configuration;
  persisted or environment-provided credentials pinned to a development
  issuer/client (including an access-token development `iss` claim) are rejected
  before refresh or publication; rejected environment credentials are treated
  as absent so they do not block a production login; persisted development
  sessions are compare-and-deleted only when the store supports an atomic
  update, followed by one re-read that can surface a peer-written production
  replacement in the same status call; stores without that primitive leave the
  value untouched but continue to report it as signed out; and
  `ADE_ALLOW_DEVELOPMENT_CLERK=1` is the explicit controlled-testing escape
  hatch. Source-checkout runtimes and non-development custom issuers keep their
  existing override behavior.
- `apps/ade-cli/src/services/credentials/credentialStore.ts` — the per-machine
  credential store behind the account session. Two implementations share one
  interface. `EncryptedFileCredentialStore` owns the AES-GCM
  `.ade/secrets/credentials.json.enc` file that the brain, the `ade` CLI, and
  the desktop app all read; `ElectronSafeStorageCredentialStore` owns the
  Electron-only `credentials.safe.enc`. Because the brain cannot read a
  safeStorage file, `FILE_BACKED_CREDENTIAL_KEYS` (`account.session.v1`,
  `sync.bootstrapToken.v1`) are pinned to the file store: the safeStorage
  migration copies everything *else* across, retains those keys in the file
  store, prunes the now-duplicated migrated keys out of it, and keeps
  `.machine-key` alive; only a legacy store with nothing retained is deleted.
  `setSync`/`updateSync` on the safeStorage store throw if a caller tries to
  write one of those keys back into the Electron-only file — otherwise a
  machine whose app is signed in silently signs its brain out. A legacy store
  that reads back `unreadable` aborts the migration outright rather than
  migrating an empty view of it and then deleting the ciphertext and machine
  key. Reads try the OS-bound key first and the bare machine key second (a
  second-candidate hit is genuine legacy ciphertext and is rewritten); if
  neither works, the store self-heals once per 30 s by dropping the cached OS
  key material and retrying against a fresh read, then reports
  `getLastReadState() === "unreadable"` with a coarse
  `getLastReadFailureReason()` of `decrypt_failure`, `no_os_key_material`, or
  `store_format`. It never writes an empty store over ciphertext it could not
  decrypt.
- `apps/ade-cli/src/services/credentials/osBoundKeyMaterial.ts` — everything
  about obtaining the machine-local secret the file store's key is derived
  from: the `security` invocations, the process-wide cache, the negative-cache
  backoff, and the create race. Resolution is race-safe and non-destructive.
  `add-generic-password` runs **without** `-U`, so a process that loses the
  create race adopts the winner's item instead of clobbering it, and any
  inconclusive `security` result (timeout, locked keychain, denied access) fails
  closed rather than minting a replacement — two first-run processes each
  minting their own secret is exactly what made one of them unable to decrypt
  what the other wrote. The synchronous path may create the item; the
  asynchronous path is read-only and never participates in the race. The two
  paths use different backoffs: the read-only path backs off on any miss, while
  the creating path backs off only when the keychain was *unavailable*, so a
  `not_found` miss can never starve first-run item creation.
- `apps/account-directory/src/directory.ts` — the Clerk-scoped machine
  register/list/delete Worker routes. Machine listing selects the owner's 500
  most recently seen rows before computing online-first order and exposes
  separate authentication and D1 durations through `Server-Timing`; the
  trusted web-client CORS response exposes that header. Every request also
  receives a validated/generated `X-ADE-Correlation-ID`, echoed on the
  response and included in one privacy-safe structured completion log; trusted
  web CORS exposes the id and allows the request header.
- `apps/desktop/src/shared/accountDirectory.ts` — canonical account-directory
  origin, bounded success/error response decoding, route allowlisting, machine
  selection, and paired endpoint validation shared by desktop, the brain, ADE
  Code, and hosted web. List calls can force-refresh once after a 401; a final
  401/403 becomes `auth_expired` with the Worker's short fixed reason preserved
  for CLI and desktop diagnostics, while oversized or unrecognized bodies fall
  back to the generic session-expired message. `accountMachineConnectionState`
  reports `available` whenever a directory-verified secure endpoint exists,
  even if the short-lived `online` heartbeat expired; only a row with no
  dialable endpoint is `offline`/`unreachable`.

- `apps/ade-cli/src/eventBuffer.ts` — bounded runtime-event replay buffer
  used by multi-project RPC and desktop/TUI event streams. Retains up to
  10,000 events / 16 MB total / 1 MB per event by default, emits live
  subscribers best-effort even for oversize events, and returns
  `eventEpoch`, `gap`, and `oldestCursor` from `drain()` so clients can
  reset stale cursors when a daemon restarts or history was evicted.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — machine-level JSON-RPC
  surface for `projects.*`, `sync.*` (including `sync.runSelfProbe`, which
  resolves the active sync host and runs the tunnel client's relay end-to-end
  probe, or returns a skipped verdict when no host is active),
  `runtimeEvents.*`, project-scoped
  `ade/actions/call`, and project-independent `personalChats.call` /
  `personalChats.streamEvents`. `sync.getStatus` with no active scope answers
  from the injected `getProjectlessSyncSnapshot` — the brain passes the real
  builder, and a process that has none falls back to
  `buildDegradedProjectlessSyncSnapshot` — rather than the fixed all-down
  literal it used to return, which misreported a hosting brain as unreachable
  to `ade doctor` and to the account-directory publisher.
  Runtime-event subscribe replies include the gap
  fields above; `projects.list` resolves at most 24 host-side icons within
  750 ms, with 128 KiB per-icon and 512 KiB aggregate wire caps, so large
  project registries cannot stall remote desktop or mobile catalog setup just
  to inline artwork.
  `projects.getHandoffStoragePreflight` checks the destination parent path,
  write access, target collision, free space, and destination-local Git access
  before the desktop offers to clone a missing handoff repository. `projects.add`
  / `create` / `clone` and the new `projects.setCatalogVisibility` accept a
  registration intent (`catalogVisibility: "recent" | "system"` +
  `registrationSource`) so the caller declares whether a project should show in
  the phone catalog and roster; unspecified callers default to
  `SYSTEM_PROJECT_REGISTRATION`. The registry file (`projectRegistry.ts`) is now
  **version 2** — records carry `catalogVisibility` and `registrationSource`,
  and a one-time v1→v2 upgrade seeds `"recent"` for roots that match the
  desktop's recent-project list (passed in as `legacyRecentProjectRoots`) or are
  an existing Git checkout, marking everything else `"system"`; `add()` upgrades
  a `"system"` row to `"recent"` on an explicit recent registration but never
  demotes. Desktop local-runtime action routing uses that default registration
  only to obtain a project id: an already-cached registration for the same root
  satisfies the default request, so routine PTY/file actions after a project
  switch cannot overwrite an explicit recent/desktop registration with
  `system` / `runtime-auto` metadata.
- `apps/ade-cli/src/services/personalChats/personalChatScope.ts` — lazy
  machine-owned personal runtime injected into both sync ingress paths. It
  validates personal session ownership and exposes the durable transcript path
  and active-turn state used by `chatScope: "personal"` subscriptions.

Desktop connection UI:

- `apps/desktop/src/shared/types/sync.ts` — the account-directory state union
  plus the two things every consumer of it needs:
  `isSyncAccountDirectoryState`, which narrows a state that arrived over RPC as
  an untyped string (widening at the trust boundary rather than in a caller's
  signature, where it would silently disable the exhaustiveness check), and
  `describeUnpublishedAccountDirectory`, the per-state
  `{ summary, nextAction }` advice for a machine that is signed in but not
  published. That table is the **only** place this copy lives; the Connections
  pane and `ade setup` both read it. They previously kept hand-mirrored copies
  that had already drifted — the pane covered every state, the CLI covered one
  and printed the publisher's raw `skipReason` for the rest. Never render
  `skipReason` to a user: those strings are internal diagnostics ("No active
  sync scope is available.") that name a fault and say nothing about clearing
  it. `nextAction` is a CLI command, so a surface that has a button for the
  same fix (the pane's **Repair** control for `token_unreadable`) drops it and
  renders the summary alone.
- `apps/desktop/src/renderer/components/settings/accountDirectorySummary.ts` —
  turns that advice into the one Connections line: `Signed in — <summary>`.
- `apps/desktop/src/renderer/components/app/IntegrationBannerHost.tsx` — hosts
  the `relay-offline` banner alongside the GitHub/AI-provider family.
  `AppShell` seeds `routeHealth.relay` from `sync.getLocalStatus` (the physical
  machine's relay, not whichever runtime a remote-bound project routes to),
  then keeps it current from the existing `sync-status` broadcast, committing a
  new object only when a field the banner reads actually changed.
  `deriveRelayOutageState` reports `"suppressed"` immediately — nothing
  recovers a machine-local ownership conflict on its own, so a grace period
  would only delay the fix — and `"down"` only after `RELAY_OUTAGE_GRACE_MS`
  (2 minutes) of uninterrupted outage measured from `relayControlFailingSinceMs`,
  which is past every ordinary sleep/wake or Wi-Fi-hop redial. The threshold is
  crossed on wall-clock time, so `relayGraceRemainingMs` arms exactly one timer
  for the remaining grace rather than polling. The dismiss key is global (relay
  identity is machine-wide) and its fingerprint is the outage state, so
  dismissing a plain outage cannot hide a later process conflict.
- `apps/desktop/src/renderer/components/app/ConnectionsPanel.tsx` — the single
  top-bar Connections surface with Machines, Phone, and Web tabs. The
  panel owns its header close control and passes the current in-app route to the
  Account page so signed-out users can return to the exact surface they left.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx` —
  Connections uses the focused `"phone"` and `"web"` variants beneath a
  shared **This computer** card. The card owns the pairing-PIN manager and the
  internal phone QR; the Phone tab explains sign-in, QR + PIN, and Nearby + PIN,
  while Web is account-sign-in only. When a configured PIN is available only
  as its at-rest PBKDF2 hash after a runtime restart, the This computer card can
  generate and set a new six-digit PIN instead of leaving copy disabled.
  Initial-load failures show a short recovery action while keeping the raw
  message under **Technical details**: missing project registration asks the
  user to open a project, a build running from its output directory asks the
  user to install this build and reopen it from the installed copy — that copy
  names no folder, because the macOS Applications folder it used to name does
  not exist on Windows — and other sync-service failures ask for an ADE
  restart. When
  the account-directory state is the one failure a restart
  actually clears — `isBrainAccountSessionFailure(...)` in
  `shared/types/sync.ts`, currently exactly `token_unreadable` — the This
  computer card renders a **Repair** control next to the directory summary. The local-brain-only
  `window.ade.sync.getLocalStatus(...)` accessor is available for the card to
  consume so a window bound to another machine can still show the physical
  computer's identity, pairing code, and Phone/Web device lists.
- `apps/desktop/src/renderer/components/settings/useSyncConnections.ts` — the
  hook that keeps the Connections panel local-vs-remote aware. It fetches the
  binding-following `sync.getStatus` **and** the machine-level
  `sync.getLocalStatus` on every refresh; the This computer card always renders the
  `getLocalStatus` snapshot, so it names the physical computer even in a remote-bound
  window, and never substitutes a routed (remote) snapshot when the local one is
  unavailable. It derives `isRemoteBound` by comparing the two snapshots'
  `localDevice.deviceId`, exposes the bound machine's display name for labeling,
  and gates `canManageDevices` on `!isRemoteBound`. Because the mutation methods
  (`setPin`, `generatePin`, `clearPin`, `forgetDevice`, name edits) still follow
  the window binding, the panel renders the pairing code and device controls
  read-only while remote-bound and labels the connected device list with the
  local computer's name so it can't be mistaken for the bound machine's. When
  remote-bound it also scopes the shown devices to this computer's live
  `connectedPeers` (via `peerToRuntimeDeviceState`) instead of the routed
  `listDevices()` result, which would describe the remote machine; offline-paired
  rows are unavailable in that mode until a local-scoped device IPC exists.
  It also exposes `refresh()` — a one-shot re-read of both snapshots without the
  initial-load spinner — which the Repair control uses to re-evaluate its banner
  once a restart settles.
- `apps/desktop/src/renderer/hooks/useBrainRepair.ts` and
  `apps/desktop/src/renderer/components/settings/BrainRepairButton.tsx` — the
  shared **Repair** affordance for a brain that cannot read the stored account
  session. The hook calls `window.ade.app.restartBackgroundService()`
  (`ade.app.restartBackgroundService`), which restarts this Mac's
  `com.ade.runtime` launch agent and resolves only once the replacement answers
  a ping — readiness is observable only in the main process, so the renderer
  awaits it rather than sleeping and hoping. The IPC is optional in
  `global.d.ts`: the hosted-web adapter and browser mock cannot touch a launch
  agent, so `repair.available` feature-detects before any surface offers the
  button. A rejected restart renders "Repair failed — quit and reopen ADE."
  with the technical detail in the `title`; `onSettled` runs on both paths so the
  caller's banner is re-derived either way. Both the This Mac card and the
  Machines panel's route-publish row mount the same hook and button.
- `apps/desktop/src/shared/runtimeErrors.ts` — canonical cross-process error
  messages and predicates shared by the local-runtime pool, main IPC fallback,
  preload routing, remote-runtime connection/timeout reconciliation, and the
  Connections recovery copy. Keep these predicates aligned rather than
  duplicating message regexes at each boundary.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` — the Connections
  control, connected summary, dialog portal/focus ownership, and external
  requests that open a specific tab. Browser peers are identified by
  `deviceType === "browser"`.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.test.tsx`
  and `apps/desktop/src/renderer/components/app/TopBar.test.tsx` — focused
  Phone/Web variants, This computer PIN management, internal phone-QR interactions,
  account-only web guidance, web-peer chip, and sheet dismissal coverage.

Cross-machine Work union:

- `apps/desktop/src/renderer/state/crossMachineLanes.ts` — renderer-owned,
  repository-scoped projection of each connected machine's lanes, bounded
  session preview, and mapped PR rows into the active Work sidebar. It is not
  CRDT replication and does not change the project tab's runtime binding. A PR
  row lives in the `.ade` database of the machine that owns the lane, so each
  machine's slice carries its own `prs`, read with `pr.listAll` on the lane
  cadence (in parallel with the lane and session reads on a cadence tick;
  sequentially only for the off-cadence catch-up, so a slow PR round trip never
  holds a machine's lanes and chats out of the store). The read is best-effort
  and omission-retaining: a machine that answers `lane.list` but fails
  `pr.listAll` still contributes its lanes and sessions and keeps its last
  reported PR rows. `decodeForeignPrs` applies the same drop-don't-half-decode
  contract as `decodeForeignLanes`, validating every field the badge path reads
  (`id`, `laneId`, `headBranch`, `githubPrNumber`, `githubUrl`, `state`) so a
  peer on an older build cannot produce a `PR #undefined` chip or one whose
  click is a silent no-op. See
  [Pull requests](../pull-requests/README.md#which-machine-answers-a-pr-read).
  A detached chat created
  against another `OpenProjectBinding` is optimistically filed in that
  binding's machine slice using its stable session id and resolved lane name;
  binding-scoped reconciliation retains it across stale list responses, then
  replaces it when the owning runtime returns the authoritative row. Foreign
  lane presentation applies the same active/snoozed/settled filing and quiet
  collapse rules as local lanes while keeping runtime-pinned actions directed
  to the owner. Its machine marker follows the physical Mac, not the selected
  tab binding: `isActiveBinding` decides where the lane renders, while
  `isThisMachine` decides whether the amber elsewhere glyph appears. Thus a
  remote-bound tab still labels every remotely owned lane, including those in
  its primary list rather than the foreign union.
- `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx`,
  `SessionListPane.tsx`, and
  `apps/desktop/src/renderer/lib/terminalAttention.ts` — route chat-created
  ownership metadata into the local or foreign optimistic path and render both
  through the shared `sessionFilingBucket` lifecycle-plus-snooze contract.
- `apps/desktop/src/renderer/components/terminals/useWorkMachineRouter.ts` —
  per-session machine routing for the union. A CLI or shell session on another
  machine opens **in place** with its owning `OpenProjectBinding` carried as a
  per-session runtime pin, exactly like a chat: the PTY spawn/write/resize/
  dispose calls, terminal preview, transcript reads, and PTY data/exit
  subscriptions all target the owning machine while the project tab stays where
  the user put it. Switching the tab is reserved for a session whose binding this
  window does not have open. Local sessions resolve to a `null` pin and keep the
  unpinned path unchanged.
- `apps/desktop/src/renderer/components/terminals/useLanePrs.ts` and
  `apps/desktop/src/renderer/lib/lanePrBadge.ts` — the lane→PR map and the
  navigation contract for its chips. Because cross-machine handoff copies a
  lane id, "which machine" is part of the identity of a PR lookup: the map has
  three namespaced key spaces and no bare lane ids — `bound:<laneId>`
  (`boundMachineLanePrs`), `<machineId>:<laneId>` (`lanePrsForMachine`), and
  `any:<laneId>` (`laneHasAnyPr`, used only by the Has PR filter chip). A
  lane's value is plural: its current-branch row is `active`, retained rows
  from previous branches are `previous`, and the collapsed badge rolls them up
  without hiding a worse CI or review state. A session or chat narrows that set
  to its explicit PR links when present; legacy rows without an edge keep the
  recent lane fallback. A
  session card marks its badge foreign from the presence of a foreign row, not
  from a runtime pin — an unreachable machine's row has a null binding and no
  pin while still being foreign — and `openLanePr` sends a foreign PR to GitHub
  because the PRs tab can only resolve a PR id on the bound machine.

Cross-machine Work chat handoff:

- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` and
  `CrossMachineHandoffModal.tsx` — Handoff-tab entry point and the staged
  source/destination/clone/review/completion UI, including the destination
  chat's model / reasoning / fast-mode / permission controls and the
  fast-forward offer for a clean-but-behind destination lane.
- `apps/desktop/src/renderer/components/chat/crossMachineHandoffPresentation.tsx`
  — the modal's pure presentation half: stage/mode types, the `SourceCheck`
  shape, the branch-row and route/repo-readiness copy, permission tone and icon
  lookups, send-step labels, and the `CheckRow` component. Split out because
  these are exactly the pieces that shipped wrong (a tone map that rendered
  every permission pill grey, a branch row that called a two-commits-behind
  branch "pushed") and were unreachable from a test inside the stateful modal.
- `apps/desktop/src/renderer/components/shared/BlockedAction.tsx` and
  `apps/desktop/src/renderer/components/shared/PermissionModePicker.tsx` —
  cross-surface primitives the modal reuses rather than reimplementing: the
  reason-carrying blocked-action button/list, and the composer's permission
  pill.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — authoritative
  source readiness, capsule creation and validation, destination preflight,
  deterministic lane/chat acceptance, durable replay record, and source notice.
- `apps/desktop/src/shared/crossMachineHandoff.ts` and
  `apps/desktop/src/shared/types/chat.ts` — portable Git identity/sanitization,
  untrusted response decoders, capsule DTO, and preflight/result contracts.
- `apps/desktop/src/main/services/remoteRuntime/remoteConnectionPool.ts`,
  `remoteConnectionService.ts`, and `apps/desktop/src/main/services/ipc/runtimeBridge.ts`
  — destination machine capability checks, storage preflight dispatch, route
  pinning, paired/SSH runtime JSON-RPC routing, request-local timeout policy,
  and non-replayable action reconciliation when confirmation is lost.
- `apps/desktop/src/preload/preload.ts` — source project-runtime routing plus
  the renderer bridge for machine-level project setup and destination actions.

Canonical files (`apps/ade-cli/src/services/sync/`):

- `productAnalyticsRemoteCommand.ts` — treats browser/phone analytics input as
  untrusted, binds the peer surface and canonical host project, strips claimed
  identity fields, and applies the peer's consent bit before dispatch. Paired
  consent never changes the machine-wide preference.

- `syncService.ts` (~1,160 lines) — orchestrator that wires the runtime,
  peer client, device registry, draft persistence, pin store, and the
  per-project / per-runtime configuration. Builds the
  `projectCatalogProvider` so a runtime hosting multiple projects can
  hand a phone a catalog and react to `project_switch_request`. Accepts
  `forceHostRole` only as a legacy override; normal callers leave it
  false so a second runtime becomes a viewer instead of stealing the
  sync authority role. Its route-health derivation lives in
  `syncRouteHealth.ts`, shared with the projectless path.
- `syncRouteHealth.ts` — `deriveListenerHealth` and `buildRelayRouteHealth`,
  the one derivation of how a machine describes its own inbound routes. Both
  `syncService.getStatus` (project scope) and `buildProjectlessSyncSnapshot`
  (no scope) call it with the same raw inputs. The strings are what the user
  reads in Connections and `ade doctor`, and the account-machine publisher gates
  on the booleans, so the two paths disagreeing is not cosmetic drift — it is
  one of them lying about whether the machine is reachable. The genuine
  differences are parameters, not branches: what "not bound" means (a listener
  that failed to start vs a machine with no scope), and which timestamp stands
  in when the tunnel reports no failure time. A loopback validation result
  counts only while it still names the currently bound port, so a rebound
  listener is never reported healthy from a stale probe.
- `projectlessSyncSnapshot.ts` — the `SyncRoleSnapshot` for a brain with no
  project scope. See *Hosting sync, and publishing, with no project*.
  `buildProjectlessSyncSnapshot` reports the real listener, machine identity,
  pairing connect info, and relay when this process holds the lease and has the
  shared listener bound; `buildDegradedProjectlessSyncSnapshot` is the honest
  all-down shape for callers with neither. It replaced a hardcoded placeholder
  that claimed `listenerBound: false` and `pairingConnectInfo: null` for a
  genuinely bound listener — the two fields the account-directory publisher
  gates on. Optional `pin` and `bootstrapToken` args let a caller that holds
  the machine stores report the real pairing state; both are gated on `hosting`,
  so a runtime that is not the machine's sync host never leaks a plaintext PIN
  or bootstrap token.
- `syncHelloProtocol.ts` — the one parser for `hello` and `pairing_request`
  payloads, imported by both ingress paths (`syncHostService` and
  `brainProjectActionsSyncHandler`). Normalizes the legacy top-level `token`
  into `auth: { kind: "bootstrap" }`, validates each of the four auth shapes
  (`bootstrap`, `paired`, `account`, `account_sealed`), bounds the carried
  relay account token, and parses `connectionAttempt` (id capped at
  `CONNECTION_ATTEMPT_ID_MAX_CHARS`, timestamps no further ahead than
  `CONNECTION_ATTEMPT_MAX_FUTURE_MS`) plus `dbVersionBySite` and the
  application-compression offer. There is no second copy; the brain's narrower
  hand-rolled one is gone.
- `syncAccountHelloAuth.ts` — the shared account-hello gate chain for both
  ingresses, and the canonical rejection strings
  (`SYNC_REPAIR_REQUIRED_MESSAGE`, `SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE`,
  `SYNC_ACCOUNT_VERIFY_UNAVAILABLE_MESSAGE`, `SYNC_ACCOUNT_NOT_SIGNED_IN_MESSAGE`,
  `SYNC_ACCOUNT_DEVICE_MISMATCH_MESSAGE`, `SYNC_ACCOUNT_KEYLESS_RECORD_MESSAGE`,
  `SYNC_ACCOUNT_OTHER_OWNER_MESSAGE`, `SYNC_ACCOUNT_PAIRING_WRITE_FAILED_MESSAGE`,
  `SYNC_ACCOUNT_VERIFY_FAILED_MESSAGE`). "No usable pairing record" and "unknown
  device" deliberately return the same wire answer: distinguishing them would
  turn the handshake into an existence oracle for an unauthenticated caller.
  Connection arbitration and sealed adoption are options the brain leaves unset,
  which is the only genuine divergence between the two callers.
- `brainMachineSyncStores.ts` — the machine-level PIN / pairing / security
  stores for a brain hosting sync with no project scope
  (`sync-pin.json`, `sync-paired-devices.json`, `sync-security.json` under
  `~/.ade/secrets/`), memoized per resolved secrets directory under a
  `pathKey` so one directory can never yield two store sets. Also exports
  `generateMachinePairingPin` and `createProjectlessSyncControls`, the
  `ProjectlessSyncControls` implementation the RPC surface falls back to. The
  ingress handler and the RPC surface share these instances, so a PIN generated
  over RPC is live for the very next handshake instead of after a restart.
- `machineRelayTunnel.ts` — `createMachineRelayTunnel`, the machine's one relay
  tunnel client plus its authority gate. Both brains that can host phone sync
  build it: `createAdeRuntime` for a project scope, and `runServe`'s projectless
  path for a machine with nothing registered. They must produce the same thing,
  because the relay Durable Object keeps one host control socket per
  `machineKey` and evicts the previous holder with `4505` — two clients on one
  machine evict each other in a loop and relay stays down for both. The client
  is cached one-per-machine keyed by the relay config path, so a project scope
  booting after the projectless brain adopts that brain's client instead of
  registering the same `machineKey` twice. The host listener is attached
  *outside* the factory and before the gate: whichever runtime actually owns the
  listener wins regardless of who created the instance, and the gate's first
  `start()` already has a bridge to validate. Only the reaction to a
  publication-state change differs between the two callers, so that stays a
  parameter. Its account lease asks "is this machine still theirs", not "can I
  call the API": a process-lifetime `retainedAccountOwnerId` keeps the tunnel up
  through an `expired` or `unreadable` session (lease `expiresAt: null`, no
  token churn against a grant already known dead), and only a deliberate
  `signed_out` drops it. See
  [remote runtime → Account state and reachability](../remote-runtime/README.md#account-state-and-reachability).
- `syncHostService.ts` — the per-project WebSocket host. Owns
  connection acceptance, hello/pairing handshakes (an `auth_failed`
  rejection is attributed with the rejecting machine's
  `host: { deviceId, name }` — read from `readBrainMetadata()` — so a
  client can only ever drop a saved pairing when the rejection came from
  the machine it is actually paired with), the sealed `ade-adopt-v1`
  account-adoption handshake (`account_challenge` → `account_challenge_ok` →
  a `hello` whose `auth.kind` is `account_sealed`: the host signs the client's
  nonce over an ephemeral X25519 exchange with its `machineIdentitySigningStore`
  key, derives the session key, unseals the account credentials from the sealed
  hello, and returns the paired credentials in a sealed `hello_ok`. The seal
  AEAD is negotiated from the client's advertised `supportedAeads` against the
  host's `supportedAdoptChannelAeads()` — the host picks the first mutual
  choice, echoes it in the `account_challenge_ok`, and binds it into the
  signature input, so a packaged Electron without ChaCha20-Poly1305 negotiates
  `aes-256-gcm` instead of failing to connect; a client advertising an AEAD set
  with no host overlap is rejected rather than silently downgraded. Legacy
  adopters that omit `supportedAeads` still fall back to
  `chacha20-poly1305` for compatibility; that choice is not present in their
  signed transcript. The host records
  `sync_host.legacy_adoption_aead_unbound` with the client version when that
  path completes. `ALLOW_LEGACY_UNBOUND_ADOPTION_AEAD` names the sunset gate:
  once the supported-client floor guarantees AEAD advertisement, the
  `account_challenge` handler can reject an omitted list and make transcript
  binding unconditional. A completed
  single-use challenge is required, well-formed challenges feed no rate limiter
  while malformed/anomalous ones charge a per-IP + global cooldown, and unsealed
  `account_sealed` adoption is the one account path allowed over a direct
  LAN/tailnet route — plaintext `account` bearers still require the
  `relay-bridge` transport origin), per-peer state,
  application-compression negotiation (the client offers ordered codecs in
  `hello`, the host selects `deflate` in the legacy-encoded `hello_ok`, and
  both directions switch only after that frame is queued), authenticated
  inbound `envelope_chunk` reassembly, outbound per-peer chunk framing after
  the peer declared `chunkedEnvelopes`, and protocol-range rejection through a
  typed uncompressed `hello_error` before close code `4406`,
  changeset fan-out + ack tracking (bounded, windowed exports and smaller-batch
  recovery from the last acknowledged cursor — see `crdt-model.md`),
  bounded parallel reads on the per-peer envelope queue (up to
  `MAX_CONCURRENT_PEER_READS = 4` reads overlap, while every other envelope
  stays a barrier: a write waits for all preceding work and every later read
  waits for that write, so a read still observes every mutation the peer sent
  before it, and the only new interleaving is read-with-read — which these
  services already face from the desktop renderer's parallel IPC calls. It
  replaced one fully serialized chain, where a cold search-index build or a git
  blame head-of-line-blocked every other read from the same client.
  `isConcurrentReadEnvelope` classifies conservatively: file reads by action
  name, remote commands only when the method segment is a plain `get*` / `list*`
  / `read*` / `search*` accessor, and everything else — including verbs that
  only look harmless, like `git.fetch` — is a write. A read waits for the
  preceding write barrier *before* taking a slot, so it cannot starve an
  earlier read the write is itself waiting on, and a released slot is handed
  straight to the longest-waiting read to preserve FIFO order. The handler
  timeout starts when the handler starts, never while the envelope waits its
  turn), per-peer
  foreground-first scheduling (each peer has its own serialized
  chat/changeset-poll chain, so a slow transcript read cannot hold other peers;
  queued foreground envelopes or active-chat socket pressure defer background
  changesets for at most 2 seconds, after which only the smaller active-chat
  batch is admitted before returning to foreground work), mobile-chat inline-image compaction
  (`compactChatEventEnvelopeForSync`: data URIs above 64 KB are removed from
  live sends, snapshots, and replay entries while the desktop event remains
  unchanged and original/omitted byte counts are retained), the mobile changeset diet
  (`MOBILE_CHANGESET_EXCLUDED_TABLES`: high-churn tables the phone
  never reads — `attempt_transcripts`, `operations`, `ai_usage_log`,
  `budget_usage_records`, `automation_runs`,
  `automation_action_results` — are filtered from phone changesets
  while ack watermarks still advance), compact reseeding for replica phones
  more than 5,000 versions behind (ACK- and chunk-capable iOS peers receive one
  bounded current-state `catchup` batch, then resume incremental delivery only
  after its `changeset_ack`), the host-authoritative table
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
  terminal streams, a bounded snapshot barrier that queues live data until an
  authoritative transcript snapshot is captured, `sinceOffset` delta
  snapshots, terminal scrollback paging via `terminal_history`, subscribed
  chat scrollback via `chat_history` (authorized against the existing
  project/personal/foreign subscription, append-stable byte cursor, and
  retryable `unavailable` responses), acknowledged/deduped
  terminal input with legacy fallback, mobile terminal input/resize forwarding
  into subscribed PTYs, desktop-size restore after the last phone
  detaches, lane presence decoration, project catalog/switch envelopes,
  runtime-scoped project action envelopes (browse/open/create/clone/
  list GitHub repos/default parent directory/forget), project-id alias
  matching between the machine catalog id and the hosted DB id, per-IP pairing rate
  limiter, mobile compatibility advertisement (`features.mobileCompatibility`
  derived from the shared required-action contract), and the Tailscale Serve / mDNS
  publication paths. Runtime
  kind is one of `desktop-embedded`, `headless`, `remote-stdio`,
  `desktop`, `daemon`, or `remote`. After a successful project command it
  records meaningful user mutations in the local usage ledger, deriving
  `mobile` / `web` / `desktop` attribution from the peer metadata; reads and
  failed commands do not create events. It also owns the all-projects session
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
  `crossProjectChat` hello feature flag. An injected `personalChatScope` adds
  the separate `personalChats` hello feature and resolves chat subscriptions
  that explicitly carry `chatScope: "personal"`; it never infers personal
  scope from a missing project id.
- `rosterBuilder.ts` — builds the machine-wide all-projects session roster
  (`SyncRosterProject[]`) consumed by the Hub: agent chats, their attached
  shell rows, and **standalone CLI (tracked terminal) sessions — live and
  ended**. The roster is built only from projects
  whose registry `catalogVisibility` is `"recent"`, **plus the host's own
  project** (matched by `hostProjectId`) which is always included even if it is
  a `"system"`-visibility entry — so the machine you are actively hosting never
  vanishes from its own Hub while runtime-auto system projects stay out of the
  feed. Opens each project's
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
  up to ~8 attempts over ~3.2 s on the saved port before falling back to a
  port scan, so a transient brain restart does not drift the port phones saved).
  Port diagnosis uses asynchronous `lsof` / `ps`; once a live holder is
  confirmed, the listener skips the remaining duplicate retries for that port
  and emits one conflict warning before advancing. WebSocket
  upgrades are accepted only on the sync root path (`/`). When an Origin header
  is present, it must name the canonical hosted web client
  (`https://app.ade-app.dev`) or one of the explicit local Vite origins;
  foreign origins are rejected and logged at debug. An absent Origin remains
  valid for non-browser clients such as iOS URLSession, ADE CLI peers, and the
  relay bridge, whose private bridge-proof header is validated separately.
  On an `EADDRINUSE` for a port in the sync range (`DEFAULT_SYNC_HOST_PORT`
  8787 through `SYNC_HOST_MAX_PORT` 8999) it runs **sync-port zombie
  reaping**: it diagnoses the port's holders (`inspectSyncListenerPort`),
  and if a stale ADE brain owns it, re-confirms the same pid + process
  start-time on a second diagnosis (guarding against pid reuse), terminates
  that holder, logs `sync_listener.zombie_reaped`, and retries the freed port
  once — so a dead-but-port-holding sibling brain cannot force the new brain
  onto a drifted port that phones never saved. The same diagnosis feeds the
  `ade doctor` Sync-port row, which is explicit that it cannot see a root-owned
  holder: a stranded `tailscale serve` entry from an earlier run holds the port
  through `tailscaled`, so a user-level probe reports no holders even though the
  port is taken (`tailscale serve status` and `netstat -an -p tcp` show it).
  Those leftovers are reclaimed on the next tailnet publish. The listener is
  handed between hosts on project switch: the new host adopts
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
  handler used by `ade serve` before any project host is active. It takes a
  `secretsDir` (not individual PIN/pairing file paths) and resolves its stores
  through `resolveBrainMachineSyncStores`, so the RPC surface mutates the same
  instances it verifies against. It parses helloes with the shared
  `syncHelloProtocol` and runs account helloes through the shared
  `syncAccountHelloAuth` gate chain. Account helloes used to be refused here on
  the theory that only a project sync host owns the account session — which made
  "install, sign in, connect from anywhere" impossible until the user opened a
  project, since the web client authenticates this way and no other. They are
  now accepted with the project host's own gates. Connection arbitration and
  sealed adoption are options it leaves unset: an `account_sealed` hello needs
  an `account_challenge` round trip this handler does not serve, so it is
  answered with a plain "pair with a code, or open a project" under
  `account_session_changed` rather than `auth_failed`, because the device's
  saved pairing is untouched by that refusal. `connectionAttempt` metadata is
  now parsed rather than silently discarded. It
  authenticates the same PIN / paired-secret / bootstrap paths as the
  per-project host, applies the same failed-PIN cooldown, attributes its
  `auth_failed` rejections with the same `host: { deviceId, name }`
  identity the per-project host sends (so a phone that reaches this
  fallback over a stale address still won't destroy a pairing it can't
  attribute), and serves
  project catalog plus runtime-scoped project actions so a phone can
  add/open/create/clone/remove a project even from the project picker. It
  receives the same `PersonalChatScope`, advertises the same capability/action
  descriptors, and can execute personal commands before any project host is
  active. Personal `chat_subscribe` snapshots carry the same byte paging
  metadata as project-host snapshots, and `chat_history` pages continue to
  work through this fallback without booting a project host.
  It shares the project host's compression offer/selection and typed protocol
  mismatch behavior; the selected codec is stored per socket only after the
  legacy-encoded `hello_ok` is accepted for send.
  It also answers `command` envelopes: when no project host owns the peer
  (host restarting, or blocked by a conflicting sync listener) it replies
  immediately with a `command_result` carrying
  `error.code: "host_unavailable"` instead of silently dropping the
  command — a dropped command used to leave the phone staring at a 30 s
  timeout with a vague "took too long" banner. iOS treats that code as
  transient (retryable and queueable, like a timeout), so queued
  operations survive host restarts instead of being deleted on replay.
- `syncHostSingleton.ts` — the machine-wide sync host lease. Owns the advisory
  lock file (`$TMPDIR/ade-sync-host-<uid>.json`, override
  `ADE_SYNC_HOST_LOCK_PATH`) that records the owning pid, channel, project
  root, and bound port, diagnoses conflicts (`SyncHostSingletonConflictError`)
  against live listeners so a stale record cannot strand a new host, and
  exposes `updatePort` / `dispose` on the acquired lease. Alongside the file it
  keeps a **process-wide authority registry**: `holdsSyncHostSingleton()`
  answers whether *this* process currently owns the machine's phone sync, and
  `onSyncHostSingletonAuthorityChanged()` notifies subscribers on none-held →
  held and held → none-held transitions. That registry is what the relay tunnel
  and the account-directory publisher gate on — see *The machine-wide sync host
  lease* above.
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
- `mobileReplicaReseed.ts` — bounded compact-state construction for an iOS
  replica strictly more than 5,000 versions behind. It scans at most 1,000
  relevant rows per host poll, caps the shared cache and logical payload at
  10,000 rows / 4 MiB, and falls back to normal incremental replay when the
  current state or one version group exceeds those limits.
- `syncPeerService.ts` (~580 lines) — WebSocket **client**. The runtime
  can run this too when it joins another runtime as a peer (handoff
  rehearsal, controller-to-authority swap). On iOS, an equivalent Swift
  implementation lives in `apps/ios/ADE/Services/SyncService.swift`.
- `syncProtocol.ts` — canonical Node envelope codec and protocol boundary.
  It retains the legacy gzip threshold
  (`DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES = 4 * 1024`) for peers that
  omit compression negotiation, and supports negotiated zlib-wrapped
  `deflate` at `SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES` (512 bytes).
  Decode is capped at
  `MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES` (25 MiB). Encoded envelopes above
  `DEFAULT_SYNC_MAX_FRAME_BYTES` (720 KiB) can be split into
  `envelope_chunk` frames; reassembly accepts at most eight chunk sets, 512
  parts, a 128-byte `chunkId`, and 32 MiB total buffered data, and expires an
  incomplete set after 30 seconds. It also owns the supported protocol range
  (`SYNC_PROTOCOL_MIN_SUPPORTED...SYNC_PROTOCOL_VERSION`), the typed
  mismatch error, and close code `4406`. Default host port is `8787`, and
  `SYNC_HOST_MAX_PORT` (`8999`) bounds the sync range the shared listener
  will zombie-reap a stale ADE holder from.
- `abortSignal.ts` — the shared cancellation helper (`runWithAbortSignal`,
  `abortSignalError`) used across the sync command paths so a registration- or
  caller-carried `AbortSignal` rejects in-flight work with a consistent
  `AbortError` instead of each call site re-implementing the wiring.
- `syncRemoteCommandService.ts` (~4,600 lines) — command registry
  (lanes, chat, git, PR, sessions, conflicts, files,
  `usage.getAdeStats`, `usage.getQuotaSnapshot`, `usage.refreshQuota`,
  `prs.getMobileSnapshot`, `lanes.presence.*`,
  `work.runQuickCommand`,
  `work.startCliSession`, `work.listExternalSessions`,
  `work.importExternalSession`, `chat.recoverCodexTurn`, `modelPicker.*`, …).
  The cross-machine handoff family (`chat.prepareCrossMachineHandoff`,
  `chat.validateCrossMachineSource`, `chat.preflightCrossMachineDestination`,
  `chat.fastForwardCrossMachineHandoffLane`,
  `chat.acceptCrossMachineHandoff`, and `chat.markCrossMachineHandoff`) keeps
  source and destination work inside their owning project runtimes. The
  fast-forward command lets a destination catch an existing clean lane up to the
  source commit with a `--ff-only` merge it re-validates itself, so a shared
  branch such as `main` is not an automatic dead end. Final
  acceptance is not queueable; destination idempotency is keyed by the
  capsule's handoff id and fingerprint instead of relying on command replay.
  Desktop **Send to machine** reaches the destination through multi-project
  runtime JSON-RPC: paired routes carry that stream in `rpc_data` envelopes,
  while SSH uses `ade rpc --stdio`. The sync host's remote-command responder
  timeout therefore does not bound the paired desktop acceptance action.
  Stalled-turn recovery is viewer-allowed but not queueable because it must
  target the currently active Codex turn. Mobile/remote Codex CLI launches
  also resolve the explicitly opted-in, verified standalone Computer Use MCP
  client and add it through the shared launch builder. Each registration
  carries a `SyncRemoteCommandDescriptor` with a **scope** label of
  `"runtime"` or `"project"`. The runtime rejects a `project`-scoped
  command when no project is open or when the caller did not bundle a
  matching `projectId` (see *Scope enforcement* below). Mobile /
  controller CLI launches resolve the target lane worktree before
  building provider argv/env so Agent Skill roots and
  `ADE_AGENT_SKILLS_DIRS` stay lane-aware. External-session imports share
  the desktop external-session service and DTOs: list returns provider
  summaries, while import returns the created ids plus the persisted
  `TerminalSessionSummary` or `AgentChatSessionSummary`. Controllers install
  that summary before navigating, avoiding a race with replicated/session-list
  state. See
  [External Session Import](../terminals-and-sessions/external-session-import.md)
  for the provider storage formats, host/runtime requirements, and mobile
  testing constraints.
  `usage.getAdeStats` is a viewer-allowed project read backed by the runtime's
  usage tracker; it serves cached provider/GitHub data plus live DB aggregates
  to iOS and web without replicating the local-only raw interaction ledger.
  `usage.getQuotaSnapshot` reads the cached live Claude/Codex limit snapshot,
  while `usage.refreshQuota` runs the bounded quota-only provider path with
  interactive auth disabled. Neither remote quota action starts local provider
  history scans or sends provider credentials to the controller.
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
  The `personalChats.*` family is registered from the shared
  `PERSONAL_CHAT_ACTIONS` allowlist with `scope: "runtime"`; the executor calls
  `PersonalChatScope` directly instead of looking up the current project.
  Only `personalChats.send` is queueable. A queued create is prohibited because
  it cannot return a stable optimistic session id and replay could duplicate a
  conversation.
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
  `crdt-model.md` for the underlying suppression mechanism. Local identity
  snapshots return cached/fallback values synchronously while macOS
  `ComputerName` (`scutil`) and the Tailscale DNS name refresh asynchronously;
  Tailscale status is single-flight and retained for 30 seconds so periodic
  machine publication cannot block the brain event loop on an external CLI.
  The identity defaults are exported as `localSyncDeviceDefaults()` so
  `projectlessSyncSnapshot` can name the machine without a project database.
  The Tailscale probe spawns with `windowsHide`, so a packaged Windows brain
  never flashes a console window on its 30-second cadence.
- `syncPairingStore.ts` — validates `pairing_request` envelopes
  against `syncPinStore`, mints the durable per-device secret, and
  persists it into the `paired_devices` row (SQLite). Each
  `SyncPairingRecord` carries its provenance: `accountOwnerUserId` (null for a
  QR/Nearby-PIN/SSH pairing made at the Mac) and the sticky `localTrustOrigin`
  flag set when such a record is later adopted into an account.
  `pairPeerViaAccount` mints or rotates from a verified same-account
  attestation and performs that adoption; `isValidDpopPublicKey` is the shared
  validity test both this store and `syncHostService` use so a blank pinned key
  can never be mistaken for a real one. `revokeAccountOwnedExcept` is the
  sign-out / account-switch sweep: it deletes records owned by another account
  but demotes `localTrustOrigin` records back to `accountOwnerUserId: null`,
  and writes whenever it deleted **or** demoted. See *Adopting a manual pairing
  into an account* for the gate.
- `syncPinStore.ts` — on-disk storage for the user-set 6-digit
  pairing PIN at `~/.ade/secrets/sync-pin.json`, chmodded `0600`. The
  runtime never rotates the PIN; the operator sets or clears it from
  the **This computer** card in the Connections panel.
- `resolveTailscaleCliPath.ts` — Tailscale CLI discovery used for the
  tailnet `tailscale serve` publication path.
- `syncDpop.ts` — device-bound pairing (DPoP) helpers: the canonical
  signing string builder, `evaluatePairedHelloDpop` (validates a
  `SyncDpopProof` against the stored P-256 public key and TOFU-adopts an
  offered key for legacy devices), and `createSyncDpopNonceCache` (a replay
  guard partitioned to 256 recent nonces per device with a 4,096-entry global
  ceiling). A device may evict only its own oldest entries; when the global
  ceiling has no safe slot, verification fails closed with
  `nonce_cache_saturated` instead of evicting another device's replay history.
  Shared by `syncHostService` and the brain
  ingress handler.
- `syncSecurityStore.ts` — machine-level sync security posture stored at
  `~/.ade/secrets/sync-security.json` (chmod `0600`). Owns the
  `requireDpop` flag with the `ADE_SYNC_REQUIRE_DPOP=1|0` env override; both
  the per-project host and the brain ingress handler read it.
- `machineIdentitySigningStore.ts` — the machine's long-lived Ed25519 identity
  keypair at `~/.ade/secrets/machine-identity-signing.json` (chmod `0600`,
  lazily generated, cached per file path, regenerated if corrupt). The public
  key is published as the directory row's `pubkey`; the private key signs the
  `ade-adopt-v1` challenge so a client can verify it is talking to the machine
  it selected before releasing any account credential. Shared by the host
  service and the account-directory publisher.
- `apps/desktop/src/shared/sync/adoptChannelCrypto.ts` — the shared
  `ade-adopt-v1` primitives used on both sides of sealed account adoption:
  X25519 ephemeral key generation, the canonical challenge signature input,
  HKDF-SHA256 session-key derivation over the X25519 shared secret + nonce,
  AEAD `seal`/`unseal` with context-bound AAD, and Ed25519
  sign/verify against the raw published key. Also imported by
  `machineIdentitySigningStore.ts` for SPKI↔raw key conversion. The AEAD is
  **negotiated**: `ADOPT_CHANNEL_AEADS` lists `chacha20-poly1305` then
  `aes-256-gcm`, and `supportedAdoptChannelAeads()` probes which of them the
  running crypto backend can actually construct (cached). This is what lets a
  packaged Electron whose bundled BoringSSL lacks ChaCha20-Poly1305 still
  account-connect: the client advertises the AEADs it supports in the challenge,
  the host picks the first it also supports, and the chosen AEAD is folded into
  the challenge signature input (`aead` field) so it cannot be downgraded by an
  on-path attacker. A client that sends no AEAD list, and both sides by default,
  fall back to `chacha20-poly1305`.
- `syncCloudRelayStore.ts` — persists the cloud tunnel-relay identity, and
  exports `buildSyncCloudRelayStatus`, the one projection of relay state that
  the desktop and the CLI read whether a project scope owns sync or the brain
  answers for the bare machine. Both surfaces had their own copy and they had
  already drifted in whitespace, one edit away from telling two different relay
  stories about one machine. `accountSignedIn` is the gate: without it the live
  fields collapse to their off values and `lastError` becomes the sign-in
  prompt, so a signed-out machine never reports a connection it cannot have.
  The identity itself lives at
  `~/.ade/secrets/sync-cloud-relay.json` (lazily-minted 32-hex `machineKey` +
  HMAC `secret`, chmod `0600`). The identity is stable in normal operation.
  Only a claim endpoint response with the exact HTTP status `409` can trigger
  the tunnel client's one-attempt recovery: the store serializes competing
  brains with an exclusive sibling lock, compare-and-swaps the expected
  `machineKey`, and mints a replacement key + secret. Generic network, auth,
  upgrade, and bridge failures never rotate identity. Legacy `enabled` /
  `enabledSetByUser` fields are accepted only long enough to rewrite the file
  without them; there is no stored enablement or user kill-switch. The store
  derives the controller-facing
  `wss://<relay>/connect/<machineKey>` URL and the canonical host/pipe
  HMAC signing strings shared with the `apps/tunnel-relay` worker. The claim
  and host requests also decide where the relay's Durable Object is placed:
  the worker derives a location hint from the requesting machine's geography
  so the object is created near the machine rather than near whichever request
  arrives first. Cloudflare honors a hint only at creation, so an existing
  machineKey keeps its original placement.
- `relayTunnelAuthorityGate.ts` — decides whether a runtime may run the
  machine's relay tunnel at all. `createRelayTunnelAuthorityGate` subscribes to
  `onSyncHostSingletonAuthorityChanged` and starts the tunnel only while this
  process both hosts the brain-level shared listener **and** holds the
  machine-wide sync host lease; a loss of authority stops it after
  `SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS` (5 s) so an in-process project switch
  rides through. Every start re-attaches the host listener, because `stop()`
  drops the reference and it is otherwise attached once per runtime — a
  gate-driven stop/start would otherwise come back with a live control socket
  and no bridge, rejecting phone connects with "host sync listener unavailable"
  until the brain restarted. Re-winning the lease also calls
  `clearControlSuppression()`, but only for a gate that has actually observed a
  release, so opening a second project cannot reset the eviction budget.
  `dispose()` detaches the subscription without stopping the tunnel: the client
  is machine-level and shared across project scopes, so a closing scope must
  not sever relay for the others. `bootstrap.ts` builds one gate per scope.
- `syncTunnelClientService.ts` — the brain-side tunnel client. When the
  machine has a current ADE account lease it keeps an outbound WebSocket
  registered with the relay worker (HMAC-signed host/pipe upgrades,
  exponential backoff with decorrelated jitter, a 1 s floor, and a 60 s cap)
  so controllers off the LAN/tailnet can dial the machine through the relay.
  `computeBackoffMs` samples from a window widened by the *previous* delay
  rather than resampling the same narrow exponential band, so two clients that
  collide once do not keep colliding at the same instant; the floor exists
  because full jitter from zero let rival processes both resample near-zero
  delays forever. The client runs only under `relayTunnelAuthorityGate` — the
  runtime holding the machine-wide sync host lease. Connect and reconnect are
  single-flight: lease reconciliation does not close a still-valid connecting
  socket, and a transient token-refresh exception retains the current control
  route through the last known account-lease expiry. Sign-out, an explicit
  missing lease, account switch, or expiry closes the control socket and active
  pipes. The normal ADE sync
  hello/pairing then runs inside that pipe. TLS terminates at the relay, so the
  relay can inspect the handshake and subsequent sync traffic. Bridge
  validation is **proactive**: `validateCurrentBridge()` re-probes the
  loopback sync listener (matching port + identity nonce) whenever the control
  socket opens and whenever the shared listener reports a fresh loopback
  validation, serializing probes through the same validation queue used by
  inbound opens. The listener itself arrives through `attachHostListener()`,
  which `relayTunnelAuthorityGate` calls on every start from the runtime that
  owns the shared listener — not from the construction factory. The client is shared one-per-machine
  (`getSharedSyncTunnelClientService`, keyed by `sync-cloud-relay.json`) and is
  built by whichever runtime bootstraps first, which is regularly a scope with
  no listener at all (a headless one-shot, an embedded fallback), so anything
  captured at construction would answer `null` for the life of the process and
  the bridge could never validate. Attaching supplies the port, loopback nonce,
  and relay bridge proof, subscribes the `onLoopbackValidated` retry hook
  (whose failures log `sync_tunnel.bridge_validation_failed`), and validates
  immediately if the listener is already bound; `stop()` detaches it. This flips `relayBridgeValidated` — and therefore directory relay
  publication — true as soon as the listener is confirmed, so the earlier
  "bridge not validated against the sync port" state self-heals instead of
  waiting for an inbound client to open the first tunnel. `openTunnel` still
  re-validates on every inbound open as defense in depth. Validation calls are
  strictly serialized, and the port plus loopback identity
  are checked again before pipe creation so a listener change cannot reuse a
  stale result. The control socket uses native WebSocket ping frames every 30
  seconds with a 10-second pong deadline. Because a hibernated or wedged
  Durable Object can leave the Cloudflare edge answering those transport-level
  pings while the machine's control registration is already dead (a "zombie"
  control), a **low-frequency application-level JSON keepalive** runs alongside
  it: the client sends `{t:"ping"}` on the control every
  `CONTROL_JSON_PING_INTERVAL_MS` (180 s, first ping after ~1 s) and expects a
  `{t:"pong"}` within `CONTROL_JSON_PONG_DEADLINE_MS` (30 s). A miss on either
  liveness path terminates the socket and enters the guarded reconnect state
  machine; a JSON-keepalive miss additionally records a
  `relay control unreachable at relay (zombie socket)` failure, drops
  end-to-end verification, and logs `sync_tunnel.zombie_control_detected`.
  Beyond liveness, the client verifies the relay path **end-to-end** with
  `runSelfProbe()`: it dials the relay exactly like a ready-v2 controller
  (`syncRelaySelfProbe.probeRelayEndToEnd`) and only treats the route as
  verified once it sees `accepted`+`ready` v2 back through its own bridge. The
  probe runs (debounced ~2 s) whenever the control reaches ready and whenever
  the local bridge re-validates, and its verdict — `relayEndToEndVerifiedAt`,
  `relayEndToEndFailure`, `relayEndToEndRoundTripMs` on the status — is what
  the account-directory publisher additionally gates the `relay` endpoint on
  (see `accountMachinePublisherService.ts`), so a control that connects but
  whose bridge cannot actually round-trip stays unpublished. A probe failure
  terminates the control as a zombie; an `atCapacity` close (relay code `4503`
  `CLOSE_TOO_MANY`, sent only after the machine's control is confirmed
  registered) is treated as liveness proof and renders no verdict, leaving
  prior verification/publication state untouched. Opens that fail validation,
  local-listener setup, or pipe
  setup send a bounded `{t:"reject"}` signal so the waiting controller closes
  immediately instead of hanging. A real pipe/local setup error or timeout is
  also a generation-scoped publication blocker until a fresh tunnel reaches
  `ready`; cached loopback validation cannot clear it, ordinary cancelled
  candidate closes do not create it, and a failed secondary attempt cannot
  poison a route that already has a ready tunnel. Pipe/local application close
  codes and sanitized reasons are preserved across the bridge; other closes
  normalize to `4000`. Account loss clears validation and all sockets, while
  account switches force a clean control reconnect.
  A close with `RELAY_CLOSE_CONTROL_REPLACED` (`4505`) is handled as its own
  regime, not as a network failure: it can only mean another process registered
  the same `machineKey`, so redialing on the network schedule just evicts the
  rival right back. The client retries on a fixed `CONTROL_REPLACED_RETRY_BASE_MS`
  (60 s) floor jittered upward only, at most
  `MAX_CONTROL_REPLACED_REATTEMPTS` (3) times, then stops dialing entirely and
  reports `controlSuppressed` with the actionable reason "Another ADE process
  owns the relay connection for this machine." Suppression is enforced at the
  dial itself as well as in the reconnect scheduler, because the once-a-second
  account-lease poll calls `connectControl` directly. Because the rival usually
  exits on its own, a stopped client re-arms once after
  `CONTROL_REPLACED_REARM_MS` (10 minutes); `clearControlSuppression()` also
  re-arms immediately when this process (re)acquires the sync host lease, and a
  control socket that survives the ready-stability window resets the budget so a
  long-lived brain cannot accumulate its way to a permanent stop. Structured
  events are `sync_tunnel.control_replaced`, `.control_replaced_stopped`, and
  `.control_suppression_cleared`; one edge-triggered `ade_relay_suppressed`
  analytics event (coarse attempt count + `control_replaced` code, no URL,
  `machineKey`, or close reason) is captured per suppression episode.
  Control observability
  preserves the causal failure rather than replacing it with a generic WebSocket error:
  upgrade rejection captures the HTTP status and at most 512 sanitized response
  bytes; close telemetry records code, reason, and whether the socket opened.
  `sync_tunnel.claimed`, `.claim_failed`, `.control_open`, `.control_error`,
  `.control_close`, `.self_probe_ok`, `.self_probe_failed`,
  `.self_probe_at_capacity`, and `.zombie_control_detected` are the structured
  lifecycle events. `routeHealth.relay`
  exposes `skipReason` / `lastControlError` plus the end-to-end verdict, while
  `lastControlOpenAt` and `lastBridgeValidationAt` retain the two independent
  success histories. It also carries `relayControlSuppressed`,
  `relayControlSuppressedReason`, and `relayControlFailingSinceMs` — the last
  being the start of the *current uninterrupted* outage, which `lastFailureAt`
  can never express because it restamps on every retry. Suppression outranks
  every other reason in both the `ade doctor` relay row and the desktop banner,
  since nothing downstream can succeed while another process owns the slot and
  no other reason tells the user what to do about it.
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
  latches so it stops delivering across restarts.
- `apps/ade-cli/src/services/push/attentionItemBuilder.ts` — the Activity
  projection itself, lifted out of the publisher's closure so it can be
  exercised with a plain context record instead of a booted publisher.
  `(runs, recentRuns, prActivities, roster) → AttentionItem[]`: identity-chat and
  child-shell filtering, phase derivation (including holding a completed turn at
  `running` while background subagents live), the title/preview tables, the
  2 h / 24 h / 7-day lifetimes, and `attentionProjectRef`.
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
  worth notifying about.
- `apps/desktop/src/shared/types/attention.ts` — cross-client item, snapshot,
  destination, availability, preference, and native-presentation contract.
  `ATTENTION_CONTRACT_VERSION` is the *item* contract; the publish protocol
  version is separate (see `push-notifications.md`). It also owns the
  acknowledgment mechanics every shell shares:
  `ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT` (64, derived from the relay's own
  bound), `chunkAttentionAcknowledgmentItemIds`, `runAcknowledgmentChunks` (with
  the abort-on-first-failing-chunk policy), and
  `AttentionAcknowledgmentOutcome`.
- `apps/desktop/src/shared/attention/activityStateGroup.cases.json` — the
  cross-language conformance fixture for the five-group state table. The mapping
  is implemented four times (renderer TypeScript, native notch Swift, iOS Swift,
  and the hermetic relay Worker) because the surfaces cannot share code, and
  documentation alone did not keep them in step. Every implementation runs these
  cases through its own mapper. Canonical source of truth:
  `activityStateGroup` in
  `apps/desktop/src/renderer/components/activity/activityPresentation.ts`.
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
  single account poller, mounted in `AppShell` so the header control and ADE
  Notch stay truthful while `/activity` is closed. It also derives the notch
  toast stream.
- `apps/desktop/src/renderer/components/activity/HeaderActivityControl.tsx` —
  the global-header count (the `needs-you` group and nothing else) and its
  popover preview, which shows every state section except `done`.
- `apps/desktop/src/renderer/components/activity/ActivityPane.tsx` — the
  `/activity` two-column pane, with `ActivitySessionsColumn.tsx` (the agent feed,
  one section per state group, split per machine and divided where an offline
  machine's rows become last-known state), `ActivityInboxColumn.tsx` (the
  Notifications column: PR/CI and review outcomes grouped by project),
  `ActivityFilters.tsx` (machine / chat type / model, every option derived from
  the snapshot on screen), and `ActivityDetailSheet.tsx`.
- `apps/desktop/src/renderer/components/activity/ActivitySectionHeader.tsx`,
  `activitySectionCollapse.ts`, `ActivityStateGlyphMark.tsx`,
  `ActivityAllClear.tsx`, and `useAllClearBeat.ts` — the shared section header
  (the whole strip is the button, with the `<h3>`/`<h4>` outline preserved for
  screen readers), per-surface collapsed-section memory, the Phosphor half of the
  state glyph language, and the all-clear beat that fires on the transition to
  zero raised hands and never on arrival.
- `apps/desktop/src/renderer/components/activity/ActivityCard.tsx` and
  `ActivityCardSkeleton.tsx` — the row and its fixed-height placeholder. The
  card deliberately does **not** reuse `terminals/SessionCard`: an Activity row
  frequently belongs to another machine, and `SessionCard`'s settle/snooze
  controls call this Mac's local session service, where a non-unique session id
  could land the mutation on a same-id local session. The status vocabulary is
  shared instead through the pure `terminals/SessionStatusLabel.tsx`, extracted
  from `SessionStatusSlot` for exactly this reason. Read the comment at the top
  of `ActivityCard.tsx` before "simplifying" it.
- `apps/desktop/src/renderer/components/activity/activityPresentation.ts` — the
  canonical state glyph language: `ActivityStateGroup`, `ACTIVITY_STATE_GLYPHS`,
  `ACTIVITY_STATE_GROUPS` (also the priority order), `activityStateGroup`, plus
  the per-item label/tone/glyph derivation and the detail sheet's
  `activityStateSentence` / `activityStateElapsed`. Change the rule here first;
  the notch, iOS, and relay mirrors follow.
- `apps/desktop/src/renderer/components/activity/activityPriority.ts` — the
  projection every surface reads: `activityFeedItems` (agents only),
  `activitySections` (one per state group, empties included),
  `activityNotificationItems` (non-agent, inbox-eligible),
  `activityFeedOrder` (what the notch mirrors), and the counts/leading-group
  helpers that replaced four hand-written priority ladders.
- `apps/desktop/src/renderer/components/activity/useProgressiveRows.ts` — the
  bounded row budget (60, stepped by 60) that keeps long columns cheap.
- `apps/desktop/src/renderer/components/activity/activityNotchLocalSettings.ts`
  — this Mac's offline cache of the notch presentation. Account preferences win
  when loaded. The three original `ade:attention:notch-*` localStorage keys are
  frozen wire for anyone who already made a choice; new settings got new keys.
- `apps/desktop/src/renderer/components/activity/ActivitySettingsPopover.tsx` —
  the gear in both the popover and the pane. It mounts
  `settings/ActivitySettingsControls.tsx` in its `popover` variant, which
  `settings/ActivitySection.tsx` also mounts, so the Settings tab and the
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
- `apps/ade-cli/src/tuiClient/activityPane.ts` and
  `components/ActivityPaneView.tsx` — ADE Code's machine-global `/activity`
  pane and exact-destination acknowledgment flow. The hidden `/attention`
  alias and `attention.call` RPC remain for compatibility.
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
(`apps/desktop/src/preload/preload.ts`): project-scoped
`window.ade.sync.*` calls
goes through `callProjectRuntimeSyncOr(method, params, localFallback)`,
which:

1. Resolves the active project binding. If the window is bound to a
   remote runtime, the call goes over `IPC.remoteRuntimeCallSync` to
   the remote runtime.
2. Otherwise, it calls `IPC.localRuntimeCallSync` against the local
   runtime. In-process sync IPC is used only when no runtime binding is
   available, such as tests or diagnostics.

`window.ade.sync.getLocalStatus(args?: SyncGetStatusArgs)` is the deliberate
exception. Preload invokes `ade.sync.getLocalStatus` directly; main dispatches
`sync.getStatus` through the machine-level `LocalRuntimeConnectionPool`, never
the active window's remote project binding, with only the local in-process
diagnostics service as its unavailable-runtime fallback. This is the path the
Connections This computer projection and local pairing/device controls should use.

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
`SyncListExternalSessionsArgs` / `SyncImportExternalSessionArgs`, and the
runtime-scoped `PersonalChatRemoteCommandAction`s) live in
`apps/desktop/src/shared/types/sync.ts`. The CLI launcher's
provider-to-argv translation is shared with the desktop Work tab
through `apps/desktop/src/shared/cliLaunch.ts`.

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
  `pull_request_chat_sessions` relationship table, and integration proposal
  fields mirrored from desktop schema.
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
  reparent payload building with the optional stack base-branch
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
   the preferred-port retry, adopting any sockets that stayed open.
   A phone that initiated the switch tears down and reconnects against
   the same port; a phone that was merely connected while another
   client switched projects is adopted in place and never disconnects.
   If the switch fails, the previous host is restored so the listener
   is never left unowned.

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

Directory list, delete, rename, and publish operations retry one 401 with a
forced access-token refresh. Only a repeated 401/403 is classified as
`auth_expired`; timeouts, server failures, and temporary token-verifier/JWKS
failures remain retryable and do not erase pairing trust. Rename is an
owner-scoped `PATCH /account/machines/:machineKey` with an additive, nullable
`customName` capped at 80 characters. Registration updates the reported
hostname and reachability lease but never overwrites that custom name. Clients
preserve both values and use `customName`, then the reported hostname, as the
display precedence.

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
device has not acknowledged it (`pairingStore.hasPendingRotation`). Adoption
writes through rather than staging, which would discard the staged secret and
leave the device's `pairing_commit` with nothing to promote. That hello answers
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
        "roster_subscribe" | "roster_unsubscribe" |
        "roster_snapshot" | "roster_delta" |
        "brain_status" |
        "project_catalog_request" | "project_catalog" |
        "project_catalog_chunk" |
        "project_switch_request" | "project_switch_result" |
        "command" | "command_ack" | "command_result" |
        "rpc_open" | "rpc_data" | "rpc_close" |
        "fwd_open" | "fwd_data" | "fwd_close" |
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
| `host_update_required` | The host cannot verify ADE accounts yet. | Update ADE **on that machine**. Never destroy a saved pairing. |
| `account_session_changed` | The host's account session moved under the handshake, or the ingress cannot finish this sign-in shape. | Sign in / retry. Never destroy a saved pairing. |
| `relay_account_required` | The route needs an account-authenticated hello. | Sign in on this device. |
| `connection_attempt_superseded` | Another route won the same attempt. | Nothing is wrong; drop this attempt quietly. |
| `invalid_hello` | The payload was malformed. | Client bug or version skew. |
| `protocol_version_mismatch` | Version floor/ceiling, as above. | Update the side named by `updateTarget`. |

`host_update_required` and `account_session_changed` exist because
`auth_failed` reads as "pair again" on every client, and that is the wrong — and
destructive — instruction for a host that simply cannot verify accounts yet or
whose session moved mid-handshake. Where a rejection *can* legitimately lead a
client to drop a saved pairing, the host also attributes itself with
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

### Transport readiness and path truth

Relay controllers negotiate bridge readiness before sending an ADE envelope.
They first open `wss://…/connect/<machineKey>?ready=2`. A current Worker sends
`{"t":"accepted","v":2}` immediately, then sends
`{"t":"ready","v":2}` only after the runtime control pipe and validated
loopback listener are both open. ADE `hello` is forbidden before `ready`.
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
results are intentionally narrow: `work.runQuickCommand` and
`work.startCliSession` keep only the returned `sessionId` / `ptyId`
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
| Chat roster | Machine-wide all-projects projection of every project's lanes + work sessions grouped by lane — agent chats, their attached shell rows, and standalone CLI (tracked terminal) sessions, live **and** ended — so the mobile Hub renders every project's sessions at once **without activating each project**. `roster_subscribe` (handshake mirrors `chat_subscribe`, with an optional `sinceSeq`) → `roster_snapshot` then incremental `roster_delta` (`changed` upserts whole project entries, `removed` lists dropped `projectId`s). Un-booted projects are read cheaply from disk — each project's `<root>/.ade/ade.db` (read-only, no cr-sqlite / no runtime boot) plus `.ade/cache/chat-sessions/*.json` — so their session status is limited to the last-persisted `idle`/`ended`/`awaiting`; live `running`/`awaiting` fidelity is overlaid only for scopes currently booted on the runtime (booted scopes also overlay PTY liveness so a live standalone CLI session reads `running`). `attentionCount` counts awaiting/failed **chat** rows and their attached shells only — standalone CLI failures never count, so a long-dead CLI exit can't pin a project to the top of the hub. Rows carry `toolType` so the phone routes chat rows to the chat surface and CLI rows to the terminal path. Transcripts are excluded from the roster and load on demand after a row tap activates the owning project; the Hub cover exposes switching/hydration progress and an error with Retry instead of silently ignoring an unhydrated project. Oversized snapshots ride the generic `envelope_chunk` path. A host without a roster provider (single-project desktop) simply never answers `roster_subscribe`, so the phone falls back to the active project only | iOS Hub |
| Command routing | Send named actions (`chat.send`, `lanes.create`, `git.push`, `prs.getMobileSnapshot`, `work.listExternalSessions`, `work.importExternalSession`, etc.) | Controller devices |
| Project switching | `project_catalog` + `project_switch_request/result` for multi-project runtimes | iOS project hub |
| Project actions | Runtime-scoped project browser plus open/create/clone/list-GitHub-repos/default-parent-dir/forget envelopes. Available from the active project host or the machine-wide fallback handler before a project is selected | iOS project hub |
| Paired desktop runtime | Full newline-delimited runtime JSON-RPC over `rpc_open` / `rpc_data` / `rpc_close`, plus host-loopback TCP previews over `fwd_open` / `fwd_data` / `fwd_close`. Same-account adoption or a Nearby PIN pairing obtains the required host grant internally; there is no user-facing Share link. Client-claimed device metadata never authorizes either channel | ADE desktop remote machines |
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
  accepted only when the shared listener verified that the socket came from
  ADE's in-process cloud-relay bridge. The tunnel client attaches a private,
  per-process 256-bit proof to its loopback WebSocket upgrade; the listener
  validates the decoded proof with a constant-time comparison and carries the
  resulting `relay-bridge` provenance through parked-socket host handoffs.
  Missing, forged, or stale proof fails closed as a direct connection. The
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
  this release retain their saved local/direct reconnect path. Direct pairing
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
- **Secrets never sync.** `.ade/local.secret.yaml` (provider API keys,
  ADE CLI configs) is per-machine. Linear tokens stay in the active
  project's machine-local `.ade/secrets`; GitHub tokens and AI provider
  tokens stay on the runtime machine.
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
  upgrades are HMAC-signed with a per-machine secret. Relay availability now
  follows the host's account session: sign-in starts and advertises it, and
  sign-out stops it. The old Settings/CLI kill-switch and its `enabled` /
  `enabledSetByUser` fields are removed; existing files are rewritten without
  those fields, so machines whose operators had disabled Relay are re-enabled
  when signed in after this release. The live relay URL is also advertised to
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

## Current implementation status

| Component | Status |
|---|---|
| Sync service owned by `ade serve` runtime | Implemented |
| Desktop in-process sync host | Disabled by default (`ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics) |
| Multi-project runtime + `project_switch` handshake | Implemented |
| Hosted web workspace Hub + four-client LRU machine pool | Implemented |
| Hosted web repository tabs with per-binding machine selection | Implemented |
| `SyncRemoteCommandDescriptor.scope` (`runtime` / `project`) gating | Implemented |
| cr-sqlite extension loading (desktop/runtime) | Implemented |
| Pure-SQL CRR emulation (iOS) | Implemented |
| CRR marking for eligible tables | Implemented (dynamic startup) |
| Changeset extraction/application | Implemented |
| WebSocket sync server | Implemented |
| Sync protocol (JSON + negotiated deflate with legacy gzip fallback) | Implemented |
| File access sub-protocol | Implemented |
| Terminal stream sub-protocol | Implemented |
| Chat stream sub-protocol | Implemented |
| All-projects chat roster sub-protocol (`roster_subscribe`/`snapshot`/`delta`, mobile Hub) | Implemented |
| Device registry table | Implemented |
| Desktop peer client + account/Nearby/SSH connection paths | Implemented |
| Sync authority transfer | Implemented |
| Shared ADE scaffold portability for desktop clones | Implemented |
| PIN-based phone pairing + per-device secrets | Implemented |
| Live chat-event push from runtime | Implemented |
| Mobile project catalog + project switch handoff | Implemented |
| Mobile project actions (browse/open/create/clone/list GitHub repos/remove from list) | Implemented |
| Brain-level shared listener (peers adopted across project switches) | Implemented |
| Bidirectional chunked envelopes (`envelope_chunk`, 720 KiB frame budget, 30 s bounded reassembly) | Implemented |
| Typed sync protocol version floor/mismatch (`hello_error`, close `4406`) | Implemented |
| Per-host-DB sync cursors (`serverDbSiteId` / `remoteDbVersionBySite`) | Implemented |
| Resumable chat streams (per-session `seq` + `sinceSeq` replay buffer) | Implemented |
| Mobile changeset diet (heavy never-read tables filtered for phones) | Implemented |
| Lane presence decoration (`devicesOpen`) | Implemented |
| PR mobile snapshot (`prs.getMobileSnapshot`) | Implemented |
| iOS local replicated DB | Implemented |
| iOS Lanes / Files / Work / PRs / Settings tabs | Implemented |
| QR pairing UX | Implemented (payload v3 smart URL + iOS camera scanner; PIN entered separately) |
| Device-bound pairing (DPoP, Secure Enclave P-256) | Implemented (host + brain ingress; `requireDpop` / `ADE_SYNC_REQUIRE_DPOP`) |
| Cloud tunnel relay (off-LAN transport, `relay` candidate) | Implemented whenever the host is signed in, with no separate toggle and with same-account per-connection proof (`syncTunnelClientService` + `apps/tunnel-relay`) |
| Relay end-to-end self-probe + zombie-control detection (honest relay publication) | Implemented (`syncRelaySelfProbe`, JSON control keepalive, `sync.runSelfProbe`, `ade doctor` relay check) |
| Relay tunnel + account-directory publisher gated on the machine sync-host lease | Implemented (`syncHostSingleton` authority registry, `relayTunnelAuthorityGate`, `runServe` publisher gate) |
| Account publication + relay for a machine with no registered project | Implemented (`projectlessSyncSnapshot`, `machineRelayTunnel`, `runServe` publisher snapshot fallback) |
| One hello parser + one account-hello gate chain across both ingresses | Implemented (`syncHelloProtocol`, `syncAccountHelloAuth`) |
| Machine-level pairing PIN / device forget / DPoP posture on a projectless brain | Implemented (`brainMachineSyncStores`, `ProjectlessSyncControls`, `withSyncService`) |
| Code-first `hello_error` classification with non-destructive `host_update_required` / `account_session_changed` | Implemented (desktop `classifyPairedRuntimeFailure`, web `SyncConnection`, iOS `syncCodeIsPairingRejection`) |
| Relay eviction (`4505`) suppression + surfaced outage | Implemented (bounded re-attempts, 10-minute re-arm, `routeHealth.relay.relayControlSuppressed*`, `ade doctor` relay row, desktop `relay-offline` banner) |
| Sealed account adoption over direct routes (`ade-adopt-v1`, host `pubkey` identity, LAN → tailnet → Relay fallback, negotiated ChaCha20-Poly1305 / AES-256-GCM AEAD) | Implemented (`machineIdentitySigningStore` + `adoptChannelCrypto`; desktop + iOS clients) |
| Legacy manual-pairing adoption into an account (DPoP-gated) + `localTrustOrigin` demotion on sign-out | Implemented (`syncPairingStore.pairPeerViaAccount` / `revokeAccountOwnedExcept`, `syncHostService` account hello) |
| Push notifications + Live Activities (APNs relay) | Implemented (see `push-notifications.md`; on-device E2E needs a physical iPhone) |
| Tailscale integration | Implemented (address candidate + mDNS TXT + per-node `tailscale serve` publication on the live sync port) |
| Clean, published lane + Work chat handoff between connected desktops | Implemented ([contract](./cross-machine-session-handoff.md)) |

## Gotchas

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
