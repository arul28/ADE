# Remote Runtime Internal Architecture

Remote runtime support is built on the same JSON-RPC runtime the local `ade serve` daemon answers. The desktop chooses a runtime binding for each window; the renderer APIs stay stable while preload decides whether to call the local runtime daemon or a remote SSH-backed runtime. Both bindings speak the same wire protocol.

## Runtime bindings

`OpenProjectBinding` records the active runtime for a window:

- `kind: "local"` — actions normally go through `LocalRuntimeConnectionPool`, which connects to the machine socket (`~/.ade/sock/ade.sock`) and spawns `ade serve` if it is not running. With `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`, preload treats the local runtime route as unavailable and falls back to Electron IPC without spawning or polling the daemon.
- `kind: "remote"` — actions go through `RemoteConnectionPool` keyed by `{ targetId, projectId }`.

The binding is established when a project is opened. Local bindings are created from the current desktop project (the desktop calls `LocalRuntimeConnectionPool.ensureProject(rootPath)` to register the project with the daemon and capture its `projectId`). Remote bindings are created by `remoteRuntimeOpenProject` after the selected target is connected and the remote project record is confirmed.

## Protocol shape

Runtime-level methods do not require a project and operate on the daemon as a whole:

```text
ade/initialize    ade/initialized   ping   shutdown   exit
runtime/info      machineInfo.get
projects.list     projects.add      projects.remove   projects.touch
runtimeEvents.subscribe              runtimeEvents.unsubscribe
sync.getStatus              sync.refreshDiscovery
sync.listDevices            sync.updateLocalDevice
sync.connectToBrain         sync.disconnectFromBrain
sync.forgetDevice
sync.getTransferReadiness   sync.transferBrainToLocal
sync.getPin   sync.setPin   sync.clearPin
sync.setActiveLanePresence
```

Project-scoped operations are routed through `ade/actions/call` and carry `params.projectId`. The ade-cli multi-project RPC handler (`createMultiProjectRpcRequestHandler`) looks up the per-project service scope via `ProjectScopeRegistry.get(projectId)` and forwards the request to the cached single-project handler created from `createAdeRpcRequestHandler({ runtime, … })`.

`ade/initialize` advertises `runtimeInfo.multiProject: true` and `capabilities.projects: true`. Clients use that to decide whether to send `projectId` per request (multi-project runtime) or treat the runtime as already bound to one project (embedded `ade code --embedded`). `validateRemoteRuntimeInitializeResult` enforces both flags on the remote side and rejects mismatched runtime versions.

Runtime event streaming uses `ade/actions/call` with `name: "stream_events"` for one-shot pulls, and `runtimeEvents.subscribe` (with `runtime/event` notifications) for live streaming. For remote bindings the desktop reconnects the SSH transport before re-subscribing, matching normal remote action behavior after disconnects. For local bindings, preload polls the local daemon through `localRuntimeStreamEvents` so daemon-owned chat, terminal, pty, lane, file-watch, process, and test events are delivered through the same renderer fanout used by remote projects. Local event pulls use a short per-call timeout; if the local daemon times out with a safe runtime error, preload suppresses local event polling for 30 seconds before retrying so one stalled daemon call does not keep tripping renderer IPC timeouts. The local event pump is not started when `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`.

Each `stream_events` response carries a per-runtime `eventEpoch` UUID minted when the daemon's `eventBuffer` is constructed. The preload event pump compares it against the last seen epoch for the active binding; if it changes (daemon restart, ssh reconnect to a fresh process) the cursor and dedup set reset and the next poll starts from `cursor=0`. The `startedAtMs` "drop events older than the pump start" filter is only applied to **local** bindings — remote pumps rely on the epoch reset instead, so older events backfilled after a reconnect are still delivered.

