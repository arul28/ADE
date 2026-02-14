# ADE Implementation Plan

> Last updated: 2026-02-12

---

## Table of Contents

1. [Overview](#overview)
2. [Phase Summary](#phase-summary)
3. [Completed Phases](#completed-phases)
   - [Phase -1: Repo + Desktop Scaffold](#phase--1-repo--desktop-scaffold)
   - [Phase 0: Terminals + Session Tracking](#phase-0-terminals--session-tracking)
   - [Phase 1: Lanes Cockpit + Diffs + Git Operations](#phase-1-lanes-cockpit--diffs--git-operations)
   - [Phase 2: Project Home (Processes + Tests + Config)](#phase-2-project-home-processes--tests--config)
   - [Phase 3: Files Tab + UI Polish](#phase-3-files-tab--ui-polish)
   - [Phase 4: Stacks + Restack](#phase-4-stacks--restack)
   - [Phase 5: Conflict Radar + Resolution](#phase-5-conflict-radar--resolution)
4. [Upcoming Phases](#upcoming-phases)
   - [Phase 6: Cloud Infrastructure + Auth + LLM Gateway](#phase-6-cloud-infrastructure--auth--llm-gateway)
   - [Phase 7: GitHub Integration + Workspace Graph](#phase-7-github-integration--workspace-graph)
   - [Phase 8: Automations + Onboarding + Packs V2](#phase-8-automations--onboarding--packs-v2)
   - [Phase 9: Advanced Features + Polish + Runtime Isolation](#phase-9-advanced-features--polish--runtime-isolation)
5. [Cross-Cutting Concerns](#cross-cutting-concerns)
6. [Risk Register](#risk-register)

---

## Overview

This document is the master implementation plan for ADE (Agentic Development Environment). It ties together every feature specification and architecture document into a single phased development roadmap, providing traceability from high-level phases down to individual task IDs defined in the feature docs.

**There is no MVP.** ADE is a single, complete product. Every phase in this plan contributes to the finished application. All phases must be completed. Phases are ordered by dependency and priority -- earlier phases establish foundations that later phases build on -- but the goal is the full product, not a subset.

### Document References

**Feature Documentation** (in `docs/features/`):

| Document | Covers |
|----------|--------|
| `TERMINALS_AND_SESSIONS.md` | PTY service, session tracking, transcripts, deltas, tiling |
| `LANES.md` | Lane CRUD, 3-pane layout, diff viewer, git operations, stacks |
| `PROJECT_HOME.md` | Process management, test suites, config editor |
| `FILES_AND_EDITOR.md` | File explorer, Monaco editor, diff/conflict modes |
| `CONFLICTS.md` | Conflict prediction, risk matrix, merge simulation, resolution proposals |
| `PULL_REQUESTS.md` | GitHub integration, PR CRUD, stacked PRs, land flow |
| `PACKS.md` | Context packs, checkpoints, versioning, event logging, narratives |
| `WORKSPACE_GRAPH.md` | React Flow canvas, node/edge components, risk visualization |
| `AUTOMATIONS.md` | Trigger-action rules, action chaining, execution history |
| `ONBOARDING_AND_SETTINGS.md` | Setup wizard, trust model, provider config, settings |
| `HISTORY.md` | Operations timeline, checkpoints, replay, undo |

**Architecture Documentation** (in `docs/architecture/`):

| Document | Covers |
|----------|--------|
| `SYSTEM_OVERVIEW.md` | Three-layer architecture, design decisions, integration points |
| `DESKTOP_APP.md` | Electron process model, service factory pattern, AppContext |
| `DATA_MODEL.md` | SQLite (sql.js), dual persistence, migration system |
| `GIT_ENGINE.md` | Worktree model, git operations service, operation tracking |
| `JOB_ENGINE.md` | Event-driven queue, per-lane coalescing, lane refresh pipeline |
| `UI_FRAMEWORK.md` | React 18, Zustand, Tailwind CSS, theming, component inventory |
| `CONFIGURATION.md` | YAML config layering, trust model, lane profiles |
| `SECURITY_AND_PRIVACY.md` | Process isolation, IPC security, secret protection, audit trail |
| `CLOUD_BACKEND.md` | AWS serverless stack (SST, Clerk auth, S3, SQS, DynamoDB, Lambda) |
| `HOSTED_AGENT.md` | Mirror sync protocol, LLM gateway, job types, provider swapping |

---

## Phase Summary

| Phase | Name | Status | Key Deliverables |
|-------|------|--------|-----------------|
| -1 | Repo + Desktop Scaffold | DONE | Electron + React + Vite + SQLite + Tailwind + Zustand |
| 0 | Terminals + Session Tracking | DONE | PTY service, xterm.js, transcripts, session deltas |
| 1 | Lanes Cockpit + Diffs + Git Operations | DONE | Lane CRUD, 3-pane layout, diff viewer, git ops, stash, push |
| 2 | Project Home (Processes + Tests + Config) | DONE | Process manager, test runner, config editor, packs, job engine |
| 3 | Files Tab + UI Polish | DONE | File explorer (Zed-inspired), Monaco editor, diff modes, Run tab rename, lane selector, guest mode, untracked sessions |
| 4 | Stacks + Restack | DONE | Parent-child lanes, stack graph, restack operations, overlay policies, vertical connectors |
| 5 | Conflict Radar + Resolution | DONE | Conflict prediction, risk matrix, merge simulation, Monaco conflict diff, risk tooltips, status badges |
| 6 | Cloud Infrastructure + Auth + LLM Gateway | DONE | AWS SST stack, Clerk auth, LLM gateway, mirror sync, pack narratives, conflict proposals |
| 7 | GitHub Integration + Workspace Graph | NOT STARTED | GitHub PR CRUD, stacked PRs, land flow, React Flow canvas, graph interactions, view modes |
| 8 | Automations + Onboarding + Packs V2 | NOT STARTED | Trigger-action rules, onboarding wizard, CI/CD import, checkpoints, pack versioning |
| 9 | Advanced Features + Polish + Runtime Isolation | NOT STARTED | History graph, terminal tiling, advanced git, agent CLI tools, runtime isolation |

---

## Completed Phases

### Phase -1: Repo + Desktop Scaffold

**Status**: DONE (2026-02-10)

**Goal**: Establish the foundational project structure, build toolchain, and application shell that all subsequent phases build upon.

**Scope**:
- Electron 40 + React 18 + TypeScript + Vite (renderer) + tsup (main)
- Preload bridge with typed IPC allowlist (security boundary)
- App shell: TopBar, 50px left icon rail, 8-tab navigation
- React Router routing for all pages (Projects, Lanes, Files, Terminals, Conflicts, PRs, History, Settings)
- Resizable pane layouts via `react-resizable-panels`
- SQLite persistence via `sql.js` (WASM) with kv table for layout state
- Tailwind CSS 4.x with two themes: Clean Paper (light) and Bloomberg Terminal (dark)
- Zustand app store for renderer state management

**Architecture References**: `DESKTOP_APP.md`, `DATA_MODEL.md`, `UI_FRAMEWORK.md`, `SECURITY_AND_PRIVACY.md`

**Exit Criteria**: Application builds, launches, and renders the shell with all navigation tabs. Theme toggle works. SQLite persists and restores layout state across restarts.

---

### Phase 0: Terminals + Session Tracking

**Status**: DONE (2026-02-11)

**Goal**: Deliver a fully functional terminal system with session lifecycle tracking, transcript capture, and delta computation that feeds into the pack system.

**Scope**:
- PTY service via `node-pty` with xterm.js rendering
- Session lifecycle tracking (create, stream, exit)
- Transcript capture to `.ade/transcripts/`
- HEAD SHA tracking at session start and end
- Session delta computation (files changed, insertions, deletions, failure lines)
- Global Terminals page with filters (lane, status, search)
- Lane terminal panel (Terminals sub-tab in Lanes)
- Session end triggers pack refresh job via job engine

**Feature Doc References**: `TERMINALS_AND_SESSIONS.md`

**Architecture References**: `DESKTOP_APP.md` (IPC streaming), `JOB_ENGINE.md` (session-end trigger), `DATA_MODEL.md` (session tables)

**Task References**:
- TERM-001 through TERM-020: ALL DONE
- Covers PTY infrastructure (TERM-001 to TERM-006), session tracking (TERM-007 to TERM-012), and global UI (TERM-013 to TERM-020)

**Exit Criteria**: Terminals can be created per lane, output streams in real-time, transcripts are saved to disk, session deltas are computed on exit, and pack refresh jobs are triggered.

---

### Phase 1: Lanes Cockpit + Diffs + Git Operations

**Status**: DONE (2026-02-11)

**Goal**: Build the primary development workspace with full git operations support, enabling developers to manage parallel worktrees, view diffs, and perform all common git actions from a single cockpit.

**Scope**:
- Lane (worktree) CRUD: create, rename, archive, delete
- 3-pane resizable layout (lane list, detail area, inspector sidebar)
- Diff viewer: unstaged and staged sections with file change indicators
- Monaco side-by-side diff view with quick edit capability
- Stage/Unstage/Discard per file and bulk operations
- Commit with message
- Stash operations (push/pop/apply/drop/list)
- Fetch, Sync (merge/rebase), Push (with force-with-lease)
- Recent commits list, revert commit, cherry-pick commit
- Multi-lane tabs (open multiple lanes simultaneously)
- Lane sub-tabs (Diff, Terminals, Packs, Conflicts, PR)
- Operation history tracking with SHA transitions

**Feature Doc References**: `LANES.md`

**Architecture References**: `GIT_ENGINE.md` (worktree model, git operations service), `DATA_MODEL.md` (lanes table), `UI_FRAMEWORK.md` (layout system)

**Task References**:
- LANES-001 through LANES-023: ALL DONE
- Core lane management (LANES-001 to LANES-006), git operations (LANES-007 to LANES-020), advanced UI (LANES-021 to LANES-023)

**Exit Criteria**: Full lane lifecycle works end-to-end. Diffs render correctly for all change types. All git operations execute and record operation history. Multi-lane tabs function.

---

### Phase 2: Project Home (Processes + Tests + Config)

**Status**: DONE (2026-02-11)

**Goal**: Deliver the project control plane with managed processes, test suites, config editing, pack generation, and the job engine that ties them together.

**Scope**:
- Process definitions from YAML config with spawning and lifecycle management
- Readiness checks (port probe, log regex)
- Stack buttons (named process groups with dependency ordering)
- Test suite execution with status tracking and timeout enforcement
- Process and test log capture and viewer components
- Config editor with YAML syntax highlighting, inline validation, and save
- Shared/Local config split with trust confirmation dialog
- Pack service: deterministic content generation + template narrative
- Pack viewer and freshness indicator (green/yellow/red)
- Job engine with per-lane deduplication and coalescing
- Keyboard shortcuts (j/k/s/x/r) for process and test navigation

**Feature Doc References**: `PROJECT_HOME.md`, `PACKS.md`, `HISTORY.md`

**Architecture References**: `JOB_ENGINE.md`, `CONFIGURATION.md`, `DATA_MODEL.md` (packs_index, operations tables)

**Task References**:
- PROJ-001 through PROJ-025: ALL DONE
- PACK-001 through PACK-011: ALL DONE
- HIST-001 through HIST-010: ALL DONE

**Exit Criteria**: Processes can be started, stopped, and monitored. Test suites run and report results. Config editor validates and saves. Packs generate on session end and display freshness. History timeline shows all operations with filters.

---

### Phase 3: Files Tab + UI Polish

**Status**: DONE (2026-02-11)

**Goal**: Provide an IDE-style file explorer and editor that allows developers to browse and edit code across workspaces without leaving ADE, plus refinements to terminal and lane keyboard navigation.

**Scope**:
- File tree listing service with `.gitignore` support and lazy loading
- File explorer tree view component with expand/collapse and contextual icons
- Workspace scope selector (Primary, Lane Worktrees, Attached Worktrees)
- Git change indicators in file tree (M/A/D badges)
- Monaco editor integration with syntax highlighting for common languages
- File tab bar (multiple open files, unsaved changes indicator)
- Edit mode: read/write with atomic save via `fileService`
- File path breadcrumb navigation
- Right-click context menu (Open, Diff, Stage, Discard, Copy Path, New File, Rename, Delete)
- Diff mode: staged vs. unstaged, commit comparison (side-by-side with change highlighting)
- Protected branch warnings (banner when editing in primary workspace)
- Unsaved changes prompts on tab close or workspace switch
- File watching for external changes (chokidar, debounced, gitignore-aware)
- Search across files (Ctrl+Shift+F) and quick open (Ctrl+P)
- Zed-inspired file tree styling (compact rows, minimal chrome, keyboard-driven navigation)
- Terminal theme sync (dark/light xterm.js themes)
- Untracked session mode (terminals that don't record to context/history)
- Keyboard shortcuts refinement for lane navigation and search/filter
- Run tab rename (Projects → Run with ▶ play/pause icon)
- Lane selector in Run tab (dropdown to set execution context for commands/tests)
- Guest mode foundation (no-account usage with local features only, context tracking disabled)
- Guest mode banner (persistent "Running in Guest Mode" with provider setup link)
- Guest mode template narratives (template-based pack fallback when no LLM provider)

**Feature Doc References**: `FILES_AND_EDITOR.md`, `TERMINALS_AND_SESSIONS.md` (TERM-024), `LANES.md` (LANES-034, LANES-035)

**Architecture References**: `UI_FRAMEWORK.md` (Monaco integration, keyboard shortcuts), `DESKTOP_APP.md` (IPC channels for file operations)

**Progress**:

Phase 3 development is complete. The following major deliverables are complete:

- **Files Tab (complete)**: File explorer tree view with `.gitignore` support, workspace scope selector, Monaco editor with syntax highlighting, multi-tab editor, edit/diff/conflict modes, file breadcrumbs, right-click context menu, unsaved changes detection, file watching via chokidar, quick open (Ctrl+P), cross-file search (Ctrl+Shift+F), atomic saves, extension-aware file icons, protected-branch lane-switch suggestion, and Zed-inspired compact styling with indentation guides and refined hover states. All 21 FILES tasks are done.
- **Untracked sessions (TERM-032)**: Done. "New Terminal (Untracked)" button in lane terminal panel creates sessions with `tracked: false`.
- **Run tab rename (PROJ-033)**: Done. Tab uses Play icon with "Play" label in the nav rail.
- **Lane selector (PROJ-034)**: Done. Run tab shows "Running in: [lane]" dropdown with lane selection.
- **Guest mode (ONBOARD-025)**: Done. `ProviderMode` type includes "guest", all local features work without an account.
- **Guest mode banner (ONBOARD-026)**: Done. Persistent amber banner with "Running in Guest Mode" and link to provider settings.
- **Guest mode template narratives (PACK-030)**: Done. Current pack system generates template narratives by default.
- **Renderer error boundary**: Added for graceful crash recovery in the renderer process.

**Remaining Work**: None for Phase 3 scope.

**Task References**:
- FILES-001 through FILES-021: ALL DONE (see `FILES_AND_EDITOR.md`)
  - Phase 3a (File Tree + Basic Editor): FILES-001 through FILES-009, FILES-013, FILES-014, FILES-015, FILES-018 — ALL DONE
  - Phase 3b (Diff + Conflict Modes): FILES-010, FILES-011, FILES-012, FILES-017 — ALL DONE
  - Phase 3c (Advanced Editor): FILES-016, FILES-019, FILES-020, FILES-021 — ALL DONE
- TERM-024: Terminal theme sync — DONE
- TERM-032: Untracked session mode — DONE
- LANES-034: Keyboard shortcuts for lane navigation — DONE
- LANES-035: Lane search/filter — DONE
- PROJ-033: Tab rename to "Run" with play/pause nav icon — DONE
- PROJ-034: Lane selector for command execution context — DONE
- ONBOARD-025: Guest mode (no-account usage) — DONE
- ONBOARD-026: Guest mode banner — DONE
- PACK-030: Guest mode template narratives — DONE

**Services Implemented**:
- `fileService` (expanded): Now includes listTree, readFile, writeWorkspaceText, createFile, createDirectory, rename, delete, watchWorkspace, stopWatching, quickOpen, searchText
- `fileSearchIndexService` (new): Cooperative in-memory file index for quick open and cross-file text search
- `fileWatcherService` (new): chokidar-based file watching with debouncing and gitignore filtering

**IPC Channels** (implemented):
- `ade.files.listWorkspaces`, `ade.files.listTree`, `ade.files.readFile`, `ade.files.writeText`
- `ade.files.watchChanges`, `ade.files.stopWatching`
- `ade.files.createFile`, `ade.files.createDirectory`, `ade.files.rename`, `ade.files.delete`
- `ade.files.quickOpen`, `ade.files.searchText`

**Dependencies**: Phase -1 (Monaco already bundled), Phase 1 (diffService exists)

**Exit Criteria**: File explorer renders workspace trees with Zed-inspired compact styling and git indicators. Files open in Monaco with syntax highlighting. Save works atomically. Diff mode shows staged and unstaged comparisons. File watcher detects external changes. Keyboard shortcuts work for lane navigation and file search. The Projects tab is renamed to "Run" with a play/pause icon and lane selector. Guest mode allows using ADE without an account (packs use template narratives). Untracked sessions can be launched without context recording.

---

### Phase 4: Stacks + Restack

**Status**: DONE (2026-02-11, merged in `codex/ade-phase-4-5` branch, commit `65b7a6b`)

**Goal**: Enable stacked development workflows where child lanes build on parent lanes, with visualization and restack operations to propagate parent changes downstream.

**Scope**:
- Stack model: `parent_lane_id` in lanes table (schema column already exists, currently unused)
- Stack creation: "Create Child Lane" action that sets parent and bases branch on parent's HEAD
- Stack graph visualization in the lane list sidebar (tree rendering of parent-child relationships)
- Restack operation: propagate parent branch changes to all child lanes (rebase children onto updated parent)
- Stack-aware status indicators: show ahead/behind relative to parent (not just remote)
- Stack DB queries: fetch children of a lane, fetch entire stack chain (root to leaf)
- Lane overlay policies (configuration for per-lane behavior overrides)

#### Files to Create

| File | Purpose |
|------|---------|
| (none — all changes extend existing files) | |

#### Files to Modify

| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add `StackChainItem`, `RestackArgs`, `CreateChildLaneArgs`, `LaneOverlayPolicy` types. Extend `LaneSummary` with `parentLaneId: string \| null`, `childCount: number`, `stackDepth: number`, `parentStatus: LaneStatus \| null` |
| `src/shared/ipc.ts` | Add channels: `lanesCreateChild`, `lanesGetStackChain`, `lanesRestack`, `lanesGetChildren` |
| `src/main/services/lanes/laneService.ts` | Add methods: `createChild(args)`, `getStackChain(laneId)`, `getChildren(laneId)`, `restack(laneId)`. Extend `toLaneSummary()` to include `parentLaneId`, `childCount`, `stackDepth`. Extend `create()` to accept `parentLaneId` param and set `base_ref` to parent's branch. Add `computeStackDepth(laneId)` helper. |
| `src/main/services/ipc/registerIpc.ts` | Register 4 new IPC handlers for the stack channels |
| `src/preload/preload.ts` | Expose 4 new methods under `window.ade.lanes`: `createChild`, `getStackChain`, `restack`, `getChildren` |
| `src/preload/global.d.ts` | Add type declarations for the 4 new lane methods |
| `src/renderer/components/lanes/LanesPage.tsx` | Add "Create Child Lane" to the create lane dialog (parent lane selector dropdown). Render stack graph section below the lane list. |
| `src/renderer/components/lanes/LaneRow.tsx` | Add stack-depth indentation (left padding = `stackDepth * 16px`). Show parent/child connector lines. Add stack icon badge. Show ahead/behind relative to parent when `parentLaneId` is set. |
| `src/renderer/components/lanes/LaneDetail.tsx` | Add "Restack" button in the lane header when lane has a parent. Show parent lane link. Show children list in inspector. |
| `src/renderer/components/lanes/LaneInspector.tsx` | Add "Stack" section showing parent lane, children, stack depth, and "Restack" action button |

#### New Types (`types.ts`)

```typescript
export type CreateChildLaneArgs = {
  parentLaneId: string;
  name: string;
  description?: string;
};

export type StackChainItem = {
  laneId: string;
  laneName: string;
  branchRef: string;
  depth: number;
  parentLaneId: string | null;
  status: LaneStatus;
};

export type RestackArgs = {
  laneId: string;  // the child to restack (rebases onto parent HEAD)
  recursive?: boolean;  // also restack grandchildren (default true)
};

export type RestackResult = {
  restackedLanes: string[];  // lane IDs that were rebased
  failedLaneId: string | null;  // first lane that failed rebase (null = all succeeded)
  error: string | null;
};
```

#### New IPC Channels

| Constant | Channel String | Signature |
|----------|---------------|-----------|
| `lanesCreateChild` | `ade.lanes.createChild` | `(args: CreateChildLaneArgs) => LaneSummary` |
| `lanesGetStackChain` | `ade.lanes.getStackChain` | `(laneId: string) => StackChainItem[]` |
| `lanesGetChildren` | `ade.lanes.getChildren` | `(laneId: string) => LaneSummary[]` |
| `lanesRestack` | `ade.lanes.restack` | `(args: RestackArgs) => RestackResult` |

#### Service Method Details

**`laneService.createChild(args)`**:
1. Look up parent lane by ID — get its `branchRef` and `worktreePath`
2. Get parent's current HEAD: `git rev-parse HEAD` in parent worktree
3. Create a new branch from parent HEAD: `git branch <child-branch> <parent-HEAD>` in repo root
4. Create worktree for the new branch at `.ade/worktrees/<slug>/`
5. Insert lane row with `parent_lane_id = args.parentLaneId`, `base_ref = parent.branchRef`
6. Return the new `LaneSummary` with `stackDepth` computed

**`laneService.getStackChain(laneId)`**:
1. Walk up from `laneId` via `parent_lane_id` to find root
2. Walk down from root via recursive CTE query: `WITH RECURSIVE stack AS (SELECT ... WHERE parent_lane_id IS NULL AND id = :rootId UNION ALL SELECT l.* FROM lanes l JOIN stack s ON l.parent_lane_id = s.id) SELECT * FROM stack ORDER BY depth`
3. Return array of `StackChainItem` in depth-first order

**`laneService.restack(args)`**:
1. Get the target lane and its parent
2. Get parent's current HEAD SHA
3. Rebase target lane onto parent HEAD: `git rebase <parent-HEAD> <child-branch>` in child's worktree
4. If `recursive: true`, get all children of target lane and restack each in depth-first order
5. If any rebase fails (conflict), stop and return the failed lane ID — user must resolve manually
6. Record operation via `operationService` with pre/post SHAs for each restacked lane
7. Trigger pack refresh for all restacked lanes via `jobEngine`

**`laneService.getChildren(laneId)`**:
1. Query `SELECT * FROM lanes WHERE parent_lane_id = ? AND archived_at IS NULL`
2. Compute status for each child
3. Return as `LaneSummary[]`

#### Stack Graph Component

The stack graph renders below the lane list in the left pane of `LanesPage.tsx`:

```
Lane List:
  ● main (primary)
  ├─ feature/auth        ↑2  ●
  │  └─ feature/auth-ui  ↑0  ●
  ├─ feature/payments    ↑1
  └─ bugfix/login        ↑0
```

Implementation: Use CSS indentation + connector lines (similar to the file tree in FilesPage). Each `LaneRow` receives `stackDepth` from `LaneSummary` and renders with `paddingLeft = 16 + stackDepth * 20`. Connector lines use absolute-positioned `::before` pseudo-elements (vertical line from parent row to child row, horizontal line into the child).

#### Implementation Order

1. **Types + IPC** (30 min): Add types to `types.ts`, channels to `ipc.ts`, preload bridge, type declarations
2. **DB queries** (1 hr): Add `getChildren`, `getStackChain` with recursive CTE, extend `toLaneSummary` to include parentLaneId/childCount/stackDepth
3. **createChild** (1 hr): Implement `laneService.createChild()` with branch creation from parent HEAD, worktree setup, DB insert
4. **Restack** (2 hr): Implement `laneService.restack()` with recursive rebase, error handling for conflicts, operation recording, pack refresh triggering
5. **Lane row changes** (1 hr): Add stack-depth indentation, connector lines, parent-relative ahead/behind, stack icon badge
6. **Create child UI** (1 hr): Add "Create Child Lane" option to the create dialog with parent selector dropdown
7. **Stack graph** (1.5 hr): Render tree structure in lane list with visual connectors
8. **Restack UI** (1 hr): "Restack" button in lane header/inspector, confirmation dialog, progress/error display
9. **Lane overlay policies** (1 hr): Config schema for per-lane behavior overrides, read in service, apply in relevant operations

**Feature Doc References**: `LANES.md` (Phase 4 tasks)

**Architecture References**: `GIT_ENGINE.md` (worktree model, rebase operations), `DATA_MODEL.md` (lanes table parent_lane_id), `CONFIGURATION.md` (lane profiles, lane overlays)

**Task References**:
- LANES-026: Stack creation (parent-child relationships)
- LANES-027: Stack graph visualization in lane list
- LANES-028: Restack operations (propagate parent to children)
- LANES-029: Stack-aware status indicators
- LANES-033: Lane overlay policies

**Dependencies**: Phase 1 (lane CRUD, git operations). No dependency on Phase 5.

**Exit Criteria**: Child lanes can be created from a parent lane. The lane list sidebar shows a tree graph of the stack with connector lines. Restack rebases all children when the parent advances (recursive, stops on conflict). Status indicators show ahead/behind relative to parent lane. Lane overlay policies can be defined in config.

---

### Phase 5: Conflict Radar + Resolution

**Status**: DONE (2026-02-11, merged in `codex/ade-phase-4-5` branch, commit `65b7a6b`)

**Goal**: Surface integration risk proactively by predicting merge conflicts before they happen, displaying risk across all lanes, and enabling merge simulation between any pair of lanes.

**Scope**:
- New `conflictService` with dry-merge engine using `git merge-tree`
- `git merge-tree` method added to `gitService` (new method, no existing method changes)
- Lane conflict status computation and caching (merge-ready, behind-base, conflict-predicted, conflict-active, unknown)
- Periodic conflict prediction job via job engine (new job type alongside existing pack refresh)
- Realtime conflict pass triggered on stage/dirty change (debounced, file-list comparison fast path)
- Conflict status badges in lane rows on the Lanes tab
- Realtime conflict chips ("new overlap", "high risk")
- Conflicts tab page with 3-panel layout (lane list, conflict summary / risk matrix, resolution proposals placeholder)
- Conflict summary panel: overlapping files, conflict types, base drift, peer overlaps
- Pairwise risk matrix view with color-coded cells (white/green/yellow/orange/red)
- Merge simulation service and UI (select two lanes, preview outcome)
- Conflict file diff viewer
- Conflict pack generation (context bundle for future hosted agent)
- Batch conflict assessment (all-lanes report)

#### Files to Create

| File | Purpose |
|------|---------|
| `src/main/services/conflicts/conflictService.ts` | Conflict prediction engine: dry-merge via `git merge-tree`, lane conflict status computation, pairwise risk matrix, prediction storage, merge simulation, batch assessment |
| `src/renderer/components/conflicts/ConflictsPage.tsx` | Full Conflicts tab: 3-panel layout (lane list, summary/matrix, proposals placeholder) |
| `src/renderer/components/conflicts/RiskMatrix.tsx` | Pairwise risk matrix grid component with color-coded cells and click interaction |
| `src/renderer/components/conflicts/ConflictSummary.tsx` | Conflict detail panel: overlapping files, conflict types, base drift, peer info |
| `src/renderer/components/conflicts/MergeSimulationPanel.tsx` | Merge simulation UI: lane pair selector, preview result (clean/conflict/error), diff stat |
| `src/renderer/components/conflicts/ConflictFileDiff.tsx` | Diff viewer for conflicting files showing conflict markers |

#### Files to Modify

| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add all conflict types: `ConflictStatusValue`, `ConflictStatus`, `ConflictOverlap`, `RiskMatrixEntry`, `MergeSimulationResult`, `MergeSimulationArgs`, `ConflictPrediction`, `BatchAssessmentResult`, `GetLaneConflictStatusArgs`, `ListOverlapsArgs`, `SimulateMergeArgs` |
| `src/shared/ipc.ts` | Add 7 channels: `conflictsGetLaneStatus`, `conflictsListOverlaps`, `conflictsGetRiskMatrix`, `conflictsSimulateMerge`, `conflictsRunPrediction`, `conflictsGetBatchAssessment`, `conflictsEvent` |
| `src/main/main.ts` | Instantiate `conflictService` in `initContextForProjectRoot()`, wire to jobEngine for periodic prediction |
| `src/main/services/ipc/registerIpc.ts` | Register 6 new invoke handlers + 1 event channel for conflict events |
| `src/main/services/state/kvDb.ts` | Add migration for `conflict_predictions` table |
| `src/preload/preload.ts` | Expose `window.ade.conflicts` namespace with 6 methods + 1 event subscription |
| `src/preload/global.d.ts` | Add type declarations for the conflicts namespace |
| `src/renderer/components/lanes/LaneRow.tsx` | Add conflict status badge (colored dot) after existing status indicators — right side of the row, separate from stack depth (left side) |
| `src/renderer/components/app/App.tsx` | Add `/conflicts` route pointing to `ConflictsPage` (route exists but currently renders placeholder) |

#### New Types (`types.ts`)

```typescript
export type ConflictStatusValue =
  | "merge-ready"
  | "behind-base"
  | "conflict-predicted"
  | "conflict-active"
  | "unknown";

export type ConflictStatus = {
  laneId: string;
  status: ConflictStatusValue;
  overlappingFileCount: number;
  peerConflictCount: number;
  lastPredictedAt: string | null;
};

export type ConflictOverlap = {
  peerId: string | null;       // null = overlap with base
  peerName: string;
  files: Array<{
    path: string;
    conflictType: "content" | "rename" | "delete" | "add";
  }>;
  riskLevel: "none" | "low" | "medium" | "high";
};

export type RiskMatrixEntry = {
  laneAId: string;
  laneBId: string;
  riskLevel: "none" | "low" | "medium" | "high";
  overlapCount: number;
  hasConflict: boolean;
};

export type MergeSimulationArgs = {
  laneAId: string;
  laneBId?: string;  // omit to simulate lane-to-base
};

export type MergeSimulationResult = {
  outcome: "clean" | "conflict" | "error";
  mergedFiles: string[];
  conflictingFiles: Array<{
    path: string;
    conflictMarkers: string;
  }>;
  diffStat: { insertions: number; deletions: number; filesChanged: number };
  error?: string;
};

export type ConflictPrediction = {
  id: string;
  laneAId: string;
  laneBId: string | null;
  status: "clean" | "conflict" | "unknown";
  conflictingFiles: Array<{ path: string; conflictType: string }>;
  overlapFiles: string[];
  laneASha: string;
  laneBSha: string | null;
  predictedAt: string;
};

export type BatchAssessmentResult = {
  lanes: ConflictStatus[];
  matrix: RiskMatrixEntry[];
  computedAt: string;
};

export type GetLaneConflictStatusArgs = { laneId: string };
export type ListOverlapsArgs = { laneId: string };
export type RunConflictPredictionArgs = { laneId?: string };  // omit for all lanes
```

#### New IPC Channels

| Constant | Channel String | Signature |
|----------|---------------|-----------|
| `conflictsGetLaneStatus` | `ade.conflicts.getLaneStatus` | `(args: GetLaneConflictStatusArgs) => ConflictStatus` |
| `conflictsListOverlaps` | `ade.conflicts.listOverlaps` | `(args: ListOverlapsArgs) => ConflictOverlap[]` |
| `conflictsGetRiskMatrix` | `ade.conflicts.getRiskMatrix` | `() => RiskMatrixEntry[]` |
| `conflictsSimulateMerge` | `ade.conflicts.simulateMerge` | `(args: MergeSimulationArgs) => MergeSimulationResult` |
| `conflictsRunPrediction` | `ade.conflicts.runPrediction` | `(args: RunConflictPredictionArgs) => BatchAssessmentResult` |
| `conflictsGetBatchAssessment` | `ade.conflicts.getBatchAssessment` | `() => BatchAssessmentResult` |
| `conflictsEvent` | `ade.conflicts.event` | Push event for prediction completion |

#### DB Schema Addition (`conflict_predictions` table)

```sql
CREATE TABLE IF NOT EXISTS conflict_predictions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  lane_a_id TEXT NOT NULL,
  lane_b_id TEXT,
  status TEXT NOT NULL,             -- 'clean' | 'conflict' | 'unknown'
  conflicting_files_json TEXT,
  overlap_files_json TEXT,
  lane_a_sha TEXT,
  lane_b_sha TEXT,
  predicted_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cp_lane_a ON conflict_predictions(lane_a_id);
CREATE INDEX IF NOT EXISTS idx_cp_lane_b ON conflict_predictions(lane_b_id);
CREATE INDEX IF NOT EXISTS idx_cp_predicted_at ON conflict_predictions(predicted_at);
```

#### Service Method Details

**`conflictService.predictLaneVsBase(laneId)`**:
1. Get lane's worktree path and base ref
2. Get current HEAD: `git rev-parse HEAD` in lane worktree
3. Get base HEAD: `git rev-parse <baseRef>` in repo root
4. Run `git merge-tree --write-tree <merge-base> <base-HEAD> <lane-HEAD>` in repo root
5. Parse output: exit code 0 = clean merge, non-zero = conflicts. Parse `CONFLICT` lines for file list
6. Get file overlap: `git diff --name-only <merge-base>..<lane-HEAD>` intersected with `git diff --name-only <merge-base>..<base-HEAD>`
7. Store prediction in `conflict_predictions` table
8. Compute and return `ConflictStatus`

**`conflictService.predictPairwise(laneAId, laneBId)`**:
1. Get both lanes' worktree paths and HEADs
2. Find merge base: `git merge-base <laneA-HEAD> <laneB-HEAD>`
3. Run `git merge-tree --write-tree <merge-base> <laneA-HEAD> <laneB-HEAD>`
4. Parse conflicts and overlaps same as above
5. Store pairwise prediction
6. Return `RiskMatrixEntry`

**`conflictService.computeRiskMatrix()`**:
1. Get all active (non-archived) lanes
2. For each pair (N*(N-1)/2 pairs): run `predictPairwise` if no fresh prediction exists (within expiry window)
3. Also run `predictLaneVsBase` for each lane
4. Assemble and return `RiskMatrixEntry[]`

**`conflictService.simulateMerge(args)`**:
1. Determine lane A and lane B (or base) HEADs
2. Run `git merge-tree --write-tree` with full output capture
3. If clean: compute diff stat with `git diff-tree --stat <merge-tree-result>`
4. If conflict: parse conflict markers from merge-tree output, extract per-file conflict previews
5. Return `MergeSimulationResult`

**`conflictService.runBatchAssessment()`**:
1. Get all active lanes
2. Predict each lane vs base
3. Predict all pairwise combinations
4. Return `BatchAssessmentResult` with all statuses and full matrix

**git merge-tree addition to `gitService`**: Add a single new method `mergeTree(repoRoot, baseSha, oursSha, theirsSha)` that runs `git merge-tree --write-tree <base> <ours> <theirs>` and returns `{ exitCode, stdout, stderr }`. This is a new method — no existing methods are modified.

**Job engine integration**: Add a `conflictPrediction` job type alongside existing `packRefresh`. The job runs `conflictService.predictLaneVsBase(laneId)` for the affected lane. Triggered by: session end (same as pack refresh), manual "Run Prediction" button, and a periodic timer (configurable, default every 5 minutes while app is active).

**Realtime conflict pass**: On `ade.diff.getChanges` calls (which happen when lane tabs are viewed), the conflict service checks if the changed file list overlaps with any peer lane's changed files using cached data. If overlap is found and no fresh prediction exists, a targeted prediction job is queued for those pairs. This is a fast path — no `git merge-tree` call, just file list intersection.

#### Component Details

**`ConflictsPage.tsx`** — 3-panel layout:
- Left (24%): Lane list with conflict status badges, sorted by risk (highest first). Count badges at top: "3 conflict, 2 at-risk, 5 clean". Click lane to show its summary.
- Center (52%): Toggle between Conflict Summary and Risk Matrix views. Summary shows overlapping files table, base drift info, peer overlaps. Matrix shows color-coded grid.
- Right (24%): Merge simulation panel. Select two lanes from dropdowns, click "Simulate". Shows result (clean/conflict) with file list and diff stat. Future: resolution proposals (placeholder for Phase 11).

**`RiskMatrix.tsx`**: CSS Grid where each cell is `min-width: 40px`. Lane names on both axes. Cell color: white (none), green (low), yellow (medium), orange (high with conflict-predicted), red (conflict-active). Click cell to populate merge simulation with that pair. Diagonal cells show lane-to-base status. Tooltip on hover shows overlap count and file names.

**`LaneRow.tsx` conflict badge**: A small colored dot rendered after the ahead/behind indicators, positioned on the right side of the row. Colors match `ConflictStatusValue`: green, yellow, orange, red, gray. Tooltip shows the status label. This is visually distinct from Phase 4's stack depth indentation (which affects the left side/padding of the row).

#### Implementation Order

1. **Types + IPC** (30 min): Add all conflict types to `types.ts`, channels to `ipc.ts`, preload bridge, type declarations
2. **DB migration** (30 min): Add `conflict_predictions` table in kvDb migration
3. **git merge-tree in gitService** (45 min): Add `mergeTree()` method with output parsing
4. **conflictService core** (3 hr): Implement `predictLaneVsBase`, `predictPairwise`, `computeRiskMatrix`, `simulateMerge`, `runBatchAssessment`, prediction storage, status computation
5. **Job engine integration** (1 hr): Add `conflictPrediction` job type, wire session-end trigger, add periodic timer
6. **Realtime conflict pass** (1 hr): File overlap fast-path on diff changes, targeted job queuing
7. **Lane row badges** (30 min): Conflict status dot in `LaneRow.tsx` with color mapping and tooltip
8. **ConflictsPage layout** (1.5 hr): 3-panel structure, lane list with status sorting, view toggle
9. **ConflictSummary** (1.5 hr): Overlapping files table, base drift, peer overlaps, last prediction timestamp
10. **RiskMatrix** (2 hr): CSS Grid, color-coded cells, cell click interaction, tooltip, diagonal (lane-to-base)
11. **MergeSimulationPanel** (1.5 hr): Lane pair dropdowns, simulate button, result display (clean/conflict/error), diff stat, conflicting files preview
12. **ConflictFileDiff** (1 hr): Monaco diff view showing conflict markers for specific files from simulation
13. **Conflict pack generation** (1 hr): Assemble context bundle (both sides, base, overlaps, lane pack summaries) as markdown for future hosted agent
14. **Batch assessment** (30 min): "Run Full Assessment" button that predicts all lanes and all pairs, updates entire matrix

**Feature Doc References**: `CONFLICTS.md`

**Architecture References**: `GIT_ENGINE.md` (merge-tree), `JOB_ENGINE.md` (periodic prediction jobs), `DATA_MODEL.md` (conflict_predictions table)

**Task References**:
- CONF-001: Conflict prediction service (dry-merge engine)
- CONF-002: `git merge-tree` integration in gitService
- CONF-003: Lane conflict status computation and caching
- CONF-004: Conflict status badges in lane rows
- CONF-005: Realtime conflict chips
- CONF-006: Conflicts tab page layout (3-panel)
- CONF-007: Lane list with conflict status (left panel)
- CONF-008: Conflict summary panel
- CONF-009: Pairwise risk matrix view
- CONF-010: Risk matrix color coding and cell interaction
- CONF-011: Merge simulation service (backend)
- CONF-012: Merge simulation UI
- CONF-013: Conflict file diff viewer
- CONF-014: Periodic conflict prediction job
- CONF-015: Realtime conflict pass
- CONF-016: Conflict pack generation
- CONF-023: Batch conflict assessment

**Note**: CONF-022 (Stack-aware conflict resolution) has been moved to Phase 7 (GitHub Integration + Workspace Graph). It requires Phase 4's stack model and Phase 5's conflict engine, both of which are now complete.

**New Services Required**:
- `conflictService`: dry-merge simulation, prediction storage, risk matrix computation, merge simulation, batch assessment

**Dependencies**: Phase 1 (lane service, git service), Phase 2 (job engine). No dependency on Phase 4.

**Exit Criteria**: Conflict predictions run periodically and on demand. Lane rows show conflict status badges. The Conflicts tab displays the risk matrix and conflict summaries. Merge simulation previews the outcome of merging any two lanes. Conflict packs are generated for future hosted agent consumption. Batch assessment produces a full all-lanes report.

---

## Completed Phases (continued)

### Phase 6: Cloud Infrastructure + Auth + LLM Gateway

**Status**: DONE (2026-02-12, commit `030ed04`)

**Goal**: Stand up the AWS cloud infrastructure and desktop integration that enables authenticated access, persistent cloud storage, and LLM-powered features — the foundation all subsequent phases build on.

**AWS Deployment Context:**
- Account: `695094375923` (shared account — all resources MUST be prefixed with `ade-` and tagged with `project: ade`)
- IAM User: `ArulSharma` (AWS profile: `arulsharma`)
- Deployment: SST (Serverless Stack) with TypeScript
- See `docs/architecture/CLOUD_BACKEND.md` for full naming conventions, resource tagging, and architecture details

**Scope** (all delivered):
- AWS infrastructure via SST (Serverless Stack):
  - API Gateway + Clerk JWT authentication for desktop hosted access
  - S3 buckets for mirror storage and job artifacts (blobs, manifests, artifacts)
  - SQS queues for job processing (with DLQ and CloudWatch alarms)
  - DynamoDB tables for projects, lanes, jobs, artifacts, and rate limits
  - Lambda functions for API endpoints and job workers
- Auth flow: Clerk OAuth (GitHub/Google social sign-in, public client + PKCE) with desktop loopback redirect (`127.0.0.1:42420/callback`)
- Repo mirror sync: content-addressed blobs + per-lane manifests uploaded from desktop
- Cloud job processing: SQS queue consumer Lambda workers (NarrativeGeneration, ProposeConflictResolution, DraftPrDescription)
- LLM gateway module: prompt templates, model routing (Anthropic, OpenAI, Gemini, Mock), token budgets
- Rate limiting: per-minute, daily jobs, and daily estimated token budgets via DynamoDB
- Pack narrative augmentation via LLM (`hostedAgentService.requestLaneNarrative()`)
- Conflict resolution proposals via LLM (`hostedAgentService.requestConflictProposal()`)
- Proposal review and apply workflow in desktop (preview diff, apply with `git apply --3way`, undo with `git apply -R`)
- Hosted agent consent flow integration (consent checkboxes in SettingsPage + StartupAuthPage)
- Pack sync to hosted mirror (`hostedAgentService.syncPacks()`)
- Secret redaction rules (`redactSecrets()` in desktop + cloud — API keys, tokens, PEM keys, GitHub PATs)
- Exclude rules configuration (default + user-configurable patterns in SettingsPage)
- Provider configuration UI: Hosted / BYOK / CLI radio selector with config forms
- API key management: secure password input, local.yaml storage, validation
- Transcript upload opt-in toggle with conditional sync
- Startup auth page for first-run sign-in/guest decision
- OS secure storage for auth tokens via `safeStorage`

**Feature Doc References**: `CONFLICTS.md` (CONF-017 through CONF-021), `PACKS.md` (PACK-021, PACK-023, PACK-025), `ONBOARDING_AND_SETTINGS.md` (ONBOARD-012, ONBOARD-014, ONBOARD-015)

**Architecture References**: `CLOUD_BACKEND.md`, `HOSTED_AGENT.md`, `SECURITY_AND_PRIVACY.md`

**Task References**:
- CONF-017: Hosted agent proposal integration — DONE
- CONF-018: Proposal diff preview in UI — DONE
- CONF-019: Proposal apply with operation record — DONE
- CONF-020: Proposal confidence scoring display — DONE
- CONF-021: Proposal undo via operation timeline — DONE
- PACK-021: LLM-powered narrative generation — DONE
- PACK-023: Pack sync to hosted mirror — DONE
- PACK-025: Pack privacy controls (redaction rules) — DONE
- ONBOARD-012: Hosted agent consent flow — DONE
- ONBOARD-014: Provider configuration UI — DONE
- ONBOARD-015: API key management — DONE
- TERM-028: Transcript upload opt-in (hosted mirror) — DONE

**Deferred to Phase 7**: PACK-024 (pack retention and cleanup policy) — implemented (pack service cleanup for archived lanes/conflict packs).

**Services Implemented**:
- `hostedAgentService` (desktop): Clerk OAuth PKCE sign-in, mirror sync (blobs/manifests/packs/transcripts), job submission/polling, conflict proposal orchestration, narrative generation orchestration, auth token management via OS secure storage
- `llmGateway` (cloud): Multi-provider LLM routing (Anthropic, OpenAI, Gemini, Mock), token budget enforcement, prompt templates
- Lambda API handlers: createProject, getProject, uploadBlobs, updateLaneManifest, submitJob, getJob, getArtifact, deleteProject
- Lambda job worker: NarrativeGeneration, ProposeConflictResolution, DraftPrDescription processing

**IPC Channels** (implemented):
- `ade.hosted.getStatus`, `ade.hosted.getBootstrapConfig`, `ade.hosted.applyBootstrapConfig`
- `ade.hosted.signIn`, `ade.hosted.signOut`
- `ade.hosted.syncMirror`
- `ade.hosted.submitJob`, `ade.hosted.getJob`, `ade.hosted.getArtifact`

**Dependencies**: Phase 2 (pack service), Phase 5 (conflict service, conflict packs)

**Exit Criteria**: All met. AWS infrastructure deploys via SST with all resources prefixed `ade-` and tagged `project: ade`. Desktop authenticates via Clerk social sign-in (GitHub or Google). Mirror sync uploads content-addressed blobs with exclude rules. Cloud jobs process pack narratives and conflict resolutions. Desktop polls for results and presents proposals for user review. Apply and undo workflows function correctly. Provider can be configured (Hosted, BYOK, or CLI). Secret redaction prevents sensitive data from being uploaded.

---

## Upcoming Phases

### Phase 7: GitHub Integration + Canvas PR Workflow + Lane Commit Graph

**Status**: IMPLEMENTED (Desktop)

**Goal**: Connect ADE to GitHub for PR lifecycle management, extend the existing workspace canvas into an interactive PR orchestration surface where developers can open PRs, merge, and resolve conflicts visually, rework the lane detail UI with an inline commit graph, and ensure the conflict resolution pipeline is fully operational end-to-end.

Phase 7 is structured into four sub-phases. 7A (GitHub Integration) and 7D (Lane Commit Graph) have no mutual dependency and can be developed in parallel. 7B (Canvas PR Workflow) depends on 7A. 7C (Conflict Resolution Polish) is independent.

---

#### Phase 7A: GitHub Integration (Foundation)

**Goal**: Build the GitHub service layer and basic PR CRUD so lanes can create, track, and land pull requests.

**Scope**:

- CONF-022: Stack-aware conflict resolution (resolve parent lane conflicts before children)
- GitHub authentication: OS keychain token storage and retrieval (macOS Keychain, Windows Credential Manager)
- GitHub API integration service (`githubService`): wraps `gh` CLI or GitHub REST/GraphQL API
- PR creation from lane, PR link to existing, PR status display and polling
- Pack-generated PR description drafting via LLM (uses Phase 6 LLM gateway)
- PR description update (push regenerated description to GitHub)
- Lane PR panel component (sub-tab in Lane detail, replacing current stub)
- PR creation form, PR status view, "Open in GitHub" action
- PRs tab page layout (stacked chains view, all PRs list)
- Stacked PR chain visualization, base retargeting
- Land single PR and land stack flow with progress UI
- PR checks integration, PR review status integration
- PR notifications with lane-aware context and deep links
- PR template support (load from `.github/PULL_REQUEST_TEMPLATE.md`)

**New Services Required**:
- `githubService`: GitHub API wrapper (authentication, PR CRUD, checks, reviews, merge)
- `prService`: PR lifecycle management, stack chain logic, land flow orchestration

**Task References**:
- CONF-022: Stack-aware conflict resolution
- PR-001 through PR-020: All PR tasks

---

#### Phase 7B: Canvas PR Workflow (Interactive Graph Orchestration)

**Goal**: Transform the existing workspace canvas from a visualization tool into an interactive PR orchestration surface where developers can open PRs, monitor CI, merge, and resolve conflicts — all through visual graph interactions.

**Prerequisite**: Phase 7A (githubService and prService must exist).

**Already completed (canvas foundation from Phase 4/5/6):**
- React Flow canvas with custom nodes (Primary, Worktree, Attached) and edges (Topology, Stack, Risk)
- 4 view modes (Stack/Risk/Activity/All) with layout algorithms
- Full interactivity: drag reparent, right-click context menu (12 actions), multi-select, batch operations
- Risk edge coloring from conflict service risk matrix
- Merge simulation on edge click
- Layout presets, filters, minimap, theme-aware styling
- Node appearance customization (color, icon, tags)
- Collapsible sub-graphs, environment mapping, loading states

**New scope — PR edge overlays:**
- PR edge type: When a lane has an open PR, render a PR icon badge on the connecting edge to the PR's base (primary or parent lane)
- PR edge color by state: green = open/passing, purple = draft, yellow = changes requested, red = failing checks
- PR edge CI status dot: tiny check/X/spinner icon beside the PR badge
- PR + risk edge coexistence: both visible simultaneously on the same lane pair
- Merged PR edge: solid green with fade-out animation before lane node disappears

**New scope — drag-to-open-PR workflow:**
- Drag a lane node onto the primary node (or any target lane node) to initiate PR creation
- Drop triggers a PR creation modal pre-filled with: title (from branch name), body (auto-drafted from lane pack), base (drop target's branch)
- On PR creation, edge between source and target transitions from risk edge to PR edge with animation
- PR details shown on edge hover: PR number, title, checks summary, review status

**New scope — merge-from-graph workflow:**
- Click a PR edge or drag lane onto target again to open a merge action panel
- Panel shows: PR status summary, checks, reviews, merge readiness
- Actions: "View on GitHub", "Merge PR" (with merge method selector: merge/squash/rebase)
- On successful merge: lane node plays disappearance animation (fade + shrink), edge dissolves
- Remaining risk edges re-evaluate and update colors in real-time (conflict service re-prediction triggered)
- If merge creates new conflicts with other lanes, those edges animate from green to red

**New scope — conflict resolution from graph:**
- Click a red (conflict) risk edge between any two lanes to open an inline conflict resolution panel
- Panel shows: overlapping files, conflict type, risk level
- "Resolve with AI" button: invokes `conflictService.requestProposal()` for the lane pair
- AI proposal displayed inline: explanation, diff preview, confidence score
- Apply actions: "Apply to lane" (stages changes), "Move to unstaged", "Commit directly"
- After applying resolution, edge color animates from red to green as conflict is resolved
- Supports resolution between: lane-to-primary, lane-to-lane, and lane-to-parent

**New scope — integration lane creation:**
- Multi-select several lanes on the canvas, right-click → "Create Integration Lane"
- Creates a new lane branched from primary that merges all selected lanes into one
- Conflict resolution UI opens for any merge conflicts across the combined changes
- After all conflicts resolved, user can open a single PR from the integration lane against main
- Integration lane appears on canvas connected to all source lanes with special "integration" edge type

**New scope — real-time visual feedback:**
- Edge color transitions animate smoothly (CSS transitions on stroke color, ~300ms)
- Merge-in-progress: pulsing animation on the PR edge while merge is executing
- Post-merge cascade: after a lane is merged and removed, all remaining risk edges re-evaluate with a brief loading shimmer
- Conflict resolution: edge animates through yellow (resolving) to green (resolved)
- Lane node removal: fade-out + scale-down animation (~500ms) after successful merge and archive

**New scope — enhanced edge hover details:**
- Hover any edge to see a tooltip with: edge type label, risk level, overlap count, file names
- PR edges show on hover: PR number, title, checks count (pass/fail), review status, last updated
- Risk edges show on hover: conflicting file list, conflict types, staleness indicator
- Tooltip persists while hovering (400ms delay before show, 200ms delay before hide)

**Task References**:
- GRAPH-026: PR edge overlays
- GRAPH-027: PR + risk edge coexistence
- CANVAS-001: Drag-to-open-PR workflow
- CANVAS-002: PR edge state visualization (color, CI dot, merge animation)
- CANVAS-003: Merge-from-graph panel and workflow
- CANVAS-004: Lane disappearance animation on merge
- CANVAS-005: Conflict resolution panel from edge click
- CANVAS-006: AI conflict resolution invocation from graph
- CANVAS-007: Post-resolution edge color animation
- CANVAS-008: Integration lane creation (multi-lane merge)
- CANVAS-009: Real-time edge re-evaluation after merge
- CANVAS-010: Merge-in-progress pulse animation
- CANVAS-011: Enhanced edge hover tooltips (PR details, conflict files)

---

#### Phase 7C: Conflict Resolution Polish

**Goal**: Ensure the full conflict detection → AI resolution → apply pipeline is robust and accessible from both the Conflicts tab and the canvas. Improve pack collection depth for better AI context.

**Scope**:

**Conflict resolution completeness:**
- Verify end-to-end flow: detect conflict → generate AI proposal → review diff → apply → undo
- Lane-to-lane conflict resolution (currently focused on lane-vs-base; extend to arbitrary pairs)
- Apply resolution with choice: move to unstaged, move to staged, or commit directly
- Post-apply conflict re-prediction (trigger immediate re-evaluation of affected pairs)
- Conflict resolution from canvas edges (wired in 7B) with same apply options

**Pack collection improvements:**
- PACK-024: Pack retention and cleanup policy (age-based, count-based)
- Ensure conflict packs include full context for AI: both sides' changed files, base version, overlap analysis, lane pack summaries
- On-demand AI narrative generation: user can click "Generate AI Summary" on any lane pack to request narrative even in hosted mode without waiting for session-end trigger
- Pack freshness indicators in canvas node tooltips (show last pack update time)

**BYOK provider mode (new):**
- Implement actual BYOK code path: direct LLM API calls from the desktop Electron app (no AWS round-trip)
- Support Gemini, Anthropic, and OpenAI providers for BYOK
- Use API key from `.ade/local.yaml` `providers.byok.apiKey`
- Same prompt templates as hosted mode but executed locally
- Eliminates dependency on AWS infrastructure for AI features

**Task References**:
- CONF-022: Stack-aware conflict resolution
- PACK-024: Pack retention and cleanup policy
- BYOK-001: BYOK LLM provider implementation (desktop-direct API calls)
- RESOLVE-001: Lane-to-lane conflict resolution (arbitrary pair)
- RESOLVE-002: Apply resolution with staging choice (unstaged/staged/commit)
- RESOLVE-003: Post-apply conflict re-prediction trigger

---

#### Phase 7D: Lane Commit Graph + Detail UI Rework

**Goal**: Add an inline commit timeline to the lane detail view so developers can see the commit history of each lane at a glance, and rework the lane detail layout to accommodate the new visualization alongside existing unstaged/staged views.

**Scope**:

**Commit timeline component (`CommitTimeline.tsx`):**
- Vertical timeline of commits for the active lane, most recent at top
- Each commit rendered as a node on a vertical line: dot + short SHA + subject
- Hover a commit: tooltip with full SHA, author, date, full message, file count
- Click a commit: select it for diff viewing in the Monaco diff pane (compare commit vs parent)
- Merge commits shown with branching visual (two parent lines converging)
- HEAD indicator: special styling on the top commit (current HEAD)
- Scroll within a fixed-height panel; lazy-loads older commits on scroll
- Extend `git.listRecentCommits` to return parent SHAs for merge line rendering

**Lane detail layout rework:**
- Current layout (top: unstaged/staged split, bottom: Monaco diff) replaced with a 3-column horizontal flow:
  ```
  ┌──────────────┬──────────────┬──────────────────────────┐
  │  Unstaged     │  Staged      │  Commit Timeline         │
  │  files list   │  files list  │  (vertical scrollable)   │
  │               │  + commit    │                          │
  │               │    box       │  ● abc123 Fix auth bug   │
  │               │              │  │                       │
  │               │              │  ● def456 Add tests      │
  │               │              │  │                       │
  │               │              │  ● 789abc Initial commit │
  ├──────────────┴──────────────┴──────────────────────────┤
  │  Monaco Diff Viewer / Git Operations                    │
  │  (shows diff for selected file OR selected commit)      │
  └─────────────────────────────────────────────────────────┘
  ```
- Unstaged column: file list with stage buttons (same as current)
- Staged column: file list with unstage buttons + commit message textarea + commit button (same as current)
- Commit timeline column: new `CommitTimeline` component
- Bottom pane: Monaco diff viewer that responds to both file selection (from unstaged/staged) AND commit selection (from timeline)
- When a commit is selected in the timeline, diff viewer shows that commit's changes (commit vs parent)
- When a file is selected from unstaged/staged, diff viewer shows working tree or index diff (same as current)
- Git operation buttons (fetch, pull, push, stash, revert, cherry-pick) remain in the header bar

**Inspector sub-tab updates:**
- Replace Conflicts stub tab with live conflict status (uses existing `conflictService.getLaneStatus()`)
- Replace PR stub tab with live PR panel (uses new `prService` from 7A)

**Task References**:
- COMMIT-001: CommitTimeline component (vertical line, commit nodes, hover details)
- COMMIT-002: Extend listRecentCommits API to include parent SHAs
- COMMIT-003: Click commit to view diff in Monaco
- COMMIT-004: Merge commit branching visual
- COMMIT-005: Lazy-load older commits on scroll
- LANE-UI-001: Lane detail 3-column layout rework (unstaged / staged / commit timeline)
- LANE-UI-002: Dual-mode diff viewer (file selection + commit selection)
- LANE-UI-003: Inspector Conflicts sub-tab (live, replaces stub)
- LANE-UI-004: Inspector PR sub-tab (live, replaces stub)

---

#### Phase 7 — Cross-Cutting Notes

**Service-layer work already completed (ahead of schedule):**
- Full workspace canvas: `WorkspaceGraphPage.tsx` (2,738 lines) with React Flow, custom nodes/edges, 4 view modes, drag reparent, context menus, multi-select, batch operations, layout presets, filters, minimap
- `laneService.reparent()` method and `laneService.updateAppearance()` method
- IPC channels `lanesReparent` and `lanesUpdateAppearance`
- Preload bridge methods for reparent and updateAppearance
- Types: `ReparentLaneArgs`, `AppearanceUpdate`, `GraphState`
- Full conflict detection and AI resolution pipeline (conflictService, hostedAgentService)
- Pack system: lane packs, project packs, conflict packs all generating and syncing

**Feature Doc References**: `PULL_REQUESTS.md`, `WORKSPACE_GRAPH.md`, `CONFLICTS.md` (CONF-022)

**Architecture References**: `UI_FRAMEWORK.md`, `DATA_MODEL.md`, `SECURITY_AND_PRIVACY.md`

**New Services Required**:
- `githubService`: GitHub API wrapper (authentication, PR CRUD, checks, reviews, merge)
- `prService`: PR lifecycle management, stack chain logic, land flow orchestration

**Dependencies**: Phase 1 (lane service, git push), Phase 4 (stacks), Phase 5 (conflict service), Phase 6 (LLM gateway for PR descriptions, Clerk for auth)

**Implementation Order**:
1. **7A + 7D in parallel**: GitHub service build-out and lane commit graph are independent
2. **7B after 7A**: Canvas PR workflow depends on prService existing
3. **7C any time**: Conflict resolution polish and BYOK can be done at any point

**Exit Criteria**: GitHub token is securely stored in OS keychain. PRs can be created from lanes and from the canvas via drag-to-open-PR. PR status is displayed and polled. PR edges on the canvas show CI status and review state. Stacked PRs correctly target parent branches. Landing works from both the PRs tab and the canvas (drag-to-merge or click-edge). Lane nodes animate out on merge; risk edges re-evaluate in real-time. Conflict resolution is launchable from canvas edge clicks with AI proposal generation, apply, and undo. Integration lanes can be created from multi-select. Lane detail shows a 3-column layout with inline commit timeline. Commits are clickable for diff viewing. BYOK provider mode makes direct API calls without AWS round-trip. Pack retention policies are enforced.

---

### Phase 8: Automations + Onboarding + Packs V2

**Status**: IN PROGRESS (core implemented: automations, onboarding wizard, packs v2; remaining onboarding seeding/import items tracked in feature docs)

**Goal**: Add user-configurable automation workflows, a guided onboarding experience with intelligent project detection, and evolve the pack system to support versioning, checkpoints, and new pack types.

**Scope**:

**Automations:**
- Automation rule schema definition and validation in config (`automations` key in `ade.yaml` / `local.yaml`)
- Automation service: parse rules, register trigger listeners, evaluate conditions
- Triggers: session-end, commit, schedule (cron via node-cron)
- Actions: update-packs, predict-conflicts, sync-to-mirror, run-tests, run-command
- Action chaining with sequential execution and failure handling
- Conditional execution (evaluate conditions per action)
- Automation management UI (list, toggles, detail with history)
- Enable/disable toggle, manual trigger button
- Execution history display
- Automation run logging (SQLite `automation_runs` and `automation_action_results` tables)
- Error handling, retry, and lane-aware failure notifications

**Onboarding:**
- Project defaults detection (scan for `package.json`, `Makefile`, `docker-compose.yml`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `.github/workflows/`)
- Onboarding wizard UI (step-by-step modal with progress)
- Suggested process and test definitions from detection results
- Config review step (editable form before saving)
- "What ADE will do" previews (pre-execution dialogs for shared config commands)
- Initial codebase scan for pack seeding
- Existing documentation import for richer pack seeding
- Existing lane/branch detection (scan for branches/worktrees)
- Initial pack generation trigger
- CI/CD workflow scan and import (parse GitHub Actions, GitLab CI, etc.)
- CI/CD sync mode
- Welcome guide with feature highlights
- Project switching (recent projects list)
- Keybindings viewer and customization
- Data management (clear local data, export config, delete mirror data)

**Packs V2:**
- Checkpoint creation at session boundaries (immutable snapshot with SHA, diff stat)
- Checkpoint storage and indexing (SQLite `checkpoints` table + filesystem)
- Pack event logging (append-only event log)
- Pack version snapshots (immutable rendered markdown with content hashes)
- Pack head pointers (mutable, atomic updates)
- Feature pack type (issue-scoped, cross-lane aggregation)
- Conflict pack type (resolution context bundle)
- Plan pack type (versioned planning documents)
- Narrative editing (user override of auto-generated content)
- Pack diff (compare two versions)
- Checkpoint creation on session end (terminal integration)

**Feature Doc References**: `AUTOMATIONS.md`, `ONBOARDING_AND_SETTINGS.md`, `PACKS.md`, `HISTORY.md`

**Architecture References**: `JOB_ENGINE.md`, `CONFIGURATION.md`, `DATA_MODEL.md`

**Task References**:
- AUTO-003 through AUTO-020: All automation tasks
- ONBOARD-007 through ONBOARD-024: All remaining onboarding tasks
- PACK-012 through PACK-022: Packs V2 tasks
- PACK-027 through PACK-029: Initial pack generation
- PROJ-036, PROJ-037: CI/CD import
- HIST-011 through HIST-014: History/checkpoint tasks
- TERM-029: Checkpoint on session end

**New Services Required**:
- `automationService`: rule parsing, trigger registration, condition evaluation, run logging
- `onboardingService`: project defaults detection, suggested config, wizard state

**Dependencies**: Phase 0 (session service), Phase 2 (job engine, pack service, config service), Phase 5 (conflict service), Phase 6 (cloud backend, LLM gateway for PACK-021 and AUTO-010)

**Exit Criteria**: Automation rules can be defined in YAML and managed in the UI. Triggers fire and actions execute with history tracking. First-run wizard detects project type and suggests defaults. Initial packs are generated from codebase scan. CI/CD workflows are importable. Checkpoints are created automatically. Pack versions are immutable with content hashes. New pack types work. Users can edit narratives and diff pack versions.

---

### Phase 9: Advanced Features + Polish + Runtime Isolation

**Status**: NOT STARTED

**Goal**: Complete the product with advanced history features, terminal enhancements, agent tooling, performance optimization, and per-lane runtime isolation for parallel development.

**Scope**:

**History Enhancements:**
- Feature history (filtered by feature/issue tag across lanes)
- History graph view (visual timeline with parallel lane tracks)
- Checkpoint browser (navigate to past repo state, read-only file browser)
- Undo operation (reverse git action via history)
- Replay operation sequence (dry-run re-execution)
- Plan version history
- Jump-to-lane and jump-to-session links from operation detail
- Export history as CSV/JSON

**Terminal Enhancements:**
- Tiling layout (split horizontal/vertical)
- Drag to rearrange tiles
- Grid view (multi-terminal overview)
- Session goal/purpose tagging
- Tool type detection (Claude, Cursor, shell, etc.)
- Session transcript search
- Pin important sessions

**Advanced Git Operations:**
- Primary lane support (main repo dir, no separate worktree)
- Attached lane support (link existing external worktree)
- Amend commit
- Branch create/delete/rename from lane
- Reset (soft/mixed/hard) with confirmation dialog
- Lane profiles (preset configs per lane type)

**Run Tab Enhancements:**
- AI-suggested run prompts (detect new suites/services)
- Run prompt suggestion cards UI
- Agent CLI tools detection (Claude Code, Codex, Cursor, Aider, Continue)
- Agent commands and skills viewer
- Agent command editing
- Agent tool quick-launch
- Process restart policies, health monitoring, env var editor
- Test suite tags/filtering, test result diff
- Config diff viewer, config import/export

**Cross-Surface UX:**
- Global identity bar (project, lane, branch, cwd, environment)
- PR attention queue ("needs human action")
- Mission-control overview for project switching

**Performance and Quality:**
- Render batching, virtual scrolling for large lists
- Error handling hardening, graceful degradation
- Cross-platform testing and fixes (macOS, Windows, Linux)

**Local Runtime Isolation:**
- Lane runtime identity model (stable hostname, deterministic ports)
- Deterministic port allocation service with lane/process leases
- Local host orchestration layer (reverse proxy)
- Preview launcher (correct lane URL from ADE)
- Optional per-lane browser profile integration
- Per-lane runtime diagnostics
- Fallback mode and escape hatches

**Feature Doc References**: `HISTORY.md`, `TERMINALS_AND_SESSIONS.md`, `LANES.md`, `PROJECT_HOME.md`

**Architecture References**: `UI_FRAMEWORK.md`, `GIT_ENGINE.md`, `DESKTOP_APP.md`

**Task References**:
- HIST-015 through HIST-023: History enhancements
- TERM-021 through TERM-031: Terminal enhancements
- LANES-024, LANES-025, LANES-030 through LANES-038: Advanced lane operations
- PROJ-026 through PROJ-032, PROJ-035, PROJ-038 through PROJ-042: Run tab enhancements
- PACK-026: Pack export
- CONF-024: Conflict notification/alerts

**New Services Required**:
- `laneRuntimeService`: lane runtime identity, port leasing, diagnostics
- `laneProxyService`: local reverse proxy and host-to-port routing
- `browserProfileService`: per-lane browser profile lifecycle
- `previewLaunchService`: lane-aware URL and browser launch

**Dependencies**: All prior phases

**Exit Criteria**: All task IDs across all feature docs are marked DONE. History graph view renders parallel tracks. Checkpoint browser works. Terminal tiling enables split views. Agent CLI tools detected and launchable. Performance smooth with large repos. Cross-platform verified. Runtime isolation enables 3+ active lanes without port conflicts.

---

## Cross-Cutting Concerns

### Testing Strategy

Testing is applied incrementally as each phase is built, not deferred to a final testing phase.

| Layer | Approach | Scope |
|-------|----------|-------|
| **Unit tests** | Vitest for all service logic in the main process | Git operations parsing, delta computation, pack generation, conflict prediction algorithms, config validation |
| **Integration tests** | Vitest with real SQLite and filesystem | Service-to-service interactions, IPC round-trips, job engine pipeline, operation recording |
| **Component tests** | React Testing Library + Vitest | Individual React components (lane row, session card, diff viewer, file tree node) |
| **E2E tests** | Playwright or Spectron | Full application flows (create lane, open terminal, commit, view diff, create PR) |

Each phase's exit criteria implicitly include tests for all new services and critical UI paths. Tests are written alongside implementation, not after.

### Performance Requirements

| Metric | Target | Affected Phases |
|--------|--------|----------------|
| App startup to interactive | < 2 seconds | All phases (regression monitoring) |
| PTY output latency (main to renderer) | < 16ms (one frame) | Phase 0 |
| File tree render (1000 files) | < 200ms | Phase 3 |
| Diff view render (large file) | < 500ms | Phase 1, Phase 3 |
| Conflict prediction (10 lanes) | < 5 seconds | Phase 5 |
| Pack generation (single lane) | < 3 seconds | Phase 2 |
| Graph canvas render (50 nodes) | < 100ms | Phase 7 |
| SQLite query (any single query) | < 50ms | All phases |

### Security Considerations

Security is not a separate phase; it is enforced at every layer from Phase -1 onward.

| Concern | Implementation | Enforced From |
|---------|---------------|---------------|
| **Process isolation** | Renderer has zero Node.js access; all system calls go through typed IPC allowlist | Phase -1 |
| **Secret protection** | API keys in `local.yaml` (gitignored); GitHub tokens in OS keychain only; never in SQLite or config files | Phase 6, Phase 7 |
| **Configuration trust** | SHA-based trust model for shared config; user approval before executing any commands from `ade.yaml` | Phase 2 |
| **Hosted mirror redaction** | Secret redaction rules strip `.env`, credentials, API keys before upload; user-configurable exclude patterns | Phase 6 |
| **Transcript privacy** | Terminal output may contain secrets; transcripts are local-only unless user explicitly opts in to hosted upload | Phase 0, Phase 6 |
| **Proposal safety** | LLM-generated diffs are previewed before application; all applications create operation records for undo | Phase 6 |
| **Git safety** | Destructive operations (force push, hard reset) require confirmation dialog; all operations tracked with pre/post SHA | Phase 1 |
| **IPC allowlist** | Only explicitly registered IPC channels are accessible from the renderer; no wildcard patterns | Phase -1 |

### Accessibility

- All interactive elements are keyboard-navigable (enforced per phase)
- ARIA labels on custom components (lane rows, session cards, tree nodes)
- High contrast mode compatibility (both themes meet WCAG AA for text contrast)
- Focus management for modals and dialogs
- Screen reader compatibility for critical workflows (lane selection, git operations, PR creation)

### Error Handling Philosophy

Every phase follows a consistent error handling pattern:

1. **Service layer**: Operations return structured results (`{ success: boolean; error?: string; data?: T }`) rather than throwing
2. **IPC layer**: Errors are serialized and transmitted to the renderer with user-friendly messages
3. **UI layer**: Toast notifications for transient errors; inline error displays for form validation; modal dialogs for destructive operation failures
4. **Recovery**: Failed operations are recorded in the history timeline with error context, enabling debugging without log diving

---

## Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Affected Phases |
|----|------|-----------|--------|------------|----------------|
| R-01 | `node-pty` native module compatibility across Electron versions | Medium | High | Pin Electron and node-pty versions together; test upgrades in isolation; maintain fallback to basic shell spawn | Phase 0 |
| R-02 | Monaco Editor bundle size impacts startup time | Medium | Medium | Lazy-load Monaco only when Files or Diff tabs are activated; use code splitting; monitor startup metrics | Phase 3 |
| R-03 | `git merge-tree` behavior varies across git versions | Medium | Medium | Require git >= 2.38 (when merge-tree gained the 3-way merge mode); document minimum version; fall back to temp-index approach for older git | Phase 5 |
| R-04 | GitHub API rate limiting impacts PR status polling | High | Low | Implement exponential backoff; cache responses; use conditional requests (ETag/If-Modified-Since); allow user-configurable poll interval | Phase 7 |
| R-05 | LLM output quality varies unpredictably for narrative generation | High | Medium | Always pair LLM narratives with deterministic data; show confidence scores; allow user override/editing; implement human-in-the-loop review | Phase 6 |
| R-06 | Large repositories (100K+ files) cause file tree performance issues | Medium | Medium | Lazy loading with depth limiting; virtual scrolling; gitignore filtering; debounced file watching; avoid full-tree loads | Phase 3 |
| R-07 | Stacked rebase operations can fail in complex merge scenarios | Medium | High | Validate stack integrity before restack; provide clear error messages with recovery instructions; record all SHA transitions for manual recovery | Phase 4 |
| R-08 | AWS cold start latency for Lambda workers impacts job response time | Medium | Low | Use provisioned concurrency for critical job types; implement client-side polling with exponential backoff; show progress indicators | Phase 6 |
| R-09 | Cross-platform differences in PTY behavior (Windows vs macOS vs Linux) | Medium | Medium | Test on all three platforms per release; use platform-specific shell detection; handle signal differences (SIGTERM vs TerminateProcess) | Phase 0, Phase 9 |
| R-10 | sql.js (WASM) write performance under heavy operation recording | Low | Medium | Debounced flush strategy (125ms); batch writes during rapid operations; monitor flush frequency; fall back to native SQLite if needed | All phases |
| R-11 | React Flow performance degrades with many nodes and edges (50+ lanes) | Low | Medium | Virtualize off-screen nodes; throttle edge recomputation; limit risk overlay edges to top-N risks; implement level-of-detail rendering | Phase 7 |
| R-12 | Secret leakage via terminal transcripts uploaded to hosted mirror | Medium | High | Transcript upload is opt-in only; apply redaction rules before upload; scan for common secret patterns; provide audit log of uploaded content | Phase 6 |
| R-13 | Concurrent worktree operations cause git lock contention | Medium | Medium | Serialize git operations per-worktree via job engine; implement lock file detection with retry; provide clear "repository locked" error messages | Phase 1, Phase 4 |

---

*This document is the authoritative implementation plan for ADE. It is maintained alongside the feature and architecture documentation and updated as phases are completed. All task IDs referenced here are defined in their respective feature documents under `docs/features/`.*
