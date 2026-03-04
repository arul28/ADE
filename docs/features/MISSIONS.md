# Missions — Planner + Orchestrator Runtime

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-03

---

## Overview

Missions are ADE's structured execution flow for multi-step work. A mission starts from a prompt, is decomposed into a plan, and is executed by the orchestrator with per-step tracking, interventions, artifacts, and resumable runtime state.

The current baseline is **no-legacy**:

- planner/orchestrator behavior is centered on the current AI coordinator runtime,
- mission chat reconciliation no longer backfills legacy metadata-only entries,
- step and hook timeout configuration is `timeoutMs`-only.

---

## Core Runtime Model

### Mission lifecycle

A mission moves through planning, execution, intervention (if needed), and terminal states. Mission detail surfaces expose:

- plan graph and step status,
- runtime activity and worker state,
- interventions/questions,
- artifacts and outcome summary.

### Planner output contract

Planner output is validated and canonicalized before execution. Steps include structured fields such as:

- stable `stepId`, `name`, `description`,
- dependency graph metadata,
- claim policy and output contract,
- per-step timeout via `timeoutMs`.

### Orchestrator execution

The orchestrator runs missions in `manual` or `autopilot` mode and applies runtime safeguards (budgets, claims, integrity checks) while leaving strategy to the coordinator model.

Current behavior intentionally avoids the old deterministic strategy fallback path:

- coordinator AI owns retry/replan/replacement decisions,
- runtime enforces state and safety constraints,
- deterministic timeout/retry strategy handlers are not used as a legacy fallback.

---

## Timeout Behavior (Current)

Timeouts use modern keys only.

### Step timeout resolution

Per-step timeout resolves in this order:

1. `metadata.aiTimeoutMs`
2. `metadata.timeoutMs`
3. `metadata.planStep.timeoutMs`
4. runtime profile default (`execution.stepTimeoutMs`)

Final values are clamped by runtime minimums/caps.

### Hook timeout config

Orchestrator hook config parsing accepts:

- `command`
- `timeoutMs`

There is no legacy timeout key migration path in the hook parser.

---

## Chat + Interventions (No Legacy Backfill)

Mission/orchestrator chat messages are parsed as first-class records and require:

- `id`
- valid `role`
- non-empty `content`

Startup reconciliation now ignores legacy metadata chat entries that do not include message IDs. Those entries are not rehydrated into the active thread.

Interventions remain the human-in-the-loop boundary for blocked or question states and are linked to runtime question thread/message IDs when available.

---

## Context Inputs

Mission planning and execution context is sourced from current ADE context artifacts:

- `.ade/context/PRD.ade.md`
- `.ade/context/ARCHITECTURE.ade.md`
- additional discovered docs from prioritized repo scanning
- pack exports (project/lane/mission/conflict/plan where relevant)

This keeps mission runs aligned with the same `.ade` context system used by packs and conflict tooling.

---

## Mission Artifacts and Persistence

Mission execution records persist durable run/step/attempt state and timeline events, including:

- step transitions and runtime events,
- intervention records,
- mission artifacts,
- mission-pack updates for resumable context.

Mission packs live under `.ade/packs/missions/<missionId>/mission_pack.md` and are refreshed as mission state advances.
