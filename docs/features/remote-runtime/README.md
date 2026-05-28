# Remote Runtime

The desktop app connects to an `ade serve` daemon running on a remote machine over SSH. The remote project lives on that machine; lanes, PTYs, git, agent chat, and PR actions all run there. The local desktop is the controller — it spawns no project services of its own for a remote binding.

The wire transport is the same JSON-RPC the local daemon answers. The remote-runtime layer just wraps it in an SSH `exec` channel running `ade rpc --stdio`.

## Source file map

- `apps/desktop/src/main/services/remoteRuntime/` — SSH transport (multi-route
  fallback, ssh2 keepalive), runtime bootstrap, target registry (saved routes +
  per-route `lastSucceededAt`), runtime RPC client (timeouts treated as fatal),
  remote connection pool (eviction listeners, retryable read-only actions and
  selected retryable sync reads), remote connection service
  (`powerMonitor`-driven `probeSavedConnections`), `runtimeDiscovery.ts`
  (Bonjour + Tailscale with `discoverLanRuntimes` returning
  `{ machines, diagnostics }`).
- `apps/desktop/src/main/services/ipc/runtimeBridge.ts` — runtime IPC boundary:
  remote target registry, connect / projects / project-open channels, remote
  action/sync/event dispatch, local-runtime project action/sync/event routing,
  per-target action registry lookups, and per-window remote-open generation
  guards so a slow earlier remote-project open cannot overwrite the latest
  window binding.
- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` —
  the local daemon connection used by desktop IPC, event streaming, sync
  Settings, and local-work checks. Spawns `ade serve` if the machine socket is
  not listening; tracks the per-user login service install/health state; applies
  short per-call timeouts for project registration, file actions, and event
  polling so renderer IPC calls do not wait for the desktop handler timeout.
- `apps/desktop/src/renderer/components/remoteTargets/` — remote machine form
  (carries `routes` through saves), target list (Tailscale-preferred primary
  route, "+ N routes" fallback hint, Tailscale/Bonjour discovery diagnostics
  warning, and a yellow `Warning` strip for the
  `compatibilityWarnings` the bootstrap returns for the selected
  connection — version skew, channel mismatch, missing project
  capabilities, runtime-home fallbacks), project picker, dirty-local-work
  warning.
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
  renderer requests hit the destination daemon project instead of the previous
  window session binding. During remote project opens, preload clears the
  current binding, tracks the newest open generation, blocks mutating
  action/sync calls with the "Project is switching" error, and avoids refreshing
  a stale runtime binding.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — runtime-level project catalog
  and sync methods plus project-scoped action dispatch.
- `apps/ade-cli/src/services/projects/` — machine project registry and
  per-project service scope cache.
- `apps/ade-cli/scripts/build-static.mjs` — produces the static
  `ade-<platform-arch>` SEA binary and the `.native.tar.gz` of native modules.
- `apps/ade-cli/scripts/install-runtime.sh` — standalone installer that
  downloads `ade-<platform-arch>` and the matching native deps from a release.
- `apps/desktop/scripts/materialize-runtime-resources.mjs` and
  `validate-runtime-resources.mjs` — populate and validate
  `apps/desktop/resources/runtime/` for packaging.

## User model

A **remote target** is a machine reachable by SSH. A **remote project** is a path on that machine that has been registered with that machine's ADE runtime (via `projects.add`). Opening a remote project does not copy local files or move a local lane; ADE controls the remote runtime and expects normal git workflow to move code between local and remote clones.

When opening a remote project, ADE checks local projects with the same git origin. If a matching local copy has uncommitted changes, ADE shows a confirmation dialog (`RemoteProjectOpenDialog`) before switching so the user can push, stash, or keep the divergent local work intentionally.

## Connect flow

1. Add a machine from the remote machines panel or command palette. Discovered machines (LAN + Tailscale) prefill the form with the Tailscale FQDN as the primary host plus every other reachable route (LAN address, mDNS host, alt IPs) on the saved target so reconnects can fall back automatically.
2. Enter a display name, hostname, SSH user, port, and optionally a private key path. If no key path is provided, ADE uses the user's local ssh-agent when `SSH_AUTH_SOCK` is available and reads matching `HostName` / `IdentityFile` entries from `~/.ssh/config`.
3. Connect. ADE opens an SSH session (15 s keepalive, 3 strikes), detects the remote platform with `uname -sm`, and starts `ade rpc --stdio`. If the primary host is unreachable, ADE walks alternate `routes` ranked by most-recent success and records the route that wins.
4. If the bundled ADE runtime for that platform is present and the remote ADE binary is missing or stale, ADE uploads `ade-<platform-arch>` to `~/.ade/bin/ade` (or the matching channel home), uploads native dependencies to `~/.ade/runtime/<platform-arch>/`, and verifies `~/.ade/bin/ade --version`. If the desktop has no bundled binary for that arch, bootstrap probes the alternate channel homes (`.ade`, `.ade-alpha`, `.ade-beta`) for a working `ade` and uses whichever already serves a compatible RPC; the chosen home is recorded as a `compatibilityWarnings` entry so the UI explains why a non-default home was used.
5. Pick an existing remote project or register a new remote path; the desktop
   calls `projects.add { rootPath }` against the remote runtime to bind it.
   If the same window starts multiple remote opens concurrently, both preload
   and the main IPC bridge keep only the latest open as the durable binding.

After connecting, the desktop persists the active remote project to `globalState.lastRemoteProjectBinding`. When the app relaunches with no startup project path, the first window restores that binding and reconnects to the same target / project automatically.

Per-channel layout: builds with `ADE_PACKAGE_CHANNEL=alpha|beta` upload to `~/.ade-alpha/` or `~/.ade-beta/` instead of `~/.ade/` so a remote machine can host stable, beta, and alpha runtimes side by side, and they pass `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` so the channel build doesn't fight the stable login service for the socket.

## Compatibility warnings

Version skew and capability skew no longer fail the connect outright. The bootstrap performs the JSON-RPC `ade/initialize` handshake, normalizes the `capabilities.machineProjects` flags returned by the remote daemon, and reports the result as `RemoteRuntimeCapabilities` plus a `compatibilityWarnings` array on the `RemoteRuntimeConnectResult`. The renderer's remote target panel displays each warning inline under the connection chip. Warnings cover:

- Runtime version mismatch (`Remote ADE service reported X; local ADE is Y. ADE will connect because the RPC capabilities are compatible.`).
- Remote package channel mismatch (e.g. desktop is `beta`, remote runtime advertises `stable`).
- Missing `machineProjects` capabilities — `browseDirectories`, `getDetail`, `getWorkSummary`, `getDefaultParentDir`, `create`, `clone`, `listMyGitHubRepos`. These map to the `projects.*` RPCs the renderer uses for the project picker / new-project / clone flows. Missing capabilities do not block connect, but the connection pool refuses the matching call with a self-describing error when the renderer attempts it (e.g. `Remote ADE service 0.7.2 does not support cloning remote projects.`).
- The bootstrap fell back to a different ADE home (`Using remote runtime home .ade-beta because .ade did not contain an ADE service for darwin-arm64.`).

## Runtime artifact layout

Desktop distributable builds require `apps/desktop/resources/runtime/` to contain every supported `ade-<platform-arch>` binary and matching `.native.tar.gz` archive. The supported targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`.

