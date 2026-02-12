import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { registerIpc } from "./services/ipc/registerIpc";
import { createFileLogger } from "./services/logging/logger";
import { openKvDb } from "./services/state/kvDb";
import { ensureAdeDirs } from "./services/state/projectState";
import { readGlobalState, upsertRecentProject, writeGlobalState } from "./services/state/globalState";
import { createLaneService } from "./services/lanes/laneService";
import { createSessionService } from "./services/sessions/sessionService";
import { createPtyService } from "./services/pty/ptyService";
import { createDiffService } from "./services/diffs/diffService";
import { createFileService } from "./services/files/fileService";
import { createConflictService } from "./services/conflicts/conflictService";
import { createProjectConfigService } from "./services/config/projectConfigService";
import { createProcessService } from "./services/processes/processService";
import { createTestService } from "./services/tests/testService";
import { createOperationService } from "./services/history/operationService";
import { createGitOperationsService } from "./services/git/gitOperationsService";
import { createPackService } from "./services/packs/packService";
import { createJobEngine } from "./services/jobs/jobEngine";
import { createHostedAgentService } from "./services/hosted/hostedAgentService";
import { createByokLlmService } from "./services/byok/byokLlmService";
import { createGithubService } from "./services/github/githubService";
import { createPrService } from "./services/prs/prService";
import { detectDefaultBaseRef, ensureAdeExcluded, resolveRepoRoot, toProjectInfo, upsertProjectRow } from "./services/projects/projectService";
import { IPC } from "../shared/ipc";
import type { AppContext } from "./services/ipc/registerIpc";
import fs from "node:fs";

function getRendererUrl(): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return devUrl;
  return `file://${path.join(__dirname, "../renderer/index.html")}`;
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // Match renderer theme to avoid a dark flash on load.
    backgroundColor: "#fbf8ee",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenuBarVisibility(false);

  // Block unexpected external navigation/window creation.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = getRendererUrl();
    if (process.env.VITE_DEV_SERVER_URL) {
      // In dev we allow vite's HMR websocket/etc.
      const devBase = process.env.VITE_DEV_SERVER_URL;
      if (devBase && url.startsWith(devBase)) return;
    }
    if (url === allowed) return;
    event.preventDefault();
  });

  await win.loadURL(getRendererUrl());

  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

