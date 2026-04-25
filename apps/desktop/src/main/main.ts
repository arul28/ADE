import { app, BrowserWindow, dialog, nativeImage, protocol, safeStorage, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NodePty from "node-pty";
type NodePtyType = typeof NodePty;
import { isAdeMcpNamedPipePath } from "../shared/adeMcpIpc";
import { registerIpc } from "./services/ipc/registerIpc";
import { createFileLogger } from "./services/logging/logger";
import { openKvDb } from "./services/state/kvDb";
import { ensureAdeDirs } from "./services/state/projectState";
import {
  readGlobalState,
  upsertRecentProject,
  writeGlobalState,
} from "./services/state/globalState";
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
import { augmentProcessPathWithShellAndKnownCliDirs, setPathEnvValue } from "./services/ai/cliExecutableResolver";
import { createAgentChatService } from "./services/chat/agentChatService";
import { createGithubService } from "./services/github/githubService";
import { createFeedbackReporterService } from "./services/feedback/feedbackReporterService";
import { createPrService } from "./services/prs/prService";
import { createPrPollingService } from "./services/prs/prPollingService";
import { createQueueLandingService } from "./services/prs/queueLandingService";
import { createIssueInventoryService } from "./services/prs/issueInventoryService";
import { createPrSummaryService } from "./services/prs/prSummaryService";
import {
  detectDefaultBaseRef,
  resolveRepoRoot,
  toProjectInfo,
  upsertProjectRow,
} from "./services/projects/projectService";
import { toRecentProjectSummary } from "./services/projects/recentProjectSummary";
import { createAdeProjectService } from "./services/projects/adeProjectService";
import { createConfigReloadService } from "./services/projects/configReloadService";
import { IPC } from "../shared/ipc";
import { resolveAdeLayout } from "../shared/adeLayout";
import type { PortLease, ProjectInfo, RecentProjectSummary, SyncMobileProjectSummary, SyncProjectSwitchRequestPayload, SyncProjectSwitchResultPayload } from "../shared/types";
import type { AutomationTriggerType } from "../shared/types/config";
import type { AutomationTriggerLinearIssueContext } from "../shared/types/automations";
import type { LinearIngressEventRecord } from "../shared/types/linearSync";
import type { AppContext } from "./services/ipc/registerIpc";
import fs from "node:fs";
import net from "node:net";
import { createAdeRpcRequestHandler } from "../../../ade-cli/src/adeRpcServer";
import {
  createEventBuffer,
  type AdeRuntime,
  type AdeRuntimePaths,
} from "../../../ade-cli/src/bootstrap";
import { startJsonRpcServer, type JsonRpcTransport } from "../../../ade-cli/src/jsonrpc";
import { createKeybindingsService } from "./services/keybindings/keybindingsService";
import { createAgentToolsService } from "./services/agentTools/agentToolsService";
import { createAdeCliService } from "./services/cli/adeCliService";
import { createDevToolsService } from "./services/devTools/devToolsService";
import { createOnboardingService } from "./services/onboarding/onboardingService";
import { createAutomationService } from "./services/automations/automationService";
import { createAutomationPlannerService } from "./services/automations/automationPlannerService";
import { createAutomationSecretService } from "./services/automations/automationSecretService";
import { createAutomationIngressService } from "./services/automations/automationIngressService";
import { createReviewService } from "./services/review/reviewService";
import { createGithubPollingService } from "./services/automations/githubPollingService";
import type { AutomationAdeActionRegistry } from "./services/automations/automationService";
import {
  ADE_ACTION_ALLOWLIST,
  type AdeActionDomain,
  getAdeActionDomainServices,
  isAllowedAdeAction,
} from "./services/adeActions/registry";
import { createUsageTrackingService } from "./services/usage/usageTrackingService";
import { createBudgetCapService } from "./services/usage/budgetCapService";
import { createRebaseSuggestionService } from "./services/lanes/rebaseSuggestionService";
import { createAutoRebaseService } from "./services/lanes/autoRebaseService";
import { createMissionService } from "./services/missions/missionService";
import { createMissionPreflightService } from "./services/missions/missionPreflightService";
import { createBatchConsolidationService } from "./services/memory/batchConsolidationService";
import { createEmbeddingService } from "./services/memory/embeddingService";
import { createEmbeddingWorkerService } from "./services/memory/embeddingWorkerService";
import { createHybridSearchService } from "./services/memory/hybridSearchService";
import { createMemoryService } from "./services/memory/memoryService";
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
import { createComputerUseArtifactBrokerService } from "./services/computerUse/computerUseArtifactBrokerService";
import { createSyncService } from "./services/sync/syncService";
import { ApnsService, ApnsKeyStore } from "./services/notifications/apnsService";
import {
  createNotificationEventBus,
  type DevicePushTarget,
  type NotificationEventBus,
} from "./services/notifications/notificationEventBus";
import type { SyncService } from "./services/sync/syncService";
import type { DeviceRegistryService } from "./services/sync/deviceRegistryService";
import { createAutoUpdateService } from "./services/updates/autoUpdateService";
import { cleanupStaleTempArtifacts } from "./services/runtime/tempCleanupService";
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
    // Use setPathEnvValue so Windows processes inheriting a `Path` key collapse
    // to a single canonical entry (direct `process.env.PATH = …` can leave a
    // stale `Path` behind that later readers pick up instead).
    setPathEnvValue(process.env, nextPath);
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
  process.env.ADE_STABILITY_MODE === "1" || !!process.env.VITE_DEV_SERVER_URL;
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
  "ADE_ENABLE_MEMORY_STARTUP_SWEEP",
  "ADE_ENABLE_MEMORY_CONSOLIDATION",
  "ADE_ENABLE_EMBEDDING_WORKER",
  "ADE_ENABLE_MEMORY_FILE_SYNC",
  "ADE_ENABLE_SYNC_INIT",
]);

function isBackgroundTaskEnabled(enableFlag?: string): boolean {
  if (!devStabilityMode || enableAllBackgroundTasks) {
    return true;
  }
  if (!enableFlag) {
    return false;
  }
  return (
    process.env[enableFlag] === "1" ||
    defaultEnabledBackgroundTaskFlags.has(enableFlag)
  );
}

const episodicSummaryEnabled = isBackgroundTaskEnabled(
  "ADE_ENABLE_EPISODIC_SUMMARY",
);

function readString(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(source: Record<string, unknown> | null | undefined, key: string): string[] | undefined {
  const value = source?.[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : null;
      if (name) return name;
    }
    return "";
  }).filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
}

function readNested(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mapLinearActionToTriggerType(
  action: string | null,
  data: Record<string, unknown> | null,
  prevData: Record<string, unknown> | null,
): { triggerType: AutomationTriggerType; stateTransition: string | null; previousState: string | undefined } {
  const currentState = readString(readNested(data, "state"), "name") ?? readString(data, "stateName");
  const previousState = readString(readNested(prevData, "state"), "name") ?? readString(prevData, "stateName");
  if (action === "create") {
    return { triggerType: "linear.issue_created", stateTransition: null, previousState: undefined };
  }
  const prevAssignee = readString(prevData, "assigneeId") ?? readString(readNested(prevData, "assignee"), "id");
  const curAssignee = readString(data, "assigneeId") ?? readString(readNested(data, "assignee"), "id");
  if (curAssignee && curAssignee !== prevAssignee) {
    return { triggerType: "linear.issue_assigned", stateTransition: null, previousState };
  }
  if (currentState && previousState && currentState !== previousState) {
    return {
      triggerType: "linear.issue_status_changed",
      stateTransition: `${previousState}->${currentState}`,
      previousState,
    };
  }
  return { triggerType: "linear.issue_updated", stateTransition: null, previousState };
}

function buildLinearAutomationDispatch(event: LinearIngressEventRecord): {
  source: "linear-relay";
  eventKey: string;
  triggerType: AutomationTriggerType;
  eventName?: string | null;
  summary?: string | null;
  author?: string | null;
  labels?: string[];
  rawPayload?: Record<string, unknown> | null;
  linear?: { issue: AutomationTriggerLinearIssueContext } | null;
  project?: string | null;
  team?: string | null;
  assignee?: string | null;
  stateTransition?: string | null;
  changedFields?: string[];
} | null {
  if (!event.issueId) return null;
  const payload = event.payload ?? null;
  const data = readNested(payload, "data");
  const prevData = readNested(payload, "updatedFrom");
  const mapping = mapLinearActionToTriggerType(event.action, data, prevData);

  const teamName = readString(readNested(data, "team"), "name") ?? readString(data, "teamName");
  const projectName = readString(readNested(data, "project"), "name") ?? readString(data, "projectName");
  const assigneeName = readString(readNested(data, "assignee"), "name") ?? readString(data, "assigneeName");
  const stateName = readString(readNested(data, "state"), "name") ?? readString(data, "stateName");
  const labels = readStringArray(data, "labels") ?? readStringArray(readNested(data, "labels"), "nodes");
  const title = readString(data, "title") ?? undefined;

  const changedFields = prevData ? Object.keys(prevData) : undefined;

  const linearContext: AutomationTriggerLinearIssueContext = {
    id: event.issueId,
    title,
    team: teamName,
    project: projectName,
    assignee: assigneeName,
    state: stateName,
    previousState: mapping.previousState,
    labels,
  };

  return {
    source: "linear-relay",
    eventKey: event.eventId,
    triggerType: mapping.triggerType,
    eventName: event.action,
    summary: event.summary,
    labels,
    rawPayload: payload,
    linear: { issue: linearContext },
    project: projectName ?? null,
    team: teamName ?? null,
    assignee: assigneeName ?? null,
    stateTransition: mapping.stateTransition,
    changedFields,
  };
}

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
  return pathToFileURL(path.join(__dirname, "../renderer/index.html")).toString();
}

