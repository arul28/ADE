# Packs (Project, Lane, Conflict)

Last updated: 2026-02-10

## 1. Goal

Packs are always-in-sync, structured artifacts that provide:

- deterministic ground truth (computed locally)
- narrative augmentation (produced by hosted agent)

They are the core substrate for conflict resolution, PR drafting, and lane handoff.

Terminology note:

- "Context pack" refers to the **Project Pack** (global context) unless explicitly stated otherwise.

## 2. Pack Types

### 2.1 Project Pack (global)

Deterministic content (local):

- repo purpose (user-provided)
- folder map and major modules
- entrypoints (detected heuristically)
- how to run (processes config)
- how to test (test suites config)
- conventions and constraints (user-editable section)

Narrative augmentation (hosted):

- "architecture notes"
- "recently changed areas"
- "risk hot spots"

Update triggers:

- on project import (full build)
- incremental update on lane session end (bounded)
- scheduled full rebuild (nightly/weekly)

### 2.2 Lane Pack (per lane)

Deterministic content (local):

- intent (template + user edits)
- current status (dirty, ahead/behind, predicted conflicts)
- deltas since last update:
  - diff summary keyed by SHAs
  - touched files/modules
- commands run in recent sessions (summary)
- last test results
- decisions/todos (user-editable)

Narrative augmentation (hosted):

- "what changed and why"
- "risks and recommended next steps"

Update triggers:

- terminal session end (always)
- commit created
- manual "refresh" (fallback)

### 2.3 Conflict Pack (per operation/prediction)

Deterministic content (local):

- base vs lane refs and SHAs
- predicted conflict files (and types if available)
- active conflict hunks/markers when present
- "what changed in base since lane started"
- "what changed in lane"
- suggested tests to run post-resolution

Narrative augmentation (hosted):

- explanation of conflict cause
- recommended resolution strategies
- patch proposals (separate artifact)

Update triggers:

- whenever conflict prediction changes materially
- whenever an active conflict exists in a sync/rebase operation

## 3. File Layout

Default local paths (git-ignored by default):

- `.ade/packs/project_pack.md`
- `.ade/packs/lanes/<laneId>/lane_pack.md`
- `.ade/packs/conflicts/<operationId>/conflict_pack.md`
- `.ade/packs/conflicts/<operationId>/proposals/<proposalId>.diff`

## 4. Always-In-Sync Rule

After terminal session end:

1. local deterministic updates happen immediately
2. hosted sync occurs (forced on session end)
3. hosted narrative updates run after sync and stream back

UI should show:

- deterministic timestamp (local)
- narrative timestamp (hosted)

## 5. Development Checklist

MVP:

- [ ] Define deterministic schemas for all 3 packs
- [ ] Implement lane pack update from session delta + SHAs
- [ ] Implement project pack build (import) + incremental update (bounded)
- [ ] Implement conflict pack generation from prediction and from active conflicts
- [ ] UI viewer for packs + freshness indicators

V1:

- [ ] Hosted narrative integration (merge narrative into packs or show as separate "agent notes")
- [ ] Pack diff viewer (what changed between pack versions)
