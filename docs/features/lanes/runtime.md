# Lane runtime isolation

Lane runtime isolation turns a lane from "just a worktree" into a full
parallel dev environment: its own port range, its own `.localhost`
hostname, its own OAuth callback routing, its own health signals, and
optional per-lane env init. Shipped as Phase 5 workstreams W1–W6.

## Where this runs

Every service below executes inside the **active runtime** for the
window's project binding — the local ADE daemon (`ade serve`) for
local-bound windows or the SSH-attached remote runtime for
remote-bound windows. Port leases, proxy hostname routing, OAuth
callback handling, env init, and runtime diagnostics all run on the
machine that owns the lane's worktree. The desktop main-process copies
under `apps/desktop/src/main/services/lanes/` are kept as fallback
implementations only; the canonical ones now live alongside the runtime
services in `apps/ade-cli/`. The renderer's `window.ade.lanes.*` APIs
that touch this subsystem (`initEnv`, `getEnvStatus`, `port.*`,
`proxy.*`, `oauth.*`, `diagnostics.*`) are routed through preload's
`callProjectRuntimeActionOr("lane", …)` helper, which prefers the
ADE runtime and only falls back to in-process handlers when no
runtime is bound.

For remote-bound windows the listening sockets, the `*.localhost`
proxy, and the OAuth callback URL all live on the remote host. Preview
URLs reflect that hostname.

## Services

Services keyed by workstream. Code paths shown for the desktop
fallback target; the ADE runtime hosts the canonical instances.

| Service | Workstream | Responsibility |
|---------|-----------|----------------|
| `laneEnvironmentService.ts` | W1 | Env file templating, docker services, dependency install, mount points, copy paths, setup script; docker teardown on archive/delete/reclaim; the per-lane init/cleanup queue and the incomplete-init marker |
| `laneEnvInitMerge.ts` | W1 | Dependency-free merge kernel for `LaneEnvInitConfig` / `LaneOverlayOverrides` (`mergeLaneEnvInitConfig`, `mergeLaneDockerConfig`, `cloneLaneEnvInitConfig`, `mergeLaneOverrides`). Imported by `projectConfigService`, `registerIpc`, the action-domain registry, and the ade-cli sync command service, which each used to carry their own copy. Kept free of service types so config parsing can import it without a cycle. |
| `laneOverlayContext.ts` | W1 | `resolveLaneOverlayContext` — the one answer for "which lane, which overlay overrides, which env-init config", with the lane's active port lease folded in (`applyLeaseToOverrides`). Used by env init and by every teardown path so two teardowns of the same lane cannot disagree about which compose file to bring down. |
| `setupScriptConfig.ts` | W2 | Leaf module resolving a `LaneSetupScriptConfig` to the platform's commands / script path (`resolveSetupScriptConfig`) and rejecting script files Windows cannot launch (`unsupportedWindowsScriptPathError`). Lets the executor resolve exactly what the template UI promises without importing template CRUD. |
| `laneTemplateService.ts` | W2 | CRUD for reusable init recipes, platform-specific setup scripts, default-template selection |
| `portAllocationService.ts` | W3 | Lease-based port range allocation, conflict detection, orphan recovery |
| `laneProxyService.ts` | W4 | `*.localhost` reverse proxy, per-lane hostname routes |
| `oauthRedirectService.ts` | W5 | OAuth callback routing (see [`oauth-redirect.md`](./oauth-redirect.md)) |
| `runtimeDiagnosticsService.ts` | W6 | Aggregated health checks (port/proxy), fallback mode |

Renderer surfaces:

| Component | Role |
|-----------|------|
| `renderer/components/lanes/LaneEnvInitProgress.tsx` | Per-step env init progress inside `CreateLaneDialog` |
| `renderer/components/settings/storage/StorageDiagnostics.tsx` | Diagnostics view, inside Settings > Diagnostics |
| `renderer/components/settings/LaneTemplatesSection.tsx` | Template management |
| `renderer/components/settings/LaneBehaviorSection.tsx` | New-lane base, auto-rebase, rebase-suggestion display (off/badge/banner) + threshold. Cleanup policy lives in `StorageSection.tsx`. |

## Environment initialization (W1)

`laneEnvironmentService.initializeLane(laneId)` runs initialization
steps in order:

1. **`env-files`** — copy/template `.env` files with lane-specific
   substitutions (port, hostname, API keys). Both source and
   destination paths are validated against their roots via
   `resolvePathWithinRoot` (symlink-aware) to prevent path traversal.
