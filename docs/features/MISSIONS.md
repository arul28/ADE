# Missions — Current Runtime

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-06

## Overview

Missions are ADE's structured execution flow for multi-step work. A mission enters a phase-aware orchestrator run and executes through durable run/step/attempt state, timeline events, interventions, worker sessions, and artifacts.

Current baseline:

- planning is a built-in mission phase, not a hidden pre-pass,
- mission detail uses Plan, Work, DAG, Chat, Activity, and Details sub-tabs,
- mission chat persists first-class thread/message records only,
- legacy metadata-only chat backfill is not active behavior.

## Runtime Contract

### Planning

When planning is enabled, the run starts in `planning`. The coordinator should gather context, hand off quickly to a read-only planning worker, require a usable planner result, and then transition explicitly to `development`.

Configured phase transitions are explicit coordinator actions. The runtime may summarize phase progress, but it should not silently advance the configured current phase on the coordinator's behalf.

After delegation, the coordinator should stay mostly quiet and wake back up for meaningful runtime events, steering input, or blocked/error conditions.

### Execution

The coordinator owns strategy: delegation, retry, replan, and escalation. The runtime owns state, dependency, claim, budget, and validation enforcement. Low-signal churn should not keep waking the coordinator into idle reasoning turns.

### Validation

Validation is strict runtime behavior:

- required validation cannot be skipped,
- dedicated validation can auto-spawn validator work,
- completion requests do not bypass runtime completion gates,
- required predecessor phases must actually succeed before later required phases unlock,
- missing required validation blocks downstream progress and emits explicit runtime/timeline signals.

## Mission Detail Tabs

- **Plan**: task and phase summary.
- **Work**: worker state, transcript-oriented inspection, and validator lineage.
- **DAG**: dependency graph for executable work.
- **Chat**: Global summary thread plus detailed worker/orchestrator threads.
- **Activity**: durable event feed for runtime transitions and interventions.
- **Details**: configuration, usage, budget, and mission summary.

### Chat Split

- **Global** is the high-signal summary/broadcast channel.
- **Worker and orchestrator threads** are the detailed inspection surface and reuse the shared agent chat renderer patterns used by normal chat sessions.

## Permissions and Tools

ADE uses two layers:

- **Provider-native permissions**: Claude CLI and Codex CLI native behavior is governed by the provider runtime's permission mode (`plan`/read-only vs edit/full execution).
- **ADE-owned tools**: ADE separately controls coordinator tools, worker reporting/status tools, and the planning/coding tool profiles used by API-key and local models.

For API-key and local models, ADE's planning/coding profiles are the primary tool surface because ADE is the runtime there.

## Context and Persistence

Mission context is sourced from the current `.ade` context docs, prioritized repo docs, pack exports, and mission/runtime state where relevant.

Mission persistence includes:

- run/step/attempt state,
- timeline and intervention records,
- worker session lineage and transcripts,
- mission artifacts,
- mission-pack updates under `.ade/packs/missions/<missionId>/mission_pack.md`.
