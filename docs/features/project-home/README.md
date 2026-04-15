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
  ~1,300 lines.
- `apps/desktop/src/renderer/components/run/LaneRuntimeBar.tsx` —
  the bar at the top with "Running in: [lane]" selector, Start All /
  Stop All, stack buttons with aggregate status.
- `apps/desktop/src/renderer/components/run/RunStackTabs.tsx` — tab
  strip for switching between stacks and the "all processes" view.
- `apps/desktop/src/renderer/components/run/CommandCard.tsx` — the
  per-process card (name, status dot, readiness, pid, ports, uptime,
  action buttons).
- `apps/desktop/src/renderer/components/run/ProcessMonitor.tsx` —
  per-process log viewer with search, auto-scroll, and focus target
  management. Handles both managed processes and run-shell sessions.
- `apps/desktop/src/renderer/components/run/RunNetworkPanel.tsx` —
  drawer showing port allocations, proxy status, preview URLs.
- `apps/desktop/src/renderer/components/run/AddCommandDialog.tsx` —
  add/edit modal for processes and stacks.
- `apps/desktop/src/renderer/components/run/QuickRunMenu.tsx` —
  compact quick-launch menu from the command palette.
- `apps/desktop/src/renderer/components/run/RunSidebar.tsx` — optional
  side rail for process groupings.
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

Shared types:

- `apps/desktop/src/shared/types/config.ts` — `ProcessDefinition`,
  `ProcessRuntime`, `StackButtonDefinition`, `TestSuiteDefinition`,
  `LaneOverlayPolicy`, `ProxyConfig`, `PortLease`, `LanePreviewInfo`.

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
3. **Processes grid / list** — renders a `CommandCard` per
   `ProcessDefinition` filtered by the active stack tab. Each card
   shows:
   - name + description from config
   - status dot (gray/stopped, yellow/starting or degraded,
     green/running, red/crashed)
   - readiness state (`unknown`, `ready`, `not_ready`)
   - pid and uptime when running
   - listening ports (when defined via port readiness)
   - action buttons (Start, Stop, Restart, Kill)
   - overflow menu (Edit, Move to stack, Delete)
4. **ProcessMonitor** — log viewer panel pinned at the bottom or on
   the side. Shows live stdout/stderr from the focused process and
   supports in-log search, filter, and auto-scroll. Also handles
   user-launched "run shell" sessions (one-off commands via the Run
   tab).
5. **RunNetworkPanel** (optional drawer) — shows port leases, proxy
   routes, and preview URLs for the current lane. Pulls from
   `window.ade.ports.*` and `window.ade.proxy.*`.
6. **AddCommandDialog** — full modal for adding or editing a process.
   Covers command, args, cwd, env, restart policy, readiness config
   (none / port / logRegex), dependency list, graceful shutdown
   timeout. Saves back to config via `projectConfig.save`.

### Quick run menu

`QuickRunMenu` is reachable through the command palette and provides
fuzzy-search over:

- processes (start/stop)
- test suites (run)
- stacks (start/stop)
- recent run-shell commands

Scoped to the current run lane.

## Data model

The dashboard is driven by:

- `ProjectConfigSnapshot.effective.processes: ProcessDefinition[]`
- `ProjectConfigSnapshot.effective.stackButtons: StackButtonDefinition[]`
- `ProjectConfigSnapshot.effective.testSuites: TestSuiteDefinition[]`
- `ProcessRuntime[]` for the selected lane (from
  `window.ade.processes.listRuntime(laneId)`)
- live `ProcessEvent` stream (`ade.processes.event`) filtered to
  runtime-only events with matching lane

Config comes from `projectConfigService`, which merges
`.ade/ade.yaml` (shared, committed) with `.ade/local.yaml` (local,
gitignored) into an effective config. See
[../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
for the schema.

## Runtime lifecycle (high level)

1. Page mounts. `refreshDefinitions` calls
   `processes.listDefinitions` once.
2. The runtime refresh is deferred ~140 ms behind first paint, then
   calls `processes.listRuntime(laneId)` to populate initial state.
3. The page subscribes to `processes.onEvent`, filtering runtime
   events to the current effective lane.
4. Start/stop/restart calls go through `window.ade.processes.*` and
   update the runtime map optimistically; the next runtime event
   confirms or corrects.
5. When the user switches lanes, the page disposes any user-launched
   run-shell sessions (`disposeRunShellSessions`) and calls
   `refreshRuntime` again.

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
- Process events for other lanes are intentionally ignored by the
  filter in `onEvent`; do not rely on Run showing state for a
  non-selected lane.
- The stack aggregate status is computed in the renderer
  (`processUtils.ts`). It is not authoritative — the ultimate truth
  is the per-process `ProcessRuntime.status`.
- The ProcessMonitor log viewer reads `processes.getLogTail(...)`
  for initial hydration and then streams from the event bus. If you
  truncate a log file out-of-band, the viewer will briefly double-up
  lines until the next tail fetch.

## Cross-links

- Processes and stacks lifecycle:
  [../terminals-and-sessions/pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md)
- Onboarding and config:
  [../onboarding-and-settings/](../onboarding-and-settings/)
- Preview URLs, proxy, port leases: see the Lanes feature and the
  `laneProxyService`/`portAllocationService`.
- Agent tools detection (Claude Code, Codex, Cursor, Aider,
  Continue): `apps/desktop/src/main/services/agentTools/`.
