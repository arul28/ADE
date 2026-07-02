import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, shell } from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NodePty from "node-pty";
type NodePtyType = typeof NodePty;
import { isAdeRuntimeNamedPipePath } from "../shared/adeRuntimeIpc";
import {
  areAutomationsEnabledForPackagedState,
} from "../shared/automationAvailability";
import {
  handleDeeplinkUrl,
  isAdeDeeplinkArg,
  registerAdeProtocolHandler,
} from "./services/deeplinks/protocolHandler";
import { selectWindowForProjectNavigation } from "./services/deeplinks/projectNavigationWindowSelection";
import { registerIpc } from "./services/ipc/registerIpc";
import { createFileLogger } from "./services/logging/logger";
import { initPerfRunFromEnv } from "./services/perf/perfLog";
import { startMetricsSampler } from "./services/perf/metricsSampler";
import { registerPerfIpcHandlers } from "./services/perf/perfIpc";
import { openKvDb } from "./services/state/kvDb";
import { ensureAdeDirs } from "./services/state/projectState";
import {
  persistableRemoteProjectIconDataUrl,
  readGlobalState,
  type RecentProject,
  upsertRecentProject,
  withPersistableRemoteProjectIcon,
  writeGlobalState,
} from "./services/state/globalState";
import { createLaneService, type LaneDeleteTeardownDeps } from "./services/lanes/laneService";
import { createLaneEnvironmentService } from "./services/lanes/laneEnvironmentService";
import { createLaneTemplateService } from "./services/lanes/laneTemplateService";
import { createLaneWorktreeLockService } from "./services/lanes/laneWorktreeLockService";
import { createPortAllocationService } from "./services/lanes/portAllocationService";
import { createLaneProxyService } from "./services/lanes/laneProxyService";
import { createOAuthRedirectService } from "./services/lanes/oauthRedirectService";
import { createRuntimeDiagnosticsService } from "./services/lanes/runtimeDiagnosticsService";
import { createSessionService } from "./services/sessions/sessionService";
import { createSessionDeltaService } from "./services/sessions/sessionDeltaService";
import { createPtyService } from "./services/pty/ptyService";
import { createSupervisedPtyLoader } from "./services/pty/supervisedPtyHost";
import {
  normalizePtyDataSubscriptions,
  setPtyDataSubscriptionsForSender,
  shouldSendPtyDataToWebContents,
} from "./services/pty/ptyDataSubscriptions";
import {
  createProcessRegistryService,
  DEFAULT_PROCESS_REGISTRY_LIVENESS_WINDOW_MS,
} from "./services/runtime/processRegistryService";
import { createDiffService } from "./services/diffs/diffService";
import { createExternalFilesWorkspaceRegistry, createFileService, type FileServiceLaneAdapter } from "./services/files/fileService";
import { createConflictService } from "./services/conflicts/conflictService";
import { createProjectConfigService } from "./services/config/projectConfigService";
import { createProcessService } from "./services/processes/processService";
import { recoverOrphanedAdeAgentProcesses } from "./services/processes/orphanedAgentProcessReaper";
import { createTestService } from "./services/tests/testService";
import { createOperationService } from "./services/history/operationService";
import { createGitOperationsService } from "./services/git/gitOperationsService";
import { runGit } from "./services/git/git";
import { createJobEngine } from "./services/jobs/jobEngine";
import { createTranscriptionService } from "./services/transcription/transcriptionService";
import { createAiIntegrationService } from "./services/ai/aiIntegrationService";
import { augmentProcessPathWithShellAndKnownCliDirs, setPathEnvValue } from "./services/ai/cliExecutableResolver";
import { createAgentChatService, writeSessionLinearIssueContextFile } from "./services/chat/agentChatService";
import { createGithubService } from "./services/github/githubService";
import { createProjectScaffoldService } from "./services/projects/projectScaffoldService";
import { createFeedbackReporterService } from "./services/feedback/feedbackReporterService";
import { createPrService } from "./services/prs/prService";
import { createPrPollingService } from "./services/prs/prPollingService";
import { createQueueLandingService } from "./services/prs/queueLandingService";
import { createPrSummaryService } from "./services/prs/prSummaryService";
import { openExternalUrl } from "./services/shared/externalLinks";
import {
  detectDefaultBaseRef,
  resolveRepoRoot,
  toProjectInfo,
  upsertProjectRow,
} from "./services/projects/projectService";
import { inspectRecentProject, type RecentProjectInspection } from "./services/projects/recentProjectSummary";
import { browseProjectDirectories } from "./services/projects/projectBrowserService";
import { resolveMobileProjectIconDataUrl } from "./services/projects/projectIconThumbnail";
import { normalizeStartupProjectState, resolveStartupProject } from "./services/projects/startupProjectResolver";
import { createAdeProjectService } from "./services/projects/adeProjectService";
import { createConfigReloadService } from "./services/projects/configReloadService";
import { IPC } from "../shared/ipc";
import { resolveAdeLayout } from "../shared/adeLayout";
import type {
  OpenProjectBinding,
  AppNavigationRequest,
  AppZoomCommand,
  CloneProjectInput,
  CreateProjectInput,
  LaneDeleteProgress,
  LaneLinearIssue,
  ListMyGitHubReposInput,
  PortLease,
  PrEventPayload,
  ProjectBrowseInput,
  ProjectInfo,
  PtyDataEvent,
  SyncMobileProjectSummary,
  SyncProjectForgetRequestPayload,
  SyncProjectForgetResultPayload,
  SyncProjectOpenRequestPayload,
  SyncPeerConnectionState,
  SyncProjectConnectionPayload,
  SyncProjectSwitchRequestPayload,
  SyncProjectSwitchResultPayload,
  UpdateInstallImpact,
} from "../shared/types";
import { buildLinearAutomationDispatches } from "./services/automations/linearAutomationDispatch";
import type { IosSimulatorDrawerMode } from "../shared/types/iosSimulator";
import type { AppContext } from "./services/ipc/registerIpc";
import fs from "node:fs";
import net from "node:net";
import { createAdeRpcRequestHandler } from "../../../ade-cli/src/adeRpcServer";
import {
  createEventBuffer,
  type AdeRuntime,
  type AdeRuntimePaths,
} from "../../../ade-cli/src/bootstrap";
import {
  startJsonRpcServer,
  type JsonRpcServerErrorContext,
  type JsonRpcTransport,
} from "../../../ade-cli/src/jsonrpc";
import { resolveMachineAdeLayout } from "../../../ade-cli/src/services/projects/machineLayout";
import { normalizeProjectRootPath } from "../../../ade-cli/src/services/projects/projectRoots";
import { uninstallRuntimeService } from "../../../ade-cli/src/serviceManager";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
  isElectronSafeStorageCredentialFile,
  type SyncCredentialStore,
} from "../../../ade-cli/src/services/credentials/credentialStore";
import { createKeybindingsService } from "./services/keybindings/keybindingsService";
import { createAgentToolsService } from "./services/agentTools/agentToolsService";
import { createAdeCliService } from "./services/cli/adeCliService";
import { createDevToolsService } from "./services/devTools/devToolsService";
import { createOnboardingService } from "./services/onboarding/onboardingService";
import { createAutomationService } from "./services/automations/automationService";
import { createAutomationPlannerService } from "./services/automations/automationPlannerService";
import { createAutomationSecretService } from "./services/automations/automationSecretService";
import { createProjectSecretService } from "./services/secrets/projectSecretService";
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
import {
  markMachineStateMigrationComplete,
  readMachineRegistryRecentProjects,
  runMachineStateMigration,
} from "./services/runtime/machineStateMigration";
import { createRebaseSuggestionService } from "./services/lanes/rebaseSuggestionService";
import { createAutoRebaseService } from "./services/lanes/autoRebaseService";
import { createCtoStateService } from "./services/cto/ctoStateService";
import { createWorkerAgentService } from "./services/cto/workerAgentService";
import { createWorkerRevisionService } from "./services/cto/workerRevisionService";
import { createWorkerBudgetService } from "./services/cto/workerBudgetService";
import { createWorkerAdapterRuntimeService } from "./services/cto/workerAdapterRuntimeService";
import { createWorkerTaskSessionService } from "./services/cto/workerTaskSessionService";
import { createWorkerHeartbeatService } from "./services/cto/workerHeartbeatService";
import { createLinearCredentialService } from "./services/cto/linearCredentialService";
import { buildRendererCspPolicy, shouldApplyRendererCsp } from "./rendererCsp";
import { createLinearClient } from "./services/cto/linearClient";
import { createLinearIssueTracker, type LinearIssueTracker } from "./services/cto/linearIssueTracker";
import { createLinearLiveStatusService, type LinearLiveStatusService } from "./services/cto/linearLiveStatusService";
import { createLinearTemplateService } from "./services/cto/linearTemplateService";
import { createFlowPolicyService } from "./services/cto/flowPolicyService";
import { createLinearWorkflowFileService } from "./services/cto/linearWorkflowFileService";
import { createLinearRoutingService } from "./services/cto/linearRoutingService";
import { createLinearIntakeService } from "./services/cto/linearIntakeService";
import { createLinearOutboundService } from "./services/cto/linearOutboundService";
import { createLinearCloseoutService } from "./services/cto/linearCloseoutService";
import { createLinearDispatcherService } from "./services/cto/linearDispatcherService";
import { createLinearChatLinkPublisher, publishLinearLaneCard } from "./services/cto/linearLaneCardService";
import { createLinearIngressService } from "./services/cto/linearIngressService";
import { createLinearSyncService } from "./services/cto/linearSyncService";
import { createOrchestrationService } from "./services/orchestration/orchestrationService";
import { createComputerUseArtifactBrokerService } from "./services/computerUse/computerUseArtifactBrokerService";
import { createIosSimulatorService } from "./services/ios/iosSimulatorService";
import { createAppControlService } from "./services/appControl/appControlService";
import { createBuiltInBrowserService } from "./services/builtInBrowser/builtInBrowserService";
import {
  BUILT_IN_BROWSER_PARTITION,
  BUILT_IN_BROWSER_PROFILE_PREFIX,
} from "./services/builtInBrowser/builtInBrowserConstants";
import { startBuiltInBrowserDesktopBridgeServer } from "./services/builtInBrowser/desktopBridgeServer";
import { configureBuiltInBrowserWebAuthn } from "./services/builtInBrowser/builtInBrowserWebAuthn";
import { LocalRuntimeConnectionPool } from "./services/localRuntime/localRuntimeConnectionPool";
import { createSyncService } from "./services/sync/syncService";
import { blockPackagedLaunchForCrossChannelSyncConflict } from "./services/sync/packagedSyncHostLaunchGate";
import { createAutoUpdateService } from "./services/updates/autoUpdateService";
import { cleanupStaleTempArtifacts } from "./services/runtime/tempCleanupService";
import type { Logger } from "./services/logging/logger";
import { resolveDesktopUserDataPath, resolveElectronAppDataPath } from "./desktopUserDataPath";

type RemoteOpenProjectBinding = Extract<OpenProjectBinding, { kind: "remote" }>;

const AUTO_UPDATER_CACHE_DIR_NAME = "ade-desktop-updater";
const ADE_BROWSER_PROJECT_PROFILE_KEY_PATTERN = /^[a-f0-9]{16}$/;

type AdePackageChannel = "alpha" | "beta";

function normalizeAdePackageChannel(value: unknown): AdePackageChannel | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "alpha" || normalized === "beta" ? normalized : null;
}

function readBundledAdePackageChannel(): AdePackageChannel | null {
  const envChannel = normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL);
  if (envChannel) return envChannel;

  try {
    const packageJsonPath = path.join(app.getAppPath(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      adePackageChannel?: unknown;
      productName?: unknown;
    };
    const packageChannel = normalizeAdePackageChannel(packageJson.adePackageChannel);
    if (packageChannel) return packageChannel;
    const productName = typeof packageJson.productName === "string" ? packageJson.productName : "";
    if (/\balpha\b/i.test(productName)) return "alpha";
    if (/\bbeta\b/i.test(productName)) return "beta";
  } catch {
    // Dev builds and older packaged apps do not need channel metadata.
  }

  const appName = app.getName();
  if (/\balpha\b/i.test(appName)) return "alpha";
  if (/\bbeta\b/i.test(appName)) return "beta";
  return null;
}

function applyPackagedChannelDefaults(): void {
  const channel = readBundledAdePackageChannel();
  if (!channel) return;

  process.env.ADE_PACKAGE_CHANNEL = process.env.ADE_PACKAGE_CHANNEL || channel;
  process.env.ADE_DESKTOP_APP_NAME = process.env.ADE_DESKTOP_APP_NAME || (channel === "alpha" ? "ADE Alpha" : "ADE Beta");
  process.env.ADE_HOME = process.env.ADE_HOME || path.join(os.homedir(), `.ade-${channel}`);
}

applyPackagedChannelDefaults();

function configureDesktopUserDataPath(): void {
  const appDataPath = (() => {
    try {
      return app.getPath("appData");
    } catch {
      return resolveElectronAppDataPath({
        platform: process.platform,
        env: process.env,
        homeDir: os.homedir(),
      });
    }
  })();
  const userDataPath = resolveDesktopUserDataPath({
    appDataPath,
    channel: normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL),
    isPackaged: app.isPackaged,
    env: process.env,
  });
  if (userDataPath) {
    app.setPath("userData", userDataPath);
  }
}

configureDesktopUserDataPath();

function resolveAutoUpdaterCacheDir(): string {
  const homeDir = os.homedir();
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"),
      AUTO_UPDATER_CACHE_DIR_NAME,
    );
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Caches", AUTO_UPDATER_CACHE_DIR_NAME);
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(homeDir, ".cache"),
    AUTO_UPDATER_CACHE_DIR_NAME,
  );
}

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

function installAdeCliForTerminalInBackground(
  adeCliService: ReturnType<typeof createAdeCliService>,
  logger: Logger,
): void {
  if (process.env.ADE_DISABLE_CLI_AUTO_INSTALL === "1") return;
  void adeCliService.installForUser()
    .then((result) => {
      logger.info("ade_cli.auto_install", {
        ok: result.ok,
        command: result.status.command,
        installTargetPath: result.status.installTargetPath,
        message: result.message,
      });
    })
    .catch((error) => {
      logger.warn("ade_cli.auto_install_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

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
  "ADE_ENABLE_HEAD_WATCHER",
  "ADE_ENABLE_PORT_ALLOCATION_RECOVERY",
  "ADE_ENABLE_SYNC_INIT",
]);

function readString(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
  // Unpackaged launches without VITE_DEV_SERVER_URL (e.g. raw `electron .`) should
  // prefer the local Vite dev server instead of file:// chunks that tsup watch can delete.
  if (!app.isPackaged) {
    return "http://localhost:5173";
  }
  return pathToFileURL(path.join(__dirname, "../renderer/index.html")).toString();
}

function createDesktopCredentialStore(secretsDir: string): SyncCredentialStore {
  const legacyStore = new EncryptedFileCredentialStore({ secretsDir });
  const safeCredentialsPath = path.join(secretsDir, "credentials.safe.enc");
  const legacyCredentialsPath = path.join(secretsDir, "credentials.json.enc");
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return new ElectronSafeStorageCredentialStore({
        secretsDir,
        safeStorage,
        legacyStore,
      });
    }
  } catch {
    // Fall through to the file store when Electron cannot reach the OS keychain.
  }
  if (
    isElectronSafeStorageCredentialFile(safeCredentialsPath)
    || isElectronSafeStorageCredentialFile(legacyCredentialsPath)
  ) {
    const message = "Electron safeStorage is unavailable; unlock the OS credential store to read ADE credentials.";
    return {
      get: async () => {
        throw new Error(message);
      },
      set: async () => {
        throw new Error(message);
      },
      delete: async () => {
        throw new Error(message);
      },
      getSync: () => {
        throw new Error(message);
      },
      setSync: () => {
        throw new Error(message);
      },
      deleteSync: () => {
        throw new Error(message);
      },
    };
  }
  return legacyStore;
}

// Voice-to-text transcription is a project-independent capability (it only needs
// the bundled whisper binary + model + shared glossary), so it lives as a single
// shared instance threaded into every project/dormant context. Constructed lazily
// on first context build.
let sharedTranscriptionService: ReturnType<typeof createTranscriptionService> | null = null;
function getSharedTranscriptionService(logger: Logger): ReturnType<typeof createTranscriptionService> {
  if (!sharedTranscriptionService) {
    sharedTranscriptionService = createTranscriptionService({
      logger,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      // The ~141 MB model is downloaded at runtime (not bundled) into userData
      // so it never bloats the auto-update zip. See whisperModelStore.
      modelDir: path.join(app.getPath("userData"), "whisper"),
    });
  }
  return sharedTranscriptionService;
}

function isAllowedAdeBrowserWebviewSource(rawSrc: string): boolean {
  const src = rawSrc.trim();
  if (!src || src === "about:blank") return true;
  return isAllowedAdeBrowserWebviewNavigation(src);
}

