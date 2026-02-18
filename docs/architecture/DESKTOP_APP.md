# Desktop Application Architecture

> Last updated: 2026-02-16

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

**Main Process** (trusted): Created via `main.ts`. Has full Node.js access including `fs`, `child_process`, `net`, and native modules. All services are instantiated here. Handles 197 IPC request-response channels plus 10 event broadcast channels. Manages application lifecycle events (`ready`, `activate`, `before-quit`, `window-all-closed`).

**Renderer Process** (untrusted): A React SPA loaded from either a Vite dev server URL (development) or a local `file://` URL (production). Has no direct access to Node.js APIs. Communicates with the main process through `window.ade`, which is injected by the preload script.

**Preload Script** (`preload.ts`): Compiled to `preload.cjs` and loaded into the renderer context with access to both `ipcRenderer` and `contextBridge`. Defines the complete `window.ade` API surface, which mirrors the IPC channel structure.

### AppContext and Service Initialization

The `AppContext` type defines the complete set of services available in the main process (27 fields as of Phase 8):

```typescript
export type AppContext = {
  db: AdeDb;
  logger: Logger;
  project: ProjectInfo;
  projectId: string;
  adeDir: string;
  disposeHeadWatcher: () => void;
  keybindingsService: ReturnType<typeof createKeybindingsService>;
  terminalProfilesService: ReturnType<typeof createTerminalProfilesService>;
  agentToolsService: ReturnType<typeof createAgentToolsService>;
  onboardingService: ReturnType<typeof createOnboardingService>;
  ciService: ReturnType<typeof createCiService>;
  laneService: ReturnType<typeof createLaneService>;
  restackSuggestionService: ReturnType<typeof createRestackSuggestionService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  diffService: ReturnType<typeof createDiffService>;
  fileService: ReturnType<typeof createFileService>;
  operationService: ReturnType<typeof createOperationService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  conflictService: ReturnType<typeof createConflictService>;
  hostedAgentService: ReturnType<typeof createHostedAgentService>;
  byokLlmService: ReturnType<typeof createByokLlmService>;
  githubService: ReturnType<typeof createGithubService>;
  prService: ReturnType<typeof createPrService>;
  prPollingService: ReturnType<typeof createPrPollingService>;
  jobEngine: ReturnType<typeof createJobEngine>;
  automationService: ReturnType<typeof createAutomationService>;
  automationPlannerService: ReturnType<typeof createAutomationPlannerService>;
  packService: ReturnType<typeof createPackService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  processService: ReturnType<typeof createProcessService>;
  testService: ReturnType<typeof createTestService>;
};
```

Services are initialized in a specific order within `initContextForProjectRoot()` in `main.ts`, respecting dependency chains:

1. **Infrastructure**: `ensureAdeDirs()`, `createFileLogger()`, `openKvDb()`
2. **Project setup**: `toProjectInfo()`, `upsertProjectRow()`, `ensureAdeExcluded()`
3. **Config service**: `projectConfigService`
4. **Settings services**: `keybindingsService`, `terminalProfilesService`, `agentToolsService`
5. **Core data services**: `laneService`, `sessionService`
6. **Onboarding / CI**: `onboardingService`, `ciService`
7. **Derived services**: `diffService`, `fileService`
8. **Tracking service**: `operationService`
9. **Pack service**: `packService` (depends on laneService, sessionService, projectConfigService, operationService)
10. **AI services**: `hostedAgentService`, `byokLlmService`
11. **Conflict service**: `conflictService` (depends on laneService, gitService, packService)
12. **Job engine**: `jobEngine` (depends on packService, conflictService, hostedAgentService, projectConfigService, byokLlmService)
13. **PTY service**: `ptyService` (depends on laneService, sessionService; calls jobEngine on session end)
14. **Git service**: `gitService` (depends on laneService, operationService)
15. **Head watcher**: Polls for HEAD changes, routes to jobEngine, automationService, restackSuggestionService
16. **GitHub / PR services**: `githubService`, `prService`, `prPollingService`
17. **Restack suggestions**: `restackSuggestionService`
18. **Automation services**: `automationService`, `automationPlannerService`
19. **Execution services**: `processService`, `testService`

### IPC Registration

The `registerIpc()` function in `registerIpc.ts` binds all IPC channels to their handler functions. It receives a `getCtx()` function (rather than a direct context reference) to support project switching -- when the user opens a different repository, the context reference is swapped. It also receives `globalStatePath` for recent project management.

