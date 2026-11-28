# Remote Runtime Internal Architecture

Local and remote runtimes answer the same JSON-RPC protocol. Each window has a
runtime binding; the renderer API stays the same and preload decides which
runtime a call goes to. User-facing behavior is in the [README](README.md).

## Runtime bindings

`OpenProjectBinding` names a window's runtime:

- `kind: "local"` — `LocalRuntimeConnectionPool`, over the machine socket
  (`~/.ade/sock/ade.sock`; a named pipe on Windows).
- `kind: "remote"` — `RemoteConnectionPool`, keyed by `{ targetId, projectId }`.

Remote opens are generation-guarded twice: preload keeps only the newest
`ade.remoteRuntime.openProject` result, and `runtimeBridge.ts` binds only the
newest in-flight open per window, so a slow earlier open cannot overwrite the
session or `lastRemoteProjectBinding`.

## Protocol shape

Runtime-level methods need no project: `ade/initialize`, `ping`, `shutdown`,
`runtime/info`, `machineInfo.get`, `projects.*`, `runtimeEvents.*`, `sync.*`.
`sync.connectToBrain`, `disconnectFromBrain` and `transferBrainToLocal` are
legacy wire names (say runtime connection and sync authority transfer).

Project operations go through `ade/actions/call` with `params.projectId`;
`createMultiProjectRpcRequestHandler` finds the scope with
`ProjectScopeRegistry.get(projectId)` and forwards to that project's handler.

`ade/initialize` advertises `runtimeInfo.multiProject`, `packageChannel` and
`capabilities`. `validateRemoteRuntimeInitializeResult` normalizes
`capabilities.machineProjects` and turns version, channel and capability skew
into `compatibilityWarnings` instead of throwing.
`RemoteConnectionPool.assertMachineProjectCapability` refuses a `projects.*`
call whose capability the remote did not advertise, before it leaves the
desktop.

### Events

- One-shot pulls use `stream_events`; live streaming uses
  `runtimeEvents.subscribe` with `runtime/event` notifications. Reads and
  subscribe acks have a 30 s deadline and one reconnect-retry.
- A window runs one pump for its active binding plus pinned pumps
  (`preload/pinnedRuntimeEvents.ts`) for other open bindings. Main keys
  subscriptions by `(sender, requestKey)` so they coexist. A remote pump's
  first subscribe is `replay: false`; preload sends `ade.runtime.events.release`
  when the last pump on a `(binding, category)` stops.
- Every response carries `eventEpoch`; a change resets cursor and dedupe.
  `gap: true` with `oldestCursor` triggers an authoritative re-read. Transient
  events (App Control frames) are never retained, so ids are not contiguous.
- Wire categories stay narrow (`orchestrator`, `dag_mutation`, `runtime`,
  `pty`); preload dispatches `runtime` events by payload `type`.

## SSH transport

`sshTransport.ts` builds an `ssh2` config from the saved target: host, port,
user; `sshKeyPath` (expanded by `sshKeyPaths.ts`, which accepts `~`, `%VAR%`,
`$env:VAR`, `$VAR` and quotes); otherwise matching `HostName` / `IdentityFile`
from `~/.ssh/config`; `SSH_AUTH_SOCK` as the agent. `readyTimeout` is
`ADE_REMOTE_SSH_CONNECT_TIMEOUT_MS` (10 s); exec probes
`ADE_REMOTE_SSH_EXEC_TIMEOUT_MS` (30 s). The runtime transport is an `exec`
channel running `daex rpc --stdio`, behind the same `RuntimeRpcTransport` the
local socket uses.

The CLI uses the system OpenSSH client: destination stays the saved hostname
(so `Host` aliases apply), alternate routes go as `-o HostName=<route>`, and
`StrictHostKeyChecking=yes` always.

### Multi-route fallback

A target has a `hostname` plus `routes` (`RemoteRuntimeTargetRoute[]`:
`hostname`, `port`, `source: "manual" | "bonjour" | "tailscale"`,
`lastSucceededAt`). `buildSshRouteCandidates` dedupes (primary first, then most
recent success); `connectSshWithRoute` walks route × username (an auth failure
tries the next username, anything else the next route);
`markRemoteTargetRouteSucceeded` remembers the winner.

### Discovery diagnostics

`discoverLanRuntimes` runs Bonjour and `tailscale status --json` in parallel.
The only diagnostic is `bonjour-discovery-failed`. Tailscale never reports a
problem; its peers only add addresses to Bonjour-found machines.

## Bootstrap sequence

`bootstrapRemoteRuntime` (`remoteBootstrap.ts`):

1. Connect over SSH; detect platform with `uname -sm`.
2. Read the channel home's `bin/ade.version`, `bin/ade.sha256` and
   `bin/ade --version`.
3. Find the bundled binary, native archive, `ptyHostWorker.cjs` and
   `agent-skills/` (or fetch a missing sidecar; see the README). With none and no
   install in the preferred home, probe the other channel homes.
