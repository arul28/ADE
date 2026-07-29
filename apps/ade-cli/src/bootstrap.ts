import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as nodePty from "node-pty";
import { isSourceCheckoutRuntimeModule } from "./runtimePackaging";
import { createFileLogger, type Logger } from "../../desktop/src/main/services/logging/logger";
import { classifySqliteOpenError, openKvDb, type AdeDb } from "../../desktop/src/main/services/state/kvDb";
import { createRegisteredSyncPeerGate } from "../../desktop/src/main/services/state/syncPeerCompactionGate";
import {
  clearLastFailure,
  recordLastFailure,
} from "../../desktop/src/main/services/runtime/lastFailureStore";
import { mapKvDbOpenErrorCode } from "../../desktop/src/shared/types/recovery";
import { detectDefaultBaseRef, toProjectInfo, upsertProjectRow } from "../../desktop/src/main/services/projects/projectService";
import { reseedAdeSkills } from "../../desktop/src/main/services/skills/skillReseedService";
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
import { createProjectSearchService } from "../../desktop/src/main/services/search/searchServiceWiring";
import type { SearchService } from "../../desktop/src/main/services/search/searchService";
import {
  createExternalSessionsService,
} from "../../desktop/src/main/services/externalSessions/externalSessionsService";
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
import { releaseLaneRuntimeResources } from "../../desktop/src/main/services/lanes/laneRuntimeLifecycle";
import { createOAuthRedirectService } from "../../desktop/src/main/services/lanes/oauthRedirectService";
import { createRuntimeDiagnosticsService } from "../../desktop/src/main/services/lanes/runtimeDiagnosticsService";
import { createRebaseSuggestionService } from "../../desktop/src/main/services/lanes/rebaseSuggestionService";
import { createAutoRebaseService } from "../../desktop/src/main/services/lanes/autoRebaseService";
import { createDiskPressureMonitor } from "../../desktop/src/main/services/storage/diskPressure";
import { createStorageInsightsService } from "../../desktop/src/main/services/storage/storageInsightsService";
import { augmentProcessPathWithShellAndKnownCliDirs, setPathEnvValue } from "../../desktop/src/main/services/ai/cliExecutableResolver";
import { createAgentChatService } from "../../desktop/src/main/services/chat/agentChatService";
import { createOrchestrationService } from "../../desktop/src/main/services/orchestration/orchestrationService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import {
  emitPrCardsForChange,
  type PrCardChange,
  type PrCardChatSink,
  type PrCardDataSource,
} from "../../desktop/src/main/services/prs/prChatCards";
import { createPrPollingService } from "../../desktop/src/main/services/prs/prPollingService";
import { createPrMergeAutoSettlementService } from "../../desktop/src/main/services/prs/prMergeAutoSettlementService";
import { createPrSummaryService } from "../../desktop/src/main/services/prs/prSummaryService";
import { createQueueLandingService } from "../../desktop/src/main/services/prs/queueLandingService";
import { createCtoStateService } from "../../desktop/src/main/services/cto/ctoStateService";
import { createCtoMemoryService } from "../../desktop/src/main/services/cto/ctoMemoryService";
import type { createLinearCredentialService } from "../../desktop/src/main/services/cto/linearCredentialService";
import { createLinearOAuthService } from "../../desktop/src/main/services/cto/linearOAuthService";
import type { createLinearIssueTracker } from "../../desktop/src/main/services/cto/linearIssueTracker";
import {
  createLinearChatLinkPublisher,
  publishLinearLaneCard,
} from "../../desktop/src/main/services/cto/linearLaneCardService";
import { createAiIntegrationService } from "../../desktop/src/main/services/ai/aiIntegrationService";
import { initApiKeyStore } from "../../desktop/src/main/services/ai/apiKeyStore";
import type { createSyncService } from "./services/sync/syncService";
import type { SharedSyncListener } from "./services/sync/sharedSyncListener";
import type { createSyncHostService, SyncRuntimeKind } from "./services/sync/syncHostService";
import { getSharedModelPickerStore } from "./services/modelPickerStore";
import { createAutomationIngressService, createKvIngressCursorStore } from "../../desktop/src/main/services/automations/automationIngressService";
import { createLinearAccessTokenGetter, createLinearIngressService } from "../../desktop/src/main/services/automations/linearIngressService";
import { buildLinearAutomationDispatches } from "../../desktop/src/main/services/automations/linearAutomationDispatch";
import { createAutomationSecretService } from "../../desktop/src/main/services/automations/automationSecretService";
import { createProjectSecretService } from "../../desktop/src/main/services/secrets/projectSecretService";
import type { createGithubService } from "../../desktop/src/main/services/github/githubService";
import { createFeedbackReporterService } from "../../desktop/src/main/services/feedback/feedbackReporterService";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  getAdeAgentSkillRootsForPrompt,
  joinAdeAgentSkillRoots,
  splitAdeAgentSkillRoots,
} from "../../desktop/src/shared/agentSkillRoots";
import { createUsageTrackingService } from "../../desktop/src/main/services/usage/usageTrackingService";
import { createBudgetCapService } from "../../desktop/src/main/services/usage/budgetCapService";
import {
  createProductAnalyticsService,
  defaultProductAnalyticsStateFile,
  getSharedProductAnalyticsService,
  type ProductAnalyticsService,
} from "../../desktop/src/main/services/analytics/productAnalyticsService";
import {
  createUsageProductAnalyticsExporter,
  type UsageProductAnalyticsExporter,
} from "../../desktop/src/main/services/analytics/usageProductAnalyticsExporter";
import {
  captureDailyUsageAnalytics,
  completedDailyUsageAnalyticsTarget,
} from "../../desktop/src/main/services/analytics/dailyUsageAnalytics";
import { captureAgentTurnSettledAnalytics } from "../../desktop/src/main/services/analytics/agentTurnProductAnalytics";
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
import type { BuiltInBrowserService } from "../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import {
  createBuiltInBrowserDesktopBridgeClient,
  verifyBuiltInBrowserDesktopBridgeAuth,
} from "./services/builtInBrowser/desktopBridgeClient";
import type { BuiltInBrowserDesktopBridgeClient } from "./services/builtInBrowser/desktopBridgeMethods";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import { createPushRegistrationStore } from "./services/push/pushRegistrationStore";
import { createPushRelayClient } from "./services/push/pushRelayClient";
import { getSharedPushPublisherService, resolvePushRelayStateFile, type PushPrNotification, type PushPublisherService } from "./services/push/pushPublisherService";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import type { AppNavigationRequest, AppNavigationResult, PortLease } from "../../desktop/src/shared/types";
import type { PrEventPayload } from "../../desktop/src/shared/types/prs";
import {
  createAutomationService,
  type AutomationAdeActionRegistry,
} from "../../desktop/src/main/services/automations/automationService";
import { createAutomationPlannerService } from "../../desktop/src/main/services/automations/automationPlannerService";
import {
  ADE_ACTION_ALLOWLIST,
  type AdeActionDomain,
  getAdeActionDomainServices,
  isAutomationAllowedAdeAction,
  isCtoOnlyAdeAction,
} from "../../desktop/src/main/services/adeActions/registry";
import { createLaneWorktreeLockService, type LaneWorktreeLockService } from "../../desktop/src/main/services/lanes/laneWorktreeLockService";
import { createHeadlessLinearServices } from "./headlessLinearServices";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import {
  getSignedInAccountAccessToken,
  type AccountAuthService,
} from "./services/account/accountAuthService";
import {
  getSharedAccountAuthService,
  registerAccountConfigProjectRoot,
} from "./services/account/sharedAccountAuthService";
import { createEventBuffer, type BufferedEvent, type EventBuffer } from "./eventBuffer";
import { createPrEventFanout } from "./prEventFanout";
import { readAutomationsEnvOverride } from "../../desktop/src/shared/automationAvailability";

