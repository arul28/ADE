# Lanes — Development Cockpit

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-31

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
  - [Phase 5 — Lane Runtime Isolation (DONE)](#phase-5--lane-runtime-isolation)
- [Lane Proxy & Preview](#lane-proxy--preview)
  - [Per-Lane Hostname Isolation (Phase 5 W4)](#per-lane-hostname-isolation-phase-5-w4--done)
  - [Preview URLs (Phase 5 W4)](#preview-urls-phase-5-w4--done)
- [Lane Cleanup & Lifecycle](#lane-cleanup--lifecycle)
- [Auth Redirect Handling (Phase 5 W5)](#auth-redirect-handling-phase-5-w5--done)
- [Runtime Diagnostics (Phase 5 W6)](#runtime-diagnostics-phase-5-w6--done)

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

### Mission lane roles

Lanes can be associated with a mission through two optional fields on the lane record: `missionId` and `laneRole`. The `MissionLaneRole` type defines four roles:

| Role | Description |
|------|-------------|
| `mission_root` | The base lane the mission was launched from. |
| `worker` | A lane created for an individual worker agent during execution. |
| `integration` | A lane used for merging worker outputs (legacy, retained for compatibility). |
| `result` | The single output lane containing the consolidated mission changes. |

The lane service exposes `setMissionOwnership()` to tag or re-tag a lane's mission affiliation after creation. Child lane creation also accepts `missionId` and `laneRole` so worker and result lanes are tagged at birth.

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
- **Rebase operations**: When a parent lane is updated, propagate those changes to all children.

### Lane base resolution

The `shouldLaneTrackParent()` function in `src/shared/laneBaseResolution.ts` determines whether a child lane should track its parent lane's branch as its comparison ref. A lane tracks its parent only when the parent is **not** a primary lane and the parent has a valid branch ref. When the parent is a primary lane, the child uses its own `baseRef` (the project's default branch) instead, because the primary lane's branch _is_ the default branch and tracking it would produce zero behind-by counts.

The `branchNameFromLaneRef()` helper normalizes branch refs (stripping `refs/heads/`, `refs/remotes/`, and `origin/` prefixes) so that comparisons work uniformly regardless of how the ref was stored.

These shared functions are consumed by `laneService`, `conflictService`, `autoRebaseService`, and renderer-side utilities to ensure consistent base-ref resolution across ahead/behind computation, rebase suggestions, conflict prediction, and auto-rebase.

On startup, the lane service runs two repair routines:

- **`repairPrimaryParentedRootLanes`** -- Detaches non-primary lanes that point to the primary lane as their parent, resetting their `base_ref` to the project default branch. This cleans up lanes that were incorrectly parented to the primary lane in older versions.
- **`repairLegacyPrimaryBaseRootLanes`** -- Normalizes `base_ref` on root worktree lanes that still reference a stale or non-default branch, aligning them with the project's current default branch. Lanes with open PRs are excluded from repair to avoid disrupting active workflows.

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

**Create Lane button**: Opens a dropdown menu offering "Create new lane" or "Add existing worktree as lane". Both options open a dialog built on the shared `LaneDialogShell` component. The create dialog lets the user choose a name, optional template, and starting point (from primary with a base branch selector, or as a child of an existing lane). The attach dialog accepts a lane name, an absolute worktree path, and an optional description. When importing the currently checked-out branch while the primary lane has uncommitted changes, the dialog shows a warning that only committed changes will carry over to the new lane.

### Center Pane — Lane Detail Area

The center pane is the main working area. The LanesPage uses `PaneTilingLayout` for a resizable pane structure with persisted sizes.

**Tab bar**: Multiple lanes can be open simultaneously as tabs. Each tab shows the lane name and a close button. Tabs are reorderable by drag-and-drop. Primary lanes display a home icon.

**Sub-panes** within the center area (via PaneTilingLayout):
- **Diff pane** (`LaneDiffPane`): Git diff viewer with Monaco side-by-side diffs, per-file stage/unstage/discard, commit diff viewing
- **Git actions pane** (`LaneGitActionsPane`): Commit, stash, fetch, sync (merge/rebase), push operations with recent commits list, rebase button for stacked lanes. The Pull button flashes and shows a behind-count badge when the lane is behind its upstream. Stash buttons use user-friendly labels (Save Changes, Restore, Copy to Worktree, Delete) with inline explanations. The Save Changes button is disabled when there are no working tree changes. A Clear All button (with numeric confirmation) appears when stashes exist. Stash pop, drop, and clear operations now refresh git metadata immediately after completion.
- **Terminals pane** (`LaneTerminalsPanel`): Embedded terminal sessions with tab/tiling views, quick-launch profiles, session delta cards
- **Work pane** (`LaneWorkPane`): Embedded terminal sessions and agent chat view (terminal/chat toggle)
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

**Agent Chat View (Phase 1.5)**: The Work Pane includes a view toggle between two modes:

- **Terminal view** (default): The existing `LaneTerminalsPanel` showing PTY sessions with xterm.js.
- **Chat view**: The `AgentChatPane` providing a rich conversational interface for working with Codex or Claude.

The Chat view layout:

```
+-----------------------------------------------+
| [Terminal View] [Chat View]  <- toggle         |
+-----------------------------------------------+
| Messages (scrollable)                          |
|                                                |
| [You]: "Fix the auth middleware timeout"       |
|                                                |
| [Codex]: "I'll analyze the middleware..."      |
|   src/middleware/auth.ts  +12 -3               |
|   +------------------------------------+       |
|   | - const timeout = 5000;            |       |
|   | + const timeout = 30000;           |       |
|   +------------------------------------+       |
|                                                |
|   $ npm test                                   |
|   +------------------------------------+       |
|   | 31 tests passed                    |       |
|   +------------------------------------+       |
|                                                |
+-----------------------------------------------+
| [@ attach] [Codex gpt-5.4-codex]      [Send]  |
| Type a message...                    [Stop]    |
+-----------------------------------------------+
```

Chat sessions created from the Chat view are automatically scoped to the selected lane (`cwd` = lane worktree path). The provider/model selector in the composer supports all configured models (CLI, API-key, OpenRouter, and local providers such as LM Studio/Ollama/vLLM). If a user switches model families while a chat session is active, ADE forks a new chat session with the selected model so the active thread remains internally consistent. Chat sessions are tracked as first-class sessions with the same delta computation, pack integration, and context tracking as terminal sessions. The chat header shows the session title (or "New chat" when no session exists yet) and includes a lane navigation button that links back to the parent lane in the Lanes tab. The lane label is passed to `AgentChatPane` via the `laneLabel` prop from `TilingLayout` and `WorkViewArea`.

**Phase 2 improvements (shipped)**: The agent chat view now has polished message/composer/pane styling, Claude provider selection remains stable, and Codex reasoning effort selection is available in the model controls (persisted per lane/model and sent to Codex thread/turn starts).

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
- **Stash**: Save Changes (push with optional message), Restore (pop), Copy to Worktree (apply), Delete (drop), Clear All (with numeric confirmation), List stashes
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
- **Health indicator**: `LaneHealthDot` shows traffic-light health status (green/yellow/red) for lanes with runtime isolation active.

### Lane Lifecycle

1. **Create**: User provides a name. ADE creates a git branch (from the selected base ref) and a worktree directory (at `.ade/worktrees/<name>/`). The lane appears in the list with `active` status.

2. **Create from unstaged**: When a lane has unstaged or untracked changes that belong in a separate branch, the user can create a child lane from those changes. ADE stashes the unstaged work in the source lane, creates a new child lane from the source's HEAD, applies the stash into the new lane, and cleans up. If the stash apply fails, ADE rolls back: the created lane is removed and the stash is restored to the source. The UI exposes this as the "Create New Lane with Current Changes" button in the git actions pane. Preconditions: the source lane must have no staged changes and no in-progress merge or rebase.

3. **Work**: The user opens terminals in the lane, makes code changes, stages and commits, and pushes to the remote. All activity is tracked via sessions and operations.

4. **Archive**: The lane is hidden from the active list but its worktree and branch are preserved. Useful for lanes that are paused but not finished. Archived lanes can be unarchived at any time.

5. **Delete**: The worktree directory is removed from disk. The user is prompted whether to also delete the git branch. Session records and history are retained for audit purposes.

---

## Technical Implementation

### Services

| Service | Responsibility |
|---------|---------------|
| `laneService` | CRUD operations for lanes. Creates/removes worktrees via git. Computes lane status by aggregating dirty state, ahead/behind, and other signals. Manages lane metadata in the database. Supports primary, worktree, and attached lane types. Provides rebase (recursive rebase with remote tracking branch resolution for primary parents, dirty-worktree guard), reparent, stack chain, appearance management, `createFromUnstaged` (stash-based unstaged change rescue to a new child lane with automatic rollback on failure), mission lane ownership (`setMissionOwnership`), and startup repair routines for legacy lane base refs. |
| `rebaseSuggestionService` | Monitors stacked lanes for parent-advanced state. Generates rebase suggestions with dismiss/defer lifecycle. Emits real-time suggestion events to the renderer. |
| `gitService` | All git operations: stage, unstage, discard, commit, stash (push, list, apply, pop, drop, clear), fetch, sync (merge/rebase), push, conflict state detection (merge/rebase in-progress, continue, abort). Operates on a specified worktree path. Returns structured results with success/failure and output. |
| `diffService` | Computes working tree diffs (unstaged changes) and index diffs (staged changes). Per-file diff content for the Monaco viewer. Handles binary file detection and large file truncation. |
| `operationService` | Records all git operations with before/after SHA transitions. Provides an audit trail for every action taken in a lane. Used by the History tab. |
| `laneProxyService` | Per-lane hostname reverse proxy. Routes HTTP traffic by Host header to the correct lane's dev server. Manages proxy lifecycle, route registration, and preview URL generation. |
| `oauthRedirectService` | OAuth callback routing for multi-lane environments. Supports state-parameter and hostname-based routing strategies. Tracks OAuth sessions and provides setup assistant helpers. |
| `runtimeDiagnosticsService` | Continuous health monitoring for lane runtime isolation. Runs per-lane health checks (process, port, proxy), manages fallback mode, and provides actionable remediation. |

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
| `ade.lanes.createFromUnstaged` | `(args: CreateLaneFromUnstagedArgs) => LaneSummary` | Create a child lane from a source lane's unstaged changes, moving them to the new lane |
| `ade.lanes.importBranch` | `(args: { branchRef: string }) => LaneSummary` | Import an existing branch as a lane |
| `ade.lanes.attach` | `(args: AttachLaneArgs) => LaneSummary` | Attach an existing worktree directory as a lane |
| `ade.lanes.reparent` | `(args: ReparentLaneArgs) => ReparentLaneResult` | Change a lane's parent (reparent in stack) |
| `ade.lanes.updateAppearance` | `(args: UpdateLaneAppearanceArgs) => void` | Update lane color, icon, or tags |
| `ade.lanes.getStackChain` | `(args: { laneId: string }) => StackChainItem[]` | Get the full stack chain for a lane |
| `ade.lanes.getChildren` | `(args: { laneId: string }) => LaneSummary[]` | Get direct child lanes |

**Rebase operations**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.lanes.rebaseStart` | `(args: RebaseStartArgs) => RebaseStartResult` | Rebase a lane onto its parent. For primary parents, resolves the remote tracking branch (upstream or `origin/<branch>`) as the rebase target before falling back to the local HEAD. Refuses to rebase dirty worktrees. Optionally recursive. |
| `ade.lanes.listRebaseSuggestions` | `() => RebaseSuggestion[]` | List lanes whose parent has advanced (rebase recommended) |
| `ade.lanes.dismissRebaseSuggestion` | `(args: { laneId: string }) => void` | Dismiss a rebase suggestion for the current parent HEAD |
| `ade.lanes.deferRebaseSuggestion` | `(args: { laneId: string; minutes: number }) => void` | Defer a rebase suggestion for N minutes |
| `ade.lanes.rebaseSuggestions.event` | Event stream | Emits `rebase-suggestions-updated` when suggestions change |

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
| `ade.git.stashClear` | `(args: { laneId: string }) => GitActionResult` | Remove all stash entries |
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
  folder            TEXT,                   -- Optional organizational folder
  mission_id        TEXT,                   -- Mission that owns this lane (nullable)
  lane_role         TEXT,                   -- Mission lane role: 'mission_root' | 'worker' | 'integration' | 'result'
  created_at        TEXT NOT NULL,          -- ISO 8601 timestamp
  archived_at       TEXT,                   -- ISO 8601 timestamp, NULL if active
  status            TEXT NOT NULL,          -- 'active' | 'archived'
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (parent_lane_id) REFERENCES lanes(id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
)
```

### Filesystem Artifacts

| Path | Description |
|------|-------------|
| `.ade/worktrees/<name>/` | Worktree directory for managed lanes |
| `.ade/ade.db` | SQLite database containing lane records |

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
| LANES-028 | Rebase operations (propagate parent to children) | DONE |
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

### Phase 8 — Tiling Layout, Rebase Suggestions & Appearance

| ID | Task | Status |
|----|------|--------|
| LANES-039 | PaneTilingLayout for LanesPage | DONE — Phase 8 (recursive react-resizable-panels tree with persisted sizes) |
| LANES-040 | Lane terminal tiling (TilingLayout component) | DONE — Phase 8 (binary tree layout with alternating horizontal/vertical splits) |
| LANES-041 | Rebase suggestion service | DONE — Phase 8 (`rebaseSuggestionService.ts` — parent-advanced detection, dismiss/defer lifecycle, real-time events) |
| LANES-042 | Rebase suggestion UI in LanesPage | DONE — Phase 8 (amber rebase badges on lane rows, rebase/dismiss/defer actions in lane detail) |
| LANES-043 | Lane appearance customization (color, icon, tags) | DONE — Phase 8 (`updateAppearance` IPC, `color`/`icon`/`tags_json` columns) |
| LANES-044 | Lane reparent support | DONE — Phase 8 (`reparent` IPC, changes parent-child relationship in stack) |
| LANES-045 | Create child lane from parent | DONE — Phase 8 (`createChild` IPC, used by integration proposal flows) |
| LANES-046 | Import branch as lane | DONE — Phase 8 (`importBranch` IPC, creates lane from existing branch) |
| LANES-047 | Quick-launch terminal profiles | DONE — Phase 8 (Claude/Codex/Shell one-click launch buttons, configurable profiles) |
| LANES-048 | Lane filter/search in LanesPage | DONE — Phase 8 (text search with filter token toggling) |

---

### Completion Notes

**Phase 4 completed** as part of the `codex/ade-phase-4-5` branch merge (commit `65b7a6b`). Core stack management (LANES-026–029), lane overlay policies (LANES-033), and conflict prediction indicators (LANES-030, via Phase 5) are all operational.

**Phase 8 completed**: LANES-039 through LANES-048. PaneTilingLayout, terminal tiling, rebase suggestions, lane appearance customization, reparent, create child, import branch, quick-launch profiles, and lane filter/search are all operational.

**Phase 5 completed**: All W1–W6 workstreams are done. LANES-049 (env init, W1), LANES-053 (templates, W2), LANES-050 (port allocation, W3), LANES-055 (overlay extensions, W1), LANES-051 (per-lane proxy, W4), LANES-052 (preview launch, W4), LANES-054 (auth redirect, W5), LANES-056 (runtime diagnostics, W6), LANES-057 (renderer UI, W4–W6), and LANES-058 (E2E validation) are all operational.

**Remaining tasks** are scheduled as follows:
- **Phase 9 (Advanced Features)**: LANES-032, LANES-036, LANES-037, LANES-038

### Phase 5 — Lane Runtime Isolation

| ID | Task | Status |
|----|------|--------|
| LANES-049 | Lane environment initialization service | DONE — Phase 5 W1 (`laneEnvironmentService.ts`, steps: env-files, docker, dependencies, mount-points) |
| LANES-050 | Port allocation and lease manager | DONE — Phase 5 W3 (`portAllocationService.ts`, lease-based port range allocation with conflict detection) |
| LANES-051 | Per-lane hostname proxy (*.localhost) | DONE — Phase 5 W4 (`laneProxyService.ts`, Host-header routing reverse proxy, 16 tests) |
| LANES-052 | Preview launch service | DONE — Phase 5 W4 (`LanePreviewPanel.tsx`, one-click preview URL generation and browser launch, 8 tests) |
| LANES-053 | Lane template CRUD and storage | DONE — Phase 5 W2 (`laneTemplateService.ts`, reusable initialization recipes, template selector in CreateLaneDialog, `resolveSetupScript` for platform-specific post-creation scripts) |
| LANES-054 | Auth redirect handling per-lane: state-parameter routing (single OAuth callback URL, route by state param to correct lane), hostname-based routing (for providers supporting wildcards), setup assistant in Settings | DONE — Phase 5 W5 (`oauthRedirectService.ts`, state-parameter + hostname routing, 18+10 tests) |
| LANES-055 | LaneOverlayPolicy extension for env/port/proxy | DONE — Phase 5 W1 (extended `LaneOverlayOverrides` with `portRange`, `proxyHostname`, `computeBackend`, `envInit`) |
| LANES-056 | Runtime diagnostics (health checks, port conflicts) | DONE — Phase 5 W6 (`runtimeDiagnosticsService.ts`, traffic-light health checks with fallback mode, 25+11 tests) |
| LANES-057 | Renderer UI updates for lane env/proxy/preview | DONE — Phase 5 W4–W6 (LanePreviewPanel, LaneHealthDot, RuntimeDiagnosticsPanel, DiagnosticsDashboardSection, ProxyAndPreviewSection) |
| LANES-058 | E2E validation for lane isolation | DONE — Phase 5 (covered by unit + integration tests across all W1–W6 workstreams) |

---

## Lane Environment Initialization (Phase 5 W1 — DONE)

When a lane is created, ADE can automatically initialize its working environment via the `laneEnvironmentService`. The service executes initialization steps in a deterministic order:

1. **Environment Files** (`env-files`): Copy/template `.env` files with lane-specific values (ports, hostnames, API keys). Both source and destination paths are validated against their respective roots via `resolvePathWithinRoot()` (symlink-aware) to prevent path traversal.
2. **Docker Services** (`docker`): Start lane-specific Docker Compose services (databases, caches, queues). The compose file path is validated against the project root to prevent path escape.
3. **Dependency Installation** (`dependencies`): Run install commands from an allowlist of known package managers (`npm`, `yarn`, `pnpm`, `pip`, `pip3`, `bundle`, `cargo`, `go`, `composer`, `poetry`, `pipenv`, `bun`). Commands outside this allowlist are rejected. Working directories for dependency commands are validated against the worktree root.
4. **Mount Points** (`mount-points`): Configure runtime mount points for agent profiles/context. Both source and destination paths are validated via `resolvePathWithinRoot()` to prevent escaping the allowed directories, including through symlinks.
5. **Copy Paths**: Both source and destination paths are validated via symlink-aware containment checks against the project root and worktree respectively.

### LaneEnvInitProgress Component

The `LaneEnvInitProgress` component shows real-time initialization progress directly inside the `CreateLaneDialog`. Each step displays its status (pending, running, done, failed) with duration tracking.

### LaneOverlayConfigPanel

The `LaneOverlayConfigPanel` component (in `src/renderer/components/lanes/LaneOverlayConfigPanel.tsx`) provides a UI for configuring overlay policies in lane settings, including the new env/port/proxy override fields.

### Types

Defined in `src/shared/types/config.ts`:

- `LaneEnvInitConfig` — top-level config with `envFiles`, `docker`, `dependencies`, `mountPoints` arrays
- `LaneEnvInitProgress` — per-lane progress state with step statuses and timestamps
- `LaneEnvInitStep` — individual step status: `"pending" | "running" | "done" | "failed"`
- `LaneEnvFileConfig` — source/destination template pair for env files
- `LaneDockerConfig` — Docker Compose path and service names
- `LaneDependencyInstallConfig` — command, working directory, and package manager
- `LaneMountPointConfig` — mount source, target, and read-only flag
- `LaneSetupScriptConfig` — platform-specific setup script with commands/script paths and primary worktree path injection
- `LaneCleanupConfig` — auto-cleanup policy for stale lanes (max active, archive/delete thresholds, remote branch cleanup)

### IPC Channels

| Channel | Description |
|---------|-------------|
| `ade.lanes.initEnv` | Trigger environment initialization for a lane |
| `ade.lanes.getEnvStatus` | Get current environment initialization status |
| `ade.lanes.getOverlay` | Get resolved overlay policy for a lane |
| `ade.lanes.env.event` | Event stream for environment initialization progress |

---

## Lane Overlay Policy Extensions (Phase 5 W1 — DONE)

The `LaneOverlayOverrides` type has been extended with four new fields to support runtime isolation configuration:

```typescript
type LaneOverlayOverrides = {
  env?: Record<string, string>;
  cwd?: string;
  processIds?: string[];
  testSuiteIds?: string[];
  // New in Phase 5 W1:
  portRange?: { start: number; end: number };
  proxyHostname?: string;
  computeBackend?: "local" | "vps" | "daytona";
  envInit?: LaneEnvInitConfig;
};
```

The `laneOverlayMatcher` evaluates overlay policies at lane creation time:

- `portRange`: last-wins merge (most specific policy takes precedence)
- `proxyHostname`: last-wins merge
- `computeBackend`: last-wins merge
- `envInit`: deep-merged (env files, docker configs, dependencies, and mount points concatenate across policies)

---

## Lane Templates (Phase 5 W2 — DONE)

The `laneTemplateService` provides CRUD operations for reusable lane initialization recipes. Templates encapsulate a complete environment setup that can be applied when creating new lanes.

### Template Contents

Each `LaneTemplate` specifies:

- `envFiles` — environment file copy/template pairs
- `docker` — Docker Compose paths and service names
- `dependencies` — install commands per package manager
- `mountPoints` — runtime mount configurations
- `portRange` — default port range for lanes using this template
- `envVars` — extra environment variables
- `setupScript` — optional post-creation setup script with platform-specific command/script support

### Setup Script (`LaneSetupScriptConfig`)

Templates can include a setup script that runs after environment initialization completes. The script config supports platform-specific overrides:

- `commands` / `unixCommands` / `windowsCommands` — inline shell commands (platform-specific variants take precedence)
- `scriptPath` / `unixScriptPath` / `windowsScriptPath` — path to a script file relative to the project root (platform-specific variants take precedence)
- `injectPrimaryPath` — when true, `$PRIMARY_WORKTREE_PATH` (or `%PRIMARY_WORKTREE_PATH%` on Windows) is available in commands/scripts, referencing the primary lane's worktree root

The `laneTemplateService.resolveSetupScript(template)` method resolves the platform-appropriate commands and script path at runtime, returning `null` if no setup script is configured or if the resolved config has no commands and no script path.

### UI Components

- **Template selector in CreateLaneDialog**: Users choose a template when creating a lane; the template's config is auto-applied to the new lane's environment initialization.
- **LaneTemplatesSection in Settings**: Management UI (`src/renderer/components/settings/LaneTemplatesSection.tsx`) for creating, editing, and deleting templates. Supports setting a project-level default template. Each template card shows feature chips summarizing its configuration (copy paths, env files, dependencies, mounts, docker, ports, env vars, setup script).

### NO_DEFAULT_LANE_TEMPLATE Sentinel

The `NO_DEFAULT_LANE_TEMPLATE` sentinel value is used when a project explicitly opts out of having a default template. This distinguishes "no default set" from "default cleared intentionally."

### IPC Channels

| Channel | Description |
|---------|-------------|
| `ade.lanes.templates.list` | List all templates |
| `ade.lanes.templates.get` | Get a template by ID |
| `ade.lanes.templates.getDefault` | Get the project's default template |
| `ade.lanes.templates.setDefault` | Set the project's default template |
| `ade.lanes.templates.apply` | Apply a template to an existing lane |

---

## Lane Cleanup & Lifecycle

ADE supports automatic lane cleanup to prevent lane sprawl in long-running projects. The cleanup policy is configured via `LaneCleanupConfig` in the project config (`local.yaml` / `ade.yaml`) and managed in the Settings UI under the **Lane Behavior** section.

### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxActiveLanes` | `number` | `0` (unlimited) | Maximum active (non-archived) lanes. Oldest by access time are auto-archived when exceeded. |
| `cleanupIntervalHours` | `number` | `0` (disabled) | How often (in hours) to scan for stale lanes and run cleanup. |
| `autoArchiveAfterHours` | `number` | `0` (never) | Auto-archive lanes inactive for this many hours. |
| `autoDeleteArchivedAfterHours` | `number` | `0` (never) | Permanently delete archived lanes after this many hours. |
| `deleteRemoteBranchOnCleanup` | `boolean` | `false` | Also delete the remote branch when a lane is auto-deleted. |

### Settings UI

The **Lane Behavior** section in Settings (`LaneBehaviorSection.tsx`) manages both auto-rebase and cleanup configuration:

- **Auto-rebase child lanes** — toggle to automatically rebase dependent lanes when a parent advances
- **Cleanup & limits** — primary controls for max active lanes and auto-archive inactivity threshold; secondary controls (scan interval, archived deletion period, remote branch cleanup) appear conditionally when cleanup is active

Cleanup configuration is persisted to `local.yaml` via the project config service.

### Types

Defined in `src/shared/types/config.ts`:

- `LaneCleanupConfig` — cleanup policy with all fields above
- `ProjectConfigFile.laneCleanup` — project-level cleanup config
- `EffectiveProjectConfig.laneCleanup` — effective (merged) cleanup config

---

## Port Allocation (Phase 5 W3 — DONE)

The `portAllocationService` provides lease-based port range allocation for lanes. Each lane that needs network ports is assigned a non-overlapping range from a configurable pool.

### How It Works

- **Base port** (default: 3000) and **ports per lane** (default: 100) are configurable via `PortAllocationConfig`.
- When a lane acquires a lease, the service finds the next available range and assigns it.
- Port leases have a lifecycle: `active` → `released` (on lane archive/delete) or `orphaned` (on abnormal termination).
- Port conflict detection identifies when two lanes have overlapping ranges and surfaces them in the UI. Conflict detection also runs automatically after orphan recovery to catch any newly introduced overlaps.
- The `maxSlots()` calculation clamps to zero for degenerate port range configurations.

### PortAllocationPanel

The `PortAllocationPanel` component (`src/renderer/components/lanes/PortAllocationPanel.tsx`) displays the current port lease for a lane in the lane detail/inspector, including the allocated range, lease status, and any detected conflicts.

### Types

Defined in `src/shared/types/config.ts`:

- `PortLease` — lane ID, range start/end, status (`"active" | "released" | "orphaned"`), timestamps
- `PortConflict` — conflicting port number, the two lane IDs, and detection timestamp
- `PortAllocationConfig` — base port, ports per lane, max port ceiling
- `PortAllocationEvent` — event payload for lease acquired/released and conflict detected/resolved

### IPC Channels

| Channel | Description |
|---------|-------------|
| `ade.lanes.port.getLease` | Get port lease for a lane |
| `ade.lanes.port.listLeases` | List all active port leases |
| `ade.lanes.port.listConflicts` | List detected port conflicts |
| `ade.lanes.port.acquire` | Acquire a port lease for a lane |
| `ade.lanes.port.release` | Release a port lease |
| `ade.lanes.port.recoverOrphans` | Recover orphaned port leases |
| `ade.lanes.port.event` | Event stream for port allocation changes |

---

## Lane Proxy & Preview

Each lane can be assigned a unique `.localhost` subdomain for isolated web access:

- **Hostname Pattern**: `<lane-slug>.localhost` (e.g., `feat-auth.localhost:8080`)
- **Reverse Proxy**: A single proxy port routes requests by Host header to the correct lane's dev server
- **Cookie/Auth Isolation**: Each lane gets its own cookie jar via unique hostname — no cross-lane session leakage
- **Preview URLs**: Generated URLs can be shared or opened in browser for quick visual review
- **Browser Profile Isolation** (optional): Auto-launch Chrome with a lane-specific profile directory

This solves the common pain point where multiple dev servers on the same `localhost` share cookies, ports, and auth state — causing silent failures when switching between branches/lanes.

### Per-Lane Hostname Isolation (Phase 5 W4 — DONE)

The `laneProxyService` implements a reverse proxy that routes HTTP requests by Host header to the correct lane's dev server.

**Architecture**:
- Single proxy port (default 8080) handles all lane traffic
- Hostname pattern: `<lane-slug>.localhost:<proxyPort>` (e.g., `feat-auth.localhost:8080`)
- Host header routing: proxy parses the incoming Host header, strips the suffix, looks up the lane's target port, and forwards the request
- Cookie/auth isolation: each lane gets a unique hostname, so browser cookies are naturally scoped per-lane — no cross-lane session leakage
- IPv6 normalization: handles `[::1]` and `::ffff:127.0.0.1` variants for localhost connections

**Service**: `laneProxyService.ts` (`src/main/services/lanes/laneProxyService.ts`)
- `startProxy(port?)` — starts the HTTP reverse proxy server
- `stopProxy()` — stops the proxy server
- `addRoute(laneId, targetPort)` — registers a hostname route for a lane
- `removeRoute(laneId)` — removes a lane's route
- `getStatus()` — returns current proxy status with all routes
- `getPreviewInfo(laneId)` — generates preview URL info for a lane
- `openPreview(laneId)` — opens preview URL in the default browser

**Types** (from `shared/types/config.ts`):
```typescript
type ProxyRouteStatus = "active" | "inactive" | "error";
type ProxyRoute = { laneId: string; hostname: string; targetPort: number; status: ProxyRouteStatus; createdAt: string };
type ProxyStatus = { running: boolean; proxyPort: number; routes: ProxyRoute[]; startedAt?: string; error?: string };
type ProxyConfig = { proxyPort: number; hostnameSuffix: string };
type LanePreviewInfo = { laneId: string; hostname: string; previewUrl: string; proxyPort: number; targetPort: number; active: boolean };
type LaneProxyEvent = { type: "proxy-started" | "proxy-stopped" | "route-added" | "route-removed" | "route-error"; status?: ProxyStatus; route?: ProxyRoute; error?: string };
```

**IPC Channels**:

| Channel | Description |
|---------|-------------|
| `ade.lanes.proxy.getStatus` | Get proxy server status |
| `ade.lanes.proxy.start` | Start the reverse proxy |
| `ade.lanes.proxy.stop` | Stop the reverse proxy |
| `ade.lanes.proxy.addRoute` | Add a hostname route for a lane |
| `ade.lanes.proxy.removeRoute` | Remove a lane's route |
| `ade.lanes.proxy.getPreviewInfo` | Get preview URL info for a lane |
| `ade.lanes.proxy.openPreview` | Open preview URL in browser |
| `ade.lanes.proxy.event` | Event stream for proxy changes |

**Codex audit hardening** (commit 6677edf): Added Host header validation, route lookup hardening, and proxy error page sanitization.

### Preview URLs (Phase 5 W4 — DONE)

The `LanePreviewPanel` component provides a preview URL management surface in the lane detail view.

**Features**:
- One-click preview URL generation from lane port allocation
- Copy preview URL to clipboard for sharing
- Open preview in default browser
- Proxy status indicator (running/stopped)
- Route status per lane (active/inactive/error)

**Component**: `LanePreviewPanel.tsx` (`src/renderer/components/lanes/LanePreviewPanel.tsx`)

See also: `docs/final-plan/phase-5.md`

### Lane Artifacts

Artifacts are first-class objects on lanes, enabling agents, chat sessions, and mission workers to attach visual proof and outputs directly to the lane where work happened.

**Artifact types**:
- `summary`: Text summary of work performed
- `pr`: PR link and metadata
- `link`: External URL reference
- `note`: Free-form text note
- `patch`: Code diff/patch
- `screenshot`: PNG/JPEG image captured from agent environment (new)
- `video`: Screen recording of agent work in MP4 format (new)
- `test-result`: Structured test output with pass/fail counts and log (new)

**Artifact sources**:
- Agent chat sessions: Agent captures screenshots or records video while working in a lane
- Task agents: Background agents attach artifacts on completion
- Mission steps: When a mission step targets a lane, artifacts attach to both the mission and the lane
- Manual: Users can attach files directly via the lane detail UI

**Artifact display**: Lane detail view includes an "Artifacts" sub-pane showing attached artifacts with thumbnails, timestamps, and source labels (which agent/session produced them).

**PR integration**: When a PR is opened from a lane, the PR description generator auto-includes attached artifacts:
- Screenshots are embedded as images in the PR body
- Videos are linked (uploaded to a configured destination or attached as GitHub PR assets)
- Test results are formatted as a summary table

**Storage**: Shared `artifacts` table with polymorphic ownership:
- `owner_type`: 'mission' | 'lane' | 'agent-run'
- `owner_id`: mission ID, lane ID, or agent run ID

**IPC channels**: `ade.artifacts.list(ownerId)`, `ade.artifacts.get(artifactId)`, `ade.artifacts.attach(ownerId, artifact)`, `ade.artifacts.delete(artifactId)`

---

## Auth Redirect Handling (Phase 5 W5 — DONE)

The `oauthRedirectService` solves the problem of OAuth callbacks reaching the correct lane when multiple lanes share the same OAuth provider configuration.

**Why state-parameter routing**: Traditional OAuth requires registering a specific redirect URI per app instance. With multiple lanes, you'd need to register N redirect URIs — impractical for most providers. Instead, ADE encodes the originating lane ID into the OAuth `state` parameter (a standard OAuth 2.0 field), so a single callback URL works for all lanes.

**Routing strategies**:
1. **State-parameter routing** (default): ADE encodes `{laneId, originalState}` into the state parameter. The proxy intercepts callbacks, decodes the state, and forwards to the correct lane's dev server. Works with any OAuth provider.
2. **Hostname-based routing** (fallback): For providers supporting wildcard redirect URIs (`*.localhost`), each lane's unique hostname naturally routes callbacks.

**Service**: `oauthRedirectService.ts` (`src/main/services/lanes/oauthRedirectService.ts`)
- `getStatus()` — returns OAuth redirect service status
- `updateConfig(config)` — updates OAuth redirect configuration
- `generateRedirectUris(provider?)` — generates redirect URIs to register with OAuth providers
- `encodeState(laneId, originalState)` — encodes lane ID into OAuth state parameter
- `decodeState(encodedState)` — decodes lane ID from OAuth state parameter
- `listSessions()` — lists active OAuth sessions

**Session tracking**: Each OAuth flow is tracked as an `OAuthSession` with lifecycle: `pending` → `active` → `completed` | `failed`. Sessions use `randomUUID()` for session identifiers. Sessions include provider detection, callback path matching, and automatic cleanup.

**Setup assistant**: The `ProxyAndPreviewSection` in Settings provides a "Copy Redirect URIs" helper that generates the exact URIs to register with your OAuth provider based on your proxy configuration.

**Types** (from `shared/types/config.ts`):
```typescript
type OAuthRoutingMode = "state-parameter" | "hostname";
type OAuthSessionStatus = "pending" | "active" | "completed" | "failed";
type OAuthSession = { id: string; laneId: string; provider?: string; status: OAuthSessionStatus; callbackPath: string; createdAt: string; completedAt?: string; error?: string };
type OAuthRedirectConfig = { enabled: boolean; callbackPaths: string[]; routingMode: OAuthRoutingMode };
type OAuthRedirectStatus = { enabled: boolean; routingMode: OAuthRoutingMode; activeSessions: OAuthSession[]; callbackPaths: string[] };
type OAuthRedirectEvent = { type: "oauth-callback-routed" | "oauth-session-started" | "oauth-session-completed" | "oauth-session-failed" | "oauth-config-changed"; session?: OAuthSession; status?: OAuthRedirectStatus; error?: string };
type RedirectUriInfo = { provider: string; uris: string[]; instructions: string };
```

**IPC Channels**:

| Channel | Description |
|---------|-------------|
| `ade.lanes.oauth.getStatus` | Get OAuth redirect service status |
| `ade.lanes.oauth.updateConfig` | Update OAuth redirect configuration |
| `ade.lanes.oauth.generateRedirectUris` | Generate redirect URIs for provider setup |
| `ade.lanes.oauth.encodeState` | Encode lane ID into OAuth state |
| `ade.lanes.oauth.decodeState` | Decode lane ID from OAuth state |
| `ade.lanes.oauth.listSessions` | List active OAuth sessions |
| `ade.lanes.oauth.event` | Event stream for OAuth redirect changes |

**Codex audit hardening** (commit d7058c9): Added HMAC validation for state parameter integrity, session cleanup for stale sessions, and error pages for failed OAuth callbacks.

See also: `docs/final-plan/phase-5.md`

---

## Runtime Diagnostics (Phase 5 W6 — DONE)

The `runtimeDiagnosticsService` provides continuous health monitoring for lane runtime isolation, surfacing issues and offering one-click remediation.

**Why traffic-light health**: Lane isolation involves multiple moving parts (processes, ports, proxy routes). A single "healthy/unhealthy" status isn't enough — developers need to see which specific component is failing. The traffic-light model (healthy/degraded/unhealthy) with per-component checks gives actionable visibility.

**Health check components**:
- **Process alive**: Is the lane's dev server process running?
- **Port responding**: Is the allocated port accepting connections?
- **Proxy route active**: Is the proxy routing traffic to this lane? When the proxy status itself is unavailable, the lane is immediately marked `unhealthy` with a `proxy-route-missing` issue.
- **Fallback mode**: Is the lane operating in degraded fallback mode?

**Service**: `runtimeDiagnosticsService.ts` (`src/main/services/lanes/runtimeDiagnosticsService.ts`)
- `getStatus()` — returns full diagnostics status for all lanes
- `getLaneHealth(laneId)` — returns health check for a specific lane
- `runHealthCheck(laneId)` — triggers an on-demand health check
- `runFullCheck()` — runs health checks for all lanes
- `activateFallback(laneId)` — enables fallback mode for a lane
- `deactivateFallback(laneId)` — disables fallback mode

**Fallback mode**: When isolation fails (proxy down, port conflict), fallback mode allows the lane to continue operating with direct localhost access instead of proxied hostname access. This ensures developers aren't blocked by infrastructure issues.

**UI Components**:
- `LaneHealthDot` — traffic-light indicator (green/yellow/red) in lane list rows
- `RuntimeDiagnosticsPanel` — detailed diagnostics panel in lane detail view with per-component status and remediation actions
- `DiagnosticsDashboardSection` — global diagnostics dashboard in Settings showing proxy status, all lane health, and active conflicts

**Health status levels**:

| Status | Color | Meaning |
|--------|-------|---------|
| `healthy` | Green | All checks passing |
| `degraded` | Yellow | Some checks failing, lane functional via fallback |
| `unhealthy` | Red | Critical checks failing, lane may not work |
| `unknown` | Gray | Health not yet checked |

**Actionable remediation**: Each health issue includes an `actionLabel` and `actionType` so the UI can offer one-click fixes:
- `reassign-port` — reallocate port when conflict detected
- `restart-proxy` — restart proxy when route missing
- `reinit-env` — reinitialize environment when env init failed
- `enable-fallback` — switch to fallback mode when proxy unavailable

**Types** (from `shared/types/config.ts`):
```typescript
type LaneHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
type LaneHealthIssue = { type: "process-dead" | "port-unresponsive" | "proxy-route-missing" | "port-conflict" | "env-init-failed"; message: string; actionLabel?: string; actionType?: "reassign-port" | "restart-proxy" | "reinit-env" | "enable-fallback" };
type LaneHealthCheck = { laneId: string; status: LaneHealthStatus; processAlive: boolean; portResponding: boolean; proxyRouteActive: boolean; fallbackMode: boolean; lastCheckedAt: string; issues: LaneHealthIssue[] };
type RuntimeDiagnosticsStatus = { lanes: LaneHealthCheck[]; proxyRunning: boolean; proxyPort: number; totalRoutes: number; activeConflicts: number; fallbackLanes: string[] };
type RuntimeDiagnosticsEvent = { type: "health-updated" | "fallback-activated" | "fallback-deactivated" | "diagnostics-refresh"; laneId?: string; health?: LaneHealthCheck; status?: RuntimeDiagnosticsStatus };
```

**IPC Channels**:

| Channel | Description |
|---------|-------------|
| `ade.lanes.diagnostics.getStatus` | Get full diagnostics status |
| `ade.lanes.diagnostics.getLaneHealth` | Get health for a specific lane |
| `ade.lanes.diagnostics.runHealthCheck` | Run health check for a lane |
| `ade.lanes.diagnostics.runFullCheck` | Run health checks for all lanes |
| `ade.lanes.diagnostics.activateFallback` | Activate fallback mode |
| `ade.lanes.diagnostics.deactivateFallback` | Deactivate fallback mode |
| `ade.lanes.diagnostics.event` | Event stream for diagnostics changes |

**Codex audit hardening** (commit 97565cf): Added timeout guards for health checks, sanitized diagnostic event payloads, and hardened fallback activation idempotency.

See also: `docs/final-plan/phase-5.md`

---

## Runtime Placement

The older per-lane "compute backend" concept is no longer the active ADE model.

- **Current baseline**: lanes run on the active ADE machine alongside local worktrees, terminals, and previews.
- **Phase 6 direction**: other devices become controllers of the host machine rather than choosing a different backend per lane.
- **Dropped direction**: Daytona-style managed cloud backends are not part of the active lanes roadmap.

---

## Lane Overlay Policies

The existing `laneOverlayMatcher.ts` system provides a foundation for lane-specific configuration. Overlay policies define per-lane overrides for environment variables, port mappings, proxy settings, and other lane-local runtime behavior. These policies are evaluated at lane creation time and can be dynamically updated as lane configuration changes.

---

## Multi-Device Lane Availability (Phase 6)

When multiple devices are connected, lanes gain a per-device **availability state** that governs what actions are possible on each machine. This is the primary UX layer for multi-device lane management.

### Availability States

| State | Icon | Meaning | User Actions |
|-------|------|---------|--------------|
| **Local** | ✓ | Branch synced, worktree exists locally, no remote agents running | Full local dev |
| **Behind** | ⚠ | Host has commits not yet pulled to this device | "Sync to this Mac" (one-click) |
| **Live on [device]** | 🔵 | Agent actively running on this lane on the host | View remotely, chat with agent, auto-sync when done |
| **Remote only** | ☁ | Lane exists on the host, never been pulled here | "Bring to this machine" (one-click) |
| **Push pending** | ⏳ | Host has commits but hasn't pushed to remote yet | "Request push" or wait |
| **Offline** | ○ | Host unreachable, code state unknown | View cached metadata only |

On the host machine itself, all lanes are inherently "local" — standard dirty/ahead/behind indicators apply.

### Auto-Push Policy

The host auto-pushes lane branches to the remote so other devices can access code without manual intervention:

- `on-commit` (default): Push after every commit. Code available on other devices within seconds.
- `on-agent-complete`: Push when agent finishes work on the lane.
- `manual`: User must explicitly push.

Configurable per-project in Settings → Sync → Auto-push policy.

### One-Click Sync

"Sync to this Mac" orchestrates: remote push (if needed) → local fetch → worktree creation. One button, three steps, lane becomes Local.

### Agent-Running Guard

While an agent is actively running on a lane on the host, other devices **cannot create a local worktree** for that lane. This prevents divergent writes to the same branch. Users can:

- View agent work remotely (file contents via File Access Protocol, agent chat via cr-sqlite)
- Send messages to the agent from a controller device
- Register "Auto-sync when done" — ADE auto-syncs the lane when the agent finishes
- Register "Notify me" — lighter, just a notification when done

**Reverse guard**: If a lane is checked out locally and the user tries to launch an agent on the host for that lane, ADE warns about divergent changes and offers to push local changes first.

### Device Sync Summary

On first connection to a host (for example, opening a laptop away from the primary machine), ADE shows a summary overlay listing all lanes with their availability states, offering bulk sync for all ready lanes. Also accessible from the status bar.

Full design details: `docs/final-plan/phase-6.md` → W10.

---

## 2026-02-16 Addendum — Integration Lane Rule

ADE now applies an explicit external-resolver integration rule:

- Single source lane merge into target: external CLI runs in source lane worktree.
- Multiple source lanes into target: ADE auto-creates or reuses an **Integration lane** and runs external CLI there.

No additional orchestrator/scheduler behavior is introduced by this rule; it is scoped to conflict-resolution execution only.
