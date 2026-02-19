# ADE System Architecture Overview

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-19
>
> Roadmap note: future sequencing and planned architecture expansion (orchestrator, MCP, relay, iOS, machine hub) are maintained in `docs/final-plan.md`.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Technical Details](#technical-details)
   - [Desktop UI](#1-desktop-ui)
   - [Local Core Engine](#2-local-core-engine)
   - [Hosted ADE Agent](#3-hosted-ade-agent)
4. [Integration Points](#integration-points)
   - [Data Flow](#data-flow)
   - [IPC Architecture](#ipc-architecture)
   - [Event Propagation](#event-propagation)
5. [Implementation Status](#implementation-status)

---

## Overview

ADE (Agentic Development Environment) is a desktop application designed to augment the developer workflow by providing deep integration between terminal sessions, git operations, and context-aware tooling. The system is built around three principal components that operate in a layered architecture, with strict boundaries governing which layer is permitted to perform mutations on the repository and filesystem.

The core insight behind ADE's architecture is that developer context -- the state of code changes, terminal output, test results, process health, and git history -- is fragmented across tools. ADE unifies this context into structured artifacts called "packs" that serve both humans and AI agents.

---

## Design Decisions

### Local-First, Cloud-Optional

ADE operates fully offline. The Local Core Engine handles all repository mutations, file I/O, and process management without requiring network connectivity. The Hosted ADE Agent is an optional enhancement that provides AI-generated narratives and proposals but never touches the local repository.

### Trust Boundary at the Process Level

Electron's process model provides a natural trust boundary. The main process (Node.js) is trusted and has full filesystem and process access. The renderer process (Chromium) is untrusted and communicates exclusively through a typed IPC bridge. This prevents any renderer-side vulnerability from directly accessing the filesystem or spawning processes.

### Git Worktrees as the Isolation Primitive

Rather than using branches alone, ADE maps each lane (unit of work) to a dedicated git worktree. This enables true parallel development: multiple lanes can have different working trees checked out simultaneously without interference. The worktree model also provides a clean filesystem boundary for process execution and test isolation.

### Deterministic Packs Over Live Queries

ADE materializes context into markdown pack files rather than relying on live queries. This decision ensures reproducibility (packs are snapshots), enables offline consumption, and provides a natural serialization format for the Hosted Agent. Packs are rebuilt on deterministic triggers (session end, HEAD change) rather than polled.

### Event-Driven Job Engine

Background work is triggered by events (session end, HEAD change) rather than periodic polling. This reduces unnecessary computation while ensuring that packs and deltas are always current when needed. The job engine coalesces duplicate requests to avoid redundant work.

### SQLite for Structured State

All structured data lives in a single SQLite database (via sql.js WASM). This eliminates the need for a separate database server, keeps all state local, and provides ACID guarantees for concurrent reads and writes within the single main process.

---

## Technical Details

ADE is composed of three main components, each with distinct responsibilities and trust levels.

### 1. Desktop UI

**Technology**: Electron 40.x (Chromium + Node.js), React 18.3, TypeScript, Vite, TailwindCSS 4.x

The Desktop UI is the user-facing application. It renders lanes, terminals (via xterm.js), file diffs (via Monaco Editor), process status panels, test result views, pack viewers, and operation history. The UI is split into two Electron processes:

- **Main Process (trusted)**: Full Node.js access. This is where all services live. It handles file I/O, PTY spawning via node-pty, git operations, SQLite database access, process management, and test execution. Entry point is `main.ts`, which initializes an `AppContext` containing all service instances.

- **Renderer Process (untrusted)**: A React single-page application. It has no direct file or process access. All communication with the main process goes through Electron's IPC mechanism via a typed preload bridge that exposes the `window.ade` API.

Key UI subsystems:

| Subsystem | Purpose |
|-----------|---------|
| Play | Run processes/tests, lane-scoped execution controls, CI import, agent tool launch points |
| Lanes | Create, rename, archive, delete, and stack worktree-backed development lanes |
| Files | IDE-style workspace browser/editor with search and quick-open |
| Terminals | Embedded terminal sessions backed by node-pty |
| Conflicts | Risk matrix, merge simulation, proposal/reconciliation workflows |
| Context/Packs | Deterministic pack views, exports, and docs-generation actions |
| Graph | Workspace topology and risk overlays |
| PRs | PR creation/linking, checks/reviews, stacked + integration flows |
| History | Operation/checkpoint/pack event timeline |
| Automations | Trigger-action workflows and planner-driven draft flows |
| Missions | Plain-English mission intake, lifecycle board, interventions, artifacts, outcomes |
| Settings | Provider, trust, keybindings, terminal profiles, and data controls |

### 2. Local Core Engine

**Technology**: Node.js (Electron main process), sql.js (SQLite WASM), node-pty, child_process

The Local Core Engine is the brain of ADE. It runs exclusively in Electron's main process and is the only component permitted to mutate the repository, filesystem, or spawn processes. It is organized as a set of services, each created via a factory function pattern:

| Service | Module | Responsibility |
|---------|--------|----------------|
| `laneService` | `laneService.ts` | Lane CRUD, worktree creation/removal, status computation |
| `sessionService` | `sessionService.ts` | Terminal session lifecycle (create, end, query) |
| `ptyService` | `ptyService.ts` | PTY spawning via node-pty, transcript capture, data broadcast |
| `diffService` | `diffService.ts` | Git diff computation (staged, unstaged, file-level) |
| `fileService` | `fileService.ts` | Full file operations: workspace listing, tree browsing (with gitignore), read, write, create, rename, delete, watch (chokidar), quick-open (fuzzy), text search |
| `gitService` | `gitOperationsService.ts` | All git operations (stage, commit, stash, sync, push, etc.) |
| `operationService` | `operationService.ts` | Operation history tracking with pre/post HEAD SHAs |
| `packService` | `packService.ts` | Pack materialization (lane packs, project packs, session deltas) |
| `jobEngine` | `jobEngine.ts` | Async job scheduling with deduplication |
| `processService` | `processService.ts` | Dev process lifecycle management |
| `testService` | `testService.ts` | Test suite execution and result tracking |
| `projectConfigService` | `projectConfigService.ts` | YAML config loading, validation, trust model |

All services are instantiated in `main.ts` and wired together through dependency injection. The `AppContext` type aggregates all service instances and is passed to the IPC registration layer.

### 3. Hosted ADE Agent

**Technology**: Cloud-hosted serverless backend (`infra`) with LLM gateway integration

The Hosted ADE Agent is a read-only cloud mirror that receives snapshots of lane state and uses large language models to generate higher-order context:

- **Pack narratives**: Human-readable summaries of what changed and why, derived from deterministic pack data
- **Conflict resolution proposals**: Suggested approaches when lanes have overlapping changes
- **PR descriptions**: Auto-generated pull request descriptions based on lane history
- **Code review suggestions**: Context-aware review comments (future)

**Key contract**: The Hosted Agent NEVER mutates the repository. The Local Core Engine is the ONLY component allowed to edit files, run git commands, or execute processes. The Hosted Agent receives data, processes it through LLMs, and returns proposals that the user must explicitly accept before the Local Core applies them.

---

## Integration Points

### Data Flow

The primary data flow through ADE follows this pipeline:

```
User creates lane
  --> Runs terminal session in lane worktree
    --> Session end triggers checkpoint computation
      --> Checkpoint triggers pack update (lane pack + project pack)
        --> Pack triggers conflict prediction
          --> Results can sync to hosted mirror (if enabled)
            --> Hosted agent generates narratives/proposals
              --> Proposals sent back to desktop for user review
```

Each step in this pipeline is triggered by events rather than polling. The job engine ensures that rapid successive events (multiple sessions ending quickly) are coalesced into a single pack refresh.

### IPC Architecture

Communication between the renderer and main process is organized into a broad typed IPC contract (`234` channels in `apps/desktop/src/shared/ipc.ts` as of 2026-02-19). Major domains include:

| Domain | Prefix examples | Pattern |
|-----------|---------------|---------|
| App / Project / Onboarding / CI | `ade.app.*`, `ade.project.*`, `ade.onboarding.*`, `ade.ci.*` | invoke/handle + selected events |
| Lanes / Git / Conflicts / PRs | `ade.lanes.*`, `ade.git.*`, `ade.conflicts.*`, `ade.prs.*` | invoke/handle + selected events |
| Terminals / Sessions / Files | `ade.pty.*`, `ade.sessions.*`, `ade.files.*` | invoke/handle + high-frequency stream events |
| Context / Packs / History / Graph | `ade.context.*`, `ade.packs.*`, `ade.history.*`, `ade.graph.*` | invoke/handle + pack events |
| Processes / Tests / Automations / Missions | `ade.processes.*`, `ade.tests.*`, `ade.automations.*`, `ade.missions.*` | invoke/handle + runtime events |
| Config / Settings surfaces | `ade.projectConfig.*`, `ade.keybindings.*`, `ade.terminalProfiles.*`, `ade.agentTools.*`, `ade.hosted.*`, `ade.github.*` | invoke/handle + provider/state events |

These per-subsystem counts are illustrative and can drift; `apps/desktop/src/shared/ipc.ts` is the canonical live channel inventory.

All channels use the `ipcMain.handle` / `ipcRenderer.invoke` request-response pattern except for real-time data streams (PTY output, process logs, test logs), which use `webContents.send` for push-based delivery.

The IPC layer is defined in three files:
- `shared/ipc.ts` -- Channel name constants
- `preload/preload.ts` -- Typed renderer-side API (`window.ade`)
- `main/services/ipc/registerIpc.ts` -- Main process handler registration

### Event Propagation

ADE uses a callback-based event propagation model between services:

```
PTY exit --> ptyService.closeEntry()
  --> sessionService.end()
  --> onSessionEnded callback
    --> jobEngine.onSessionEnded()
      --> packService.refreshLanePack()
      --> packService.refreshProjectPack()

Git operation completes --> gitService (any mutation)
  --> operationService.finish()
  --> onHeadChanged callback (if SHA changed)
    --> jobEngine.onHeadChanged()
      --> packService.refreshLanePack()
      --> packService.refreshProjectPack()
```

Real-time events (PTY data, process status changes, test run updates) are broadcast to all renderer windows via a `broadcast()` utility that iterates over `BrowserWindow.getAllWindows()`.

---

## Implementation Status

Current codebase status is feature-rich across lanes, files, terminals, conflicts, packs/context, PRs, automations, and hosted/BYOK provider flows.

For authoritative phase sequencing, dependencies, and next implementation tasks, see:

- `docs/final-plan.md`
