# Remote Runtime Internal Architecture

Remote runtime support is built on the same JSON-RPC runtime used by the local
daemon. The desktop chooses a runtime binding for each window; renderer APIs stay
stable while preload decides whether to call the local runtime daemon or a remote
SSH-backed runtime.

## Runtime bindings

`OpenProjectBinding` records the active runtime for a window:

- `kind: "local"` - actions go through `LocalRuntimeConnectionPool`.
- `kind: "remote"` - actions go through `RemoteConnectionPool` with
  `{ targetId, projectId }`.

The binding is established when a project is opened. Local bindings are created
from the current desktop project. Remote bindings are created by
`remoteRuntimeOpenProject` after the selected target is connected and the remote
project record is confirmed.

## Protocol shape

Runtime-level methods do not require a project:

- `initialize`
- `projects.list`
- `projects.add`
- `projects.remove`
- `projects.touch`
- `sync.getStatus`
- `sync.refreshDiscovery`
- `sync.listDevices`
- `sync.updateLocalDevice`
- `sync.forgetDevice`
- `sync.getPin`
- `sync.setPin`
- `sync.clearPin`

Project-scoped operations are routed through `ade/actions/call` and carry
`projectId` in the request payload. The ade-cli multi-project RPC handler looks
up the per-project service scope before executing the requested action.

Runtime event streaming uses the same route with `name: "stream_events"`. For
remote bindings the desktop reconnects the target before polling events,
matching normal remote action behavior after SSH or RPC disconnects. For local
bindings, preload polls the local daemon through `localRuntimeStreamEvents`, so
daemon-owned chat, terminal, pty, lane, file-watch, process, and test events are
delivered through the same renderer fanout used by remote projects.

## SSH transport

`sshTransport.ts` creates an `ssh2` client config from the saved target:

- host, port, and username come from the remote target registry.
- `sshKeyPath` loads a private key from disk when supplied.
- if no explicit key path is saved, matching `HostName` and `IdentityFile`
  entries in `~/.ssh/config` are applied so aliases like `Host studio` work.
- `SSH_AUTH_SOCK` is passed through as `agent` when available.

The runtime transport is an SSH `exec` channel running `ade rpc --stdio`. The
channel implements the `RuntimeRpcTransport` interface used by
`RuntimeRpcClient`.

## Bootstrap sequence

`bootstrapRemoteRuntime` performs first-connect setup:

1. Connect over SSH.
2. Detect platform and architecture with `uname -sm`.
3. Read `~/.ade/bin/ade.version` and `~/.ade/bin/ade --version` when present.
4. Locate the bundled `ade-<platform-arch>` binary and native dependency archive
   in desktop resources.
5. Upload stale or missing runtime files to `~/.ade/bin` and `~/.ade/runtime`.
6. Verify the uploaded runtime by running `~/.ade/bin/ade --version`.
7. Start `ade rpc --stdio`, initialize the JSON-RPC client, and read
   `projects.list`.
8. Update the target registry with architecture, runtime version, and last
   connected timestamp.

If no bundled runtime exists and the remote does not already expose `ade`,
bootstrap fails with an explicit install/build error instead of assuming the
desktop version.

## Local-vs-remote work warning

Before opening a remote project, `remoteRuntimeCheckLocalWork` compares the
remote project's git origin with local projects. It checks both recent desktop
projects and projects known to the local runtime daemon, then runs
`git status --porcelain` on matches. Dirty matches produce the confirmation
dialog in the remote target UI.

## Sync command scoping

The sync WebSocket host is owned by the `ade serve` daemon in normal desktop
operation. Desktop sync Settings IPC first talks to the local runtime daemon for
status, discovery, device registry, and PIN operations, then falls back to the
legacy in-process sync service only when the daemon route is unavailable. The
old desktop-host path is guarded by `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for
diagnostics and migration debugging.

The sync command registry now labels descriptors as `runtime` or `project`
scope. Project-bound hosts reject project-scoped commands that arrive without a
matching `projectId`, while runtime-scoped commands can operate without a
project binding. This keeps mobile/controller commands explicit as ADE moves to
a multi-project runtime.

## Local daemon routing

Local desktop windows now use the runtime binding before calling legacy
Electron-hosted handlers for the core project loop:

- agent chat actions and chat event history
- terminal session list/detail/update/delete and transcript tails
- pty create/write/resize/dispose plus streamed data/exit events
- file reads/writes/search/quick-open/tree listing and file-watch subscriptions
- diff reads and most git operations
- lanes, PRs, PR queue automation, PR issue-resolution launch flows, Path to
  Merge, PR AI conflict-resolution sessions, issue inventory, tests, processes,
  and project config

Operations with desktop-only side effects, such as some automation hooks and
UI-native flows, still use the in-process IPC handlers until their side effects
are moved into ade-cli services.
