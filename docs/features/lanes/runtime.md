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
| `laneEnvironmentService.ts` | W1 | Env file templating, docker services, dependency install, mount points, copy paths |
| `laneTemplateService.ts` | W2 | CRUD for reusable init recipes, platform-specific setup scripts, default-template selection |
| `portAllocationService.ts` | W3 | Lease-based port range allocation, conflict detection, orphan recovery |
| `laneProxyService.ts` | W4 | `*.localhost` reverse proxy, per-lane hostname routes |
| `oauthRedirectService.ts` | W5 | OAuth callback routing (see [`oauth-redirect.md`](./oauth-redirect.md)) |
| `runtimeDiagnosticsService.ts` | W6 | Aggregated health checks (port/proxy), fallback mode |

Renderer surfaces:

| Component | Role |
|-----------|------|
| `renderer/components/lanes/LaneEnvInitProgress.tsx` | Per-step env init progress inside `CreateLaneDialog` |
| `renderer/components/settings/storage/StorageDiagnostics.tsx` | Diagnostics view, inside Settings > Storage & Diagnostics |
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

Each step is reported through `LaneEnvInitProgress` IPC events with
status (`pending | running | done | failed`) and a duration.
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
  commands.

## Lane templates (W2)

Templates package a complete `LaneEnvInitConfig` + overlay overrides
+ setup script. `laneTemplateService.resolveSetupScript(template)`
returns the platform-appropriate command/script path at runtime or
`null` if no script is configured.

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
- `envInit`: deep-merged (env files, docker configs, dependencies,
  and mount points concatenate across policies)

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
