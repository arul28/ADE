# Context documentation contract

> This document defines the ownership split between canonical docs and generated agent bootstrap docs. Detailed service and storage design stays in the other architecture docs.
>
> Last updated: 2026-03-25

## Purpose

ADE keeps two kinds of context documentation:

- canonical human-owned docs under `docs/`
- generated agent-owned bootstrap cards under `.ade/context/`

The canonical docs maximize coverage and reviewability. The generated docs maximize startup usefulness under a tight token budget. This contract keeps those layers from collapsing into the same document twice.

## Canonical ownership split

### `docs/PRD.md` owns product semantics

`docs/PRD.md` is the source of truth for:

- what ADE is
- who it is for
- product goals and principles
- operator workflows and feature areas
- current shipped state
- non-goals and success signals

It should not embed large technical architecture sections. When implementation detail is needed, it should link into `docs/architecture/`.

### `docs/architecture/*` owns technical design

The architecture tree is the source of truth for:

- trust boundaries and process model
- service layout and major subsystems
- storage and state contracts
- IPC/preload/shared-type boundaries
- integration paths and extension seams
- performance, safety, and enforcement patterns

Architecture docs may reference product workflows only when that detail is required to explain a technical constraint.

## Generated docs contract

ADE generates two bounded bootstrap cards:

- `.ade/context/PRD.ade.md`
- `.ade/context/ARCHITECTURE.ade.md`

These docs are agent-facing summaries, not canonical references.

### PRD card

`PRD.ade.md` owns:

- what ADE is
- who it is for
- feature areas
- current product state
- working norms that affect operators and implementers

Required headings:

- `## What this is`
- `## Who it's for`
- `## Feature areas`
- `## Current state`
- `## Working norms`

### Architecture card

`ARCHITECTURE.ade.md` owns:

- system shape
- core services
- data and state model
- integration points
- key implementation patterns

Required headings:

- `## System shape`
- `## Core services`
- `## Data and state`
- `## Integration points`
- `## Key patterns`

## Generation inputs

The generator uses a hybrid source-digest model. Source documents are not passed raw; each is summarized into a `ContextSourceDigest` (title, blurb, headings) before being bundled for generation. This keeps the input compact and prevents noisy content from leaking into generated cards.

### Product-first sources

- `docs/PRD.md`
- `docs/features/*`
- `README.md`
- `AGENTS.md`

### Technical sources

- `docs/architecture/*`
- selected shared contracts and IPC/preload surfaces
- selected main-process entrypoints and service anchors (code anchors)
- recent git history and git changes since the last generation

Generated output should not be derived from noisy build artifacts, vendored output, caches, or broad directory dumps.

## Quality gates

Generated docs are only accepted when they pass all of these checks:

- each doc fits inside the configured character budget (default 8,000 characters)
- each doc contains the required headings for its role
- PRD and architecture output are sufficiently distinct (token-level Jaccard overlap check)
- invalid AI output does not overwrite previously valid docs

If the AI path fails for a given doc:

- preserve the previous valid generated doc when one exists (source: `previous_good`)
- otherwise fall back to a deterministic compact summary (source: `deterministic`)
- never replace the docs with a raw codebase snapshot dump

The generation result reports per-doc outcomes (`docResults`) including health, source, and size. When any doc uses a fallback or previous-good path, the overall result is flagged as `degraded`.

## Runtime health model

The UI consumes doc health from the main process, not renderer heuristics. The context doc service pushes status changes to the renderer via the `contextStatusChanged` IPC event whenever generation status or doc health changes, replacing the previous polling approach.

Each `ContextDocStatus` carries a `health` field and a `source` field:

Allowed health states:

- `missing`
- `incomplete`
- `fallback`
- `stale`
- `ready`

Allowed sources:

- `ai`
- `deterministic`
- `previous_good`

Helper functions in `contextShared.ts` (`isContextDocReady`, `listContextDocsByHealth`, `listActionableContextDocs`, `describeContextDocHealth`) provide consistent rendering logic across shell banners, Settings, and onboarding. The `describeContextDocHealth` function maps each health state to a human-readable label (e.g., `"deterministic fallback"`, `"stale"`). The module also exports `relativeTime` for timestamp display and `parsePackBody` for extracting JSON headers and markdown sections from pack content.

Shell banners, Settings, and onboarding should all render from that shared health contract. The Settings > Context section subscribes to real-time status changes via the `onStatusChanged` callback (exposed through the preload bridge) so the UI updates immediately when generation completes or doc health changes, without polling.

## Relationship to other architecture docs

- System/process model: [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md)
- Desktop trust boundaries and performance rules: [`DESKTOP_APP.md`](./DESKTOP_APP.md)
- Data model and storage layout: [`DATA_MODEL.md`](./DATA_MODEL.md)
- AI runtime and orchestration: [`AI_INTEGRATION.md`](./AI_INTEGRATION.md)