The remote event allowlist (`toRemoteRuntimeBufferedEvent`) accepts the runtime event categories desktop renders today: `category in {agent_chat, terminal, lane, pr, file_watch, process, test, project_state, orchestrator, dag_mutation, runtime, pty}`. The runtime additionally emits source-tagged events that preload routes to dedicated remote subscribers: `usage`, `usage_threshold`, `automation_event`, `conflict_event`, `github_status_changed`, `linear_workflow_event`, `feedback_submission_event`, `computer_use_event`, `ios_simulator_event`, `app_control_event`, and `macos_vm` (re-keyed to its `eventType`). ade-cli wires these into the runtime event buffer in `bootstrap.ts` so a remote-bound window sees the same usage, automation, conflict, GitHub, Linear, feedback, Computer Use, iOS Simulator, App Control, and macOS VM events as the local host.

## SSH transport

`sshTransport.ts` creates an `ssh2` client config from the saved target:

- host, port, and username come from the remote target registry.
- `sshKeyPath` loads a private key from disk when supplied.
- if no explicit key path is saved, matching `HostName` and `IdentityFile` entries in `~/.ssh/config` are applied so aliases like `Host studio` work.
- `SSH_AUTH_SOCK` is passed through as `agent` when available.
- every config carries `keepaliveInterval: 15_000` and `keepaliveCountMax: 3` so the client tears the channel down within ~45 s of a dead network instead of silently hanging.

The runtime transport itself is an SSH `exec` channel running `ade rpc --stdio` (with the channel-aware environment prefix from `buildRemoteRuntimeEnvironmentPrefix`). The channel implements the `RuntimeRpcTransport` interface used by `RuntimeRpcClient`, the same client `LocalRuntimeConnectionPool` uses against a Unix socket.

### Multi-route fallback

A remote target stores a primary `hostname` plus an optional `routes` array (`RemoteRuntimeTargetRoute[]`). Each route has `{ hostname, port, source: "manual" | "bonjour" | "tailscale", lastSucceededAt }`. Discovery captures every reachable address advertised by a peer (Tailscale FQDN, mDNS host, raw IPv4/IPv6 entries) and `RemoteTargetForm` persists them alongside the manual host on save.

`buildSshRouteCandidates` flattens routes (deduped by `hostname:port`, primary always first) and sorts later attempts by most-recent `lastSucceededAt`. `connectSshWithRoute` walks the route × username matrix: an authentication failure tries the next username for the same route, any other failure skips remaining usernames and advances to the next route. On success, `bootstrapRemoteRuntime` calls `markRemoteTargetRouteSucceeded` so the registry remembers which route worked — a target that moved between LAN and Tailscale auto-prefers whichever one reconnected last.

### Discovery diagnostics

`discoverLanRuntimes` runs Bonjour and `tailscale status --json` in parallel and now returns a `RemoteRuntimeDiscoveryResult` with `{ machines, diagnostics }`. Each diagnostic carries `{ source: "bonjour" | "tailscale", code, message, detail }`. Codes today: `bonjour-discovery-failed`, `tailscale-unavailable` (CLI not installed), `tailscale-timeout`, `tailscale-status-failed`. The form surfaces these warnings inline so a missing or hung Tailscale CLI does not look like "no machines found" — the LAN side still ran.

## Bootstrap sequence

`bootstrapRemoteRuntime` performs first-connect setup:

1. Connect over SSH.
2. Detect platform and architecture with `uname -sm` (`normalizeRemoteArch` accepts darwin/linux × arm64/x64).
3. Read `~/.ade/bin/ade.version` and `~/.ade/bin/ade --version` when present.
4. Locate the bundled `ade-<platform-arch>` binary and `ade-<platform-arch>.native.tar.gz` archive in desktop resources.
5. If the local bundle is present and `executableVersion !== appVersion`, upload the binary to `~/.ade/bin/ade` (mode 700 dir, +x file, write `~/.ade/bin/ade.version`).
6. If the native deps archive is present and either the runtime was just uploaded or the remote `~/.ade/runtime/<arch>/.ade-version` doesn't match, upload and extract it to `~/.ade/runtime/<platform-arch>/`.
7. Verify the uploaded runtime by running `~/.ade/bin/ade --version` with the channel/arch environment prefix; abort with `Uploaded ADE service version mismatch` if the reported version doesn't match.
8. Start `ade rpc --stdio`, initialize the JSON-RPC client, validate `multiProject` + `projects` capabilities and version, and read `projects.list`.
9. Update the target registry with architecture, runtime version, last-connected timestamp, and a refreshed `routes` array marking the successful route's `lastSucceededAt`.