app.whenReady().then(async () => {
  const globalStatePath = path.join(app.getPath("userData"), "ade-state.json");
  const saved = readGlobalState(globalStatePath);

  const envRoot = process.env.ADE_PROJECT_ROOT;
  const initialCandidate =
    envRoot && envRoot.trim().length
      ? path.resolve(envRoot)
      : saved.lastProjectRoot && fs.existsSync(saved.lastProjectRoot)
        ? saved.lastProjectRoot
        : process.env.VITE_DEV_SERVER_URL
          ? path.resolve(process.cwd(), "..", "..")
          : path.resolve(app.getPath("userData"), "ade-project");

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        // ignore
      }
    }
  };

  const loadPty = () => {
    // node-pty is a native dependency; keep the require inside the main process runtime.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node-pty") as typeof import("node-pty");
  };

  let ctxRef!: AppContext;

  const initContextForProjectRoot = async ({
    projectRoot,
    baseRef,
    ensureExclude
  }: {
    projectRoot: string;
    baseRef: string;
    ensureExclude: boolean;
  }): Promise<AppContext> => {
    const adePaths = ensureAdeDirs(projectRoot);
    const logger = createFileLogger(path.join(adePaths.logsDir, "main.jsonl"));

    logger.info("project.init", { projectRoot, baseRef, ensureExclude });

    const db = await openKvDb(adePaths.dbPath, logger);

    // Avoid surprising git changes; use .git/info/exclude by default.
    if (ensureExclude) {
      try {
        await ensureAdeExcluded(projectRoot);
      } catch (err) {
        logger.warn("project.exclude_failed", { projectRoot, err: String(err) });
      }
    }

    const project = toProjectInfo(projectRoot, baseRef);
    const { projectId } = upsertProjectRow({ db, repoRoot: projectRoot, displayName: project.displayName, baseRef });

    const operationService = createOperationService({ db, projectId });
    let jobEngine: ReturnType<typeof createJobEngine> | null = null;
    const laneService = createLaneService({
      db,
      projectRoot,
      projectId,
      defaultBaseRef: baseRef,
      worktreesDir: adePaths.worktreesDir,
      operationService,
      onHeadChanged: ({ laneId, reason }) => {
        jobEngine?.onHeadChanged({ laneId, reason });
      }
    });
    await laneService.ensurePrimaryLane();
    const sessionService = createSessionService({ db });
    const diffService = createDiffService({ laneService });
    const projectConfigService = createProjectConfigService({
      projectRoot,
      adeDir: adePaths.adeDir,
      projectId,
      db,
      logger
    });

    const packService = createPackService({
      db,
      logger,
      projectRoot,
      projectId,
      packsDir: adePaths.packsDir,
      laneService,
      sessionService,
      projectConfigService,
      operationService
    });

    const hostedAgentService = createHostedAgentService({
      logger,
      projectId,
      projectRoot,
      projectDisplayName: project.displayName,
      adeDir: adePaths.adeDir,
      laneService,
      projectConfigService,
      openExternal: async (url) => {
        await shell.openExternal(url);
      }
    });

    const byokLlmService = createByokLlmService({
      logger,
      projectConfigService
    });

    const githubService = createGithubService({
      logger,
      adeDir: adePaths.adeDir,
      projectRoot
    });

    const conflictService = createConflictService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      operationService,
      hostedAgentService,
      byokLlmService,
      conflictPacksDir: path.join(adePaths.packsDir, "conflicts"),
      onEvent: (event) => broadcast(IPC.conflictsEvent, event)
    });

    jobEngine = createJobEngine({
      logger,
      packService,
      conflictService,
      hostedAgentService
    });

    const prService = createPrService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      operationService,
      githubService,
      packService,
      hostedAgentService,
      byokLlmService,
      projectConfigService,
      openExternal: async (url) => {
        await shell.openExternal(url);
      }
    });

    const fileService = createFileService({
      laneService,
      onLaneWorktreeMutation: ({ laneId, reason }) => {
        jobEngine.onLaneDirtyChanged({ laneId, reason });
      }
    });

    const ptyService = createPtyService({
      projectRoot,
      transcriptsDir: adePaths.transcriptsDir,
      laneService,
      sessionService,
      logger,
      broadcastData: (ev) => broadcast(IPC.ptyData, ev),
      broadcastExit: (ev) => broadcast(IPC.ptyExit, ev),
      onSessionEnded: ({ laneId, sessionId }) => {
        jobEngine.onSessionEnded({ laneId, sessionId });
      },
      loadPty
    });

    const gitService = createGitOperationsService({
      laneService,
      operationService,
      logger,
      onWorktreeChanged: ({ laneId, reason }) => {
        jobEngine.onLaneDirtyChanged({ laneId, reason });
      },
      onHeadChanged: ({ laneId, reason }) => {
        jobEngine.onHeadChanged({ laneId, reason });
      }
    });

    const processService = createProcessService({
      db,
      projectId,
      processLogsDir: adePaths.processLogsDir,
      logger,
      laneService,
      projectConfigService,
      broadcastEvent: (ev) => broadcast(IPC.processesEvent, ev)
    });

    const testService = createTestService({
      db,
      projectId,
      testLogsDir: adePaths.testLogsDir,
      logger,
      laneService,
      projectConfigService,
      broadcastEvent: (ev) => broadcast(IPC.testsEvent, ev)
    });

    const state = upsertRecentProject(readGlobalState(globalStatePath), project);
    writeGlobalState(globalStatePath, state);

    // Keep project pack initialized even before first terminal session.
    void packService.refreshProjectPack({ reason: "project_init" }).catch((err: unknown) => {
      logger.warn("packs.project_init_failed", { err: String(err) });
    });

    return {
      db,
      logger,
      project,
      projectId,
      adeDir: adePaths.adeDir,
      laneService,
      sessionService,
      ptyService,
      diffService,
      fileService,
      operationService,
      gitService,
      conflictService,
      hostedAgentService,
      byokLlmService,
      githubService,
      prService,
      jobEngine,
      packService,
      projectConfigService,
      processService,
      testService
    };
  };

  const closeContext = () => {
    try {
      ctxRef.jobEngine.dispose();
    } catch {
      // ignore
    }
    try {
      ctxRef.fileService.dispose();
    } catch {
      // ignore
    }
    try {
      ctxRef.testService.disposeAll();
    } catch {
      // ignore
    }
    try {
      ctxRef.processService.disposeAll();
    } catch {
      // ignore
    }
    try {
      ctxRef.ptyService.disposeAll();
    } catch {
      // ignore
    }
    try {
      ctxRef.db.flushNow();
      ctxRef.db.close();
    } catch {
      // ignore
    }
  };

  const switchProjectFromDialog = async (selectedPath: string) => {
    const repoRoot = await resolveRepoRoot(selectedPath); // require a real git repo for onboarding.
    const baseRef = await detectDefaultBaseRef(repoRoot);
    closeContext();
    ctxRef = await initContextForProjectRoot({ projectRoot: repoRoot, baseRef, ensureExclude: true });
    return ctxRef.project;
  };

  // Initial project: prefer last opened repo; if missing/non-git, start in a minimal local state until onboarding.
  try {
    const repoRoot = await resolveRepoRoot(initialCandidate);
    const baseRef = await detectDefaultBaseRef(repoRoot);
    ctxRef = await initContextForProjectRoot({ projectRoot: repoRoot, baseRef, ensureExclude: true });
  } catch {
    ctxRef = await initContextForProjectRoot({ projectRoot: initialCandidate, baseRef: "main", ensureExclude: false });
  }

  process.on("uncaughtException", (err) => {
    ctxRef.logger.error("process.uncaught_exception", {
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
  });
  process.on("unhandledRejection", (reason) => {
    ctxRef.logger.error("process.unhandled_rejection", { reason: String(reason) });
  });

  registerIpc({
    getCtx: () => ctxRef,
    switchProjectFromDialog
  });

  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });

  app.on("before-quit", () => {
    ctxRef.logger.info("app.before_quit");
    closeContext();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