2. **`docker`** — start lane-specific Docker Compose services.
   Compose file path validated against the project root.
3. **`dependencies`** — run install commands from an allowlist:
   `npm`, `yarn`, `pnpm`, `pip`, `pip3`, `bundle`, `cargo`, `go`,
   `composer`, `poetry`, `pipenv`, `bun`. Any command outside this
   set is rejected. Working directories must resolve inside the
   worktree.
4. **`mount-points`** — configure runtime mount points for agent
   profiles/context. Source and destination validated.
5. **`copy-paths`** — same validation as env files; used for copying
   non-template files from the project root into the worktree.
6. **`setup-script`** — run the template's setup script, last, so it can
   rely on every step above having finished. Only added to the run when
   a setup script is actually configured for the current platform;
   otherwise there is no step and nothing runs.

Each step is reported through `LaneEnvInitProgress` IPC events with
status (`pending | running | completed | failed | skipped`) and a
duration. `skipped` carries a reason rather than a fault — it is what a
cancelled run marks its remaining steps with — so both the desktop
(`LaneEnvInitProgress.tsx`) and iOS (`LaneEnvInitProgressView.swift`)
renderers show a `skipped` step's message in muted text instead of the
red used for `failed`.
`CreateLaneDialogHost` decides how that progress is surfaced. In the
Lanes tab it keeps `CreateLaneDialog` open and renders
`LaneEnvInitProgress` inline so the user can watch or retry setup in the
modal. In the Work tab it closes as soon as the lane row exists and runs
setup detached; failures create a sticky toast with a Retry action so
the session sidebar does not need to stay mounted.

Config types live in `src/shared/types/config.ts`:

- `LaneEnvInitConfig` — top-level config with arrays of steps
- `LaneEnvFileConfig`, `LaneDockerConfig`, `LaneDependencyInstallConfig`,
  `LaneMountPointConfig`, `LaneCopyPathConfig`
- `LaneSetupScriptConfig` — optional post-init script with
  platform-specific variants (`commands` / `unixCommands` /
  `windowsCommands`, similar for `scriptPath`). Supports
  `injectPrimaryPath` to expose `$PRIMARY_WORKTREE_PATH` to shell
  commands. Carried on `LaneEnvInitConfig` as `setupScript`, which is
  how it reaches the executor.

### Setup script execution

`laneTemplateService.resolveTemplateAsEnvInit()` copies the template's
`setupScript` onto the resulting `LaneEnvInitConfig`, so the script runs
on **every** path that runs env init with a template: lane create,
`lanes.applyTemplate`, `lanes.initEnv`, and unarchive that recreates the
worktree. When both a project-level and a template/overlay setup script
exist, the more specific one wins — a lane runs one setup script.

- **Platform selection.** `resolveSetupScriptConfig` picks
  `windowsCommands` / `windowsScriptPath` on Windows and
  `unixCommands` / `unixScriptPath` elsewhere, each falling back to the
  generic `commands` / `scriptPath`. If nothing resolves for the current
  platform, the step is not created at all. "Is there work for *this*
  platform" is a different question from "is a script configured at
  all", and only the second one may decide what persists:
  normalization, merging, and the config that ships to other hosts use
  the platform-agnostic `laneSetupScriptHasWork` predicate (exported
  from `src/shared/types/config.ts`), so a `windowsCommands`-only script
  survives a save made on macOS. A config carrying only
  `injectPrimaryPath` fails both tests — it configures nothing to run,
  so it is not a setup script.
- **Shell semantics (commands).** Configured `commands` are
  user-authored shell, not argv: they run through `/bin/sh -c` on
  macOS/Linux and through `cmd.exe /d /s /c` (via
  `resolveWindowsCmdLineInvocation`) on Windows, so pipes, `&&`, and
  variable expansion work — `$VAR` on POSIX, `%VAR%` on Windows.
- **Script files are spawned, not shelled.** A configured `scriptPath`
  is a path, so it goes through `resolveCliSpawnInvocation` as a real
  argv spawn rather than being pasted into a shell line: `.ps1` runs
  under an absolutely-resolved `powershell.exe`
  (`windowsPowerShellCommand()`, `-NoLogo -NoProfile -NonInteractive
  -ExecutionPolicy Bypass -File`) so a `powershell.exe` sitting at the
  lane worktree root cannot win resolution, `.cmd`/`.bat` go through
  ComSpec, and on macOS/Linux the script path is executed directly.
  **A POSIX script file must therefore be executable (`chmod +x`) and
  start with a shebang** — without both, the step fails with the OS
  error (`EACCES` / `ENOEXEC`) rather than being interpreted by a
  shell. On Windows the reverse case is caught before spawning:
  `unsupportedWindowsScriptPathError` fails the step for a script whose
  extension Windows cannot launch (anything outside `.ps1`, `.cmd`,
  `.bat`, `.exe`, `.com` — a `scripts/setup.sh` or an extension-less
  path), with a message naming `windowsScriptPath` / `windowsCommands`
  as the fix, instead of a raw `ENOEXEC` that reads like an ADE bug.
