# Desktop Application Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-18

This document describes the Electron desktop runtime in `apps/desktop`, including process boundaries, service initialization, IPC contracts, and lifecycle behavior.

---

## Table of Contents

1. [Overview](#overview)
2. [Process Model](#process-model)
3. [Main Process Service Graph](#main-process-service-graph)
4. [IPC Contract and Preload](#ipc-contract-and-preload)
5. [Project Switching](#project-switching)
6. [Shutdown and Cleanup](#shutdown-and-cleanup)
7. [Implementation Status](#implementation-status)

---

## Overview

ADE desktop is an Electron app with a strict trust split:

- Main process: trusted runtime for filesystem, git, PTY, process execution, and SQLite state.
- Renderer process: untrusted React UI.
- Preload bridge: typed IPC surface (`window.ade`) between renderer and main.

All repository mutation and command execution happens in main-process services.

---

## Process Model

### Main Process (trusted)

`apps/desktop/src/main/main.ts` bootstraps project context, service instances, IPC registration, and lifecycle handlers.

Main-process responsibilities:

- Project root detection and switching
- `.ade` directory/bootstrap management
- SQLite (`kvDb`) and local state persistence
- Lane/worktree orchestration
- PTY session lifecycle and transcript capture
- Git operations and conflict-state handling
- Packs/checkpoints/events/versioning pipeline
- Automations and job engine execution
- Process/test runners
- Hosted/BYOK integrations

### Renderer Process (untrusted)

React SPA in `apps/desktop/src/renderer` renders product surfaces and forwards all privileged actions through preload APIs.

### Preload Bridge

`apps/desktop/src/preload/preload.ts` exposes a typed `window.ade` API. Renderer has `contextIsolation: true` and `nodeIntegration: false`.

---

## Main Process Service Graph

`AppContext` (defined in `registerIpc.ts`) aggregates service instances for the active project and is swapped during project changes.

Core service groups:

- Project/context bootstrapping: project service, config service, keybindings, terminal profiles, agent tools, onboarding, CI
- Core execution: lane/session/pty/file/diff/git/process/test/history
- Context and risk systems: pack service, conflict service, restack suggestion service, auto-rebase service, job engine
- Integrations: hosted agent service, BYOK service, GitHub service, PR service + polling
- Automation: automation service + automation planner service

Additional runtime loops:

- Head watcher loop to detect out-of-band git HEAD changes
- Event broadcasters for renderer subscriptions

---

## IPC Contract and Preload

IPC channel constants live in `apps/desktop/src/shared/ipc.ts` and are registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`.

As of 2026-02-18, the contract includes `225` channels spanning app/project, lanes, sessions/pty, files/git, conflicts/context/packs, PRs/github/hosted, automations, layout/graph, processes/tests, and settings/config domains.

High-frequency/broadcast event channels include:

- `ade.pty.data`
- `ade.pty.exit`
- `ade.files.change`
- `ade.processes.event`
- `ade.tests.event`
- `ade.conflicts.event`
- `ade.packs.event`
- `ade.prs.event`
- `ade.automations.event`
- `ade.lanes.restackSuggestions.event`
- `ade.lanes.autoRebase.event`
- `ade.project.missing`

The preload layer mirrors these domains into typed methods and event subscription helpers for renderer use.

---

## Project Switching

ADE supports runtime repository switching.

Switch flow:

1. Resolve selected path to repo root and base ref.
2. Dispose active context services (watchers, pollers, processes, PTYs, db handles).
3. Reinitialize `AppContext` for the new root.
4. Keep IPC handlers stable via `getCtx()` indirection (handlers always read latest context).
5. Update recent-project registry in global state.

This keeps the app process alive while replacing all project-scoped services.

---

## Shutdown and Cleanup

On `before-quit`, ADE performs defensive cleanup (each step isolated by try/catch):

- Stop head watcher
- Dispose polling and automation/job loops
- Dispose file watchers
- Stop tests and managed processes
- Dispose PTY sessions
- Flush and close SQLite

Uncaught exception and unhandled rejection handlers log structured errors through the main logger.

---

## Implementation Status

Desktop architecture is mature and production-oriented for current scope:

- Service-factory composition and dependency injection are implemented.
- Project switching is implemented with full context teardown/rebuild.
- Broad typed IPC contract is implemented and actively used by renderer surfaces.
- Security boundaries (`contextIsolation`, preload-only IPC surface) are enforced.
- Head-change and session-end pipelines keep packs/conflicts/automations synchronized.

Future architecture expansion (Missions, Machines, relay transport, core extraction) is tracked in `docs/final-plan.md`.
