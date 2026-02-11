import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC } from "../../../shared/ipc";
import type {
  AppInfo,
  ArchiveLaneArgs,
  CreateLaneArgs,
  DockLayout,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  LaneSummary,
  ListLanesArgs,
  ListSessionsArgs,
  ProjectInfo,
  PtyCreateArgs,
  PtyCreateResult,
  RenameLaneArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  WriteTextAtomicArgs
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createPtyService } from "../pty/ptyService";
import type { createDiffService } from "../diffs/diffService";
import type { createFileService } from "../files/fileService";

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
};

function clampLayout(layout: DockLayout): DockLayout {
  const out: DockLayout = {};
  for (const [k, v] of Object.entries(layout)) {
    if (!Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(100, v));
  }
  return out;
}

export function registerIpc({
  getCtx,
  switchProjectFromDialog
}: {
  getCtx: () => AppContext;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
}) {
  ipcMain.handle(IPC.appPing, async () => "pong" as const);

  ipcMain.handle(IPC.appGetProject, async () => getCtx().project);

  ipcMain.handle(IPC.appGetInfo, async (): Promise<AppInfo> => {
    return {
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node ?? "unknown",
        v8: process.versions.v8 ?? "unknown"
      },
      env: {
        nodeEnv: process.env.NODE_ENV,
        viteDevServerUrl: process.env.VITE_DEV_SERVER_URL
      }
    };
  });

  ipcMain.handle(IPC.projectOpenRepo, async (event): Promise<ProjectInfo> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "Open repository",
      properties: ["openDirectory"]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return getCtx().project;
    }
    const selected = result.filePaths[0]!;
    return await switchProjectFromDialog(selected);
  });

  ipcMain.handle(IPC.projectOpenAdeFolder, async (): Promise<void> => {
    const ctx = getCtx();
    await shell.openPath(ctx.adeDir);
  });

  ipcMain.handle(IPC.layoutGet, async (_event, arg: { layoutId: string }): Promise<DockLayout | null> => {
    const ctx = getCtx();
    const key = `dock_layout:${arg.layoutId}`;
    const value = ctx.db.getJson<DockLayout>(key);
    ctx.logger.debug("layout.get", { key, hit: value != null });
    return value;
  });

  ipcMain.handle(IPC.layoutSet, async (_event, arg: { layoutId: string; layout: DockLayout }): Promise<void> => {
    const ctx = getCtx();
    const key = `dock_layout:${arg.layoutId}`;
    const safe = clampLayout(arg.layout);
    ctx.db.setJson(key, safe);
    ctx.logger.debug("layout.set", { key, panels: Object.keys(safe).length });
  });

  ipcMain.handle(IPC.lanesList, async (_event, arg: ListLanesArgs): Promise<LaneSummary[]> => {
    const ctx = getCtx();
    return await ctx.laneService.list(arg);
  });

  ipcMain.handle(IPC.lanesCreate, async (_event, arg: CreateLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.create({ name: arg.name, description: arg.description });
  });

  ipcMain.handle(IPC.lanesRename, async (_event, arg: RenameLaneArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.laneService.rename(arg);
  });

  ipcMain.handle(IPC.lanesArchive, async (_event, arg: ArchiveLaneArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.laneService.archive(arg);
  });

  ipcMain.handle(IPC.lanesOpenFolder, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    const worktreePath = ctx.laneService.getLaneWorktreePath(arg.laneId);
    await shell.openPath(worktreePath);
  });

  ipcMain.handle(IPC.sessionsList, async (_event, arg: ListSessionsArgs): Promise<TerminalSessionSummary[]> => {
    const ctx = getCtx();
    return ctx.sessionService.list(arg);
  });

  ipcMain.handle(IPC.sessionsGet, async (_event, arg: { sessionId: string }): Promise<TerminalSessionDetail | null> => {
    const ctx = getCtx();
    return ctx.sessionService.get(arg.sessionId);
  });

  ipcMain.handle(IPC.sessionsReadTranscriptTail, async (_event, arg: { sessionId: string; maxBytes?: number }): Promise<string> => {
    const ctx = getCtx();
    const session = ctx.sessionService.get(arg.sessionId);
    if (!session) return "";
    const maxBytes = typeof arg.maxBytes === "number" ? Math.max(1024, Math.min(2_000_000, arg.maxBytes)) : 160_000;
    return ctx.sessionService.readTranscriptTail(session.transcriptPath, maxBytes);
  });

  ipcMain.handle(IPC.ptyCreate, async (_event, arg: PtyCreateArgs): Promise<PtyCreateResult> => {
    const ctx = getCtx();
    return await ctx.ptyService.create(arg);
  });

  ipcMain.handle(IPC.ptyWrite, async (_event, arg: { ptyId: string; data: string }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.write(arg);
  });

  ipcMain.handle(IPC.ptyResize, async (_event, arg: { ptyId: string; cols: number; rows: number }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.resize(arg);
  });

  ipcMain.handle(IPC.ptyDispose, async (_event, arg: { ptyId: string }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.dispose(arg);
  });

  ipcMain.handle(IPC.diffGetChanges, async (_event, arg: GetDiffChangesArgs) => {
    const ctx = getCtx();
    return await ctx.diffService.getChanges(arg.laneId);
  });

  ipcMain.handle(IPC.diffGetFile, async (_event, arg: GetFileDiffArgs) => {
    const ctx = getCtx();
    return await ctx.diffService.getFileDiff({ laneId: arg.laneId, filePath: arg.path, mode: arg.mode });
  });

  ipcMain.handle(IPC.filesWriteTextAtomic, async (_event, arg: WriteTextAtomicArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.writeTextAtomic({ laneId: arg.laneId, relPath: arg.path, text: arg.text });
  });
}
