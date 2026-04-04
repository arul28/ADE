import { app, BrowserWindow, nativeImage, protocol, shell } from "electron";
import path from "node:path";
type NodePtyType = typeof import("node-pty");
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
import { createJobEngine } from "./services/jobs/jobEngine";
import { createAiIntegrationService } from "./services/ai/aiIntegrationService";
import { augmentProcessPathWithShellAndKnownCliDirs } from "./services/ai/cliExecutableResolver";
import { createAgentChatService } from "./services/chat/agentChatService";
import { createGithubService } from "./services/github/githubService";
import { createPrService } from "./services/prs/prService";
import { createPrPollingService } from "./services/prs/prPollingService";
import { createQueueLandingService } from "./services/prs/queueLandingService";
import { createIssueInventoryService } from "./services/prs/issueInventoryService";
import { detectDefaultBaseRef, resolveRepoRoot, toProjectInfo, upsertProjectRow } from "./services/projects/projectService";
import { createAdeProjectService } from "./services/projects/adeProjectService";
import { createConfigReloadService } from "./services/projects/configReloadService";
import { IPC } from "../shared/ipc";
import { resolveAdeLayout } from "../shared/adeLayout";
import type { PortLease, ProjectInfo } from "../shared/types";
import type { AppContext } from "./services/ipc/registerIpc";
import fs from "node:fs";
import net from "node:net";
import { createMcpRequestHandler } from "../../../mcp-server/src/mcpServer";
import { createEventBuffer, type AdeMcpRuntime, type AdeMcpPaths } from "../../../mcp-server/src/bootstrap";
import { startJsonRpcServer } from "../../../mcp-server/src/jsonrpc";
import type { JsonRpcTransport } from "../../../mcp-server/src/transport";
import { createKeybindingsService } from "./services/keybindings/keybindingsService";
import { createAgentToolsService } from "./services/agentTools/agentToolsService";
import { createDevToolsService } from "./services/devTools/devToolsService";
import { createOnboardingService } from "./services/onboarding/onboardingService";
import { createAutomationService } from "./services/automations/automationService";
import { createAutomationPlannerService } from "./services/automations/automationPlannerService";
import { createAutomationSecretService } from "./services/automations/automationSecretService";
import { createAutomationIngressService } from "./services/automations/automationIngressService";
import { createUsageTrackingService } from "./services/usage/usageTrackingService";
import { createBudgetCapService } from "./services/usage/budgetCapService";
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
import { createProjectMemoryFilesService } from "./services/memory/memoryFilesService";
import { createMemoryLifecycleService } from "./services/memory/memoryLifecycleService";
import { createMemoryBriefingService } from "./services/memory/memoryBriefingService";
import { createMissionMemoryLifecycleService } from "./services/memory/missionMemoryLifecycleService";
import { createEpisodicSummaryService } from "./services/memory/episodicSummaryService";
import { createHumanWorkDigestService } from "./services/memory/humanWorkDigestService";
import { createProceduralLearningService } from "./services/memory/proceduralLearningService";
import { createMemoryRepairService } from "./services/memory/memoryRepairService";
import { createSkillRegistryService } from "./services/memory/skillRegistryService";
import { createKnowledgeCaptureService } from "./services/memory/knowledgeCaptureService";
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
import { createLinearWorkflowFileService } from "./services/cto/linearWorkflowFileService";
import { createLinearRoutingService } from "./services/cto/linearRoutingService";
import { createLinearIntakeService } from "./services/cto/linearIntakeService";
import { createLinearOutboundService } from "./services/cto/linearOutboundService";
import { createLinearCloseoutService } from "./services/cto/linearCloseoutService";
import { createLinearDispatcherService } from "./services/cto/linearDispatcherService";
import { createLinearIngressService } from "./services/cto/linearIngressService";
import { createLinearSyncService } from "./services/cto/linearSyncService";
import { createOpenclawBridgeService } from "./services/cto/openclawBridgeService";
import { createOrchestratorService } from "./services/orchestrator/orchestratorService";
import { createAiOrchestratorService } from "./services/orchestrator/aiOrchestratorService";
import { createMissionBudgetService } from "./services/orchestrator/missionBudgetService";
import { transitionMissionStatus } from "./services/orchestrator/missionLifecycle";
import { createExternalMcpService } from "./services/externalMcp/externalMcpService";
import { createExternalConnectionAuthService } from "./services/externalMcp/externalConnectionAuthService";
import { createComputerUseArtifactBrokerService } from "./services/computerUse/computerUseArtifactBrokerService";
import { createSyncService } from "./services/sync/syncService";
import { createAutoUpdateService } from "./services/updates/autoUpdateService";
import type { Logger } from "./services/logging/logger";

/**
 * Electron apps launched from macOS Dock/Finder inherit a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) that misses user-installed CLI tools like
 * `claude`. Resolve the user's login shell PATH so child processes spawned by
 * the AI SDK can locate the CLI.
 */
function fixElectronShellPath(): void {
  const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
    env: process.env,
    includeInteractiveShell: true,
    timeoutMs: 1_500,
  });
  if (nextPath) {
    process.env.PATH = nextPath;
  }
}

// Must run before any service or child process is created.
fixElectronShellPath();

const disableHardwareAcceleration =
  process.env.ADE_DISABLE_HARDWARE_ACCEL === "1";
if (disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

const devStabilityMode =
  process.env.ADE_STABILITY_MODE === "1"
  || !!process.env.VITE_DEV_SERVER_URL;
const enableAllBackgroundTasks =
  process.env.ADE_ENABLE_ALL_BACKGROUND_TASKS === "1";
// In dev stability mode, only enable essential background tasks by default.
// Use ADE_ENABLE_ALL_BACKGROUND_TASKS=1 or individual flags to enable others.
const defaultEnabledBackgroundTaskFlags = new Set<string>([
  "ADE_ENABLE_CONFIG_RELOAD",
  "ADE_ENABLE_USAGE_TRACKING",
  "ADE_ENABLE_MISSION_QUEUE",
  "ADE_ENABLE_TEAM_RUNTIME_RECOVERY",
  "ADE_ENABLE_HEAD_WATCHER",
  "ADE_ENABLE_PORT_ALLOCATION_RECOVERY",
]);

function isBackgroundTaskEnabled(enableFlag?: string): boolean {
  if (!devStabilityMode || enableAllBackgroundTasks) {
    return true;
  }
  if (!enableFlag) {
    return false;
  }
  return process.env[enableFlag] === "1" || defaultEnabledBackgroundTaskFlags.has(enableFlag);
}

const episodicSummaryEnabled = isBackgroundTaskEnabled("ADE_ENABLE_EPISODIC_SUMMARY");

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
  const cspImageSources = `${cspSources} https://avatars.githubusercontent.com https://*.githubusercontent.com https://github.githubassets.com https://opengraph.githubassets.com https://github.com https://vercel.com https://*.vercel.com https://img.shields.io`;
  const cspPolicy = [
    `default-src ${cspSources}`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `script-src ${cspSources} 'unsafe-inline'`,
    `style-src ${cspSources} 'unsafe-inline'`,
    `img-src ${cspImageSources} ade-artifact: data: blob:`,
    `media-src ade-artifact:`,
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
      `<html><body style="margin:0;background:#0f0d14;color:#f8f8f2;font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">` +
      `<h2 style="margin:0 0 12px;">ADE failed to load renderer</h2>` +
      `<p style="margin:0 0 8px;">URL: ${rendererUrl.replace(/</g, "&lt;")}</p>` +
      `<p style="margin:0;">Error: ${toErrorMessage(error).replace(/</g, "&lt;")}</p>` +
      `</body></html>`
    );
    await win.loadURL(`data:text/html;charset=UTF-8,${fallbackHtml}`);
  }

  if (process.env.VITE_DEV_SERVER_URL && !process.env.NO_DEVTOOLS) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

