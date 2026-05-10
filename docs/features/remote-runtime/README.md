# Remote Runtime

ADE can connect the desktop UI to an ADE runtime on another machine over SSH.
The remote project lives on that machine; lanes, PTYs, git operations, agent
chat, and PR actions run there. The local desktop remains the controller.

## Source file map

- `apps/desktop/src/main/services/remoteRuntime/` - SSH transport, runtime
  bootstrap, target registry, and remote connection pool.
- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` -
  local daemon connection used by desktop IPC, event streaming, sync Settings,
  and local-work checks.
- `apps/desktop/src/renderer/components/remoteTargets/` - remote machine form,
  target list, project picker, and local-dirty-work warning.
- `apps/desktop/src/preload/preload.ts` - routes runtime-backed renderer APIs to
  local or remote JSON-RPC actions based on the active project binding.
- `apps/ade-cli/src/multiProjectRpcServer.ts` - runtime-level project catalog
  and sync methods plus project-scoped action dispatch.
- `apps/ade-cli/src/services/projects/` - machine project registry and
  per-project service scope cache.

## User model

A remote target is a machine reachable by SSH. A remote project is a path on
that machine. Opening a remote project does not copy local files or move a
local lane; ADE controls the remote runtime and expects normal git workflow to
move code between local and remote clones.

When opening a remote project, ADE checks local projects with the same git
origin. If a matching local copy has uncommitted changes, ADE shows a warning
before switching so the user can push, stash, or keep the divergent local work
intentionally.

## Connect flow

1. Add a machine from the remote machines panel or command palette.
2. Enter a display name, hostname, SSH user, port, and optionally a private key
   path. If no key path is provided, ADE uses the user's local ssh-agent when
   `SSH_AUTH_SOCK` is available and reads matching `HostName` / `IdentityFile`
   entries from `~/.ssh/config`.
3. Connect. ADE opens an SSH session, detects the remote platform with
   `uname -sm`, and starts `ade rpc --stdio`.
4. If the bundled ADE service for that platform is present and the remote ADE
   service is missing or stale, ADE uploads it to `~/.ade/bin/ade`, uploads native
   dependencies to `~/.ade/runtime/<platform-arch>/`, and verifies
   `~/.ade/bin/ade --version`.
5. Pick an existing remote project or register a new remote path.

Desktop distributable builds require `apps/desktop/resources/runtime/` to
contain every remote ADE service binary and matching native dependency archive.
The `validate:runtime-resources` preflight fails fast when those artifacts are
missing. Release builds populate the resource directory from workflow artifacts;
for local same-platform packaging, build into the resource directory with
`npm --prefix apps/ade-cli run build:static -- --target <target> --out-dir ../desktop/resources/runtime`.

## Standalone runtime install

Release artifacts include an `install.sh` helper for headless macOS/Linux
machines:

```bash
curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
```

Set `ADE_VERSION=vX.Y.Z` to install a specific release, `ADE_INSTALL_DIR` to
override the destination directory, or `ADE_RELEASE_REPO=owner/repo` for forks.
The script downloads the matching `ade-<platform>-<arch>` binary and native
dependency archive, installs `ade`, extracts native dependencies under
`~/.ade/runtime/<platform-arch>/`, and best-effort registers the per-user
runtime service.

## What works remotely

Remote project bindings route lanes, agent chat, PTYs, terminal IO, file
operations, file-watch notifications, git actions, PR actions, PR queue
automation, PR AI conflict-resolution sessions, PR issue-resolution launch
flows, Path to Merge orchestration, AI PR summaries, issue inventory, and event
streaming through the remote runtime. Agent CLI failures are surfaced as inline
install/authentication cards; the buttons open a tracked terminal in the active
runtime, so a remote project runs the install or login command on the remote
machine.

Local project bindings also prefer the local `ade serve` daemon for agent chat,
session history, PTYs, terminal reads/writes, file operations and watchers,
diffs, lanes, PRs, PR queues, PR issue-resolution launch flows, Path to Merge,
PR AI conflict-resolution sessions, issue inventory, tests, processes, project
config, and most git operations. The legacy Electron-hosted services remain as a
fallback while the remaining IPC surface is migrated.

Memory and embedding features are disabled for remote runtimes in v1. The
remote static runtime does not bundle `onnxruntime-node`.

## Mobile reachability

iOS does not SSH into a machine. The phone connects to an ADE machine over the
sync WebSocket advertised on the LAN or over a Tailscale tailnet. Install
Tailscale on the phone and the ADE machine when they are not on the same local
network.

On desktop, phone pairing and sync status are managed through the local
`ade serve` daemon. The legacy in-process desktop sync host is disabled by
default and can be re-enabled only for diagnostics with
`ADE_ENABLE_DESKTOP_SYNC_HOST=1`.

## Troubleshooting

- `Remote target was not found` - the saved target was removed or the UI has a
  stale selection. Refresh the target list.
- `ADE service is not installed ... no bundled ADE service is available` - build
  or install `ade` on the remote, or use a release build that includes runtime
  resources for the remote architecture.
- `Uploaded ADE service version mismatch` - the uploaded binary did not report
  the desktop app version. Rebuild the static runtime artifacts for the current
  version.
- Agent provider missing or unauthenticated - use the inline card to install or
  authenticate that provider on the active runtime machine.
