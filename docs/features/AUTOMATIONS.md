# Automations

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-06

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

### Core Principle: Full ADE Tool Access (W5b)

Automations are not a limited "run shell command" system. When W5b ships, an automation rule can spawn an AI agent with **the same capabilities as any CTO worker or mission worker** — every single tool that ADE has to offer:

- **Repo/code tools**: read files, search code, analyze dependencies
- **Git operations**: branch, commit, merge, rebase, cherry-pick
- **Terminal/PTY**: run arbitrary commands in sandboxed environments
- **Test runners**: execute test suites, report results
- **GitHub PR workflows**: open PRs, request reviews, post comments, merge
- **Linear actions**: create/update issues, transition state, post comments
- **Browser automation**: navigate, interact, screenshot
- **External MCP tools** (W8): any user-configured MCP server
- **Memory tools**: read/write project memory, search knowledge base
- **Conflict resolution**: detect and resolve merge conflicts
- **Mission launch**: spawn sub-missions, validate outcomes, generate artifacts

The user configures per rule: which model to use, what permission level, which tools are available, what the agent should do, and how to handle output (open PR, post to Linear, run tests, verify before publishing). The automation executor dispatches through the orchestrator's mission system — the same infrastructure that powers interactive missions.

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

## Linear Dispatch Boundary

> Decided 2026-03-06

**CTO owns Linear dispatch; Automations does NOT duplicate it.**

The CTO heartbeat (W4, shipped) is the intelligent intake and routing path for Linear issues. It polls Linear, classifies issues, selects mission templates, and dispatches work to the appropriate worker. This is where logic like "P0 bug -> bug-fix template -> backend-dev worker" belongs.

Automations handles local triggers (commit, schedule, session-end, manual), webhooks, and programmable workflows. Linear appears in Automations only as an **action** — for example, "on commit -> update Linear issue status" or "on session-end -> post summary to Linear issue". Automations does NOT re-implement Linear issue intake or routing as a trigger.

If a user wants "P0 bug -> specific template", that is a CTO dispatch policy configured via `linearSync.autoDispatch.rules` in W4, not an automation rule. This boundary prevents UX confusion ("which system handles my Linear issue?") and avoids duplicating the already-shipped W4 dispatch infrastructure.

## Supported Trigger Families

W5 supports both local repo triggers and external event triggers.

### Local triggers

- `manual`
- `schedule`
- `commit`
- `session-end`

### External triggers (W5b)

- `GitHub` (webhooks)
- `webhook` (generic)

Note: Linear is intentionally excluded as a trigger — see Linear Dispatch Boundary above. Slack, PagerDuty, and other external sources are deferred for later phases and can plug into the same trigger contract once the first connector set is stable.

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

## Usage Tracking and Budget Caps

> Added 2026-03-06. Inspired by [CodexBar](https://github.com/steipete/CodexBar).

Automations includes a usage tracking and budget cap layer to give users visibility into AI spend and prevent runaway costs from unattended execution.

### Usage Tracking

- **OAuth API polling**: Real-time usage data from Claude (`api.anthropic.com/api/oauth/usage` with five_hour and seven_day windows) and Codex (`chatgpt.com/backend-api/wham/usage` or CLI RPC).
- **Local cost scanning**: Parse JSONL session logs from `~/.claude/projects/` and `~/.codex/sessions/` for granular per-session cost attribution.
- **Pacing calculation**: Determine whether usage is on-track, ahead, or behind based on `usage% vs time_elapsed%` within the billing window.

### Budget Caps

- **Per-rule caps**: Each automation rule can specify a USD or token budget per run.
- **Per-night-shift-run caps**: Limit how much a single Night Shift session can spend.
- **Global caps**: Expressed as percentage of weekly budget or absolute USD.
- **Night Shift reserve**: Protect X% of weekly budget for overnight runs, preventing daytime usage from starving Night Shift.

### Implementation

- `usageTrackingService`: Provider-agnostic usage snapshots, polling intervals, pacing math.
- `budgetCapService`: Budget enforcement at rule, night-shift, and global levels. Emits budget-breach events for notification/auto-pause.
- Usage data surfaced in the Automations tab via a dedicated "Usage" sub-tab.

## Competitive References

> Added 2026-03-06

Design decisions informed by competitive analysis:

- **Cursor Automations (Mar 2026)**: Triggers from GitHub/Linear/Slack/PagerDuty/webhooks/schedules, cloud sandbox agents with MCP access, memory tool, template categories (security review, PR review, incident triage, routine maintenance). ADE adopts the template gallery pattern, trigger taxonomy, and memory-aware execution. ADE skips cloud sandbox execution (local-first) and does not use Linear as an automation trigger (CTO dispatch boundary).
- **Codex Agents SDK**: "Works unprompted" concept, skills system, multi-agent orchestration with PM agent, trace dashboard. ADE adopts the "works unprompted" framing for Night Shift, trace/history visibility, and multi-agent orchestration (CTO as PM agent equivalent).
- **CodexBar**: macOS menu bar usage tracker for Claude and Codex. ADE adopts the OAuth API polling pattern and pacing calculation, integrated into the Usage tab rather than a separate menu bar app.

## Canonical References

- [docs/features/CTO.md](CTO.md)
- [docs/features/AGENTS.md](AGENTS.md)
- [docs/features/MISSIONS.md](MISSIONS.md)
- [docs/architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md)
- [docs/architecture/CONTEXT_CONTRACT.md](../architecture/CONTEXT_CONTRACT.md)
- [docs/final-plan/phase-4.md](../final-plan/phase-4.md)
