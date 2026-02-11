import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type {
  AppInfo,
  ArchiveLaneArgs,
  CreateLaneArgs,
  DiffChanges,
  DockLayout,
  FileDiff,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  LaneSummary,
  ListLanesArgs,
  ListSessionsArgs,
  ListTestRunsArgs,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessEvent,
  ProcessRuntime,
  ProcessStackArgs,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectInfo,
  PtyCreateArgs,
  PtyCreateResult,
  PtyDataEvent,
  PtyExitEvent,
  ReadTranscriptTailArgs,
  RenameLaneArgs,
  RunTestSuiteArgs,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  TestEvent,
  TestRunSummary,
  TestSuiteDefinition,
  WriteTextAtomicArgs
} from "../shared/types";

contextBridge.exposeInMainWorld("ade", {
  app: {
    ping: async (): Promise<"pong"> => ipcRenderer.invoke(IPC.appPing),
    getInfo: async (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    getProject: async (): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.appGetProject)
  },
  project: {
    openRepo: async (): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.projectOpenRepo),
    openAdeFolder: async (): Promise<void> => ipcRenderer.invoke(IPC.projectOpenAdeFolder)
  },
  lanes: {
    list: async (args: ListLanesArgs = {}): Promise<LaneSummary[]> => ipcRenderer.invoke(IPC.lanesList, args),
    create: async (args: CreateLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesCreate, args),
    rename: async (args: RenameLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesRename, args),
    archive: async (args: ArchiveLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesArchive, args),
    openFolder: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.lanesOpenFolder, args)
  },
  sessions: {
    list: async (args: ListSessionsArgs = {}): Promise<TerminalSessionSummary[]> =>
      ipcRenderer.invoke(IPC.sessionsList, args),
    get: async (sessionId: string): Promise<TerminalSessionDetail | null> =>
      ipcRenderer.invoke(IPC.sessionsGet, { sessionId }),
    readTranscriptTail: async (args: ReadTranscriptTailArgs): Promise<string> =>
      ipcRenderer.invoke(IPC.sessionsReadTranscriptTail, args)
  },
  pty: {
    create: async (args: PtyCreateArgs): Promise<PtyCreateResult> => ipcRenderer.invoke(IPC.ptyCreate, args),
    write: async (arg: { ptyId: string; data: string }): Promise<void> => ipcRenderer.invoke(IPC.ptyWrite, arg),
    resize: async (arg: { ptyId: string; cols: number; rows: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.ptyResize, arg),
    dispose: async (arg: { ptyId: string }): Promise<void> => ipcRenderer.invoke(IPC.ptyDispose, arg),
    onData: (cb: (ev: PtyDataEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent) => cb(payload);
      ipcRenderer.on(IPC.ptyData, listener);
      return () => ipcRenderer.removeListener(IPC.ptyData, listener);
    },
    onExit: (cb: (ev: PtyExitEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent) => cb(payload);
      ipcRenderer.on(IPC.ptyExit, listener);
      return () => ipcRenderer.removeListener(IPC.ptyExit, listener);
    }
  },
  diff: {
    getChanges: async (args: GetDiffChangesArgs): Promise<DiffChanges> => ipcRenderer.invoke(IPC.diffGetChanges, args),
    getFile: async (args: GetFileDiffArgs): Promise<FileDiff> => ipcRenderer.invoke(IPC.diffGetFile, args)
  },
  files: {
    writeTextAtomic: async (args: WriteTextAtomicArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.filesWriteTextAtomic, args)
  },
  layout: {
    get: async (layoutId: string): Promise<DockLayout | null> => ipcRenderer.invoke(IPC.layoutGet, { layoutId }),
    set: async (layoutId: string, layout: DockLayout): Promise<void> =>
      ipcRenderer.invoke(IPC.layoutSet, { layoutId, layout })
  },
  processes: {
    listDefinitions: async (): Promise<ProcessDefinition[]> => ipcRenderer.invoke(IPC.processesListDefinitions),
    listRuntime: async (): Promise<ProcessRuntime[]> => ipcRenderer.invoke(IPC.processesListRuntime),
    start: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesStart, args),
    stop: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesStop, args),
    restart: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesRestart, args),
    kill: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesKill, args),
    startStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesStartStack, args),
    stopStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesStopStack, args),
    restartStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesRestartStack, args),
    startAll: async (): Promise<void> => ipcRenderer.invoke(IPC.processesStartAll),
    stopAll: async (): Promise<void> => ipcRenderer.invoke(IPC.processesStopAll),
    getLogTail: async (args: GetProcessLogTailArgs): Promise<string> => ipcRenderer.invoke(IPC.processesGetLogTail, args),
    onEvent: (cb: (ev: ProcessEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProcessEvent) => cb(payload);
      ipcRenderer.on(IPC.processesEvent, listener);
      return () => ipcRenderer.removeListener(IPC.processesEvent, listener);
    }
  },
  tests: {
    listSuites: async (): Promise<TestSuiteDefinition[]> => ipcRenderer.invoke(IPC.testsListSuites),
    run: async (args: RunTestSuiteArgs): Promise<TestRunSummary> => ipcRenderer.invoke(IPC.testsRun, args),
    stop: async (args: StopTestRunArgs): Promise<void> => ipcRenderer.invoke(IPC.testsStop, args),
    listRuns: async (args: ListTestRunsArgs = {}): Promise<TestRunSummary[]> => ipcRenderer.invoke(IPC.testsListRuns, args),
    getLogTail: async (args: GetTestLogTailArgs): Promise<string> => ipcRenderer.invoke(IPC.testsGetLogTail, args),
    onEvent: (cb: (ev: TestEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TestEvent) => cb(payload);
      ipcRenderer.on(IPC.testsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.testsEvent, listener);
    }
  },
  projectConfig: {
    get: async (): Promise<ProjectConfigSnapshot> => ipcRenderer.invoke(IPC.projectConfigGet),
    validate: async (candidate: ProjectConfigCandidate): Promise<ProjectConfigValidationResult> =>
      ipcRenderer.invoke(IPC.projectConfigValidate, { candidate }),
    save: async (candidate: ProjectConfigCandidate): Promise<ProjectConfigSnapshot> =>
      ipcRenderer.invoke(IPC.projectConfigSave, { candidate }),
    diffAgainstDisk: async (): Promise<ProjectConfigDiff> => ipcRenderer.invoke(IPC.projectConfigDiffAgainstDisk),
    confirmTrust: async (arg: { sharedHash?: string } = {}): Promise<ProjectConfigTrust> =>
      ipcRenderer.invoke(IPC.projectConfigConfirmTrust, arg)
  }
});