`apps/desktop/scripts/validate-runtime-resources.mjs` is the preflight that fails the package step when artifacts are missing. Release builds populate the resource directory from the runtime-binary CI workflow's artifacts via `materialize-runtime-resources.mjs`. For local same-platform packaging, build into the resource directory directly:

```bash
npm --prefix apps/ade-cli run build:static -- --target <target> --out-dir ../desktop/resources/runtime
```

…or set `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1` to validate only the host target during local channel builds (release builds always require the full set).

`materialize-runtime-resources.mjs` searches `ADE_RUNTIME_ARTIFACTS_DIR`, then `apps/ade-cli/dist-static/`, copies any matching artifacts into the resource directory, and falls back to invoking `npm run build:static` for the host target when a missing artifact is the host build (downloading the official Node SEA helper if `ADE_STATIC_NODE_BINARY` isn't set and `ADE_RUNTIME_DISABLE_NODE_DOWNLOAD` isn't `1`).

## Standalone runtime install

For headless macOS / Linux machines that can run an SSH server but have no desktop, install the runtime directly from a release:

```bash
curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
```

`install.sh` (lives at `apps/ade-cli/scripts/install-runtime.sh`):

- detects platform / arch with `uname -sm`,
- downloads `ade-<platform-arch>` and `ade-<platform-arch>.native.tar.gz` from the release,
- installs the binary to `$ADE_INSTALL_DIR` (default `/usr/local/bin` if writable, else `~/.local/bin`),
- extracts the native modules to `~/.ade/runtime/<platform-arch>/`,
- verifies with `ade --version`,
- best-effort registers the per-user login service via `ade serve --install-service` on macOS and systemd Linux.

