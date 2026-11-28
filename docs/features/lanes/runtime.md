# Lane runtime isolation

Beyond its worktree, a lane can have its own port range, `*.localhost`
hostname, OAuth callback routing, health checks and environment setup.

## Where this runs

Every service here runs on the machine that holds the lane's worktree: the
brain for a local binding, the remote runtime for a remote one. The code is in
`apps/desktop/src/main/services/lanes/`; the brain imports it. Renderer calls
(`window.ade.lanes.initEnv`, `getEnvStatus`, `port.*`, `proxy.*`, `oauth.*`,
`diagnostics.*`) go through preload to the bound runtime, with in-process IPC
only when no runtime is bound. For a remote binding the sockets, the proxy and
the OAuth callback URL all live on the remote host.

## Source file map

| File | Responsibility |
|------|----------------|
| `laneEnvironmentService.ts` | Env files, Docker, dependency installs, mount points, copy paths, setup script; Docker teardown; the per-lane init/cleanup queue; the incomplete-init marker; `onEvent`, `abortLaneEnvironment`. |
| `laneEnvironmentProcesses.ts` | Event fan-out, running setup children per working directory, cooperative cancel flags. |
| `laneEnvironmentSetup.ts` | `runLaneEnvironmentSetup` (the one post-create setup path) and `planNewLaneEnvironment`. |
| `laneEnvInitMerge.ts` | Dependency-free merge kernel for env-init configs and overlay overrides (imports no services, so config parsing can use it without a cycle). |
| `laneOverlayContext.ts` | `resolveLaneOverlayContext`: lane, overlay overrides with the port lease folded in (`applyLeaseToOverrides`), effective env-init config. Shared by setup and every teardown. |
| `setupScriptConfig.ts` | `resolveSetupScriptConfig` (platform choice), `unsupportedWindowsScriptPathError`. |
| `laneTemplateService.ts` | Template CRUD, default template (`NO_DEFAULT_LANE_TEMPLATE` tells "none set" from "cleared"). |
| `laneDependencyStatus.ts` | Main checkout lockfiles and install state. |
| `portAllocationService.ts` | Port range leases, conflicts, orphan recovery. |
| `laneProxyService.ts` | `*.localhost` reverse proxy. |
| `oauthRedirectService.ts` | OAuth callbacks; see [oauth-redirect.md](./oauth-redirect.md). |
| `runtimeDiagnosticsService.ts` | Per-lane health checks, fallback mode. |
| `apps/desktop/src/shared/laneSetupPlatform.ts` | `LANE_SETUP_PLATFORM_FIELDS`, `macosOnlyToolOnLinux`. |
| `apps/desktop/src/shared/types/config.ts` | `LaneEnvInitConfig` and step types, `LaneSetupScriptConfig`, `laneSetupScriptHasWork`. |
| `renderer/components/settings/LaneTemplatesSection.tsx`, `NewLaneSettingsSection.tsx` | Templates and start defaults in Settings. |
| `renderer/components/app/useLaneDependencyBanners.tsx`, `renderer/lib/laneTemplateSetupPrompt.ts` | Main checkout notices and the template setup prompt. |
| `apps/ios/ADE/Views/Lanes/LaneEnvInitProgressView.swift` | Setup progress on the phone. |

## Gotchas

- **One setup path.** Every post-create setup goes through
  `runLaneEnvironmentSetup`. Add behavior there, not in an entry point.
- **A compose path set only on a lane template is never torn down.** The
  applied template is not stored per lane, so no teardown can see it. Put
  `docker.composePath` on `laneEnvInit` or a matching overlay policy.
- **Persistence vs platform.** Normalizing, merging and syncing a setup script
  use the platform-agnostic `laneSetupScriptHasWork`, so a
  `windowsCommands`-only script survives a save on macOS. Only execution asks
  "is there work for this platform".
- **Probe timing.** `checkPort` waits 500 ms, preferred ports 150 ms, sweeps
  75 ms. A dev server on cold start can flap into `port-unresponsive`.
