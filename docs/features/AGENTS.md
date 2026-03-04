# Agents — Current Runtime Surfaces

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-03

---

## Overview

ADE currently does **not** ship a standalone `/agents` hub page.

Agent behavior is delivered through existing runtime surfaces:

- **Missions** for coordinated multi-step execution,
- **Automations** for trigger-action background rules,
- **Chat/orchestrator runtime** for interactive and mission-linked agent sessions.

This replaces legacy "future hub" documentation with the implementation that exists in the product today.

---

## Where Agent Execution Lives

### Missions (`/missions`)

Missions run coordinated agent work via orchestrator runtime:

- coordinator + worker attempts,
- runtime events and interventions,
- mission artifacts and mission-pack updates.

### Automations (`/automations`)

Automations are config-driven rules loaded from effective project config.

Supported triggers:

- `session-end`
- `commit`
- `schedule`
- `manual`

Supported actions:

- `update-packs`
- `predict-conflicts`
- `run-tests`
- `run-command`

Automation runs and action results are persisted and queryable for history/status.

### Chat-linked agent runtime

Mission chat and orchestrator messaging use structured message records and runtime IDs. Legacy metadata-only chat backfill is not part of current behavior.

---

## Configuration Contract

Agent-capable AI behavior follows current config contracts:

- `ai.mode` controls effective provider mode (`subscription` vs `guest`),
- `ai.taskRouting` controls provider/model selection per task type,
- `ai.features` toggles specific AI-enabled surfaces,
- `ai.permissions` applies provider-specific execution guardrails.

Legacy `providers.mode` does not drive agent/runtime mode.

---

## Context and State

Agent runtime context is assembled from the modern `.ade` state layout:

- context docs: `.ade/context/PRD.ade.md`, `.ade/context/ARCHITECTURE.ade.md`
- packs: `.ade/packs/*`
- mission/automation runtime records in ADE local state

This keeps agent execution aligned with the same deterministic context system used by missions, packs, conflicts, and PR tooling.

---

## Non-Goals in Current Baseline

- No separate legacy Agents Hub page.
- No legacy provider-mode migration path.
- No metadata chat backfill behavior without message IDs.
