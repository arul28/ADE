# Remote Runtime Internal Architecture

Remote runtime support is built on the same JSON-RPC runtime the local `ade serve` daemon answers. The desktop chooses a runtime binding for each window; the renderer APIs stay stable while preload decides whether to call the local runtime daemon or a remote SSH-backed runtime. Both bindings speak the same wire protocol.

## Runtime bindings

`OpenProjectBinding` records the active runtime for a window:

- `kind: "local"` — actions go through `LocalRuntimeConnectionPool`, which connects to the machine socket (`~/.ade/sock/ade.sock`) and spawns `ade serve` if it is not running.
- `kind: "remote"` — actions go through `RemoteConnectionPool` keyed by `{ targetId, projectId }`.

The binding is established when a project is opened. Local bindings are created from the current desktop project (the desktop calls `LocalRuntimeConnectionPool.ensureProject(rootPath)` to register the project with the daemon and capture its `projectId`). Remote bindings are created by `remoteRuntimeOpenProject` after the selected target is connected and the remote project record is confirmed. Remote opens are generation-guarded twice: preload only remembers the newest `ade.remoteRuntime.openProject` result, and `runtimeBridge.ts` only calls `bindRemoteProject` for the newest in-flight open request from that window/webContents. A slow earlier open can still return its binding to its caller, but it cannot overwrite the window session or `lastRemoteProjectBinding`.

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

`ade/initialize` advertises `runtimeInfo.multiProject: true`, `runtimeInfo.packageChannel` (when set on the daemon environment), and `capabilities.projects: true`. Clients use the multi-project flag to decide whether to send `projectId` per request (multi-project runtime) or treat the runtime as already bound to one project (embedded `ade code --embedded`). `validateRemoteRuntimeInitializeResult` enforces both top-level capabilities, normalizes the per-method `capabilities.machineProjects` flags (`browseDirectories`, `getDetail`, `getWorkSummary`, `getDefaultParentDir`, `create`, `clone`, `listMyGitHubRepos`), and turns version mismatch / channel mismatch / missing capabilities into a `RemoteRuntimeInitializeInfo.compatibilityWarnings` array instead of throwing. Those warnings flow back to `bootstrapRemoteRuntime`, are returned on `RemoteRuntimeConnectResult.compatibilityWarnings`, and are surfaced inline under the remote target's connection chip.

`RemoteRuntimeCapabilities` (in `apps/desktop/src/shared/types/remoteRuntime.ts`) is the structured shape both the connect result and the connection status carry. `RemoteConnectionPool.assertMachineProjectCapability` maps `projects.*` RPC method names to the matching capability flag and rejects the call with a self-describing message before it leaves the desktop when the remote did not advertise that capability — the connection stays open for everything else.

Runtime event streaming uses `ade/actions/call` with `name: "stream_events"` for one-shot pulls, and `runtimeEvents.subscribe` (with `runtime/event` notifications) for live streaming. For remote bindings the desktop reconnects the SSH transport before re-subscribing, matching normal remote action behavior after disconnects. The initial remote subscription starts with `replay: false` when the cursor is still zero, so opening a remote project does not flood the renderer with buffered history before live events arrive; catch-up polls still use a short delay while idle remote polls back off. For local bindings, preload polls the local daemon through `localRuntimeStreamEvents` so daemon-owned chat, terminal, pty, lane, file-watch, process, and test events are delivered through the same renderer fanout used by remote projects.

Each `stream_events` response carries a per-runtime `eventEpoch` UUID minted when the daemon's `eventBuffer` is constructed. The preload event pump compares it against the last seen epoch for the active binding; if it changes (daemon restart, ssh reconnect to a fresh process) the cursor and dedup set reset and the next poll starts from `cursor=0`. The `startedAtMs` "drop events older than the pump start" filter is only applied to **local** bindings — remote pumps rely on the epoch reset instead, so older events backfilled after a reconnect are still delivered.

