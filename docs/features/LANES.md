# Lanes — Development Cockpit

> Last updated: 2026-02-16

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Lane](#lane)
  - [Lane Types](#lane-types)
  - [Lane Status](#lane-status)
  - [Stack](#stack)
- [User Experience](#user-experience)
  - [3-Pane Layout](#3-pane-layout)
  - [Left Pane — Lane List & Stack Graph](#left-pane--lane-list--stack-graph)
  - [Center Pane — Lane Detail Area](#center-pane--lane-detail-area)
  - [Inspector Sidebar](#inspector-sidebar)
  - [Lane Lifecycle](#lane-lifecycle)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
- [Data Model](#data-model)
- [Implementation Tracking](#implementation-tracking)
  - [Phase 1 — Core Lane Management (DONE)](#phase-1--core-lane-management-done)
  - [Phase 2 — Git Operations (DONE)](#phase-2--git-operations-done)
  - [Phase 3 — Advanced UI (DONE)](#phase-3--advanced-ui-done)
  - [Phase 4 — Stacks & Advanced Features (DONE)](#phase-4--stacks--advanced-features-done)

---

## Overview

The **Lanes tab** is the primary workspace in ADE. It provides a 3-pane cockpit for managing parallel development lanes (git worktrees), viewing diffs, performing git operations, and orchestrating work across branches.

Lanes are the foundational abstraction in ADE. Rather than forcing developers to mentally juggle branches, stashes, and worktrees, ADE wraps each unit of parallel work into a **lane** — a self-contained workspace with its own branch, working directory, terminal sessions, and status indicators. The Lanes tab surfaces all of this in a dense, keyboard-navigable cockpit designed for high-throughput development.

This feature matters because modern development increasingly demands parallelism: hotfixes alongside feature work, stacked PRs, code review checkouts, and experimental branches. Lanes make this manageable without leaving the tool.

---

## Core Concepts

### Lane

A **lane** is a unit of parallel work. Each lane wraps a git branch and a worktree directory, providing an isolated workspace where changes do not interfere with other lanes. Lanes are the primary organizational primitive in ADE — terminals, packs, sessions, and jobs are all scoped to a lane.

### Lane Types

ADE supports three types of lanes:

| Type | Description | Worktree Directory | Use Case |
|------|-------------|-------------------|----------|
| **Primary** | The main repository directory itself. No separate worktree is created. | `<repo-root>/` | Default lane for the main branch. Always exists. |
| **Worktree** | A dedicated worktree created by ADE in a managed location. | `.ade/worktrees/<name>/` | Standard parallel development. Most lanes are this type. |
| **Attached** | A pre-existing external worktree that the user links into ADE. | User-specified path | Integrating worktrees created outside ADE. |

### Lane Status

Lane status is a composite indicator derived from multiple signals:

- **Dirty state**: Whether the working tree has uncommitted changes (modified, untracked, or staged files).
- **Ahead/Behind counts**: How many commits the lane's branch is ahead of or behind its base ref (typically the remote tracking branch or parent lane).
- **Conflict prediction**: Whether merging with the base ref would produce conflicts (computed via merge simulation).
- **Test results**: Aggregated pass/fail status from the most recent test run scoped to this lane.
- **PR status**: If a pull request exists for this lane's branch, its review status (open, approved, changes requested, merged).

### Stack

A **stack** is a parent-child relationship between lanes. The child lane's branch is based on the parent lane's branch rather than on `main` or another shared ref. This enables:

- **Stacked PRs**: Each lane in the stack has its own PR, reviewed independently but merged in order.
- **Layered development**: Build feature B on top of feature A before A is merged.
- **Restack operations**: When a parent lane is updated, propagate those changes to all children.

---

## User Experience

### 3-Pane Layout

The Lanes tab uses a resizable 3-pane layout optimized for parallel development workflows:

```
+---------------------------+------------------------------------------------+
|  Lane List (~24%)         |  Lane Detail (~76%)                            |
|                           |                                                |
|  [+ Create Lane]          |  [Tab: feature-auth] [Tab: bugfix-123]  [x]   |
|                           |  +-----------------------------------------+  |
|  ● feature-auth     M↑2   |  | Sub-tabs: [Diff] [Terminals] [Packs]    |  |
|    bugfix-123        ↑1   |  +-----------------------------------------+  |
|    refactor-db       ●    |  |                                         |  |
|    experiment-ui          |  |  Diff / Git Operations Panel             |  |
|                           |  |                                         |  |
|  ─── Stack Graph ───      |  |  Unstaged Changes (3 files)             |  |
|  (mini graph + canvas)    |  |  Staged Changes (1 file)                |  |
|                           |  |                                         |  |
|                           |  |  [Stage All] [Commit] [Push]            |  |
|                           |  +-----------------------------------------+  |
+---------------------------+------------------------------------------------+
```

All pane dividers are draggable for user-customized sizing and are persisted across lane switches.

### Left Pane — Lane List & Stack Graph

The left pane is a scrollable list of all active lanes for the current project.

**Lane rows** are high-density index cards showing:
- Lane name (bold, primary text)
- Branch name (secondary text, if different from lane name)
- Status badges:
  - Dirty indicator (filled circle if uncommitted changes exist)
  - Ahead count (up arrow + number, e.g., `↑2`)
  - Behind count (down arrow + number, e.g., `↓1`)
- Timestamp (last activity or creation time)

**Interactions**:
- Single click: Select lane, show in center pane.
- Shift+click: Multi-select lanes (for bulk operations like archive/delete).
- Right-click: Context menu with Rename, Archive, Delete, Open Folder, Create Child Lane.
- Double-click: Open lane in a new tab in the center pane.

**Stack graph** (bottom of left pane): A lightweight visual representation of parent-child lane relationships (including clear connections back to the Primary lane). A one-click “Open canvas” action jumps to the full Workspace Graph for deeper exploration.

**Create Lane button**: Opens a dialog to create a new lane. The user provides a name and optionally selects a parent lane (for stacking) and a base ref.

### Center Pane — Lane Detail Area

The center pane is the main working area. The LanesPage uses `PaneTilingLayout` for a resizable pane structure with persisted sizes.

**Tab bar**: Multiple lanes can be open simultaneously as tabs. Each tab shows the lane name and a close button. Tabs are reorderable by drag-and-drop. Primary lanes display a home icon.

**Sub-panes** within the center area (via PaneTilingLayout):
- **Diff pane** (`LaneDiffPane`): Git diff viewer with Monaco side-by-side diffs, per-file stage/unstage/discard, commit diff viewing
- **Git actions pane** (`LaneGitActionsPane`): Commit, stash, fetch, sync (merge/rebase), push operations with recent commits list, restack button for stacked lanes
- **Terminals pane** (`LaneTerminalsPanel`): Embedded terminal sessions with tab/tiling views, quick-launch profiles, session delta cards
- **Work pane** (`LaneWorkPane`): Embedded terminal sessions
- **Stack pane** (`LaneStackPane`): Stack chain visualization and management
- **Inspector pane** (`LaneInspectorPane`): Packs, PR, and conflict management

**Terminals pane (signal-first)**:
- Default view prioritizes **running** sessions. Ended/closed sessions are collapsed behind a toggle.
- Ended sessions show a one-line deterministic summary (for review) and only reveal transcript tails when explicitly expanded.
- **Tab vs Tiling toggle**: Switch between single-session tab view and multi-terminal tiling grid (`TilingLayout` component with recursive binary splits).
- **Quick launch profiles**: One-click launch for Claude Code, Codex, or plain Shell. Profiles are configurable via terminal profiles settings.
- **Context toggle**: Launch with or without context tracking (tracked/untracked sessions).
- **Session delta card**: Displayed for ended sessions showing files changed, insertions/deletions, touched files, and failure lines.
- A lightweight "Open in Terminals tab" action jumps to the global Terminals view with the lane filter pre-applied.

**Diff / Git Operations Panel** (default sub-tab):

The diff panel is the primary interaction surface for git operations within a lane.

**Status header**:
- Clean/dirty badge with file count
- Ahead/behind counts relative to base ref

**Diff sections**:
- **Unstaged Changes**: Files modified in the working tree but not yet staged.
- **Staged Changes**: Files added to the git index, ready for commit.

Each section shows a file list with change type indicators:
| Indicator | Meaning |
|-----------|---------|
| `M` | Modified |
| `A` | Added (new file) |
| `D` | Deleted |
| `R` | Renamed |
| `U` | Unmerged (conflict) |

**File interactions**:
- Click a file to open the Monaco side-by-side diff viewer.
- Quick edit: Modify unstaged files directly within the diff view.
- Per-file buttons: Stage, Unstage, Discard (with confirmation for destructive actions).
- Bulk buttons: Stage All, Unstage All.

**Commit controls**:
- Commit message input (multiline textarea)
- Commit button (disabled when no staged changes or empty message)
- Amend checkbox (future)

**Advanced git controls**:
- **Stash**: Push (with optional message), Pop, Apply, Drop, List stashes
- **Fetch**: Fetch from remote (all refs or specific)
- **Sync**: Merge or Rebase with upstream/base ref
- **Push**: Push to remote, with force-with-lease option
- **Recent commits**: Scrollable list of recent commits on this branch
- **Revert commit**: Create a revert commit for a selected commit
- **Cherry-pick commit**: Apply a commit from another branch

### Inspector Sidebar

The inspector is a collapsible sidebar on the right edge of the Lanes tab. It provides supplementary metadata and quick actions for the currently selected lane.

**Contents**:
- **Lane metadata**: Created date, branch name, worktree path, base ref, lane type.
- **Quick actions**: Open in Finder/Explorer, Copy worktree path, Open terminal here.
- **Session list**: All terminal sessions associated with this lane, with status indicators.
- **Pack freshness indicator**: Shows whether packs are up-to-date or stale for this lane.

### Lane Lifecycle

1. **Create**: User provides a name. ADE creates a git branch (from the selected base ref) and a worktree directory (at `.ade/worktrees/<name>/`). The lane appears in the list with `active` status.

2. **Work**: The user opens terminals in the lane, makes code changes, stages and commits, and pushes to the remote. All activity is tracked via sessions and operations.

3. **Archive**: The lane is hidden from the active list but its worktree and branch are preserved. Useful for lanes that are paused but not finished. Archived lanes can be unarchived at any time.

4. **Delete**: The worktree directory is removed from disk. The user is prompted whether to also delete the git branch. Session records and history are retained for audit purposes.

---

## Technical Implementation

### Services

| Service | Responsibility |
|---------|---------------|
| `laneService` | CRUD operations for lanes. Creates/removes worktrees via git. Computes lane status by aggregating dirty state, ahead/behind, and other signals. Manages lane metadata in the database. Supports primary, worktree, and attached lane types. Provides restack (recursive rebase), reparent, stack chain, and appearance management. |
| `restackSuggestionService` | Monitors stacked lanes for parent-advanced state. Generates restack suggestions with dismiss/defer lifecycle. Emits real-time suggestion events to the renderer. |
| `gitService` | All git operations: stage, unstage, discard, commit, stash, fetch, sync (merge/rebase), push, conflict state detection (merge/rebase in-progress, continue, abort). Operates on a specified worktree path. Returns structured results with success/failure and output. |
| `diffService` | Computes working tree diffs (unstaged changes) and index diffs (staged changes). Per-file diff content for the Monaco viewer. Handles binary file detection and large file truncation. |
| `operationService` | Records all git operations with before/after SHA transitions. Provides an audit trail for every action taken in a lane. Used by the History tab. |

### IPC Channels

**Lane management**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.lanes.list` | `(args: { projectId: string }) => LaneSummary[]` | List all active lanes for a project |
| `ade.lanes.create` | `(args: { projectId: string, name: string, baseRef?: string, parentLaneId?: string }) => LaneSummary` | Create a new lane with branch and worktree |
| `ade.lanes.rename` | `(args: { laneId: string, newName: string }) => void` | Rename a lane (does not rename branch) |
| `ade.lanes.archive` | `(args: { laneId: string }) => void` | Archive a lane (hide from active list) |
| `ade.lanes.delete` | `(args: DeleteLaneArgs) => void` | Delete lane, remove worktree, optionally delete branch |
| `ade.lanes.openFolder` | `(args: { laneId: string }) => void` | Open worktree directory in Finder/Explorer |
| `ade.lanes.createChild` | `(args: CreateChildLaneArgs) => LaneSummary` | Create a child lane (for stacking) |
| `ade.lanes.importBranch` | `(args: { branchRef: string }) => LaneSummary` | Import an existing branch as a lane |
| `ade.lanes.attach` | `(args: AttachLaneArgs) => LaneSummary` | Attach an existing worktree directory as a lane |
| `ade.lanes.reparent` | `(args: ReparentLaneArgs) => ReparentLaneResult` | Change a lane's parent (reparent in stack) |
| `ade.lanes.updateAppearance` | `(args: UpdateLaneAppearanceArgs) => void` | Update lane color, icon, or tags |
| `ade.lanes.getStackChain` | `(args: { laneId: string }) => StackChainItem[]` | Get the full stack chain for a lane |
| `ade.lanes.getChildren` | `(args: { laneId: string }) => LaneSummary[]` | Get direct child lanes |

**Restack operations**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.lanes.restack` | `(args: RestackArgs) => RestackResult` | Restack a lane (rebase onto parent), optionally recursive |
| `ade.lanes.listRestackSuggestions` | `() => RestackSuggestion[]` | List lanes whose parent has advanced (restack recommended) |
| `ade.lanes.dismissRestackSuggestion` | `(args: { laneId: string }) => void` | Dismiss a restack suggestion for the current parent HEAD |
| `ade.lanes.deferRestackSuggestion` | `(args: { laneId: string; minutes: number }) => void` | Defer a restack suggestion for N minutes |
| `ade.lanes.restackSuggestions.event` | Event stream | Emits `restack-suggestions-updated` when suggestions change |

**Diff operations**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.diff.getChanges` | `(args: { worktreePath: string }) => DiffChanges` | Get unstaged and staged file change lists |
| `ade.diff.getFile` | `(args: { worktreePath: string, filePath: string, staged: boolean }) => FileDiff` | Get detailed diff content for one file |

**Git operations**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.git.stageFile` | `(args: { worktreePath: string, filePath: string }) => GitActionResult` | Stage a specific file |
| `ade.git.unstageFile` | `(args: { worktreePath: string, filePath: string }) => GitActionResult` | Unstage a specific file |
| `ade.git.discardFile` | `(args: { worktreePath: string, filePath: string }) => GitActionResult` | Discard changes to a specific file |
| `ade.git.restoreStagedFile` | `(args: { worktreePath: string, filePath: string }) => GitActionResult` | Restore a staged file to its HEAD state |
| `ade.git.commit` | `(args: { worktreePath: string, message: string }) => GitActionResult` | Create a commit with staged changes |
| `ade.git.listRecentCommits` | `(args: { worktreePath: string, count?: number }) => GitCommitSummary[]` | List recent commits on current branch |
| `ade.git.revertCommit` | `(args: { worktreePath: string, sha: string }) => GitActionResult` | Revert a specific commit |
| `ade.git.cherryPickCommit` | `(args: { worktreePath: string, sha: string }) => GitActionResult` | Cherry-pick a commit from another branch |
| `ade.git.stashPush` | `(args: { worktreePath: string, message?: string }) => GitActionResult` | Stash current changes |
| `ade.git.stashApply` | `(args: { worktreePath: string, index?: number }) => GitActionResult` | Apply a stash without removing it |
| `ade.git.stashPop` | `(args: { worktreePath: string, index?: number }) => GitActionResult` | Apply and remove a stash |
| `ade.git.stashDrop` | `(args: { worktreePath: string, index?: number }) => GitActionResult` | Remove a stash entry |
| `ade.git.fetch` | `(args: { worktreePath: string, remote?: string }) => GitActionResult` | Fetch from remote |
| `ade.git.sync` | `(args: { worktreePath: string, strategy: 'merge' \| 'rebase', ref?: string }) => GitActionResult` | Merge or rebase with upstream |
| `ade.git.push` | `(args: { worktreePath: string, forceWithLease?: boolean }) => GitActionResult` | Push to remote |

---

## 2026-02-16 Addendum — Lane/Hosted Context Integration

### Lane-to-hosted context flow

1. Lane activity updates deterministic packs.
2. Conflict prediction updates lane conflict freshness metadata.
3. Hosted submission chooses context source (`inline` vs `mirror`) by policy.
4. `__adeHandoff` carries source, reason code, staleness, and manifest refs.
5. Worker prompt includes provenance and scoped file-set summary.

### UI connections in Lanes + Settings

- Lanes tab:
  - Conflict status badges reflect prediction staleness and unresolved state.
  - Pack view consumes updated manifests with context fingerprint/freshness.
- Settings page (`Hosted` section):
  - shows last sync success/attempt/error.
  - shows last cleanup success/attempt/error.
  - shows context fallback count.
  - shows insufficient-context job count.
  - shows staleness reason when mirror is old.

---

## Data Model

### Database Schema

```sql
lanes (
  id                TEXT PRIMARY KEY,       -- UUID
  project_id        TEXT NOT NULL,          -- FK to projects table
  name              TEXT NOT NULL,          -- User-visible lane name
  description       TEXT,                   -- Optional description
  base_ref          TEXT NOT NULL,          -- Base branch/ref (e.g., 'main', parent lane branch)
  branch_ref        TEXT NOT NULL,          -- Git branch name for this lane
  worktree_path     TEXT NOT NULL,          -- Absolute path to worktree directory
  attached_root_path TEXT,                  -- For attached lanes: original external directory path
  lane_type         TEXT NOT NULL DEFAULT 'worktree', -- 'primary' | 'worktree' | 'attached'
  is_edit_protected INTEGER NOT NULL DEFAULT 0, -- 1 for primary lane (prevents destructive operations)
  parent_lane_id    TEXT,                   -- FK to lanes (for stacks), NULL if no parent
  color             TEXT,                   -- User-customizable lane color
  icon              TEXT,                   -- Lane icon: 'star' | 'flag' | 'bolt' | 'shield' | 'tag' | null
  tags_json         TEXT,                   -- JSON array of tag strings (up to 24)
  created_at        TEXT NOT NULL,          -- ISO 8601 timestamp
  archived_at       TEXT,                   -- ISO 8601 timestamp, NULL if active
  status            TEXT NOT NULL,          -- 'active' | 'archived'
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (parent_lane_id) REFERENCES lanes(id)
)
```

### Filesystem Artifacts

| Path | Description |
|------|-------------|
| `.ade/worktrees/<name>/` | Worktree directory for managed lanes |
| `.ade/db/ade.db` | SQLite database containing lane records |

---

## Implementation Tracking

### Phase 1 — Core Lane Management (DONE)

| ID | Task | Status |
|----|------|--------|
| LANES-001 | Lane list component with status badges | DONE |
| LANES-002 | Lane creation (branch + worktree) | DONE |
| LANES-003 | Lane rename | DONE |
| LANES-004 | Lane archive | DONE |
| LANES-005 | Lane delete (worktree cleanup) | DONE |
| LANES-006 | 3-pane resizable layout | DONE |

### Phase 2 — Git Operations (DONE)

| ID | Task | Status |
|----|------|--------|
| LANES-007 | Diff viewer (unstaged + staged sections) | DONE |
| LANES-008 | File change list with type indicators | DONE |
| LANES-009 | Monaco side-by-side diff view | DONE |
| LANES-010 | Quick edit in diff view | DONE |
| LANES-011 | Stage/Unstage/Discard per file | DONE |
| LANES-012 | Bulk stage/unstage all | DONE |
| LANES-013 | Commit with message | DONE |
| LANES-014 | Stash operations (push/pop/apply/drop/list) | DONE |
| LANES-015 | Fetch from remote | DONE |
| LANES-016 | Sync (merge or rebase) | DONE |
| LANES-017 | Push (with force-with-lease option) | DONE |
| LANES-018 | Recent commits list | DONE |
| LANES-019 | Revert commit | DONE |
| LANES-020 | Cherry-pick commit | DONE |

### Phase 3 — Advanced UI (DONE)

| ID | Task | Status |
|----|------|--------|
| LANES-021 | Lane inspector sidebar | DONE |
| LANES-022 | Multi-lane tabs (open multiple lanes) | DONE |
| LANES-023 | Lane sub-tabs (Terminals, Packs, Conflicts, PR) | DONE |

### Phase 4 — Stacks & Advanced Features (DONE)

| ID | Task | Status |
|----|------|--------|
| LANES-024 | Primary lane support (main repo dir, no worktree) | DONE — Phase 7 (`ensurePrimaryLane()` in laneService, edit-protected, no worktree creation) |
| LANES-025 | Attached lane support (link existing worktree) | DONE — Phase 7 (`laneService.attach()`, `lane_type = 'attached'`, uses existing directory) |
| LANES-026 | Stack creation (parent-child relationships) | DONE |
| LANES-027 | Stack graph visualization in lane list | DONE |
| LANES-028 | Restack operations (propagate parent to children) | DONE |
| LANES-029 | Stack-aware status indicators | DONE |
| LANES-030 | Conflict prediction indicators in lane rows | DONE (implemented in Phase 5) |
| LANES-031 | Merge simulation from lane context menu | DONE — Phase 7 (merge simulation from canvas edge click + conflict panel in WorkspaceGraphPage) |
| LANES-032 | Lane profiles (preset configs per lane type) | TODO — **moved to Phase 9** (Advanced Features) |
| LANES-033 | Lane overlay policies | DONE |
| LANES-034 | Keyboard shortcuts for lane navigation | DONE |
| LANES-035 | Lane search/filter | DONE |
| LANES-036 | Amend commit | TODO — **moved to Phase 9** (Advanced Features) |
| LANES-037 | Branch create/delete/rename from lane | TODO — **moved to Phase 9** (Advanced Features) |
| LANES-038 | Reset (soft/mixed/hard) with confirmation | TODO — **moved to Phase 9** (Advanced Features) |

### Phase 8 — Tiling Layout, Restack Suggestions & Appearance

| ID | Task | Status |
|----|------|--------|
| LANES-039 | PaneTilingLayout for LanesPage | DONE — Phase 8 (recursive react-resizable-panels tree with persisted sizes) |
| LANES-040 | Lane terminal tiling (TilingLayout component) | DONE — Phase 8 (binary tree layout with alternating horizontal/vertical splits) |
| LANES-041 | Restack suggestion service | DONE — Phase 8 (`restackSuggestionService.ts` — parent-advanced detection, dismiss/defer lifecycle, real-time events) |
| LANES-042 | Restack suggestion UI in LanesPage | DONE — Phase 8 (amber restack badges on lane rows, restack/dismiss/defer actions in lane detail) |
| LANES-043 | Lane appearance customization (color, icon, tags) | DONE — Phase 8 (`updateAppearance` IPC, `color`/`icon`/`tags_json` columns) |
| LANES-044 | Lane reparent support | DONE — Phase 8 (`reparent` IPC, changes parent-child relationship in stack) |
| LANES-045 | Create child lane from parent | DONE — Phase 8 (`createChild` IPC, used by ConflictsPage for integration lanes) |
| LANES-046 | Import branch as lane | DONE — Phase 8 (`importBranch` IPC, creates lane from existing branch) |
| LANES-047 | Quick-launch terminal profiles | DONE — Phase 8 (Claude/Codex/Shell one-click launch buttons, configurable profiles) |
| LANES-048 | Lane filter/search in LanesPage | DONE — Phase 8 (text search with filter token toggling) |

---

### Completion Notes

**Phase 4 completed** as part of the `codex/ade-phase-4-5` branch merge (commit `65b7a6b`). Core stack management (LANES-026–029), lane overlay policies (LANES-033), and conflict prediction indicators (LANES-030, via Phase 5) are all operational.

**Phase 8 completed**: LANES-039 through LANES-048. PaneTilingLayout, terminal tiling, restack suggestions, lane appearance customization, reparent, create child, import branch, quick-launch profiles, and lane filter/search are all operational.

**Remaining tasks** are scheduled as follows:
- **Phase 9 (Advanced Features)**: LANES-032, LANES-036, LANES-037, LANES-038

---

## 2026-02-16 Addendum — Integration Lane Rule

ADE now applies an explicit external-resolver integration rule:

- Single source lane merge into target: external CLI runs in source lane worktree.
- Multiple source lanes into target: ADE auto-creates or reuses an **Integration lane** and runs external CLI there.

No additional orchestrator/scheduler behavior is introduced by this rule; it is scoped to conflict-resolution execution only.