Environment overrides:

- `ADE_VERSION=vX.Y.Z` — pin a specific release; default `latest`.
- `ADE_INSTALL_DIR=/usr/local/bin` — destination directory.
- `ADE_RELEASE_REPO=owner/repo` — fetch from a fork.
- `ADE_HOME=/path/to/.ade` — alternate per-machine state root.

After install, the headless machine can already serve clients. Desktop ADE on a developer laptop adds it as a remote target; `ade code` works on the headless machine itself.

## What works remotely

Remote project bindings route lanes, agent chat, PTYs, terminal IO, file operations, file-watch notifications, git actions, PR actions, PR queue automation, PR AI conflict-resolution sessions, PR issue-resolution launch flows, Path to Merge orchestration, AI PR summaries, issue inventory, and event streaming through the remote runtime. Agent CLI failures (Claude / Codex / Cursor / Droid not installed or not authenticated) surface as inline `AgentCliAuthCard` cards in chat; the install / login buttons open a tracked terminal in the active runtime, so a remote project runs the install or login command on the remote machine.

Local project bindings use the local `ade serve` daemon for the same surfaces — agent chat, session history, PTYs, terminal reads/writes, file operations and watchers, diffs, lanes, PRs, PR queues, PR issue-resolution launch flows, Path to Merge, PR AI conflict-resolution sessions, issue inventory, tests, processes, project config, and most git operations. Electron main still owns desktop-only services that physically require an Electron host.

## Mobile reachability

iOS does not SSH into a machine. The phone connects to the runtime daemon's sync WebSocket advertised on the LAN or over a Tailscale tailnet. Install Tailscale on the phone and the ADE machine when they are not on the same local network.

On desktop, phone pairing and sync status are managed by the local `ade serve` daemon. The legacy in-process desktop sync host is disabled by default and can be re-enabled only for diagnostics with `ADE_ENABLE_DESKTOP_SYNC_HOST=1`.

## Troubleshooting

- `Remote target was not found` — the saved target was removed or the UI has a stale selection. Refresh the target list.
- `ADE service is not installed ... no bundled ADE service is available` — install or build `ade` on the remote, or use a release build that includes runtime resources for the remote architecture.
- `Uploaded ADE service version mismatch: expected X, got Y` — the uploaded binary did not report the expected runtime version. Rebuild the static runtime artifacts for the current desktop version.
- `Remote ADE service does not support multi-project mode` — the remote is running an older ADE before multi-project RPC. Re-bootstrap from a current desktop build.
- `Remote ADE service could not start a compatible RPC runtime. Tried ...` — every alternate ADE home (`.ade`, `.ade-alpha`, `.ade-beta`) failed to start. The error lists each home and the underlying reason. Install or rebuild `ade` on the remote machine for the desktop's target architecture.
- `Remote ADE service <version> does not support <capability>.` — the remote daemon connected but is missing a specific `machineProjects` capability the renderer just called (e.g. `cloning remote projects`). Update ADE on that machine.
- `Remote ADE service method <method> failed (code N): <message> Details: ...` — the runtime RPC client now surfaces the JSON-RPC error `code`, `message`, and `data` together so a remote handler failure (e.g. a missing project capability or a service action error) is no longer reported as a generic `Remote ADE service request failed.` string.
- `Remote ADE service connection failed: timed out waiting for method ...` — the RPC client timed out and tore the connection down deliberately so the pool can rebuild it. Retry the action; the pool will reconnect using the latest known route.
- "Tailscale CLI was not found / timed out / failed" warning under the discovered-machines list — surfaced from `discoverLanRuntimes` diagnostics. LAN (Bonjour) discovery still ran; install or unblock `tailscale` to add tailnet peers.
- Agent provider missing or unauthenticated — use the inline `AgentCliAuthCard` to install or authenticate that provider on the active runtime machine.

## Related docs

- [Internal architecture](./internal-architecture.md) — protocol shape, bootstrap sequence, sync command scoping.
- [ADE CLI](../../../apps/ade-cli/README.md) — runtime modes, service manager, machine layout.
- [ADE Code](../ade-code/README.md) — terminal client that uses the same runtime.
- [Sync and Multi-Device](../sync-and-multi-device/README.md) — phone pairing and multi-device sync (hosted by the same daemon).
