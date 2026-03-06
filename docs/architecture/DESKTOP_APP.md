# Desktop Application Architecture

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-05

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
- Mission lifecycle state and intervention tracking
- Agents (automation, Night Shift, watcher, review) and job engine execution
- Process/test runners
- AI integration (AgentExecutor interface, dual SDK, MCP server)
- Agent chat service (Codex App Server, Claude multi-turn, and unified API/local model chat sessions)

### Renderer Process (untrusted)

React SPA in `apps/desktop/src/renderer` renders product surfaces and forwards all privileged actions through preload APIs.

### Preload Bridge

`apps/desktop/src/preload/preload.ts` exposes a typed `window.ade` API. Renderer has `contextIsolation: true` and `nodeIntegration: false`.

---

## Main Process Service Graph

`AppContext` (defined in `registerIpc.ts`) aggregates service instances for the active project and is swapped during project changes.

Core service groups:

- **Project/context bootstrapping**: project service, config service, keybindings, terminal profiles, agent tools, onboarding, CI
- **Core execution**: lane/session/pty/file/diff/git/process/test/history
- **Context and risk systems**: pack service (decomposed: `packService.ts` core + `projectPackBuilder.ts`, `missionPackBuilder.ts`, `conflictPackBuilder.ts`, `packUtils.ts`) for remaining compatibility exports, plus `contextDocService.ts`, `sessionDeltaService.ts`, conflict service, rebase suggestion service, auto-rebase service, job engine
- **AI Integration**: AI integration service (unified executor, `modelId`-first routing), AI orchestrator service (decomposed: `aiOrchestratorService.ts` core + `chatMessageService.ts`, `workerDeliveryService.ts`, `workerTracking.ts`, `missionLifecycle.ts`, `recoveryService.ts`, `modelConfigResolver.ts`, `orchestratorContext.ts`), orchestrator service (decomposed: `orchestratorService.ts` core + `orchestratorQueries.ts`, `stepPolicyResolver.ts`, `orchestratorConstants.ts`), MCP server, GitHub service, PR service + polling, models.dev service (dynamic pricing/capabilities), middleware (logging, retry, cost guard, reasoning extraction), provider options (tier passthrough), universal tools (API-key/local model support). See `docs/ORCHESTRATOR_OVERHAUL.md` for runtime contracts.
- **Agent Chat**: agent chat service (CodexChatBackend via App Server JSON-RPC, ClaudeChatBackend via community provider multi-turn, unified runtime for API-key/local models with permission modes, persisted as `codex-chat` / `claude-chat` / `ai-chat` sessions)
- **Agents / Automations (current runtime)**: automation service + automation planner service (automation, Night Shift, watcher, review flows under the current Automations domain model)
- **Missions**: mission service (mission lifecycle CRUD + eventing)
- **Shared types**: `src/shared/types/` directory (17 domain modules with barrel `index.ts` -- replaces former monolithic `types.ts`)
- **Shared utilities**: backend utils (`src/main/services/shared/utils.ts`), renderer formatting/shell/session libs (`src/renderer/lib/`), shared React hooks (`src/renderer/hooks/`)

Additional runtime loops:

- Head watcher loop to detect out-of-band git HEAD changes
- Event broadcasters for renderer subscriptions

---

## IPC Contract and Preload

IPC channel constants live in `apps/desktop/src/shared/ipc.ts` and are registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`.

The contract spans app/project, lanes, sessions/pty, files/git, conflicts/context/memory, PRs/github, agents/missions, layout/graph, processes/tests, and settings/config domains.

High-frequency/broadcast event channels include:

- `ade.pty.data`
- `ade.pty.exit`
- `ade.files.change`
- `ade.processes.event`
- `ade.tests.event`
- `ade.conflicts.event`
- `ade.prs.event`
- `ade.agents.event`
- `ade.missions.event`
- `ade.lanes.rebaseSuggestions.event`
- `ade.lanes.autoRebase.event`
- `ade.agentChat.event`
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
- Dispose polling and agent/job loops
- Dispose file watchers
- Stop tests and managed processes
- Dispose PTY sessions
- Dispose agent chat sessions (terminate app-server processes, persist Claude session state)
- Flush and close SQLite

Uncaught exception and unhandled rejection handlers log structured errors through the main logger.

---

## Implementation Status

Desktop architecture is mature and production-oriented for current scope:

- Service-factory composition and dependency injection are implemented.
- Project switching is implemented with full context teardown/rebuild.
- Broad typed IPC contract is implemented and actively used by renderer surfaces.
- Security boundaries (`contextIsolation`, preload-only IPC surface) are enforced.
- Head-change and session-end pipelines keep memory/conflicts/compat exports synchronized.
- AI integration service provides local AI execution via AgentExecutor interface (dual SDK) and MCP server.
- Agent chat service provides native interactive chat with Codex (via App Server) and Claude (via community provider) with full session tracking.
- Type system modularized: 17 domain-scoped type modules in `src/shared/types/` replace the former monolithic `types.ts`.
- Large services decomposed: AI orchestrator (8 extracted modules), orchestrator service (2 extracted modules), pack service (4 extracted modules) all follow a core-plus-modules pattern with shared context objects.
- Shared utilities consolidated: backend `utils.ts`, renderer `format.ts`/`shell.ts`/`sessions.ts`, and shared React hooks eliminate cross-service duplication.
- Model system unified: `modelRegistry.ts` includes pricing fields directly; `modelProfiles.ts` derives from the registry instead of maintaining parallel lists.

### Planned Services

| Service | Purpose | Phase |
|---------|---------|-------|
| `laneEnvironmentService` | Lane environment initialization (env files, port allocation, Docker startup, dependency installation) | 5 |
| `laneProxyService` | Per-lane *.localhost hostname proxy with Host-header routing | 5 |
| `previewLaunchService` | Preview URL generation, browser launch, share links | 5 |
| `browserProfileService` | Chrome profile isolation per lane for cookie/auth separation | 5 |
| `computeBackendService` | Compute backend abstraction (Local/VPS/Daytona selection and lifecycle) | 5.5 |
| `daytonaService` | Daytona SDK integration for opt-in cloud sandbox environments | 5.5 |

Future architecture expansion (Machines, relay transport, core extraction) is tracked in `docs/final-plan/README.md`.
