# Conflicts — Radar, Prediction & Resolution

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-02

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
and AI-powered resolution proposals via the agent SDKs.

This feature transforms conflict management from a reactive, painful process into a
proactive, guided workflow. Developers can see at a glance which lanes are safe to
merge, which ones are drifting from the base branch, and which pairs of lanes are
on a collision course.

**Current status**: Core conflict prediction, risk matrix, merge simulation, and Conflicts tab UI are **implemented and working** (Phase 5). Resolution proposals via AI agent SDKs (diff preview, apply, undo) are **implemented** (Phase 6). External CLI resolution (Codex/Claude), active merge/rebase conflict management, restack suggestion integration, merge-plan workflows, and integration lane creation are **implemented** (Phase 8).

### Roadmap Alignment (Final Plan)

Per `docs/final-plan.md`, Conflicts owns merge-risk intelligence and resolution workflows, including integration-lane planning. Planned coordination points:

- Integration Sandbox handoff to Run/Play for combined-lane verification before merge.
- Explicit links from conflict merge plans to PR readiness/landing gates.
- Mission/Orchestrator consumption of conflict APIs without bypassing conflict policy checks.

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

An AI-generated suggested fix for a predicted or active conflict. The AI agent (via AgentExecutor) receives **bounded context exports** (not raw pack dumps) and produces a resolution diff with a confidence score.

Context inputs (default):
- `LaneExportLite` for the lane
- `LaneExportLite` for the peer lane (when peer conflicts are being resolved)
- `ConflictExportStandard` for the specific conflict pack

All outbound AI payloads are token-budgeted and redacted.

#### User Configuration Options

When a user clicks "Resolve with AI", ADE presents a configuration dialog before dispatching the AI request. Users control:

**Where to apply changes**:
| Option | Description |
|--------|-------------|
| Target branch | Apply resolution changes in the target (destination) branch |
| Source branch | Apply resolution changes in the source branch |
| AI decides | Let the AI determine the optimal location based on change analysis |

**Post-resolution action**:
| Option | Description |
|--------|-------------|
| Unstaged | Apply changes but leave them unstaged — user reviews in git actions |
| Staged | Apply and stage changes — user reviews before committing |
| Commit | Apply, stage, and commit with an AI-generated commit message |

**PR behavior** (when no PR is already open):
| Option | Description |
|--------|-------------|
| Do nothing | Just apply the resolution, user handles PR manually |
| Open PR | After committing, automatically open a PR |
| Add to existing PR | If a PR exists for this lane, push the resolution commit to it |

**AI autonomy level**:
| Option | Description |
|--------|-------------|
| Propose only | AI generates a proposal — user must review and explicitly apply |
| Auto-apply if confident | AI auto-applies if confidence score exceeds user-set threshold (default: 0.85) |

These configuration options persist to `.ade/local.yaml` under `ai.conflict_resolution` and are remembered across sessions:

```yaml
ai:
  conflict_resolution:
    change_target: "ai_decides"      # target | source | ai_decides
    post_resolution: "staged"        # unstaged | staged | commit
    pr_behavior: "do_nothing"        # do_nothing | open_pr | add_to_existing
    auto_apply_threshold: 0.85       # 0.0-1.0, only used when autonomy = auto_apply
    autonomy: "propose_only"         # propose_only | auto_apply
```

### Conflict Pack

A context bundle assembled for conflict resolution. Contains:

- Both sides of the conflict (lane A changes, lane B or base changes)
- Common ancestor state for each conflicting file
- Full list of overlapping files
- Commit history for the overlapping regions
- Lane pack summaries for both sides (developer intent context)

Storage:
- Conflict pack v2 markdown: `.ade/packs/conflicts/v2/<laneId>__<peerKey>.md`
- Conflict prediction summaries (deterministic): `.ade/packs/conflicts/predictions/<laneId>.json`
- AI consumption should use exports (`ConflictExport*`, `LaneExport*`), not raw files.

Prediction summary packs are versioned by schema evolution (unknown fields are ignored). Newer payloads may include:

- `predictionAt`, `lastRecomputedAt`
- `stalePolicy.ttlMs`
- coverage metadata: `strategy`, `truncated`, `pairwisePairsComputed`, `pairwisePairsTotal`
- `openConflictSummaries` (peer label, risk, last seen, risk signals)

Conflict exports may additionally include a `## Conflict Lineage` JSON section (schema `ade.conflictLineage.v1`) to surface prediction provenance and unresolved resolution state.

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

