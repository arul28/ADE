# Automations

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-05

---

## Status

This document is the canonical product direction for ADE Automations in W5 and beyond.

- Surface: `/automations` is the first-class UI for creating, simulating, running, and reviewing automations.
- Settings: Settings holds global defaults, connector auth, and policy presets. It is not the primary automation builder UI.
- Runtime: automation executions use the same agent/runtime primitives as missions and CTO workers, including guardrails, memory, and audit history.

Implementation note: the current baseline still has config-backed automation plumbing, but the product contract is the Automations tab as the canonical authoring and operations surface.

---

## Overview

Automations turns ADE into a programmable background execution layer for the repo. Users can define local and external triggers, choose who or what should execute the work, control available tools, attach memory, and review outcomes through a friendly builder rather than raw config editing.

An automation can target any of these executor modes:

- `automation-bot`: disposable worker with optional automation-scoped memory
- `employee`: persistent worker under the CTO org chart
- `cto-route`: let the CTO choose the best persistent employee or handle it directly
- `night-shift`: queue the work for unattended overnight execution

This keeps one automation engine while supporting both quick disposable jobs and long-lived employees with memory.

## Product Model

Each automation rule is defined by a small set of stable building blocks:

- `trigger`: what starts the rule
- `executor`: who runs it
- `template/prompt`: the repeatable behavior or starting instructions
- `tool palette`: which tools/integrations the automation may use
- `memory`: what the automation remembers across runs
- `guardrails`: budgets, time limits, approval rules, and allowed hours
- `outputs`: verification requirements, posting behavior, artifacts, and notifications

Representative shape:

```typescript
interface AutomationRule {
  id: string;
  name: string;
  triggers: AutomationTrigger[];
  executor: {
    mode: "automation-bot" | "employee" | "cto-route" | "night-shift";
    targetId?: string;
  };
  templateId?: string;
  prompt?: string;
  toolPalette: string[];
  memory: {
    mode: "none" | "automation" | "automation-plus-employee";
  };
  guardrails: {
    budgetUsd?: number;
    maxDurationMin?: number;
    activeHours?: { start: string; end: string; timezone: string };
    verifyBeforePublish: boolean;
  };
}
```

## Supported Trigger Families

W5 supports both local repo triggers and external event triggers.

### Local triggers

- `manual`
- `schedule`
- `commit`
- `session-end`

### External triggers

- `GitHub`
- `Linear`
- `webhook`

Deferred for later phases: Slack, PagerDuty, and other external sources can plug into the same trigger contract once the first connector set is stable.

## Tool Palettes

Automations should not be constrained to a tiny fixed action enum. Users configure a tool palette per rule so the executor gets exactly the capabilities it needs.

Initial W5 palette families:

- repo/code/test tools
- GitHub actions: open PR, comment on PR, review PR, request reviewers
- Linear actions: create issue, update issue, comment, transition state
- MCP tool bundles
- memory read/write tools
- internal ADE operations such as mission launch, validation, and artifact generation

## UX Contract

The Automations tab is optimized for fast setup and safe unattended execution.

- Template gallery for common recipes and team-shared starting points
- Natural-language creation flow that drafts a rule from plain English
- Friendly builder with explicit steps for Trigger, Run As, Tools, Memory, Guardrails, Output, and Verification
- Simulation / dry-run before activation
- Run history with rerun, pause, edit, and failure inspection
- Clear ownership surfaces so users can see which employee, bot, or Night Shift queue owns a rule

## Memory Model

Automations can keep their own scoped memory even when they run as disposable bots.

- Automation-scoped memory stores recurring preferences, learned context, and prior run summaries for that rule
- When an automation targets a persistent employee, automation memory is combined with that employee's long-lived identity memory
- CTO-routed rules can use automation memory for the rule itself while still benefiting from CTO and employee project memory

This is a key differentiator from one-shot background jobs: recurring automations improve over time.

## Relationship to CTO and Employees

The Automations tab is where rules are authored. The CTO tab is where persistent employees live.

- Persistent employees can own one or more automations
- The CTO can review, route, or reassign automations across employees
- Night Shift is an execution mode and queue within the automation system, not a separate product surface
- Morning briefings and history views make overnight employee work reviewable inside the same automation system

## Relationship to Settings

Settings stores global defaults and infrastructure, including:

- default model/provider preferences
- connector credentials and integration health for GitHub, Linear, and webhooks
- default guardrails and budget policies
- default Night Shift window and notification preferences
- team template defaults and shared presets

Rule creation, simulation, activation, and run review happen in `/automations`, not in Settings.

## Canonical References

- [docs/features/CTO.md](CTO.md)
- [docs/features/AGENTS.md](AGENTS.md)
- [docs/features/MISSIONS.md](MISSIONS.md)
- [docs/architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md)
- [docs/architecture/CONTEXT_CONTRACT.md](../architecture/CONTEXT_CONTRACT.md)
- [docs/final-plan/phase-4.md](../final-plan/phase-4.md)