async function createWindow(args: {
  logger?: Logger;
  onCloseRequested?: (win: BrowserWindow, event: Electron.Event) => void;
} = {}): Promise<BrowserWindow> {
  // Load the app icon from the build directory.
  const iconDir = path.join(__dirname, "../../build");
  const icoPath = path.join(iconDir, "icon.ico");
  const pngPath = path.join(iconDir, "icon.png");
  const icnsPath = path.join(iconDir, "icon.icns");
  let icon: Electron.NativeImage;
  if (process.platform === "win32" && fs.existsSync(icoPath)) {
    icon = nativeImage.createFromPath(icoPath);
  } else if (fs.existsSync(pngPath)) {
    icon = nativeImage.createFromPath(pngPath);
  } else if (fs.existsSync(icnsPath)) {
    icon = nativeImage.createFromPath(icnsPath);
  } else {
    icon = nativeImage.createEmpty();
  }

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
      nodeIntegration: false,
    },
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
  const cspImageSources = `${cspSources} https://avatars.githubusercontent.com https://*.githubusercontent.com https://github.githubassets.com https://opengraph.githubassets.com https://github.com https://vercel.com https://*.vercel.com https://img.shields.io https://*.s3.amazonaws.com`;
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

  win.on("close", (event) => {
    args.onCloseRequested?.(win, event);
  });

  win.on("unresponsive", () => {
    args.logger?.warn("window.unresponsive", {
      windowId: win.id,
      url: win.webContents.getURL(),
    });
  });

  win.on("responsive", () => {
    args.logger?.info("window.responsive", {
      windowId: win.id,
      url: win.webContents.getURL(),
    });
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    args.logger?.error("window.render_process_gone", {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
      url: win.webContents.getURL(),
    });
  });

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    args.logger?.error("window.preload_error", {
      windowId: win.id,
      preloadPath,
      err: toErrorMessage(error),
    });
  });

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      args.logger?.error("window.did_fail_load", {
        windowId: win.id,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    },
  );

  win.webContents.on(
    "did-start-navigation",
    (_event, url, isInPlace, isMainFrame) => {
      args.logger?.info("window.did_start_navigation", {
        windowId: win.id,
        url,
        isInPlace,
        isMainFrame,
      });
    },
  );

  win.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    args.logger?.info("window.did_navigate_in_page", {
      windowId: win.id,
      url,
      isMainFrame,
    });
  });

  win.webContents.on("did-finish-load", () => {
    args.logger?.info("window.did_finish_load", {
      windowId: win.id,
      url: win.webContents.getURL(),
    });
  });

  win.webContents.on("did-stop-loading", () => {
    args.logger?.info("window.did_stop_loading", {
      windowId: win.id,
      url: win.webContents.getURL(),
    });
  });

  win.webContents.on("dom-ready", () => {
    args.logger?.info("window.dom_ready", {
      windowId: win.id,
      url: win.webContents.getURL(),
    });
  });

  win.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      const payload = {
        windowId: win.id,
        level,
        message,
        line,
        sourceId,
      };
      if (level >= 2) {
        args.logger?.error("window.console", payload);
        return;
      }
      if (level === 1) {
        args.logger?.warn("window.console", payload);
        return;
      }
      args.logger?.info("window.console", payload);
    },
  );

  if (process.env.VITE_DEV_SERVER_URL) {
    try {
      await win.webContents.session.clearCache();
      await win.webContents.session.clearStorageData({
        storages: ["serviceworkers", "cachestorage"],
      });
    } catch (error) {
      args.logger?.warn("renderer.dev_cache_clear_failed", {
        err: error instanceof Error ? error.message : String(error),
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
    win.webContents.session.webRequest.onCompleted(
      { urls: [`${devBase}/*`] },
      (details) => {
        if (recoveredOutdatedOptimizeDep) return;
        const isOutdatedOptimizeDep =
          details.statusCode === 504 &&
          details.url.includes("/node_modules/.vite/deps/") &&
          details.url.includes("v=");
        if (!isOutdatedOptimizeDep) return;

        recoveredOutdatedOptimizeDep = true;
        args.logger?.warn("renderer.optimize_dep_outdated", {
          statusCode: details.statusCode,
          url: details.url,
        });
        void win.webContents.reloadIgnoringCache();
      },
    );
  }

  const rendererUrl = getRendererUrl();
  args.logger?.info("window.loading_url", {
    windowId: win.id,
    url: rendererUrl,
  });

  try {
    await win.loadURL(rendererUrl);
  } catch (error) {
    args.logger?.error("window.load_url_failed", {
      windowId: win.id,
      url: rendererUrl,
      err: toErrorMessage(error),
    });
    const fallbackHtml = encodeURIComponent(
      `<html><body style="margin:0;background:#0f0d14;color:#f8f8f2;font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">` +
        `<h2 style="margin:0 0 12px;">ADE failed to load renderer</h2>` +
        `<p style="margin:0 0 8px;">URL: ${rendererUrl.replace(/</g, "&lt;")}</p>` +
        `<p style="margin:0;">Error: ${toErrorMessage(error).replace(/</g, "&lt;")}</p>` +
        `</body></html>`,
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
  {
    scheme: "ade-artifact",
    privileges: { standard: false, supportFetchAPI: true, stream: true },
  },
]);

app.whenReady().then(async () => {
  /** Canonical artifacts dir for the active project; ade-artifact:// only serves under this path. */
  let adeArtifactAllowedDir: string | null = null;

  const isPathInsideArtifactAllowRoot = (
    resolvedFile: string,
    allowedDir: string,
  ): boolean => {
    let allowed: string;
    try {
      allowed = fs.realpathSync(allowedDir);
    } catch {
      return false;
    }
    const normFile = path.normalize(resolvedFile);
    const normAllowed = path.normalize(allowed);
    if (process.platform === "win32") {
      return (
        normFile
          .toLowerCase()
          .startsWith(normAllowed.toLowerCase() + path.sep) ||
        normFile.toLowerCase() === normAllowed.toLowerCase()
      );
    }
    return (
      normFile === normAllowed || normFile.startsWith(normAllowed + path.sep)
    );
  };

  // Handle ade-artifact:// requests — serves local files for proof drawer previews.
  // Path is encoded in the URL: ade-artifact:///absolute/path/to/file.png
  protocol.handle("ade-artifact", (request) => {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);
    if (url.hostname === "project") {
      if (!activeProjectRoot) return new Response("Not found", { status: 404 });
      filePath = path.resolve(activeProjectRoot, filePath.replace(/^[/\\]+/, ""));
    }
    // On Windows, pathname starts with /C:/... — strip leading slash
    if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    if (!path.isAbsolute(filePath)) {
      if (!activeProjectRoot) return new Response("Not found", { status: 404 });
      filePath = path.resolve(activeProjectRoot, filePath);
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
    if (
      !allowedDir ||
      !isPathInsideArtifactAllowRoot(resolvedFile, allowedDir)
    ) {
      console.warn("[ade-artifact] rejected path outside artifacts dir", {
        resolvedFile,
        allowedDir,
      });
      return new Response("Not found", { status: 404 });
    }
    try {
      const stat = fs.statSync(resolvedFile);
      if (!stat.isFile()) return new Response("Not found", { status: 404 });
      const fileSize = stat.size;
      const ext = path.extname(resolvedFile).replace(/^\./, "").toLowerCase();
      const mimeMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        bmp: "image/bmp",
        svg: "image/svg+xml",
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime",
        avi: "video/x-msvideo",
        mkv: "video/x-matroska",
      };
      const mime = mimeMap[ext] ?? "application/octet-stream";

      // Support Range requests — required for <video> playback and seeking
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        let start = match ? parseInt(match[1], 10) : 0;
        let end =
          match && match[2] !== undefined && match[2] !== ""
            ? parseInt(match[2], 10)
            : fileSize - 1;
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
            fileStream.on("data", (chunk) =>
              controller.enqueue(
                typeof chunk === "string" ? Buffer.from(chunk) : chunk,
              ),
            );
            fileStream.on("end", () => controller.close());
            fileStream.on("error", (err) => controller.error(err));
          },
          cancel() {
            fileStream.destroy();
          },
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
          fileStream.on("data", (chunk) =>
            controller.enqueue(
              typeof chunk === "string" ? Buffer.from(chunk) : chunk,
            ),
          );
          fileStream.on("end", () => controller.close());
          fileStream.on("error", (err) => controller.error(err));
        },
        cancel() {
          fileStream.destroy();
        },
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
      ? process.env.ADE_DISABLE_HARDWARE_ACCEL === "1"
        ? "env_override"
        : "dev_mode"
      : "default",
  });
  const globalStatePath = path.join(app.getPath("userData"), "ade-state.json");
  const saved = readGlobalState(globalStatePath);
  const fallbackProjectRoot = path.resolve(
    app.getPath("userData"),
    "ade-project",
  );
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
      const rootPath =
        typeof entry?.rootPath === "string"
          ? normalizeProjectPath(entry.rootPath)
          : "";
      if (!isLikelyRepoRoot(rootPath)) return acc;
      if (acc.some((item) => item.rootPath === rootPath)) return acc;
      const displayName =
        typeof entry?.displayName === "string" &&
        entry.displayName.trim().length > 0
          ? entry.displayName
          : path.basename(rootPath);
      const lastOpenedAt =
        typeof entry?.lastOpenedAt === "string" &&
        entry.lastOpenedAt.trim().length > 0
          ? entry.lastOpenedAt
          : new Date().toISOString();
      acc.push({ rootPath, displayName, lastOpenedAt });
      return acc;
    },
    [] as Array<{
      rootPath: string;
      displayName: string;
      lastOpenedAt: string;
    }>,
  );
  const hadRecentProjectsChanges =
    cleanedRecentProjects.length !== (saved.recentProjects ?? []).length;
  const cleanedLastProjectRoot = saved.lastProjectRoot
    ? normalizeProjectPath(saved.lastProjectRoot)
    : "";
  const validLastProjectRoot =
    isLikelyRepoRoot(cleanedLastProjectRoot) &&
    cleanedRecentProjects.some(
      (project) => project.rootPath === cleanedLastProjectRoot,
    )
      ? cleanedLastProjectRoot
      : "";
  const hadLastProjectRootChanges =
    saved.lastProjectRoot !== validLastProjectRoot;
  const normalizedState = {
    ...saved,
    lastProjectRoot: validLastProjectRoot || undefined,
    recentProjects: cleanedRecentProjects,
  };

  if (hadRecentProjectsChanges || hadLastProjectRootChanges) {
    writeGlobalState(globalStatePath, normalizedState);
  }

  const envRoot = process.env.ADE_PROJECT_ROOT;
  const devFallbackProject = process.env.VITE_DEV_SERVER_URL
    ? path.resolve(process.cwd(), "..", "..")
    : fallbackProjectRoot;

  const startupUserSelected = Boolean(envRoot && envRoot.trim().length);
  const initialCandidate =
    envRoot && envRoot.trim().length
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

  const normalizeProjectRoot = (projectRoot: string) =>
    path.resolve(projectRoot);
  const projectContexts = new Map<string, AppContext>();
  const projectInitPromises = new Map<string, Promise<AppContext>>();
  const closeContextPromises = new Map<string, Promise<void>>();
  const rpcSocketCleanupByRoot = new Map<string, () => void>();
  const projectLastActivatedAt = new Map<string, number>();
  const mobileSyncHandoffLeases = new Map<string, number>();
  const mobileSyncHandoffLeaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const mobileSyncPreparationPromises = new Map<string, Promise<SyncProjectSwitchResultPayload>>();
  const MAX_WARM_IDLE_PROJECT_CONTEXTS = 1;
  const MOBILE_SYNC_HANDOFF_LEASE_MS = 60_000;
  let activeProjectRoot: string | null = null;
  let dormantContext!: AppContext;
  let projectContextRebalancePromise: Promise<void> = Promise.resolve();

  const emitProjectChanged = (project: ProjectInfo | null): void => {
    broadcast(IPC.appProjectChanged, project);
  };

  const setActiveProject = (projectRoot: string | null): void => {
    activeProjectRoot = projectRoot ? normalizeProjectRoot(projectRoot) : null;
    for (const [root, ctx] of projectContexts) {
      const isActive = activeProjectRoot != null && root === activeProjectRoot;
      ctx.syncService?.setHostStartupEnabled?.(isActive);
      ctx.syncService?.setHostDiscoveryEnabled?.(isActive);
    }
    if (activeProjectRoot) {
      projectLastActivatedAt.set(activeProjectRoot, Date.now());
      try {
        adeArtifactAllowedDir =
          resolveAdeLayout(activeProjectRoot).artifactsDir;
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

  const emitProjectEvent = (
    projectRoot: string,
    channel: string,
    payload: unknown,
  ): void => {
    if (!activeProjectRoot) return;
    if (normalizeProjectRoot(projectRoot) !== activeProjectRoot) return;
    broadcast(channel, payload);
  };

  const hasActiveProjectWorkloads = async (
    projectRoot: string,
    ctx: AppContext,
  ): Promise<boolean> => {
    const keepAliveOnProbeFailure = (
      probe: string,
      error: unknown,
    ): boolean => {
      ctx.logger.warn("project.context_workload_probe_failed", {
        projectRoot,
        probe,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    };

    try {
      if (ctx.sessionService.list({ status: "running", limit: 1 }).length > 0) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("sessions", error);
    }

    try {
      if (ctx.missionService.list({ status: "active", limit: 1 }).length > 0) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("missions", error);
    }

    try {
      if (ctx.testService.hasActiveRuns()) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("tests", error);
    }

    try {
      const lanes = await ctx.laneService.list({
        includeArchived: false,
        includeStatus: false,
      });
      for (const lane of lanes) {
        if (
          ctx.processService.listRuntime(lane.id).some((runtime) =>
            runtime.status === "starting"
            || runtime.status === "running"
            || runtime.status === "degraded"
            || runtime.status === "stopping"
          )
        ) {
          return true;
        }
      }
    } catch (error) {
      return keepAliveOnProbeFailure("processes", error);
    }

    try {
      if ((ctx.laneProxyService?.getStatus().routes.length ?? 0) > 0) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("proxy_routes", error);
    }

    try {
      if (
        ctx.oauthRedirectService?.listSessions().some((session) =>
          session.status === "pending" || session.status === "active"
        ) ?? false
      ) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("oauth_sessions", error);
    }

    try {
      if ((ctx.getActiveRpcConnectionCount?.() ?? 0) > 0) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("rpc_connections", error);
    }

    try {
      const leaseExpiresAt = mobileSyncHandoffLeases.get(projectRoot) ?? 0;
      if (leaseExpiresAt > Date.now()) {
        return true;
      }
      if (leaseExpiresAt > 0) {
        mobileSyncHandoffLeases.delete(projectRoot);
      }

      if ((ctx.syncHostService?.getPeerStates().length ?? 0) > 0) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("sync_peers", error);
    }

    try {
      const syncStatus = await ctx.syncService?.getStatus?.();
      if (syncStatus?.client.state === "connected") {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("sync_client", error);
    }

    return false;
  };

  const rebalanceProjectContexts = async (): Promise<void> => {
    const currentActiveRoot = activeProjectRoot;
    if (!currentActiveRoot) return;

    const idleRoots: string[] = [];
    for (const [projectRoot, ctx] of projectContexts.entries()) {
      if (projectRoot === currentActiveRoot) continue;
      if (await hasActiveProjectWorkloads(projectRoot, ctx)) {
        ctx.logger.info("project.context_retained", {
          projectRoot,
          policy: "active_workload",
        });
        continue;
      }
      idleRoots.push(projectRoot);
    }

    idleRoots.sort(
      (left, right) =>
        (projectLastActivatedAt.get(right) ?? 0)
        - (projectLastActivatedAt.get(left) ?? 0),
    );
    const warmRoots = new Set(
      idleRoots.slice(0, MAX_WARM_IDLE_PROJECT_CONTEXTS),
    );

    for (const projectRoot of idleRoots) {
      if (activeProjectRoot !== currentActiveRoot) {
        return;
      }
      const ctx = projectContexts.get(projectRoot);
      if (!ctx) continue;
      if (projectRoot === activeProjectRoot) continue;
      if (warmRoots.has(projectRoot)) {
        ctx.logger.info("project.context_retained", {
          projectRoot,
          policy: "warm_idle",
          activeProjectRoot: currentActiveRoot,
        });
        continue;
      }
      // Re-check workloads immediately before eviction to avoid TOCTOU races
      if (await hasActiveProjectWorkloads(projectRoot, ctx)) {
        ctx.logger.info("project.context_retained", {
          projectRoot,
          policy: "became_active_during_rebalance",
          activeProjectRoot: currentActiveRoot,
        });
        continue;
      }
      ctx.logger.info("project.context_evicted", {
        projectRoot,
        policy: "idle_after_switch",
        activeProjectRoot: currentActiveRoot,
      });
      await closeProjectContext(projectRoot);
    }
  };

  const scheduleProjectContextRebalance = (): void => {
    projectContextRebalancePromise = projectContextRebalancePromise
      .catch(() => {
        // Swallow previous rebalance failures so future rebalances still run.
      })
      .then(async () => {
        try {
          await rebalanceProjectContexts();
        } catch (error) {
          const logger = activeProjectRoot
            ? projectContexts.get(activeProjectRoot)?.logger ?? dormantContext.logger
            : dormantContext.logger;
          logger.warn("project.context_rebalance_failed", {
            activeProjectRoot,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
  };

  // --- Auto-update service (global, not per-project) ---
  // Created early so every `rpcRuntime` built inside `initContextForProjectRoot`
  // captures a live reference. Previously this was assigned after all init
  // paths were registered, which meant RPC-visible `runtime.autoUpdateService`
  // could be null if a project context was built before the late assignment.
  const updateLogger = createFileLogger(
    path.join(app.getPath("userData"), "ade-update.jsonl"),
  );
  cleanupStaleTempArtifacts({
    tempRoot: app.getPath("temp"),
    logger: updateLogger,
  });
  const autoUpdateService = createAutoUpdateService({
    logger: updateLogger,
    currentVersion: app.getVersion(),
    globalStatePath,
  });

  const initContextForProjectRoot = async ({
    projectRoot,
    baseRef,
    ensureExclude,
    recordLastProject = true,
    recordRecent = true,
    userSelectedProject = false,
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
    const packagedFirstOpenStabilityMode =
      app.isPackaged
      && !hadAdeDir
      && process.env.ADE_DISABLE_FIRST_OPEN_STABILITY !== "1";
    const projectStabilityMode = devStabilityMode || packagedFirstOpenStabilityMode;

    logger.info("project.init", { projectRoot, baseRef, ensureExclude });
    if (projectStabilityMode) {
      logger.info("project.startup_stability_mode", {
        projectRoot,
        reason: packagedFirstOpenStabilityMode ? "packaged_first_open" : "dev_stability_mode",
        enableAllBackgroundTasks,
      });
    }

    const isProjectBackgroundTaskEnabled = (enableFlag?: string): boolean => {
      if (!projectStabilityMode || enableAllBackgroundTasks) {
        return true;
      }
      if (!enableFlag) {
        return false;
      }
      return (
        process.env[enableFlag] === "1" ||
        defaultEnabledBackgroundTaskFlags.has(enableFlag)
      );
    };

    const measureProjectInitStep = async <T,>(
      step: string,
      task: () => Promise<T> | T,
    ): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await task();
      } finally {
        logger.info("project.init_step", {
          projectRoot,
          step,
          durationMs: Date.now() - startedAt,
        });
      }
    };

    const db = await measureProjectInitStep("db_open", () =>
      openKvDb(adePaths.dbPath, logger),
    );
    const keybindingsService = createKeybindingsService({ db });
    const agentToolsService = createAgentToolsService({ logger });
    const adeCliService = createAdeCliService({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      appExecutablePath: process.execPath,
      logger,
    });
    adeCliService.applyToProcessEnv();
    const devToolsService = createDevToolsService({ logger });

    const project = toProjectInfo(projectRoot, baseRef);
    const { projectId } = upsertProjectRow({
      db,
      repoRoot: projectRoot,
      displayName: project.displayName,
      baseRef,
    });

    const operationService = createOperationService({ db, projectId });

    let jobEngine: ReturnType<typeof createJobEngine> | null = null;
    let automationService: ReturnType<typeof createAutomationService> | null =
      null;
    let rebaseSuggestionService: ReturnType<
      typeof createRebaseSuggestionService
    > | null = null;
    let autoRebaseService: ReturnType<typeof createAutoRebaseService> | null =
      null;
    let humanWorkDigestService: ReturnType<
      typeof createHumanWorkDigestService
    > | null = null;
    let conflictServiceRef: ReturnType<typeof createConflictService> | null =
      null;
    let prServiceRef: ReturnType<typeof createPrService> | null = null;
    let prPollingServiceRef: ReturnType<typeof createPrPollingService> | null =
      null;
    let testServiceRef: ReturnType<typeof createTestService> | null = null;
    let gitServiceRef: ReturnType<typeof createGitOperationsService> | null =
      null;
    let missionBudgetServiceRef: ReturnType<
      typeof createMissionBudgetService
    > | null = null;

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

      const prev = lastHeadByLaneId.get(laneId) ?? args.preHeadSha ?? null;
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
        postHeadSha,
      });
      const laneTypeRow = db.get<{ lane_type: string | null }>(
        `select lane_type from lanes where id = ? and project_id = ? limit 1`,
        [laneId, projectId],
      );
      if (String(laneTypeRow?.lane_type ?? "").trim() === "primary") {
        void humanWorkDigestService
          ?.onHeadChanged({ preHeadSha: prev, postHeadSha })
          .catch(() => {});
      }
      void rebaseSuggestionService
        ?.onParentHeadChanged({
          laneId,
          reason: args.reason,
          preHeadSha: prev,
          postHeadSha,
        })
        .catch(() => {});
      void autoRebaseService
        ?.onHeadChanged({
          laneId,
          reason: args.reason,
          preHeadSha: prev,
          postHeadSha,
        })
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
        if (
          event.type === "rebase-run-updated" &&
          event.run.state !== "running"
        ) {
          void conflictServiceRef?.scanRebaseNeeds().catch((error) => {
            logger.warn("rebase.needs_refresh_failed", {
              runId: event.run.runId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      },
      logger,
    });
    await measureProjectInitStep("lane.ensure_primary", () =>
      laneService.ensurePrimaryLane(),
    );

    const laneEnvironmentService = createLaneEnvironmentService({
      projectRoot,
      adeDir: adePaths.adeDir,
      logger,
      broadcastEvent: (ev) =>
        emitProjectEvent(projectRoot, IPC.lanesEnvEvent, ev),
    });

    const sessionService = createSessionService({ db });
    sessionService.onChanged((event) => {
      emitProjectEvent(projectRoot, IPC.sessionsChanged, event);
    });
    const reconciledSessions = sessionService.reconcileStaleRunningSessions({
      status: "disposed",
    });
    if (reconciledSessions > 0) {
      logger.warn("sessions.reconciled_stale_running", {
        count: reconciledSessions,
      });
    }
    const diffService = createDiffService({ laneService });
    const projectConfigService = createProjectConfigService({
      projectRoot,
      adeDir: adePaths.adeDir,
      projectId,
      db,
      logger,
    });

    const laneTemplateService = createLaneTemplateService({
      projectConfigService,
      logger,
    });

    const portAllocationService = createPortAllocationService({
      logger,
      broadcastEvent: (ev) =>
        emitProjectEvent(projectRoot, IPC.lanesPortEvent, ev),
      persistLeases: (leases) => db.setJson("port_leases", leases),
      loadLeases: () => db.getJson<PortLease[]>("port_leases") ?? [],
    });
    portAllocationService.restore();

    const recoverPortAllocations = async () => {
      try {
        const lanes = await laneService.list({
          includeArchived: false,
          includeStatus: false,
        });
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
        logger.warn("port_allocation.startup_recovery_failed", {
          error: err?.message,
        });
      }
    };

    const laneProxyService = createLaneProxyService({
      logger,
      broadcastEvent: (ev) =>
        emitProjectEvent(projectRoot, IPC.lanesProxyEvent, ev),
    });

    const oauthRedirectService = createOAuthRedirectService({
      logger,
      broadcastEvent: (ev) =>
        emitProjectEvent(projectRoot, IPC.lanesOAuthEvent, ev),
      getRoutes: () => laneProxyService.listRoutes(),
      getProxyPort: () => laneProxyService.getConfig().proxyPort,
      getHostnameSuffix: () => laneProxyService.getConfig().hostnameSuffix,
      forwardToPort: (req, res, port) =>
        laneProxyService.forwardToPort(req, res, port),
    });

    // Register OAuth callback interceptor on the proxy
    laneProxyService.registerInterceptor((req, res) =>
      oauthRedirectService.handleRequest(req, res),
    );

    const runtimeDiagnosticsService = createRuntimeDiagnosticsService({
      logger,
      broadcastEvent: (ev) =>
        emitProjectEvent(projectRoot, IPC.lanesDiagnosticsEvent, ev),
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
      projectConfigService,
    });

    if (!hadAdeDir) {
      const hasEnvCredentials =
        Boolean(
          (
            process.env.GITHUB_TOKEN ??
            process.env.ADE_GITHUB_TOKEN ??
            ""
          ).trim(),
        ) ||
        Boolean(
          [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "MISTRAL_API_KEY",
            "DEEPSEEK_API_KEY",
            "XAI_API_KEY",
            "GROQ_API_KEY",
            "TOGETHER_API_KEY",
            "OPENROUTER_API_KEY",
          ].some((v) => (process.env[v] ?? "").trim().length > 0),
        ) ||
        Boolean(
          [
            "ADE_LINEAR_API",
            "LINEAR_API_KEY",
            "ADE_LINEAR_TOKEN",
            "LINEAR_TOKEN",
          ].some((v) => (process.env[v] ?? "").trim().length > 0)
        );
      if (hasEnvCredentials) {
        onboardingService.complete();
        logger.info("onboarding.auto_completed", {
          reason: "env_credentials_detected",
        });
      }
    }

    rebaseSuggestionService = createRebaseSuggestionService({
      db,
      logger,
      projectId,
      projectRoot,
      laneService,
      onEvent: (event) =>
        emitProjectEvent(projectRoot, IPC.lanesRebaseSuggestionsEvent, event),
    });
    // Prime suggestions once on init so the UI can show them without waiting for a head change.
    void rebaseSuggestionService
      .listSuggestions()
      .then((suggestions) =>
        emitProjectEvent(projectRoot, IPC.lanesRebaseSuggestionsEvent, {
          type: "rebase-suggestions-updated",
          computedAt: new Date().toISOString(),
          suggestions,
        }),
      )
      .catch(() => {});

    const githubService = createGithubService({
      logger,
      projectRoot,
      appDataDir: app.getPath("userData"),
    });

    const feedbackReporterService = createFeedbackReporterService({
      db,
      logger,
      projectRoot,
      aiIntegrationService,
      githubService,
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
        if (
          event.type === "rebase-started" ||
          event.type === "rebase-completed" ||
          event.type === "rebase-needs-updated"
        ) {
          emitProjectEvent(projectRoot, IPC.rebaseEvent, event);
        }
      },
    });
    conflictServiceRef = conflictService;

    autoRebaseService = createAutoRebaseService({
      db,
      logger,
      laneService,
      conflictService,
      projectConfigService,
      onEvent: (event) =>
        emitProjectEvent(projectRoot, IPC.lanesAutoRebaseEvent, event),
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
      },
    });
    prServiceRef = prService;

    let knowledgeCaptureServiceRef: ReturnType<
      typeof createKnowledgeCaptureService
    > | null = null;

    // --- Mobile push notifications (APNs + event bus) -----------------------
    // ApnsService is instantiated but left unconfigured here; the Mobile Push
    // settings panel calls into it once the user uploads a `.p8` key. The
    // notification event bus is always wired so in-app WebSocket delivery
    // works even when APNs is disabled.
    let syncServiceForNotifications: SyncService | null = null;
    const apnsService = new ApnsService({ logger });
    const apnsKeyStore = new ApnsKeyStore({
      encryptedKeyPath: path.join(projectRoot, ".ade", "secrets", "apns.key.enc"),
      safeStorage,
    });
    // Attempt to restore a previously-stored key + config on project load so
    // push delivery survives restarts without user intervention.
    try {
      const effective = projectConfigService.get().effective;
      const apnsConfig = effective.notifications?.apns ?? null;
      logger.info("apns.configure_on_startup_attempt", {
        hasConfig: apnsConfig != null,
        enabled: apnsConfig?.enabled === true,
        keyStored: apnsKeyStore.has(),
        hasKeyId: Boolean(apnsConfig?.keyId),
        hasTeamId: Boolean(apnsConfig?.teamId),
        hasBundleId: Boolean(apnsConfig?.bundleId),
        env: apnsConfig?.env ?? null,
      });
      if (apnsConfig?.enabled && apnsKeyStore.has() && apnsConfig.keyId && apnsConfig.teamId && apnsConfig.bundleId) {
        const pem = apnsKeyStore.load();
        if (pem) {
          apnsService.configure({
            keyP8Pem: pem,
            keyId: apnsConfig.keyId,
            teamId: apnsConfig.teamId,
            bundleId: apnsConfig.bundleId,
            env: apnsConfig.env ?? "sandbox",
          });
          logger.info("apns.configure_on_startup_ok", { keyId: apnsConfig.keyId });
        }
      }
    } catch (error) {
      logger.warn("apns.configure_on_startup_failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    const listPushTargets = (): DevicePushTarget[] => {
      const registry: DeviceRegistryService | null =
        syncServiceForNotifications?.getDeviceRegistryService?.() ?? null;
      if (!registry) return [];
      const effective = projectConfigService.get().effective;
      const apnsConfig = effective.notifications?.apns ?? null;
      const bundleId = apnsConfig?.bundleId?.trim() ?? "";
      const env = apnsConfig?.env === "production" ? "production" : "sandbox";
      return registry
        .listDevices()
        .filter((device) => device.deviceType === "phone" && device.platform === "iOS")
        .map((device) => {
          const meta = device.metadata ?? {};
          const alertToken = typeof meta.apnsAlertToken === "string" ? meta.apnsAlertToken : null;
          const activityStartToken = typeof meta.apnsActivityStartToken === "string" ? meta.apnsActivityStartToken : null;
          const activityUpdateTokens =
            meta.apnsActivityUpdateTokens && typeof meta.apnsActivityUpdateTokens === "object"
              ? (meta.apnsActivityUpdateTokens as Record<string, string>)
              : null;
          const perDeviceBundleId =
            typeof meta.apnsBundleId === "string" && meta.apnsBundleId.trim().length > 0
              ? meta.apnsBundleId
              : bundleId;
          return {
            deviceId: device.deviceId,
            bundleId: perDeviceBundleId,
            env: (meta.apnsEnv === "production" ? "production" : env) as "sandbox" | "production",
            alertToken,
            activityStartToken,
            activityUpdateTokens,
          } satisfies DevicePushTarget;
        })
        .filter((target) => target.bundleId.trim().length > 0);
    };
    const notificationEventBus: NotificationEventBus = createNotificationEventBus({
      logger,
      apnsService,
      listPushTargets,
      getPrefsForDevice: (deviceId) =>
        syncServiceForNotifications?.getHostService()?.getNotificationPrefsForDevice(deviceId) ?? null,
      sendInAppNotification: (deviceId, payload) => {
        syncServiceForNotifications?.getHostService()?.sendInAppNotification(deviceId, payload);
      },
      isDeviceConnected: (deviceId) =>
        syncServiceForNotifications?.getHostService()?.isIosPeerConnected(deviceId) ?? false,
    });
    // When APNs reports an invalid token, drop it from the registry so we
    // stop fanning out to a dead device.
    apnsService.onTokenInvalidated(({ deviceToken }) => {
      const registry = syncServiceForNotifications?.getDeviceRegistryService?.() ?? null;
      registry?.invalidateApnsToken?.(deviceToken);
    });

    const prPollingService = createPrPollingService({
      logger,
      prService,
      projectConfigService,
      db,
      notificationEventBus,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.prsEvent, event),
      onPullRequestsChanged: async ({ changedPrs, changes }) => {
        if (changedPrs.length > 0) {
          prService.markHotRefresh(changedPrs.map((pr) => pr.id));
        }
        await Promise.all([
          ...changedPrs.map(
            (pr) =>
              knowledgeCaptureServiceRef?.capturePrFeedback({
                prId: pr.id,
                prNumber: pr.githubPrNumber ?? null,
              }) ?? Promise.resolve(),
          ),
          ...changes.map(
            ({
              pr,
              previousState,
              previousChecksStatus,
              previousReviewStatus,
            }) => {
              automationService?.onPullRequestChanged?.({
                pr,
                previousState,
                previousChecksStatus,
                previousReviewStatus,
              });
              return Promise.resolve();
            },
          ),
        ]);
      },
    });
    prPollingServiceRef = prPollingService;

    let orchestratorServiceRef: ReturnType<
      typeof createOrchestratorService
    > | null = null;
    let aiOrchestratorServiceRef: ReturnType<
      typeof createAiOrchestratorService
    > | null = null;
    let linearDispatcherServiceRef: ReturnType<
      typeof createLinearDispatcherService
    > | null = null;
    let openclawBridgeServiceRef: ReturnType<
      typeof createOpenclawBridgeService
    > | null = null;
    let linearSyncServiceRef: ReturnType<
      typeof createLinearSyncService
    > | null = null;
    let linearIngressServiceRef: ReturnType<
      typeof createLinearIngressService
    > | null = null;
    let agentChatServiceRef: ReturnType<typeof createAgentChatService> | null =
      null;
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
      },
    });
    queueLandingService.init();

    const issueInventoryService = createIssueInventoryService({ db });

    const prSummaryService = createPrSummaryService({
      db,
      logger,
      projectRoot,
      prService,
      aiIntegrationService,
    });

    const fileService = createFileService({
      laneService,
      onLaneWorktreeMutation: ({ laneId, reason }) => {
        jobEngine.onLaneDirtyChanged({ laneId, reason });
      },
    });

    const getLaneRuntimeEnv = async (laneId: string) => {
      const lease = portAllocationService.getLease(laneId);
      const lane = (await laneService.list({ includeArchived: false, includeStatus: false })).find(
        (entry) => entry.id === laneId,
      );
      const hostname = laneProxyService.getRoute(laneId)?.hostname
        ?? laneProxyService.generateHostname(laneId, lane?.name);
      const portStart = lease?.rangeStart ?? 3000;
      const portEnd = lease?.rangeEnd ?? portStart;
      return {
        PORT: String(portStart),
        PORT_RANGE_START: String(portStart),
        PORT_RANGE_END: String(portEnd),
        HOSTNAME: hostname,
        PROXY_HOSTNAME: hostname,
      };
    };

    const onTrackedSessionEnded = ({
      laneId,
      sessionId,
      exitCode,
    }: {
      laneId: string;
      sessionId: string;
      exitCode: number | null;
    }) => {
      jobEngine?.onSessionEnded({ laneId, sessionId });
      automationService?.onSessionEnded({ laneId, sessionId });
      try {
        issueInventoryService.reconcileConvergenceSessionExit(sessionId, {
          exitCode,
        });
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
            exitCode,
          })
          .catch(() => {});
      }
    };

    let syncServiceRef: ReturnType<typeof createSyncService> | null = null;
    const ptyService = createPtyService({
      projectRoot,
      transcriptsDir: adePaths.transcriptsDir,
      laneService,
      sessionService,
      aiIntegrationService,
      projectConfigService,
      getLaneRuntimeEnv,
      getAdeCliAgentEnv: adeCliService.agentEnv,
      logger,
      broadcastData: (ev) => {
        broadcast(IPC.ptyData, ev);
        const { projectRoot: _projectRoot, ...syncEvent } = ev;
        syncServiceRef?.handlePtyData(syncEvent);
      },
      broadcastExit: (ev) => {
        broadcast(IPC.ptyExit, ev);
        const { projectRoot: _projectRoot, ...syncEvent } = ev;
        syncServiceRef?.handlePtyExit(syncEvent);
      },
      onSessionEnded: onTrackedSessionEnded,
      onSessionRuntimeSignal: (signal) => {
        aiOrchestratorServiceRef?.onSessionRuntimeSignal(signal);
      },
      loadPty,
    });

    const processService = createProcessService({
      db,
      projectId,
      logger,
      laneService,
      projectConfigService,
      sessionService,
      ptyService,
      getLaneRuntimeEnv,
      broadcastEvent: (ev) =>
        emitProjectEvent(projectRoot, IPC.processesEvent, ev),
    });

    const sessionDeltaService = createSessionDeltaService({
      db,
      projectId,
      laneService,
      sessionService,
    });

    let batchConsolidationServiceRef: ReturnType<
      typeof createBatchConsolidationService
    > | null = null;
    let embeddingWorkerServiceRef: ReturnType<
      typeof createEmbeddingWorkerService
    > | null = null;
    const embeddingService = createEmbeddingService({
      logger,
      cacheDir: path.join(app.getPath("userData"), "transformers-cache"),
    });
    // Auto-detect previously downloaded embedding model at startup
    void embeddingService.probeCache().catch(() => {
      /* best-effort */
    });
    const hybridSearchService = createHybridSearchService({
      db,
      embeddingService,
      logger,
    });
    let ctoStateServiceRef: ReturnType<typeof createCtoStateService> | null =
      null;
    let memoryFilesServiceRef: ReturnType<
      typeof createProjectMemoryFilesService
    > | null = null;
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
    const memoryService = createMemoryService(db, {
      hybridSearchService,
      onMemoryMutated: () => {
        batchConsolidationServiceRef?.scheduleAutoConsolidationCheck();
        debouncedSyncMemoryDocs();
      },
      onMemoryUpserted: (event) => {
        if (event.created || event.contentChanged) {
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
    const batchConsolidationService = createBatchConsolidationService({
      db,
      logger,
      aiIntegrationService,
      projectConfigService,
      projectId,
      projectRoot,
      onStatus: (event) =>
        emitProjectEvent(projectRoot, IPC.memoryConsolidationStatus, event),
      onMemoryInserted: (memoryId) => {
        embeddingWorkerServiceRef?.queueMemory(memoryId);
      },
    });
    batchConsolidationServiceRef = batchConsolidationService;
    const memoryLifecycleService = createMemoryLifecycleService({
      db,
      logger,
      projectId,
      onStatus: (event) =>
        emitProjectEvent(projectRoot, IPC.memorySweepStatus, event),
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
    let skillRegistryServiceRef: ReturnType<
      typeof createSkillRegistryService
    > | null = null;
    const proceduralLearningService = createProceduralLearningService({
      db,
      logger,
      projectId,
      memoryService,
      onProcedurePromoted: (memoryId) => {
        void skillRegistryServiceRef
          ?.exportProcedureSkill({ id: memoryId })
          .catch(() => {});
      },
    });
    const episodicSummaryService = createEpisodicSummaryService({
      projectId,
      projectRoot,
      logger,
      enabled: episodicSummaryEnabled,
      aiIntegrationService,
      memoryService,
      onEpisodeSaved: (memoryId) =>
        proceduralLearningService.onEpisodeSaved(memoryId),
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
      onStatusChanged: (status) =>
        emitProjectEvent(projectRoot, IPC.contextStatusChanged, status),
    });

    const ctoStateService = createCtoStateService({
      db,
      projectId,
      adeDir: adePaths.adeDir,
      memoryService,
    });
    ctoStateServiceRef = ctoStateService;

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
      autoStart: false,
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
      aiIntegrationService,
      ctoStateService,
      logger,
      appVersion: app.getVersion(),
      getAdeCliAgentEnv: adeCliService.agentEnv,
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onAgentChatEvent(event);
        openclawBridgeServiceRef?.onAgentChatEvent(event);
        emitProjectEvent(projectRoot, IPC.agentChatEvent, event);

        // Capture agent session errors as failure gotchas for the memory system
        if (event.event.type === "error" && event.provenance?.runId) {
          const prov = event.provenance;
          void knowledgeCaptureServiceRef
            ?.captureFailureGotcha({
              missionId: prov.runId!,
              runId: prov.runId!,
              stepId: null,
              attemptId: prov.attemptId ?? null,
              stepKey: prov.stepKey ?? null,
              summary: `Agent session error in ${prov.role ?? "agent"} session`,
              errorMessage: event.event.message,
            })
            .catch(() => {});
        }
      },
      onSessionEnded: onTrackedSessionEnded,
      getDirtyFileTextForPath: async (absPath: string) => {
        const trimmed = absPath.trim();
        if (!trimmed) return undefined;
        const win =
          BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win?.webContents || win.webContents.isDestroyed())
          return undefined;
        try {
          const js = `typeof window.__ADE_GET_DIRTY_FILE_TEXT__ === "function" ? window.__ADE_GET_DIRTY_FILE_TEXT__(${JSON.stringify(trimmed)}) : undefined`;
          const result: unknown = await win.webContents.executeJavaScript(
            js,
            true,
          );
          return typeof result === "string" ? result : undefined;
        } catch {
          return undefined;
        }
      },
    });
    agentChatServiceRef = agentChatService;
    setImmediate(() => {
      void Promise.resolve()
        .then(() => agentChatService.cleanupStaleAttachments())
        .catch((err) => {
          logger.warn("agent_chat.cleanup_stale_attachments_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
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
      onHeadChanged: handleHeadChanged,
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
      },
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
      onEvent: (event) =>
        emitProjectEvent(projectRoot, IPC.automationsEvent, event),
    });
    const reviewService = createReviewService({
      db,
      logger,
      projectId,
      projectRoot,
      projectDefaultBranch: baseRef,
      laneService,
      gitService,
      agentChatService,
      sessionService,
      sessionDeltaService,
      testService,
      issueInventoryService,
      prService,
      embeddingService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.reviewEvent, event),
    });
    const automationIngressService = createAutomationIngressService({
      logger,
      automationService,
      secretService: automationSecretService,
      listRules: () => projectConfigService.get().effective.automations ?? [],
    });

    const githubPollingService = createGithubPollingService({
      logger,
      githubService,
      automationService,
    });

    let missionServiceRef: ReturnType<typeof createMissionService> | null =
      null;
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
            lastError:
              intervention.body?.trim() || intervention.title?.trim() || null,
          },
        );
      },
      onInterventionResolved: ({ missionId, intervention }) => {
        void knowledgeCaptureService
          .captureResolvedIntervention({
            missionId,
            intervention,
          })
          .catch(() => {});
      },
      onEvent: (event) => {
        openclawBridgeServiceRef?.onMissionEvent(event);
        emitProjectEvent(projectRoot, IPC.missionsEvent, event);
        if (event.missionId) {
          automationService?.onMissionUpdated({ missionId: event.missionId });
        }
        if (event.reason === "ready_to_start" && event.missionId) {
          void aiOrchestratorServiceRef
            ?.startMissionRun({
              missionId: event.missionId,
              queueClaimToken: event.claimToken ?? null,
            })
            .catch((error) => {
              logger.warn("missions.queue_autostart_failed", {
                missionId: event.missionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
      },
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
    let missionPreflightService: ReturnType<
      typeof createMissionPreflightService
    >;
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
          Promise.resolve().then(task).catch(onError);
        }, delayMs);
        deferredProjectStartCancels.add(cancelTimeout);
        return;
      }
      const handle = setImmediate(() => {
        deferredProjectStartCancels.delete(cancelImmediate);
        Promise.resolve().then(task).catch(onError);
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
      if (!isProjectBackgroundTaskEnabled(enableFlag)) {
        logger.info("project.startup_task_skipped", {
          projectRoot,
          task: label,
          reason: "stability_mode",
          enableFlag: enableFlag ?? null,
        });
        return;
      }
      if (projectStabilityMode) {
        logger.info("project.startup_task_enabled", {
          projectRoot,
          task: label,
          reason: enableAllBackgroundTasks
            ? "global_override"
            : "per_task_override",
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

    scheduleBackgroundProjectTask(
      "worker_heartbeat.start",
      () => workerHeartbeatService.start(),
      (error) => {
        logger.warn("worker_heartbeat.start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      30_000,
      "ADE_ENABLE_WORKER_HEARTBEAT",
    );

    scheduleBackgroundProjectTask(
      "memory.files.initial_sync",
      () =>
        measureProjectInitStep("memory.files.initial_sync", () => {
          memoryFilesService.sync();
        }),
      (error) => {
        logger.warn("memory_files.sync_failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_MEMORY_FILE_SYNC",
    );

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
      onStatusChange: (status) =>
        emitProjectEvent(projectRoot, IPC.openclawConnectionStatus, status),
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
      onEvent: (event) => {
        aiOrchestratorServiceRef?.onOrchestratorRuntimeEvent(event);
        openclawBridgeServiceRef?.onOrchestratorEvent(event);
        emitProjectEvent(projectRoot, IPC.orchestratorEvent, event);
      },
    });
    orchestratorServiceRef = orchestratorService;
    const computerUseArtifactBrokerService =
      createComputerUseArtifactBrokerService({
        db,
        projectId,
        projectRoot,
        missionService,
        orchestratorService,
        logger,
        onEvent: (payload) =>
          emitProjectEvent(projectRoot, IPC.computerUseEvent, payload),
      });
    agentChatService.setComputerUseArtifactBrokerService(
      computerUseArtifactBrokerService,
    );
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
      onThreadEvent: (event) =>
        emitProjectEvent(projectRoot, IPC.orchestratorThreadEvent, event),
      onDagMutation: (event) =>
        emitProjectEvent(projectRoot, IPC.orchestratorDagMutation, event),
    });
    aiOrchestratorServiceRef = aiOrchestratorService;
    // Only the project that matches the currently-active root should auto-start
    // its sync host; background project contexts stay dormant until activated.
    // ADE_DISABLE_SYNC_HOST=1 is a global kill switch for tests / CI.
    const isActiveProjectContext =
      activeProjectRoot != null
      && normalizeProjectRoot(projectRoot) === activeProjectRoot;
    const syncHostAutoStart =
      process.env.ADE_DISABLE_SYNC_HOST !== "1" && isActiveProjectContext;
    const syncService = createSyncService({
      db,
      logger,
      projectRoot,
      localDeviceIdPath: path.join(app.getPath("userData"), "sync-device-id"),
      fileService,
      laneService,
      gitService,
      diffService,
      conflictService,
      prService,
      issueInventoryService,
      queueLandingService,
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
      workerAgentService,
      workerBudgetService,
      workerHeartbeatService,
      workerRevisionService,
      ctoStateService,
      flowPolicyService,
      linearCredentialService,
      getLinearIngressService: () => linearIngressServiceRef,
      getLinearIssueTracker: () => linearIssueTracker,
      getLinearSyncService: () => linearSyncServiceRef,
      processService,
      hostStartupEnabled: syncHostAutoStart,
      phonePairingStateDir: path.join(app.getPath("userData"), "phone-sync"),
      hostDiscoveryEnabled: isActiveProjectContext,
      notificationEventBus,
      projectCatalogProvider: {
        listProjects: listMobileSyncProjects,
        prepareProjectConnection: prepareMobileSyncProjectConnection,
      },
      onStatusChanged: (snapshot) => {
        if (
          activeProjectRoot == null
          || normalizeProjectRoot(projectRoot) !== activeProjectRoot
        ) {
          return;
        }
        broadcast(IPC.syncEvent, {
          type: "sync-status",
          snapshot,
        });
      },
    });
    syncServiceRef = syncService;
    // Late-bind the sync service into the notification bus dependencies so
    // push targets / prefs / in-app delivery are resolved at send time.
    syncServiceForNotifications = syncService;
    scheduleBackgroundProjectTask(
      "sync.initialize",
      () => measureProjectInitStep("sync.initialize", () => syncService.initialize()),
      (error) => {
        logger.warn("sync.initialize_failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_SYNC_INIT",
    );
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

    logger.info("project.init_stage", {
      projectRoot,
      stage: "linear_closeout_init",
    });
    const linearCloseoutService = createLinearCloseoutService({
      issueTracker: linearIssueTracker,
      outboundService: linearOutboundService,
      missionService,
      orchestratorService,
      prService,
      computerUseArtifactBrokerService,
      logger,
    });
    logger.info("project.init_stage", {
      projectRoot,
      stage: "linear_dispatcher_init",
    });
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
        if (
          event.type === "linear-workflow-run" &&
          event.milestone === "failed"
        ) {
          void knowledgeCaptureServiceRef
            ?.captureFailureGotcha({
              missionId: event.runId,
              runId: event.runId,
              summary: `Linear workflow failed for ${event.issueIdentifier}: ${event.message}`,
              errorMessage: event.message,
            })
            .catch(() => {});
        }
      },
    });
    linearDispatcherServiceRef = linearDispatcherService;

    logger.info("project.init_stage", {
      projectRoot,
      stage: "linear_sync_init",
    });
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
          previousAssigneeId:
            typeof previousIssue?.assigneeId === "string"
              ? previousIssue.assigneeId
              : null,
          previousAssigneeName:
            typeof previousIssue?.assigneeName === "string"
              ? previousIssue.assigneeName
              : null,
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

    logger.info("project.init_stage", {
      projectRoot,
      stage: "linear_ingress_init",
    });
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
          try {
            const dispatched = buildLinearAutomationDispatch(event);
            if (dispatched) {
              await automationService.dispatchIngressTrigger(dispatched);
            }
          } catch (error) {
            logger.warn("linear.automation_dispatch_failed", {
              issueId: event.issueId,
              eventId: event.eventId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    });
    linearIngressServiceRef = linearIngressService;
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
      automationService,
    });

    const usageTrackingService = createUsageTrackingService({
      logger,
      pollIntervalMs: 120_000,
      onUpdate: (snapshot) => {
        emitProjectEvent(projectRoot, IPC.usageEvent, snapshot);
      },
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
      usageTrackingService,
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

    scheduleBackgroundProjectTask(
      "automations.github_polling_start",
      () => githubPollingService.start(),
      (error) => {
        logger.warn("automations.github_polling_start_failed", {
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
      logger,
      onEvent: (event) =>
        emitProjectEvent(projectRoot, IPC.projectStateEvent, event),
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
          error: error instanceof Error ? error.message : String(error),
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
          error: error instanceof Error ? error.message : String(error),
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
          error: error instanceof Error ? error.message : String(error),
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
      headWatcherTimer = setTimeout(
        () => {
          headWatcherTimer = null;
          void pollHeads();
        },
        Math.max(HEAD_WATCHER_MIN_INTERVAL_MS, delayMs),
      );
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
            emitProjectEvent(projectRoot, IPC.projectMissing, {
              rootPath: projectRoot,
            });
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
          [projectId],
        );

        const active = new Set<string>();
        for (const row of rows) {
          const laneId = String(row.id ?? "").trim();
          const worktreePath = String(row.worktree_path ?? "");
          if (!laneId || !worktreePath) continue;
          lanesChecked += 1;
          active.add(laneId);

          const head = await runGit(["rev-parse", "HEAD"], {
            cwd: worktreePath,
            timeoutMs: 8_000,
          });
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
            handleHeadChanged({
              laneId,
              reason: "head_watcher",
              preHeadSha: prev,
              postHeadSha: sha,
            });
          }
        }

        for (const laneId of Array.from(lastHeadByLaneId.keys())) {
          if (!active.has(laneId)) lastHeadByLaneId.delete(laneId);
        }
      } catch (err) {
        logger.warn("git.head_watcher_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      } finally {
        headWatcherRunning = false;
        if (headWatcherActive) {
          if (changesDetected) {
            headWatcherDelayMs = HEAD_WATCHER_MIN_INTERVAL_MS;
          } else if (lanesChecked === 0) {
            headWatcherDelayMs = HEAD_WATCHER_MAX_INTERVAL_MS;
          } else {
            headWatcherDelayMs = Math.min(
              HEAD_WATCHER_MAX_INTERVAL_MS,
              headWatcherDelayMs + 5_000,
            );
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

    const state = upsertRecentProject(
      readGlobalState(globalStatePath),
      project,
      {
        recordLastProject,
        recordRecent,
      },
    );
    writeGlobalState(globalStatePath, state);

    // ── ADE RPC Socket Server (embedded mode) ─────────────────────
    const rpcEventBuffer = createEventBuffer();
    const rpcRuntime: AdeRuntime = {
      projectRoot,
      workspaceRoot: projectRoot,
      projectId,
      project,
      paths: adePaths as unknown as AdeRuntimePaths,
      logger,
      db,
      keybindingsService,
      agentToolsService,
      adeCliService,
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
      operationService,
      projectConfigService,
      conflictService,
      gitService,
      diffService,
      missionService,
      missionPreflightService,
      ptyService,
      testService,
      aiIntegrationService,
      agentChatService,
      prService,
      prSummaryService,
      queueLandingService,
      fileService,
      memoryService,
      ctoStateService,
      workerAgentService,
      workerBudgetService,
      workerRevisionService,
      workerHeartbeatService,
      workerTaskSessionService,
      linearCredentialService,
      openclawBridgeService,
      flowPolicyService,
      linearDispatcherService,
      linearIssueTracker,
      linearSyncService,
      linearIngressService,
      linearRoutingService,
      processService,
      githubService,
      automationService,
      automationPlannerService,
      computerUseArtifactBrokerService,
      orchestratorService,
      aiOrchestratorService,
      missionBudgetService,
      syncHostService: syncService.getHostService(),
      syncService,
      automationIngressService,
      contextDocService,
      feedbackReporterService,
      usageTrackingService,
      budgetCapService,
      sessionDeltaService,
      autoUpdateService,
      issueInventoryService,
      eventBuffer: rpcEventBuffer,
      dispose: () => {}, // desktop manages service lifecycle
    };

    // When ADE_RPC_SOCKET_PATH is set, derive a per-project socket path from
    // the override so each project context gets its own socket and avoids
    // EADDRINUSE. The first context uses the env path as-is for compatibility;
    // subsequent contexts append a project-root hash suffix.
    const envSocketOverride = process.env.ADE_RPC_SOCKET_PATH?.trim();
    const rpcSocketPath = envSocketOverride
      ? projectContexts.size === 0
        ? envSocketOverride
        : `${envSocketOverride}.${Buffer.from(normalizeProjectRoot(projectRoot)).toString("base64url").slice(0, 8)}`
      : adePaths.socketPath;
    const activeRpcConnections = new Set<net.Socket>();

    const destroyActiveRpcConnections = (): void => {
      for (const conn of activeRpcConnections) {
        activeRpcConnections.delete(conn);
        try {
          conn.destroy();
        } catch {
          // ignore
        }
      }
    };
    rpcSocketCleanupByRoot.set(
      normalizeProjectRoot(projectRoot),
      destroyActiveRpcConnections,
    );

    if (!isAdeMcpNamedPipePath(rpcSocketPath)) {
      try {
        fs.unlinkSync(rpcSocketPath);
      } catch {}
    }

    const rpcSocketServer = net.createServer((conn) => {
      activeRpcConnections.add(conn);
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
      const rpcHandler = createAdeRpcRequestHandler({
        runtime: rpcRuntime,
        serverVersion: app.getVersion(),
        onActionsListChanged: () => {
          stop?.notify("ade/actions/list_changed", {});
        },
      });
      stop = startJsonRpcServer(rpcHandler, transport, { nonFatal: true });
      const removeConnection = (): void => {
        activeRpcConnections.delete(conn);
      };
      conn.once("close", removeConnection);
      conn.once("end", removeConnection);
      conn.once("error", removeConnection);
      conn.on("close", () => {
        if (!stopped) {
          stopped = true;
          stop?.();
        }
        rpcHandler.dispose();
      });
      conn.on("error", () => {}); // ignore connection errors
    });
    await measureProjectInitStep("rpc.socket_server_start", () =>
      new Promise<void>((resolve, reject) => {
        const handleListening = () => {
          rpcSocketServer.off("error", handleError);
          resolve();
        };
        const handleError = (error: Error) => {
          rpcSocketServer.off("listening", handleListening);
          reject(error);
        };
        rpcSocketServer.once("listening", handleListening);
        rpcSocketServer.once("error", handleError);
        rpcSocketServer.listen(rpcSocketPath);
      }),
    );
    logger.info("rpc.socket_server_started", { socketPath: rpcSocketPath });

    // Wire the automation runtime into the shared ADE-action registry so
    // that `ade-action` automation steps can invoke the same domain services
    // the RPC server exposes. We do this lazily — the registry re-resolves
    // services on every call so that runtime bindings (bindMissionRuntime,
    // ctoStateService) that settle later are still visible.
    {
      const adeActionLookup: AutomationAdeActionRegistry = {
        isAllowed(domain: string, action: string): boolean {
          return isAllowedAdeAction(domain as AdeActionDomain, action);
        },
        getService(domain: string): Record<string, unknown> | null {
          const pseudoRuntime = buildAdeActionRuntimeForAutomations();
          const services = getAdeActionDomainServices(pseudoRuntime);
          const service = services[domain as AdeActionDomain] ?? null;
          return (service ?? null) as Record<string, unknown> | null;
        },
        listDomains(): string[] {
          return Object.keys(ADE_ACTION_ALLOWLIST);
        },
        listActions(domain: string): string[] {
          return [...(ADE_ACTION_ALLOWLIST[domain as AdeActionDomain] ?? [])];
        },
      };
      automationService?.bindAdeActionRegistry(adeActionLookup);
    }

    // Helper: materialize an AdeRuntime-shaped bag from the current set of
    // locally-created services so that the registry's service map resolves.
    // Using a function closure means this stays reactive to late-bound refs
    // like `ctoStateServiceRef`.
    function buildAdeActionRuntimeForAutomations(): AdeRuntime {
      return {
        laneService,
        gitService,
        diffService,
        conflictService,
        prService,
        testService,
        agentChatService,
        missionService,
        aiOrchestratorService,
        orchestratorService,
        memoryService,
        ctoStateService,
        workerAgentService,
        sessionService,
        operationService,
        projectConfigService,
        issueInventoryService,
        flowPolicyService,
        linearDispatcherService,
        linearIssueTracker,
        linearSyncService,
        linearIngressService,
        linearRoutingService,
        fileService,
        processService,
        ptyService,
        computerUseArtifactBrokerService,
        automationService,
        automationPlannerService,
        githubService,
        keybindingsService,
        onboardingService,
        feedbackReporterService,
        usageTrackingService,
        budgetCapService,
        autoUpdateService,
      } as unknown as AdeRuntime;
    }

    return {
      db,
      logger,
      project,
      projectId,
      adeDir: adePaths.adeDir,
      hasUserSelectedProject: userSelectedProject,
      getActiveRpcConnectionCount: () => activeRpcConnections.size,
      disposeHeadWatcher,
      keybindingsService,
      agentToolsService,
      adeCliService,
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
      feedbackReporterService,
      prService,
      prPollingService,
      computerUseArtifactBrokerService,
      queueLandingService,
      issueInventoryService,
      prSummaryService,
      reviewService,
      jobEngine,
      automationService,
      automationPlannerService,
      automationIngressService,
      githubPollingService,
      usageTrackingService,
      budgetCapService,
      syncHostService: syncService.getHostService(),
      syncService,
      apnsService,
      apnsKeyStore,
      notificationEventBus,
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
      configReloadService,
      rpcSocketServer,
      rpcSocketPath,
    };
  };

  const createDormantProjectContext = (projectRoot = ""): AppContext => {
    const rootIsDefined =
      typeof projectRoot === "string" && projectRoot.trim().length > 0;
    const normalizedRoot = rootIsDefined ? path.resolve(projectRoot) : "";
    const project = {
      rootPath: normalizedRoot,
      displayName: normalizedRoot ? path.basename(normalizedRoot) : "",
      baseRef: "main",
    };
    const logger = createFileLogger(
      path.join(app.getPath("userData"), "ade-idle.jsonl"),
    );
    return {
      db: null,
      logger,
      project,
      hasUserSelectedProject: false,
      projectId: "",
      adeDir: "",
      getActiveRpcConnectionCount: () => 0,
      disposeHeadWatcher: () => {},
      keybindingsService: null,
      agentToolsService: null,
      adeCliService: createAdeCliService({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        userDataPath: app.getPath("userData"),
        appExecutablePath: process.execPath,
        logger,
      }),
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
      feedbackReporterService: null,
      prService: null,
      prPollingService: null,
      queueLandingService: null,
      issueInventoryService: null,
      prSummaryService: null,
      reviewService: null,
      jobEngine: null,
      automationService: null,
      automationPlannerService: null,
      automationIngressService: null,
      githubPollingService: null,
      usageTrackingService: null,
      budgetCapService: null,
      syncHostService: null,
      syncService: null,
      apnsService: null,
      apnsKeyStore: null,
      notificationEventBus: null,
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
      configReloadService: null,
    } as unknown as AppContext;
  };

  const disposeContextResources = async (ctx: AppContext): Promise<void> => {
    const normalizedRoot =
      typeof ctx.project?.rootPath === "string" &&
      ctx.project.rootPath.trim().length > 0
        ? normalizeProjectRoot(ctx.project.rootPath)
        : null;
    // Tear down the ADE RPC socket BEFORE service disposal so in-flight requests
    // do not race with services that are being shut down.
    try {
      if (normalizedRoot) {
        rpcSocketCleanupByRoot.get(normalizedRoot)?.();
        rpcSocketCleanupByRoot.delete(normalizedRoot);
      }
      ctx.rpcSocketServer?.close();
    } catch {
      // ignore
    }
    try {
      if (ctx.rpcSocketPath && !isAdeMcpNamedPipePath(ctx.rpcSocketPath)) {
        fs.unlinkSync(ctx.rpcSocketPath);
      }
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
      ctx.githubPollingService?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.automationService.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.reviewService?.dispose?.();
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
      await ctx.workerHeartbeatService?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.embeddingService?.stopHealthCheck?.();
    } catch {
      // ignore
    }
    try {
      await ctx.embeddingService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      await ctx.laneProxyService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      ctx.oauthRedirectService?.dispose?.();
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
      await ctx.apnsService?.dispose?.();
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
      projectLastActivatedAt.delete(normalizedRoot);
      const leaseTimer = mobileSyncHandoffLeaseTimers.get(normalizedRoot);
      if (leaseTimer) {
        clearTimeout(leaseTimer);
        mobileSyncHandoffLeaseTimers.delete(normalizedRoot);
      }
      mobileSyncHandoffLeases.delete(normalizedRoot);
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

  async function mobileProjectSummaryForContext(
    ctx: AppContext,
    recent?: RecentProjectSummary | null,
  ): Promise<SyncMobileProjectSummary> {
    let laneCount = recent?.laneCount ?? 0;
    if (!recent?.laneCount) {
      try {
        laneCount = (await ctx.laneService.list({ includeArchived: false })).length;
      } catch {
        laneCount = 0;
      }
    }
    return {
      id: `root:${normalizeProjectRoot(ctx.project.rootPath)}`,
      displayName: ctx.project.displayName,
      rootPath: ctx.project.rootPath,
      defaultBaseRef: ctx.project.baseRef,
      lastOpenedAt: recent?.lastOpenedAt ?? null,
      laneCount,
      isAvailable: fs.existsSync(ctx.project.rootPath),
      isCached: false,
      isOpen: true,
    };
  }

  function mobileProjectSummaryForRecent(recent: RecentProjectSummary): SyncMobileProjectSummary {
    const normalizedRoot = normalizeProjectRoot(recent.rootPath);
    return {
      id: `root:${normalizedRoot}`,
      displayName: recent.displayName,
      rootPath: recent.rootPath,
      defaultBaseRef: null,
      lastOpenedAt: recent.lastOpenedAt,
      laneCount: recent.laneCount ?? 0,
      isAvailable: recent.exists,
      isCached: false,
      isOpen: false,
    };
  }

  async function listMobileSyncProjects(): Promise<{ projects: SyncMobileProjectSummary[] }> {
    const recentProjects = (readGlobalState(globalStatePath).recentProjects ?? [])
      .map(toRecentProjectSummary);
    const recentByRoot = new Map(
      recentProjects.map((entry) => [normalizeProjectRoot(entry.rootPath), entry] as const),
    );
    const byRoot = new Map<string, SyncMobileProjectSummary>();
    for (const recent of recentProjects) {
      byRoot.set(normalizeProjectRoot(recent.rootPath), mobileProjectSummaryForRecent(recent));
    }
    const contextSummaries = await Promise.all(
      [...projectContexts.entries()].map(async ([root, ctx]) =>
        [root, await mobileProjectSummaryForContext(ctx, recentByRoot.get(root) ?? null)] as const
      ),
    );
    for (const [root, summary] of contextSummaries) {
      byRoot.set(root, summary);
    }
    const projects = [...byRoot.entries()]
      .sort(([leftRoot], [rightRoot]) => {
        if (leftRoot === activeProjectRoot) return -1;
        if (rightRoot === activeProjectRoot) return 1;
        return 0;
      })
      .map(([, project]) => project);
    return { projects };
  }

  async function ensureProjectContextForMobileSync(projectRoot: string): Promise<AppContext> {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const existing = projectContexts.get(normalizedRoot);
    if (existing) return existing;
    if (!fs.existsSync(normalizedRoot)) {
      throw new Error("Project is no longer available on this desktop.");
    }

    let initPromise = projectInitPromises.get(normalizedRoot);
    if (!initPromise) {
      initPromise = (async () => {
        const baseRef = await detectDefaultBaseRef(normalizedRoot);
        const ctx = await initContextForProjectRoot({
          projectRoot: normalizedRoot,
          baseRef,
          ensureExclude: true,
          recordLastProject: false,
          recordRecent: true,
          userSelectedProject: false,
        });
        projectContexts.set(normalizedRoot, ctx);
        return ctx;
      })().finally(() => {
        projectInitPromises.delete(normalizedRoot);
      }) as Promise<AppContext>;
      projectInitPromises.set(normalizedRoot, initPromise);
    }
    return initPromise;
  }

  async function prepareMobileSyncProjectConnection(
    args: SyncProjectSwitchRequestPayload,
  ): Promise<SyncProjectSwitchResultPayload> {
    const catalog = await listMobileSyncProjects();
    const requestedRoot = typeof args.rootPath === "string" && args.rootPath.trim()
      ? normalizeProjectRoot(args.rootPath)
      : null;
    const requestedProjectId = typeof args.projectId === "string" && args.projectId.trim()
      ? args.projectId.trim()
      : null;
    let catalogEntry = catalog.projects.find((entry) => {
      const entryRoot = entry.rootPath ? normalizeProjectRoot(entry.rootPath) : null;
      if (requestedRoot != null && requestedProjectId != null) {
        if (entryRoot !== requestedRoot) return false;
        return entry.id === requestedProjectId || !requestedProjectId.startsWith("root:");
      }
      return (requestedRoot != null && entryRoot === requestedRoot)
        || (requestedProjectId != null && entry.id === requestedProjectId);
    });
    if (!catalogEntry && requestedProjectId) {
      for (const [root, ctx] of projectContexts) {
        if (ctx.projectId === requestedProjectId) {
          catalogEntry = catalog.projects.find((entry) =>
            entry.rootPath != null && normalizeProjectRoot(entry.rootPath) === root
          ) ?? await mobileProjectSummaryForContext(ctx, null);
          break;
        }
      }
    }
    if (!catalogEntry || !catalogEntry.isAvailable) {
      return {
        ok: false,
        message: "That project is not available from this desktop.",
      };
    }
    const targetRoot = catalogEntry.rootPath ? normalizeProjectRoot(catalogEntry.rootPath) : null;
    if (!targetRoot) {
      return {
        ok: false,
        message: "Choose a desktop project first.",
      };
    }

    const existingPreparation = mobileSyncPreparationPromises.get(targetRoot);
    if (existingPreparation) return existingPreparation;

    const preparationPromise = (async (): Promise<SyncProjectSwitchResultPayload> => {
      const hadExistingContext = projectContexts.has(targetRoot);
      let createdLeaseExpiresAt: number | null = null;
      let createdLeaseTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await switchProjectFromDialog(targetRoot);
        const ctx = await ensureProjectContextForMobileSync(targetRoot);
        if (!ctx.syncService) {
          throw new Error("Sync is not available for that project.");
        }
        await ctx.syncService.initialize();
        const recent = (readGlobalState(globalStatePath).recentProjects ?? [])
          .map(toRecentProjectSummary)
          .find((entry) => normalizeProjectRoot(entry.rootPath) === targetRoot) ?? null;
        const project = await mobileProjectSummaryForContext(ctx, recent);
        const leaseExpiresAt = Date.now() + MOBILE_SYNC_HANDOFF_LEASE_MS;
        createdLeaseExpiresAt = leaseExpiresAt;
        mobileSyncHandoffLeases.set(targetRoot, leaseExpiresAt);
        const existingLeaseTimer = mobileSyncHandoffLeaseTimers.get(targetRoot);
        if (existingLeaseTimer) clearTimeout(existingLeaseTimer);
        const leaseTimer = setTimeout(() => {
          mobileSyncHandoffLeaseTimers.delete(targetRoot);
          if (mobileSyncHandoffLeases.get(targetRoot) === leaseExpiresAt) {
            mobileSyncHandoffLeases.delete(targetRoot);
          }
          scheduleProjectContextRebalance();
        }, MOBILE_SYNC_HANDOFF_LEASE_MS + 100);
        leaseTimer.unref?.();
        createdLeaseTimer = leaseTimer;
        mobileSyncHandoffLeaseTimers.set(targetRoot, leaseTimer);
        projectLastActivatedAt.set(targetRoot, Date.now());
        scheduleProjectContextRebalance();
        return {
          ok: true,
          project,
          connection: null,
        };
      } catch (error) {
        const currentLeaseTimer = mobileSyncHandoffLeaseTimers.get(targetRoot);
        if (createdLeaseTimer != null && currentLeaseTimer === createdLeaseTimer) {
          clearTimeout(createdLeaseTimer);
          mobileSyncHandoffLeaseTimers.delete(targetRoot);
        }
        if (createdLeaseExpiresAt != null && mobileSyncHandoffLeases.get(targetRoot) === createdLeaseExpiresAt) {
          mobileSyncHandoffLeases.delete(targetRoot);
        }
        if (!hadExistingContext && projectContexts.has(targetRoot) && !mobileSyncHandoffLeases.has(targetRoot)) {
          await closeProjectContext(targetRoot);
        } else {
          scheduleProjectContextRebalance();
        }
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Unable to prepare phone sync for that project.",
        };
      }
    })();
    mobileSyncPreparationPromises.set(targetRoot, preparationPromise);
    try {
      return await preparationPromise;
    } finally {
      if (mobileSyncPreparationPromises.get(targetRoot) === preparationPromise) {
        mobileSyncPreparationPromises.delete(targetRoot);
      }
    }
  }

  const persistRecentProject = (
    project: ProjectInfo,
    options: { recordLastProject?: boolean; recordRecent?: boolean } = {},
  ): void => {
    const state = upsertRecentProject(
      readGlobalState(globalStatePath),
      project,
      options,
    );
    writeGlobalState(globalStatePath, state);
  };

  const projectOpenLogger = createFileLogger(
    path.join(app.getPath("userData"), "project-open.jsonl"),
  );

  const switchProjectFromDialog = async (
    selectedPath: string,
  ): Promise<ProjectInfo> => {
    const startedAt = Date.now();
    let repoRoot: string | null = null;
    projectOpenLogger.info("project.open.begin", { selectedPath });
    try {
      const resolveStartedAt = Date.now();
      repoRoot = normalizeProjectRoot(await resolveRepoRoot(selectedPath)); // require a real git repo for onboarding.
      projectOpenLogger.info("project.open.repo_resolved", {
        selectedPath,
        repoRoot,
        durationMs: Date.now() - resolveStartedAt,
      });
      const existing = projectContexts.get(repoRoot);
      if (existing) {
        existing.hasUserSelectedProject = true;
        setActiveProject(repoRoot);
        persistRecentProject(existing.project, {
          recordLastProject: true,
          recordRecent: false,
        });
        emitProjectChanged(existing.project);
        scheduleProjectContextRebalance();
        projectOpenLogger.info("project.open.done", {
          selectedPath,
          repoRoot,
          reusedContext: true,
          durationMs: Date.now() - startedAt,
        });
        return existing.project;
      }

      let initPromise = projectInitPromises.get(repoRoot);
      if (!initPromise) {
        initPromise = (async () => {
          const baseRefStartedAt = Date.now();
          const baseRef = await detectDefaultBaseRef(repoRoot!);
          projectOpenLogger.info("project.open.base_ref_detected", {
            selectedPath,
            repoRoot,
            baseRef,
            durationMs: Date.now() - baseRefStartedAt,
          });
          const initStartedAt = Date.now();
          const ctx = await initContextForProjectRoot({
            projectRoot: repoRoot!,
            baseRef,
            ensureExclude: true,
            recordLastProject: true,
            recordRecent: true,
            userSelectedProject: true,
          });
          projectOpenLogger.info("project.open.context_initialized", {
            selectedPath,
            repoRoot,
            durationMs: Date.now() - initStartedAt,
          });
          projectContexts.set(repoRoot!, ctx);
          return ctx;
        })().finally(() => {
          if (repoRoot) {
            projectInitPromises.delete(repoRoot);
          }
        }) as Promise<AppContext>;
        projectInitPromises.set(repoRoot, initPromise);
      }

      const ctx = await initPromise;
      ctx.hasUserSelectedProject = true;
      setActiveProject(repoRoot);
      persistRecentProject(ctx.project, {
        recordLastProject: true,
        recordRecent: false,
      });
      emitProjectChanged(ctx.project);
      scheduleProjectContextRebalance();
      projectOpenLogger.info("project.open.done", {
        selectedPath,
        repoRoot,
        reusedContext: false,
        durationMs: Date.now() - startedAt,
      });
      return ctx.project;
    } catch (error) {
      projectOpenLogger.error("project.open.failed", {
        selectedPath,
        repoRoot,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  };

  const closeProjectByPath = async (projectRoot: string): Promise<void> => {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const wasActive = activeProjectRoot === normalizedRoot;
    await closeProjectContext(normalizedRoot);
    if (wasActive) {
      dormantContext = createDormantProjectContext(normalizedRoot);
      emitProjectChanged(null);
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
    emitProjectChanged(null);
  };

  dormantContext = createDormantProjectContext();

  let shutdownPromise: Promise<void> | null = null;
  let shutdownRequested = false;
  let shutdownFinalized = false;
  let quitWarningAcknowledged = false;
  let shutdownForceTimer: NodeJS.Timeout | null = null;

  const shutdownOpenCodeServersBestEffort = (): void => {
    try {
      const { shutdownOpenCodeServers } = require("./services/opencode/openCodeServerManager");
      shutdownOpenCodeServers();
    } catch {
      // ignore if module not loaded
    }
  };

  const runImmediateProcessCleanup = (reason: string): void => {
    try {
      autoUpdateService?.dispose();
    } catch {
      // ignore
    }

    const contexts = new Set<AppContext>(projectContexts.values());
    contexts.add(getActiveContext());

    for (const ctx of contexts) {
      try {
        ctx.aiOrchestratorService?.dispose?.();
      } catch {
        // ignore
      }
      try {
        ctx.automationService?.dispose?.();
      } catch {
        // ignore
      }
      try {
        ctx.testService?.disposeAll?.();
      } catch {
        // ignore
      }
      try {
        ctx.processService?.disposeAll?.();
      } catch {
        // ignore
      }
      try {
        ctx.ptyService?.disposeAll?.();
      } catch {
        // ignore
      }
      try {
        ctx.agentChatService?.forceDisposeAll?.();
      } catch {
        // ignore
      }
      try {
        ctx.db?.flushNow?.();
      } catch {
        // ignore
      }
      try {
        ctx.logger.info("app.process_cleanup_now", {
          reason,
          projectRoot: ctx.project?.rootPath ?? null,
        });
      } catch {
        // ignore
      }
    }

    shutdownOpenCodeServersBestEffort();
  };

  const finalizeAppExit = (exitCode: number): void => {
    if (shutdownFinalized) return;
    shutdownFinalized = true;
    if (shutdownForceTimer) {
      clearTimeout(shutdownForceTimer);
      shutdownForceTimer = null;
    }
    runImmediateProcessCleanup("process_exit_finalize");
    if (app.isReady()) {
      app.exit(exitCode);
      return;
    }
    process.exit(exitCode);
  };

  const requestAppShutdown = (args: {
    reason: string;
    exitCode?: number;
    fastKillFirst?: boolean;
    forceAfterMs?: number;
  }): void => {
    if (shutdownFinalized || shutdownPromise) return;
    shutdownRequested = true;
    quitWarningAcknowledged = true;

    const exitCode = args.exitCode ?? 0;
    const shutdownLogger = getActiveContext().logger;
    const previousRoot = getActiveContext().project?.rootPath ?? "";

    if (args.fastKillFirst) {
      runImmediateProcessCleanup(`fast_kill:${args.reason}`);
    }

    const forceAfterMs = args.forceAfterMs ?? 8_000;
    shutdownForceTimer = setTimeout(() => {
      shutdownLogger.error("app.shutdown_force_exit", {
        reason: args.reason,
        forceAfterMs,
      });
      runImmediateProcessCleanup(`forced:${args.reason}`);
      finalizeAppExit(exitCode);
    }, forceAfterMs);
    shutdownForceTimer.unref?.();

    shutdownPromise = (async () => {
      shutdownLogger.info("app.shutdown_start", {
        reason: args.reason,
        exitCode,
        fastKillFirst: args.fastKillFirst ?? false,
      });

      try {
        autoUpdateService?.dispose();
      } catch {
        // ignore
      }
      setActiveProject(null);
      dormantContext = createDormantProjectContext(previousRoot);

      try {
        await closeAllProjectContexts();
      } catch (error) {
        shutdownLogger.error("app.shutdown_cleanup_failed", {
          reason: args.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        runImmediateProcessCleanup(`complete:${args.reason}`);
      }
    })().finally(() => {
      finalizeAppExit(exitCode);
    });
  };

  const confirmQuitWarning = (): boolean => {
    if (quitWarningAcknowledged || shutdownRequested) return true;
    const options = {
      type: "warning" as const,
      buttons: ["Keep ADE open", "Quit ADE"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Quit ADE?",
      message: "Save your work before closing ADE.",
      detail:
        "Quitting ADE will end any running agents and stop background processes started by ADE, including OpenCode servers, terminal sessions, and test runs.",
    };
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const response = parentWindow
      ? dialog.showMessageBoxSync(parentWindow, options)
      : dialog.showMessageBoxSync(options);
    if (response !== 1) {
      return false;
    }
    quitWarningAcknowledged = true;
    return true;
  };

  const handleMainWindowCloseRequested = (
    _win: BrowserWindow,
    event: Electron.Event,
  ): void => {
    if (shutdownRequested) return;
    if (BrowserWindow.getAllWindows().length > 1) return;
    event.preventDefault();
    if (!confirmQuitWarning()) return;
    requestAppShutdown({ reason: "window_close", exitCode: 0 });
  };

  const FILE_LIMIT_CODES = new Set(["EMFILE", "ENFILE"]);
  let emfileWarned = false;
  process.on("uncaughtException", (err) => {
    if (FILE_LIMIT_CODES.has((err as NodeJS.ErrnoException).code ?? "")) return;
    const logger = getActiveContext().logger;
    logger.error("process.uncaught_exception", {
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    requestAppShutdown({
      reason: "uncaught_exception",
      exitCode: 1,
      fastKillFirst: true,
      forceAfterMs: 5_000,
    });
  });
  process.on("unhandledRejection", (reason) => {
    const msg = String(reason);
    if (msg.includes("EMFILE") || msg.includes("ENFILE")) {
      if (!emfileWarned) {
        emfileWarned = true;
        getActiveContext().logger.warn("process.emfile_detected", {
          reason: msg,
        });
      }
      return;
    }
    getActiveContext().logger.error("process.unhandled_rejection", {
      reason: msg,
    });
  });
  app.on("child-process-gone", (_event, details) => {
    getActiveContext().logger.warn("app.child_process_gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName ?? null,
      name: details.name ?? null,
    });
  });
  process.once("SIGINT", () => {
    requestAppShutdown({
      reason: "signal_sigint",
      exitCode: 130,
      fastKillFirst: true,
      forceAfterMs: 5_000,
    });
  });
  process.once("SIGTERM", () => {
    requestAppShutdown({
      reason: "signal_sigterm",
      exitCode: 143,
      fastKillFirst: true,
      forceAfterMs: 5_000,
    });
  });
  process.once("exit", () => {
    runImmediateProcessCleanup("process_exit");
  });
  app.on("will-quit", () => {
    runImmediateProcessCleanup("will_quit");
  });

  try {
    const { recoverManagedOpenCodeOrphans } = require("./services/opencode/openCodeServerManager");
    await recoverManagedOpenCodeOrphans({ force: true, logger: getActiveContext().logger });
  } catch (error) {
    getActiveContext().logger.warn("opencode.orphan_recovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  autoUpdateService.onStateChange((snapshot) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC.updateEvent, snapshot);
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
    getSyncService: () => {
      if (!activeProjectRoot) return null;
      return projectContexts.get(activeProjectRoot)?.syncService ?? null;
    },
    switchProjectFromDialog,
    closeCurrentProject,
    closeProjectByPath,
    globalStatePath,
  });

  // Dogfood and other explicit ADE_PROJECT_ROOT launches need the project
  // context ready before the renderer boots, otherwise the window can paint
  // the welcome state and swallow project selection into a confusing no-op.
  if (startupUserSelected) {
    try {
      await switchProjectFromDialog(initialCandidate);
    } catch {
      setActiveProject(null);
      dormantContext = createDormantProjectContext();
    }
  }

  await createWindow({
    logger: getActiveContext().logger,
    onCloseRequested: handleMainWindowCloseRequested,
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow({
        logger: getActiveContext().logger,
        onCloseRequested: handleMainWindowCloseRequested,
      });
    }
  });

  app.on("before-quit", (event) => {
    if (shutdownFinalized) return;
    event.preventDefault();
    if (shutdownRequested) return;
    if (!confirmQuitWarning()) return;
    requestAppShutdown({ reason: "before_quit", exitCode: 0 });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