**Layout (4-pane tiling via `PaneTilingLayout`)**:

```
+-------------------+---------------------------+---------------------+
|                   |  Conflict Detail           |                     |
|   Lane List       |  (summary / merge sim)    |   Risk Matrix       |
|   (~22%)          |  (~55% of center)         |   (~30%)            |
|                   +---------------------------+                     |
|                   |  Resolution               |                     |
|                   |  (proposals / external)   |                     |
|                   |  (~45% of center)         |                     |
+-------------------+---------------------------+---------------------+
```

The layout uses `PaneTilingLayout` (a recursive `react-resizable-panels` tree), making all pane dividers draggable. Pane sizes are persisted across sessions.

**Left panel — Lane list with conflict status**:

- All active lanes displayed with their conflict status badges (colored left border + status dot)
- Sort by: risk level (highest first), then lane name
- Click a lane to populate the center panel with its conflict summary
- **Status filter chips** at the top: conflict / at-risk / clean / unknown — click to toggle filtering. Each chip shows the count of lanes in that category.
- Restack suggestion badges appear on lanes whose parent has advanced (amber "restack" chip with behind-count tooltip)

**Center-top pane — Conflict detail** (for selected lane):

- **Lane header**: Branch ref, base ref, parent lane (if stacked), with Open Folder and Refresh buttons
- **Restack suggestion**: When a lane's parent has advanced, an amber banner offers "Restack now", "Defer 1h", "Defer 1d", and "Dismiss" actions
- **Active Merge/Rebase panel**: Detects in-progress git merge or rebase via `git.getConflictState`. Shows conflicted file list (with red dots), Continue button (enabled when all conflicts resolved), and Abort button (with "type ABORT" confirmation dialog). When a merge-plan merge is paused on conflicts, the panel shows which source lane is blocked.
- **Conflict summary** (`ConflictSummary` component): Lane status, overlapping file count, peer conflict count, last predicted timestamp, and per-peer overlap cards with risk level coloring and file lists
- **Merge simulation panel** (`MergeSimulationPanel` component): Select two lanes (or lane + base), run simulation, see outcome (clean/conflict/error), diff stats, and per-file conflict marker previews via `ConflictFileDiff`
- Toggle between **summary view** and **matrix view** (via view mode buttons)

**Right pane — Risk matrix** (`RiskMatrix` component):

- Pairwise grid of all active lanes (always visible in right pane)
- Each cell colored by risk level:
  - **Gray (`bg-card`)**: No overlap
  - **Light green (`bg-emerald-500/20`)**: Low overlap, no predicted conflict
  - **Amber (`bg-amber-500/25`)**: Medium file overlap
  - **Red (`bg-red-500/30`)**: High risk or active conflicts
- Stale cells show a clock icon and reduced opacity with "Last computed N minutes ago" tooltip
- **Animated transitions**: cells animate on entry, flash on risk level increase/decrease
- **Progress indicator**: during batch computation, shows "Computing X/Y pairs..." with ETA
- Click a cell to see details of the overlap between those two lanes
- Diagonal cells show lane-to-base risk
- **Hover tooltip** (`RiskTooltip` component): shows overlapping file paths (up to 10, with "+N more" indicator)

**Merge simulation panel** (activated from summary or matrix):

- Select two lanes (or lane + base) to simulate merge
- Preview result:
  - **Clean merge**: File list of merged changes, combined diff stat
  - **Conflicts**: List of conflicting files with conflict markers preview
  - **Error**: Simulation could not complete (e.g., unrelated histories)
- Action buttons: "Open in diff viewer", "Generate resolution proposal"

**Center-bottom pane — Resolution**:

The resolution pane provides three resolution paths:

**1. Merge one-by-one (merge plan)**:
- Select a target lane and check source lanes to merge sequentially
- Stack-aware ordering: child lanes are sorted by depth then creation time
- Each merge runs `git merge --no-edit <source-branch>` on the target
- If conflicts occur, the plan pauses — user resolves and clicks Continue
- Integration lane creation: create a child lane from a base lane to use as the merge target

