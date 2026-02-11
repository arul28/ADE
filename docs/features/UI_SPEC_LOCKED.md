# UI Spec (Locked)

Last updated: 2026-02-11

This is the single source of truth for ADE’s UI structure. It locks:

- the app shell layout and tab structure
- the default Lanes “cockpit” layout (GitButler-like conflict visibility)
- the Terminals command center layout (scales to many sessions)
- Project Home (processes + test buttons + project management) layout (SoloTerm-like)
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

## 0.1 Visual Direction (MVP)

Locked aesthetic direction for MVP: **Maestro on Parchment** (Clean Paper).

Guidelines:

- **Clean Paper**: Solid, warm off-white background (`#FDFBF7`) with no noise or gradients. Like fresh stationer's paper.
- **High-Density Console**: Layouts should feel like a technical console. Full-height panes, explicit borders.
- **Crisp Borders**: Borders are 1px solid (`#DBD8D3`), acting as physical fold lines or dividers. No soft shadows.
- **Typography as Interface**:
  - **Headers**: Serif (`ui-serif`) for a "Document" / "Narrative" feel.
  - **Data/UI**: Monospace (`ui-monospace`) for high-density information, status, and controls.
- **Accents**: "Sealing Wax" Red & "Ink" Blue. Used for active states and critical alerts.
- **Physicality**: Elements should feel like distinct cards or sheets of paper resting on a desk.

## 1. App Shell

### 1.1 Main Regions (Console Layout)

- **Top bar** (Integrated, not floating)
  - Project selector (repo name)
  - Global status & Command palette trigger
  - *Note: Top bar separates the "Paper" flow from the OS chrome.*
- **Left nav** (Slim Icon Rail - 50px)
  - Vertical rail of icon-only tabs for high efficiency:
    - Projects
    - Lanes
    - Terminals
    - Conflicts
    - PRs
    - History
    - Settings
- **Main content** (Canvas)
  - Full-height, distinct pane separated from nav by a border.

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

### 2.2 Lane List Card/Row Requirements (Index Card)

Each lane row is designed as a **High-Density Index Card**:

- **Header**:
  - Name (Serif, Semibold) + Git Branch Icon
  - Description (Monospace, truncated)
- **Actions (Hover)**:
  - New Terminal, Open Folder, Rename, Archive (appear on card hover)
- **Footer (Metadata Grid)**:
  - **Sync**: Ahead/Behind counts (Monospace, directional arrows)
  - **State**: Dirty/Clean status (Uppercase Monospace)
  - **Activity**: Last active timestamp
- **Visuals**:
  - 1px border.
  - Active state: "Sealing Wax" accent border + subtle background tint.

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

## 4. Project Home Tab (Project-Global)

This tab is the “SoloTerm-like” project control plane and the default home for project-wide operations.

### 4.1 Header

- project summary (repo name/path)
- project management actions:
  - change/open repo (onboarding flow)
  - base branch selection (V1 if needed; MVP can be read-only)
  - open `.ade/` folder (escape hatch)
- stack button row:
  - named subset buttons (for example `Backend`, `Frontend`, `Full Stack`)
  - each button maps to an explicit process set
  - each button shows aggregate state (`running`, `partial`, `stopped`, `error`)
- “Start all” / “Stop all”

### 4.2 Managed Processes Panel

- list of managed processes
- per process:
  - start/stop/restart/kill
  - readiness indicator
  - ports (best-effort)
  - status details (PID, uptime, last exit)
  - logs viewer (tail + search)

Home tab requirement:

- user must be able to view every managed process and force-kill from this tab without leaving Home.

### 4.3 Test Suites Panel (Buttons)

- unit/integration/e2e/custom buttons
- last run status + duration + time
- ability to run suite:
  - globally
  - optionally in a lane context (later)

### 4.4 Config Surface

MVP: allow editing processes/stack buttons/tests via UI that writes to `.ade/` config files.

Config split:

- shared defaults in `.ade/ade.yaml`
- machine-specific overrides in `.ade/local.yaml`

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
- [ ] Project Home tab has managed processes + test buttons + basic project management
- [ ] Conflicts tab can run proposal flow and show diff/apply
- [ ] History tab shows timeline from operations table
