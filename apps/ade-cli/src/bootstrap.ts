import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodePty from "node-pty";
import { createFileLogger, type Logger } from "../../desktop/src/main/services/logging/logger";
import { openKvDb, type AdeDb } from "../../desktop/src/main/services/state/kvDb";
import { detectDefaultBaseRef, toProjectInfo, upsertProjectRow } from "../../desktop/src/main/services/projects/projectService";
import {
  createAdeProjectService,
  initializeOrRepairAdeProject,
} from "../../desktop/src/main/services/projects/adeProjectService";
import { createConfigReloadService } from "../../desktop/src/main/services/projects/configReloadService";
import { createOperationService } from "../../desktop/src/main/services/history/operationService";
import { createLaneService, type LaneDeleteTeardownDeps } from "../../desktop/src/main/services/lanes/laneService";
import {
  createSessionService,
  STALE_RUNNING_SESSION_FRESH_ACTIVITY_GRACE_MS,
} from "../../desktop/src/main/services/sessions/sessionService";
import { createProjectConfigService } from "../../desktop/src/main/services/config/projectConfigService";
import { createConflictService } from "../../desktop/src/main/services/conflicts/conflictService";
import { createGitOperationsService } from "../../desktop/src/main/services/git/gitOperationsService";
import { createDiffService } from "../../desktop/src/main/services/diffs/diffService";
import { createPtyService } from "../../desktop/src/main/services/pty/ptyService";
import { createSupervisedPtyLoader } from "../../desktop/src/main/services/pty/supervisedPtyHost";
import { createTestService } from "../../desktop/src/main/services/tests/testService";
import { createKeybindingsService } from "../../desktop/src/main/services/keybindings/keybindingsService";
import type { createAgentToolsService } from "../../desktop/src/main/services/agentTools/agentToolsService";
import type { createAdeCliService } from "../../desktop/src/main/services/cli/adeCliService";
import type { createDevToolsService } from "../../desktop/src/main/services/devTools/devToolsService";
import { createOnboardingService } from "../../desktop/src/main/services/onboarding/onboardingService";
import { createLaneEnvironmentService } from "../../desktop/src/main/services/lanes/laneEnvironmentService";
import { createLaneTemplateService } from "../../desktop/src/main/services/lanes/laneTemplateService";
import { createPortAllocationService } from "../../desktop/src/main/services/lanes/portAllocationService";
import { createLaneProxyService } from "../../desktop/src/main/services/lanes/laneProxyService";
import { createOAuthRedirectService } from "../../desktop/src/main/services/lanes/oauthRedirectService";
import { createRuntimeDiagnosticsService } from "../../desktop/src/main/services/lanes/runtimeDiagnosticsService";
import { createRebaseSuggestionService } from "../../desktop/src/main/services/lanes/rebaseSuggestionService";
import { createAutoRebaseService } from "../../desktop/src/main/services/lanes/autoRebaseService";
import {
  invalidateVmLaneLaunchCache,
  refreshVmLaneLaunchCache,
  setMacosVmLaunchProvider,
  syncMacosVmLaunchCacheFromEvent,
} from "../../desktop/src/main/services/lanes/laneLaunchContext";
import { createProcessService } from "../../desktop/src/main/services/processes/processService";
import { augmentProcessPathWithShellAndKnownCliDirs, setPathEnvValue } from "../../desktop/src/main/services/ai/cliExecutableResolver";
import { createAgentChatService } from "../../desktop/src/main/services/chat/agentChatService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import type { createPrSummaryService } from "../../desktop/src/main/services/prs/prSummaryService";
import type { createQueueLandingService } from "../../desktop/src/main/services/prs/queueLandingService";
import { createIssueInventoryService } from "../../desktop/src/main/services/prs/issueInventoryService";
import { createPathToMergeOrchestrator } from "../../desktop/src/main/services/prs/pathToMergeOrchestrator";
import { createCtoStateService } from "../../desktop/src/main/services/cto/ctoStateService";
import { createWorkerAgentService } from "../../desktop/src/main/services/cto/workerAgentService";
import { createWorkerBudgetService } from "../../desktop/src/main/services/cto/workerBudgetService";
import { createWorkerRevisionService } from "../../desktop/src/main/services/cto/workerRevisionService";
import type { createWorkerHeartbeatService } from "../../desktop/src/main/services/cto/workerHeartbeatService";
import type { createWorkerTaskSessionService } from "../../desktop/src/main/services/cto/workerTaskSessionService";
import type { createLinearCredentialService } from "../../desktop/src/main/services/cto/linearCredentialService";
import { createLinearOAuthService } from "../../desktop/src/main/services/cto/linearOAuthService";
import type { createFlowPolicyService } from "../../desktop/src/main/services/cto/flowPolicyService";
import type { createLinearDispatcherService } from "../../desktop/src/main/services/cto/linearDispatcherService";
import type { createLinearIssueTracker } from "../../desktop/src/main/services/cto/linearIssueTracker";
import type { createLinearIngressService } from "../../desktop/src/main/services/cto/linearIngressService";
import type { createLinearRoutingService } from "../../desktop/src/main/services/cto/linearRoutingService";
import type { createLinearSyncService } from "../../desktop/src/main/services/cto/linearSyncService";
import {
  createLinearChatLinkPublisher,
  publishLinearLaneCard,
} from "../../desktop/src/main/services/cto/linearLaneCardService";
import { createAiIntegrationService } from "../../desktop/src/main/services/ai/aiIntegrationService";
import { initApiKeyStore } from "../../desktop/src/main/services/ai/apiKeyStore";
import type { createSyncService } from "./services/sync/syncService";
import type { createSyncHostService, SyncRuntimeKind } from "./services/sync/syncHostService";
import { getSharedModelPickerStore } from "./services/modelPickerStore";
import type { createAutomationIngressService } from "../../desktop/src/main/services/automations/automationIngressService";
import type { createGithubService } from "../../desktop/src/main/services/github/githubService";
import { createFeedbackReporterService } from "../../desktop/src/main/services/feedback/feedbackReporterService";
import {
  ApnsKeyStore,
  ApnsService,
} from "../../desktop/src/main/services/notifications/apnsService";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  getAdeAgentSkillRootsForPrompt,
  joinAdeAgentSkillRoots,
  splitAdeAgentSkillRoots,
} from "../../desktop/src/shared/agentSkillRoots";
import { createUsageTrackingService } from "../../desktop/src/main/services/usage/usageTrackingService";
import { createBudgetCapService } from "../../desktop/src/main/services/usage/budgetCapService";
import { createSessionDeltaService } from "../../desktop/src/main/services/sessions/sessionDeltaService";
import { createReviewService } from "../../desktop/src/main/services/review/reviewService";
import { createProcessRegistryService } from "../../desktop/src/main/services/runtime/processRegistryService";
import type { createAutoUpdateService } from "../../desktop/src/main/services/updates/autoUpdateService";
import {
  createComputerUseArtifactBrokerService,
  type ComputerUseArtifactBrokerService,
} from "../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import {
  createIosSimulatorService,
  type IosSimulatorService,
} from "../../desktop/src/main/services/ios/iosSimulatorService";
import {
  createAppControlService,
  type AppControlService,
} from "../../desktop/src/main/services/appControl/appControlService";
import { createMacosVmService } from "../../desktop/src/main/services/macosVm/macosVmService";
import type { BuiltInBrowserService } from "../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import {
  createBuiltInBrowserDesktopBridgeClient,
} from "./services/builtInBrowser/desktopBridgeClient";
import type { BuiltInBrowserDesktopBridgeClient } from "./services/builtInBrowser/desktopBridgeMethods";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import type { AppNavigationRequest, AppNavigationResult, PortLease } from "../../desktop/src/shared/types";
import {
  createAutomationService,
  type AutomationAdeActionRegistry,
} from "../../desktop/src/main/services/automations/automationService";
import { createAutomationPlannerService } from "../../desktop/src/main/services/automations/automationPlannerService";
import {
  ADE_ACTION_ALLOWLIST,
  type AdeActionDomain,
  getAdeActionDomainServices,
  isAllowedAdeAction,
} from "../../desktop/src/main/services/adeActions/registry";
import { createLaneWorktreeLockService, type LaneWorktreeLockService } from "../../desktop/src/main/services/lanes/laneWorktreeLockService";
import { createHeadlessLinearServices } from "./headlessLinearServices";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import { createEventBuffer, type BufferedEvent, type EventBuffer } from "./eventBuffer";

