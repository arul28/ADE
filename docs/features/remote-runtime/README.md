# Remote Runtime

The desktop drives a DAEX runtime (`daex serve`, the "brain") on another
machine. The project lives there; lanes, PTYs, Git, chats and PR actions run
there. The local desktop is a controller and starts no project services for a
remote binding.

The normal transport is **paired**: same-account adoption (no PIN) or Nearby +
the six-digit PIN. Both create device-bound DPoP credentials and carry runtime
JSON-RPC over the machine's sync WebSocket, trying LAN, then tailnet, then DAEX
Relay (when both machines are signed in to one account). **SSH** is the Advanced
path: the same JSON-RPC over `daex rpc --stdio`, with upload or start of the
remote runtime. Relay is not end-to-end encrypted.

The CLI is `daex`; `ade` still works. File, env and service names keep `ade`
for compatibility (`ADE_HOME`, `~/.ade`, `ade.sock`, `com.ade.runtime`,
`ade-<platform-arch>` binaries).

See also [internal architecture](internal-architecture.md) and
[sync and multi-device](../sync-and-multi-device/README.md).

## Source file map

### Connections (`apps/desktop/src/main/services/remoteRuntime/`)

- `remoteConnectionPool.ts`, `remoteConnectionService.ts` — the pool: paired
  first with eligible SSH fallback, replay-safe reads, event gap/epoch handling,
  route-pinned sensitive actions, unknown-outcome errors for non-replayable
  writes, fast redial and the reconnect hold.
- `syncRuntimeTransport.ts`, `syncPortForwardClient.ts` — paired transport and
  preview port forwards.
- `syncPairedMachineStore.ts` — paired credentials and endpoint history; only
  `forgetEndpoint` removes an address (one that answered as another host).
- `pairedRuntimeRoutes.ts` — route order and failure classification
  (`classifyPairedRuntimeFailure`); two silent failures rank an address last; a
  `4505` relay close is retried once (`isRelayHostReplacedError`).
- `pairedRuntimeErrors.ts` — `PairedRuntimeHelloRejectedError` carries the
  host's `hello_error.code` and identity; `PairedRuntimeRpcOverBudgetError` is
  never "unreachable".
- `remoteBrainStart.ts` — `user` vs `background` connects and the
  `daex brain start` path for a stopped remote brain.
- `remoteEventSetup.ts` — the 2-minute ceiling on event setup
  (`REMOTE_EVENT_SETUP_TIMEOUT`).
- `remoteDialTelemetry.ts` — one record per outage of why dials failed.
- `remoteLinkMeter.ts`, `remoteAttachmentParts.ts` — link-sized bulk reads and
  resendable paste parts.
- `remoteSidecarCache.ts`, `remoteBootstrap.ts` — SSH bootstrap and the release
  download of a missing `ade-<target>` sidecar.
- `remoteTerminalUpdate.ts` — `daex brain update` typed into a terminal for a
  Windows machine that cannot self-install.
- `connectionDoctor.ts` and `apps/desktop/src/shared/connectionDiagnosis.ts` —
  Test connection and the one wording module for failures.
- `attachmentUploadRoute.ts`, `attachmentUploadClient.ts` — HTTP attachment
  upload on direct routes.

### Desktop main and preload

- `apps/desktop/src/main/services/ipc/runtimeBridge.ts` — the runtime IPC
  boundary: targets, connect, project open (per-window generations), action /
  sync / event dispatch, port forwards, `updateAndRestart`, `callMachineMethod`
  for main-process callers with no binding.
- `apps/desktop/src/main/services/ipc/runtimeEventSubscriptionRegistry.ts` —
  event subscriptions keyed by sender, binding and category; idle entries
  expire after 180 s.
- `apps/desktop/src/preload/preload.ts` — routes runtime APIs to the active
  binding or an explicit pin (`callPinnedOrBoundRuntimeActionOr`); the bridge is
  `satisfies Window["ade"]`, so a missing `pin` does not compile.
- `apps/desktop/src/preload/pinnedRuntimeEvents.ts`, `remoteTargetGate.ts` —
  event pumps for pinned bindings; the preload answers for a manually
  disconnected machine.
- `apps/desktop/src/main/services/machines/machineConnector.ts` —
  `machines.connect` (one flight per machine).
- `apps/desktop/src/main/services/account/accountBridge.ts`,
  `localMachineIdentity.ts` — account adoption and the local machine identity.
- `apps/desktop/src/main/services/projects/windowTabRootAuthorization.ts` —
  which local roots a window may act on.
- `apps/desktop/src/main/services/chat/sessionInputOrigins.ts`,
  `apps/desktop/src/shared/sessionInputOrigin.ts` — which desktop last messaged
  a chat.
