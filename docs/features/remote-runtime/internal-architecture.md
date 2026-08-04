# Remote Runtime Internal Architecture

Remote runtime support is built on the same JSON-RPC runtime the local ADE runtime answers. The desktop chooses a runtime binding for each window; the renderer APIs stay stable while preload decides whether to call the local machine runtime or a remote SSH-backed runtime. Both bindings speak the same wire protocol.

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

The `connectToBrain`, `disconnectFromBrain`, and `transferBrainToLocal`
method names are legacy wire identifiers. New documentation should use
runtime connection, runtime disconnection, and sync authority transfer.

Project-scoped operations are routed through `ade/actions/call` and carry `params.projectId`. The ade-cli multi-project RPC handler (`createMultiProjectRpcRequestHandler`) looks up the per-project service scope via `ProjectScopeRegistry.get(projectId)` and forwards the request to the cached single-project handler created from `createAdeRpcRequestHandler({ runtime, … })`.

`ade/initialize` advertises `runtimeInfo.multiProject: true`, `runtimeInfo.packageChannel` (when set on the daemon environment), and `capabilities.projects: true`. Clients use the multi-project flag to decide whether to send `projectId` per request (multi-project runtime) or treat the runtime as already bound to one project (embedded `ade code --embedded`). `validateRemoteRuntimeInitializeResult` enforces both top-level capabilities, normalizes the per-method `capabilities.machineProjects` flags (`browseDirectories`, `getDetail`, `getWorkSummary`, `getDefaultParentDir`, `create`, `clone`, `listMyGitHubRepos`), and turns version mismatch / channel mismatch / missing capabilities into a `RemoteRuntimeInitializeInfo.compatibilityWarnings` array instead of throwing. Those warnings flow back to `bootstrapRemoteRuntime`, are returned on `RemoteRuntimeConnectResult.compatibilityWarnings`, and are surfaced inline under the remote target's connection chip.

`RemoteRuntimeCapabilities` (in `apps/desktop/src/shared/types/remoteRuntime.ts`) is the structured shape both the connect result and the connection status carry. `RemoteConnectionPool.assertMachineProjectCapability` maps `projects.*` RPC method names to the matching capability flag and rejects the call with a self-describing message before it leaves the desktop when the remote did not advertise that capability — the connection stays open for everything else.

Runtime event streaming uses `ade/actions/call` with `name: "stream_events"` for one-shot pulls, and `runtimeEvents.subscribe` (with `runtime/event` notifications) for live streaming. For remote bindings the desktop reconnects the SSH transport before re-subscribing, matching normal remote action behavior after disconnects. The initial remote subscription starts with `replay: false` when the cursor is still zero, so opening a remote project does not flood the renderer with buffered history before live events arrive; catch-up polls still use a short delay while idle remote polls back off. For local bindings, preload polls the local runtime through `localRuntimeStreamEvents` so runtime-owned chat, terminal, pty, lane, file-watch, process, and test events are delivered through the same renderer fanout used by remote projects.

