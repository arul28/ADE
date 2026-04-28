# Project Home

ADE's landing surface for the currently open project. Combines a
welcome/open-repo screen for fresh installs with a per-lane runtime
dashboard — managed processes, stacks, tests, and quick actions — for
loaded projects. The same surface (`RunPage`) is also the Run tab,
because "the project's home" and "the project's execution substrate"
have converged.

## Source file map

Renderer:

- `apps/desktop/src/renderer/components/run/RunPage.tsx` — top-level
  page. Welcome screen + per-lane runtime dashboard in one component.
- `apps/desktop/src/renderer/components/run/LaneRuntimeBar.tsx` —
  the bar at the top with "Running in: [lane]" selector, Start All /
  Stop All, stack buttons with aggregate status.
- `apps/desktop/src/renderer/components/run/RunStackTabs.tsx` — tab
  strip for switching between stacks and the "all processes" view.
- `apps/desktop/src/renderer/components/run/CommandCard.tsx` — the
  per-process card. Accepts the full `ProcessRuntime[]` for its
  `(laneId, processId)` (so concurrent/historical runs all show),
  plus the lane list, group list, selected lane, and an
  `onSelectLane` callback for the per-card lane picker.
- `apps/desktop/src/renderer/components/run/ProcessMonitor.tsx` —
  per-process log viewer with search, auto-scroll, and focus target
  management. Tracks per-`runId` focus (not per `processId`) so a
  card with multiple runs can drill into each one independently.
  Handles both managed processes and run-shell sessions.
- `apps/desktop/src/renderer/components/run/RunNetworkPanel.tsx` —
  drawer showing port allocations, proxy status, preview URLs.
- `apps/desktop/src/renderer/components/run/AddCommandDialog.tsx` —
  add/edit modal for processes, stacks, and process groups. The
  advanced panel exposes existing group chips plus a "new groups,
  comma separated" input that materializes new `ProcessGroupDefinition`
  entries on save.
- `apps/desktop/src/renderer/components/run/QuickRunMenu.tsx` —
  compact quick-launch menu from the command palette.
- `apps/desktop/src/renderer/components/run/processUtils.ts` —
  helpers for status aggregation, restart policy labels, etc.

Related pages for the broader "home" experience:

- `apps/desktop/src/renderer/components/app/AppShell.tsx` — top-level
  nav, routes `/run` to `RunPage`.
- `apps/desktop/src/renderer/components/app/TabNav.tsx` — nav rail
  where the Run tab is pinned.
- `apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx`
  — first-run wizard that a new project must pass through before
  `RunPage` becomes meaningful. See
  [../onboarding-and-settings/first-run.md](../onboarding-and-settings/first-run.md).

Main process (the substrate):

- `apps/desktop/src/main/services/processes/processService.ts` —
  lifecycle, readiness, restart. See
  [../terminals-and-sessions/pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md).
- `apps/desktop/src/main/services/config/projectConfigService.ts` —
  config read/merge/save for `.ade/ade.yaml` + `.ade/local.yaml`.
- `apps/desktop/src/main/services/lanes/portAllocationService.ts` —
  per-lane port leases.
- `apps/desktop/src/main/services/lanes/laneProxyService.ts` —
  hostname proxy routing and preview URL management.
- `apps/desktop/src/main/services/lanes/runtimeDiagnosticsService.ts`
  — aggregated lane runtime health.
- `apps/desktop/src/main/services/agentTools/` — detects installed
  agent CLI tools (Claude Code, Codex, Cursor, Aider, Continue).
- `apps/desktop/src/main/services/projects/projectBrowserService.ts`
  — serves the Command Palette project browser: expands `~`, handles
  platform-appropriate relative / absolute paths, lists matching
  subdirectories with `.git` detection (concurrency-limited, capped at
  `limit` with 500 max), and resolves any exact-directory match up to
  an openable repo root via `resolveRepoRoot()`. Windows-style paths
  are rejected on non-Windows hosts.
