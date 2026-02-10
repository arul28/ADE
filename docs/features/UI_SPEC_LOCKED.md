# UI Spec (Locked)

Last updated: 2026-02-10

This is the single source of truth for ADE’s UI structure. It locks:

- the app shell layout and tab structure
- the default Lanes “cockpit” layout (GitButler-like conflict visibility)
- the Terminals command center layout (scales to many sessions)
- global Processes/test buttons layout (SoloTerm-like)
- Conflicts/PRs/History layouts and cross-links
- keyboard shortcuts (MVP set)

If another doc conflicts with this one, this doc wins.

Implementation note: reusable UI components are inventoried in `UI_COMPONENT_INVENTORY.md`.

## 0. UI Tech Decisions (Locked For MVP)

- Renderer framework: React + TypeScript
- Routing: React Router (deep links into lanes, conflicts, PRs)
- State management: Zustand (small, pragmatic)
- Layout/panes: `react-resizable-panels` (3-pane cockpit with persisted sizes)
- Terminal rendering: xterm.js (renderer), PTY in main process
- Graphs:
  - stacks: React Flow (or equivalent node/edge graph lib)
  - history graph (V1): reuse same graph lib
- Editor/diff:
  - MVP: Monaco editor + Monaco diff editor (lazy-loaded)
  - Quick edit is intentionally scoped (small edits, conflict marker edits)
- UI primitives: Radix UI (headless, accessible)
- Icons: Lucide
- Styling: Tailwind + CSS variables for theme tokens

## 1. App Shell

### 1.1 Main Regions

- **Top bar** (always visible)
  - Project selector (repo name + path)
  - Current base branch indicator (e.g., `main`)
  - Global status chips:
    - hosted sync status (idle/syncing/error)
    - job status (e.g., N running)
    - processes running (N running)
  - Global actions:
    - Command palette
    - Create lane
    - Start terminal (in selected lane)
- **Left nav** (tabs)
  - Lanes
  - Terminals
  - Processes
  - Conflicts
  - PRs
  - History
  - Settings
- **Main content** (tab content area)

### 1.2 Lane Context (Cross-Tab Overlap)

ADE has a “selected lane” concept that persists across tabs.

- When a lane is selected:
  - Terminals tab can default-filter to that lane (toggleable).
  - Conflicts tab can default-filter to that lane (toggleable).
  - PRs tab can default-focus that lane’s PR (toggleable).

Rule: the user should never be forced to leave the Lanes tab to do common lane actions.

## 2. Lanes Tab (Primary Cockpit)

### 2.1 Default 3-Pane Layout

- **Left pane**: Lanes + Stack Graph
  - lanes list (cards/rows)
  - optional stack graph overlay (toggle: list/graph/split)
- **Center pane**: Lane Detail (Changes)
  - default: diff view (working tree + staged + recent commits)
  - file tree toggle
  - quick edit (small edits only)
- **Right pane**: Lane Inspector (sub-tabs)
  - Terminals
  - Packs
  - Conflicts
  - PR

All panes are resizable. Layout is persisted per project.

### 2.2 Lane List Card/Row Requirements

Each lane row must show at-a-glance:

- name + optional description
- dirty/clean indicator
- ahead/behind counts vs base
- test status badge (last run)
- PR status badge (if linked)
- conflict badges (GitButler-like):
  - predicted conflicts badge + count
  - active conflict badge
  - blocked-by-parent badge (if stacked)

Primary row actions:

- new terminal
- sync lane
- open conflicts window
- open PR panel

Secondary (overflow):

- rename
- archive
- open folder

### 2.3 Lane Inspector Sub-Tabs

**Terminals**

- shows the lane’s sessions (tabs)
- “new session” using template (goal + tool)
- post-session “delta” summary (files touched, failures) pinned under session title

**Packs**

- lane pack viewer (deterministic + narrative timestamps)
- project pack quick link (opens in modal)

**Conflicts**

- shows predicted/active conflict summary for the lane
- CTA: “Open Conflicts Window” (deep link into Conflicts tab with lane filter)

**PR**