```typescript
export function registerIpc({
  getCtx,
  switchProjectFromDialog,
  globalStatePath
}: {
  getCtx: () => AppContext;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
  globalStatePath: string;
}) {
  ipcMain.handle(IPC.appPing, async () => "pong" as const);
  ipcMain.handle(IPC.lanesList, async (_event, arg) => getCtx().laneService.list(arg));
  // ... 197 total request-response handlers
}
```

Each handler follows a consistent pattern:
1. Extract the current `AppContext` via `getCtx()`
2. Delegate to the appropriate service method
3. Return the result (automatically serialized by Electron's IPC)

The IPC channels are organized by domain (see `shared/ipc.ts` for the full list of 207 channel constants). Major domain groups include: `app`, `project`, `onboarding`, `ci`, `lanes`, `sessions`, `pty`, `diff`, `files`, `git`, `conflicts`, `context`, `packs`, `hosted`, `github`, `prs`, `automations`, `keybindings`, `agentTools`, `terminalProfiles`, `history`, `layout`, `tilingTree`, `graphState`, `processes`, `tests`, `projectConfig`.

### Preload Bridge

The preload script (`preload.ts`) uses `contextBridge.exposeInMainWorld()` to inject a typed `window.ade` object into the renderer. The API surface is organized by 26 subsystems:

```typescript
contextBridge.exposeInMainWorld("ade", {
  app:              { ping, getInfo, getProject, openExternal },
  project:          { openRepo, openAdeFolder, clearLocalData, exportConfig,
                      listRecent, switchToPath, forgetRecent },
  keybindings:      { get, set },
  agentTools:       { detect },
  terminalProfiles: { get, set },
  onboarding:       { getStatus, detectDefaults, detectExistingLanes,
                      generateInitialPacks, complete },
  ci:               { scan, import: importCi },
  automations:      { list, toggle, triggerManually, getHistory, getRunDetail,
                      parseNaturalLanguage, validateDraft, saveDraft, simulate,
                      onEvent },
  lanes:            { list, create, createChild, importBranch, attach, rename,
                      reparent, updateAppearance, archive, delete, getStackChain,
                      getChildren, restack, listRestackSuggestions,
                      dismissRestackSuggestion, deferRestackSuggestion,
                      openFolder, onRestackSuggestionsEvent },
  sessions:         { list, get, updateMeta, readTranscriptTail, getDelta },
  pty:              { create, write, resize, dispose, onData, onExit },
  diff:             { getChanges, getFile },
  files:            { writeTextAtomic, listWorkspaces, listTree, readFile,
                      writeText, watch, stopWatching, quickOpen, searchText,
                      createFile, createDirectory, rename, delete: deletePath,
                      onChangeEvent },
  git:              { stageFile, unstageFile, discardFile, restoreStagedFile,
                      commit, listRecentCommits, listCommitFiles, getCommitMessage,
                      revertCommit, cherryPickCommit, stashPush, stashList,
                      stashApply, stashPop, stashDrop, fetch, sync, push,
                      getConflictState, rebaseContinue, rebaseAbort,
                      mergeContinue, mergeAbort },
  conflicts:        { getLaneStatus, listOverlaps, getRiskMatrix, simulateMerge,
                      runPrediction, getBatchAssessment, listProposals,
                      prepareProposal, requestProposal, applyProposal,
                      undoProposal, runExternalResolver, listExternalResolverRuns,
                      commitExternalResolverRun, onEvent },
  context:          { getStatus, generateDocs, openDoc },
  packs:            { getProjectPack, getLanePack, getFeaturePack, getConflictPack,
                      getPlanPack, getProjectExport, getLaneExport,
                      getConflictExport, refreshLanePack, refreshProjectPack,
                      refreshFeaturePack, refreshConflictPack, savePlanPack,
                      applyHostedNarrative, generateNarrative, listVersions,
                      getVersion, diffVersions, updateNarrative, listEvents,
                      listEventsSince, listCheckpoints, getHeadVersion,
                      getDeltaDigest, onEvent },
  github:           { getStatus, setToken, clearToken },
  prs:              { createFromLane, linkToLane, getForLane, listAll, refresh,
                      getStatus, getChecks, getReviews, updateDescription, land,
                      landStack, draftDescription, openInGitHub, onEvent },
  hosted:           { getStatus, getBootstrapConfig, applyBootstrapConfig,
                      signIn, signOut, syncMirror, cleanMirrorData,
                      deleteMirrorData, submitJob, getJob, getArtifact,
                      githubGetStatus, githubConnectStart, githubDisconnect,
                      githubListEvents },
  history:          { listOperations },
  layout:           { get, set },
  tilingTree:       { get, set },
  graphState:       { get, set },
  processes:        { listDefinitions, listRuntime, start, stop, restart, kill,
                      startStack, stopStack, restartStack, startAll, stopAll,
                      getLogTail, onEvent },
  tests:            { listSuites, run, stop, listRuns, getLogTail, onEvent },
  projectConfig:    { get, validate, save, diffAgainstDisk, confirmTrust }
});
```

Request-response methods use `ipcRenderer.invoke()`. Event subscriptions (`onData`, `onExit`, `onEvent`, `onChangeEvent`, `onRestackSuggestionsEvent`) use `ipcRenderer.on()` and return a cleanup function for unsubscription. There are 10 event broadcast channels in total.

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

1. Dispose head watcher (`disposeHeadWatcher()`)
2. Dispose job engine timers (`jobEngine.dispose()`)
3. Dispose PR polling service (`prPollingService.dispose()`)
4. Dispose all test service runners (`testService.disposeAll()`)
5. Dispose all managed processes (`processService.disposeAll()`)
6. Dispose all PTY sessions (`ptyService.disposeAll()`)
7. Flush database to disk (`db.flushNow()`)
8. Close database (`db.close()`)

Each disposal step is wrapped in try/catch to ensure that failures in one service do not prevent cleanup of others.

---

## Integration Points

### Main Process to Renderer

- **IPC invoke/handle**: 197 request-response channels for CRUD operations and queries
- **IPC push events**: 10 broadcast channels for real-time data:
  - `ade.pty.data` -- Terminal output chunks
  - `ade.pty.exit` -- Terminal session exit events
  - `ade.files.change` -- File system change events
  - `ade.processes.event` -- Process log and runtime state changes
  - `ade.tests.event` -- Test run and log events
  - `ade.conflicts.event` -- Conflict prediction and proposal events
  - `ade.packs.event` -- Pack refresh, version, and narrative events
  - `ade.prs.event` -- Pull request status change events
  - `ade.automations.event` -- Automation rule execution events
  - `ade.lanes.restackSuggestions.event` -- Restack suggestion events

### Main Process Internal

Services communicate through direct method calls and callback injection:

- `ptyService` --> `sessionService` (session lifecycle)
- `ptyService` --> `jobEngine` (session end trigger)
- `headWatcher` --> `jobEngine` (HEAD change trigger)
- `headWatcher` --> `automationService` (HEAD change trigger)
- `headWatcher` --> `restackSuggestionService` (evaluate lane)
- `gitService` --> `operationService` (operation tracking)
- `jobEngine` --> `packService` (pack refresh)
- `jobEngine` --> `conflictService` (conflict prediction)
- `jobEngine` --> `hostedAgentService` / `byokLlmService` (narrative generation)
- `packService` --> `operationService` (pack operation tracking)
- `prPollingService` --> `prService` (periodic PR status refresh)

### External Dependencies

- **Git CLI**: All git operations shell out to the system `git` binary
- **User shell**: PTY sessions spawn the user's configured shell (`$SHELL` or `/bin/zsh`)
- **Filesystem**: `.ade/` directory within the project root for all ADE artifacts
- **Global state**: `~/.ade/ade-state.json` (or Electron userData path) for recent projects

---

## Implementation Status

### Completed

- Electron shell with main/renderer/preload architecture
- 197 IPC request-response channels + 10 event broadcast channels, all registered and typed
- Service factory pattern for all 30+ services in AppContext
- Project initialization and switching with full context teardown/rebuild
- Window management with security hardening
- Development build pipeline (Vite + tsup + Electron)
- Production build pipeline
- Ordered shutdown with resource cleanup (head watcher, job engine, PR polling, tests, processes, PTY, DB)
- Global state persistence (recent projects, project switching)
- Error boundary handlers (uncaughtException, unhandledRejection)
- Head watcher for detecting external commits and routing to job engine / automation / restack services
- Preload bridge with 26 subsystems matching the full IPC surface

### Not Yet Implemented

- Multi-window support (currently single window only)
- Auto-update mechanism (Electron autoUpdater)
- Native menu integration (menu bar is hidden)
- System tray support
- Deep linking / custom protocol handler
- Packaged application distribution (DMG, AppImage, NSIS)
- Crash reporting integration
- Telemetry / analytics (by design -- local-first)
