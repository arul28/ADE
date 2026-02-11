# UI Component Inventory (Locked)

Last updated: 2026-02-11

This doc lists the reusable UI components ADE should build and reuse across tabs. It is intended to:

- prevent duplicated UI logic
- make implementation more mechanical
- keep the UI consistent as the app grows

This is aligned with `UI_SPEC_LOCKED.md`.

UI tech stack for these components is locked in `UI_SPEC_LOCKED.md` (routing, panes, editor/diff, graphs, primitives).

## 1. Renderer Folder Structure (Recommended)

In `/Users/arul/ADE/apps/desktop/src/renderer/components/`:

- `app/` app shell and routing
- `project/` project home (project management + processes + tests)
- `lanes/` lane list, lane detail, stack graph
- `terminals/` session list, terminal view wrappers, filters
- `conflicts/` conflict list/detail, proposal UI, patch viewer
- `prs/` PR lists, PR detail, checks/review badges
- `history/` timeline, event detail, graph (V1)
- `packs/` pack viewer and sections
- `ui/` shared primitives (buttons, chips, modals, split panes)

## 2. Shell + Navigation

- `AppShell` (Console Grid)
- `TopBar` (Integrated)
- `ProjectSelector`
- `GlobalStatusChips`
- `TabNav` (Slim Icon Rail - 50px)
- `CommandPalette`

## 3. Layout Primitives

These are required early to match the locked 3-pane cockpit.

- `SplitPane` (resizable)
- `PaneHeader` (title + actions + breadcrumbs)
- `DockLayoutState` (persist pane sizes per project)
- `EmptyState`

## 4. Lanes UI

- `LaneList`
- `LaneRow` (High-Density Index Card)
- `LaneStatusBadges` (Metadata Grid):
  - dirty/clean (Mono)
  - ahead/behind (Mono)
  - tests/PR/active timestamps
- `StackGraphMini` (left pane)
- `LaneDetail` (center pane container)
- `ChangesDiffView` (working/staged/commits)
- `FileTree` (toggle)
- `QuickEdit` (small edits only)
- `LaneInspector` (right pane)
- `LaneInspectorTabs` (Terminals/Packs/Conflicts/PR)

## 5. Terminals UI

- `TerminalSessionTabs` (per lane)
- `TerminalView` (xterm wrapper; no PTY logic inside)
- `TerminalSessionList` (global)
- `TerminalSessionRow`
- `TerminalFiltersBar`
- `TerminalPinnedBar`
- `TerminalGrid` (V1; virtualization required)
- `TerminalPreviewFrame` (lightweight preview for non-focused sessions)
- `SessionDeltaCard` (rendered in packs and in terminal detail)

## 6. Project Home UI (Project Management + Processes + Tests)

- `ProjectHome` (tab container)
- `ProjectHeader` (repo/path/base branch + stack button row + start/stop all)
- `ProjectActions` (open/change repo, open `.ade/` folder, export config)
- `StackButtonsBar` (named process subsets like Backend/Frontend/Full Stack)
- `StackButton`
- `ProcessList`
- `ProcessCard`
- `ProcessStatusChip` (running/stopped/exited + readiness)
- `ProcessRuntimeMeta` (pid/uptime/last-exit)
- `ProcessControls` (start/stop/restart/kill)
- `ProcessLogsViewer` (tail + search)
- `PortsPanel` (V1; best-effort detection)
- `TestSuitesPanel`
- `TestSuiteButton`
- `TestRunMeta` (last status/duration/time)
- `RunHistoryList` (tests/process restarts)
- `ConfigEditor` (process/stack button/test definitions)

## 7. Packs UI

- `PackViewer`
- `PackFreshnessIndicator` (deterministic vs narrative timestamps)
- `PackSection` (Summary/Intent/HowToTest/etc.)
- `PackLinkBar` (jump between project/lane/conflict packs)

V1:

- `PackDiffViewer` (compare pack versions)

## 8. Conflicts UI

- `ConflictsLaneList` (aggregate across lanes)
- `ConflictSummaryRow` (files + severity)
- `ConflictDetailPanel`
- `ConflictFilesList`
- `ConflictPackViewer` (wraps `PackViewer`)
- `ProposalRunnerPanel` (job status + controls)
- `ProposalList`
- `ProposalDiffViewer`
- `ApplyProposalControls` (apply as commit, choose mode)
- `LocalTestRunPanel` (run suggested tests; show results)

## 9. PRs UI

- `PRsStackedChainsView`
- `PRChainRow`
- `PRParallelList`
- `PRDetailPanel`
- `ChecksStatusChip`
- `ReviewStatusChip`
- `LandStackWizard` (V1)

## 10. History UI

MVP:

- `HistoryTimeline`
- `HistoryEventRow`
- `HistoryFiltersBar`
- `HistoryEventDetail`

V1:

- `HistoryGraphView`

## 11. Shared UI Primitives

- `Button` (+ variants)
- `Badge` / `Chip`
- `Icon` (single icon set)
- `Tooltip`
- `Popover`
- `Modal`
- `Drawer` (optional)
- `Toast` / notifications
- `ContextMenu`
- `Kbd` (keyboard shortcut renderer)

## 12. Development Checklist

- [ ] Create folders and component stubs following this inventory
- [ ] Ensure Lanes cockpit uses shared layout primitives (no duplicated split-pane logic)
- [ ] Ensure Terminals and Conflicts use the same session/proposal row components (consistent status chips)
