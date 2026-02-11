# Packs (Comprehensive Context and History System)

Last updated: 2026-02-11

## 1. Goal

Packs are ADE's durable context system for agent-first development.

Packs must support two modes at the same time:

- immutable history (append-only, auditable, replayable)
- current state (fast materialized pack views for daily work)

This design is intentionally "capture everything" so we can power:

- lane handoffs without context loss
- high-quality agent prompts grounded in project reality
- explainable planning revisions and design decisions
- feature history across every terminal session

Terminology note:

- "Context pack" refers to the **Project Pack** unless explicitly stated otherwise.

## 2. Core Primitives

### 2.1 Checkpoint

A checkpoint is an immutable snapshot of execution context, typically created at session end and commit boundaries.

Minimum checkpoint payload:

- identity:
  - `checkpoint_id`
  - `project_id`, `lane_id`, optional `feature_key` and `issue_key`
  - `session_id` (nullable for non-session checkpoints)
- git anchors:
  - `base_ref`
  - `head_sha_start`, `head_sha_end`
  - `commit_sha` (if a new commit was created)
- execution context:
  - session label/goal
  - tool/agent metadata (provider, model when available)
  - commands summary
  - transcript pointer + transcript hash
  - optional prompt/tool-call/token summaries
- deterministic deltas:
  - changed files
  - insertions/deletions
  - module areas touched
  - failure/error lines
- validation context:
  - tests run + outcomes
  - process/runtime state pointers
- references:
  - linked operations
  - linked PRs/issues
  - parent checkpoint ids (for thread continuity)

### 2.2 Pack Event

Append-only event for anything that changes pack state.

Examples:

- checkpoint created
- lane pack materialized
- project pack materialized
- plan version created
- plan version activated/reverted
- conflict pack generated
- narrative augmentation completed

### 2.3 Pack Version

Immutable rendered version of a pack (`markdown + metadata + source inputs`).

Pack versions are never edited in place. A separate head pointer chooses which version is active.

### 2.4 Pack Head

A mutable pointer for each pack key (for example `lane:<laneId>`) that references:

- latest deterministic version
- latest narrative version
- active version (for user-facing view)

## 3. Pack Types

### 3.1 Project Pack (global context)

Deterministic content:

- repo purpose + system map
- architecture/module map
- run/test/process baselines
- conventions/constraints
- recently touched hotspots (derived from checkpoints)
- cross-lane risk signals

Narrative content:

- architecture notes
- risk hotspots and mitigations
- project-level "what changed recently" summaries

### 3.2 Lane Pack (execution context)

Deterministic content:

- intent + acceptance criteria
- lane status (dirty/ahead/behind/conflicts)
- latest checkpoint summary
- checkpoint timeline slice for the lane
- touched files/modules and commit anchors
- tests/process pointers
- explicit decisions/todos

Narrative content:

- "what changed and why"
- implementation risks
- recommended next steps

### 3.3 Feature Pack (issue/initiative context)

A feature-scoped aggregate across one or more lanes/sessions/issues.

Deterministic content:

- linked issues/PRs/lanes
- checkpoints grouped by milestone
- design decisions and plan revisions
- acceptance criteria status
- validation evidence (tests/checks)

Narrative content:

- feature evolution summary
- unresolved risks + open questions

### 3.4 Conflict Pack (resolution context)

Deterministic content:

- predicted/active conflict files + anchors
- base vs lane vs parent-stack deltas
- operation timeline for the conflict episode
- proposal artifact links

Narrative content:

- root-cause explanation
- recommended resolution strategy
- post-resolution validation checklist

### 3.5 Plan Pack (versioned coding plan)

Deterministic content:

- plan versions (immutable)
- active plan version
- per-version diff summary
- rationale entries and feedback thread pointers
- handoff prompts (phase and full-plan)

Narrative content:

- planning rationale summary
- alternatives considered

## 4. Storage Layout

Default local paths (git-ignored by default):

- `.ade/history/checkpoints/<checkpointId>.json`
- `.ade/history/events/<YYYY-MM>.jsonl`
- `.ade/packs/versions/<packKey>/<versionId>.md`
- `.ade/packs/heads/<packKey>.json`
- `.ade/packs/current/project_pack.md`
- `.ade/packs/current/lanes/<laneId>/lane_pack.md`
- `.ade/packs/current/features/<featureKey>/feature_pack.md`
- `.ade/packs/current/conflicts/<operationId>/conflict_pack.md`
- `.ade/packs/current/plans/<planKey>/plan_pack.md`
- `.ade/packs/conflicts/<operationId>/proposals/<proposalId>.diff`

Notes:

- `current/` is a materialized convenience view.
- `versions/` + `heads/` + `history/events` is source of truth.

## 5. Update Pipeline (Always In Sync)

### 5.1 Session End Path

1. build and persist checkpoint
2. append checkpoint-created event
3. materialize lane pack version
4. materialize project pack version (bounded incremental)
5. materialize feature pack version (if linked)
6. append pack-version events and move pack heads
7. run conflict prediction and update conflict pack if needed
8. trigger hosted narrative augmentation (optional)

### 5.2 Commit Path

- creates additional checkpoint if commit happened outside session-end boundary
- updates lane/project/feature pack versions with new SHA anchors

### 5.3 Re-plan Path

- creates new immutable plan version
- keeps prior versions available for compare/revert
- appends plan events and optionally updates feature/lane pack views

## 6. Privacy and Retention

Defaults:

- raw transcripts and raw prompt/tool traces stay local
- hosted sync is opt-in per project and policy-controlled

Controls:

- redaction rules for secrets before any upload
- per-session opt-out from hosted sync
- retention policy by artifact class:
  - checkpoints/events/pack versions: keep forever by default
  - raw transcripts: configurable (for example 30/90/365 days)

## 7. Non-Negotiable Requirements

- Append-only history for checkpoints, pack events, and pack versions.
- Deterministic regeneration: pack versions must be reproducible from inputs.
- Stable anchors: every major item links to lane/session/checkpoint/SHAs.
- Fast reads: current pack views must load quickly from materialized state.
- Explainability: every pack section should trace back to source checkpoints/events.

## 8. Development Checklist

Comprehensive implementation (single phase):

- [ ] Implement immutable checkpoint schema and writers
- [ ] Implement append-only pack events log
- [ ] Implement pack version store + per-pack head pointers
- [ ] Implement materializers for project/lane/feature/conflict/plan packs
- [ ] Implement re-plan versioning (compare/revert/activate)
- [ ] Implement feature history timeline from checkpoints + events
- [ ] Implement UI for pack version history and source traceability

Hardening:

- [ ] Add retention/redaction controls and policy UI
- [ ] Add integrity checks (hashes and schema validation)
- [ ] Add recovery/rebuild command to regenerate current views from history