declare const __ADE_VERSION__: string | undefined;

const BUNDLED_ADE_VERSION = typeof __ADE_VERSION__ === "string" ? __ADE_VERSION__.trim() : "";

export { createEventBuffer, type BufferedEvent, type EventBuffer };

export async function emitRuntimePrCardsForChanges(args: {
  changes: PrCardChange[];
  dataSource: PrCardDataSource;
  chat: Partial<PrCardChatSink> | null;
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  const { chat } = args;
  if (
    !chat
    || typeof chat.listSessions !== "function"
    || typeof chat.emitAdeCard !== "function"
  ) {
    return;
  }
  await Promise.all(args.changes.map(async (change) => {
    try {
      await emitPrCardsForChange({
        change,
        dataSource: args.dataSource,
        chat: chat as PrCardChatSink,
      });
    } catch (error) {
      args.logger.warn("prs.chat_card_emit_failed", {
        prId: change.pr.id,
        laneId: change.pr.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}

export type AdeRuntimePaths = {
  adeDir: string;
  logsDir: string;
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
  rosterProvider?: Parameters<typeof createSyncService>[0]["rosterProvider"];
  foreignChatProvider?: Parameters<typeof createSyncService>[0]["foreignChatProvider"];
  personalChatScope?: Parameters<typeof createSyncService>[0]["personalChatScope"];
  remoteCommandExecutor?: Parameters<typeof createSyncService>[0]["remoteCommandExecutor"];
  getAccountDirectoryHealth?: Parameters<typeof createSyncService>[0]["getAccountDirectoryHealth"];
  requestAccountMachinePublish?: () => void | Promise<void>;
  /**
   * Brain-level websocket listener shared by every project scope's sync host
   * so connected phones survive hosted-project switches. Owned (created and
   * closed) by the brain process, threaded through unchanged.
   */
  sharedSyncListener?: SharedSyncListener | null;
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
  projectSecretService?: ReturnType<typeof createProjectSecretService> | null;
  conflictService: ReturnType<typeof createConflictService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  diffService: ReturnType<typeof createDiffService>;
  ptyService: ReturnType<typeof createPtyService>;
  testService: ReturnType<typeof createTestService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  orchestrationService?: ReturnType<typeof createOrchestrationService> | null;
  prService?: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  fileService?: ReturnType<typeof createFileService> | null;
  ctoStateService: ReturnType<typeof createCtoStateService>;
  ctoMemoryService?: ReturnType<typeof createCtoMemoryService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearOAuthService?: ReturnType<typeof createLinearOAuthService> | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  githubService?: ReturnType<typeof createGithubService> | null;
  accountAuthService?: AccountAuthService | null;
  automationService?: ReturnType<typeof createAutomationService> | null;
  automationPlannerService?: ReturnType<typeof createAutomationPlannerService> | null;
  computerUseArtifactBrokerService: ComputerUseArtifactBrokerService;
  iosSimulatorService?: IosSimulatorService | null;
  appControlService?: AppControlService | null;
  builtInBrowserService?: BuiltInBrowserService | BuiltInBrowserDesktopBridgeClient | null;
  configureBuiltInBrowserDesktopBridgeAuth?: (authToken: string) => Promise<boolean>;
  syncHostService?: ReturnType<typeof createSyncHostService> | null;
  syncService?: ReturnType<typeof createSyncService> | null;
  pushPublisherService?: PushPublisherService | null;
  automationIngressService?: ReturnType<typeof createAutomationIngressService> | null;
  linearIngressService?: ReturnType<typeof createLinearIngressService> | null;
  feedbackReporterService?: ReturnType<typeof createFeedbackReporterService> | null;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  productAnalyticsService?: ProductAnalyticsService | null;
  usageProductAnalyticsExporter?: UsageProductAnalyticsExporter | null;
  storageInsightsService?: ReturnType<typeof createStorageInsightsService> | null;
  budgetCapService?: ReturnType<typeof createBudgetCapService> | null;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
  reviewService?: ReturnType<typeof createReviewService> | null;
  searchService?: SearchService | null;
  externalSessionsService?: ReturnType<typeof createExternalSessionsService> | null;
  autoUpdateService?: ReturnType<typeof createAutoUpdateService> | null;
  appNavigationService?: {
    navigate(args: AppNavigationRequest): Promise<AppNavigationResult>;
  } | null;
  eventBuffer: EventBuffer;
  isPackaged?: boolean;
  dispose: () => void;
};

export function ensureAdePaths(projectRoot: string): AdeRuntimePaths {
  const { paths } = initializeOrRepairAdeProject(projectRoot);
  return {
    adeDir: paths.adeDir,
    logsDir: paths.logsDir,
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

const currentModulePath =
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);

if (
  !isSourceCheckoutRuntimeModule(currentModulePath)
  && process.env.ADE_RUNTIME_PACKAGED === undefined
) {
  process.env.ADE_RUNTIME_PACKAGED = "1";
}

function automationsEnabledForHeadlessRuntime(): boolean {
  const override = readAutomationsEnvOverride(process.env);
  if (override !== null) return override;
  return true;
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

let adeSkillsReseededForCli = false;

/**
 * Materialize ADE's bundled `ade-*` skills into the home-level skill dirs every
 * runtime natively discovers, so agents ADE spawns pick them up via the runtime's
 * own progressive disclosure. Cheap no-op once on-disk copies are current;
 * best-effort so an unwritable home dir never blocks the CLI.
 */
export function reseedBundledAdeSkillsForCli(): void {
  if (adeSkillsReseededForCli) return;
  if (process.env.ADE_DISABLE_SKILL_RESEED === "1" || process.env.VITEST) return;
  adeSkillsReseededForCli = true;
  try {
    const bundledRoot = inferAgentSkillsRootForCliEntry(resolveCurrentAdeCliEntry());
    if (bundledRoot) reseedAdeSkills({ bundledRoot });
  } catch {
    /* best-effort: skill re-seeding must never break agent launch */
  }
}

function createHeadlessAdeCliAgentEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  reseedBundledAdeSkillsForCli();
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
  primaryWorktreePath?: string;
  chatRuntime?: "headless-stub" | "agent";
  runtimeProfile?: "full" | "chat";
  /** Disable project-oriented push/deep-link events for machine-scoped runtimes. */
  publishPushEvents?: boolean;
  syncRuntime?: AdeRuntimeSyncOptions;
} | string): Promise<AdeRuntime> {
  const resolvedArgs = typeof args === "string"
    ? { projectRoot: args, workspaceRoot: args }
    : args;
  const projectRoot = path.resolve(resolvedArgs.projectRoot);
  const workspaceRoot = path.resolve(resolvedArgs.workspaceRoot ?? resolvedArgs.projectRoot);
  const primaryWorktreePath = path.resolve(resolvedArgs.primaryWorktreePath ?? resolvedArgs.projectRoot);
  const chatOnlyRuntime = resolvedArgs.runtimeProfile === "chat";
  const publishPushEvents = resolvedArgs.publishPushEvents !== false;
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
  }
  if (!fs.existsSync(primaryWorktreePath) || !fs.statSync(primaryWorktreePath).isDirectory()) {
    throw new Error(`Primary worktree path does not exist: ${primaryWorktreePath}`);
  }

  const hadAdeDb = fs.existsSync(path.join(projectRoot, ".ade", "ade.db"));
  const baseRef = await detectDefaultBaseRef(projectRoot);
  const paths = ensureAdePaths(projectRoot);
  initApiKeyStore(projectRoot, { credentialStore: new EncryptedFileCredentialStore() });
  const logger = createFileLogger(path.join(paths.logsDir, "ade-cli.jsonl"));
  const diskPressureMonitor = createDiskPressureMonitor({
    roots: [projectRoot, resolveMachineAdeLayout().adeDir],
  });
  let syncService: ReturnType<typeof createSyncService> | null = null;
  const hasSyncPeers = createRegisteredSyncPeerGate({
    syncEnabled: resolvedArgs.syncRuntime?.enabled === true,
    getSyncService: () => syncService,
  });
  let db: AdeDb;
  try {
    db = await openKvDb(paths.dbPath, logger, {
      hasSyncPeers,
    });
  } catch (error) {
    const code = mapKvDbOpenErrorCode(classifySqliteOpenError(error));
    const detail = error instanceof Error ? error.message : String(error);
    const failure = {
      code,
      message: "ADE could not open the project data store.",
      detail,
      projectRoot,
      component: "project_db_open" as const,
    };
    recordLastFailure({ kind: "project", projectRoot }, failure);
    recordLastFailure({ kind: "machine" }, failure);
    throw error;
  }
  clearLastFailure({ kind: "project", projectRoot });

  const project = toProjectInfo(projectRoot, baseRef);
  const { projectId } = upsertProjectRow({
    db,
    repoRoot: projectRoot,
    displayName: project.displayName,
    baseRef
  });

  // Product analytics is machine-scoped and lazy: constructing the service
  // performs no network work, and a missing build token makes it a no-op. The
  // shared instance enforces one bounded daily budget across every project
  // scope in this process.
  const productAnalyticsStateFile = defaultProductAnalyticsStateFile(resolveMachineAdeLayout().adeDir);
  const productAnalyticsService = getSharedProductAnalyticsService(productAnalyticsStateFile, () =>
    createProductAnalyticsService({
      stateFilePath: productAnalyticsStateFile,
      logger,
      appVersion: process.env.ADE_CLI_VERSION?.trim() || BUNDLED_ADE_VERSION || "0.0.0",
      runtimeMode: resolvedArgs.syncRuntime?.runtimeKind ?? (chatOnlyRuntime ? "chat_runtime" : "project_runtime"),
    }));
  const usageProductAnalyticsExporter = createUsageProductAnalyticsExporter({
    db,
    analytics: productAnalyticsService,
    logger,
  });
  usageProductAnalyticsExporter.start();

  const operationService = createOperationService({ db, projectId });
  const keybindingsService = createKeybindingsService({ db });
  const eventBuffer = createEventBuffer();

  function pushEvent(category: BufferedEvent["category"], payload: Record<string, unknown>): void {
    eventBuffer.push({ timestamp: new Date().toISOString(), category, payload });
  }

  let conflictServiceRef: ReturnType<typeof createConflictService> | null = null;
  let rebaseSuggestionServiceRef: ReturnType<typeof createRebaseSuggestionService> | null = null;
  let autoRebaseServiceRef: ReturnType<typeof createAutoRebaseService> | null = null;
  const searchServiceHolder: { current: SearchService | null } = { current: null };
  let linearIssueTrackerRef: ReturnType<typeof createLinearIssueTracker> | null = null;
  let githubServiceRef: ReturnType<typeof createGithubService> | null = null;
  let laneServiceRef: ReturnType<typeof createLaneService> | null = null;
  let prServiceRef: ReturnType<typeof createPrService> | null = null;
  const publishLinearChatLink = createLinearChatLinkPublisher({
    getIssueTracker: () => linearIssueTrackerRef,
    resolveEnvelope: async ({ laneId }) => {
      const repo = await githubServiceRef?.getRepoOrThrow().catch(() => null);
      if (!repo) return null;
      const lanes = await laneServiceRef?.list({ includeArchived: false, includeStatus: false }).catch(() => []);
      const lane = lanes?.find((candidate) => candidate.id === laneId) ?? null;
      const branch = lane?.branchRef?.replace(/^refs\/heads\//, "") ?? null;
      const pr = prServiceRef?.getForLane(laneId) ?? null;
      return {
        repoOwner: repo.owner,
        repoName: repo.name,
        branch,
        prNumber: pr?.githubPrNumber ?? null,
      };
    },
    log: (event, fields) => logger.warn(event, fields),
  });
  const laneTeardownDeps: LaneDeleteTeardownDeps = {};
  let autoRebaseActivityReady = false;

  const laneService = createLaneService({
    db,
    projectRoot,
    primaryWorktreePath,
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
    onLifecycleEvent: (event) => {
      pushEvent("runtime", { type: "lane_lifecycle_event", event });
      if (event.laneId) searchServiceHolder.current?.notifyLaneActivity(event.laneId);
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
          prNumber: prServiceRef?.getForLane(lane.id)?.githubPrNumber ?? null,
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
  laneServiceRef = laneService;
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
      logger,
    });
    const projectSecretService = createProjectSecretService(projectRoot);
    registerAccountConfigProjectRoot(projectRoot);
    const accountAuthService = getSharedAccountAuthService({
      projectRoots: () => [projectRoot],
      logger,
    });
    const getAccountAccessToken = (
      options?: Parameters<typeof getSignedInAccountAccessToken>[1],
    ) => getSignedInAccountAccessToken(accountAuthService, options);
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
  // The sync runtime is created after ptyService (it takes ptyService as a
  // dependency), so live PTY forwarding binds late through this ref — same
  // pattern as desktop main. Without this bridge, paired phones only ever
  // receive terminal snapshots, never live terminal_data push.
  let syncServiceForPtyEvents: ReturnType<typeof createSyncService> | null = null;
  // Same late-binding for the push publisher: it feeds tracked CLI runtime
  // states (running / waiting-input from OSC 133 markers) into the phone's
  // Live Activity, and it's constructed after ptyService.
  let pushPublisherForPtySignals: PushPublisherService | null = null;
  const ptyService = createPtyService({
    projectRoot,
    transcriptsDir: paths.transcriptsDir,
    laneService,
    sessionService,
    processRegistry,
    aiIntegrationService,
    projectConfigService,
    logger,
    broadcastData: (event) => {
      pushEvent("pty", { type: "pty_data", event });
      searchServiceHolder.current?.notifyTerminalData(event.sessionId);
      const { projectRoot: _projectRoot, ...syncEvent } = event;
      syncServiceForPtyEvents?.handlePtyData(syncEvent);
    },
    broadcastExit: (event) => {
      pushEvent("pty", { type: "pty_exit", event });
      const { projectRoot: _projectRoot, ...syncEvent } = event;
      syncServiceForPtyEvents?.handlePtyExit(syncEvent);
    },
    onSessionRuntimeSignal: (signal) => {
      pushPublisherForPtySignals?.handleCliRuntimeSignal(projectId, {
        laneId: signal.laneId,
        sessionId: signal.sessionId,
        runtimeState: signal.runtimeState,
      });
    },
    onSessionUserInput: ({ sessionId }) => {
      pushPublisherForPtySignals?.handleSessionAttentionResolved(projectId, sessionId);
    },
    diskPressureMonitor,
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
  const laneWorktreeLockService = createLaneWorktreeLockService({ db, logger });

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

  const ctoMemoryService = createCtoMemoryService({
    adeDir: paths.adeDir,
    logger,
  });
  const ctoStateService = createCtoStateService({
    db,
    projectId,
    adeDir: paths.adeDir,
    ctoMemoryService,
  });
  const adeProjectService = createAdeProjectService({
    projectRoot,
    db,
    projectId,
    logger,
    projectConfigService,
    ctoStateService,
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
  // `built_in_browser` is hosted by the desktop's Electron main process (the
  // browser pane owns a WebContentsView). The runtime daemon proxies calls
  // through `<adeHome>/sock/desktop-bridge.sock`; if no desktop is running,
  // individual calls fail clearly. Override the socket path with
  // `ADE_DESKTOP_BRIDGE_SOCKET_PATH` for dev launches that use a non-default
  // ADE home.
  let builtInBrowserBridgeAuthToken: string | null = null;
  const builtInBrowserBridgeSocketPath =
    process.env.ADE_DESKTOP_BRIDGE_SOCKET_PATH?.trim()
    || resolveMachineAdeLayout().desktopBridgeSocketPath;
  const builtInBrowserBridge: BuiltInBrowserDesktopBridgeClient | null = chatOnlyRuntime
    ? null
    : createBuiltInBrowserDesktopBridgeClient({
        socketPath: builtInBrowserBridgeSocketPath,
        getAuthToken: () => builtInBrowserBridgeAuthToken,
        projectRoot,
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
    openExternal: async () => {},
    onGitHubStatusChanged: (status) =>
      pushEvent("runtime", { type: "github_status_changed", event: status }),
    getAccountAccessToken,
  });
  linearIssueTrackerRef = headlessLinearServices.linearIssueTracker;
  githubServiceRef = headlessLinearServices.githubService as ReturnType<typeof createGithubService>;
  prServiceRef = headlessLinearServices.prService;
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

  const orchestrationService = createOrchestrationService({
    resolveLaneWorktree: (laneId: string): string | undefined => {
      try {
        return laneService.getLaneWorktreePath(laneId);
      } catch {
        return undefined;
      }
    },
  });
  orchestrationService.on("event", (payload) => {
    pushEvent("orchestrator", payload as unknown as Record<string, unknown>);
  });

  let agentChatService = headlessLinearServices.agentChatService as unknown as ReturnType<typeof createAgentChatService> | null;
  if (resolvedArgs.chatRuntime === "agent") {
    agentChatService = createAgentChatService({
      getOrchestrationService: () => orchestrationService,
      projectRoot,
      adeDir: paths.adeDir,
      transcriptsDir: paths.transcriptsDir,
      fileService: headlessLinearServices.fileService,
      linearIssueTracker: headlessLinearServices.linearIssueTracker,
      githubService: headlessLinearServices.githubService,
      linearClient: headlessLinearServices.linearClient,
      linearCredentials: headlessLinearServices.linearCredentialService,
      prService: headlessLinearServices.prService,
      diskPressureMonitor,
      getTestService: () => testService,
      ptyService,
      getAutomationService: () => automationServiceRef,
      getGitService: () => gitService,
      conflictService,
      computerUseArtifactBrokerService,
      laneService,
      sessionService,
      processRegistry,
      projectConfigService,
      db,
      aiIntegrationService,
      ctoStateService,
      ctoMemoryService,
      logger,
      appVersion: "ade-cli",
      getAdeCliAgentEnv: createHeadlessAdeCliAgentEnv,
      getLocalGitHubToken: () => headlessLinearServices.githubService.getTokenOrThrowAsync(),
      onLinearIssueChatLinked: publishLinearChatLink,
      onEvent: (event) => {
        pushEvent("runtime", event as unknown as Record<string, unknown>);
      },
      onTurnSettled: (event) => captureAgentTurnSettledAnalytics({
        analytics: productAnalyticsService,
        projectId,
        event,
      }),
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
  autoRebaseActivityReady = true;
  void autoRebaseService
    .refreshActiveRebaseNeeds("activity_services_ready")
    .catch((error) => {
      logger.warn("autoRebase.activity_ready_refresh_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
        prService: headlessLinearServices.prService,
        onEvent: (event) => pushEvent("runtime", { type: "review_event", event }),
      })
    : null;
  const automationFeatureEnabled = automationsEnabledForHeadlessRuntime();
  const automationService = automationFeatureEnabled
    ? createAutomationService({
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
      })
    : null;
  automationServiceRef = automationService;
  const automationSecretService = createAutomationSecretService({
    adeDir: paths.adeDir,
    logger,
  });
  // The ingress runs even when the automations feature is unavailable: its
  // GitHub relay poll feeds prService.ingestGithubWebhook, which is how
  // webhook-driven PR state updates reach installed (non-source) runtimes.
  // Automation rule dispatch stays gated on automationService being present.
  // The PR poller is constructed below; bind it before starting ingress so
  // webhook deliveries can schedule targeted PR reconciliation immediately.
  let prPollingServiceForIngress: { reconcilePrs: (prIds: string[]) => void } | null = null;
  const automationIngressService = createAutomationIngressService({
    logger,
    automationService,
    prService: headlessLinearServices.prService,
    onPrStateIngested: (prIds) => prPollingServiceForIngress?.reconcilePrs(prIds),
    secretService: automationSecretService,
    githubService: headlessLinearServices.githubService,
    getAccountAccessToken,
    listRules: () => (automationService ? projectConfigService.get().effective.automations ?? [] : []),
    ingressCursorStore: createKvIngressCursorStore(db),
    // 30s halves worst-case webhook latency. Each poll is one request to our
    // own relay worker (no GitHub data cost); the service floors at 30s.
    pollIntervalMs: 30_000,
  });
  const linearIngressService = automationService
    ? createLinearIngressService({
        db,
        projectId,
        credentialStore: new EncryptedFileCredentialStore({
          secretsDir: path.join(paths.adeDir, "secrets"),
        }),
        getLinearClient: () => headlessLinearServices.linearClient,
        getLinearAccessToken: createLinearAccessTokenGetter(headlessLinearServices.linearCredentialService),
        getAccountAccessToken,
        cursorStore: createKvIngressCursorStore(db),
        hasEnabledLinearRules: () => automationService?.hasEnabledLinearRules() ?? false,
        isAdeAppConnection: () => {
          const credentials = headlessLinearServices.linearCredentialService;
          return credentials.getStatus().authMode === "oauth"
            && credentials.getOAuthClientSource() === "ade-app";
        },
        dispatch: async (record) => {
          if (!automationService) return;
          // Rule dispatch is awaited so the relay cursor only advances once
          // every trigger for the delivery has been handed to the engine; a
          // failing rule logs and never wedges polling.
          await Promise.all(buildLinearAutomationDispatches(record).map((dispatch) =>
            automationService!.dispatchIngressTrigger(dispatch).catch((error) => {
              logger.warn("automations.linear_relay_dispatch_failed", {
                eventId: record.eventId,
                error: error instanceof Error ? error.message : String(error),
              });
            }),
          ));
        },
        logger,
      })
    : null;
  if (linearIngressService) {
    // Availability keys off configuration, not the enabled-rule-dependent
    // status.state ("disabled" while no Linear rule is enabled would make
    // enabling the first Linear rule impossible).
    automationService?.setLinearIngressAvailable(() => {
      const status = linearIngressService.getStatus();
      // App-connected workspaces are available before first setup: events
        // already reach the relay, and enabling the first linear.* rule is
        // what triggers the self-configuring poll.
        return Boolean(status.appManaged || (status.webhookId && status.organizationId && !status.lastError));
    });
    linearIngressService.start();
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
    logger,
    onEvent: (event) => pushEvent("runtime", { type: "project_state_event", event }),
  });
  void configReloadService.start().catch((error) => {
    logger.warn("project.config_reload_start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const automationPlannerService = automationFeatureEnabled && automationService
    ? createAutomationPlannerService({
        logger,
        projectRoot,
        projectConfigService,
        laneService,
        automationService,
      })
    : null;

  // PR queue-landing + AI-summary services. These live on dedicated services
  // (not on prService), so without wiring them here the runtime `pr` domain
  // omits `listQueueStates`/queue-automation/summary actions and the desktop's
  // `pr.listQueueStates` call over the local runtime fails with "is not
  // callable". Mirror the desktop main-process wiring (see main.ts) so the PRs
  // tab loads against the local runtime.
  // Fan-out for the push publisher: PR lifecycle/status notifications are
  // bridged here so the publisher never has to poll GitHub itself. Populated
  // by pushPublisherService.start() (declared below), so it stays empty and inert
  // when push publishing is not running.
  const pushPrNotificationSubscribers = new Set<(notification: PushPrNotification) => void>();
  let syncService: ReturnType<typeof createSyncService> | null = null;
  const emitPrEvent = (event: PrEventPayload): void => {
    pushEvent("runtime", { type: "pr_event", event });
    if (event.type === "prs-updated") {
      syncService?.notifyPrsUpdated();
    }
    if (event.type === "pr-notification" && pushPrNotificationSubscribers.size > 0) {
      const notification: PushPrNotification = {
        kind: event.kind,
        prId: event.prId,
        prNumber: event.prNumber,
        prTitle: event.prTitle ?? null,
        laneId: event.laneId ?? null,
        repoOwner: event.repoOwner ?? null,
        repoName: event.repoName ?? null,
      };
      for (const subscriber of pushPrNotificationSubscribers) {
        try {
          subscriber(notification);
        } catch {
          // ignore subscriber failures
        }
      }
    }
  };
  const queueLandingService = createQueueLandingService({
    db,
    logger,
    projectId,
    prService: headlessLinearServices.prService,
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
        headlessLinearServices.prService.markHotRefresh(Array.from(hotPrIds));
      }
    },
  });
  queueLandingService.init();
  const prSummaryService = createPrSummaryService({
    db,
    logger,
    projectRoot,
    prService: headlessLinearServices.prService,
    aiIntegrationService,
  });
  const prMergeAutoSettlementService = agentChatService
    ? createPrMergeAutoSettlementService({
        db,
        sessionService,
        agentChatService,
        emitEvent: emitPrEvent,
      })
    : null;

  // GitHub polling fallback. Runtime-bound desktop windows route PR reads to
  // this daemon instead of the desktop main process, so the daemon must own
  // the background polling loop that emits `prs-updated` — otherwise PR state
  // only refreshes when a surface happens to issue a direct read.
  const prPollingService = createPrPollingService({
    logger,
    prService: headlessLinearServices.prService,
    projectConfigService,
    db,
    onEvent: emitPrEvent,
    onPullRequestsSnapshot: (snapshot) =>
      prMergeAutoSettlementService?.processSnapshot(snapshot),
    onPullRequestsChanged: async ({ changedPrs, changes }) => {
      if (changedPrs.length > 0) {
        // Poll results must not start another hot-refresh window; doing so
        // turns active CI into an unbounded high-frequency GitHub API loop.
        for (const pr of changedPrs) searchServiceHolder.current?.notifyPrChanged(pr.id);
      }
      for (const { pr, previousState, previousChecksStatus, previousReviewStatus } of changes) {
        automationService?.onPullRequestChanged?.({
          pr,
          previousState,
          previousChecksStatus,
          previousReviewStatus,
        });
      }
      await emitRuntimePrCardsForChanges({
        changes,
        dataSource: headlessLinearServices.prService,
        chat: agentChatService,
        logger,
      });
    },
  });
  prPollingService.start();
  prPollingServiceForIngress = prPollingService;
  void automationIngressService.start().catch((error) => {
    logger.warn("automations.ingress_start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Brain → Cloudflare push relay publisher. Owns push registration (from the
  // paired phone via `push.*` sync commands) and fans agent/PR state transitions
  // out as APNs alerts + the aggregate "agent-runs" Live Activity. Machine-level
  // identity lives next to the sync pairing secrets under ~/.ade/secrets.
  // One machine-level publisher shared by every project scope (keyed by the
  // push-identity file), so a run in one project doesn't clobber the phone's
  // single "agent-runs" Live Activity for another. Each scope wires its own
  // chat/pty/PR signals via attachSources; the aggregate merges runs across all.
  // This is also the canonical account-directory identity used to route an
  // Attention click back to this exact machine, even when another machine has
  // a project at the same path.
  const { createSyncCloudRelayStore } = await import("./services/sync/syncCloudRelayStore");
  const cloudRelayFilePath = path.join(
    resolvedArgs.syncRuntime?.phonePairingStateDir ?? resolveMachineAdeLayout().secretsDir,
    "sync-cloud-relay.json",
  );
  const cloudRelayStore = createSyncCloudRelayStore({ filePath: cloudRelayFilePath });
  const syncDeviceIdPath = path.join(
    resolvedArgs.syncRuntime?.phonePairingStateDir ?? resolveMachineAdeLayout().secretsDir,
    "sync-device-id",
  );
  const pushRelayFilePath = resolvePushRelayStateFile(resolveMachineAdeLayout().secretsDir);
  const pushPublisherService = getSharedPushPublisherService(pushRelayFilePath, () => {
    const store = createPushRegistrationStore({ filePath: pushRelayFilePath });
    return {
      logger,
      store,
      relayClient: createPushRelayClient({
        store,
        logger,
        getAccountAccessToken,
        getAccountUserId: () => {
          const status = accountAuthService.getStatus();
          return status.signedIn ? status.userId?.trim() || null : null;
        },
      }),
      machineName: os.hostname(),
      getAccountOwnerId: () => {
        const status = accountAuthService.getStatus();
        return status.signedIn ? status.userId?.trim() || null : null;
      },
      getAccountMachineIdentity: () => {
        const { machineKey } = cloudRelayStore.getMachineIdentity();
        let deviceId: string | null = null;
        try {
          deviceId = fs.readFileSync(syncDeviceIdPath, "utf8").trim() || null;
        } catch {
          deviceId = null;
        }
        return { machineKey, deviceId };
      },
    };
  });
  const detachPushSources = publishPushEvents
    ? pushPublisherService.attachSources(projectId, {
        // The lightweight no-agent headless chat stub intentionally exposes
        // only its request/response surface. Do not treat it as an event
        // source unless it implements the full subscription contract.
        agentChatService: typeof agentChatService?.subscribeToEvents === "function"
          ? agentChatService
          : null,
        ptyService,
        projectName: project.displayName,
        projectRoot,
        subscribePrNotifications: (cb) => {
          pushPrNotificationSubscribers.add(cb);
          return () => pushPrNotificationSubscribers.delete(cb);
        },
        resolveLaneName: (laneId) => {
          try {
            const row = db.get<{ name: string }>(
              "select name from lanes where id = ? and project_id = ? limit 1",
              [laneId, projectId],
            );
            return row?.name ?? null;
          } catch {
            return null;
          }
        },
        resolveCliSession: (sessionId) => {
          try {
            const session = sessionService.get(sessionId);
            if (!session) return null;
            return {
              title: session.title ?? null,
              toolType: session.toolType ?? null,
              chatSessionId: session.chatSessionId ?? null,
            };
          } catch {
            return null;
          }
        },
      })
    : () => {};
  if (publishPushEvents) {
    pushPublisherForPtySignals = pushPublisherService;
    void pushPublisherService.start().catch((error) => {
      logger.warn("push.start_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  let lastDailyAnalyticsDay: string | null = null;
  let dailyAnalyticsInFlight: Promise<void> | null = null;
  let usageTrackingService: ReturnType<typeof createUsageTrackingService>;
  usageTrackingService = createUsageTrackingService({
    logger,
    db,
    pollIntervalMs: 120_000,
    onUpdate: (snapshot) => {
      pushEvent("runtime", { type: "usage", snapshot });
      if (!productAnalyticsService.getStatus().effective || dailyAnalyticsInFlight) return;
      const target = completedDailyUsageAnalyticsTarget();
      if (!target || lastDailyAnalyticsDay === target.day) return;
      const current = Promise.resolve()
        .then(async () => {
          // Report the last completed local day. Capturing the in-progress
          // "today" bucket on the first poll systematically missed providers,
          // models, and actions used later in the day.
          const stats = await usageTrackingService.getAdeUsageStats({
            preset: "today",
            until: target.occurredAt,
            scope: "project",
          });
          captureDailyUsageAnalytics({
            analytics: productAnalyticsService,
            stats,
            projectId,
            reportDay: target.day,
            occurredAt: target.occurredAt,
          });
          lastDailyAnalyticsDay = target.day;
        })
        .catch((error) => {
          logger.debug("product_analytics.daily_summary_failed", {
            errorKind: error instanceof Error ? error.name : "unknown",
          });
        })
        .finally(() => {
          if (dailyAnalyticsInFlight === current) dailyAnalyticsInFlight = null;
        });
      dailyAnalyticsInFlight = current;
    },
    projectRoot,
  });
  const storageInsightsService = createStorageInsightsService({
    projectRoot,
    adeHome: resolveMachineAdeLayout().adeDir,
    db,
    logger,
    diskPressure: diskPressureMonitor,
    isPathActive: (filePath) =>
      Boolean(agentChatService?.isTranscriptPathActive(filePath))
      || ptyService.isTranscriptPathActive(filePath)
      || Boolean(iosSimulatorService?.isBuildPathActive(filePath)),
    projectId,
    laneService,
    projectConfigService,
    releaseLaneRuntimeResources: (laneId) => {
      releaseLaneRuntimeResources({ portAllocationService, laneProxyService }, laneId);
    },
    // One bounded `ade_feature_used` per completed maintenance run at the daemon
    // boundary (deduped to 20 h by the service).
    captureAnalytics: (input) => {
      productAnalyticsService.capture(input);
    },
  // Removing proof files from Settings must drop their records too,
  // otherwise the drawer keeps listing items whose bytes are gone.
  purgeProofRecordsUnder: (removedPath) => {
    computerUseArtifactBrokerService.purgeArtifactRecordsUnder(removedPath);
  },
  });
  const budgetCapService = createBudgetCapService({
    db,
    logger,
    projectConfigService,
    usageTrackingService,
  });
  // Cloud tunnel relay (phone → Cloudflare DO → this brain). The store
  // instance is shared with the sync service so the relay candidate in
  // pairingConnectInfo and the tunnel client use one machine identity.
  const { createSyncTunnelClientService, getSharedSyncTunnelClientService } = await import("./services/sync/syncTunnelClientService");
  // ONE tunnel client per machine (keyed by the config file): per-scope
  // instances would re-register the same machineKey with the relay on every
  // project open and churn the connection paired phones dial through.
  const syncTunnelClientService = getSharedSyncTunnelClientService(cloudRelayFilePath, () => {
    const service = createSyncTunnelClientService({
      logger,
      configStore: cloudRelayStore,
      isAccountSignedIn: () => {
        const status = accountAuthService.getStatus();
        return status.signedIn && Boolean(status.userId?.trim());
      },
      getAccountLease: async () => {
        const status = accountAuthService.getStatus();
        const userId = status.signedIn ? status.userId?.trim() || null : null;
        if (!userId) return null;
        const token = (await accountAuthService.getAccessToken()).trim();
        const refreshed = accountAuthService.getStatus();
        return token && refreshed.signedIn && refreshed.userId?.trim() === userId
          ? { userId, expiresAt: refreshed.expiresAt }
          : null;
      },
      onPublicationStateChanged: () => {
        // Relay state changes are machine-level; without this nudge an idle
        // machine emits no sync-status snapshot and the desktop relay banner
        // never appears (or never clears).
        syncService?.notifyRouteStateChanged();
        resolvedArgs.syncRuntime?.requestAccountMachinePublish?.();
      },
      // The analytics service is machine-scoped and shared, so capturing it in
      // this one-per-machine factory closure is safe (unlike the listener
      // accessors above, which is why those moved to attachHostListener).
      captureAnalytics: (input) => {
        productAnalyticsService.captureInternal(input);
      },
    });
    return service;
  });
  // Bind the listener OUTSIDE the factory. The client is cached one-per-machine
  // and built by whichever runtime bootstrapped first, which is regularly a
  // scope with no listener (headless one-shot, embedded fallback). Everything
  // captured in that factory — the port accessor and the loopback retry hook —
  // then pointed at null for the life of the process, so the bridge could never
  // validate and Relay stayed fail-closed even though the listener was up.
  // Attaching here means the runtime that actually owns the listener wins,
  // whether or not it was the one that created the instance.
  if (resolvedArgs.syncRuntime?.sharedSyncListener) {
    syncTunnelClientService.attachHostListener(resolvedArgs.syncRuntime.sharedSyncListener);
  }
  // Only the runtime that holds the machine-wide sync host lease may register
  // the relay tunnel. See relayTunnelAuthorityGate for why the old
  // "has a listener" gate let secondary brains evict the real host.
  const [{ createRelayTunnelAuthorityGate }, { holdsSyncHostSingleton, onSyncHostSingletonAuthorityChanged }] =
    await Promise.all([
      import("./services/sync/relayTunnelAuthorityGate"),
      import("./services/sync/syncHostSingleton"),
    ]);
  const relayTunnelGate = createRelayTunnelAuthorityGate({
    hostListener: resolvedArgs.syncRuntime?.sharedSyncListener ?? null,
    tunnel: syncTunnelClientService,
    holdsLease: holdsSyncHostSingleton,
    subscribe: onSyncHostSingletonAuthorityChanged,
    logger,
  });

  let externalSessionsService: ReturnType<typeof createExternalSessionsService> | null = null;
  if (resolvedArgs.syncRuntime?.enabled && agentChatService) {
    const { createSyncService } = await import("./services/sync/syncService");
    syncService = createSyncService({
      db,
      usageTrackingService,
      productAnalyticsService,
      logger,
      getAccountDirectoryHealth: resolvedArgs.syncRuntime.getAccountDirectoryHealth,
      requestAccountMachinePublish: resolvedArgs.syncRuntime.requestAccountMachinePublish,
      accountAuthService,
      projectId: resolvedArgs.syncRuntime.registryProjectId ?? projectId,
      runtimeProjectId: projectId,
      projectRoot,
      appVersion: resolvedArgs.syncRuntime.appVersion ?? "ade-cli",
      runtimeKind: resolvedArgs.syncRuntime.runtimeKind ?? "headless",
      localDeviceIdPath: resolvedArgs.syncRuntime.localDeviceIdPath,
      phonePairingStateDir: resolvedArgs.syncRuntime.phonePairingStateDir,
      fileService: headlessLinearServices.fileService,
      laneService,
      gitService,
      githubService: headlessLinearServices.githubService,
      diffService,
      conflictService,
      operationService,
      prService: headlessLinearServices.prService,
      prSummaryService,
      queueLandingService,
      sessionService,
      sessionDeltaService,
      ptyService,
      aiIntegrationService,
      orchestrationService,
      projectConfigService,
      portAllocationService,
      laneEnvironmentService,
      laneTemplateService,
      rebaseSuggestionService,
      autoRebaseService,
      computerUseArtifactBrokerService,
      agentChatService,
      pushPublisherService,
      ctoStateService,
      ctoMemoryService,
      linearCredentialService: headlessLinearServices.linearCredentialService,
      linearOAuthService,
      getLinearIssueTracker: () => headlessLinearServices.linearIssueTracker,
      getExternalSessionsService: () => externalSessionsService,
      sharedSyncListener: resolvedArgs.syncRuntime.sharedSyncListener ?? null,
      hostStartupEnabled: resolvedArgs.syncRuntime.hostStartupEnabled ?? true,
      hostDiscoveryEnabled: resolvedArgs.syncRuntime.hostDiscoveryEnabled ?? true,
      forceHostRole: resolvedArgs.syncRuntime.forceHostRole ?? false,
      projectCatalogProvider: resolvedArgs.syncRuntime.projectCatalogProvider,
      rosterProvider: resolvedArgs.syncRuntime.rosterProvider,
      foreignChatProvider: resolvedArgs.syncRuntime.foreignChatProvider,
      personalChatScope: resolvedArgs.syncRuntime.personalChatScope,
      remoteCommandExecutor: resolvedArgs.syncRuntime.remoteCommandExecutor,
      getModelPickerStore: () => getSharedModelPickerStore(db),
      cloudRelayStore,
      syncTunnelClientService,
      onStatusChanged: (snapshot) => {
        pushEvent("runtime", { type: "sync-status", snapshot });
      },
    });
    syncServiceForPtyEvents = syncService;
  }

  if (syncService) {
    const currentSyncService = syncService;
    const initializeSyncService = async () => {
      try {
        await currentSyncService.initialize();
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

  const searchService = createProjectSearchService({
    cacheDir: paths.cacheDir,
    transcriptsDir: paths.transcriptsDir,
    chatTranscriptsDir: paths.chatTranscriptsDir,
    logger,
    sessionService,
    laneService,
    agentChatService,
    prService: headlessLinearServices.prService ?? null,
    gitService,
    repoSlug: async () => {
      const status = await headlessLinearServices.githubService.getRemoteStatus().catch(() => ({ repo: null }));
      return status.repo ?? null;
    },
    fileService: headlessLinearServices.fileService ?? null,
    artifactBroker: computerUseArtifactBrokerService,
    linearIssueTracker: headlessLinearServices.linearIssueTracker ?? null,
    backfillDelayMs: 5_000,
  });
  searchServiceHolder.current = searchService;
  headlessLinearServices.prService?.setEventEmitter(createPrEventFanout(
    emitPrEvent,
    (event) => {
      if (event.type === "prs-updated") {
        for (const pr of event.prs) searchService.notifyPrChanged(pr.id);
      }
    },
  ));
  const agentChatImportedRefsSource = agentChatService;
  const chatImportedRefsProvider = agentChatImportedRefsSource
    ? async () => {
        const sessions = await agentChatImportedRefsSource.listSessions(undefined, {
          includeIdentity: true,
          includeAutomation: true,
          includeArchived: true,
        });
        return sessions.flatMap((session) => {
          const importedFrom = session.importedFrom;
          if (!importedFrom?.provider?.trim() || !importedFrom.sessionId?.trim()) return [];
          return [{
            provider: importedFrom.provider,
            externalId: importedFrom.sessionId,
            chatSessionId: session.sessionId,
          }];
        });
      }
    : undefined;
  externalSessionsService = createExternalSessionsService({
    projectRoot,
    laneService,
    sessionService,
    ptyService,
    logger,
    chatImporter: agentChatService,
    ...(chatImportedRefsProvider ? { chatImportedRefsProvider } : {}),
  });

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
    projectSecretService,
    conflictService,
    gitService,
    diffService,
    syncService,
    pushPublisherService,
    syncHostService: syncService?.getHostService() ?? null,
    laneWorktreeLockService,
    ptyService,
    testService,
    reviewService,
    searchService,
    externalSessionsService,
    aiIntegrationService,
    agentChatService,
    orchestrationService,
    ctoStateService,
    ctoMemoryService,
    adeProjectService,
    githubService: headlessLinearServices.githubService,
    accountAuthService,
    linearCredentialService: headlessLinearServices.linearCredentialService,
    linearOAuthService,
    prService: headlessLinearServices.prService,
    queueLandingService,
    prSummaryService,
    fileService: headlessLinearServices.fileService,
    linearIssueTracker: headlessLinearServices.linearIssueTracker,
    feedbackReporterService,
    usageTrackingService,
    productAnalyticsService,
    usageProductAnalyticsExporter,
    storageInsightsService,
    budgetCapService,
    automationService,
    automationIngressService,
    linearIngressService,
    automationPlannerService,
    computerUseArtifactBrokerService,
    iosSimulatorService,
    appControlService,
    builtInBrowserService: builtInBrowserBridge,
    configureBuiltInBrowserDesktopBridgeAuth: async (authToken: string) => {
      if (!builtInBrowserBridge) return false;
      const verified = await verifyBuiltInBrowserDesktopBridgeAuth({
        socketPath: builtInBrowserBridgeSocketPath,
        authToken,
      });
      if (verified) builtInBrowserBridgeAuthToken = authToken.trim();
      return verified;
    },
    eventBuffer,
    isPackaged: !isSourceCheckoutRuntimeModule(currentModulePath),
    dispose: () => {
      const swallow = (fn: () => void) => { try { fn(); } catch { /* ignore */ } };
      if (staleSessionReconcileTimer) {
        clearTimeout(staleSessionReconcileTimer);
      }
      void configReloadService.dispose().catch(() => {});
      swallow(() => prPollingService.dispose());
      // Detach only this scope's signals; the shared publisher outlives the scope.
      swallow(() => detachPushSources());
      // The tunnel client is machine-level and shared across scopes — closing
      // one project must not sever the relay for the others. The daemon's
      // shutdown path (disposeServeResources) stops it. Drop only THIS scope's
      // lease subscription, or a disposed scope could later stop the shared
      // tunnel on a lease transition it no longer has any business observing.
      swallow(() => relayTunnelGate.dispose());
      swallow(() => automationIngressService?.dispose());
      swallow(() => linearIngressService?.stop());
      swallow(() => automationService?.dispose());
      swallow(() => usageTrackingService.dispose());
      swallow(() => usageProductAnalyticsExporter.stop());
      swallow(() => storageInsightsService.dispose());
      swallow(() => syncService?.dispose());
      swallow(() => runtimeDiagnosticsService.dispose());
      swallow(() => oauthRedirectService.dispose());
      void laneProxyService.dispose().catch(() => {});
      void orchestrationService?.dispose().catch(() => {});
      swallow(() => portAllocationService.dispose());
      swallow(() => iosSimulatorService?.dispose());
      swallow(() => appControlService?.dispose());
      swallow(() => builtInBrowserBridge?.dispose());
      swallow(() => linearOAuthService.dispose());
      swallow(() => headlessLinearServices.dispose());
      swallow(() => agentChatService?.forceDisposeAll?.());
      swallow(() => testService.disposeAll());
      swallow(() => ptyService.disposeAll());
      swallow(() => searchService.dispose());
      swallow(() => processRegistry.stop());
      swallow(() => db.flushNow());
      swallow(() => db.close());
    }
  };

  const adeActionLookup: AutomationAdeActionRegistry = {
    isAllowed(domain: string, action: string): boolean {
      return isAutomationAllowedAdeAction(domain as AdeActionDomain, action);
    },
    getService(domain: string): Record<string, unknown> | null {
      const services = getAdeActionDomainServices(runtime);
      return (services[domain as AdeActionDomain] ?? null) as Record<string, unknown> | null;
    },
    listDomains(): string[] {
      return Object.keys(ADE_ACTION_ALLOWLIST);
    },
    listActions(domain: string): string[] {
      return [...(ADE_ACTION_ALLOWLIST[domain as AdeActionDomain] ?? [])]
        .filter((action) => !isCtoOnlyAdeAction(domain as AdeActionDomain, action));
    },
  };
  automationService?.bindAdeActionRegistry(adeActionLookup);

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
