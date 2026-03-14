# History — Operations Timeline & Replay

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-13

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [User Experience](#user-experience)
  - [Layout](#layout)
  - [Timeline Panel](#timeline-panel)
  - [Event Detail Panel](#event-detail-panel)
  - [Future Enhancements](#future-enhancements)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Operation Recording Flow](#operation-recording-flow)
- [Data Model](#data-model)
  - [Current Tables](#current-tables)
  - [Future Tables](#future-tables)
  - [Type Definitions](#type-definitions)
- [Implementation Tracking](#implementation-tracking)

---

## Overview

The History feature provides an ADE-native operations timeline that records
everything meaningful that happens in a project. Unlike `git log` which only shows
commits, the History tab captures a broader view: git operations with before/after
SHA transitions, terminal session lifecycle, and metadata about each action. Pack-
backed checkpoints/events still exist as backend compatibility artifacts, but they
are not exposed through a current public `ade.packs.*` IPC surface.

This timeline serves multiple purposes:

- **Traceability**: Understand what happened, when, and in which lane. Every
  significant action is recorded with enough context to reconstruct the sequence
  of events.
- **Debugging**: When something goes wrong, the history provides a clear trail.
  Failed operations are recorded with their error context, making it easy to
  identify what broke and when.
- **Undo**: For reversible operations, the history provides the foundation for
  undoing actions. The pre-HEAD and post-HEAD SHA recorded with each git operation
  enables precise rollback.
- **Auditing**: The complete operation log provides accountability for changes,
  especially useful in team environments where understanding who did what matters.

**Current status**: Implemented and working (Phases 2 + 8). The core operations timeline is recorded and browsable, and Phase 8 adds checkpoints + pack events as first-class history artifacts. The UI favors readable activity summaries with deep links into lanes and packs; raw metadata remains available but is de-emphasized to reduce noise. Advanced timeline features (graph view, undo, replay, export) remain planned for Phase 9.

Recent UI hardening keeps the page quieter under load: polling only runs while live operations exist, background refreshes stay silent, and focus/visibility return triggers catch-up refresh instead of constant foreground churn.

---

## Core Concepts

### Operation Record

The fundamental unit of history. An operation record captures a tracked action with:

- **Kind**: What type of action (e.g., `git.commit`, `git.checkout`, `pack.refresh`)
- **Status**: Current state (`running`, `succeeded`, `failed`, `canceled`)
- **Timestamps**: When the operation started and ended
- **SHA transitions**: For git operations, the HEAD SHA before and after the action
- **Lane association**: Which lane the operation was performed in (if applicable)
- **Metadata**: Additional context as a JSON object (commit message, file list,
  error details, etc.)

Currently tracked operation kinds:

| Kind | Description | Metadata |
|------|-------------|----------|
| `git.commit` / `git_commit` | A git commit was created | `{ message, filesChanged, sha }` |
| `git.checkout` | Branch was checked out | `{ fromBranch, toBranch }` |
| `git.merge` | A merge was performed | `{ fromBranch, conflicts }` |
| `git.rebase` | A rebase was performed | `{ ontoBranch, commitCount }` |
| `git.push` / `git_push` | Changes pushed to remote | `{ remote, branch, commitCount }` |
| `git.pull` | Changes pulled from remote | `{ remote, branch, newCommits }` |
| `git.fetch` / `git_fetch` | Fetch from remote | `{ remote }` |
| `git.sync` / `git_sync` | Merge or rebase with upstream | `{ mode, baseRef }` |
| `pack_update_lane` | A lane pack was regenerated | `{ reason, trigger }` |
| `pack_update_project` | The project pack was regenerated | `{ reason, trigger }` |

### Session Record

Terminal session lifecycle tracking. Each session records:

- Session ID and associated lane
- Start and end timestamps
- Exit code (when session ends)
- Transcript path (for session replay, future)
- Command count and last command

Sessions appear in the timeline alongside other operations, providing context about
what terminal work was happening around each git or context-maintenance operation.

### Checkpoint

An immutable snapshot created at session boundaries (implemented in Phase 8 via packService compatibility internals). A checkpoint captures:

- The exact SHA at the moment of creation
- Diff stat since the previous checkpoint
- Pack event IDs associated with this checkpoint
- Session reference (which session triggered the checkpoint)

Checkpoints enable navigating to any past state to see what the repository looked
like at that point.

### Pack Event

Append-only log entries recording changes to pack/export state (implemented in Phase 8 via packService compatibility internals). Each event records what
happened (checkpoint created, narrative updated, conflict detected, etc.) with a
typed payload. This provides a granular audit trail of how deterministic context exports evolve. Events are surfaced in context/inventory workflows rather than a dedicated PackViewer component.

### Feature History (Future)

A filtered view of the timeline scoped to a specific feature or issue. By tagging
lanes and operations with feature/issue identifiers, ADE can reconstruct the
complete history of work on a particular feature across multiple lanes and sessions.

### Replay (Future)

The ability to re-examine past state by navigating to a checkpoint. Replay does
not re-execute commands; it provides a read-only view of the repository state,
pack content, and session context at a given point in time.

---

## User Experience

### Layout

The History tab uses a 2-pane `PaneTilingLayout` optimized for timeline browsing with
contextual detail:

```
+-----------------------------+-------------------------+
|                             |                         |
|   Timeline                  |   Event Detail          |
|   (~45% width)              |   (~55% width)          |
|                             |                         |
|   [Filters]                 |   Kind: git.commit      |
|   ┌─────────────────────┐   |   Status: succeeded     |
|   │ ● Git commit        │   |   Lane: feature/auth    |
|   │   feature/auth      │   |   Started: 14:32:01     |
|   │   2 min ago         │   |   Ended: 14:32:02       |
|   ├─────────────────────┤   |   Duration: 1.2s        |
|   │ ○ Lane pack refresh │   |   Pre-HEAD: abc1234     |
|   │   feature/auth      │   |   Post-HEAD: def5678    |
|   │   5 min ago         │   |                         |
|   ├─────────────────────┤   |   Metadata:             |
|   │ ● Git push          │   |   { message: "Add..."   |
|   │   feature/auth      │   |     filesChanged: 3 }   |
|   │   12 min ago        │   |                         |
|   └─────────────────────┘   |   [Jump to lane]        |
+-----------------------------+-------------------------+
```

The layout uses `PaneTilingLayout` (recursive `react-resizable-panels` tree) with persisted pane sizes.

### Timeline Panel

The left pane displays a chronological list of operations, most recent first.

**Filter bar** (top of timeline):

- **Lane filter** (dropdown): "All lanes" (default), or select a specific lane
  to see only operations in that lane. Also accepts `laneId` URL parameter.
- **Kind filter** (dropdown): "All kinds" (default), or filter to specific
  kind (e.g., `git_commit`, `pack_update_lane`)
- **Status filter** (chip buttons): "All" (default), succeeded, failed,
  running, canceled — click to toggle
- **Refresh button**: Manually refresh the operation list
- Auto-refresh: silent polling every 4s when any operation has `running` status, guarded by window visibility/focus so background tabs stay quiet

**Operation rows**:

Each row displays:

- **Status border**: Color-coded left border
  - Emerald: succeeded
  - Red: failed
  - Amber: running
  - Gray: canceled
- **Description**: Human-readable summary generated by `describeOperation()` (e.g., "Git commit · feature/auth · Add login button", "Lane pack refreshed · trigger: session_end")
- **Kind chip**: Operation kind displayed as a chip (e.g., "Git commit", "Lane pack refreshed")
- **Lane name**: Which lane this happened in (or "project" for project-level ops)
- **Status chip**: Color-coded status badge
- **Timestamp**: Relative time ("2m ago", "5h ago") with absolute time on hover

**Interaction**:

- Click a row to select it and populate the detail panel
- Selected row is highlighted with a distinct background color
- Scroll loads more operations (pagination via offset/limit; default fetch size is intentionally bounded to keep large histories responsive)
- Empty state: "No operations recorded yet" with explanation

### Event Detail Panel

The right pane shows comprehensive details for the selected operation.

**Header**:

- Operation kind (humanized, e.g., "Git commit") with kind icon
- Status badge with color
- Lane name (clickable — navigates to the lane in the Lanes tab via `/lanes?laneId=...`)

**Detail fields** (displayed as labeled rows):

- **Kind**: Full operation kind string
- **Status**: Color-coded badge
- **Started**: ISO 8601 timestamp with relative time and calendar/clock icons
- **Ended**: Same format (blank if operation is still running)
- **Duration**: Computed from start-to-end (e.g., "1.2s", "45s", "2m 13s")
- **Pre-HEAD**: SHA before the operation, displayed as abbreviated hash (10 chars)
- **Post-HEAD**: SHA after the operation, displayed with arrow transition indicator

**Metadata**:

- Parsed from `metadataJson` field
- Key fields pulled out as labeled values (e.g., commit message, trigger reason)
- Full JSON expandable view for detailed inspection
- Collapsible section for large metadata objects

**Actions** (bottom of detail panel):

- **Jump to lane**: Navigate to the associated lane in the Lanes tab (implemented — navigates to `/lanes?laneId=...`)
- **Undo**: Reverse this operation (future, only for reversible git operations)
- **Copy details**: Copy the full operation record as JSON to clipboard (future)

### Future Enhancements

**Feature history**:

- Filter the timeline by a feature/issue tag
- Shows all operations across all lanes related to that feature
- Timeline includes lane switches, showing how work moved between lanes

**Graph view**:

- Visual timeline with branching for parallel operations across lanes
- Each lane is a vertical track; operations are nodes on the track
- Connections show relationships (e.g., merge operations connect two tracks)
- Zoom and pan for navigating large histories

**Checkpoint browser**:

- Navigate to any checkpoint to see the repository state at that point
- Read-only file browser showing the working tree at the checkpoint SHA
- Pack content at that point in time
- Diff from current state

**Pack version history**:

- See how packs evolved over time
- Side-by-side diff between pack versions
- Identify when specific narrative content was added or changed

**Plan version history**:

- Track iterations of implementation plans
- Diff between plan versions to see how scope changed
- Correlate plan changes with operation history

**Replay**:

- Re-run a sequence of operations (dry-run mode, no actual execution)
- Useful for understanding complex operation sequences
- Provides "what if" analysis for alternative operation orderings

---

## Technical Implementation

### Services

| Service | Status | Responsibility |
|---------|--------|----------------|
| `operationService` | **Exists, implemented** | CRUD for operation records; query with filters (lane, kind, status, pagination); SHA transition tracking |
| `sessionService` | Exists | Session lifecycle tracking; provides session data for history correlation |
| `packService` | Exists | Remaining compatibility pack refresh operations are recorded via operationService |

The `operationService` is called by other services whenever a significant action
occurs. For example, `gitService` calls `operationService.record()` before and
after each git operation to capture the pre/post state.

### IPC Channels

**Currently implemented**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.history.listOperations` | `(args: { laneId?: string; kind?: string; status?: string; limit: number; offset: number }) => OperationRecord[]` | Query operations with optional filters and pagination |

**Pack/checkpoint status**:

There is no current public `ade.packs.*` IPC surface in the branch. Checkpoints, pack events, and pack versions remain backend data owned by compatibility paths, but History UI browsing for those records is still not shipped.

**Planned (future)**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.history.getFeatureHistory` | `(featureId: string) => HistoryEntry[]` | Get the complete history for a feature across lanes |
| `ade.history.undoOperation` | `(id: string) => GitActionResult` | Undo a reversible operation |
| `ade.history.exportHistory` | `(args: { format: 'csv' \| 'json'; filters?: HistoryFilters }) => string` | Export filtered history as CSV or JSON |

### Operation Recording Flow

```
gitService.commit(args):
  1. preHeadSha = getCurrentHead()
  2. operationId = operationService.start({
       kind: 'git.commit',
       laneId: activeLaneId,
       preHeadSha
     })
  3. try:
       result = execGitCommit(args)
       postHeadSha = getCurrentHead()
       operationService.complete(operationId, {
         status: 'succeeded',
         postHeadSha,
         metadata: { message: args.message, filesChanged: result.files.length }
       })
     catch (error):
       operationService.complete(operationId, {
         status: 'failed',
         metadata: { error: error.message }
       })
```

This pattern ensures that every git operation is bracketed by start/complete calls,
providing accurate timing and pre/post SHA transitions even when operations fail.

---

## Data Model

### Current Tables

```sql
-- Core operation record table (implemented and in use)
operations (
  id TEXT PRIMARY KEY,             -- UUID generated at operation start
  project_id TEXT NOT NULL,        -- FK to projects table
  lane_id TEXT,                    -- FK to lanes table (NULL for project-level ops)
  kind TEXT NOT NULL,              -- Operation kind (e.g., 'git.commit', 'pack.refresh')
  started_at TEXT NOT NULL,        -- ISO 8601 timestamp
  ended_at TEXT,                   -- ISO 8601 timestamp (NULL while running)
  status TEXT NOT NULL,            -- 'running' | 'succeeded' | 'failed' | 'canceled'
  pre_head_sha TEXT,               -- Git HEAD before operation (for git ops)
  post_head_sha TEXT,              -- Git HEAD after operation (for git ops)
  metadata_json TEXT               -- JSON object with operation-specific data
)

-- Indexes for efficient querying
CREATE INDEX idx_operations_project_id ON operations(project_id);
CREATE INDEX idx_operations_lane_id ON operations(lane_id);
CREATE INDEX idx_operations_kind ON operations(kind);
CREATE INDEX idx_operations_started_at ON operations(started_at);
```

### Phase 8 Tables (Implemented)

```sql
-- Immutable snapshots at session boundaries (implemented Phase 8)
checkpoints (
  id TEXT PRIMARY KEY,             -- UUID
  lane_id TEXT NOT NULL,           -- FK to lanes table
  session_id TEXT,                 -- FK to sessions table (which session triggered this)
  sha TEXT NOT NULL,               -- Git SHA at checkpoint time
  diff_stat_json TEXT,             -- JSON: { insertions, deletions, filesChanged, files[] }
  pack_event_ids_json TEXT,        -- JSON array of pack_event IDs associated with this checkpoint
  created_at TEXT NOT NULL         -- ISO 8601 timestamp
)

-- Append-only log of pack state changes (implemented Phase 8)
pack_events (
  id TEXT PRIMARY KEY,             -- UUID
  pack_key TEXT NOT NULL,          -- Which pack this event relates to
  event_type TEXT NOT NULL,        -- 'checkpoint' | 'narrative_update' | 'conflict_detected' | etc.
  payload_json TEXT,               -- Event-specific data as JSON
  created_at TEXT NOT NULL         -- ISO 8601 timestamp
)

-- Indexes for Phase 8 tables
CREATE INDEX idx_checkpoints_lane_id ON checkpoints(lane_id);
CREATE INDEX idx_checkpoints_created_at ON checkpoints(created_at);
CREATE INDEX idx_pack_events_pack_key ON pack_events(pack_key);
CREATE INDEX idx_pack_events_created_at ON pack_events(created_at);
```

### Type Definitions

```typescript
type OperationRecord = {
  id: string;
  laneId: string | null;
  laneName: string | null;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  preHeadSha: string | null;
  postHeadSha: string | null;
  metadataJson: string | null;
};

interface Checkpoint {
  id: string;
  laneId: string;
  sessionId: string | null;
  sha: string;
  diffStat: {
    insertions: number;
    deletions: number;
    filesChanged: number;
    files: string[];
  };
  packEventIds: string[];
  createdAt: string;
}

interface PackEvent {
  id: string;
  packKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface HistoryFilters {
  laneId?: string;
  kind?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  featureId?: string;
}

interface HistoryEntry {
  operation: OperationRecord;
  laneName: string | null;
  checkpoint: Checkpoint | null;  // Associated checkpoint, if any
}
```

---

## Implementation Tracking

### Core Timeline (Implemented)

| ID | Task | Status |
|----|------|--------|
| HIST-001 | Operation recording service (`operationService`) | DONE |
| HIST-002 | Git operations tracked with SHA transitions (pre/post HEAD) | DONE |
| HIST-003 | Pack refresh operations tracked | DONE |
| HIST-004 | History page 2-pane layout | DONE |
| HIST-005 | Operation timeline list (chronological, most recent first) | DONE |
| HIST-006 | Timeline filters (lane dropdown, kind filter, status filter) | DONE |
| HIST-007 | Operation detail panel (selected operation view) | DONE |
| HIST-008 | Status color coding (green/red/blue/gray) | DONE |
| HIST-009 | SHA transition display (pre-HEAD / post-HEAD) | DONE |
| HIST-010 | Metadata JSON display (expandable, syntax-highlighted) | DONE |

### Checkpoints & Snapshots

Backend data structures remain in place, but public browsing/IPC for them is still not shipped in the current branch.

| ID | Task | Status |
|----|------|--------|
| HIST-011 | Checkpoint creation on session end | Backend artifact exists — not exposed in current History UI |
| HIST-012 | Checkpoint storage and indexing (SQLite + filesystem) | Backend artifact exists — not exposed in current History UI |
| HIST-013 | Pack event logging (append-only event log) | Backend artifact exists — not exposed in current public IPC/UI |
| HIST-014 | Pack version tracking (version numbers, content hashes) | Backend artifact exists — still used by compatibility exports, not by History UI |

### Advanced Timeline Features

| ID | Task | Status |
|----|------|--------|
| HIST-015 | Feature history (filtered by feature/issue tag) | TODO |
| HIST-016 | Graph view (visual timeline with parallel lane tracks) | TODO |
| HIST-017 | Checkpoint browser (navigate to past repo state) | TODO |
| HIST-018 | Undo operation (reverse a git action via history) | TODO |
| HIST-019 | Replay operation sequence (dry-run re-execution) | TODO |
| HIST-020 | Plan version history (track planning document iterations) | TODO |

### Navigation & Export

| ID | Task | Status |
|----|------|--------|
| HIST-021 | Jump to lane from operation detail | DONE — Phase 7 (HistoryPage navigates to `/lanes?laneId=...` on click) |
| HIST-022 | Jump to session from operation detail | DONE — Phase 7 (HistoryPage navigates to lane with packs/inspector tab) |
| HIST-023 | Export history (CSV and JSON formats with filters) | TODO |

### Phase 8 — UI Enhancements

| ID | Task | Status |
|----|------|--------|
| HIST-024 | PaneTilingLayout for HistoryPage | DONE — Phase 8 (2-pane layout: timeline 45%, detail 55%) |
| HIST-025 | Human-readable operation descriptions (`describeOperation`) | DONE — Phase 8 (pack updates, git commits, and other operations get readable titles/detail lines) |
| HIST-026 | Status-colored left border on operation rows | DONE — Phase 8 (emerald/red/amber/gray border based on status) |
| HIST-027 | URL parameter support (`laneId`, `operationId`) | DONE — Phase 8 (deep linking to specific lane/operation) |
| HIST-028 | Auto-refresh for running operations | DONE — Phase 8, later hardened to 4s silent visibility-aware polling when any operation has `running` status |

---

*This document describes the History feature for ADE. The core operations timeline is implemented. Checkpoints, pack event logging, and pack version tracking still exist as backend compatibility data, but they are not currently exposed through a public `ade.packs.*` bridge or dedicated History UI browser. The History UI received PaneTilingLayout, human-readable descriptions, status-colored borders, URL parameter support, and auto-refresh in Phase 8, with later hardening for quieter silent refresh and visibility-aware polling. Advanced timeline features (graph view, undo, replay, export, checkpoint/event browsing) remain future work.*