A window runs one pump for its active binding (`preload.ts`) plus, for every binding it has open but is not bound to, the pinned pumps in `preload/pinnedRuntimeEvents.ts` — one shared PTY pump per pinned binding and one generic pump per pinned chat/project listener. Main keys its subscriptions by `(sender, requestKey)` so those pumps coexist instead of evicting each other (see [ARCHITECTURE §5.4](../../ARCHITECTURE.md#54-event-subscriptions-push-not-poll)), and preload sends `ade.runtime.events.release` when the last pump on a `(binding, category)` stops reading, so a switched-away binding stops streaming immediately rather than at idle expiry.

Each `stream_events` response carries a per-runtime `eventEpoch` UUID minted when the daemon's `eventBuffer` is constructed. The pump compares it against the last seen epoch for its binding; if it changes (daemon restart, ssh reconnect to a fresh process) the cursor and dedup set reset and the next poll starts from `cursor=0`. Responses can also include `gap: true` with `oldestCursor` when the requested cursor is older than the bounded replay buffer; preload clears the dedupe set and notifies the project-binding refresh callbacks so renderer projections re-hydrate from authoritative reads instead of assuming no events were missed. The `startedAtMs` "drop events older than the pump start" filter is only applied to **local** bindings — remote pumps rely on the epoch reset instead, so older events backfilled after a reconnect are still delivered.

The remote event buffer categories are intentionally narrow: `orchestrator`, `dag_mutation`, `runtime`, and `pty`. Preload dispatches `runtime` events by their payload `type` so domain-specific updates such as agent chat, terminal, lane, PR, file-watch, process, test, project-state, usage, automation, conflict, GitHub, Linear, feedback, Computer Use, iOS Simulator, and App Control changes still reach their dedicated remote subscribers without expanding the wire-level category enum. ade-cli wires these source-tagged payloads into the runtime event buffer in `bootstrap.ts` so a remote-bound window sees the same event fanout as the local host. Headless runtimes start `usageTrackingService` during `createAdeRuntime()` after the ADE action registry is bound, so the usage poller and threshold events run only once the runtime can answer the matching usage/budget actions.

## SSH transport

`sshTransport.ts` creates an `ssh2` client config from the saved target:

- host, port, and username come from the remote target registry.
- `sshKeyPath` loads a private key from disk when supplied.
- if no explicit key path is saved, matching `HostName` and `IdentityFile` entries in `~/.ssh/config` are applied so aliases like `Host studio` work.
- `SSH_AUTH_SOCK` is passed through as `agent` when available.
- every config carries a bounded `readyTimeout` (`ADE_REMOTE_SSH_CONNECT_TIMEOUT_MS`, default 10 s) and disables SSH-level keepalives; runtime RPC calls, exec probes, and artifact uploads carry their own timeouts so large channel writes are not interrupted by transport probes.

The runtime transport itself is an SSH `exec` channel running `ade rpc --stdio` (with the channel-aware environment prefix from `buildRemoteRuntimeEnvironmentPrefix`). The channel implements the `RuntimeRpcTransport` interface used by `RuntimeRpcClient`, the same client `LocalRuntimeConnectionPool` uses against a Unix socket.

Short SSH exec probes use `ADE_REMOTE_SSH_EXEC_TIMEOUT_MS` (default 30 s). Connect failures are normalized before surfacing to the renderer so handshake timeouts, connection resets before ready, and local TCP port exhaustion have actionable messages.

`ade code remote` uses the system OpenSSH client rather than the desktop's
`ssh2` transport, but preserves the same config identity. The destination stays
the saved target hostname (and therefore remains the `Host` pattern selector in
`~/.ssh/config`); alternate LAN/tailnet addresses are supplied with
`-o HostName=<route>`. This keeps alias-scoped `User`, `IdentityFile`, agent,
`ProxyJump`/`ProxyCommand`, and other OpenSSH settings active while dialing a
concrete address. The CLI also passes `StrictHostKeyChecking=yes`; route fallback
never relaxes host-key verification.

### Multi-route fallback

A remote target stores a primary `hostname` plus an optional `routes` array (`RemoteRuntimeTargetRoute[]`). Each route has `{ hostname, port, source: "manual" | "bonjour" | "tailscale", lastSucceededAt }`. Discovery captures every reachable address advertised by a peer (Tailscale FQDN, mDNS host, raw IPv4/IPv6 entries) and `RemoteTargetForm` persists them alongside the manual host on save.

`buildSshRouteCandidates` flattens routes (deduped by `hostname:port`, primary always first) and sorts later attempts by most-recent `lastSucceededAt`. `connectSshWithRoute` walks the route × username matrix: an authentication failure tries the next username for the same route, any other failure skips remaining usernames and advances to the next route. On success, `bootstrapRemoteRuntime` calls `markRemoteTargetRouteSucceeded` so the registry remembers which route worked — a target that moved between LAN and Tailscale auto-prefers whichever one reconnected last.

### Discovery diagnostics

`discoverLanRuntimes` runs Bonjour and `tailscale status --json` in parallel and now returns a `RemoteRuntimeDiscoveryResult` with `{ machines, diagnostics }`. Each diagnostic carries `{ source: "bonjour" | "tailscale", severity, code, message, detail }`. Codes today: `bonjour-discovery-failed`, `tailscale-unavailable` (CLI not installed), `tailscale-timeout`, `tailscale-status-failed`. `severity` is `"warning"` when discovery is degraded in a way the user may want to look at, and `"info"` for a normal, non-actionable observation about the environment. `tailscale-unavailable` is `info` — Tailscale is optional software, so not having it installed is a fact about the machine rather than a problem with discovery — while the timeout and failure codes stay `warning`. The form surfaces warnings inline so a hung or broken Tailscale CLI does not look like "no machines found" (the LAN side still ran), and renders info diagnostics as muted secondary text with no warning glyph.

## Bootstrap sequence

`bootstrapRemoteRuntime` performs first-connect setup:

1. Connect over SSH.
2. Detect platform and architecture with `uname -sm` (`normalizeRemoteArch` accepts darwin/linux × arm64/x64).
3. Read the preferred channel home's `bin/ade.version`, `bin/ade.sha256`, and `bin/ade --version` when present.
4. Locate the bundled `ade-<platform-arch>` binary, `ade-<platform-arch>.native.tar.gz` archive, packaged `ptyHostWorker.cjs`, and bundled `agent-skills/` root in desktop resources.
5. If the desktop has no bundled binary for that arch and no executable was found in the preferred home, probe the alternate channel homes (`~/.ade`, `~/.ade-alpha`, `~/.ade-beta`) for a working `ade --version`. The first home that responds is adopted as the active layout and the reason is captured for the connection's `compatibilityWarnings` (`Using remote runtime home <home> because <preferred> did not contain an ADE service for <arch>`).
6. If the local bundle is present and the selected installed version or SHA does not match the desktop bundle, upload the binary to `<layout>/bin/ade` (mode 700 dir, +x file, write `<layout>/bin/ade.version` and `<layout>/bin/ade.sha256`). Uploads prefer SFTP; when that cannot start safely, ADE writes bounded SSH chunks and can fall back to OpenSSH for chunks that did not enter the existing channel.
7. If the native deps archive is present and either the runtime was just uploaded or the remote `<layout>/runtime/<arch>/.ade-version` doesn't match, upload and extract it to `<layout>/runtime/<platform-arch>/`.
8. If the PTY host worker is available locally and the remote worker hash is missing or stale, upload it to `<layout>/runtime/ptyHostWorker.cjs` with a sidecar `.sha256`. When the remote has `node`, the runtime environment points `ADE_PTY_HOST_WORKER_PATH` and `ADE_PTY_HOST_WORKER_NODE` at that worker; otherwise it points `ADE_PTY_HOST_WORKER_COMMAND` at the uploaded `ade` binary so the static runtime can run the internal worker entry.
9. Verify the uploaded runtime by running `<layout>/bin/ade --version` with the channel/arch/worker environment prefix; abort with `Uploaded ADE service version mismatch` if the reported version doesn't match.
10. If bundled ADE agent skills are available locally, hash the directory and upload it to `<layout>/agent-skills` when `<layout>/agent-skills.sha256` is missing or stale. The remote CLI resolves that root from its own binary path and re-seeds ADE-managed skills into runtime-native home skill directories on launch.
11. Start `ade rpc --stdio`, initialize the JSON-RPC client, normalize capabilities and version through `validateRemoteRuntimeInitializeResult`, and read `projects.list`. Version skew, channel skew, and missing capabilities become `compatibilityWarnings` rather than throws.
12. If the preferred runtime fails validated initialize, walk the alternate channel homes again with `ade rpc --stdio` against each candidate even when this connection just uploaded a packaged Beta binary. The first home that completes initialize and capability negotiation wins; failed candidates are collected with their launch, initialization, or capability-negotiation phase so the final error remains actionable. If a fallback wins, the chosen home and environment prefix are retained for every follow-up command and recorded as a compatibility warning.
13. After SSH RPC and `projects.list` succeed, send a versioned device identity and DPoP public key to that selected runtime with `ade sync pair-device --json-stdin`. The request is bounded and never placed in argv. A valid response stores the paired secret and local DPoP private key, then upgrades the saved target to paired-first while retaining SSH as recovery. This step is best-effort for older compatible runtimes.
14. Update the target registry with architecture, runtime version (preferring the value the daemon reported through `initialize`), last-connected timestamp, explicit `autoConnect: true`, and a refreshed `routes` array marking the successful route's `lastSucceededAt`.

If no bundled runtime exists locally and no channel home on the remote can start a compatible RPC, bootstrap fails with an explicit install/build error rather than silently shipping the wrong version.

Channel layout: `resolveRemoteRuntimeLayout` reads `ADE_PACKAGE_CHANNEL` for the preferred home; `resolveRemoteRuntimeLayoutCandidates` enumerates that preferred home plus the stable / alpha / beta layouts (deduped by `homeDirName`) for the fallback walk. Stable uploads to `~/.ade/`; alpha to `~/.ade-alpha/`; beta to `~/.ade-beta/`. Runtime binaries, native deps, PTY worker artifacts, and bundled ADE agent skills all stay inside the selected home. Channel builds also pass `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1` in the environment prefix so the channel binary doesn't fight a stable login service for the socket.

### One-time machine trust reset

On the first packaged launch carrying this migration,
`machineTrustResetMigration.ts` removes only the channel-local saved target and
pairing grant files: `remote-machines.json`, `desktop-paired-machines.json`,
`sync-paired-devices.json`, and
`sync-paired-devices.json.runtime-host-grants`. It deliberately preserves the
account credential store, stable machine/device identity, sync PIN, bootstrap
token, project registry/state, and SSH files. The migration first writes
`.machine-trust-reset-v1.pending`; `main.ts` forces the background runtime
service to restart and atomically renames that marker to
`.machine-trust-reset-v1` only after installation/restart reports success. If
ADE exits before confirmation, the next launch retries the restart without
clearing any new pairings a second time. Source/dev launches never run it.

SSH bootstrap and direct LAN/tailnet paired reconnect do not read account
status or an account token. Before a relay candidate is opened, the desktop
requests a current Clerk access token in memory and adds it only to that paired
hello. The host verifies the token subject against its currently signed-in
owner; missing, expired, or different-user proof returns
`relay_account_required`. The token is never written to the remote target or
paired credential store. A changed SSH host key must pass the explicit trust
flow again. A paired
`hello_ok` whose authoritative host device identity differs from the stored
identity fails closed and requires re-pairing rather than rewriting the saved
identity.

## Cross-machine divergence

Opening a project on another machine is not gated by a confirmation. The git-origin comparison that used to power one now feeds tab grouping (`projectTabGrouping.ts`), and the risk it was really guarding against — two machines pushing the same branch from different commits — is caught at push time by `shared/laneDivergence.ts`.

`detectPushDivergence` runs at click time on the push button, from lane state the renderer already holds (`LaneSummary.branchRef` + `LaneStatus.ahead/behind`, unioned across machines by `renderer/state/crossMachineLanes.ts`). No lane record in ADE carries a head sha, so the rule is grounded in `ahead` instead: another machine holding the same branch with unpushed commits would have them stranded when the upstream tip moves. Head shas are used only to silence the guard when two machines are proven to sit on the same commit — an unknown head never suppresses a warning, because the false-negative direction on a destructive push is the expensive one. Machine identity is compared by id (`shared/machineIdentity.ts`), never by name, so the guard cannot mistake This computer for another machine.

## Per-session runtime routing

A lane owns its machine; a session — chat, CLI, or shell — inherits its machine from its lane through `laneId`. Because the Work sidebar is a union across every open machine, the user can click a row whose lane lives on a machine this window's project tab is not bound to. `renderer/lib/chatMachineRouting.ts` derives the `OpenProjectBinding` that row's calls must target and returns `null` when it already lives on the active binding. Two routers are built on it from the same shared constructors: `AgentChatPane` for chats, and `components/terminals/useWorkMachineRouter.ts` for the Work tab's CLI/shell rows, which falls back to the remembered launch pin when a row's lane is not in the index.

Preload consumes that as an optional trailing pin on chat/session APIs and on the PTY/terminal surface (`callPinnedOrBoundRuntimeActionOr`): with a pin the call goes to the pinned runtime through `callPinnedRuntimeAction`; without one it takes the unchanged bound path and its IPC fallback. Foreign PTY output arrives through the pinned PTY pump described above, and `TerminalView` keeps the pin on the cached runtime (it is part of the runtime cache key) so two parked terminals from different machines cannot borrow the same route.

The tab's binding is never rewritten by opening a session — rebinding would move Lanes, PRs, Files, Git, and Run with it. The one exception is a row whose owning binding this window does not have open: there is nothing to pin to, so the tab switches. Switching the tab's machine otherwise stays an explicit action (the tab's machine menu, or clicking a foreign *lane*).

## Sync command scoping

The sync WebSocket service is owned by the `ade serve` runtime in normal desktop operation. `ProjectScopeRegistry.ensureSyncHost` selects the most-recently-opened registered project as the active sync project and refreshes that selection when projects are added or removed.

Desktop Connections controls first talk to the active runtime for status,
discovery, device registry, and PIN operations. Local project windows use
`LocalRuntimeConnectionPool`; remote project windows use
`RemoteConnectionPool`. The old desktop-host path is guarded by
`ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics and migration debugging.

When a packaged desktop is temporarily attached to an isolated local
project-capable runtime whose sync service is disabled, preload recognizes only
the specific `Sync service is not available` / `Register a project first`
errors and retries machine-level Mobile/Web status and controls through the
main sync IPC. Remote-bound errors never take this local fallback, so a failed
remote sync call cannot accidentally operate on the desktop's machine brain.

The sync command registry labels descriptors as `runtime` or `project` scope. Project-bound runtimes reject project-scoped commands that arrive without a matching `projectId`, while runtime-scoped commands operate on the ADE runtime as a whole. This keeps mobile/controller commands explicit in the multi-project runtime.

## Paired transport & relay trust boundary

Besides SSH, a remote target can use the **paired** transport: after PIN + DPoP
pairing, the full runtime JSON-RPC rides the sync WebSocket as newline-delimited
frames inside `rpc_*` envelopes, and loopback TCP previews ride `fwd_*`
envelopes (host-side connect restricted to `127.0.0.1`). Both are gated to
desktop runtime-host peers: the host only opens the RPC channel / port-forward
for a peer that authenticated with `kind: "paired"` **and** whose authoritative
stored pairing record has `runtimeHostGranted: true`. The Share Machine link
carries a short-lived, one-time server grant that is consumed only after the
PIN succeeds. Nearby desktop pairing over a direct LAN/tailnet socket may set
the same stored capability after a correct PIN; the host never applies that
exception to a Relay socket. The device type claimed in `hello.peer` is metadata, not
authorization: a paired phone or browser that reconnects while claiming
`deviceType: "desktop"` still stays on the mobile
command allowlist. If it sends `rpc_open`/`fwd_open`, the host closes the channel
with "Runtime channel is only available to desktop clients", and `hello_ok`
advertises `features.rpcChannel`/`features.portForward` as `false`. The host also
caps concurrent channels per peer (32 RPC channels, 64 forwards) so an
authenticated peer cannot exhaust file descriptors or memory.

**Relay trust boundary.** The sync WebSocket can reach the host over a direct
LAN/tailnet route or through the cloud tunnel-relay. The relay is a plaintext
byte pipe: TLS terminates *at* the relay and there is no end-to-end encryption
between the two ADE machines. Over a relay route the relay operator can read all
runtime RPC payloads and the paired `secret` that transits in the `hello`.
Direct LAN/tailnet routes do not transit the relay and are not exposed to it.
DPoP proves to the host that the connecting client possesses the private key
registered for that paired device; it protects the host from replay with only a
stolen paired secret. It does not authenticate the host to the client or prevent
a relay operator from impersonating the host. Treat relay routes as
trusted-operator paths, not confidential channels.

Relay authorization is enforced again at the host, not only in route selection:
every `kind: "paired"` hello arriving through the process-private
`relay-bridge` origin must include a short-lived Clerk access token whose `sub`
matches the host's current account. Direct LAN/tailnet paired hellos do not carry
or require this proof. First-time `pairing_request` messages over the relay use
the same proof before the host checks the PIN, so account failures do not enter
the PIN brute-force budget. Legacy `kind: "bootstrap"` hello messages are never
accepted over `relay-bridge`. The relay proof is intentionally not persisted.
The host also omits its relay candidate and stops the tunnel control connection
while signed out, then resumes it when a current account session returns. Because
the current tunnel is not end-to-end encrypted, the trusted relay operator can
also read this short-lived bearer; eliminating that exposure requires an
infrastructure-level opaque relay attestation or end-to-end encrypted tunnel.

Account-created host pairing records persist their Clerk owner id. The host
periodically refreshes its own account token as a short lease: sign-out, account
switch, expiry, or refresh failure removes records owned by the old account and
closes both those peers and every active Relay peer. PIN and local SSH pairing
write explicit local provenance, so they can declassify a same-device account
record and survive account changes. Older records without provenance are
treated as local for backward compatibility. A verified same-owner account
hello with the already-pinned DPoP key may rotate and return a fresh paired
secret; this makes credential delivery retryable when the previous `hello_ok`
was lost without allowing a different account or key to take over the record.

### ADE Code saved-target resolution and launch budget

The desktop Machines panel and `ade code remote` share
`RemoteTargetRegistry` plus `DesktopPairedMachineStore`. Selecting an account
directory machine asks `AccountMachineDirectoryService` to perform account
adoption over the exact allowlisted WSS relay, persist the resulting paired
secret and DPoP reference, and save a `transport: "paired"` target with no SSH
fallback routes. Subsequent LAN/tailnet connections authenticate from the
paired store. Relay reconnect adds the ephemeral same-account proof described
above. Manual pairings remain account-independent locally; signing both machines
into the same account makes relay eligible without converting that manual record
to account-owned provenance.

Older desktop builds could save that account row as a credentialless routed SSH
target even though the desktop's own SSH stack happened to find a working local
identity. `resolveRemoteTargetForLaunch` recognizes only the high-confidence
legacy shape: no saved SSH user/key, non-manual routes, an exact name match, and
all saved hosts belonging to one account-directory machine. It adopts that
machine into the paired store and removes the obsolete record. An unavailable
directory, offline machine, or pairing failure is a terminal paired-transport
error for that shape. ADE never downgrades an account-created target to SSH;
only a route with `source: "manual"` is eligible for SSH fallback; Bonjour and
Tailscale discovery routes are never inferred as SSH configuration.

`remoteLauncher.ts` gives target resolution, account adoption, paired route
dials, and every SSH route × channel-home × absolute/PATH binary probe one shared
45-second startup budget. Every child process, WebSocket open, and paired hello
wait is bounded by the smaller of its normal per-attempt cap and the budget that
remains. `SIGINT`/`SIGTERM` abort the active wait and close the corresponding
child/socket; exhaustion returns the collected route/runtime diagnostics instead
of polling indefinitely. After project/session selection, a paired bridge
reconnect receives a fresh bounded startup budget; the deadline does not limit
the connected ADE Code session itself.

## Local runtime routing

Local desktop windows go through the runtime binding. `callProjectRuntimeActionOr` and `callProjectRuntimeSyncOr` in `apps/desktop/src/preload/preload.ts` call the active local or remote runtime when a binding exists; legacy Electron IPC handlers are used only when no runtime route is bound or for desktop-only side effects. File actions are strict once a local or remote runtime is bound, which prevents a failed runtime-bound file write/read from being retried against the desktop's local filesystem when the bound project is owned by a daemon or remote host. Usage and budget reads use the remote runtime only for remote-bound windows; local-bound windows keep using desktop usage IPC. During `project.switchToPath`, preload temporarily binds local runtime calls to the requested root and main-process `runtimeBridge.ts` honors the explicit `rootPath` over the window session binding for local action, sync, and event-stream calls. During `remoteRuntime.openProject`, preload clears the binding while the switch is in flight; mutating runtime actions and mutating sync calls fail with the "Project is switching" message instead of refreshing or writing through a stale binding, while read-only project calls can wait for the active remote open and retry against the new binding.

Read-only chat calls are deliberately left unhandled while a transition is in flight, which raises the question of what to do with them. For **remote** contexts the answer is not the local IPC fallback: the local main-process chat service has never heard of a remote session id, so it answers `sessionFound: false` — a *false* "this session does not exist" that the renderer treats as authoritative and uses to wipe the transcript and its cache. `agentChat.getEventHistory` and `agentChat.getEventHistoryPage` therefore return an explicit `unavailable: true` result ("runtime temporarily unreachable") so the renderer keeps what it has and re-queries once the switch settles; the page variant echoes the caller's `beforeOffset` back as `startOffset` so it does not also claim the head of the transcript was reached. Local bindings keep the IPC fallback, because there the local service *is* the right answer. See [Chat transcript and turns](../chat/transcript-and-turns.md#history-snapshots-scroll-back-and-misses).

That decision needs a synchronous answer to "is this window's project runtime remote?" at a moment when `currentProjectBinding` has been intentionally nulled. `isRemoteProjectRuntimeContext()` provides it without refreshing or awaiting, using three signals in precedence order: a live binding answers for itself; an in-flight remote `openProject` means the window is switching *to* a remote runtime; otherwise, only while a transition is in flight, it falls back to the kind of the binding the window was attached to when the switch began. That last value is snapshotted by `detachProjectBindingForTransition()` at detach time rather than being left at "the last non-null binding" — otherwise a window that closed a remote project and is now projectless would report "remote" forever, and every later local transition would answer "runtime unreachable" for projectless chats the local service can legitimately serve.

`callPinnedRuntimeAction(pin, domain, action, request)` is the explicit-binding escape hatch alongside the binding-resolving helpers. Instead of reading the mutable module-level `currentProjectBinding`, it routes against a caller-supplied `OpenProjectBinding` — addressing a remote runtime by `targetId`/`projectId` or a local runtime by `rootPath` directly — and bypasses the project-transition guard. It exists for in-flight work that must stay pinned to the project that started it even if the active project changes mid-flight: the originating binding is captured up front and the call cannot be misrouted to the now-active project. `lanes.delete` and `agentChat.delete` accept an optional `pin?: OpenProjectBinding | null` second argument that routes through this helper when present (used by draft-launch rollback — see [Chat](../chat/README.md)); when `pin` is absent they fall back to the binding-resolving path. The transition guard is skipped deliberately because a pin is only passed for explicitly-targeted, intentional cleanup, not for ambiguous active-binding calls.

Lane preview reads are also binding-aware. For remote bindings, `proxyGetPreviewInfo` is resolved on the remote runtime, then `remoteRuntime.ensurePortForward` creates or reuses a local `127.0.0.1:<port>` TCP forward to the remote preview port and rewrites the preview URL before returning it to the renderer.

The runtime path covers:

- agent chat actions and chat event history
- terminal session list / detail / update / delete and transcript tails
- pty create / write / resize / dispose plus streamed data and exit events
- file reads / writes / search / quick-open / tree listing and file-watch subscriptions
- diff reads and most git operations
- lanes, PRs, native GitHub stacks, PR issue-resolution launch flows, PR AI conflict-resolution sessions, issue inventory, tests, and project config

Operations with desktop-only side effects, such as some automation hooks and UI-native flows, still use the in-process IPC handlers until their side effects are moved into ade-cli services.

Preload also guards two classes of API against remote bindings:

- `assertNotRemoteProjectPathAction` rejects `app.revealPath`, `app.openPath`, `app.openPathInEditor`, `app.getImageDataUrl`, and `app.writeClipboardImage` when the input path is the remote project root or any descendant of it. A remote project's filesystem is not mounted locally, so revealing or opening those paths on the desktop would point at the wrong machine.
- `assertLocalProjectHostAction` rejects iOS Simulator window-state / window-source lookups on remote-bound windows; those need direct Electron / OS access on the host that owns the simulator.

## Remote connection pool lifecycle

`RemoteConnectionPool` keeps one paired- or SSH-backed `RuntimeRpcClient` per `targetId`:

- `withEntryForTarget` is the single funnel for all RPCs. On a recognized connection error, it disposes the entry, reconnects (via the latest `registry.get(targetId)` so an updated `routes` array applies), and either replays the operation or reports the connection error to the caller. A method timeout is not a connection error: it propagates to the original caller without reconnecting or replaying any operation. `callProjectActionForTarget` only enables automatic replay after a genuine connection failure for safe read-only actions: prefixes `diagnosticsGet|get|list|oauthGet|oauthList|portGet|portList|proxyGet|read|search` plus a small allowlist (`chat.codexFuzzyFileSearch`, `chat.fileSearch`, `chat.modelCatalog`, `file.quickOpen`, `terminal.activeForChat`, `terminal.preview`). `callProjectSyncForTarget` uses the same posture for sync: status/discovery/device/PIN reads, lane-presence announcements, and model-picker reads are retryable after a connection failure; mutating action and sync calls are never replayed automatically, because ADE cannot know whether the remote side effect completed before the connection was interrupted.
- Connection startup failures are backoff-throttled per target so repeated implicit reconnect attempts do not saturate SSH. Explicit Connect bypasses that backoff, clears manual disconnect state, and resets the automatic reconnect failure budget. After 10 implicit connection failures, `RemoteConnectionService` pauses automatic reconnect and reports that the user must press Connect.
- Reconnection intent is persisted as `target.autoConnect`, independent of account state. A successful explicit or implicit connection sets it to `true`; Disconnect sets it to `false`; an explicit failure preserves the previous value. Launch/wake probing considers only targets where it is enabled (with a one-time legacy coercion from old last-connected/manual-disconnect fields).
- `ensureLocalPortForward` owns local TCP listeners keyed by `(targetId, remoteHost, remotePort)`. Each listener uses `ssh.forwardOut` into the active SSH session and is closed when the target disconnects.
- `callMethodForTarget` is the runtime-scoped JSON-RPC entry point used by the command-palette project picker and clone flows. Before forwarding to the SSH transport it runs `assertMachineProjectCapability(entry, method)`, which checks the connection's `capabilities.machineProjects` map for the `projects.*` family. A missing capability fails the call with a self-describing message that names the action (e.g. `creating remote projects`) so the renderer can guide the user to update the remote runtime.
- Optional remote actions can define compatibility fallbacks. Missing `file.refreshGitDecorations` returns an empty decoration set and marks `statusHints.optionalActionMissing`. The first not-callable response is memoized per target/project/action so old remote runtimes do not get hammered by unsupported optional calls.
- `RuntimeRpcClient.call` expires each request independently: the timer atomically removes and rejects only that request ID, late responses for the expired ID are ignored, and unrelated calls plus runtime-event notifications continue on the same transport. Transport close/error and malformed JSON framing remain connection-fatal: they close the client, notify disconnect observers, and reject every pending request. Oversized response lines remain memory-bounded and reject only the matching request while the client discards the rest of that line. The client records the original `method` for every pending request and formats remote errors as `Remote ADE service method <method> failed (code N): <message> Details: ...` so JSON-RPC error `code` / `message` / `data` are all preserved instead of being collapsed into a generic string.
- `onEntryEvicted(listener)` lets `RemoteConnectionService` flip a status to `error` when the paired/SSH transport or JSON-RPC client closes underneath it. `runtimeBridge.ts` subscribes `powerMonitor` `resume` and `unlock-screen` to `remoteConnectionService.probeSavedConnections()`, which pings every `connected` target with a short `pingTimeoutMs` (default 5 s); a recognized transport failure disconnects the entry so the next renderer call reconnects against the most-recently-successful route, while a request-local ping timeout leaves the healthy shared client in place.

## Per-target action registry

The renderer's command palette needs to know which action domains a target supports. `ade.remoteRuntime.listActionRegistry { id, projectId }` IPC calls `RemoteConnectionPool.listActionRegistryForTarget`, which invokes `list_ade_actions` on the remote runtime and normalizes the result into `AdeActionRegistryEntry[]`. Preload's `ade.actions.listRegistry` checks the active binding: remote-bound windows query the remote runtime, local-bound windows query the local ADE runtime through `ade.localRuntime.listActionRegistry`, and the desktop in-process registry is only used when no project runtime is bound.

## Local runtime connection lifecycle

`LocalRuntimeConnectionPool` handles the desktop side of the local runtime binding:

- `connect()` first tries an existing `~/.ade/sock/ade.sock`. If that socket is unavailable, it spawns `ade serve --socket <path>` with the bundled CLI from `process.resourcesPath/ade-cli/cli.cjs` or the dev path, waits for the socket, and reconnects.
- `initialize` is called immediately after connect. The pool compares `runtimeInfo.version`, `runtimeInfo.buildHash`, and `runtimeInfo.defaultRole` with the expected desktop runtime. A mismatch closes only that client: the primary `ade.sock` daemon is preserved, and the desktop starts or reuses a deterministic isolated socket (`ade-cto-<version>-<build>.sock`) for its own runtime instead of terminating the user's existing daemon.
- `installServiceBestEffort()` runs `ade serve --install-service` once per session to register the per-user login service; the result feeds `LocalRuntimeStatus.serviceInstall`.
- `getStatus()` periodically refreshes `serviceHealth` (`unsupported | not_installed | installed | running | error | unknown`) by calling `getRuntimeServiceStatus()` from the service manager.
- The pool exposes typed entry points for action calls (`callActionForRoot`), sync calls (`callSyncForRoot`), event polling (`streamEventsForRoot`), and event subscription (`subscribeEventsForRoot`). All of them register the project with `projects.add` once and then carry `projectId` on every project-scoped request.
- Project registration, file actions, and event polling pass per-call timeout overrides to `RuntimeRpcClient`; ordinary actions keep the client's default timeout. A timeout propagates only to that caller: the local pool does not reset the shared client or replay the request, so concurrent calls and event subscriptions continue normally. Both pools also keep a small `LONG_RUNNING_*_ACTION_TIMEOUTS` map keyed by `<domain>.<action>`; today it grants both the compatibility `chat.suggestLaneNameFromPrompt` action and the structured `chat.generateAutoLaneIdentity` action a 120 s budget instead of the default 30 s local / 25 s retryable-remote ceiling. Auto-lane naming still runs entirely after lane/session launch, so even an expired naming request cannot fail the launched work.
- `callActionForRoot` measures `ensureProject`, `connect`, and the daemon RPC separately. Any action call that exceeds 500 ms total — or throws — emits a `local_runtime.action_slow` warning log with `domain`, `action`, `totalMs`, `ensureProjectMs`, `connectMs`, `daemonCallMs`, the applied per-call timeout, and the error message (when present). This is the entry point for diagnosing why a renderer action stalled before the IPC timeout fires.