- **Trust gate.** `laneEnvInit` and `laneTemplates` both merge in from
  the repo-committed `.ade/ade.yaml`, so the setup-script step consults
  `projectConfigService.getExecutableConfig()` first — the same gate
  test suites use. While the project's shared config is untrusted the
  step **fails** with "This project's shared configuration isn't trusted
  yet…" instead of executing or silently skipping. Trust the shared
  config in Settings to allow it. Only `ADE_TRUST_REQUIRED` is handled
  that way; any other config error (a malformed `ade.yaml`) propagates
  and fails the step with its own message.
- **Order.** Configured commands run first, in order, then the script
  file if one is set. `scriptPath` is resolved against the project root
  with the same symlink-aware traversal check as env files.
- **Working directory.** The lane's worktree root.
- **Environment.** The ADE process environment plus the lane runtime
  vars: `LANE_ID`, `LANE_NAME`, `LANE_SLUG`, `LANE_BRANCH`,
  `LANE_WORKTREE`, `PORT`, `PORT_RANGE_START`, `PORT_RANGE_END`,
  `HOSTNAME`, `PROXY_HOSTNAME`, and any overlay `env` entries. With
  `injectPrimaryPath` enabled, `PRIMARY_WORKTREE_PATH` is also set to
  the primary lane's root (the project checkout).
- **Failure.** Fail-fast, like every other step: the first non-zero exit
  fails the `setup-script` step with the failing command and a stderr
  excerpt, marks the whole init failed, and skips the remaining
  commands. A configured `scriptPath` that does not exist is a failure,
  not a silent skip. Each command has a 300 s timeout.

### Teardown on archive, delete, and reclaim

`laneEnvironmentService.cleanupLaneEnvironment(lane, config)` runs
`docker compose -f <composePath> -p <projectName> down --remove-orphans`
for the lane's compose project. It runs on all four lifecycle paths:

| Path | How teardown is reached |
|------|-------------------------|
| Delete | `teardownEnv` passed by the caller into `laneService.delete` |
| Archive & reclaim | `teardownEnv` passed into `laneService.archiveAndReclaim` |
| Plain archive | The late-bound `setOnLaneArchivedEnvTeardown` hook, run inside `laneService.archive` |
| Unarchive | `docker compose up` runs again — full env init when the worktree had to be recreated or the lane's last init never finished, docker-only otherwise |

**What "the lane's compose project" means, exactly.** Every teardown
path resolves the config the same way, through
`laneRuntimeLifecycle.buildLaneEnvTeardown` →
`laneOverlayContext.resolveLaneOverlayContext`: project-level
`laneEnvInit` merged with the matching lane overlay overrides. That
resolver lives in `laneOverlayContext.ts` rather than in the merge
kernel `laneEnvInitMerge.ts`, which stays free of service types so
`projectConfigService` can import it without dragging the lane services
(and an import cycle) in with it. **A
`docker.composePath` configured only on a lane template is not covered.**
`applyTemplate` composes it up, but the applied template is not
persisted per lane, so no teardown resolver can see it — archive,
delete, and reclaim will all leave that stack running. Put a compose
path on `laneEnvInit` (or on an overlay policy that matches the lane) if
you want it torn down.

Plain archive used to skip teardown, so an archived lane's containers
kept running and holding ports with nothing in the UI pointing at them.
The hook lives in `laneService.archive` rather than at each caller
because archive is reached from the IPC handler, the action-domain
registry, the sync command service, the PR service (post-merge lane
cleanup), and storage auto-archive — one list, not six. It is wired by
the host (`main.ts`, `bootstrap.ts`) once `laneEnvironmentService`
exists, resolved through
`laneRuntimeLifecycle.teardownArchivedLaneEnvironment`.

Teardown on archive is best-effort: a failing `compose down` is logged
(`lane.archive.env_teardown_failed`) and the archive still succeeds.

