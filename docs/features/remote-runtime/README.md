# Remote Runtime

The desktop app connects to an ADE runtime (`ade serve`) running on another
machine. The remote project lives on that machine; lanes, PTYs, git, agent
chat, and PR actions all run there. The local desktop is the controller — it
spawns no project services of its own for a remote binding.

The recommended transport is **paired**: sign in on both desktops for PIN-less
account-directory adoption, or pair a Nearby machine with its six-digit PIN.
Both paths create device-bound DPoP credentials, then carry the full runtime
JSON-RPC over the machine sync WebSocket. ADE tries direct LAN routes, then
tailnet routes, then the cloud relay when both machines are signed in to the
same ADE account. **SSH** remains the Advanced path and a fallback only for paired
targets that came from an explicitly configured SSH route. It
runs the same JSON-RPC over an SSH `exec` channel using `ade rpc --stdio` and
can upload or start the remote runtime when needed. The relay is a
trusted-operator plaintext path, not an end-to-end encrypted tunnel; adding
relay payload E2E encryption is planned security work. See the trust boundary in
[Internal architecture](internal-architecture.md).

## Source file map

ADE Cloud:

- `apps/desktop/src/main/services/adeCloud/` — the provider seam, New ADE
  Cloud machine and half-made box cleanup; see [ADE Cloud](../ade-cloud/README.md).