// Register custom protocol for serving local artifact files (images, videos) to the renderer.
// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  { scheme: "ade-artifact", privileges: { standard: false, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(async () => {
  /** Canonical artifacts dir for the active project; ade-artifact:// only serves under this path. */
  let adeArtifactAllowedDir: string | null = null;

  const isPathInsideArtifactAllowRoot = (resolvedFile: string, allowedDir: string): boolean => {
    let allowed: string;
    try {
      allowed = fs.realpathSync(allowedDir);
    } catch {
      return false;
    }
    const normFile = path.normalize(resolvedFile);
    const normAllowed = path.normalize(allowed);
    if (process.platform === "win32") {
      return normFile.toLowerCase().startsWith(normAllowed.toLowerCase() + path.sep)
        || normFile.toLowerCase() === normAllowed.toLowerCase();
    }
    return normFile === normAllowed || normFile.startsWith(normAllowed + path.sep);
  };

  // Handle ade-artifact:// requests — serves local files for proof drawer previews.
  // Path is encoded in the URL: ade-artifact:///absolute/path/to/file.png
  protocol.handle("ade-artifact", (request) => {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);
    // On Windows, pathname starts with /C:/... — strip leading slash
    if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    filePath = path.resolve(filePath);
    let resolvedFile: string;
    try {
      resolvedFile = fs.realpathSync(filePath);
    } catch {
      console.warn("[ade-artifact] realpath failed", { filePath });
      return new Response("Not found", { status: 404 });
    }
    const allowedDir = adeArtifactAllowedDir;
    if (!allowedDir || !isPathInsideArtifactAllowRoot(resolvedFile, allowedDir)) {
      console.warn("[ade-artifact] rejected path outside artifacts dir", { resolvedFile, allowedDir });
      return new Response("Not found", { status: 404 });
    }
    try {
      const stat = fs.statSync(resolvedFile);
      if (!stat.isFile()) return new Response("Not found", { status: 404 });
      const fileSize = stat.size;
      const ext = path.extname(resolvedFile).replace(/^\./, "").toLowerCase();
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
        gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml",
        mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska",
      };
      const mime = mimeMap[ext] ?? "application/octet-stream";

      // Support Range requests — required for <video> playback and seeking
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        let start = match ? parseInt(match[1], 10) : 0;
        let end = match && match[2] !== undefined && match[2] !== "" ? parseInt(match[2], 10) : fileSize - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end)) end = fileSize - 1;
        if (end > fileSize - 1) end = fileSize - 1;
        if (start >= fileSize || start > end) {
          return new Response(null, {
            status: 416,
            headers: {
              "Content-Range": `bytes */${fileSize}`,
            },
          });
        }
        const chunkSize = end - start + 1;
        const fileStream = fs.createReadStream(resolvedFile, { start, end });
        const webStream = new ReadableStream({
          start(controller) {
            fileStream.on("data", (chunk) => controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
            fileStream.on("end", () => controller.close());
            fileStream.on("error", (err) => controller.error(err));
          },
          cancel() { fileStream.destroy(); },
        });
        return new Response(webStream, {
          status: 206,
          headers: {
            "Content-Type": mime,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": String(chunkSize),
            "Accept-Ranges": "bytes",
          },
        });
      }

      // Full file response (images, small files)
      const fileStream = fs.createReadStream(resolvedFile);
      const webStream = new ReadableStream({
        start(controller) {
          fileStream.on("data", (chunk) => controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
          fileStream.on("end", () => controller.close());
          fileStream.on("error", (err) => controller.error(err));
        },
        cancel() { fileStream.destroy(); },
      });
      return new Response(webStream, {
        headers: {
          "Content-Type": mime,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  console.log("[info] app.hardware_acceleration", {
    enabled: !disableHardwareAcceleration,
    reason: disableHardwareAcceleration
      ? (process.env.ADE_DISABLE_HARDWARE_ACCEL === "1" ? "env_override" : "dev_mode")
      : "default",
  });
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
    return require("node-pty") as NodePtyType;
  };

  const normalizeProjectRoot = (projectRoot: string) => path.resolve(projectRoot);
  const projectContexts = new Map<string, AppContext>();
  const closeContextPromises = new Map<string, Promise<void>>();
  const mcpSocketCleanupByRoot = new Map<string, () => void>();
  let activeProjectRoot: string | null = null;
  let dormantContext!: AppContext;

  const setActiveProject = (projectRoot: string | null): void => {
    activeProjectRoot = projectRoot ? normalizeProjectRoot(projectRoot) : null;
    if (activeProjectRoot) {
      try {
        adeArtifactAllowedDir = resolveAdeLayout(activeProjectRoot).artifactsDir;
      } catch {
        adeArtifactAllowedDir = null;
      }
    } else {
      adeArtifactAllowedDir = null;
    }
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
    // The .ade directory may exist from git (shared scaffold files like ade.yaml),
    // but the db is gitignored and machine-local. A missing db means this machine
    // has never completed setup, so onboarding should run.
    const hadAdeDir = fs.existsSync(path.join(projectRoot, ".ade", "ade.db"));
    const adePaths = ensureAdeDirs(projectRoot);
    const { initApiKeyStore } = await import("./services/ai/apiKeyStore");
    initApiKeyStore(projectRoot);
    const logger = createFileLogger(path.join(adePaths.logsDir, "main.jsonl"));

    logger.info("project.init", { projectRoot, baseRef, ensureExclude });

    const db = await openKvDb(adePaths.dbPath, logger);
    const keybindingsService = createKeybindingsService({ db });
    const agentToolsService = createAgentToolsService({ logger });
    const devToolsService = createDevToolsService({ logger });

    const project = toProjectInfo(projectRoot, baseRef);
    const { projectId } = upsertProjectRow({ db, repoRoot: projectRoot, displayName: project.displayName, baseRef });

    const operationService = createOperationService({ db, projectId });

    let jobEngine: ReturnType<typeof createJobEngine> | null = null;
    let automationService: ReturnType<typeof createAutomationService> | null = null;
    let rebaseSuggestionService: ReturnType<typeof createRebaseSuggestionService> | null = null;
    let autoRebaseService: ReturnType<typeof createAutoRebaseService> | null = null;
    let humanWorkDigestService: ReturnType<typeof createHumanWorkDigestService> | null = null;
    let conflictServiceRef: ReturnType<typeof createConflictService> | null = null;
    let prServiceRef: ReturnType<typeof createPrService> | null = null;
    let prPollingServiceRef: ReturnType<typeof createPrPollingService> | null = null;
    let testServiceRef: ReturnType<typeof createTestService> | null = null;
    let gitServiceRef: ReturnType<typeof createGitOperationsService> | null = null;
    let missionBudgetServiceRef: ReturnType<typeof createMissionBudgetService> | null = null;

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
          ?.onHeadChanged({ preHeadSha: prev, postHeadSha })
          .catch(() => {});
      }
      void rebaseSuggestionService
        ?.onParentHeadChanged({ laneId, reason: args.reason, preHeadSha: prev, postHeadSha })
        .catch(() => {});
      void autoRebaseService
        ?.onHeadChanged({ laneId, reason: args.reason, preHeadSha: prev, postHeadSha })
        .catch(() => {});

      const pr = prServiceRef?.getForLane(laneId);
      if (pr) {
        prServiceRef?.markHotRefresh([pr.id]);
      }
    };

    const laneService = createLaneService({
      db,
      projectRoot,
      projectId,
      defaultBaseRef: baseRef,
      worktreesDir: adePaths.worktreesDir,
      operationService,
      onHeadChanged: handleHeadChanged,
      onRebaseEvent: (event) => {
        emitProjectEvent(projectRoot, IPC.lanesRebaseEvent, event);
        if (event.type === "rebase-run-updated" && event.run.state !== "running") {
          void conflictServiceRef?.scanRebaseNeeds().catch((error) => {
            logger.warn("rebase.needs_refresh_failed", {
              runId: event.run.runId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    });
    await laneService.ensurePrimaryLane();

    const laneEnvironmentService = createLaneEnvironmentService({
      projectRoot,
      adeDir: adePaths.adeDir,
      logger,
      broadcastEvent: (ev) => emitProjectEvent(projectRoot, IPC.lanesEnvEvent, ev)
    });

    const sessionService = createSessionService({ db });
    const reconciledSessions = sessionService.reconcileStaleRunningSessions({
      status: "disposed",
      excludeToolTypes: ["claude-chat", "codex-chat", "ai-chat", "cursor"],
    });
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
      loadLeases: () => db.getJson<PortLease[]>("port_leases") ?? [],
    });
    portAllocationService.restore();

    const recoverPortAllocations = async () => {
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
    };

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
      projectConfigService,
      projectRoot,
    });

    const onboardingService = createOnboardingService({
      db,
      logger,
      projectRoot,
      projectId,
      baseRef,
      freshProject: !hadAdeDir,
      laneService,
      projectConfigService
    });

    if (!hadAdeDir) {
      const hasEnvCredentials =
        Boolean((process.env.GITHUB_TOKEN ?? process.env.ADE_GITHUB_TOKEN ?? "").trim()) ||
        Boolean((process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()) ||
        Boolean((process.env.LINEAR_API_KEY ?? process.env.ADE_LINEAR_TOKEN ?? "").trim());
      if (hasEnvCredentials) {
        onboardingService.complete();
        logger.info("onboarding.auto_completed", { reason: "env_credentials_detected" });
      }
    }

    rebaseSuggestionService = createRebaseSuggestionService({
      db,
      logger,
      projectId,
      projectRoot,
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
      projectRoot,
      appDataDir: app.getPath("userData"),
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
    conflictServiceRef = conflictService;

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
      autoRebaseService,
      rebaseSuggestionService,
      onHotRefreshChanged: () => {
        prPollingServiceRef?.poke();
      },
      openExternal: async (url) => {
        await shell.openExternal(url);
      }
    });
    prServiceRef = prService;

    let knowledgeCaptureServiceRef: ReturnType<typeof createKnowledgeCaptureService> | null = null;
    const prPollingService = createPrPollingService({
      logger,
      prService,
      projectConfigService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.prsEvent, event),
      onPullRequestsChanged: async ({ changedPrs, changes }) => {
        if (changedPrs.length > 0) {
          prService.markHotRefresh(changedPrs.map((pr) => pr.id));
        }
        await Promise.all([
          ...changedPrs.map((pr) =>
            knowledgeCaptureServiceRef?.capturePrFeedback({
              prId: pr.id,
              prNumber: pr.githubPrNumber ?? null,
            }) ?? Promise.resolve()
          ),
          ...changes.map(({ pr, previousState, previousChecksStatus, previousReviewStatus }) => {
            automationService?.onPullRequestChanged?.({
              pr,
              previousState,
              previousChecksStatus,
              previousReviewStatus,
            });
            return Promise.resolve();
          }),
        ]);
      },
    });
    prPollingServiceRef = prPollingService;

    let orchestratorServiceRef: ReturnType<typeof createOrchestratorService> | null = null;
    let aiOrchestratorServiceRef: ReturnType<typeof createAiOrchestratorService> | null = null;
    let linearDispatcherServiceRef: ReturnType<typeof createLinearDispatcherService> | null = null;
    let openclawBridgeServiceRef: ReturnType<typeof createOpenclawBridgeService> | null = null;
    let linearSyncServiceRef: ReturnType<typeof createLinearSyncService> | null = null;
    let agentChatServiceRef: ReturnType<typeof createAgentChatService> | null = null;
    let externalMcpServiceRef: ReturnType<typeof createExternalMcpService> | null = null;
    const queueLandingService = createQueueLandingService({
      db,
      logger,
      projectId,
      prService,
      laneService,
      conflictService,
      emitEvent: (event) => emitProjectEvent(projectRoot, IPC.prsEvent, event),
      onStateChanged: (state) => {
        const hotPrIds = new Set<string>();
        const currentEntry = state.entries[state.currentPosition];
        const nextEntry = state.entries[state.currentPosition + 1];
        if (state.activePrId) hotPrIds.add(state.activePrId);
        if (currentEntry?.prId) hotPrIds.add(currentEntry.prId);
        if (nextEntry?.prId) hotPrIds.add(nextEntry.prId);
        if (hotPrIds.size > 0) {
          prServiceRef?.markHotRefresh(Array.from(hotPrIds));
        }
      }
    });
    queueLandingService.init();

    const issueInventoryService = createIssueInventoryService({ db });

    const fileService = createFileService({
      laneService,
      onLaneWorktreeMutation: ({ laneId, reason }) => {
        jobEngine.onLaneDirtyChanged({ laneId, reason });
      }
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

    const onTrackedSessionEnded = ({ laneId, sessionId, exitCode }: { laneId: string; sessionId: string; exitCode: number | null }) => {
      jobEngine?.onSessionEnded({ laneId, sessionId });
      automationService?.onSessionEnded({ laneId, sessionId });
      try {
        issueInventoryService.reconcileConvergenceSessionExit(sessionId, { exitCode });
      } catch (error) {
        logger.warn("main.convergence_session_reconcile_failed", {
          laneId,
          sessionId,
          exitCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      void linearSyncServiceRef?.processActiveRunsNow().catch(() => {});
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

    let syncServiceRef: ReturnType<typeof createSyncService> | null = null;
    const ptyService = createPtyService({
      projectRoot,
      transcriptsDir: adePaths.transcriptsDir,
      chatSessionsDir: adePaths.chatSessionsDir,
      laneService,
      sessionService,
      aiIntegrationService,
      projectConfigService,
      logger,
      broadcastData: (ev) => {
        emitProjectEvent(projectRoot, IPC.ptyData, ev);
        syncServiceRef?.handlePtyData(ev);
      },
      broadcastExit: (ev) => {
        emitProjectEvent(projectRoot, IPC.ptyExit, ev);
        syncServiceRef?.handlePtyExit(ev);
      },
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
    // Auto-detect previously downloaded embedding model at startup
    void embeddingService.probeCache().catch(() => { /* best-effort */ });
    const hybridSearchService = createHybridSearchService({
      db,
      embeddingService,
      logger,
    });
    let ctoStateServiceRef: ReturnType<typeof createCtoStateService> | null = null;
    let memoryFilesServiceRef: ReturnType<typeof createProjectMemoryFilesService> | null = null;
    let syncMemoryDocsTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedSyncMemoryDocs = () => {
      if (syncMemoryDocsTimer) clearTimeout(syncMemoryDocsTimer);
      syncMemoryDocsTimer = setTimeout(() => {
        try {
          ctoStateServiceRef?.syncDerivedMemoryDocs();
        } catch {
          // Ignore best-effort generated doc sync errors.
        }
        try {
          memoryFilesServiceRef?.sync();
        } catch {
          // Ignore best-effort generated memory file sync errors.
        }
      }, 2_000);
    };
    const memoryService = createUnifiedMemoryService(db, {
      hybridSearchService,
      onMemoryMutated: () => {
        batchConsolidationServiceRef?.scheduleAutoConsolidationCheck();
        debouncedSyncMemoryDocs();
      },
      onMemoryUpserted: (event) => {
        if ((event.created || event.contentChanged) && embeddingService.isAvailable()) {
          embeddingWorkerServiceRef?.queueMemory(event.memory.id);
        }
      },
    });
    const memoryFilesService = createProjectMemoryFilesService({
      projectRoot,
      projectId,
      memoryService,
    });
    memoryFilesServiceRef = memoryFilesService;
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
    const memoryRepairService = createMemoryRepairService({
      db,
      projectId,
      logger,
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
      memoryFilesService,
      projectRoot,
      humanWorkDigestService: {
        getRecentCommitSummaries: async (count?: number) => {
          return humanWorkDigestService?.getRecentCommitSummaries(count) ?? [];
        },
      },
    });
    const missionMemoryLifecycleService = createMissionMemoryLifecycleService({
      logger,
      memoryService,
    });
    let skillRegistryServiceRef: ReturnType<typeof createSkillRegistryService> | null = null;
    const proceduralLearningService = createProceduralLearningService({
      db,
      logger,
      projectId,
      memoryService,
      onProcedurePromoted: (memoryId) => {
        void skillRegistryServiceRef?.exportProcedureSkill({ id: memoryId }).catch(() => {});
      },
    });
    const episodicSummaryService = createEpisodicSummaryService({
      projectId,
      projectRoot,
      logger,
      enabled: episodicSummaryEnabled,
      aiIntegrationService,
      memoryService,
      onEpisodeSaved: (memoryId) => proceduralLearningService.onEpisodeSaved(memoryId),
    });
    const knowledgeCaptureService = createKnowledgeCaptureService({
      db,
      projectId,
      logger,
      memoryService,
      proceduralLearningService,
      prService,
    });
    knowledgeCaptureServiceRef = knowledgeCaptureService;
    humanWorkDigestService = createHumanWorkDigestService({
      projectId,
      projectRoot,
      logger,
    });
    const skillRegistryService = createSkillRegistryService({
      db,
      projectId,
      projectRoot,
      logger,
      memoryService,
      proceduralLearningService,
    });
    skillRegistryServiceRef = skillRegistryService;
    const contextDocService = createContextDocService({
      db,
      logger,
      projectRoot,
      projectId,
      packsDir: adePaths.packsDir,
      laneService,
      projectConfigService,
      aiIntegrationService,
      onStatusChanged: (status) => emitProjectEvent(projectRoot, IPC.contextStatusChanged, status),
    });

    const ctoStateService = createCtoStateService({
      db,
      projectId,
      adeDir: adePaths.adeDir,
      memoryService,
    });
    ctoStateServiceRef = ctoStateService;
    try {
      memoryFilesService.sync();
    } catch (err) {
      logger.warn("memory_files.sync_failed", {
        projectRoot,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const workerAgentService = createWorkerAgentService({
      db,
      projectId,
      adeDir: adePaths.adeDir,
    });
    const adeProjectService = createAdeProjectService({
      projectRoot,
      db,
      projectId,
      logger,
      projectConfigService,
      ctoStateService,
      workerAgentService,
    });
    setImmediate(() => {
      try {
        const integrityCleanup = adeProjectService.runIntegrityCheck();
        if (integrityCleanup.changed) {
          logger.info("ade.project.integrity_repaired", {
            projectRoot,
            actions: integrityCleanup.actions.length,
          });
        }
      } catch (error) {
        logger.warn("ade.project.integrity_check_failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        memoryRepairService.runRepair();
      } catch (error) {
        logger.warn("memory.repair.failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

    const workerAdapterRuntimeService = createWorkerAdapterRuntimeService({
      getAgentChatService: () => agentChatServiceRef,
    });

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
    const automationSecretService = createAutomationSecretService({
      adeDir: adePaths.adeDir,
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
    const linearWorkflowFileService = createLinearWorkflowFileService({
      projectRoot,
    });
    const flowPolicyService = createFlowPolicyService({
      db,
      projectId,
      projectConfigService,
      workflowFileService: linearWorkflowFileService,
    });
    const linearRoutingService = createLinearRoutingService({
      flowPolicyService,
      workerAgentService,
    });
    const linearIntakeService = createLinearIntakeService({
      db,
      projectId,
      issueTracker: linearIssueTracker,
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
      transcriptsDir: adePaths.transcriptsDir,
      projectId,
      memoryService,
      fileService,
      workerAgentService,
      workerHeartbeatService,
      linearIssueTracker,
      flowPolicyService,
      getMissionService: () => missionServiceRef,
      getAiOrchestratorService: () => aiOrchestratorServiceRef,
      getLinearDispatcherService: () => linearDispatcherServiceRef,
      linearClient,
      linearCredentials: linearCredentialService,
      prService,
      issueInventoryService,
      processService,
      getTestService: () => testServiceRef,
      ptyService,
      getAutomationService: () => automationService,
      getGitService: () => gitServiceRef,
      conflictService,
      contextDocService,
      getWorkerBudgetService: () => workerBudgetService,
      getMissionBudgetService: () => missionBudgetServiceRef,
      episodicSummaryService,
      laneService,
      sessionService,
      projectConfigService,
      ctoStateService,
      logger,
      appVersion: app.getVersion(),
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onAgentChatEvent(event);
        openclawBridgeServiceRef?.onAgentChatEvent(event);
        emitProjectEvent(projectRoot, IPC.agentChatEvent, event);

        // Compaction flush: when context compaction occurs, trigger a flush steer
        // so the agent can save durable discoveries to memory before they are lost.
        if (event.event.type === "context_compact") {
          const sid = event.sessionId;
          const compactEvt = event.event as { preTokens?: number };
          void compactionFlushService.beforeCompaction({
            sessionId: sid,
            boundaryId: `chat:${sid}:${Date.now()}`,
            conversationTokenCount: compactEvt.preTokens ?? 200_000,
            maxTokens: 200_000,
            flushTurn: async ({ prompt }) => {
              try {
                await agentChatService.steer({ sessionId: sid, text: prompt });
                return { status: "flushed" };
              } catch {
                return { status: "budget_exceeded" };
              }
            },
          }).catch(() => {});
        }

        // Capture agent session errors as failure gotchas for the memory system
        if (event.event.type === "error" && event.provenance?.runId) {
          const prov = event.provenance;
          void knowledgeCaptureServiceRef?.captureFailureGotcha({
            missionId: prov.runId!,
            runId: prov.runId!,
            stepId: null,
            attemptId: prov.attemptId ?? null,
            stepKey: prov.stepKey ?? null,
            summary: `Agent session error in ${prov.role ?? "agent"} session`,
            errorMessage: event.event.message,
          }).catch(() => {});
        }
      },
      onSessionEnded: onTrackedSessionEnded,
      getExternalMcpConfigs: () => externalMcpServiceRef?.getRawConfigs() ?? [],
      getDirtyFileTextForPath: async (absPath: string) => {
        const trimmed = absPath.trim();
        if (!trimmed) return undefined;
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win?.webContents || win.webContents.isDestroyed()) return undefined;
        try {
          const js = `typeof window.__ADE_GET_DIRTY_FILE_TEXT__ === "function" ? window.__ADE_GET_DIRTY_FILE_TEXT__(${JSON.stringify(trimmed)}) : undefined`;
          const result: unknown = await win.webContents.executeJavaScript(js, true);
          return typeof result === "string" ? result : undefined;
        } catch {
          return undefined;
        }
      },
    });
    agentChatServiceRef = agentChatService;

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

    const testService = createTestService({
      db,
      projectId,
      testLogsDir: adePaths.testLogsDir,
      logger,
      laneService,
      projectConfigService,
      broadcastEvent: (ev) => {
        openclawBridgeServiceRef?.onTestEvent(ev);
        emitProjectEvent(projectRoot, IPC.testsEvent, ev);
      }
    });
    testServiceRef = testService;
    gitServiceRef = gitService;

    automationService = createAutomationService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      projectConfigService,
      conflictService,
      testService,
      agentChatService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.automationsEvent, event)
    });
    const automationIngressService = createAutomationIngressService({
      logger,
      automationService,
      secretService: automationSecretService,
      listRules: () => projectConfigService.get().effective.automations ?? [],
    });

    let missionServiceRef: ReturnType<typeof createMissionService> | null = null;
    const missionService = createMissionService({
      db,
      projectId,
      projectRoot,
      onBlockingInterventionAdded: ({ missionId, intervention }) => {
        const currentMissionService = missionServiceRef;
        const currentOrchestratorService = orchestratorServiceRef;
        if (!currentMissionService || !currentOrchestratorService) return;
        transitionMissionStatus(
          {
            logger,
            missionService: currentMissionService,
            orchestratorService: currentOrchestratorService,
          } as any,
          missionId,
          "intervention_required",
          {
            lastError: intervention.body?.trim() || intervention.title?.trim() || null,
          },
        );
      },
      onInterventionResolved: ({ missionId, intervention }) => {
        void knowledgeCaptureService.captureResolvedIntervention({
          missionId,
          intervention,
        }).catch(() => {});
      },
      onEvent: (event) => {
        openclawBridgeServiceRef?.onMissionEvent(event);
        emitProjectEvent(projectRoot, IPC.missionsEvent, event);
        if (event.missionId) {
          automationService?.onMissionUpdated({ missionId: event.missionId });
        }
        if (event.reason === "ready_to_start" && event.missionId) {
          void aiOrchestratorServiceRef?.startMissionRun({
            missionId: event.missionId,
            queueClaimToken: event.claimToken ?? null,
          }).catch((error) => {
            logger.warn("missions.queue_autostart_failed", {
              missionId: event.missionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    });
    missionServiceRef = missionService;
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
    missionBudgetServiceRef = missionBudgetService;
    let missionPreflightService: ReturnType<typeof createMissionPreflightService>;
    const deferredProjectStartCancels = new Set<() => void>();
    const scheduleDeferredProjectStart = (
      task: () => Promise<unknown> | unknown,
      onError: (error: unknown) => void,
      delayMs = 0,
    ) => {
      if (delayMs > 0) {
        const cancelTimeout = () => clearTimeout(handle);
        const handle = setTimeout(() => {
          deferredProjectStartCancels.delete(cancelTimeout);
          Promise.resolve()
            .then(task)
            .catch(onError);
        }, delayMs);
        deferredProjectStartCancels.add(cancelTimeout);
        return;
      }
      const handle = setImmediate(() => {
        deferredProjectStartCancels.delete(cancelImmediate);
        Promise.resolve()
          .then(task)
          .catch(onError);
      });
      const cancelImmediate = () => clearImmediate(handle);
      deferredProjectStartCancels.add(cancelImmediate);
    };
    const scheduleBackgroundProjectTask = (
      label: string,
      task: () => Promise<unknown> | unknown,
      onError: (error: unknown) => void,
      delayMs = 0,
      enableFlag?: string,
    ) => {
      if (!isBackgroundTaskEnabled(enableFlag)) {
        logger.info("project.startup_task_skipped", {
          projectRoot,
          task: label,
          reason: "stability_mode",
          enableFlag: enableFlag ?? null,
        });
        return;
      }
      if (devStabilityMode) {
        logger.info("project.startup_task_enabled", {
          projectRoot,
          task: label,
          reason: enableAllBackgroundTasks ? "global_override" : "per_task_override",
          enableFlag: enableFlag ?? null,
          delayMs,
        });
      }
      scheduleDeferredProjectStart(
        async () => {
          const startedAt = Date.now();
          logger.info("project.startup_task_begin", {
            projectRoot,
            task: label,
            enableFlag: enableFlag ?? null,
            delayMs,
          });
          await task();
          logger.info("project.startup_task_done", {
            projectRoot,
            task: label,
            enableFlag: enableFlag ?? null,
            delayMs,
            durationMs: Date.now() - startedAt,
          });
        },
        onError,
        delayMs,
      );
    };
    const externalConnectionAuthService = createExternalConnectionAuthService({
      adeDir: adePaths.adeDir,
      logger,
    });
    const externalMcpService = createExternalMcpService({
      projectRoot,
      adeDir: adePaths.adeDir,
      db,
      projectId,
      logger,
      workerAgentService,
      ctoStateService,
      missionService,
      workerBudgetService,
      missionBudgetService,
      authService: externalConnectionAuthService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.externalMcpEvent, event),
    });
    externalMcpServiceRef = externalMcpService;
    scheduleBackgroundProjectTask(
      "lanes.port_allocation_recovery",
      () => recoverPortAllocations(),
      (error) => {
        logger.warn("port_allocation.startup_recovery_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      8_000,
      "ADE_ENABLE_PORT_ALLOCATION_RECOVERY",
    );

    scheduleBackgroundProjectTask(
      "external_mcp.start",
      () => externalMcpService.start(),
      (error) => {
        logger.warn("external_mcp.start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_EXTERNAL_MCP",
    );

    const openclawBridgeService = createOpenclawBridgeService({
      projectRoot,
      adeDir: adePaths.adeDir,
      laneService,
      agentChatService,
      ctoStateService,
      workerAgentService,
      missionService,
      logger,
      appVersion: app.getVersion(),
      onStatusChange: (status) => emitProjectEvent(projectRoot, IPC.openclawConnectionStatus, status),
    });
    openclawBridgeServiceRef = openclawBridgeService;
    scheduleBackgroundProjectTask(
      "openclaw_bridge.start",
      () => openclawBridgeService.start(),
      (error) => {
        logger.warn("openclaw_bridge.start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_OPENCLAW",
    );

    const orchestratorService = createOrchestratorService({
      db,
      projectId,
      projectRoot,
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
      proceduralLearningService,
      knowledgeCaptureService,
      externalMcpService,
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onOrchestratorRuntimeEvent(event);
        openclawBridgeServiceRef?.onOrchestratorEvent(event);
        emitProjectEvent(projectRoot, IPC.orchestratorEvent, event);
      }
    });
    orchestratorServiceRef = orchestratorService;
    const computerUseArtifactBrokerService = createComputerUseArtifactBrokerService({
      db,
      projectId,
      projectRoot,
      missionService,
      orchestratorService,
      externalMcpService,
      logger,
      onEvent: (payload) => emitProjectEvent(projectRoot, IPC.computerUseEvent, payload),
    });
    agentChatService.setComputerUseArtifactBrokerService(computerUseArtifactBrokerService);
    missionPreflightService = createMissionPreflightService({
      logger,
      projectRoot,
      missionService,
      laneService,
      aiIntegrationService,
      projectConfigService,
      missionBudgetService,
      humanWorkDigestService,
      computerUseArtifactBrokerService,
    });
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
      projectRoot,
      missionBudgetService,
      humanWorkDigestService,
      missionMemoryLifecycleService,
      computerUseArtifactBrokerService,
      onThreadEvent: (event) => emitProjectEvent(projectRoot, IPC.orchestratorThreadEvent, event),
      onDagMutation: (event) => emitProjectEvent(projectRoot, IPC.orchestratorDagMutation, event)
    });
    aiOrchestratorServiceRef = aiOrchestratorService;
    const syncService = createSyncService({
      db,
      logger,
      projectRoot,
      fileService,
      laneService,
      gitService,
      diffService,
      conflictService,
      prService,
      sessionService,
      ptyService,
      projectConfigService,
      portAllocationService,
      laneEnvironmentService,
      laneTemplateService,
      rebaseSuggestionService,
      autoRebaseService,
      computerUseArtifactBrokerService,
      missionService,
      agentChatService,
      processService,
      onStatusChanged: (snapshot) => emitProjectEvent(projectRoot, IPC.syncEvent, { type: "sync-status", snapshot }),
    });
    syncServiceRef = syncService;
    await syncService.initialize();
    scheduleBackgroundProjectTask(
      "missions.process_queue",
      () => {
        missionService.processQueue();
      },
      (error) => {
        logger.warn("missions.queue_autostart_bootstrap_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      20_000,
      "ADE_ENABLE_MISSION_QUEUE",
    );

    logger.info("project.init_stage", { projectRoot, stage: "linear_closeout_init" });
    const linearCloseoutService = createLinearCloseoutService({
      issueTracker: linearIssueTracker,
      outboundService: linearOutboundService,
      missionService,
      orchestratorService,
      prService,
      computerUseArtifactBrokerService,
    });
    logger.info("project.init_stage", { projectRoot, stage: "linear_dispatcher_init" });
    const linearDispatcherService = createLinearDispatcherService({
      db,
      projectId,
      issueTracker: linearIssueTracker,
      workerAgentService,
      workerHeartbeatService,
      missionService,
      aiOrchestratorService,
      agentChatService,
      laneService,
      templateService: linearTemplateService,
      closeoutService: linearCloseoutService,
      outboundService: linearOutboundService,
      workerTaskSessionService,
      prService,
      onEvent: (event) => {
        emitProjectEvent(projectRoot, IPC.ctoLinearWorkflowEvent, event);

        // Capture linear workflow failures as gotchas for the memory system
        if (event.type === "linear-workflow-run" && event.milestone === "failed") {
          void knowledgeCaptureServiceRef?.captureFailureGotcha({
            missionId: event.runId,
            runId: event.runId,
            summary: `Linear workflow failed for ${event.issueIdentifier}: ${event.message}`,
            errorMessage: event.message,
          }).catch(() => {});
        }
      },
    });
    linearDispatcherServiceRef = linearDispatcherService;

    logger.info("project.init_stage", { projectRoot, stage: "linear_sync_init" });
    const linearSyncService = createLinearSyncService({
      db,
      logger,
      projectId,
      flowPolicyService,
      routingService: linearRoutingService,
      intakeService: linearIntakeService,
      issueTracker: linearIssueTracker,
      dispatcherService: linearDispatcherService,
      hasCredentials: () => linearCredentialService.getStatus().tokenStored,
      autoStart: false,
      onIssueUpdated: ({ issue, previousIssue }) => {
        automationService?.onLinearIssueChanged?.({
          issue,
          previousAssigneeId: typeof previousIssue?.assigneeId === "string" ? previousIssue.assigneeId : null,
          previousAssigneeName: typeof previousIssue?.assigneeName === "string" ? previousIssue.assigneeName : null,
        });
      },
    });
    linearSyncServiceRef = linearSyncService;
    scheduleBackgroundProjectTask(
      "linear.sync_start",
      () => linearSyncService.start(),
      (error) => {
        logger.warn("linear.sync_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_LINEAR_SYNC",
    );

    logger.info("project.init_stage", { projectRoot, stage: "linear_ingress_init" });
    const linearIngressService = createLinearIngressService({
      db,
      logger,
      projectId,
      linearClient,
      secretService: automationSecretService,
      onEvent: async (event) => {
        emitProjectEvent(projectRoot, IPC.ctoLinearWorkflowEvent, {
          type: "linear-workflow-ingress",
          projectId,
          source: event.source,
          issueId: event.issueId,
          issueIdentifier: event.issueIdentifier,
          summary: event.summary,
          createdAt: event.createdAt,
        });
        if (event.issueId) {
          await linearSyncService.processIssueUpdate(event.issueId);
        }
      },
    });
    scheduleBackgroundProjectTask(
      "linear.ingress_start",
      () => {
        if (!linearIngressService.canAutoStart()) {
          logger.info("project.startup_task_skipped", {
            projectRoot,
            task: "linear.ingress_start",
            reason: "not_configured",
            enableFlag: "ADE_ENABLE_LINEAR_INGRESS",
          });
          return;
        }
        return linearIngressService.start();
      },
      (error) => {
        logger.warn("linear.ingress_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_LINEAR_INGRESS",
    );

    // Resume any active team runtimes that were running before app restart
    scheduleBackgroundProjectTask(
      "orchestrator.resume_team_runtimes",
      () => aiOrchestratorService.resumeActiveTeamRuntimes(),
      (error) => {
        logger.warn("orchestrator.resume_team_runtimes_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      60_000,
      "ADE_ENABLE_TEAM_RUNTIME_RECOVERY",
    );

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
    scheduleBackgroundProjectTask(
      "usage.start",
      () => usageTrackingService.start(),
      (error) => {
        logger.warn("usage.start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      20_000,
      "ADE_ENABLE_USAGE_TRACKING",
    );

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
      workerHeartbeatService,
    });
    scheduleBackgroundProjectTask(
      "automations.ingress_start",
      () => automationIngressService.start(),
      (error) => {
        logger.warn("automations.ingress_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_AUTOMATION_INGRESS",
    );

    const configReloadService = createConfigReloadService({
      paths: {
        sharedPath: adeProjectService.paths.sharedConfigPath,
        localPath: adeProjectService.paths.localConfigPath,
        secretPath: adeProjectService.paths.secretConfigPath,
      },
      projectConfigService,
      adeProjectService,
      automationService,
      secretService: automationSecretService,
      externalMcpService,
      logger,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.projectStateEvent, event),
    });
    scheduleBackgroundProjectTask(
      "project.config_reload.start",
      () => configReloadService.start(),
      (error) => {
        logger.warn("project.config_reload_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_CONFIG_RELOAD",
    );

    scheduleBackgroundProjectTask(
      "memory.lifecycle.startup_sweep",
      () => memoryLifecycleService.runStartupSweepIfDue(),
      (error) => {
        logger.warn("memory.lifecycle.startup_sweep_failed", {
          projectId,
          error: error instanceof Error ? error.message : String(error)
        });
      },
      0,
      "ADE_ENABLE_MEMORY_STARTUP_SWEEP",
    );
    scheduleBackgroundProjectTask(
      "memory.consolidation.startup_check",
      () => batchConsolidationService.runAutoConsolidationIfNeeded(),
      (error) => {
        logger.warn("memory.consolidation.startup_check_failed", {
          projectId,
          error: error instanceof Error ? error.message : String(error)
        });
      },
      0,
      "ADE_ENABLE_MEMORY_CONSOLIDATION",
    );
    scheduleBackgroundProjectTask(
      "memory.embedding_worker.start",
      async () => {
        const status = await embeddingWorkerService.start();
        if (status.queueDepth > 0) {
          logger.info("memory.embedding_worker.backlog_sweep", {
            projectId,
            queueDepth: status.queueDepth,
          });
        }
        embeddingService.startHealthCheck();
      },
      (error) => {
        logger.warn("memory.embedding_worker.start_failed", {
          projectId,
          error: error instanceof Error ? error.message : String(error)
        });
      },
      120_000,
      "ADE_ENABLE_EMBEDDING_WORKER",
    );
    scheduleBackgroundProjectTask(
      "memory.human_digest.sync",
      () => humanWorkDigestService.syncKnowledge(),
      (error) => {
        logger.warn("memory.human_digest.startup_sync_failed", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      45_000,
      "ADE_ENABLE_HUMAN_DIGEST",
    );
    scheduleBackgroundProjectTask(
      "memory.skill_registry.start",
      () => skillRegistryService.start(),
      (error) => {
        logger.warn("memory.skill_registry.start_failed", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      60_000,
      "ADE_ENABLE_SKILL_REGISTRY",
    );

    // Head watcher: detects commits/rebases made outside ADE's Git UI (e.g. in the terminal),
    // then routes them through the same onHeadChanged pipeline (packs, automations, rebase suggestions).
    let headWatcherTimer: NodeJS.Timeout | null = null;
    let headWatcherActive = false;
    let headWatcherRunning = false;
    let headWatcherDelayMs = 10_000;
    let missingBroadcasted = false;

    const HEAD_WATCHER_MIN_INTERVAL_MS = 15_000;
    const HEAD_WATCHER_MAX_INTERVAL_MS = 60_000;

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
            headWatcherDelayMs = Math.min(HEAD_WATCHER_MAX_INTERVAL_MS, headWatcherDelayMs + 5_000);
          }
          scheduleHeadPoll(headWatcherDelayMs);
        }
      }
    };

    const startHeadWatcher = () => {
      if (headWatcherActive) return;
      headWatcherActive = true;
      headWatcherDelayMs = HEAD_WATCHER_MIN_INTERVAL_MS;
      scheduleHeadPoll(headWatcherDelayMs);
    };

      const disposeHeadWatcher = () => {
      headWatcherActive = false;
      for (const cancel of deferredProjectStartCancels) {
        cancel();
      }
      deferredProjectStartCancels.clear();
      if (!headWatcherTimer) return;
      clearTimeout(headWatcherTimer);
      headWatcherTimer = null;
    };

    scheduleBackgroundProjectTask(
      "git.head_watcher.start",
      () => startHeadWatcher(),
      (error) => {
        logger.warn("git.head_watcher_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      15_000,
      "ADE_ENABLE_HEAD_WATCHER",
    );

    const state = upsertRecentProject(readGlobalState(globalStatePath), project, {
      recordLastProject,
      recordRecent
    });
    writeGlobalState(globalStatePath, state);

    // ── MCP Socket Server (embedded mode) ─────────────────────────
    const mcpEventBuffer = createEventBuffer();
    const mcpRuntime: AdeMcpRuntime = {
      projectRoot,
      workspaceRoot: projectRoot,
      projectId,
      project,
      paths: adePaths as unknown as AdeMcpPaths,
      logger,
      db,
      laneService,
      sessionService,
      operationService,
      projectConfigService,
      conflictService,
      gitService,
      diffService,
      missionService,
      ptyService,
      testService,
      agentChatService,
      prService,
      fileService,
      memoryService,
      ctoStateService,
      workerAgentService,
      flowPolicyService,
      linearDispatcherService,
      linearIssueTracker,
      linearSyncService,
      linearIngressService,
      linearRoutingService,
      processService,
      externalMcpService,
      computerUseArtifactBrokerService,
      orchestratorService,
      aiOrchestratorService,
      issueInventoryService,
      eventBuffer: mcpEventBuffer,
      dispose: () => {} // desktop manages service lifecycle
    };

    const mcpSocketPath = adePaths.socketPath;
    const activeMcpConnections = new Set<net.Socket>();

    const destroyActiveMcpConnections = (): void => {
      for (const conn of activeMcpConnections) {
        activeMcpConnections.delete(conn);
        try {
          conn.destroy();
        } catch {
          // ignore
        }
      }
    };
    mcpSocketCleanupByRoot.set(normalizeProjectRoot(projectRoot), destroyActiveMcpConnections);

    // Clean stale socket from prior crash
    try { fs.unlinkSync(mcpSocketPath); } catch {}

    const mcpSocketServer = net.createServer((conn) => {
      activeMcpConnections.add(conn);
      let stopped = false;
      const transport: JsonRpcTransport = {
        onData(callback) {
          conn.on("data", callback);
        },
        write(data) {
          conn.write(data);
        },
        close() {
          if (!conn.destroyed) conn.destroy();
        },
      };
      let stop: ReturnType<typeof startJsonRpcServer> | null = null;
      const mcpHandler = createMcpRequestHandler({
        runtime: mcpRuntime,
        serverVersion: app.getVersion(),
        onToolsListChanged: () => {
          stop?.notify("notifications/tools/list_changed", {});
        },
      });
      stop = startJsonRpcServer(mcpHandler, transport, { nonFatal: true });
      const removeConnection = (): void => {
        activeMcpConnections.delete(conn);
      };
      conn.once("close", removeConnection);
      conn.once("end", removeConnection);
      conn.once("error", removeConnection);
      conn.on("close", () => {
        if (!stopped) {
          stopped = true;
          stop?.();
        }
        mcpHandler.dispose();
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
      agentToolsService,
      devToolsService,
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
      computerUseArtifactBrokerService,
      queueLandingService,
      issueInventoryService,
      jobEngine,
      automationService,
      automationPlannerService,
      automationIngressService,
      usageTrackingService,
      budgetCapService,
      syncHostService: syncService.getHostService(),
      syncService,
      missionService,
      missionPreflightService,
      orchestratorService,
      missionBudgetService,
      aiOrchestratorService,
      agentChatService,
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
      openclawBridgeService,
      workerAgentService,
      adeProjectService,
      workerRevisionService,
      workerBudgetService,
      workerHeartbeatService,
      workerTaskSessionService,
      linearCredentialService,
      linearIssueTracker,
      flowPolicyService,
      linearRoutingService,
      linearIngressService,
      linearSyncService,
      externalConnectionAuthService,
      externalMcpService,
      configReloadService,
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
      agentToolsService: null,
      devToolsService: null,
      onboardingService: null,
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
      computerUseArtifactBrokerService: null,
      githubService: null,
      prService: null,
      prPollingService: null,
      queueLandingService: null,
      issueInventoryService: null,
      jobEngine: null,
      automationService: null,
      automationPlannerService: null,
      automationIngressService: null,
      usageTrackingService: null,
      budgetCapService: null,
      syncHostService: null,
      syncService: null,
      missionService: null,
      missionPreflightService: null,
      orchestratorService: null,
      missionBudgetService: null,
      aiOrchestratorService: null,
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
      openclawBridgeService: null,
      workerAgentService: null,
      adeProjectService: null,
      workerRevisionService: null,
      workerBudgetService: null,
      workerHeartbeatService: null,
      workerTaskSessionService: null,
      linearCredentialService: null,
      linearIssueTracker: null,
      flowPolicyService: null,
      linearRoutingService: null,
      linearIngressService: null,
      linearSyncService: null,
      externalConnectionAuthService: null,
      externalMcpService: null,
      configReloadService: null
    } as unknown as AppContext);
  };

  const disposeContextResources = async (ctx: AppContext): Promise<void> => {
    const normalizedRoot = typeof ctx.project?.rootPath === "string" && ctx.project.rootPath.trim().length > 0
      ? normalizeProjectRoot(ctx.project.rootPath)
      : null;
    // Tear down MCP socket BEFORE any service disposal so in-flight MCP requests
    // do not race with services that are being shut down.
    try {
      if (normalizedRoot) {
        mcpSocketCleanupByRoot.get(normalizedRoot)?.();
        mcpSocketCleanupByRoot.delete(normalizedRoot);
      }
      ctx.mcpSocketServer?.close();
    } catch {
      // ignore
    }
    try {
      if (ctx.mcpSocketPath) fs.unlinkSync(ctx.mcpSocketPath);
    } catch {
      // ignore
    }
    // Flush DB before disposing services so that any pending writes are persisted.
    // Services may write during disposal, so we flush again at the end as a safety net.
    try {
      ctx.db.flushNow();
    } catch {
      // ignore
    }
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
      ctx.autoRebaseService?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.automationIngressService?.dispose();
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
      ctx.linearIngressService?.dispose();
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
      await ctx.externalMcpService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      ctx.externalConnectionAuthService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      await ctx.openclawBridgeService?.stop?.();
    } catch {
      // ignore
    }
    try {
      await ctx.skillRegistryService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      await ctx.configReloadService?.dispose?.();
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
      await ctx.syncService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      await ctx.syncHostService?.dispose?.();
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
    const previousRoot = current.project?.rootPath ?? "";
    if (activeProjectRoot) {
      await closeProjectContext(activeProjectRoot);
    }
    setActiveProject(null);
    dormantContext = createDormantProjectContext(previousRoot);
  };

  dormantContext = createDormantProjectContext();

  const FILE_LIMIT_CODES = new Set(["EMFILE", "ENFILE"]);
  let emfileWarned = false;
  process.on("uncaughtException", (err) => {
    if (FILE_LIMIT_CODES.has((err as NodeJS.ErrnoException).code ?? "")) return;
    getActiveContext().logger.error("process.uncaught_exception", {
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
  });
  process.on("unhandledRejection", (reason) => {
    const msg = String(reason);
    if (msg.includes("EMFILE") || msg.includes("ENFILE")) {
      if (!emfileWarned) {
        emfileWarned = true;
        getActiveContext().logger.warn("process.emfile_detected", { reason: msg });
      }
      return;
    }
    getActiveContext().logger.error("process.unhandled_rejection", { reason: msg });
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

  // --- Auto-update service (global, not per-project) ---
  const updateLogger = createFileLogger(path.join(app.getPath("userData"), "ade-update.jsonl"));
  const autoUpdateService = createAutoUpdateService(updateLogger);
  autoUpdateService.onUpdateAvailable((info) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC.updateEvent, { type: "available", version: info.version });
    });
  });
  autoUpdateService.onUpdateDownloaded((info) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC.updateEvent, { type: "downloaded", version: info.version });
    });
  });

  registerIpc({
    getCtx: () => {
      const ctx = getActiveContext();
      if (!ctx.autoUpdateService) {
        ctx.autoUpdateService = autoUpdateService;
      }
      return ctx;
    },
    switchProjectFromDialog,
    closeCurrentProject,
    closeProjectByPath,
    globalStatePath
  });

  await createWindow(getActiveContext().logger);

  // Initial project context: load AFTER the window is visible so the main
  // thread isn't blocked (DB load + service init) before anything renders.
  if (startupUserSelected) {
    void (async () => {
      try {
        await switchProjectFromDialog(initialCandidate);
      } catch {
        setActiveProject(null);
        dormantContext = createDormantProjectContext();
      }
    })();
  }

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
    const current = getActiveContext();
    const previousRoot = current.project?.rootPath;
    current.logger.info("app.before_quit");
    setActiveProject(null);
    dormantContext = createDormantProjectContext(previousRoot);
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