- `apps/desktop/src/main/services/builtInBrowser/` — remote browser requests and
  calls (`remoteRequestClaims.ts`, `builtInBrowserRemoteCalls.ts`).

### Local brain and its service

- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` —
  the local brain connection: compatibility window (`minCompatibleProtocol` vs
  `RUNTIME_COMPAT_LEVEL`), service install and repair backoff, the app-fallback
  brain (`--no-sync`, "Fix it" banner), `probeMachineRuntimeIdentity()`,
  `olderBrainRetirement.ts`.
- `apps/desktop/src/main/services/runtime/projectRecoveryService.ts`,
  `lastFailureStore.ts` — diagnosis, ordered repair, `restartBrain()`; see
  [storage and recovery](../storage-and-recovery/README.md).
- `apps/ade-cli/src/serviceManager/` — launchd, systemd and Windows supervisor
  install; `serviceHandover.ts` (one handover for all three);
  `runtimeServiceBudgets.ts` (every start timeout in one file);
  `installLaunchdWatchdog.ts`; `windowsSupervisor.ts`.
- `apps/ade-cli/src/services/runtime/` — `brainHeartbeat.ts`,
  `brainWatchdogCheck.ts`, `brainStartupState.ts`, `connectWhileServiceStarts.ts`,
  `awaitRuntimeServiceEndpoint.ts`, `machineUpdateAndRestart.ts`,
  `machineUpdateInFlight.ts`, `desktopAppUpdateBridge.ts`, `hostStallRecord.ts`.
- `apps/ade-cli/src/services/projects/` — machine project registry, lazy
  per-project scopes (startup boots only the sync-host project),
  `projectIconResolver.ts`.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — `projects.*` (list with icons,
  `inspectRemoval` / `removeCopy`, handoff storage preflight), `sync.*`,
  `runtimeEvents.*`, `machine.updateAndRestart`.
- `apps/ade-cli/src/backgroundActionJobs.ts`, `connectionLinkSummary.ts`,
  `lib/brainConnectionLoss.ts` — long actions by id, link summaries,
  `brain_connection_lost`.
- `apps/ade-cli/src/services/account/machineBridge.ts`,
  `agentMachineBridge.ts`, `pairedRemoteConnector.ts` — brain-to-brain pools and
  `daex machines connect`; see
  [cross-machine agents](../sync-and-multi-device/cross-machine-agents.md).

### Renderer

- `apps/desktop/src/renderer/components/remoteTargets/` — the Machines panel:
  rows (`SavedMachineRow.tsx`, `MachineIdentity.tsx`, `remoteMachineModel.ts`),
  `RemoteErrorCard.tsx`, `ConnectionRouteDetails.tsx`,
  `ConnectionDoctorPanel`, `machineUpdateStatus.ts`, `machineUpdates.ts`,
  `MachineUpdateImpact.tsx`.
- `apps/desktop/src/renderer/components/app/projectTabGrouping.ts`,
  `apps/desktop/src/shared/projectIdentity.ts`, `machineIdentity.ts` — one tab per
  repository (joined on git origin); `THIS_MACHINE_ID`, `machineDisplayName`.
- `apps/desktop/src/renderer/state/crossMachineLanes.ts`,
  `connectRepositoryCopies.ts` — the cross-machine Work union and background
  joins.
- `apps/desktop/src/renderer/lib/chatMachineRouting.ts`,
  `components/chat/ChatRuntimeScope.tsx`,
  `components/terminals/useWorkMachineRouter.ts` — per-session pins.
- `apps/desktop/src/renderer/components/lanes/laneMachines.ts`,
  `apps/desktop/src/shared/laneDivergence.ts` — the machine choice at lane
  creation and the push guard.
- `apps/desktop/src/shared/slowLinkMode.ts`,
  `apps/desktop/src/shared/backgroundActionJob.ts` — slow-link rule and
  background jobs.

### DAEX Cloud (brain side)

- `apps/ade-cli/src/services/cloudChats/` — `cloudChatUploader.ts`,
  `cloudRestSave.ts`, `cloudChatMessageQueue.ts`, `chatIdleWait.ts`,
  `cloudChatRestore.ts`.
- `apps/ade-cli/src/services/account/cloudBootLaunch.ts`,
  `accountLaneIndexPublisher.ts`.
- `apps/ade-cli/src/services/power/cloudPrepareStop.ts`, `cloudKeepAwake.ts`.
- `apps/ade-cli/src/services/github/cloudGitIdentity.ts`.
- `apps/desktop/src/main/services/adeCloud/` — see [DAEX Cloud](../ade-cloud/README.md).

### Build and install

- `apps/ade-cli/scripts/build-static.mjs` — the `ade-<platform-arch>` SEA binary
  and `.native.tar.gz`.
- `apps/ade-cli/scripts/install-runtime.sh`, `install-runtime.ps1` — the
  install scripts.
- `apps/desktop/scripts/runtime-resource-targets.cjs`,
  `materialize-runtime-resources.mjs`, `validate-runtime-resources.mjs`,
  `assert-runtime-resource-target.mjs` — runtime resources for packaging.

## Gotchas / fragile areas

- **Every action goes to the item's own machine.** Pass the item's pin
  (`pin?: OpenProjectBinding | null`) through `callPinnedRuntimeAction` or
  `callPinnedOrBoundRuntimeActionOr`. A call with no pin goes to the tab's
  machine; it works locally and fails with "Chat session '…' was not found" when
  the item is elsewhere. `null` is only for this computer's machine-global calls
  in Settings.
- **Where to read the pin:** `useChatRuntimeScope().pin` (and
  `.isActiveBinding`) in a chat subtree; `foreignRow.binding` or
  `useWorkSessions().resolveSessionRuntimePin` on Work; `LaneMachine.pin` on
  Lanes; `useSettingsMachineScope().pin` in Settings. "Another machine" UI reads
  `isActiveBinding` or `usePinTargetsTab`, never a null pin.
- **Keep the pin for the whole flow**, and key effects on `pin?.key`, not the
  object.
- **A new action must be reachable remotely**: an action domain and an
  `actionPolicy` entry, or the remote brain refuses it.
- **Writes are not replayed after a drop.** Only `isReplaySafeAdeAction` actions
  replay; the rest report an unknown outcome.
- **`crossMachineLanesByMachineId` lives only in the root store.** Use
  `useRootAppStore` hooks; `useLanesForPin` is the only lane list a pinned lane
  id may resolve against (lane ids are unique per machine).
- **An account-answered pin never dials.** A resting DAEX Cloud lane is read
  from the account server; opening it never wakes the computer
  (`CloudComputerAsleepError` opens the DAEX Cloud tab instead). See
  [DAEX Cloud](../ade-cloud/README.md#daex-cloud-with-no-computer-of-your-own).
- **A dev desktop never auto-connects** (`explicitConnectOnly`), because a paired
  host keeps one connection per device and every DAEX on a computer shares the
  pairing. `ADE_DEV_REMOTE_AUTOCONNECT=1` turns it back on.
- **Diagnose tailnet ports with `netstat -an -p tcp` or `tailscale serve
  status`, not `lsof`**: tailscaled runs as root, so a user probe reports its
  ports as free.

## User model

A **remote target** is another DAEX machine reachable by a paired route, SSH or
both. A **remote project** is a path registered with that machine's runtime
(`projects.add`). Opening one copies nothing; Git moves code between clones, and
**Continue on another machine** is the explicit chat handoff
([cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md)).

Direct trust (Nearby + PIN, SSH) lives on this desktop and survives sign-out.
Account adoption is account-owned: tagged with the Clerk user id and removed on
sign-out or account switch. A changed SSH host key or host pairing identity
needs explicit trust again.

## One repository, many machines

A repository is one tab; checkouts on different machines (same normalized git
origin) are a machine dropdown inside it. "Remote" is never a machine name
("This computer", "MacBook Pro (97)"). The tab's machine drives Lanes, PRs,
Files and Run. Two things are wider:

- **The Work sidebar is a union** of in-flight sessions on every connected
  machine for this repository. Offline machines' rows are hidden, not deleted
  (rows leave after the machine is gone, proves the repo missing, or is
  unreachable 24 h).
- **A session owns its Work tools.** Opening a chat, CLI or shell from the union
  streams it from its machine with pinned calls; the tab stays bound where it
  was. Clicking a foreign *lane* is the explicit machine switch.

Lane creation picks the machine (by origin; a folder-name match is a guess that
never rebinds). Push warns when another machine holds the same branch with
unpushed commits (`laneDivergence.ts`). Removing or disconnecting a machine falls
the tab back to another checkout; only a repo that lives nowhere else closes.

## Connect flow

1. **Connections › Machines** lists same-account machines, plus Bonjour and
   Tailscale discovery (this machine's own advertisement removed, routes for one
   machine merged). Discovery also runs at launch and on wake.
2. **Same-account connect** dials the directory-verified Relay; when the row
   carries the host's Ed25519 `pubkey`, adoption may also use Tailscale and LAN
   with sealed `ade-adopt-v1`
   ([sync security model](../sync-and-multi-device/README.md#security-model)). A
   host-identity failure aborts at once. A connect locks only its own row; its
   Cancel is a manual disconnect.
3. **Paired connect** dials LAN → tailnet → relay, preferring recent successes.
   After `hello_ok` it needs `features.rpcChannel`, then opens runtime JSON-RPC
   and the port-forward channel. Relay needs this client signed in to the same
   account as the host; otherwise **Sign in to DAEX**.
4. **SSH fallback** happens only for a paired target that came from an Advanced
   SSH route; Nearby routes are never reinterpreted as SSH.
5. **SSH (Advanced)**: host, user, port, optional key (else ssh-agent and
   `~/.ssh/config`). Unknown host keys need **Trust & connect**. Each alternate
   route goes as `-o HostName=<route>` so the saved `Host` alias still applies;
   `StrictHostKeyChecking=yes` always. One 45-second startup deadline covers
   account resolution, paired dials and the SSH probe matrix.
6. **SSH bootstrap** detects the platform (`uname -sm`), uploads the runtime,
   native deps, PTY worker and agent skills into the channel home when missing
   or stale, then asks the runtime to authorize this desktop as a paired device
   and upgrades the target to paired-first. Windows clients need the OpenSSH
   Client (`Add-WindowsCapability` is named when missing).
7. Pick or register a remote project (`projects.add { rootPath }`).

Targets persist `autoConnect` (Connect turns it on, Disconnect off) and this
computer's `slowLinkMode`. Implicit reconnects back off 30 s → 5 min forever,
except failures no redial fixes (pairing or identity rejected, account will not
vouch), which wait for the person. Remote recents are keyed
`remote:<targetId>:<projectId>`. Alpha uploads to `~/.ade-alpha/`; Beta is a
track of the normal install.

`daex machines connect` uses the same target registry and paired store; an
account-created SSH-shaped record is adopted into the paired store or fails
closed, never retried as SSH.

### A remote machine whose brain is not running

The POSIX SSH relay runs `daex --socket … rpc --stdio`, which never spawns a
brain, so a stopped machine answers `ENOENT` / `ECONNREFUSED`.

- A connect the person asked for (`"user"`) runs `daex brain start --text` over
  SSH and redials every 2 s for up to 90 s (`REMOTE_BRAIN_SOCKET_WAIT_MS`).
- A background connect never starts a brain; nor does a layout with service
  install disabled (`ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1`, Alpha).
- The error names the command to run on that machine. A Windows remote starts a
  brain from the relay itself, so the message shows the PowerShell command.

Time limits: paired `ade/initialize` + first `projects.list` 30 s
(`PAIRED_RUNTIME_HANDSHAKE_TIMEOUT_MS`); SSH 90 s; event setup 2 min
(`REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS`), with the IPC budget for
`streamEvents` just above it so main names the step that hung. When the brain's
socket drops under the relay, calls in flight get `brain_connection_lost` with
structured data only (brain state, heartbeat age, errno, log event names).

### When the connect fails, the user reads one sentence

Main classifies the attempts and picks the dominant cause
(`RemoteRuntimeConnectErrorInfo.failure`); the UI keys headline and action on
it, never on message text. Hosts, ports, durations and the diagnostic id stay in
the collapsed **Details** (`ConnectionRouteDetails.tsx`).

| `hello_error.code` | Attempt failure |
| --- | --- |
| `repair_required`, `auth_failed` | `pairing` |
| `relay_account_required` | `authentication` |
| `connection_attempt_superseded` | `superseded` (not a fault) |
| `invalid_hello`, `protocol_version_mismatch` | `protocol` |

A host that names itself in `hello_error.host` but is not the saved host is
`identity` (`PairedRuntimeHostMismatchError`) and the address is forgotten.
**Pair again** appears only when the rejecting machine is in this account's
directory; nothing re-pairs on its own. Account adoption keeps its own classifier
(`classifyAccountMachineAdoptionFailure`).

### Which part failed: the connection doctor

- **Test connection** (`ConnectionDoctorPanel`, `connectionDoctor.ts`) probes
  every route; relay close `4501` is `host_offline`, an unresolvable relay name
  is `no_network`. A probe hello sets `peer.connectionPurpose: "probe"`; against
  a host without `features.connectionProbe` while this app is connected, it only
  opens routes, so it cannot supersede the live connection.
- **Check** on the This computer card (`sync.checkReachability`,
  `hostReachabilityCheck.ts`) asks this computer's brain: listener, relay control
  and bridge, a real relay self-probe, Tailscale (including an exit node that
  blocks the relay), account, recent freeze.
- **On <machine>** runs the same check on a connected remote machine.
- **A frozen host says so.** `hello_ok.hostHealth.lastStall` (for 5 minutes,
  with an age) and `hostHealth.storageWait` (a folder waiting on a permission
  prompt, also pushed as a `host_health` envelope) let clients show "DAEX there
  was too busy to answer" or "macOS is asking on Studio's screen…" instead of a
  network error. See
  [storage and recovery](../storage-and-recovery/README.md#a-folder-waiting-on-a-permission-prompt).

## Compatibility warnings

Version and capability skew do not fail a connect. `ade/initialize` returns
`capabilities.machineProjects`; missing ones (`browseDirectories`, `create`,
`clone`, …) become `compatibilityWarnings`, and the pool refuses the matching
call with a self-describing error. The row's version chip shows `X → Y`; the
older machine is the one to update. A channel mismatch or a fallback to another
channel home is also a warning.

## Runtime artifact layout

A desktop package carries only its own target's `ade-<platform-arch>` binary
and `.native.tar.gz` in `apps/desktop/resources/runtime/` (all five would push
the macOS update ZIP past the Squirrel.Mac limit).
`runtime-resource-targets.cjs` is the one list (`darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`, `win32-x64`) and modes: `ADE_RUNTIME_TARGET=<target>`
(exclusive; release jobs), `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1` (local), or
full. Three stages enforce target mode: `assert-runtime-resource-target.mjs`,
`validate-runtime-resources.mjs` and electron-builder `afterPack`. Packages also
carry `apps/desktop/resources/agent-skills/`, which SSH bootstrap copies into the
remote DAEX home.

Local same-platform packaging:

```bash
npm --prefix apps/ade-cli run build:static -- --target <target> --out-dir ../desktop/resources/runtime
```

### Sidecar fetch fallback

A desktop provisioning another platform downloads the missing sidecar
(`remoteSidecarCache.ts`, entry point `resolveBootstrapRuntimeSidecars`):
bundled → cache → release, at **this desktop's exact version** (a dev build is
`unavailable`). Assets are checked against the release's `SHA256SUMS`, staged,
and published atomically to `<ade home>/runtime-sidecars/<tag>/<target>/`.
`unavailable` is never fatal; `network` is fatal only for a first install;
`checksum` is always fatal.

## Standalone runtime install

```bash
curl -fsSL https://ade-app.dev/install.sh | sh
```

```powershell
irm https://ade-app.dev/install.ps1 | iex
```

`apps/web/api/install.ts` proxies the release assets. The script
(`apps/ade-cli/scripts/install-runtime.sh`) downloads the binary, native archive
and `SHA256SUMS`, verifies them, installs to `$ADE_INSTALL_DIR` (default
`$ADE_HOME/bin`), runs `daex brain start` (not `serve --install-service`, which
would register the brain at role `agent`), then hands off to `daex setup`.
Overrides: `ADE_VERSION`, `ADE_INSTALL_DIR`, `ADE_RELEASE_REPO`, `ADE_HOME`.
Windows 10 22H2 / 11 x64 are supported (PowerShell 5.1+, `tar.exe`); WSL, ARM64
and Windows Server are not.

A headless machine is reachable as an SSH target, or published to the account
with `daex connect` (`--headless` over SSH); no project is needed. It updates with
`daex brain update --text` (staged under `$ADE_HOME/runtime/updates/`, verified,
promoted, service restarted).

### What a standalone brain finds without an app

- **Native helpers** (`nativeHelperPaths.ts`, `simHelperClient.ts`): beside its
  binary, then `$ADE_RUNTIME_ROOT/native/`, then the installed DAEX app's
  resources (the app recorded in `$ADE_HOME/runtime/desktop-app.json`, the
  channel's app in `/Applications`, then a Spotlight hit that passes
  `codesign --verify --strict` with the right team). The Mac Desktop driver
  comes from the app's signed copy, because privacy grants belong to it.
- **The agent CLI** (`bootstrap.ts`): a SEA uses its own executable as the CLI
  entry (`ADE_CLI_PATH`, shim folder on `PATH`); skills from
  `$ADE_RUNTIME_ROOT/agent-skills`, then `$ADE_HOME/agent-skills`, then the app.

## What works remotely

Lanes, chats, PTYs, files and watchers, Git, PRs, stacks, conflict and issue
sessions, handoff acceptance and event streams all route to the remote runtime.
Lane preview URLs open through a local TCP forward. A remote tab shows the
host-resolved project icon (inlined on `projects.list`). Agent CLI download and
sign-in cards run on the chat's machine.

### Which desktop shows it

Two desktops can show one chat. Preload stamps `chat.sendMessage`,
`chat.steer` and a CLI Enter with `inputOrigin: { clientId, local }`
(`window.ade.app.desktopClientId`); the runtime keeps the last stamp per session
in memory, and an unstamped message (phone, CLI, agent) resets it. Agent calls
cannot supply a stamp. `daex ui show`, floating offers, forwarded browser opens
and Apple drawer reveals carry `targetClientId`; a desktop acts only when the
target is empty or its own id. Unacknowledged requests follow the sender only
while its last message is under 10 minutes old (`RECENT_INPUT_ORIGIN_MS`).
Unknown means every desktop acts.

### Dev servers on another machine

The owning runtime detects dev servers (terminal output, shell output, a
listener scan), publishes `dev_server_event`, and answers
`work_tools.listDevServers` / `work_tools.probePort`. Clicking opens the page in
this desktop's DAEX browser through the tunnel; nothing opens by itself.

<a id="the-ade-browser-for-a-remote-chat"></a>

## The DAEX browser for a remote chat

The built-in browser belongs to a desktop; a brain only proxies to it. A pin
changes where `localhost` points and which desktop answers.

- **Loopback tunnels.** For a remote pin, `localizeRemoteLoopbackUrl` rewrites
  `localhost`, `127.0.0.0/8`, `[::1]` and `0.0.0.0` onto a per-(machine, port)
  forward. The first use of a new pair needs a person's yes ("Always for this
  lane" is remembered).
- **A brain with no browser.** `daex browser open` on a headless brain returns
  `forwarded_to_desktop`; a desktop holding a pin for that lane runs it and
  acknowledges. `remoteRequestClaims.ts` lets only the first panel answer.
- **The browser where the user sits.** Agent `daex browser` commands run in the
  desktop that sent the chat's last message, when that is not the agent's
  machine. `BUILT_IN_BROWSER_METHOD_ROUTES` (`desktopBridgeMethods.ts`) gives
  each method a route (`open`, `user-desktop`, `local-file`, `agent-machine`);
  `remoteBrowserForwarder.ts`, `remoteBrowserTabHosts.ts` (one task stays on
  one machine) and `renderer/lib/remoteBrowserCallHost.ts` carry it. Falls back
  to the agent's machine when no desktop answers within 4 s, the last message
  came from the phone or CLI, or `--here`. `upload`, `har` and `record` need a
  local tab. Every result names where it ran (`browserHost`).
- **Chat links** open the chat machine's `localhost` in the DAEX browser.

## A slow or dropping link

Each machine connection measures itself; nothing is global.

- **Slow-connection mode** (`shared/slowLinkMode.ts`): on when two of the last
  three round trips are ≥400 ms or two drops in five minutes; off after five
  round trips under 250 ms with no drop. A ping delayed by a brain freeze
  (`hostFrozenMs`) is not a sample. The state rides the connection snapshot as
  `slowLink` (no new poll). Per machine and per computer: **Automatic**,
  **Always on**, **Off** (`remoteRuntime.setSlowLinkMode`). It holds transcript
  pictures behind a `Show picture` tile and makes plain shells type ahead.
- **Far** (≥150 ms on, <110 ms off; `FAR_RTT_ON_MS` / `FAR_RTT_OFF_MS`) turns on
  type-ahead only.
- **Bulk pieces** are sized to ~250 ms of the measured rate and resumed from the
  same offset; pastes over 128 KiB go in resendable parts; pictures over 1920 px
  get a display copy.
- **Long actions** (`lane.create`, `git.pull`, `pr.land`, archive actions, …) go
  to a brain with `backgroundActionJobs` as a job id; a call sent again after a
  drop joins the same run (outcome kept ten minutes).
- **One send, one copy.** A chat send carries `clientSendId`, resent after a
  reconnect only to a brain with `clientSendDedupe`; `chat.typeIntoCli` uses
  `clientMessageId` with `agentCliTypeNow`.
- **A blip.** A dropped link redials every 2 s for 3 minutes
  (`FAST_REDIAL_WINDOW_MS`). For 20 s (`RECONNECT_HOLD_MS`) the machine still
  reads as connected and calls wait up to 8 s (`RECONNECT_CALL_WAIT_MS`). Cloud
  computers skip the hold.
- **Only shown terminals stream** (`ptyDataIds`; see
  [PTY and sessions](../terminals-and-sessions/pty-and-sessions.md)).
- **Numbers.** `remote.link_summary` (desktop) and `rpc.link_summary` (brain)
  every five minutes, plus `remote.slow_link_switch` and `rpc.link_closed`.

## Mobile reachability

Phones use the paired sync WebSocket (LAN, tailnet or Relay); SSH is only an
optional pairing bootstrap. On desktop, the This computer card and the Phone and
Web tabs always describe the physical computer running this desktop, even when
the window is remote-bound (`window.ade.sync.getLocalStatus`); pairing
mutations are read-only while remote-bound.

## Troubleshooting

- `Remote machine was manually disconnected…` / `Not connected · you disconnected it on <date>` — DAEX waits for Connect.
- `Not connected · Reconnect automatically is off` — the machine's **Reconnect automatically** box (Edit) is off.
- `Remote DAEX service connection failed.` — unreachable; reconnects continue with backoff; Connect skips the backoff.
- `SSH server at <host:port> closed the connection…` — sshd, firewall or Tailscale SSH policy; sshd source penalties after many refusals.
- `SSH authentication failed… DAEX won't retry on its own` / host key mismatch — fix it, then Try again; DAEX stops retrying.
- `Nothing is accepting SSH connections at <host:port>.` — machine off, sshd stopped, or a missing port forward.
- `Uploaded DAEX service version mismatch` — rebuild the static runtime for this desktop version.
- `Remote DAEX service <version> does not support <capability>.` — update DAEX on that machine.
- `…interrupted before DAEX could confirm the action result` — a non-replayable call lost its answer; check before retrying. A handoff retry reconciles by handoff id.
- `Remote DAEX service timed out waiting for method …` — only that request expired; DAEX does not replay timed-out writes.
- **Repair** next to the publish failure — the brain cannot read the account session; Repair restarts `com.ade.runtime`.
- `<Machine> says this device's pairing is out of date — pair it again.` — the host rejected this desktop; other routes' timeouts under Details are noise.
- `wrong machine answered` — that endpoint is forgotten, not demoted.
- "Couldn't look for computers on this Wi-Fi" — a failed Bonjour scan; account computers are still listed.

