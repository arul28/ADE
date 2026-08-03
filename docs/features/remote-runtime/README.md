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

- `apps/desktop/src/main/services/remoteRuntime/` — paired transport
  (`syncRuntimeTransport.ts`), loopback preview forwarding
  (`syncPortForwardClient.ts`), paired credential and endpoint history
  (`syncPairedMachineStore.ts`), LAN → tailnet → relay ordering
  (`pairedRuntimeRoutes.ts`), paired bootstrap and connection diagnostics;
  plus the Advanced SSH transport (multi-route fallback, bounded connect/exec
  timeouts, strict host-key verification, normalized handshake errors) and
  runtime upload/bootstrap. The folder also owns the target registry, runtime
  RPC client (request-local timeouts with connection-fatal transport/protocol
  failures), remote connection pool (paired-first with eligible SSH fallback,
  eviction listeners, connection-failure retryable reads, preview forwards,
  optional-action fallbacks, event-stream gap/epoch propagation, route-pinned
  sensitive action dispatch, unknown-outcome errors for non-replayable actions
  that lose confirmation, and capability-gated handoff storage preflight),
  connection service, and Bonjour + Tailscale discovery.
- `apps/desktop/src/main/services/ipc/runtimeBridge.ts` — runtime IPC boundary:
  remote target registry, connect / projects / project-open channels, remote
  action/sync/event dispatch, local-runtime project action/sync/event routing,
  local port-forward creation for remote previews, per-target action registry
  lookups, replay-aware event streams, manual disconnect handling, and
  per-window remote-open generation guards so a slow earlier remote-project
  open cannot overwrite the latest window binding. It also registers
  `ade.runtime.events.release`, the renderer's explicit teardown for a
  subscription it has stopped reading.
- `apps/desktop/src/main/services/ipc/runtimeEventSubscriptionRegistry.ts` —
  the store behind those streams. Subscriptions are keyed by
  `(sender, requestKey = <bindingKey>:<category|*>:<replay|live>)`, because one
  window runs several pumps at once (active binding, one pinned PTY pump per
  foreign lane, one pinned chat pump) and keying by sender alone would make each
  new pump tear down its siblings. Stale entries are reclaimed by idle expiry
  (refreshed on every poll, swept every 20 s at a 60 s idle threshold) with the
  renderer's release as the fast path. Every caller — release, the ended
  callback, remote disconnect, sender death, the sweep — removes through one
  function, so disposal and pruning cannot drift apart, and cleanup functions are
  attached through an atomic check so a subscription replaced mid-flight never
  adopts a disposer the registry could not run.
- `apps/desktop/src/preload/pinnedRuntimeEvents.ts` — the renderer-side half:
  every event pump that reads a binding the window is *not* bound to. It owns one
  shared PTY pump per pinned binding (polling plus `ade.runtime.event` push
  delivery, with its own cursor, epoch generation, dedupe ring, in-flight
  epoch-rewind guard, and failure backoff), the per-listener generic pump used by
  pinned chat/project subscriptions, and the helpers the active pump in
  `preload.ts` shares. Main-side subscriptions are reference-counted per
  `(binding, category)` so sibling pumps share one and only the last teardown
  releases it; the active pump never retains a reference and therefore never
  releases a subscription a pinned pump is still reading.
- `apps/desktop/src/main/services/account/accountBridge.ts` and
  `apps/ade-cli/src/services/account/accountMachineDirectoryService.ts` —
  account-directory adoption. The desktop Machines row and packaged CLI both
  turn an online account machine into the same paired-machine credential record
  and paired-only remote target; account credentials are not retained as an
  alternate transport.
- `apps/ade-cli/src/services/account/accountMachinePublisherService.ts` — the
  producer side: the host publishes its own directory row so a same-account
  desktop or CLI can adopt it. Only currently validated routes are advertised —
  a `lan` endpoint per live LAN address (a saved `lastHost` that matches the
  current LAN/Tailscale set is now classified as `lan`/`tailscale` rather than
  the opaque `saved` kind, so LAN endpoints publish correctly instead of being
  dropped), a `tailnet` endpoint per reachable Tailscale address, and a `relay`
  endpoint once the tunnel bridge is validated **and** an end-to-end self-probe
  confirms the relay path round-trips (`relayEndToEndVerifiedAt` with no
  failure). Bridge validation is now
  proactive (`syncTunnelClientService.validateCurrentBridge`, run on
  control-open and on listener-ready), so the relay endpoint appears in the
  directory as soon as the machine is signed in, its listener is confirmed, and
  the self-probe passes — it no longer waits for an external client to open the
  first relay tunnel. The row also carries the host's Ed25519 identity as
  `pubkey`, which same-account clients verify before a sealed `ade-adopt-v1`
  adoption over a direct route (see the [Sync](../sync-and-multi-device/README.md)
  security model). The published machine name is channel-suffixed (`<name> ·
  Beta` / `<name> · Alpha`, stable left bare) so two channels on one Mac are
  distinguishable rows.
- `apps/ade-cli/src/services/sync/syncTunnelClientService.ts` and
  `apps/ade-cli/src/bootstrap.ts` — the relay side of a paired route. The tunnel
  client is shared one-per-machine (`getSharedSyncTunnelClientService`, keyed by
  `sync-cloud-relay.json`); bootstrap builds a
  `relayTunnelAuthorityGate` per project scope, which starts the tunnel only
  while this process holds the machine-wide sync host lease and hands the
  shared listener to `attachHostListener()` outside the construction factory,
  so the runtime that owns the listener supplies the port, loopback nonce, and
  bridge proof regardless of which runtime created the instance. See *Relay
  tunnel and the sync port* below.
