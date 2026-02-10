# Desktop App (Shell, Processes, IPC)

Last updated: 2026-02-10

This document describes how the ADE desktop app is structured so implementation can start from nothing.

## 1. Packaging Choice (Recommended)

- Electron + React + TypeScript
- Renderer bundler: Vite
- Terminal: xterm.js (renderer) + node-pty (main process)

Rationale:

- Cross-platform embedded PTY is a hard requirement.
- Electron + node-pty is the lowest-risk path to stable PTY on macOS/Windows/Linux.

## 2. Process Model

### 2.1 Main process (trusted)

Responsibilities:

- Owns access to filesystem and child processes.
- Runs PTY sessions via node-pty.
- Runs git CLI operations (initially shelling out to `git`).
- Runs the job engine and pipelines (session end -> packs -> sync -> predict conflicts).
- Maintains the local DB (SQLite).

### 2.2 Renderer process (untrusted UI)

Responsibilities:

- UI: lanes dashboard, terminals, diffs, packs viewer, conflicts window.
- Renders terminals using xterm.js.
- Never directly spawns processes or reads arbitrary files.

### 2.3 Preload (bridge)

Responsibilities:

- Expose a narrow API surface to the renderer via `contextBridge`.
- Enforce that the renderer can only call whitelisted operations.

Security:

- `contextIsolation: true`
- `nodeIntegration: false`
- strict IPC channel allowlist

## 3. IPC Contracts (MVP)

All IPC should be typed and versioned (at least by TypeScript types).

Suggested channels:

### Lanes

- `lanes.list -> LaneSummary[]`
- `lanes.create({name, baseRef, templateId}) -> LaneSummary`
- `lanes.rename({laneId, name}) -> void`
- `lanes.archive({laneId}) -> void`
- `lanes.openFolder({laneId}) -> void`

### Terminal sessions / PTY

- `pty.create({laneId, cols, rows, title}) -> {ptyId}`
- `pty.write({ptyId, data}) -> void`
- `pty.resize({ptyId, cols, rows}) -> void`
- `pty.dispose({ptyId}) -> void`
- Event: `pty.data({ptyId, data})`
- Event: `pty.exit({ptyId, exitCode})`

### Packs

- `packs.getProjectPack() -> {path, deterministicUpdatedAt, narrativeUpdatedAt}`
- `packs.getLanePack({laneId}) -> {path, deterministicUpdatedAt, narrativeUpdatedAt}`
- `packs.getConflictPack({operationId}) -> {path, deterministicUpdatedAt, narrativeUpdatedAt}`

### Conflicts

- `conflicts.predict({laneId}) -> ConflictPrediction`
- `conflicts.requestProposals({operationId}) -> ProposalRun`
- `conflicts.listProposals({operationId}) -> ProposalSummary[]`
- `conflicts.applyProposal({proposalId, mode}) -> OperationResult`

### Processes/tests (later in MVP)

- `processes.start({processId})`
- `processes.stop({processId})`
- `tests.run({suiteId, laneId?})`

## 4. Where PTY Lives (Important)

PTY must run in the main process (or a dedicated Node child process) because:

- node-pty requires native bindings and OS-level PTY access
- renderer must remain unprivileged

The renderer only renders bytes via xterm.js and sends keystrokes back via IPC.

## 5. Folder/Repo Layout (Suggested)

For a clean starting point:

- `apps/desktop/` (Electron app)
- `docs/` (this PRD/spec set)

Inside `apps/desktop/`:

- `src/main/` (Electron main)
- `src/preload/` (context bridge)
- `src/renderer/` (React UI)

## 6. Milestone 0 "It Works" Definition

- Can open app window.
- Can create 3 PTYs and render them with xterm.js.
- Each PTY is lane-scoped by working directory.
- Session end emits event that triggers a job (even if the job is a stub at first).