If no bundled runtime exists locally and the remote does not already expose `ade` on `PATH`, bootstrap fails with an explicit install/build error rather than silently shipping the wrong version.

Channel layout: `resolveRemoteRuntimeLayout` reads `ADE_PACKAGE_CHANNEL`. Stable uploads to `~/.ade/`; alpha to `~/.ade-alpha/`; beta to `~/.ade-beta/`. Channel builds also pass `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` in the environment prefix so the channel binary doesn't fight a stable login service for the socket.

## Local-vs-remote work warning

Before opening a remote project, `remoteRuntimeCheckLocalWork` compares the remote project's git origin with local projects. It checks both recent desktop projects and projects known to the local runtime daemon's project registry, then runs `git status --porcelain` on matches. Dirty matches produce the `RemoteProjectOpenDialog` confirmation in the remote target UI, listing the matching local clones and their changed file counts.

## Sync command scoping

The sync WebSocket host is owned by the `ade serve` daemon in normal desktop operation. `ProjectScopeRegistry.ensureSyncHost` elects the most-recently-opened registered project as the active sync host and re-elects when projects are added or removed.

Desktop sync Settings IPC first talks to the local runtime daemon for status, discovery, device registry, and PIN operations, then falls back to the legacy in-process sync service only when the daemon route is unavailable. When `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`, IPC skips the daemon route; if no in-process sync service is available, status returns a standalone unavailable snapshot and `sync.setActiveLanePresence` no-ops. The old desktop-host path is guarded by `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics and migration debugging.

The sync command registry labels descriptors as `runtime` or `project` scope. Project-bound hosts reject project-scoped commands that arrive without a matching `projectId`, while runtime-scoped commands operate on the daemon as a whole. This keeps mobile/controller commands explicit in the multi-project runtime.

## Local daemon routing

Local desktop windows go through the runtime binding before falling back to legacy Electron-hosted handlers. `callProjectRuntimeActionOr` and `callProjectRuntimeSyncOr` in `apps/desktop/src/preload/preload.ts` try the runtime path first and fall back to the in-process IPC only on a safe local-runtime fallback error. File actions use the stricter `callProjectFileRuntimeActionOr`: remote runtime first, strict local runtime second, and legacy Electron IPC only when no runtime route exists. This prevents a failed runtime-bound file write/read from being retried against the desktop's local filesystem when the bound project is owned by a daemon or remote host. Usage and budget reads use the remote runtime only for remote-bound windows; local-bound windows keep using desktop usage IPC. During `project.switchToPath`, preload temporarily binds local runtime calls to the requested root and main-process `runtimeBridge.ts` honors the explicit `rootPath` over the window session binding for local action, sync, and event-stream calls. That keeps early lane/chat/file reads from racing against the previous project while the backend switch is still pending. The exception is `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`: preload returns "not handled" for local runtime calls immediately, so local windows use the fallback handlers directly.

The runtime path covers:

- agent chat actions and chat event history
- terminal session list / detail / update / delete and transcript tails
- pty create / write / resize / dispose plus streamed data and exit events
- file reads / writes / search / quick-open / tree listing and file-watch subscriptions
- diff reads and most git operations
- lanes, PRs, PR queue automation, PR issue-resolution launch flows, Path to Merge, PR AI conflict-resolution sessions, issue inventory, tests, processes, and project config

Operations with desktop-only side effects, such as some automation hooks and UI-native flows, still use the in-process IPC handlers until their side effects are moved into ade-cli services.

Preload also guards two classes of API against remote bindings:

- `assertNotRemoteProjectPathAction` rejects `app.revealPath`, `app.openPath`, `app.openPathInEditor`, `app.getImageDataUrl`, and `app.writeClipboardImage` when the input path is the remote project root or any descendant of it. A remote project's filesystem is not mounted locally, so revealing or opening those paths on the desktop would point at the wrong machine.
- `assertLocalProjectHostAction` rejects iOS Simulator window-state / window-source lookups and the local-only macOS VM operations (`getDisplaySession`, `setCredentials`, `detachLane`) on remote-bound windows; those need direct Electron / OS access on the host that owns the simulator or VM.

## Remote connection pool lifecycle

`RemoteConnectionPool` keeps one SSH-backed `RuntimeRpcClient` per `targetId`:

- `withEntryForTarget` is the single funnel for all RPCs. On a recognized `Remote ADE service connection error`, it disposes the entry, reconnects (via the latest `registry.get(targetId)` so an updated `routes` array applies), and either replays the operation or reports the connection error to the caller. `callProjectActionForTarget` only enables automatic replay for safe read-only actions: prefixes `diagnosticsGet|get|list|oauthGet|oauthList|portGet|portList|proxyGet|read|search` plus a small allowlist (`chat.codexFuzzyFileSearch`, `chat.fileSearch`, `chat.modelCatalog`, `file.quickOpen`, `terminal.activeForChat`, `terminal.preview`). Mutating actions surface the connection error so the renderer can prompt the user before retrying.
- `RuntimeRpcClient.call` treats a per-call timeout as terminal: it tears the connection down through `failConnection` instead of dangling the request, which makes the pool's reconnect path observe the dead channel immediately.
- `onEntryEvicted(listener)` lets `RemoteConnectionService` flip a status to `error` when SSH or the JSON-RPC client closes underneath it. `runtimeBridge.ts` subscribes `powerMonitor` `resume` and `unlock-screen` to `remoteConnectionService.probeSavedConnections()`, which pings every `connected` target with a short `pingTimeoutMs` (default 5 s); a failed ping disconnects the entry so the next renderer call reconnects against the most-recently-successful route.

## Per-target action registry

The renderer's command palette needs to know which action domains a target supports. `ade.remoteRuntime.listActionRegistry { id, projectId }` IPC calls `RemoteConnectionPool.listActionRegistryForTarget`, which invokes `list_ade_actions` on the remote runtime and normalizes the result into `AdeActionRegistryEntry[]`. Preload's `ade.actions.listRegistry` checks the active binding: remote-bound windows go through the remote IPC, local-bound windows keep using the existing in-process IPC.

## Local runtime connection lifecycle

`LocalRuntimeConnectionPool` handles the desktop side of the local runtime binding:

- `connect()` first tries an existing `~/.ade/sock/ade.sock`. If that fails, it spawns `ade serve --socket <path>` detached (using the bundled CLI from `process.resourcesPath/ade-cli/cli.cjs` or the dev path), waits for the socket, and reconnects.
- `initialize` is called immediately after connect. The pool compares `runtimeInfo.version` and `runtimeInfo.buildHash` with the expected desktop runtime; a mismatch closes that client and lets the next attach/spawn path choose the right daemon.
- `installServiceBestEffort()` runs `ade serve --install-service` once per session to register the per-user login service; the result feeds `LocalRuntimeStatus.serviceInstall`.
- `getStatus()` periodically refreshes `serviceHealth` (`unsupported | not_installed | installed | running | error | unknown`) by calling `getRuntimeServiceStatus()` from the service manager.
- The pool exposes typed entry points for action calls (`callActionForRoot`), sync calls (`callSyncForRoot`), event polling (`streamEventsForRoot`), and event subscription (`subscribeEventsForRoot`). All of them register the project with `projects.add` once and then carry `projectId` on every project-scoped request.
- Project registration, file actions, and event polling pass per-call timeout overrides to `RuntimeRpcClient`; ordinary actions keep the client's default timeout.
