import { app, BrowserWindow, nativeImage, shell } from "electron";
import { execSync } from "node:child_process";
import path from "node:path";
import { registerIpc } from "./services/ipc/registerIpc";
import { createFileLogger } from "./services/logging/logger";
import { openKvDb } from "./services/state/kvDb";
import { ensureAdeDirs } from "./services/state/projectState";
import { readGlobalState, upsertRecentProject, writeGlobalState } from "./services/state/globalState";
import { createLaneService } from "./services/lanes/laneService";
import { createLaneEnvironmentService } from "./services/lanes/laneEnvironmentService";
import { createLaneTemplateService } from "./services/lanes/laneTemplateService";
import { createPortAllocationService } from "./services/lanes/portAllocationService";
import { createLaneProxyService } from "./services/lanes/laneProxyService";
import { createOAuthRedirectService } from "./services/lanes/oauthRedirectService";
import { createRuntimeDiagnosticsService } from "./services/lanes/runtimeDiagnosticsService";
import { createContextDocService } from "./services/context/contextDocService";
import { createSessionService } from "./services/sessions/sessionService";
import { createSessionDeltaService } from "./services/sessions/sessionDeltaService";
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
import { createQueueRehearsalService } from "./services/prs/queueRehearsalService";
import { detectDefaultBaseRef, ensureAdeExcluded, resolveRepoRoot, toProjectInfo, upsertProjectRow } from "./services/projects/projectService";
import { IPC } from "../shared/ipc";
import type { ProjectInfo } from "../shared/types";
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
import { createUsageTrackingService } from "./services/usage/usageTrackingService";
import { createBudgetCapService } from "./services/usage/budgetCapService";
import { createCiService } from "./services/ci/ciService";
import { createRebaseSuggestionService } from "./services/lanes/rebaseSuggestionService";
import { createAutoRebaseService } from "./services/lanes/autoRebaseService";
import { createMissionService } from "./services/missions/missionService";
import { createMissionPreflightService } from "./services/missions/missionPreflightService";
import { createCompactionFlushService } from "./services/memory/compactionFlushService";
import { createBatchConsolidationService } from "./services/memory/batchConsolidationService";
import { createEmbeddingService } from "./services/memory/embeddingService";
import { createEmbeddingWorkerService } from "./services/memory/embeddingWorkerService";
import { createHybridSearchService } from "./services/memory/hybridSearchService";
import { createUnifiedMemoryService } from "./services/memory/unifiedMemoryService";
import { createMemoryLifecycleService } from "./services/memory/memoryLifecycleService";
import { createMemoryBriefingService } from "./services/memory/memoryBriefingService";
import { createMissionMemoryLifecycleService } from "./services/memory/missionMemoryLifecycleService";
import { createEpisodicSummaryService } from "./services/memory/episodicSummaryService";
import { createHumanWorkDigestService } from "./services/memory/humanWorkDigestService";
import { createProceduralLearningService } from "./services/memory/proceduralLearningService";
import { createSkillRegistryService } from "./services/memory/skillRegistryService";
import { createCtoStateService } from "./services/cto/ctoStateService";
import { createWorkerAgentService } from "./services/cto/workerAgentService";
import { createWorkerRevisionService } from "./services/cto/workerRevisionService";
import { createWorkerBudgetService } from "./services/cto/workerBudgetService";
import { createWorkerAdapterRuntimeService } from "./services/cto/workerAdapterRuntimeService";
import { createWorkerTaskSessionService } from "./services/cto/workerTaskSessionService";
import { createWorkerHeartbeatService } from "./services/cto/workerHeartbeatService";
import { createLinearCredentialService } from "./services/cto/linearCredentialService";
import { createLinearClient } from "./services/cto/linearClient";
import { createLinearIssueTracker } from "./services/cto/linearIssueTracker";
import { createLinearTemplateService } from "./services/cto/linearTemplateService";
import { createFlowPolicyService } from "./services/cto/flowPolicyService";
import { createLinearRoutingService } from "./services/cto/linearRoutingService";
import { createLinearOutboundService } from "./services/cto/linearOutboundService";
import { createLinearSyncService } from "./services/cto/linearSyncService";
import { createOrchestratorService } from "./services/orchestrator/orchestratorService";
import { createAiOrchestratorService } from "./services/orchestrator/aiOrchestratorService";
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
    // Match renderer dark theme to avoid a flash on load.
    backgroundColor: "#0F0D14",
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

  const toErrorMessage = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  // Set CSP dynamically so it works with both http:// (dev) and file:// (production).
  const isDevMode = !!process.env.VITE_DEV_SERVER_URL;
  const cspSources = isDevMode
    ? "'self' http://localhost:* http://127.0.0.1:*"
    : "'self' file: app:";
  const cspWsSources = isDevMode ? " ws://localhost:* ws://127.0.0.1:*" : "";
  const cspImageSources = `${cspSources} https://avatars.githubusercontent.com`;
  const cspPolicy = [
    `default-src ${cspSources}`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `script-src ${cspSources} 'unsafe-inline'`,
    `style-src ${cspSources} 'unsafe-inline'`,
    `img-src ${cspImageSources} data: blob:`,
    `font-src ${cspSources} data:`,
    `connect-src ${cspSources}${cspWsSources} https:`,
    `worker-src 'self' blob:`,
  ].join("; ");

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [cspPolicy],
      },
    });
  });

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

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    logger?.error("window.preload_error", {
      windowId: win.id,
      preloadPath,
      err: toErrorMessage(error)
    });
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logger?.error("window.did_fail_load", {
      windowId: win.id,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame
    });
  });

  win.webContents.on("did-finish-load", () => {
    logger?.info("window.did_finish_load", {
      windowId: win.id,
      url: win.webContents.getURL()
    });
  });

  win.webContents.on("dom-ready", () => {
    logger?.info("window.dom_ready", {
      windowId: win.id,
      url: win.webContents.getURL()
    });
  });

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const payload = {
      windowId: win.id,
      level,
      message,
      line,
      sourceId
    };
    if (level >= 2) {
      logger?.error("window.console", payload);
      return;
    }
    if (level === 1) {
      logger?.warn("window.console", payload);
      return;
    }
    logger?.info("window.console", payload);
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

  const rendererUrl = getRendererUrl();
  logger?.info("window.loading_url", {
    windowId: win.id,
    url: rendererUrl
  });

  try {
    await win.loadURL(rendererUrl);
  } catch (error) {
    logger?.error("window.load_url_failed", {
      windowId: win.id,
      url: rendererUrl,
      err: toErrorMessage(error)
    });
    const fallbackHtml = encodeURIComponent(
      `<html><body style="margin:0;background:#0f0d14;color:#f8f8f2;font-family:monospace;padding:24px;">` +
      `<h2 style="margin:0 0 12px;">ADE failed to load renderer</h2>` +
      `<p style="margin:0 0 8px;">URL: ${rendererUrl.replace(/</g, "&lt;")}</p>` +
      `<p style="margin:0;">Error: ${toErrorMessage(error).replace(/</g, "&lt;")}</p>` +
      `</body></html>`
    );
    await win.loadURL(`data:text/html;charset=UTF-8,${fallbackHtml}`);
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

app.whenReady().then(async () => {
  const globalStatePath = path.join(app.getPath("userData"), "ade-state.json");
  const saved = readGlobalState(globalStatePath);
  const fallbackProjectRoot = path.resolve(app.getPath("userData"), "ade-project");
  const normalizeProjectPath = (value: string) => path.resolve(value);
  const isLikelyRepoRoot = (value: string) => {
    const resolved = normalizeProjectPath(value);
    return (
      resolved.length > 0 &&
      resolved !== fallbackProjectRoot &&
      fs.existsSync(resolved) &&
      fs.existsSync(path.join(resolved, ".git"))
    );
  };

  const cleanedRecentProjects = (saved.recentProjects ?? []).reduce(
    (acc, entry) => {
      const rootPath = typeof entry?.rootPath === "string" ? normalizeProjectPath(entry.rootPath) : "";
      if (!isLikelyRepoRoot(rootPath)) return acc;
      if (acc.some((item) => item.rootPath === rootPath)) return acc;
      const displayName = typeof entry?.displayName === "string" && entry.displayName.trim().length > 0
        ? entry.displayName
        : path.basename(rootPath);
      const lastOpenedAt = typeof entry?.lastOpenedAt === "string" && entry.lastOpenedAt.trim().length > 0
        ? entry.lastOpenedAt
        : new Date().toISOString();
      acc.push({ rootPath, displayName, lastOpenedAt });
      return acc;
    },
    [] as Array<{ rootPath: string; displayName: string; lastOpenedAt: string }>
  );
  const hadRecentProjectsChanges =
    cleanedRecentProjects.length !== (saved.recentProjects ?? []).length;
  const cleanedLastProjectRoot = saved.lastProjectRoot
    ? normalizeProjectPath(saved.lastProjectRoot)
    : "";
  const validLastProjectRoot =
    isLikelyRepoRoot(cleanedLastProjectRoot) && cleanedRecentProjects.some((project) => project.rootPath === cleanedLastProjectRoot)
      ? cleanedLastProjectRoot
      : "";
  const hadLastProjectRootChanges = saved.lastProjectRoot !== validLastProjectRoot;
  const normalizedState = {
    ...saved,
    lastProjectRoot: validLastProjectRoot || undefined,
    recentProjects: cleanedRecentProjects
  };

  if (hadRecentProjectsChanges || hadLastProjectRootChanges) {
    writeGlobalState(globalStatePath, normalizedState);
  }

  const envRoot = process.env.ADE_PROJECT_ROOT;
  const devFallbackProject = process.env.VITE_DEV_SERVER_URL
    ? path.resolve(process.cwd(), "..", "..")
    : fallbackProjectRoot;

  const startupUserSelected = Boolean(envRoot && envRoot.trim().length);
  const initialCandidate = envRoot && envRoot.trim().length
    ? normalizeProjectPath(envRoot)
    : devFallbackProject;

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

  const normalizeProjectRoot = (projectRoot: string) => path.resolve(projectRoot);
  const projectContexts = new Map<string, AppContext>();
  const closeContextPromises = new Map<string, Promise<void>>();
  let activeProjectRoot: string | null = null;
  let dormantContext!: AppContext;

  const setActiveProject = (projectRoot: string | null): void => {
    activeProjectRoot = projectRoot ? normalizeProjectRoot(projectRoot) : null;
  };

  const getActiveContext = (): AppContext => {
    if (activeProjectRoot) {
      const ctx = projectContexts.get(activeProjectRoot);
      if (ctx) return ctx;
      activeProjectRoot = null;
    }
    return dormantContext;
  };

  const emitProjectEvent = (projectRoot: string, channel: string, payload: unknown): void => {
    if (!activeProjectRoot) return;
    if (normalizeProjectRoot(projectRoot) !== activeProjectRoot) return;
    broadcast(channel, payload);
  };

  const initContextForProjectRoot = async ({
    projectRoot,
    baseRef,
    ensureExclude,
    recordLastProject = true,
    recordRecent = true,
    userSelectedProject = false
  }: {
    projectRoot: string;
    baseRef: string;
    ensureExclude: boolean;
    recordLastProject?: boolean;
    recordRecent?: boolean;
    userSelectedProject?: boolean;
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
    let rebaseSuggestionService: ReturnType<typeof createRebaseSuggestionService> | null = null;
    let autoRebaseService: ReturnType<typeof createAutoRebaseService> | null = null;
    let humanWorkDigestService: ReturnType<typeof createHumanWorkDigestService> | null = null;

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
      const laneTypeRow = db.get<{ lane_type: string | null }>(
        `select lane_type from lanes where id = ? and project_id = ? limit 1`,
        [laneId, projectId]
      );
      if (String(laneTypeRow?.lane_type ?? "").trim() === "primary") {
        void humanWorkDigestService
          .onHeadChanged({ preHeadSha: prev, postHeadSha })
          .catch(() => {});
      }
      void rebaseSuggestionService
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
      onHeadChanged: handleHeadChanged,
      onRebaseEvent: (event) => emitProjectEvent(projectRoot, IPC.lanesRebaseEvent, event)
    });
    await laneService.ensurePrimaryLane();

    const laneEnvironmentService = createLaneEnvironmentService({
      projectRoot,
      adeDir: adePaths.adeDir,
      logger,
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.lanesEnvEvent, ev)
    });

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

    const laneTemplateService = createLaneTemplateService({
      projectConfigService,
      logger
    });

    const portAllocationService = createPortAllocationService({
      logger,
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.lanesPortEvent, ev),
      persistLeases: (leases) => db.setJson("port_leases", leases),
      loadLeases: () => db.getJson<import("../shared/types").PortLease[]>("port_leases") ?? [],
    });
    portAllocationService.restore();

    // Recover orphaned leases on startup
    (async () => {
      try {
        const lanes = await laneService.list({ includeArchived: false, includeStatus: false });
        const validIds = new Set(lanes.map((l) => l.id));
        portAllocationService.recoverOrphans(validIds);
        for (const lane of lanes) {
          const lease = portAllocationService.getLease(lane.id);
          if (lease?.status === "active") continue;
          try {
            portAllocationService.acquire(lane.id);
          } catch (error: any) {
            logger.warn("port_allocation.startup_acquire_failed", {
              laneId: lane.id,
              error: error?.message ?? String(error),
            });
          }
        }
        portAllocationService.detectConflicts();
      } catch (err: any) {
        logger.warn("port_allocation.startup_recovery_failed", { error: err?.message });
      }
    })();

    const laneProxyService = createLaneProxyService({
      logger,
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.lanesProxyEvent, ev),
    });

    const oauthRedirectService = createOAuthRedirectService({
      logger,
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.lanesOAuthEvent, ev),
      getRoutes: () => laneProxyService.listRoutes(),
      getProxyPort: () => laneProxyService.getConfig().proxyPort,
      getHostnameSuffix: () => laneProxyService.getConfig().hostnameSuffix,
      forwardToPort: (req, res, port) => laneProxyService.forwardToPort(req, res, port),
    });

    // Register OAuth callback interceptor on the proxy
    laneProxyService.registerInterceptor((req, res) =>
      oauthRedirectService.handleRequest(req, res),
    );

    const runtimeDiagnosticsService = createRuntimeDiagnosticsService({
      logger,
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.lanesDiagnosticsEvent, ev),
      getPortLease: (laneId) => portAllocationService.getLease(laneId),
      getPortConflicts: () => portAllocationService.listConflicts(),
      detectPortConflicts: () => portAllocationService.detectConflicts(),
      getProxyStatus: () => laneProxyService.getStatus(),
      getProxyRoute: (laneId) => laneProxyService.getRoute(laneId),
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
      onEvent: () => {}
    });

    const onboardingService = createOnboardingService({
      db,
      logger,
      projectRoot,
      projectId,
      baseRef,
      laneService,
      projectConfigService
    });

    rebaseSuggestionService = createRebaseSuggestionService({
      db,
      logger,
      projectId,
      laneService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.lanesRebaseSuggestionsEvent, event)
    });
    // Prime suggestions once on init so the UI can show them without waiting for a head change.
    void rebaseSuggestionService
      .listSuggestions()
      .then((suggestions) =>
        emitProjectEvent(projectRoot, IPC.lanesRebaseSuggestionsEvent, {
          type: "rebase-suggestions-updated",
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
      operationService,
      aiIntegrationService,
      sessionService,
      conflictPacksDir: path.join(adePaths.packsDir, "conflicts"),
      onEvent: (event) => {
        emitProjectEvent(projectRoot, IPC.conflictsEvent, event);
        // Forward rebase events to the dedicated rebaseEvent channel
        if (event.type === "rebase-started" || event.type === "rebase-completed" || event.type === "rebase-needs-updated") {
          emitProjectEvent(projectRoot, IPC.rebaseEvent, event);
        }
      }
    });

    autoRebaseService = createAutoRebaseService({
      db,
      logger,
      laneService,
      conflictService,
      projectConfigService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.lanesAutoRebaseEvent, event)
    });
    // Prime status stream so renderer can render immediately on load.
    void autoRebaseService.emit().catch(() => {});

    jobEngine = createJobEngine({
      logger,
      conflictService,
    });

    const prService = createPrService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      operationService,
      githubService,
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
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.prsEvent, event)
    });

    let orchestratorServiceRef: ReturnType<typeof createOrchestratorService> | null = null;
    let aiOrchestratorServiceRef: ReturnType<typeof createAiOrchestratorService> | null = null;
    const queueLandingService = createQueueLandingService({
      db,
      logger,
      projectId,
      prService,
      laneService,
      conflictService,
      emitEvent: (event) => emitProjectEvent(projectRoot, IPC.prsEvent, event),
      onStateChanged: (state) => {
        aiOrchestratorServiceRef?.onQueueLandingStateChanged?.(state);
      }
    });
    queueLandingService.init();
    const queueRehearsalService = createQueueRehearsalService({
      db,
      logger,
      projectId,
      prService,
      laneService,
      conflictService,
      emitEvent: (event) => emitProjectEvent(projectRoot, IPC.prsEvent, event),
      onStateChanged: (state) => {
        aiOrchestratorServiceRef?.onQueueRehearsalStateChanged?.(state);
      }
    });
    queueRehearsalService.init();

    const fileService = createFileService({
      laneService,
      onLaneWorktreeMutation: ({ laneId, reason }) => {
        jobEngine.onLaneDirtyChanged({ laneId, reason });
      }
    });

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
      projectConfigService,
      logger,
      broadcastData: (ev) => emitProjectEvent(projectRoot, IPC.ptyData, ev),
      broadcastExit: (ev) => emitProjectEvent(projectRoot, IPC.ptyExit, ev),
      onSessionEnded: onTrackedSessionEnded,
      onSessionRuntimeSignal: (signal) => {
        aiOrchestratorServiceRef?.onSessionRuntimeSignal(signal);
      },
      loadPty
    });

    const sessionDeltaService = createSessionDeltaService({
      db,
      projectId,
      laneService,
      sessionService
    });

    let batchConsolidationServiceRef: ReturnType<typeof createBatchConsolidationService> | null = null;
    let embeddingWorkerServiceRef: ReturnType<typeof createEmbeddingWorkerService> | null = null;
    const embeddingService = createEmbeddingService({
      logger,
      cacheDir: path.join(app.getPath("userData"), "transformers-cache"),
    });
    const hybridSearchService = createHybridSearchService({
      db,
      embeddingService,
    });
    const memoryService = createUnifiedMemoryService(db, {
      hybridSearchService,
      onMemoryMutated: () => {
        batchConsolidationServiceRef?.scheduleAutoConsolidationCheck();
      },
      onMemoryUpserted: (event) => {
        if ((event.created || event.contentChanged) && embeddingService.isAvailable()) {
          embeddingWorkerServiceRef?.queueMemory(event.memory.id);
        }
      },
    });
    const compactionFlushService = createCompactionFlushService(undefined, { logger });
    aiIntegrationService.setCompactionFlushService(compactionFlushService);
    const batchConsolidationService = createBatchConsolidationService({
      db,
      logger,
      aiIntegrationService,
      projectConfigService,
      projectId,
      projectRoot,
      onStatus: (event) => emitProjectEvent(projectRoot, IPC.memoryConsolidationStatus, event)
    });
    batchConsolidationServiceRef = batchConsolidationService;
    const memoryLifecycleService = createMemoryLifecycleService({
      db,
      logger,
      projectId,
      onStatus: (event) => emitProjectEvent(projectRoot, IPC.memorySweepStatus, event)
    });
    const embeddingWorkerService = createEmbeddingWorkerService({
      db,
      logger,
      projectId,
      embeddingService,
      sessionService,
    });
    embeddingWorkerServiceRef = embeddingWorkerService;
    const memoryBriefingService = createMemoryBriefingService({
      memoryService,
    });
    const missionMemoryLifecycleService = createMissionMemoryLifecycleService({
      logger,
      memoryService,
    });
    const proceduralLearningService = createProceduralLearningService({
      db,
      logger,
      projectId,
      memoryService,
    });
    const episodicSummaryService = createEpisodicSummaryService({
      projectId,
      projectRoot,
      logger,
      aiIntegrationService,
      memoryService,
      onEpisodeSaved: (memoryId) => proceduralLearningService.onEpisodeSaved(memoryId),
    });
    humanWorkDigestService = createHumanWorkDigestService({
      projectId,
      projectRoot,
      logger,
      memoryService,
    });
    const skillRegistryService = createSkillRegistryService({
      db,
      projectId,
      projectRoot,
      logger,
      memoryService,
      proceduralLearningService,
    });
    const contextDocService = createContextDocService({
      db,
      logger,
      projectRoot,
      projectId,
      packsDir: adePaths.packsDir,
      laneService,
      projectConfigService,
      aiIntegrationService
    });

    const ctoStateService = createCtoStateService({
      db,
      projectId,
      adeDir: adePaths.adeDir
    });

    const workerAgentService = createWorkerAgentService({
      db,
      projectId,
      adeDir: adePaths.adeDir,
    });

    const workerRevisionService = createWorkerRevisionService({
      db,
      projectId,
      workerAgentService,
    });

    const workerTaskSessionService = createWorkerTaskSessionService({
      db,
      projectId,
    });

    const workerAdapterRuntimeService = createWorkerAdapterRuntimeService();

    const workerBudgetService = createWorkerBudgetService({
      db,
      projectId,
      workerAgentService,
      projectConfigService,
    });

    const workerHeartbeatService = createWorkerHeartbeatService({
      db,
      projectId,
      workerAgentService,
      workerAdapterRuntimeService,
      workerTaskSessionService,
      workerBudgetService,
      memoryService,
      memoryBriefingService,
      ctoStateService,
      logger,
    });

    const linearCredentialService = createLinearCredentialService({
      adeDir: adePaths.adeDir,
      logger,
    });
    const linearClient = createLinearClient({
      credentials: linearCredentialService,
      logger,
    });
    const linearIssueTracker = createLinearIssueTracker({
      client: linearClient,
    });
    const linearTemplateService = createLinearTemplateService({
      adeDir: adePaths.adeDir,
    });
    const flowPolicyService = createFlowPolicyService({
      db,
      projectId,
      projectConfigService,
    });
    const linearRoutingService = createLinearRoutingService({
      projectRoot,
      workerAgentService,
      aiIntegrationService,
      flowPolicyService,
    });
    const linearOutboundService = createLinearOutboundService({
      db,
      projectId,
      projectRoot,
      issueTracker: linearIssueTracker,
      logger,
    });

    const agentChatService = createAgentChatService({
      projectRoot,
      adeDir: adePaths.adeDir,
      transcriptsDir: adePaths.transcriptsDir,
      projectId,
      memoryService,
      packService,
      workerAgentService,
      episodicSummaryService,
      laneService,
      sessionService,
      projectConfigService,
      ctoStateService,
      logger,
      appVersion: app.getVersion(),
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onAgentChatEvent(event);
        emitProjectEvent(projectRoot, IPC.agentChatEvent, event);
      },
      onSessionEnded: onTrackedSessionEnded
    });

    // Wire agentChatService into prService for integration resolution
    prService.setAgentChatService(agentChatService);

    const gitService = createGitOperationsService({
      laneService,
      operationService,
      projectConfigService,
      aiIntegrationService,
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
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.processesEvent, ev)
    });

    const testService = createTestService({
      db,
      projectId,
      testLogsDir: adePaths.testLogsDir,
      logger,
      laneService,
      projectConfigService,
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.testsEvent, ev)
    });

    automationService = createAutomationService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      conflictService,
      testService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.automationsEvent, event)
    });

    const missionService = createMissionService({
      db,
      projectId,
      projectRoot,
      onEvent: (event) => {
        emitProjectEvent(projectRoot, IPC.missionsEvent, event);
        if (event.missionId) {
          automationService?.onMissionUpdated({ missionId: event.missionId });
        }
        if (event.reason === "ready_to_start" && event.missionId) {
          void aiOrchestratorServiceRef?.startMissionRun({
            missionId: event.missionId,
          }).catch((error) => {
            logger.warn("missions.queue_autostart_failed", {
              missionId: event.missionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    });
    // Run phase built-in migration/cleanup once at startup so launcher state is canonical.
    try {
      missionService.listPhaseProfiles({ includeArchived: true });
      missionService.listPhaseItems({ includeArchived: true });
    } catch (error) {
      logger.warn("missions.phase_storage_seed_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const missionBudgetService = createMissionBudgetService({
      db,
      logger,
      projectId,
      projectRoot,
      missionService,
      aiIntegrationService,
      projectConfigService,
    });
    const missionPreflightService = createMissionPreflightService({
      logger,
      projectRoot,
      missionService,
      laneService,
      aiIntegrationService,
      projectConfigService,
      missionBudgetService,
      humanWorkDigestService,
    });

    const orchestratorService = createOrchestratorService({
      db,
      projectId,
      projectRoot,
      packService,
      conflictService,
      ptyService,
      agentChatService,
      prService,
      projectConfigService,
      aiIntegrationService,
      memoryService,
      memoryBriefingService,
      missionMemoryLifecycleService,
      episodicSummaryService,
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onOrchestratorRuntimeEvent(event);
        emitProjectEvent(projectRoot, IPC.orchestratorEvent, event);
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
      conflictService,
      queueLandingService,
      queueRehearsalService,
      projectRoot,
      missionBudgetService,
      humanWorkDigestService,
      missionMemoryLifecycleService,
      onThreadEvent: (event) => emitProjectEvent(projectRoot, IPC.orchestratorThreadEvent, event),
      onDagMutation: (event) => emitProjectEvent(projectRoot, IPC.orchestratorDagMutation, event)
    });
    aiOrchestratorServiceRef = aiOrchestratorService;
    try {
      missionService.processQueue();
    } catch (error) {
      logger.warn("missions.queue_autostart_bootstrap_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const linearSyncService = createLinearSyncService({
      db,
      logger,
      projectId,
      projectRoot,
      issueTracker: linearIssueTracker,
      flowPolicyService,
      routingService: linearRoutingService,
      templateService: linearTemplateService,
      outboundService: linearOutboundService,
      workerAgentService,
      missionService,
      aiOrchestratorService,
      orchestratorService,
      autoStart: true,
    });

    // Resume any active team runtimes that were running before app restart
    setImmediate(() => aiOrchestratorService.resumeActiveTeamRuntimes());

    const automationPlannerService = createAutomationPlannerService({
      logger,
      projectRoot,
      projectConfigService,
      laneService,
      automationService
    });

    const usageTrackingService = createUsageTrackingService({
      logger,
      pollIntervalMs: 120_000,
      onUpdate: (snapshot) => {
        emitProjectEvent(projectRoot, IPC.usageEvent, snapshot);
      }
    });
    usageTrackingService.start();

    const budgetCapService = createBudgetCapService({
      db,
      logger,
      projectConfigService,
      usageTrackingService
    });
    automationService?.bindMissionRuntime({
      missionService,
      aiOrchestratorService,
      memoryBriefingService,
      proceduralLearningService,
      budgetCapService,
    });

    void memoryLifecycleService.runStartupSweepIfDue().catch((error) => {
      logger.warn("memory.lifecycle.startup_sweep_failed", {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    void batchConsolidationService.runAutoConsolidationIfNeeded().catch((error: unknown) => {
      logger.warn("memory.consolidation.startup_check_failed", {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    void embeddingWorkerService.start().catch((error) => {
      logger.warn("memory.embedding_worker.start_failed", {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    void humanWorkDigestService.syncKnowledge().catch((error) => {
      logger.warn("memory.human_digest.startup_sync_failed", {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void skillRegistryService.start().catch((error) => {
      logger.warn("memory.skill_registry.start_failed", {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Head watcher: detects commits/rebases made outside ADE's Git UI (e.g. in the terminal),
    // then routes them through the same onHeadChanged pipeline (packs, automations, rebase suggestions).
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
            emitProjectEvent(projectRoot, IPC.projectMissing, { rootPath: projectRoot });
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

    const state = upsertRecentProject(readGlobalState(globalStatePath), project, {
      recordLastProject,
      recordRecent
    });
    writeGlobalState(globalStatePath, state);

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
      ctoStateService,
      workerAgentService,
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
      hasUserSelectedProject: userSelectedProject,
      disposeHeadWatcher,
      keybindingsService,
      terminalProfilesService,
      agentToolsService,
      onboardingService,
      laneService,
      laneEnvironmentService,
      laneTemplateService,
      portAllocationService,
      laneProxyService,
      oauthRedirectService,
      runtimeDiagnosticsService,
      rebaseSuggestionService,
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
      queueRehearsalService,
      jobEngine,
      automationService,
      automationPlannerService,
      usageTrackingService,
      budgetCapService,
      missionService,
      missionPreflightService,
      orchestratorService,
      missionBudgetService,
      aiOrchestratorService,
      ciService,
      agentChatService,
      packService,
      contextDocService,
      projectConfigService,
      processService,
      sessionDeltaService,
      testService,
      memoryService,
      batchConsolidationService,
      memoryLifecycleService,
      memoryBriefingService,
      missionMemoryLifecycleService,
      episodicSummaryService,
      humanWorkDigestService,
      proceduralLearningService,
      skillRegistryService,
      embeddingService,
      embeddingWorkerService,
      ctoStateService,
      workerAgentService,
      workerRevisionService,
      workerBudgetService,
      workerHeartbeatService,
      workerTaskSessionService,
      linearCredentialService,
      linearIssueTracker,
      flowPolicyService,
      linearRoutingService,
      linearSyncService,
      mcpSocketServer,
      mcpSocketPath
    };
  };

  const createDormantProjectContext = (projectRoot = ""): AppContext => {
    const rootIsDefined = typeof projectRoot === "string" && projectRoot.trim().length > 0;
    const normalizedRoot = rootIsDefined ? path.resolve(projectRoot) : "";
    const project = {
      rootPath: normalizedRoot,
      displayName: normalizedRoot ? path.basename(normalizedRoot) : "",
      baseRef: "main"
    };
    const logger = createFileLogger(path.join(app.getPath("userData"), "ade-idle.jsonl"));
    return ({
      db: null,
      logger,
      project,
      hasUserSelectedProject: false,
      projectId: "",
      adeDir: "",
      disposeHeadWatcher: () => {},
      keybindingsService: null,
      terminalProfilesService: null,
      agentToolsService: null,
      onboardingService: null,
      ciService: null,
      laneService: null,
      laneEnvironmentService: null,
      laneTemplateService: null,
      rebaseSuggestionService: null,
      autoRebaseService: null,
      sessionService: null,
      ptyService: null,
      diffService: null,
      fileService: null,
      operationService: null,
      gitService: null,
      conflictService: null,
      aiIntegrationService: null,
      agentChatService: null,
      githubService: null,
      prService: null,
      prPollingService: null,
      queueLandingService: null,
      queueRehearsalService: null,
      jobEngine: null,
      automationService: null,
      automationPlannerService: null,
      usageTrackingService: null,
      budgetCapService: null,
      missionService: null,
      missionPreflightService: null,
      orchestratorService: null,
      missionBudgetService: null,
      aiOrchestratorService: null,
      packService: null,
      contextDocService: null,
      projectConfigService: null,
      processService: null,
      sessionDeltaService: null,
      testService: null,
      embeddingService: null,
      embeddingWorkerService: null,
      memoryService: null,
      batchConsolidationService: null,
      memoryLifecycleService: null,
      memoryBriefingService: null,
      missionMemoryLifecycleService: null,
      episodicSummaryService: null,
      humanWorkDigestService: null,
      proceduralLearningService: null,
      skillRegistryService: null,
      ctoStateService: null,
      workerAgentService: null,
      workerRevisionService: null,
      workerBudgetService: null,
      workerHeartbeatService: null,
      workerTaskSessionService: null,
      linearCredentialService: null,
      linearIssueTracker: null,
      flowPolicyService: null,
      linearRoutingService: null,
      linearSyncService: null
    } as unknown as AppContext);
  };

  const disposeContextResources = async (ctx: AppContext): Promise<void> => {
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
      ctx.usageTrackingService?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.aiOrchestratorService.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.linearSyncService?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.workerHeartbeatService?.dispose();
    } catch {
      // ignore
    }
    try {
      await ctx.skillRegistryService?.dispose?.();
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
  };

  const closeProjectContext = async (projectRoot: string): Promise<void> => {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const existingPromise = closeContextPromises.get(normalizedRoot);
    if (existingPromise) {
      await existingPromise;
      return;
    }
    const ctx = projectContexts.get(normalizedRoot);
    if (!ctx) return;

    const closePromise = (async () => {
      await disposeContextResources(ctx);
      projectContexts.delete(normalizedRoot);
      if (activeProjectRoot === normalizedRoot) {
        activeProjectRoot = null;
      }
    })().finally(() => {
      closeContextPromises.delete(normalizedRoot);
    });
    closeContextPromises.set(normalizedRoot, closePromise);
    await closePromise;
  };

  const closeAllProjectContexts = async (): Promise<void> => {
    const roots = Array.from(projectContexts.keys());
    for (const root of roots) {
      await closeProjectContext(root);
    }
    setActiveProject(null);
  };

  const persistRecentProject = (
    project: ProjectInfo,
    options: { recordLastProject?: boolean; recordRecent?: boolean } = {}
  ): void => {
    const state = upsertRecentProject(readGlobalState(globalStatePath), project, options);
    writeGlobalState(globalStatePath, state);
  };

  const switchProjectFromDialog = async (selectedPath: string): Promise<ProjectInfo> => {
    const repoRoot = normalizeProjectRoot(await resolveRepoRoot(selectedPath)); // require a real git repo for onboarding.
    const existing = projectContexts.get(repoRoot);
    if (existing) {
      existing.hasUserSelectedProject = true;
      setActiveProject(repoRoot);
      persistRecentProject(existing.project, { recordLastProject: true, recordRecent: false });
      return existing.project;
    }

    const baseRef = await detectDefaultBaseRef(repoRoot);
    const ctx = await initContextForProjectRoot({
      projectRoot: repoRoot,
      baseRef,
      ensureExclude: true,
      recordLastProject: true,
      recordRecent: true,
      userSelectedProject: true
    });
    projectContexts.set(repoRoot, ctx);
    setActiveProject(repoRoot);
    return ctx.project;
  };

  const closeProjectByPath = async (projectRoot: string): Promise<void> => {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const wasActive = activeProjectRoot === normalizedRoot;
    await closeProjectContext(normalizedRoot);
    if (wasActive) {
      dormantContext = createDormantProjectContext(normalizedRoot);
    }
  };

  const closeCurrentProject = async () => {
    const current = getActiveContext();
    const previousRoot = current.project?.rootPath;
    if (activeProjectRoot) {
      await closeProjectContext(activeProjectRoot);
    }
    setActiveProject(null);
    dormantContext = createDormantProjectContext(previousRoot);
  };

  dormantContext = createDormantProjectContext();

  // Initial project context: only load a user-specified project automatically (e.g. ADE_PROJECT_ROOT).
  // Otherwise, start in a no-project state until the user selects one.
  if (startupUserSelected) {
    try {
      await switchProjectFromDialog(initialCandidate);
    } catch {
      setActiveProject(null);
      dormantContext = createDormantProjectContext();
    }
  }

  process.on("uncaughtException", (err) => {
    getActiveContext().logger.error("process.uncaught_exception", {
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
  });
  process.on("unhandledRejection", (reason) => {
    getActiveContext().logger.error("process.unhandled_rejection", { reason: String(reason) });
  });
  app.on("child-process-gone", (_event, details) => {
    getActiveContext().logger.warn("app.child_process_gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName ?? null,
      name: details.name ?? null
    });
  });

  registerIpc({
    getCtx: () => getActiveContext(),
    switchProjectFromDialog,
    closeCurrentProject,
    closeProjectByPath,
    globalStatePath
  });

  await createWindow(getActiveContext().logger);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow(getActiveContext().logger);
    }
  });

  let quitAfterCleanup = false;
  app.on("before-quit", (event) => {
    if (quitAfterCleanup) return;
    quitAfterCleanup = true;
    event.preventDefault();
    getActiveContext().logger.info("app.before_quit");
    void closeAllProjectContexts()
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