// Stricter check used for post-attach navigation: rejects empty/about:blank/file:/data:/blob:
// so a compromised renderer can't attach a blank webview and then loadURL anywhere.
function isAllowedAdeBrowserWebviewNavigation(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeAdeBrowserWebviewPartition(value: unknown): string {
  if (typeof value !== "string") return BUILT_IN_BROWSER_PARTITION;
  const partition = value.trim();
  if (
    partition === BUILT_IN_BROWSER_PARTITION
    || (
      partition.startsWith(BUILT_IN_BROWSER_PROFILE_PREFIX)
      && ADE_BROWSER_PROJECT_PROFILE_KEY_PATTERN.test(partition.slice(BUILT_IN_BROWSER_PROFILE_PREFIX.length))
    )
  ) {
    return partition;
  }
  return BUILT_IN_BROWSER_PARTITION;
}

async function createWindow(args: {
  logger?: Logger;
  onCreated?: (win: BrowserWindow) => void;
  onCloseRequested?: (win: BrowserWindow, event: Electron.Event) => void;
} = {}): Promise<BrowserWindow> {
  // Load the app icon from the build directory. In dev (`npm run dev` sets
  // VITE_DEV_SERVER_URL) prefer the inverted icon so the dock/window icon makes
  // it obvious at a glance that this is a dev build, not the installed app.
  const iconDir = path.join(__dirname, "../../build");
  const icoPath = path.join(iconDir, "icon.ico");
  const pngPath = path.join(iconDir, "icon.png");
  const devPngPath = path.join(iconDir, "icon.dev.png");
  const icnsPath = path.join(iconDir, "icon.icns");
  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  let icon: Electron.NativeImage;
  if (isDev && fs.existsSync(devPngPath)) {
    icon = nativeImage.createFromPath(devPngPath);
  } else if (process.platform === "win32" && fs.existsSync(icoPath)) {
    icon = nativeImage.createFromPath(icoPath);
  } else if (fs.existsSync(pngPath)) {
    icon = nativeImage.createFromPath(pngPath);
  } else if (fs.existsSync(icnsPath)) {
    icon = nativeImage.createFromPath(icnsPath);
  } else {
    icon = nativeImage.createEmpty();
  }

  const defaultWindowBounds = isDev
    ? { width: 1460, height: 880 }
    : { width: 1280, height: 820 };

  const win = new BrowserWindow({
    ...defaultWindowBounds,
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
      webviewTag: true,
    },
  });

  args.onCreated?.(win);

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const src = typeof params.src === "string" ? params.src : "";
    if (!isAllowedAdeBrowserWebviewSource(src)) {
      event.preventDefault();
      args.logger?.warn("window.webview_blocked", { src });
      return;
    }
    delete webPreferences.preload;
    delete (webPreferences as Record<string, unknown>).preloadURL;
    webPreferences.partition = normalizeAdeBrowserWebviewPartition(webPreferences.partition);
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
  });

  // Enforce the same allowlist on post-attach navigation. about:blank/empty src is
  // allowed at attach time (the built-in browser legitimately creates blank tabs),
  // but a compromised renderer must not be able to loadURL to a non-allowlisted URL
  // afterward. The setWindowOpenHandler('deny') below also blocks new windows from
  // the attached webview.
  win.webContents.on("did-attach-webview", (_event, attachedWc) => {
    attachedWc.setWindowOpenHandler(() => ({ action: "deny" }));
    attachedWc.on("will-navigate", (navEvent, url) => {
      // Allow same-page navigations to about:blank only as the initial state; any
      // explicit navigation must go through the http/https allowlist.
      if (!isAllowedAdeBrowserWebviewNavigation(url)) {
        navEvent.preventDefault();
        args.logger?.warn("window.webview_navigation_blocked", { url });
      }
    });
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
  const cspPolicy = buildRendererCspPolicy(isDevMode);

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (
      !shouldApplyRendererCsp(details, {
        isDevMode,
        devServerUrl: process.env.VITE_DEV_SERVER_URL,
      })
    ) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

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

// Only Stable claims `ade://` as the default handler. Beta and Alpha still
// install the single-instance lock + `open-url` listeners (so a manual
// `duti` binding still works), but they don't ask the OS to make them the
// default on boot. Source builds and dev Electron launches never claim the OS
// binding; they only listen for URLs explicitly delivered to that process.
const deeplinkChannel = normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL);
const deeplinkClaimAsDefault = app.isPackaged && deeplinkChannel === null;

const pendingAppNavigationRequests: AppNavigationRequest[] = [];
let dispatchAppNavigationRequest: ((request: AppNavigationRequest) => void) | null = null;
let dispatchAppNavigationForProjectRoot:
  | ((targetProjectRoot: string, request: AppNavigationRequest) => void)
  | null = null;

const dispatchOrQueueAppNavigationRequest = (request: AppNavigationRequest): void => {
  if (!dispatchAppNavigationRequest) {
    pendingAppNavigationRequests.push(request);
    return;
  }
  dispatchAppNavigationRequest(request);
};

// Register the user-facing `ade://` deeplink scheme + single-instance lock so a
// second `open ade://...` invocation reuses the running window. Dispatch to the
// focused window's renderer via the existing IPC.appNavigate channel.
registerAdeProtocolHandler({
  claimAsDefault: deeplinkClaimAsDefault,
  dispatch: dispatchOrQueueAppNavigationRequest,
  log: (event, fields) => {
    // Avoid throwing if console is gone; structured logger may not be ready yet.
    try {
      console.log(`[main] ${event}`, fields);
    } catch {
      // ignore
    }
  },
});

let pendingProjectOpenFiles: string[] = [];
let handleProjectOpenFile: ((filePath: string) => void) | null = null;

const normalizeExistingAbsoluteOpenFileArg = (arg: unknown): string | null => {
  if (typeof arg !== "string") return null;
  const value = arg.trim();
  if (!value || value.startsWith("-") || isAdeDeeplinkArg(value) || !path.isAbsolute(value)) return null;
  let normalized: string;
  try {
    normalized = path.normalize(value);
  } catch {
    return null;
  }
  const appPath = path.normalize(app.getAppPath());
  const resourcesPath = typeof process.resourcesPath === "string" ? path.normalize(process.resourcesPath) : null;
  if (
    normalized === path.normalize(process.execPath) ||
    normalized === appPath ||
    (resourcesPath != null && (normalized === resourcesPath || normalized.startsWith(`${resourcesPath}${path.sep}`)))
  ) {
    return null;
  }
  try {
    const stat = fs.statSync(normalized);
    return stat.isFile() || stat.isDirectory() ? normalized : null;
  } catch {
    return null;
  }
};

const enqueueProjectOpenFile = (filePath: string): void => {
  if (handleProjectOpenFile) {
    handleProjectOpenFile(filePath);
    return;
  }
  pendingProjectOpenFiles.push(filePath);
};

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!filePath) return;
  enqueueProjectOpenFile(filePath);
});

app.on("second-instance", (_event, argv) => {
  if (process.platform === "darwin") return;
  for (const arg of argv.slice(1)) {
    const filePath = normalizeExistingAbsoluteOpenFileArg(arg);
    if (filePath) enqueueProjectOpenFile(filePath);
  }
});

if (process.platform !== "darwin") {
  for (const arg of process.argv.slice(1)) {
    const filePath = normalizeExistingAbsoluteOpenFileArg(arg);
    if (filePath) pendingProjectOpenFiles.push(filePath);
  }
}

