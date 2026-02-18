# Automations — Trigger-Action Workflows

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-16

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
- [User Experience](#user-experience)
  - [Configuration in YAML](#configuration-in-yaml)
  - [Automation Management UI](#automation-management-ui)
  - [Built-in Pipelines](#built-in-pipelines)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Component Architecture](#component-architecture)
  - [Data Flow](#data-flow)
  - [Execution Model](#execution-model)
- [Data Model](#data-model)
  - [Database Tables](#database-tables)
  - [Configuration Schema](#configuration-schema)
  - [TypeScript Interfaces](#typescript-interfaces)
- [Implementation Tracking](#implementation-tracking)
  - [NL-to-Rule Planner](#nl-to-rule-planner)
  - [Trust Model Enforcement](#trust-model-enforcement)

---

## Overview

Automations allow users to wire triggers (events) to actions (commands and
operations), enabling automated workflows within ADE. Developers can define rules
like "on session end, update packs and predict conflicts" or "on commit, run tests"
and let ADE execute them automatically.

The automation system builds on the existing job engine, which already implements
the core session-end pipeline (session end, checkpoint creation, pack refresh).
Automations generalize this into a user-configurable system where any supported
trigger can invoke any supported action, with conditional execution and chaining.

Automations are implemented and working as part of **Phase 8** (Automations + Onboarding + Packs V2).

### Roadmap Alignment (Final Plan)

Per `docs/final-plan.md`, Automations owns recurring/background execution policy, including:

- Night Shift presets (scheduled off-hours mission batches).
- Budget/time guardrails for unattended runs.
- Morning digest summaries and review queues.

Missions are ad-hoc goal objects and are documented in the Final Plan. Automations is not replaced by Missions; it remains the recurring trigger layer that can launch mission/orchestrator work.

---

## Core Concepts

### Triggers

A **Trigger** is an event that starts an automation.

| Type | Source | Description |
|------|--------|-------------|
| `session-end` | Session service | Fires when a terminal session completes |
| `commit` | Git file watcher | Fires when a new commit is detected on any lane's active branch |
| `schedule` | Node.js timer | Fires on a cron-like schedule (e.g., hourly) |
| `manual` | User action | Fires when the user clicks "Run Now" in the UI |

### Actions

An **Action** is an operation performed when a trigger fires.

| Type | Target Service | Description |
|------|---------------|-------------|
| `update-packs` | Pack service | Regenerates the pack snapshot for the affected lane |
| `sync-to-mirror` | Hosted agent | Pushes pack and metadata to the ADE hosted mirror |
| `predict-conflicts` | Conflict service | Runs pairwise conflict prediction across active lanes |
| `run-tests` | Test runner | Executes a test suite by ID (e.g., "unit") |
| `run-command` | PTY service | Executes an arbitrary shell command in the lane's worktree |

### Automation Rules

An **Automation Rule** pairs one trigger with one or more actions. Rules are defined
in `.ade/ade.yaml` (shared) or `.ade/local.yaml` (personal) and can be toggled on/off.

### Pipelines

A **Pipeline** is a chain of actions within a rule that execute in strict sequence.
If an action fails, subsequent actions are skipped unless `continueOnFailure` is set.
The existing job engine implements the core pipeline (session end to checkpoint to
pack refresh), which is always active and not user-configurable.

---

## User Experience

### Configuration in YAML

```yaml
automations:
  - id: "session-end-pipeline"
    name: "Session End Pipeline"
    trigger:
      type: "session-end"
    actions:
      - type: "update-packs"
      - type: "predict-conflicts"
      - type: "sync-to-mirror"
        condition: "hosted-enabled"
    enabled: true

  - id: "commit-tests"
    name: "Run Tests on Commit"
    trigger:
      type: "commit"
    actions:
      - type: "run-tests"
        suiteId: "unit"
    enabled: true

  - id: "scheduled-sync"
    name: "Hourly Mirror Sync"
    trigger:
      type: "schedule"
      cron: "0 * * * *"
    actions:
      - type: "sync-to-mirror"
    enabled: false

  - id: "post-commit-lint"
    name: "Lint on Commit"
    trigger:
      type: "commit"
    actions:
      - type: "run-command"
        command: "npm run lint -- --fix"
        cwd: "."
    enabled: true
```

### Automation Management UI

Accessible from Project Home or Settings. Provides visual management without
editing YAML directly.

**List View** columns:

| Column | Content |
|--------|---------|
| Name | Human-readable automation name |
| Trigger | Type with icon (clock, git icon, etc.) |
| Actions | Comma-separated action types |
| Last Run | Timestamp or "Never" |
| Status | Succeeded (green) / Failed (red) / Running (blue) / Never Run (gray) |
| Enabled | Toggle switch |

**Detail View** (click to expand): Editable trigger config (type selector, cron
input, branch filter), ordered action list with add/remove/reorder controls,
condition editor per action, and "Run Now" / "Delete" buttons.

**Execution History**: Each run logs run ID, timestamps, overall status, per-action
status, error messages, and duration.

### Built-in Pipelines

Always active, managed by the job engine, not user-configurable:

| Pipeline | Trigger | Actions |
|----------|---------|---------|
| Core session cleanup | Session end | Create checkpoint, Refresh lane pack |

Built-in pipelines run before user-configurable automations, ensuring core
functionality is always maintained.

---

## Technical Implementation

### Services

| Service | Status | Role |
|---------|--------|------|
| `jobEngine` | Exists | Core pipeline, job queuing, deduplication, coalescing |
| `automationService` | Exists | Parses rules from config, registers trigger listeners, evaluates conditions, dispatches action chains, persists run/action records to SQLite |
| `automationPlannerService` | Exists | NL-to-rule planner. Accepts natural language intent, generates structured automation drafts using Codex CLI (`codex exec -`) or Claude CLI (`claude --print`). Provides draft normalization, fuzzy test suite matching, confirmation requirements, and simulation preview. |
| `projectConfigService` | Exists | Provides automation definitions from YAML |
| `sessionService` | Exists | Fires `session-end` events |
| `gitOperationsService` | Exists | Emits head-change events when ADE performs git operations |
| `packService` | Exists | Implements `update-packs` action |
| `conflictService` | Exists | Implements `predict-conflicts` action |
| `hostedAgentService` | Exists | Implements `sync-to-mirror` action |
| `testService` | Exists | Implements `run-tests` action |
| `ptyService` | Exists | Provides `session-end` events via terminal session lifecycle |

### IPC Channels

| Channel | Status | Payload |
|---------|--------|---------|
| `ade.automations.list()` | Exists | Returns `AutomationRule[]` with enabled state and last run info |
| `ade.automations.toggle(args)` | Exists | Enable/disable by ID: `{ id: string, enabled: boolean }` |
| `ade.automations.triggerManually(id)` | Exists | Fires automation immediately, returns async |
| `ade.automations.getHistory(id)` | Exists | Returns `AutomationRun[]` ordered by most recent |
| `ade.automations.getRunDetail(runId)` | Exists | Returns detailed run with per-action status |
| `ade.automations.parseNaturalLanguage(args)` | Exists | Planner-powered rule draft from intent text |
| `ade.automations.validateDraft(args)` | Exists | Validates + normalizes draft, returns required confirmations |
| `ade.automations.saveDraft(args)` | Exists | Persists a validated rule into config |
| `ade.automations.simulate(args)` | Exists | Human-readable preview of actions/triggers |
| `ade.automations.event` | Exists | Push updates for run/history changes |

### Component Architecture

```
AutomationsPage (route: /automations or embedded in ProjectHome)
  +-- Rule list with search/filter (inline, not a separate component)
  |    +-- Per-rule row: name, trigger badge, actions summary, last run, enable toggle
  +-- RuleEditor (expanded on click, form-based editing)
  |    +-- Trigger config (type selector, cron input for schedule, branch filter for commit)
  |    +-- Action list editor (add/remove/reorder actions, condition per action)
  |    +-- "Run Now" button, "Delete" button
  +-- HistoryDialog (modal, shows runs + per-action detail for a rule)
  +-- CreateWithNaturalLanguageDialog (modal)
  |    +-- Intent text input
  |    +-- Provider selector (Codex / Claude)
  |    +-- Draft preview, confirmation checklist, simulation preview
  +-- ConfirmationsChecklist (inline, shown when NL draft requires confirmations)
  +-- Trust CTA banner (shown when shared config is untrusted)

SettingsPage > AutomationsSection (embedded summary)
  +-- Per-rule row with run-now, history, enable/disable toggle
```

### Data Flow

**Startup**: Main process loads config. `automationService` reads the `automations`
array and registers trigger listeners: session-end subscribes to session events,
commit fires from head-change detection (ADE git operations + lane head watcher),
schedule creates cron timers, manual needs no listener.

**Trigger Firing**: Event occurs. Service evaluates matching enabled rules. For each
match, creates an `AutomationRun` record (status: running). Actions execute
sequentially: evaluate condition, dispatch to service, wait for completion, record
result. If an action fails and `continueOnFailure` is not set, the pipeline stops.
Final status is written and an IPC event notifies the renderer.

**Manual Trigger**: User clicks "Run Now". Renderer calls `triggerManually(id)`.
Main creates a synthetic trigger event dispatched through normal execution flow.

### Execution Model

- **Sequential within a rule**: Actions execute one at a time, in order
- **Parallel across rules**: Multiple rules matching the same trigger run in parallel
- **Deduplication**: Re-triggered automations coalesce with running executions
- **Timeout**: Default 5 minutes (300,000 ms) per action; configurable via `timeoutMs` field
- **Retry**: Failed actions can retry with exponential backoff (400ms * 2^attempt); configurable via `retry` field (integer, number of retries)
- **Error handling**: Failed action stops pipeline unless `continueOnFailure: true`
- **Trust enforcement**: Automations refuse to execute when shared config is untrusted (requires `projectConfigService.confirmTrust()` first)
- **Safety checks**: `run-command` actions validate `cwd` is within the project root (`isWithinDir` check) before execution

### Condition Types

Actions support a `condition` field. The following condition strings are evaluated at runtime:

| Condition | Evaluates to `true` when |
|-----------|-------------------------|
| `hosted-enabled` | Provider mode is `hosted` and the hosted agent service is connected |
| `byok-enabled` | Provider mode is `byok` and an API key is configured |
| `provider-enabled` | Any AI provider (hosted or BYOK) is active |
| `lane-present` | A lane ID is available in the trigger context |
| `true` | Always (unconditional) |
| `false` | Never (effectively disables the action) |

---

## Data Model

### Database Tables

```sql
CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,         -- FK to projects table
    automation_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL,       -- 'session-end' | 'commit' | 'schedule' | 'manual'
    started_at TEXT NOT NULL,         -- ISO 8601
    ended_at TEXT,                    -- NULL while running
    status TEXT NOT NULL,             -- 'running' | 'succeeded' | 'failed' | 'cancelled'
    actions_completed INTEGER DEFAULT 0,
    actions_total INTEGER NOT NULL,
    error_message TEXT,
    trigger_metadata TEXT             -- JSON: session/commit/schedule context
);

CREATE INDEX idx_runs_automation ON automation_runs(automation_id);
CREATE INDEX idx_runs_started ON automation_runs(started_at);

CREATE TABLE automation_action_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES automation_runs(id),
    action_index INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,             -- 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
    error_message TEXT,
    output TEXT                       -- Captured stdout/stderr (truncated)
);

CREATE INDEX idx_results_run ON automation_action_results(run_id);
```

**`trigger_metadata` examples**: session-end includes `sessionId` and `laneId`;
commit includes `commitHash` and `branch`; schedule includes `scheduledAt`;
manual includes `triggeredBy: "user"`.

### Configuration Schema

The `automations` key in `.ade/ade.yaml` or `.ade/local.yaml` accepts an array of
rules. Each rule requires `id` (lowercase with hyphens), `name`, `trigger` (with
`type` and optional `cron`/`branch`), `actions` (array of action objects with
`type` and optional `suiteId`, `command`, `cwd`, `condition`, `continueOnFailure`,
`timeoutMs`, `retry`), and `enabled` (boolean).

### TypeScript Interfaces

```typescript
interface AutomationRule {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  enabled: boolean;
}

interface AutomationTrigger {
  type: 'session-end' | 'commit' | 'schedule' | 'manual';
  cron?: string;
  branch?: string;
}

interface AutomationAction {
  type: 'update-packs' | 'sync-to-mirror' | 'predict-conflicts'
      | 'run-tests' | 'run-command';
  suiteId?: string;
  command?: string;
  cwd?: string;
  condition?: string;
  continueOnFailure?: boolean;
  timeoutMs?: number;   // Per-action timeout in milliseconds (default: 300000 = 5 min)
  retry?: number;       // Number of retries on failure (exponential backoff: 400ms * 2^attempt)
}

interface AutomationRun {
  id: string;
  automationId: string;
  triggerType: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  actionsCompleted: number;
  actionsTotal: number;
  errorMessage?: string;
  triggerMetadata?: Record<string, unknown>;
}

// Extended type returned by automationService.list()
interface AutomationRuleSummary extends AutomationRule {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  running: boolean;
}
```

---

## Implementation Tracking

### Completed

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-001 | Core pipeline | Job engine handles session end, checkpoint, pack refresh | DONE |
| AUTO-002 | Job deduplication | Prevents duplicate jobs, coalesces rapid-fire triggers | DONE |

### Implemented (Phase 8)

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-003 | Automation rule schema | Define and validate `automations` section in config | DONE |
| AUTO-004 | Automation service | Parse rules, register trigger listeners | DONE |
| AUTO-005 | Session-end trigger | Subscribe to session events, dispatch rules | DONE |
| AUTO-006 | Commit trigger | Poll lane HEAD SHAs, dispatch rules | DONE |
| AUTO-007 | Schedule trigger | Cron-based timer using `node-cron` | DONE |
| AUTO-008 | Update-packs action | Wire to pack service | DONE |
| AUTO-009 | Predict-conflicts action | Wire to conflict service (can use existing conflict service from Phase 5) | DONE |
| AUTO-010 | Sync-to-mirror action | Wire to hosted agent service | DONE |
| AUTO-011 | Run-tests action | Execute test suite by ID | DONE |
| AUTO-012 | Run-command action | Execute shell command via `child_process` (non-interactive) | DONE |
| AUTO-013 | Action chaining | Sequential execution with failure handling | DONE |
| AUTO-014 | Conditional execution | Evaluate conditions, skip when false | DONE |
| AUTO-015 | Automation management UI | List view with status and toggles | DONE |
| AUTO-016 | Enable/disable toggle | IPC + UI control, persisted to config | DONE |
| AUTO-017 | Manual trigger button | "Run Now" for immediate execution | DONE |
| AUTO-018 | Execution history display | Recent runs with expandable details | DONE |
| AUTO-019 | Automation run logging | Write run/action records to SQLite | DONE |
| AUTO-020 | Error handling and retry | Configurable retry and backoff with history surfaced in UI | DONE |

### NL-to-Rule Planner (Phase 8)

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-021 | NL planner service | `automationPlannerService` accepts natural language intent and generates structured automation drafts | DONE |
| AUTO-022 | Codex CLI provider | Planner uses `codex exec -` to generate automation JSON from intent text | DONE |
| AUTO-023 | Claude CLI provider | Planner uses `claude --print` (headless) as alternative generation backend | DONE |
| AUTO-024 | Draft normalization | Normalizes generated drafts: lowercases IDs, validates trigger/action types, fuzzy-matches test suite IDs | DONE |
| AUTO-025 | Confirmation requirements | Flags dangerous actions (sync-to-mirror, run-command, certain permission flags) for explicit user confirmation | DONE |
| AUTO-026 | Simulation preview | `ade.automations.simulate(args)` renders a human-readable preview of what an automation would do | DONE |
| AUTO-027 | NL creation UI | `CreateWithNaturalLanguageDialog` with intent input, provider selector, draft preview, and confirmation checklist | DONE |

### Trust Model Enforcement (Phase 8)

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-028 | Trust gate for automation execution | Automations refuse to run when shared config is untrusted; UI shows trust CTA banner | DONE |
| AUTO-029 | Safety checks for run-command | `run-command` validates `cwd` is within project root via `isWithinDir` before execution | DONE |

### Dependency Notes

- AUTO-003 is prerequisite for AUTO-004.
- AUTO-004 is prerequisite for AUTO-005 through AUTO-007.
- AUTO-005/006/007 (triggers) can be developed in parallel.
- AUTO-008 through AUTO-012 (actions) can be developed in parallel.
- AUTO-013 depends on at least one action type being implemented.
- AUTO-014 depends on AUTO-013 (conditions evaluated during chain execution).
- AUTO-015 through AUTO-018 (UI) can be developed independently but need AUTO-004 for real data.
- AUTO-019 depends on AUTO-004 and AUTO-013.
- AUTO-020 depends on AUTO-013.
- AUTO-009 can use the existing `conflictService` implemented in Phase 5 (no additional dependency).
- AUTO-010 depends on the hosted agent/mirror service from **Phase 6** (Cloud Infrastructure).
- AUTO-021 through AUTO-027 (NL planner) depend on AUTO-004 for rule schema and AUTO-015 for UI integration.

---

*This document describes the Automations feature for ADE. The core job engine pipeline (AUTO-001, AUTO-002) is implemented, and Phase 8 adds user-configurable automation rules, triggers, actions, NL-to-rule planner, trust enforcement, and UI management.*