4. Upload what is missing or stale (SFTP first, then bounded SSH chunks / OpenSSH):
   binary to `<layout>/bin/ade`, native deps to `<layout>/runtime/<target>/`, the
   PTY worker, agent skills, and on macOS the Mac Desktop driver (only when its
   hash changed and never re-signed, because privacy grants follow the code hash;
   a failure is a warning).
5. Verify with `<layout>/bin/ade --version`.
6. Start `daex rpc --stdio`, initialize, read `projects.list`. If the preferred
   home fails, try each other home; the preferred failure is listed first and
   each fallback line starts "Also tried". Stderr is reduced by
   `summarizeRemoteRuntimeStderr`.
7. Ask the runtime to pair this desktop (`daex sync pair-device --json-stdin`,
   never in argv) and upgrade the target to paired-first with SSH as recovery.
8. Save architecture, version, `autoConnect: true` and the winning route.

`resolveRemoteRuntimeLayout` reads `ADE_PACKAGE_CHANNEL`; stable uses `~/.ade/`,
alpha `~/.ade-alpha/`, beta `~/.ade/`. Channel builds pass
`ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` so they do not fight the stable service.

### One-time machine trust reset

`machineTrustResetMigration.ts` removed, once per install, only
`remote-machines.json`, `desktop-paired-machines.json`,
`sync-paired-devices.json` and its runtime-host grants. It writes a `.pending`
marker and commits it only after the service restart succeeds. Source builds
never run it.

## Per-session runtime routing

A session inherits its machine from its lane (`laneId`).
`renderer/lib/chatMachineRouting.ts` gives the pin for a row (null when it is on
the active binding). `components/chat/ChatRuntimeScope.tsx` derives it once per
chat pane (`useChatScopeDerivation`) and provides `useChatRuntimeScope()`;
surfaces outside a pane use `useChatRuntimeScopeForPin`. Lane rows resolve with
`useLanesForPin`, never the tab's `lanes`, because lane ids are only unique per
machine.

Preload takes the pin as an optional trailing argument
(`callPinnedOrBoundRuntimeActionOr` → `callPinnedRuntimeAction`) on chat,
session, PTY, iOS simulator, App Control, computer-use artifact and handoff
calls. `TerminalView` keeps the pin in its runtime cache key. Read caches are
keyed by binding (`boundReadCacheKey()`). `builtInBrowser.*` is the exception:
the browser lives in this desktop's main process, so a pin only localizes
loopback URLs.

The Work tools pane takes `runtimePin` from the active session and keys tools by
`workRuntimeScopeKey(pin, bound)`, so a dropdown switch to the same machine does
not remount it. Opening a session never rebinds the tab. Cross-machine slices
survive a same-repo dropdown switch (matched by git origin) and are wiped for a
different or unprovable origin.

## Sync command scoping