- **Fallback is manual.** It disables cookie isolation, so the UI prompts but
  never turns it on itself.
- **Proxy error pages HTML-escape every user-controlled field.** A malicious
  OAuth redirect can trigger one. Do not relax it.
- **Keep health refreshes separate** from preview, port and OAuth refreshes;
  proxy and port events plus the 30 s routing safety poll own those reads.
- **Orphaned leases** from a crash are marked `orphaned` and freed by
  `recoverOrphans` at service start.

## Environment setup

`laneEnvironmentService.initializeLane(laneId)` runs, in order:

1. **`env-files`**: copy or template `.env` files with lane values. Source and
   destination are checked with symlink-aware `resolvePathWithinRoot`.
2. **`docker`**: start the lane's Compose services.
3. **`dependencies`**: run each install command directly (no shell) in its
   `cwd`, which must resolve inside the worktree.
4. **`mount-points`**: runtime mount points for agent profiles and context.
5. **`copy-paths`**: copy non-template files from the project root.
6. **`setup-script`**: last, and only when one is configured for this
   platform.

Each step reports `LaneEnvInitProgress` (`pending | running | completed |
failed | skipped`) with a duration. `skipped` carries a reason (a cancelled run
marks its remaining steps so), shown muted, not red. Each install, setup
command or script may run 20 minutes (`LANE_ENV_COMMAND_TIMEOUT_MS`); callers
of `lane.initEnv` and `lane.applyTemplate` wait 45
(`LANE_ENV_SETUP_TIMEOUT_MS`).

On desktop the create dialog closes on submit and `runDetachedLaneCreate`
runs create and setup in the background on the chosen machine; the sidebar
shows "Creating…" then "Setting up…", and a failure leaves a sticky toast with
Retry. A lane made by a new-lane chat launch runs setup inside the launch
(`chatLaunchService` subscribes to `onEvent`); see
[Chat › New-lane launches](../chat/README.md#new-lane-launches).

`runLaneEnvironmentSetup(deps, { laneId, templateId?, includeArchived? })` is
called by the `lane.initEnv` / `lane.applyTemplate` actions, the
`ade.lanes.initEnv` / `ade.lanes.templates.apply` IPC handlers, the sync
`lanes.initEnv` / `lanes.applyTemplate` commands and chat launch. With a
template it resolves it (`resolveTemplateAsEnvInit`), merges its env vars and
port range into the overlay (an existing port range wins) and its env init over
the project's; without one it runs the project config alone (zero steps →
`completed`). An unknown template throws `Template not found: <id>`.
`includeArchived` defaults to true; IPC and sync pass false.

### Setup script execution

The template's `setupScript` runs on every path that runs env init with a
template: create, apply template, init env, and an unarchive that recreates
the worktree. When project and template both have one, the more specific wins;
a lane runs one setup script.

- **Platform.** Windows: `windowsCommands` / `windowsScriptPath`. macOS:
  `macosCommands`, then `unixCommands`. Linux (a DAEX Cloud computer):
  `linuxCommands`, then `unixCommands`. Each falls back to generic `commands` /
  `scriptPath`. A list of its own, even empty, is what that OS runs. Nothing
  resolved → no step. A config with only `injectPrimaryPath` is not a script.
- **macOS tools on Linux.** When Linux would run shared commands that call
  macOS-only tools (`cp -c`, `xcrun`, `ditto`, `pbcopy`…), the step still runs,
  logs `lane_env_init.setup_script_macos_on_linux`, and its label and the
  template editor say to add Linux commands.
- **Commands are shell**: `/bin/sh -c` on macOS/Linux, `cmd.exe /d /s /c`
  (`resolveWindowsCmdLineInvocation`) on Windows.
- **Script files are spawned, not shelled** (`resolveCliSpawnInvocation`):
  `.ps1` through an absolutely resolved `powershell.exe`
  (`windowsPowerShellCommand()`, so a `powershell.exe` in the worktree cannot
  win), `.cmd`/`.bat` through ComSpec. A POSIX script must be executable and
  start with a shebang. On Windows, an extension it cannot launch fails early
  with `unsupportedWindowsScriptPathError`, naming `windowsScriptPath` /
  `windowsCommands`.
