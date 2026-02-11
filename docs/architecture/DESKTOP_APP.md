# Desktop Application Architecture

> Last updated: 2026-02-11

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Technical Details](#technical-details)
   - [Technology Stack](#technology-stack)
   - [Process Model](#process-model)
   - [AppContext and Service Initialization](#appcontext-and-service-initialization)
   - [IPC Registration](#ipc-registration)
   - [Preload Bridge](#preload-bridge)
   - [Window Management](#window-management)
   - [Build Pipeline](#build-pipeline)
   - [Project Switching](#project-switching)
   - [Shutdown and Cleanup](#shutdown-and-cleanup)
4. [Integration Points](#integration-points)
5. [Implementation Status](#implementation-status)

---

## Overview

The ADE Desktop Application is an Electron-based development environment that provides a unified interface for managing git worktree lanes, terminal sessions, file diffs, process management, test execution, and context pack generation. It is the primary user-facing component of the ADE system.

The application follows a strict process isolation model inherited from Electron's Chromium architecture. All privileged operations (file I/O, process spawning, git commands, database access) are confined to the main process. The renderer process runs a React SPA that communicates with the main process exclusively through typed IPC channels exposed via a preload bridge.

---

## Design Decisions

### Service Factory Pattern Over Classes

All main process services are created via factory functions (`createXxxService(deps)`) that return plain objects with methods, rather than using class hierarchies. This approach was chosen for several reasons:

- Explicit dependency injection through function parameters
- No `this` binding ambiguity when passing methods as callbacks
- Simpler testing (factory functions are easier to mock)
- Natural closure over shared state without exposing internals

### Single AppContext Object

All services are aggregated into a single `AppContext` type that is threaded through the IPC layer. This provides a single point of access for all capabilities and makes it straightforward to swap the entire context when the user switches projects.

### Lazy PTY Loading

The `node-pty` native module is loaded lazily via a `loadPty()` callback rather than being imported at the top level. This isolates the native dependency loading to runtime, ensuring that build tooling does not need to resolve the native binary at bundle time.

### Vite for Renderer, tsup for Main Process

The renderer uses Vite for its React SPA (with HMR support in development), while the main process uses tsup for TypeScript compilation. This split acknowledges that the renderer benefits from Vite's browser-oriented bundling and HMR, while the main process needs straightforward Node.js CommonJS output.

### Context Isolation Enforced

The renderer process runs with `contextIsolation: true` and `nodeIntegration: false`. This means the renderer has zero access to Node.js APIs. All communication goes through `contextBridge.exposeInMainWorld()`, which creates a serialization boundary that prevents prototype pollution attacks.

---

## Technical Details

### Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop Framework | Electron | 40.x |
| UI Framework | React | 18.3 |
| Language | TypeScript | 5.7 |
| Renderer Bundler | Vite | 4.5 |
| Main Process Bundler | tsup | 8.3 |
| Styling | TailwindCSS | 4.x |
| Router | React Router | 7.13 |
| State Management | Zustand | 5.x |
| Terminal Emulator | xterm.js | 5.3 |
| Code Editor | Monaco Editor | 0.55 |
| UI Components | Radix UI | Various |
| Icons | Lucide React | 0.563 |
| Panel Layout | react-resizable-panels | 4.6 |
| Database | sql.js (SQLite WASM) | 1.13 |
| PTY | node-pty | 1.1 |
| Config Parser | yaml | 2.8 |

### Process Model

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Shell                        │
│                                                         │
│  ┌──────────────────────┐  ┌─────────────────────────┐  │
│  │    Main Process       │  │   Renderer Process      │  │
│  │    (Node.js)          │  │   (Chromium)            │  │
│  │                       │  │                         │  │
│  │  - AppContext         │  │  - React SPA            │  │
│  │  - All Services       │  │  - xterm.js terminals   │  │
│  │  - SQLite Database    │  │  - Monaco diffs         │  │
│  │  - PTY Management     │  │  - Zustand stores       │  │
│  │  - Git Operations     │  │  - React Router         │  │
│  │  - Process Spawning   │  │                         │  │
│  │  - Test Execution     │  │  window.ade API         │  │
│  │                       │  │  (preload bridge)       │  │
│  └──────────┬────────────┘  └────────┬────────────────┘  │
│             │         IPC            │                    │
│             └────────────────────────┘                    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Preload Script                       │   │
│  │  contextBridge.exposeInMainWorld("ade", {...})    │   │
│  │  Typed API surface with strict channel allowlist  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Main Process** (trusted): Created via `main.ts`. Has full Node.js access including `fs`, `child_process`, `net`, and native modules. All services are instantiated here. Handles all 82+ IPC channels. Manages application lifecycle events (`ready`, `activate`, `before-quit`, `window-all-closed`).

**Renderer Process** (untrusted): A React SPA loaded from either a Vite dev server URL (development) or a local `file://` URL (production). Has no direct access to Node.js APIs. Communicates with the main process through `window.ade`, which is injected by the preload script.

**Preload Script** (`preload.ts`): Compiled to `preload.cjs` and loaded into the renderer context with access to both `ipcRenderer` and `contextBridge`. Defines the complete `window.ade` API surface, which mirrors the IPC channel structure.

### AppContext and Service Initialization

The `AppContext` type defines the complete set of services available in the main process:

```typescript
export type AppContext = {
  db: AdeDb;
  logger: Logger;
  project: ProjectInfo;
  projectId: string;
  adeDir: string;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  diffService: ReturnType<typeof createDiffService>;
  fileService: ReturnType<typeof createFileService>;
  operationService: ReturnType<typeof createOperationService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  packService: ReturnType<typeof createPackService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  processService: ReturnType<typeof createProcessService>;
  testService: ReturnType<typeof createTestService>;
};
```

Services are initialized in a specific order within `initContextForProjectRoot()` in `main.ts`, respecting dependency chains:

1. **Infrastructure**: `ensureAdeDirs()`, `createFileLogger()`, `openKvDb()`
2. **Project setup**: `toProjectInfo()`, `upsertProjectRow()`, `ensureAdeExcluded()`
3. **Core data services**: `laneService`, `sessionService`
4. **Derived services**: `diffService` (depends on laneService), `fileService` (depends on laneService)
5. **Config service**: `projectConfigService`
6. **Tracking service**: `operationService`
7. **Pack service**: `packService` (depends on laneService, sessionService, projectConfigService, operationService)
8. **Job engine**: `jobEngine` (depends on packService)
9. **PTY service**: `ptyService` (depends on laneService, sessionService; calls jobEngine on session end)
10. **Git service**: `gitService` (depends on laneService, operationService; calls jobEngine on HEAD change)
11. **Execution services**: `processService`, `testService`

### IPC Registration

The `registerIpc()` function in `registerIpc.ts` binds all IPC channels to their handler functions. It receives a `getCtx()` function (rather than a direct context reference) to support project switching -- when the user opens a different repository, the context reference is swapped.

```typescript
export function registerIpc({
  getCtx,
  switchProjectFromDialog
}: {
  getCtx: () => AppContext;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
}) {
  ipcMain.handle(IPC.appPing, async () => "pong" as const);
  ipcMain.handle(IPC.lanesList, async (_event, arg) => getCtx().laneService.list(arg));
  // ... 71 total handlers
}
```

Each handler follows a consistent pattern:
1. Extract the current `AppContext` via `getCtx()`
2. Delegate to the appropriate service method
3. Return the result (automatically serialized by Electron's IPC)

### Preload Bridge

The preload script (`preload.ts`) uses `contextBridge.exposeInMainWorld()` to inject a typed `window.ade` object into the renderer. The API surface is organized by subsystem:

```typescript
contextBridge.exposeInMainWorld("ade", {
  app:           { ping, getInfo, getProject },
  project:       { openRepo, openAdeFolder },
  lanes:         { list, create, rename, archive, delete, openFolder },
  sessions:      { list, get, readTranscriptTail, getDelta },
  pty:           { create, write, resize, dispose, onData, onExit },
  diff:          { getChanges, getFile },
  files:         { listWorkspaces, listTree, readFile, writeText, createFile,
                   createDirectory, rename, delete: deletePath, watch, stopWatching,
                   quickOpen, searchText, onChangeEvent },
  git:           { stageFile, unstageFile, discardFile, restoreStagedFile,
                   commit, listRecentCommits, revertCommit, cherryPickCommit,
                   stashPush, stashList, stashApply, stashPop, stashDrop,
                   fetch, sync, push },
  packs:         { getProjectPack, getLanePack, refreshLanePack },
  history:       { listOperations },
  layout:        { get, set },
  processes:     { listDefinitions, listRuntime, start, stop, restart, kill,
                   startStack, stopStack, restartStack, startAll, stopAll,
                   getLogTail, onEvent },
  tests:         { listSuites, run, stop, listRuns, getLogTail, onEvent },
  projectConfig: { get, validate, save, diffAgainstDisk, confirmTrust }
});
```

Request-response methods use `ipcRenderer.invoke()`. Event subscriptions (`onData`, `onExit`, `onEvent`) use `ipcRenderer.on()` and return a cleanup function for unsubscription.

### Window Management

ADE creates a single `BrowserWindow` with the following configuration:

- **Dimensions**: 1280 x 820 default
- **Background color**: `#fbf8ee` (matches renderer theme to prevent dark flash)
- **Context isolation**: Enabled
- **Node integration**: Disabled
- **Menu bar**: Hidden
- **External navigation**: Blocked (only allows the renderer URL)
- **Window open**: Denied (prevents popup windows)
- **DevTools**: Auto-opened in detached mode during development

### Build Pipeline

**Development**:
```bash
npm run dev
```
Runs three concurrent processes:
1. `vite --port 5173` -- Renderer dev server with HMR
2. `tsup --watch` -- Main process TypeScript compilation (watch mode)
3. `electron .` -- Electron process (waits for Vite and tsup to be ready)

**Production**:
```bash
npm run build
```
1. `tsup` -- Compiles main process to `dist/main/main.cjs`
2. `vite build` -- Bundles renderer to `dist/renderer/`

Output structure:
```
dist/
├── main/
│   └── main.cjs          # Main process bundle (CommonJS)
├── preload/
│   └── preload.cjs        # Preload script (CommonJS)
└── renderer/
    ├── index.html          # SPA entry point
    ├── assets/             # Hashed JS/CSS bundles
    └── ...
```

### Project Switching

ADE supports switching between git repositories at runtime. When the user opens a new repo via the file dialog:

1. `switchProjectFromDialog()` resolves the selected path to a git repo root
2. `detectDefaultBaseRef()` determines the default branch (main, master, etc.)
3. `closeContext()` disposes all active PTYs, processes, tests, and flushes/closes the database
4. `initContextForProjectRoot()` creates a new `AppContext` with fresh services
5. The `ctxRef` is swapped, and subsequent `getCtx()` calls return the new context
6. The global state file is updated with the new project as the most recent

### Shutdown and Cleanup

On `before-quit`, ADE performs ordered cleanup:

1. Dispose all test service runners (`testService.disposeAll()`)
2. Dispose all managed processes (`processService.disposeAll()`)
3. Dispose all PTY sessions (`ptyService.disposeAll()`)
4. Flush database to disk (`db.flushNow()`)
5. Close database (`db.close()`)

Each disposal step is wrapped in try/catch to ensure that failures in one service do not prevent cleanup of others.

---

## Integration Points

### Main Process to Renderer

- **IPC invoke/handle**: 66 request-response channels for CRUD operations and queries
- **IPC push events**: 5 broadcast channels for real-time data:
  - `ade.pty.data` -- Terminal output chunks
  - `ade.pty.exit` -- Terminal session exit events
  - `ade.processes.event` -- Process log and runtime state changes
  - `ade.tests.event` -- Test run and log events

### Main Process Internal

Services communicate through direct method calls and callback injection:

- `ptyService` --> `sessionService` (session lifecycle)
- `ptyService` --> `jobEngine` (session end trigger)
- `gitService` --> `operationService` (operation tracking)
- `gitService` --> `jobEngine` (HEAD change trigger)
- `jobEngine` --> `packService` (pack refresh)
- `packService` --> `operationService` (pack operation tracking)

### External Dependencies

- **Git CLI**: All git operations shell out to the system `git` binary
- **User shell**: PTY sessions spawn the user's configured shell (`$SHELL` or `/bin/zsh`)
- **Filesystem**: `.ade/` directory within the project root for all ADE artifacts
- **Global state**: `~/.ade/ade-state.json` (or Electron userData path) for recent projects

---

## Implementation Status

### Completed

- Electron shell with main/renderer/preload architecture
- All 82+ IPC channels registered and typed
- Service factory pattern for all 11 services
- Project initialization and switching
- Window management with security hardening
- Development build pipeline (Vite + tsup + Electron)
- Production build pipeline
- Ordered shutdown with resource cleanup
- Global state persistence (recent projects)
- Error boundary handlers (uncaughtException, unhandledRejection)

### Not Yet Implemented

- Multi-window support (currently single window only)
- Auto-update mechanism (Electron autoUpdater)
- Native menu integration (menu bar is hidden)
- System tray support
- Deep linking / custom protocol handler
- Packaged application distribution (DMG, AppImage, NSIS)
- Crash reporting integration
- Telemetry / analytics (by design -- local-first)
