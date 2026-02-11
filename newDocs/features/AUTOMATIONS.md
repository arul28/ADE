# Automations — Trigger-Action Workflows

> Last updated: 2026-02-11

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

**Detail View** (click to expand): Editable trigger config, ordered action list
with drag-to-reorder, condition editor per action, execution history table, and
"Run Now" button.

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
| `automationService` | Planned | Parses rules from config, registers trigger listeners, evaluates conditions, dispatches action chains |
| `projectConfigService` | Exists | Provides automation definitions from YAML |
| `sessionService` | Exists | Fires `session-end` events |
| `gitOperationsService` | Exists | Will fire `commit` events |
| `packService` | Exists | Implements `update-packs` action |
| `ptyService` | Exists | Implements `run-command` action |

### IPC Channels

| Channel | Status | Payload |
|---------|--------|---------|
| `ade.automations.list()` | Planned | Returns `AutomationRule[]` with enabled state and last run info |
| `ade.automations.toggle(args)` | Planned | Enable/disable by ID: `{ id: string, enabled: boolean }` |
| `ade.automations.triggerManually(id)` | Planned | Fires automation immediately, returns async |
| `ade.automations.getHistory(id)` | Planned | Returns `AutomationRun[]` ordered by most recent |
| `ade.automations.getRunDetail(runId)` | Planned | Returns detailed run with per-action status |

### Component Architecture

```
AutomationsPage (route: /automations or embedded in ProjectHome)
  +-- AutomationList
  |    +-- AutomationRow (per rule)
  |         +-- TriggerBadge / ActionsSummary / LastRunIndicator / EnableToggle
  +-- AutomationDetail (expanded on click)
  |    +-- TriggerEditor / ActionListEditor / ExecutionHistory / ManualTriggerButton
  +-- CreateAutomationDialog
```

### Data Flow

**Startup**: Main process loads config. `automationService` reads the `automations`
array and registers trigger listeners: session-end subscribes to session events,
commit subscribes to git file watcher, schedule creates cron timers, manual needs
no listener.

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
- **Timeout**: Default 5 minutes per action; configurable via `timeout` field
- **Error handling**: Failed action stops pipeline unless `continueOnFailure: true`

---

## Data Model

### Database Tables

```sql
CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
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
    status TEXT NOT NULL,             -- 'running' | 'succeeded' | 'failed' | 'skipped'
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
`timeout`), and `enabled` (boolean).

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
  timeout?: number;
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
```

---

## Implementation Tracking

### Completed

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-001 | Core pipeline | Job engine handles session end, checkpoint, pack refresh | DONE |
| AUTO-002 | Job deduplication | Prevents duplicate jobs, coalesces rapid-fire triggers | DONE |

### Planned

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-003 | Automation rule schema | Define and validate `automations` section in config | TODO |
| AUTO-004 | Automation service | Parse rules, register trigger listeners | TODO |
| AUTO-005 | Session-end trigger | Subscribe to session events, dispatch rules | TODO |
| AUTO-006 | Commit trigger | Watch `.git/refs/heads/`, dispatch rules | TODO |
| AUTO-007 | Schedule trigger | Cron-based timer using `node-cron` | TODO |
| AUTO-008 | Update-packs action | Wire to pack service | TODO |
| AUTO-009 | Predict-conflicts action | Wire to conflict service (requires it) | TODO |
| AUTO-010 | Sync-to-mirror action | Wire to hosted agent service (requires it) | TODO |
| AUTO-011 | Run-tests action | Execute test suite by ID | TODO |
| AUTO-012 | Run-command action | Execute shell command via PTY service | TODO |
| AUTO-013 | Action chaining | Sequential execution with failure handling | TODO |
| AUTO-014 | Conditional execution | Evaluate conditions, skip when false | TODO |
| AUTO-015 | Automation management UI | List view with status and toggles | TODO |
| AUTO-016 | Enable/disable toggle | IPC + UI control, persisted to config | TODO |
| AUTO-017 | Manual trigger button | "Run Now" for immediate execution | TODO |
| AUTO-018 | Execution history display | Recent runs with expandable details | TODO |
| AUTO-019 | Automation run logging | Write run/action records to SQLite | TODO |
| AUTO-020 | Error handling and retry | Configurable retry, backoff, notifications | TODO |

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
- AUTO-009 depends on the future `conflictService`.
- AUTO-010 depends on the future hosted agent service.

---

*This document describes the Automations feature for ADE. It will be updated as
implementation progresses.*