- `apps/ade-cli/src/services/cloudChats/` — the brain's side of ADE Cloud with
  no computer awake (see [On an ADE Cloud computer](#on-an-ade-cloud-computer)):
  `cloudChatUploader.ts` (saved chat parts and subagent copies),
  `cloudRestSave.ts` (copies, Git summaries, capsules and event wakes before a
  rest), `cloudChatMessageQueue.ts` and `chatIdleWait.ts` (the queue drain),
  `cloudChatRestore.ts` (fork-continue of a chat or a CLI).
- `apps/ade-cli/src/services/account/cloudBootLaunch.ts` — a server launch on a
  new cloud computer, with its sign-in wait (`cloudLaunchSignInWait.ts`) and the
  continue of a saved chat; `accountLaneIndexPublisher.ts` — the account lane
  index.
- `apps/ade-cli/src/services/power/cloudPrepareStop.ts` — `ade cloud
  prepare-stop`; `cloudKeepAwake.ts` — the idle step, the rest save before a
  sleep, and the drain on a wake.
- `apps/ade-cli/src/services/github/cloudGitIdentity.ts` — the commit identity
  of a cloud computer.

Connections and links:

- `apps/desktop/src/main/services/remoteRuntime/remoteBrainStart.ts` — who asked
  for a connect (`user` or `background`), the `ade brain start` command for a
  POSIX or Windows remote, the start-then-retry loop, and the plain messages
  for a stopped brain and an SSH server that refuses a command.
- `apps/desktop/src/main/services/remoteRuntime/remoteEventSetup.ts` — the
  2-minute ceiling on an event read or subscribe setup
  (`REMOTE_EVENT_SETUP_TIMEOUT`, naming the step).
- `apps/ade-cli/src/lib/brainConnectionLoss.ts` and
  `apps/desktop/src/shared/brainConnectionLoss.ts` — the relay's
  `brain_connection_lost` answer and its validation.
- `apps/desktop/src/main/services/remoteRuntime/remoteDialTelemetry.ts` — one
  record per outage of why a dial failed (route kind, result, error token,
  duration), matched to the other machine by hashed device ids. See
  [Logging](../../logging.md#error-tracking-sentry).
- `apps/desktop/src/shared/slowLinkMode.ts` — the slow-connection rule (round
  trips and drops, with hysteresis), the per-machine setting (`auto`, `on`,
  `off`), `slowLink` on a connection and the link report. The connection
  snapshot carries it, so the chip, the machine row and the tiles need no poll.
- `apps/desktop/src/main/services/remoteRuntime/remoteLinkMeter.ts` — sizes
  bulk pieces from the measured rate and keeps the round trip covered;
  `linkWantsSlowPath` picks the slow path.
- `apps/desktop/src/main/services/remoteRuntime/remoteAttachmentParts.ts` and
  `apps/desktop/src/main/services/chat/chatAttachmentParts.ts` — a paste sent in
  parts that are safe to send again (`chat.saveTempAttachmentPart`), staged
  once in any order.
- `apps/desktop/src/main/services/computerUse/artifactDisplayCopy.ts` — the
  1920 px JPEG a transcript tile shows on a far link
  (`.ade/cache/artifact-display/`, at most 400).
- `apps/desktop/src/shared/backgroundActionJob.ts` and
  `apps/ade-cli/src/backgroundActionJobs.ts` — long actions followed by id:
  started once per id, joined by a repeat call, the outcome kept ten minutes.
- `apps/ade-cli/src/connectionLinkSummary.ts` — `rpc.link_summary` every five
  minutes per remote connection, and `rpc.link_closed`.
- `apps/desktop/src/main/services/remoteRuntime/remoteTerminalUpdate.ts` —
  `ade brain update` typed into a terminal, for a connected Windows machine
  whose build cannot install itself.
- `apps/desktop/src/shared/crossMachineHandoff.ts` — `pickLiveCheckout`: a
  project's checkout on a machine (folder exists, then user-opened, then
  `lastOpenedAt`). `projects.list` returns `exists` per project (async stats,
  250 ms budget, cached 10 s); every cross-machine picker uses it, and
  `ade projects` labels "folder missing".
- `apps/ade-cli/src/services/account/machineBridge.ts`,
  `agentMachineBridge.ts` — brain-to-brain connection pools (CTO, agents) and
  `machines.call` forwarding. The host binds an `ade-agent-remote` caller's
  claim to the authenticated peer device (`SyncRuntimeRpcHandlerContext`). See
  [Cross-machine agents](../sync-and-multi-device/cross-machine-agents.md).
- `apps/desktop/src/main/services/remoteRuntime/` — the transports, the target
  registry, the RPC client, the connection pool and service, and Bonjour +
  Tailscale discovery.
  - `syncRuntimeTransport.ts` (paired), `syncPortForwardClient.ts` (preview
    forwards).
  - `syncPairedMachineStore.ts` — credentials and endpoint history. Only
    `forgetEndpoint` removes an address: one that answered as a different host.
    The record's own endpoint always stays.
  - `pairedRuntimeRoutes.ts` — LAN, then tailnet, then relay. Two silent
    failures in a row (timeouts, unreachable, unknown errors) rank an address
    last until it answers or mDNS sees it; a rejection never demotes. A relay
    attempt closed with `4505` (the host opened a new relay link, as after a
    sleep) is tried once more at once (`isRelayHostReplacedError`).
  - `pairedRuntimeErrors.ts` — `PairedRuntimeHelloRejectedError` carries the
    host's `hello_error.code` and identity, so nothing parses prose.
    `PairedRuntimeRpcOverBudgetError` (`rpc_over_budget`) never counts as an
    unreachable machine (see [internal architecture](./internal-architecture.md)).
  - SSH (Advanced): route fallback, bounded connect and exec, strict host
    keys, runtime upload and bootstrap.
  - The pool: paired first with eligible SSH fallback, retryable reads,
    event gap and epoch handling, route-pinned sensitive actions, and an
    unknown-outcome error for a non-replayable action that loses its answer.
    Identical concurrent `streamEvents` calls share one read. Pasted bytes go
    through `uploadChatAttachmentBytes`.
- `apps/desktop/src/main/services/remoteRuntime/remoteSidecarCache.ts` — the
  release download of an `ade-<target>` sidecar a target-only package lacks:
  version-pinned, `SHA256SUMS`-checked, published atomically to
  `<ADE home>/runtime-sidecars/<tag>/<target>/`. Only
  `resolveBootstrapRuntimeSidecars` calls it.
- `apps/desktop/src/main/services/ipc/runtimeBridge.ts` — the runtime IPC
  boundary: targets, connect, projects, project open, action / sync / event
  dispatch, preview port forwards, per-window open generations (a slow open
  never overwrites a later one), `ade.runtime.events.release` and
  `ade.remoteRuntime.updateAndRestart` (see
  [`machine.updateAndRestart`](#machineupdateandrestart)).
  - `callMachineMethod` is machine-scoped RPC for main-process callers with no
    binding (the usage merge); it does not widen the renderer allowlist.
    `isTargetConnected` lets a background reader skip a disconnected machine.
  - The local machine identity lives in
    `services/account/localMachineIdentity.ts` (no Electron).
  - Event reads and subscribe acks: 30 s, one retry after a reconnect.
  - Automatic reconnects back off from 30 s to 5 min, forever. Implicit calls
    fail fast during the backoff (`Remote ADE service connection failed
    recently (…)`); calls that share one failed dial count it once.
  - An SSH target that failed with `ssh_auth` or `host_key` is not retried
    until Try again, an edit, or a host-key trust. Paired machines are never
    held this way.
  - A manual disconnect sets `reconnectBlocked: "disconnected"`; the preload
    answers that machine's calls itself (`preload/remoteTargetGate.ts`).
- `apps/desktop/src/renderer/components/settings/SettingsMachineScope.tsx`
  and `settings/health/useHealthData.ts` — machine-scoped Settings pages pass
  the machine's binding and clear the old machine's data first.
- `apps/desktop/src/main/services/ipc/runtimeEventSubscriptionRegistry.ts` —
  event subscriptions keyed by
  `(sender, <bindingKey>:<category|*>:<replay|live>)`, because one window runs
  several pumps. Idle entries expire after 180 s (swept every 60 s); the
  renderer's release is the fast path. One function removes entries for every
  caller.
- `apps/desktop/src/preload/pinnedRuntimeEvents.ts` — the pumps for bindings
  the window is not bound to: one PTY pump per pinned binding and a generic
  pump per listener, each with polling plus push, a cursor, epochs and a
  dedupe ring. Main-side subscriptions are reference-counted per
  `(binding, category)`; the active pump never holds a reference.
- `apps/desktop/src/main/services/account/accountBridge.ts` and
  `apps/ade-cli/src/services/account/accountMachineDirectoryService.ts` —
  account-directory adoption: the Machines row and the CLI turn an account
  machine into a paired credential and a paired-only target.
- `apps/ade-cli/src/services/account/accountMachinePublisherService.ts` — the
  host's own directory row. It lists only validated routes: `lan` per live LAN
  address, `tailnet` per reachable Tailscale address, and `relay` once the
  bridge is validated (`validateCurrentBridge`, run on control open and
  listener ready) and an end-to-end self-probe passes. The row carries the
  host's Ed25519 `pubkey` for sealed `ade-adopt-v1` adoption (see
  [Sync](../sync-and-multi-device/README.md)). The name has a channel suffix
  (`<name> · Alpha`; stable is bare).
- `apps/ade-cli/src/services/sync/syncTunnelClientService.ts` and
  `apps/ade-cli/src/bootstrap.ts` — the relay side. One tunnel client per
  machine (`getSharedSyncTunnelClientService`); `relayTunnelAuthorityGate`
  starts it only while this process holds the sync host lease, and the owner of
  the listener supplies port, nonce and bridge proof. See
  [Relay tunnel and the sync port](#relay-tunnel-and-the-sync-port).
- `apps/ade-cli/src/services/sync/syncHostService.ts` — the host end: paired
  hello authentication (`sync_host.paired_device_rejected`,
  `sync_host.paired_account_owner_mismatch`) and tailnet publication, which
  retires ADE's own leftover `tailscale serve` entries
  (`reclaimStaleTailnetServes`).
- `apps/ade-cli/src/commands/doctor.ts` — the `Sync port` row names a drifted
  port and its base-port holders, and says that a root-owned holder (such as
  `tailscaled`) is invisible to this probe.
- `apps/ade-cli/src/services/account/pairedRemoteConnector.ts` and
  `apps/ade-cli/src/lib/remoteLaunchBudget.ts` — paired route, auth and health
  policy and bounded cancellation for `ade machines connect`.

The local brain and its service:

- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` —
  the local runtime connection for desktop IPC, events, sync Settings and
  local-work checks.
  - Compatibility: the brain advertises `minCompatibleProtocol` through
    `protocolVersion`. A desktop whose `RUNTIME_COMPAT_LEVEL` is inside that
    window connects to a newer brain; otherwise the brain stays and the old
    desktop falls back to an isolated no-sync runtime.
  - It spawns `ade serve` for non-primary sockets, tracks the login service,
    and gives project registration, file actions and event polls short
    per-call timeouts.
  - `LocalRuntimeStatus` carries the brain's `pid`, `syncPort`,
    `publishHealth` and the one-shot `lastWedge` (read by
    `BrainRecoveryNotice`).
  - App fallback: when a packaged desktop cannot install or start the service
    after its own repair, it starts an app-owned brain on the primary socket
    with `--no-sync` (`runtimeMode: "app_fallback"`, with a **Fix it** banner).
    Disk, database and migration failures never trigger it. The child exits
    with the desktop; Repair reinstalls the real service (on Linux the pool
    releases its child first, because systemd stops only its own children).
  - `probeMachineRuntimeIdentity()` says exactly what answers on the
    endpoint (version, build hash, pid, the expected build hash, and whether
    it is a compatible newer brain). See
    [desktop auto-update](../onboarding-and-settings/desktop-auto-update.md#applying-an-update-is-one-transaction).
  - Opportunistic repair backs off (`serviceRepairBackoffMs`: 0 / 5 / 15 / 30
    / 60 s, then one a minute). `beginUpdateWindow` / `endUpdateWindow`
    suppress it for at most 2 minutes during an update, and refused connects
    get `LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE`.
    `getStaleMismatchedRuntime()` reports a live pre-update brain (start time
    checked through `readProcessStartTimeMs`), never a newer one.
  - `serve --install-service` and `--uninstall-service` share
    `runServiceManagerCommand`; install waits at most 90 s, uninstall 20 s.
    `starting` and `restarted` reach `LocalRuntimeStatus.serviceInstall`; a
    `starting` install logs `local_runtime.service_install_starting`.
    `attemptStartedAt` is the start of the current streak of install attempts
    (reset on a connect), which `projectRecoveryService.diagnose` ages for
    `brain_starting`.
  - `installServiceBestEffort` coalesces callers, but a `forceRestart` call
    never joins a plain install: it queues and runs its own. Compatibility
    repair forces it when the endpoint answers with the wrong identity
    (`runtime_older`, `build_mismatch`, `role_mismatch`); a missing endpoint
    gets a plain install. Isolated recovery forces too.
  - `olderBrainRetirement.ts`: isolated recovery asks a strictly older brain
    on the primary socket (one the service manager does not own) to run its
    own `shutdown`. It never signals or kills, and acts only in a packaged
    desktop with the service installed, outside quit and update, once per pid.
  - During quit, a call whose connection drops is not retried, and `drain()`
    waits for every action call.
  - `codedRecoveryError` refuses an app-owned brain on a primary service
    socket and carries the `AdeRecoveryErrorCode` to the recovery surface.
- `apps/desktop/src/main/services/runtime/lastFailureStore.ts` — bounded typed
  failure reports for a service that exits before IPC gets a normal error.
- `apps/desktop/src/main/services/runtime/projectRecoveryService.ts` —
  project diagnosis and ordered repair (storage, database, migration,
  endpoint, chat continuity), plus `restartBrain()` behind **Repair** and the
  brain-down **Fix it**. Both use `restartServiceAndWait()` (install, wait up
  to 90 s for the endpoint, `ping`), which names the stage that failed. A
  forced restart treats a skipped install as a failure ("A newer version of
  ADE is already running. Restart ADE to switch to it."). `restartBrain()`
  refuses ("Recovery is already running.") while `repair()` runs, because
  repair does exclusive database work.
- **A slow brain is not a broken brain.** The brain binds `ade.sock` before it
  starts the sync host (`runServe` in `apps/ade-cli/src/cli.ts`), so a desktop
  reaches it within seconds.
  - Every installer waits `RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS` (30 s; 15 s on
    Windows) for the replacement to answer, then returns `ok: true,
    starting: true` for a live but quiet one.
  - `serviceManager/serviceHandover.ts` (`awaitServiceHandover`,
    `awaitYoungBrainStart`) is the one handover for launchd, systemd and
    Windows; the young-brain wait and the handover get a full budget each.
  - A forced install (Repair) that finds an unchanged agent whose child is
    younger than `RUNTIME_SERVICE_YOUNG_BRAIN_MS` (120 s) waits for it rather
    than restart it. A recorded crash-loop streak cancels that wait.
  - `projectRecoveryService.diagnose` reports the same window as
    `brain_starting` (no Repair; the screen re-diagnoses every 2 s), and
    `repair()` streams its steps (`IPC.recoveryRepairStep`). The desktop keeps
    dialling for 90 s (`LOCAL_RUNTIME_SERVICE_REPAIR_CONNECT_TIMEOUT_MS`).
  - launchd: `loadLaunchAgent` (`serviceManager/common.ts`) runs `launchctl
    enable`, `bootstrap gui/<uid>`, `load -w` as a fallback, then `print` to
    confirm, with one retry. The exit code of `launchctl load` is never
    trusted (a disabled job prints an error, exits 0 and registers nothing).
    An unregistered job fails with `failureStep: "launchd_register"`; the
    diagnostic report reads `launchctl print-disabled`, and
    `ade reset --all` re-enables every ADE label.
  - `installLaunchd.ts` runs `launchctl kickstart` (no `-k`) when launchd has
    not started the job, because a domain in on-demand-only mode ignores
    `RunAtLoad` and `KeepAlive`. The watchdog kickstarts after it kills a
    wedged brain, and the diagnostic report carries launchd's spawn log.
  - `installSystemd.ts` reads `systemctl --user show -p ActiveState -p
    MainPID` and treats `activating` as live.
- **Linux parity.** Headless and SSH brains use `installSystemdService` with
  the same handover, young-brain wait, crash-loop veto and
  `starting` / `restarted` / `failureStep` results.
- **Windows: "still starting" needs proof of a supervisor.**
  `serviceManager/windowsSupervisor.ts` sets `supervised` only when the
  recorded pid is alive and is a PowerShell running this launcher; a recycled
  pid or an unanswerable query is never `supervised`.
- **A brain that loses its socket ends itself.** `monitorBrainSocketOwnership`
  (`cli.ts`) remembers the bound inode. Two brains can race over a stale
  socket; the loser exits and its restart reports `socket_owned_by_other`.
  Shutdown removes the socket only when it still owns the inode
  (`unlinkOwnedRuntimeSocket`). Windows pipes are exempt.
- `apps/desktop/src/main/services/runtime/machineTrustResetMigration.ts` — a
  one-time reset of the old machine-connection trust files that keeps account
  auth, identity, PINs, projects and SSH settings. It completes only when the
  service install reports `restarted`.

The Machines panel:

- `apps/desktop/src/renderer/components/remoteTargets/` — "Your machines":
  connected, available and unavailable sections, Pair and SSH paths, the
  share and connection-doctor cards, machine rows, host-key trust, errors,
  the project picker and the This-computer publish indicator.
  - `blockingHostKeyTrust` returns `needs_trust` / `changed` as its own
    outcome, not as an error.
  - Failures carry **Report this error to ADE…**.
  - `remoteMachineModel.describePublishHealth`: `published` is healthy;
    `sync_disabled`, `sync_not_started`, `not_host`, `account_signed_out`,
    `machine_key_unavailable` and the like read "none"; any other state alarms
    only after 2 minutes. A `token_unreadable` failure adds the shared
    `BrainRepairButton`.
  - Only Bonjour produces a discovery warning. Tailscale discovery adds
    addresses to computers Bonjour found and reports nothing when Tailscale is
    missing or slow.
- `ConnectionRouteDetails.tsx` — the collapsed **Details** under a failure:
  each route, host and port, duration and diagnostic id, with reasons in plain
  words mapped from `RemoteRuntimeConnectionAttempt.failure`, never from
  message text.
- `RemoteErrorCard.tsx` — **Try again**, plus one optional `action`. Today that
  is **Pair again** (`account.pairMachine`), only when the rejecting machine is
  in this account's directory. Nothing re-pairs on its own.
- `SavedMachineRow.tsx`, `MachineIdentity.tsx`, `remoteMachineModel.ts`,
  `UpdateSteps.tsx` — one machine row.
  - The computer drawn with its platform logo in the machine's color
    (`machineColorKey`); a hand-picked color applies to this computer only
    (`ade.machineColors.v1`). A presence dot, a version chip and the winning
    route with its latency.
  - Two versions: the brain's and the installed app's
    (`runtimeInfo.desktopAppVersion`, Bonjour `appVersion`; read by
    `readInstalledDesktopApp` from Info.plist on macOS or the `.exe` version on
    Windows). When they differ the chip shows both, and the older decides
    "behind" (`shared/machineVersions.ts`).
  - **Update** shows on a connected machine behind the newest version this
    computer knows (`compareUpdateVersions`). It calls
    `remoteRuntime.updateAndRestart`, shows Sending → Restarting → Back on
    <version>, keeps the row under Connected during the restart, and checks
    the reported version against `pendingVersion`.

Tabs, machines and routing:

- `apps/desktop/src/renderer/components/app/projectTabGrouping.ts` — one tab
  group per repository, joined on the normalized git origin. No origin, no
  merge; at most one checkout per machine in a group.
  `shared/projectIdentity.ts` owns the binding-key format. `TopBar.tsx` shows a
  machine name only when it is ambiguous, and the menu offers **Connect
  another machine…**.
- `apps/desktop/src/shared/machineIdentity.ts` — "the machine ADE runs on":
  `THIS_MACHINE_ID` (`"this-mac"`), `THIS_MACHINE_NAME` (`"This computer"`),
  `isThisMachineId`, `machineDisplayName`. Every machine-id user imports it,
  because the push guard compares ids. Machines have absolute names; "remote"
  is never a machine name. `machineNameForBinding` names the machine of a
  binding (null is this computer).
- `apps/desktop/src/main/services/projects/recentProjectSummary.ts` — reads
  `origin` from the git config file (no `git` process), undecorated as git
  does, follows a linked worktree to the main config, and caches by mtime.
- `apps/desktop/src/renderer/state/crossMachineLanes.ts` (and the
  `crossMachineLanesByMachineId` slice of `appStore.ts`) — the cross-machine
  Work union, keyed by machine and holding lanes; chats inherit a machine
  through `laneId` (there is no per-chat machine field).
  - Refresh: connection snapshots and lane and session events (coalesced),
    plus a loop that stops while the window is hidden: chats every 10 s, lanes
    every 30 s, an unknown lane at once and only once. Foreign reads are
    bounded, at most four machines at a time, and never hold up the local list.
    Each read is a pinned `lanes.list`, `sessions.list` or `prs.listAll`; a
    window without them logs `work.machine_read_bridge_missing`.
  - Hidden, not deleted: a machine that drops leaves the list and comes back
    with its rows. An asleep ADE Cloud computer is not offline. A drop counts
    after a failed reconnect attempt plus a 45 s floor (120 s ceiling). An
    `idle` target, or a connected machine that cannot prove the repository,
    counts on the floor alone and keeps its rows in the store.
  - Rows leave only when the machine is gone from the snapshot, reports the
    repository missing with a resolvable origin to prove it, or has been
    unreachable 24 hours. The union is per repository.
  - `selectOtherMachineBranchStates` feeds the push guard.
  - Pin hooks: `machineEntryForBinding` / `useMachineEntryForBinding` join by
    binding **key**, and also read the retained slices during a same-repo tab
    switch (one slot per proven origin). `useForeignSessionLaneId` finds the
    lane of a chat this tab does not list. `useLanesForPin` is the **only**
    lane list a pinned lane id may resolve against (lane ids are unique per
    machine, not globally); it returns `null` for no pin.
  - **Root-store invariant:** `crossMachineLanesByMachineId` lives only in the
    root store, so these are `useRootAppStore` hooks; never pass a
    `useAppStore` state into `machineEntryForBinding`.
- `apps/desktop/src/renderer/state/connectRepositoryCopies.ts` — while a
  repository tab is in front, each computer with a copy that the account lists
  as awake and that has no live connection joins in the background
  (`machines.connect(key, { background: true })`). A background connect never
  wakes a cloud computer, starts a brain or parks another web connection, and
  is `declined` for a machine the person disconnected. A failed one retries
  after 60 s, at most five times, and on focus.
- `apps/desktop/src/main/services/machines/machineConnector.ts` —
  `machines.connect`: this computer, a saved connection, or a pairing through
  the account. One flight per machine; a person's connect waits for a
  background flight, then runs its own.
- `apps/desktop/src/renderer/lib/chatMachineRouting.ts` — per-session routing:
  `buildLaneBindingIndex`, `resolveChatRuntimePin` (null when the session is on
  the active binding), the shared `collectOpenProjectBindings` /
  `buildChatMachineRoutingState`, and `isLivePinnedBinding` (open, not active).
  A row on another open machine streams from there without rebinding the tab.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` and
  `terminals/useWorkMachineRouter.ts` — the two routers on that module: the
  chat pane resolves its pin from its lane; the Work hook adds launch pins for
  CLI and shell rows, and the tools pane follows it.
- `apps/desktop/src/renderer/components/chat/ChatRuntimeScope.tsx` — the chat's
  machine, derived once per pane (`useChatScopeDerivation`) and provided to the
  whole subtree, so every chat tool agrees. `useChatRuntimeScope()` returns
  `{ pin, binding, laneId, lane, laneWorktreePath, rootPath, isRemote,
  machineName, online }`; `pin === null` means only "on the tab's binding".
  `useChatRuntimeScopeForPin` serves a surface outside a chat pane (the CLI
  header's `ChatGitToolbar`). `online` is false only for a known-unreachable
  pinned machine.
- `apps/desktop/src/renderer/components/lanes/laneMachines.ts`,
  `LaneMachineSelector.tsx`, `PushDivergenceDialog.tsx` — the machine choice
  when creating a lane (by origin, which is proof, else by folder name, a guess
  that never rebinds on its own) and the push warning.
  `CreateLaneDialogHost` restores the opening binding if the dialog closes
  without a lane.
- `apps/desktop/src/shared/laneDivergence.ts` — the push guard. Another machine
  on the same branch with `ahead > 0` holds commits the push would strand. Head
  shas only silence it (proven same commit); an unknown head never does. Silent
  when no other machine has the branch, the entry is this machine (by id), or
  the other machine has nothing unpushed.
- `apps/desktop/src/renderer/state/appStore.ts`, `app/App.tsx`, `TopBar.tsx`,
  `projectRouteStorage.ts` — every open remote binding is its own project
  surface, keyed by binding key. Local and remote tabs share one eight-surface
  warm LRU; a failed reconnect leaves the stale surface visible.
  - Closing a tab or removing a machine forgets it
    (`evictProjectState` + `removeStoredProjectRoute`).
  - Disconnect only drops data caches (`evictProjectDataCaches`); the view
    state and route stay, so a reconnect lands on the same chat. Binding keys
    are `remote:<targetId>:<projectId>`. `closeProject({
    preserveRemoteViewState: true })` does the same for the last tab.
- `apps/desktop/src/preload/preload.ts` — routes runtime-backed APIs to the
  local or remote runtime of the active binding, or to an explicit
  `OpenProjectBinding` pin passed last (`callPinnedOrBoundRuntimeActionOr`).
  With no pin, a call is exactly the bound path, with no extra await.
  - Pinned domains: chat and session calls, the iOS simulator, App Control and
    computer-use artifacts (through `callIosSimulatorActionOr`,
    `callAppControlActionOr`, `callComputerUseArtifactActionOr`, so the domain
    string is typed once), and the cross-machine handoff calls.
  - `iosSimulator.onEvent` and `appControl.onEvent` follow the pin to that
    runtime's stream. `builtInBrowser.onEvent` never does: the browser is this
    desktop's (`isLocalBrowserRoutingPin` decides).
  - Read caches are keyed by binding (`boundReadCacheKey()`); a pinned
    simulator status or device read skips the cache.
  - The bridge is declared `satisfies Window["ade"]`, so a preload signature
    that drifts from `global.d.ts` (a missing `pin` above all) does not
    compile.
  - Usage and budget: a bound window reads them from its runtime; a window
    with no local project goes through desktop usage IPC, which proxies to a
    booted brain scope (`ade.usage.event` keeps it live).
  - Project switch: preload records a pending local binding and sends
    `rootPath`, so early calls hit the new project. During a remote open it
    clears the binding, waits before retrying reads, and refuses writes with
    "Project is switching". Read or write comes from
    `shared/adeActionAccess.ts`, never the action name.
  - Remote event polling skips buffered replay on the first live subscribe,
    resets on an `eventEpoch` change, refreshes on `gap: true`, and backs off
    when idle. Lane preview URLs go through a local TCP forward.
  - Only an isolated no-sync local window retries `Sync service is not
    available` / `Register a project first` through main; a remote-bound
    failure never falls back to the local machine.
  - The browser across machines is described in
    [The ADE browser for a remote chat](#the-ade-browser-for-a-remote-chat).
- `apps/desktop/src/main/services/projects/windowTabRootAuthorization.ts` — what
  a window's set-open-tabs call may change. `resolveWindowTabRoots` splits the
  list into `tabRoots` (display only) and `authorizedLocalRoots` (local runtime
  scope), and only roots of projects this process opened pass. `main.ts` also
  keeps `windowKnownLocalProjectRoots` (every local root this window opened),
  so a chat pinned to This computer can act from a remote-bound tab. Only the
  window's own open grants membership.
- Settings › Passwords & Secrets always talks to the computer the person is
  using (`passwords.call` through main), whatever the tab: the vault is the
  account's, and a "this computer only" secret lives there. `.env` import and
  export use that computer's files. A remote chat's secret card, a webhook's
  signing secret and Cursor Cloud's env reach their project through
  `project_secret` on the pinned machine.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — the runtime's project catalog
  and sync methods, machine-scoped personal-chat methods and project action
  dispatch.
  - `projects.getHandoffStoragePreflight` checks a clone path, free space and
    Git access before a handoff changes the machine.
  - `runtimeEvents.*` replies carry `eventEpoch`, `gap` and `oldestCursor`.
  - `projects.list` inlines icons (24 icons / 750 ms on connect, 128 KiB each,
    512 KiB total). `projects.setIcon` / `removeIcon` store or clear an icon on
    the host (base64, MIME from the extension, 2 MB, basename only, under
    `.ade/project-icons`). Older hosts advertise `machineProjects.setIcon:
    false`.
  - A project with a git origin takes its name and icon from the shared
    project record (`shared/projectRecord.ts`: `project.icon` and
    `project.name` under `repo:<origin>`, or `.ade/project-record.json` with
    sync off). A write the store cannot take waits in that file and goes first
    on the next read or write.
  - `projects.inspectRemoval` reports the host copy's state for the remove
    dialog (unpushed changes and commits in every worktree, stashes, ignored
    `.env` files, live chats and terminals). `projects.removeCopy` (cto only;
    another machine needs `runtimeHostGranted`) re-reads that state and
    refuses when it no longer matches the `stateToken` (HEADs, status, branch
    tips, stashes, sizes and times of changed and secret files; over 5,000
    paths never match). It then checks the folder is exactly a registered
    root with no home, ADE home, other project or running ADE inside, stops
    the project, renames the folder aside and deletes it. The desktop's own
    computer sends `folderMode: "caller"` and uses the Trash. Older hosts lack
    `machineProjects.removeCopy` and get entry removal only.
  - It also serves `machine.updateAndRestart` (a paired phone or browser
    sends the sync commands `machine.updateImpact` /
    `machine.updateAndRestart` instead) and the
    `ProjectlessSyncControls` fallback for `sync.*` — see
    [sync and multi-device](../sync-and-multi-device/README.md#sync-on-a-machine-with-no-project).

Brain liveness and lifecycle:

- `apps/ade-cli/src/services/runtime/brainHeartbeat.ts` —
  `<ADE home>/runtime/heartbeat.json` (`{pid, ts, seq, startedAt}`), written
  every 15 s even when idle. A beat late by more than 60 s logs
  `brain.suspend_gap` (the machine slept). `evaluateBrainHeartbeat` and
  `brainWatcherSuspendFloorMs` are shared by both platforms.
- `apps/ade-cli/src/services/runtime/brainWatchdogCheck.ts` —
  `ade runtime watchdog-check`: reads the heartbeat and kills at most one pid.
  It never opens the socket (a wedged brain hangs connects). Its own record,
  `<ADE home>/runtime/watchdog-check.json`, is written before the verdict; an
  unwritable directory means it stops killing.
- `apps/ade-cli/src/serviceManager/installLaunchdWatchdog.ts` — the
  `com.ade.watchdog` agent (`.alpha` for Alpha, every 60 s), best effort.
- `apps/ade-cli/src/serviceManager/runtimeServiceBudgets.ts` — every timeout
  of the start and handover, in one file, because they only make sense
  together: handover 30 s (`RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS`; 15 s on
  Windows), young brain 120 s, endpoint wait 90 s, and 60 s of dialling a
  `starting` brain (`RUNTIME_SERVICE_STARTING_CONNECT_WAIT_MS`).
- `apps/ade-cli/src/serviceManager/serviceHandover.ts` — the shared handover
  (see above).
- `apps/ade-cli/src/services/runtime/awaitRuntimeServiceEndpoint.ts` — the
  install-then-wait of `ade setup`; a failed install marked `starting` keeps
  dialling.
- `apps/ade-cli/src/services/runtime/brainStartupState.ts` —
  `readBrainStartupState`, the CLI's `brain_starting` answer for a brain that
  does not answer: the service is installed and not stopped, its brain is
  younger than 120 s, and it is not crash-looping (`last-failure.json` on
  macOS and Linux, the supervisor's `restartCount` on Windows, where the age
  comes from `runtimeStartedAtMs`). Any probe failure means not starting.
- `apps/ade-cli/src/services/runtime/connectWhileServiceStarts.ts` — dials a
  just-installed service and throws `RuntimeServiceStillStartingError` on time
  out, so no caller starts a rival brain on the supervisor's socket.
- `apps/ade-cli/src/services/runtime/machineUpdateAndRestart.ts` — the host
  side of `machine.updateAndRestart`; embedded and test runtimes refuse it.
- `apps/ade-cli/src/services/runtime/machineUpdateInFlight.ts` —
  `joinOrStartMachineUpdate`, the one-run-per-process coalescer that the
  runtime RPC and the phone's sync command both go through.
- `apps/ade-cli/src/services/runtime/atomicJson.ts` — the write-temp-then-
  rename JSON helper for these state files.
- `apps/ade-cli/src/services/projects/` — the machine project registry, the
  lazy per-project scope cache (startup boots only the sync-host project; each
  scope is a full DB, search, chat, automation and PTY runtime) and
  `projectIconResolver.ts` (the `.ade/local.yaml` `project.iconPath`
  override, icon files, `index.html` icons; a 64 px thumbnail, 128 KiB).

Build and install:

- `apps/ade-cli/scripts/build-static.mjs` — the static `ade-<platform-arch>`
  SEA binary and its `.native.tar.gz`, with the version check.
- `apps/ade-cli/scripts/install-runtime.sh` and `install-runtime.ps1` —
  download, verify, PATH and `ade brain start`; the rest is `ade setup`.
- `apps/desktop/scripts/materialize-runtime-resources.mjs` and
  `validate-runtime-resources.mjs` — `apps/desktop/resources/runtime/` for
  packaging.

## User model

A **remote target** is another ADE machine reachable through a paired sync
route, SSH, or both. A paired target stores the machine identity and paired
credentials separately from the saved target; the target may also retain SSH
user, port, key, and route information for fallback. A **remote project** is a
path on that machine that has been registered with its ADE runtime (via
`projects.add`). Opening a remote project does not copy local files or move a
local lane by default. Normal project opening still expects Git to move code
between clones; the explicit **Continue on another machine** flow adds a guarded clean-lane
handoff that publishes the exact source commit, prepares or clones the
destination project, creates or reuses the destination lane, and starts a new
chat from a bounded portable capsule.

Direct remote targets are account-independent. Trust created through Nearby +
PIN or SSH lives on this desktop and continues to connect after sign-out.
Account-directory adoption is deliberately account-owned instead:
the target and paired DPoP credentials are tagged with the Clerk user id and
removed when that user signs out or switches accounts, so a shared ADE install
cannot expose another person's machines. Signing in never converts an existing
direct pairing into account-owned trust.
Changing an SSH host key always requires explicit trust again. Changing the
remote host's stable pairing identity, or losing its stored pairing grant,
invalidates the saved paired credential and requires re-pairing; ADE does not
silently attach old credentials to a different host identity.

Opening a project on another machine asks nothing: a repository is one tab.
ADE warns about two checkouts that differ only at push time, when another
machine holds the same branch with unpushed commits
(`apps/desktop/src/shared/laneDivergence.ts`).

## One repository, many machines

A repository is one tab. Local and remote checkouts of the same repo — joined on
their normalized git origin — collapse into a single tab whose **machine** is a
dimension inside it, switched from a dropdown on the tab. There is no separate
"remote" tab, and "remote" is not a machine name: machines are named absolutely
("This computer", "MacBook Pro (97)").

The tab's machine is the global execution context — Lanes, PRs, the Files
page, and Run all follow it. Two things are deliberately wider than that:

- **The Work sidebar is a union.** It shows chats in flight on *every* connected
  machine for this repository, whatever the tab's machine. A lane not on This
  computer carries a machine marker. Foreign lanes show only when they have
  sessions. An offline machine's rows are hidden until it reconnects. One
  session is one row: a single claim set spans the slices, local wins a tie,
  and a slice claims only sessions on lanes that machine reports.
- **A session owns its Work tools.** Git, Files, Terminal, Browser, Simulator,
  and App Control in the Work tools pane follow the focused chat's machine, not
  the tab dropdown. Opening a chat, CLI, or shell from the union streams it from
  the machine that owns its lane, with its calls pinned to that machine's
  runtime; the tab stays bound where it was. Switching the dropdown under an
  open session does not remount or retarget those tools — a Studio chat keeps
  Studio git and Studio shells while you sit on a MacBook. New chat has no
  Tools toggle; opening a draft closes any leftover pane. Clicking a session
  never rebinds the tab: the row already carries a complete binding, so Work
  pins the call even after the dropdown released that checkout. The command
  palette and `ade:work:select-session` follow the same rule. Same-repo
  machine switches keep the union's session slices; a different git origin
  wipes them. Clicking a
  foreign *lane* (rather than a session) is the explicit move: it switches the
  tab's machine, the same thing opening a remote project does.

Hosted web still cannot drive Simulator (no capture stream) and shows App
Control read-only. iOS switches host rather than pinning a foreign runtime. The
CLI addresses machines separately. Windows uses the same session-owned routing;
Simulator stays macOS-only.

Machine selection also appears at lane creation: the create-lane dialog picks
which machine the new worktree is created on, matching each machine's checkout of
the repo by git origin. Browsing machines in that dialog and closing it without
creating a lane restores the binding the dialog opened on.

Local project opens use typed recovery rather than raw error text. If the
machine brain could not open project data, it records a bounded failure report;
the local connection pool returns a coded refusal instead of spawning a second
brain on the primary socket. The renderer carries that code into the full
project recovery surface, where `projectRecoveryService` can diagnose and
repair storage or database state without depending on the failed brain. Remote
RPC errors retain their method/code/message/data diagnostics, but they do not
run a local repair against data owned by the remote machine. See
[Storage and recovery](../storage-and-recovery/README.md#typed-project-open-recovery).

## Connect flow

1. Open **Connections > Machines**. When signed in, ADE loads the other computers on
   the same account. It also combines Bonjour and Tailscale discovery,
   removes this machine's own Bonjour advertisement, and merges routes that
   identify the same machine. Discovered paired-capable ADE desktops appear in
   Available; offline or unsupported machines remain visible in Unavailable.
   The same discovery also runs in the main process at launch (after the first
   autoconnects start) and on wake or unlock, so a demoted LAN address that
   answers the network again is ranked first at the next connect without a dial.
   A connect never waits on it.
2. Select a same-account computer for the primary PIN-less flow. ADE dials the
   directory-verified Relay first; when the target publishes an ed25519
   identity key in its directory row (`pubkey`), adoption can also fall back
   to Tailscale and LAN routes using the sealed `ade-adopt-v1` handshake —
   the host signs the client's challenge nonce over an ephemeral X25519
   exchange, the client verifies that signature against the directory key
   before releasing any account credential, and both the account attestation
   and the returned paired credentials travel AEAD-sealed under a negotiated
   cipher — ChaCha20-Poly1305, or AES-256-GCM when a packaged Electron's bundled
   BoringSSL lacks ChaCha20-Poly1305, with the chosen cipher bound into the
   signed challenge so it cannot be downgraded. A
   host-identity verification failure aborts adoption immediately (no route
   is retried); hosts without a published key remain relay-only-adoptable.
   Successful adoption saves the returned DPoP-bound credentials either way.
   While connecting, the machine row reports the route being tried, and a
   failure surfaces inline with a one-tap jump into Nearby + PIN pairing
   when the same machine is discoverable locally.

   A connect locks only its own row in the Machines pane (`useRowActions`); every
   other row keeps Connect, Edit and Remove. A connecting or reconnecting row shows
   Cancel, which is a manual disconnect: main's disconnect generation ends the
   in-flight connect for that target, including one still in the account ownership
   check, and the renderer ignores its late answer. Remove works while connecting
   and cancels first. Main cannot interrupt an account pairing, so a cancelled
   pairing keeps its row at "Stopping…" until it settles, and a second pairing for
   the same machine cannot start meanwhile.

   `ade-adopt-v1` protects the *credentials* exchanged during adoption (the
   account bearer, the DPoP proof, and the minted paired secret are all
   sealed), not the confidentiality of the ongoing session. After adoption
   over a plaintext `ws://` LAN or tailnet route, the established sync stream
   has the same on-path exposure as any other direct paired reconnect — an
   attacker who can already read that LAN can observe the post-adoption
   traffic, but never the sealed credentials. This matches the pre-existing
   direct-route trust boundary; relay routes remain trusted-operator
   plaintext-readable as documented above.
   A signed-out desktop may use a saved direct pairing during explicit recovery;
   a fresh launch has no account-less **Find nearby computers** pass-through.
   When Nearby + PIN pairing is offered from an account-backed or recoverable
   Connections flow, select the discovered LAN/Tailscale machine and enter the
   six-digit PIN shown on that computer's **This computer** Connections card.
   There is no desktop pairing-link paste/scan or manual address + PIN path.
   A discovered machine with an existing pairing is upgraded to a paired target
   automatically.
3. Connect. ADE dials paired routes in LAN → tailnet → relay order, preferring a
   recently successful endpoint within each class. After authenticated
   `hello_ok`, it requires `features.rpcChannel === true`, opens the runtime
   JSON-RPC channel, and uses the paired port-forward channel for remote preview
   URLs. The connected status reports the winning route and latency. A relay
   route is tried only while this ADE client is signed in. The client attaches
   a short-lived account proof to that relay hello, and the host accepts it only
   when the proof belongs to the Clerk user currently signed in on the host.
   A missing or different account reports **Sign in to ADE** without consuming
   the transport's automatic-reconnect backoff. Relay remains a trusted-operator
   plaintext-readable path, not a confidential channel; end-to-end payload
   encryption remains planned. A signed-out host does not advertise or hold a
   Relay tunnel; it resumes automatically after sign-in. Legacy shared
   bootstrap tokens are rejected over Relay even when
   they remain valid for an eligible direct reconnect.
4. If paired dialing fails, or the remote runtime does not support the paired
   RPC channel, ADE silently falls back to SSH only when that paired target has
   a route originally configured through Advanced SSH. Nearby/discovery routes
   are never reinterpreted as SSH fallback. SSH host-key trust is requested only
   after fallback is actually needed; it is never pre-trusted or prompted
   before the paired attempt.
5. Use **SSH** under Advanced to configure or connect directly: enter a display
   name, hostname, SSH user, port, and optional private key path. With no key
   path, ADE uses the local ssh-agent when `SSH_AUTH_SOCK` is available and
   matching `HostName` / `IdentityFile` entries from `~/.ssh/config`. An unknown
   host key is shown with its fingerprint and requires explicit **Trust &
   connect** approval before it is recorded in `known_hosts`.
6. On an SSH connection, ADE detects the remote platform with `uname -sm` and
   starts `ade rpc --stdio`. If the bundled runtime is present locally and the
   remote binary is missing, stale, or hash-mismatched, ADE uploads the binary,
   native dependencies, PTY worker, and bundled agent skills into the matching
   ADE channel home, then verifies the runtime. Uploads prefer SFTP and fall
   back to bounded SSH chunk uploads / OpenSSH. Without a bundled binary, ADE
   probes alternate channel homes for a compatible installed runtime and
   reports the selected fallback as a compatibility warning.
   Windows clients require the built-in OpenSSH Client for the bounded fallback
   upload path. If `ssh.exe` is unavailable, ADE reports the missing Windows
   Optional Feature and the `Add-WindowsCapability` repair command instead of a
   raw process-spawn error.
7. Once SSH RPC succeeds, ADE asks that exact runtime to authorize this desktop
   as a paired DPoP device using a bounded JSON request on stdin. The resulting
   secret, private key, host identity, and endpoints are stored locally, and
   the target is upgraded to paired-first while retaining the verified SSH
   route as recovery. Older compatible runtimes that do not implement this
   upgrade remain usable over SSH.
8. Pick an existing remote project or register a new remote path; the desktop
   calls `projects.add { rootPath }` against the remote runtime to bind it.
   If the same window starts multiple remote opens concurrently, both preload
   and the main IPC bridge keep only the latest open as the durable binding.

`ade machines connect` consumes that same saved target registry and paired credential
store. Before opening a credentialless routed SSH record, it compares the saved
name and all saved hosts with the signed-in account directory. An exact, unique
legacy account-machine match is adopted into the paired store and the obsolete
SSH-shaped record is removed. If the directory cannot be verified, the machine
is offline, or adoption fails, that account-created target fails closed; ADE
does not silently retry it as SSH. Targets with an explicit SSH user or private
key remain true SSH targets and bypass this migration. Paired connections dial LAN → tailnet → relay by default and
never fall back to SSH. The CLI prints the selected path without showing temporary socket
locations or pairing identifiers.

For a true SSH target, each alternate route is passed as
`-o HostName=<concrete-route>` while the saved hostname stays in the destination
argument. OpenSSH therefore still selects the saved `Host` alias and applies its
`User`, `IdentityFile`, agent, and proxy configuration, while
`StrictHostKeyChecking=yes` remains enforced. Account resolution, paired
LAN/tailnet/relay dialing, and the SSH route × channel-home × binary-command
matrix share one 45-second startup deadline. Each child process and paired
WebSocket/auth wait is capped by the remaining budget and observes cancellation;
authentication failure stops redundant channel-home probes for that route, and
the final error aggregates the routes/runtimes that were actually attempted.

After connecting, the desktop persists the active remote project to `globalState.lastRemoteProjectBinding` and records it in the unified recent-project list with target id, project id, runtime name, and hostname. Remote recents are keyed as `remote:<targetId>:<projectId>`, so a remote project can share a path string with a local checkout without colliding; the welcome screen can reconnect/open the remote row directly from that metadata. Each target also persists an explicit `autoConnect` preference: a successful Connect enables it, and Disconnect disables it. Only targets with that preference enabled reconnect at launch or after wake; an explicit failed Connect does not change the saved preference. Implicit retries use bounded exponential backoff from 30 s through 5 minutes and remain eligible after repeated failures — except for failures no redial can fix: a machine that rejects this device's pairing or identity, or an account that will not vouch for it, stops the 30 s maintenance redials until the person acts (Connect, Pair again, an edit) or, for a sign-in failure, until the signed-in account changes. Such a failure shows the error and its action, not "Reconnecting". Pressing Connect bypasses the current backoff without bypassing SSH or pairing authentication. A target also persists this computer's `slowLinkMode` (`"on"`/`"off"`, absent for Automatic), which saving the machine's address again keeps; see [A slow or dropping link](#a-slow-or-dropping-link). An unpackaged (development) desktop runs with `explicitConnectOnly`: it never reconnects saved targets at launch, after wake, or for implicit use, and connects only when the person presses Connect in it. A paired host keeps one connection per device and every ADE on a computer shares that device pairing, so a dev app reconnecting on its own took machines from the installed app (which then shows the superseded error and waits). `ADE_DEV_REMOTE_AUTOCONNECT=1` turns auto-connect back on for a dev app.

Per-channel layout: builds with `ADE_PACKAGE_CHANNEL=alpha` upload to `~/.ade-alpha/` instead of `~/.ade/` so a remote machine can host stable and alpha runtimes side by side. Beta is an update track of the normal install and uses `~/.ade/`. Runtime binaries, native deps, PTY workers, and bundled ADE agent skills all live under the selected home. Remote compatibility launches keep `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` so remote probes do not fight the user's login service.

A packaged Alpha upload that cannot initialize is not terminal by itself. ADE
still probes the isolated Stable and other channel homes and accepts the first
runtime whose initialization and machine-project capabilities are compatible;
the selected home is then used consistently for follow-up commands such as the
SSH-to-paired upgrade.

### A remote machine whose brain is not running

The SSH relay on a POSIX remote runs `ade --socket ... rpc --stdio`, and an
explicit `--socket` turns off the CLI's own spawn and service repair, so a
machine with no brain answers with `ENOENT` or `ECONNREFUSED` on its socket.
Who asked for the connect decides what happens next
(`remoteBrainStart.ts`; `initiatedBy` on `RemoteConnectionPool.connect`):

- A connect the person asked for (`"user"`: Add machine, Test, Connect, Try
  again, opening or switching to a project on that machine) runs
  `ade brain start --text` over SSH, which installs the login service (or ADE's
  own supervised process where no service manager answers) and waits for the
  handover, then dials again every 2 seconds for up to 90 seconds
  (`REMOTE_BRAIN_SOCKET_WAIT_MS`). Disconnecting or removing the target
  abandons the wait.
- A background reconnect, the event pump and autoconnect (`"background"`) never
  start a brain: one the person stopped stays stopped. Neither does a layout
  whose service install is disabled (`ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1`,
  and the alpha channel) or a fallback to another channel home.
- A user connect that joined a background dial which failed because the brain
  was not running dials once more as its own, so the person's click is not
  answered with the background dial's refusal.

When the brain still is not running, the error is expected (environment) and
names the exact command to run on that machine, then asks the person to press
Try again; when `brain start` ran, it says whether it failed or the brain did
not accept connections within 90 seconds, with the command's first lines. A
Windows remote already starts a brain from the relay (no `--socket`), so the
desktop never runs a start there; the message shows the PowerShell command
(`$env:ADE_HOME = ...; & '<binary>' brain start`). An SSH server that opened
the connection but refuses to run a command ("Unable to exec", often
`MaxSessions` or a forced command) gets a plain message naming the step ADE was
on and the check to run (`ssh <user>@<host> true`).

Each step of a connect has its own time limit, and an event read or
subscription has a ceiling over all of them:

| Step | Limit |
| --- | --- |
| Paired runtime `ade/initialize` and first `projects.list`, after the hello | 30 s (`PAIRED_RUNTIME_HANDSHAKE_TIMEOUT_MS`) |
| SSH runtime `ade/initialize` and first `projects.list` | 90 s (`RUNTIME_SERVICE_START_WAIT_MS`) |
| A `projects.list` read on an open connection | 30 s |
| Event read or subscribe setup, including a dial it starts or joins | 2 min (`REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS`) |

Past the ceiling the call fails with `REMOTE_EVENT_SETUP_TIMEOUT`, whose message
names the step that hung (account check, connect, project list, read,
subscribe, liveness probe, reconnect). The dial itself keeps going for the next
poll to join, and the pump polls again two seconds later. The IPC budget for
`ade.remoteRuntime.streamEvents` is 2.5 minutes, just above the ceiling, so
main always answers with the step before the generic IPC deadline fires.

When the brain's socket drops under an `ade rpc --stdio` relay, the relay
passes the brain's own typed errors through unchanged and answers calls in
flight with `brain_connection_lost`. Its `data` is structured only: brain state
(`alive`, `exited`, `exited_and_replaced`, `unknown`), heartbeat age, the
socket's errno, and up to six of the brain log's last lines as level, event
name and error code. Free text never crosses. The desktop re-validates every
field and reports `remote.brain_connection_lost`
(see [Logging](../../logging.md#error-tracking-sentry)).

### When the connect fails, the user reads one sentence

The main process classifies the attempts and picks the dominant cause,
carried as `RemoteRuntimeConnectErrorInfo.failure` beside the `attempts`
array. The UI keys its headline **and its recovery action** off that
field, never off the message text. Every host, port, duration and the
correlation id stay in a collapsed **Details** list
(`ConnectionRouteDetails.tsx`), which is where support questions get answered.

Classification is structural. `classifyPairedRuntimeFailure`
(`pairedRuntimeRoutes.ts`) reads the host's `hello_error.code`, carried up by
`PairedRuntimeHelloRejectedError`:

| `hello_error.code` | Attempt failure |
| --- | --- |
| `repair_required`, and `auth_failed` from an older host | `pairing` |
| `relay_account_required` | `authentication` |
| `connection_attempt_superseded` | `superseded` |
| `invalid_hello`, `protocol_version_mismatch` | `protocol` |

The message-regex classifier is reserved for transport errors, which carry no
code at all. Account-machine *adoption* keeps its own prose classifier
(`classifyAccountMachineAdoptionFailure` in `syncPairedMachineStore.ts`): that
flow has no hello code to read and deliberately orders its rules differently —
"pair it again" is a first-class outcome because adoption *is* the repair, a
credential word outranks a transport word, and `cipher` reads as identity.

`superseded` exists so a losing route stops reading as a fault. Another route
won the same connection attempt; nothing is wrong.

### Which part failed: the connection doctor

A client can only see that a route failed; the machine at the other end knows
why. So there are two halves, sharing one wording module
(`shared/connectionDiagnosis.ts`), so a failure reads the same on every
surface:

- **Test connection** (a machine row's Test button, `ConnectionDoctorPanel`)
  probes every route of a machine and classifies each failure from its
  structure (`classifyDoctorFailure` in `connectionDoctor.ts`): the relay's
  close code 4501 is `host_offline` (the relay answered; the machine is not
  connected to it), a relay name that does not resolve or a down interface is
  `no_network` (this computer's own network), and the rest reuse the connect
  classifier (`pairing`, `authentication`, `protocol`, `timeout`,
  `unreachable`…). `diagnoseDoctorChecks` writes one sentence and one fix over
  all routes; any route that works wins, since a LAN address failing away from
  home is expected. A route login sends hello `peer.connectionPurpose: "probe"`
  and, on the relay, the same account proof a real connect carries
  (`resolveAccountRelayProof`). A host keeps one connection per device and
  closes the older one ("Superseded by a newer connection for this device"),
  which the client then reads as another ADE using the pairing and stops
  reconnecting. So a host that advertises `features.connectionProbe` answers a
  probe hello and closes it before arbitration, and while this app has a paired
  connection open or opening to a host that has not advertised it
  (`RemoteConnectionPool.liveConnectionState`, remembered across reconnects),
  the test only opens each route without logging in. An SSH fallback never logs
  in as the device, so it does not limit the test.
- **Check** on the This machine card in Connections
  (`HostReachabilityCheck.tsx`, IPC `ade.sync.checkLocalReachability`, brain
  method `sync.checkReachability` in `hostReachabilityCheck.ts`) asks this
  computer's own brain whether others can reach it: the sync listener, the
  relay control socket and bridge, a real self-probe through the relay
  (dialled like a phone would, only when the control and bridge are up),
  Tailscale's state and whether it routes everything through an exit node
  (`tailscale status --json`; an exit node that blocks the relay is the case
  that looks healthy on the host and dead everywhere else), the account, and
  a recent freeze. Each part gets a state and a fix. It is always this physical
  computer (like `getLocalStatus`), never the window's bound machine; the web
  client has no such check and shows nothing.
- **On <machine>** is the same check asked of a connected remote machine,
  from inside its Test panel (`HostReachabilitySection`, IPC
  `ade.remoteRuntime.checkReachability`). The desktop sends
  `sync.checkReachability` over that machine's own connection
  (`callMachineMethod`, 30 s, no retry) and rewrites "this computer" to the
  machine's name (`describeReportForMachine`). A machine that is not
  connected has no section; one running an older ADE answers "can't check
  itself" with the fix to update it.

**A frozen host says so.** While a machine is frozen, its clients cannot tell
that from a dropped network. The brain loop watchdog reports every stall
it came back from (`onStall`, not suspensions) and every wedge it restarted
(`onRecovered`) to `hostStallRecord.ts`, which keeps the latest one of 5 s or
more, with the 1-minute load average (none on Windows) and core count. For 5
minutes, `hello_ok` carries it as `hostHealth.lastStall` with an age instead
of a timestamp, so clients need no clock sync. The desktop keeps it on the
machine's connection status (`hostStall`, a note under the row for 10
minutes) and shows one toast per freeze; the web client toasts it from its
hello; iOS shows it on the Connection card. "Its CPU is overloaded (load 21 on
8 cores)" when load exceeds the cores, otherwise "ADE there was too busy to
answer". A restart that ended a wait on a file call names the folder
(`lastStall.blockedPath`): "ADE there waited 42s to read /Volumes/Dev/… and
restarted itself. macOS may have been asking for permission on its screen."

While a project folder there is not answering (see
[A folder waiting on a permission prompt](../storage-and-recovery/README.md#a-folder-waiting-on-a-permission-prompt)),
`hello_ok` carries `hostHealth.storageWait` (path, `not_answering` or
`denied`, an age, the host's platform), and the host pushes a `host_health`
envelope to every connected device when it starts and ends. That envelope reads
no database, so it still goes out when the waiting folder holds the host's own
project; the handshake does read the host project's database, so a device that
connects while that folder waits may not get through. The desktop keeps it on
the machine's connection status (`hostStorageWait`, a note under the row while
connected) and toasts it once; the web client toasts it; iOS shows it on the
Connection card. "Studio is waiting for permission. macOS is asking on Studio's
screen whether ADE may use /Volumes/Dev/Projects/ADE. Click Allow there."
(`describeHostStorageWait`). The host's own self-check lists it as a "Project
folders" row. Older clients ignore the envelope. The web client's close
messages name the cause too: 4501 says the computer is not connected to the
relay, and a socket that went stale after working says the computer stopped
responding (overloaded, asleep or off the network).

## Compatibility warnings

Version skew and capability skew do not fail the connect. The bootstrap performs the JSON-RPC `ade/initialize` handshake, normalizes the `capabilities.machineProjects` flags returned by the remote runtime, and reports the result as `RemoteRuntimeCapabilities` plus a `compatibilityWarnings` array on the `RemoteRuntimeConnectResult`. The renderer's remote target panel displays the capability warnings inline in the machine row. Warnings cover:

- Runtime version mismatch, shown as the machine row's version chip (`X → Y`) rather than a sentence; the older machine is the one to update.
- Remote package channel mismatch (e.g. desktop is `alpha`, remote runtime advertises `stable`).
- Missing `machineProjects` capabilities — `browseDirectories`, `getDetail`, `getWorkSummary`, `getDefaultParentDir`, `create`, `clone`, `listMyGitHubRepos`. These map to the `projects.*` RPCs the renderer uses for the project picker / new-project / clone flows. Missing capabilities do not block connect, but the connection pool refuses the matching call with a self-describing error when the renderer attempts it (e.g. `Remote ADE service 0.7.2 does not support cloning remote projects.`).
- The bootstrap fell back to a different ADE home (`Using remote runtime home .ade-alpha because .ade did not contain an ADE service for darwin-arm64.`).

## Runtime artifact layout

A desktop package carries **only its own build target's** `ade-<platform-arch>`
binary and matching `.native.tar.gz` archive in `apps/desktop/resources/runtime/`,
plus the packaged ADE CLI resources that include `ptyHostWorker.cjs` for remote
terminal hosting. A foreign-platform payload fails the build: all five targets
would push the macOS update ZIP past the 1 GiB Squirrel.Mac limit (see
[desktop-auto-update.md](../onboarding-and-settings/desktop-auto-update.md)).

`apps/desktop/scripts/runtime-resource-targets.cjs` is the single source of
truth for which sidecars a build may contain — `darwin-arm64`, `darwin-x64`,
`linux-arm64`, `linux-x64`, `win32-x64` — and every packaging stage reads it:

| Mode | Trigger | Meaning |
| --- | --- | --- |
| `target` | `ADE_RUNTIME_TARGET=<target>` (set per release packaging job) | Exactly that target must be present and any other target's sidecar is a hard failure. |
| `host-only` | `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1` | Local channel builds validate only the host target. |
| `full` | neither | Stages every target. |

Only `target` mode is exclusive, and three stages enforce it: the pre-build CI
gate `assert-runtime-resource-target.mjs` (name comparison only, so a mis-scoped
artifact download fails in milliseconds rather than after a ~20 minute build),
`validate-runtime-resources.mjs` before packaging (same diff plus the executable
bit and archive-content checks), and the electron-builder `afterPack` hook.

For SSH bootstrap, a desktop does not have a local copy of every runtime it
might need to upload — see "Sidecar fetch fallback" below.
`win32-x64` is still not an SSH-bootstrap *target*; a Windows desktop bundles it
for its own local brain.

Desktop distributable builds also package `apps/desktop/resources/agent-skills/`.
Remote bootstrap copies that directory into the selected remote ADE home as
`agent-skills/`; the CLI then re-seeds ADE-managed skills into runtime-native
home skill directories on launch.

`apps/desktop/scripts/validate-runtime-resources.mjs` is the preflight that fails the package step when artifacts are missing. Release builds populate the resource directory from the runtime-binary CI workflow's artifacts via `materialize-runtime-resources.mjs`. For local same-platform packaging, build into the resource directory directly:

```bash
npm --prefix apps/ade-cli run build:static -- --target <target> --out-dir ../desktop/resources/runtime
```

…or set `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1` to validate only the host target during local channel builds (release builds always require the full set).

`materialize-runtime-resources.mjs` searches `ADE_RUNTIME_ARTIFACTS_DIR`, then `apps/ade-cli/dist-static/`, copies any matching artifacts into the resource directory, and falls back to invoking `npm run build:static` for the host target when a missing artifact is the host build (downloading the official Node SEA helper if `ADE_STATIC_NODE_BINARY` isn't set and `ADE_RUNTIME_DISABLE_NODE_DOWNLOAD` isn't `1`). It reads the same resolved target set, and in pinned-target mode it also *deletes* any other target's sidecar it finds — a re-widened CI artifact download cannot leave a foreign payload behind for electron-builder to pick up.

### Sidecar fetch fallback

Because a package bundles one target, a mac desktop provisioning a Linux box —
or a Windows desktop provisioning a mac — has no local copy of the runtime it
must upload. `remoteSidecarCache.ts` closes that gap by downloading the missing
sidecar from the GitHub release, and `resolveBootstrapRuntimeSidecars` in
`remoteBootstrap.ts` is the one entry point both the POSIX and Windows bootstrap
paths call.

Resolution order is bundled → cache → release, and the release tag is **this
desktop's exact version**, never `latest`, so a remote can never skew ahead of
or behind the desktop that installed it. A version that is not a release tag
(`vX.Y.Z`, optionally with a pre-release/build suffix — i.e. a dev build) fails
`unavailable` rather than guessing.

| Step | Behavior |
| --- | --- |
| Cache location | `<machine ADE dir>/runtime-sidecars/<tag>/<target>/` — channel-scoped like the rest of the ADE home, since an Alpha desktop uploads Alpha bytes. Overridable via `RemoteSidecarDeps.cacheRoot` in tests. |
| Download | `ade-<target>[.exe]`, `ade-<target>.native.tar.gz`, and that release's `SHA256SUMS`, into a `.staging-<target>-XXXXXX` dir inside the version dir. |
| Verify | Every asset is checked against the release's own `SHA256SUMS`. A missing entry is as fatal as a mismatch. |
| Publish | `rename(staging, cacheDir)` — same volume by construction. Losing the race to a concurrent bootstrap adopts its (equally verified) copy; a half-written directory from an interrupted run is removed and re-published rather than wedging every future fetch. |
| GC | Every version directory except the current tag is dropped, best effort, after a hit or a successful fetch. |
| Cleanup | The staging directory is removed in a `finally`. Non-Windows binaries get `chmod 755`. |

Failures are typed (`RemoteSidecarFetchError.kind`) and the caller decides
whether one is fatal:

| `kind` | Cause | Bootstrap behavior |
| --- | --- | --- |
| `unavailable` | HTTP 404/403, or the desktop is not running a published release | Never fatal — this is the dev-build case; bootstrap continues without an upload. |
| `network` | DNS, TLS, timeout, proxy, 5xx | Survivable **only** when the remote already reports a runtime version; a first-time provisioning that cannot get bytes fails loudly. |
| `checksum` | Downloaded bytes do not match the published `SHA256SUMS` | Always fatal. Installing unverified bytes is never the better outcome. |

A survivable failure logs `remote_runtime.sidecar_fetch_failed` and returns no
paths. Steady-state reconnects never reach the network at all: when the remote
already runs exactly this desktop's version, the fetch is skipped before it
starts.

## Standalone runtime install

For headless machines that can run an SSH server but have no desktop, the runtime can be installed directly from a release. Windows 10 22H2 and Windows 11 x64 machines can install the standalone brain locally or be bootstrapped through Windows OpenSSH Server. Release publishing includes `install.sh`, `install.ps1`, `SHA256SUMS`, the `ade-<platform-arch>` binaries (with `.exe` for Windows), and matching native dependency archives. Desktop bootstrap uploads bundled runtime artifacts on first connect, verifies size and SHA-256 through native platform tools, and launches `ade rpc --stdio` with the channel-specific ADE home. Windows SSH bootstrap requires PowerShell 5.1 or newer and `tar.exe`; WSL, ARM64, and Windows Server are not supported in Windows v1.

```bash
curl -fsSL https://ade-app.dev/install.sh | sh
```

```powershell
irm https://ade-app.dev/install.ps1 | iex
```

These are the promoted URLs; `apps/web/api/install.ts` serves them by proxying the same release assets, so `https://github.com/arul28/ADE/releases/latest/download/install.sh` remains equivalent and is what the scripts fall back to for the binaries themselves.

`install.sh` (lives at `apps/ade-cli/scripts/install-runtime.sh`):

- detects platform / arch with `uname -sm`,
- downloads `ade-<platform-arch>`, `ade-<platform-arch>.native.tar.gz`, and `SHA256SUMS` from the release,
- verifies downloaded runtime assets against `SHA256SUMS`,
- installs the binary to `$ADE_INSTALL_DIR` (default `$ADE_HOME/bin`),
- extracts the native modules to `$ADE_HOME/runtime/<platform-arch>/`,
- verifies with `ade --version`,
- best-effort registers the per-user login service via `ade brain start` on macOS and systemd Linux — not `serve --install-service`, which inherits an unset `ADE_DEFAULT_ROLE`, registers the brain at role `agent`, and makes `ade connect` fail on every clean install.
- hands off to `ade setup` for everything after that: pinned agent CLIs, account, desktop app, end-to-end verification, and a closing summary. The same command re-runs the flow at any time.

Environment overrides:

- `ADE_VERSION=vX.Y.Z` — pin a specific release; default `latest`.
- `ADE_INSTALL_DIR=/custom/bin` — destination directory.
- `ADE_RELEASE_REPO=owner/repo` — fetch from a fork.
- `ADE_HOME=/path/to/.ade` — alternate per-machine state root.

After install, the headless machine can already serve clients. Desktop ADE on a developer laptop adds it as a remote target; the `ade` CLI works on the headless machine itself.

There are two ways to make that machine reachable, and they are independent:

- **SSH remote target** — the desktop bootstraps and tunnels to it. No account involved. Covered by the rest of this document.
- **Account-published machine** — run `ade connect` (or `ade connect --headless` over SSH, where no browser is available) on the box itself. It signs in, installs the per-user login service, and waits for the machine's row to reach the account directory, after which desktop, the web client, and iOS can all reach it without SSH. The install scripts run this for you as `ade setup`'s account step. No project is required: a headless box with an empty `~/.ade/projects.json` publishes itself and dials the relay as soon as its brain holds the machine sync-host lease. See `apps/ade-cli/README.md` §"ADE account auth" for the three-step contract and why the brain must stay running for the machine to stay published.

Headless hosts update through the same binary, without requiring the desktop app:

```bash
ade brain update --text
ade brain update status --text
```

The update command stages the next release under `$ADE_HOME/runtime/updates/`, verifies the staged binary with the staged native deps, promotes the binary/native deps into place, and restarts the per-user brain service. A connected mobile or desktop controller should expect the sync/RPC connection to drop briefly while the brain restarts.

### What a standalone brain finds without an app

A standalone brain (`$ADE_HOME/bin/ade serve`, a Node SEA) has no app
`resources` folder. It finds what an app brain gets from its resources here:

- **Native helpers** (`nativeHelperPaths.ts`, `simHelperClient.ts`). After the
  usual places (beside its own binary in `bin/resources/native`, where SSH
  bootstrap uploads them), it looks in its runtime archive
  (`$ADE_RUNTIME_ROOT/native/`), then in the installed ADE app's
  `Contents/Resources/native` (Windows: `resources\native`). The app is the one
  the desktop recorded in `$ADE_HOME/runtime/desktop-app.json`, then the
  channel's app (`ADE`, `ADE Alpha`, or `ADE_DESKTOP_APP_NAME`) in
  `/Applications` and `~/Applications`, skipping a bundle whose id is another
  channel's, and last the app Spotlight finds by the channel's bundle id (a miss is asked again after five minutes).
  A Spotlight hit counts only when `codesign --verify --strict` passes and its
  team is the installed app's (ADE's own team when none is installed), so a
  copy in a disk image, the Trash or Downloads is never run. Unsigned dev
  builds keep their explicit paths. The
  darwin runtime archive ships `ade-sim-helper` and `ade-media`, so the brain
  prefers its own build of those. The Mac Desktop driver is not in the archive
  and the app's signed copy comes first: Screen Recording and Accessibility
  grants belong to that binary. A sim helper that speaks another protocol is
  stopped at its `ready` line and named in the error, not used. "Missing"
  messages list every folder that was searched.
- **The agent `ade`** (`bootstrap.ts`). In a SEA, `argv[1]` is the literal
  `cli.cjs`, so the brain uses its own executable as the CLI entry: chats and
  terminals get `ADE_CLI_PATH`, the shim folder first on `PATH`, and
  `ADE_AGENT_SKILLS_DIRS`. Skills come from `$ADE_RUNTIME_ROOT/agent-skills`
  (shipped in every runtime archive), then `$ADE_HOME/agent-skills` (SSH
  bootstrap), then the installed app's.

## What works remotely

Remote project bindings route lanes, agent chat, PTYs, terminal IO, file operations, file-watch notifications, git actions, PR actions, native GitHub stack actions, PR AI conflict-resolution sessions, PR issue-resolution launch flows, AI PR summaries, issue inventory, cross-machine handoff destination checks/acceptance, and event streaming through the remote runtime. The global Chats route lists personal chats from every connected machine. Each call names its machine, so row actions and event reads reach the owner; the new-chat picker chooses where a new chat runs without changing the project tab. Calls without a target still use the window's bound machine, which is also where the Browser tab's docked chat runs. Remote lane preview URLs are opened through a local TCP forward created by the desktop, so a dev server bound to `127.0.0.1` on the remote can be inspected from the local window. A connected remote project's tab shows the real project logo and a yellow connected accent: the host brain resolves the icon and inlines it on `projects.list`, the desktop threads it through `RemoteRuntimeProjectRecord.iconDataUrl` → `OpenProjectBinding.iconDataUrl` to the tab, and persists it so the logo is restored on a cold start before the remote reconnects. Agent CLI failures surface in chat on the chat's machine: a copy not downloaded yet as the inline `AgentCliAuthCard` (Download on that machine), a signed-out agent as the sign-in card in the composer's place, which runs that machine's own sign-in through the chat's pin.

### Which desktop shows it

Two desktops can show one chat: the Mac Studio that runs it and a MacBook
connected to it. A request to put something on screen should land on the
screen of the person talking to the chat, not on both.

- **Every message names its desktop.** Preload stamps `chat.sendMessage`,
  `chat.steer` and a CLI chat's Enter (`pty.write` with a newline) with
  `inputOrigin: { clientId, local }` (`shared/sessionInputOrigin.ts`).
  `clientId` is one id per desktop install (`window.ade.app.desktopClientId`,
  kept in the renderer origin's storage, so every window of that desktop
  shares it). `local` says whether the runtime is on the same machine, which
  only the preload's routing knows. The runtime keeps the last stamp per
  session in memory (`main/services/chat/sessionInputOrigins.ts`). A message
  sent without a stamp (the phone, the CLI, another agent) resets it to
  unknown. Only a user client may supply a stamp; the runtime strips one from
  an agent's call.
- **Requests carry `targetClientId`.** `ade ui show` and the agent-driven
  floating offers (`work_tool_show_request`), forwarded browser opens
  (`built_in_browser_remote_request`) and Apple drawer reveals
  (`drawer-open-requested`) name the sending desktop. A desktop acts on a
  request only when the target is empty or is its own id
  (`renderer/lib/desktopClient.ts`). An `ade ui show` that the target does not
  answer within 4 s goes out again with no target. It keeps the same request
  id, so the target ignores the repeat if it was only slow.
- **Unacknowledged requests only follow a recent sender.** Automatic float
  offers and Apple drawer reveals have no answer to fall back on, so they are
  addressed to the sender only while its last message is under 10 minutes old
  (`RECENT_INPUT_ORIGIN_MS`), and to every desktop after that. When the
  addressed desktop answers `held`, `ade ui show` asks every desktop at once
  and waits 3.5 s for one of them to show it.
- **Unknown means everywhere.** After a runtime restart, or for a chat nobody
  has messaged from a desktop, requests carry no target and every desktop
  showing the chat acts, as before.

### Dev servers on another machine

A dev server a Studio lane starts lights the Browser on the MacBook exactly as
it does on the Studio: the globe button in the Work header, the Tools-pane
Browser status, and the launchpad chips. The Studio's runtime finds the
server (terminal output, agent shell output, a listener scan that never
polls; see `docs/features/chat/README.md`), publishes `dev_server_event`, and
answers `work_tools.listDevServers` and `work_tools.probePort`. Nothing opens
by itself. Clicking opens the page in the MacBook's ADE browser through the
tunnel.

Local project bindings use the local ADE runtime for the same surfaces — agent chat, session history, PTYs, terminal reads/writes, file operations and watchers, diffs, lanes, PRs, native GitHub stacks, PR issue-resolution launch flows, PR AI conflict-resolution sessions, issue inventory, tests, project config, and most git operations. Electron main still owns desktop-only services that physically require an Electron host.

Removing or disconnecting a machine never closes a project that exists elsewhere. A project tab is the repo, so its remote binding is only a default: when the machine goes away, the tab falls back to another checkout of the same repo — the local checkout first, then another connected machine — and only a repo that lives nowhere else closes. A disconnect keeps the tab and its view state, with the disconnected machine's lanes, chats, and terminals simply gone from the project; a remove does the same but also forgets the machine's saved details and remembered route. The Connections confirmation names which open tabs stay and which close.

## The ADE browser for a remote chat

The built-in browser belongs to a desktop (its main process owns the
`WebContentsView`). A brain only proxies calls to it over the desktop bridge
socket. So a pin never moves the browser's event stream; it changes where
`localhost` points and which desktop answers.

- **Loopback tunnels.** For a remote pin, `localizeRemoteLoopbackUrl` rewrites
  `localhost`, `127.0.0.0/8`, `[::1]` and `0.0.0.0` onto a per-(machine, port)
  forward (`remoteRuntimeEnsurePortForward`, memoized) before `navigate`,
  `createTab` or `showPanel`. The pane shows the remote origin and a tunnel
  badge, never the forward port. The first use of a new (machine, port) pair
  needs a person's yes, even with the `portForward` grant, because the agent
  picks the port; "Always for this lane" is kept in `browserTunnelAlwaysKeys`.
  Which agents may use the browser at all is a separate machine-wide setting.
- **Available on remote lanes.** `workToolAvailability` gates only the
  simulator and App Control on `isRemoteProject`. A chat on a remote tab's own
  runtime has no pin; `ChatBuiltInBrowserPanel` falls back to
  `projectBinding`, so it still tunnels.
- **A brain with no browser.** `ade browser open <url>` on a machine that runs
  only `ade serve` emits `built_in_browser_remote_request` and returns
  `{ status: "forwarded_to_desktop", requestId }`. A desktop that holds a pin
  for that lane runs it through the same approval and forward path and answers
  with `built_in_browser.acknowledgeRemoteRequest` ("Opened on <desktop> via
  tunnel", or after 5 s "no desktop is attached to this machine"). If Browser
  is not on screen, Work holds the request and switches the pane only for the
  focused chat (or no chat); a request for another chat waits for its panel.
  `builtInBrowser.onRemoteRequest` on the active binding uses the shared remote
  pump's fanout.
- **One request, one answering panel.** Several windows can show the Browser
  for one machine. `main/services/builtInBrowser/remoteRequestClaims.ts` grants
  the first claim per id and refuses the rest (ids kept 60 s, at most 500). A
  request with no id is let through.
- **The browser where the user sits.** An agent's `ade browser` commands run
  in the browser of the desktop that sent its chat the last message (see
  [Which desktop shows it](#which-desktop-shows-it)), when that desktop is not
  the agent's machine. The user watches it in their pane, with their sign-ins.
  - `BUILT_IN_BROWSER_METHOD_ROUTES` (`desktopBridgeMethods.ts`) gives every
    method one route (the compiler refuses one without): `open`,
    `user-desktop`, `local-file` (`upload`, `har`, `record`) or
    `agent-machine`. `remoteBrowserForwarder.ts#route` picks the path.
  - Opens (`navigate`, `createTab`) load quietly in a chat-owned background
    tab. A loopback URL may need a person's yes, so the desktop answers
    `needs_pane` and the open goes as a remote request with the pane and its
    approval bar. `showPanel` and `--panel` always take the request path.
  - Commands (`built_in_browser_remote_call`,
    `BUILT_IN_BROWSER_REMOTE_CALL_METHODS`: `observe`, `click`, `fill`,
    `readText`, `claim`, `getStatus` and the other tab calls) go to one
    desktop, and only its reply counts: `taken` at once, then `done`
    (`built_in_browser.replyRemoteCall`). `wait` and sign-in handoffs get
    their own budget. A screenshot's bytes travel in the reply and land under
    `.ade/cache/browser-observations/remote/`.
  - `renderer/lib/remoteBrowserCallHost.ts` answers on the desktop. It serves a
    machine once any chat pane shows a chat or draft on it: one subscription
    per machine, the four most recent, kept in localStorage and served again
    4 s after a reload (dropped after 7 days unseen). The call carries
    `collection` (`project` or `personal`); the host swaps in this window's
    root and runs `builtInBrowser.runRemoteAgentCall` (main:
    `builtInBrowserRemoteCalls.ts`, the same dispatch as the bridge socket).
  - One task stays on one machine: `remoteBrowserTabHosts.ts` remembers which
    browser holds each tab. `--tab` goes there; no tab goes where the chat's
    last tab is; a plain `open` follows the user. An unknown id is tried
    everywhere before it fails, and the error lists the machines asked. A
    holder that does not answer is an error, never a run elsewhere.
  - Broadcasts (`remoteBrowserBroadcast.ts`) reach every desktop with a pin on
    this machine: `listTabsForAgent` (`ade browser status`), `releaseLaneTabs`
    on a lane delete or archive, and `chatBrowserLifecycle` as a chat starts,
    finishes or ends. A tab list waits for the desktops that answered last
    time (or 1.2 s); after an unanswered list, lists stop for two minutes or
    until a desktop takes a command.
  - Watching another machine's tab is a poll of
    `work_tools.readBrowserTabFrame` (person only), and
    `work_tools.sendBrowserTabInput` carries Take control input.
  - Isolated sign-ins open on the user's desktop. A loopback one needs a
    desktop whose `needs_pane` reply says `requestCarriesSignIn`; otherwise
    the tab opens on the agent's machine.
  - Fallbacks to the agent's machine: no desktop takes a command within 4 s
    (then the chat stays local for 60 s); the last message came from the
    phone or the CLI; `--here`. `upload`, `har` and `record` are refused with a
    pointer to `--here` unless the tab is local.
  - Every result names where it ran (`browserHost`), every error the machine
    that refused (`builtInBrowserErrorOnMachine`). `ade browser status`
    prints the route and every machine's tabs.
  - Known limits: a tunnelled tab reports its forward port to the agent; a
    remote personal chat is served only after its pane was shown here; a
    download lands on the user's computer.
  - On the desktop, the Browser card says `chat on <machine>`, the floating
    preview shows only that chat's tabs, and "Attach to chat" tells the agent
    the tab is on the user's computer.
- **A request to show the user** (`showPanel`, `open --panel`) goes to the
  desktop that sent the last message. When nobody can tell, or that desktop
  does not acknowledge, it goes to every desktop, and the agent machine's
  panel opens too.
- **Chat links open the chat machine's `localhost`.** A link carries the
  chat's pin (`openLinkFromUi(url, event, { runtimePin })`); with no pin,
  `withLocalizedBrowserUrl` uses the window's binding. A mounted Browser panel
  takes the click; otherwise the link waits in `pendingBrowserLinkOpens` (3 s
  fallback). Another machine's `localhost` always opens in the ADE browser.

## A slow or dropping link

Every machine connection measures itself and adapts. Nothing here is global: a
fast machine on the same LAN and a far one in the same window each get their
own answer.

**Slow-connection mode.** `shared/slowLinkMode.ts` turns the mode on when two
of the last three round trips are 400 ms or more, or two connections dropped
within five minutes. It turns off only after five round trips under 250 ms with
no drop in five minutes, so a link near the line does not flicker. The samples
are the dial's latency and the 30 s maintenance ping; the drops are connection
evictions that are not a hand-over to another ADE. A ping that a freeze of the
machine's brain delayed is not a sample: the brain's reply then carries
`hostFrozenMs` (`brainPingReply`, `RuntimePingReply`), because that round trip
measured the freeze, not the network. The result rides the
existing connection snapshot as `slowLink: { active, reason, rttMs, far }` — no new
poll, timer or IPC call. The person's own setting for the machine wins: **Slow
connection mode** in the machine's **Edit** panel is **Automatic** (default),
**Always on** or **Off**, saved on this computer's target record
(`remoteRuntime.setSlowLinkMode(id, mode)`), so it applies per machine and per
computer. With the mode on, a chat on that machine shows `Slow connection to
<machine> · <rtt> ms` in the composer's status strip. Its X closes it in every
chat on that machine until the link is good again (`closeSlowLinkChip` in
`renderer/state/projectMachines.ts`, cleared by the shared connection feed);
the next slow spell shows it again. The machine row reads `<route> · <rtt>
ms · Slow connection`.

What the mode changes is only what would be hidden or delayed: a transcript
picture from that machine waits as a `Show picture · <size>` tile until it is
clicked (a picture already shown stays) and a plain-shell terminal types
ahead. An agent CLI's terminal sends every key to the machine as on a fast
link; to type on this computer first, the person opens the Work input box
(keyboard button in the terminal header).

Typing has a lower line of its own, `far`: two of the last three round trips at
150 ms or more turn it on, and the last five under 110 ms turn it off
(`FAR_RTT_ON_MS`, `FAR_RTT_OFF_MS`). At 150 ms each key already lags enough to
feel, so a far link gets the type-ahead without the rest of
the mode. Slow-connection mode always counts as far; **Always on** and **Off**
set both. Pictures in the proof drawer and
the lightbox load as before. The always-on transport work below runs in every
mode.

**Bulk pieces, sized to the link.** A transcript picture is read from the other
machine in pieces about 250 ms of the measured delivery rate (1 MiB on a fast
link, 16-30 KiB at 1 Mbit/s), with enough in flight to cover the round trip, and
a piece that times out or loses its connection is read again from the same
offset — the bytes already pulled are kept. `linkWantsSlowPath` skips the slow
path on a fast, near link. A paste over 128 KiB goes in parts of the same
measure, each naming its offset, so a drop costs only the parts that were out;
the picture appears in the composer at once, and a part that timed out is sent
again in the size the meter now allows. A picture of more than 1920 px on its
long edge also gets a display copy made on the machine that holds it: a JPEG
the tile shows, while the lightbox, copy, save and what the model sees keep the
original (see [Computer use](../computer-use/README.md)).

**Long actions.** `lane.create`, `lane.importBranch`, `lane.switchBranch`, the
archive and restore actions, `lane.initEnv`, `lane.applyTemplate`,
`git.pull`, `git.checkoutBranch`, `pr.createLaneFromPrBranch`, `pr.land`,
`archive.*`, `file.deletePath` and `lane.pushCloudStartBranch` go to a brain
that announces `backgroundActionJobs` with `backgroundJob: { id, waitMs }`.
The brain starts the action once per id, answers within 20 s ("still running"
or the outcome), and keeps a finished outcome for ten minutes; a call sent
again after a drop joins the same run. The desktop keeps asking with the same
id until the action's own budget runs out, and stops as soon as the person
disconnects. An older brain keeps the one-request path.

**One send, one copy.** A chat send carries `clientSendId`. The desktop keeps
the id of an unconfirmed send (per chat and payload), so the same message sent
again after a drop reuses it; the pool sends it again after a reconnect only to
a brain that announces `clientSendDedupe`; and the id is forgotten once the
message is confirmed, so an identical message later is a message of its own.
When one call loses a dropped connection, the other reads on that machine wait
for the same redial and ask again, while a write still reports that its outcome
is unknown.

Text for a running agent CLI (`chat.typeIntoCli`) gets the same treatment from
both modes: the Work box (`when: "free"`, typed at a free prompt) and
`when: "now"` (typed at once; sent only by older desktops' terminal local
line, which this desktop no longer has). A brain
that announces `agentCliTypeNow` answers a repeated `clientMessageId` once for
both modes; the pool sends the text again after a reconnect only to such a
brain, and a send refused before it dialled comes back to the caller as not
sent. See
[Terminal and Session UI Surfaces](../terminals-and-sessions/ui-surfaces.md#input-box-for-a-running-agent-cli-workcliinputboxtsx).

**A drop that is a blip.** A link that was up and dropped redials every 2 s for
3 minutes (`FAST_REDIAL_WINDOW_MS`, cleared by the ordinary bounded backoff
after that); each redial waits for the one before it, so a dead link costs one
dial per interval and a failed redial writes no snapshot update. A window's
network change (`online`, or the browser's connection change, merged by main)
redials dropped machines at once and pings the connected ones, as a wake does.
For the first 20 s (`RECONNECT_HOLD_MS`) the dropped machine still reads as
connected, with `reconnectingSinceMs` saying when it dropped: the open chat and
the Work list stay, the new-chat picker keeps that machine, and a call waits up
to 8 s (`RECONNECT_CALL_WAIT_MS`) for the link instead of failing. A cloud
computer skips the hold, so its drop is shown and a sleeping one can rest;
Disconnect, Remove, a rest, and the end of the hold all end it at once.

**Text the person is not looking at.** A window tells its machine which
terminals it shows (`ptyDataIds`), and the brain sends only their output; see
[PTY and sessions](../terminals-and-sessions/pty-and-sessions.md) for the
capability and the list update.

**Numbers on both ends.** `remote.link_summary` on the desktop and
`rpc.link_summary` in the brain write one line per connection every five
minutes (round trip percentiles, drops, bytes, route, mode), plus a switch line
(`remote.slow_link_switch`) and a close line (`rpc.link_closed`).

## Mobile reachability

iOS uses SSH only as an optional one-time pairing bootstrap. Routine mobile
traffic always uses the paired sync WebSocket advertised on the LAN, through a
Tailscale tailnet, or through the relay. Install Tailscale on the phone and the
ADE machine for a direct route when they are not on the same local network.

On desktop, the **This computer** card and **Connections > Phone**/**Web** tabs
are runtime controls that always describe the **physical computer running this
ADE desktop**, even while the window is bound to a remote project. Most
`window.ade.sync.*` calls follow the active binding and would report the remote
machine, so the Connections panel reads its identity, pairing code, and local
device lists through `window.ade.sync.getLocalStatus(...)`, which deliberately
bypasses the binding and targets this machine's local brain (see the
`ade.sync.getLocalStatus` IPC handler and `useSyncConnections.ts`; the call goes
through the shared `renderer/lib/localSyncStatusReader.ts`, which coalesces it
with every other subscriber's read and backs off while the local runtime is
degraded). The
binding-routed `sync.getStatus` is still fetched, but only to detect that the
window is remote-bound and to name the machine it is working on. Because the
pairing and device *mutations* (`setPin`, `generatePin`, `clearPin`,
`forgetDevice`, name edits) continue to route through the binding, the panel
presents them **read-only while remote-bound** and labels the connected-device
list with the local computer's name so it cannot be mistaken for the bound machine's.
The pairing PIN manager lives on the This computer card. The legacy in-process
desktop sync host is disabled by default and can be re-enabled only for
diagnostics with `ADE_ENABLE_DESKTOP_SYNC_HOST=1`.

## Troubleshooting

- `Remote target was not found` — the saved target was removed or the UI has a stale selection. Refresh the target list.
- `Remote machine was manually disconnected. Connect again to use this remote project.` — the user explicitly disconnected the target; ADE will not implicitly reconnect or restore it until Connect is pressed.
- `Not connected · you disconnected it on <date>` — the row's line for a manual disconnect. The same rule applies: ADE waits for Connect.
- `Not connected · Reconnect automatically is off` — the machine has connected before, but its **Reconnect automatically** checkbox (Edit) is off, so ADE does not reconnect it when the app opens. Connect makes a one-off connection and leaves the checkbox as it is. A machine that has never connected shows `Never connected` instead.
- `Slow connection to <machine> · <rtt> ms` in a chat's composer — slow-connection mode is on for that machine (its X hides it until the link recovers), so pictures wait for a click and a plain-shell terminal types ahead. **Slow connection mode** in the machine's **Edit** panel turns it off or forces it on. See [A slow or dropping link](#a-slow-or-dropping-link).
- `Remote ADE service connection failed.` — the target is currently unreachable or its route failed. Automatic reconnects continue with bounded backoff; press Connect to bypass the current backoff when you want an immediate retry.
- `SSH server at <host:port> closed the connection before ADE could finish the SSH handshake` — the TCP route opened but the server reset or closed the SSH handshake. Check Remote Login/sshd, firewall rules, and Tailscale SSH policy. An sshd that saw many refused sign-ins from this computer also does this for a while (OpenSSH source penalties).
- `SSH authentication failed for user(s) … ADE won't retry on its own. Fix this, then press Try again.` — the server refused every key. ADE stops retrying so it does not repeat the refusal on a timer; fix the user or key, then press Try again or edit the machine.
- `The SSH host key of <host:port> is not the one ADE trusts for this machine.` — the key does not match `known_hosts`. ADE stops retrying until the key is trusted again or Try again is pressed.
- `Nothing is accepting SSH connections at <host:port>.` (kind `unreachable`) — the port refused the connection (for `localhost`, on both IPv4 and IPv6). The machine is off, sshd is not running, or a port forward is missing. Automatic reconnects continue with backoff.
- `ADE service is not installed ... no bundled ADE service is available` — install or build `ade` on the remote, or use a release build that includes runtime resources for the remote architecture.
- `Uploaded ADE service version mismatch: expected X, got Y` — the uploaded binary did not report the expected runtime version. Rebuild the static runtime artifacts for the current desktop version.
- `Remote ADE service does not support multi-project mode` — the remote is running an older ADE before multi-project RPC. Re-bootstrap from a current desktop build.
- `ADE couldn't connect to this machine. Check that ADE is open there, then press Try again.` — ADE could not initialize any compatible installed service. Expand technical details to see each channel home and the launch, initialization, or capability-negotiation failure.
- `Remote ADE service <version> does not support <capability>.` — the remote runtime connected but is missing a specific `machineProjects` capability the renderer just called (e.g. `cloning remote projects`). Update ADE on that machine.
- `Remote ADE service method <method> failed (code N): <message> Details: ...` — a remote handler failed; the JSON-RPC `code`, `message` and `data` are shown together.
- `Remote ADE service connection was interrupted before ADE could confirm the action result. ADE reconnected …` — the link dropped while a call that must not run twice was in flight. The machine is reachable, so the connection status stays healthy; only that call's result is unknown. Idempotent writes the desktop sends on its own (`work_tools.setActiveTool`, `pr.reconcileOnFocus`, `session.clearWokeMarker`) are replay-safe and run again instead.
- `Remote ADE service timed out waiting for method ...` — only that request expired. The shared runtime connection and event subscriptions remain live; retry explicitly if the operation is still needed, because ADE does not replay timed-out mutations automatically.
- A cross-machine handoff warning that ADE lost confirmation — destination
  acceptance was already dispatched, but its request timed out or the runtime
  connection closed. The destination may still finish. Check that machine
  before retrying; the handoff ID makes an explicit retry reconcile the same
  destination lane/chat rather than automatically replaying the mutation.
- "Couldn't look for computers on this Wi-Fi" warning on the Connections pane — the one discovery diagnostic, from a failed Bonjour scan. Account computers are still listed. Tailscale discovery never reports a problem here; Tailscale's status lives in Account → Private network.
- "Repair" next to the This Mac / route-publish failure — this Mac's brain cannot read the stored account session, so it never publishes to the account directory even though the app is signed in. The button restarts `com.ade.runtime` and waits for the replacement to answer; the new process re-reads the keychain from scratch. If it reports "Repair failed — quit and reopen ADE", a newer runtime is usually already running and must not be forced down.
- Agent provider missing or signed out — the inline `AgentCliAuthCard` downloads it, and the composer's sign-in card signs it in, on the chat's machine.
- "<Machine> says this device's pairing is out of date — pair it again." — the paired host was reached and it *rejected* this desktop, so the other routes' `timed out`/`no answer` entries under **Details** are noise. A host names itself in `hello_error.host`; when that is not the saved host (another ADE now answers at the address), the attempt is `identity`, never `pairing` (`PairedRuntimeHostMismatchError`, telemetry code `host_mismatch`), and the address is forgotten. A host too old to name itself is still read as the paired host. When the machine is also on this ADE account the error card carries a **Pair again** button, which re-runs account-directory adoption (`account.pairMachine`) for that machine. Nothing re-pairs on its own.
- The headline never lists routes. It is one sentence derived from the dominant attempt failure; every host, port, duration and the diagnostic ID stay in the collapsed **Details** list built from `RemoteRuntimeConnectErrorInfo.attempts`.
- Attempt failures are classified from the host's structured `hello_error.code`, never from its message text — see [When the connect fails, the user reads one sentence](#when-the-connect-fails-the-user-reads-one-sentence) for the code table. Both `repair_required` and `auth_failed` mean the same thing to a paired client, so iOS treats them identically when deciding whether a saved pairing may be dropped — and only ever when the rejecting host's identity matches the saved pairing.
- `wrong machine answered` in **Details** — the address answered as a different host. That endpoint is *forgotten* rather than demoted: the endpoint list is otherwise append-only (recording a failure re-adds the address, and a demoted address is still dialled, last, until it answers or mDNS sees it again), so a neighbour's tailnet name that once landed in the record would be dialled on every connect.

## Pairing identity and paired-secret lifetime

A desktop's pairing identity is per-host, not per-machine: `sync-device-id` is
the machine's stable id, but each entry in `desktop-paired-machines.json`
carries its own `deviceId` that the host uses as the key for its pairing
record. Re-pairing the same machine therefore **must** present the same
`deviceId` — the host upserts on that key. `pairWithMachine` recovers the prior
identity (and its `siteId`) before it sends the pairing request, because the
`hello` that reports the host identity only arrives afterwards. It looks the
saved record up by two things that both identify a *host*: the caller-supplied
`hostDeviceId` (a QR/link payload and account-directory adoption both carry it),
then the relay machine key parsed out of a `/connect/<key>` endpoint. A bare LAN
address is not a host identity — DHCP handing `192.168.1.240` to a different computer
would hand that computer the identity this desktop uses with the first one — so
matching on a saved endpoint is deliberately not an option, and a LAN pairing
with no `hostDeviceId` mints a fresh identity.

A fresh id for a host that already has one leaves an orphaned, still-valid
credential on the host for every re-pair.

Three logs make a lost pairing diagnosable:

- Host: `sync_host.paired_device_rejected` (`unknown_device` vs
  `secret_mismatch`) and `sync_host.paired_account_owner_mismatch`, both at
  warn. The host distinguishes those two rejection causes for itself but tells
  the unauthenticated caller the same thing either way, so the close reason is
  not an existence oracle for device ids.
- Host, for peers that never spoke: `sync_host.peer_closed_without_frames` at
  **debug**. The relay readiness self-probe bridges in over loopback and
  disconnects without sending a frame on every poll, and so does a port scan.
  Keeping that routine traffic out of `sync_host.peer_closed` is what makes a
  rejected peer visible at a glance. Anything that sent at least one frame —
  including every authentication failure — logs `sync_host.peer_closed` at
  info.
- Desktop: `account.local_machines_removed`, written at **warn** to the
  machine-scoped `<machine ade dir>/runtime/account-trust.jsonl` (and mirrored
  at info to the project logger). The machine-scoped sink is the load-bearing
  one: dropping a paired secret is a machine-level credential mutation, and the
  project logger follows the active project, which on a remote-bound project
  ships the record to the other machine and leaves nothing on the machine that
  actually lost its trust. Each removed credential records its host device id,
  host name, previous owner, and whether the owner actually changed, so an
  intended account switch is distinguishable from an identity glitch that
  silently cost trust. The sink is resolved lazily and never fails account auth.

## Relay tunnel and the sync port

The relay tunnel client is cached **one per machine**, keyed by the cloud-relay
config file, and is built by whichever runtime bootstraps first — regularly a
scope that owns no shared listener (a headless one-shot, an embedded fallback).
So it must not capture per-runtime state at construction. The runtime that owns
the listener calls `attachHostListener()`, which supplies the port, loopback
nonce, and bridge proof, registers the `onLoopbackValidated` retry hook, and
validates once the listener is bound. Symptom when this is wrong:
`routeHealth.listener` reports bound and loopback-validated on a real port while
`relayBridgeValidated` is false and `lastBridgeValidationAt` has never been set —
relay silently never works, and a LAN auth failure becomes a total outage
because no fallback route exists.

Whether a runtime may dial the relay at all is a separate question, decided by
`relayTunnelAuthorityGate` on the machine-wide sync host lease
(`syncHostSingleton`), not by owning a listener. The relay Durable Object keeps
one host control socket per `machineKey` and evicts the previous holder with
close code `4505`, so two brains that both dial it would evict each other in a
loop. A `4505` close therefore suppresses redialing (bounded
re-attempts on a 60 s floor, then a stop with a 10-minute re-arm) and surfaces
as `routeHealth.relay.relayControlSuppressed` in `ade doctor` and in the
desktop relay banner, rather than being retried as if it were a network fault.
The gate rides out the momentary authority gap of an in-process project switch
with a 5 s grace and re-attaches the host listener on every start, because
`stop()` drops the listener reference and a start without it would leave a live
control socket with no bridge, rejecting every phone connect with "host sync
listener unavailable".

ADE advertises its sync port with `tailscale serve --bg --tcp=<port>`. That
outlives the process that registered it, so the served port is reclaimed after
each successful publish (`staleAdeTailnetServePorts` +
`reclaimStaleTailnetServes`). Without it every restart — and every force-kill
that skips teardown — leaves an entry that Tailscale keeps bound, and ADE's next
bind fails `EADDRINUSE` and walks one port higher, again and again.

Only ADE's exact signature is reclaimed — a port inside ADE's sync range
forwarding to `127.0.0.1` on the **same** port — so a hand-rolled
`tailscale serve` is left alone, and the live port is re-checked inside the loop
because reclaiming frees exactly the low ports a restarting host prefers.

Beside the TCP entry, ADE publishes a secure route for browsers:
`tailscale serve --bg --https=<sync port + 10000> http://127.0.0.1:<sync port>`
(`publishTailnetHttps`), advertised to the account directory as a `tailnet`
endpoint with `url: wss://<name>.ts.net:<port>`. It needs MagicDNS and HTTPS
certificates on the tailnet; `tailscale status --json` (`CertDomains`, read by
`tailscaleLocalStatus.ts` with a one-minute cache) says which is missing, and
the route reports `needs_magic_dns` / `needs_https_certs` so Settings ›
Account › Private network can link to the switch. The hosted web client keeps
the URL as an explicit WSS endpoint and prefers it to the relay on later
connects. Stale HTTPS entries are reclaimed by the same rule as the TCP ones
(`staleAdeTailnetHttpsPorts`).

Diagnosing this needs `netstat -an -p tcp` or `tailscale serve status`, **not**
`lsof`: tailscaled runs as root, so a user-level probe reports the ports as
having no holder, which reads as "free" and is the opposite of the truth.

## Wedge supervision and remote repair

A brain can hang with its process alive: the event loop dies, the brain keeps
its socket and sync lease, and answers nothing. launchd's `KeepAlive` and the
Windows supervisor react only to an **exit**, so three layers cover a hang:

- **In-process.** `brainLoopWatchdog` runs a worker thread that SIGKILLs the
  brain when the event loop stalls past its threshold. It cannot help when the
  worker never starts or dies with the process.
- **External.** The brain writes `<ADE home>/runtime/heartbeat.json`
  (`{pid, ts, seq, startedAt}`) every 15 s from a timer that ticks while idle
  (`services/runtime/brainHeartbeat.ts`). A watcher kills a brain whose beat is
  older than 90 s **and** whose pid is alive. An absent or unreadable heartbeat
  is "no judgement", never "wedged"; a stale beat with a dead writer is left to
  the supervisor. `evaluateBrainHeartbeat` needs three facts and returns a
  named verdict for each one it lacks:
  1. The beat is stale and its writer is alive and positively identified.
  2. **The watcher was awake to see it go stale.** A sleeping laptop suspends
     both. When the gap since the watcher's last run reaches
     `brainWatcherSuspendFloorMs` (`max(90 s, 3 × the check interval)`) and the
     beat's age fits inside that gap plus the staleness window, the verdict is
     `machine_slept` and nothing dies. A brain quiet for days before a short
     nap still dies.
  3. **A previous check saw this same beat**, matched on the beat's own
     timestamp. A brain the OS only stopped scheduling beats again first; until
     the second consecutive stale check the verdict is `stale_unconfirmed`. A
     fresh beat clears the strike.

  `ADE_BRAIN_HEARTBEAT_STALE_MS` overrides the 90 s (a positive integer wins,
  never below 30 s), and the suspend floor rescales with it.
  - *macOS*: a separate launch agent, `com.ade.watchdog` (`.alpha` for Alpha),
    `StartInterval` 60 s, runs `ade runtime watchdog-check` from the brain's
    binary. It is installed and removed with the brain's agent, best effort.
    Each check is a fresh process, so it reads the variable each time.
  - *Windows*: the PowerShell supervisor's restart loop waits in 15 s slices and
    applies the same three rules inline (`Get-StaleBeatTs` returns the beat's
    timestamp for the second strike). No Scheduled Task. It reads the variable
    once at start, so a change applies after the service restarts.
- **Desktop, when running.** `projectRecoveryService.restartBrain` probes and
  repairs; the watchdog is for the headless case.

A kill writes the `event-loop-wedge.json` breadcrumb the in-process watchdog
writes, so the next start promotes it to `last-wedge.json`, logs
`brain.recovered_from_wedge`, and shows it in `runtime/info`'s `lastWedge`.

- The brain's launch agent pins `ThrottleInterval` to 10 s. While
  `/Applications/ADE.app` is being replaced, a restart onto half-written files
  dies at once (`Cannot find module '/serve'`); the floor makes that a slow
  retry, not a hot spin.
- `brainFreshnessMonitor` re-hashes the installed runtime about every 5 minutes
  and restarts into new code when the hash moves. A missing, unreadable or
  changing file is a swap **in progress** and must hold still across a settle
  pause before it is hashed, so a mid-copy binary never triggers a restart.

### `machine.updateAndRestart`

A machine that is stuck, or runs old code because no local desktop noticed,
must be fixable from wherever the user is. The projectless method
`machine.updateAndRestart` needs the `cto` role and the authenticated runtime
RPC endpoint. A paired phone or ADE Web asks for the same run over the sync
commands `machine.updateImpact` and `machine.updateAndRestart`
(`apps/ade-cli/src/services/sync/machineUpdateRemoteCommands.ts`): any paired
controller may run them, and a viewer or lane-share guest is refused. One run
happens per process, whatever asked for it (`machineUpdateInFlight.ts`): a
second caller joins the run in flight and gets its result. It is never
automatic and never silent.

- **Who asked.** The host records `requestedBy` (a machine name and client
  kind), from the connection's paired device record (the client's own claim
  only when there is none; cleaned and length-capped). It appears in
  `brain.remote_update_route`, `autoUpdate.remote_install_requested`, and the
  message agents get after an accepted restart ("an update to 1.2.3 that "Mac
  Studio" asked for"). It never changes routing; older clients ignore it.
- **Version.** The client sends `targetVersion`. A machine already on it (or
  past it) installs and restarts nothing: "Already on X — nothing to update,
  nothing restarted" (`alreadyCurrentResult`), because a restart stops every
  agent there. A request with no version is the "fix a stuck machine" button
  and still restarts.
- **Steps.** The reply names `check`, `apply` and `restart`. `restart` comes
  back `pending`: it ends the process that answers, so the client confirms by
  reconnecting and reading the version.

**Which updater runs.** A brain served by an open desktop app belongs to it:
the app re-registers its runtime whenever the brain goes missing, so a
standalone runtime installed under it is replaced within milliseconds.

- The brain first calls `app_update.install` on this machine's desktop bridge
  (`apps/ade-cli/src/services/runtime/desktopAppUpdateBridge.ts`). The app
  (`apps/desktop/src/main/services/updates/remoteUpdateInstall.ts`) checks its
  feed and answers `installing` (it runs its consented `quitAndInstall` 1.5 s
  after the reply), `downloading` (installs when done, gives up after 30
  minutes), `already_current`, `no_update`, `unsupported` (development and
  channel builds) or `failed`. The app's post-update step restarts the brain.
  The same on macOS and Windows.
- With no app, an app too old for the method, or `unsupported`, the standalone
  `ade brain update` runs. The reply's `route` (`desktop_app` or `standalone`)
  says which, and `pendingVersion` names the version to come back on.
- A connected Windows machine whose build cannot self-install
  (`isWindowsSelfInstallBlocked`, `shared/updateVersions.ts`) gets no
  `app_update.install`. `runtimeBridge` uses `updateViaRemoteTerminal`
  (`remoteTerminalUpdate.ts`): a remote PTY in the primary lane of that
  machine's live project runs `ade brain update [--version X]`, and the client
  polls `session.get`. Exit 0 or a dropped connection is installing (route
  `terminal`); a refused read while connected is retried, then failed; a
  non-zero exit is failed with a manual hint. It gives up after
  `REMOTE_MACHINE_UPDATE_TIMEOUT_MS` (15 min).
- The app-routed install on a healthy build runs a read-only service-removal
  preflight first, so `failed` carries the reason. See
  [Desktop auto-update](../onboarding-and-settings/desktop-auto-update.md).
- A brain update this app did not start writes
  `<ADE home>/runtime/update-status.json`. While it says `staged` (2 min),
  `applying` or `restarting` (5 min), or `succeeded` (60 s), the desktop
  connection pool does not repair the service, so an open app cannot put its
  older runtime back.

**The client checks the result.** Before it sends, it re-reads each machine's
live version and skips one already on the target with the same "Already on X"
answer. It records `pendingVersion` (from an older host, `targetVersion` for an
applied update). When the machine reports that version the row says "Updated
to X"; after 5 minutes (35 for a download) it says "Still on Y — the update to
X didn't apply". A reconnect after the restart refreshes the version
(`RemoteConnectionPool.onEntryConnected`), so a finished update is never
called failed. The button stays busy until then.

**Nothing restarts without a yes.** The desktop first asks what the update
would stop (`ade.remoteRuntime.getUpdateImpact` → `runtime.updateImpact`) and
shows it in the confirmation: chats mid-turn by name, plus counts of open CLI
sessions and terminals (a restart closes each).

- `runtime.updateImpact` is `cto`-gated, reads only booted projects (it never
  boots one), and includes personal chats. A machine too old for it falls back
  to `runtime.activitySummary`: "Work is running" or "Nothing is running".
- One 3-second deadline covers both asks; no answer reads "Couldn't check
  what's running", never idle. The IPC never rejects.
- With two or more connected machines behind, `MachinesBehindBanner` ("N
  machines are behind", naming the target) offers **Update all**: one
  confirmation with a block per machine, then the updates in parallel.

**Where it is offered.** General's ADE card has an update row per machine
(`components/settings/general/MachineUpdateRows.tsx`), and **Update other
machines** (`components/settings/OtherMachinesUpdateSection.tsx`) is under Your
computers on the Account page. Each lists machines with version and track,
"Update" for those behind the newest build on **their own** track (Stable never
gets Beta, or the reverse), and "Update all N". This computer's restart dialog
(`components/app/autoUpdateInstallAction.tsx`) shows the same rows with an
"Update" box each; picked machines update first and this computer restarts
last, and a refusal is named with a choice to restart anyway. All of them use
one store (`components/remoteTargets/machineUpdates.ts`), so an update shows as
in flight everywhere and its outcome survives leaving the page. The words for
what runs live in `components/remoteTargets/MachineUpdateImpact.tsx`. The
browser client cannot ask a machine to update, so it does not show the section.

### Account state and reachability

Relay gating asks "is this machine still theirs", not "can I call the API".
`accountAuthService.getStatus()` reports a `sessionState`, and `expired` (a
rejected refresh grant) and `unreadable` (a credential store that could not be
read) are accidents, not decisions: the relay tunnel stays up and the machine
keeps its published directory row, so already-paired devices keep connecting
while the user signs in again. Only a deliberate `signed_out` drops the tunnel.
The relay control socket authenticates with machine credentials rather than the
account token, so this costs nothing in reachability terms. Direct LAN and
tailnet routes to a paired device never consulted account state at all.

## On an ADE Cloud computer

An ADE Cloud computer runs the same brain. On it the brain also keeps the
account server up to date, so a person reads the lane with no computer awake.
The server routes and caps are in
[ADE Cloud with no computer of your own](../ade-cloud/README.md#ade-cloud-with-no-computer-of-your-own).
Each part below runs only when `isAdeCloudComputer()` is true, except the
account lane index, which every brain sends.

### What the brain saves before it rests

The rest save (`apps/ade-cli/src/services/cloudChats/cloudRestSave.ts`) runs
these steps in order, four uploads at a time, inside one time budget:

1. The chats' newest parts (`cloudChatUploader.ts`).
2. Shell and CLI copies: the 50 newest terminals across the open projects. A
   shell keeps its last 5,000 lines (2 MiB at most). A CLI keeps its stored
   terminal screen when it fits, else its last lines. The text is redacted
   first. A terminal with no new output since the last save is not sent again.
3. A Git summary for each lane, when it changed.
4. Fork capsules, only with `--capsules` (the delete path): Claude, Codex and
   OpenCode chats, and Claude Code and Codex CLIs. A capsule over 20 MiB is
   skipped, and the continue replays the saved transcript.
5. Native subagent transcripts of Claude, Muse and OpenCode chats, as saved
   chats under their parent (`parentChatId`, `spawnKind: "native_subagent"`).
   The newest 20 subagents of each chat go, one part of at most 4 MiB each.
   The idle step skips OpenCode, because its subagents are read through its
   server.
6. The event-wake topics (Linear workspaces and webhooks that a rule on this
   computer acts on), only when the list changed.

The save runs at three points:

| When | Budget | Capsules |
|---|---|---|
| The idle step, before the computer sleeps (`cloudKeepAwake.ts`) | 60 s | no |
| `ade cloud prepare-stop`, in the time left after the chats | what is left | no |
| `ade cloud save-for-rest [--capsules]`, which the server's idle cleanup runs between push-work and the check | 225 s | with the flag |

What the save already sent is kept in `<ADE home>/cloud/rest-save.json`. A
disk copy under a new machine key saves everything again.

### Messages that waited while it slept

The queue drain (`cloudChatMessageQueue.ts`) runs 15 s after the brain starts,
when the brain signs in, when the computer wakes, and when the server runs
`ade cloud messages drain`. For each message it claims the
message, sends it, and reports `delivered` or `failed`. A journal in
`<ADE home>/cloud/chat-messages.json` makes sure a crash between the send and
the report never sends a message twice. The messages of one chat go in order:
a message that waits stops the rest of its chat.

- **A chat.** The drain waits up to 30 minutes for the chat to be idle. If the
  chat's provider is not signed in, the launch's sign-in card shows first. The
  send carries `clientSendId` = the message id, so the written `user_message`
  carries the same id.
- **A CLI.** The drain types the text through the composer's CLI send path
  (`typeIntoAgentCliWhenFree`, held until the CLI is free). That path waits
  for the CLI's ready signal ([the turn signal table](../terminals-and-sessions/pty-and-sessions.md#exact-turn-status-for-agent-clis)):
  Claude Code hooks, Codex 0.167+ OSC 7501, and output guesses (about 12 s of
  quiet) for every other CLI. A busy CLI tries again at the next drain.
  Attached files go into the text as a list of paths.
- **A CLI that is gone** (the computer restarted) gets `failed` with "This CLI
  isn't running on its computer any more (the computer restarted), so ADE
  couldn't type the message. Open the CLI and send the message again."

### A chat or CLI whose computer was deleted

The server starts a continue launch on a new computer. The new brain makes the
lane, then restores the chat or CLI with the same id
(`cloudChatRestore.ts`). The restore reuses the cross-machine move
destination; see
[Continue on a new ADE Cloud computer](../sync-and-multi-device/cross-machine-session-handoff.md#continue-on-a-new-ade-cloud-computer).
The brain holds the chat's uploads while it restores, then goes on from the
server's last part.

### Other account work

- **The account lane index.** `accountLaneIndexPublisher.ts` sends each
  project's lanes (name, branch, machine, PR number) to `/account/lanes`. A
  lane or PR change makes one write 30 s later, so a burst makes one write. The
  same set makes no write. The
  last sent set is in `<ADE home>/account-lanes.json`. Every brain publishes,
  not only cloud computers.
- **Git identity.** `cloudGitIdentity.ts` sets `user.name` and `user.email` on
  a cloud computer to the account's GitHub noreply identity, else
  `ADE Cloud <cloud@users.noreply.ade-app.dev>`. It never writes over a value
  a person set. Its record is `<ADE home>/cloud/git-identity.json`.
- **Being deleted.** Once the server says the computer is being deleted, the
  brain refuses new work with "This ADE Cloud computer is being deleted, so it
  can't take new work. Its lane is saved; continue it on another computer."
- **Provider logins.** The cloud computer gets the account's sign-ins, and
  access-only copies of the logins in the subscription proxy
  (`<ADE home>/proxy/auth`, without refresh tokens, `providerLoginCarry.ts`).
  The proxy on the person's own computer stays their one owner.

## Related docs

- [Internal architecture](./internal-architecture.md) — protocol shape, bootstrap sequence, sync command scoping.
- [ADE Cloud](../ade-cloud/README.md): Linux machines ADE runs for the person, and the provider seam behind them.
- [ADE CLI](../../../apps/ade-cli/README.md) — runtime modes, service manager, machine layout, and legacy compatibility command names.
- [Sync and Multi-Device](../sync-and-multi-device/README.md) — phone pairing and multi-device sync (hosted by the same runtime).
- [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md) — route, repository, Git, capsule, and retry contract for continuing a Work chat on another connected machine.