**2. AI resolution proposals (via AgentExecutor)**:
- **Configure**: When user clicks "Resolve with AI", a configuration panel appears with options for: change target (target branch / source branch / AI decides), post-resolution action (unstaged / staged / commit), PR behavior (do nothing / open PR / add to existing), and AI autonomy level (propose only / auto-apply if confident). These options persist across sessions.
- Prepare proposal: refreshes packs, builds bounded context (`LaneExportLite` + `ConflictExportStandard`), shows preview with context digest, file count, and token budget
- Send proposal: dispatches to `aiIntegrationService` via `AgentExecutor.execute()` — one-shot, no multi-turn conversation
- Each proposal shows: confidence %, provider used, model used, explanation, and diff patch
- Apply mode determined by user configuration: unstaged / staged / commit (with AI-generated or custom commit message)
- If autonomy is set to "auto-apply" and confidence exceeds threshold, apply happens automatically with notification
- "Apply + Continue" option: applies patch then auto-continues merge/rebase if no conflicts remain
- Undo: reverse-applies the patch via `git apply -R`
- Post-apply PR behavior: if configured, opens PR or pushes to existing PR after commit

**3. External CLI resolver (Codex/Claude)**:
- One-click buttons to run external CLI (Codex or Claude) with deterministic prompt + context refs
- ADE builds pack references (project pack, lane packs, conflict packs, context docs), validates context completeness
- If context is insufficient, blocks with explicit gap messages (`status=blocked`)
- Run history shows: provider, status, summary, patch path, warnings, context gaps
- Commit button: stages and commits the external resolver's changes with a generated commit message
- Run artifacts stored at `.ade/packs/external-resolver-runs/<runId>/`

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

5. **Resolution**: For active or predicted conflicts, the developer clicks "Resolve with AI"
   and configures resolution options (change target, post-resolution action, PR behavior,
   AI autonomy level). ADE dispatches a one-shot request to the AI integration service
   via `AgentExecutor.execute()`. The provider receives bounded exports (`LaneExportLite` +
   `ConflictExportStandard`) and produces a resolution diff. The entire interaction is
   one-shot — no back-and-forth conversation.

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
| `packService` | Exists | Generates conflict packs and bounded exports (`LaneExport*`, `ConflictExport*`) used for AI proposal jobs. Conflict-specific pack assembly is handled by the `conflictPackBuilder` sub-module. |

**AI resolution integration** (via AgentExecutor):

- Dispatch: `aiIntegrationService.requestConflictProposal()` routes through `AgentExecutor.execute()`
- Default provider: Claude CLI with `sonnet` model, `read-only` permissions, 60s timeout
- Input: bounded exports (token-budgeted):
  - `LaneExportLite` (lane)
  - `LaneExportLite` (peer lane, optional)
  - `ConflictExportStandard`
  - User configuration (change target, post-resolution action, PR behavior)
- Output: Resolution diff with confidence score, explanation, and change target recommendation
- Execution: One-shot — prompt + context in, result out, session ends
- Runs asynchronously; result stored as a `conflict_proposal` record
- Logged to `ai_usage_log` table for usage tracking

### IPC Channels

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.conflicts.getLaneStatus` | `(laneId: string) => ConflictStatus` | Get conflict status for a single lane |
| `ade.conflicts.listOverlaps` | `(args: { laneId: string }) => ConflictOverlap[]` | List file overlaps for a lane against base and peers |
| `ade.conflicts.getRiskMatrix` | `() => RiskMatrixEntry[]` | Get the full pairwise risk matrix for all active lanes |
| `ade.conflicts.simulateMerge` | `(args: { laneAId: string; laneBId?: string }) => MergeSimulationResult` | Simulate merge between two lanes or lane-to-base |
| `ade.conflicts.runPrediction` | `(args: RunConflictPredictionArgs) => void` | Trigger conflict prediction for a specific lane or pair |
| `ade.conflicts.getBatchAssessment` | `() => BatchAssessmentResult` | Get batch assessment: lane statuses, risk matrix, overlaps, and progress |
| `ade.conflicts.listProposals` | `(laneId: string) => ConflictProposal[]` | Get resolution proposals for a lane's conflicts |
| `ade.conflicts.prepareProposal` | `(args: PrepareConflictProposalArgs) => ConflictProposalPreview` | Prepare AI proposal: refresh packs, build context, return preview |
| `ade.conflicts.requestProposal` | `(args: RequestConflictProposalArgs) => void` | Submit prepared proposal to hosted/BYOK provider |
| `ade.conflicts.applyProposal` | `(args: ApplyConflictProposalArgs) => GitActionResult` | Apply a resolution proposal (unstaged/staged/commit mode) |
| `ade.conflicts.undoProposal` | `(args: UndoConflictProposalArgs) => GitActionResult` | Reverse-apply a proposal via `git apply -R` |
| `ade.conflicts.runExternalResolver` | `(args: RunExternalConflictResolverArgs) => ConflictExternalResolverRunSummary` | Run external CLI resolver (Codex/Claude) with context |
| `ade.conflicts.listExternalResolverRuns` | `(args: { laneId: string; limit?: number }) => ConflictExternalResolverRunSummary[]` | List external resolver run history for a lane |
| `ade.conflicts.commitExternalResolverRun` | `(args: { runId: string }) => CommitExternalConflictResolverRunResult` | Commit changes from an external resolver run |
| `ade.conflicts.event` | Event stream | Conflict prediction events: `prediction-progress` and `prediction-updated` |

**Git conflict state channels** (used by ConflictsPage):

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.git.getConflictState` | `(laneId: string) => GitConflictState` | Detect active merge/rebase state and conflicted files |
| `ade.git.rebaseContinue` | `(laneId: string) => GitActionResult` | Continue an in-progress rebase |
| `ade.git.rebaseAbort` | `(laneId: string) => GitActionResult` | Abort an in-progress rebase |
| `ade.git.mergeContinue` | `(laneId: string) => GitActionResult` | Continue an in-progress merge |
| `ade.git.mergeAbort` | `(laneId: string) => GitActionResult` | Abort an in-progress merge |

