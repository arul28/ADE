# Automations

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-15

---

## Status

This document captures ADE's current automation model.

- Surface: `/automations` is the canonical UI for creating, simulating, running, and reviewing automations.
- Settings: stores shared defaults and policy presets, including usage policy.
- Runtime: each automation dispatches to one of three execution surfaces:
  - `agent-session`
  - `mission`
  - `built-in-task`
- Triggers: only **time-based** and **action-based** triggers are supported for automation entries.
- CTO role: CTO owns Linear intake and dispatch; Automations never duplicate issue routing.

---

## Overview

Automations are rule-based background workflows in ADE.

Each rule has:

- a trigger (time-based or action-based),
- a target execution surface,
- a prompt / mission template,
- optional tool palette,
- optional output contract,
- and guardrails.

The execution surface model is the key control point:

- **agent-session**: launch an AI chat thread scoped to the automation and record it as an automation-only chat.
- **mission**: launch the full Mission runtime (planning/execution/validation, lane workers, interventions).
- **built-in-task**: run an ADE-native task with structured input and output when no full agent model is required.

Agent-session results are visible in **Automations → History**. Mission runs and multi-step artifacts are visible in the Missions surface.

---

## Trigger model

Automation rules are split into two trigger classes.

### Time-based

- `schedule` for cron-like cadence.

### Action-based

- `manual` from the Automations UI
- `git.commit` and other Git event variants
- `session-end`
- `webhook` and `github.webhook`

Current action coverage is intentionally focused to keep runtime semantics predictable and easy to debug.

---

## Trigger and execution boundaries

### CTO and Linear boundary

CTO owns Linear issue intake. Linear polling, priority routing, worker assignment, and dispatch are in CTO.

Automations can use Linear in two ways:

- as an execution target (`output` writes, comments, status updates),
- or as an external context in output templates.

They do **not** define Linear issue intake logic.

---

## Execution surfaces

### 1) agent-session

Best for lightweight autonomous text-work: reviews, audits, short summaries, status checks.

- lightweight one-shot agent call path
- direct visibility in Automations history as a chat thread
- minimal orchestration overhead

### 2) mission

Best for code-affecting or multi-step tasks.

- planner + phase model
- interventions and validation gates
- reusable lane/worker execution
- multi-artifact outputs

Mission results use the Missions UI by design.

### 3) built-in-task

Best for deterministic built-in ADE operations.

- schema-driven inputs and outputs
- no separate mission thread
- low overhead execution

---

## Execution model and memory

- `agent-session`: uses rule-scoped memory and optional project memory depending on config.
- `mission`: inherits mission memory model and may reference project/employee context.
- `built-in-task`: usually project-context lightweight and task-scoped.

Execution mode should map directly to what each rule needs: cheap and local for quick automation, mission for durable workflows.

---

## Tool palettes

Automations expose explicit tool palettes per rule instead of a fixed global enum. Examples:

- repo/code/test
- GitHub actions (review/comment/open/reviewers)
- Linear actions (create/update/comment/status)
- mission launch/validation utilities
- MCP tool bundles
- memory tools

---

## Output model and result routing

Automations can route outputs to:

- comments/notes in artifacts
- PR updates
- Linear updates
- in-app notifications
- built-in workflow endpoints

When output requires high visibility or follow-up, choose `mission`; otherwise an `agent-session` often provides the right signal-to-noise profile.

---

## Usage and budget policy

Budget policy is shared from **Settings > Usage** and applies consistently across automations, missions, and chat surfaces.

- rule-level caps are allowed for predictable cost control
- global/shared caps prevent accidental runaway spend
- budget changes in settings apply across surfaces

Usage telemetry should remain aligned with actual cost models for each provider type.

---

## What changed with the current model

- Automation execution now uses a single model: **time-based or action-based** triggers plus three execution surfaces (`agent-session`, `mission`, `built-in-task`).
- All budget policy for automations is centralized in **Settings > Usage** and shared with Missions.
- Output placement is explicit by execution surface: `agent-session` writes to Automations history, while `mission` writes stay in Missions.

---

## Competitive references

- Template gallery and trigger/action taxonomy are informed by modern automation systems.
- ADE adapts local-first execution and explicit execution surfaces to reduce confusion over where output lives.

---

## Canonical references

- [docs/features/CTO.md](CTO.md)
- [docs/features/MISSIONS.md](MISSIONS.md)
- [docs/architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md)
- [docs/architecture/CONTEXT_CONTRACT.md](../architecture/CONTEXT_CONTRACT.md)
- [docs/final-plan/phase-4.md](../final-plan/phase-4.md)