## Pairing identity and paired-secret lifetime

Each entry in `desktop-paired-machines.json` carries its own `deviceId`, the
host's key for its pairing record, so re-pairing a host must reuse it.
`pairWithMachine` finds the prior identity by `hostDeviceId`, then by the relay
machine key in a `/connect/<key>` endpoint; never by a LAN address (DHCP reuse
would hand the identity to another computer).

Logs: host `sync_host.paired_device_rejected` (`unknown_device` vs
`secret_mismatch`, same answer to the caller) and
`sync_host.paired_account_owner_mismatch`; `sync_host.peer_closed_without_frames`
at debug for probes and scans; desktop `account.local_machines_removed` at warn
in the machine-scoped `<machine .ade dir>/runtime/account-trust.jsonl`.

## Relay tunnel and the sync port

The relay tunnel client is cached one per machine and is often built by a scope
that owns no listener, so it must not capture listener state at construction:
the listener owner calls `attachHostListener()` (port, nonce, bridge proof).
Symptom when wrong: listener bound and validated, `relayBridgeValidated` false,
`lastBridgeValidationAt` never set. Whether a runtime may dial Relay at all is
`relayTunnelAuthorityGate` on the sync host lease; a `4505` close suppresses
redials (60 s floor, then stop, re-armed after 10 minutes) and shows as
`relayControlSuppressed`.