### Conflict Exports (For AI / Orchestrators)

Conflicts are sent to AI providers via **bounded pack exports**, not raw pack dumps.

- `ade.packs.getLaneExport({ laneId, level: "lite" | "standard" | "deep" })`
- `ade.packs.getConflictExport({ laneId, peerLaneId?, level: "lite" | "standard" | "deep" })`

Recommended defaults:
- proposals: `LaneExportLite` + `ConflictExportStandard`
- narrative / broader lane updates: `LaneExportStandard`

### Conflict Prediction Engine

The prediction engine operates in two modes:

**Periodic mode** (background):

```
Job Engine tick →
  For each active lane (always):
    1. Run git merge-tree <base> <lane-HEAD>
    2. Parse result for conflicts + overlap
3. Store prediction record
    4. Update lane conflict status

  For lane-vs-lane (scaled for large workspaces):
    1. Compute a cheap overlap heuristic (touched files since base)
    2. Prefilter to likely-conflicting pairs (top peers per lane)
    3. Run git merge-tree only for those high-likelihood pairs
    4. Persist partial-coverage metadata:
       - `truncated: true`
       - `strategy: "prefilter-overlap"`
       - `pairwisePairsComputed` / `pairwisePairsTotal`

  Full pairwise matrices are available on-demand (e.g. per-lane predictions or small selected sets).
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
  source TEXT NOT NULL,            -- 'sdk' | 'external_cli' | 'deterministic'
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
  source: 'sdk' | 'external_cli' | 'deterministic';
  confidence: number;
  explanation: string;
  diffPatch: string;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
}
```

---

## Implementation Tracking

Core prediction, UI, simulation, and resolution proposals are **DONE** (Phases 5–6).

### What's Built

