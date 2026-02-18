# Packs — Context, History & Narratives

> Last updated: 2026-02-16

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
  - [Bounded Export System](#bounded-export-system)
  - [Pack Retention & Cleanup](#pack-retention--cleanup)
  - [Orchestrator Delta Consumption](#orchestrator-delta-consumption)
  - [Auto-Narrative Pipeline](#auto-narrative-pipeline)

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
- **Feature packs** aggregate context for a specific feature tag across lanes.
- **Conflict packs** bundle overlap + merge-tree context for a lane vs base or a lane vs peer.
- **Plan packs** store versioned planning documents per lane.

Each pack contains two sections: a **deterministic section** with machine-generated
facts (file changes, diff stats, test results) and a **narrative section** with
human-readable summaries (initially template-based, eventually LLM-generated).

**Current status**: Core pack functionality (generation, storage, display, refresh)
is **implemented and working**. LLM-powered narratives, pack sync to hosted mirror,
and pack privacy controls (redaction) are **implemented** (Phase 6). Packs V2 features
(checkpoints, versioning, event logging) are **implemented** (Phase 8). Pack retention
and cleanup policy is **implemented** (Phase 7/8).

**Contract**: For stable, orchestrator-friendly context artifacts (markers, headers, exports, deltas), see:
- `docs/architecture/CONTEXT_CONTRACT.md`

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

**Status**: Implemented. Checkpoints are created at session boundaries and indexed for browsing.

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

**Status**: Implemented. Pack events are append-only, stored in SQLite, and surfaced as a human-readable activity feed in the UI.

Event payloads may additionally include standardized selection metadata (backward compatible; consumers must be null-safe):

- `importance`: `low` | `medium` | `high`
- `importanceScore`: numeric (0-1)
- `category`: `session` | `narrative` | `conflict` | `branch` | `pack`
- `entityIds`: string[]
- `entityRefs`: `{ kind, id }`[]
- `actionType`: string
- `rationale`: string | null

### Pack Version

An immutable rendered snapshot of a pack at a point in time. Pack versions are
saved as markdown files with a content hash, enabling:

- Diffing between versions to see what changed in the pack
- Rollback to a previous pack version
- Historical browsing of how context evolved

Each version has a monotonically increasing version number within its pack scope.

**Status**: Implemented. Versions are immutable snapshots with content hashes and a built-in diff viewer.

### Pack Head

A mutable pointer to the latest pack version for a given scope. The head is
updated atomically when a new version is created. Reading the "current" pack
content means following the head pointer to the latest version.

This separation between immutable versions and mutable heads enables concurrent
access: readers always see a consistent snapshot, and writers create new versions
without disturbing readers.

**Status**: Implemented via `packs_index` + version pointers. The UI reads the current pack and can diff prior versions.

### Pack Types

| Type | Scope | Content | Status |
|------|-------|---------|--------|
| **Project Pack** | Entire project | High-level overview of all lanes, recent activity, project goals, aggregate stats | Implemented |
| **Lane Pack** | Single lane | Per-lane execution context — sessions, commits, file changes, test results, narrative | Implemented |
| **Feature Pack** | Feature/issue | All work related to a specific feature across lanes. Aggregates lane packs by feature tag. | Implemented |
| **Conflict Pack** | Merge conflict | Lane-vs-base or lane-vs-peer overlap context (merge-tree output + file overlaps) used for proposals. | Implemented |
| **Plan Pack** | Implementation plan | Versioned planning document per lane. | Implemented |

---

## User Experience

### Pack Viewer

Accessible from the Lanes tab as a "Packs" sub-tab, the Pack Viewer displays
pack content with interactive features.

**Layout** (lane inspector):

```
+---------------------------------------------------+
|  Pack Viewer   [Lane|Project]  [Refresh] [AI...]   |
+---------------------------------------------------+
|                                                   |
|  (Selected pack body as readable markdown text)    |
|                                                   |
+---------------------------------------------------+
|  Freshness: ● Up to date    Last refresh: 2m ago  |
+---------------------------------------------------+
```

**Features**:

- **Two clear pack scopes**: A toggle switches between the Project pack and the selected Lane pack.
- **Refresh button**: Triggers deterministic pack regeneration (always available).
- **AI details button**: Re-runs AI pack details on demand (lane pack only). AI details also refresh automatically in the background after deterministic refresh when Hosted/BYOK is enabled.
- **Activity feed**: Human-readable pack events (refreshes, AI updates, failures) with deep links into the History tab.
- **Versions + diff**: Immutable snapshots with a built-in diff viewer.

---

## Hosted Context Delivery (What the Cloud Jobs Actually Consume)

Hosted jobs (narratives, conflict proposals, PR drafts) consume **bounded exports** (for example `LaneExportStandard`) by default.

There are two delivery modes:

1. **Inline**: the export(s) are embedded directly in the job payload `params` (works without mirror sync).
2. **Mirror-ref**: for large/conflict jobs or when configured, ADE uploads the canonical JSON `params` as a content-addressed blob and submits a small `__adeContextRef` plus a reduced `__adeContextInline` fallback.

This is intentionally deterministic and observable:

- Pack events like `narrative_requested` record the delivery mode and reason code.
- Settings exposes the hosted context delivery mode (Auto/Inline/Mirror Preferred).

### Expected Behavior Matrix

| Scenario | Mirror Sync | Hosted Job Context | Notes |
|----------|------------|-------------------|------|
| New lane with active session | optional | inline bounded export | Works even if mirror is disabled |
| Stale mirror (no recent sync) | stale | inline bounded export | Jobs do not silently depend on mirror freshness |
| Mirror disabled / no remoteProjectId | no | inline bounded export | Hosted jobs do not depend on mirror |
| Conflict-heavy lane | optional | mirror-ref preferred (auto) | Inline fallback is reduced to keep payload compact |
| Mirror-ref fetch fails (rare) | any | inline fallback | Worker emits `job.context_ref_failed` and proceeds with reduced fallback |
| Periodic handoff via delta | optional | delta digest + bounded export | Deltas remain compact/deterministic |

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

**Lane Pack structure** (review-focused handoff document):

```markdown
```json
{
  "schema": "ade.context.v1",
  "packKey": "lane:lane-123",
  "packType": "lane",
  "laneId": "lane-123",
  "baseRef": "main",
  "headSha": "abc12345",
  "deterministicUpdatedAt": "2026-02-14T12:00:00Z",
  "narrativeUpdatedAt": null,
  "providerMode": "hosted"
}
```

# Lane: feature-auth
> Branch: `feature/auth` | Base: `main` | HEAD: `abc12345` | clean · ahead 2 · behind 0

## What Changed
- Modified authentication middleware (src/auth/).
- Added rate limiting to API routes (src/api/routes/).

## Why
<!-- ADE_INTENT_START -->
Intent not set — click to add.
<!-- ADE_INTENT_END -->

Inferred from commits:
- Add rate limiting to API routes
- Fix flaky auth tests

## Task Spec
<!-- ADE_TASK_SPEC_START -->
- Problem: (what is broken / missing?)
- Scope: (what is in / out)
- Acceptance:
  - [ ] (checklist)
- Constraints: (conventions, APIs, patterns)
- Dependencies: (parent lane, merges required)
<!-- ADE_TASK_SPEC_END -->

## Validation
- Tests: PASS (2 suites, 31 tests, 1.2s) · command: `npm test`
- Lint: NOT RUN

## Key Files (10 files touched)
| File | Change |
|------|--------|
| `src/auth/middleware.ts` | +45/-12 |

## Errors & Issues
No errors detected.

## Sessions (4 total, 1 running)
| When | Tool | Goal | Result | Delta |
|------|------|------|--------|-------|
| 14:32 | shell | "run tests" | exit 0 | +45/-12 |

## Open Questions / Next Steps
- 2 tests failing in auth suite — investigate before merge
<!-- ADE_TODOS_START -->
- (add notes/todos here)
<!-- ADE_TODOS_END -->

## Narrative
<!-- ADE_NARRATIVE_START -->
AI narrative not yet generated.
<!-- ADE_NARRATIVE_END -->

---
*Updated: 2026-02-14T12:00:00Z | Trigger: session_end | Provider: hosted | [View history →](ade://packs/versions/lane:... )*
```

Notes:
- The `ADE_INTENT_*`, `ADE_TASK_SPEC_*`, `ADE_TODOS_*`, and `ADE_NARRATIVE_*` markers are preserved so users (and orchestrators) can edit intent/task spec/todos/narrative without ADE losing those sections on deterministic refresh.
- Any transcript-derived lines (errors, session output previews) are ANSI-stripped and de-duplicated before inclusion.
- The Sessions section includes "Recent summaries" when `sessionHighlights` are available. Each highlight includes `summarySource` (explicit_final_block or heuristic_tail), `summaryConfidence` (high or medium), and optional `summaryOmissionTags` for clipped extractions.
- The lane pack header JSON fence includes `graph` (dependency graph envelope), `dependencyState` (dependency freshness), and `conflictState` (conflict prediction state) when available.

### Update Pipeline

Pack updates follow an automated pipeline triggered by session lifecycle events:

```
Session End
  │
  ▼
Checkpoint Created
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
Conflict Prediction Triggered
  │  - Uses updated pack data for context
  │
  ▼
Hosted Mirror Synced (if enabled)
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
| `packService` | **Exists, implemented** | Generates deterministic pack content (diff stats, file lists). Reads/writes pack markdown files to `.ade/packs/`. Manages pack index in SQLite. Provides bounded exports via `getLaneExport`, `getProjectExport`, `getConflictExport`. |
| `packExports` | **Exists, implemented** | Token-budgeted export engine. Builds Lite/Standard/Deep exports for lanes, projects, and conflicts. Enforces token budgets (~4 chars/token heuristic), extracts marker-based sections, and includes conflict risk summaries. See `docs/architecture/CONTEXT_CONTRACT.md`. |
| `packSections` | **Exists, implemented** | Stable marker-based section manipulation. Functions: `extractBetweenMarkers`, `replaceBetweenMarkers`, `upsertSectionByHeading`. Enables non-truncating narrative updates and backward-compatible legacy pack upgrades. |
| `lanePackTemplate` | **Exists, implemented** | Renders deterministic lane pack markdown from raw data. Produces structured markdown with machine-readable header, all marker-bounded sections (intent, task spec, todos, narrative), sessions table with session highlights (summarySource, summaryConfidence, omission tags), validation, errors, key files, and audit footer. |
| `transcriptInsights` | **Exists, implemented** | Parses high-signal terminal output for structured summaries. Returns `summarySource` (`explicit_final_block` or `heuristic_tail`), `summaryConfidence` (`high` or `medium`), and deterministic omission tags for clipped extractions. |
| `redaction` | **Exists, implemented** | Secret redaction for exports. `redactSecrets()` strips API keys, tokens, private keys, GitHub PATs. `redactSecretsDeep()` recursively scans complex objects. Applied to all outbound AI payloads. |
| `jobEngine` | **Exists, implemented** | Queues pack refresh jobs, deduplicates by lane, manages execution order. After deterministic refresh, automatically generates AI narratives when Hosted/BYOK is configured. |
| `sessionService` | Exists | Provides session delta data (commands, exit codes, failure lines) for pack generation. |
| `gitService` | Exists | Provides git diff stats, commit history, and file change information for deterministic sections. |
| `operationService` | Exists | Records pack refresh operations in the history timeline. |

### IPC Channels

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.packs.getProjectPack` | `() => PackSummary` | Get the current project pack content and metadata |
| `ade.packs.getLanePack` | `(laneId: string) => PackSummary` | Get the current lane pack content and metadata |
| `ade.packs.getFeaturePack` | `(featureKey: string) => PackSummary` | Get a feature pack |
| `ade.packs.getConflictPack` | `(args: { laneId: string; peerLaneId?: string \| null }) => PackSummary` | Get a conflict pack (v2 markdown) |
| `ade.packs.getPlanPack` | `(laneId: string) => PackSummary` | Get a plan pack |
| `ade.packs.getProjectExport` | `(args: { level: "lite" \| "standard" \| "deep" }) => PackExport` | Build a bounded project export |
| `ade.packs.getLaneExport` | `(args: { laneId: string; level: "lite" \| "standard" \| "deep" }) => PackExport` | Build a bounded lane export |
| `ade.packs.getConflictExport` | `(args: { laneId: string; peerLaneId?: string \| null; level: "lite" \| "standard" \| "deep" }) => PackExport` | Build a bounded conflict export |
| `ade.packs.refreshLanePack` | `(laneId: string) => PackSummary` | Refresh deterministic lane pack content |
| `ade.packs.refreshProjectPack` | `(args: { laneId?: string \| null }) => PackSummary` | Refresh deterministic project pack content |
| `ade.packs.refreshFeaturePack` | `(featureKey: string) => PackSummary` | Refresh a feature pack |
| `ade.packs.refreshConflictPack` | `(args: { laneId: string; peerLaneId?: string \| null }) => PackSummary` | Refresh a conflict pack |
| `ade.packs.savePlanPack` | `(args: { laneId: string; body: string }) => PackSummary` | Save/update a plan pack |
| `ade.packs.generateNarrative` | `(laneId: string) => PackSummary` | Request an AI narrative update (Hosted/BYOK) |
| `ade.packs.applyHostedNarrative` | `(args: { laneId: string; narrative: string; jobId?: string }) => PackSummary` | Apply an AI narrative result to a lane pack |
| `ade.packs.updateNarrative` | `(args: { packKey: string; narrative: string }) => PackSummary` | Manual narrative edit (marker-based) |
| `ade.packs.listVersions` | `(args: { packKey: string; limit?: number }) => PackVersionSummary[]` | List pack versions |
| `ade.packs.getVersion` | `(versionId: string) => PackVersion` | Fetch a specific version |
| `ade.packs.diffVersions` | `(args: { fromId: string; toId: string }) => string` | Diff two versions |
| `ade.packs.getHeadVersion` | `(args: { packKey: string }) => PackVersionSummary \| null` | Fetch the current head version metadata |
| `ade.packs.listEvents` | `(args: { packKey: string; limit?: number }) => PackEvent[]` | List pack events |
| `ade.packs.listEventsSince` | `(args: { packKey: string; sinceIso: string; limit?: number }) => PackEvent[]` | Delta feed for orchestrators |
| `ade.packs.listCheckpoints` | `(args: { laneId: string; limit?: number }) => Checkpoint[]` | List lane checkpoints |

Pack events are also broadcast over:
- `ade.packs.event` (renderer subscription channel)

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
  5. Preserve marker-based user/orchestrator sections:
     a. Intent (`ADE_INTENT_*`)
     b. Task Spec (`ADE_TASK_SPEC_*`)
     c. Todos (`ADE_TODOS_*`)
     d. Narrative (`ADE_NARRATIVE_*`)
  6. Combine deterministic + preserved marker sections into pack markdown
  7. Write to `.ade/packs/lanes/<laneId>/lane_pack.md`
  8. Update packs_index in SQLite + create an immutable pack version snapshot
  9. Record pack events (refresh/version/checkpoint)
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

Narrative updates are **optional** and provider-driven, but packs remain fully useful in Guest Mode.

**Guest Mode (no AI provider)**:
- Deterministic packs refresh normally.
- Narrative content is a placeholder and is preserved between `ADE_NARRATIVE_START/END`.

**Hosted / BYOK (AI enabled)**:
- AI jobs consume **bounded exports**, not raw lane pack markdown:
  - Narrative generation uses `LaneExportStandard` by default.
- Exports are **redacted** before leaving the local machine.
- Narrative updates are applied via **marker-based replacement** between:
  - `<!-- ADE_NARRATIVE_START -->` / `<!-- ADE_NARRATIVE_END -->`
  - This preserves any footer/metadata/sections outside the narrative region.

Hosted is a remote gateway and may be self-hosted by setting:
- `providers.hosted.apiBaseUrl` in `.ade/local.yaml`

Diagnostics should reference `apiBaseUrl` and `remoteProjectId` (no AWS-specific assumptions).

---

## Data Model

### Tables (Implemented)

```sql
-- Index of all packs, tracking metadata and freshness
packs_index (
  pack_key TEXT PRIMARY KEY,       -- Stable key: 'project' | 'lane:<laneId>' | 'feature:<key>' | 'conflict:<laneId>:<peerKey>' | 'plan:<laneId>'
  project_id TEXT NOT NULL,        -- FK to projects table
  lane_id TEXT,                    -- FK to lanes table (NULL for project packs)
  pack_type TEXT NOT NULL,         -- 'project' | 'lane' | 'feature' | 'conflict' | 'plan'
  pack_path TEXT NOT NULL,         -- Filesystem path to the pack markdown file
  deterministic_updated_at TEXT,   -- When the deterministic section was last regenerated
  narrative_updated_at TEXT,       -- When the narrative section was last updated
  last_head_sha TEXT,              -- Git HEAD SHA at the time of last pack generation
  metadata_json TEXT               -- JSON metadata (safe, non-secret)
)
```

### Additional Tables (Implemented)

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
├── project_pack.md                  # Current project pack
├── lanes/
│   └── <laneId>/
│       └── lane_pack.md             # Current lane pack
├── features/
│   └── <featureKey>/
│       └── feature_pack.md
├── plans/
│   └── <laneId>/
│       └── plan_pack.md
├── conflicts/
│   ├── predictions/
│   │   └── <laneId>.json            # Lane conflict prediction summary (deterministic)
│   └── v2/
│       └── <laneId>__<peerKey>.md   # Conflict pack v2 markdown
└── versions/
    └── <versionId>.md               # Immutable rendered snapshot (by UUID)

.ade/history/
├── checkpoints/
│   └── <checkpointId>.json
└── events/
    └── YYYY-MM/
        └── <eventId>.json

.ade/ade.db                          # SQLite durable index (packs, versions, events, checkpoints)
```

### Type Definitions

```typescript
type PackSummary = {
  packKey: string;
  packType: "project" | "lane" | "feature" | "conflict" | "plan";
  path: string;
  exists: boolean;
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt: string | null;
  lastHeadSha: string | null;
  versionId: string | null;
  versionNumber: number | null;
  contentHash: string | null;
  metadata?: Record<string, unknown> | null;
  body: string;
};

type PackVersionSummary = {
  id: string;
  packKey: string;
  packType: "project" | "lane" | "feature" | "conflict" | "plan";
  versionNumber: number;
  contentHash: string;
  createdAt: string;
};

type PackVersion = PackVersionSummary & {
  renderedPath: string;
  body: string;
};

type PackEvent = {
  id: string;
  packKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type Checkpoint = {
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
};

type PackExport = {
  packKey: string;
  packType: "project" | "lane" | "feature" | "conflict" | "plan";
  level: "lite" | "standard" | "deep";
  header: Record<string, unknown>; // `ade.context.v1` header fence content
  content: string;                 // Bounded export markdown (includes header fence + markers)
  approxTokens: number;
  maxTokens: number;
  truncated: boolean;
  warnings: string[];
};
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
| PACK-009 | Pack viewer component (lane/project toggle + activity + versions) | DONE |
| PACK-010 | Pack freshness indicator (green/yellow/red badge) | DONE |
| PACK-011 | Manual pack refresh button | DONE |

### Checkpoints & Event Logging

Implemented (Phase 8).

| ID | Task | Status |
|----|------|--------|
| PACK-012 | Checkpoint creation at session boundaries | DONE — Phase 8 |
| PACK-013 | Checkpoint storage and indexing (SQLite + filesystem) | DONE — Phase 8 |
| PACK-014 | Pack event logging (append-only event log) | DONE — Phase 8 |

### Versioning System

Implemented (Phase 8).

| ID | Task | Status |
|----|------|--------|
| PACK-015 | Pack version snapshots (immutable rendered files) | DONE — Phase 8 |
| PACK-016 | Pack head pointers (mutable, atomic updates) | DONE — Phase 8 |
| PACK-022 | Pack diff (compare two versions side by side) | DONE — Phase 8 |

### Additional Pack Types

Implemented (Phase 8).

| ID | Task | Status |
|----|------|--------|
| PACK-017 | Feature pack type (issue-scoped, cross-lane aggregation) | DONE — Phase 8 |
| PACK-018 | Conflict pack type (resolution context bundle) | DONE — Phase 8 |
| PACK-019 | Plan pack type (versioned planning documents) | DONE — Phase 8 |

### Narrative & Intelligence

| ID | Task | Status |
|----|------|--------|
| PACK-020 | Narrative editing (user override of auto-generated content) | DONE — Phase 8 |
| PACK-021 | LLM-powered narrative generation (hosted agent integration) | DONE — Phase 6 (`hostedAgentService.requestLaneNarrative()`, cloud `NarrativeGeneration` job worker) |

### Operations & Management

| ID | Task | Status |
|----|------|--------|
| PACK-023 | Pack sync to hosted mirror (cloud storage for agent access) | DONE — Phase 6 (`hostedAgentService.syncPacks()`, uploaded via mirror sync pipeline) |
| PACK-024 | Pack retention and cleanup policy (age-based, count-based) | DONE — Phase 7 (implemented in pack service) |
| PACK-025 | Pack privacy controls (redaction rules for sensitive content) | DONE — Phase 6 (`redactSecrets()` in desktop + cloud, exclude patterns for `.env`/creds/keys) |
| PACK-026 | Token-budgeted pack exports (Lite/Standard/Deep) for orchestrators + AI jobs | DONE — bounded exports via `ade.packs.getLaneExport/getProjectExport/getConflictExport` |

### Initial Pack Generation

| ID | Task | Status |
|----|------|--------|
| PACK-027 | Initial project pack bootstrap (repo map + git history seed) | DONE — Phase 8 |
| PACK-028 | Documentation-seeded pack generation (docs index + bootstrap context) | DONE — Phase 8 |
| PACK-029 | Existing lane pack hydration (generate Lane Packs for existing lanes) | DONE — Phase 8 |
| PACK-030 | Guest mode template narratives (template-based fallback when no LLM provider) | DONE (Phase 3) |

### Bounded Export System

Bounded exports are the primary interface for AI jobs and orchestrators. They provide token-budgeted, redacted views of packs designed for consumption by LLM prompts and agent context windows.

**Architecture**: See `docs/architecture/CONTEXT_CONTRACT.md` for the full contract specification. Constants are defined in `apps/desktop/src/shared/contextContract.ts`.

**Export Levels**:

| Level | Token Budget | Use Case | Included Sections |
|-------|-------------|----------|------------------|
| **Lite** | ~800 tokens | Quick agent spawn, status check | Header, Task Spec, Intent, What Changed (summary), Conflict Risk Summary, Errors (top 3) |
| **Standard** | ~2,800 tokens | Narrative generation, orchestrator steps | All Lite sections + Validation, Sessions table, Key Files, Next Steps, Todos |
| **Deep** | ~8,000 tokens | On-demand deep analysis | All Standard sections + Narrative text, extended file list, extended sessions |

**Export API**:
- `ade.packs.getLaneExport({ laneId, level })` — lane-scoped export
- `ade.packs.getProjectExport({ level })` — project-scoped export
- `ade.packs.getConflictExport({ laneId, peerLaneId?, level })` — conflict-scoped export

**Export Structure** (`PackExport` type):
```typescript
type PackExport = {
  packKey: string;               // e.g. "lane:lane-123"
  packType: "project" | "lane" | "feature" | "conflict" | "plan";
  level: "lite" | "standard" | "deep";
  header: Record<string, unknown>; // ade.context.v1 header fence content
  content: string;               // Bounded export markdown (includes header fence + markers)
  approxTokens: number;          // Approximate token count
  maxTokens: number;             // Budget limit for this level
  truncated: boolean;            // Whether any section was truncated
  warnings: string[];            // Truncation warnings, missing data notes
};
```

**Security**: All exports are passed through `redactSecrets()` before leaving the local machine. This strips API keys, tokens, private keys, and GitHub PATs regardless of provider mode.

**Machine-Readable Header**: Every export includes a JSON code fence at the top with schema `ade.context.v1`, containing identity, scope, git snapshot, version metadata, and provider info. Consumers can parse the header programmatically for routing and auditing.

**Conflict Risk Summary**: Lane exports always include a bounded conflict risk summary derived from the latest prediction data (status, top risky peers, last prediction time, coverage info when truncated).

### Pack Retention & Cleanup

Packs are cleaned up automatically to prevent unbounded disk growth.

**Retention policy**:

| Parameter | Value |
|-----------|-------|
| Active lane retention | Indefinite (always kept) |
| Max archived lanes | 25 most recent (by archive time) |
| Age limit for archived | 14 days |
| Cleanup interval | Every 60 minutes (hourly) |

**Cleanup logic**:
1. Active lanes: all pack files retained indefinitely.
2. Archived lanes: sorted by archive time (newest first). Keep newest 25 by count; delete if older than 14 days OR not in the top 25.
3. Associated conflict predictions and v2 conflict packs are cleaned alongside their lane packs.
4. Cleanup runs asynchronously after `refreshLanePack()` completes (non-blocking).

### Orchestrator Delta Consumption

Orchestrators and agents can consume pack changes incrementally using the delta feed pattern:

```
1. Track cursor: sinceIso timestamp from last checkpoint
2. Read new pack events:
   await ade.packs.listEventsSince({ packKey, sinceIso, limit: 200 })
3. If material change detected:
   - Fetch head version: ade.packs.getHeadVersion({ packKey })
   - Diff against last-seen: ade.packs.diffVersions({ fromId, toId })
4. For agent context:
   - Get bounded export: ade.packs.getLaneExport({ laneId, level: "lite" })
   - Secrets are redacted automatically
   - Send to agent
```

**Why bounded exports instead of full packs?** Agents consume token-budgeted exports, not raw pack markdown. This keeps context windows clean, enables incremental updates via diffs, and allows Lite/Standard by default with Deep on-demand.

### Auto-Narrative Pipeline

When a Hosted or BYOK provider is configured, the job engine automatically generates AI narratives after every deterministic pack refresh:

```
Deterministic Pack Refresh Complete
  ↓
IF providerMode = "hosted" or "byok":
  ↓
  Build LaneExportStandard (~2,800 tokens)
    ↓
  Redact all secrets
    ↓
  Submit AI job (narrative_requested event)
    ↓
  Poll for completion
    ↓
  Apply narrative via marker-based replacement
  (between ADE_NARRATIVE_START / ADE_NARRATIVE_END)
    ↓
  Create new pack version + narrative_update event
    ↓
ELSE IF providerMode = "guest":
  Narrative stays as template placeholder
```

Narrative metadata is recorded in the pack event payload: `providerMode`, `jobId`, `provider`, `model`, `inputTokens`, `outputTokens`, `latencyMs`, `exportLevel`, `approxTokens`.

### Current State

> **Note**: The pack service generates deterministic content (diff stats, file lists, session summaries) with template-based narratives. This is fully functional for local workflows. When a Hosted or BYOK provider is configured and available, narrative updates can be applied and are recorded as pack events and immutable version snapshots. Bounded exports (Lite/Standard/Deep) are available for orchestrator and AI consumption.

---

## 2026-02-16 Addendum — Context Freshness + Omission Metadata

### Global docs freshness tracking

Project context now fingerprints core docs and refreshes bootstrap context when docs change.

Tracked paths include:

- `docs/PRD.md`
- `docs/architecture/*`
- `docs/features/*`

Manifest metadata now includes:

- `contextFingerprint`
- `contextVersion`
- `lastDocsRefreshAt`
- `docsStaleReason` (when docs cannot be refreshed/read)

### Deterministic omission metadata

Pack exports and deltas now carry optional omission metadata:

- `clipReason`
- `omittedSections`

These fields are additive and backward compatible. Legacy consumers can ignore them.

### Conflict freshness metadata in lane manifests

Lane manifests now include conflict freshness signals:

- `lastConflictRefreshAt`
- `predictionStalenessMs`
- `stalePolicy.ttlMs`
- `pairwisePairsComputed`
- `pairwisePairsTotal`
- `unresolvedResolutionState`

### UI connections

- Lane inspector `Packs` view shows refreshed exports and omission warnings.
- Settings `Hosted` view surfaces mirror sync/cleanup status and context fallback counters.

---

## 2026-02-16 Addendum — Context Hardening

### Structured terminal summaries

Lane pack generation now parses high-signal final terminal summaries and records:

- `summarySource` (`explicit_final_block` or `heuristic_tail`)
- `summaryConfidence` (`high` or `medium`)
- deterministic omission tags for clipped summary/file extraction

These markers are included in the `## Sessions` section and preserved in pack history.

### Project/global context in narratives

Narrative jobs now include:

- `LaneExportStandard` (`packBody`)
- `ProjectExportLite` (`projectContext`)
- omission metadata and context refs (`projectContextRefs`, `projectContextMeta`)

### ADE-managed minimized docs

ADE now maintains first-class context docs:

- `docs/PRD.ade.md`
- `docs/architecture/ARCHITECTURE.ade.md`

Model-facing context prefers these minimized docs when present. If canonical docs are too large, deterministic generation emits explicit `omitted_due_size` notes.