DAEX publishes `tailscale serve --bg --tcp=<port>` and, for browsers, an HTTPS
route `--https=<sync port + 10000>` (`createTailnetHttpsServe`, advertised as a
`tailnet` endpoint `wss://<name>.ts.net:<port>`; needs MagicDNS and HTTPS certs,
reported as `needs_magic_dns` / `needs_https_certs`). Both outlive the process,
so stale DAEX entries (same-port forwards inside the sync range) are reclaimed
after each publish (`reclaimStaleTailnetServes`); hand-made entries are left
alone.

## Wedge supervision and remote repair

A brain can hang with its process alive. Three layers cover it:

- **In process.** `brainLoopWatchdog` (a worker thread) kills the brain when the
  event loop stalls.
- **External.** The brain writes `<ade home>/runtime/heartbeat.json` every 15 s.
  A watcher kills it only when the beat is older than 90 s, its pid is alive and
  identified, the watcher itself was awake (else `machine_slept`), and a previous
  check saw the same stale beat (else `stale_unconfirmed`)
  (`evaluateBrainHeartbeat`). `ADE_BRAIN_HEARTBEAT_STALE_MS` overrides (≥30 s).
  macOS: the `com.ade.watchdog` agent runs `daex runtime watchdog-check` every
  60 s. Windows: the supervisor loop applies the same rules.
