# Packs — Context, History & Narratives

> Last updated: 2026-02-11

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Checkpoint](#checkpoint)
  - [Pack Event](#pack-event)
  - [Pack Version](#pack-version)
  - [Pack Head](#pack-head)
  - [Pack Types](#pack-types)
- [User Experience](#user-experience)
  - [Pack Viewer](#pack-viewer)
  - [Pack Freshness Indicator](#pack-freshness-indicator)
  - [Pack Content Structure](#pack-content-structure)
  - [Update Pipeline](#update-pipeline)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Pack Generation Pipeline](#pack-generation-pipeline)
  - [Deterministic Content Generation](#deterministic-content-generation)
  - [Narrative Generation](#narrative-generation)
- [Data Model](#data-model)
  - [Current Tables](#current-tables)
  - [Future Tables](#future-tables)
  - [Filesystem Layout](#filesystem-layout)
  - [Type Definitions](#type-definitions)
- [Implementation Tracking](#implementation-tracking)

---

## Overview

Packs are ADE's comprehensive context and history system. They automatically capture
what happened during development sessions, generate structured summaries, and provide
rich context for multiple downstream features: conflict resolution, PR descriptions,
developer onboarding, and project status reporting.

The core insight behind packs is that development generates a wealth of contextual
information that is typically lost: which files were touched in what order, what
tests failed and were fixed, what the developer's intent was for a series of changes.
Packs capture this context in a structured, versioned format that can be consumed
by both humans and LLMs.

Packs operate at multiple scopes:

- **Project packs** provide a global view of project activity across all lanes.
- **Lane packs** capture per-lane execution context with session-level detail.
- **Feature packs** (future) aggregate context for a specific feature across lanes.
- **Conflict packs** (future) bundle resolution context for merge conflicts.
- **Plan packs** (future) version implementation planning documents.

Each pack contains two sections: a **deterministic section** with machine-generated
facts (file changes, diff stats, test results) and a **narrative section** with
human-readable summaries (initially template-based, eventually LLM-generated).

**Current status**: Core pack functionality (generation, storage, display, refresh)
is **implemented and working**. Advanced features (checkpoints, versioning, event
logging, LLM narratives) are planned but not yet built.

---

## Core Concepts

### Checkpoint

An immutable execution snapshot created at session boundaries (when a terminal
session ends). A checkpoint captures the repository state at a specific moment:

- **SHA**: The exact git commit hash at checkpoint time
- **Diff stat**: Lines added, deleted, files changed since the previous checkpoint
- **Touched files**: Complete list of files modified in this session
- **Failure lines**: Any test failures or error output captured from the session
- **Session reference**: Which terminal session triggered this checkpoint

Checkpoints are the atoms of pack history. Each lane pack is built from its
sequence of checkpoints, and navigating between checkpoints allows replaying
the development timeline.

**Status**: Planned, not yet implemented.

### Pack Event

An append-only log entry recording a change to pack state. Pack events provide
a granular audit trail of how packs evolved over time.

Event types:

| Event Type | Trigger | Payload |
|------------|---------|---------|
| `checkpoint` | Session end | `{ checkpointId, sha, diffStat }` |
| `narrative_update` | Pack refresh or manual edit | `{ previousHash, newHash, source }` |
| `conflict_detected` | Conflict prediction finds overlap | `{ peerLaneId, files }` |
| `refresh_triggered` | Manual or automatic refresh | `{ trigger, packType }` |
| `version_created` | Pack snapshot saved | `{ versionId, versionNumber }` |

**Status**: Planned, not yet implemented.

### Pack Version

An immutable rendered snapshot of a pack at a point in time. Pack versions are
saved as markdown files with a content hash, enabling:

- Diffing between versions to see what changed in the pack
- Rollback to a previous pack version
- Historical browsing of how context evolved

Each version has a monotonically increasing version number within its pack scope.

**Status**: Planned, not yet implemented.

### Pack Head

A mutable pointer to the latest pack version for a given scope. The head is
updated atomically when a new version is created. Reading the "current" pack
content means following the head pointer to the latest version.

This separation between immutable versions and mutable heads enables concurrent
access: readers always see a consistent snapshot, and writers create new versions
without disturbing readers.

**Status**: Planned, not yet implemented.

### Pack Types

| Type | Scope | Content | Status |
|------|-------|---------|--------|
| **Project Pack** | Entire project | High-level overview of all lanes, recent activity, project goals, aggregate stats | Implemented |
| **Lane Pack** | Single lane | Per-lane execution context — sessions, commits, file changes, test results, narrative | Implemented |
| **Feature Pack** | Feature/issue | All work related to a specific feature across lanes. Aggregates lane packs by feature tag. | Planned |
| **Conflict Pack** | Merge conflict | Both sides of a conflict, base state, overlapping files, resolution proposals. Context for conflict resolution. | Planned |
| **Plan Pack** | Implementation plan | Versioned planning document. Tracks iterations of scope, approach, and task breakdown. | Planned |

---

## User Experience

### Pack Viewer

Accessible from the Lanes tab as a "Packs" sub-tab, the Pack Viewer displays
pack content with interactive features.

**Layout**:

```
+---------------------------------------------------+
|  Pack Viewer                          [Refresh ↻]  |
+-------------------------+-------------------------+
|                         |                         |
|  Project Pack           |  Lane Pack              |
|                         |  (for selected lane)    |
|  ## Project Overview    |                         |
|  Active lanes: 3        |  ## Lane: feature/auth  |
|  Recent activity: ...   |  Branch: feature/auth   |
|                         |  Sessions: 4            |
|  ## Lane Summary        |                         |
|  - feature/auth (3c)    |  ## Changes             |
|  - feature/ui (1c)      |  +42 / -12, 8 files    |
|  - bugfix/login (2c)    |                         |
|                         |  ## Narrative            |
|                         |  Implemented the auth... |
|                         |                         |
+-------------------------+-------------------------+
|  Freshness: ● Up to date    Last refresh: 2m ago  |
+---------------------------------------------------+
```

**Features**:

- **Side-by-side view**: Project pack on the left, lane pack on the right
- **Rendered markdown**: Pack content displayed as formatted markdown with
  syntax highlighting for code blocks
- **Refresh button**: Manually trigger pack regeneration for the current lane
  (and project pack if stale)
- **Freshness indicator**: Badge showing how current the pack is (see below)
- **Edit button** (future): Edit the narrative section to override auto-generated
  content

### Pack Freshness Indicator

Displayed in both the Pack Viewer and the Lane Inspector, the freshness indicator
shows how current a pack is relative to the latest HEAD:

| Color | Meaning | Condition |
|-------|---------|-----------|
| **Green** | Up to date | Pack's `lastHeadSha` matches the current lane HEAD |
| **Yellow** | Slightly stale | Pack is 1-2 commits behind current HEAD |
| **Red** | Significantly stale | Pack is 3+ commits behind, or has never been generated |

The indicator includes a tooltip showing the exact state: "Pack at abc1234,
HEAD at def5678 (3 commits behind)".

### Pack Content Structure

Each pack markdown file follows a consistent structure with two main sections. The balance between deterministic and LLM-generated content is intentional:

**Content ratio by pack type**:

| Pack Type | Deterministic (machine-generated) | Narrative (LLM-generated) | Notes |
|-----------|----------------------------------|--------------------------|-------|
| **Project Pack** | ~40% — repo structure, technology stack, active lanes, aggregate stats | ~60% — architecture overview, conventions summary, project goals, cross-lane risk narrative | The Project Pack is the closest analog to a PRD — it provides the high-level "what is this project" context. When seeded from existing docs, the narrative section may be much richer. |
| **Lane Pack** | ~70% — diff stats, file list, commit log, session summaries, test results, failure lines | ~30% — intent summary, key decisions, patterns, open questions | Lane Packs are primarily factual with a narrative overlay for human/LLM readability. |
| **Feature Pack** | ~50% — aggregated diffs across lanes, commit history, test results | ~50% — feature narrative, progress summary, cross-lane coordination notes | Feature Packs synthesize multiple lanes into a coherent feature story. |
| **Conflict Pack** | ~80% — conflicting file lists, diff hunks, base state, merge-tree output | ~20% — root cause analysis, resolution strategy suggestion | Conflict Packs are heavily data-driven with minimal narrative. |
| **Plan Pack** | ~20% — version history, linked task IDs, referenced file paths | ~80% — planning prose, rationale, approach decisions, handoff prompts | Plan Packs are primarily narrative documents with versioning metadata. |

**Without an LLM provider (Guest Mode)**: All packs still generate, but the narrative sections use template-based text instead of LLM prose. The deterministic sections are identical regardless of provider. This means packs are always useful for diff stats, file tracking, and session history — the LLM layer adds qualitative intelligence on top.

**Project Pack structure** (resembles a living PRD):

**Deterministic section** (auto-generated from git and session data):

```markdown
## Changes
- Files changed: 8
- Insertions: +142
- Deletions: -37

### Modified Files
- src/auth/login.ts (+45 / -12)
- src/auth/session.ts (+33 / -8)
- src/auth/types.ts (+15 / -0)
- ...

### Sessions
- Session 1: 45 commands, exit code 0
- Session 2: 23 commands, exit code 0

### Failure Lines
(none captured)
```

**Narrative section** (template-based, later LLM-generated):

```markdown
## Narrative
Implemented authentication flow with login endpoint, session management,
and type definitions. All sessions completed successfully with no test
failures. Key changes focused on the auth module with new login and
session handling logic.
```

### Update Pipeline

Pack updates follow an automated pipeline triggered by session lifecycle events:

```
Session End
  │
  ▼
Checkpoint Created (future)
  │
  ▼
Lane Pack Refreshed
  │  - Deterministic section regenerated from git diff/log
  │  - Narrative section updated (template or LLM)
  │  - Pack index updated in SQLite
  │
  ▼
Project Pack Refreshed (if stale)
  │  - Aggregates data from all lane packs
  │  - Updates project-level overview
  │
  ▼
Conflict Prediction Triggered (future)
  │  - Uses updated pack data for context
  │
  ▼
Hosted Mirror Synced (if enabled, future)
    - Pack content pushed to cloud for hosted agent access
```

The pipeline is orchestrated by the job engine, which ensures:

- **Deduplication**: Multiple rapid session ends for the same lane produce only
  one pack refresh job
- **Ordering**: Lane pack refreshes complete before project pack refresh starts
- **Error isolation**: A failed pack refresh does not block other pipeline steps

### Initial Pack Generation (Onboarding)

When a user adds an existing git project to ADE, packs need to be bootstrapped from scratch. The initial pack generation process:

**Project Pack bootstrap**:
1. **Codebase scan**: Analyze `package.json`, `Cargo.toml`, `go.mod`, directory structure, README, and other indicator files to identify the technology stack, project structure, and conventions.
2. **Git history analysis**: Read recent commit messages (last 100 commits) to understand development patterns, active areas, and contributor activity.
3. **Documentation import** (optional): If the user points ADE to existing documentation (PRDs, architecture docs, design specs), the LLM ingests these to produce a richer, more accurate Project Pack narrative that reflects the actual project intent rather than just code analysis.
4. **Pack materialization**: Combine the deterministic scan data with LLM narrative (or templates in Guest Mode) into the initial `project-<id>.md` file.

**Lane Pack bootstrap for existing branches**:
1. ADE scans for existing branches and worktrees.
2. For each branch the user selects, ADE creates a lane and generates an initial Lane Pack by computing the diff against the base branch, analyzing the commit log, and generating a narrative.
3. If sessions already exist (from a previous ADE installation), their deltas are incorporated.

**Trigger**: Initial pack generation runs during onboarding (Step 5.5) or can be triggered manually from Settings → Data Management → "Generate Initial Packs".

---

## Technical Implementation

### Services

| Service | Status | Responsibility |
|---------|--------|----------------|
| `packService` | **Exists, implemented** | Generates deterministic pack content (diff stats, file lists). Reads/writes pack markdown files to `.ade/packs/`. Manages pack index in SQLite. |
| `jobEngine` | **Exists, implemented** | Queues pack refresh jobs, deduplicates by lane, manages execution order. |
| `sessionService` | Exists | Provides session delta data (commands, exit codes, failure lines) for pack generation. |
| `gitService` | Exists | Provides git diff stats, commit history, and file change information for deterministic sections. |
| `operationService` | Exists | Records pack refresh operations in the history timeline. |

### IPC Channels

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.packs.getProjectPack` | `() => PackSummary` | Get the current project pack content and metadata |
| `ade.packs.getLanePack` | `(laneId: string) => PackSummary` | Get the current lane pack content and metadata |
| `ade.packs.refreshLanePack` | `(laneId: string) => PackSummary` | Manually trigger a lane pack refresh and return the updated pack |

**Planned (future)**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.packs.listVersions` | `(packKey: string) => PackVersionSummary[]` | List all versions of a pack |
| `ade.packs.getVersion` | `(versionId: string) => PackVersion` | Get a specific pack version |
| `ade.packs.diffVersions` | `(args: { fromId: string; toId: string }) => string` | Diff two pack versions |
| `ade.packs.updateNarrative` | `(args: { packKey: string; narrative: string }) => PackSummary` | Manually edit the narrative section |
| `ade.packs.listEvents` | `(args: { packKey: string; limit: number }) => PackEvent[]` | List pack events for audit trail |

### Pack Generation Pipeline

The pack generation process for a lane pack:

```
refreshLanePack(laneId):
  1. Get lane metadata (branch name, parent lane, etc.)
  2. Get git diff stats:
     a. diffStat = git diff --stat <branchPoint>..HEAD
     b. fileList = git diff --name-only <branchPoint>..HEAD
     c. commitLog = git log --oneline <branchPoint>..HEAD
  3. Get session data:
     a. sessions = sessionService.getSessionsForLane(laneId)
     b. For each session: command count, exit code, failure lines
  4. Generate deterministic section:
     a. Format diff stats as markdown
     b. Format file list with per-file stats
     c. Format session summaries
     d. Format failure lines (if any)
  5. Generate narrative section:
     a. Current: Template-based ("Modified N files in M sessions...")
     b. Future: LLM-generated from deterministic data + commit messages
  6. Combine sections into pack markdown
  7. Write to .ade/packs/lane-<laneId>.md
  8. Update packs_index in SQLite
  9. Record pack.refresh operation in history
  10. Return PackSummary
```

### Deterministic Content Generation

The deterministic section is generated entirely from git and session data, with
no LLM involvement. This ensures it is always accurate and reproducible.

**Sources**:

| Data | Source | Command/Query |
|------|--------|---------------|
| Diff stat | gitService | `git diff --stat <branchPoint>..HEAD` |
| File list | gitService | `git diff --name-only <branchPoint>..HEAD` |
| Per-file stats | gitService | `git diff --numstat <branchPoint>..HEAD` |
| Commit log | gitService | `git log --oneline <branchPoint>..HEAD` |
| Session data | sessionService | SQLite query on sessions table |
| Failure lines | sessionService | Parsed from session transcript |

### Narrative Generation

**Current implementation** (template-based):

The narrative section uses string templates populated with data from the
deterministic section:

```
"Modified {fileCount} files across {sessionCount} sessions.
{insertions} lines added, {deletions} lines removed.
Key changes in: {topFiles.join(', ')}."
```

**Future implementation** (LLM-powered):

The hosted agent receives the deterministic section plus commit messages and
generates a human-quality narrative. The narrative includes:

- High-level summary of what was accomplished
- Key decisions and their rationale (inferred from commit messages)
- Notable patterns (e.g., "iterative test-fix cycle on auth module")
- Open questions or incomplete work (inferred from TODOs, partial implementations)

The LLM narrative is always paired with the deterministic section, so readers
can verify claims against the raw data.

---

## Data Model

### Current Tables

```sql
-- Index of all packs, tracking metadata and freshness
packs_index (
  pack_key TEXT PRIMARY KEY,       -- Unique key: 'project-<id>' or 'lane-<id>'
  project_id TEXT NOT NULL,        -- FK to projects table
  lane_id TEXT,                    -- FK to lanes table (NULL for project packs)
  pack_type TEXT NOT NULL,         -- 'project' | 'lane'
  pack_path TEXT NOT NULL,         -- Filesystem path to the pack markdown file
  deterministic_updated_at TEXT,   -- When the deterministic section was last regenerated
  narrative_updated_at TEXT,       -- When the narrative section was last updated
  last_head_sha TEXT               -- Git HEAD SHA at the time of last pack generation
)
```

### Future Tables

```sql
-- Immutable snapshots at session boundaries
checkpoints (
  id TEXT PRIMARY KEY,             -- UUID
  lane_id TEXT NOT NULL,           -- FK to lanes table
  session_id TEXT,                 -- FK to sessions table
  sha TEXT NOT NULL,               -- Git SHA at checkpoint time
  diff_stat_json TEXT,             -- JSON: { insertions, deletions, filesChanged, files[] }
  pack_event_ids_json TEXT,        -- JSON array of associated pack_event IDs
  created_at TEXT NOT NULL         -- ISO 8601 timestamp
)

-- Append-only log of pack state changes
pack_events (
  id TEXT PRIMARY KEY,             -- UUID
  pack_key TEXT NOT NULL,          -- FK to packs_index
  event_type TEXT NOT NULL,        -- 'checkpoint' | 'narrative_update' | 'conflict_detected' | etc.
  payload_json TEXT,               -- Event-specific data as JSON
  created_at TEXT NOT NULL         -- ISO 8601 timestamp
)

-- Immutable rendered snapshots of pack content
pack_versions (
  id TEXT PRIMARY KEY,             -- UUID
  pack_key TEXT NOT NULL,          -- FK to packs_index
  version_number INTEGER NOT NULL, -- Monotonically increasing within pack scope
  content_hash TEXT NOT NULL,      -- SHA-256 of the rendered markdown content
  rendered_path TEXT NOT NULL,     -- Filesystem path to the version file
  created_at TEXT NOT NULL         -- ISO 8601 timestamp
)

-- Mutable pointer to the latest version for each pack
pack_heads (
  pack_key TEXT PRIMARY KEY,       -- FK to packs_index / pack_versions
  current_version_id TEXT NOT NULL,-- FK to pack_versions
  updated_at TEXT NOT NULL         -- ISO 8601 timestamp
)

-- Indexes
CREATE INDEX idx_checkpoints_lane_id ON checkpoints(lane_id);
CREATE INDEX idx_checkpoints_created_at ON checkpoints(created_at);
CREATE INDEX idx_pack_events_pack_key ON pack_events(pack_key);
CREATE INDEX idx_pack_events_created_at ON pack_events(created_at);
CREATE INDEX idx_pack_versions_pack_key ON pack_versions(pack_key);
CREATE UNIQUE INDEX idx_pack_versions_key_number ON pack_versions(pack_key, version_number);
```

### Filesystem Layout

```
.ade/packs/
├── project-<projectId>.md           # Current project pack (rendered markdown)
├── lane-<laneId>.md                 # Current lane pack for each active lane
├── versions/                        # Immutable pack version snapshots (future)
│   ├── <versionId>.md               # Each version stored by UUID
│   └── ...
├── heads/                           # Head pointer files (future)
│   ├── project-<projectId>.json     # { currentVersionId, updatedAt }
│   └── lane-<laneId>.json
└── current/                         # Symlinks to current versions (future)
    ├── project-<projectId>.md → ../versions/<versionId>.md
    └── lane-<laneId>.md → ../versions/<versionId>.md

.ade/history/
├── checkpoints/                     # Checkpoint data files (future)
│   ├── <checkpointId>.json          # { sha, diffStat, packEventIds, ... }
│   └── ...
└── events/                          # Pack event log files (future)
    ├── <year-month>/                # Partitioned by month for manageability
    │   ├── <eventId>.json
    │   └── ...
    └── ...
```

### Type Definitions

```typescript
interface PackSummary {
  type: 'project' | 'lane';
  path: string;                      // Filesystem path to the pack file
  exists: boolean;                   // Whether the pack file exists on disk
  deterministicUpdatedAt: string | null;  // ISO 8601
  narrativeUpdatedAt: string | null;      // ISO 8601
  lastHeadSha: string | null;       // Git SHA at last generation
  body: string;                      // Full markdown content of the pack
}

interface PackVersionSummary {
  id: string;
  packKey: string;
  versionNumber: number;
  contentHash: string;
  createdAt: string;
}

interface PackVersion {
  id: string;
  packKey: string;
  versionNumber: number;
  contentHash: string;
  renderedPath: string;
  body: string;                      // Full markdown content of this version
  createdAt: string;
}

interface PackEvent {
  id: string;
  packKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

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

interface PackFreshness {
  status: 'current' | 'slightly-stale' | 'stale';
  packSha: string | null;
  headSha: string;
  commitsBehind: number;
}

interface PackRefreshJob {
  id: string;
  packKey: string;
  laneId: string;
  trigger: 'session-end' | 'manual' | 'scheduled';
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt: string | null;
}
```

---

## Implementation Tracking

### Core Pack System (Implemented)

| ID | Task | Status |
|----|------|--------|
| PACK-001 | Pack service — deterministic content generation (diff stats, file lists) | DONE |
| PACK-002 | Session delta computation for packs (command counts, exit codes) | DONE |
| PACK-003 | Lane pack markdown generation (deterministic + template narrative) | DONE |
| PACK-004 | Project pack markdown generation (aggregate of all lanes) | DONE |
| PACK-005 | Pack index in SQLite (`packs_index` table) | DONE |
| PACK-006 | Pack files on filesystem (`.ade/packs/` directory) | DONE |
| PACK-007 | Job engine triggers pack refresh on session end | DONE |
| PACK-008 | Job deduplication for pack refreshes (one refresh per lane) | DONE |
| PACK-009 | Pack viewer component (side-by-side project + lane packs) | DONE |
| PACK-010 | Pack freshness indicator (green/yellow/red badge) | DONE |
| PACK-011 | Manual pack refresh button | DONE |

### Checkpoints & Event Logging

| ID | Task | Status |
|----|------|--------|
| PACK-012 | Checkpoint creation at session boundaries | TODO |
| PACK-013 | Checkpoint storage and indexing (SQLite + filesystem) | TODO |
| PACK-014 | Pack event logging (append-only event log) | TODO |

### Versioning System

| ID | Task | Status |
|----|------|--------|
| PACK-015 | Pack version snapshots (immutable rendered files) | TODO |
| PACK-016 | Pack head pointers (mutable, atomic updates) | TODO |
| PACK-022 | Pack diff (compare two versions side by side) | TODO |

### Additional Pack Types

| ID | Task | Status |
|----|------|--------|
| PACK-017 | Feature pack type (issue-scoped, cross-lane aggregation) | TODO |
| PACK-018 | Conflict pack type (resolution context bundle) | TODO |
| PACK-019 | Plan pack type (versioned planning documents) | TODO |

### Narrative & Intelligence

| ID | Task | Status |
|----|------|--------|
| PACK-020 | Narrative editing (user override of auto-generated content) | TODO |
| PACK-021 | LLM-powered narrative generation (hosted agent integration) | TODO |

### Operations & Management

| ID | Task | Status |
|----|------|--------|
| PACK-023 | Pack sync to hosted mirror (cloud storage for agent access) | TODO |
| PACK-024 | Pack retention and cleanup policy (age-based, count-based) | TODO |
| PACK-025 | Pack privacy controls (redaction rules for sensitive content) | TODO |
| PACK-026 | Pack export (standalone markdown file with all context) | TODO |

### Initial Pack Generation

| ID | Task | Status |
|----|------|--------|
| PACK-027 | Initial project pack bootstrap (codebase scan + git history analysis) | TODO |
| PACK-028 | Documentation-seeded pack generation (import existing docs for richer Project Pack) | TODO |
| PACK-029 | Existing lane pack hydration (generate Lane Packs for pre-existing branches) | TODO |
| PACK-030 | Guest mode template narratives (template-based fallback when no LLM provider) | DONE |