export { createEventBuffer, type BufferedEvent, type EventBuffer };

export type AdeRuntimePaths = {
  adeDir: string;
  logsDir: string;
  processLogsDir: string;
  testLogsDir: string;
  transcriptsDir: string;
  worktreesDir: string;
  packsDir: string;
  dbPath: string;
  socketPath: string;
  cacheDir: string;
  artifactsDir: string;
  chatSessionsDir: string;
  chatTranscriptsDir: string;
  orchestratorCacheDir: string;
};

export type AdeRuntimeSyncOptions = {
  enabled?: boolean;
  hostStartupEnabled?: boolean;
  hostDiscoveryEnabled?: boolean;
  initializeInBackground?: boolean;
  forceHostRole?: boolean;
  runtimeKind?: SyncRuntimeKind;
  appVersion?: string;
  registryProjectId?: string;
  localDeviceIdPath?: string;
  phonePairingStateDir?: string;
  projectCatalogProvider?: Parameters<typeof createSyncService>[0]["projectCatalogProvider"];
  remoteCommandExecutor?: Parameters<typeof createSyncService>[0]["remoteCommandExecutor"];
};

export type AdeRuntime = {
  projectRoot: string;
  workspaceRoot: string;
  projectId: string;
  project: { rootPath: string; displayName: string; baseRef: string };
  paths: AdeRuntimePaths;
  logger: Logger;
  db: AdeDb;
  keybindingsService?: ReturnType<typeof createKeybindingsService> | null;
  agentToolsService?: ReturnType<typeof createAgentToolsService> | null;
  adeCliService?: ReturnType<typeof createAdeCliService> | null;
  devToolsService?: ReturnType<typeof createDevToolsService> | null;
  onboardingService?: ReturnType<typeof createOnboardingService> | null;
  adeProjectService?: ReturnType<typeof createAdeProjectService> | null;
  laneService: ReturnType<typeof createLaneService>;
  laneWorktreeLockService?: LaneWorktreeLockService | null;
  laneEnvironmentService?: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService?: ReturnType<typeof createLaneTemplateService> | null;
  portAllocationService?: ReturnType<typeof createPortAllocationService> | null;
  laneProxyService?: ReturnType<typeof createLaneProxyService> | null;
  oauthRedirectService?: ReturnType<typeof createOAuthRedirectService> | null;
  runtimeDiagnosticsService?: ReturnType<typeof createRuntimeDiagnosticsService> | null;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  operationService: ReturnType<typeof createOperationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  conflictService: ReturnType<typeof createConflictService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  diffService: ReturnType<typeof createDiffService>;
  ptyService: ReturnType<typeof createPtyService>;
  testService: ReturnType<typeof createTestService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  prService?: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  pathToMergeOrchestrator?: ReturnType<typeof createPathToMergeOrchestrator> | null;
  fileService?: ReturnType<typeof createFileService> | null;
  ctoStateService: ReturnType<typeof createCtoStateService>;
  workerAgentService: ReturnType<typeof createWorkerAgentService>;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  workerRevisionService?: ReturnType<typeof createWorkerRevisionService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  workerTaskSessionService?: ReturnType<typeof createWorkerTaskSessionService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearOAuthService?: ReturnType<typeof createLinearOAuthService> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearDispatcherService?: ReturnType<typeof createLinearDispatcherService> | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  linearSyncService?: ReturnType<typeof createLinearSyncService> | null;
  linearIngressService?: ReturnType<typeof createLinearIngressService> | null;
  linearRoutingService?: ReturnType<typeof createLinearRoutingService> | null;
  processService?: ReturnType<typeof createProcessService> | null;
  githubService?: ReturnType<typeof createGithubService> | null;
  automationService?: ReturnType<typeof createAutomationService> | null;
  automationPlannerService?: ReturnType<typeof createAutomationPlannerService> | null;
  computerUseArtifactBrokerService: ComputerUseArtifactBrokerService;
  iosSimulatorService?: IosSimulatorService | null;
  appControlService?: AppControlService | null;
  builtInBrowserService?: BuiltInBrowserService | BuiltInBrowserDesktopBridgeClient | null;
  macosVmService?: ReturnType<typeof createMacosVmService> | null;
  syncHostService?: ReturnType<typeof createSyncHostService> | null;
  syncService?: ReturnType<typeof createSyncService> | null;
  apnsService?: ApnsService | null;
  apnsKeyStore?: ApnsKeyStore | null;
  automationIngressService?: ReturnType<typeof createAutomationIngressService> | null;
  feedbackReporterService?: ReturnType<typeof createFeedbackReporterService> | null;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  budgetCapService?: ReturnType<typeof createBudgetCapService> | null;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
  reviewService?: ReturnType<typeof createReviewService> | null;
  autoUpdateService?: ReturnType<typeof createAutoUpdateService> | null;
  appNavigationService?: {
    navigate(args: AppNavigationRequest): Promise<AppNavigationResult>;
  } | null;
  eventBuffer: EventBuffer;
  dispose: () => void;
};

