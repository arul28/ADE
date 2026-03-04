# Run — Command Center

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-16

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Managed Process](#managed-process)
  - [Stack Button](#stack-button)
  - [Test Suite](#test-suite)
  - [Config Editor](#config-editor)
- [User Experience](#user-experience)
  - [Layout](#layout)
  - [Header](#header)
  - [Global Controls Bar](#global-controls-bar)
  - [Processes Section](#processes-section)
  - [Test Suites Section](#test-suites-section)
  - [Config Editor Section](#config-editor-section)
  - [Process Lifecycle](#process-lifecycle)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
- [Data Model](#data-model)
  - [Database Schema](#database-schema)
  - [Configuration Files](#configuration-files)
  - [Filesystem Artifacts](#filesystem-artifacts)
- [Implementation Tracking](#implementation-tracking)
  - [Phase 1 — Core Process Management (DONE)](#phase-1--core-process-management-done)
  - [Phase 2 — Test Suites (DONE)](#phase-2--test-suites-done)
  - [Phase 3 — Config Editor (DONE)](#phase-3--config-editor-done)
  - [Phase 4 — Real-Time Streaming & Keyboard (DONE)](#phase-4--real-time-streaming--keyboard-done)
  - [Phase 5 — Advanced Features (PARTIAL)](#phase-5--advanced-features-partial)
  - [Phase 6 — Run Tab Enhancements (PARTIAL)](#phase-6--run-tab-enhancements-partial)

---

## Overview

The **Run tab** (denoted by a ▶ play/pause icon in the nav rail) serves as the global command center for running everything related to your project. It functions as a SoloTerm-style process manager combined with a test runner, CI/CD sync engine, agent CLI tool registry, and configuration editor. The core idea: any command your development stack needs — from starting services to running tests to executing agent skills — should be one button press away.

This feature matters because modern projects depend on a constellation of background services — dev servers, databases, API gateways, watchers, compilers — that must be started, monitored, and stopped in concert. Without a centralized control plane, developers resort to scattered terminal tabs, manual startup scripts, and guesswork about which services are running. Project Home eliminates this friction by making every managed process, test suite, and configuration knob visible and controllable from one surface.

**Current status**: Core process management (Phases 1-4) is **fully implemented** — process spawning, lifecycle management, readiness checks, dependency resolution, stack buttons, test suites, config editor, keyboard shortcuts, and real-time streaming. Phase 5 (Advanced Features) is **partially complete** — restart policies, health monitoring, test suite tags, and config diff/export are done; environment variable editor and test result diff remain. Phase 6 (Run Tab Enhancements) is **partially complete** — the Run tab rename, lane selector, CI/CD scan/import/sync, and agent tools detection are done; AI-suggested run prompts, agent commands viewer/editor, and quick-launch are still TODO.

### Roadmap Alignment (Final Plan)

Per `docs/final-plan/README.md`, the Run/Play surface is the owner for execution-focused future work:

- Per-lane runtime isolation (deterministic ports, host routing, preview launch).
- Integration Sandbox flows for pre-merge combined-lane testing.
- Browser profile launch and runtime diagnostics.
- Execution entry points used by Missions/Orchestrator flows.

PR orchestration and stack landing remain owned by `PULL_REQUESTS.md`; conflict analysis and merge plans remain owned by `CONFLICTS.md`. Run owns the runtime/test execution substrate those flows depend on.

---

## Core Concepts

### Managed Process

A **managed process** is a long-running process defined in the project configuration file (`.ade/ade.yaml` or `.ade/local.yaml`). Examples include dev servers, databases, API services, file watchers, and build tools. Each managed process has:

- A **command** and optional **arguments** to spawn.
- An **environment** (inherited from the project, with optional overrides).
- A **working directory** (defaults to the project root).
- A **restart policy** governing automatic restart behavior.
- Optional **dependencies** on other processes (for ordered startup).
- Optional **readiness checks** to determine when the process is fully available.

### Stack Button

A **stack button** is a named group of processes that start and stop together in a defined order. For example, a "Backend" stack might start the database first, then the API server, then the worker. Stack buttons appear as prominent controls in the global controls bar.

Stack buttons respect dependency ordering: if process B depends on process A, pressing the "Start" stack button will start A first, wait for readiness (if configured), then start B.

### Test Suite

A **test suite** is a non-daemon command that runs tests and reports results. Unlike managed processes, test suites are ephemeral — they run to completion and produce a pass/fail outcome. Each suite has:

- A **command** to execute (e.g., `npm test`, `pytest`, `cargo test`).
- A **timeout** (maximum allowed duration before forced termination).
- A **last run status** (passed, failed, or never-run).
- A **run history** showing previous executions with timestamps and outcomes.

### Config Editor

The **config editor** provides in-app editing of ADE configuration files. ADE uses two configuration files:

- **`.ade/ade.yaml`** (shared): Committed to version control. Defines processes, test suites, stack buttons, and project-level settings shared across the team.
- **`.ade/local.yaml`** (local): Gitignored. Contains user-specific overrides such as custom ports, local-only processes, or personal environment variables.

The config editor includes YAML syntax highlighting, inline validation, and a trust model for shared configuration changes.

### Lane Selector

Commands and tests execute in a specific working directory — and in ADE, that means a specific lane's worktree. The Run tab includes a **lane selector** at the top of the page (below the global controls bar) that determines the execution context:

- **Default**: The currently selected lane from the Lanes tab (synced via the global `selectedLaneId` in the Zustand store)
- **Override**: A dropdown allowing the user to pick any active lane, or "Primary" for the main repo directory
- **Indicator**: The selected lane name is shown prominently: "Running in: `feature/auth`" with a colored dot matching the lane status

When a user starts a process, runs a test, or executes an agent command, it runs in the selected lane's worktree directory. This makes the Run tab lane-agnostic — it can control any lane without switching tabs.

### AI-Suggested Run Prompts

ADE's agent can analyze repository changes and automatically suggest new run buttons. Suggestions appear as a "Suggested" section in the Run tab with a sparkle (✨) indicator:

**Trigger conditions**:
- A merge or PR introduces new dependencies (new entries in `package.json`, `Cargo.toml`, etc.) → suggest "Install Dependencies"
- A new test file or test suite is detected (e.g., `*.test.ts`, `*.spec.py`) → suggest a "Run [suite name]" button
- A new CI workflow file appears (`.github/workflows/*.yml`) → suggest importing its jobs as run buttons
- A new service or entry point is detected (e.g., `Dockerfile`, `docker-compose.yml`, new `bin/` script) → suggest a process definition

**User flow**: Suggestions appear as cards with "Add to Run Tab" and "Dismiss" buttons. Adding a suggestion creates the appropriate process, test, or stack button definition in the config.

### CI/CD Workflow Sync

ADE can import run definitions from CI/CD pipeline files, keeping your local run buttons in sync with what your CI does:

**Supported sources**:
- `.github/workflows/*.yml` (GitHub Actions)
- `.gitlab-ci.yml` (GitLab CI)
- `Jenkinsfile` (Jenkins)
- `.circleci/config.yml` (CircleCI)

**Import flow**:
1. User clicks "Scan CI" in the Run tab header (or during onboarding)
2. ADE parses the workflow file(s) and extracts jobs/steps
3. Each job is presented as a suggested run button (e.g., "lint", "test", "build", "deploy-staging")
4. User selects which jobs to import; ADE creates process or test definitions in config
5. Optional: Enable "CI Sync" to automatically detect changes to workflow files and suggest updated run buttons

**Execution note**: CI jobs often run in Docker containers or specific environments. ADE extracts the command portion and runs it locally in the selected lane. Environment-specific steps (like cloud deployments) are flagged as "CI-only" and shown but not runnable locally.

### Agent CLI Tools

ADE provides a registry of **agent CLI tools** — the major AI coding assistants that developers use alongside ADE:

| Tool | CLI Command | Skills/Commands Support |
|------|------------|------------------------|
| **Claude Code** | `claude` | Custom slash commands, skills, MCP servers |
| **Codex** | `codex` | Prompts, tools, custom instructions |
| **Cursor** | `cursor` | Rules, .cursorrules files |
| **Aider** | `aider` | Conventions, architect mode |
| **Continue** | `continue` | Custom slash commands, context providers |

The Agent Tools section in the Run tab:
- **Detects installed CLI tools** by checking PATH and common install locations
- **Shows each tool's commands and skills**: For Claude Code, reads `.claude/commands/` and installed skills. For Codex, reads custom prompts. Etc.
- **Allows editing**: Users can view and edit agent tool configurations directly (e.g., add a new Claude Code slash command, edit a Codex prompt)
- **Quick launch**: Each tool has a "Launch in Terminal" button that opens a tracked session with that tool in the selected lane's worktree
- **Tool type tagging**: When a terminal is launched via an agent tool button, the session is automatically tagged with the tool type (feeds into TERM-026 tool type detection)

---

## User Experience

### Layout

The Run page uses `PaneTilingLayout` with four resizable panes (overview, processes, tests, config). The layout is user-customizable with drag-to-resize gutters:

```
+-------------------------------------------------------------------+
| Header: Project Name | Base Ref | Running in: [feature/auth ▼]   |
+-------------------------------------------------------------------+
| Global Controls: [Start All] [Stop All] | [Backend] [Frontend]    |
+-------------------------------------------------------------------+
| Processes                                                         |
| +---------------------------------------------------------------+ |
| | Name        | Status    | Ready | PID    | Uptime  | Ports    | |
| |-------------|-----------|-------|--------|---------|----------| |
| | api-server  | ● Running | Ready | 12345  | 2h 14m  | 3000     | |
| | database    | ● Running | Ready | 12340  | 2h 15m  | 5432     | |
| | worker      | ○ Stopped |  —    |   —    |   —     |   —      | |
| +---------------------------------------------------------------+ |
| [Process Log Viewer — scrollable output with search]              |
+-------------------------------------------------------------------+
| Test Suites                                                       |
| +---------------------------------------------------------------+ |
| | Suite         | Last Run         | Status  | [Run] [Stop]     | |
| |---------------|------------------|---------|------------------| |
| | unit-tests    | 2026-02-11 14:30 | Passed  | [Run]            | |
| | integration   | 2026-02-11 13:00 | Failed  | [Run]            | |
| | e2e           | Never            |   —     | [Run]            | |
| +---------------------------------------------------------------+ |
| [Test Log Viewer — output with search]                            |
+-------------------------------------------------------------------+
| Config Editor                                                     |
| +---------------------------------------------------------------+ |
| | [ade.yaml] [local.yaml]                                       | |
| |                                                                | |
| | (YAML editor with syntax highlighting)                        | |
| |                                                                | |
| | [Save] | Validation: No errors                                | |
| +---------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

### Header

The header bar spans the full width and contains:

- **Project name**: The name of the currently open project.
- **Base ref**: The default base branch (e.g., `main`, `develop`).
- **Open Repo button**: Opens the repository root in Finder/Explorer.
- **Open .ade button**: Opens the `.ade/` directory in Finder/Explorer.
- **Theme toggle**: Switch between dark and light mode (applies globally).

### Global Controls Bar

Located below the header, the global controls bar provides bulk process management:

- **Start All**: Starts all defined processes in dependency order.
- **Stop All**: Gracefully stops all running processes (SIGTERM, then SIGKILL after timeout).
- **Stack buttons**: One button per defined stack. Each shows the stack name and current aggregate status (all running, partially running, all stopped). Clicking toggles the stack on/off.

### Processes Section

The processes section displays a table of all managed processes defined in the configuration.

**Table columns**:

| Column | Description |
|--------|-------------|
| Name | Process name as defined in config |
| Status | Color-coded status indicator |
| Ready | Readiness state based on configured checks |
| PID | OS process ID (when running) |
| Uptime | Duration since process started |
| Ports | Listening ports (when applicable) |

**Status colors**:

| Color | State | Meaning |
|-------|-------|---------|
| Green | Running | Process is alive and healthy |
| Yellow | Starting / Degraded | Process is starting up or readiness checks are failing |
| Red | Crashed | Process exited unexpectedly with non-zero exit code |
| Gray | Stopped | Process is not running |

**Interactions**:
- Click a process row to focus it and show its log viewer below the table.
- Per-process action buttons: **Start**, **Stop**, **Restart**, **Kill** (SIGKILL, for unresponsive processes).

**Process Log Viewer**:
- Scrollable output panel showing stdout and stderr from the focused process.
- Auto-scroll to bottom (toggleable).
- Search/filter bar to find specific log lines.
- Log lines are captured to disk at `.ade/process-logs/<proc>.log`.

### Test Suites Section

The test suites section lists all defined test suites with their run history and controls.

**Suite rows show**:
- Suite name
- Last run timestamp
- Status badge: **Passed** (green), **Failed** (red), **Running** (yellow spinner), **Never** (gray)
- Action buttons: **Run** (or **Rerun**), **Stop** (if running)

**Interactions**:
- Click a suite row to show its run history in a sidebar panel.
- Run history shows each past execution with: timestamp, duration, status, exit code.
- Selecting a run shows its log output.

**Test Log Viewer**:
- Similar to the process log viewer but scoped to the selected test run.
- Includes full stdout/stderr output.
- Failed test output is highlighted for quick identification.

### Config Editor Section

The config editor provides a tabbed YAML editing interface.

**Tabs**:
- **ade.yaml** (shared): Team configuration, committed to version control.
- **local.yaml** (local): Personal overrides, gitignored.

**Editor features**:
- YAML syntax highlighting with proper indentation handling.
- Inline validation: Errors and warnings are displayed as annotations on the relevant lines.
- Schema-aware: The editor understands the ADE config schema and can flag unknown keys, type mismatches, and missing required fields.

**Save workflow**:
1. User edits configuration.
2. Inline validation runs continuously, showing errors in real-time.
3. User clicks **Save**.
4. If editing shared config (`ade.yaml`), a **trust confirmation dialog** appears explaining that shared config affects all team members.
5. Config is written to disk.
6. Affected services are notified to reload configuration.

### Process Lifecycle

Managed processes follow a well-defined state machine:

```
stopped ──► starting ──► running ──► stopping ──► exited
                │            │                       │
                │            ▼                       │
                │        degraded                    │
                │                                    │
                └────────────────────────► crashed ◄─┘
```

**States**:

| State | Description |
|-------|-------------|
| `stopped` | Process is not running. Initial state. |
| `starting` | Process has been spawned but readiness checks have not passed yet. |
| `running` | Process is alive and readiness checks are passing. |
| `degraded` | Process is alive but readiness checks are failing. |
| `stopping` | SIGTERM has been sent, waiting for graceful shutdown. |
| `exited` | Process terminated normally (exit code 0). |
| `crashed` | Process terminated abnormally (non-zero exit code). |

**Readiness checks**:
- **Port check**: Periodically attempt a TCP connection to the configured port.
- **Log regex**: Watch stdout for a line matching a configured regular expression (e.g., "Server listening on port").

**Restart policies** (`ProcessRestartPolicy`):
- `never`: Do not restart automatically (default).
- `on-failure`: Restart automatically if the process exits with a non-zero code (with backoff).
- `on_crash`: Alias for `on-failure` — restart on non-zero exit.
- `always`: Restart automatically on any exit (with backoff).

**Dependencies**: Processes can declare dependencies on other processes. When starting, ADE resolves the dependency graph and starts processes in topological order, waiting for each dependency's readiness before starting its dependents.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `j` / `k` | Navigate up/down in process or suite list |
| `s` | Start selected process/suite |
| `x` | Stop selected process/suite |
| `r` | Restart selected process / Rerun selected suite |
| `Enter` | Focus/expand selected row |
| `Escape` | Collapse/unfocus |

---

## Technical Implementation

### Services

| Service | Responsibility |
|---------|---------------|
| `processService` | Spawns and monitors managed processes using Node.js `child_process`. Performs readiness checks (port probe, log regex). Captures stdout/stderr to log files at `.ade/process-logs/`. Manages lifecycle state transitions. Handles dependency resolution for ordered startup. |
| `testService` | Spawns test commands as ephemeral child processes. Tracks status (running, passed, failed). Enforces timeouts with forced termination. Captures output to `.ade/test-logs/`. Maintains run history. |
| `projectConfigService` | Reads, validates, and saves YAML configuration files. Merges shared and local configs (local overrides shared). Implements the trust model for shared config modifications. Notifies other services when config changes. |

### IPC Channels

**Process management**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.processes.listDefinitions` | `() => ProcessDefinition[]` | List all process definitions from config |
| `ade.processes.listRuntime` | `() => ProcessRuntime[]` | List all processes with current runtime state |
| `ade.processes.start` | `(args: { processId: string }) => ProcessRuntime` | Start a specific process |
| `ade.processes.stop` | `(args: { processId: string }) => ProcessRuntime` | Gracefully stop a process |
| `ade.processes.restart` | `(args: { processId: string }) => ProcessRuntime` | Stop then start a process |
| `ade.processes.kill` | `(args: { processId: string }) => ProcessRuntime` | Forcefully kill a process (SIGKILL) |
| `ade.processes.startStack` | `(args: { stackName: string }) => void` | Start all processes in a stack (ordered) |
| `ade.processes.stopStack` | `(args: { stackName: string }) => void` | Stop all processes in a stack |
| `ade.processes.restartStack` | `(args: { stackName: string }) => void` | Restart all processes in a stack |
| `ade.processes.startAll` | `() => void` | Start all defined processes |
| `ade.processes.stopAll` | `() => void` | Stop all running processes |
| `ade.processes.getLogTail` | `(args: { processId: string, lines?: number }) => string` | Get recent log output |

**Process events** (streamed via `ade.processes.event`):
- `log-line`: New log output from a process.
- `state-change`: Process transitioned to a new lifecycle state.
- `readiness-change`: Readiness check result changed.

**Test management**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.tests.listSuites` | `() => TestSuiteDefinition[]` | List all test suite definitions |
| `ade.tests.run` | `(args: { suiteId: string }) => TestRunSummary` | Run a test suite |
| `ade.tests.stop` | `(args: { suiteId: string }) => void` | Stop a running test suite |
| `ade.tests.listRuns` | `(args: { suiteId: string }) => TestRunSummary[]` | List run history for a suite |
| `ade.tests.getLogTail` | `(args: { runId: string, lines?: number }) => string` | Get log output for a specific run |

**Test events** (streamed via `ade.tests.event`):
- `log-line`: New test output.
- `state-change`: Test run started, passed, failed, or was cancelled.

**Config management**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.projectConfig.get` | `() => ProjectConfig` | Get merged project configuration |
| `ade.projectConfig.validate` | `(args: { content: string, file: 'shared' \| 'local' }) => ValidationResult` | Validate YAML content |
| `ade.projectConfig.save` | `(args: { content: string, file: 'shared' \| 'local' }) => void` | Save config to disk |
| `ade.projectConfig.diffAgainstDisk` | `() => ConfigDiff` | Show unsaved changes vs disk |
| `ade.projectConfig.confirmTrust` | `() => void` | Confirm trust for shared config changes |

**CI/CD sync**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.ci.scan` | `() => CiScanResult` | Scan for CI/CD workflow files (GitHub Actions, GitLab CI, CircleCI, Jenkins) and parse jobs with safety classification |
| `ade.ci.import` | `(args: { jobs: CiJobImport[], mode: 'import' \| 'sync' }) => void` | Import or sync selected CI jobs as process/test definitions. Sync mode updates existing definitions. |

**Agent tools**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.agentTools.detect` | `() => AgentTool[]` | Detect installed agent CLI tools (Claude Code, Codex, Cursor, Aider, Continue) |

*Note*: `getCommands` and `launch` channels are planned (PROJ-039, PROJ-041) but not yet registered.

**AI suggestions**:

*Note*: AI suggestion channels (`ade.suggestions.*`) are planned (PROJ-035, PROJ-042) but not yet registered.

---

## Data Model

### Database Schema

```sql
process_runs (
  id              TEXT PRIMARY KEY,       -- UUID
  project_id      TEXT NOT NULL,          -- FK to projects table
  process_id      TEXT NOT NULL,          -- Process name/ID from config
  started_at      TEXT NOT NULL,          -- ISO 8601 timestamp
  ended_at        TEXT,                   -- ISO 8601 timestamp, NULL if still running
  status          TEXT NOT NULL,          -- 'running' | 'exited' | 'crashed'
  exit_code       INTEGER,               -- Exit code, NULL if still running
  FOREIGN KEY (project_id) REFERENCES projects(id)
)

test_runs (
  id              TEXT PRIMARY KEY,       -- UUID
  project_id      TEXT NOT NULL,          -- FK to projects table
  suite_id        TEXT NOT NULL,          -- Test suite name/ID from config
  started_at      TEXT NOT NULL,          -- ISO 8601 timestamp
  ended_at        TEXT,                   -- ISO 8601 timestamp, NULL if still running
  status          TEXT NOT NULL,          -- 'running' | 'passed' | 'failed' | 'cancelled'
  exit_code       INTEGER,               -- Exit code, NULL if still running
  duration_ms     INTEGER,               -- Total duration in milliseconds
  FOREIGN KEY (project_id) REFERENCES projects(id)
)
```

### Configuration Files

| File | Scope | Version Controlled | Description |
|------|-------|-------------------|-------------|
| `.ade/ade.yaml` | Shared | Yes | Team-wide process definitions, test suites, stack buttons, and settings |
| `.ade/local.yaml` | Local | No (gitignored) | Personal overrides for ports, environment variables, additional processes |

### Filesystem Artifacts

| Path | Description |
|------|-------------|
| `.ade/process-logs/<proc>.log` | Captured stdout/stderr for each managed process |
| `.ade/test-logs/<suite>.log` | Captured output for the most recent test run of each suite |
| `.ade/test-logs/<suite>-<run-id>.log` | Archived output for historical test runs |

---

## Implementation Tracking

### Phase 1 — Core Process Management (DONE)

| ID | Task | Status |
|----|------|--------|
| PROJ-001 | Project home page layout (header, sections) | DONE |
| PROJ-002 | Process definitions from config | DONE |
| PROJ-003 | Process spawning and lifecycle management | DONE |
| PROJ-004 | Process status display (color-coded) | DONE |
| PROJ-005 | Process readiness checks (port, log regex) | DONE |
| PROJ-006 | Process dependency resolution and ordered start | DONE |
| PROJ-007 | Process log capture and viewer | DONE |
| PROJ-008 | Process log search/filter | DONE |
| PROJ-009 | Start/Stop/Restart/Kill per process | DONE |
| PROJ-010 | Start All / Stop All | DONE |
| PROJ-011 | Stack buttons (named process groups) | DONE |
| PROJ-012 | Stack button start/stop/restart | DONE |

### Phase 2 — Test Suites (DONE)

| ID | Task | Status |
|----|------|--------|
| PROJ-013 | Test suite definitions from config | DONE |
| PROJ-014 | Test execution with status tracking | DONE |
| PROJ-015 | Test timeout and cancellation | DONE |
| PROJ-016 | Test log capture and viewer | DONE |
| PROJ-017 | Test run history per suite | DONE |

### Phase 3 — Config Editor (DONE)

| ID | Task | Status |
|----|------|--------|
| PROJ-018 | Config editor (YAML with syntax highlighting) | DONE |
| PROJ-019 | Config validation (inline errors) | DONE |
| PROJ-020 | Config save | DONE |
| PROJ-021 | Shared/Local config toggle | DONE |
| PROJ-022 | Trust confirmation for shared config | DONE |

### Phase 4 — Real-Time Streaming & Keyboard (DONE)

| ID | Task | Status |
|----|------|--------|
| PROJ-023 | Keyboard shortcuts (j/k/s/x/r) | DONE |
| PROJ-024 | Real-time process event streaming | DONE |
| PROJ-025 | Real-time test event streaming | DONE |

### Phase 5 — Advanced Features (PARTIAL)

| ID | Task | Status |
|----|------|--------|
| PROJ-026 | Process restart policies (never, on-failure, always, on_crash) | DONE |
| PROJ-027 | Process health monitoring (periodic readiness re-checks, degraded state) | DONE |
| PROJ-028 | Process environment variable editor | TODO |
| PROJ-029 | Test suite tags and filtering (unit, lint, integration, e2e, custom) | DONE |
| PROJ-030 | Test result diff (compare runs) | TODO |
| PROJ-031 | Config diff viewer (diffAgainstDisk IPC) | DONE |
| PROJ-032 | Config export (projectExportConfig IPC) | DONE |

### Phase 6 — Run Tab Enhancements (PARTIAL)

| ID | Task | Status |
|----|------|--------|
| PROJ-033 | Tab rename to "Run" with play/pause nav icon | DONE |
| PROJ-034 | Lane selector for command execution context | DONE |
| PROJ-035 | AI-suggested run prompts (detect new suites/apps/services on merge) | TODO |
| PROJ-036 | CI/CD workflow scan and import (GitHub Actions, GitLab CI, CircleCI, Jenkins) | DONE |
| PROJ-037 | CI/CD sync mode (computeCiScanDiff for detecting workflow changes, import vs sync modes) | DONE |
| PROJ-038 | Agent CLI tools detection (agentToolsDetect IPC) | DONE |
| PROJ-039 | Agent commands and skills viewer (read .claude/commands/, etc.) | TODO |
| PROJ-040 | Agent command editing (add/edit/delete commands and skills in-app) | TODO |
| PROJ-041 | Agent tool quick-launch (open tracked terminal with tool in selected lane) | TODO |
| PROJ-042 | Run prompt suggestion cards UI (accept/dismiss flow) | TODO |

### Preview URL Management (Planned)

The Project Home dashboard will surface preview URLs for active lanes:

- **Preview URL Column**: Each lane row shows its preview URL (if proxy is enabled)
- **Quick Launch**: Click to open preview in browser (uses isolated browser profile if configured)
- **Copy Link**: Copy preview URL to clipboard for sharing
- **Compute Backend Status**: Visual indicator showing which backend each lane is running on:
  - Local (default)
  - VPS (remote)
  - Daytona (cloud sandbox)

**Daytona Sandbox Management** (when configured):
- View active Daytona workspaces
- Start/stop workspaces from the dashboard
- Monitor resource usage (CPU, RAM, disk)
