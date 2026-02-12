# Conflicts — Radar, Prediction & Resolution

> Last updated: 2026-02-11

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [User Experience](#user-experience)
  - [Lane Indicators](#lane-indicators)
  - [Conflicts Tab](#conflicts-tab)
  - [Conflict Workflow](#conflict-workflow)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Conflict Prediction Engine](#conflict-prediction-engine)
- [Data Model](#data-model)
  - [Database Tables](#database-tables)
  - [Type Definitions](#type-definitions)
- [Implementation Tracking](#implementation-tracking)

---

## Overview

The Conflicts feature surfaces integration risk early by predicting merge conflicts
before they happen. Rather than discovering conflicts at merge time — when the cost
of resolution is highest — ADE continuously monitors active lanes for overlapping
changes and provides proactive warnings, pairwise risk analysis, merge simulation,
and eventually hosted-agent-powered resolution proposals.

This feature transforms conflict management from a reactive, painful process into a
proactive, guided workflow. Developers can see at a glance which lanes are safe to
merge, which ones are drifting from the base branch, and which pairs of lanes are
on a collision course.

**Current status**: Core conflict prediction, risk matrix, merge simulation, and Conflicts tab UI are **implemented and working** (Phase 5, merged in `codex/ade-phase-4-5` branch). Resolution proposals via hosted agent are planned for Phase 6.

---

## Core Concepts

### Conflict Prediction

Dry-run merge simulation using `git merge-tree` or a temporary index to predict
whether two branches will conflict — without actually performing a merge. This runs
periodically in the background via the job engine and on-demand when the user
requests a simulation.

### Lane Conflict Status

Each lane carries a conflict status that summarizes its current integration health:

| Status | Color | Meaning |
|--------|-------|---------|
| `merge-ready` | Green | Clean merge to base; no overlaps with peer lanes |
| `behind-base` | Yellow | Base branch has advanced; lane needs rebase but no conflicts detected |
| `conflict-predicted` | Orange | Dry-merge predicts conflicts with base or a peer lane |
| `conflict-active` | Red | An attempted merge has produced actual conflicts requiring resolution |
| `unknown` | Gray | Prediction has not run yet or failed |

### Pairwise Risk Matrix

A grid showing conflict risk between every pair of active lanes. Each cell is
colored by risk level (none, low, medium, high) based on file overlap analysis
and dry-merge results. This gives a project-wide view of integration risk.

### Merge Simulation

An on-demand preview of what would happen if two lanes (or a lane and the base
branch) were merged. The simulation produces a detailed result: clean merge,
list of conflicting files, or a full diff of the merged state.

### Resolution Proposal

An LLM-generated suggested fix for a predicted or active conflict. The hosted
agent receives a Conflict Pack containing both sides of the conflict, the common
base state, and overlapping file contents, then produces a resolution diff with
a confidence score.

### Conflict Pack

A context bundle assembled for conflict resolution. Contains:

- Both sides of the conflict (lane A changes, lane B or base changes)
- Common ancestor state for each conflicting file
- Full list of overlapping files
- Commit history for the overlapping regions
- Lane pack summaries for both sides (developer intent context)

---

## User Experience

### Lane Indicators

Conflict status indicators appear directly in lane list rows on the Lanes tab,
providing at-a-glance integration health without leaving the main workflow.

**Status badges** (always visible on each lane row):

- **Green badge** — `merge-ready`: Safe to merge. No predicted conflicts.
- **Yellow badge** — `behind-base`: Base branch has moved ahead. Rebase recommended.
- **Orange badge** — `conflict-predicted`: Dry-merge found conflicts. Action needed.
- **Red badge** — `conflict-active`: Real conflicts exist. Resolution required.
- **Gray badge** — `unknown`: Status not yet computed.

**Realtime chips** (contextual, appear when relevant):

- **"new overlap"** — Just detected: a peer lane has started modifying files that
  this lane also touches. Appears briefly after detection, then fades to a
  persistent indicator.
- **"high risk"** — Multiple overlapping files detected with a peer lane, or
  overlapping files have high churn. Indicates elevated risk of conflict.

### Conflicts Tab

A dedicated tab providing the full conflict management interface.

**Layout (3-panel)**:

```
+-------------------+---------------------------+---------------------+
|                   |                           |                     |
|   Lane List       |   Conflict Summary /      |   Resolution        |
|   (left sidebar)  |   Risk Matrix             |   Proposals         |
|                   |   (center)                |   (right panel)     |
|                   |                           |                     |
+-------------------+---------------------------+---------------------+
```

**Left panel — Lane list with conflict status**:

- All active lanes displayed with their conflict status badges
- Sort by: risk level (highest first), lane name, last updated
- Click a lane to populate the center panel with its conflict summary
- Lane count badges: total lanes, lanes with conflicts, lanes merge-ready

**Center panel — Conflict summary** (for selected lane):

- **Overlapping files**: List of files modified in both this lane and base or
  peer lanes, with modification type (content change, rename, delete)
- **Coarse conflict type**: Content conflict, rename/rename, delete/modify,
  add/add — categorized per overlapping file
- **Base drift**: Number of commits base has advanced since branch point;
  files changed in base that overlap with lane changes
- **Peer overlaps**: Which other lanes touch the same files, with risk level
- **Last prediction**: Timestamp of most recent dry-merge run

**Center panel — Risk matrix** (toggle view):

- Pairwise grid of all active lanes
- Each cell colored by risk level:
  - **White/light gray**: No overlap
  - **Light green**: Minimal overlap, no predicted conflict
  - **Yellow**: File overlap detected, but dry-merge is clean
  - **Orange**: Dry-merge predicts conflicts
  - **Red**: Active conflicts
- Click a cell to see details of the overlap between those two lanes
- Diagonal cells show lane-to-base risk

**Merge simulation panel** (activated from summary or matrix):

- Select two lanes (or lane + base) to simulate merge
- Preview result:
  - **Clean merge**: File list of merged changes, combined diff stat
  - **Conflicts**: List of conflicting files with conflict markers preview
  - **Error**: Simulation could not complete (e.g., unrelated histories)
- Action buttons: "Open in diff viewer", "Generate resolution proposal"

**Right panel — Resolution proposals**:

- List of LLM-generated proposals for the selected conflict
- Each proposal shows:
  - Confidence score (0.0 to 1.0, displayed as percentage)
  - Source: "hosted agent" or "local heuristic"
  - Summary of the proposed resolution approach
  - Diff preview (collapsed by default, expandable)
- Actions per proposal:
  - **Preview**: Full diff view of the proposed resolution
  - **Apply**: Apply the resolution diff, creating an operation record
  - **Reject**: Mark as rejected (for feedback/training)

### Conflict Workflow

The typical workflow for managing conflicts in ADE:

1. **Prediction**: The job engine periodically runs dry-merge simulations between
   each active lane and the base branch, and optionally between pairs of lanes.
   Results are stored and lane statuses are updated.

2. **Detection**: When a prediction run finds new conflicts or overlaps, lane
   status indicators update in real time. Realtime chips ("new overlap",
   "high risk") appear on affected lane rows.

3. **Analysis**: The developer opens the Conflicts tab to examine details.
   The conflict summary shows which files overlap, what kind of conflicts
   are predicted, and which peer lanes are involved.

4. **Simulation**: For deeper investigation, the developer can simulate a merge
   between any two lanes (or lane and base) to see the exact outcome —
   including conflict markers for conflicting files.

5. **Resolution**: For active or predicted conflicts, the developer can request
   a resolution proposal from the hosted agent. The agent receives a Conflict
   Pack with full context and produces a resolution diff.

6. **Apply**: The developer previews the proposal diff, optionally edits it,
   and applies it. The application is recorded as an operation in the history
   timeline, enabling traceability.

7. **Undo**: If a resolution turns out to be incorrect, the developer can undo
   it via the operation timeline in the History tab, reverting to the
   pre-resolution state.

---

## Technical Implementation

### Services

| Service | Status | Responsibility |
|---------|--------|----------------|
| `conflictService` | **Exists, implemented** | Runs dry-merge simulations, stores prediction results, computes pairwise risk, manages proposals |
| `gitService` | Exists | Provides `git merge-tree` execution, temp index operations, diff computation |
| `jobEngine` | Exists | Triggers periodic conflict prediction jobs, manages job queue and deduplication |
| `operationService` | Exists | Records resolution applications as operations for history/undo |
| `packService` | Exists | Generates Conflict Packs for hosted agent consumption |

**Hosted agent integration** (planned):

- Job type: `ProposeConflictResolution`
- Input: Conflict Pack (both sides, base, overlapping files, lane context)
- Output: Resolution diff with confidence score and explanation
- Runs asynchronously; result stored as a `conflict_proposal` record

### IPC Channels

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.conflicts.getLaneStatus` | `(laneId: string) => ConflictStatus` | Get conflict status for a single lane |
| `ade.conflicts.listOverlaps` | `(laneId: string) => ConflictOverlap[]` | List file overlaps for a lane against base and peers |
| `ade.conflicts.getRiskMatrix` | `() => RiskMatrixEntry[]` | Get the full pairwise risk matrix for all active lanes |
| `ade.conflicts.simulateMerge` | `(args: { laneAId: string; laneBId?: string }) => MergeSimulationResult` | Simulate merge between two lanes or lane-to-base |
| `ade.conflicts.getProposals` | `(laneId: string) => ConflictProposal[]` | Get resolution proposals for a lane's conflicts |
| `ade.conflicts.applyProposal` | `(args: { proposalId: string; laneId: string }) => GitActionResult` | Apply a resolution proposal and record the operation |

### Conflict Prediction Engine

The prediction engine operates in two modes:

**Periodic mode** (background):

```
Job Engine tick →
  For each active lane:
    1. Run git merge-tree <base> <lane-HEAD>
    2. Parse result for conflicts
    3. Store prediction record
    4. Update lane conflict status
  For each pair of active lanes (optional, configurable):
    1. Run git merge-tree <lane-A-HEAD> <lane-B-HEAD>
    2. Store pairwise prediction
    3. Update risk matrix
```

**Realtime mode** (triggered on changes):

```
Stage/dirty change detected →
  1. Identify touched files
  2. Check if any peer lane touches the same files (fast path: file list comparison)
  3. If overlap detected: queue targeted dry-merge job for those pairs
  4. Update lane status and chips
```

---

## Data Model

### Database Tables

```sql
-- Stores results of dry-merge simulations between lanes or lane-to-base
conflict_predictions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  lane_a_id TEXT NOT NULL,
  lane_b_id TEXT,                  -- NULL if comparing lane_a to base branch
  status TEXT NOT NULL,            -- 'clean' | 'conflict' | 'unknown'
  conflicting_files_json TEXT,     -- JSON array of { path, conflictType }
  overlap_files_json TEXT,         -- JSON array of file paths touched by both sides
  lane_a_sha TEXT,                 -- HEAD of lane A at prediction time
  lane_b_sha TEXT,                 -- HEAD of lane B (or base) at prediction time
  predicted_at TEXT NOT NULL,      -- ISO 8601 timestamp
  expires_at TEXT                  -- When this prediction becomes stale
)

-- Stores LLM-generated or heuristic resolution proposals
conflict_proposals (
  id TEXT PRIMARY KEY,
  prediction_id TEXT NOT NULL,     -- FK to conflict_predictions
  source TEXT NOT NULL,            -- 'hosted' | 'local'
  confidence REAL,                 -- 0.0 to 1.0
  explanation TEXT,                -- Human-readable explanation of the approach
  diff_patch TEXT,                 -- The resolution as a unified diff patch
  status TEXT NOT NULL,            -- 'pending' | 'applied' | 'rejected'
  applied_operation_id TEXT,       -- FK to operations table (when applied)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### Type Definitions

```typescript
type ConflictStatusValue =
  | 'merge-ready'
  | 'behind-base'
  | 'conflict-predicted'
  | 'conflict-active'
  | 'unknown';

interface ConflictStatus {
  laneId: string;
  status: ConflictStatusValue;
  overlappingFileCount: number;
  peerConflictCount: number;
  lastPredictedAt: string | null;
}

interface ConflictOverlap {
  peerId: string | null;       // null = overlap with base
  peerName: string;
  files: Array<{
    path: string;
    conflictType: 'content' | 'rename' | 'delete' | 'add';
  }>;
  riskLevel: 'none' | 'low' | 'medium' | 'high';
}

interface RiskMatrixEntry {
  laneAId: string;
  laneBId: string;
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  overlapCount: number;
  hasConflict: boolean;
}

interface MergeSimulationResult {
  outcome: 'clean' | 'conflict' | 'error';
  mergedFiles: string[];
  conflictingFiles: Array<{
    path: string;
    conflictMarkers: string;    // Preview of conflict markers
  }>;
  diffStat: { insertions: number; deletions: number; filesChanged: number };
  error?: string;
}

interface ConflictProposal {
  id: string;
  predictionId: string;
  source: 'hosted' | 'local';
  confidence: number;
  explanation: string;
  diffPatch: string;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
}
```

---

## Implementation Tracking

Core prediction, UI, and simulation tasks are **DONE** (Phase 5, merged in `codex/ade-phase-4-5` branch, commit `65b7a6b`). Resolution proposals are deferred to Phase 6.

### What's Built

| Component | Details |
|-----------|---------|
| `conflictService.ts` | 1064 lines — full conflict prediction engine, pairwise risk computation, merge simulation, batch assessment |
| Conflict UI (6 components) | `ConflictsPage.tsx`, `ConflictFileDiff.tsx`, `RiskMatrix.tsx`, `RiskTooltip.tsx`, `extensionToLanguage.ts`, lane-level conflict badges |
| Job engine integration | Periodic prediction jobs via `processService`, configurable intervals |
| Database schema | `conflict_predictions` table with SHA tracking and expiry; `conflict_proposals` table ready for Phase 6 |
| Git merge-tree integration | Dry-merge via `git merge-tree` for zero-side-effect conflict detection |
| Phase 4/5 gap resolution | G3 (risk tooltip hover details), G4 (conflict file diff language detection), G5 (batch conflict assessment) — all resolved |

### Prediction Engine

| ID | Task | Status |
|----|------|--------|
| CONF-001 | Conflict prediction service (dry-merge engine) | DONE |
| CONF-002 | `git merge-tree` integration in gitService | DONE |
| CONF-003 | Lane conflict status computation and caching | DONE |
| CONF-014 | Periodic conflict prediction job (job engine integration) | DONE |
| CONF-015 | Realtime conflict pass (triggered on stage/dirty change) | DONE |

### Lane Indicators

| ID | Task | Status |
|----|------|--------|
| CONF-004 | Conflict status badges in lane rows (Lanes tab) | DONE |
| CONF-005 | Realtime conflict chips ("new overlap", "high risk") | DONE |

### Conflicts Tab UI

| ID | Task | Status |
|----|------|--------|
| CONF-006 | Conflicts tab page layout (3-panel) | DONE |
| CONF-007 | Lane list with conflict status (left panel) | DONE |
| CONF-008 | Conflict summary panel (overlapping files, types, base drift) | DONE |
| CONF-009 | Pairwise risk matrix view (toggle in center panel) | DONE |
| CONF-010 | Risk matrix color coding and cell interaction | DONE |
| CONF-013 | Conflict file diff viewer | DONE |

### Merge Simulation

| ID | Task | Status |
|----|------|--------|
| CONF-011 | Merge simulation service (backend) | DONE |
| CONF-012 | Merge simulation UI (select lanes, preview result) | DONE |

### Resolution Proposals

| ID | Task | Status |
|----|------|--------|
| CONF-016 | Conflict pack generation (context bundle for agent) | DONE (conflict pack generation is implemented; pack content is generated) |
| CONF-017 | Hosted agent proposal integration (ProposeConflictResolution job) | DONE — Phase 6 (`hostedAgentService.requestConflictProposal()`, `conflictService.requestProposal()`) |
| CONF-018 | Proposal diff preview in UI | DONE — Phase 6 (ConflictsPage right panel shows diff patch preview) |
| CONF-019 | Proposal apply with operation record | DONE — Phase 6 (`conflictService.applyProposal()` with `git apply --3way`, operation tracking) |
| CONF-020 | Proposal confidence scoring display | DONE — Phase 6 (confidence percentage shown in ConflictsPage proposal list) |
| CONF-021 | Proposal undo via operation timeline | DONE — Phase 6 (`conflictService.undoProposal()` with `git apply -R`, operation tracking) |

### Advanced Features

| ID | Task | Status |
|----|------|--------|
| CONF-022 | Stack-aware conflict resolution (resolve parent lane first) | TODO — **moved to Phase 7** (requires Phase 4 stacks + Phase 6 PRs) |
| CONF-023 | Batch conflict assessment (all-lanes report) | DONE (batch conflict assessment implemented) |
| CONF-024 | Conflict notification/alerts (in-app and system) | TODO — **moved to Phase 9** |

---

### Completion Notes

**Phase 5 (Conflict Detection) completed** as part of the `codex/ade-phase-4-5` branch merge. The core conflict engine (CONF-001 through CONF-016) and batch assessment (CONF-023) are fully operational.

**Phase 6 (Hosted Agent) completed**: CONF-017 through CONF-021 (LLM-powered resolution proposals) are fully implemented. The desktop hosted agent service submits `ProposeConflictResolution` jobs to the cloud, polls for results, and presents proposals in the Conflicts tab with diff preview, confidence scoring, apply (with operation record), and undo capabilities.

**Remaining tasks** are scheduled as follows:
- **Phase 7 (Workspace Graph)**: CONF-022 (stack-aware conflict resolution)
- **Phase 9 (Advanced Features)**: CONF-024 (conflict notifications)
