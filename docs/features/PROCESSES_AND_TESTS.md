# Processes and Tests

Last updated: 2026-02-11

This spec defines Phase 2 for the Projects (Home) tab. The goal is a SoloTerm-like control plane for local development, with explicit process controls, stack buttons, and test suite buttons.

## 1. User Value

Make "run the app" deterministic:

- one place to view all project processes
- one-click start/stop/restart/kill for each process
- one-click stack buttons (backend/frontend/full)
- one-click test suite buttons with remembered status

## 2. Scope and Terminology

- Managed process:
  - named long-running command (for example API server, queue worker, frontend dev server, db proxy)
  - owned by ADE process service, not ad-hoc shell tabs
- Stack button (also called stack profile action):
  - named button that maps to a set of managed processes
  - examples: `Backend`, `Frontend`, `Full Stack`
- Test suite:
  - named command button for non-daemon commands (unit, lint, integration, e2e)
- Shared config:
  - committed to repo for team-wide default workflows
- Local config:
  - machine/user overrides not committed

## 3. UX Surface (Projects/Home Tab)

Projects (Home) must include these sections in order:

1. Project header
- repo name/path
- base branch
- open/change repo
- open `.ade/` folder

2. Stack controls row
- `Start all`
- `Stop all`
- configurable stack buttons (for example `Backend`, `Frontend`, `Full Stack`)
- each button displays aggregate status (`running`, `partial`, `stopped`, `error`)

3. Managed processes panel
- process list/table with:
  - name
  - status
  - readiness
  - PID
  - uptime
  - last exit code + ended time
  - ports (best-effort)
- per process actions:
  - `Start`
  - `Stop` (graceful)
  - `Restart`
  - `Kill` (force)
- a detail/log region for selected process:
  - live tail
  - pause autoscroll
  - search/filter
  - clear view (UI only)

4. Test suites panel
- named buttons
- per suite show:
  - last status
  - duration
  - last run time
- run controls:
  - `Run`
  - `Rerun`
  - optional `Stop` if still running

5. Config surface
- add/edit/remove processes
- add/edit/remove stack buttons
- add/edit/remove test suites
- write to `.ade/` config files

## 4. Functional Requirements (MVP)

### 4.1 Process Definitions

Each process definition must support:

- `id` (stable key)
- `name`
- `command` (argv form preferred)
- `cwd` (repo-relative or absolute)
- `env` (key/value overrides)
- `autostart` (boolean)
- `restart` policy (MVP: `never` or `on_crash`)
- `gracefulShutdownMs` (default 7000)
- optional `readiness` block:
  - `type: none | port | logRegex`
  - `port` (for port checks)
  - `pattern` (for regex checks)

### 4.2 Process Runtime Semantics

Required runtime states:

- `stopped`
- `starting`
- `running`
- `degraded` (running but readiness failed)
- `stopping`
- `exited`
- `crashed`

Action behavior:

- `Start` on running process: no-op
- `Stop`:
  - send graceful signal (`SIGTERM` on POSIX)
  - wait `gracefulShutdownMs`
  - escalate to `Kill` if still alive
- `Kill`:
  - immediate force terminate (`SIGKILL` on POSIX)
- `Restart`:
  - equivalent to `Stop` then `Start`

Logging:

- stdout/stderr captured to `.ade/logs/processes/<processId>.log`
- runtime stream available to renderer via IPC events
- renderer should not read arbitrary filesystem paths directly

### 4.3 Stack Buttons

Stack buttons are named commands that operate on process sets.

Each stack button definition must support:

- `id`
- `name`
- `processIds[]`
- optional `startOrder`:
  - `parallel` (default)
  - `dependency` (uses process-level `dependsOn`)

Required actions:

- `Start <stack button>`: starts only mapped processes
- `Stop <stack button>`: stops only mapped processes
- `Restart <stack button>` (optional UI in MVP, required API)

Global actions:

- `Start all`
- `Stop all`

### 4.4 Test Suites

Each suite definition must support:

- `id`
- `name`
- `command` (argv)
- `cwd`
- `env`
- optional `timeoutMs`
- optional `tags[]` (`unit`, `lint`, `integration`, `e2e`, `custom`)

Run behavior:

- run as foreground managed command (not daemon)
- capture output to `.ade/logs/tests/<suiteId>/<runId>.log`
- persist run summary:
  - `status`
  - `exitCode`
  - `durationMs`
  - `startedAt`, `endedAt`

### 4.5 Project Trust and Safety

- if shared config changes after git pull, ADE must require user confirmation before executing changed commands
- no shell interpolation of untrusted strings in renderer
- execution happens only in main process via explicit service calls

