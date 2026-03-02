import { app, BrowserWindow, nativeImage, shell } from "electron";
import { execSync } from "node:child_process";
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
import { createAiIntegrationService } from "./services/ai/aiIntegrationService";
import { createAgentChatService } from "./services/chat/agentChatService";
import { createGithubService } from "./services/github/githubService";
import { createPrService } from "./services/prs/prService";
import { createPrPollingService } from "./services/prs/prPollingService";
import { createQueueLandingService } from "./services/prs/queueLandingService";
import { detectDefaultBaseRef, ensureAdeExcluded, resolveRepoRoot, toProjectInfo, upsertProjectRow } from "./services/projects/projectService";
import { IPC } from "../shared/ipc";
import type { AppContext } from "./services/ipc/registerIpc";
import fs from "node:fs";
import net from "node:net";
import { createMcpRequestHandler } from "../../../mcp-server/src/mcpServer";
import { createEventBuffer, type AdeMcpRuntime, type AdeMcpPaths } from "../../../mcp-server/src/bootstrap";
import { createKeybindingsService } from "./services/keybindings/keybindingsService";
import { createTerminalProfilesService } from "./services/terminalProfiles/terminalProfilesService";
import { createAgentToolsService } from "./services/agentTools/agentToolsService";
import { createOnboardingService } from "./services/onboarding/onboardingService";
import { createAutomationService } from "./services/automations/automationService";
import { createAutomationPlannerService } from "./services/automations/automationPlannerService";
import { createCiService } from "./services/ci/ciService";
import { createRestackSuggestionService } from "./services/lanes/restackSuggestionService";
import { createAutoRebaseService } from "./services/lanes/autoRebaseService";
import { createMissionService } from "./services/missions/missionService";
import { createMissionPreflightService } from "./services/missions/missionPreflightService";
import { createMemoryService } from "./services/memory/memoryService";
import { createOrchestratorService } from "./services/orchestrator/orchestratorService";
import { createAiOrchestratorService } from "./services/orchestrator/aiOrchestratorService";
import { createClaudeOrchestratorAdapter } from "./services/orchestrator/claudeOrchestratorAdapter";
import { createCodexOrchestratorAdapter } from "./services/orchestrator/codexOrchestratorAdapter";
import { createMissionBudgetService } from "./services/orchestrator/missionBudgetService";
import type { Logger } from "./services/logging/logger";

/**
 * Electron apps launched from macOS Dock/Finder inherit a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) that misses user-installed CLI tools like
 * `claude`. Resolve the user's login shell PATH so child processes spawned by
 * the AI SDK can locate the CLI.
 */