| Component | Details |
|-----------|---------|
| `conflictService.ts` | ~1800 lines — full conflict prediction engine, pairwise risk computation, merge simulation, batch assessment, external CLI resolver, proposal lifecycle, integration lane support |
| `gitConflictState.ts` | Git conflict state detection (`detectConflictKind` — checks for `rebase-apply`, `rebase-merge`, `MERGE_HEAD` in git dir) |
| Conflict UI (7 components) | `ConflictsPage.tsx` (~1500 lines, 4-pane PaneTilingLayout), `ConflictFileDiff.tsx`, `ConflictSummary.tsx`, `MergeSimulationPanel.tsx`, `RiskMatrix.tsx` (with animated transitions and progress), `RiskTooltip.tsx`, `extensionToLanguage.ts`. Note: the graph canvas also has its own inline `ConflictPanel.tsx` (extracted to `graph/graphDialogs/ConflictPanel.tsx`) for showing conflict details on risk edge click without navigating away. |
| Job engine integration | Periodic prediction jobs via `processService`, configurable intervals |
| Database schema | `conflict_predictions` + `conflict_proposals` tables with SHA tracking, expiry, and proposal lifecycle |
| Git merge-tree integration | Dry-merge via `git merge-tree` for zero-side-effect conflict detection |
| External resolver infrastructure | Run artifacts at `.ade/packs/external-resolver-runs/<runId>/`, JSON run records (`ade.conflictExternalRun.v1`), pack ref building, context gap detection, commit workflow |
| Restack suggestion integration | `restackSuggestionService.ts` — detects parent-advanced children, dismiss/defer/emit lifecycle, integrated into ConflictsPage |
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
| CONF-017 | Hosted agent proposal integration (ProposeConflictResolution job) | DONE — Phase 6 (`aiIntegrationService.requestConflictProposal() via AgentExecutor`, `conflictService.requestProposal()`) |
| CONF-018 | Proposal diff preview in UI | DONE — Phase 6 (ConflictsPage right panel shows diff patch preview) |
| CONF-019 | Proposal apply with operation record | DONE — Phase 6 (`conflictService.applyProposal()` with `git apply --3way`, operation tracking) |
| CONF-020 | Proposal confidence scoring display | DONE — Phase 6 (confidence percentage shown in ConflictsPage proposal list) |
| CONF-021 | Proposal undo via operation timeline | DONE — Phase 6 (`conflictService.undoProposal()` with `git apply -R`, operation tracking) |
| CONF-039 | Conflict resolution configuration dialog | User-facing config panel: change target, post-resolution action, PR behavior, AI autonomy level. Persisted to `local.yaml` under `ai.conflict_resolution` | TODO |
| CONF-040 | Auto-apply with confidence threshold | When autonomy is "auto_apply" and confidence > threshold, automatically apply resolution with user notification | TODO |
| CONF-041 | Post-resolution PR behavior | After committing resolution, optionally open PR or push to existing PR based on user config | TODO |

### Advanced Features

| ID | Task | Status |
|----|------|--------|
| CONF-022 | Stack-aware conflict resolution (resolve parent lane first) | DONE — Phase 7 (ConflictsPage restack suggestions + merge-plan workflows with stack-aware ordering) |
| CONF-023 | Batch conflict assessment (all-lanes report) | DONE (batch conflict assessment implemented) |
| CONF-024 | Conflict notification/alerts (in-app and system) | TODO — **moved to Phase 9** |

### Phase 8 — Active Conflict Management & External Resolution

| ID | Task | Status |
|----|------|--------|
| CONF-025 | Active merge/rebase detection (`GitConflictState` via `gitConflictState.ts`) | DONE — Phase 8 (detects merge/rebase-in-progress, conflicted files, canContinue/canAbort) |
| CONF-026 | Merge continue/abort from ConflictsPage | DONE — Phase 8 (Continue + Abort buttons with confirmation dialog) |
| CONF-027 | External CLI resolver (Codex/Claude) | DONE — Phase 8 (`runExternalResolver` in conflictService, pack ref building, context validation, insufficient-context blocking) |
| CONF-028 | External resolver commit workflow | DONE — Phase 8 (`commitExternalResolverRun` — stage + commit with generated message) |
| CONF-029 | External resolver run history | DONE — Phase 8 (`listExternalResolverRuns`, run artifacts at `.ade/packs/external-resolver-runs/`) |
| CONF-030 | Merge-plan UI (sequential multi-lane merge) | DONE — Phase 8 (target lane selection, source checkboxes, stack-depth ordering, pause on conflicts) |
| CONF-031 | Integration lane creation from Conflicts tab | DONE — Phase 8 (create child lane as merge target, auto-selects and initializes merge plan) |
| CONF-032 | Restack suggestion integration in Conflicts tab | DONE — Phase 8 (restack banner with Restack Now / Defer / Dismiss, via `restackSuggestionService`) |
| CONF-033 | PaneTilingLayout for Conflicts page | DONE — Phase 8 (4-pane layout: lanes, conflict-detail, resolution, risk-matrix) |
| CONF-034 | Proposal apply modes (unstaged/staged/commit) | DONE — Phase 8 (radio selector for apply mode, optional commit message) |
| CONF-035 | Proposal apply + auto-continue | DONE — Phase 8 (apply patch then auto-continue rebase/merge if canContinue) |
| CONF-036 | Batch assessment progress tracking | DONE — Phase 8 (real-time progress events: completedPairs/totalPairs with ETA in RiskMatrix) |
| CONF-037 | Risk matrix staleness indicators | DONE — Phase 8 (stale cells show clock icon, reduced opacity, "Last computed N min ago" tooltip) |
| CONF-038 | Risk matrix animated transitions | DONE — Phase 8 (entry animation, risk increase/decrease flash, skeleton loading) |

