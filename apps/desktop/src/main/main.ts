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
import { runGit } from "./services/git/git";
import { createPackService } from "./services/packs/packService";
import { createJobEngine } from "./services/jobs/jobEngine";
import { createHostedAgentService } from "./services/hosted/hostedAgentService";
import { createByokLlmService } from "./services/byok/byokLlmService";
import { createGithubService } from "./services/github/githubService";
import { createPrService } from "./services/prs/prService";
import { createPrPollingService } from "./services/prs/prPollingService";
import { detectDefaultBaseRef, ensureAdeExcluded, resolveRepoRoot, toProjectInfo, upsertProjectRow } from "./services/projects/projectService";
import { IPC } from "../shared/ipc";
import type { AppContext } from "./services/ipc/registerIpc";
import fs from "node:fs";
import { createKeybindingsService } from "./services/keybindings/keybindingsService";
import { createTerminalProfilesService } from "./services/terminalProfiles/terminalProfilesService";
import { createAgentToolsService } from "./services/agentTools/agentToolsService";
import { createOnboardingService } from "./services/onboarding/onboardingService";
import { createAutomationService } from "./services/automations/automationService";
import { createAutomationPlannerService } from "./services/automations/automationPlannerService";
import { createCiService } from "./services/ci/ciService";
import { createRestackSuggestionService } from "./services/lanes/restackSuggestionService";

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
    const keybindingsService = createKeybindingsService({ db });
    const terminalProfilesService = createTerminalProfilesService({ db });
    const agentToolsService = createAgentToolsService({ logger });

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
    let automationService: ReturnType<typeof createAutomationService> | null = null;
    let restackSuggestionService: ReturnType<typeof createRestackSuggestionService> | null = null;

    const lastHeadByLaneId = new Map<string, string>();

    const handleHeadChanged = (args: {
      laneId: string;
      reason: string;
      preHeadSha: string | null;
      postHeadSha: string | null;
    }) => {
      const laneId = args.laneId;
      const postHeadSha = (args.postHeadSha ?? "").trim();
      if (!laneId || !postHeadSha) return;

      const prev = lastHeadByLaneId.get(laneId) ?? (args.preHeadSha ?? null);
      if (prev === postHeadSha) {
        lastHeadByLaneId.set(laneId, postHeadSha);
        return;
      }

      lastHeadByLaneId.set(laneId, postHeadSha);

      jobEngine?.onHeadChanged({ laneId, reason: args.reason });
      automationService?.onHeadChanged({
        laneId,
        reason: args.reason,
        preHeadSha: prev,
        postHeadSha
      });
      void restackSuggestionService
        ?.onParentHeadChanged({ laneId, reason: args.reason, preHeadSha: prev, postHeadSha })
        .catch(() => {});
    };

    const laneService = createLaneService({
      db,
      projectRoot,
      projectId,
      defaultBaseRef: baseRef,
      worktreesDir: adePaths.worktreesDir,
      operationService,
      onHeadChanged: handleHeadChanged
    });
    await laneService.ensurePrimaryLane();

    const sessionService = createSessionService({ db });
    const reconciledSessions = sessionService.reconcileStaleRunningSessions({ status: "disposed" });
    if (reconciledSessions > 0) {
      logger.warn("sessions.reconciled_stale_running", { count: reconciledSessions });
    }
    const diffService = createDiffService({ laneService });
    const projectConfigService = createProjectConfigService({
      projectRoot,
      adeDir: adePaths.adeDir,
      projectId,
      db,
      logger
    });

    const ciService = createCiService({
      db,
      logger,
      projectRoot,
      projectConfigService
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
      operationService,
      onEvent: (event) => broadcast(IPC.packsEvent, event)
    });

    const onboardingService = createOnboardingService({
      db,
      logger,
      projectRoot,
      projectId,
      baseRef,
      laneService,
      packService,
      projectConfigService
    });

    restackSuggestionService = createRestackSuggestionService({
      db,
      logger,
      projectId,
      laneService,
      onEvent: (event) => broadcast(IPC.lanesRestackSuggestionsEvent, event)
    });
    // Prime suggestions once on init so the UI can show them without waiting for a head change.
    void restackSuggestionService
      .listSuggestions()
      .then((suggestions) =>
        broadcast(IPC.lanesRestackSuggestionsEvent, {
          type: "restack-suggestions-updated",
          computedAt: new Date().toISOString(),
          suggestions
        })
      )
      .catch(() => { });

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
      projectRoot,
      projectConfigService,
      hostedAgentService
    });

    const conflictService = createConflictService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      packService,
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
      hostedAgentService,
      projectConfigService,
      byokLlmService
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

    const prPollingService = createPrPollingService({
      logger,
      prService,
      projectConfigService,
      onEvent: (event) => broadcast(IPC.prsEvent, event)
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
        automationService?.onSessionEnded({ laneId, sessionId });
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
      onHeadChanged: handleHeadChanged
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

    automationService = createAutomationService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      packService,
      conflictService,
      hostedAgentService,
      testService,
      onEvent: (event) => broadcast(IPC.automationsEvent, event)
    });

    const automationPlannerService = createAutomationPlannerService({
      logger,
      projectRoot,
      projectConfigService,
      laneService,
      automationService
    });

    // Head watcher: detects commits/rebases made outside ADE's Git UI (e.g. in the terminal),
    // then routes them through the same onHeadChanged pipeline (packs, automations, restack suggestions).
    let headWatcherTimer: NodeJS.Timeout | null = null;
    let headWatcherRunning = false;
    let missingBroadcasted = false;

    const pollHeads = async () => {
      if (headWatcherRunning) return;
      headWatcherRunning = true;
      try {
        // Check if the active project root still exists on disk.
        if (!fs.existsSync(projectRoot)) {
          if (!missingBroadcasted) {
            missingBroadcasted = true;
            broadcast(IPC.projectMissing, { rootPath: projectRoot });
          }
        } else {
          missingBroadcasted = false;
        }
        const rows = db.all<{ id: string; worktree_path: string }>(
          `
            select id, worktree_path
            from lanes
            where project_id = ?
              and status != 'archived'
          `,
          [projectId]
        );

        const active = new Set<string>();
        for (const row of rows) {
          const laneId = String(row.id ?? "").trim();
          const worktreePath = String(row.worktree_path ?? "");
          if (!laneId || !worktreePath) continue;
          active.add(laneId);

          const head = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
          if (head.exitCode !== 0) continue;
          const sha = head.stdout.trim();
          if (!sha) continue;

          const prev = lastHeadByLaneId.get(laneId);
          if (!prev) {
            lastHeadByLaneId.set(laneId, sha);
            continue;
          }
          if (prev !== sha) {
            handleHeadChanged({ laneId, reason: "head_watcher", preHeadSha: prev, postHeadSha: sha });
          }
        }

        for (const laneId of Array.from(lastHeadByLaneId.keys())) {
          if (!active.has(laneId)) lastHeadByLaneId.delete(laneId);
        }
      } catch (err) {
        logger.warn("git.head_watcher_failed", { err: err instanceof Error ? err.message : String(err) });
      } finally {
        headWatcherRunning = false;
      }
    };

    const startHeadWatcher = () => {
      if (headWatcherTimer) return;
      void pollHeads();
      headWatcherTimer = setInterval(() => {
        void pollHeads();
      }, 5_000);
    };

    const disposeHeadWatcher = () => {
      if (!headWatcherTimer) return;
      clearInterval(headWatcherTimer);
      headWatcherTimer = null;
    };

    startHeadWatcher();

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
      disposeHeadWatcher,
      keybindingsService,
      terminalProfilesService,
      agentToolsService,
      onboardingService,
      laneService,
      restackSuggestionService,
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
      prPollingService,
      jobEngine,
      automationService,
      automationPlannerService,
      ciService,
      packService,
      projectConfigService,
      processService,
      testService
    };
  };

  const closeContext = () => {
    try {
      ctxRef.disposeHeadWatcher();
    } catch {
      // ignore
    }
    try {
      ctxRef.prPollingService.dispose();
    } catch {
      // ignore
    }
    try {
      ctxRef.automationService.dispose();
    } catch {
      // ignore
    }
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
    switchProjectFromDialog,
    globalStatePath
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