Restore is deliberately asymmetric. When the worktree had to be
recreated, unarchive re-runs the whole env init
(`restoreRecreatedLaneRuntime`). After a plain unarchive the worktree
was never removed, so only the Docker step re-runs
(`restoreUnarchivedLaneDocker`) — re-copying env files, reinstalling
dependencies, or re-running the setup script would clobber work that
survived the archive. Run **Init env** (`lanes.initEnv`) by hand if you
do want the full sequence again.

### Cancelling an init that a teardown is waiting on

Init and cleanup for the same lane are serialized on one promise queue,
and an archive or delete arriving mid-init raises a flag that
`initLaneEnvironment` reads at every step boundary: the remaining steps
are marked `skipped` with "Cancelled: lane is being torn down" (neutral
copy and neutral styling — it fires for delete and archive-and-reclaim
too, not only archive) and the run ends `failed`. Already-spawned child
processes keep their own timeouts; nothing is killed.

That leaves a half-initialized worktree, and the evidence disappears
with it: cleanup deletes the lane's progress entry. So an init that
does not run every planned step — cancelled or failed — records the
lane in `.ade/lane-env-init-incomplete.json` (local runtime state,
gitignored). `restoreUnarchivedLaneDocker` reads it through
`laneEnvironmentService.wasLastInitIncomplete(laneId)` and re-runs the
**whole** env init instead of the docker-only restore, including for a
lane with no Docker step at all. The marker is durable rather than
in-memory because the gap it covers spans restarts; it is removed when
a later init for that lane completes. A lane deleted while marked
leaves an inert stale id behind.

## Lane templates (W2)

Templates package a complete `LaneEnvInitConfig` + overlay overrides
+ setup script. `resolveSetupScriptConfig(setupScript, platform)` in
`services/lanes/setupScriptConfig.ts` returns the platform-appropriate
commands / script path or `null` if nothing is configured for that
platform; it is a leaf module so `laneEnvironmentService` (the executor)
resolves exactly what the template UI promises without importing
template CRUD.

The `NO_DEFAULT_LANE_TEMPLATE` sentinel distinguishes "no default
set" from "default explicitly cleared" so the Settings UI can surface
the difference.

IPC: `ade.lanes.templates.list / get / getDefault / setDefault / apply`.

## Overlay policies

`LaneOverlayOverrides` extends the base overlay fields with Phase 5
additions:

```ts
type LaneOverlayOverrides = {
  env?: Record<string, string>;
  cwd?: string;
  testSuiteIds?: string[];
  portRange?: { start: number; end: number };
  proxyHostname?: string;
  computeBackend?: "local" | "vps" | "daytona";  // legacy; see note
  envInit?: LaneEnvInitConfig;
};
```

The matcher in `src/main/services/config/laneOverlayMatcher.ts` evaluates policies
at lane creation:

- `portRange`, `proxyHostname`, `computeBackend`: last-wins merge
- `envInit`: deep-merged through `laneEnvInitMerge.ts` — env files,
  dependencies, mount points, and copy paths concatenate across
  policies; docker configs shallow-merge (a later `services` list
  replaces an earlier one); `setupScript` is last-wins, because a lane
  runs exactly one setup script

`computeBackend` is retained for back-compat with older configs but
is no longer part of the active lane runtime direction.

## Port allocation (W3)

Deterministic, lease-based. Defaults: `basePort = 3000`, `portsPerLane
= 100`, `maxPort = 9999`. Lane N gets `[basePort + N*100, basePort +
N*100 + 99]`.

`PortLease`:

```ts
type PortLease = {
  laneId: string;
  rangeStart: number;
  rangeEnd: number;
  status: "active" | "released" | "orphaned";
  leasedAt: string;
  releasedAt?: string;
};
```

Conflict detection runs automatically after orphan recovery. When
conflicts are detected, `PortConflict` records are emitted and the
UI surfaces them in the diagnostics panel with a "Reassign port"
action.

Config validation at service creation:

- `basePort` must be a positive integer
- `portsPerLane` must be a positive integer
- `maxPort >= basePort`
- `maxSlots()` clamps to zero for degenerate configs so the service
  can still boot and return empty allocations.

IPC: `ade.lanes.port.getLease / listLeases / listConflicts / acquire
/ release / recoverOrphans / event`.

## Hostname proxy (W4)

`laneProxyService` runs a single HTTP reverse proxy on `proxyPort`
(default 8080). Traffic is routed by Host header:

```
incoming: feat-auth.localhost:8080
proxy strips suffix → "feat-auth"
looks up route by hostname → route.targetPort
forwards to 127.0.0.1:<targetPort>
```

