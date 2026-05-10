# Remote Runtime

The desktop app connects to an `ade serve` daemon running on a remote machine over SSH. The remote project lives on that machine; lanes, PTYs, git, agent chat, and PR actions all run there. The local desktop is the controller — it spawns no project services of its own for a remote binding.

The wire transport is the same JSON-RPC the local daemon answers. The remote-runtime layer just wraps it in an SSH `exec` channel running `ade rpc --stdio`.

## Source file map

- `apps/desktop/src/main/services/remoteRuntime/` — SSH transport, runtime
  bootstrap, target registry, runtime RPC client, remote connection pool.
- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` —
  the local daemon connection used by desktop IPC, event streaming, sync
  Settings, and local-work checks. Spawns `ade serve` if the machine socket is
  not listening; tracks the per-user login service install/health state.
- `apps/desktop/src/renderer/components/remoteTargets/` — remote machine form,
  target list, project picker, dirty-local-work warning.
- `apps/desktop/src/renderer/components/projects/RemoteProjectOpenDialog.tsx` —
  confirmation dialog before opening a remote project, surfaces local matches
  with uncommitted changes.
- `apps/desktop/src/preload/preload.ts` — routes runtime-backed renderer APIs to
  local or remote JSON-RPC actions based on the active project binding.
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

1. Add a machine from the remote machines panel or command palette.
2. Enter a display name, hostname, SSH user, port, and optionally a private key path. If no key path is provided, ADE uses the user's local ssh-agent when `SSH_AUTH_SOCK` is available and reads matching `HostName` / `IdentityFile` entries from `~/.ssh/config`.
3. Connect. ADE opens an SSH session, detects the remote platform with `uname -sm`, and starts `ade rpc --stdio`.
4. If the bundled ADE runtime for that platform is present and the remote ADE binary is missing or stale, ADE uploads `ade-<platform-arch>` to `~/.ade/bin/ade`, uploads native dependencies to `~/.ade/runtime/<platform-arch>/`, and verifies `~/.ade/bin/ade --version`.
5. Pick an existing remote project or register a new remote path; the desktop calls `projects.add { rootPath }` against the remote runtime to bind it.

Per-channel layout: builds with `ADE_PACKAGE_CHANNEL=alpha|beta` upload to `~/.ade-alpha/` or `~/.ade-beta/` instead of `~/.ade/` so a remote machine can host stable, beta, and alpha runtimes side by side, and they pass `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` so the channel build doesn't fight the stable login service for the socket.

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

Local project bindings prefer the local `ade serve` daemon for the same surfaces — agent chat, session history, PTYs, terminal reads/writes, file operations and watchers, diffs, lanes, PRs, PR queues, PR issue-resolution launch flows, Path to Merge, PR AI conflict-resolution sessions, issue inventory, tests, processes, project config, and most git operations. The legacy in-process Electron services remain only as a guarded fallback while the last IPC surfaces are migrated.

Memory and embedding features are disabled for remote runtimes in v1. The static remote runtime does not bundle `onnxruntime-node`.

## Mobile reachability

iOS does not SSH into a machine. The phone connects to the runtime daemon's sync WebSocket advertised on the LAN or over a Tailscale tailnet. Install Tailscale on the phone and the ADE machine when they are not on the same local network.

On desktop, phone pairing and sync status are managed by the local `ade serve` daemon. The legacy in-process desktop sync host is disabled by default and can be re-enabled only for diagnostics with `ADE_ENABLE_DESKTOP_SYNC_HOST=1`.

## Troubleshooting

- `Remote target was not found` — the saved target was removed or the UI has a stale selection. Refresh the target list.
- `ADE service is not installed ... no bundled ADE service is available` — install or build `ade` on the remote, or use a release build that includes runtime resources for the remote architecture.
- `Uploaded ADE service version mismatch: expected X, got Y` — the uploaded binary did not report the expected runtime version. Rebuild the static runtime artifacts for the current desktop version.
- `Remote ADE service does not support multi-project mode` — the remote is running an older ADE before multi-project RPC. Re-bootstrap from a current desktop build.
- Agent provider missing or unauthenticated — use the inline `AgentCliAuthCard` to install or authenticate that provider on the active runtime machine.

## Related docs

- [Internal architecture](./internal-architecture.md) — protocol shape, bootstrap sequence, sync command scoping.
- [ADE CLI](../../../apps/ade-cli/README.md) — runtime modes, service manager, machine layout.
- [ADE Code](../ade-code/README.md) — terminal client that uses the same runtime.
- [Sync](../sync/README.md) — phone pairing and multi-device sync (hosted by the same daemon).
