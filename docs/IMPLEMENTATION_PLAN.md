# ADE Implementation Plan

> Last updated: 2026-02-11

---

## Table of Contents

1. [Overview](#overview)
2. [Phase Summary](#phase-summary)
3. [Completed Phases](#completed-phases)
   - [Phase -1: Repo + Desktop Scaffold](#phase--1-repo--desktop-scaffold)
   - [Phase 0: Terminals + Session Tracking](#phase-0-terminals--session-tracking)
   - [Phase 1: Lanes Cockpit + Diffs + Git Operations](#phase-1-lanes-cockpit--diffs--git-operations)
   - [Phase 2: Project Home (Processes + Tests + Config)](#phase-2-project-home-processes--tests--config)
4. [Upcoming Phases](#upcoming-phases)
   - [Phase 3: Files Tab + UI Polish](#phase-3-files-tab--ui-polish)
   - [Phase 4: Stacks + Restack](#phase-4-stacks--restack)
   - [Phase 5: Conflict Radar + Resolution](#phase-5-conflict-radar--resolution)
   - [Phase 6: Pull Requests + GitHub + Stack-Conflict Integration](#phase-6-pull-requests--github--stack-conflict-integration)
   - [Phase 7: Packs V2 (Checkpoints + Versioning + Events)](#phase-7-packs-v2-checkpoints--versioning--events)
   - [Phase 8: Workspace Graph](#phase-8-workspace-graph)
   - [Phase 9: Automations](#phase-9-automations)
   - [Phase 10: Onboarding Wizard + Settings Polish](#phase-10-onboarding-wizard--settings-polish)
   - [Phase 11: Hosted Agent + Cloud Backend](#phase-11-hosted-agent--cloud-backend)
   - [Phase 12: Advanced Features + Polish](#phase-12-advanced-features--polish)
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
| `CLOUD_BACKEND.md` | AWS serverless stack (SST, Cognito, S3, SQS, DynamoDB, Lambda) |
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
| 4 | Stacks + Restack | NOT STARTED | Parent-child lanes, stack graph, restack operations |
| 5 | Conflict Radar + Resolution | NOT STARTED | Conflict prediction, risk matrix, merge simulation |
| 6 | Pull Requests + GitHub + Stack-Conflict Integration | NOT STARTED | GitHub auth, PR CRUD, stacked PRs, land flow, stack-aware conflicts (CONF-022) |
| 7 | Packs V2 (Checkpoints + Versioning + Events) | NOT STARTED | Checkpoint creation, pack versions, event log, new pack types |
| 8 | Workspace Graph | NOT STARTED | React Flow canvas, lane nodes, risk edges, environment mapping, PR edge overlays, minimap |
| 9 | Automations | NOT STARTED | Trigger-action rules, action chaining, automation UI |
| 10 | Onboarding Wizard + Settings Polish | NOT STARTED | Default detection, setup wizard, initial pack generation, CI/CD import, provider config, keybindings |
| 11 | Hosted Agent + Cloud Backend | NOT STARTED | AWS infra, auth, mirror sync, LLM gateway, proposals |
| 12 | Advanced Features + Polish | NOT STARTED | History graph, checkpoint browser, undo, tiling, advanced git, agent CLI tools, AI-suggested run prompts |

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

## Upcoming Phases

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

**Status**: NOT STARTED

**Goal**: Enable stacked development workflows where child lanes build on parent lanes, with visualization and restack operations to propagate parent changes downstream.

**Parallel development note**: This phase can be developed in a separate worktree lane simultaneously with Phase 5 (Conflicts). The two phases share no services and only have minor additive overlaps in `types.ts`, `ipc.ts`, and `LaneRow.tsx` (different visual regions). Merge Phase 4 first (smaller scope), then Phase 5, resolving trivial additive conflicts.

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

**Status**: NOT STARTED

**Goal**: Surface integration risk proactively by predicting merge conflicts before they happen, displaying risk across all lanes, and enabling merge simulation between any pair of lanes.

**Parallel development note**: This phase can be developed in a separate worktree lane simultaneously with Phase 4 (Stacks). The two phases have no service dependencies. CONF-022 (stack-aware conflict resolution) has been moved to Phase 6 where both phases will be merged. The only shared-file overlaps are additive additions to `types.ts`, `ipc.ts`, and `LaneRow.tsx` (conflict badges go in a different region than stack depth indicators).

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

**Note**: CONF-022 (Stack-aware conflict resolution) has been moved to Phase 6. It requires Phase 4's stack model and will be implemented after both Phase 4 and Phase 5 are merged.

**New Services Required**:
- `conflictService`: dry-merge simulation, prediction storage, risk matrix computation, merge simulation, batch assessment

**Dependencies**: Phase 1 (lane service, git service), Phase 2 (job engine). No dependency on Phase 4.

**Exit Criteria**: Conflict predictions run periodically and on demand. Lane rows show conflict status badges. The Conflicts tab displays the risk matrix and conflict summaries. Merge simulation previews the outcome of merging any two lanes. Conflict packs are generated for future hosted agent consumption. Batch assessment produces a full all-lanes report.

---

### Phase 6: Pull Requests + GitHub Integration + Stack-Conflict Integration

**Status**: NOT STARTED

**Goal**: Connect ADE lanes to GitHub pull requests, enabling PR creation, monitoring, and landing directly from the development cockpit, with full support for stacked PR chains. Also integrates Phase 4 (stacks) and Phase 5 (conflicts) by adding stack-aware conflict resolution.

**Scope**:
- CONF-022: Stack-aware conflict resolution — resolve parent lane conflicts before children (requires both Phase 4 stacks and Phase 5 conflicts to be merged)
- GitHub authentication: OS keychain token storage and retrieval (macOS Keychain, Windows Credential Manager)
- GitHub API integration service (`githubService`): wraps `gh` CLI or GitHub REST/GraphQL API
- PR creation from lane (GitHub API call, local record in SQLite)
- PR link to existing (by URL or number, fetch and store)
- PR status display (state badge, checks icon, review icon)
- PR status polling (periodic refresh from GitHub)
- Pack-generated PR description drafting (from lane pack content)
- PR description update (push regenerated description to GitHub)
- Lane PR panel component (sub-tab in Lane detail)
- PR creation form (title, body, base branch, draft toggle, labels, reviewers)
- PR status view (checks, reviews, conflicts)
- "Open in GitHub" action (launch external browser)
- PRs tab page layout (stacked chains view, all PRs list with sortable columns and filters)
- Stacked PR chain visualization (node graph showing parent-child PR relationships)
- Base retargeting for stacked PRs (update via GitHub API when parent merges)
- Land single PR (merge, delete remote branch, archive lane)
- Land stack flow (ordered merge with retarget, cleanup, progress UI)
- PR checks integration (CI status detail view)
- PR review status integration (reviewer list, comments preview)
- PR notifications (check failures, review requests, merge ready)
- PR template support (load from `.github/PULL_REQUEST_TEMPLATE.md`)

**Feature Doc References**: `PULL_REQUESTS.md`

**Architecture References**: `SECURITY_AND_PRIVACY.md` (secret protection -- tokens in keychain only), `DATA_MODEL.md` (pull_requests table)

**Task References**:
- CONF-022: Stack-aware conflict resolution (resolve parent lane conflicts first) — moved from Phase 5
- PR-001: GitHub authentication (OS keychain)
- PR-002: GitHub API integration service
- PR-003: PR creation from lane
- PR-004: PR link to existing
- PR-005: PR status display
- PR-006: PR status polling
- PR-007: Pack-generated PR description drafting
- PR-008: PR description update
- PR-009: Lane PR panel component
- PR-010: PR creation form and PRs tab page layout
- PR-011: PR status view and all PRs list
- PR-012: "Open in GitHub" action
- PR-013: Stacked PR chain visualization
- PR-014: Base retargeting for stacked PRs
- PR-015: Land single PR
- PR-016: Land stack flow
- PR-017: Land progress UI and PR checks integration
- PR-018: PR review status integration
- PR-019: PR notifications
- PR-020: PR template support

**New Services Required**:
- `githubService`: GitHub API wrapper (authentication, PR CRUD, checks, reviews, merge)
- `prService`: PR lifecycle management, stack chain logic, land flow orchestration

**Dependencies**: Phase 1 (lane service, git push). Phase 4 (stacks) required for stacked PR features (PR-013, PR-014, PR-016). Phase 2 (pack service) required for PR-007.

**Exit Criteria**: GitHub token is securely stored in OS keychain. PRs can be created and linked from lanes. PR status (state, checks, reviews) is displayed and polled. Stacked PRs correctly target parent branches. Landing a single PR and a full stack works end-to-end with progress tracking.

---

### Phase 7: Packs V2 (Checkpoints + Versioning + Events)

**Status**: NOT STARTED

**Goal**: Evolve the pack system from simple snapshots to a versioned, event-driven context history with checkpoint creation, immutable versions, and new pack types for features, conflicts, and planning.

**Scope**:
- Checkpoint creation at session boundaries (immutable snapshot with SHA, diff stat, session reference)
- Checkpoint storage and indexing (SQLite `checkpoints` table + filesystem at `.ade/history/checkpoints/`)
- Pack event logging (append-only event log in `pack_events` table)
- Pack version snapshots (immutable rendered markdown files with content hashes)
- Pack head pointers (mutable, atomic updates pointing to latest version)
- Feature pack type (issue-scoped, cross-lane aggregation)
- Conflict pack type (resolution context bundle for hosted agent)
- Plan pack type (versioned planning documents)
- Narrative editing (user override of auto-generated content)
- Pack diff (compare two versions side by side)
- Checkpoint creation on session end (terminal integration)

**Feature Doc References**: `PACKS.md`, `HISTORY.md` (HIST-011 through HIST-014), `TERMINALS_AND_SESSIONS.md` (TERM-029)

**Architecture References**: `DATA_MODEL.md` (checkpoints, pack_events, pack_versions, pack_heads tables), `JOB_ENGINE.md` (checkpoint creation job)

**Task References**:
- PACK-012: Checkpoint creation at session boundaries
- PACK-013: Checkpoint storage and indexing
- PACK-014: Pack event logging (append-only)
- PACK-015: Pack version snapshots (immutable)
- PACK-016: Pack head pointers (mutable, atomic)
- PACK-017: Feature pack type
- PACK-018: Conflict pack type
- PACK-019: Plan pack type
- PACK-020: Narrative editing (user override)
- PACK-022: Pack diff (compare versions)
- HIST-011: Checkpoint creation on session end
- HIST-012: Checkpoint storage and indexing
- HIST-013: Pack event logging
- HIST-014: Pack version tracking
- TERM-029: Checkpoint creation on session end

**Dependencies**: Phase 0 (session service), Phase 2 (pack service, job engine). Phase 5 (conflict service) for PACK-018.

**Exit Criteria**: Checkpoints are created automatically when sessions end. Pack versions are immutable snapshots with content hashes. Pack heads track the latest version atomically. Event log records all pack state changes. Feature, conflict, and plan pack types can be generated. Users can edit narratives and diff between pack versions.

---

### Phase 8: Workspace Graph

**Status**: NOT STARTED

**Goal**: Provide a visual, interactive canvas that externalizes the mental model of lane relationships and integration risk, enabling at-a-glance understanding of the project topology.

**Scope**:
- React Flow canvas setup (`@xyflow/react` installation, `WorkspaceGraphPage` route)
- Primary lane node component (larger size, distinct border, centered position)
- Worktree lane node component (standard size, solid border)
- Attached lane node component (dashed border, muted label)
- Node status badges (dirty indicator, ahead/behind counts, conflict indicator)
- Active session indicator (pulsing dot on nodes with running terminals)
- Topology edges (solid lines from primary to each worktree)
- Stack edges (arrow edges from parent to child, thicker stroke)
- Risk overlay edges (dashed lines colored by conflict risk level)
- Edge state coloring from risk matrix data (green/blue/red/gray)
- Pan and zoom controls (zoom buttons, fit-to-view, scroll-wheel zoom)
- Auto-layout algorithm (initial positioning based on lane relationships)
- Manual node repositioning with drag (position persistence on drop)
- Layout persistence via kvDb (save/restore across app restarts)
- Click node to navigate to lane detail view
- Click edge to open merge simulation panel
- Merge simulation result display (prediction badge, conflicting files, diff preview)
- Node context menu (right-click: Open, Archive, Delete, Create Child)
- Minimap (React Flow minimap in bottom-right corner)
- Multi-select (Shift+click, drag-box selection)
- Zoom-to-fit button
- Theme-aware styling (colors adapt to dark/light themes)
- Environment mapping configuration (branch-to-environment in ade.yaml: main=PROD, develop=STAGING, etc.)
- Environment badge rendering on nodes (badge label + configured color)
- Environment-aware auto-layout (environment branches centered, feature branches radiate outward)
- PR edge overlays (PR icon badge on edges, colored by PR state, check status dot)
- PR + risk edge coexistence (both visible simultaneously on same lane pair)
- Environment legend (color key panel in canvas corner)

**Feature Doc References**: `WORKSPACE_GRAPH.md`

**Architecture References**: `UI_FRAMEWORK.md` (React Flow integration), `DATA_MODEL.md` (layout persistence in kvDb)

**Task References**:
- GRAPH-001 through GRAPH-028: All TODO
  - Canvas setup: GRAPH-001
  - Node components: GRAPH-002, GRAPH-003, GRAPH-004, GRAPH-005, GRAPH-006
  - Edge components: GRAPH-007, GRAPH-008, GRAPH-009, GRAPH-010
  - Canvas controls: GRAPH-011, GRAPH-012, GRAPH-013, GRAPH-014
  - Interactions: GRAPH-015, GRAPH-016, GRAPH-017, GRAPH-018, GRAPH-019, GRAPH-020, GRAPH-021
  - Theming: GRAPH-022
  - Environment mapping: GRAPH-023, GRAPH-024, GRAPH-025, GRAPH-028
  - PR overlays: GRAPH-026, GRAPH-027

**Dependencies**: Phase 1 (lane service for node data). Phase 2 (config service) for GRAPH-023 through GRAPH-025. Phase 4 (stacks) for GRAPH-008. Phase 5 (conflict service) for GRAPH-009, GRAPH-010, GRAPH-016, GRAPH-017. Phase 6 (PR service) for GRAPH-026, GRAPH-027.

**Exit Criteria**: The workspace graph renders all lanes as interactive nodes with correct types, status badges, and environment labels. Edges show topology, stack, risk, and PR relationships. Environment-mapped branches are positioned centrally with feature branches radiating outward. PR edge overlays show state and check status. Pan, zoom, and minimap work. Node positions persist across restarts. Clicking nodes navigates to lane detail. Clicking edges opens merge simulation.

---

### Phase 9: Automations

**Status**: NOT STARTED

**Goal**: Enable user-configurable trigger-action workflows that automate repetitive development tasks, building on the existing job engine's core pipeline.

**Scope**:
- Automation rule schema definition and validation in config (`automations` key in `ade.yaml` / `local.yaml`)
- Automation service: parse rules from config, register trigger listeners, evaluate conditions
- Session-end trigger (subscribe to session events, dispatch matching rules)
- Commit trigger (watch `.git/refs/heads/`, dispatch matching rules)
- Schedule trigger (cron-based timer using `node-cron`)
- Update-packs action (wire to pack service)
- Predict-conflicts action (wire to conflict service)
- Sync-to-mirror action (wire to hosted agent service)
- Run-tests action (execute test suite by ID)
- Run-command action (execute arbitrary shell command via PTY service)
- Action chaining (sequential execution with failure handling)
- Conditional execution (evaluate conditions per action, skip when false)
- Automation management UI (list view with status, toggles, detail view with history)
- Enable/disable toggle (IPC + UI, persisted to config)
- Manual trigger button ("Run Now" for immediate execution)
- Execution history display (recent runs with expandable per-action details)
- Automation run logging (write run/action records to SQLite `automation_runs` and `automation_action_results` tables)
- Error handling and retry (configurable retry count, backoff, failure notifications)

**Feature Doc References**: `AUTOMATIONS.md`

**Architecture References**: `JOB_ENGINE.md` (extends existing queue), `CONFIGURATION.md` (automations config schema)

**Task References**:
- AUTO-003: Automation rule schema
- AUTO-004: Automation service
- AUTO-005: Session-end trigger
- AUTO-006: Commit trigger
- AUTO-007: Schedule trigger
- AUTO-008: Update-packs action
- AUTO-009: Predict-conflicts action
- AUTO-010: Sync-to-mirror action
- AUTO-011: Run-tests action
- AUTO-012: Run-command action
- AUTO-013: Action chaining
- AUTO-014: Conditional execution
- AUTO-015: Automation management UI
- AUTO-016: Enable/disable toggle
- AUTO-017: Manual trigger button
- AUTO-018: Execution history display
- AUTO-019: Automation run logging
- AUTO-020: Error handling and retry

**Dependencies**: Phase 0 (session service for session-end trigger), Phase 2 (job engine, pack service, test service, config service). Phase 5 (conflict service) for AUTO-009. Phase 11 (hosted agent) for AUTO-010.

**Exit Criteria**: Automation rules can be defined in YAML and managed in the UI. Session-end, commit, and schedule triggers fire correctly. Actions execute in sequence with failure handling. Execution history is recorded and displayed. Enable/disable and manual trigger work.

---

### Phase 10: Onboarding Wizard + Settings Polish

**Status**: NOT STARTED

**Goal**: Provide a smooth first-run experience with project defaults detection and guided configuration, plus complete the settings page with provider configuration, keybindings, and data management.

**Scope**:
- Project defaults detection: scan for `package.json`, `Makefile`, `docker-compose.yml`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `.github/workflows/`
- Onboarding wizard UI: step-by-step modal with progress indicator
- Suggested process definitions from detection results
- Suggested test definitions from detection results
- Config review step: editable form showing suggested config before saving
- Hosted agent consent flow: explanation of data residency, consent options (Hosted / BYOK / CLI / Decide Later)
- "What ADE will do" previews (pre-execution dialogs for shared config commands)
- Provider configuration UI: Hosted / BYOK / CLI radio selector with config forms
- API key management: secure input, local.yaml storage, validation
- Keybindings viewer: read-only shortcut table organized by scope
- Keybindings customization: click-to-record editor with conflict detection
- Data management: clear local data, export project config, delete hosted mirror data
- Welcome guide: in-app getting started with feature highlights
- Project switching: recent projects list with quick-switch
- Initial codebase scan for pack seeding (analyze repo structure, key files, git history)
- Existing documentation import (ask user for docs directory/files, ingest via LLM for richer pack seeding)
- Existing lane/branch detection (scan for existing branches/worktrees, offer to create lanes and generate Lane Packs)
- Initial pack generation trigger (bootstrap project and lane packs during onboarding)
- CI/CD workflow scan and import (parse GitHub Actions, GitLab CI, etc. into run buttons)
- CI/CD sync mode (auto-detect workflow file changes, suggest updated run definitions)

**Feature Doc References**: `ONBOARDING_AND_SETTINGS.md`

**Architecture References**: `CONFIGURATION.md` (config schema, trust model), `SECURITY_AND_PRIVACY.md` (secret protection, consent)

**Task References**:
- ONBOARD-007: Project defaults detection
- ONBOARD-008: Onboarding wizard UI
- ONBOARD-009: Suggested process definitions
- ONBOARD-010: Suggested test definitions
- ONBOARD-011: Config review step
- ONBOARD-012: Hosted agent consent flow
- ONBOARD-013: "What ADE will do" previews
- ONBOARD-014: Provider configuration UI
- ONBOARD-015: API key management
- ONBOARD-016: Keybindings viewer
- ONBOARD-017: Keybindings customization
- ONBOARD-018: Data management
- ONBOARD-019: Welcome guide
- ONBOARD-020: Project switching
- ONBOARD-021: Initial codebase scan for pack seeding
- ONBOARD-022: Existing documentation import for pack seeding
- ONBOARD-023: Existing lane/branch detection
- ONBOARD-024: Initial pack generation trigger
- PACK-027: Initial project pack bootstrap (codebase scan + git history)
- PACK-028: Documentation-seeded pack generation
- PACK-029: Existing lane pack hydration
- PROJ-036: CI/CD workflow scan and import
- PROJ-037: CI/CD sync mode

**New Services Required**:
- `onboardingService`: detection of project defaults, suggested config generation, wizard state management

**Dependencies**: Phase -1 (settings page shell), Phase 2 (config service). ONBOARD-012 depends on Phase 11 (hosted agent). ONBOARD-020 requires a project registry service.

**Exit Criteria**: First-run wizard detects project type and suggests sensible defaults. Initial packs are generated from codebase scan and optional documentation import. Existing branches can be imported as lanes with hydrated Lane Packs. CI/CD workflows can be scanned and imported as run definitions. User can review and edit config before saving. Provider can be configured (Hosted, BYOK, or CLI). Keybindings are displayed and customizable. Data management operations work. Project switching allows opening recent projects.

---

### Phase 11: Hosted Agent + Cloud Backend

**Status**: NOT STARTED

**Goal**: Build the AWS cloud infrastructure and desktop integration that enables LLM-powered features: narrative generation, conflict resolution proposals, and PR description drafting, all operating under a strict read-only contract.

**Scope**:
- AWS infrastructure via SST (Serverless Stack):
  - Cognito user pool for authentication
  - S3 buckets for mirror storage and job artifacts
  - SQS queues for job processing
  - DynamoDB tables for job metadata, manifests, and results
  - Lambda functions for API endpoints and job workers
- Auth flow: Cognito + GitHub OAuth with desktop loopback redirect (localhost callback)
- Repo mirror sync: content-addressed blobs + per-lane manifests uploaded from desktop
- Cloud job processing: SQS queue consumer Lambda workers
- LLM gateway module: prompt templates, model selection (Claude, GPT, etc.), token budgets, provider swapping
- Pack narrative augmentation via LLM (hosted agent generates human-quality narratives from deterministic data)
- Conflict resolution proposals via LLM (agent receives Conflict Pack, returns resolution diff with confidence score)
- PR description drafting via LLM (agent receives lane pack, returns formatted PR description)
- Proposal review and apply workflow in desktop (preview diff, apply, undo)
- Hosted agent consent flow integration (wire to onboarding wizard consent step)
- Pack sync to hosted mirror (push pack content to cloud storage)
- Secret redaction rules (prevent sensitive data from being uploaded -- .env, credentials, API keys)
- Exclude rules configuration (per-project control over what is mirrored)

**Feature Doc References**: `CONFLICTS.md` (CONF-017 through CONF-021), `PACKS.md` (PACK-021, PACK-023 through PACK-025), `ONBOARDING_AND_SETTINGS.md` (ONBOARD-012), `TERMINALS_AND_SESSIONS.md` (TERM-028)

**Architecture References**: `CLOUD_BACKEND.md`, `HOSTED_AGENT.md`, `SECURITY_AND_PRIVACY.md` (hosted mirror security, transcript privacy, proposal safety)

**Task References**:
- CONF-017: Hosted agent proposal integration (ProposeConflictResolution job)
- CONF-018: Proposal diff preview in UI
- CONF-019: Proposal apply with operation record
- CONF-020: Proposal confidence scoring display
- CONF-021: Proposal undo via operation timeline
- PACK-021: LLM-powered narrative generation
- PACK-023: Pack sync to hosted mirror
- PACK-024: Pack retention and cleanup policy
- PACK-025: Pack privacy controls (redaction rules)
- ONBOARD-012: Hosted agent consent flow
- TERM-028: Transcript upload opt-in (hosted mirror)

**New Services Required**:
- `hostedAgentService`: mirror sync protocol, job submission, result polling, artifact download
- `llmGatewayModule` (cloud): prompt templates, model routing, token budgets
- AWS Lambda workers for each job type (NarrativeGeneration, ConflictResolution, PrDescriptionDraft)

**Dependencies**: Phase 2 (pack service), Phase 5 (conflict service, conflict packs), Phase 6 (PR service for description drafting), Phase 10 (onboarding consent flow)

**Exit Criteria**: AWS infrastructure deploys via SST. Desktop authenticates via Cognito. Mirror sync uploads content-addressed blobs with exclude rules. Cloud jobs process pack narratives, conflict resolutions, and PR descriptions. Desktop polls for results and presents proposals for user review. Apply and undo workflows function correctly. Secret redaction prevents sensitive data from being uploaded.

---

### Phase 12: Advanced Features + Polish

**Status**: NOT STARTED

**Goal**: Complete the product with advanced history features, terminal enhancements, additional git operations, and final polish across all surfaces.

**Scope**:

**History Enhancements**:
- Feature history: filtered timeline by feature/issue tag across lanes
- History graph view: visual timeline with parallel lane tracks
- Checkpoint browser: navigate to past repo state, read-only file browser at checkpoint SHA
- Undo operation: reverse a git action via history (using pre/post SHA)
- Replay operation sequence: dry-run re-execution of past operations
- Plan version history: track planning document iterations
- Jump-to-lane link from operation detail
- Jump-to-session link from operation detail
- Export history as CSV or JSON with filters

**Terminal Enhancements**:
- Tiling layout for multiple terminals (split horizontal/vertical)
- Drag to rearrange tiles
- Grid view (multi-terminal overview)
- Session goal/purpose tagging
- Tool type detection (Claude, Cursor, shell, etc.)
- Session transcript search
- Pin important sessions

**Advanced Git Operations**:
- Primary lane support (main repo dir, no separate worktree)
- Attached lane support (link existing external worktree)
- Amend commit
- Branch create/delete/rename from lane
- Reset (soft/mixed/hard) with confirmation dialog
- Lane profiles (preset configs per lane type)
- Conflict prediction indicators in lane rows (integration with Phase 5)
- Merge simulation from lane context menu

**Run Tab Enhancements**:
- AI-suggested run prompts (detect new test suites/services on merge, propose new run buttons)
- Run prompt suggestion cards UI (accept/dismiss flow)
- Agent CLI tools detection (Claude Code, Codex, Cursor, Aider, Continue)
- Agent commands and skills viewer (read .claude/commands/, etc.)
- Agent command editing (add/edit/delete commands and skills in-app)
- Agent tool quick-launch (open tracked terminal with tool in selected lane)
- Process restart policies (on-failure, always) with backoff
- Process health monitoring (periodic readiness checks)
- Process environment variable editor
- Test suite tags and filtering
- Test result diff (compare runs)
- Config diff viewer (before save)
- Config import/export

**Performance and Error Handling**:
- Performance optimization (render batching, virtual scrolling for large lists)
- Error handling hardening (graceful degradation, user-facing error messages)
- Cross-platform testing and fixes (macOS, Windows, Linux)

**Feature Doc References**: `HISTORY.md`, `TERMINALS_AND_SESSIONS.md`, `LANES.md`, `PROJECT_HOME.md`, `PACKS.md`, `CONFLICTS.md`

**Architecture References**: `UI_FRAMEWORK.md`, `GIT_ENGINE.md`, `DESKTOP_APP.md`

**Task References**:
- HIST-015: Feature history (filtered by feature/issue tag)
- HIST-016: Graph view (visual timeline with parallel lane tracks)
- HIST-017: Checkpoint browser
- HIST-018: Undo operation
- HIST-019: Replay operation sequence
- HIST-020: Plan version history
- HIST-021: Jump to lane from operation detail
- HIST-022: Jump to session from operation detail
- HIST-023: Export history (CSV/JSON)
- TERM-021: Tiling layout for multiple terminals
- TERM-022: Split horizontal/vertical
- TERM-023: Drag to rearrange tiles
- TERM-025: Session goal/purpose tagging
- TERM-026: Tool type detection
- TERM-027: Session transcript search
- TERM-030: Pin important sessions
- TERM-031: Grid view (multi-terminal overview)
- LANES-024: Primary lane support
- LANES-025: Attached lane support
- LANES-030: Conflict prediction indicators in lane rows
- LANES-031: Merge simulation from lane context menu
- LANES-032: Lane profiles
- LANES-036: Amend commit
- LANES-037: Branch create/delete/rename
- LANES-038: Reset (soft/mixed/hard)
- PROJ-026: Process restart policies
- PROJ-027: Process health monitoring
- PROJ-028: Process environment variable editor
- PROJ-029: Test suite tags and filtering
- PROJ-030: Test result diff
- PROJ-031: Config diff viewer
- PROJ-032: Config import/export
- PROJ-035: AI-suggested run prompts
- PROJ-038: Agent CLI tools detection
- PROJ-039: Agent commands and skills viewer
- PROJ-040: Agent command editing
- PROJ-041: Agent tool quick-launch
- PROJ-042: Run prompt suggestion cards UI
- PACK-026: Pack export
- CONF-024: Conflict notification/alerts

**Dependencies**: All prior phases. Specifically: Phase 5 for LANES-030/LANES-031, Phase 7 for HIST-017/HIST-019/HIST-020, Phase 0 for TERM-021 through TERM-031.

**Exit Criteria**: All task IDs across all feature docs are marked DONE. History graph view renders parallel lane tracks. Checkpoint browser allows navigating to past states. Undo reverses git operations. Terminal tiling layout enables split views. All advanced git operations work. Agent CLI tools are detected and launchable from the Run tab. AI-suggested run prompts detect and propose new buttons on merge. Performance is smooth with large repositories. Error handling is robust across all features. Cross-platform compatibility is verified.

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
| Graph canvas render (50 nodes) | < 100ms | Phase 8 |
| SQLite query (any single query) | < 50ms | All phases |

### Security Considerations

Security is not a separate phase; it is enforced at every layer from Phase -1 onward.

| Concern | Implementation | Enforced From |
|---------|---------------|---------------|
| **Process isolation** | Renderer has zero Node.js access; all system calls go through typed IPC allowlist | Phase -1 |
| **Secret protection** | API keys in `local.yaml` (gitignored); GitHub tokens in OS keychain only; never in SQLite or config files | Phase 6, Phase 10 |
| **Configuration trust** | SHA-based trust model for shared config; user approval before executing any commands from `ade.yaml` | Phase 2 |
| **Hosted mirror redaction** | Secret redaction rules strip `.env`, credentials, API keys before upload; user-configurable exclude patterns | Phase 11 |
| **Transcript privacy** | Terminal output may contain secrets; transcripts are local-only unless user explicitly opts in to hosted upload | Phase 0, Phase 11 |
| **Proposal safety** | LLM-generated diffs are previewed before application; all applications create operation records for undo | Phase 11 |
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
| R-04 | GitHub API rate limiting impacts PR status polling | High | Low | Implement exponential backoff; cache responses; use conditional requests (ETag/If-Modified-Since); allow user-configurable poll interval | Phase 6 |
| R-05 | LLM output quality varies unpredictably for narrative generation | High | Medium | Always pair LLM narratives with deterministic data; show confidence scores; allow user override/editing; implement human-in-the-loop review | Phase 11 |
| R-06 | Large repositories (100K+ files) cause file tree performance issues | Medium | Medium | Lazy loading with depth limiting; virtual scrolling; gitignore filtering; debounced file watching; avoid full-tree loads | Phase 3 |
| R-07 | Stacked rebase operations can fail in complex merge scenarios | Medium | High | Validate stack integrity before restack; provide clear error messages with recovery instructions; record all SHA transitions for manual recovery | Phase 4 |
| R-08 | AWS cold start latency for Lambda workers impacts job response time | Medium | Low | Use provisioned concurrency for critical job types; implement client-side polling with exponential backoff; show progress indicators | Phase 11 |
| R-09 | Cross-platform differences in PTY behavior (Windows vs macOS vs Linux) | Medium | Medium | Test on all three platforms per release; use platform-specific shell detection; handle signal differences (SIGTERM vs TerminateProcess) | Phase 0, Phase 12 |
| R-10 | sql.js (WASM) write performance under heavy operation recording | Low | Medium | Debounced flush strategy (125ms); batch writes during rapid operations; monitor flush frequency; fall back to native SQLite if needed | All phases |
| R-11 | React Flow performance degrades with many nodes and edges (50+ lanes) | Low | Medium | Virtualize off-screen nodes; throttle edge recomputation; limit risk overlay edges to top-N risks; implement level-of-detail rendering | Phase 8 |
| R-12 | Secret leakage via terminal transcripts uploaded to hosted mirror | Medium | High | Transcript upload is opt-in only; apply redaction rules before upload; scan for common secret patterns; provide audit log of uploaded content | Phase 11 |
| R-13 | Concurrent worktree operations cause git lock contention | Medium | Medium | Serialize git operations per-worktree via job engine; implement lock file detection with retry; provide clear "repository locked" error messages | Phase 1, Phase 4 |

---

*This document is the authoritative implementation plan for ADE. It is maintained alongside the feature and architecture documentation and updated as phases are completed. All task IDs referenced here are defined in their respective feature documents under `docs/features/`.*