---

### Completion Notes

**Phase 5 (Conflict Detection) completed** as part of the `codex/ade-phase-4-5` branch merge. The core conflict engine (CONF-001 through CONF-016) and batch assessment (CONF-023) are fully operational.

**Phase 6 (AI Resolution Proposals) completed**: CONF-017 through CONF-021 (AI-powered resolution proposals) are fully implemented. AI integration service generates conflict proposals locally via AgentExecutor (Claude or Codex CLI). Proposals are generated on-device via one-shot SDK calls, presented in the Conflicts tab with diff preview, confidence scoring, user configuration options (change target, post-resolution action, PR behavior, autonomy level), apply (with operation record), and undo capabilities.

**Phase 8 (Active Conflict Management) completed**: CONF-025 through CONF-038. Active merge/rebase conflict detection and management, external CLI resolution (Codex/Claude) with context validation and commit workflow, merge-plan sequential merge UI, integration lane creation, restack suggestions, PaneTilingLayout, proposal apply modes, batch progress tracking, and risk matrix animations are all operational.

**Remaining tasks** are scheduled as follows:
- **Phase 9 (Advanced Features)**: CONF-024 (conflict notifications)

---

## 2026-02-16 Addendum — Conflict Context Integrity Rules

### Conflict context payload (hosted/BYOK)

Conflict jobs now carry a richer scoped context envelope:

- `relevantFilesForConflict[]`
- `fileContexts[]` with:
  - `path`
  - side snapshots/excerpts (`base`, `left`, `right`)
  - hunk metadata and selection reason
- freshness:
  - `predictionAgeMs`
  - `predictionStalenessMs`
  - `stalePolicy.ttlMs`
  - `pairwisePairsComputed`
  - `pairwisePairsTotal`

### Omission and clipping signaling

If context is clipped/omitted, reasons are explicit, for example:

- `omitted:path_count_limit`
- `omitted:byte_cap`
- `omitted:no_text_context`
- `omitted:binary`
- `omitted:secret-filter`

### Insufficient-context guard (no speculative patches)

When patch risk is high and required file context is incomplete:

- set `insufficientContext=true`
- include `insufficientReasons[]`
- do not emit speculative patch
- return explicit data-gap output instead

### Conflict prompt contract

Conflict prompts now enforce this exact output structure:

1. `ResolutionStrategy`
2. `RelevantEvidence`
3. `Scope`
4. `Patch`
5. `Confidence`
6. `Assumptions`
7. `Unknowns`
8. `InsufficientContext`

If `InsufficientContext=true`, patch output must be empty.

---

## 2026-02-16 Addendum — External CLI Resolution Primary Path

Conflict resolution generation now defaults to **external local CLIs** (Codex or Claude) while ADE remains the context system of record.

### Primary path

1. ADE refreshes lane/conflict packs and builds bounded conflict context.
2. ADE validates context completeness (`relevantFilesForConflict` + `fileContexts`).
3. ADE executes external CLI with deterministic prompt + context refs.
4. ADE captures stdout/stderr, summary, and patch artifact path under `.ade/packs/external-resolver-runs/<runId>/`.
5. ADE exposes run history via IPC and the Conflicts UI.

### CWD policy

- Single-lane merge: run in the **source lane** worktree.
- Multi-lane merge: create/use **Integration lane**, run there.

### Safety policy

- If context is insufficient, ADE blocks speculative patch generation (`status=blocked`) and records explicit gap messages.
- Hosted/BYOK proposal APIs remain for compatibility, but they are deprecated as the primary resolution UX path.

---

### Phase 3: Orchestrator Conflict Handling

The Phase 3 missions overhaul changes how conflicts are managed:

- **Merge Phase Removed**: The previous merge phase (which attempted automatic conflict resolution) has been completely removed from the mission lifecycle
- **PR Strategy**: Conflicts are now handled at PR time, controlled by the selected PR strategy (integration/per-lane/queue/manual)
- **Integration Phase**: For `integration` strategy, lanes merge into an integration branch where conflicts are surfaced for resolution
- **Pre-Merge Checking** (Planned): The orchestrator will perform dry-run merges to detect conflicts before PR creation, allowing proactive conflict resolution
- **File Conflict Prevention** (Planned): During mission planning, the orchestrator will assign files to lanes to minimize overlap and reduce merge conflicts
