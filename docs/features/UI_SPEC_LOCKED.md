# UI Spec (Locked)

Last updated: 2026-02-11

This is the single source of truth for ADE’s UI structure. It locks:

- the app shell layout and tab structure
- the default Lanes “cockpit” layout (GitButler-like conflict visibility)
- the Files workbench (IDE-like explorer/editor)
- workspace topology and canvas overview behavior
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

Locked aesthetic direction for MVP supports two first-class themes:

- **Clean Paper (Light)**: Maestro on Parchment, warm off-white stationer's paper.
- **Bloomberg Terminal (Dark)**: high-contrast terminal-like dark mode with dense operational readability.

Guidelines:

- **High-Density Console**: Layouts should feel like a technical console. Full-height panes, explicit borders.
- **Crisp Borders**: Borders are 1px solid and act as physical fold lines or dividers. No soft shadows.
- **Typography as Interface**:
  - **Headers**: Serif (`ui-serif`) for a "Document" / "Narrative" feel.
  - **Data/UI**: Monospace (`ui-monospace`) for high-density information, status, and controls.
- **Theme Switching**:
  - UI can switch between light/dark without reload.
  - Theme preference persists locally per machine/user.
  - Tokenized colors must preserve status readability in both themes.
- **Physicality**: Elements should feel like distinct cards or sheets/panels, regardless of theme.

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
    - Files
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
Rule: when user opens Files tab, default scope should follow selected lane (toggleable to primary workspace).

## 2. Lanes Tab (Primary Cockpit)

### 2.1 Default 3-Pane Layout

- **Left pane**: Lanes + Topology Views
  - lanes list (cards/rows)
  - topology mode toggle: list/stack graph/workspace canvas
- **Center pane**: Lane Detail (Changes) or Workspace Canvas
  - default: diff view (working tree + staged + recent commits)
  - file tree toggle
  - quick edit (small edits only)
  - workspace canvas mode (overview interaction)
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
  - **Type**: Primary/Worktree/Attached lane
  - **Sync**: Ahead/Behind counts (Monospace, directional arrows)
  - **State**: Dirty/Clean status (Uppercase Monospace)
  - **Risk**: Conflict/Overlap risk score
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
- switch branch
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

### 2.4 In-App Git Operations

Lanes must expose a source-control action surface so routine git tasks can be done without leaving ADE:

- stage/unstage file actions
- commit/amend
- stash operations
- sync (merge/rebase)
- revert/cherry-pick
- push/force-with-lease
- branch create/switch/rename/delete

Safety requirements:

- branch switch with dirty state prompts commit/stash/discard flow
- branch switch while sessions are running requires explicit force confirmation
- primary lane can enforce protected-branch warning/guardrails

Destructive actions must use explicit confirmations and show lane/branch target.

### 2.5 Workspace Graph Canvas

Workspace canvas mode is an infinite-canvas style topology overview:

- main repository directory (`Primary Lane`) node centered
- outgoing edges to active and stale worktree lanes
- stacked parent/child links rendered on top of workspace edges
- node status overlays:
  - dirty/clean
  - ahead/behind
  - tests
  - PR state
  - conflict risk
- edge status overlays:
  - merge simulation result (`clean`, `auto-merge`, `conflicts`)
  - overlap risk severity

Interactions:

- zoom/pan
- click node to focus lane detail
- click edge to open merge simulation detail
- filter to active/stale/archived/risky

## 3. Files Tab (Explorer + Editor Workbench)

The Files tab is a dedicated IDE-like editing surface for cross-workspace browsing and editing.

### 3.1 Files Layout

- **Left pane**: Workspace Scope + File Explorer
  - scope selector: primary workspace, lane worktrees, attached worktrees
  - searchable file tree rooted at selected scope
- **Center pane**: Editor / Diff Tabs
  - Monaco editor tabs
  - diff tabs (working tree, staged, commit)
  - conflict-marker editing mode
- **Right pane**: Context Actions
  - file git status
  - quick stage/unstage
  - jump-to-lane / jump-to-conflicts
  - copy snippet for agent

