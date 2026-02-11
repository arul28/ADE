# Navigation and Layout

Last updated: 2026-02-11

This spec locks the top-level UI structure (tabs) and how features overlap across tabs.

## 1. Primary Navigation (Tabs)

Top-level tabs (left-to-right):

- **Projects (Home)** (project-global)
- **Lanes** (primary)
- **Files** (explorer/editor workbench)
- **Terminals**
- **Conflicts**
- **PRs** (GitHub)
- **History**
- **Settings**

Design rule: most actions should also be reachable from the Lanes tab to avoid forcing context switches.

## 2. Overlap Rules (How Tabs Interconnect)

- Lanes tab is the main cockpit:
  - start terminals for a lane
  - view lane terminals inline (lane inspector -> Terminals tab)
  - see conflict badges and open conflict window
  - see PR status and open PR panel
  - open workspace graph canvas (overview mode)
- Files tab is the IDE-like workbench:
  - browse files across primary workspace and lane worktrees
  - edit files with Monaco
  - diff staged/unstaged/commit changes
  - quick stage/unstage and jump to lane/conflict context
- Projects (Home) tab is global:
  - project management (open/change repo, base branch, escape hatches)
  - show current project stack status (dev server/db/worker/etc.)
  - run tests from buttons
  - edit process/test definitions
- Terminals tab is the global command center:
  - view all terminals across lanes
  - filter/pin/search
  - jump to the owning lane
- Conflicts tab aggregates across lanes:
  - predicted and active conflicts across the project
  - lane-lane risk matrix and merge simulation entry points
  - jump into a lane conflict pack + proposal flow
- PRs tab aggregates across lanes:
  - stacked PR chains
  - review readiness and merge order
  - jump into lane PR panel
- History tab is global:
  - ADE operations timeline/graph
  - drill down into a lane, checkpoint, feature, conflict episode, or PR event

## 3. Lanes Tab Layout (Default)

Default layout is a 3-pane experience:

- Left: lanes list + topology views (toggleable)
- Center: lane detail (diffs, files, quick edit) or workspace canvas
- Right: lane side panel (tabs):
  - Terminals
  - Packs
  - Conflicts
  - PR

Key behavior:

- Selecting a lane updates center/right panels.
- Conflicts are visible at lane-list level (badges) and in panel details.
- Workspace topology supports three modes:
  - list
  - stack graph
  - workspace graph canvas

## 4. Workspace Graph Canvas (Overview Mode)

The workspace graph canvas provides high-level project topology:

- main repository directory node in center (`Primary Lane`)
- outgoing lines to all known worktree/attached lanes
- visual state for each node:
  - active/stale/archived
  - dirty/clean
  - ahead/behind
  - tests status
  - PR status
- visual state for each edge:
  - parent-child stack relation
  - merge simulation health (`clean`, `auto-merge`, `conflicts`)
  - overlap risk score

Interactions:

- click node to focus lane details
- click edge to open merge simulation detail
- filter by active/stale/archived and risk level
- zoom/pan (infinite canvas style)

## 5. Terminals Tab Layout (Command Center)

The terminals tab provides:

- Global list/grid of sessions across lanes
- Filters:
  - lane
  - running/exited
  - label/goal
  - has errors
- Views:
  - focused single terminal
  - grid view (many terminals)
  - list view (compact)

See `TERMINAL_COMMAND_CENTER.md` for details.

## 6. Files Tab Layout (Explorer + Editor)

The Files tab provides:

- workspace scope selector:
  - main repository directory
  - active lane worktrees
  - attached worktree lanes
- file explorer tree (scope-rooted)
- editor/diff workspace:
  - file editing
  - staged/unstaged/commit diff views
  - conflict marker editing support
- context panel:
  - git status for current file
  - quick stage/unstage
  - jump to lane details/conflict panel

See `FILE_VIEWER_DIFF_QUICK_EDIT.md`.

## 7. Projects (Home) Tab Layout (Project Stack)

The Projects (Home) tab provides:

- Project overview header:
  - repo name/path
  - active base branch
  - stack button row (for example Backend/Frontend/Full Stack)
  - global `Start all` / `Stop all`
- Managed processes list:
  - status (running/stopped/exited)
  - lifecycle controls (start/stop/restart/kill)
  - readiness
  - pid/uptime/last exit
  - ports
  - logs quick view
- Test suite buttons:
  - unit/integration/e2e/custom
  - last run status + duration

See `PROCESSES_AND_TESTS.md` for detailed requirements.

## 8. Conflicts Tab Layout

The conflicts tab provides:

- global list of lanes with:
  - predicted conflicts
  - active conflicts
  - blocked stacks
- pairwise lane risk matrix
- merge simulation panel (source lane -> target lane/branch)
- conflict pack viewer
- proposal runner panel (hosted agent)
- apply proposal + test-run controls

See `CONFLICT_RESOLUTION.md`.

## 9. PRs Tab Layout (Stacked + Parallel)

The PRs tab provides:

- stacked PR chains with:
  - checks status
  - review status
  - dependencies
- parallel PR list for non-stacked lanes
- land stack guided flow entry point

See `PULL_REQUESTS_GITHUB.md` and `STACKS_AND_RESTACK.md`.

## 10. Keyboard Shortcuts (MVP)

MVP shortlist:

- Command palette
- New lane
- Open Files tab
- New terminal in current lane
- Toggle left lanes/graph panel
- Toggle center panel mode (diff/canvas)
- Toggle right side panel
- Jump to next/previous lane

Exact keybindings can be refined, but shortcuts should exist early because parallel workflows are shortcut-heavy.

## 11. Development Checklist

MVP:

- [ ] Tabbed shell with routing
- [ ] Lanes tab 3-pane layout with resizable panels
- [ ] Lane side panel with sub-tabs (Terminals/Packs/Conflicts/PR)
- [ ] Workspace topology modes (list + stack graph)
- [ ] Files tab explorer/editor route
- [ ] Terminals tab global list view with jump-to-lane
- [ ] Projects (Home) tab global view with processes + test buttons
- [ ] Conflicts tab aggregate view
- [ ] History tab placeholder wired to operations DB table

V1:

- [ ] Workspace graph canvas mode
- [ ] Conflicts matrix + merge simulation deep links
- [ ] Persisted canvas zoom/pan per project
