# Missions — Goal Intake & Execution Tracking

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-19

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Mission](#mission)
  - [Mission Step](#mission-step)
  - [Intervention](#intervention)
  - [Artifact](#artifact)
  - [Mission Pack](#mission-pack)
  - [Step Handoff](#step-handoff)
  - [Execution Target](#execution-target)
- [User Experience](#user-experience)
  - [Phase 1 Surface](#phase-1-surface)
  - [Launch Flow](#launch-flow)
  - [Mission Board](#mission-board)
  - [Mission Detail](#mission-detail)
  - [Mobile-First Behavior](#mobile-first-behavior)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Renderer Components](#renderer-components)
  - [Event Flow](#event-flow)
- [Data Model](#data-model)
- [Implementation Tracking](#implementation-tracking)
  - [Phase 1 (Implemented)](#phase-1-implemented)
  - [Phase 1.5 (Context Hardening Gate, Implemented)](#phase-15-context-hardening-gate-implemented)
  - [Phase 2+ Runtime (Next)](#phase-2-runtime-next)

---

## Overview

The **Missions tab** is ADE's Phase 1 mission-control surface for plain-English task intake and lifecycle tracking.

It gives users a fast way to:

- launch a mission from a prompt,
- assign lane/priority/execution target metadata,
- track status in queue-style lanes,
- manage interventions when human input is required,
- capture outcomes and link artifacts (including PR URLs).

This is the product bridge between today's manual workflow and orchestrator execution. Phase 1.5 context hardening adds durable mission packs, step handoffs, and orchestrator runtime persistence before full Phase 2 runtime expansion.

---

## Core Concepts

### Mission

A **Mission** is a user-defined goal object with lifecycle state:

- `queued`
- `in_progress`
- `intervention_required`
- `completed`
- `failed`
- `canceled`

Missions are durable records, persisted locally and visible in a board + detail experience.

### Mission Step

A **Mission Step** is an ordered subtask row attached to a mission.

- Phase 1 creates placeholder steps from the prompt.
- Steps have independent status transitions (`pending`, `running`, `succeeded`, `failed`, etc.).
- A failed step can automatically open an intervention and move the mission into `intervention_required`.

### Intervention

An **Intervention** is a human-in-the-loop checkpoint.

- Open interventions block forward mission flow.
- Interventions can be resolved or dismissed.
- Resolving all open interventions can auto-resume mission progress when appropriate.

### Artifact

An **Artifact** is a mission outcome reference.

Supported artifact types:

- `summary`
- `pr`
- `link`
- `note`
- `patch`

Artifacts support PR handoff, traceability, and post-mission review.

### Mission Pack

A **Mission Pack** is a deterministic mission-level context artifact (`mission:<missionId>`) with immutable versioning and pack events. It snapshots:

- mission metadata and prompt,
- mission step status progression,
- artifacts/interventions counts,
- linked orchestrator runs,
- recent structured step handoffs.

Mission packs are refreshed on mission mutations and orchestrator run starts to keep mission context resumable and auditable.

### Step Handoff

A **Step Handoff** is a structured record emitted per orchestrated step attempt (`mission_step_handoffs`):

- `attempt_started`
- `attempt_succeeded`
- `attempt_failed`
- `attempt_blocked`
- `attempt_canceled`
- `attempt_recovered_after_restart`

Handoffs are machine-readable payloads used for deterministic resume, history replay, and context provenance.

### Execution Target

Mission execution target metadata includes:

- `executionMode`: `local` or `relay`
- optional `targetMachineId`

Phase 1 stores this metadata and surfaces it in UI. Future runtime phases execute against it.

---

## User Experience

### Phase 1 Surface

Missions is exposed as a first-class tab (`/missions`) in the left rail.

The page includes:

- summary/status cards,
- mission launch form,
- mission board lanes (by status),
- detail panel with actions, steps, interventions, artifacts, and timeline.

### Launch Flow

Users launch a mission with:

- plain-English prompt (required),
- optional title,
- optional lane,
- priority,
- execution mode (`local` / `relay`),
- optional target machine ID.

### Mission Board

The board is lane-oriented by mission status and optimized for quick scan:

- queued
- running
- needs input
- completed
- failed
- canceled

Each card shows priority, lane, last update time, step progress, and open intervention count.

### Mission Detail

The detail surface includes:

- mission summary metadata,
- status actions (start, complete, fail, cancel, requeue),
- editable outcome summary,
- per-step controls,
- intervention list + resolve/dismiss actions,
- artifact list with open-link/open-PR actions,
- event timeline.

### Mobile-First Behavior

Phase 1 UI choices are built for constrained widths:

- compact card density and small action surfaces,
- horizontal mission-lane board for swipe/scroll scanning,
- form and detail layout that collapse into single-column sections.

This keeps launch and status updates fast on small screens while preserving full desktop functionality.

---

## Technical Implementation

### Services

Main-process mission logic lives in:

- `apps/desktop/src/main/services/missions/missionService.ts`

Responsibilities:

- mission CRUD/list/detail,
- lifecycle transition validation,
- step status updates,
- intervention and artifact creation/resolution,
- event recording + broadcast.

### IPC Channels

Mission IPC contract lives in:

- `apps/desktop/src/shared/ipc.ts`

Channels:

- `ade.missions.list`
- `ade.missions.get`
- `ade.missions.create`
- `ade.missions.update`
- `ade.missions.updateStep`
- `ade.missions.addArtifact`
- `ade.missions.addIntervention`
- `ade.missions.resolveIntervention`
- `ade.missions.event`

Main-process handlers are registered in:

- `apps/desktop/src/main/services/ipc/registerIpc.ts`

Preload bridge and renderer typings are defined in:

- `apps/desktop/src/preload/preload.ts`
- `apps/desktop/src/preload/global.d.ts`
- `apps/desktop/src/shared/types.ts`

### Renderer Components

Missions renderer entrypoint:

- `apps/desktop/src/renderer/components/missions/MissionsPage.tsx`

Route and navigation wiring:

- `apps/desktop/src/renderer/components/app/App.tsx`
- `apps/desktop/src/renderer/components/app/TabNav.tsx`
- `apps/desktop/src/renderer/components/app/CommandPalette.tsx`

### Event Flow

Mission updates are event-driven:

1. Main process writes mission/step/artifact/intervention state.
2. Service emits `ade.missions.event`.
3. Renderer subscriptions refresh list and selected mission detail.

This pattern keeps UI reactive while preserving local-first durability.

Mission updates now also trigger mission pack refreshes so mission-level context stays current across sessions.

---

## Data Model

Phase 1 + Phase 1.5 mission/orchestrator persistence adds:

- `missions`
- `mission_steps`
- `mission_events`
- `mission_artifacts`
- `mission_interventions`
- `mission_step_handoffs`
- `orchestrator_runs`
- `orchestrator_steps`
- `orchestrator_attempts`
- `orchestrator_claims`
- `orchestrator_context_snapshots`

Migration is implemented in:

- `apps/desktop/src/main/services/state/kvDb.ts`

Migration coverage:

- `apps/desktop/src/main/services/state/kvDb.missionsMigration.test.ts`

Lifecycle/transition coverage:

- `apps/desktop/src/main/services/missions/missionService.test.ts`

---

## Implementation Tracking

### Phase 1 (Implemented)

- Mission schema and indexes are persisted locally.
- Mission service lifecycle and transition validation is implemented.
- Missions tab UI is implemented for launch, board tracking, detail control, interventions, and artifacts.
- Mission event broadcasting and renderer subscriptions are implemented.
- Migration and lifecycle tests are passing.

### Phase 1.5 (Context Hardening Gate, Implemented)

- Mission-level pack type (`mission`) is implemented with deterministic version/event/index semantics.
- Structured mission step handoffs are durable and queryable for every orchestrator step attempt.
- Orchestrator runtime state tables are implemented (runs, steps, attempts, claims, context snapshots).
- Claim/lease model, resume recovery path, and tracked-session enforcement are implemented in runtime service/tests.

### Phase 2 Runtime v2 (Implemented)

- Missions detail now includes orchestrator runtime controls:
  - start run from mission steps,
  - tick/resume/cancel run,
  - start step attempts,
  - complete running attempts.
- Mission detail now shows:
  - step DAG runtime status,
  - attempt history per step,
  - recent run timeline events.
- IPC coverage now includes orchestrator runtime endpoints for runs/graph/attempt lifecycle/claims heartbeat/timeline/gate report.
- Orchestrator runtime events are broadcast and mission UI refreshes on mission + orchestrator event streams.

### Phase 2 Runtime Notes (Shipped vs Scaffolded)

- Shipped:
  - deterministic run lifecycle controls from mission UI,
  - durable timeline and context provenance visibility.
- Scaffolded:
  - external executor deep integration for Claude/Codex/Gemini remains in production-safe tracked-session scaffold mode with explicit adapter state markers.
