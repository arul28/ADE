# Packs — Deterministic Context Artifacts

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-03

---

## Overview

Packs are ADE's versioned context artifacts. They combine deterministic project facts (git-derived data, lane/session state, conflict data) with optional AI narrative sections.

Packs are the shared context substrate for:

- mission planning/execution,
- conflict analysis and resolver runs,
- PR drafting and integration simulation,
- history/audit workflows.

The current implementation is fully aligned to `.ade` paths.

---

## Filesystem Layout (`.ade`)

### Pack roots

All pack bodies are stored under `.ade/packs`:

- project pack: `.ade/packs/project_pack.md`
- lane pack: `.ade/packs/lanes/<laneId>/lane_pack.md`
- feature pack: `.ade/packs/features/<featureKey>/feature_pack.md`
- plan pack: `.ade/packs/plans/<laneId>/plan_pack.md`
- mission pack: `.ade/packs/missions/<missionId>/mission_pack.md`
- conflict pack: `.ade/packs/conflicts/v2/<laneId>__<peer>.md`

Version/history support is maintained under `.ade/history` and `.ade/packs/versions`.

### Context docs consumed by packs

Canonical ADE context docs are:

- `.ade/context/PRD.ade.md`
- `.ade/context/ARCHITECTURE.ade.md`

These are prioritized during doc discovery and are included in context status/fingerprint and downstream pack/export assembly.

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

In guest mode, deterministic packs still refresh and remain usable; narrative generation is simply skipped.

---

## Integration Points

### Missions

Mission planning/execution reads pack exports plus ADE context docs for bounded runtime context.

### Conflicts

Conflict tooling references:

- project pack,
- relevant lane packs,
- conflict packs,
- `.ade/context/*.ade.md` docs.

### PRs

PR drafting and integration simulation consume pack data for summaries and conflict-aware planning.

---

## Practical Guidance

Use packs as the primary context layer for both humans and automation:

- refresh project/lane packs before high-stakes AI operations,
- keep `.ade/context/*.ade.md` up to date,
- rely on pack paths above as the canonical no-legacy baseline.