## 5. V1 Extensions (Post-MVP)

- file watch restart rules
- lane-specific process/test overrides
- process dependency graph visualization
- onboarding auto-detection wizard from `package.json`/`Makefile`/compose
- promote terminal command to managed process
- notifications for crashes/restarts
- Raycast/MCP control surface

## 6. Config Model (`.ade/`)

Recommended files:

- `.ade/ade.yaml` (shareable)
- `.ade/local.yaml` (machine-specific overrides)

Merge precedence:

1. `ade.yaml` baseline
2. `local.yaml` override

MVP schema sketch:

```yaml
version: 1
processes:
  - id: api
    name: API
    command: ["npm", "run", "dev:api"]
    cwd: "apps/api"
    env: {}
    autostart: false
    restart: on_crash
    gracefulShutdownMs: 7000
    readiness:
      type: port
      port: 3001

  - id: web
    name: Web
    command: ["npm", "run", "dev:web"]
    cwd: "apps/web"
    env: {}
    autostart: false
    restart: on_crash
    gracefulShutdownMs: 7000
    readiness:
      type: port
      port: 5173

stackButtons:
  - id: backend
    name: Backend
    processIds: ["api"]
  - id: frontend
    name: Frontend
    processIds: ["web"]
  - id: full
    name: Full Stack
    processIds: ["api", "web"]

testSuites:
  - id: unit
    name: Unit
    command: ["npm", "run", "test:unit"]
    cwd: "."
  - id: lint
    name: Lint
    command: ["npm", "run", "lint"]
    cwd: "."
```

## 7. Data Model Requirements (Local DB)

MVP requires these persisted entities:

- process definitions (resolved effective config snapshot)
- process runs/history
- process runtime state cache (for restart recovery UI)
- stack button definitions
- test suite definitions
- test run history

See `architecture/DATA_MODEL.md` for table sketches.

## 8. IPC Surface Requirements (Typed)

Channels should follow existing typed IPC conventions.

Required process IPC methods:

- `processes.listDefinitions()`
- `processes.listRuntime()`
- `processes.start({ processId })`
- `processes.stop({ processId })`
- `processes.restart({ processId })`
- `processes.kill({ processId })`
- `processes.startStack({ stackId })`
- `processes.stopStack({ stackId })`
- `processes.getLogTail({ processId, maxBytes })`
- `processes.onEvent(...)` for status transitions/log chunks

Required test IPC methods:

- `tests.listSuites()`
- `tests.run({ suiteId })`
- `tests.stop({ runId })` (optional in MVP UI, API should exist)
- `tests.listRuns({ suiteId?, limit? })`
- `tests.getLogTail({ runId, maxBytes })`
- `tests.onEvent(...)`

Required config IPC methods:

- `projectConfig.get()`
- `projectConfig.validate(candidate)`
- `projectConfig.save(candidate)`
- `projectConfig.diffAgainstDisk()`

## 9. Integration With Packs (Phase 3 dependency)

When packs are implemented:

- lane/project packs should reference last relevant test runs
- process crashes during sessions should be surfaced in known issues sections
- process/test artifacts should include stable references to log files and run IDs

## 10. Acceptance Criteria (Phase 2 Exit)

Phase 2 is complete only when all are true:

1. Processes
- user can define processes in config UI
- user can start/stop/restart/kill any process from Home tab
- status transitions are accurate and visible in under 1 second
- logs stream live and searchable

2. Stack buttons
- user can define at least three stack buttons (for example backend/frontend/full)
- each button starts/stops exactly its configured process set
- `Start all` and `Stop all` work across full project set

3. Test suites
- user can define suites and run from Home tab buttons
- last run status/duration/timestamp persist across restart
- suite logs are viewable after completion

4. Persistence and safety
- definitions persist in `.ade/` config + local DB cache
- command execution is main-process only
- trust prompt appears before running changed shared config

## 11. Development Checklist

MVP:

- [ ] `processService` core lifecycle (spawn/stop/restart/kill)
- [ ] process runtime event stream + persisted run records
- [ ] stack button engine (start/stop selected process sets)
- [ ] logs storage + log tail/search UI
- [ ] `testService` run flow + run history + logs
- [ ] config editor for processes/stack buttons/test suites
- [ ] trust confirmation flow for changed shared config

V1:

- [ ] readiness checks beyond port/log regex basics
- [ ] lane overrides
- [ ] onboarding suggestions
- [ ] promote terminal to managed process
- [ ] notifications and MCP/Raycast integrations