- **No trust gate.** Setup scripts come only from the machine-local config
  (`.ade/local.yaml`) or a local template, never from the repo. A malformed
  `local.yaml` fails the step.
- **Order:** commands, then the script file (resolved against the project root
  with the symlink-aware check). **Cwd:** the worktree root.
- **Environment:** the process environment plus `LANE_ID`, `LANE_NAME`,
  `LANE_SLUG`, `LANE_BRANCH`, `LANE_WORKTREE`, `PORT`, `PORT_RANGE_START`,
  `PORT_RANGE_END`, `HOSTNAME`, `PROXY_HOSTNAME`, overlay `env`, and with
  `injectPrimaryPath` `PRIMARY_WORKTREE_PATH` (the main checkout).
- **Failure:** fail fast with the command and a stderr excerpt. A missing
  `scriptPath` fails.

### Teardown on archive, delete and reclaim

`cleanupLaneEnvironment` runs `docker compose -f <composePath> -p <project>
down --remove-orphans`. Delete and archive-and-reclaim get it through the
caller's `teardownEnv`; plain archive through the `setOnLaneArchivedEnvTeardown`
hook inside `laneService.archive` (one place for all archive callers),
best effort (`lane.archive.env_teardown_failed`). Every path resolves the
compose project the same way (`laneRuntimeLifecycle.buildLaneEnvTeardown` →
`resolveLaneOverlayContext`).

Unarchive is asymmetric: a recreated worktree re-runs the whole init
(`restoreRecreatedLaneRuntime`); a plain unarchive re-runs only Docker
(`restoreUnarchivedLaneDocker`), so surviving work is not clobbered, unless the
last init was incomplete.

### Cancelling and aborting

Init and cleanup for a lane share one queue. An archive or delete arriving
mid-init raises a flag read at each step boundary: remaining steps become
`skipped` ("Cancelled: lane is being torn down") and the run ends `failed`.
Running children are not killed.

`abortLaneEnvironment(laneId, worktreePath)` is the hard stop, used when a
new-lane launch is cancelled: it raises the same flag and kills
(`terminateProcessTree`) every tracked setup child inside the worktree
(`laneEnvironmentProcesses.trackChild`).

An init that does not finish every step records the lane in
`.ade/lane-env-init-incomplete.json` (machine-local). `wasLastInitIncomplete`
makes the next unarchive run the whole init. The marker clears when a later
init completes.

## Lane templates

A template packages a `LaneEnvInitConfig`, overlay overrides and a setup
script. Templates are stored per machine and do not sync. IPC:
`ade.lanes.templates.list / get / getDefault / setDefault / apply`.

CLI: `daex lanes templates list|show|save|default|apply|delete`;
`--machine <name>` targets another machine. The agent tools `create_lane` and
`import_lane` set the lane up like the dialog (`templateId`, else the default
template, else the project config) and wait; `skipSetup: true` leaves a plain
worktree. So `daex lanes create`, `create-from-linear`,
`batch-create-from-linear` and `daex chat create` with a new lane all get it;
`daex lanes create` takes `--template <id>` and `--no-template`. A failed setup
is returned in `setup.error`, not thrown.

The phone's chat paths that make a lane (Hub composer, Work new chat, Linear
launch) send `setup: "default"` with the sync `lanes.create` command; the host
answers at once and runs setup in the background (failure logged as
`sync.lane_default_setup_failed`). The phone's lane sheet keeps its own
template step.

## Main checkout packages

DAEX puts no packages in new lanes; a project that wants them uses a default
lane template. (Older lanes may still have `node_modules` links to the main
checkout; DAEX no longer makes them, because a shared folder let one lane's
install change every other lane.)

`lane.getDependencyStatus` (`daex lanes deps`) reads the main checkout of the
machine that owns it and never installs:

- **Lockfiles:** `git ls-files --cached --others --exclude-standard` for known
  names, so ignored folders and nested repos are never walked. At most 50
  (`truncated`). Without git, only the root.
