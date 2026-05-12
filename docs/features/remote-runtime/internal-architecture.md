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

Runtime event streaming uses `ade/actions/call` with `name: "stream_events"` for one-shot pulls, and `runtimeEvents.subscribe` (with `runtime/event` notifications) for live streaming. For remote bindings the desktop reconnects the SSH transport before re-subscribing, matching normal remote action behavior after disconnects. For local bindings, preload polls the local daemon through `localRuntimeStreamEvents` so daemon-owned chat, terminal, pty, lane, file-watch, process, and test events are delivered through the same renderer fanout used by remote projects. The local event pump is not started when `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`.

## SSH transport

`sshTransport.ts` creates an `ssh2` client config from the saved target:

- host, port, and username come from the remote target registry.
- `sshKeyPath` loads a private key from disk when supplied.
- if no explicit key path is saved, matching `HostName` and `IdentityFile` entries in `~/.ssh/config` are applied so aliases like `Host studio` work.
- `SSH_AUTH_SOCK` is passed through as `agent` when available.

The runtime transport itself is an SSH `exec` channel running `ade rpc --stdio` (with the channel-aware environment prefix from `buildRemoteRuntimeEnvironmentPrefix`). The channel implements the `RuntimeRpcTransport` interface used by `RuntimeRpcClient`, the same client `LocalRuntimeConnectionPool` uses against a Unix socket.

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
9. Update the target registry with architecture, runtime version, and last-connected timestamp.

If no bundled runtime exists locally and the remote does not already expose `ade` on `PATH`, bootstrap fails with an explicit install/build error rather than silently shipping the wrong version.

Channel layout: `resolveRemoteRuntimeLayout` reads `ADE_PACKAGE_CHANNEL`. Stable uploads to `~/.ade/`; alpha to `~/.ade-alpha/`; beta to `~/.ade-beta/`. Channel builds also pass `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` in the environment prefix so the channel binary doesn't fight a stable login service for the socket.

## Local-vs-remote work warning

Before opening a remote project, `remoteRuntimeCheckLocalWork` compares the remote project's git origin with local projects. It checks both recent desktop projects and projects known to the local runtime daemon's project registry, then runs `git status --porcelain` on matches. Dirty matches produce the `RemoteProjectOpenDialog` confirmation in the remote target UI, listing the matching local clones and their changed file counts.

## Sync command scoping

The sync WebSocket host is owned by the `ade serve` daemon in normal desktop operation. `ProjectScopeRegistry.ensureSyncHost` elects the most-recently-opened registered project as the active sync host and re-elects when projects are added or removed.

Desktop sync Settings IPC first talks to the local runtime daemon for status, discovery, device registry, and PIN operations, then falls back to the legacy in-process sync service only when the daemon route is unavailable. When `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`, IPC skips the daemon route; if no in-process sync service is available, status returns a standalone unavailable snapshot and `sync.setActiveLanePresence` no-ops. The old desktop-host path is guarded by `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics and migration debugging.

The sync command registry labels descriptors as `runtime` or `project` scope. Project-bound hosts reject project-scoped commands that arrive without a matching `projectId`, while runtime-scoped commands operate on the daemon as a whole. This keeps mobile/controller commands explicit in the multi-project runtime.

## Local daemon routing

Local desktop windows go through the runtime binding before falling back to legacy Electron-hosted handlers. `callProjectRuntimeActionOr` and `callProjectRuntimeSyncOr` in `apps/desktop/src/preload/preload.ts` try the runtime path first and fall back to the in-process IPC only on a safe local-runtime fallback error. The exception is `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`: preload returns "not handled" for local runtime calls immediately, so local windows use the fallback handlers directly.

The runtime path covers:

- agent chat actions and chat event history
- terminal session list / detail / update / delete and transcript tails
- pty create / write / resize / dispose plus streamed data and exit events
- file reads / writes / search / quick-open / tree listing and file-watch subscriptions
- diff reads and most git operations
- lanes, PRs, PR queue automation, PR issue-resolution launch flows, Path to Merge, PR AI conflict-resolution sessions, issue inventory, tests, processes, and project config

Operations with desktop-only side effects, such as some automation hooks and UI-native flows, still use the in-process IPC handlers until their side effects are moved into ade-cli services.

## Local runtime connection lifecycle

`LocalRuntimeConnectionPool` handles the desktop side of the local runtime binding:

- `connect()` first tries an existing `~/.ade/sock/ade.sock`. If that fails, it spawns `ade serve --socket <path>` detached (using the bundled CLI from `process.resourcesPath/ade-cli/cli.cjs` or the dev path), waits for the socket, and reconnects.
- `initialize` is called immediately after connect; if `runtimeInfo.version` does not match the desktop app version, the pool shuts the connection down and lets the next call respawn the daemon at the right version.
- `installServiceBestEffort()` runs `ade serve --install-service` once per session to register the per-user login service; the result feeds `LocalRuntimeStatus.serviceInstall`.
- `getStatus()` periodically refreshes `serviceHealth` (`unsupported | not_installed | installed | running | error | unknown`) by calling `getRuntimeServiceStatus()` from the service manager.
- The pool exposes typed entry points for action calls (`callActionForRoot`), sync calls (`callSyncForRoot`), event polling (`streamEventsForRoot`), and event subscription (`subscribeEventsForRoot`). All of them register the project with `projects.add` once and then carry `projectId` on every project-scoped request.