The remote event buffer categories are intentionally narrow: `orchestrator`, `dag_mutation`, `runtime`, and `pty`. Preload dispatches `runtime` events by their payload `type` so domain-specific updates such as agent chat, terminal, lane, PR, file-watch, process, test, project-state, usage, automation, conflict, GitHub, Linear, feedback, Computer Use, iOS Simulator, App Control, and macOS VM changes still reach their dedicated remote subscribers without expanding the wire-level category enum. ade-cli wires these source-tagged payloads into the runtime event buffer in `bootstrap.ts` so a remote-bound window sees the same event fanout as the local host. Headless runtimes start `usageTrackingService` during `createAdeRuntime()` after the ADE action registry is bound, so the usage poller and threshold events run only once the runtime can answer the matching usage/budget actions.

## SSH transport

`sshTransport.ts` creates an `ssh2` client config from the saved target:

- host, port, and username come from the remote target registry.
- `sshKeyPath` loads a private key from disk when supplied.
- if no explicit key path is saved, matching `HostName` and `IdentityFile` entries in `~/.ssh/config` are applied so aliases like `Host studio` work.
- `SSH_AUTH_SOCK` is passed through as `agent` when available.
- every config carries a bounded `readyTimeout` (`ADE_REMOTE_SSH_CONNECT_TIMEOUT_MS`, default 10 s) and disables SSH-level keepalives; runtime RPC calls, exec probes, and artifact uploads carry their own timeouts so large channel writes are not interrupted by transport probes.

The runtime transport itself is an SSH `exec` channel running `ade rpc --stdio` (with the channel-aware environment prefix from `buildRemoteRuntimeEnvironmentPrefix`). The channel implements the `RuntimeRpcTransport` interface used by `RuntimeRpcClient`, the same client `LocalRuntimeConnectionPool` uses against a Unix socket.

Short SSH exec probes use `ADE_REMOTE_SSH_EXEC_TIMEOUT_MS` (default 30 s). Connect failures are normalized before surfacing to the renderer so handshake timeouts, connection resets before ready, and local TCP port exhaustion have actionable messages.

### Multi-route fallback

A remote target stores a primary `hostname` plus an optional `routes` array (`RemoteRuntimeTargetRoute[]`). Each route has `{ hostname, port, source: "manual" | "bonjour" | "tailscale", lastSucceededAt }`. Discovery captures every reachable address advertised by a peer (Tailscale FQDN, mDNS host, raw IPv4/IPv6 entries) and `RemoteTargetForm` persists them alongside the manual host on save.

`buildSshRouteCandidates` flattens routes (deduped by `hostname:port`, primary always first) and sorts later attempts by most-recent `lastSucceededAt`. `connectSshWithRoute` walks the route × username matrix: an authentication failure tries the next username for the same route, any other failure skips remaining usernames and advances to the next route. On success, `bootstrapRemoteRuntime` calls `markRemoteTargetRouteSucceeded` so the registry remembers which route worked — a target that moved between LAN and Tailscale auto-prefers whichever one reconnected last.

### Discovery diagnostics

`discoverLanRuntimes` runs Bonjour and `tailscale status --json` in parallel and now returns a `RemoteRuntimeDiscoveryResult` with `{ machines, diagnostics }`. Each diagnostic carries `{ source: "bonjour" | "tailscale", code, message, detail }`. Codes today: `bonjour-discovery-failed`, `tailscale-unavailable` (CLI not installed), `tailscale-timeout`, `tailscale-status-failed`. The form surfaces these warnings inline so a missing or hung Tailscale CLI does not look like "no machines found" — the LAN side still ran.

## Bootstrap sequence

`bootstrapRemoteRuntime` performs first-connect setup:

1. Connect over SSH.
2. Detect platform and architecture with `uname -sm` (`normalizeRemoteArch` accepts darwin/linux × arm64/x64).
3. Read the preferred channel home's `bin/ade.version`, `bin/ade.sha256`, and `bin/ade --version` when present.
4. Locate the bundled `ade-<platform-arch>` binary, `ade-<platform-arch>.native.tar.gz` archive, and packaged `ptyHostWorker.cjs` in desktop resources.
5. If the desktop has no bundled binary for that arch and no executable was found in the preferred home, probe the alternate channel homes (`~/.ade`, `~/.ade-alpha`, `~/.ade-beta`) for a working `ade --version`. The first home that responds is adopted as the active layout and the reason is captured for the connection's `compatibilityWarnings` (`Using remote runtime home <home> because <preferred> did not contain an ADE service for <arch>`).
6. If the local bundle is present and the selected installed version or SHA does not match the desktop bundle, upload the binary to `<layout>/bin/ade` (mode 700 dir, +x file, write `<layout>/bin/ade.version` and `<layout>/bin/ade.sha256`). Uploads prefer SFTP; when that cannot start safely, ADE writes bounded SSH chunks and can fall back to OpenSSH for chunks that did not enter the existing channel.
7. If the native deps archive is present and either the runtime was just uploaded or the remote `<layout>/runtime/<arch>/.ade-version` doesn't match, upload and extract it to `<layout>/runtime/<platform-arch>/`.
8. If the PTY host worker is available locally and the remote worker hash is missing or stale, upload it to `<layout>/runtime/ptyHostWorker.cjs` with a sidecar `.sha256`. When the remote has `node`, the runtime environment points `ADE_PTY_HOST_WORKER_PATH` and `ADE_PTY_HOST_WORKER_NODE` at that worker; otherwise it points `ADE_PTY_HOST_WORKER_COMMAND` at the uploaded `ade` binary so the static runtime can run the internal worker entry.
9. Verify the uploaded runtime by running `<layout>/bin/ade --version` with the channel/arch/worker environment prefix; abort with `Uploaded ADE service version mismatch` if the reported version doesn't match.
10. Start `ade rpc --stdio`, initialize the JSON-RPC client, normalize capabilities and version through `validateRemoteRuntimeInitializeResult`, and read `projects.list`. Version skew, channel skew, and missing capabilities become `compatibilityWarnings` rather than throws.
11. If the bundled binary was absent and the validated initialize still fails, walk the alternate channel homes again with `ade rpc --stdio` against each candidate. The first home that completes initialize wins; failed candidates are collected so the final error reads `Remote ADE service could not start a compatible RPC runtime. Tried <home1>: <reason>; <home2>: <reason>.`. If a fallback wins, the chosen home is recorded as a compatibility warning.
12. Update the target registry with architecture, runtime version (preferring the value the daemon reported through `initialize`), last-connected timestamp, and a refreshed `routes` array marking the successful route's `lastSucceededAt`.

If no bundled runtime exists locally and no channel home on the remote can start a compatible RPC, bootstrap fails with an explicit install/build error rather than silently shipping the wrong version.

Channel layout: `resolveRemoteRuntimeLayout` reads `ADE_PACKAGE_CHANNEL` for the preferred home; `resolveRemoteRuntimeLayoutCandidates` enumerates that preferred home plus the stable / alpha / beta layouts (deduped by `homeDirName`) for the fallback walk. Stable uploads to `~/.ade/`; alpha to `~/.ade-alpha/`; beta to `~/.ade-beta/`. Channel builds also pass `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` in the environment prefix so the channel binary doesn't fight a stable login service for the socket.

## Local-vs-remote work warning

Before opening a remote project, `remoteRuntimeCheckLocalWork` compares the remote project's git origin with local projects. It checks both recent desktop projects and projects known to the local runtime daemon's project registry, then runs `git status --porcelain` on matches. Dirty matches produce the `RemoteProjectOpenDialog` confirmation in the remote target UI, listing the matching local clones and their changed file counts.

