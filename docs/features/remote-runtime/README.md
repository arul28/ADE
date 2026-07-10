# Remote Runtime

The desktop app connects to an ADE runtime (`ade serve`) running on another
machine. The remote project lives on that machine; lanes, PTYs, git, agent
chat, and PR actions all run there. The local desktop is the controller — it
spawns no project services of its own for a remote binding.

The recommended transport is **paired**: pair the two ADE desktops with a PIN
and device-bound DPoP credentials, then carry the full runtime JSON-RPC over
the machine sync WebSocket. ADE tries direct LAN routes, then tailnet routes,
then the configured cloud relay. **SSH** remains the Advanced path and a
fallback for paired targets that retain usable SSH routes and credentials. It
runs the same JSON-RPC over an SSH `exec` channel using `ade rpc --stdio` and
can upload or start the remote runtime when needed. The relay is not an
end-to-end encrypted tunnel; see the trust boundary in
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
  RPC client, remote connection pool (paired-first with eligible SSH fallback,
  eviction listeners, retryable reads, preview forwards, optional-action
  fallbacks, event-stream gap/epoch propagation), connection service, and
  Bonjour + Tailscale discovery.
- `apps/desktop/src/main/services/ipc/runtimeBridge.ts` — runtime IPC boundary:
  remote target registry, connect / projects / project-open channels, remote
  action/sync/event dispatch, local-runtime project action/sync/event routing,
  local port-forward creation for remote previews, per-target action registry
  lookups, replay-aware event streams, manual disconnect handling, and
  per-window remote-open generation guards so a slow earlier remote-project
  open cannot overwrite the latest window binding.
- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` —
  the local runtime connection used by desktop IPC, event streaming, sync
  Settings, and local-work checks. It preserves a newer already-running machine
  brain instead of replacing it with an older desktop-bundled runtime, falls
  back to an isolated no-sync runtime for the old desktop window, and reports
  `versionSkew` so the renderer can require a desktop update. It also spawns
  `ade serve` for non-primary sockets, tracks the per-user login service
  install/health state, and applies short per-call timeouts for project
  registration, file actions, and event polling so renderer IPC calls do not
  wait for the desktop handler timeout.
- `apps/desktop/src/renderer/components/remoteTargets/` — Machines panel with
  connected / available / unavailable sections, Pair and SSH entry paths,
  share-this-machine and connection-doctor cards, saved/discovered machine
  rows, route and latency status, SSH host-key trust, structured connection
  errors, project picker, and the dirty-local-work warning.
- `apps/desktop/src/renderer/components/projects/RemoteProjectOpenDialog.tsx` —
  confirmation dialog before opening a remote project, surfaces local matches
  with uncommitted changes.
- `apps/desktop/src/preload/preload.ts` — routes runtime-backed renderer APIs to
  local or remote JSON-RPC actions based on the active project binding. Remote
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
  the renderer opens them.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — runtime-level project catalog
  and sync methods, machine-scoped personal-chat methods, plus project-scoped
  action dispatch. `runtimeEvents.*`
  replies include `eventEpoch`, `gap`, and `oldestCursor` from the runtime's
  bounded event buffer. `projects.list` inlines host-resolved icons, with
  `dataUrl`, `sourcePath`, and `mimeType` fields, under a connect-path budget
  (64 icons / 12 MB per call), so a connected desktop can render real project
  logos without letting an oversized registry stall connection setup.
- `apps/ade-cli/src/services/projects/` — machine project registry,
  per-project service scope cache, and `projectIconResolver.ts`
  (`resolveRemoteProjectIcon`, an electron-free port of the desktop icon
  resolver: `.ade/ade.yaml` override + conventional icon/logo files +
  `index.html` `<link rel="icon">`, best-effort and capped at 2 MB to stay
  inline-safe on the wire).
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
local lane; ADE controls the remote runtime and expects normal git workflow to
move code between local and remote clones.

When opening a remote project, ADE checks local projects with the same git origin. If a matching local copy has uncommitted changes, ADE shows a confirmation dialog (`RemoteProjectOpenDialog`) before switching so the user can push, stash, or keep the divergent local work intentionally.

## Connect flow

1. Open the Machines panel. ADE combines Bonjour and Tailscale discovery,
   removes this machine's own Bonjour advertisement, and merges routes that
   identify the same machine. Discovered paired-capable ADE desktops appear in
   Available; offline or unsupported machines remain visible in Unavailable.
2. Use **Pair** for the normal flow. Paste or scan the machine's pairing link or
   code, enter its six-digit PIN, and let ADE save the machine identity, DPoP
   key, and advertised direct/relay endpoints. A discovered machine with an
   existing pairing is upgraded to a paired target automatically.
3. Connect. ADE dials paired routes in LAN → tailnet → relay order, preferring a
   recently successful endpoint within each class. After authenticated
   `hello_ok`, it requires `features.rpcChannel === true`, opens the runtime
   JSON-RPC channel, and uses the paired port-forward channel for remote preview
   URLs. The connected status reports the winning route and latency. A relay
   route is a trusted-operator plaintext-readable path, not a confidential
   channel.
4. If paired dialing fails, or the remote runtime does not support the paired
   RPC channel, ADE silently falls back to SSH only when that paired target has
   usable SSH routes and credentials. SSH host-key trust is requested only
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
7. Pick an existing remote project or register a new remote path; the desktop
   calls `projects.add { rootPath }` against the remote runtime to bind it.
   If the same window starts multiple remote opens concurrently, both preload
   and the main IPC bridge keep only the latest open as the durable binding.

After connecting, the desktop persists the active remote project to `globalState.lastRemoteProjectBinding` and records it in the unified recent-project list with target id, project id, runtime name, and hostname. Remote recents are keyed as `remote:<targetId>:<projectId>`, so a remote project can share a path string with a local checkout without colliding; the welcome screen can reconnect/open the remote row directly from that metadata. When the app relaunches with no startup project path, the first window restores the last remote binding and reconnects to the same target / project automatically. A user-triggered disconnect records manual intent on the target and suppresses restore/autoconnect until the user presses Connect again; repeated implicit reconnect failures also pause automatic reconnects and surface a "Press Connect to try again" message.

Per-channel layout: builds with `ADE_PACKAGE_CHANNEL=alpha|beta` upload to `~/.ade-alpha/` or `~/.ade-beta/` instead of `~/.ade/` so a remote machine can host stable, beta, and alpha runtimes side by side. Runtime binaries, native deps, PTY workers, and bundled ADE agent skills all live under the selected home. Remote compatibility launches keep `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` so remote probes do not fight the user's login service.

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

For headless macOS / Linux machines that can run an SSH server but have no desktop, the runtime can be installed directly from a release. Release publishing includes `install.sh`, `SHA256SUMS`, the `ade-<platform-arch>` binaries, and the matching native dependency archives for darwin/linux arm64/x64. SSH-reachable machines can still skip the standalone installer because desktop bootstrap uploads bundled runtime artifacts on first connect.

```bash
curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
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

Remote project bindings route lanes, agent chat, PTYs, terminal IO, file operations, file-watch notifications, git actions, PR actions, PR queue automation, PR AI conflict-resolution sessions, PR issue-resolution launch flows, AI PR summaries, issue inventory, and event streaming through the remote runtime. The global Chats route deliberately retains the window binding: when opened from a remote-bound project tab, `personalChats.call` / `streamEvents` go to that remote machine's hidden personal-chat scope; from a local or no-project window they go to the local brain. Remote lane preview URLs are opened through a local TCP forward created by the desktop, so a dev server bound to `127.0.0.1` on the remote can be inspected from the local window. A connected remote project's tab shows the real project logo and a yellow connected accent: the host brain resolves the icon and inlines it on `projects.list`, the desktop threads it through `RemoteRuntimeProjectRecord.icon` → `OpenProjectBinding.iconDataUrl` to the tab, and persists it so the logo is restored on a cold start before the remote reconnects. Agent CLI failures (Claude / Codex / Cursor / Droid not installed or not authenticated) surface as inline `AgentCliAuthCard` cards in chat; the install / login buttons open a tracked terminal in the active runtime, so a remote project runs the install or login command on the remote machine.