- `apps/desktop/src/main/services/projects/projectDetailService.ts` —
  produces the palette's preview pane: branch name, dirty-file count,
  ahead/behind counts, last commit (subject / ISO date / short sha),
  README excerpt (first ~1,600 chars, trimmed on paragraph / sentence
  boundary), top-four languages by file count (extension-mapped,
  depth-2 walk capped at 2,000 files), subdirectory count, and — when
  the path matches a recent-projects row in the global state file —
  lane count and last-opened timestamp.
- `apps/desktop/src/main/services/projects/projectIconResolver.ts` —
  best-effort icon discovery and user-overridable selection for a
  project root. Discovery walks a fixed list of base directories
  (`./`, `app/`, `src/`, `src/app/`, `public/`, `assets/`, `build/`)
  combined with one-deep child directories (and one-deep
  `apps/*` / `packages/*` for monorepos), checking a curated list of
  filenames (`macIcon.png`, `app-icon.{png,svg,webp}`,
  `icon.{png,svg,ico,webp}`, `logo.{png,svg,webp}`,
  `favicon.{png,svg,ico}`) and any image file whose name contains
  `icon`/`logo` or equals `favicon`. Heavy directories
  (`.ade`, `.git`, `.next`, `.open-next`, `coverage`, `dist`,
  `node_modules`, `out`) are skipped. Candidates are scored: `macicon`
  / `app-icon` win first, then `icon`, then `logo`, then any name
  containing `icon`, then `favicon`; `/app/` and `/src/app/` placement
  boosts score, `apps/desktop/build/` boosts further (so ADE's own
  app icon is preferred when developing ADE), `/docs/` and
  `/mintlify/` paths are demoted. PNG > SVG > ICO > WebP for ties,
  shallower paths win, alphabetical tiebreak last. When automatic
  discovery returns nothing, the resolver scans `index.html`,
  `public/index.html`, the TanStack Router root files
  (`app/routes/__root.tsx`, `src/routes/__root.tsx`), `app/root.tsx`,
  `src/root.tsx`, and `src/index.html` for a `<link rel="icon">` href
  (HTML attribute or JS-object form, local hrefs only) and resolves
  it against `public/` or the project root.

  An explicit user choice in `.ade/ade.yaml` (`project.iconPath`
  relative to the project root) is honoured first. `iconPath: null`
  disables automatic detection entirely so the project deliberately
  shows the fallback glyph; an unknown / removed file silently falls
  through to detection. `setProjectIconOverride(rootPath, iconPath)`
  validates the path stays inside the project root and points at a
  supported file, then writes `project.iconPath` into
  `.ade/ade.yaml`. `removeProjectIconOverride(rootPath)` writes
  `iconPath: null`. Both helpers return the freshly resolved
  `ProjectIcon` so the renderer can update the cache in one round
  trip.

  `resolveProjectIcon(rootPath)` returns
  `{ dataUrl, sourcePath, mimeType }`: any matched file under 1 MB is
  base64-encoded as a data URL (svg / ico / png / jpeg / webp), larger
  files report only `sourcePath`. Path traversal outside the project
  root is blocked end-to-end (probe paths run through
  `resolvePathWithinRoot`, so symlinks pointing outside the worktree
  silently fail to match instead of leaking files).
- `apps/desktop/src/main/services/projects/projectIconResolver.test.ts`
  — vitest coverage: direct file matches, HTML link scrapes,
  escape-attempt rejection, base64 data-URL emission, scoring
  preferences, and round-tripping `setProjectIconOverride` /
  `removeProjectIconOverride` against `.ade/ade.yaml`.

Shared types:

- `apps/desktop/src/shared/types/config.ts` — `ProcessDefinition`,
  `ProcessRuntime`, `StackButtonDefinition`, `TestSuiteDefinition`,
  `LaneOverlayPolicy`, `ProxyConfig`, `PortLease`, `LanePreviewInfo`.