- **State:** npm compares `package-lock.json` with
  `node_modules/.package-lock.json`; pnpm, yarn and Composer compare the
  lockfile time with their install record and remember the content last seen
  installed; CocoaPods compares `Podfile.lock` with `Pods/Manifest.lock`. bun,
  Bundler, Poetry, uv and Pipenv leave no record (`tracksInstall: false`): the
  first fingerprint counts as installed and `lane.acknowledgeDependencyStatus`
  accepts the current one. Cargo, Go and SwiftPM are never out of date. A
  missing install folder is "not installed".
- **Fingerprints:** `.ade/cache/dependency-baselines.json` (machine-local).
- **Cost:** one `git ls-files` plus a `stat` per lockfile; hashing only on
  change; cached 20 s.
- **`updateCommand`:** one line for a person to copy (POSIX or PowerShell).

Desktop notices (`useLaneDependencyBanners.tsx`), for the tab's machine:

- **Packages in the main checkout are out of date.** **Update** opens one
  tracked shell per out-of-date folder in the main checkout running only its
  install command, shows the first in Work, and checks every 15 s until
  installed. Dismissal lasts until a lockfile changes.
- **Set up a lane template**, when the project has lockfiles and no default
  template. **Set up with an agent** opens a chat draft in the main checkout
  with `laneTemplateSetupPrompt.ts`; snooze two weeks, or **Don't show again**
  per project and machine. Settings › Lane templates has the same button.

The web client has no sync command for the status and shows neither notice.

## Overlay policies

`LaneOverlayOverrides` adds `portRange`, `proxyHostname` and `envInit` to `env`,
`cwd` and `testSuiteIds`. `config/laneOverlayMatcher.ts` evaluates policies at
lane creation: `portRange` and `proxyHostname` last-wins; `envInit` merged by
`laneEnvInitMerge.ts` (lists concatenate, Docker shallow-merges, `setupScript`
last-wins).

## Port allocation

Lease-based and deterministic: `basePort = 3000`, `portsPerLane = 100`,
`maxPort = 9999`; slot N gets `[3000 + N*100, 3000 + N*100 + 99]`. A
`PortLease` is `active | released | orphaned`. Conflict detection runs after
orphan recovery; conflicts show in diagnostics with **Reassign port**. Bad
configs are rejected at start; `maxSlots()` clamps to zero. IPC:
`ade.lanes.port.getLease / listLeases / listConflicts / acquire / release /
recoverOrphans / event`.

## Hostname proxy

One HTTP reverse proxy on `proxyPort` (default 8080) routes by Host header:
`feat-auth.localhost:8080` → route → `127.0.0.1:<targetPort>`. `buildHostname`
adds `-lane` or `-<laneIdSlug>` when the slug is taken. `normalizeHostHeader`
handles IPv6 loopback forms. Browsers scope cookies by hostname, so lanes never
share sessions. `getPreviewInfo` / `openPreview` open the lane's URL. IPC:
`ade.lanes.proxy.getStatus / start / stop / addRoute / removeRoute /
getPreviewInfo / openPreview / event`.

## Runtime diagnostics

`runCheck(laneId)` builds a `LaneHealthCheck` (`healthy | degraded |
unhealthy | unknown`, with typed issues and suggested actions):

1. **Port responding:** `findResponsivePort` tries the route's target port, the
   lease start, then sweeps the range in parallel.
2. **Proxy route active:** route exists, proxy running, target matches the
   responding port; otherwise a specific `proxy-route-missing` issue.
3. **Port conflicts** involving the lane.

`deriveStatus`: no issues → `healthy` (or `degraded` in fallback);
`port-unresponsive` → `unhealthy`; else `degraded`. Proxy status unavailable
short-circuits to `unhealthy`. `activateFallback` / `deactivateFallback` are
idempotent and emit events. IPC: `ade.lanes.diagnostics.getStatus /
getLaneHealth / runHealthCheck / runFullCheck / activateFallback /
deactivateFallback / event`.