- **Desktop.** `projectRecoveryService.restartBrain` probes and repairs.

A kill leaves `event-loop-wedge.json`; the next start promotes it to
`last-wedge.json` (`runtime/info` `lastWedge`, `brain.recovered_from_wedge`). The
launch agent's `ThrottleInterval` is 10 s so a restart onto a half-replaced app
retries slowly. `brainFreshnessMonitor` restarts into new code when the installed
runtime's hash changes and holds still.

A slow brain is not a broken one: the brain binds `ade.sock` before starting
sync; installers wait `RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS` (30 s, 15 s on
Windows) and return `starting: true` for a live but quiet brain; a brain younger
than 120 s (`RUNTIME_SERVICE_YOUNG_BRAIN_MS`) is waited for, not restarted.
launchd registration is confirmed with `launchctl print` (the exit code of
`load` is never trusted); `daex reset --all` re-enables every DAEX label. A brain
that loses its socket inode to another exits (`socket_owned_by_other`).

### `machine.updateAndRestart`

The projectless method (`cto` role) and the sync commands
`machine.updateImpact` / `machine.updateAndRestart`
(`machineUpdateRemoteCommands.ts`; paired controllers only, not viewers or
guests) update and restart a machine from anywhere. One run per process
(`machineUpdateInFlight.ts`); never automatic.