app.whenReady().then(async () => {
  // Perf run init — must come first so subsequent IPC + sampler hooks can see the active run.
  const perfRun = initPerfRunFromEnv();
  if (perfRun) {
    startMetricsSampler();
  }

  if (blockPackagedLaunchForCrossChannelSyncConflict({
    isPackaged: app.isPackaged,
    channel: normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL),
  })) {
    return;
  }

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
  const normalizeProjectPath = (value: string) => normalizeProjectRootPath(value);
  const isLikelyRepoRoot = (value: string) => {
    const resolved = normalizeProjectPath(value);
    return (
      resolved.length > 0 &&
      resolved !== fallbackProjectRoot &&
      fs.existsSync(resolved) &&
      fs.existsSync(path.join(resolved, ".git"))
    );
  };
  const parseSavedRemoteProjectBinding = (
    value: unknown,
  ): RemoteOpenProjectBinding | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const targetId = readString(record, "targetId");
    const projectId = readString(record, "projectId");
    const rootPath = readString(record, "rootPath");
    const hostname = readString(record, "hostname");
    if (record.kind !== "remote" || !targetId || !projectId || !rootPath) {
      return null;
    }
    return {
      kind: "remote",
      key: readString(record, "key") ?? `remote:${targetId}:${projectId}`,
      targetId,
      runtimeName: readString(record, "runtimeName") ?? "Remote",
      ...(hostname ? { hostname } : {}),
      projectId,
      rootPath,
      displayName: readString(record, "displayName") ?? path.basename(rootPath),
      // Restore the cached project logo so the tab shows it immediately on a
      // cold start, before the remote reconnects and refreshes the icon.
      iconDataUrl: remoteProjectIconDataUrlForPersistence(
        readString(record, "iconDataUrl"),
      ),
    };
  };
  const remoteProjectIconDataUrlForPersistence = (
    value: string | null | undefined,
  ): string | null => {
    const direct = persistableRemoteProjectIconDataUrl(value);
    if (direct || !value) return direct;
    try {
      const image = nativeImage.createFromDataURL(value);
      if (image.isEmpty()) return null;
      return persistableRemoteProjectIconDataUrl(
        image.resize({ width: 64, height: 64, quality: "best" }).toDataURL(),
      );
    } catch {
      return null;
    }
  };
  const savedRemoteProjectBinding = parseSavedRemoteProjectBinding(
    saved.lastRemoteProjectBinding,
  );
  const readLastRemoteProjectBinding = (): RemoteOpenProjectBinding | null =>
    parseSavedRemoteProjectBinding(
      readGlobalState(globalStatePath).lastRemoteProjectBinding,
    );
  const readLocalRecentProjects = (): RecentProject[] =>
    (readGlobalState(globalStatePath).recentProjects ?? [])
      .filter((entry) => !entry.remote);

  const machineAdeLayout = resolveMachineAdeLayout();
  const startupState = normalizeStartupProjectState({
    saved,
    additionalRecentProjects: readMachineRegistryRecentProjects(machineAdeLayout),
    isLikelyRepoRoot,
    normalizeProjectPath,
  });
  const cleanedRecentProjects = startupState.recentProjects;

  if (startupState.changed) {
    writeGlobalState(globalStatePath, startupState.state);
  }

  const machineStateMigration = runMachineStateMigration({
    layout: machineAdeLayout,
    recentProjects: cleanedRecentProjects,
  });
  const shouldAttemptRuntimeServiceInstall =
    app.isPackaged
    && process.env.NODE_ENV !== "test"
    && process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL !== "1";
  const shouldShowRuntimeMigrationNotice =
    shouldAttemptRuntimeServiceInstall && machineStateMigration.shouldShowNotice;
  const packagedChannel = normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL);

  const envRoot = process.env.ADE_PROJECT_ROOT;
  const pendingStartupProjectRoot =
    pendingProjectOpenFiles
      .map((filePath) => normalizeProjectPath(filePath))
      .find((filePath) => isLikelyRepoRoot(filePath)) ?? null;
  if (pendingStartupProjectRoot) {
    pendingProjectOpenFiles = pendingProjectOpenFiles.filter(
      (filePath) => normalizeProjectPath(filePath) !== pendingStartupProjectRoot,
    );
  }
  const startupProject = resolveStartupProject({
    envRoot,
    pendingStartupProjectRoot,
    normalizeProjectPath,
  });
  const shouldOpenStartupProject = startupProject.rootPath != null;

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        // ignore
      }
    }
  };

  ipcMain.handle(IPC.ptyDataSubscriptions, (event, arg: { ptyIds?: unknown } | undefined) => {
    setPtyDataSubscriptionsForSender(
      event.sender,
      normalizePtyDataSubscriptions(arg?.ptyIds),
    );
  });

  const broadcastPtyData = (payload: PtyDataEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!shouldSendPtyDataToWebContents(win.webContents, payload.ptyId)) continue;
      try {
        win.webContents.send(IPC.ptyData, payload);
      } catch {
        // ignore stale window sends
      }
    }
  };

  const builtInBrowserService = createBuiltInBrowserService({
    getLogger: () => getActiveContext().logger,
    getProjectRootForWindow: (win) => getWindowSession(win.id).binding?.rootPath ?? null,
    getWindowForProjectRoot: (projectRoot) => {
      const normalizedRoot = normalizeProjectRoot(projectRoot);
      const candidateWindows = BrowserWindow.getAllWindows().filter(
        (win) => !win.isDestroyed(),
      );
      const selection = selectWindowForProjectNavigation(
        normalizedRoot,
        candidateWindows.map((win) => ({
          id: win.id,
          activeProjectRoot: windowProjectRoots.get(win.id) ?? null,
          openProjectRoots: windowProjectTabRoots.get(win.id) ?? new Set<string>(),
        })),
      );
      if (!selection) return null;
      const targetWindow = candidateWindows.find((win) => win.id === selection.windowId) ?? null;
      return targetWindow;
    },
    onEvent: (payload, targetWindow) => {
      if (targetWindow && !targetWindow.isDestroyed()) {
        try {
          targetWindow.webContents.send(IPC.builtInBrowserEvent, payload);
        } catch {
          // ignore stale window sends
        }
        return;
      }
      broadcast(IPC.builtInBrowserEvent, payload);
    },
  });

  // Side-channel JSON-RPC server that lets the runtime daemon proxy
  // `ade browser …` CLI calls into this Electron main process.
  // The daemon runs under ELECTRON_RUN_AS_NODE and can't host the browser
  // service itself (it needs WebContentsView). The bridge socket lives under
  // `<adeHome>/sock/desktop-bridge.sock`; the daemon discovers it via
  // resolveMachineAdeLayout() or ADE_DESKTOP_BRIDGE_SOCKET_PATH.
  const builtInBrowserBridgeLogger = createFileLogger(
    path.join(app.getPath("userData"), "desktop-bridge.jsonl"),
  );
  const builtInBrowserBridgeSocketPath =
    process.env.ADE_DESKTOP_BRIDGE_SOCKET_PATH?.trim()
    || machineAdeLayout.desktopBridgeSocketPath;
  let builtInBrowserBridgeServer: ReturnType<typeof startBuiltInBrowserDesktopBridgeServer> | null = null;
  try {
    builtInBrowserBridgeServer = startBuiltInBrowserDesktopBridgeServer({
      socketPath: builtInBrowserBridgeSocketPath,
      service: builtInBrowserService,
      logger: builtInBrowserBridgeLogger,
    });
  } catch (error) {
    builtInBrowserBridgeLogger.warn("built_in_browser_bridge.start_failed", {
      socketPath: builtInBrowserBridgeSocketPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const normalizeProjectRoot = (projectRoot: string) =>
    path.resolve(projectRoot);
  const projectContexts = new Map<string, AppContext>();
  const projectInitPromises = new Map<string, Promise<AppContext>>();
  const closeContextPromises = new Map<string, Promise<void>>();
  const windowProjectRoots = new Map<number, string | null>();
  const windowProjectTabRoots = new Map<number, Set<string>>();
  const windowPendingProjectRoots = new Map<number, Map<string, number>>();
  const windowProjectBindings = new Map<number, RemoteOpenProjectBinding>();
  const ipcWindowScope = new AsyncLocalStorage<number | null>();
  const rpcSocketCleanupByRoot = new Map<string, () => void>();
  const projectLastActivatedAt = new Map<string, number>();
  const mobileSyncHandoffLeases = new Map<string, number>();
  const mobileSyncHandoffLeaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const mobileSyncPreparationPromises = new Map<string, Promise<SyncProjectSwitchResultPayload>>();
  const localRuntimeLogger = createFileLogger(path.join(app.getPath("userData"), "local-runtime.jsonl"));
  const shouldRepairRuntimeServiceOnFallback =
    app.isPackaged
    && process.env.NODE_ENV !== "test"
    && process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL !== "1";
  const localRuntimePool = new LocalRuntimeConnectionPool(app.getVersion(), localRuntimeLogger, {
    preferServiceRepair: shouldRepairRuntimeServiceOnFallback,
    onRuntimeModeChange: (mode) => {
      localRuntimeLogger.warn("local_runtime.runtime_mode_changed", { mode });
      if (!Notification.isSupported()) return;
      try {
        const notification = mode === "isolated"
          ? new Notification({
              title: "ADE is running in fallback mode",
              body: "The ADE background service did not restart cleanly. Phone sync and ADE Code connections are unavailable while ADE keeps retrying in the background.",
            })
          : new Notification({
              title: "ADE service restored",
              body: "Phone sync and ADE Code connections are available again.",
            });
        notification.show();
      } catch (error) {
        localRuntimeLogger.warn("local_runtime.runtime_mode_notification_failed", {
          mode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  if (shouldAttemptRuntimeServiceInstall) {
    void localRuntimePool.installServiceBestEffort()
      .then(() => {
        const status = localRuntimePool.getStatus().serviceInstall;
        if (status.state === "installed") {
          markMachineStateMigrationComplete({ layout: machineAdeLayout });
        }
      })
      .catch((error) => {
        localRuntimeLogger.warn("local_runtime.service_install_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } else if (process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL === "1") {
    localRuntimePool.noteServiceInstallSkipped("Background service installation is disabled by ADE_DISABLE_RUNTIME_SERVICE_INSTALL.");
    if (machineStateMigration.didRun && app.isPackaged && packagedChannel) {
      markMachineStateMigrationComplete({ layout: machineAdeLayout });
    }
  } else if (!app.isPackaged) {
    localRuntimePool.noteServiceInstallSkipped("Background service installation is skipped in dev builds.");
  } else if (process.env.NODE_ENV === "test") {
    localRuntimePool.noteServiceInstallSkipped("Background service installation is skipped in tests.");
  }
  // Soft cap for project contexts that have NO user work at all (no chats,
  // no live PTYs, no active sessions/tests). Anything with work is
  // protected by `hasActiveProjectWorkloads` and is never evicted regardless
  // of this number. The cap exists only as a safety valve against opening
  // hundreds of empty projects in a long-running session — well above any
  // realistic working set, so users effectively never hit it.
  const MAX_WARM_IDLE_PROJECT_CONTEXTS = 100;
  const MOBILE_SYNC_HANDOFF_LEASE_MS = 60_000;
  let activeProjectRoot: string | null = null;
  let mobileSyncSelectedRoot: string | null = null;
  let dormantContext!: AppContext;
  let projectContextRebalancePromise: Promise<void> = Promise.resolve();
  const closeWindowWithoutQuitPrompt = new Set<number>();

  const currentIpcWindowId = (): number | null =>
    ipcWindowScope.getStore() ?? null;

  const shouldUseInProcessProjectRuntime = (): boolean =>
    process.env.NODE_ENV === "test";

  const projectForRoot = (projectRoot: string | null): ProjectInfo | null => {
    if (!projectRoot) return null;
    return projectContexts.get(projectRoot)?.project ?? null;
  };

  const projectWindowTitle = (project: ProjectInfo | null, binding?: OpenProjectBinding | null): string => {
    const label =
      binding?.displayName
      ?? project?.displayName
      ?? (project?.rootPath ? path.basename(project.rootPath) : null);
    return label ? `${label} - ADE` : "ADE";
  };

  const setWindowTitle = (win: BrowserWindow, title: string): void => {
    try {
      win.setTitle(title);
    } catch {
      // ignore stale window/title races
    }
  };

  const projectsForWindowTabs = (windowId: number | null): ProjectInfo[] => {
    if (windowId == null) return [];
    const roots = windowProjectTabRoots.get(windowId) ?? new Set<string>();
    const projects: ProjectInfo[] = [];
    for (const root of roots) {
      const project = projectForRoot(root);
      if (project) projects.push(project);
    }
    return projects;
  };

  const pendingProjectRootsForWindow = (windowId: number | null): string[] => {
    if (windowId == null) return [];
    return Array.from(windowPendingProjectRoots.get(windowId)?.keys() ?? []);
  };

  const authorizePendingWindowProjectRoot = (
    windowId: number | null,
    rootPath: string | null | undefined,
  ): (() => void) => {
    if (windowId == null) return () => {};
    const trimmed = typeof rootPath === "string" ? rootPath.trim() : "";
    if (!trimmed) return () => {};
    const normalizedRoot = normalizeProjectRoot(trimmed);
    const roots = windowPendingProjectRoots.get(windowId) ?? new Map<string, number>();
    roots.set(normalizedRoot, (roots.get(normalizedRoot) ?? 0) + 1);
    windowPendingProjectRoots.set(windowId, roots);
    return () => {
      const current = windowPendingProjectRoots.get(windowId);
      if (!current) return;
      const count = current.get(normalizedRoot) ?? 0;
      if (count > 1) {
        current.set(normalizedRoot, count - 1);
      } else {
        current.delete(normalizedRoot);
      }
      if (current.size === 0) windowPendingProjectRoots.delete(windowId);
    };
  };

  const rememberWindowProjectTabs = (
    windowId: number | null,
    rootPaths: string[],
  ): ProjectInfo[] => {
    if (windowId == null) return [];
    const roots = new Set<string>();
    for (const rootPath of rootPaths) {
      const normalized = rootPath.trim() ? normalizeProjectRoot(rootPath) : "";
      if (normalized) roots.add(normalized);
    }
    const activeRoot = windowProjectRoots.get(windowId) ?? null;
    if (activeRoot) roots.add(activeRoot);
    windowProjectTabRoots.set(windowId, roots);
    scheduleProjectContextRebalance();
    return projectsForWindowTabs(windowId);
  };

  const bindingForLocalProject = (project: ProjectInfo | null): OpenProjectBinding | null =>
    project && !shouldUseInProcessProjectRuntime()
      ? {
        kind: "local",
        key: `local:${project.rootPath}`,
        rootPath: project.rootPath,
        displayName: project.displayName,
      }
      : null;

  const rootsBoundToWindows = (): Set<string> => {
    const roots = new Set<string>();
    for (const root of windowProjectRoots.values()) {
      if (root) roots.add(root);
    }
    for (const tabRoots of windowProjectTabRoots.values()) {
      for (const root of tabRoots) roots.add(root);
    }
    return roots;
  };

  const emitProjectChangedToWindow = (
    windowId: number | null,
    project: ProjectInfo | null,
  ): void => {
    const win = windowId == null ? null : BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) return;
    setWindowTitle(win, projectWindowTitle(project, bindingForLocalProject(project)));
    try {
      win.webContents.send(IPC.appProjectChanged, project);
    } catch {
      // ignore
    }
  };

  const emitProjectBindingChangedToWindow = (
    windowId: number | null,
    binding: OpenProjectBinding | null,
  ): void => {
    const win = windowId == null ? null : BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) return;
    if (binding?.kind === "remote") {
      setWindowTitle(win, projectWindowTitle(null, binding));
    }
    try {
      win.webContents.send(IPC.appProjectBindingChanged, binding);
    } catch {
      // ignore
    }
  };

  const firstAvailableRecentProjectRoot = (): string | null => {
    const recentProjects = readLocalRecentProjects();
    for (const project of recentProjects) {
      if (typeof project.rootPath !== "string") continue;
      const rootPath = normalizeProjectRoot(project.rootPath);
      if (rootPath && isLikelyRepoRoot(rootPath)) return rootPath;
    }
    return null;
  };

  const isDesktopSyncHostEnabled = (): boolean =>
    process.env.ADE_ENABLE_DESKTOP_SYNC_HOST === "1"
    && process.env.ADE_DISABLE_SYNC_HOST !== "1";

  const getMobileSyncHostRoot = (): string | null =>
    isDesktopSyncHostEnabled()
      ? mobileSyncSelectedRoot
        ?? activeProjectRoot
        ?? firstAvailableRecentProjectRoot()
      : null;

  const getMobileSyncService = (): ReturnType<typeof createSyncService> | null => {
    const hostRoot = getMobileSyncHostRoot();
    return hostRoot ? projectContexts.get(hostRoot)?.syncService ?? null : null;
  };

  const notifyMobileSyncProjectCatalogChanged = (): void => {
    const hostService = getMobileSyncService()?.getHostService();
    if (!hostService) return;
    void hostService.broadcastProjectCatalog().catch((error) => {
      const logger =
        (activeProjectRoot ? projectContexts.get(activeProjectRoot)?.logger : null)
        ?? (dormantContext as AppContext | undefined)?.logger;
      logger?.warn("sync.mobile_project_catalog_broadcast_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  let reconcileSyncHostContextsChain: Promise<void> = Promise.resolve();
  const reconcileSyncHostContexts = (): Promise<void> => {
    const next = reconcileSyncHostContextsChain.then(async () => {
      const hostRoot = getMobileSyncHostRoot();
      for (const [root, ctx] of projectContexts) {
        const isSyncHost = hostRoot != null && root === hostRoot;
        ctx.syncService?.setHostDiscoveryEnabled?.(isSyncHost);
      }
      for (const [root, ctx] of projectContexts) {
        const isSyncHost = hostRoot != null && root === hostRoot;
        await ctx.syncService?.setHostStartupEnabled?.(isSyncHost);
      }
    });
    reconcileSyncHostContextsChain = next.catch(() => {});
    return next;
  };

  const setForegroundProject = (projectRoot: string | null): void => {
    activeProjectRoot = projectRoot ? normalizeProjectRoot(projectRoot) : null;
    void reconcileSyncHostContexts().then(() => {
      notifyMobileSyncProjectCatalogChanged();
    });
    if (activeProjectRoot) {
      projectLastActivatedAt.set(activeProjectRoot, Date.now());
      const activeCtx = projectContexts.get(activeProjectRoot);
      if (activeCtx) {
        persistRecentProject(activeCtx.project, { recordLastProject: false, preserveRecentOrder: true });
      }
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

  const bindWindowToProject = (
    windowId: number | null,
    projectRoot: string | null,
    options: { emit?: boolean; foreground?: boolean } = {},
  ): void => {
    const normalizedRoot = projectRoot ? normalizeProjectRoot(projectRoot) : null;
    const previousRemoteBinding =
      windowId != null ? (windowProjectBindings.get(windowId) ?? null) : null;
    if (windowId != null) {
      windowProjectRoots.set(windowId, normalizedRoot);
      windowProjectBindings.delete(windowId);
      if (normalizedRoot) {
        const tabRoots = windowProjectTabRoots.get(windowId) ?? new Set<string>();
        tabRoots.add(normalizedRoot);
        windowProjectTabRoots.set(windowId, tabRoots);
      }
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed()) {
        builtInBrowserService.attachToWindow(win);
      }
    }
    if (options.foreground ?? true) {
      setForegroundProject(normalizedRoot);
    }
    if (normalizedRoot) {
      projectLastActivatedAt.set(normalizedRoot, Date.now());
      const ctx = projectContexts.get(normalizedRoot);
      if (ctx) {
        persistRecentProject(ctx.project, { recordLastProject: false, preserveRecentOrder: true });
      }
      if (!shouldUseInProcessProjectRuntime()) {
        // Desktop foregrounding is independent from phone sync project selection:
        // registering the project lets desktop/TUI route RPC by projectId without
        // stealing the singleton mobile sync host from a connected phone.
        const projectRegistration = localRuntimePool.ensureProject(normalizedRoot);
        void projectRegistration.catch((error) => {
          localRuntimeLogger.warn("local_runtime.project_registration_failed", {
            rootPath: normalizedRoot,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    if (previousRemoteBinding) {
      const remainingRemoteBinding =
        Array.from(windowProjectBindings.values()).at(-1) ?? null;
      if (remainingRemoteBinding) {
        persistLastRemoteProjectBinding(remainingRemoteBinding);
      } else {
        clearLastRemoteProjectBinding();
      }
    }
    if (options.emit !== false) {
      const project = projectForRoot(normalizedRoot);
      emitProjectChangedToWindow(windowId, project);
      emitProjectBindingChangedToWindow(windowId, bindingForLocalProject(project));
    }
  };

  const persistLastRemoteProjectBinding = (
    binding: RemoteOpenProjectBinding,
  ): void => {
    const state = readGlobalState(globalStatePath);
    const iconDataUrl = remoteProjectIconDataUrlForPersistence(binding.iconDataUrl);
    const persistedBinding = withPersistableRemoteProjectIcon({
      ...binding,
      iconDataUrl,
    });
    // Record the remote project in recents so it appears in the unified recents
    // list on the welcome screen (alongside local projects) — no need to re-add
    // it from the remote panel next time.
    const withRecent = upsertRecentProject(
      state,
      {
        rootPath: binding.rootPath,
        displayName: binding.displayName,
        remote: {
          targetId: binding.targetId,
          projectId: binding.projectId,
          runtimeName: binding.runtimeName,
          hostname: binding.hostname || binding.runtimeName,
          ...(iconDataUrl ? { iconDataUrl } : {}),
        },
      },
      { recordLastProject: false, recordRecent: true },
    );
    const next = {
      ...withRecent,
      lastRemoteProjectBinding: {
        ...persistedBinding,
        updatedAt: new Date().toISOString(),
      },
    };
    delete next.lastProjectRoot;
    writeGlobalState(globalStatePath, next);
  };

  const clearLastRemoteProjectBinding = (): void => {
    const state = readGlobalState(globalStatePath);
    if (!state.lastRemoteProjectBinding) return;
    const next = { ...state };
    delete next.lastRemoteProjectBinding;
    writeGlobalState(globalStatePath, next);
  };

  const bindWindowToRemoteProject = (
    windowId: number | null,
    binding: RemoteOpenProjectBinding,
  ): void => {
    if (windowId != null) {
      windowProjectRoots.set(windowId, null);
      windowProjectBindings.set(windowId, binding);
    }
    persistLastRemoteProjectBinding(binding);
    // Binding this window to a remote project must not tear down local
    // foreground services that other windows depend on. Only drop the
    // foreground if no other window is still working in a local project.
    if (!activeProjectRoot || !rootsBoundToWindows().has(activeProjectRoot)) {
      setForegroundProject(firstOpenWindowProjectRoot());
    }
    // Do NOT emit a standalone projectChanged(null) before the remote binding.
    // It would reach the renderer as a separate IPC message and momentarily put
    // the window into project==null && !remoteBinding && showWelcome==true,
    // which used to wipe the open-tab lists (see TopBar). The binding-changed
    // event below fully drives the remote view (AppShell.applyProjectState) and
    // sets the remote window title itself, so the null precursor is redundant.
    emitProjectBindingChangedToWindow(windowId, binding);
  };

  const getActiveContext = (): AppContext => {
    const windowId = currentIpcWindowId();
    if (windowId != null) {
      const windowProjectRoot = windowProjectRoots.get(windowId) ?? null;
      if (windowProjectRoot) {
        const ctx = projectContexts.get(windowProjectRoot);
        if (ctx) return ctx;
        windowProjectRoots.set(windowId, null);
      }
      return dormantContext;
    }
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
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    for (const win of BrowserWindow.getAllWindows()) {
      const isActiveInWindow = windowProjectRoots.get(win.id) === normalizedRoot;
      const isOpenTabInWindow = windowProjectTabRoots.get(win.id)?.has(normalizedRoot) === true;
      if (!isActiveInWindow && !isOpenTabInWindow) continue;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // ignore
      }
    }
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
      if (ctx.laneService?.hasRunningDelete?.()) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("lane_deletes", error);
    }

    try {
      if ((ctx.sessionService?.list({ status: "running", limit: 1 }).length ?? 0) > 0) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("sessions", error);
    }

    try {
      // ANY chat session the user hasn't explicitly closed/deleted protects
      // the project. The narrower hasActiveWorkloads check (mid-turn only) is
      // not enough — a session sitting between turns still owns a live agent
      // runtime that must survive a project switch so typing a new message
      // does not cold-restart the agent.
      if (
        ctx.agentChatService?.hasRetainableSessions?.()
        ?? ctx.agentChatService?.hasActiveWorkloads()
      ) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("agent_chats", error);
    }

    try {
      // Any live PTY (running CLI/shell/agent) means the user has work that
      // would be killed by eviction. Don't evict.
      if (ctx.ptyService?.hasLiveSessions?.()) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("pty_sessions", error);
    }

    try {
      if (ctx.testService?.hasActiveRuns()) {
        return true;
      }
    } catch (error) {
      return keepAliveOnProbeFailure("tests", error);
    }

    try {
      if (ctx.laneService && ctx.processService) {
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
    const activeRoots = rootsBoundToWindows();
    if (activeProjectRoot) activeRoots.add(activeProjectRoot);
    if (activeRoots.size === 0) return;
    const currentActiveRoot = activeProjectRoot ?? [...activeRoots][0] ?? null;

    const idleRoots: string[] = [];
    for (const [projectRoot, ctx] of projectContexts.entries()) {
      if (activeRoots.has(projectRoot)) continue;
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
      const nextActiveRoots = rootsBoundToWindows();
      if (activeProjectRoot) nextActiveRoots.add(activeProjectRoot);
      const stillSameActiveSet =
        nextActiveRoots.size === activeRoots.size
        && [...activeRoots].every((root) => nextActiveRoots.has(root));
      if (!stillSameActiveSet) {
        return;
      }
      const ctx = projectContexts.get(projectRoot);
      if (!ctx) continue;
      if (rootsBoundToWindows().has(projectRoot) || projectRoot === activeProjectRoot) continue;
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
  const prepareAutoUpdateInstall = async (): Promise<void> => {
    updateLogger.info("autoUpdate.prepare_quit_and_install_start", {
      serviceManaged: shouldRepairRuntimeServiceOnFallback,
    });
    try {
      localRuntimePool.dispose();
    } catch (error) {
      updateLogger.warn("autoUpdate.local_runtime_dispose_before_install_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!shouldRepairRuntimeServiceOnFallback) {
      updateLogger.info("autoUpdate.prepare_quit_and_install_done", {
        serviceManaged: false,
      });
      return;
    }
    const result = uninstallRuntimeService();
    const payload = {
      ok: result.ok,
      serviceName: result.serviceName,
      path: result.path,
      message: result.message,
      selfMutationBlocked: result.selfMutationBlocked === true,
    };
    if (!result.ok) {
      updateLogger.warn("autoUpdate.runtime_service_uninstall_before_install_failed", payload);
      throw new Error(result.message);
    }
    updateLogger.info("autoUpdate.runtime_service_uninstalled_before_install", payload);
    updateLogger.info("autoUpdate.prepare_quit_and_install_done", {
      serviceManaged: true,
    });
  };
  const autoUpdateService = createAutoUpdateService({
    logger: updateLogger,
    currentVersion: app.getVersion(),
    globalStatePath,
    updaterCacheDir: app.isPackaged ? resolveAutoUpdaterCacheDir() : undefined,
    autoCheckEnabled: app.isPackaged,
    beforeQuitAndInstall: prepareAutoUpdateInstall,
  });
  const shouldRefreshRuntimeServiceAfterUpdate =
    app.isPackaged
    && process.env.NODE_ENV !== "test"
    && process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL !== "1"
    && autoUpdateService.getSnapshot().recentlyInstalled != null;
  if (shouldRefreshRuntimeServiceAfterUpdate && !shouldAttemptRuntimeServiceInstall) {
    void localRuntimePool.installServiceBestEffort()
      .then(() => {
        const status = localRuntimePool.getStatus().serviceInstall;
        if (status.state === "installed") {
          markMachineStateMigrationComplete({ layout: machineAdeLayout });
        }
      })
      .catch((error) => {
        localRuntimeLogger.warn("local_runtime.service_update_refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  const initContextForProjectRoot = async ({
    projectRoot,
    baseRef,
    ensureExclude,
    recordLastProject = false,
    recordRecent = true,
    preserveRecentOrder = false,
    userSelectedProject = false,
  }: {
    projectRoot: string;
    baseRef: string;
    ensureExclude: boolean;
    recordLastProject?: boolean;
    recordRecent?: boolean;
    preserveRecentOrder?: boolean;
    userSelectedProject?: boolean;
  }): Promise<AppContext> => {
    // The .ade directory may exist from git (shared scaffold files like ade.yaml),
    // but the db is gitignored and machine-local. A missing db means this machine
    // has never completed setup, so onboarding should run.
    const hadAdeDir = fs.existsSync(path.join(projectRoot, ".ade", "ade.db"));
    const adePaths = ensureAdeDirs(projectRoot);
    const { initApiKeyStore } = await import("./services/ai/apiKeyStore");
    initApiKeyStore(projectRoot, {
      credentialStore: createDesktopCredentialStore(machineAdeLayout.secretsDir),
    });
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
    installAdeCliForTerminalInBackground(adeCliService, logger);
    const devToolsService = createDevToolsService({ logger });

    const project = toProjectInfo(projectRoot, baseRef);
    const { projectId } = upsertProjectRow({
      db,
      repoRoot: projectRoot,
      displayName: project.displayName,
      baseRef,
    });

    const operationService = createOperationService({ db, projectId });
    try {
      operationService.pruneOld();
    } catch (error) {
      logger.warn("operation_prune_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const automationsEnabled = areAutomationsEnabledForPackagedState(app.isPackaged);

    let jobEngine: ReturnType<typeof createJobEngine> | null = null;
    let automationService: ReturnType<typeof createAutomationService> | null =
      null;
    let rebaseSuggestionService: ReturnType<
      typeof createRebaseSuggestionService
    > | null = null;
    let autoRebaseService: ReturnType<typeof createAutoRebaseService> | null =
      null;
    let conflictServiceRef: ReturnType<typeof createConflictService> | null =
      null;
    let prServiceRef: ReturnType<typeof createPrService> | null = null;
    let prPollingServiceRef: ReturnType<typeof createPrPollingService> | null =
      null;
    let testServiceRef: ReturnType<typeof createTestService> | null = null;
    let gitServiceRef: ReturnType<typeof createGitOperationsService> | null =
      null;
    let linearIssueTrackerRef: LinearIssueTracker | null = null;
    let linearLiveStatusServiceRef: LinearLiveStatusService | null = null;
    const linearLiveStatusLaunchKeys = new Set<string>();
    const publishLinearChatCard = createLinearChatLinkPublisher({
      getIssueTracker: () => linearIssueTrackerRef,
      log: (event, fields) => logger.warn(event, fields),
    });
    const publishLinearChatLink = ({ laneId, sessionId, sessionTitle, issue, linkedAt }: {
      laneId: string;
      sessionId: string;
      sessionTitle?: string | null;
      issue: LaneLinearIssue;
      linkedAt: string;
    }) => {
      if (!linearIssueTrackerRef) return;
      const key = `${issue.id}:${sessionId}`;
      publishLinearChatCard({ laneId, sessionId, sessionTitle, issue, linkedAt });
      // Agent launched against a Linear issue → reflect status into Linear
      // (no-op unless the live round-trip flag is set).
      const liveStatusService = linearLiveStatusServiceRef;
      if (!liveStatusService || linearLiveStatusLaunchKeys.has(key)) return;
      linearLiveStatusLaunchKeys.add(key);
      void liveStatusService.onAgentLaunched({
        issue,
        branchName: issue.branchName,
        laneName: sessionTitle ?? null,
      }).catch((error) => {
        linearLiveStatusLaunchKeys.delete(key);
        logger.warn("linear.live_status_launch_failed", {
          laneId,
          sessionId,
          issueId: issue.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

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

    const laneTeardownDeps: LaneDeleteTeardownDeps = {};
    let autoRebaseActivityReady = false;
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
      onDeleteEvent: (event) => emitProjectEvent(projectRoot, IPC.lanesDeleteEvent, event),
      onLinearIssueLinked: ({ lane, issue, linkedAt }) => {
        const tracker = linearIssueTrackerRef;
        if (!tracker) return;
        // Resolve repo lazily so cards posted to Linear carry the cross-machine
        // ADE deeplink (https://ade-app.dev/open?type=branch&...). If the project
        // has no GitHub remote, fall back to the legacy hash-anchor URL.
        void githubService.getRepoOrThrow()
          .catch(() => null)
          .then((repo) => publishLinearLaneCard({
            issueTracker: tracker,
            lane,
            issue,
            projectRoot,
            linkedAt,
            repoOwner: repo?.owner ?? null,
            repoName: repo?.name ?? null,
            postInitialComment: true,
            log: (event, fields) => logger.warn(event, fields),
          }))
          .catch((error) => {
            logger.warn("linear.lane_card_publish_failed", {
              laneId: lane.id,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      },
      onLinearIssueSessionLinked: publishLinearChatLink,
      teardownDeps: laneTeardownDeps,
      logger,
    });
    await measureProjectInitStep("lane.ensure_primary", () =>
      laneService.ensurePrimaryLane(),
    );

    const laneWorktreeLockService = createLaneWorktreeLockService({
      db,
      logger,
    });
    laneWorktreeLockService.sweepExpired();

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
    const processRegistry = createProcessRegistryService({
      db,
      logger,
      role: "desktop-main",
      projectRoot,
    });
    processRegistry.start();
    const reconcileStaleRunningSessions = (reason: "startup" | "owner-liveness-expired") => {
      const reconciledSessions = sessionService.reconcileStaleRunningSessions({
        status: "detached",
        liveOwnerPids: processRegistry.listLivePids(),
        liveOwnerIdentities: processRegistry.listLiveProcessIdentities(),
        knownOwnerPids: processRegistry.listKnownPids(),
        knownOwnerIdentities: processRegistry.listKnownProcessIdentities(),
      });
      if (reconciledSessions > 0) {
        logger.warn("sessions.reconciled_stale_running", {
          count: reconciledSessions,
          reason,
        });
      }
    };
    reconcileStaleRunningSessions("startup");
    const staleSessionReconcileTimer = setTimeout(
      () => reconcileStaleRunningSessions("owner-liveness-expired"),
      DEFAULT_PROCESS_REGISTRY_LIVENESS_WINDOW_MS + 1_000,
    );
    staleSessionReconcileTimer.unref?.();
    const diffService = createDiffService({ laneService });
    const projectConfigService = createProjectConfigService({
      projectRoot,
      adeDir: adePaths.adeDir,
      projectId,
      db,
      logger,
    });
    const projectSecretService = createProjectSecretService(projectRoot);

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

    let githubRelaySecretService: ReturnType<typeof createAutomationSecretService> | null = null;
    const githubService = createGithubService({
      logger,
      projectRoot,
      appDataDir: app.getPath("userData"),
      credentialStore: createDesktopCredentialStore(machineAdeLayout.secretsDir),
      githubRelaySecretReader: (ref) => githubRelaySecretService?.getSecret(ref) ?? null,
    });

    const projectScaffoldService = createProjectScaffoldService({
      logger,
      githubService,
    });

    const feedbackReporterService = createFeedbackReporterService({
      db,
      logger,
      projectRoot,
      aiIntegrationService,
      githubService,
      onSubmissionUpdated: (event) => broadcast(IPC.feedbackOnUpdate, event),
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
      laneWorktreeLockService,
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
      getLaneActivity: (laneId) => {
        if (!autoRebaseActivityReady) {
          throw new Error("Session activity services are not ready.");
        }
        return {
          activeChatCount:
            laneTeardownDeps.agentChatService?.countActiveForLane(laneId) ?? 0,
          activePtyCount:
            laneTeardownDeps.ptyService?.countActiveForLane(laneId) ?? 0,
        };
      },
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
      laneWorktreeLockService,
      autoRebaseService,
      rebaseSuggestionService,
      getLinearIssueTracker: () => linearIssueTrackerRef,
      getLinearLiveStatusService: () => linearLiveStatusServiceRef,
      onHotRefreshChanged: () => {
        prPollingServiceRef?.poke();
      },
      openExternal: openExternalUrl,
    });
    prServiceRef = prService;

    const rpcEventBuffer = createEventBuffer();
    const emitPrEvent = (event: PrEventPayload): void => {
      emitProjectEvent(projectRoot, IPC.prsEvent, event);
      rpcEventBuffer.push({
        timestamp: new Date().toISOString(),
        category: "runtime",
        payload: { type: "pr_event", event },
      });
    };

    // Wire auto-map-by-branch: the PR service emits Undo-able toasts through the
    // PR event channel, and a freshly created worktree lane triggers a
    // best-effort auto-map of any existing open PR on its branch (Trigger #1).
    prService.setEventEmitter(emitPrEvent);
    laneService.setOnWorktreeLaneCreated((lane) => {
      void prService.tryAutoMapLaneByBranch(lane.id);
    });

    const prPollingService = createPrPollingService({
      logger,
      prService,
      projectConfigService,
      db,
      onEvent: emitPrEvent,
      onPullRequestsChanged: async ({ changedPrs, changes }) => {
        if (changedPrs.length > 0) {
          prService.markHotRefresh(changedPrs.map((pr) => pr.id));
        }
        await Promise.all(
          changes.map(
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
        );
        // Live status round-trip (no-op unless flag is set): a PR that just
        // transitioned into the merged state moves its linked Linear issues to
        // Done.
        const liveStatus = linearLiveStatusServiceRef;
        if (liveStatus?.enabled) {
          const mergedLaneIds = new Set(
            changes
              .filter((change) => change.previousState !== "merged" && change.pr.state === "merged" && change.pr.laneId)
              .map((change) => change.pr.laneId as string),
          );
          for (const laneId of mergedLaneIds) {
            try {
              const lanes = await laneService.list({ includeArchived: true, includeStatus: false });
              const lane = lanes.find((entry) => entry.id === laneId) ?? null;
              if (!lane) continue;
              const issues = new Map<string, { id: string; teamKey?: string | null; stateId?: string | null }>();
              const addIssue = (issue: { id: string; teamKey?: string | null; stateId?: string | null } | null | undefined): void => {
                if (issue?.id) issues.set(issue.id, issue);
              };
              addIssue(lane.linearIssue ?? null);
              for (const link of lane.linearIssueLinks ?? []) {
                if (link.closeOnMerge) addIssue(link.issue);
              }
              for (const link of laneService.listLinearIssuesForLaneSessions?.({ laneId }) ?? []) {
                if (link.closeOnMerge) addIssue(link.issue);
              }
              if (issues.size === 0) continue;
              await liveStatus.onIssueMerged({ issues: Array.from(issues.values()) });
            } catch (error) {
              logger.warn("linear.live_status_merge_failed", {
                laneId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      },
    });
    prPollingServiceRef = prPollingService;

    let linearDispatcherServiceRef: ReturnType<
      typeof createLinearDispatcherService
    > | null = null;
    let linearSyncServiceRef: ReturnType<
      typeof createLinearSyncService
    > | null = null;
    let linearIngressServiceRef: ReturnType<
      typeof createLinearIngressService
    > | null = null;
    let agentChatServiceRef: ReturnType<typeof createAgentChatService> | null =
      null;
    let orchestrationServiceRef: ReturnType<typeof createOrchestrationService> | null =
      null;
    const queueLandingService = createQueueLandingService({
      db,
      logger,
      projectId,
      prService,
      laneService,
      conflictService,
      emitEvent: emitPrEvent,
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

    const prSummaryService = createPrSummaryService({
      db,
      logger,
      projectRoot,
      prService,
      aiIntegrationService,
    });

    const externalFilesRegistry = createExternalFilesWorkspaceRegistry();
    const fileService = createFileService({
      laneService,
      externalWorkspaces: externalFilesRegistry,
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

    // Materialize the per-session Linear issue context for a CLI terminal agent
    // (mirrors agentChatService.buildAgentRuntimeEnv for SDK chats) so the agent
    // can read its attached issues without Linear creds. Keyed by the terminal's
    // chat/session id; returns the env vars pointing at the context file.
    const getSessionLinearEnv = ({
      sessionId,
      chatSessionId,
    }: {
      sessionId: string;
      chatSessionId: string | null;
    }): Record<string, string> | null => {
      const linkKey = (chatSessionId ?? sessionId).trim();
      if (!linkKey) return null;
      try {
        const links = laneService.listLinearIssuesForSession?.({ chatSessionId: linkKey }) ?? [];
        const context = writeSessionLinearIssueContextFile({
          contextDir: resolveAdeLayout(projectRoot).contextDir,
          sessionId: linkKey,
          links,
          now: new Date().toISOString(),
        });
        if (!context) return null;
        return {
          ADE_LINEAR_ISSUE_IDS: context.identifiers,
          ADE_LINEAR_CONTEXT_FILE: context.filePath,
        };
      } catch (error) {
        logger.warn("pty.session_linear_env_failed", {
          sessionId,
          chatSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    let sessionDeltaServiceRef: ReturnType<typeof createSessionDeltaService> | null = null;
    const onTrackedSessionEnded = ({
      laneId,
      sessionId,
      exitCode: _exitCode,
    }: {
      laneId: string;
      sessionId: string;
      exitCode: number | null;
    }) => {
      jobEngine?.onSessionEnded({ laneId, sessionId });
      automationService?.onSessionEnded({ laneId, sessionId });
      try {
        laneWorktreeLockService.release({ ownerKind: "conflict_resolution", ownerSessionId: sessionId });
      } catch (error) {
        logger.warn("main.lane_worktree_session_lock_release_failed", {
          laneId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      void sessionDeltaServiceRef?.computeSessionDelta(sessionId).catch((error) => {
        logger.warn("main.session_delta_compute_failed", {
          laneId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void linearSyncServiceRef?.processActiveRunsNow().catch(() => {});
    };

    let syncServiceRef: ReturnType<typeof createSyncService> | null = null;
    const ptyBackend = process.env.ADE_DISABLE_SUPERVISED_PTY_HOST === "1"
      ? null
      : createSupervisedPtyLoader({ logger });
    const loadPty = ptyBackend
      ?? (() => {
        // node-pty is a native dependency; keep the require inside the main process runtime.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("node-pty") as NodePtyType;
      });
    const ptyService = createPtyService({
      projectRoot,
      transcriptsDir: adePaths.transcriptsDir,
      laneService,
      sessionService,
      processRegistry,
      aiIntegrationService,
      projectConfigService,
      getLaneRuntimeEnv,
      getSessionLinearEnv,
      getAdeCliAgentEnv: adeCliService.agentEnv,
      logger,
      broadcastData: (ev) => {
        broadcastPtyData(ev);
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
        emitProjectEvent(projectRoot, IPC.sessionsChanged, {
          sessionId: signal.sessionId,
          reason: "meta-updated",
        });
      },
      loadPty,
      disposePtyBackend: ptyBackend?.dispose,
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

    // Wire teardown deps for laneService.delete now that the underlying services exist.
    laneTeardownDeps.processService = {
      listRuntime: (laneId) => processService.listRuntime(laneId),
      stopAll: (args) => processService.stopAll(args),
    };
    laneTeardownDeps.ptyService = {
      countActiveForLane: (laneId) => ptyService.countActiveForLane(laneId),
      disposeForLane: (laneId) => ptyService.disposeForLane(laneId),
    };
    laneTeardownDeps.fileWatcherService = {
      countActiveForWorkspace: (id) => fileService.countActiveWatchersForWorkspace(id),
      stopAllForWorkspace: (id) => fileService.stopAllWatchersForWorkspace(id),
    };
    laneTeardownDeps.autoRebaseService = {
      cancelForLane: (laneId) => autoRebaseService?.cancelForLane(laneId),
    };
    laneTeardownDeps.rebaseSuggestionService = {
      dismiss: (args) => rebaseSuggestionService?.dismiss(args) ?? Promise.resolve(),
    };

    const sessionDeltaService = createSessionDeltaService({
      db,
      projectId,
      laneService,
      sessionService,
    });
    sessionDeltaServiceRef = sessionDeltaService;

    const ctoStateService = createCtoStateService({
      db,
      projectId,
      adeDir: adePaths.adeDir,
    });

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
      ctoStateService,
      logger,
      autoStart: false,
    });
    const automationSecretService = createAutomationSecretService({
      adeDir: adePaths.adeDir,
      logger,
    });
    githubRelaySecretService = automationSecretService;

    const linearCredentialService = createLinearCredentialService({
      adeDir: adePaths.adeDir,
      logger,
      credentialStore: createDesktopCredentialStore(path.join(adePaths.adeDir, "secrets")),
    });
    const linearClient = createLinearClient({
      credentials: linearCredentialService,
      logger,
    });
    const linearIssueTracker = createLinearIssueTracker({
      client: linearClient,
    });
    linearIssueTrackerRef = linearIssueTracker;
    // Live status round-trip (gated OFF unless ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1).
    const linearLiveStatusService = createLinearLiveStatusService({
      getIssueTracker: () => linearIssueTrackerRef,
      logger,
    });
    linearLiveStatusServiceRef = linearLiveStatusService;
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
      fileService,
      workerAgentService,
      workerHeartbeatService,
      linearIssueTracker,
      flowPolicyService,
      getOrchestrationService: () => orchestrationServiceRef,
      getLinearDispatcherService: () => linearDispatcherServiceRef,
      linearClient,
      linearCredentials: linearCredentialService,
      prService,
      processService,
      getTestService: () => testServiceRef,
      ptyService,
      getAutomationService: () => automationService,
      getGitService: () => gitServiceRef,
      conflictService,
      getWorkerBudgetService: () => workerBudgetService,
      laneService,
      sessionService,
      processRegistry,
      projectConfigService,
      aiIntegrationService,
      ctoStateService,
      logger,
      appVersion: app.getVersion(),
      getAdeCliAgentEnv: adeCliService.agentEnv,
      onLinearIssueChatLinked: publishLinearChatLink,
      onEvent: (event) => {
        emitProjectEvent(projectRoot, IPC.agentChatEvent, event);
      },
      onSessionEnded: onTrackedSessionEnded,
      getDirtyFileTextForPath: async (absPath: string) => {
        const trimmed = absPath.trim();
        if (!trimmed) return undefined;
        const normalizedProjectRoot = normalizeProjectRoot(projectRoot);
        const candidateWindows = BrowserWindow.getAllWindows().filter(
          (candidate) =>
            !candidate.isDestroyed()
            && candidate.webContents
            && !candidate.webContents.isDestroyed(),
        );
        const win =
          candidateWindows.find(
            (candidate) => windowProjectRoots.get(candidate.id) === normalizedProjectRoot,
          )
          ?? candidateWindows.find(
            (candidate) => windowProjectTabRoots.get(candidate.id)?.has(normalizedProjectRoot) === true,
          )
          ?? null;
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
    laneTeardownDeps.agentChatService = {
      countActiveForLane: (laneId) => agentChatService.countActiveForLane(laneId),
      disposeForLane: (laneId) => agentChatService.disposeForLane(laneId),
    };
    autoRebaseActivityReady = true;
    void autoRebaseService
      .refreshActiveRebaseNeeds("activity_services_ready")
      .catch((error) => {
        logger.warn("autoRebase.activity_ready_refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
        emitProjectEvent(projectRoot, IPC.testsEvent, ev);
      },
    });
    testServiceRef = testService;
    gitServiceRef = gitService;

    if (automationsEnabled) {
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
    }
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
      prService,
      onEvent: (event) => emitProjectEvent(projectRoot, IPC.reviewEvent, event),
    });
    const automationIngressService = automationService
      ? createAutomationIngressService({
          logger,
          automationService,
          prService,
          secretService: automationSecretService,
          githubService,
          listRules: () => projectConfigService.get().effective.automations ?? [],
        })
      : null;

    const githubPollingService = automationService
      ? createGithubPollingService({
          logger,
          githubService,
          automationService,
        })
      : null;

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

    const orchestrationService = createOrchestrationService({
      resolveLaneWorktree: (laneId: string): string | undefined => {
        try {
          return laneService.getLaneWorktreePath(laneId);
        } catch {
          return undefined;
        }
      },
    });
    orchestrationServiceRef = orchestrationService;
    const computerUseArtifactBrokerService =
      createComputerUseArtifactBrokerService({
        db,
        projectId,
        projectRoot,
        logger,
        onEvent: (payload) =>
          emitProjectEvent(projectRoot, IPC.computerUseEvent, payload),
      });
    agentChatService.setComputerUseArtifactBrokerService(
      computerUseArtifactBrokerService,
    );
    const iosSimulatorService = createIosSimulatorService({
      projectRoot,
      logger,
      onEvent: (payload) =>
        emitProjectEvent(projectRoot, IPC.iosSimulatorEvent, payload),
    });
    const iosSimulatorDrawerActionModes: Partial<Record<string, IosSimulatorDrawerMode>> = {
      inspectPoint: "inspect",
      launch: "interact",
      openPreviewWorkspace: "preview",
      renderCurrentPreview: "preview",
      renderPreview: "preview",
      selectPoint: "inspect",
      startStream: "interact",
      tap: "interact",
      typeText: "interact",
      drag: "interact",
      swipe: "interact",
    };
    const requestIosSimulatorDrawerOpen = (
      action: keyof typeof iosSimulatorDrawerActionModes,
      rawArgs: unknown,
      result?: unknown,
    ): void => {
      const mode = iosSimulatorDrawerActionModes[action];
      if (!mode) return;
      const argRecord = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : null;
      const resultRecord = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
      const chatSessionId = readString(argRecord, "chatSessionId") ?? readString(resultRecord, "chatSessionId") ?? null;
      const laneId = readString(argRecord, "laneId") ?? readString(resultRecord, "laneId") ?? null;
      emitProjectEvent(projectRoot, IPC.iosSimulatorEvent, {
        type: "drawer-open-requested",
        action,
        mode,
        chatSessionId,
        laneId,
      });
    };
    const iosSimulatorRpcService = {
      ...iosSimulatorService,
      inspectPoint: async (arg: Parameters<typeof iosSimulatorService.inspectPoint>[0]) => {
        const result = await iosSimulatorService.inspectPoint(arg);
        requestIosSimulatorDrawerOpen("inspectPoint", arg, result);
        return result;
      },
      launch: async (arg?: Parameters<typeof iosSimulatorService.launch>[0]) => {
        const result = await iosSimulatorService.launch(arg);
        requestIosSimulatorDrawerOpen("launch", arg, result);
        return result;
      },
      openPreviewWorkspace: async (arg?: Parameters<typeof iosSimulatorService.openPreviewWorkspace>[0]) => {
        const result = await iosSimulatorService.openPreviewWorkspace(arg);
        requestIosSimulatorDrawerOpen("openPreviewWorkspace", arg, result);
        return result;
      },
      renderPreview: async (arg: Parameters<typeof iosSimulatorService.renderPreview>[0]) => {
        const result = await iosSimulatorService.renderPreview(arg);
        requestIosSimulatorDrawerOpen("renderPreview", arg, result);
        return result;
      },
      renderCurrentPreview: async (arg?: Parameters<typeof iosSimulatorService.renderCurrentPreview>[0]) => {
        const result = await iosSimulatorService.renderCurrentPreview(arg);
        requestIosSimulatorDrawerOpen("renderCurrentPreview", arg, result);
        return result;
      },
      selectPoint: async (arg: Parameters<typeof iosSimulatorService.selectPoint>[0]) => {
        const result = await iosSimulatorService.selectPoint(arg);
        requestIosSimulatorDrawerOpen("selectPoint", arg, result);
        return result;
      },
      startStream: async (arg?: Parameters<typeof iosSimulatorService.startStream>[0]) => {
        const result = await iosSimulatorService.startStream(arg);
        requestIosSimulatorDrawerOpen("startStream", arg, result);
        return result;
      },
      tap: async (arg: Parameters<typeof iosSimulatorService.tap>[0]) => {
        const result = await iosSimulatorService.tap(arg);
        requestIosSimulatorDrawerOpen("tap", arg, result);
        return result;
      },
      typeText: async (arg: Parameters<typeof iosSimulatorService.typeText>[0]) => {
        const result = await iosSimulatorService.typeText(arg);
        requestIosSimulatorDrawerOpen("typeText", arg, result);
        return result;
      },
      drag: async (arg: Parameters<typeof iosSimulatorService.drag>[0]) => {
        const result = await iosSimulatorService.drag(arg);
        requestIosSimulatorDrawerOpen("drag", arg, result);
        return result;
      },
      swipe: async (arg: Parameters<typeof iosSimulatorService.swipe>[0]) => {
        const result = await iosSimulatorService.swipe(arg);
        requestIosSimulatorDrawerOpen("swipe", arg, result);
        return result;
      },
    };
    const appControlService = createAppControlService({
      projectRoot,
      logger,
      ptyService,
      resolveLaneId: async ({ cwd, projectRoot: requestedProjectRoot, laneId, chatSessionId }) => {
        const explicitLaneId = laneId?.trim();
        if (explicitLaneId) return explicitLaneId;
        const chatId = chatSessionId?.trim();
        if (chatId) {
          const chatSession = await agentChatService.getSessionSummary(chatId).catch(() => null);
          if (chatSession?.laneId) return chatSession.laneId;
        }
        const targetRoot = path.resolve(cwd || requestedProjectRoot || projectRoot);
        const lanes = await laneService.list({ includeArchived: false });
        const matchingLane = lanes.find((lane) => {
          const worktreePath = path.resolve(lane.worktreePath);
          const attachedRootPath = lane.attachedRootPath ? path.resolve(lane.attachedRootPath) : null;
          return (
            targetRoot === worktreePath
            || targetRoot.startsWith(`${worktreePath}${path.sep}`)
            || (attachedRootPath !== null
              && (targetRoot === attachedRootPath
                || targetRoot.startsWith(`${attachedRootPath}${path.sep}`)))
          );
        });
        return matchingLane?.id ?? lanes[0]?.id ?? null;
      },
      onEvent: (payload) =>
        emitProjectEvent(projectRoot, IPC.appControlEvent, payload),
    });
    // Phone sync is owned by the per-machine ADE service. The desktop
    // keeps a non-host sync service for legacy viewer state and explicit
    // diagnostics only; ADE_ENABLE_DESKTOP_SYNC_HOST=1 re-enables the old
    // in-process host path while debugging migrations.
    const mobileSyncHostRoot = getMobileSyncHostRoot();
    const isMobileSyncHostContext =
      mobileSyncHostRoot != null
      && normalizeProjectRoot(projectRoot) === mobileSyncHostRoot;
    const syncHostAutoStart = isMobileSyncHostContext;
    const syncService = createSyncService({
      db,
      logger,
      projectRoot,
      projectId,
      runtimeProjectId: recentProjectInspectionForRoot(projectRoot)?.projectId ?? projectId,
      appVersion: app.getVersion(),
      localDeviceIdPath: path.join(machineAdeLayout.secretsDir, "sync-device-id"),
      fileService,
      laneService,
      gitService,
      diffService,
      conflictService,
      prService,
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
      phonePairingStateDir: machineAdeLayout.secretsDir,
      hostDiscoveryEnabled: isMobileSyncHostContext,
      forceHostRole: false,
      projectCatalogProvider: {
        listProjects: listMobileSyncProjects,
        prepareProjectConnection: prepareMobileSyncProjectConnection,
        completeProjectConnection: completeMobileSyncProjectConnection,
        browseDirectories: async (input: ProjectBrowseInput) =>
          browseProjectDirectories(input),
        getDefaultParentDir: async () =>
          projectScaffoldService.getDefaultParentDir(readLocalRecentProjects()),
        openProject: openMobileSyncProject,
        createProject: (input: CreateProjectInput) =>
          createMobileSyncProject(input, projectScaffoldService),
        cloneProject: (input: CloneProjectInput) =>
          cloneMobileSyncProject(input, projectScaffoldService),
        forgetProject: forgetMobileSyncProject,
        listMyGitHubRepos: async (input: ListMyGitHubReposInput) =>
          projectScaffoldService.listMyGitHubRepos(input),
      },
      onStatusChanged: (snapshot) => {
        const normalizedProjectRoot = normalizeProjectRoot(projectRoot);
        if (mobileSyncSelectedRoot == null && snapshot.connectedPeers.length > 0) {
          mobileSyncSelectedRoot = normalizedProjectRoot;
        }
        const currentSyncHostRoot = getMobileSyncHostRoot();
        if (currentSyncHostRoot == null || normalizedProjectRoot !== currentSyncHostRoot) {
          return;
        }
        broadcast(IPC.syncEvent, {
          type: "sync-status",
          snapshot,
        });
      },
      // iOS "Send to your Mac" handler. Parses the inbound `ade://...` URL
      // and routes it through the same protocol dispatcher main.ts wires up
      // for direct OS clicks, so the renderer's existing AppNavigationBridge
      // / InboundDeeplinkModal / CrossRepoPrBanner all fire normally.
      dispatchDeeplinkUrl: async (rawUrl) => {
        try {
          // Route to this sync host's project window, not whichever window is focused.
          handleDeeplinkUrl(rawUrl, "sync:ios", (request) => {
            if (dispatchAppNavigationForProjectRoot) {
              dispatchAppNavigationForProjectRoot(projectRoot, request);
              return;
            }
            dispatchOrQueueAppNavigationRequest(request);
          });
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
    syncServiceRef = syncService;
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
    logger.info("project.init_stage", {
      projectRoot,
      stage: "linear_closeout_init",
    });
    const linearCloseoutService = createLinearCloseoutService({
      issueTracker: linearIssueTracker,
      outboundService: linearOutboundService,
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
      agentChatService,
      laneService,
      templateService: linearTemplateService,
      closeoutService: linearCloseoutService,
      outboundService: linearOutboundService,
      workerTaskSessionService,
      prService,
      onEvent: (event) => {
        emitProjectEvent(projectRoot, IPC.ctoLinearWorkflowEvent, event);
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
    const linearIngressService = automationsEnabled && automationService
      ? createLinearIngressService({
          db,
          logger,
          projectId,
          linearClient,
          secretService: automationSecretService,
          projectConfigService,
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
              const isCreatedIssueEvent =
                event.entityType?.trim().toLowerCase() === "issue"
                && /^(create|created)$/i.test(event.action?.trim() ?? "");
              await linearSyncService.processIssueUpdate(event.issueId, {
                adeIssueLinkCause: isCreatedIssueEvent ? "linear_issue_created" : "linear_issue_ingress",
              });
              try {
                for (const dispatched of buildLinearAutomationDispatches(event)) {
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
        })
      : null;
    linearIngressServiceRef = linearIngressService;
    if (linearIngressService) {
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
    }

    const automationPlannerService = automationService
      ? createAutomationPlannerService({
          logger,
          projectRoot,
          projectConfigService,
          laneService,
          automationService,
        })
      : null;

    const usageTrackingService = createUsageTrackingService({
      logger,
      pollIntervalMs: 120_000,
      onUpdate: (snapshot) => {
        emitProjectEvent(projectRoot, IPC.usageEvent, snapshot);
      },
      projectRoot,
    });
    scheduleBackgroundProjectTask(
      "usage.start",
      () => usageTrackingService.start(),
      (error) => {
        logger.warn("usage.start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      1_000,
      "ADE_ENABLE_USAGE_TRACKING",
    );

    const budgetCapService = createBudgetCapService({
      db,
      logger,
      projectConfigService,
      usageTrackingService,
    });
    if (automationIngressService) {
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
    }

    if (githubPollingService) {
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
    }

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
        preserveRecentOrder,
      },
    );
    writeGlobalState(globalStatePath, state);

    // ── ADE RPC Socket Server (embedded mode) ─────────────────────
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
      laneWorktreeLockService,
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
      projectSecretService,
      conflictService,
      gitService,
      diffService,
      ptyService,
      testService,
      aiIntegrationService,
      agentChatService,
      prService,
      prSummaryService,
      queueLandingService,
      fileService,
      ctoStateService,
      workerAgentService,
      workerBudgetService,
      workerRevisionService,
      workerHeartbeatService,
      workerTaskSessionService,
      linearCredentialService,
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
      iosSimulatorService: iosSimulatorRpcService,
      appControlService,
      builtInBrowserService,
      syncHostService: syncService.getHostService(),
      syncService,
      automationIngressService,
      feedbackReporterService,
      usageTrackingService,
      budgetCapService,
      sessionDeltaService,
      autoUpdateService,
      appNavigationService: {
        navigate: async (request) => {
          const result = await deliverAppNavigationToProject(projectRoot, request);
          if (!result.ok) {
            return {
              ok: false,
              mode: "unavailable" as const,
              message: result.message,
            };
          }
          return {
            ok: true,
            mode: "desktop" as const,
            windowId: result.windowId,
          };
        },
      },
      eventBuffer: rpcEventBuffer,
      dispose: () => {}, // desktop manages service lifecycle
    };

    const activeRpcConnections = new Set<net.Socket>();
    let rpcSocketServer: net.Server | undefined;
    let rpcSocketPath: string | undefined;

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

    if (process.env.ADE_ENABLE_DESKTOP_RPC_SOCKET === "1") {
      // Legacy compatibility: the ADE service owns ADE RPC by default.
      // When explicitly enabled, derive a per-project socket path so multiple
      // desktop project contexts do not collide on the same override.
      const envSocketOverride = process.env.ADE_RPC_SOCKET_PATH?.trim();
      rpcSocketPath = envSocketOverride
        ? projectContexts.size === 0
          ? envSocketOverride
          : `${envSocketOverride}.${Buffer.from(normalizeProjectRoot(projectRoot)).toString("base64url").slice(0, 8)}`
        : adePaths.socketPath;

      if (!isAdeRuntimeNamedPipePath(rpcSocketPath)) {
        try {
          fs.unlinkSync(rpcSocketPath);
        } catch {}
      }

      const server = net.createServer((conn) => {
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
        });
        stop = startJsonRpcServer(rpcHandler, transport, {
          nonFatal: true,
          onError(error: unknown, context: JsonRpcServerErrorContext) {
            logger.warn("rpc.socket_server.contained_error", {
              context,
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
        const unsubscribeChatEvents = rpcRuntime.agentChatService?.subscribeToEvents((event) => {
          stop?.notify("chat/event", event);
        }) ?? (() => {});
        let removedConnection = false;
        const removeConnection = (): void => {
          if (removedConnection) return;
          removedConnection = true;
          activeRpcConnections.delete(conn);
          unsubscribeChatEvents();
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
      rpcSocketServer = server;
      await measureProjectInitStep("rpc.socket_server_start", () =>
        new Promise<void>((resolve, reject) => {
          const handleListening = () => {
            server.off("error", handleError);
            resolve();
          };
          const handleError = (error: Error) => {
            server.off("listening", handleListening);
            reject(error);
          };
          server.once("listening", handleListening);
          server.once("error", handleError);
          server.listen(rpcSocketPath);
        }),
      );
      logger.warn("rpc.socket_server_started", {
        socketPath: rpcSocketPath,
        mode: "legacy_desktop",
      });
    } else {
      logger.info("rpc.socket_server_skipped", {
        reason: "runtime_daemon_owns_rpc",
      });
    }

    // Wire the automation runtime into the shared ADE-action registry so
    // that `ade-action` automation steps can invoke the same domain services
    // the RPC server exposes. We do this lazily — the registry re-resolves
    // services on every call so late-bound runtime state remains visible.
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
    // like CTO state bindings.
    function buildAdeActionRuntimeForAutomations(): AdeRuntime {
      return {
        laneService,
        gitService,
        diffService,
        conflictService,
        prService,
        testService,
        agentChatService,
        ctoStateService,
        workerAgentService,
        sessionService,
        operationService,
        projectConfigService,
        projectSecretService,
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
        iosSimulatorService,
        appControlService,
        builtInBrowserService,
        automationService,
        automationPlannerService,
        githubService,
        keybindingsService,
        onboardingService,
        feedbackReporterService,
        usageTrackingService,
        budgetCapService,
        autoUpdateService,
        isPackaged: app.isPackaged,
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
      laneWorktreeLockService,
      laneEnvironmentService,
      laneTemplateService,
      portAllocationService,
      laneProxyService,
      oauthRedirectService,
      runtimeDiagnosticsService,
      rebaseSuggestionService,
      autoRebaseService,
      sessionService,
      processRegistry,
      ptyService,
      diffService,
      fileService,
      operationService,
      gitService,
      conflictService,
      aiIntegrationService,
      githubService,
      projectScaffoldService,
      feedbackReporterService,
      prService,
      prPollingService,
      computerUseArtifactBrokerService,
      iosSimulatorService,
      appControlService,
      queueLandingService,
      prSummaryService,
      reviewService,
      jobEngine,
      transcriptionService: getSharedTranscriptionService(logger),
      automationService,
      automationPlannerService,
      automationIngressService,
      githubPollingService,
      usageTrackingService,
      budgetCapService,
      syncHostService: syncService.getHostService(),
      syncService,
      orchestrationService,
      agentChatService,
      projectConfigService,
      projectSecretService,
      processService,
      sessionDeltaService,
      testService,
      ctoStateService,
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
      disposeTimers: [staleSessionReconcileTimer],
    };
  };

  const initRuntimeBackedProjectContext = async ({
    projectRoot,
    baseRef,
    userSelectedProject,
  }: {
    projectRoot: string;
    baseRef: string;
    userSelectedProject: boolean;
  }): Promise<AppContext> => {
    const adePaths = ensureAdeDirs(projectRoot);
    const logger = createFileLogger(path.join(adePaths.logsDir, "main.jsonl"));
    const project = toProjectInfo(projectRoot, baseRef);
    const runtimeProject = await localRuntimePool.ensureProject(projectRoot);
    const shellContext = createDormantProjectContext(projectRoot, { enableUsageTracking: false });
    const usageTrackingService = createUsageTrackingService({
      logger,
      pollIntervalMs: 120_000,
      onUpdate: (snapshot) => {
        emitProjectEvent(projectRoot, IPC.usageEvent, snapshot);
      },
      projectRoot,
    });
    usageTrackingService.start();

    logger.info("project.runtime_bound", {
      projectRoot,
      projectId: runtimeProject.projectId,
      mode: "local_runtime_daemon",
    });
    return {
      ...shellContext,
      logger,
      project,
      projectId: runtimeProject.projectId,
      adeDir: adePaths.adeDir,
      hasUserSelectedProject: userSelectedProject,
      adeCliService: shellContext.adeCliService,
      builtInBrowserService,
      usageTrackingService,
    };
  };

  const createDormantProjectContext = (
    projectRoot = "",
    options: { enableUsageTracking?: boolean } = {},
  ): AppContext => {
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
    // Welcome-screen IPCs (project create/clone, listMyRepos) need scaffold +
    // github services even before a project is opened. Build minimal versions
    // here that share the user-data token store. detectRepo / publishCurrent
    // require an active project and will throw clearly when called dormant.
    const dormantGithubService = createGithubService({
      logger,
      projectRoot: normalizedRoot,
      appDataDir: app.getPath("userData"),
      credentialStore: createDesktopCredentialStore(machineAdeLayout.secretsDir),
    });
    const dormantProjectScaffoldService = createProjectScaffoldService({
      logger,
      githubService: dormantGithubService,
    });
    const adeCliService = createAdeCliService({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      appExecutablePath: process.execPath,
      logger,
    });
    adeCliService.applyToProcessEnv();
    installAdeCliForTerminalInBackground(adeCliService, logger);
    const externalOnlyLaneService: FileServiceLaneAdapter = {
      getFilesWorkspaces: () => [],
      resolveWorkspaceById: (workspaceId: string) => {
        throw new Error(`Workspace is not available locally: ${workspaceId}`);
      },
      getLaneBaseAndBranch: (laneId: string) => {
        throw new Error(`Lane is not available locally: ${laneId}`);
      },
    };
    const externalOnlyFileService = createFileService({
      laneService: externalOnlyLaneService,
      externalWorkspaces: createExternalFilesWorkspaceRegistry(),
    });
    let usageTrackingService: ReturnType<typeof createUsageTrackingService> | null = null;
    if (options.enableUsageTracking !== false) {
      usageTrackingService = createUsageTrackingService({
        logger,
        pollIntervalMs: 120_000,
        onUpdate: (snapshot) => {
          const currentDormantUsageService =
            (dormantContext as AppContext | undefined)?.usageTrackingService;
          if (currentDormantUsageService !== usageTrackingService || projectContexts.size > 0) {
            return;
          }
          broadcast(IPC.usageEvent, snapshot);
        },
        projectRoot: normalizedRoot || null,
      });
    }
    return {
      db: null,
      logger,
      project,
      hasUserSelectedProject: false,
      projectId: "",
      adeDir: "",
      getActiveRpcConnectionCount: () => 0,
      disposeTimers: [],
      disposeHeadWatcher: () => {},
      keybindingsService: null,
      agentToolsService: null,
      adeCliService,
      devToolsService: createDevToolsService({ logger }),
      onboardingService: null,
      laneService: null,
      laneWorktreeLockService: null,
      laneEnvironmentService: null,
      laneTemplateService: null,
      portAllocationService: null,
      laneProxyService: null,
      oauthRedirectService: null,
      runtimeDiagnosticsService: null,
      rebaseSuggestionService: null,
      autoRebaseService: null,
      sessionService: null,
      ptyService: null,
      diffService: null,
      fileService: externalOnlyFileService,
      operationService: null,
      gitService: null,
      conflictService: null,
      aiIntegrationService: null,
      agentChatService: null,
      computerUseArtifactBrokerService: null,
      iosSimulatorService: null,
      appControlService: null,
      builtInBrowserService: null,
      githubService: dormantGithubService,
      projectScaffoldService: dormantProjectScaffoldService,
      feedbackReporterService: null,
      prService: null,
      prPollingService: null,
      queueLandingService: null,
      prSummaryService: null,
      reviewService: null,
      jobEngine: null,
      transcriptionService: getSharedTranscriptionService(logger),
      automationService: null,
      automationPlannerService: null,
      automationIngressService: null,
      githubPollingService: null,
      usageTrackingService,
      budgetCapService: null,
      syncHostService: null,
      syncService: null,
      orchestrationService: null,
      projectConfigService: null,
      projectSecretService: null,
      processService: null,
      sessionDeltaService: null,
      testService: null,
      ctoStateService: null,
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
    };
  };

  const syncDormantUsageTrackingState = (): void => {
    const usageTrackingService = (dormantContext as AppContext | undefined)?.usageTrackingService;
    if (!usageTrackingService) return;
    if (projectContexts.size > 0) {
      usageTrackingService.stop();
      return;
    }
    usageTrackingService.start();
  };

  const replaceDormantContext = (projectRoot = ""): void => {
    const previous = dormantContext as AppContext | undefined;
    if (previous) {
      try {
        previous.usageTrackingService?.dispose();
      } catch {
        // ignore
      }
    }
    dormantContext = createDormantProjectContext(projectRoot);
    syncDormantUsageTrackingState();
  };

  const disposeContextResources = async (ctx: AppContext): Promise<void> => {
    const normalizedRoot =
      typeof ctx.project?.rootPath === "string" &&
      ctx.project.rootPath.trim().length > 0
        ? normalizeProjectRoot(ctx.project.rootPath)
        : null;
    // Tear down the ADE RPC socket BEFORE service disposal so in-flight requests
    // do not race with services that are being shut down.
    for (const timer of ctx.disposeTimers ?? []) {
      clearTimeout(timer);
    }
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
      if (ctx.rpcSocketPath && !isAdeRuntimeNamedPipePath(ctx.rpcSocketPath)) {
        fs.unlinkSync(ctx.rpcSocketPath);
      }
    } catch {
      // ignore
    }
    // Flush DB before disposing services so that any pending writes are persisted.
    // Services may write during disposal, so we flush again at the end as a safety net.
    try {
      ctx.db?.flushNow();
    } catch {
      // ignore
    }
    try {
      ctx.disposeHeadWatcher();
    } catch {
      // ignore
    }
    try {
      ctx.prPollingService?.dispose();
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
      ctx.automationService?.dispose();
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
      await ctx.configReloadService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      ctx.jobEngine?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.fileService?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.iosSimulatorService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      ctx.appControlService?.dispose?.();
    } catch {
      // ignore
    }
    try {
      ctx.testService?.disposeAll();
    } catch {
      // ignore
    }
    try {
      ctx.processService?.disposeAll();
    } catch {
      // ignore
    }
    try {
      ctx.ptyService?.disposeAll();
    } catch {
      // ignore
    }
    try {
      await ctx.agentChatService?.disposeAll();
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
      ctx.processRegistry?.stop();
    } catch {
      // ignore
    }
    try {
      ctx.db?.flushNow();
      ctx.db?.close();
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
      syncDormantUsageTrackingState();
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
      if (mobileSyncSelectedRoot === normalizedRoot) {
        mobileSyncSelectedRoot = null;
      }
      await reconcileSyncHostContexts();
      notifyMobileSyncProjectCatalogChanged();
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
    setForegroundProject(null);
  };

  async function mobileProjectSummaryForContext(
    ctx: AppContext,
    recent?: RecentProjectInspection | null,
  ): Promise<SyncMobileProjectSummary> {
    let laneCount = recent?.summary.laneCount ?? 0;
    if (!recent?.summary.laneCount && ctx.laneService) {
      try {
        laneCount = (await ctx.laneService.list({ includeArchived: false })).length;
      } catch {
        laneCount = 0;
      }
    }
    return {
      id: ctx.projectId || recent?.projectId || `root:${normalizeProjectRoot(ctx.project.rootPath)}`,
      displayName: ctx.project.displayName,
      rootPath: ctx.project.rootPath,
      defaultBaseRef: ctx.project.baseRef,
      lastOpenedAt: recent?.summary.lastOpenedAt ?? null,
      iconDataUrl: mobileProjectIconDataUrl(ctx.project.rootPath),
      laneCount,
      isAvailable: fs.existsSync(ctx.project.rootPath),
      isCached: false,
      isOpen: true,
    };
  }

  function mobileProjectSummaryForRecent(recent: RecentProjectInspection): SyncMobileProjectSummary {
    const normalizedRoot = normalizeProjectRoot(recent.summary.rootPath);
    return {
      id: recent.projectId ?? `root:${normalizedRoot}`,
      displayName: recent.summary.displayName,
      rootPath: recent.summary.rootPath,
      defaultBaseRef: recent.defaultBaseRef,
      lastOpenedAt: recent.summary.lastOpenedAt,
      iconDataUrl: mobileProjectIconDataUrl(recent.summary.rootPath),
      laneCount: recent.summary.laneCount ?? 0,
      isAvailable: recent.summary.exists,
      isCached: false,
      isOpen: false,
    };
  }

  function mobileProjectIconDataUrl(projectRoot: string): string | null {
    try {
      return resolveMobileProjectIconDataUrl(projectRoot, { nativeImage });
    } catch {
      return null;
    }
  }

  async function listMobileSyncProjects(): Promise<{ projects: SyncMobileProjectSummary[] }> {
    // Remote recents belong to another machine; the paired phone pairs to this
    // host's local catalog, so skip them (and avoid disk-inspecting remote paths).
    const recentProjects = readLocalRecentProjects()
      .map(inspectRecentProject);
    const recentByRoot = new Map(
      recentProjects.map((entry) => [normalizeProjectRoot(entry.summary.rootPath), entry] as const),
    );
    const byRoot = new Map<string, SyncMobileProjectSummary>();
    for (const recent of recentProjects) {
      byRoot.set(normalizeProjectRoot(recent.summary.rootPath), mobileProjectSummaryForRecent(recent));
    }
    const contextSummaries = await Promise.all(
      [...projectContexts.entries()]
        .filter(([root]) => recentByRoot.has(root))
        .map(async ([root, ctx]) =>
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

  function recentProjectInspectionForRoot(rootPath: string): RecentProjectInspection | null {
    const normalizedRoot = normalizeProjectRoot(rootPath);
    return readLocalRecentProjects()
      .map(inspectRecentProject)
      .find((entry) => normalizeProjectRoot(entry.summary.rootPath) === normalizedRoot) ?? null;
  }

  async function resolveMobileSyncProjectRoot(rootPath: string | null | undefined): Promise<string> {
    const requestedRoot = typeof rootPath === "string" ? rootPath.trim() : "";
    if (!requestedRoot) {
      throw new Error("Project path is required.");
    }
    if (!fs.existsSync(requestedRoot)) {
      throw new Error("Project is no longer available on this machine.");
    }
    try {
      return normalizeProjectRoot(await resolveRepoRoot(requestedRoot));
    } catch {
      throw new Error("Choose a Git repository folder.");
    }
  }

  async function mobileProjectSummaryForRoot(rootPath: string | null | undefined): Promise<SyncMobileProjectSummary> {
    const normalizedRoot = await resolveMobileSyncProjectRoot(rootPath);
    const ctx = await ensureProjectContextForMobileSync(normalizedRoot);
    return await mobileProjectSummaryForContext(
      ctx,
      recentProjectInspectionForRoot(normalizedRoot),
    );
  }

  async function openMobileSyncProject(
    input: SyncProjectOpenRequestPayload,
  ): Promise<SyncMobileProjectSummary> {
    return await mobileProjectSummaryForRoot(input.rootPath);
  }

  async function createMobileSyncProject(
    input: CreateProjectInput,
    scaffoldService: ReturnType<typeof createProjectScaffoldService>,
  ): Promise<SyncMobileProjectSummary> {
    const result = await scaffoldService.createLocalProject(input);
    return await mobileProjectSummaryForRoot(result.rootPath);
  }

  async function cloneMobileSyncProject(
    input: CloneProjectInput,
    scaffoldService: ReturnType<typeof createProjectScaffoldService>,
  ): Promise<SyncMobileProjectSummary> {
    const result = await scaffoldService.cloneRepository(input);
    return await mobileProjectSummaryForRoot(result.rootPath);
  }

  async function forgetMobileSyncProject(
    input: SyncProjectForgetRequestPayload,
  ): Promise<SyncProjectForgetResultPayload> {
    const requestedProjectId = typeof input.projectId === "string" && input.projectId.trim()
      ? input.projectId.trim()
      : null;
    const requestedRoot = typeof input.rootPath === "string" && input.rootPath.trim()
      ? normalizeProjectRoot(input.rootPath)
      : null;
    if (!requestedProjectId && !requestedRoot) {
      return {
        ok: false,
        message: "Project id or path is required.",
      };
    }

    const state = readGlobalState(globalStatePath);
    const localRecentProjects = (state.recentProjects ?? []).filter((entry) => !entry.remote);
    const inspected = localRecentProjects.map(inspectRecentProject);
    const recentByRoot = requestedRoot == null
      ? null
      : inspected.find((entry) => normalizeProjectRoot(entry.summary.rootPath) === requestedRoot) ?? null;
    const recentById = requestedProjectId == null
      ? null
      : inspected.find((entry) => entry.projectId === requestedProjectId) ?? null;
    const contextByRoot = requestedRoot == null
      ? null
      : [...projectContexts.entries()].find(([root]) => root === requestedRoot) ?? null;
    const contextById = requestedProjectId == null
      ? null
      : [...projectContexts.entries()].find(([, ctx]) => ctx.projectId === requestedProjectId) ?? null;
    const rootFromPath = requestedRoot
      ?? (recentByRoot ? normalizeProjectRoot(recentByRoot.summary.rootPath) : null)
      ?? contextByRoot?.[0]
      ?? null;
    const rootFromId = (recentById ? normalizeProjectRoot(recentById.summary.rootPath) : null)
      ?? contextById?.[0]
      ?? null;
    if (rootFromPath && rootFromId && rootFromPath !== rootFromId) {
      return {
        ok: false,
        message: "projectId and rootPath refer to different projects.",
        projectId: requestedProjectId,
        rootPath: requestedRoot,
      };
    }
    const recent = recentByRoot ?? recentById;
    const contextMatch = contextByRoot ?? contextById;
    const rootToForget = rootFromPath ?? rootFromId;
    if (!rootToForget) {
      return {
        ok: true,
        message: "Project is already removed from this ADE machine.",
        projectId: requestedProjectId,
        rootPath: requestedRoot,
      };
    }

    const nextRecentProjects = (state.recentProjects ?? []).filter((entry) => {
      return entry.remote || normalizeProjectRoot(entry.rootPath) !== rootToForget;
    });
    writeGlobalState(globalStatePath, {
      ...state,
      recentProjects: nextRecentProjects,
      lastProjectRoot: state.lastProjectRoot && normalizeProjectRoot(state.lastProjectRoot) === rootToForget
        ? undefined
        : state.lastProjectRoot,
    });
    if (projectContexts.has(rootToForget)) {
      const rootToClose = rootToForget;
      const closeTimer = setTimeout(() => {
        void closeProjectByPath(rootToClose).catch((error) => {
          console.warn("sync.mobile_project_forget_close_failed", {
            rootPath: rootToClose,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 0);
      closeTimer.unref?.();
    }
    notifyMobileSyncProjectCatalogChanged();
    return {
      ok: true,
      projectId: requestedProjectId ?? contextMatch?.[1].projectId ?? recent?.projectId ?? null,
      rootPath: rootToForget,
    };
  }

  async function ensureProjectContextForMobileSync(projectRoot: string): Promise<AppContext> {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const existing = projectContexts.get(normalizedRoot);
    if (existing) return existing;
    if (!fs.existsSync(normalizedRoot)) {
      throw new Error("Project is no longer available on this machine.");
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
          preserveRecentOrder: true,
          userSelectedProject: false,
        });
        projectContexts.set(normalizedRoot, ctx);
        syncDormantUsageTrackingState();
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
        message: "That project is not available from this machine.",
      };
    }
    const targetRoot = catalogEntry.rootPath ? normalizeProjectRoot(catalogEntry.rootPath) : null;
    if (!targetRoot) {
      return {
        ok: false,
        message: "Choose a machine project first.",
      };
    }

    const existingPreparation = mobileSyncPreparationPromises.get(targetRoot);
    if (existingPreparation) return existingPreparation;

    const preparationPromise = (async (): Promise<SyncProjectSwitchResultPayload> => {
      const hadExistingContext = projectContexts.has(targetRoot);
      let createdLeaseExpiresAt: number | null = null;
      let createdLeaseTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const ctx = await ensureProjectContextForMobileSync(targetRoot);
        if (!ctx.syncService) {
          throw new Error("Sync is not available for that project.");
        }
        ctx.syncService.setHostDiscoveryEnabled?.(true);
        await ctx.syncService.setHostStartupEnabled?.(true);
        await ctx.syncService.initialize();
        const recent = readLocalRecentProjects()
          .map(inspectRecentProject)
          .find((entry) => normalizeProjectRoot(entry.summary.rootPath) === targetRoot) ?? null;
        const project = await mobileProjectSummaryForContext(ctx, recent);
        const status = await ctx.syncService.getStatus();
        const connectInfo = status.pairingConnectInfo;
        if (!connectInfo) {
          throw new Error("Phone sync is not ready for that project yet.");
        }
        const connection: SyncProjectConnectionPayload = {
          authKind: "paired",
          token: null,
          pairedDeviceId: null,
          hostIdentity: connectInfo.hostIdentity,
          port: connectInfo.port,
          addressCandidates: connectInfo.addressCandidates,
        };
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
          connection,
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
        if (mobileSyncSelectedRoot !== targetRoot) {
          await reconcileSyncHostContexts();
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

  async function completeMobileSyncProjectConnection(
    args: SyncProjectSwitchRequestPayload,
    result: SyncProjectSwitchResultPayload,
  ): Promise<void> {
    if (!result.ok) return;
    const resultRoot = result.project?.rootPath ? normalizeProjectRoot(result.project.rootPath) : null;
    const requestedRoot = typeof args.rootPath === "string" && args.rootPath.trim()
      ? normalizeProjectRoot(args.rootPath)
      : null;
    const targetRoot = resultRoot ?? requestedRoot;
    if (!targetRoot) return;

    mobileSyncSelectedRoot = targetRoot;
    projectLastActivatedAt.set(targetRoot, Date.now());
    await reconcileSyncHostContexts();
    scheduleProjectContextRebalance();
    notifyMobileSyncProjectCatalogChanged();
  }

  async function ensureMobileSyncService(): Promise<ReturnType<typeof createSyncService> | null> {
    const hostRoot = getMobileSyncHostRoot();
    if (!hostRoot) return null;
    const normalizedRoot = normalizeProjectRoot(hostRoot);
    let ctx = projectContexts.get(normalizedRoot) ?? null;
    if (!ctx) {
      ctx = await ensureProjectContextForMobileSync(normalizedRoot);
    }
    if (!ctx.syncService) return null;
    await reconcileSyncHostContexts();
    await ctx.syncService.initialize();
    return ctx.syncService;
  }

  const persistRecentProject = (
    project: ProjectInfo,
    options: { recordLastProject?: boolean; recordRecent?: boolean; preserveRecentOrder?: boolean } = {},
  ): void => {
    const state = upsertRecentProject(
      readGlobalState(globalStatePath),
      project,
      options,
    );
    delete state.lastRemoteProjectBinding;
    writeGlobalState(globalStatePath, state);
  };

  const projectOpenLogger = createFileLogger(
    path.join(app.getPath("userData"), "project-open.jsonl"),
  );

  const switchProjectFromDialog = async (
    selectedPath: string,
  ): Promise<ProjectInfo> => {
    const startedAt = Date.now();
    const windowId = currentIpcWindowId();
    let repoRoot: string | null = null;
    const pendingSelectedRootCleanup = authorizePendingWindowProjectRoot(windowId, selectedPath);
    let pendingRepoRootCleanup: (() => void) | null = null;
    const logOpenStep = (
      step: string,
      stepStartedAt: number,
      extra: Record<string, unknown> = {},
    ): void => {
      projectOpenLogger.info("project.open.step", {
        selectedPath,
        repoRoot,
        step,
        durationMs: Date.now() - stepStartedAt,
        totalMs: Date.now() - startedAt,
        ...extra,
      });
    };
    const scheduleOpenRecentPersist = (
      project: ProjectInfo,
      options: { recordLastProject?: boolean; recordRecent?: boolean; preserveRecentOrder?: boolean },
      step: string,
    ): void => {
      const scheduledAt = Date.now();
      const timer = setTimeout(() => {
        const writeStartedAt = Date.now();
        try {
          persistRecentProject(project, options);
          projectOpenLogger.info("project.open.deferred_step", {
            selectedPath,
            repoRoot,
            step,
            scheduledDelayMs: writeStartedAt - scheduledAt,
            durationMs: Date.now() - writeStartedAt,
            totalMs: Date.now() - startedAt,
          });
        } catch (error) {
          projectOpenLogger.warn("project.open.deferred_step_failed", {
            selectedPath,
            repoRoot,
            step,
            scheduledDelayMs: writeStartedAt - scheduledAt,
            durationMs: Date.now() - writeStartedAt,
            totalMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, 0);
      timer.unref?.();
      logOpenStep(`schedule_${step}`, scheduledAt);
    };
    projectOpenLogger.info("project.open.begin", { selectedPath });
    try {
      const resolveStartedAt = Date.now();
      repoRoot = normalizeProjectRoot(await resolveRepoRoot(selectedPath)); // require a real git repo for onboarding.
      if (repoRoot !== normalizeProjectRoot(selectedPath)) {
        pendingRepoRootCleanup = authorizePendingWindowProjectRoot(windowId, repoRoot);
      }
      // Kick off base-ref detection IN PARALLEL with the existing-context
      // check and any recent-project bookkeeping. For a cold open this shaves
      // 200-600ms off (git symbolic-ref + rev-parse run during work we'd be
      // doing anyway). For the fast "context already warm" path we simply
      // discard the in-flight promise.
      const baseRefStartedAt = Date.now();
      const baseRefPromise = detectDefaultBaseRef(repoRoot)
        .then((value) => {
          projectOpenLogger.info("project.open.base_ref_detected", {
            selectedPath,
            repoRoot,
            baseRef: value,
            durationMs: Date.now() - baseRefStartedAt,
          });
          return value;
        })
        .catch((error) => {
          projectOpenLogger.warn("project.open.base_ref_failed", {
            selectedPath,
            repoRoot,
            durationMs: Date.now() - baseRefStartedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          return "main";
        });
      const isKnownRecentProject = readLocalRecentProjects().some((entry) => {
        if (typeof entry?.rootPath !== "string") return false;
        return normalizeProjectRoot(entry.rootPath) === repoRoot;
      });
      projectOpenLogger.info("project.open.repo_resolved", {
        selectedPath,
        repoRoot,
        durationMs: Date.now() - resolveStartedAt,
      });
      const existing = projectContexts.get(repoRoot);
      if (existing) {
        existing.hasUserSelectedProject = true;
        scheduleOpenRecentPersist(existing.project, {
          recordLastProject: false,
          preserveRecentOrder: isKnownRecentProject,
        }, "persist_recent_reused");
        const bindStartedAt = Date.now();
        bindWindowToProject(windowId, repoRoot, { emit: true, foreground: true });
        logOpenStep("bind_window_reused", bindStartedAt);
        const rebalanceStartedAt = Date.now();
        scheduleProjectContextRebalance();
        logOpenStep("schedule_rebalance_reused", rebalanceStartedAt);
        // Drop the unused base-ref promise so it doesn't leak as an unhandled
        // rejection if detectDefaultBaseRef threw between the .catch above
        // and this point (already neutralized by .catch, but keep tidy).
        void baseRefPromise;
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
          const baseRef = await baseRefPromise;
          const initStartedAt = Date.now();
          const ctx = shouldUseInProcessProjectRuntime()
            ? await initContextForProjectRoot({
              projectRoot: repoRoot!,
              baseRef,
              ensureExclude: true,
              recordLastProject: false,
              recordRecent: true,
              preserveRecentOrder: isKnownRecentProject,
              userSelectedProject: true,
            })
            : await initRuntimeBackedProjectContext({
              projectRoot: repoRoot!,
              baseRef,
              userSelectedProject: true,
            });
          projectOpenLogger.info("project.open.context_initialized", {
            selectedPath,
            repoRoot,
            mode: shouldUseInProcessProjectRuntime() ? "in_process" : "local_runtime_daemon",
            durationMs: Date.now() - initStartedAt,
          });
          projectContexts.set(repoRoot!, ctx);
          syncDormantUsageTrackingState();
          projectOpenLogger.info("project.open.context_registered", {
            selectedPath,
            repoRoot,
            durationMs: Date.now() - initStartedAt,
          });
          return ctx;
        })().finally(() => {
          if (repoRoot) {
            projectInitPromises.delete(repoRoot);
          }
        }) as Promise<AppContext>;
        projectInitPromises.set(repoRoot, initPromise);
      }

      const initAwaitStartedAt = Date.now();
      const ctx = await initPromise;
      logOpenStep("await_init_promise", initAwaitStartedAt);
      ctx.hasUserSelectedProject = true;
      scheduleOpenRecentPersist(ctx.project, {
        recordLastProject: false,
        recordRecent: true,
        preserveRecentOrder: isKnownRecentProject,
      }, "persist_recent_new");
      const bindStartedAt = Date.now();
      bindWindowToProject(windowId, repoRoot, { emit: true, foreground: true });
      logOpenStep("bind_window_new", bindStartedAt);
      const rebalanceStartedAt = Date.now();
      scheduleProjectContextRebalance();
      logOpenStep("schedule_rebalance_new", rebalanceStartedAt);
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
    } finally {
      pendingRepoRootCleanup?.();
      pendingSelectedRootCleanup();
    }
  };

  const closeProjectByPath = async (projectRoot: string): Promise<void> => {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const wasActive = activeProjectRoot === normalizedRoot;
    for (const [windowId, root] of windowProjectRoots) {
      const tabRoots = windowProjectTabRoots.get(windowId);
      tabRoots?.delete(normalizedRoot);
      if (root === normalizedRoot) {
        const nextRoot = tabRoots?.values().next().value ?? null;
        windowProjectRoots.set(windowId, nextRoot);
        windowProjectBindings.delete(windowId);
        const nextProject = projectForRoot(nextRoot);
        emitProjectChangedToWindow(windowId, nextProject);
        emitProjectBindingChangedToWindow(windowId, bindingForLocalProject(nextProject));
      }
    }
    await closeProjectContext(normalizedRoot);
    if (wasActive) {
      setForegroundProject(firstOpenWindowProjectRoot());
      replaceDormantContext(normalizedRoot);
    }
  };

  const closeCurrentProject = async () => {
    const current = getActiveContext();
    const previousRoot = current.project?.rootPath ?? "";
    const windowId = currentIpcWindowId();
    if (windowId != null) {
      // Unbind this window without clobbering the global foreground project —
      // other open windows may still be working in their own projects, and
      // background services keyed to `activeProjectRoot` (mobile sync host,
      // artifact dir, etc.) must keep pointing at a live root if one exists.
      const tabRoots = windowProjectTabRoots.get(windowId);
      if (previousRoot) tabRoots?.delete(normalizeProjectRoot(previousRoot));
      const nextRoot = tabRoots?.values().next().value ?? null;
      bindWindowToProject(windowId, nextRoot, { emit: true, foreground: false });
      if (nextRoot == null && (activeProjectRoot === previousRoot || activeProjectRoot == null)) {
        setForegroundProject(firstOpenWindowProjectRoot());
      }
      replaceDormantContext(previousRoot);
      scheduleProjectContextRebalance();
      return;
    }
    if (activeProjectRoot) {
      await closeProjectContext(activeProjectRoot);
    }
    setForegroundProject(firstOpenWindowProjectRoot());
    replaceDormantContext(previousRoot);
  };

  replaceDormantContext();
  configureBuiltInBrowserWebAuthn({
    getLogger: () => getActiveContext().logger,
  });

  let shutdownPromise: Promise<void> | null = null;
  let shutdownRequested = false;
  let shutdownFinalized = false;
  let quitWarningAcknowledged = false;
  let quitConfirmationInFlight = false;
  let shutdownForceTimer: NodeJS.Timeout | null = null;

  const shutdownOpenCodeServersBestEffort = (): void => {
    try {
      const { shutdownOpenCodeServers } = require("./services/opencode/openCodeServerManager");
      shutdownOpenCodeServers();
    } catch {
      // ignore if module not loaded
    }
  };

  const disposeSharedTranscriptionService = (): void => {
    try {
      sharedTranscriptionService?.dispose();
    } catch {
      // ignore
    }
    sharedTranscriptionService = null;
  };

  const runImmediateProcessCleanup = (reason: string): void => {
    try {
      autoUpdateService?.dispose();
    } catch {
      // ignore
    }
    disposeSharedTranscriptionService();
    try {
      localRuntimePool.dispose();
    } catch {
      // ignore
    }

    const contexts = new Set<AppContext>(projectContexts.values());
    contexts.add(getActiveContext());

    for (const ctx of contexts) {
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
      try {
        builtInBrowserService.dispose();
      } catch {
        // ignore
      }
      try {
        builtInBrowserBridgeServer?.dispose();
      } catch {
        // ignore
      }
      setForegroundProject(null);
      replaceDormantContext(previousRoot);

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

  const showWindowCloseWarning = (
    ownerWindow: BrowserWindow | null | undefined,
    options: {
      buttons: string[];
      title: string;
      message: string;
      detail: string;
      rememberQuitAcknowledgement?: boolean;
    },
  ): boolean => {
    if (shutdownRequested) return true;
    if (options.rememberQuitAcknowledgement && quitWarningAcknowledged) return true;
    const dialogOptions = {
      type: "warning" as const,
      buttons: options.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: options.title,
      message: options.message,
      detail: options.detail,
    };
    const parentWindow =
      ownerWindow && !ownerWindow.isDestroyed()
        ? ownerWindow
        : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const response = parentWindow
      ? dialog.showMessageBoxSync(parentWindow, dialogOptions)
      : dialog.showMessageBoxSync(dialogOptions);
    if (response !== 1) {
      return false;
    }
    if (options.rememberQuitAcknowledgement) {
      quitWarningAcknowledged = true;
    }
    return true;
  };

  const isRunningLaneDeleteProgress = (value: unknown): value is LaneDeleteProgress => {
    return Boolean(
      value
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as { overallStatus?: unknown }).overallStatus === "running",
    );
  };

  const labelForProjectRoot = (root: string): string => {
    const normalizedRoot = normalizeProjectRoot(root);
    const ctx = projectContexts.get(normalizedRoot);
    return ctx?.project?.displayName || path.basename(normalizedRoot) || normalizedRoot;
  };

  const getInProcessRunningLaneDeleteLabels = (): string[] => {
    const labels: string[] = [];
    for (const ctx of projectContexts.values()) {
      try {
        if (!ctx.laneService?.hasRunningDelete?.()) continue;
        labels.push(ctx.project?.displayName ?? ctx.project?.rootPath ?? "Unknown project");
      } catch (error) {
        ctx.logger.warn("lane_delete.quit_probe_failed", {
          projectRoot: ctx.project?.rootPath ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        labels.push(ctx.project?.displayName ?? ctx.project?.rootPath ?? "Unknown project");
      }
    }
    return labels;
  };

  const getRuntimeBackedRunningLaneDeleteLabels = async (): Promise<string[]> => {
    if (shouldUseInProcessProjectRuntime()) return [];
    const roots = new Set<string>([
      ...rootsBoundToWindows(),
      ...projectContexts.keys(),
    ]);
    const labels: string[] = [];
    await Promise.all(Array.from(roots).map(async (root) => {
      try {
        const response = await localRuntimePool.callActionForRoot(root, {
          domain: "lane",
          action: "listDeleteProgress",
        });
        const progress = Array.isArray(response.result) ? response.result : [];
        if (progress.some(isRunningLaneDeleteProgress)) {
          labels.push(labelForProjectRoot(root));
        }
      } catch (error) {
        localRuntimeLogger.warn("lane_delete.runtime_quit_probe_failed", {
          projectRoot: root,
          error: error instanceof Error ? error.message : String(error),
        });
        labels.push(labelForProjectRoot(root));
      }
    }));
    return labels;
  };

  const getRunningLaneDeleteLabels = async (): Promise<string[]> => {
    const labels = [
      ...getInProcessRunningLaneDeleteLabels(),
      ...await getRuntimeBackedRunningLaneDeleteLabels(),
    ];
    return Array.from(new Set(labels));
  };

  // Live-connection probe shown before an update install or quit. Mirrors the
  // lane-delete quit probe: in-process services in dev, runtime actions against
  // the brain in packaged builds. Best-effort — an unreachable runtime simply
  // reports no phones.
  const collectUpdateInstallImpact = async (): Promise<UpdateInstallImpact> => {
    const phonesById = new Map<string, string>();
    const recordPeers = (peers: readonly SyncPeerConnectionState[] | undefined): void => {
      for (const peer of peers ?? []) {
        // Match the canonical connected-phone convention used by the phone
        // device list: a phone is both deviceType "phone" AND platform "iOS".
        // The looser OR form belongs to
        // host-side sync gating, not user-facing phone copy.
        if (peer.deviceType !== "phone" || peer.platform !== "iOS") continue;
        phonesById.set(peer.deviceId, peer.deviceName?.trim() || "Connected phone");
      }
    };
    if (shouldUseInProcessProjectRuntime()) {
      for (const ctx of projectContexts.values()) {
        try {
          const status = await ctx.syncService?.getStatus();
          recordPeers(status?.connectedPeers);
        } catch {
          // Best-effort probe.
        }
      }
    } else {
      const roots = new Set<string>([
        ...rootsBoundToWindows(),
        ...projectContexts.keys(),
      ]);
      await Promise.all(Array.from(roots).map(async (root) => {
        try {
          const status = await localRuntimePool.syncStatusForRoot(root, {});
          recordPeers(status.connectedPeers);
        } catch {
          // Best-effort probe.
        }
      }));
    }
    return {
      connectedPhones: Array.from(phonesById, ([deviceId, deviceName]) => ({
        deviceId,
        deviceName,
      })),
    };
  };

  // Quit/update dialogs are synchronous, so cap how long the impact probe can
  // delay them. On timeout the dialog falls back to generic copy.
  const collectUpdateInstallImpactBounded = async (
    timeoutMs = 1_500,
  ): Promise<UpdateInstallImpact> => {
    return await Promise.race([
      collectUpdateInstallImpact().catch((): UpdateInstallImpact => ({ connectedPhones: [] })),
      new Promise<UpdateInstallImpact>((resolve) => {
        const timer = setTimeout(() => resolve({ connectedPhones: [] }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  };

  const confirmNoRunningLaneDeleteForQuit = async (ownerWindow?: BrowserWindow | null): Promise<boolean> => {
    const runningDeletes = await getRunningLaneDeleteLabels();
    if (runningDeletes.length === 0) return true;
    const detail =
      runningDeletes.length === 1
        ? `${runningDeletes[0]} is deleting a lane. Wait for deletion to finish before quitting ADE.`
        : `These projects are deleting lanes: ${runningDeletes.join(", ")}. Wait for deletion to finish before quitting ADE.`;
    const dialogOptions = {
      type: "warning" as const,
      // Always offer an escape: a delete-progress flag can get stuck "running"
      // (e.g. a delete whose completion event was lost to a daemon
      // disconnect), and a single-button dialog would trap the app forever,
      // forcing a force-quit. "Quit anyway" is safe — runtime-backed deletes
      // run in the daemon, which keeps running after the desktop quits.
      buttons: ["Keep ADE open", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Lane delete in progress",
      message: "ADE cannot quit while a lane is being deleted.",
      detail: `${detail} You can quit anyway — any in-progress deletion continues in the background.`,
    };
    const parentWindow =
      ownerWindow && !ownerWindow.isDestroyed()
        ? ownerWindow
        : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const choice = parentWindow
      ? dialog.showMessageBoxSync(parentWindow, dialogOptions)
      : dialog.showMessageBoxSync(dialogOptions);
    // Index 1 ("Quit anyway") allows the quit to proceed.
    return choice === 1;
  };

  const describeConnectedPhones = (impact: UpdateInstallImpact | null): string | null => {
    const phones = impact?.connectedPhones ?? [];
    if (phones.length === 0) return null;
    const names = phones.map((phone) => phone.deviceName).join(", ");
    return phones.length === 1
      ? `${names} is connected through ADE phone sync and will disconnect; it reconnects automatically once ADE is running again.`
      : `These phones are connected through ADE phone sync and will disconnect: ${names}. They reconnect automatically once ADE is running again.`;
  };

  const confirmQuitWarning = (
    ownerWindow?: BrowserWindow | null,
    impact: UpdateInstallImpact | null = null,
  ): boolean => {
    const phoneDetail = describeConnectedPhones(impact);
    return showWindowCloseWarning(ownerWindow, {
      buttons: ["Keep ADE open", "Quit ADE"],
      title: "Quit ADE?",
      message: "Save your work before closing ADE.",
      detail: [
        "Quitting ADE will end agents and background processes owned by this desktop session, including OpenCode servers, terminal sessions, and test runs.",
        phoneDetail,
        "Open ADE Code terminals attached to this machine's ADE service will disconnect too — you can reopen them afterwards.",
        "The ADE service login item keeps running separately when it is installed.",
      ].filter(Boolean).join(" "),
      rememberQuitAcknowledgement: true,
    });
  };

  const confirmCloseWindowWarning = (ownerWindow: BrowserWindow): boolean =>
    showWindowCloseWarning(ownerWindow, {
      buttons: ["Keep window open", "Close window"],
      title: "Close ADE window?",
      message: "Close this ADE window?",
      detail:
        "ADE will keep running in other windows. Active agents and background processes continue unless you quit ADE.",
      rememberQuitAcknowledgement: false,
    });

  const requestQuitAfterWarnings = (
    ownerWindow: BrowserWindow | null | undefined,
    reason: "before_quit" | "window_close",
  ): void => {
    if (shutdownRequested || quitConfirmationInFlight) return;
    quitConfirmationInFlight = true;
    void (async () => {
      try {
        if (!(await confirmNoRunningLaneDeleteForQuit(ownerWindow))) return;
        const impact = await collectUpdateInstallImpactBounded();
        if (!confirmQuitWarning(ownerWindow, impact)) return;
        requestAppShutdown({ reason, exitCode: 0 });
      } finally {
        quitConfirmationInFlight = false;
      }
    })();
  };

  const closeWindowWithoutPrompt = (win: BrowserWindow): void => {
    closeWindowWithoutQuitPrompt.add(win.id);
    win.close();
    if (!win.isDestroyed()) {
      closeWindowWithoutQuitPrompt.delete(win.id);
    }
  };

  const handleMainWindowCloseRequested = (
    win: BrowserWindow,
    event: Electron.Event,
  ): void => {
    if (shutdownRequested) return;
    if (closeWindowWithoutQuitPrompt.delete(win.id)) return;
    event.preventDefault();
    if (BrowserWindow.getAllWindows().filter((openWindow) => !openWindow.isDestroyed()).length > 1) {
      if (!confirmCloseWindowWarning(win)) return;
      closeWindowWithoutPrompt(win);
      return;
    }
    requestQuitAfterWarnings(win, "window_close");
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
    disposeSharedTranscriptionService();
  });

  try {
    const { recoverManagedOpenCodeOrphans } = require("./services/opencode/openCodeServerManager");
    void recoverManagedOpenCodeOrphans({ force: true, logger: getActiveContext().logger }).catch((error: unknown) => {
      getActiveContext().logger.warn("opencode.orphan_recovery_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    getActiveContext().logger.warn("opencode.orphan_recovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void recoverOrphanedAdeAgentProcesses({ logger: getActiveContext().logger }).catch((error: unknown) => {
    getActiveContext().logger.warn("agent_process_orphan_recovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  autoUpdateService.onStateChange((snapshot) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC.updateEvent, snapshot);
    });
  });

  const firstOpenWindowProjectRoot = (): string | null => {
    for (const win of BrowserWindow.getAllWindows()) {
      const root = windowProjectRoots.get(win.id);
      if (root) return root;
    }
    return null;
  };

  const registerWindowSession = (
    win: BrowserWindow,
    projectRoot: string | null = null,
    remoteBinding: RemoteOpenProjectBinding | null = null,
  ): void => {
    let normalizedRoot: string | null = null;
    if (!remoteBinding && projectRoot) {
      normalizedRoot = normalizeProjectRoot(projectRoot);
    }
    windowProjectRoots.set(win.id, normalizedRoot);
    windowProjectTabRoots.set(win.id, normalizedRoot ? new Set([normalizedRoot]) : new Set());
    if (remoteBinding) {
      windowProjectBindings.set(win.id, remoteBinding);
    } else {
      windowProjectBindings.delete(win.id);
    }
    win.on("focus", () => {
      const focusedRemoteBinding = windowProjectBindings.get(win.id) ?? null;
      const focusedRoot = windowProjectRoots.get(win.id) ?? null;
      if (focusedRemoteBinding) {
        persistLastRemoteProjectBinding(focusedRemoteBinding);
      } else if (focusedRoot != null) {
        clearLastRemoteProjectBinding();
        setForegroundProject(focusedRoot);
      } else if (!activeProjectRoot || !rootsBoundToWindows().has(activeProjectRoot)) {
        // Focusing an unscoped window (e.g. a brand-new File > New Window) must
        // not clobber the foreground project — that would tear down background
        // services and break running work in other windows. Only re-derive the
        // foreground when the current one is no longer bound to any window.
        setForegroundProject(firstOpenWindowProjectRoot());
      }
      builtInBrowserService.attachToWindow(win);
    });
    win.on("closed", () => {
      const previousRoot = windowProjectRoots.get(win.id) ?? null;
      windowProjectRoots.delete(win.id);
      windowProjectTabRoots.delete(win.id);
      windowPendingProjectRoots.delete(win.id);
      windowProjectBindings.delete(win.id);
      if (activeProjectRoot === previousRoot) {
        setForegroundProject(firstOpenWindowProjectRoot());
      }
      scheduleProjectContextRebalance();
    });
  };

  const getWindowSession = (windowId: number | null): { windowId: number | null; project: ProjectInfo | null; binding: OpenProjectBinding | null; openProjectTabs: ProjectInfo[]; pendingLocalProjectRoots: string[] } => {
    if (windowId == null) {
      const project = projectForRoot(activeProjectRoot);
      return {
        windowId: null,
        project,
        binding: bindingForLocalProject(project),
        openProjectTabs: project ? [project] : [],
        pendingLocalProjectRoots: [],
      };
    }
    const remoteBinding = windowProjectBindings.get(windowId) ?? null;
    if (remoteBinding) return {
      windowId,
      project: null,
      binding: remoteBinding,
      openProjectTabs: projectsForWindowTabs(windowId),
      pendingLocalProjectRoots: pendingProjectRootsForWindow(windowId),
    };
    const project = projectForRoot(windowProjectRoots.get(windowId) ?? null);
    return {
      windowId,
      project,
      binding: bindingForLocalProject(project),
      openProjectTabs: projectsForWindowTabs(windowId),
      pendingLocalProjectRoots: pendingProjectRootsForWindow(windowId),
    };
  };

  const openAdeWindow = async (
    args: { projectRoot?: string | null } = {},
  ): Promise<{ windowId: number | null; project: ProjectInfo | null }> => {
    const openWindows = BrowserWindow.getAllWindows().filter(
      (win) => !win.isDestroyed(),
    );
    const restoredRemoteBinding =
      args.projectRoot || openWindows.length > 0
        ? null
        : readLastRemoteProjectBinding();
    const win = await createWindow({
      logger: getActiveContext().logger,
      onCreated: (createdWindow) =>
        registerWindowSession(createdWindow, null, restoredRemoteBinding),
      onCloseRequested: handleMainWindowCloseRequested,
    });
    builtInBrowserService.attachToWindow(win);
    if (args.projectRoot) {
      await ipcWindowScope.run(win.id, async () => {
        await switchProjectFromDialog(args.projectRoot!);
      });
    } else if (restoredRemoteBinding) {
      // Binding-changed alone drives the remote view and title; skip the
      // standalone projectChanged(null) precursor so the renderer never sees a
      // transient "no project" state that would clear restored tabs.
      emitProjectBindingChangedToWindow(win.id, restoredRemoteBinding);
    } else {
      emitProjectChangedToWindow(win.id, null);
      emitProjectBindingChangedToWindow(win.id, null);
    }
    return getWindowSession(win.id);
  };

  const deliverAppNavigationToProject = async (
    targetProjectRoot: string,
    request: AppNavigationRequest,
  ): Promise<{ ok: true; windowId: number } | { ok: false; message: string }> => {
    const normalizedRoot = normalizeProjectRoot(targetProjectRoot);
    const candidateWindows = BrowserWindow.getAllWindows().filter(
      (win) => !win.isDestroyed(),
    );
    const selection = selectWindowForProjectNavigation(
      normalizedRoot,
      candidateWindows.map((win) => ({
        id: win.id,
        activeProjectRoot: windowProjectRoots.get(win.id) ?? null,
        openProjectRoots: windowProjectTabRoots.get(win.id) ?? new Set<string>(),
      })),
    );

    let targetWindow = selection
      ? candidateWindows.find((win) => win.id === selection.windowId) ?? null
      : null;
    if (targetWindow && selection?.activateProjectRoot) {
      bindWindowToProject(targetWindow.id, normalizedRoot, {
        emit: true,
        foreground: true,
      });
    }
    if (!targetWindow) {
      const opened = await openAdeWindow({ projectRoot: normalizedRoot });
      targetWindow = opened.windowId != null ? BrowserWindow.fromId(opened.windowId) : null;
    }
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { ok: false, message: "No ADE window is available for this project." };
    }
    if (targetWindow.isMinimized()) targetWindow.restore();
    targetWindow.show();
    targetWindow.focus();
    targetWindow.webContents.send(IPC.appNavigate, request);
    return { ok: true, windowId: targetWindow.id };
  };

  dispatchAppNavigationForProjectRoot = (targetProjectRoot, request) => {
    void deliverAppNavigationToProject(targetProjectRoot, request).catch((error: unknown) => {
      getActiveContext().logger.warn("deeplink.dispatch_window_failed", {
        projectRoot: normalizeProjectRoot(targetProjectRoot),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  let initialWindowNavigationReady = false;
  const drainPendingAppNavigationRequests = (): void => {
    for (const request of pendingAppNavigationRequests.splice(0)) {
      dispatchAppNavigationRequest?.(request);
    }
  };

  dispatchAppNavigationRequest = (request) => {
    void (async () => {
      let targetWindow =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ??
        null;
      if (!targetWindow) {
        if (!initialWindowNavigationReady) {
          pendingAppNavigationRequests.push(request);
          return;
        }
        const opened = await openAdeWindow();
        targetWindow = opened.windowId != null ? BrowserWindow.fromId(opened.windowId) : null;
      }
      if (!targetWindow || targetWindow.isDestroyed()) return;
      if (targetWindow.isMinimized()) targetWindow.restore();
      targetWindow.show();
      targetWindow.focus();
      targetWindow.webContents.send(IPC.appNavigate, request);
    })().catch((error: unknown) => {
      getActiveContext().logger.warn("deeplink.dispatch_window_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const openProjectRootFromFileRequest = async (projectRoot: string): Promise<void> => {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const existing = BrowserWindow.getAllWindows()
      .find((win) => !win.isDestroyed() && windowProjectRoots.get(win.id) === normalizedRoot) ?? null;
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    await openAdeWindow({ projectRoot: normalizedRoot });
  };

  const repoRootSearchPathForOpenFileRequest = (filePath: string): string => {
    try {
      return fs.statSync(filePath).isFile() ? path.dirname(filePath) : filePath;
    } catch {
      return filePath;
    }
  };

  const openProjectFileRequest = async (filePath: string): Promise<void> => {
    const projectRoot = normalizeProjectPath(filePath);
    if (isLikelyRepoRoot(projectRoot)) {
      await openProjectRootFromFileRequest(projectRoot);
      return;
    }

    try {
      const repoRoot = normalizeProjectRoot(await resolveRepoRoot(repoRootSearchPathForOpenFileRequest(filePath)));
      if (isLikelyRepoRoot(repoRoot)) {
        await deliverAppNavigationToProject(repoRoot, {
          target: { kind: "files-external", path: filePath },
          source: "desktop",
        });
        return;
      }
    } catch {
      // Not inside a known Git repository: fall through to the focused ADE window
      // and let Files register it as an explicit external workspace.
    }

    dispatchAppNavigationRequest?.({
      target: { kind: "files-external", path: filePath },
      source: "desktop",
    });
  };

  handleProjectOpenFile = (filePath) => {
    void openProjectFileRequest(filePath).catch((error) => {
      getActiveContext().logger.warn("project.open_file_request_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  for (const filePath of pendingProjectOpenFiles.splice(0)) {
    handleProjectOpenFile(filePath);
  }

  const closeAdeWindow = async (windowId: number | null): Promise<{ closed: boolean }> => {
    if (windowId == null) return { closed: false };
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) return { closed: false };
    closeWindowWithoutPrompt(win);
    return { closed: true };
  };

  const installApplicationMenu = (): void => {
    // Route menu/keyboard zoom through the renderer so it follows the same path
    // as the in-app zoom counter (display %, persistence, macOS traffic-light
    // inset). Falls back to the focused window when the click handler omits one
    // (e.g. accelerator fired with no menu-provided window reference).
    const sendZoomCommand = (
      command: AppZoomCommand,
      browserWindow?: Electron.BaseWindow,
    ): void => {
      const target =
        browserWindow instanceof BrowserWindow
          ? browserWindow
          : BrowserWindow.getFocusedWindow();
      if (!target || target.isDestroyed()) return;
      target.webContents.send(IPC.appZoomCommand, command);
    };
    const template: Electron.MenuItemConstructorOptions[] = [
      ...(process.platform === "darwin"
        ? [{
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          }]
        : []),
      {
        label: "File",
        submenu: [
          {
            label: "New window",
            accelerator: "CommandOrControl+N",
            click: () => {
              void openAdeWindow();
            },
          },
          { type: "separator" },
          { role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          {
            label: "Actual Size",
            accelerator: "CmdOrCtrl+0",
            click: (_item, browserWindow) =>
              sendZoomCommand("reset", browserWindow),
          },
          {
            label: "Zoom In",
            accelerator: "CmdOrCtrl+Plus",
            click: (_item, browserWindow) =>
              sendZoomCommand("in", browserWindow),
          },
          // Electron's native zoomIn role also bound Cmd/Ctrl+= (the unshifted
          // "+" key most keyboards use). A single CmdOrCtrl+Plus accelerator
          // drops it, so register the "=" variant on a hidden twin to preserve
          // the shortcut (acceleratorWorksWhenHidden defaults true on macOS).
          {
            label: "Zoom In",
            accelerator: "CmdOrCtrl+=",
            visible: false,
            acceleratorWorksWhenHidden: true,
            click: (_item, browserWindow) =>
              sendZoomCommand("in", browserWindow),
          },
          {
            label: "Zoom Out",
            accelerator: "CmdOrCtrl+-",
            click: (_item, browserWindow) =>
              sendZoomCommand("out", browserWindow),
          },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(process.platform === "darwin"
            ? [
                { type: "separator" as const },
                { role: "front" as const },
              ]
            : []),
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  installApplicationMenu();

  registerIpc({
    getCtx: () => {
      const ctx = getActiveContext();
      if (!ctx.autoUpdateService) {
        ctx.autoUpdateService = autoUpdateService;
      }
      if (!ctx.updateInstallImpactProvider) {
        ctx.updateInstallImpactProvider = () => collectUpdateInstallImpactBounded();
      }
      return ctx;
    },
    getResourceUsageContexts: () => {
      const contexts = new Set<AppContext>(projectContexts.values());
      contexts.add(getActiveContext());
      return Array.from(contexts);
    },
    getSyncService: () => {
      return getMobileSyncService();
    },
    resolveSyncService: ensureMobileSyncService,
    runWithIpcWindow: (event, fn) =>
      ipcWindowScope.run(BrowserWindow.fromWebContents(event.sender)?.id ?? null, fn),
    getWindowSession,
    getProjectContext: (projectRoot) =>
      projectContexts.get(normalizeProjectRoot(projectRoot)) ?? null,
    setWindowProjectTabs: rememberWindowProjectTabs,
    bindRemoteProject: bindWindowToRemoteProject,
    localRuntimeConnectionPool: shouldUseInProcessProjectRuntime()
      ? null
      : localRuntimePool,
    createWindow: openAdeWindow,
    closeWindow: closeAdeWindow,
    switchProjectFromDialog,
    closeCurrentProject,
    closeProjectByPath,
    globalStatePath,
    builtInBrowserService,
  });

  // Explicit project launches still bind a project before the renderer boots;
  // normal launches stay on the welcome/recent-project surface.

  registerPerfIpcHandlers();

  // Restore the startup project before the renderer boots so packaged launches
  // do not flash into the welcome state and lose the previous project context.
  if (shouldOpenStartupProject && startupProject.rootPath) {
    try {
      await switchProjectFromDialog(startupProject.rootPath);
    } catch {
      setForegroundProject(null);
      replaceDormantContext();
    }
  }

  const initialRemoteProjectBinding =
    shouldOpenStartupProject ? null : savedRemoteProjectBinding;
  const initialWindowProjectRoot = shouldOpenStartupProject ? activeProjectRoot : null;
  const initialWindow = await createWindow({
    logger: getActiveContext().logger,
    onCreated: (createdWindow) =>
      registerWindowSession(
        createdWindow,
        initialWindowProjectRoot,
        initialRemoteProjectBinding,
      ),
    onCloseRequested: handleMainWindowCloseRequested,
  });
  builtInBrowserService.attachToWindow(initialWindow);
  initialWindowNavigationReady = true;
  drainPendingAppNavigationRequests();
  if (shouldShowRuntimeMigrationNotice && process.env.NODE_ENV !== "test") {
    void dialog.showMessageBox(initialWindow, {
      type: "info",
      buttons: ["Got it"],
      defaultId: 0,
      title: "ADE now runs in the background",
      message: "ADE now runs in the background",
      detail: [
        "Your machine can stay available for mobile pairing and agent work after the app window closes.",
        "You can remove the background service by running `ade serve --uninstall-service`.",
      ].join("\n\n"),
    }).catch(() => {});
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await openAdeWindow();
    }
  });

  app.on("before-quit", (event) => {
    if (shutdownFinalized) return;
    event.preventDefault();
    if (shutdownRequested) return;
    requestQuitAfterWarnings(null, "before_quit");
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