Local project bindings use the local ADE runtime for the same surfaces — agent chat, session history, PTYs, terminal reads/writes, file operations and watchers, diffs, lanes, PRs, PR queues, PR issue-resolution launch flows, PR AI conflict-resolution sessions, issue inventory, tests, processes, project config, and most git operations. Electron main still owns desktop-only services that physically require an Electron host.

## Mobile reachability

iOS does not SSH into a machine. The phone pairs with an ADE machine and connects to that runtime's sync WebSocket advertised on the LAN or over a Tailscale tailnet. Install Tailscale on the phone and the ADE machine when they are not on the same local network.

On desktop, the top-bar Mobile control is a runtime control, not a project control. It remains visible while a window is bound to a remote project: `window.ade.sync.*` routes to the active runtime binding, so a local/no-project window manages the local machine brain while a remote-bound window manages the remote machine's sync service. The legacy in-process desktop sync host is disabled by default and can be re-enabled only for diagnostics with `ADE_ENABLE_DESKTOP_SYNC_HOST=1`.

## Troubleshooting

- `Remote target was not found` — the saved target was removed or the UI has a stale selection. Refresh the target list.
- `Remote machine was manually disconnected. Connect again to use this remote project.` — the user explicitly disconnected the target; ADE will not implicitly reconnect or restore it until Connect is pressed.
- `ADE stopped automatic reconnecting after 10 failed attempts. Press Connect to try again.` — implicit reconnects were paused after repeated failures so the renderer does not keep hammering SSH.
- `SSH server at <host:port> closed the connection before ADE could finish the SSH handshake` — the TCP route opened but the server reset or closed the SSH handshake. Check Remote Login/sshd, firewall rules, and Tailscale SSH policy.
- `ADE service is not installed ... no bundled ADE service is available` — install or build `ade` on the remote, or use a release build that includes runtime resources for the remote architecture.
- `Uploaded ADE service version mismatch: expected X, got Y` — the uploaded binary did not report the expected runtime version. Rebuild the static runtime artifacts for the current desktop version.
- `Remote ADE service does not support multi-project mode` — the remote is running an older ADE before multi-project RPC. Re-bootstrap from a current desktop build.
- `Remote ADE service could not start a compatible RPC runtime. Tried ...` — every alternate ADE home (`.ade`, `.ade-alpha`, `.ade-beta`) failed to start. The error lists each home and the underlying reason. Install or rebuild `ade` on the remote machine for the desktop's target architecture.
- `Remote ADE service <version> does not support <capability>.` — the remote runtime connected but is missing a specific `machineProjects` capability the renderer just called (e.g. `cloning remote projects`). Update ADE on that machine.
- `Remote ADE service method <method> failed (code N): <message> Details: ...` — the runtime RPC client now surfaces the JSON-RPC error `code`, `message`, and `data` together so a remote handler failure (e.g. a missing project capability or a service action error) is no longer reported as a generic `Remote ADE service request failed.` string.
- `Remote ADE service connection failed: timed out waiting for method ...` — the RPC client timed out and tore the connection down deliberately so the pool can rebuild it. Retry the action; the pool will reconnect using the latest known route.
- "Tailscale CLI was not found / timed out / failed" warning under the discovered-machines list — surfaced from `discoverLanRuntimes` diagnostics. LAN (Bonjour) discovery still ran; install or unblock `tailscale` to add tailnet peers.
- Agent provider missing or unauthenticated — use the inline `AgentCliAuthCard` to install or authenticate that provider on the active runtime machine.

## Related docs

- [Internal architecture](./internal-architecture.md) — protocol shape, bootstrap sequence, sync command scoping.
- [ADE CLI](../../../apps/ade-cli/README.md) — runtime modes, service manager, machine layout, and legacy compatibility command names.
- [ADE Code](../ade-code/README.md) — terminal client that uses the same runtime.
- [Sync and Multi-Device](../sync-and-multi-device/README.md) — phone pairing and multi-device sync (hosted by the same runtime).
