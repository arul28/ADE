# Desktop application architecture

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

This document describes the Electron runtime in `apps/desktop`, with emphasis on the current startup contract, background-service model, and the safeguards that keep the app responsive while project services come online.

---

## Overview

ADE desktop is an Electron application with a strict trust split:

- **Main process**: trusted runtime for filesystem access, git, PTYs, SQLite, worker orchestration, AI execution, and background services
- **Renderer process**: untrusted React UI
- **Preload bridge**: typed IPC surface exposed as `window.ade`

All repository mutation and privileged execution happen in main-process services. The renderer only issues typed requests and renders state.

The current desktop runtime is built around a **quiet-first startup** contract:

1. Open the project and render a usable shell quickly.
2. Load the cheapest project state first.
3. Start background services in controlled stages.
4. Keep expensive or optional work off the critical path.
5. Emit enough structured logs to explain stalls without guesswork.

---

## Process model

### Main process

`apps/desktop/src/main/main.ts` owns project bootstrap, service creation, IPC registration, window lifecycle, and background task startup.

Main-process responsibilities include:

- project detection and switching
- `.ade` repair/bootstrap
- SQLite-backed local state
- lane/worktree orchestration
- PTY and transcript lifecycle
- git operations and conflict analysis
- missions and orchestrator runtime
- PR and GitHub/Linear integration services
- memory lifecycle, digest, and embedding services
- external MCP, OpenClaw, and automation ingress services

### Renderer process

The renderer in `apps/desktop/src/renderer` renders feature surfaces and delegates all privileged work through the preload API. It is treated as untrusted code and never reads the repo or spawns processes directly.

### Preload bridge

`apps/desktop/src/preload/preload.ts` exposes a typed `window.ade` contract. `contextIsolation` remains enabled and `nodeIntegration` remains disabled.

---

## Startup lifecycle

### Early process setup

Before ADE creates services or child processes, the main process normalizes the shell `PATH` and applies Electron runtime switches:

- `fixElectronShellPath()` repairs shell resolution on macOS and dev machines.
- Hardware acceleration is disabled in desktop dev by default (`ADE_DISABLE_HARDWARE_ACCEL=1` or `VITE_DEV_SERVER_URL`) to reduce dev-only GPU instability.
- Dev builds disable the renderer HTTP cache to avoid stale Vite optimized-dependency artifacts.

### Minimal project open

Project open and project switch intentionally avoid the old "hydrate everything now" behavior.

The renderer-side store now opens a project with:

- `refreshLanes({ includeStatus: false })`
- `refreshKeybindings()`
- deferred hydration scheduled later by `scheduleProjectHydration(...)`

The app shell follows the same pattern on initial boot:

- read stored project
- fetch lanes without status first
- fetch lane status later
- fetch provider mode later still

This keeps first paint and tab navigation cheap even on larger repos.

### Background service startup

Background startup is centralized through `scheduleBackgroundProjectTask(...)` in `main.ts`.

That helper is responsible for:

- per-task gating through `ADE_ENABLE_*` flags
- structured `project.startup_task_enabled`
- structured `project.startup_task_skipped`
- structured `project.startup_task_begin`
- structured `project.startup_task_done`
- duration logging per task

This made it possible to turn services back on one by one, verify them in isolation, and keep the app usable while the system was being hardened.

### Current dev stability contract

In dev stability mode, ADE no longer depends on one giant delayed startup blob. Instead, tasks are individually gated and started intentionally.

The current default dev-enabled background set includes:

- config reload
- usage tracking
- automation ingress
- external MCP startup
- OpenClaw bridge startup
- mission queue bootstrap
- team runtime recovery
- Linear sync
- Linear ingress
- memory startup sweep
- memory consolidation check
- embedding worker start
- human digest sync
- conflict prediction
- episodic summary enablement
- head watcher
- skill registry

Two details matter for stability:

- **Linear ingress** only auto-starts when its realtime relay/local webhook configuration is actually present.
- **Embedding worker** starts on a long delay and is no longer part of the first usable paint.

---

## Responsiveness and crash-resilience contract

The current desktop architecture relies on several guardrails that are now part of the runtime contract rather than temporary debugging scaffolding.

### Controlled background startup

Background services are no longer treated as "free." Each service has an explicit startup point, logs its timing, and can be isolated behind an env flag during debugging.

### Cheap initial lane hydration

Lane status computation is optional during initial project open. This prevents lane-heavy repos from blocking first interaction.

### Route-scoped renderer polling

Renderer polling now lives closer to the surfaces that need it:

- terminal attention only runs on terminal-adjacent routes
- session-list lookups are deduplicated through a shared renderer cache
- lane-scoped terminal panels only keep polling while they still have live sessions to watch

### Staged feature hydration

Several heavy surfaces now load in phases:

- CTO loads summary state first and defers team/settings-specific work
- Missions loads the list first and defers dashboard/settings/model metadata
- Graph loads topology first and then stages risk, activity, sync, and PR overlays
- PR workflows load queue/rehearsal state lazily instead of on every visit

### Explicit fallback behavior

Network- or config-dependent services now short-circuit instead of spinning:

- Linear sync skips cycles when there are no enabled workflows or no credentials and no active runs
- Linear ingress stays dormant when not configured
- idle/disconnected Linear does not keep burning CPU
- trivial session summaries are skipped instead of triggering unnecessary AI work

---

## IPC and observability

### Typed IPC

IPC channel constants live in `apps/desktop/src/shared/ipc.ts` and are registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`.

The preload bridge mirrors those channels into typed methods plus event subscription helpers.

### Structured tracing

IPC handlers now emit:

- `ipc.invoke.begin`
- `ipc.invoke.done`
- `ipc.invoke.failed`

Each entry includes a call ID, channel, window ID, duration, and summarized args/results.

The renderer also emits:

- `renderer.route_change`
- `renderer.tab_change`
- `renderer.window_error`
- `renderer.unhandled_rejection`
- `renderer.event_loop_stall`

This tracing is what turned the stability work from "the app feels bad" into isolated, actionable bottlenecks.

### React runtime behavior

Electron runtime rendering no longer wraps the app in `React.StrictMode`. Browser-mock development still uses Strict Mode, but Electron runtime behavior now matches real production invocation patterns more closely.

---

## Project switching

Project switching still rebuilds the active `AppContext`, but the runtime now does so with less renderer churn:

1. resolve the repo root
2. dispose project-scoped services
3. create the next context
4. keep IPC handlers stable via context indirection
5. let the renderer rehydrate in phases instead of forcing full eager refresh

---

## Shutdown and cleanup

Shutdown continues to be defensive and best-effort:

- stop head watcher and background timers
- dispose pollers and ingress services
- stop file watchers, tests, and managed processes
- dispose PTYs and agent chat sessions
- flush and close SQLite

Every cleanup step remains isolated by `try/catch` so one failing service does not block application exit.

---

## Current runtime status

The desktop runtime is now shaped around predictable startup and bounded background work instead of hidden deferred bursts.

Current architecture guarantees:

- the renderer becomes usable before all background services finish booting
- background services declare when they start, how long they took, and why they were skipped
- optional integrations stay dormant when not configured
- renderer polling is scoped and deduplicated instead of globally eager
- main-process services remain the only authority for repo mutation and system access

Future architecture work can now focus on product features and localized performance issues rather than app-wide crash triage.