- `apps/desktop/src/shared/types/core.ts` — `ProjectIcon` (`{ dataUrl,
  sourcePath, mimeType }`), the return shape of `resolveProjectIcon`
  consumed by the TopBar tab strip and the iOS project list.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.processes`,
  `window.ade.project`, `window.ade.tests`.

## Composition

### Welcome screen

Rendered by `RunPage` when `useAppStore((s) => s.showWelcome)` is true
— typically when no project is open or the app was launched without
a prior session. Shows:

- ADE logo with a subtle pulse-glow
- "OPEN PROJECT" primary button → opens the Command Palette in
  `intent="project-browse"` mode (see the next subsection)
- recent projects list from `window.ade.project.listRecent()`, with
  display name, host path, lane count, and last-opened timestamp

Clicking a recent project calls `appStore.switchProjectToPath(path)`
which goes through the project open flow
(`adeProjectService.openProject`).

### Command Palette project browser

The Command Palette (`renderer/components/app/CommandPalette.tsx`) is a
dual-mode Radix dialog. In default mode it fuzzy-filters navigation /
action commands; in `intent="project-browse"` mode it becomes a
keyboard-first project opener. The palette mounts from two places:

- **`AppShell`** — global ⌘K shortcut opens the palette in default
  mode. The "Open project" / "Open another project" command switches
  it into `project-browse` mode without closing.
- **`WelcomeScreen` in `RunPage`** — the "OPEN PROJECT" button mounts
  a dedicated palette instance with `intent="project-browse"` so the
  empty-project state skips straight to the browser.

Project-browse behavior:

1. The input field debounces into `window.ade.project.browseDirectories({
   partialPath, cwd, limit })`. `cwd` is the active project root
   (so `../` is a usable starting point); if no project is open the
   default input is `~/`.
2. Results render as a list: a "Go up" row if the current directory
   has a parent, then matching subdirectories (alphabetically sorted,
   `.git`-detected marked with a branch icon).
3. A debounced `window.ade.project.getDetail(target)` populates a
   preview pane alongside the list — branch, dirty/ahead/behind,
   last commit, README excerpt (rendered through `react-markdown` +
   `remark-gfm`), language swatches, lane count, last-opened.
4. Enter activates the highlighted directory (walks into it). ⌘/Ctrl+
   Enter opens the openable project root (the first ancestor with a
   `.git` entry).
5. Drag-and-drop onto the palette uses
   `window.ade.project.getDroppedPath(file)` to resolve the dropped
   folder's absolute path and then opens it.
6. A "Choose folder…" escape hatch falls through to the OS directory
   picker via `window.ade.project.chooseDirectory`.

### Per-lane runtime dashboard

When a project is open and not in welcome state:

1. **LaneRuntimeBar** — top row with the currently-selected "Running
   in" lane. This uses `runLaneId ?? selectedLaneId` so users can
   override the Run tab's lane without changing the globally-selected
   lane. Aggregate status badges, stack buttons, Start All / Stop All.
2. **RunStackTabs** — horizontal tab strip. The leftmost tab is "All
   processes"; subsequent tabs correspond to
   `config.effective.stackButtons`. Each tab shows an aggregate
   status indicator and a process count.
3. **Group filter chip row** — a second horizontal row directly under
   the stack tabs, populated from `config.effective.processGroups`.
   The first chip is "All groups"; each subsequent chip corresponds
   to a `ProcessGroupDefinition` and displays the count of processes
   that list its ID in `groupIds`. Selecting a chip narrows the grid
   to processes with that group. Groups and stacks compose: the
   visible cards are the intersection of the active stack tab and the
   active group chip.
4. **Commands grid** — renders one `CommandCard` per `ProcessDefinition`
   matching the active stack + group filter. Each card owns:
   - name + description from config
   - a lane picker (bound to `commandLaneMap` persisted per project);
     switching lanes here rebinds the card's runtime view without
     changing the global lane selection
   - aggregate status pulled from the newest `ProcessRuntime` for
     that `(laneId, processId)` — status dot (gray/stopped,
     yellow/starting or degraded, green/running, red/crashed),
     pid, uptime, listening ports, active-run count when multiple
     runs are live
   - action buttons (Run / Stop) — Run always starts a fresh run with
     its own `runId`; Stop targets the most recent active run (or
     all active runs when the user confirms, via the overflow menu)
   - overflow menu (Edit, Delete)
5. **ProcessMonitor** — log viewer panel. Its focus target is a
   `runId` or a run-shell session ID, not just a `processId`, so the
   user can drill into a specific historical invocation. Shows live
   stdout/stderr from the focused run, supports in-log search, auto-
   scroll, and also handles user-launched run-shell sessions
   (one-off commands via the Run tab).
6. **RunNetworkPanel** (optional drawer) — shows port leases, proxy
   routes, and preview URLs for the current lane. Pulls from
   `window.ade.ports.*` and `window.ade.proxy.*`.
7. **AddCommandDialog** — full modal for adding or editing a process.
   Covers command, args, cwd, env, restart policy, readiness config
   (none / port / logRegex), dependency list, graceful shutdown
   timeout, stack assignment, and process-group membership (existing
   groups as chips plus a free-form "new groups, comma separated"
   field that creates `ProcessGroupDefinition` entries on save).
   Saves back to config via `projectConfig.save`.

### Quick run menu

`QuickRunMenu` is reachable through the command palette and provides
fuzzy-search over:

- processes (start/stop)
- test suites (run)
- stacks (start/stop)
- recent run-shell commands

Scoped to the current run lane.

### Project icons

Each project gets a best-effort icon resolved by
`projectIconResolver`. The renderer asks for it on demand through
`window.ade.project.resolveIcon(rootPath)` (handler:
`IPC.projectResolveIcon` →
`ipcMain.handle("ade.project.resolveIcon", …)`); the desktop TopBar
project tab strip caches the result per `rootPath` in a module-local
`Map` so a tab swap doesn't re-scan the disk. When the resolver finds
no icon (or the file is over the 1 MB cap), the tab falls back to the
`Folder` Phosphor glyph. Missing-project tabs skip the lookup
entirely.

The TopBar tab also exposes a small icon-override dialog: clicking the
icon button opens a Radix dialog with **Choose icon…** and **Reset to
auto-detected**. **Choose icon…** calls
`window.ade.project.chooseIcon(rootPath)` which opens an Electron
file picker (filtered to `ico`/`jpeg`/`jpg`/`png`/`svg`/`webp`); the
selected path is validated (must live inside the project root and be a
supported image type), persisted to `.ade/ade.yaml` under
`project.iconPath`, and the freshly resolved icon is returned to the
renderer. **Reset to auto-detected** calls
`window.ade.project.removeIcon(rootPath)`, which writes
`project.iconPath: null` so the project deliberately shows the
fallback glyph (use the file picker to pick a new one to re-enable
detection or override). The override is committed to `.ade/ade.yaml`
(shared, committed) so collaborators see the same project icon.

The mobile companion gets the icon through a dedicated path: the host's
`mobileProjectSummaryForContext` / `mobileProjectSummaryForRecent` in
`apps/desktop/src/main/main.ts` runs `resolveProjectIcon` on every
project entry, downsamples it to 64×64 via Electron's
`nativeImage.createFromPath(...).resize(...)` (PNG fallback for SVG /
ICO sources that `nativeImage` can't read), and ships the resulting
data URL to iOS as `MobileProjectSummary.iconDataUrl`. The iOS
`ProjectHomeView` renders that string as the project tile artwork.

## Data model

The dashboard is driven by:

- `ProjectConfigSnapshot.effective.processes: ProcessDefinition[]`
- `ProjectConfigSnapshot.effective.processGroups: ProcessGroupDefinition[]`
- `ProjectConfigSnapshot.effective.stackButtons: StackButtonDefinition[]`
- `ProjectConfigSnapshot.effective.testSuites: TestSuiteDefinition[]`
- `ProcessRuntime[]` aggregated across every lane that appears in
  `commandLaneMap` (because each command card can point at a
  different lane). `listRuntime(laneId)` includes every in-memory
  run for that lane — active ones and recent history — so the card
  sort-picks the newest run for its status.
- live `ProcessEvent` stream (`ade.processes.event`). Runtime events
  now carry `runId`; log events carry `runId`, `laneId`, and
  `processId`, so filters match the specific invocation rather than
  coalescing history.

Config comes from `projectConfigService`, which merges
`.ade/ade.yaml` (shared, committed) with `.ade/local.yaml` (local,
gitignored) into an effective config. See
[../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
for the schema.

## Runtime lifecycle (high level)

1. Page mounts. `refreshDefinitions` loads config + definitions in
   parallel.
2. The runtime refresh fans out across every distinct lane ID in
   `commandLaneMap` (plus any lanes hosting active run-shell
   sessions) with `processes.listRuntime(laneId)` calls in parallel,
   concatenating the results into a single `runtime: ProcessRuntime[]`.
3. The page subscribes to `processes.onEvent` without filtering out
   `runId`s — the ProcessMonitor and CommandCard narrow by
   `(laneId, processId, runId)` as needed.
4. Start/stop/restart calls go through `window.ade.processes.*`; the
   next `runtime` event confirms or corrects. Stop/kill resolve to
   `null` when no active run exists for the card, which is treated
   as a no-op.
5. When the user switches lanes, the page disposes any user-launched
   run-shell sessions (`disposeRunShellSessions`) and re-runs
   `refreshRuntime`.
6. Per-command lane selection is persisted per project under
   `localStorage` key `ade.runPageLaneState.v1` (via the
   `PersistedRunPageLaneState` helpers) so the grid restores its
   per-card lane assignments on reopen.

## Loading model notes

The Run page hydrates in phases rather than as a cold boot on every
lane switch:

- project config and process/test definitions load independently of
  runtime state
- selected-lane runtime refreshes when the lane changes without
  reloading lane-independent metadata
- initial runtime hydration is deferred slightly behind first render
  (the 140 ms timer above)
- config saves refresh only the dependent slices instead of
  remounting the full page

## Gotchas

- `RunPage` owns both welcome and dashboard behavior; `showWelcome`
  is the gate. Side effects (e.g. process event subscription) still
  fire during welcome but return early, so the event bus stays clean.
- `runLaneId` lets Run override `selectedLaneId` without changing the
  global selection. Always read `runLaneId ?? selectedLaneId` when
  looking up runtime state.
- User-launched "run shell" sessions are tracked separately
  (`runShellSessions` in renderer state) and disposed on lane switch
  / page unmount. They share the `terminal_sessions` table but are
  tagged with `tool_type = "run-shell"`.
- Each command card can point at a different lane. `refreshRuntime`
  therefore fans out across every lane in `commandLaneMap`;
  subscribing to `processes.onEvent` without a lane filter is the
  correct default, because filtering out other lanes would hide the
  cards that target them.
- The stack aggregate status is computed in the renderer
  (`processUtils.ts`). It is not authoritative — the ultimate truth
  is the per-process `ProcessRuntime.status`.
- The ProcessMonitor log viewer is focused by `runId` (for managed
  processes) or session ID (for run-shell sessions). Passing only
  `processId` picks the newest run; if you need a specific historical
  run, pass the `runId` explicitly.
- `processes.getLogTail(...)` also accepts `runId` — without it the
  main process picks the most recent run for the `(laneId, processId)`.
- Groups are a UI filter, not a start-order contract. Never assume
  a process's group membership implies a `dependsOn` or a stack
  relationship.

## Cross-links

- Processes and stacks lifecycle:
  [../terminals-and-sessions/pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md)
- Onboarding and config:
  [../onboarding-and-settings/](../onboarding-and-settings/)
- Preview URLs, proxy, port leases: see the Lanes feature and the
  `laneProxyService`/`portAllocationService`.
- Agent tools detection (Claude Code, Codex, Cursor, Aider,
  Continue): `apps/desktop/src/main/services/agentTools/`.