- create/link PR
- push branch
- checks/review summary
- “Update PR description” from packs

## 3. Terminals Tab (Command Center)

The Terminals tab is optimized for high session volume.

### 3.1 Default View: List

Rows include:

- lane name
- session title/goal
- status (running/exited/failure)
- last output preview (bounded)
- start time / duration

Controls:

- filters (lane, status, tool, has errors)
- pin sessions
- jump-to-lane (opens Lanes tab focused on lane + session)

### 3.2 Secondary View: Grid (V1 if needed)

Grid view shows many sessions at once but must avoid rendering too many live xterm instances.

Rule:

- only render full xterm for focused sessions
- others render lightweight “preview frames” from buffered output

See `TERMINAL_COMMAND_CENTER.md` for session model specifics.

## 4. Processes Tab (Project-Global)

This tab is the “SoloTerm-like” project control plane.

### 4.1 Header

- project summary (repo name/path)
- stack profile selector (dev/test/e2e) (if multiple)
- “Start all” / “Stop all”

### 4.2 Managed Processes Panel

- list of managed processes
- per process:
  - start/stop/restart
  - readiness indicator
  - ports (best-effort)
  - logs viewer (tail + search)

### 4.3 Test Suites Panel (Buttons)

- unit/integration/e2e/custom buttons
- last run status + duration + time
- ability to run suite:
  - globally
  - optionally in a lane context (later)

### 4.4 Config Surface

MVP: allow editing processes/tests via UI that writes to `.ade/` config files (or direct DB with export).

See `PROCESSES_AND_TESTS.md`.

## 5. Conflicts Tab (Project Aggregate)

The Conflicts tab aggregates predicted and active conflicts across lanes.

Left side list:

- lanes with predicted conflicts
- lanes with active conflicts
- stack blockers highlighted

Right side content:

- conflict pack viewer
- “Generate proposals” (hosted agent) and progress
- proposals list + diff viewer
- apply proposal (creates commit) + run tests (local) + update packs

Rule:

- proposals are triggered from here (or lane inspector) but are not auto-run merely because a conflict is predicted.

## 6. PRs Tab (Project Aggregate)

Left:

- stacked PR chains (aligned to lane stack graph)
- parallel PR list (non-stacked)

Right:

- selected PR detail (checks, reviews, description)
- “Land stack” entry point (V1)

See `PULL_REQUESTS_GITHUB.md`.

## 7. History Tab (ADE Work Graph)

MVP:

- timeline of events:
  - terminal sessions ended
  - lane sync operations
  - conflicts predicted/active/resolved
  - proposal applied
  - PR events
- filters by lane/event type
- event detail pane with jump links

V1:

- graph view (stack + operations) with conflict markers

See `HISTORY_GRAPH.md`.

## 8. Settings Tab

MVP settings:

- hosted agent enable/disable
- mirror exclude patterns
- process/test configuration location and export/import
- keyboard shortcuts list

## 9. Keyboard Shortcuts (Locked MVP Set)

Default shortcuts (macOS uses Cmd, others Ctrl):

- Command palette: `Cmd/Ctrl+K`
- New lane: `Cmd/Ctrl+N`
- New terminal (selected lane): `Cmd/Ctrl+T`
- Toggle left pane: `Cmd/Ctrl+\\`
- Toggle right inspector: `Cmd/Ctrl+;`
- Next/prev lane: `Cmd/Ctrl+Alt+Down` / `Cmd/Ctrl+Alt+Up`
- Open conflicts for selected lane: `Cmd/Ctrl+Shift+C`
- Open PR panel for selected lane: `Cmd/Ctrl+Shift+P`

## 10. Dev Checklist (UI Lock Compliance)

- [ ] Tabbed app shell matches locked tabs
- [ ] Lanes tab defaults to 3-pane layout with inspector tabs
- [ ] Conflict badges appear in lane rows (predicted/active/blocked)
- [ ] Terminals tab has global list with filters and jump-to-lane
- [ ] Processes tab has managed processes + test buttons
- [ ] Conflicts tab can run proposal flow and show diff/apply
- [ ] History tab shows timeline from operations table
