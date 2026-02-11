# ADE System Architecture Overview

> Last updated: 2026-02-11

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
| Lanes | Create, rename, archive, delete worktree-backed development lanes |
| Terminals | Embedded terminal emulators backed by node-pty sessions |
| Diffs | Side-by-side file diff viewer with staging/unstaging controls |
| Processes | Start, stop, restart managed dev server processes |
| Tests | Run test suites, view results and log output |
| Packs | View deterministic context packs (project-level and lane-level) |
| History | Browse operation timeline with SHA tracking |
| Config | Edit project configuration (processes, tests, stack buttons) |

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

**Technology**: Cloud-hosted service (planned), LLM integration

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
        --> Pack triggers conflict prediction (future)
          --> Results sync to hosted mirror (future)
            --> Hosted agent generates narratives/proposals
              --> Proposals sent back to desktop for user review
```

Each step in this pipeline is triggered by events rather than polling. The job engine ensures that rapid successive events (multiple sessions ending quickly) are coalesced into a single pack refresh.

### IPC Architecture

Communication between the renderer and main process is organized into 82+ IPC channels spanning 13 subsystems:

| Subsystem | Channel Prefix | Count | Pattern |
|-----------|---------------|-------|---------|
| App | `ade.app.*` | 3 | invoke/handle |
| Project | `ade.project.*` | 2 | invoke/handle |
| Lanes | `ade.lanes.*` | 6 | invoke/handle |
| Sessions | `ade.sessions.*` | 4 | invoke/handle |
| PTY | `ade.pty.*` | 6 | invoke/handle + push events |
| Diff | `ade.diff.*` | 2 | invoke/handle |
| Files | `ade.files.*` | 12 | invoke/handle + push events |
| Git | `ade.git.*` | 13 | invoke/handle |
| Packs | `ade.packs.*` | 3 | invoke/handle |
| History | `ade.history.*` | 1 | invoke/handle |
| Layout | `ade.layout.*` | 2 | invoke/handle |
| Processes | `ade.processes.*` | 12 | invoke/handle + push events |
| Tests | `ade.tests.*` | 6 | invoke/handle + push events |
| Config | `ade.projectConfig.*` | 5 | invoke/handle |

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

### Completed (Phase -1 through Phase 2)

- Electron application shell with main/renderer/preload architecture
- Full IPC layer with 71+ typed channels
- SQLite persistence with sql.js (WASM) and migration system
- Lane management with git worktree backing
- Terminal sessions with PTY management and transcript capture
- Git operations service (stage, unstage, discard, commit, amend, revert, cherry-pick, stash, fetch, sync, push)
- Operation history tracking with pre/post HEAD SHA recording
- Diff service (staged and unstaged changes, file-level diffs)
- File service (atomic writes within lane worktrees)
- Process management service (start, stop, restart, kill, stack operations)
- Test execution service (run, stop, result tracking)
- Project configuration service (YAML, validation, trust model)
- Pack service (lane packs, project packs, session deltas)
- Job engine (queue, deduplication, sequential processing)
- Layout persistence (panel sizes via KV store)

### Completed (Phase 3 — Files Tab & UI Polish)

- Files tab with full workspace file tree, Monaco editor, multi-tab editing, quick-open, text search
- File service expanded: listWorkspaces, listTree, readFile, writeText, create, rename, delete, watchWorkspace, quickOpen, searchText
- File watcher service (chokidar-based, debounced change events)
- File search index service (in-memory cooperative indexing with fuzzy path scoring)
- Extension-aware file icons and color-coded change status indicators
- Zed-inspired file tree styling (indentation guides, accent highlights, refined hover states)
- Protected branch warnings with lane workspace switch suggestion
- Lane search/filter with token-based queries (is:dirty, is:pinned, type:worktree)
- Lane keyboard navigation (j/k, arrows, Enter, Escape, Cmd+F)
- Terminal theme sync (dark/light xterm.js themes without PTY recreation)
- Guest mode (no-account usage with local features only)
- Guest mode banner (persistent amber bar with provider setup link)
- Untracked terminal sessions (tracked: false support)
- Run tab rename (Play icon, "Run" label)
- Lane selector on Run tab (execution context dropdown)
- Renderer error boundary (graceful crash recovery)

### Planned

- **Phase 4**: Stack operations (parent-child lane relationships, restack)
- **Phase 5**: Conflict prediction (dry-merge simulation, pairwise lane comparison)
- **Phase 6**: Hosted ADE Agent integration (cloud sync, LLM narratives, proposal pipeline)
- **Phase 7**: Advanced pack types (feature packs, conflict packs)
- **Phase 8**: Checkpoint system (immutable snapshots at session boundaries)
- **Phase 9**: Automation actions (user-defined triggers and handlers)