- `apps/ade-cli/src/services/sync/syncHostService.ts` — the host end: paired
  hello authentication (with the `sync_host.paired_device_rejected` /
  `sync_host.paired_account_owner_mismatch` rejection logs and the
  frame-count-aware peer-close logs) and tailnet publication, including
  `staleAdeTailnetServePorts` / `reclaimStaleTailnetServes`, which retire
  ADE's own leftover `tailscale serve` entries after each successful publish.
- `apps/ade-cli/src/commands/doctor.ts` — the `Sync port` row names a drifted
  port and its base-port holders, and says explicitly that a root-owned holder
  such as `tailscaled` is invisible to this probe rather than reporting the
  ports as free.
- `apps/ade-cli/src/tuiClient/remoteLauncher.ts`,
  `pairedRemoteConnector.ts`, `remoteLaunchBudget.ts`, and `remoteBridge.ts` —
  `ade code remote` target resolution, legacy account-target migration,
  paired/SSH launch ordering, bounded cancellation, project/session selection,
  and the one-connection local socket handed to the normal ADE Code client.
- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` —
  the local runtime connection used by desktop IPC, event streaming, sync
  Settings, and local-work checks. Runtime initialization advertises an integer
  compatibility window (`minCompatibleProtocol` through `protocolVersion`).
  A desktop connects normally to a newer machine brain when its own
  `RUNTIME_COMPAT_LEVEL` falls inside that window; a newer incompatible brain
  remains preserved and the old desktop window falls back to an isolated
  no-sync runtime. It also spawns
  `ade serve` for non-primary sockets, tracks the per-user login service
  install/health state, and applies short per-call timeouts for project
  registration, file actions, and event polling so renderer IPC calls do not
  wait for the desktop handler timeout. `LocalRuntimeStatus` now also carries
  the brain's `pid`, its bound `syncPort`, the account-directory `publishHealth`
  slice (state + `failingSinceMs` + last-leg durations), and the one-shot
  `lastWedge` recovered by the event-loop watchdog. The Machines panel renders
  publish health as a This-Mac indicator (`remoteMachineModel.describePublishHealth`,
  which reads inactive states as "none" and only alarms a real failure after it
  has persisted ~2 minutes), and the app shell reads `lastWedge` for the
  `BrainRecoveryNotice` banner.
- `apps/desktop/src/main/services/runtime/lastFailureStore.ts` — bounded typed
  project/machine failure reports used when the background service exits before
  desktop IPC can obtain a normal runtime error.
- `apps/desktop/src/main/services/runtime/projectRecoveryService.ts` —
  brain-independent project diagnosis and ordered repair for storage,
  database, migration, endpoint, and chat continuity failures.
- `apps/desktop/src/main/services/runtime/machineTrustResetMigration.ts` —
  one-time packaged-release reset of the old machine-connection trust files.
  It preserves account auth, machine identity, pairing PINs, projects, and SSH
  configuration, and completes only after the background service restart is
  confirmed.
- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts`
  (`codedRecoveryError`) — refuses to start an app-owned brain on a primary
  service socket and carries the recorded `AdeRecoveryErrorCode` to IPC and the
  renderer recovery surface.
- `apps/desktop/src/renderer/components/remoteTargets/` — Machines panel with
  connected / available / unavailable sections, Pair and SSH entry paths,
  share-this-machine and connection-doctor cards, saved/discovered machine
  rows, route and latency status, SSH host-key trust, structured connection
  errors, project picker, and the This-Mac
  route-publish health indicator. `remoteMachineModel.ts`
  (`describePublishHealth`) is the pure classifier for that indicator: the
  publishing `published` state reads healthy, the non-publishing states
  (`sync_disabled`, `not_host`, `account_signed_out`, `machine_key_unavailable`,
  …) read as "none", and every other state is a failure that only alarms once it
  has persisted at least `PUBLISH_FAILING_ALARM_MS` (2 min) so a transient blip
  stays quiet.
- `apps/desktop/src/renderer/components/app/projectTabGrouping.ts` — collapses
  the open local and remote tabs into one group per repository, joined on the
  normalized git origin. A project with no resolvable origin is never merged,
  and at most one checkout per machine joins a group (a lane worktree shares its
  parent's origin, so merging them would produce a tab that cannot represent
  both). `apps/desktop/src/shared/projectIdentity.ts` owns the binding-key
  format the join and every per-project cache are keyed by.
  `TopBar.tsx` renders the group as one tab plus a machine menu; the machine
  name only earns inline space when it is ambiguous (more than one machine in
  the group, or a checkout that is not on This computer), and the menu also offers
  **Connect another machine…**.
- `apps/desktop/src/shared/machineIdentity.ts` — the single definition of "the
  machine ADE is running on": `THIS_MACHINE_ID` (`"this-mac"`),
  `THIS_MACHINE_NAME` (`"This computer"`), `isThisMachineId`, and
  `machineDisplayName`. Every producer and consumer of a machine id imports
  from here — `laneMachines.ts`, `projectTabGrouping.ts`, `crossMachineLanes.ts`,
  `LaneGitActionsPane.tsx`, the composer, and the Chats page — because the
  push-divergence guard decides "is this another machine?" by comparing ids, so
  two spellings of this machine make it warn that This computer diverged from
  itself. The name is deliberately platform-neutral — ADE also runs on Windows,
  where "This Mac" was simply wrong.
  Machines are named **absolutely** ("This computer", "MacBook Pro (97)"); "remote"
  is never a machine name, since the machine a tab is bound to can change and
  the create-lane dialog already uses "remote" for the git base-branch source.