- The client sends `targetVersion`; a machine already on it restarts nothing. No
  version means "fix a stuck machine" and restarts.
- **Which updater.** The brain first asks this machine's desktop app
  (`app_update.install` via `desktopAppUpdateBridge.ts`; app side
  `apps/desktop/src/main/services/updates/remoteUpdateInstall.ts`). With no app,
  an old app or `unsupported`, it runs the standalone `daex brain update`. A
  Windows build that cannot self-install gets `remoteTerminalUpdate.ts` instead.
  The reply's `route` and `pendingVersion` say which.
- **Nothing restarts without a yes.** The desktop shows what would stop
  (`runtime.updateImpact`: chats mid-turn, open CLIs and terminals; 3 s
  deadline). The client re-reads versions, confirms after reconnect, and reports
  "Still on Y" after 5 minutes (35 for a download).
- **Where.** Settings › General update rows, **Update other machines** on the
  Account page, `MachinesBehindBanner`, and this computer's restart dialog; all
  share `components/remoteTargets/machineUpdates.ts`. The web client cannot
  update a machine.
- A brain update this app did not start writes
  `<ade home>/runtime/update-status.json`, which pauses the desktop's service
  repair so it cannot put an older runtime back.

### Account state and reachability

Relay gating asks "is this machine still theirs". In
`accountAuthService.getStatus()`, `expired` and `unreadable` session states keep
the tunnel and the directory row; only `signed_out` drops them. The relay control
authenticates with machine credentials, and direct routes never consult account
state.

