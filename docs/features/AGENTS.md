# Agents — Current Runtime Surfaces

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

---

## Overview

ADE currently does **not** ship a standalone `/agents` hub page.

Agent behavior is delivered through existing runtime surfaces:

- **Missions** for coordinated multi-step execution,
- **Automations** for trigger- and event-driven background execution,
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

Automations is the canonical surface for creating and operating non-interactive agent work.

- Automation rules configure one of three execution surfaces: `agent-session`, `mission`, or `built-in-task`.
- W5 trigger families cover local events (`manual`, `schedule`, `commit`, `session-end`) plus external GitHub and webhook triggers.
- Rules define tool palettes, memory behavior, guardrails, and output/verification policy rather than only a fixed action enum.
- Automation runs and action results are persisted and queryable for simulation, history, and review.

### Chat-linked agent runtime

Mission chat and orchestrator messaging use structured message records and runtime IDs. Legacy metadata-only chat backfill is not part of current behavior.

For mission detail:

- Global chat is the high-signal summary/broadcast surface.
- Worker and orchestrator channels are the detailed inspection surface and now reuse the shared chat message renderer patterns used by normal agent chat.

---

## Agent Tool Tiers

Agent tools are organized into three tiers, each scoped to the appropriate agent role:

| Tier | Surface | Available To | Contents |
|---|---|---|---|
| **universalTools** | All agents | CTO, workers, chat sessions, coordinator | Memory tools (memorySearch, memoryAdd, memoryPin, memoryUpdateCore), context reading |
| **workflowTools** | Chat agents | CTO chat, employee chat, regular chat sessions | Lane creation, PR creation, screenshot capture, completion reporting, PR issue resolution (refresh inventory, rerun checks, reply to/resolve review threads) |
| **coordinatorTools** | Orchestrator only | Mission coordinator agent | spawn_worker, skip_step, complete_mission, fail_mission, check_finalization_status, set_current_phase, etc. |

This tiering ensures agents have the tools appropriate to their role without exposing orchestrator-level control to regular chat sessions, or workflow actions to headless workers.

---

## Configuration Contract

Agent-capable AI behavior follows current config contracts:

- `ai.mode` controls effective provider mode (`subscription` vs `guest`),
- `ai.taskRouting` controls provider/model selection per task type,
- `ai.features` toggles specific AI-enabled surfaces,
- `ai.permissions` applies provider-specific execution guardrails.
- `automations` stores rule/default data, while `/automations` is the primary authoring and operations UI.

Legacy `providers.mode` does not drive agent/runtime mode.

---

## Context and State

Agent runtime context is assembled from the modern `.ade` state layout:

- context docs: `.ade/context/PRD.ade.md`, `.ade/context/ARCHITECTURE.ade.md`
- packs: `.ade/artifacts/packs/*`
- mission/automation runtime records in ADE local state
- unified memory briefings injected at worker activation

This keeps agent execution aligned with the same deterministic context system used by missions, packs, conflicts, and PR tooling.

### Worker memory model

Workers use the unified memory tools (`memorySearch`, `memoryAdd`) wired through the standard agent tool surface. At activation time, workers receive a memory briefing assembled from relevant entries across the project, mission, and agent scopes. Workers do not have persistent identity like the CTO — they do not own core memory. Instead, they read from and write to the shared unified memory system, and their discoveries are scoped to the mission they are executing. High-value mission-scoped memories are promoted to project scope on mission success.

---

## Non-Goals in Current Baseline

- No separate legacy Agents Hub page.
- No legacy provider-mode migration path.
- No metadata chat backfill behavior without message IDs.