- `apps/desktop/src/main/services/projects/recentProjectSummary.ts` — reads
  `origin`'s URL straight out of the repo's git config (no `git` subprocess per
  recent) and attaches it to each recent summary, which is the join key the tab
  grouping above uses. `parseGitOriginUrlFromConfig` / `cleanGitConfigValue`
  undecorate the value the way git does (quoted strings with `\` escapes,
  unquoted `;`/`#` comment tails), `resolveGitConfigDirectory` walks a linked
  worktree's `<main>/.git/worktrees/<name>` metadata dir back to the main repo's
  config structurally rather than by substring, and the parsed URL is cached per
  project root keyed on the config file's mtime because recents are
  re-summarized on every focus.
- `apps/desktop/src/renderer/state/crossMachineLanes.ts` and the
  `crossMachineLanesByMachineId` / `crossMachineLaneScopeKey` slice of
  `appStore.ts` — the **cross-machine Work union**. Lanes carry the machine
  (`lanes.worktree_path` is an absolute path on exactly one machine) and chats
  inherit theirs through `laneId`, so the union is keyed by machine and holds
  lanes; there is deliberately no per-chat machine field. Refreshes are driven
  by the connection-snapshot subscription and existing lane-lifecycle /
  session-changed events (coalesced), plus a fallback loop for machines that
  publish no renderer change feed. That loop is visibility-gated: it stops
  entirely while the window is hidden and refreshes once on the way back, re-reads
  chats every 10 s, and gives the lane list its own 30 s cadence because
  `lane.list` with `includeStatus` resolves a git status per lane on the other
  machine. A chat naming a lane that machine has never reported forces the lane
  read immediately, but only once — ids a completed read did not explain are
  remembered, since `session.list` does not filter on lane status while
  `lane.list` excludes archived lanes, and a chat on an archived lane is
  permanently unresolvable. Foreign reads are bounded,
  timed out, capped at four machines in parallel, and never gate the local list.
  A machine that drops is **dimmed, not deleted**: its lanes and chats stay on
  screen, collapsed and inert, with the offline form of the machine marker naming
  it. Believing a drop takes a completed, failed reconnect attempt (`connecting`
  observed, then a non-connected state) plus a 45 s floor, with a 120 s ceiling
  for a dial that never finishes: every redial publishes `connecting` and a
  single failed liveness ping flips a target to `error`, so a shorter rule dims
  the sidebar on every wifi blip. Two states skip the wait for an attempt that is
  never coming and dim on the floor alone — an `idle` target, which will not
  redial at all, and a machine that is connected but cannot re-prove this
  repository, which answers but is never read for it. The second is dimmed and
  not removed: absence of proof is not proof of absence, and a project list that
  has not caught up after a reconnect must not read as "the repo is gone". Coming
  back is applied instantly, and the verdict survives a Work-tab remount — a
  dimmed machine brightens only by becoming eligible again, never because the
  runtime that held its drop record was torn down.
  Rows leave for three reasons: the machine is gone from the connection snapshot
  (unpaired or removed), it positively reports the repository missing *and* there
  is a resolvable origin to prove that by, or it has been unreachable for 24
  hours. The origin requirement is what keeps a healthy machine's rows alive
  while the bound machine blips — `repoMatchFor` will answer "missing" off a
  folder-name mismatch alone, and the scope's origin URL is re-resolved from the
  bound machine, so it can be transiently null. Deleting rows on that evidence is
  not recoverable.
  The union is
  scoped per repository, so switching project tabs invalidates it wholesale.
  `selectOtherMachineBranchStates` is the derived-state seam the push guard
  reads at click time.
- `apps/desktop/src/renderer/lib/chatMachineRouting.ts` — **per-session runtime
  routing**. `buildLaneBindingIndex` folds each open binding's lane list into a
  lane→binding index (active binding first wins), and `resolveChatRuntimePin`
  returns the `OpenProjectBinding` a session's calls must target, or `null` when
  it already lives on the active binding. `collectOpenProjectBindings` and
  `buildChatMachineRoutingState` are the shared constructors both consumers use
  so the two surfaces cannot drift into different definitions of "open" or of
  lane precedence. `isLivePinnedBinding` asks whether a pin is still *open*
  rather than whether it is *active*, because a pin differing from the active
  binding is now the normal state of any session whose lane lives on another open
  machine. Clicking such a row streams it from its own machine without rebinding
  the tab, which would otherwise drag Lanes / PRs / Files / Git / Run along with
  it.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` and
  `apps/desktop/src/renderer/components/terminals/useWorkMachineRouter.ts` — the
  two routers built on that module. The chat pane resolves its own pin from the
  chat's lane; the Work hook is the Work tab's single routing authority for
  CLI/shell rows, adding lane-then-launch-pin resolution
  (`pinForSession`) and the launch-pin registry writes
  (`rememberSessionPin` / `forgetSessionPin`) on top of the shared router.
- `apps/desktop/src/renderer/components/lanes/laneMachines.ts`,
  `LaneMachineSelector.tsx`, and `PushDivergenceDialog.tsx` —
  machine selection during lane creation and the push-time divergence warning.
  `deriveLaneMachineOptions` matches each machine's checkout of the repo by
  normalized git origin (`matchedBy: "origin"`, proof) or, failing that, by
  folder name (`matchedBy: "name"`, a guess that must not on its own rebind the
  app). `CreateLaneDialogHost` captures the binding the dialog opened on and
  restores it if the dialog is closed without creating a lane, so browsing
  machines cannot silently leave the window pointed somewhere else.
- `apps/desktop/src/shared/laneDivergence.ts` — the push-time guard.
  `toMachineBranchState` builds its inputs from lane records the renderer
  already has (`LaneSummary.branchRef` + `LaneStatus.ahead/behind` from
  `LaneListSnapshot` / `lane_state_snapshots`). The rule is grounded in `ahead`,
  not head commits: no lane record in ADE carries a head sha, so a rule that
  required one could never fire. Another machine holding the same branch with
  `ahead > 0` holds commits that are by definition not in the push, so moving
  the upstream tip would strand them. Head shas only ever *silence* the guard
  (two machines proven to sit on the same commit); an unknown head never
  suppresses a warning, because this guards a destructive push. It stays silent
  when no other machine holds the branch, the entry is this machine (ids
  compared, never names), the other machine is on a different branch, or the
  other machine has nothing unpushed.
- `apps/desktop/src/renderer/components/chat/thisMachineProjectRoot.ts` —
  resolves the machine picker's "This computer" option back to *this repository's*
  local checkout by repo identity (reusing `deriveLaneMachineOptions`' rule)
  rather than to the first local tab in insertion order, and refuses to switch
  when there is no local counterpart. Used by the chat composer's machine picker
  and the Chats tab.
- `apps/desktop/src/renderer/state/appStore.ts`,
  `apps/desktop/src/renderer/components/app/App.tsx`,
  `TopBar.tsx`, and `projectRouteStorage.ts` — represent every open remote
  binding as an independent project surface. Work, lane, session, route,
  layout, and terminal-runtime identity use the binding key rather than the
  remote filesystem path. Local and remote tabs share one eight-surface warm
  LRU: inactive mounted surfaces are inert and animation-paused, while older
  open surfaces snapshot their state before unmounting. Returning to a tab
  restores its cached surface and revalidates lanes; a failed reconnect leaves
  that stale surface visible. Closing or disconnecting switches away first, then
  evicts only the affected binding — but the two are **not** the same eviction:
  - **Explicit tab close, and removing a machine**, are deliberate "forget this
    surface" actions: `evictProjectState(bindingKey)` plus
    `removeStoredProjectRoute(bindingKey)` wipe view state, data caches, and the
    remembered route.
  - **Disconnect** is temporary — the machine can come back — so it takes the
    narrower `evictProjectDataCaches(bindingKey)` path: lane cache, lane
    selection, and session cache are dropped (they can be stale against a remote
    that changed while it was unreachable) while `workViewByProject` /
    `laneWorkViewByScope` and the stored route survive, so reconnecting lands on
    the chat or tile the user had open. Binding keys are deterministic
    (`remote:<targetId>:<projectId>`), so the preserved view state re-attaches.
    When the disconnected tab was the last one, `closeProject({
    preserveRemoteViewState: true })` applies the same rule instead of wiping.
- `apps/desktop/src/preload/preload.ts` — routes runtime-backed renderer APIs to
  local or remote JSON-RPC actions based on the active project binding — or, for
  a chat that lives on another open machine, based on an explicit
  `OpenProjectBinding` pin passed as a trailing argument
  (`callPinnedOrBoundRuntimeActionOr`). Chat and session APIs
  (`agentChat.send` / `steer` / `interrupt` / `approve` / `getSummary` /
  `recoverTurn` / …, `sessions.get`, `sessions.readTranscriptTail`) accept that
  optional pin; when it is absent the call is byte-for-byte the bound path it was
  before per-chat routing, with no extra await. Remote
  project usage/budget reads route through the remote runtime; local project
  usage/budget reads stay on desktop usage IPC. File actions are strict once a
  local or remote runtime is bound. During a
  project switch, preload records a pending local binding for the target root
  and includes `rootPath` on local runtime action/sync/event calls so early
  renderer requests hit the destination runtime project instead of the previous
  window session binding. During remote project opens, preload clears the
  current binding, tracks the newest open generation, waits for active remote
  opens before retrying read-only project calls, blocks mutating action/sync
  calls with the "Project is switching" error, and avoids refreshing a stale
  runtime binding. Remote event polling suppresses buffered replay on the first
  live subscription, resets cursors on `eventEpoch` changes, notifies project
  refresh paths on `gap: true`, and backs off when idle; lane preview URLs
  returned by a remote runtime are localized through a local TCP forward before
  the renderer opens them. For a packaged local window temporarily attached to
  an isolated runtime with sync disabled, only the exact machine-level
  `Sync service is not available` / `Register a project first` failures retry
  through main-process sync IPC; remote-bound failures never fall back to the
  local machine.
- Settings > Secrets keeps file ownership explicit across this boundary. The
  controller desktop opens Finder and reads at most 1 MB from the file the user
  selected, then sends only its basename and content through the active
  `project_secret.previewEnvImport` runtime action. Parsing, replacement
  detection, and the selected batch import therefore run on the remote project
  host. `project_secret.exportEnv` also runs on that host and writes a new
  `ade-secrets.env` (or a numbered non-overwriting variant) to that machine's
  Downloads folder; it never falls back to the controller's Downloads folder
  while a remote project is bound.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — runtime-level project catalog
  and sync methods, machine-scoped personal-chat methods, plus project-scoped
  action dispatch. `projects.getHandoffStoragePreflight` validates a proposed
  clone parent/path, free-space floor, and destination-local Git access before
  cross-machine handoff setup mutates the machine. `runtimeEvents.*`
  replies include `eventEpoch`, `gap`, and `oldestCursor` from the runtime's
  bounded event buffer. `projects.list` inlines host-resolved icons, with
  `dataUrl`, `sourcePath`, and `mimeType` fields, under a 24-icon / 750 ms
  connect-path budget with 128 KiB per-icon and 512 KiB aggregate wire caps,
  so a connected desktop can render real project logos without letting an
  oversized registry stall connection setup.
- `apps/ade-cli/src/services/projects/` — machine project registry,
  lazy per-project service scope cache, and `projectIconResolver.ts`. Brain
  startup boots only the authoritative sync-host project; other recent
  projects stay cold until a project-scoped request or explicit handoff needs
  them, because each scope owns a complete DB/search/chat/automation/PTY
  runtime rather than lightweight catalog metadata. `projectIconResolver.ts`
  (`resolveRemoteProjectIcon`, an electron-free port of the desktop icon
  resolver: `.ade/ade.yaml` override + conventional icon/logo files +
  `index.html` `<link rel="icon">`, best-effort and rendered to a 64 px
  thumbnail capped at 128 KiB on the wire).
- `apps/ade-cli/scripts/build-static.mjs` — produces the static
  `ade-<platform-arch>` SEA binary and the `.native.tar.gz` of native modules,
  resolves the runtime version from the CLI / desktop package metadata, and
  verifies same-platform static binaries report that version.
- `apps/ade-cli/scripts/install-runtime.sh` — standalone installer that
  downloads `ade-<platform-arch>` and the matching native deps from a release.
- `apps/desktop/scripts/materialize-runtime-resources.mjs` and
  `validate-runtime-resources.mjs` — populate and validate
  `apps/desktop/resources/runtime/` for packaging.

## User model

A **remote target** is another ADE machine reachable through a paired sync
route, SSH, or both. A paired target stores the machine identity and paired
credentials separately from the saved target; the target may also retain SSH
user, port, key, and route information for fallback. A **remote project** is a
path on that machine that has been registered with its ADE runtime (via
`projects.add`). Opening a remote project does not copy local files or move a
local lane by default. Normal project opening still expects Git to move code
between clones; the explicit **Send to machine** flow adds a guarded clean-lane
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

The next packaged release intentionally starts this trust model from a clean
slate once per channel. It removes previously saved desktop remote targets and
paired-device grants, restarts that channel's background runtime, and then lets
users pair or adopt machines again. It does not sign the user out, change the
machine identity/PIN, remove projects, or touch SSH configuration. Source/dev
launches do not perform the reset.

Opening a project on another machine no longer interrupts. The old confirmation dialog existed to warn that a *separate remote tab* was being created; under one-tab-per-repository there is no second tab, so the warning had nothing left to warn about. Divergence between two checkouts is surfaced where it can actually cost you something instead: at push time, when another machine holds the same branch with unpushed commits (`apps/desktop/src/shared/laneDivergence.ts`).

## One repository, many machines

A repository is one tab. Local and remote checkouts of the same repo — joined on
their normalized git origin — collapse into a single tab whose **machine** is a
dimension inside it, switched from a dropdown on the tab. There is no separate
"remote" tab, and "remote" is not a machine name: machines are named absolutely
("This computer", "MacBook Pro (97)").

The tab's machine is the global execution context — Lanes, PRs, Files, Git, and
Run all follow it. Two things are deliberately wider than that:

- **The Work sidebar is a union.** It shows chats in flight on *every* connected
  machine for this repository, regardless of which machine the tab is bound to.
  Lanes not on This computer carry a small monochrome machine marker that promotes to
  the machine's name when a glyph alone would be ambiguous (the machine is
  offline, two or more foreign machines are on screen, or the same branch exists
  elsewhere). Foreign lanes appear only when they have sessions — the union is
  about work in flight, not an inventory. A machine that goes offline keeps its rows,
  dimmed, folded shut, and inert, and sinks below the reachable machines.
  One session renders as exactly one row. The union is built against the ids the
  active binding's own roster already holds and carries a single claim set across
  machine slices, so neither a locally seeded optimistic launch nor two slices
  reporting the same session can produce a second row with its own elapsed clock.
  Local wins the tie, matching where a click resolves. A slice only claims
  sessions on lanes that same machine reports, so a session naming a lane a
  machine does not have cannot suppress the machine that does have it.
- **A session runs on its own lane's machine.** Opening a chat, CLI, or shell
  session from the union streams it from the machine that owns its lane, with its
  calls pinned to that machine's runtime; the tab stays bound where it was. A row
  whose owning binding this window does not have open is the exception — there is
  nothing to pin to, so the tab switches. Clicking a foreign *lane* (rather than
  a session) is the explicit move: it switches the tab's machine, the same thing
  opening a remote project does.

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

1. Open **Connections > Machines**. When signed in, ADE loads the other Macs on
   the same account. It also combines Bonjour and Tailscale discovery,
   removes this machine's own Bonjour advertisement, and merges routes that
   identify the same machine. Discovered paired-capable ADE desktops appear in
   Available; offline or unsupported machines remain visible in Unavailable.
2. Select a same-account Mac for the primary PIN-less flow. ADE dials the
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

   `ade-adopt-v1` protects the *credentials* exchanged during adoption (the
   account bearer, the DPoP proof, and the minted paired secret are all
   sealed), not the confidentiality of the ongoing session. After adoption
   over a plaintext `ws://` LAN or tailnet route, the established sync stream
   has the same on-path exposure as any other direct paired reconnect — an
   attacker who can already read that LAN can observe the post-adoption
   traffic, but never the sealed credentials. This matches the pre-existing
   direct-route trust boundary; relay routes remain trusted-operator
   plaintext-readable as documented above.
   Without an account, choose **Find nearby Macs**, select a discovered LAN or
   Tailscale machine, and enter the six-digit PIN shown on that Mac's **This
   Mac** Connections card. There is no desktop pairing-link paste/scan or
   manual address + PIN path. A discovered machine with an existing pairing is
   upgraded to a paired target automatically.
3. Connect. ADE dials paired routes in LAN → tailnet → relay order, preferring a
   recently successful endpoint within each class. After authenticated
   `hello_ok`, it requires `features.rpcChannel === true`, opens the runtime
   JSON-RPC channel, and uses the paired port-forward channel for remote preview
   URLs. The connected status reports the winning route and latency. A relay
   route is tried only while this ADE client is signed in. The client attaches
   a short-lived account proof to that relay hello, and the host accepts it only
   when the proof belongs to the Clerk user currently signed in on the host.
   A missing or different account reports **Sign in to ADE** without spending
   the automatic-reconnect failure budget. Relay remains a trusted-operator
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

`ade code remote` consumes that same saved target registry and paired credential
store. Before opening a credentialless routed SSH record, it compares the saved
name and all saved hosts with the signed-in account directory. An exact, unique
legacy account-machine match is adopted into the paired store and the obsolete
SSH-shaped record is removed. If the directory cannot be verified, the machine
is offline, or adoption fails, that account-created target fails closed; ADE
does not silently retry it as SSH. Targets with an explicit SSH user or private
key remain true SSH targets and bypass this migration. Interactive launches
always show the machine chooser, including when only one target is saved.
Paired launches dial LAN → tailnet → relay by default; `--route
lan|tailscale|relay` restricts the attempt to one path class and never falls
back to SSH. ADE verifies the long-lived paired connection before it launches
the TUI, reuses that connection for the first local bridge socket, and leaves
the bridge available for an explicit retry if the remote path later closes.
The CLI prints the selected path and reports subsequent path changes without
showing temporary socket locations or pairing identifiers.

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

After connecting, the desktop persists the active remote project to `globalState.lastRemoteProjectBinding` and records it in the unified recent-project list with target id, project id, runtime name, and hostname. Remote recents are keyed as `remote:<targetId>:<projectId>`, so a remote project can share a path string with a local checkout without colliding; the welcome screen can reconnect/open the remote row directly from that metadata. Each target also persists an explicit `autoConnect` preference: a successful Connect enables it, and Disconnect disables it. Only targets with that preference enabled reconnect at launch or after wake; an explicit failed Connect does not change the saved preference. After 10 implicit failures ADE pauses retries until the user presses Connect, which resets the retry budget without bypassing SSH or pairing authentication.

Per-channel layout: builds with `ADE_PACKAGE_CHANNEL=alpha|beta` upload to `~/.ade-alpha/` or `~/.ade-beta/` instead of `~/.ade/` so a remote machine can host stable, beta, and alpha runtimes side by side. Runtime binaries, native deps, PTY workers, and bundled ADE agent skills all live under the selected home. Remote compatibility launches keep `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` so remote probes do not fight the user's login service.

A packaged Beta upload that cannot initialize is not terminal by itself. ADE
still probes the isolated Stable and other channel homes and accepts the first
runtime whose initialization and machine-project capabilities are compatible;
the selected home is then used consistently for follow-up commands such as the
SSH-to-paired upgrade.

## Compatibility warnings

Version skew and capability skew no longer fail the connect outright. The bootstrap performs the JSON-RPC `ade/initialize` handshake, normalizes the `capabilities.machineProjects` flags returned by the remote runtime, and reports the result as `RemoteRuntimeCapabilities` plus a `compatibilityWarnings` array on the `RemoteRuntimeConnectResult`. The renderer's remote target panel displays each warning inline under the connection chip. Warnings cover:

- Runtime version mismatch (`Remote ADE service reported X; local ADE is Y. ADE will connect because the RPC capabilities are compatible.`).
- Remote package channel mismatch (e.g. desktop is `beta`, remote runtime advertises `stable`).
- Missing `machineProjects` capabilities — `browseDirectories`, `getDetail`, `getWorkSummary`, `getDefaultParentDir`, `create`, `clone`, `listMyGitHubRepos`. These map to the `projects.*` RPCs the renderer uses for the project picker / new-project / clone flows. Missing capabilities do not block connect, but the connection pool refuses the matching call with a self-describing error when the renderer attempts it (e.g. `Remote ADE service 0.7.2 does not support cloning remote projects.`).
- The bootstrap fell back to a different ADE home (`Using remote runtime home .ade-beta because .ade did not contain an ADE service for darwin-arm64.`).

## Runtime artifact layout

Desktop distributable builds require `apps/desktop/resources/runtime/` to contain every supported `ade-<platform-arch>` binary and matching `.native.tar.gz` archive, plus the packaged ADE CLI resources that include `ptyHostWorker.cjs` for remote terminal hosting. The supported targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`.

Desktop distributable builds also package `apps/desktop/resources/agent-skills/`.
Remote bootstrap copies that directory into the selected remote ADE home as
`agent-skills/`; the CLI then re-seeds ADE-managed skills into runtime-native
home skill directories on launch.

`apps/desktop/scripts/validate-runtime-resources.mjs` is the preflight that fails the package step when artifacts are missing. Release builds populate the resource directory from the runtime-binary CI workflow's artifacts via `materialize-runtime-resources.mjs`. For local same-platform packaging, build into the resource directory directly:

```bash
npm --prefix apps/ade-cli run build:static -- --target <target> --out-dir ../desktop/resources/runtime
```

…or set `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1` to validate only the host target during local channel builds (release builds always require the full set).

`materialize-runtime-resources.mjs` searches `ADE_RUNTIME_ARTIFACTS_DIR`, then `apps/ade-cli/dist-static/`, copies any matching artifacts into the resource directory, and falls back to invoking `npm run build:static` for the host target when a missing artifact is the host build (downloading the official Node SEA helper if `ADE_STATIC_NODE_BINARY` isn't set and `ADE_RUNTIME_DISABLE_NODE_DOWNLOAD` isn't `1`).

## Standalone runtime install

For headless machines that can run an SSH server but have no desktop, the runtime can be installed directly from a release. Windows 10 22H2 and Windows 11 x64 machines can install the standalone brain locally or be bootstrapped through Windows OpenSSH Server. Release publishing includes `install.sh`, `install.ps1`, `SHA256SUMS`, the `ade-<platform-arch>` binaries (with `.exe` for Windows), and matching native dependency archives. Desktop bootstrap uploads bundled runtime artifacts on first connect, verifies size and SHA-256 through native platform tools, and launches `ade rpc --stdio` with the channel-specific ADE home. Windows SSH bootstrap requires PowerShell 5.1 or newer and `tar.exe`; WSL, ARM64, and Windows Server are not supported in Windows v1.

```bash
curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/arul28/ADE/releases/latest/download/install.ps1 | iex
```

`install.sh` (lives at `apps/ade-cli/scripts/install-runtime.sh`):

- detects platform / arch with `uname -sm`,
- downloads `ade-<platform-arch>`, `ade-<platform-arch>.native.tar.gz`, and `SHA256SUMS` from the release,
- verifies downloaded runtime assets against `SHA256SUMS`,
- installs the binary to `$ADE_INSTALL_DIR` (default `$ADE_HOME/bin`),
- extracts the native modules to `$ADE_HOME/runtime/<platform-arch>/`,
- verifies with `ade --version`,
- best-effort registers the per-user login service via `ade serve --install-service` on macOS and systemd Linux.

Environment overrides:

- `ADE_VERSION=vX.Y.Z` — pin a specific release; default `latest`.
- `ADE_INSTALL_DIR=/custom/bin` — destination directory.
- `ADE_RELEASE_REPO=owner/repo` — fetch from a fork.
- `ADE_HOME=/path/to/.ade` — alternate per-machine state root.

After install, the headless machine can already serve clients. Desktop ADE on a developer laptop adds it as a remote target; `ade code` works on the headless machine itself.

Headless hosts update through the same binary, without requiring the desktop app:

```bash
ade brain update --text
ade brain update status --text
```

The update command stages the next release under `$ADE_HOME/runtime/updates/`, verifies the staged binary with the staged native deps, promotes the binary/native deps into place, and restarts the per-user brain service. A connected mobile or desktop controller should expect the sync/RPC connection to drop briefly while the brain restarts.

## What works remotely

Remote project bindings route lanes, agent chat, PTYs, terminal IO, file operations, file-watch notifications, git actions, PR actions, native GitHub stack actions, PR AI conflict-resolution sessions, PR issue-resolution launch flows, AI PR summaries, issue inventory, cross-machine handoff destination checks/acceptance, and event streaming through the remote runtime. The global Chats route deliberately retains the window binding: when opened from a remote-bound project tab, `personalChats.call` / `streamEvents` go to that remote machine's hidden personal-chat scope; from a local or no-project window they go to the local brain. Remote lane preview URLs are opened through a local TCP forward created by the desktop, so a dev server bound to `127.0.0.1` on the remote can be inspected from the local window. A connected remote project's tab shows the real project logo and a yellow connected accent: the host brain resolves the icon and inlines it on `projects.list`, the desktop threads it through `RemoteRuntimeProjectRecord.iconDataUrl` → `OpenProjectBinding.iconDataUrl` to the tab, and persists it so the logo is restored on a cold start before the remote reconnects. Agent CLI failures (Claude / Codex / Cursor / Droid not installed or not authenticated) surface as inline `AgentCliAuthCard` cards in chat; the install / login buttons open a tracked terminal in the active runtime, so a remote project runs the install or login command on the remote machine.

Local project bindings use the local ADE runtime for the same surfaces — agent chat, session history, PTYs, terminal reads/writes, file operations and watchers, diffs, lanes, PRs, native GitHub stacks, PR issue-resolution launch flows, PR AI conflict-resolution sessions, issue inventory, tests, project config, and most git operations. Electron main still owns desktop-only services that physically require an Electron host.

## Mobile reachability

iOS uses SSH only as an optional one-time pairing bootstrap. Routine mobile
traffic always uses the paired sync WebSocket advertised on the LAN, through a
Tailscale tailnet, or through the relay. Install Tailscale on the phone and the
ADE machine for a direct route when they are not on the same local network.

On desktop, the **This Mac** card and **Connections > Phone**/**Web** tabs are
runtime controls that always describe the **physical Mac the user is sitting
at**, even while the window is bound to a remote project. Most
`window.ade.sync.*` calls follow the active binding and would report the remote
machine, so the Connections panel reads its identity, pairing code, and local
device lists through `window.ade.sync.getLocalStatus(...)`, which deliberately
bypasses the binding and targets this machine's local brain (see the
`ade.sync.getLocalStatus` IPC handler and `useSyncConnections.ts`). The
binding-routed `sync.getStatus` is still fetched, but only to detect that the
window is remote-bound and to name the machine it is working on. Because the
pairing and device *mutations* (`setPin`, `generatePin`, `clearPin`,
`forgetDevice`, name edits) continue to route through the binding, the panel
presents them **read-only while remote-bound** and labels the connected-device
list with the local Mac's name so it cannot be mistaken for the bound machine's.
The pairing PIN manager lives on the This Mac card. The legacy in-process
desktop sync host is disabled by default and can be re-enabled only for
diagnostics with `ADE_ENABLE_DESKTOP_SYNC_HOST=1`.

## Troubleshooting

- `Remote target was not found` — the saved target was removed or the UI has a stale selection. Refresh the target list.
- `Remote machine was manually disconnected. Connect again to use this remote project.` — the user explicitly disconnected the target; ADE will not implicitly reconnect or restore it until Connect is pressed.
- `ADE stopped automatic reconnecting after 10 failed attempts. Press Connect to try again.` — implicit reconnects were paused after repeated failures so the renderer does not keep hammering SSH.
- `SSH server at <host:port> closed the connection before ADE could finish the SSH handshake` — the TCP route opened but the server reset or closed the SSH handshake. Check Remote Login/sshd, firewall rules, and Tailscale SSH policy.
- `ADE service is not installed ... no bundled ADE service is available` — install or build `ade` on the remote, or use a release build that includes runtime resources for the remote architecture.
- `Uploaded ADE service version mismatch: expected X, got Y` — the uploaded binary did not report the expected runtime version. Rebuild the static runtime artifacts for the current desktop version.
- `Remote ADE service does not support multi-project mode` — the remote is running an older ADE before multi-project RPC. Re-bootstrap from a current desktop build.
- `ADE couldn't connect to this machine. Check that ADE is open there, then press Try again.` — ADE could not initialize any compatible installed service. Expand technical details to see each channel home and the launch, initialization, or capability-negotiation failure.
- `Remote ADE service <version> does not support <capability>.` — the remote runtime connected but is missing a specific `machineProjects` capability the renderer just called (e.g. `cloning remote projects`). Update ADE on that machine.
- `Remote ADE service method <method> failed (code N): <message> Details: ...` — the runtime RPC client now surfaces the JSON-RPC error `code`, `message`, and `data` together so a remote handler failure (e.g. a missing project capability or a service action error) is no longer reported as a generic `Remote ADE service request failed.` string.
- `Remote ADE service timed out waiting for method ...` — only that request expired. The shared runtime connection and event subscriptions remain live; retry explicitly if the operation is still needed, because ADE does not replay timed-out mutations automatically.
- A cross-machine handoff warning that ADE lost confirmation — destination
  acceptance was already dispatched, but its request timed out or the runtime
  connection closed. The destination may still finish. Check that machine
  before retrying; the handoff ID makes an explicit retry reconcile the same
  destination lane/chat rather than automatically replaying the mutation.
- "Tailscale CLI was not found / timed out / failed" warning under the discovered-machines list — surfaced from `discoverLanRuntimes` diagnostics. LAN (Bonjour) discovery still ran; install or unblock `tailscale` to add tailnet peers.
- Agent provider missing or unauthenticated — use the inline `AgentCliAuthCard` to install or authenticate that provider on the active runtime machine.
- `lan <host>:<port>: authentication` in the route list — the host was reached and it *rejected* this desktop, so the other routes' `timeout`/`unreachable` entries are noise. The host's `hello_error` message names which of three causes it was: the pairing was removed on that machine, the saved secret no longer matches, or the two machines are signed in to different ADE accounts. The first two are reported identically (an unauthenticated caller must not be told whether a device id exists on that host) and both need a re-pair; only the account mismatch is fixed by signing in.

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
address is not a host identity — DHCP handing `192.168.1.240` to a different Mac
would hand that Mac the identity this desktop uses with the first one — so
matching on a saved endpoint is deliberately not an option, and a LAN pairing
with no `hostDeviceId` mints a fresh identity.

Minting a fresh id when one already exists is not merely untidy: the host keeps
the old record forever, secret still valid, with no way to ever match it again,
accumulating one orphaned credential per re-pair.

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
close code `4505`, so two brains that both dial it evict each other in a tight
loop and relay stays down for both — the failure mode that made this a lease in
the first place. A `4505` close therefore suppresses redialing (bounded
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
that skips teardown — orphans an entry that Tailscale keeps bound on the tailnet
address; ADE's own next wildcard bind then fails `EADDRINUSE` against its own
leftover and walks one port higher, leaking another. It ratchets forever: one
machine reached 66 stranded ports and ~70 failed binds per start, drifting from
8787 to 8852.

Only ADE's exact signature is reclaimed — a port inside ADE's sync range
forwarding to `127.0.0.1` on the **same** port — so a hand-rolled
`tailscale serve` is left alone, and the live port is re-checked inside the loop
because reclaiming frees exactly the low ports a restarting host prefers.

Diagnosing this needs `netstat -an -p tcp` or `tailscale serve status`, **not**
`lsof`: tailscaled runs as root, so a user-level probe reports the ports as
having no holder, which reads as "free" and is the opposite of the truth.

## Related docs

- [Internal architecture](./internal-architecture.md) — protocol shape, bootstrap sequence, sync command scoping.
- [ADE CLI](../../../apps/ade-cli/README.md) — runtime modes, service manager, machine layout, and legacy compatibility command names.
- [ADE Code](../ade-code/README.md) — terminal client that uses the same runtime.
- [Sync and Multi-Device](../sync-and-multi-device/README.md) — phone pairing and multi-device sync (hosted by the same runtime).
- [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md) — route, repository, Git, capsule, and retry contract for continuing a Work chat on another connected machine.