## Sync command scoping

The sync WebSocket host is owned by the `ade serve` daemon in normal desktop operation. `ProjectScopeRegistry.ensureSyncHost` elects the most-recently-opened registered project as the active sync host and re-elects when projects are added or removed.

Desktop sync Settings IPC first talks to the active runtime for status, discovery, device registry, and PIN operations. Local project windows use `LocalRuntimeConnectionPool`; remote project windows use `RemoteConnectionPool`. The old desktop-host path is guarded by `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics and migration debugging.

The sync command registry labels descriptors as `runtime` or `project` scope. Project-bound hosts reject project-scoped commands that arrive without a matching `projectId`, while runtime-scoped commands operate on the daemon as a whole. This keeps mobile/controller commands explicit in the multi-project runtime.

## Local daemon routing

Local desktop windows go through the runtime binding. `callProjectRuntimeActionOr` and `callProjectRuntimeSyncOr` in `apps/desktop/src/preload/preload.ts` call the active local or remote runtime when a binding exists; legacy Electron IPC handlers are used only when no runtime route is bound or for desktop-only side effects. File actions are strict once a local or remote runtime is bound, which prevents a failed runtime-bound file write/read from being retried against the desktop's local filesystem when the bound project is owned by a daemon or remote host. Usage and budget reads use the remote runtime only for remote-bound windows; local-bound windows keep using desktop usage IPC. During `project.switchToPath`, preload temporarily binds local runtime calls to the requested root and main-process `runtimeBridge.ts` honors the explicit `rootPath` over the window session binding for local action, sync, and event-stream calls. During `remoteRuntime.openProject`, preload clears the binding while the switch is in flight; mutating runtime actions and mutating sync calls fail with the "Project is switching" message instead of refreshing or writing through a stale binding, while read-only project calls can wait for the active remote open and retry against the new binding.

Lane preview reads are also binding-aware. For remote bindings, `proxyGetPreviewInfo` is resolved on the remote runtime, then `remoteRuntime.ensurePortForward` creates or reuses a local `127.0.0.1:<port>` TCP forward to the remote preview port and rewrites the preview URL before returning it to the renderer.

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

- `withEntryForTarget` is the single funnel for all RPCs. On a recognized `Remote ADE service connection error`, it disposes the entry, reconnects (via the latest `registry.get(targetId)` so an updated `routes` array applies), and either replays the operation or reports the connection error to the caller. `callProjectActionForTarget` only enables automatic replay for safe read-only actions: prefixes `diagnosticsGet|get|list|oauthGet|oauthList|portGet|portList|proxyGet|read|search` plus a small allowlist (`chat.codexFuzzyFileSearch`, `chat.fileSearch`, `chat.modelCatalog`, `file.quickOpen`, `terminal.activeForChat`, `terminal.preview`). `callProjectSyncForTarget` uses the same posture for sync: status/discovery/device/PIN reads, lane-presence announcements, and model-picker reads are retryable; mutating sync calls surface the connection error so the renderer can prompt the user before retrying.
- Connection startup failures are backoff-throttled per target so repeated implicit reconnect attempts do not saturate SSH. Explicit Connect bypasses that backoff, clears manual disconnect state, and resets the automatic reconnect failure budget. After 10 implicit connection failures, `RemoteConnectionService` pauses automatic reconnect and reports that the user must press Connect.
- `ensureLocalPortForward` owns local TCP listeners keyed by `(targetId, remoteHost, remotePort)`. Each listener uses `ssh.forwardOut` into the active SSH session and is closed when the target disconnects.
- `callMethodForTarget` is the runtime-scoped JSON-RPC entry point used by the command-palette project picker and clone flows. Before forwarding to the SSH transport it runs `assertMachineProjectCapability(entry, method)`, which checks the connection's `capabilities.machineProjects` map for the `projects.*` family. A missing capability fails the call with a self-describing message that names the action (e.g. `creating remote projects`) so the renderer can guide the user to update the remote runtime.
- A small set of optional remote actions has compatibility fallbacks. Missing `file.refreshGitDecorations` returns an empty decoration set and marks `statusHints.optionalActionMissing`; missing `pr.listQueueStates` returns an empty queue-state list. The first not-callable response is memoized per target/project/action so old remote runtimes do not get hammered by unsupported optional calls.
- `RuntimeRpcClient.call` treats a per-call timeout as terminal: it tears the connection down through `failConnection` instead of dangling the request, which makes the pool's reconnect path observe the dead channel immediately. The client now records the original `method` for every pending request and formats remote errors as `Remote ADE service method <method> failed (code N): <message> Details: ...` so JSON-RPC error `code` / `message` / `data` are all preserved instead of being collapsed into a generic string.
- `onEntryEvicted(listener)` lets `RemoteConnectionService` flip a status to `error` when SSH or the JSON-RPC client closes underneath it. `runtimeBridge.ts` subscribes `powerMonitor` `resume` and `unlock-screen` to `remoteConnectionService.probeSavedConnections()`, which pings every `connected` target with a short `pingTimeoutMs` (default 5 s); a failed ping disconnects the entry so the next renderer call reconnects against the most-recently-successful route.

## Per-target action registry

The renderer's command palette needs to know which action domains a target supports. `ade.remoteRuntime.listActionRegistry { id, projectId }` IPC calls `RemoteConnectionPool.listActionRegistryForTarget`, which invokes `list_ade_actions` on the remote runtime and normalizes the result into `AdeActionRegistryEntry[]`. Preload's `ade.actions.listRegistry` checks the active binding: remote-bound windows query the remote runtime, local-bound windows query the local ADE runtime through `ade.localRuntime.listActionRegistry`, and the desktop in-process registry is only used when no project runtime is bound.

## Local runtime connection lifecycle

`LocalRuntimeConnectionPool` handles the desktop side of the local runtime binding:

- `connect()` first tries an existing `~/.ade/sock/ade.sock`. If that socket is unavailable, it spawns `ade serve --socket <path>` with the bundled CLI from `process.resourcesPath/ade-cli/cli.cjs` or the dev path, waits for the socket, and reconnects.
- `initialize` is called immediately after connect. The pool compares `runtimeInfo.version`, `runtimeInfo.buildHash`, and `runtimeInfo.defaultRole` with the expected desktop runtime. A mismatch closes only that client: the primary `ade.sock` daemon is preserved, and the desktop starts or reuses a deterministic isolated socket (`ade-cto-<version>-<build>.sock`) for its own runtime instead of terminating the user's existing daemon.
- `installServiceBestEffort()` runs `ade serve --install-service` once per session to register the per-user login service; the result feeds `LocalRuntimeStatus.serviceInstall`.
- `getStatus()` periodically refreshes `serviceHealth` (`unsupported | not_installed | installed | running | error | unknown`) by calling `getRuntimeServiceStatus()` from the service manager.
- The pool exposes typed entry points for action calls (`callActionForRoot`), sync calls (`callSyncForRoot`), event polling (`streamEventsForRoot`), and event subscription (`subscribeEventsForRoot`). All of them register the project with `projects.add` once and then carry `projectId` on every project-scoped request.
- Project registration, file actions, and event polling pass per-call timeout overrides to `RuntimeRpcClient`; ordinary actions keep the client's default timeout.
- `callActionForRoot` measures `ensureProject`, `connect`, and the daemon RPC separately. Any action call that exceeds 500 ms total — or throws — emits a `local_runtime.action_slow` warning log with `domain`, `action`, `totalMs`, `ensureProjectMs`, `connectMs`, `daemonCallMs`, the applied per-call timeout, and the error message (when present). This is the entry point for diagnosing why a renderer action stalled before the IPC timeout fires.