export function ensureAdePaths(projectRoot: string): AdeRuntimePaths {
  const { paths } = initializeOrRepairAdeProject(projectRoot);
  return {
    adeDir: paths.adeDir,
    logsDir: paths.logsDir,
    processLogsDir: paths.processLogsDir,
    testLogsDir: paths.testLogsDir,
    transcriptsDir: paths.transcriptsDir,
    worktreesDir: paths.worktreesDir,
    packsDir: paths.packsDir,
    dbPath: paths.dbPath,
    socketPath: paths.socketPath,
    cacheDir: paths.cacheDir,
    artifactsDir: paths.artifactsDir,
    chatSessionsDir: paths.chatSessionsDir,
    chatTranscriptsDir: paths.chatTranscriptsDir,
    orchestratorCacheDir: paths.orchestratorCacheDir,
  };
}

function resolveCurrentAdeCliEntry(): string | null {
  const fromArgv = typeof process.argv[1] === "string" ? process.argv[1].trim() : "";
  const fromEnv = process.env.ADE_CLI_PATH?.trim();
  const fromEnvBin = process.env.ADE_CLI_BIN_DIR?.trim()
    ? path.join(process.env.ADE_CLI_BIN_DIR.trim(), process.platform === "win32" ? "ade.cmd" : "ade")
    : "";
  const candidates = [
    fromArgv ? path.resolve(fromArgv) : "",
    fromEnv ? path.resolve(fromEnv) : "",
    fromEnvBin ? path.resolve(fromEnvBin) : "",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Ignore stale or unreadable candidates.
    }
  }
  return null;
}

function isJavaScriptCliEntry(entryPath: string): boolean {
  return /\.(?:cjs|mjs|js)$/i.test(entryPath);
}

function ensureAdeCliShim(entryPath: string): { dir: string; path: string } | null {
  const hash = createHash("sha256").update(entryPath).digest("hex").slice(0, 16);
  const shimDir = path.join(os.tmpdir(), "ade-cli-shims", hash);
  const shimPath = path.join(shimDir, process.platform === "win32" ? "ade.cmd" : "ade");
  try {
    fs.mkdirSync(shimDir, { recursive: true });
    if (process.platform === "win32") {
      const body = isJavaScriptCliEntry(entryPath)
        ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${entryPath}" %*\r\n`
        : `@echo off\r\n"${entryPath}" %*\r\n`;
      if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== body) {
        fs.writeFileSync(shimPath, body, "utf8");
      }
    } else {
      const body = isJavaScriptCliEntry(entryPath)
        ? `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(entryPath)} "$@"\n`
        : `#!/bin/sh\nexec ${JSON.stringify(entryPath)} "$@"\n`;
      if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== body) {
        fs.writeFileSync(shimPath, body, "utf8");
      }
      fs.chmodSync(shimPath, 0o755);
    }
    return { dir: shimDir, path: shimPath };
  } catch {
    return null;
  }
}

function prependPathDir(env: NodeJS.ProcessEnv, dir: string): void {
  const currentPath = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  setPathEnvValue(env, currentPath ? `${dir}${delimiter}${currentPath}` : dir);
}

function pathExistsDirectory(dir: string | null | undefined): boolean {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function prependAgentSkillsRoot(existing: string | undefined, root: string | null): string | undefined {
  if (!root || !pathExistsDirectory(root)) return existing;
  return joinAdeAgentSkillRoots([root, ...splitAdeAgentSkillRoots(existing)]);
}

function inferAgentSkillsRootForCliEntry(cliEntry: string | null): string | null {
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "agent-skills"));
  if (cliEntry) {
    const cliDir = path.dirname(cliEntry);
    candidates.push(path.resolve(cliDir, "..", "agent-skills"));
    candidates.push(path.resolve(cliDir, "..", "..", "desktop", "resources", "agent-skills"));
    candidates.push(path.resolve(cliDir, "..", "..", "..", "apps", "desktop", "resources", "agent-skills"));
  }
  candidates.push(path.resolve(process.cwd(), "apps", "desktop", "resources", "agent-skills"));
  for (const candidate of candidates) {
    if (pathExistsDirectory(candidate)) return candidate;
  }
  return null;
}

function createHeadlessAdeCliAgentEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
    env: next,
    includeInteractiveShell: true,
    timeoutMs: 1_000,
  });
  if (nextPath) setPathEnvValue(next, nextPath);
  const cliEntry = resolveCurrentAdeCliEntry();
  if (cliEntry) {
    const shim = ensureAdeCliShim(cliEntry);
    if (shim) {
      next.ADE_CLI_PATH = shim.path;
      next.ADE_CLI_BIN_DIR = shim.dir;
      next.ADE_CLI_ENTRY_PATH = cliEntry;
      prependPathDir(next, shim.dir);
    } else {
      next.ADE_CLI_PATH = cliEntry;
      delete next.ADE_CLI_ENTRY_PATH;
    }
  }
  next[ADE_AGENT_SKILLS_DIRS_ENV] = prependAgentSkillsRoot(
    next[ADE_AGENT_SKILLS_DIRS_ENV],
    inferAgentSkillsRootForCliEntry(cliEntry),
  );
  next[ADE_AGENT_SKILLS_DIRS_ENV] = joinAdeAgentSkillRoots(getAdeAgentSkillRootsForPrompt({
    env: next,
    cwd: process.cwd(),
  }));
  return next;
}

