# Packs — Compatibility Context Artifacts

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-05

---

## Overview

Persisted pack files are no longer ADE's canonical runtime context source. W6 uses live local context exports plus unified memory for runtime retrieval/injection.

Pack files and pack version history still exist as compatibility artifacts for:

- export/resource compatibility (`read_context`, `ade://pack/...`),
- audit/history,
- optional persisted summaries,
- legacy workflows that still expect file-shaped context.

---

## Filesystem Layout (`.ade`)

### Pack roots

Compatibility pack bodies and history live under `.ade/packs`:

- project pack: `.ade/packs/project_pack.md`
- lane pack: `.ade/packs/lanes/<laneId>/lane_pack.md`
- feature pack: `.ade/packs/features/<featureKey>/feature_pack.md`
- plan pack: `.ade/packs/plans/<laneId>/plan_pack.md`
- mission pack: `.ade/packs/missions/<missionId>/mission_pack.md`
- conflict pack: `.ade/packs/conflicts/v2/<laneId>__<peer>.md`
- external resolver runs: `.ade/packs/external-resolver-runs/<runId>/`

Version/history support is maintained under `.ade/history` and `.ade/packs/versions`.

### Context docs consumed by packs

Canonical ADE context docs are:

- `.ade/context/PRD.ade.md`
- `.ade/context/ARCHITECTURE.ade.md`

These are prioritized during doc discovery and are included in context status/fingerprint and downstream export assembly.

---

## Context Docs Flow

### Generation

Context doc generation builds minimized, model-friendly context docs from prioritized project documentation and writes ADE canonical docs.

### Install and fallback behavior

Preferred write target is `.ade/context/*.ade.md`.

If writing canonical files fails, generated output is written to:

- `.ade/context/generated/<timestamp>/`

### Discovery and priority

Doc discovery prioritizes:

1. `.ade/context/PRD.ade.md`
2. `.ade/context/ARCHITECTURE.ade.md`
3. key root docs (`README.md`, `CLAUDE.md`, `AGENTS.md`, etc.)
4. relevant docs found by bounded repo scan

---

## Runtime Truth

Runtime exports (`getProjectExport`, `getLaneExport`, `getConflictExport`, `getFeatureExport`, `getPlanExport`, `getMissionExport`) are synthesized from current local state when requested. They do not require a pre-refreshed on-disk pack file to exist first.

Conflict external-resolver runs now consume generated per-run context files plus optional docs, rather than assuming `.ade/packs/...` files are already present.

## Refresh Triggers and Cadence

Context doc refresh preferences support these triggers:

- `manual`
- `per_mission`
- `per_pr`
- `per_lane_refresh`

Automatic refresh throttles are enforced in service-level cadence windows to avoid over-refreshing while still keeping mission/PR context current.

---

## Pack Content Contract

Pack content includes:

- deterministic sections (stats, file sets, refs, conflicts, events),
- optional narrative sections (provider-dependent),
- context headers/markers for stable machine consumption.

In guest mode, deterministic compatibility packs remain usable; narrative generation is simply skipped.

---

## Integration Points

### Missions

Mission planning/execution consumes live bounded exports plus ADE context docs. Persisted pack history may still be useful for audit or compatibility, but it is not the runtime source of truth.

### Conflicts

Conflict tooling keeps prediction artifacts under `.ade/packs/conflicts`, but external resolver prompts should prefer generated per-run context files and optional `.ade/context/*.ade.md` docs.

### PRs

PR drafting and integration simulation consume live exports and summaries. Persisted pack artifacts remain optional compatibility/audit outputs.

---

## Practical Guidance

Use packs as persisted compatibility/audit artifacts, not as the canonical live runtime layer:

- rely on unified memory plus live exports for runtime context,
- keep `.ade/context/*.ade.md` up to date,
- use persisted pack paths only when a compatibility consumer explicitly asks for them.