### 3.2 Files Guardrails

- Always show active workspace path + branch in header.
- Warn before editing protected primary branch if policy enabled.
- Save writes are atomic and scoped to active workspace.
- File operations update lane status/conflict radar promptly.

## 4. Terminals Tab (Command Center)

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

## 5. Project Home Tab (Project-Global)

This tab is the “SoloTerm-like” project control plane and the default home for project-wide operations.

### 4.1 Header

- project summary (repo name/path)
- project management actions:
  - change/open repo (onboarding flow)
  - base branch selection (V1 if needed; MVP can be read-only)
  - open `.ade/` folder (escape hatch)
- theme toggle (dark/light)
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

## 6. Conflicts Tab (Project Aggregate)

The Conflicts tab aggregates predicted and active conflicts across lanes.

Left side list:

- lanes with predicted conflicts
- lanes with active conflicts
- stack blockers highlighted

Right side content:

- pairwise lane risk matrix (all active lanes)
- merge simulation panel (source lane -> target lane/branch)
- conflict pack viewer
- “Generate proposals” (hosted agent) and progress
- proposals list + diff viewer
- apply proposal (creates commit) + run tests (local) + update packs

Rule:

- proposals are triggered from here (or lane inspector) but are not auto-run merely because a conflict is predicted.
- realtime overlap indicators should update within seconds of staged/dirty changes (coalesced).

## 7. PRs Tab (Project Aggregate)

Left:

- stacked PR chains (aligned to lane stack graph)
- parallel PR list (non-stacked)

Right:

- selected PR detail (checks, reviews, description)
- “Land stack” entry point (V1)

See `PULL_REQUESTS_GITHUB.md`.

## 8. History Tab (ADE Work Graph)

MVP:

- timeline of events:
  - terminal sessions ended
  - checkpoints created
  - lane sync operations
  - conflicts predicted/active/resolved
  - plan versions created/activated
  - proposal applied
  - PR events
- filters by lane/event type
- event detail pane with jump links

Additional MVP view:

- feature history:
  - aggregates sessions/checkpoints/plan revisions per issue or feature key

V1:

- graph view (stack + operations) with conflict markers

See `HISTORY_GRAPH.md`.

## 9. Settings Tab

MVP settings:

- hosted agent enable/disable
- mirror exclude patterns
- process/test configuration location and export/import
- keyboard shortcuts list

## 10. Keyboard Shortcuts (Locked MVP Set)

Default shortcuts (macOS uses Cmd, others Ctrl):

- Command palette: `Cmd/Ctrl+K`
- New lane: `Cmd/Ctrl+N`
- Open Files tab: `Cmd/Ctrl+Shift+F`
- New terminal (selected lane): `Cmd/Ctrl+T`
- Toggle left pane: `Cmd/Ctrl+\\`
- Toggle right inspector: `Cmd/Ctrl+;`
- Next/prev lane: `Cmd/Ctrl+Alt+Down` / `Cmd/Ctrl+Alt+Up`
- Open conflicts for selected lane: `Cmd/Ctrl+Shift+C`
- Open PR panel for selected lane: `Cmd/Ctrl+Shift+P`

## 11. Dev Checklist (UI Lock Compliance)

- [ ] Tabbed app shell matches locked tabs
- [ ] Lanes tab defaults to 3-pane layout with inspector tabs
- [ ] Conflict badges appear in lane rows (predicted/active/blocked)
- [ ] Lane rows show lane type and risk summary
- [ ] Files tab supports workspace selection + explorer + Monaco editing
- [ ] Terminals tab has global list with filters and jump-to-lane
- [ ] Project Home tab has managed processes + test buttons + basic project management
- [ ] Workspace canvas mode renders primary lane + worktree topology
- [ ] Conflicts tab can run proposal flow and show diff/apply
- [ ] Conflicts tab shows pairwise risk matrix + merge simulation entrypoint
- [ ] History tab shows timeline from operations table