export async function createAdeRuntime(args: {
  projectRoot: string;
  workspaceRoot?: string;
  chatRuntime?: "headless-stub" | "agent";
  runtimeProfile?: "full" | "chat";
  syncRuntime?: AdeRuntimeSyncOptions;
} | string): Promise<AdeRuntime> {
  const resolvedArgs = typeof args === "string"
    ? { projectRoot: args, workspaceRoot: args }
    : args;
  const projectRoot = path.resolve(resolvedArgs.projectRoot);
  const workspaceRoot = path.resolve(resolvedArgs.workspaceRoot ?? resolvedArgs.projectRoot);
  const chatOnlyRuntime = resolvedArgs.runtimeProfile === "chat";
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
  }

  const hadAdeDb = fs.existsSync(path.join(projectRoot, ".ade", "ade.db"));
  const baseRef = await detectDefaultBaseRef(projectRoot);
  const paths = ensureAdePaths(projectRoot);
  initApiKeyStore(projectRoot, { credentialStore: new EncryptedFileCredentialStore() });
  const logger = createFileLogger(path.join(paths.logsDir, "ade-cli.jsonl"));
  const db = await openKvDb(paths.dbPath, logger);

  const project = toProjectInfo(projectRoot, baseRef);
  const { projectId } = upsertProjectRow({
    db,
    repoRoot: projectRoot,
    displayName: project.displayName,
    baseRef
  });

  const operationService = createOperationService({ db, projectId });
  const keybindingsService = createKeybindingsService({ db });
  const eventBuffer = createEventBuffer();

  function pushEvent(category: BufferedEvent["category"], payload: Record<string, unknown>): void {
    eventBuffer.push({ timestamp: new Date().toISOString(), category, payload });
  }

  let conflictServiceRef: ReturnType<typeof createConflictService> | null = null;
  let rebaseSuggestionServiceRef: ReturnType<typeof createRebaseSuggestionService> | null = null;
  let autoRebaseServiceRef: ReturnType<typeof createAutoRebaseService> | null = null;
  let linearIssueTrackerRef: ReturnType<typeof createLinearIssueTracker> | null = null;
  let githubServiceRef: ReturnType<typeof createGithubService> | null = null;
  const publishLinearChatLink = createLinearChatLinkPublisher({
    getIssueTracker: () => linearIssueTrackerRef,
    log: (event, fields) => logger.warn(event, fields),
  });
  const laneTeardownDeps: LaneDeleteTeardownDeps = {};

  const laneService = createLaneService({
    db,
    projectRoot,
    projectId,
    defaultBaseRef: baseRef,
    worktreesDir: paths.worktreesDir,
    operationService,
    onHeadChanged: (event) => {
      pushEvent("runtime", { type: "lane_head_changed", ...event });
      void rebaseSuggestionServiceRef?.onParentHeadChanged(event).catch(() => {});
      void autoRebaseServiceRef?.onHeadChanged(event).catch(() => {});
    },
    onRebaseEvent: (event) => {
      pushEvent("runtime", { type: "lane_rebase_event", event });
      if (event.type === "rebase-run-updated" && event.run.state !== "running") {
        void conflictServiceRef?.scanRebaseNeeds().catch(() => {});
      }
    },
    onDeleteEvent: (event) => pushEvent("runtime", { type: "lane_delete_event", event }),
    onPlacementChanged: (event) => {
      pushEvent("runtime", { type: "lane_placement_changed", event });
      invalidateVmLaneLaunchCache(event.laneId);
      if (event.to === "macos-vm") {
        void refreshVmLaneLaunchCache({ laneId: event.laneId }).catch((error) => {
          logger.warn("lane.placement_changed_refresh_failed", {
            laneId: event.laneId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },
    onLinearIssueLinked: ({ lane, issue, linkedAt }) => {
      const tracker = linearIssueTrackerRef;
      if (!tracker) return;
      void githubServiceRef?.getRepoOrThrow()
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
  await laneService.ensurePrimaryLane();

  const sessionService = createSessionService({ db });
  sessionService.onChanged((event) => {
    pushEvent("runtime", { type: "terminal_session_changed", event });
  });
  const processRegistry = createProcessRegistryService({
    db,
    logger,
    role: chatOnlyRuntime ? "tui-runtime" : "ade-serve-daemon",
    projectRoot,
  });
  processRegistry.start();
  let runtimeCreated = false;
  let staleSessionReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const reconcileStaleRunningSessions = (reason: "startup" | "fresh-activity-grace-expired") => {
      const reconciledSessions = sessionService.reconcileStaleRunningSessions({
        status: "detached",
        excludeToolTypes: ["claude-chat", "codex-chat", "opencode-chat", "cursor", "droid-chat"],
        liveOwnerPids: processRegistry.listLivePids(),
        liveOwnerIdentities: processRegistry.listLiveProcessIdentities(),
        knownOwnerPids: processRegistry.listKnownPids(),
        knownOwnerIdentities: processRegistry.listKnownProcessIdentities(),
        freshActivityGraceMs: STALE_RUNNING_SESSION_FRESH_ACTIVITY_GRACE_MS,
      });
      if (reconciledSessions > 0) {
        logger.warn("sessions.reconciled_stale_running", {
          count: reconciledSessions,
          runtimeProfile: chatOnlyRuntime ? "chat" : "full",
          reason,
        });
      }
    };
    reconcileStaleRunningSessions("startup");
    staleSessionReconcileTimer = setTimeout(
      () => reconcileStaleRunningSessions("fresh-activity-grace-expired"),
      STALE_RUNNING_SESSION_FRESH_ACTIVITY_GRACE_MS + 1_000,
    );
    staleSessionReconcileTimer.unref?.();
    const sessionDeltaService = createSessionDeltaService({
      db,
      projectId,
      laneService,
      sessionService,
    });

    const projectConfigService = createProjectConfigService({
      projectRoot,
      adeDir: paths.adeDir,
      projectId,
      db,
      logger
    });
    const onboardingService = createOnboardingService({
      db,
      logger,
      projectRoot,
      projectId,
      baseRef,
      freshProject: !hadAdeDb,
      laneService,
      projectConfigService,
    });

  const laneEnvironmentService = createLaneEnvironmentService({
    projectRoot,
    adeDir: paths.adeDir,
    logger,
    broadcastEvent: (event) => pushEvent("runtime", { type: "lane_env_event", event }),
  });

  const laneTemplateService = createLaneTemplateService({
    projectConfigService,
    logger,
  });

  const portAllocationService = createPortAllocationService({
    logger,
    broadcastEvent: (event) => pushEvent("runtime", { type: "lane_port_event", event }),
    persistLeases: (leases) => db.setJson("port_leases", leases),
    loadLeases: () => db.getJson<PortLease[]>("port_leases") ?? [],
  });
  portAllocationService.restore();

  const recoverPortAllocations = async () => {
    const lanes = await laneService.list({ includeArchived: false, includeStatus: false });
    const validIds = new Set(lanes.map((lane) => lane.id));
    portAllocationService.recoverOrphans(validIds);
    for (const lane of lanes) {
      const lease = portAllocationService.getLease(lane.id);
      if (lease?.status === "active") continue;
      try {
        portAllocationService.acquire(lane.id);
      } catch (error) {
        logger.warn("port_allocation.headless_startup_acquire_failed", {
          laneId: lane.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    portAllocationService.detectConflicts();
  };
  await recoverPortAllocations().catch((error) => {
    logger.warn("port_allocation.headless_startup_recovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const laneProxyService = createLaneProxyService({
    logger,
    broadcastEvent: (event) => pushEvent("runtime", { type: "lane_proxy_event", event }),
  });

  const oauthRedirectService = createOAuthRedirectService({
    logger,
    broadcastEvent: (event) => pushEvent("runtime", { type: "lane_oauth_event", event }),
    getRoutes: () => laneProxyService.listRoutes(),
    getProxyPort: () => laneProxyService.getConfig().proxyPort,
    getHostnameSuffix: () => laneProxyService.getConfig().hostnameSuffix,
    forwardToPort: (req, res, port) => laneProxyService.forwardToPort(req, res, port),
  });
  laneProxyService.registerInterceptor((req, res) => oauthRedirectService.handleRequest(req, res));

  const runtimeDiagnosticsService = createRuntimeDiagnosticsService({
    logger,
    broadcastEvent: (event) => pushEvent("runtime", { type: "lane_diagnostics_event", event }),
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
    enableDynamicModelMetadata: false,
  });

  const conflictService = createConflictService({
    db,
    logger,
    projectId,
    projectRoot,
    laneService,
    projectConfigService,
    operationService,
    conflictPacksDir: path.join(paths.packsDir, "conflicts"),
    onEvent: (event) => pushEvent("runtime", { type: "conflict_event", event })
  });
  conflictServiceRef = conflictService;

  const rebaseSuggestionService = createRebaseSuggestionService({
    db,
    logger,
    projectId,
    projectRoot,
    laneService,
    onEvent: (event) => pushEvent("runtime", { type: "lane_rebase_suggestions_event", event }),
  });
  rebaseSuggestionServiceRef = rebaseSuggestionService;

  const autoRebaseService = createAutoRebaseService({
    db,
    logger,
    laneService,
    conflictService,
    projectConfigService,
    onEvent: (event) => pushEvent("runtime", { type: "lane_auto_rebase_event", event }),
  });
  autoRebaseServiceRef = autoRebaseService;
  void autoRebaseService.emit().catch(() => {});

  const gitService = createGitOperationsService({
    laneService,
    operationService,
    projectConfigService,
    aiIntegrationService,
    logger
  });

  const diffService = createDiffService({ laneService });

  const ptyBackend = process.env.ADE_DISABLE_SUPERVISED_PTY_HOST === "1"
    ? null
    : createSupervisedPtyLoader({ logger });
  const ptyService = createPtyService({
    projectRoot,
    transcriptsDir: paths.transcriptsDir,
    laneService,
    sessionService,
    processRegistry,
    logger,
    broadcastData: (event) => pushEvent("pty", { type: "pty_data", event }),
    broadcastExit: (event) => pushEvent("pty", { type: "pty_exit", event }),
    onSessionEnded: (event) => {
      void sessionDeltaService.computeSessionDelta(event.sessionId).catch((error) => {
        logger.warn("runtime.session_delta_compute_failed", {
          laneId: event.laneId,
          sessionId: event.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    getAdeCliAgentEnv: createHeadlessAdeCliAgentEnv,
    loadPty: ptyBackend ?? (() => nodePty),
    disposePtyBackend: ptyBackend?.dispose
  });

  const testService = createTestService({
    db,
    projectId,
    testLogsDir: paths.testLogsDir,
    logger,
    laneService,
    projectConfigService,
    broadcastEvent: (event) => pushEvent("runtime", event as unknown as Record<string, unknown>)
  });
  const issueInventoryService = createIssueInventoryService({ db });
  const laneWorktreeLockService = createLaneWorktreeLockService({ db, logger });

  // Headless lane runtime env uses the same persistent allocator/proxy hostname
  // services as desktop so a remote runtime presents the same PORT and preview
  // surface to process definitions.
  const getHeadlessLaneRuntimeEnv = async (laneId: string): Promise<Record<string, string>> => {
    const lanes = await laneService.list({ includeArchived: false, includeStatus: false });
    const lane = lanes.find((entry) => entry.id === laneId);
    const lease = portAllocationService.getLease(laneId) ?? portAllocationService.acquire(laneId);
    const hostname = laneProxyService.generateHostname(laneId, lane?.name ?? lane?.branchRef);
    return {
      PORT: String(lease.rangeStart),
      PORT_RANGE_START: String(lease.rangeStart),
      PORT_RANGE_END: String(lease.rangeEnd),
      HOSTNAME: hostname,
      PROXY_HOSTNAME: hostname,
    };
  };

  const processService = createProcessService({
    db,
    projectId,
    logger,
    laneService,
    projectConfigService,
    sessionService,
    ptyService,
    getLaneRuntimeEnv: getHeadlessLaneRuntimeEnv,
    broadcastEvent: (event) => pushEvent("runtime", event as unknown as Record<string, unknown>),
  });
  laneTeardownDeps.processService = {
    listRuntime: (laneId) => processService.listRuntime(laneId),
    stopAll: (args) => processService.stopAll(args),
  };
  laneTeardownDeps.ptyService = {
    countActiveForLane: (laneId) => ptyService.countActiveForLane(laneId),
    disposeForLane: (laneId) => ptyService.disposeForLane(laneId),
  };
  laneTeardownDeps.autoRebaseService = {
    cancelForLane: (laneId) => autoRebaseService.cancelForLane(laneId),
  };
  laneTeardownDeps.rebaseSuggestionService = {
    dismiss: (args) => rebaseSuggestionService.dismiss(args),
  };

  const ctoStateService = createCtoStateService({
    db,
    projectId,
    adeDir: paths.adeDir,
  });
  const workerAgentService = createWorkerAgentService({
    db,
    projectId,
    adeDir: paths.adeDir,
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
  const workerBudgetService = createWorkerBudgetService({
    db,
    projectId,
    workerAgentService,
    projectConfigService,
  });
  const workerRevisionService = createWorkerRevisionService({
    db,
    projectId,
    workerAgentService,
  });
  const computerUseArtifactBrokerService = createComputerUseArtifactBrokerService({
    db,
    projectId,
    projectRoot,
    logger,
    onEvent: (event) => pushEvent("runtime", { type: "computer_use_event", event }),
  });
  const iosSimulatorService = chatOnlyRuntime
    ? null
    : createIosSimulatorService({
        projectRoot,
        logger,
        onEvent: (event) => pushEvent("runtime", { type: "ios_simulator_event", event }),
      });
  // Late-bound chat session lookup. agentChatService is created after
  // appControlService below, so we capture a holder that the resolveLaneId
  // closure reads at call time. The chat session store lives in agentChatService
  // (getSessionSummary), not in sessionService (which holds terminal sessions).
  const agentChatServiceHolder: { current: ReturnType<typeof createAgentChatService> | null } = { current: null };
  const appControlService = chatOnlyRuntime
    ? null
    : createAppControlService({
        projectRoot,
        logger,
        ptyService,
        onEvent: (event) => pushEvent("runtime", { type: "app_control_event", event }),
        resolveLaneId: async ({ cwd, projectRoot: requestedProjectRoot, laneId, chatSessionId }) => {
          const explicitLaneId = laneId?.trim();
          if (explicitLaneId) return explicitLaneId;
          const chatId = chatSessionId?.trim();
          if (chatId && agentChatServiceHolder.current) {
            const chatSession = await agentChatServiceHolder.current.getSessionSummary(chatId).catch(() => null);
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
      });
  const macosVmService = chatOnlyRuntime
    ? null
    : createMacosVmService({
        projectRoot,
        logger,
        resolveLanes: async () => laneService.list({ includeArchived: false }),
        onEvent: (event) => {
          syncMacosVmLaunchCacheFromEvent(event, (name, fields) => {
            logger.warn(name, fields);
          });
          pushEvent("runtime", {
            ...(event as unknown as Record<string, unknown>),
            type: "macos_vm",
            eventType: event.type,
          });
        },
      });
  if (macosVmService) {
    setMacosVmLaunchProvider({
      getStatus: macosVmService.getStatus.bind(macosVmService),
      getCredentials: macosVmService.getCredentials.bind(macosVmService),
    });
  }

  // `built_in_browser` is hosted by the desktop's Electron main process (the
  // browser pane owns a WebContentsView). The runtime daemon proxies calls
  // through `<adeHome>/sock/desktop-bridge.sock`; if no desktop is running,
  // individual calls fail clearly. Override the socket path with
  // `ADE_DESKTOP_BRIDGE_SOCKET_PATH` for dev launches that use a non-default
  // ADE home.
  const builtInBrowserBridge: BuiltInBrowserDesktopBridgeClient | null = chatOnlyRuntime
    ? null
    : createBuiltInBrowserDesktopBridgeClient({
        socketPath:
          process.env.ADE_DESKTOP_BRIDGE_SOCKET_PATH?.trim()
          || resolveMachineAdeLayout().desktopBridgeSocketPath,
        logger,
      });

  const headlessLinearServices = createHeadlessLinearServices({
    projectRoot,
    adeDir: paths.adeDir,
    paths,
    projectId,
    db,
    logger,
    projectConfigService,
    laneService,
    operationService,
    conflictService,
    workerAgentService,
    workerBudgetService,
    computerUseArtifactBrokerService,
    openExternal: async () => {},
    onGitHubStatusChanged: (status) =>
      pushEvent("runtime", { type: "github_status_changed", event: status }),
    onLinearWorkflowEvent: (event) =>
      pushEvent("runtime", { type: "linear_workflow_event", event }),
  });
  linearIssueTrackerRef = headlessLinearServices.linearIssueTracker;
  githubServiceRef = headlessLinearServices.githubService as ReturnType<typeof createGithubService>;
  laneTeardownDeps.fileWatcherService = {
    countActiveForWorkspace: (id) => headlessLinearServices.fileService.countActiveWatchersForWorkspace(id),
    stopAllForWorkspace: (id) => headlessLinearServices.fileService.stopAllWatchersForWorkspace(id),
  };
  const linearOAuthService = createLinearOAuthService({
    credentials: headlessLinearServices.linearCredentialService,
    logger,
  });

  const feedbackReporterService = createFeedbackReporterService({
    db,
    logger,
    projectRoot,
    aiIntegrationService,
    githubService: headlessLinearServices.githubService,
    onSubmissionUpdated: (event) => pushEvent("runtime", { type: "feedback_submission_event", event }),
  });

  let automationServiceRef: ReturnType<typeof createAutomationService> | null = null;
  let agentChatService = headlessLinearServices.agentChatService as unknown as ReturnType<typeof createAgentChatService> | null;
  if (resolvedArgs.chatRuntime === "agent") {
    agentChatService = createAgentChatService({
      projectRoot,
      adeDir: paths.adeDir,
      transcriptsDir: paths.transcriptsDir,
      fileService: headlessLinearServices.fileService,
      workerAgentService,
      workerHeartbeatService: headlessLinearServices.workerHeartbeatService,
      linearIssueTracker: headlessLinearServices.linearIssueTracker,
      flowPolicyService: headlessLinearServices.flowPolicyService,
      getLinearDispatcherService: () => headlessLinearServices.linearDispatcherService,
      linearClient: headlessLinearServices.linearClient,
      linearCredentials: headlessLinearServices.linearCredentialService,
      prService: headlessLinearServices.prService,
      issueInventoryService,
      processService,
      getTestService: () => testService,
      ptyService,
      getAutomationService: () => automationServiceRef,
      getGitService: () => gitService,
      conflictService,
      getWorkerBudgetService: () => workerBudgetService,
      computerUseArtifactBrokerService,
      laneService,
      sessionService,
      processRegistry,
      projectConfigService,
      aiIntegrationService,
      ctoStateService,
      logger,
      appVersion: "ade-cli",
      getAdeCliAgentEnv: createHeadlessAdeCliAgentEnv,
      onLinearIssueChatLinked: publishLinearChatLink,
      onEvent: (event) => {
        pushEvent("runtime", event as unknown as Record<string, unknown>);
      },
      onSessionEnded: (event) => {
        pushEvent("runtime", { type: "agent_chat_session_ended", ...event });
      },
      getDirtyFileTextForPath: () => undefined,
    });
    if (typeof (headlessLinearServices.prService as { setAgentChatService?: (svc: unknown) => void }).setAgentChatService === "function") {
      (headlessLinearServices.prService as { setAgentChatService: (svc: unknown) => void }).setAgentChatService(agentChatService);
    }
  }
  agentChatServiceHolder.current = agentChatService;
  if (agentChatService) {
    laneTeardownDeps.agentChatService = {
      countActiveForLane: (laneId) => agentChatService.countActiveForLane(laneId),
      disposeForLane: (laneId) => agentChatService.disposeForLane(laneId),
    };
  }
  if (resolvedArgs.chatRuntime === "agent" && !agentChatService) {
    throw new Error("Agent chat runtime was requested but the agent chat service was not initialized.");
  }
  const reviewService = agentChatService
    ? createReviewService({
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
        prService: headlessLinearServices.prService,
        onEvent: (event) => pushEvent("runtime", { type: "review_event", event }),
      })
    : null;
  type PathToMergeAgentChatService = Parameters<typeof createPathToMergeOrchestrator>[0]["agentChatService"];
  const pathToMergeOrchestrator = createPathToMergeOrchestrator({
    logger,
    prService: headlessLinearServices.prService,
    laneService,
    agentChatService: agentChatService as unknown as PathToMergeAgentChatService,
    sessionService,
    issueInventoryService,
    conflictService,
    laneWorktreeLockService,
    defaultModelId: null,
    defaultReasoningEffort: null,
  });
  const automationService = createAutomationService({
    db,
    logger,
    projectId,
    projectRoot,
    laneService,
    projectConfigService,
    conflictService,
    testService,
    agentChatService: agentChatService ?? undefined,
    onEvent: (event) => pushEvent("runtime", { ...event, source: "automations" }),
  });
  automationServiceRef = automationService;
  const configReloadService = createConfigReloadService({
    paths: {
      sharedPath: adeProjectService.paths.sharedConfigPath,
      localPath: adeProjectService.paths.localConfigPath,
      secretPath: adeProjectService.paths.secretConfigPath,
    },
    projectConfigService,
    adeProjectService,
    automationService,
    logger,
    onEvent: (event) => pushEvent("runtime", { type: "project_state_event", event }),
  });
  void configReloadService.start().catch((error) => {
    logger.warn("project.config_reload_start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
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
    onUpdate: (snapshot) => pushEvent("runtime", { type: "usage", snapshot }),
    projectRoot,
  });
  const budgetCapService = createBudgetCapService({
    db,
    logger,
    projectConfigService,
    usageTrackingService,
  });
  const apnsService = new ApnsService({ logger });
  const projectSecretsDir = path.join(projectRoot, ".ade", "secrets");
  const apnsKeyStore = new ApnsKeyStore({
    encryptedKeyPath: path.join(projectSecretsDir, "apns.key.enc"),
    credentialStore: new EncryptedFileCredentialStore({
      secretsDir: projectSecretsDir,
    }),
  });
  try {
    const apnsConfig = projectConfigService.get().effective.notifications?.apns;
    if (
      apnsConfig?.enabled &&
      apnsKeyStore.has() &&
      apnsConfig.keyId &&
      apnsConfig.teamId &&
      apnsConfig.bundleId
    ) {
      const pem = apnsKeyStore.load();
      if (pem) {
        apnsService.configure({
          keyP8Pem: pem,
          keyId: apnsConfig.keyId,
          teamId: apnsConfig.teamId,
          bundleId: apnsConfig.bundleId,
          env: apnsConfig.env ?? "sandbox",
        });
      }
    }
  } catch (error) {
    logger.warn("apns.configure_on_startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let syncService: ReturnType<typeof createSyncService> | null = null;
  if (resolvedArgs.syncRuntime?.enabled && agentChatService) {
    const { createSyncService } = await import("./services/sync/syncService");
    syncService = createSyncService({
      db,
      logger,
      projectId: resolvedArgs.syncRuntime.registryProjectId ?? projectId,
      projectRoot,
      appVersion: resolvedArgs.syncRuntime.appVersion ?? "ade-cli",
      runtimeKind: resolvedArgs.syncRuntime.runtimeKind ?? "headless",
      localDeviceIdPath: resolvedArgs.syncRuntime.localDeviceIdPath,
      phonePairingStateDir: resolvedArgs.syncRuntime.phonePairingStateDir,
      fileService: headlessLinearServices.fileService,
      laneService,
      gitService,
      diffService,
      conflictService,
      prService: headlessLinearServices.prService,
      issueInventoryService,
      pathToMergeOrchestrator,
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
      workerRevisionService,
      workerHeartbeatService: headlessLinearServices.workerHeartbeatService,
      ctoStateService,
      flowPolicyService: headlessLinearServices.flowPolicyService,
      getLinearIngressService: () => headlessLinearServices.linearIngressService,
      getLinearIssueTracker: () => headlessLinearServices.linearIssueTracker,
      getLinearSyncService: () => headlessLinearServices.linearSyncService,
      processService,
      hostStartupEnabled: resolvedArgs.syncRuntime.hostStartupEnabled ?? true,
      hostDiscoveryEnabled: resolvedArgs.syncRuntime.hostDiscoveryEnabled ?? true,
      forceHostRole: resolvedArgs.syncRuntime.forceHostRole ?? true,
      projectCatalogProvider: resolvedArgs.syncRuntime.projectCatalogProvider,
      remoteCommandExecutor: resolvedArgs.syncRuntime.remoteCommandExecutor,
      getModelPickerStore: () => getSharedModelPickerStore(db),
      onStatusChanged: (snapshot) => pushEvent("runtime", { type: "sync-status", snapshot }),
    });
  }

  if (syncService) {
    const initializeSyncService = async () => {
      try {
        await syncService.initialize();
      } catch (error) {
        logger.warn("sync.runtime_initialize_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (resolvedArgs.syncRuntime?.initializeInBackground === true) {
      void initializeSyncService();
    } else {
      await initializeSyncService();
    }
  }

  const runtime: AdeRuntime = {
    projectRoot,
    workspaceRoot,
    projectId,
    project,
    paths,
    logger,
    db,
    keybindingsService,
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
    sessionDeltaService,
    onboardingService,
    operationService,
    projectConfigService,
    conflictService,
    gitService,
    diffService,
    syncService,
    syncHostService: syncService?.getHostService() ?? null,
    apnsService,
    apnsKeyStore,
    laneWorktreeLockService,
    ptyService,
    testService,
    reviewService,
    aiIntegrationService,
    agentChatService,
    issueInventoryService,
    pathToMergeOrchestrator,
    ctoStateService,
    workerAgentService,
    adeProjectService,
    workerBudgetService,
    workerRevisionService,
    githubService: headlessLinearServices.githubService,
    workerTaskSessionService: headlessLinearServices.workerTaskSessionService,
    workerHeartbeatService: headlessLinearServices.workerHeartbeatService,
    linearCredentialService: headlessLinearServices.linearCredentialService,
    linearOAuthService,
    prService: headlessLinearServices.prService,
    fileService: headlessLinearServices.fileService,
    flowPolicyService: headlessLinearServices.flowPolicyService,
    linearDispatcherService: headlessLinearServices.linearDispatcherService,
    linearIssueTracker: headlessLinearServices.linearIssueTracker,
    linearSyncService: headlessLinearServices.linearSyncService,
    linearIngressService: headlessLinearServices.linearIngressService,
    linearRoutingService: headlessLinearServices.linearRoutingService,
    processService,
    feedbackReporterService,
    usageTrackingService,
    budgetCapService,
    automationService,
    automationPlannerService,
    computerUseArtifactBrokerService,
    iosSimulatorService,
    appControlService,
    builtInBrowserService: builtInBrowserBridge,
    macosVmService,
    eventBuffer,
    dispose: () => {
      const swallow = (fn: () => void) => { try { fn(); } catch { /* ignore */ } };
      if (staleSessionReconcileTimer) {
        clearTimeout(staleSessionReconcileTimer);
      }
      void configReloadService.dispose().catch(() => {});
      swallow(() => automationService.dispose());
      swallow(() => usageTrackingService.dispose());
      swallow(() => apnsService.dispose());
      swallow(() => syncService?.dispose());
      swallow(() => pathToMergeOrchestrator.dispose());
      swallow(() => processService.disposeAll());
      swallow(() => runtimeDiagnosticsService.dispose());
      swallow(() => oauthRedirectService.dispose());
      void laneProxyService.dispose().catch(() => {});
      swallow(() => portAllocationService.dispose());
      swallow(() => iosSimulatorService?.dispose());
      swallow(() => appControlService?.dispose());
      swallow(() => builtInBrowserBridge?.dispose());
      swallow(() => macosVmService?.dispose());
      swallow(() => setMacosVmLaunchProvider(null));
      swallow(() => invalidateVmLaneLaunchCache());
      swallow(() => linearOAuthService.dispose());
      swallow(() => headlessLinearServices.dispose());
      swallow(() => agentChatService?.forceDisposeAll?.());
      swallow(() => testService.disposeAll());
      swallow(() => ptyService.disposeAll());
      swallow(() => processRegistry.stop());
      swallow(() => db.flushNow());
      swallow(() => db.close());
    }
  };

  const adeActionLookup: AutomationAdeActionRegistry = {
    isAllowed(domain: string, action: string): boolean {
      return isAllowedAdeAction(domain as AdeActionDomain, action);
    },
    getService(domain: string): Record<string, unknown> | null {
      const services = getAdeActionDomainServices(runtime);
      return (services[domain as AdeActionDomain] ?? null) as Record<string, unknown> | null;
    },
    listDomains(): string[] {
      return Object.keys(ADE_ACTION_ALLOWLIST);
    },
    listActions(domain: string): string[] {
      return [...(ADE_ACTION_ALLOWLIST[domain as AdeActionDomain] ?? [])];
    },
  };
  automationService.bindAdeActionRegistry(adeActionLookup);

  usageTrackingService.start();
  runtimeCreated = true;
  return runtime;
  } finally {
    if (!runtimeCreated) {
      if (staleSessionReconcileTimer) {
        clearTimeout(staleSessionReconcileTimer);
      }
      try {
        processRegistry.stop();
      } catch {
        // Preserve the original startup failure.
      }
    }
  }
}