<a id="on-an-ade-cloud-computer"></a>

## On a DAEX Cloud computer

A cloud computer runs the same brain and also keeps the account server current,
so the lane reads with no computer awake. These parts run only when
`isAdeCloudComputer()` is true (except the lane index). Server routes:
[DAEX Cloud](../ade-cloud/README.md#daex-cloud-with-no-computer-of-your-own).

### What the brain saves before it rests

`cloudRestSave.ts` runs, four uploads at a time within one budget: newest chat
parts; shell and CLI copies (50 newest terminals, shells keep 5,000 lines /
2 MiB, redacted, unchanged ones skipped); changed Git summaries; fork capsules
(Claude, Codex, OpenCode chats; Claude Code and Codex CLIs; provider history
only, no Git bundle; a running turn is skipped; over 20 MiB is skipped);
native subagent transcripts (Claude, Muse, OpenCode; 20 newest per chat); and
changed event-wake topics. It runs at the idle step (90 s), in
`daex cloud prepare-stop` (time left), and in `daex cloud save-for-rest` (200 s,
from the server's idle cleanup). State: `<ade home>/cloud/rest-save.json`.

### Messages that waited while it slept

`cloudChatMessageQueue.ts` drains 15 s after start, on sign-in, on wake, and on
`daex cloud messages drain`: claim, send, report `delivered` / `failed`, with a
journal (`<ade home>/cloud/chat-messages.json`) so a crash never sends twice. A
chat waits up to 30 minutes for idle and sends with `clientSendId` = message id.
A CLI gets the text through `typeIntoAgentCliWhenFree`, which waits on the CLI's
turn signal ([turn signals](../terminals-and-sessions/pty-and-sessions.md#exact-turn-status-for-agent-clis)).
A CLI that is gone gets `failed` with a sentence saying so.

### A chat or CLI whose computer was deleted

The server starts a continue launch on a new computer; the brain makes the lane
and restores the chat or CLI with the same id (`cloudChatRestore.ts`), reusing the
handoff destination
([continue on a new cloud computer](../sync-and-multi-device/cross-machine-session-handoff.md#continue-on-a-new-daex-cloud-computer)).

### Other account work

- **Account lane index** (`accountLaneIndexPublisher.ts`, every brain):
  `/account/lanes`, one write 30 s after a change, last set in
  `<ade home>/account-lanes.json`.
- **Git identity** (`cloudGitIdentity.ts`): GitHub noreply, else
  `NEUTRAL_GIT_IDENTITY`; never overwrites a person's value.
- **Being deleted**: new work is refused with a sentence pointing to another
  computer.
- **Provider logins**: the account's sign-ins, plus access-only copies of proxy
  logins (`providerLoginCarry.ts`, no refresh tokens).

## Related docs

- [Internal architecture](internal-architecture.md)
- [DAEX Cloud](../ade-cloud/README.md)
- [DAEX CLI](../../../apps/ade-cli/README.md)
- [Sync and multi-device](../sync-and-multi-device/README.md)
- [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md)