`ProjectScopeRegistry.ensureSyncHost` picks the sync project (see
[sync](../sync-and-multi-device/README.md#multi-project-runtimes-and-project-switching)).
A packaged desktop on an isolated no-sync runtime retries only `Sync service is
not available` / `Register a project first` through main sync IPC; remote-bound
errors never fall back to this machine.

## Paired transport & relay trust boundary

After pairing, runtime JSON-RPC rides `rpc_*` envelopes and loopback previews
ride `fwd_*` (`syncPairedChannelService.ts`). Both need `kind: "paired"` auth
**and** `runtimeHostGranted: true` on the stored pairing record (set by
same-account adoption, SSH pairing, or a Nearby PIN over a direct socket, never
over Relay). A claimed `deviceType` is not authorization; others get "Runtime
channel is only available to desktop clients". Caps: 32 RPC channels and 64
forwards per peer.

- **Forwards dial both loopbacks** (`127.0.0.1` and `::1` on one socket), since
  dev servers often listen on `[::1]` only. SSH forwards retry `::1` too.
- **A refused forward shows a page.** `SyncPortForwardClient` answers an HTTP
  request with a `502` page (`forwardFailurePage.ts`) naming the machine and port
  and reloading every 3 s.
- **Flow control.** Over 4 MiB buffered locally, the client sends `fwd_pause`;
  after draining, `fwd_resume`. It closes past 64 MiB queued or 60 s paused.
- **An oversized reply closes one channel.** Past 12 MiB unsent
  (`RPC_CHANNEL_BACKPRESSURE_BYTES`) the host closes that RPC channel with
  `rpc_over_budget` (`sync_paired.rpc_channel_over_budget`). The desktop raises
  `PairedRuntimeRpcOverBudgetError` and does not mark the machine unreachable.
- **Relay trust.** TLS ends at the relay; the operator can read RPC payloads,
  the paired secret in `hello` and the short-lived Clerk proof. DPoP proves the
  client to the host, not the host to the client. Relay hellos (and first-time
  `pairing_request`s, before the PIN check) need a Clerk token whose `sub`
  matches the host's account; bootstrap-token hellos are never accepted over
  `relay-bridge`. The proof is never persisted.
- **Provenance.** Account-created pairing records keep their Clerk owner and are
  removed on sign-out, switch or expiry; PIN and SSH records are local and
  survive. A same-owner account hello with the pinned DPoP key may rotate the
  secret so a lost `hello_ok` can be retried.

### Saved-target resolution and launch budget

The Machines panel and `daex machines connect` share `RemoteTargetRegistry`
and `DesktopPairedMachineStore`. Selecting an account machine adopts it over the
allowlisted relay and saves a `transport: "paired"` target with no SSH routes.
Only `source: "manual"` routes may fall back to SSH. `pairedRemoteConnector.ts`
and `remoteLaunchBudget.ts` bound the CLI's resolution, adoption and dials with
one budget.

## Local runtime routing

`callProjectRuntimeActionOr` and `callProjectRuntimeSyncOr` (preload) call the
bound runtime; legacy Electron IPC runs only with no binding or for desktop-only
side effects. File actions never fall back to the local filesystem once a
runtime is bound.

- **Project switch.** During `project.switchToPath` preload binds local calls to
  the new root and `runtimeBridge.ts` honors the explicit `rootPath`. During
  `remoteRuntime.openProject` the binding is cleared: writes fail with "Project
  is switching", reads wait and retry.
- **Remote reads during a switch** (`agentChat.getEventHistory`,
  `getEventHistoryPage`) return `unavailable: true` instead of asking the local
  chat service, which would answer a false "session not found" and wipe the
  transcript. `isRemoteProjectRuntimeContext()` answers synchronously from the
  live binding, an in-flight remote open, or the kind snapshotted by
  `detachProjectBindingForTransition()`.
- **Local root authorization.** `runtimeBridge.collectAuthorizedLocalRuntimeRoots`
  uses `windowTabRootAuthorization.ts` (`tabRoots` for display;
  `authorizedLocalRoots` only for projects this process opened) and
  `windowKnownLocalProjectRoots`, so a chat pinned to This computer can act from
  a remote-bound tab. A renderer-supplied path never grants access.
- **Explicit pins.** `callPinnedRuntimeAction(pin, domain, action, request)`
  routes to a caller-supplied binding and skips the transition guard; used for
  pinned work and cleanup (`lanes.delete` / `agentChat.delete` with `pin`).
- **Previews.** For remote bindings, `proxyGetPreviewInfo` runs remotely and
  `remoteRuntime.ensurePortForward` rewrites the URL to a local forward.
- **Guards.** `assertNotRemoteProjectPathAction` refuses reveal/open/image calls
  on a remote project's paths (except an SSH remote-editor open, which becomes a
  `vscode://vscode-remote/ssh-remote+…` or `zed://ssh/…` link);
  `assertLocalProjectHostAction` refuses iOS Simulator window lookups on
  remote-bound windows.

## Remote connection pool lifecycle

`RemoteConnectionPool` keeps one paired or SSH `RuntimeRpcClient` per target.

- `withEntryForTarget` is the one funnel. On a connection error it reconnects
  (re-reading the target's routes) and replays only `isReplaySafeAdeAction`
  actions (`shared/adeActionAccess.ts`) and retry-safe sync reads; writes report
  an unknown outcome. A method timeout never reconnects or replays.
- Implicit reconnects back off 30 s → 5 min with no permanent latch; Connect
  bypasses the backoff. Intent persists as `target.autoConnect`.
- `callMachineForTarget` is the machine-scoped entry (project picker, clone),
  capability-checked.
- Optional actions may have fallbacks (missing `file.refreshGitDecorations`
  returns empty and sets `statusHints.optionalActionMissing`, memoized per
  target).
- `RuntimeRpcClient.call` expires each request alone; transport close or bad
  framing is fatal and rejects all. Errors keep `method`, `code`, `message` and
  `data`.
- `runtimeBridge.ts` probes saved connections on `resume` and `unlock-screen`
  (`probeSavedConnections()`, 5 s ping).
- Long actions get their own budgets
  (`LONG_RUNNING_REMOTE_RUNTIME_ACTION_TIMEOUTS` in `remoteConnectionPool.ts`;
  local: `localRuntimeTimeoutPolicy.ts`).

## Per-target action registry

`ade.actions.listRegistry` asks the bound runtime (`list_ade_actions` via
`RemoteConnectionPool.listActionRegistryForTarget`, or the local runtime); the
in-process registry is used only with no binding.

## Local runtime connection lifecycle

`LocalRuntimeConnectionPool`:

- Connects to the primary socket, or spawns `daex serve --socket <path>`.
- Compares `runtimeInfo.version`, `buildHash` and `defaultRole` after
  `initialize`. An incompatible primary brain is left alone and the desktop uses
  an isolated socket (`i-<key>.sock`, `isolatedRuntimeSocketPath`).
- Registers each project once (`projects.add`) and carries `projectId` on every
  call (`callActionForRoot`, `callSyncForRoot`, `streamEventsForRoot`,
  `subscribeEventsForRoot`). Timeouts reject only that caller.
- Logs `local_runtime.action_slow` for calls over 500 ms with the time spent in
  `ensureProject`, `connect` and the RPC.

Service install, repair and handover are in the README's
[local brain section](README.md#source-file-map).
