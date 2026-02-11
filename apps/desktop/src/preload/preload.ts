import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type {
  AppInfo,
  ArchiveLaneArgs,
  CreateLaneArgs,
  DiffChanges,
  FileDiff,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  LaneSummary,
  ListLanesArgs,
  ListSessionsArgs,
  OpenLaneFolderArgs,
  PtyCreateArgs,
  PtyCreateResult,
  PtyDataEvent,
  PtyExitEvent,
  ReadTranscriptTailArgs,
  RenameLaneArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  WriteTextAtomicArgs,
  DockLayout,
  ProjectInfo
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
    openFolder: async (args: OpenLaneFolderArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesOpenFolder, args)
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
    resize: async (arg: { ptyId: string; cols: number; rows: number }): Promise<void> => ipcRenderer.invoke(IPC.ptyResize, arg),
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
    writeTextAtomic: async (args: WriteTextAtomicArgs): Promise<void> => ipcRenderer.invoke(IPC.filesWriteTextAtomic, args)
  },
  layout: {
    get: async (layoutId: string): Promise<DockLayout | null> =>
      ipcRenderer.invoke(IPC.layoutGet, { layoutId }),
    set: async (layoutId: string, layout: DockLayout): Promise<void> =>
      ipcRenderer.invoke(IPC.layoutSet, { layoutId, layout })
  }
});