Hostname collision-safety: `buildHostname` appends `-lane` or
`-<laneIdSlug>` suffixes when the preferred slug is already used by a
different lane's active route.

IPv6 normalization (`[::1]`, `::ffff:127.0.0.1`) is handled in
`normalizeHostHeader` so localhost traffic still resolves.

Cookie/auth isolation is automatic: browsers scope cookies by
hostname, so `feat-auth.localhost` and `bugfix.localhost` never
share session cookies.

Preview URLs are generated via `getPreviewInfo(laneId)` and opened
with `openPreview(laneId)` (uses the OS default browser).

Hardening (commit `6677edf`): Host header validation, route lookup
hardening, proxy error page sanitization (HTML-escaped lane id +
message).

IPC: `ade.lanes.proxy.getStatus / start / stop / addRoute / removeRoute
/ getPreviewInfo / openPreview / event`.

## Runtime diagnostics (W6)

`runtimeDiagnosticsService` aggregates signals from the port and proxy
services into a per-lane `LaneHealthCheck`:

```ts
type LaneHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
type LaneHealthIssue = {
  type: "port-unresponsive" | "proxy-route-missing"
      | "port-conflict" | "env-init-failed";
  message: string;
  actionLabel?: string;
  actionType?: "reassign-port" | "restart-proxy" | "reinit-env"
             | "enable-fallback" | "refresh-preview";
};
type LaneHealthCheck = {
  laneId: string;
  status: LaneHealthStatus;
  portResponding: boolean;
  respondingPort: number | null;
  proxyRouteActive: boolean;
  fallbackMode: boolean;
  lastCheckedAt: string;
  issues: LaneHealthIssue[];
};
```

Check steps inside `runCheck(laneId)`:

1. **Port responding** — `findResponsivePort` probes the route's
   target port first, then the lease's `rangeStart`, then sweeps
   the rest of the range with a 75 ms per-port timeout in parallel.
2. **Proxy route active** — route exists, proxy server is running,
   route's target port matches the actually responding port. When
   any condition fails, the service emits a precise `proxy-route-missing`
   issue with a context-specific message (proxy stopped, port
   mismatch, route missing, etc).
3. **Port conflicts** — scan `getPortConflicts()` for unresolved
   conflicts involving this lane.

Status derivation (`deriveStatus`):

- No issues, no fallback → `healthy`
- No issues, fallback active → `degraded`
- Has `port-unresponsive` → `unhealthy`
- Otherwise → `degraded`

**Proxy status unavailable** short-circuits to `unhealthy` with a
single `proxy-route-missing` issue. This is the load-bearing check
that tells the UI "the proxy itself failed" vs "this one lane is
broken."

Fallback mode (`activateFallback(laneId)`):

- Adds the lane to the `fallbackLanes` set.
- Re-derives the cached health so the lane reports `degraded` rather
  than `unhealthy` when isolation is bypassed.
- Emits `fallback-activated` / `fallback-deactivated` events.

`deactivateFallback` is idempotent. Both activate/deactivate are
safe to call on a lane that has no cached health (no-op).

IPC: `ade.lanes.diagnostics.getStatus / getLaneHealth / runHealthCheck
/ runFullCheck / activateFallback / deactivateFallback / event`.

## Gotchas

- **Probe timing**. `checkPort` uses a 500 ms default timeout;
  `findResponsivePort` shortens to 150 ms for preferred ports and
  75 ms for sweeps. A slow dev server may momentarily flap into
  `port-unresponsive` on cold start. If this happens, the event
  stream will settle once the server finishes binding.
- **Preferred-port list**. `findResponsivePort` prefers the proxy
  route's `targetPort` first, then the lease's `rangeStart`. If the
  dev server binds to a different port in the lease range, detection
  still works but takes longer.
- **Fallback is a manual opt-in**. When isolation fails, the UI
  prompts but does not auto-enable fallback. This is intentional:
  fallback disables cookie isolation, and silently breaking that
  contract has caused bug reports before.
- **Orphaned leases on crash**. If ADE crashes while a lease is
  `active`, recovery on next boot marks it `orphaned` and frees the
  slot for reallocation. `recoverOrphans` is called after
  persistence load during service init.
- **Proxy hardening**. Proxy error pages HTML-escape all
  user-controlled fields. Do not relax this — a proxy error can be
  triggered by a malicious OAuth provider redirecting to
  `<script>…`.
- **Diagnostics refresh storms**. Keep health refreshes separate from
  preview routing / port / OAuth refreshes. Proxy and port events plus
  the 30s routing safety poll own those reads.