function fixElectronShellPath(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return;

  const currentPath = process.env.PATH ?? "";
  // Already rich — likely launched from terminal or already fixed.
  if (currentPath.includes("/usr/local/bin") && currentPath.includes(".local/bin")) return;

  try {
    const loginShell = process.env.SHELL || "/bin/zsh";
    // Use login (-l) shell to source profile, printf to avoid trailing newline.
    const resolved = execSync(`${loginShell} -lc 'printf "%s" "$PATH"'`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    if (resolved && resolved.length > currentPath.length) {
      process.env.PATH = resolved;
    }
  } catch {
    // Shell resolution failed — manually append common paths as fallback.
    const extras = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.nvm/current/bin`,
    ].filter((p) => !currentPath.includes(p));

    if (extras.length) {
      process.env.PATH = `${currentPath}:${extras.join(":")}`;
    }
  }
}

// Must run before any service or child process is created.
fixElectronShellPath();

// The Claude CLI refuses to start if it detects it is inside another Claude Code
// session (nested session guard). ADE is a host app, not a nested session, so
// strip the marker env var so the SDK can spawn the CLI cleanly.
delete process.env.CLAUDECODE;

if (process.env.VITE_DEV_SERVER_URL) {
  // Dev-only: prevent stale Vite optimized-dep URLs from being served from Electron cache.
  app.commandLine.appendSwitch("disable-http-cache");
}

function getRendererUrl(): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return devUrl;
  return `file://${path.join(__dirname, "../renderer/index.html")}`;
}

async function createWindow(logger?: Logger): Promise<BrowserWindow> {
  // Load the app icon from the build directory.
  const iconDir = path.join(__dirname, "../../build");
  const pngPath = path.join(iconDir, "icon.png");
  const icnsPath = path.join(iconDir, "icon.icns");
  const icon = fs.existsSync(pngPath)
    ? nativeImage.createFromPath(pngPath)
    : fs.existsSync(icnsPath)
      ? nativeImage.createFromPath(icnsPath)
      : nativeImage.createEmpty();

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    icon,
    // Hide the native title bar but keep macOS traffic lights.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    // Match renderer theme to avoid a dark flash on load.
    backgroundColor: "#fbf8ee",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Set macOS Dock icon
  if (process.platform === "darwin" && !icon.isEmpty()) {
    app.dock?.setIcon(icon);
  }

  win.setMenuBarVisibility(false);

  win.on("unresponsive", () => {
    logger?.warn("window.unresponsive", {
      windowId: win.id,
      url: win.webContents.getURL()
    });
  });

  win.on("responsive", () => {
    logger?.info("window.responsive", {
      windowId: win.id,
      url: win.webContents.getURL()
    });
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    logger?.error("window.render_process_gone", {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
      url: win.webContents.getURL()
    });
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    try {
      await win.webContents.session.clearCache();
      await win.webContents.session.clearStorageData({
        storages: ["serviceworkers", "cachestorage"]
      });
    } catch (error) {
      logger?.warn("renderer.dev_cache_clear_failed", {
        err: error instanceof Error ? error.message : String(error)
      });
    }
  }

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

  let recoveredOutdatedOptimizeDep = false;
  const devBase = process.env.VITE_DEV_SERVER_URL;
  if (devBase) {
    win.webContents.session.webRequest.onCompleted({ urls: [`${devBase}/*`] }, (details) => {
      if (recoveredOutdatedOptimizeDep) return;
      const isOutdatedOptimizeDep =
        details.statusCode === 504 &&
        details.url.includes("/node_modules/.vite/deps/") &&
        details.url.includes("v=");
      if (!isOutdatedOptimizeDep) return;

      recoveredOutdatedOptimizeDep = true;
      logger?.warn("renderer.optimize_dep_outdated", {
        statusCode: details.statusCode,
        url: details.url
      });
      void win.webContents.reloadIgnoringCache();
    });
  }

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
    const { initApiKeyStore } = await import("./services/ai/apiKeyStore");
    initApiKeyStore(adePaths.adeDir);
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
    let autoRebaseService: ReturnType<typeof createAutoRebaseService> | null = null;

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
      void autoRebaseService
        ?.onHeadChanged({ laneId, reason: args.reason, preHeadSha: prev, postHeadSha })
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

    const aiIntegrationService = createAiIntegrationService({
      db,
      logger,
      projectConfigService
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
      aiIntegrationService,
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
      packService,
      operationService,
      aiIntegrationService,
      conflictPacksDir: path.join(adePaths.packsDir, "conflicts"),
      onEvent: (event) => {
        broadcast(IPC.conflictsEvent, event);
        // Forward rebase events to the dedicated rebaseEvent channel
        if (event.type === "rebase-started" || event.type === "rebase-completed" || event.type === "rebase-needs-updated") {
          broadcast(IPC.rebaseEvent, event);
        }
      }
    });

    autoRebaseService = createAutoRebaseService({
      db,
      logger,
      laneService,
      conflictService,
      projectConfigService,
      onEvent: (event) => broadcast(IPC.lanesAutoRebaseEvent, event)
    });
    // Prime status stream so renderer can render immediately on load.
    void autoRebaseService.emit().catch(() => {});

    jobEngine = createJobEngine({
      logger,
      packService,
      conflictService,
      projectConfigService,
      aiIntegrationService
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
      aiIntegrationService,
      projectConfigService,
      conflictService,
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

    const queueLandingService = createQueueLandingService({
      db,
      logger,
      projectId,
      prService,
      emitEvent: (event) => broadcast(IPC.prsEvent, event)
    });
    queueLandingService.init();

    const fileService = createFileService({
      laneService,
      onLaneWorktreeMutation: ({ laneId, reason }) => {
        jobEngine.onLaneDirtyChanged({ laneId, reason });
      }
    });

    let orchestratorServiceRef: ReturnType<typeof createOrchestratorService> | null = null;
    let aiOrchestratorServiceRef: ReturnType<typeof createAiOrchestratorService> | null = null;
    const onTrackedSessionEnded = ({ laneId, sessionId, exitCode }: { laneId: string; sessionId: string; exitCode: number | null }) => {
      jobEngine?.onSessionEnded({ laneId, sessionId });
      automationService?.onSessionEnded({ laneId, sessionId });
      if (orchestratorServiceRef) {
        void orchestratorServiceRef
          .onTrackedSessionEnded({
            laneId,
            sessionId,
            exitCode
          })
          .catch(() => {});
      }
    };

    const ptyService = createPtyService({
      projectRoot,
      transcriptsDir: adePaths.transcriptsDir,
      laneService,
      sessionService,
      aiIntegrationService,
      logger,
      broadcastData: (ev) => broadcast(IPC.ptyData, ev),
      broadcastExit: (ev) => broadcast(IPC.ptyExit, ev),
      onSessionEnded: onTrackedSessionEnded,
      onSessionRuntimeSignal: (signal) => {
        aiOrchestratorServiceRef?.onSessionRuntimeSignal(signal);
      },
      loadPty
    });

    const agentChatService = createAgentChatService({
      projectRoot,
      adeDir: adePaths.adeDir,
      transcriptsDir: adePaths.transcriptsDir,
      laneService,
      sessionService,
      projectConfigService,
      logger,
      appVersion: app.getVersion(),
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onAgentChatEvent(event);
        broadcast(IPC.agentChatEvent, event);
      },
      onSessionEnded: onTrackedSessionEnded
    });

    // Wire agentChatService into prService for integration resolution
    prService.setAgentChatService(agentChatService);

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
      testService,
      onEvent: (event) => broadcast(IPC.automationsEvent, event)
    });

    const missionService = createMissionService({
      db,
      projectId,
      projectRoot,
      onEvent: (event) => broadcast(IPC.missionsEvent, event)
    });
    const missionBudgetService = createMissionBudgetService({
      db,
      logger,
      projectId,
      projectRoot,
      missionService,
      aiIntegrationService
    });
    const missionPreflightService = createMissionPreflightService({
      logger,
      projectRoot,
      missionService,
      laneService,
      aiIntegrationService,
      projectConfigService,
      missionBudgetService
    });

    const memoryService = createMemoryService(db);

    const orchestratorService = createOrchestratorService({
      db,
      projectId,
      projectRoot,
      packService,
      conflictService,
      ptyService,
      prService,
      projectConfigService,
      memoryService,
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onOrchestratorRuntimeEvent(event);
        broadcast(IPC.orchestratorEvent, event);
      }
    });
    orchestratorServiceRef = orchestratorService;
    const aiOrchestratorService = createAiOrchestratorService({
      db,
      logger,
      missionService,
      orchestratorService,
      agentChatService,
      laneService,
      projectConfigService,
      aiIntegrationService,
      prService,
      projectRoot,
      missionBudgetService,
      onThreadEvent: (event) => broadcast(IPC.orchestratorThreadEvent, event),
      onDagMutation: (event) => broadcast(IPC.orchestratorDagMutation, event)
    });
    aiOrchestratorServiceRef = aiOrchestratorService;
    orchestratorService.registerExecutorAdapter(createClaudeOrchestratorAdapter());
    orchestratorService.registerExecutorAdapter(createCodexOrchestratorAdapter());

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
    let headWatcherActive = false;
    let headWatcherRunning = false;
    let headWatcherDelayMs = 5_000;
    let missingBroadcasted = false;

    const HEAD_WATCHER_MIN_INTERVAL_MS = 5_000;
    const HEAD_WATCHER_MAX_INTERVAL_MS = 20_000;

    const scheduleHeadPoll = (delayMs: number) => {
      if (!headWatcherActive) return;
      if (headWatcherTimer) {
        clearTimeout(headWatcherTimer);
      }
      headWatcherTimer = setTimeout(() => {
        headWatcherTimer = null;
        void pollHeads();
      }, Math.max(HEAD_WATCHER_MIN_INTERVAL_MS, delayMs));
    };

    const pollHeads = async () => {
      if (headWatcherRunning) return;
      headWatcherRunning = true;
      let lanesChecked = 0;
      let changesDetected = false;
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
          lanesChecked += 1;
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
            changesDetected = true;
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
        if (headWatcherActive) {
          if (changesDetected) {
            headWatcherDelayMs = HEAD_WATCHER_MIN_INTERVAL_MS;
          } else if (lanesChecked === 0) {
            headWatcherDelayMs = HEAD_WATCHER_MAX_INTERVAL_MS;
          } else {
            headWatcherDelayMs = Math.min(HEAD_WATCHER_MAX_INTERVAL_MS, headWatcherDelayMs + 2_500);
          }
          scheduleHeadPoll(headWatcherDelayMs);
        }
      }
    };

    const startHeadWatcher = () => {
      if (headWatcherActive) return;
      headWatcherActive = true;
      headWatcherDelayMs = HEAD_WATCHER_MIN_INTERVAL_MS;
      void pollHeads();
    };

    const disposeHeadWatcher = () => {
      headWatcherActive = false;
      if (!headWatcherTimer) return;
      clearTimeout(headWatcherTimer);
      headWatcherTimer = null;
    };

    startHeadWatcher();

    const state = upsertRecentProject(readGlobalState(globalStatePath), project);
    writeGlobalState(globalStatePath, state);

    // Keep project pack initialized even before first terminal session.
    void packService.refreshProjectPack({ reason: "project_init" }).catch((err: unknown) => {
      logger.warn("packs.project_init_failed", { err: String(err) });
    });

    // ── MCP Socket Server (embedded mode) ─────────────────────────
    const mcpEventBuffer = createEventBuffer();
    const mcpRuntime: AdeMcpRuntime = {
      projectRoot,
      projectId,
      project,
      paths: adePaths as unknown as AdeMcpPaths,
      logger,
      db,
      laneService,
      sessionService,
      operationService,
      projectConfigService,
      packService,
      conflictService,
      gitService,
      diffService,
      missionService,
      ptyService,
      testService,
      prService,
      memoryService,
      orchestratorService,
      aiOrchestratorService,
      eventBuffer: mcpEventBuffer,
      dispose: () => {} // desktop manages service lifecycle
    };

    const mcpHandler = createMcpRequestHandler({ runtime: mcpRuntime, serverVersion: app.getVersion() });
    const mcpSocketPath = path.join(adePaths.adeDir, "mcp.sock");

    // Clean stale socket from prior crash
    try { fs.unlinkSync(mcpSocketPath); } catch {}

    const mcpSocketServer = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsed: any;
          try { parsed = JSON.parse(line); } catch { continue; }
          const id = parsed.id ?? null;
          void mcpHandler(parsed).then((result) => {
            if (id !== null && id !== undefined) {
              conn.write(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? {} }) + "\n");
            }
          }).catch((err: any) => {
            if (id !== null && id !== undefined) {
              conn.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: err?.message ?? String(err) } }) + "\n");
            }
          });
        }
      });
      conn.on("error", () => {}); // ignore connection errors
    });
    mcpSocketServer.listen(mcpSocketPath);
    logger.info("mcp.socket_server_started", { socketPath: mcpSocketPath });

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
      autoRebaseService,
      sessionService,
      ptyService,
      diffService,
      fileService,
      operationService,
      gitService,
      conflictService,
      aiIntegrationService,
      githubService,
      prService,
      prPollingService,
      queueLandingService,
      jobEngine,
      automationService,
      automationPlannerService,
      missionService,
      missionPreflightService,
      orchestratorService,
      missionBudgetService,
      aiOrchestratorService,
      ciService,
      agentChatService,
      packService,
      projectConfigService,
      processService,
      testService,
      mcpSocketServer,
      mcpSocketPath
    };
  };

  let closeContextPromise: Promise<void> | null = null;

  const closeContext = async () => {
    if (closeContextPromise) {
      await closeContextPromise;
      return;
    }
    const ctx = ctxRef;
    closeContextPromise = (async () => {
      try {
        ctx.disposeHeadWatcher();
      } catch {
        // ignore
      }
      try {
        ctx.prPollingService.dispose();
      } catch {
        // ignore
      }
      try {
        ctx.automationService.dispose();
      } catch {
        // ignore
      }
      try {
        ctx.aiOrchestratorService.dispose();
      } catch {
        // ignore
      }
      try {
        ctx.jobEngine.dispose();
      } catch {
        // ignore
      }
      try {
        ctx.fileService.dispose();
      } catch {
        // ignore
      }
      try {
        ctx.testService.disposeAll();
      } catch {
        // ignore
      }
      try {
        ctx.processService.disposeAll();
      } catch {
        // ignore
      }
      try {
        ctx.ptyService.disposeAll();
      } catch {
        // ignore
      }
      try {
        await ctx.agentChatService.disposeAll();
      } catch {
        // ignore
      }
      try {
        ctx.mcpSocketServer?.close();
      } catch {
        // ignore
      }
      try {
        if (ctx.mcpSocketPath) fs.unlinkSync(ctx.mcpSocketPath);
      } catch {
        // ignore
      }
      try {
        ctx.db.flushNow();
        ctx.db.close();
      } catch {
        // ignore
      }
    })().finally(() => {
      closeContextPromise = null;
    });
    await closeContextPromise;
  };

  const switchProjectFromDialog = async (selectedPath: string) => {
    const repoRoot = await resolveRepoRoot(selectedPath); // require a real git repo for onboarding.
    const baseRef = await detectDefaultBaseRef(repoRoot);
    await closeContext();
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
  app.on("child-process-gone", (_event, details) => {
    ctxRef.logger.warn("app.child_process_gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName ?? null,
      name: details.name ?? null
    });
  });

  registerIpc({
    getCtx: () => ctxRef,
    switchProjectFromDialog,
    globalStatePath
  });

  await createWindow(ctxRef.logger);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow(ctxRef.logger);
    }
  });

  let quitAfterCleanup = false;
  app.on("before-quit", (event) => {
    if (quitAfterCleanup) return;
    quitAfterCleanup = true;
    event.preventDefault();
    ctxRef.logger.info("app.before_quit");
    void closeContext()
      .catch(() => {
        // ignore
      })
      .finally(() => {
        app.quit();
      });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
