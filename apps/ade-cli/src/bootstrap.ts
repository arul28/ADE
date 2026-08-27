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
import { codedError } from "../../desktop/src/shared/codedError";
import {
  detectCloudPlaceholderFile,
  detectCloudStorageProvider,
  storageUnreadableMessage,
} from "../../desktop/src/main/services/storage/cloudPlaceholder";
import { detectDefaultBaseRef, toProjectInfo, upsertProjectRow } from "../../desktop/src/main/services/projects/projectService";
import { cleanupLegacyAdeSkills } from "../../desktop/src/main/services/skills/legacySkillCleanupService";
import {
  createAdeProjectService,
  initializeOrRepairAdeProject,
} from "../../desktop/src/main/services/projects/adeProjectService";
import { createConfigReloadService } from "../../desktop/src/main/services/projects/configReloadService";
import { createOperationService } from "../../desktop/src/main/services/history/operationService";
import { createLaneService, type LaneDeleteTeardownDeps } from "../../desktop/src/main/services/lanes/laneService";
import {
  createSessionService,
  STALE_RUNNING_SESSION_RESCAN_DELAY_MS,
} from "../../desktop/src/main/services/sessions/sessionService";
import { createSettleTeardownWiring } from "../../desktop/src/main/services/sessions/settleTeardownWiring";
import type {
  SettleResidueItem,
  SettleTeardownContext,
  SettleTeardownOutcome,
} from "../../desktop/src/main/services/sessions/sessionSettleTeardown";
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
import { createChatRuntimeBudget } from "../../desktop/src/main/services/chat/chatRuntimeBudget";
import { borrowSharedMachinePowerSource } from "./services/power/sharedMachinePowerMonitor";
import { createOrchestrationService } from "../../desktop/src/main/services/orchestration/orchestrationService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import {
  emitPrCardsForChange,
  type PrCardChange,
  type PrCardChatSink,
  type PrCardDataSource,
} from "../../desktop/src/main/services/prs/prChatCards";
import { createPrPollingService } from "../../desktop/src/main/services/prs/prPollingService";
import { chatLivenessReader, createPrMergeAutoSettlementService } from "../../desktop/src/main/services/prs/prMergeAutoSettlementService";
import { createPrSummaryService } from "../../desktop/src/main/services/prs/prSummaryService";
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
import { createCursorCloudIngressService } from "../../desktop/src/main/services/automations/cursorCloudIngressService";
import { createCursorCloudFleetService } from "../../desktop/src/main/services/chat/cursorCloudFleetService";
import { buildCursorCloudAutomationDispatches } from "../../desktop/src/main/services/automations/cursorCloudAutomationDispatch";
import { openCursorCloudCredentialStore } from "../../desktop/src/main/services/chat/cursorCloudCreateOptions";
import { createAutomationSecretService } from "../../desktop/src/main/services/automations/automationSecretService";
import { createProjectSecretService } from "../../desktop/src/main/services/secrets/projectSecretService";
import type { createGithubService } from "../../desktop/src/main/services/github/githubService";
import { createFeedbackReporterService } from "../../desktop/src/main/services/feedback/feedbackReporterService";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  ADE_BUNDLED_AGENT_SKILLS_DIR_ENV,
  getAdeAgentSkillRootCandidates,
  joinAdeAgentSkillRoots,
  splitAdeAgentSkillRoots,
} from "../../desktop/src/shared/agentSkillRoots";
import {
  listPluginAgentSkillRoots,
  resolvePluginsRoot,
} from "../../desktop/src/main/services/plugins/pluginInstallService";
import { readPluginRegistryFile } from "../../desktop/src/main/services/plugins/pluginRegistryFile";
import {
  allGatedActionDomains,
  buildGatedDomainDenial,
  gatedDomainUnavailableReason,
  pluginStepUnavailableReason,
} from "../../desktop/src/main/services/plugins/gatedActionDomains";
import { builtinSurfaceOwner } from "../../desktop/src/shared/plugins/builtinSurfaces";
import { stripHostAuthoredMessageProvenance } from "../../desktop/src/main/services/chat/spawnMissionOwnership";
import { withTrustedAdeCardAuthor } from "../../desktop/src/main/services/chat/adeCardProvenance";
import {
  PluginSdkError,
  type PluginFilePickerOptions,
  type PluginNotificationTarget,
} from "../../desktop/src/shared/plugins/sdk";
import { pluginNotificationUnavailable } from "../../desktop/src/main/services/plugins/pluginSdkServer";
import {
  createPluginPresenceService,
  getPluginPresenceService,
  setPluginPresenceService,
} from "./services/plugins/pluginPresenceService";
import { createPluginSyncMeter } from "./services/plugins/pluginSyncMeter";
import { reportPluginInstall } from "./services/plugins/pluginInstallPing";
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
import { captureAgentTurnSettledAnalytics, captureChatMentionsExpandedAnalytics } from "../../desktop/src/main/services/analytics/agentTurnProductAnalytics";
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
import { createDesktopAudioCaptureBridge } from "./services/audio/desktopAudioBridgeClient";
import { createDesktopHostBridge } from "./services/desktopHost/desktopHostBridgeClient";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import { createPushRegistrationStore } from "./services/push/pushRegistrationStore";
import { createPushRelayClient } from "./services/push/pushRelayClient";
import { getSharedPushPublisherService, resolvePushRelayStateFile, type PushPrNotification, type PushPublisherDeps, type PushPublisherService } from "./services/push/pushPublisherService";
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
import {
  getSharedPluginHostService,
  type PluginHostService,
} from "../../desktop/src/main/services/plugins/pluginHostService";
import {
  PLUGIN_CHANGED_EVENT_TYPE,
  subscribeToPluginChanges,
} from "../../desktop/src/main/services/plugins/pluginEvents";
import { createPluginWebhookIngressService } from "../../desktop/src/main/services/plugins/pluginWebhookIngressService";
import { createLaneWorktreeLockService, type LaneWorktreeLockService } from "../../desktop/src/main/services/lanes/laneWorktreeLockService";
import { createHeadlessLinearServices } from "./headlessLinearServices";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import { watchCredentialsForRelayRepair } from "./services/credentials/credentialChangeRelayRepair";
import {
  getSignedInAccountAccessToken,
  type AccountAuthService,
} from "./services/account/accountAuthService";
import {
  getSharedAccountAuthService,
  registerAccountConfigProjectRoot,
} from "./services/account/sharedAccountAuthService";
import { createTeardownStack } from "./services/runtime/startupTeardown";
import { createEventBuffer, type BufferedEvent, type EventBuffer } from "./eventBuffer";
import { createPrEventFanout } from "./prEventFanout";
import { readAutomationsEnvOverride } from "../../desktop/src/shared/automationAvailability";

/** One warm-runtime budget for every project scope this brain opens. */
const chatRuntimeBudget = createChatRuntimeBudget();

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
  activityRosterProvider?: PushPublisherDeps["activityRosterProvider"];
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
  cursorCloudFleetService?: ReturnType<typeof createCursorCloudFleetService> | null;
  orchestrationService?: ReturnType<typeof createOrchestrationService> | null;
  prService?: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
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
  cursorCloudIngressService?: ReturnType<typeof createCursorCloudIngressService> | null;
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
  /**
   * Machine-scoped: one plugin host serves every project scope in this process,
   * so switching projects never restarts a plugin child. The runtime holds a
   * reference; only its own project binding is torn down in `dispose()`.
   */
  pluginHostService?: PluginHostService | null;
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

function canonicalDirectoryWithin(root: string | null, boundary: string | null): string | null {
  if (!root || !boundary) return null;
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonicalBoundary = fs.realpathSync(boundary);
    if (!fs.statSync(canonicalRoot).isDirectory()) return null;
    const relative = path.relative(canonicalBoundary, canonicalRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return canonicalRoot;
  } catch {
    return null;
  }
}

/**
 * Strip the message provenance ADE authors for itself before a plugin's call
 * reaches a chat service.
 *
 * `spawnDispatch` and its siblings decide whether an agent completion may wake
 * another agent, and the host derives them from identity it OBSERVED. A plugin
 * has no chat session, so it cannot be the author of any of them — and unlike
 * the RPC edge, this bridge has no session to derive a replacement from, so the
 * honest answer is to drop the caller's copy rather than to trust it. Same rule
 * the automation action bridge applies to automation config.
 */
export function withoutPluginAuthoredProvenance(
  domain: AdeActionDomain,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (domain !== "chat" && domain !== "session") return args;
  const metadata = args.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return args;
  const copy = { ...(metadata as Record<string, unknown>) };
  stripHostAuthoredMessageProvenance(copy);
  return { ...args, metadata: copy };
}

/**
 * Stamp the calling plugin's identity onto the actions that must be ATTRIBUTED
 * rather than merely permitted.
 *
 * The inverse of {@link withoutPluginAuthoredProvenance}: that one drops
 * provenance a plugin has no standing to claim, this one adds provenance only
 * the host can establish. `caller` comes from the supervisor that owns the
 * child socket, so it names the package whose code is running and not whatever
 * the call said about itself.
 *
 * The stamp rides on a module-private symbol (see `adeCardProvenance.ts`), so
 * the same argument object arriving from an agent or an automation — both of
 * which cross a JSON boundary — cannot carry one.
 */
export function withPluginCallerProvenance(
  domain: AdeActionDomain,
  action: string,
  args: Record<string, unknown>,
  caller: { pluginId: string; displayName?: string | null },
): Record<string, unknown> {
  if (domain !== "chat" || action !== "emitAdeCard") return args;
  return withTrustedAdeCardAuthor(args, {
    pluginId: caller.pluginId,
    ...(caller.displayName ? { displayName: caller.displayName } : {}),
  });
}

/**
 * Automations verbs that WRITE or RUN a rule, refused to plugins.
 *
 * Read verbs (`list`, `get`, `getHistory`, `listRuns`, …) stay: a plugin
 * inspecting the automations it contributed to is the point. These four are the
 * ones that change what runs. `toggleRule` is the setEnabled-class verb — it
 * decides whether a rule fires at all, so it belongs with the writers.
 * The remaining rule-adjacent verbs in `ADE_ACTION_ALLOWLIST.automations`
 * (`setWebhookGatewayPublicUrl`, `linearIngressSetup`, `linearIngressTeardown`,
 * `cancelScheduledCleanup`) are already CTO-only and never reach this bridge.
 */
const PLUGIN_REFUSED_AUTOMATION_ACTIONS = new Set([
  "saveRule",
  "deleteRule",
  "toggleRule",
  "triggerManually",
]);

/**
 * The static half of the plugin action gate: refusals that depend only on the
 * verb being called, not on which plugins happen to be installed.
 *
 * Returns the refusal sentence, or null when this domain/action pair has no
 * static objection. The caller still applies the allowlist and the gated-domain
 * check, both of which need runtime state.
 */
export function pluginActionRefusalMessage(
  domain: AdeActionDomain,
  action: string,
): string | null {
  // The account domain answers the RPC edge through
  // `scopeAccountStatusForRole`, which strips the signed-in identity for
  // anything below operator. This bridge is not that edge — it calls the
  // service directly — so a plugin asking for `account.status` would read
  // back the user's email and user id in full. Plugins have no account
  // identity of their own, so the whole domain is refused here rather
  // than a redaction being maintained in a second place.
  if (domain === "account") {
    return `Action '${domain}.${action}' is not available to plugins.`;
  }
  // `session.requestSessionAttention` pushes an arbitrary message to
  // every paired phone, unlabelled and unlimited, and it does it by
  // putting a real chat session into "waiting for input" — so a plugin
  // borrowing it also lies about what the user's agent is doing.
  // `ade.notifications.post` is the supported path: same reach, but the
  // plugin's name is stamped on the payload by the host and the post is
  // counted against a per-plugin daily and burst ceiling. This stays
  // refused rather than becoming an alias, because the attribution and
  // the rate limit are properties of the SDK verb, and an action a plugin
  // can call directly has neither.
  if (domain === "session" && action === "requestSessionAttention") {
    return "Plugins notify through ade.notifications.post, which attributes and rate-limits the message.";
  }
  // Same shape of problem, different scheduler. `chat.createScheduledWork`
  // creates a cron against a chat session with no record of who asked for
  // it: nothing lists it as the plugin's, and uninstalling the plugin
  // leaves it injecting prompts into the user's conversation forever.
  // `ade.schedules.*` is the supported path — plugin-owned, quota'd,
  // listed under the plugin, and deleted with it.
  //
  // The read and cancel verbs go with the write: a plugin has no
  // schedules in the chat scheduler (create is refused above this line
  // in history, now alongside), so listing would only expose the
  // user's own crons and cancel would let a plugin silently kill them.
  // `getScheduledWorkState` and `setScheduledWorkPaused` are the same
  // two verbs under different names — the first reads the user's
  // schedules for a session, the second stops every one of them from
  // firing — so refusing three of the five would have left the hole
  // open under the other two.
  if (
    domain === "chat"
    && (action === "createScheduledWork"
      || action === "cancelScheduledWork"
      || action === "listScheduledWork"
      || action === "getScheduledWorkState"
      || action === "setScheduledWorkPaused")
  ) {
    return "Plugins schedule through ade.schedules.*, which is owned by the plugin and removed when it is uninstalled.";
  }
  // The third scheduler, and the one that reaches furthest. A plugin that
  // can save an ENABLED rule and then trigger it has borrowed every other
  // refusal on this list: the rule's steps run as the user, so a rule whose
  // step is `chat.createScheduledWork` or `session.requestSessionAttention`
  // is exactly the injection those two lines above refuse, laundered through
  // the automations engine. `saveRule` also takes an existing rule id, so a
  // plugin could silently rewrite a rule the user wrote and never told it
  // about. The division is the same one the rest of the platform draws:
  // plugins PROVIDE the triggers and steps they declare in their manifest
  // (`contributes.automationTriggers` / `contributes.automationSteps`), and
  // the USER authors the rules that use them.
  if (domain === "automations" && PLUGIN_REFUSED_AUTOMATION_ACTIONS.has(action)) {
    return "Plugins provide automation triggers and steps through their manifest (contributes.automationTriggers / contributes.automationSteps); only the user can create, change, or run a rule.";
  }
  return null;
}

function trustedAgentSkillsRootForCliEntry(
  cliEntry: string | null,
  resourcesPath: string | null,
): string | null {
  const packagedRoot = canonicalDirectoryWithin(
    resourcesPath ? path.join(resourcesPath, "agent-skills") : null,
    resourcesPath,
  );
  if (packagedRoot) return packagedRoot;
  if (!cliEntry) return null;

  let canonicalCliEntry: string;
  try {
    canonicalCliEntry = fs.realpathSync(cliEntry);
    if (!fs.statSync(canonicalCliEntry).isFile()) return null;
  } catch {
    return null;
  }

  let current = path.dirname(canonicalCliEntry);
  for (let depth = 0; depth < 8; depth += 1) {
    if (path.basename(current) === "ade-cli") {
      const parent = path.dirname(current);
      if (path.basename(parent) === "apps") {
        const repoRoot = path.dirname(parent);
        return canonicalDirectoryWithin(
          path.join(repoRoot, "apps", "desktop", "resources", "agent-skills"),
          repoRoot,
        );
      }
      return canonicalDirectoryWithin(path.join(parent, "agent-skills"), parent);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function inferAgentSkillsRootForCliEntry(
  cliEntry: string | null,
  options: { resourcesPath?: string | null; cwd?: string | null } = {},
): { catalogRoot: string | null; bundledRoot: string | null } {
  const resourcesPath = options.resourcesPath
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ?? null;
  const bundledRoot = trustedAgentSkillsRootForCliEntry(cliEntry, resourcesPath);
  if (bundledRoot) return { catalogRoot: bundledRoot, bundledRoot };

  const cwd = options.cwd ?? process.cwd();
  const cwdRoot = cwd
    ? path.resolve(cwd, "apps", "desktop", "resources", "agent-skills")
    : null;
  return {
    catalogRoot: pathExistsDirectory(cwdRoot) ? cwdRoot : null,
    bundledRoot: null,
  };
}

let legacyAdeSkillsCleanedForCli = false;

/**
 * Remove legacy ADE-managed user-global copies when they are provably unchanged.
 * Session-scoped discovery now uses ADE_AGENT_SKILLS_DIRS instead.
 */
export function cleanupLegacyBundledAdeSkillsForCli(): void {
  if (legacyAdeSkillsCleanedForCli) return;
  if (process.env.ADE_DISABLE_SKILL_CLEANUP === "1" || process.env.VITEST) return;
  legacyAdeSkillsCleanedForCli = true;
  try {
    const { bundledRoot } = inferAgentSkillsRootForCliEntry(resolveCurrentAdeCliEntry());
    if (bundledRoot) cleanupLegacyAdeSkills({ bundledRoot });
  } catch {
    /* best-effort: legacy cleanup must never break agent launch */
  }
}

export function createHeadlessAdeCliAgentEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: { cliEntry?: string | null; resourcesPath?: string | null; cwd?: string | null } = {},
): NodeJS.ProcessEnv {
  cleanupLegacyBundledAdeSkillsForCli();
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
    env: next,
    includeInteractiveShell: true,
    timeoutMs: 1_000,
  });
  if (nextPath) setPathEnvValue(next, nextPath);
  const cliEntry = options.cliEntry === undefined ? resolveCurrentAdeCliEntry() : options.cliEntry;
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
  const inferredSkillRoots = inferAgentSkillsRootForCliEntry(cliEntry, options);
  next[ADE_AGENT_SKILLS_DIRS_ENV] = prependAgentSkillsRoot(
    next[ADE_AGENT_SKILLS_DIRS_ENV],
    inferredSkillRoots.catalogRoot,
  );
  // The env var carries the FULL root list; only the prompt text is capped
  // (getAdeAgentSkillRootsForPrompt). This line used to write the capped list
  // here too, which silently dropped every root past the fourth — including the
  // plugin roots appended below, which sort last by construction.
  next[ADE_AGENT_SKILLS_DIRS_ENV] = joinAdeAgentSkillRoots([
    ...getAdeAgentSkillRootCandidates({ env: next, cwd: options.cwd ?? process.cwd() }),
    ...listPluginAgentSkillRoots(),
  ]);
  if (inferredSkillRoots.bundledRoot) {
    next[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV] = inferredSkillRoots.bundledRoot;
  } else {
    delete next[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV];
  }
  return next;
}

type ChatSessionEndedListenerHost = {
  registerChatSessionEndedListener?: (listener: (sessionId: string) => void) => void;
};

type ChatOwnedSimulator = {
  releaseIfOwnedBy: (sessionId: string) => Promise<unknown>;
};

/**
 * Headless chat (omitted / headless-stub runtime) has no session-end listener.
 * Calling the desktop method unguarded threw during brain startup and left CLI
 * tests hanging on a runtime that never came up.
 */
export function bindIosSimulatorReleaseOnChatEnd(args: {
  agentChatService: ChatSessionEndedListenerHost | null;
  iosSimulatorService: ChatOwnedSimulator | null;
  logger: Pick<Logger, "debug">;
}): boolean {
  const registerChatSessionEndedListener = args.agentChatService?.registerChatSessionEndedListener;
  if (typeof registerChatSessionEndedListener !== "function" || !args.iosSimulatorService) {
    return false;
  }
  const iosSimulatorService = args.iosSimulatorService;
  registerChatSessionEndedListener.call(args.agentChatService, (sessionId) => {
    void iosSimulatorService.releaseIfOwnedBy(sessionId).catch((error) => {
      args.logger.debug("ios_simulator.release_on_chat_end_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  return true;
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
    // Preflight before the open, so a cloud-evicted database fails with the
    // sentence that names the fix instead of the platform's uninterpretable
    // errno ("Unknown system error -11, read" on macOS).
    const placeholder = detectCloudPlaceholderFile(paths.dbPath);
    if (placeholder) {
      throw codedError(
        storageUnreadableMessage(placeholder.path, placeholder.provider),
        "storage_read_failed",
      );
    }
    db = await openKvDb(paths.dbPath, logger, {
      hasSyncPeers,
    });
  } catch (error) {
    // The path corroborates a bare errno: SQLite failures often carry no
    // `syscall`, and without a path the classifier refuses to call them
    // storage faults (a socket errno must not read as an unreadable file).
    const code = mapKvDbOpenErrorCode(classifySqliteOpenError(error, { path: paths.dbPath }));
    const detail = error instanceof Error ? error.message : String(error);
    const failure = {
      code,
      message: code === "storage_read_failed"
        ? storageUnreadableMessage(paths.dbPath, detectCloudStorageProvider(paths.dbPath))
        : "ADE could not open the project data store.",
      detail,
      projectRoot,
      component: "project_db_open" as const,
    };
    recordLastFailure({ kind: "project", projectRoot }, failure);
    recordLastFailure({ kind: "machine" }, failure);
    // Rethrowing the raw error discarded the classification computed one line
    // above and handed the renderer a bare libuv message. Carry the code, the
    // offending path and the raw errno instead — the code picks the recovery
    // copy, and `detail` stays for logs and `ade report-issue`.
    throw Object.assign(
      codedError(failure.message, code),
      { dbPath: paths.dbPath, projectRoot, detail },
    );
  }
  clearLastFailure({ kind: "project", projectRoot });

  let runtimeCreated = false;
  let staleSessionReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  // Declared out here so the failure path below can release it: the watcher is
  // installed long before `runtime` exists, and only `runtime.dispose` stops it.
  let stopCredentialWatch: (() => void) | null = null;
  // Every resource acquired from here on registers its release here, at the
  // point of acquisition. A throw during construction drains the stack in the
  // `finally`; a successful boot hands the same stack to `runtime.dispose`.
  // Without this, a failed boot leaked the native database handle and every
  // started service, and the sync-host retry loop leaked one runtime per
  // attempt.
  const teardown = createTeardownStack((error) => {
    logger.warn("runtime.teardown_step_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Pushed first so it pops last: writers must stop before the store closes.
  teardown.push(() => {
    try {
      db.flushNow();
    } catch {
      // Close the handle even when the final flush fails.
    }
    db.close();
  });
  // Reads the `let` at drain time, so it clears whatever timer the reconcile
  // scheduler last armed. Both shutdown paths drain this stack, so the timer
  // cannot be forgotten on one of them.
  teardown.push(() => {
    if (staleSessionReconcileTimer) clearTimeout(staleSessionReconcileTimer);
  });

  // Guards every acquisition from the database open onward.
  try {
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
    teardown.push(() => usageProductAnalyticsExporter.stop());
    usageProductAnalyticsExporter.start();

    // Machine-scoped, like product analytics: plugin children belong to the
    // machine, not to whichever project happens to be open. This scope's binding
    // is attached once `runtime` exists and detached in `dispose()`.
    const pluginHostService = getSharedPluginHostService({
      logger,
      adeVersion: process.env.ADE_CLI_VERSION?.trim() || BUNDLED_ADE_VERSION || null,
    });
    let detachPluginHostBinding: (() => void) | null = null;
    // ONE meter per project scope: the sync host records frames into it and
    // `plugin.usageSummary` reads its rollup, so a second instance would split
    // the counters between a writer and a reader that never see each other.
    const pluginSyncMeter = createPluginSyncMeter({ db, logger });
    // Flushes the last window of wire counters on the way out.
    teardown.push(() => pluginSyncMeter.dispose());

    /**
     * Plugin ids installed on this machine, for the storage doctor's plugin prune.
     *
     * CRITICAL: `[]` and `null` are NOT interchangeable. `[]` is the real answer
     * "this machine has no plugins" and DELETES every plugin row in this project;
     * `null` means "could not read the registry" and makes the pruner SKIP.
     * Getting them backwards silently destroys a user's plugin data. The install
     * registry's own reader cannot tell the two apart — it returns an empty
     * registry for a missing file AND for an unreadable one — so the state file
     * (`state.json`, written by pluginInstallService) is probed here first.
     */
    const listInstalledPluginIds = (): readonly string[] | null => {
      // The registry file's own reader makes the distinction, so this no longer
      // re-parses it by hand or hardcodes the file name.
      const registry = readPluginRegistryFile(resolvePluginsRoot());
      if (registry.kind === "unreadable") return null;
      if (registry.kind === "absent") return [];
      try {
        return pluginHostService.listPresenceRows().map((row) => row.pluginId);
      } catch {
        return null;
      }
    };

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

    // Late-bound because the publisher is constructed after the session/PTY
    // services. Session changes still use it once publishing is attached.
    let pushPublisherForPtySignals: PushPublisherService | null = null;
    let ptyServiceForSessionChanges: ReturnType<typeof createPtyService> | null = null;
    // Late-bound: the chat service that owns the work is constructed further
    // down. Without this the brain — which owns phone sync, remote commands and
    // the PR-merge poller in a normal install — would settle sessions while
    // stopping nothing.
    const settleTeardownRef: {
      run: ((sessionId: string, ctx: SettleTeardownContext) => Promise<SettleTeardownOutcome>) | null;
      report: ((args: { columns: string[]; changesetSessionCount: number }) => void) | null;
      residue: ((args: { provider: string | null; items: SettleResidueItem[] }) => void) | null;
    } = { run: null, report: null, residue: null };
    const sessionService = createSessionService({
      db,
      runSettleTeardown: async (sessionId, ctx) =>
        settleTeardownRef.run ? await settleTeardownRef.run(sessionId, ctx) : { residue: [], confirmed: false },
      onRemoteSettleWrite: (args) => settleTeardownRef.report?.(args),
      onSettleResidue: (args) => settleTeardownRef.residue?.(args),
    });
    // Inbound settle-tuple writes get this host's lifecycle revision, so an
    // in-flight settle can see a peer's decision and abandon rather than
    // overwrite it. Registered here because the DB layer must not know what a
    // settle means — and because the brain, not the desktop, is where changesets
    // are actually applied in a normal install.
    db.sync.setRemoteSettleTupleHandler((changes) => {
      sessionService.reconcileRemoteSettleTuple(changes);
    });
    sessionService.onChanged((event) => {
      pushEvent("runtime", { type: "terminal_session_changed", event });
      const session = sessionService.get(event.sessionId);
      const runtimeState = session
        ? ptyServiceForSessionChanges?.getRuntimeState(event.sessionId, session.status)
        ?? session.runtimeState
        : null;
      if (
        session
        && (session.status !== "running" || runtimeState === "idle")
        && (
          session.settleOverride === "settled"
          || (session.settleOverride !== "active" && Boolean(session.settledAt))
        )
      ) {
        pushPublisherForPtySignals?.handleSessionSettled(projectId, event.sessionId);
      }
    });
    const processRegistry = createProcessRegistryService({
      db,
      logger,
      role: chatOnlyRuntime ? "tui-runtime" : "ade-serve-daemon",
      projectRoot,
    });
    teardown.push(() => processRegistry.stop());
    processRegistry.start();
    const reconcileStaleRunningSessions = (reason: "startup" | "fresh-activity-grace-expired") => {
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
          runtimeProfile: chatOnlyRuntime ? "chat" : "full",
          reason,
        });
      }
    };
    reconcileStaleRunningSessions("startup");
    staleSessionReconcileTimer = setTimeout(
      () => reconcileStaleRunningSessions("fresh-activity-grace-expired"),
      STALE_RUNNING_SESSION_RESCAN_DELAY_MS,
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
      freshProject: !hadAdeDb,
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
    teardown.push(() => portAllocationService.dispose());

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

    teardown.push(() => {
      void laneProxyService.dispose().catch(() => {});
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
    teardown.push(() => oauthRedirectService.dispose());

    const runtimeDiagnosticsService = createRuntimeDiagnosticsService({
      logger,
      broadcastEvent: (event) => pushEvent("runtime", { type: "lane_diagnostics_event", event }),
      getPortLease: (laneId) => portAllocationService.getLease(laneId),
      getPortConflicts: () => portAllocationService.listConflicts(),
      detectPortConflicts: () => portAllocationService.detectConflicts(),
      getProxyStatus: () => laneProxyService.getStatus(),
      getProxyRoute: (laneId) => laneProxyService.getRoute(laneId),
    });
    teardown.push(() => runtimeDiagnosticsService.dispose());

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
    // The late-bound push publisher feeds tracked CLI runtime states into the
    // phone's Live Activity.
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
    ptyServiceForSessionChanges = ptyService;
    teardown.push(() => ptyService.disposeAll());

    const testService = createTestService({
      db,
      projectId,
      testLogsDir: paths.testLogsDir,
      logger,
      laneService,
      projectConfigService,
      broadcastEvent: (event) => pushEvent("runtime", event as unknown as Record<string, unknown>)
    });
    teardown.push(() => testService.disposeAll());
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
        // Agent launches arrive at the brain, so this is the instance that most
        // needs lane-correct build roots.
        resolveLaneWorktreePath: (laneId: string): string | null => {
          try {
            return laneService.getLaneWorktreePath(laneId);
          } catch {
            return null;
          }
        },
        onEvent: (event) => pushEvent("runtime", { type: "ios_simulator_event", event }),
      });
    teardown.push(() => iosSimulatorService?.dispose());
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
    teardown.push(() => appControlService?.dispose());
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
    teardown.push(() => builtInBrowserBridge?.dispose());
    // The same socket, the same credential, one more capability: plugin children
    // run HERE, and `ade.audio.captureClip` needs a microphone only a desktop
    // renderer has. A chat-only runtime never gets one, so it is left without the
    // dependency entirely and the SDK's own "no microphone here" refusal stands.
    const desktopAudioCaptureBridge = chatOnlyRuntime
      ? null
      : createDesktopAudioCaptureBridge({
        socketPath: builtInBrowserBridgeSocketPath,
        getAuthToken: () => builtInBrowserBridgeAuthToken,
        logger,
      });
    // And the rest of the SDK's Electron-only verbs — the clipboard, the native
    // file picker, the notification centre — over the same socket and the same
    // credential, for the same reason: this process is plain Node, and all three
    // are Electron main-process APIs.
    const desktopHostBridge = chatOnlyRuntime
      ? null
      : createDesktopHostBridge({
        socketPath: builtInBrowserBridgeSocketPath,
        getAuthToken: () => builtInBrowserBridgeAuthToken,
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
    teardown.push(() => headlessLinearServices.dispose());
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
    teardown.push(() => {
      void linearOAuthService.dispose().catch(() => {});
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
    teardown.push(() => {
      void orchestrationService?.dispose().catch(() => {});
    });

    let agentChatService = headlessLinearServices.agentChatService as unknown as ReturnType<typeof createAgentChatService> | null;
    if (resolvedArgs.chatRuntime === "agent") {
      agentChatService = createAgentChatService({
        runtimeBudget: chatRuntimeBudget,
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
        // Sleep is a machine fact, so every chat in this brain reads the one
        // monitor. Borrowed: the chat service must not be able to dispose it out
        // from under the account publisher, or vice versa.
        hostPowerSource: borrowSharedMachinePowerSource(),
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
        getLocalGitHubToken: () => headlessLinearServices.githubService.getGitTransportTokenOrThrowAsync(),
        onLinearIssueChatLinked: publishLinearChatLink,
        onEvent: (event) => {
          pushEvent("runtime", event as unknown as Record<string, unknown>);
        },
        onTurnSettled: (event) => captureAgentTurnSettledAnalytics({
          analytics: productAnalyticsService,
          projectId,
          event,
        }),
        onChatMentionsExpanded: (event) => captureChatMentionsExpandedAnalytics({
          analytics: productAnalyticsService,
          projectId,
          sessionId: event.sessionId,
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
    teardown.push(() => agentChatService?.forceDisposeAll?.());
    bindIosSimulatorReleaseOnChatEnd({
      agentChatService,
      iosSimulatorService,
      logger,
    });
    if (agentChatService) {
      laneTeardownDeps.agentChatService = {
        countActiveForLane: (laneId) => agentChatService.countActiveForLane(laneId),
        disposeForLane: (laneId) => agentChatService.disposeForLane(laneId),
      };
      const settleWiring = createSettleTeardownWiring({
        agentChatService,
        logger,
        analytics: productAnalyticsService ?? null,
        // The brain is the non-GUI runtime surface, matching its other analytics.
        surface: "api",
      });
      settleTeardownRef.run = settleWiring.runSettleTeardown;
      settleTeardownRef.report = settleWiring.onRemoteSettleWrite;
      settleTeardownRef.residue = settleWiring.onSettleResidue;
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
        // Reads the machine install registry file, not the plugin host handle:
        // the answer must be the same in the Electron main process, which never
        // builds a host, so the sentence a failed run records cannot depend on
        // which process ran the rule.
        pluginAvailability: { unavailableReason: (pluginId) => pluginStepUnavailableReason(pluginId) },
        onEvent: (event) => pushEvent("runtime", { ...event, source: "automations" }),
      })
      : null;
    automationServiceRef = automationService;
    teardown.push(() => automationService?.dispose());
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
    teardown.push(() => automationIngressService?.dispose());
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
    teardown.push(() => linearIngressService?.stop());
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
    const cursorCloudIngressService = createCursorCloudIngressService({
      db,
      projectId,
      credentialStore: openCursorCloudCredentialStore(projectRoot),
      getAccountAccessToken,
      cursorStore: createKvIngressCursorStore(db),
      dispatch: async (record) => {
        await agentChatService?.handleCursorCloudStatusChange(record).catch((error: unknown) => {
          logger.warn("agent_chat.cursor_cloud_status_change_failed", {
            eventId: record.eventId,
            agentId: record.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        if (!automationService) return;
        await Promise.all(buildCursorCloudAutomationDispatches(record).map((dispatch) =>
          automationService.dispatchIngressTrigger(dispatch).catch((error) => {
            logger.warn("automations.cursor_cloud_relay_dispatch_failed", {
              eventId: record.eventId,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        ));
      },
      logger,
    });
    automationService?.setCursorCloudIngressAvailable(() => {
      const status = cursorCloudIngressService.getStatus();
      return status.state === "ready" || Boolean(status.webhookId && !status.lastError);
    });
    teardown.push(() => cursorCloudIngressService.stop());
    cursorCloudIngressService.start();
    const cursorCloudFleetService = createCursorCloudFleetService({
      projectRoot,
      logger,
      listCursorCloudAgents: (args) => aiIntegrationService.listCursorCloudAgents(args),
      listCursorCloudRuns: async (args) => {
        const result = await aiIntegrationService.listCursorCloudRuns(args);
        return { items: result.items as Array<Record<string, unknown>> };
      },
      laneService: {
        list: (args) => laneService.list(args),
        importBranch: (args) => laneService.importBranch(args),
      },
      listCursorCloudSessionLinks: async () => {
        if (!agentChatService) throw new Error("Agent chat service not available.");
        const sessions = await agentChatService.listSessions(undefined, { includeArchived: true });
        return sessions
          .filter((session) => Boolean(session.cursorCloudAgentId))
          .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
          .map((session) => ({
            sessionId: session.sessionId,
            agentId: session.cursorCloudAgentId ?? "",
            laneId: session.laneId,
            title: session.title ?? null,
          }))
          .filter((link) => link.agentId.length > 0);
      },
      openCursorCloudChat: (args) => {
        if (!agentChatService) throw new Error("Agent chat service not available.");
        return agentChatService.openCursorCloudChat(args);
      },
      cancelCursorCloudRun: (args) => {
        if (!agentChatService) throw new Error("Agent chat service not available.");
        return agentChatService.cancelCursorCloudRun(args);
      },
      getCursorCloudAgent: (agentId) => aiIntegrationService.getCursorCloudAgent(agentId),
      getIngressStatus: () => {
        const status = cursorCloudIngressService.getStatus();
        return { state: status.state, lastEventAt: status.lastEventAt };
      },
    });
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
    // Registered before the start: the start is detached, so a failure elsewhere
    // must still be able to stop a reload that is only now settling.
    teardown.push(() => {
      void configReloadService.dispose().catch(() => {});
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

    // PR event fan-out and AI-summary services.
    // Fan-out for the push publisher: PR lifecycle/status notifications are
    // bridged here so the publisher never has to poll GitHub itself. Populated
    // by pushPublisherService.start() (declared below), so it stays empty and inert
    // when push publishing is not running.
    const pushPrNotificationSubscribers = new Set<(notification: PushPrNotification) => void>();
    // `syncService` is the outer declaration next to `hasSyncPeers`: a second
    // `let` here once shadowed it, so the compaction gate's closure read a
    // variable nothing ever assigned and reported "peers exist" forever — CRR
    // history was never compacted, even with no paired device.
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
    const prSummaryService = createPrSummaryService({
      db,
      logger,
      projectRoot,
      prService: headlessLinearServices.prService,
      aiIntegrationService,
    });
    const prMergeAutoSettlementService = createPrMergeAutoSettlementService({
      db,
      sessionService,
      emitEvent: emitPrEvent,
      logger,
      getChatLiveness: agentChatService ? chatLivenessReader(agentChatService) : undefined,
    });

    // GitHub polling fallback. Runtime-bound desktop windows route PR reads to
    // this daemon instead of the desktop main process, so the daemon must own
    // the background polling loop that emits `prs-updated` — otherwise PR state
    // only refreshes when a surface happens to issue a direct read.
    const prPollingService = createPrPollingService({
      logger,
      prService: headlessLinearServices.prService,
      projectConfigService,
      db,
      isGithubRelayHealthy: () => automationIngressService.isGithubRelayHealthy(),
      getGithubBackgroundPauseUntilMs: () =>
        headlessLinearServices.githubService.getBackgroundRequestPauseUntilMs(),
      onEvent: emitPrEvent,
      onPullRequestsSnapshot: (snapshot) =>
        prMergeAutoSettlementService.processSnapshot(snapshot),
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
    teardown.push(() => prPollingService.dispose());
    prPollingService.start();
    prPollingServiceForIngress = prPollingService;
    void automationIngressService.start().catch((error) => {
      logger.warn("automations.ingress_start_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // A repaired or removed GitHub App credential ends the relay's auth-pending
    // cooldown at once, the way the desktop app's `onAppUserAuthChanged` does.
    // The brain has no such callback — the credential is written by whichever
    // process ran the device flow — so it watches the shared machine file
    // instead. Best-effort: a store with no watcher leaves the behaviour as it
    // was, and the cooldown expires on its own after five minutes.
    //
    // Installed AFTER `start()`, which marks the service started synchronously: a
    // credential change during startup would otherwise poll the relay through a
    // service that has not started, and the poll `start()` runs supersedes it.
    stopCredentialWatch = watchCredentialsForRelayRepair({
      logger,
      pollNow: () => automationIngressService.pollNow(),
    });
    teardown.push(() => stopCredentialWatch?.());

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
    const { resolveDeviceDisplayName } = await import("./services/sync/deviceRegistryService");
    const cloudRelayFilePath = path.join(
      resolvedArgs.syncRuntime?.phonePairingStateDir ?? resolveMachineAdeLayout().secretsDir,
      "sync-cloud-relay.json",
    );
    const cloudRelayStore = createSyncCloudRelayStore({ filePath: cloudRelayFilePath });
    // The plugin host was built before this identity existed. Presence rows stamp
    // `isThisMachine` from the key, and the install ping signs with the push
    // registration — both live here, so the host learns them here.
    pluginHostService.setMachineContext({
      localMachineKey: () => {
        try {
          return cloudRelayStore.getMachineIdentity().machineKey || null;
        } catch {
          // An unpaired machine has no key. Null reads as "none of these rows are
          // mine", which is true, and far better than a wrong key marking another
          // computer's installs as this one's.
          return null;
        }
      },
      reportInstall: async (install) => {
        await reportPluginInstall(
          { store: createPushRegistrationStore({ filePath: resolvePushRelayStateFile(resolveMachineAdeLayout().secretsDir), logger }), logger },
          install,
        );
      },
      // Removing the plugin removes the connection it was for. The owner id comes
      // from the shared surface table rather than a literal, so this stays correct
      // if the Linear package is ever renamed.
      disconnectAccountsForPlugin: (pluginId) => {
        if (pluginId !== builtinSurfaceOwner("linear").ownerPluginId) return;
        headlessLinearServices.linearCredentialService.clearToken();
        logger.info("plugin.linear_disconnected_on_uninstall", { pluginId });
      },
      // The microphone is the desktop's, and the label is the plugin's own
      // display name as the SDK server resolved it — the pill has to say who is
      // recording, and a plugin that could choose that string could name someone
      // else. The bridge answers a typed refusal when no desktop is attached, so
      // a capture asked for on a headless machine fails rather than hangs.
      ...(desktopAudioCaptureBridge
        ? {
          captureAudioClip: (capture: { pluginId: string; label: string; maxDurationMs?: number }) =>
            desktopAudioCaptureBridge.captureClip({
              label: capture.label,
              ...(capture.maxDurationMs != null ? { maxDurationMs: capture.maxDurationMs } : {}),
            }),
        }
        : {}),
      // The Electron-only SDK verbs, same socket and same "no desktop means a
      // typed refusal" contract as the microphone above.
      ...(desktopHostBridge
        ? {
          desktopHost: {
            readClipboard: () => desktopHostBridge.readClipboard(),
            writeClipboard: (text: string) => desktopHostBridge.writeClipboard(text),
            pickFile: (options: PluginFilePickerOptions) => desktopHostBridge.pickFile(options),
          },
        }
        : {}),
      /**
       * `ade.notifications.post`, fanned out to whatever this machine has.
       *
       * This is the sanctioned replacement for a plugin borrowing
       * `session.requestSessionAttention` (refused below). The difference is not
       * the transport — it is that the plugin's name rides on the payload, the
       * post is counted against a per-plugin ceiling before it reaches here, and
       * a post that reached nobody says so instead of quietly succeeding.
       *
       * Partial delivery is a success. A user with no phone paired should not see
       * their plugins reporting errors for a notification that appeared on their
       * desktop exactly as intended, so `delivered` carries what landed and only
       * an empty result is a refusal.
       */
      postNotification: async ({ pluginId, label, title, body, target, deeplink }) => {
        const delivered: PluginNotificationTarget[] = [];
        if (target !== "mobile") {
          try {
            const shown = await desktopHostBridge?.notify({
              title,
              ...(body ? { body } : {}),
              requesterLabel: label,
            });
            if (shown) delivered.push("desktop");
          } catch (error) {
            // A missing desktop is the ordinary case on a headless machine, and
            // it must not sink a post the phone can still take.
            logger.debug("plugin.notification_desktop_failed", {
              pluginId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (target !== "desktop") {
          try {
            const queued = pushPublisherService?.publishPluginNotification({
              pluginId,
              pluginLabel: label,
              title,
              ...(body ? { body } : {}),
              // The desktop leg carries no destination: its bridge message has
              // no field for one, and adding it would be a cross-process
              // contract change for a notification the user is already looking
              // at ADE to see. The phone is where a tap has somewhere to go.
              ...(deeplink ? { deeplink } : {}),
            });
            if (queued) delivered.push("mobile");
          } catch (error) {
            logger.debug("plugin.notification_mobile_failed", {
              pluginId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (delivered.length === 0) throw pluginNotificationUnavailable();
        return { delivered };
      },
    });
    const syncDeviceIdPath = path.join(
      resolvedArgs.syncRuntime?.phonePairingStateDir ?? resolveMachineAdeLayout().secretsDir,
      "sync-device-id",
    );

    /**
     * Which plugins each machine on the account has installed.
     *
     * Bound even though this process cannot run the directory fan-out: the
     * `plugins.presenceList` remote command answers `{plugins: []}` when nothing
     * is bound, and a caller files that under this machine's key — "this computer
     * has no plugins" — which DELETES its stored rows on every peer. Publishing
     * this machine's own rows and answering that pull honestly is the whole job
     * here.
     *
     * The pull half is deliberately inert: `resolveTargetIdForMachineKey` and
     * `callMachineMethod` need the paired-target registry and the machine-to-
     * machine call path, both of which live in the desktop main process
     * (`remoteConnectionService`). The brain has neither, so the directory is
     * reported as unavailable — the contract's own "don't know" — rather than
     * faked. Peers still converge: each one pulls FROM this machine.
     */
    const pluginPresenceService = createPluginPresenceService({
      db,
      localMachineKey: () => cloudRelayStore.getMachineIdentity().machineKey,
      listLocalPlugins: () => pluginHostService.listPresenceRows(),
      listMachines: async () => null,
      resolveTargetIdForMachineKey: () => null,
      callMachineMethod: () =>
        Promise.reject(new Error("This computer cannot call other machines directly.")),
      logger,
    });
    setPluginPresenceService(pluginPresenceService);
    // Only unbind the presence ref if it is still OURS: another project scope in
    // this process may have bound its own after this one did.
    teardown.push(() => {
      if (getPluginPresenceService() === pluginPresenceService) setPluginPresenceService(null);
      pluginPresenceService.dispose();
    });
    // Seed this machine's rows so presence has a floor before the first install.
    void pluginPresenceService.publishLocalPresence().catch((error: unknown) => {
      logger.debug("plugin.presence_seed_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const pushRelayFilePath = resolvePushRelayStateFile(resolveMachineAdeLayout().secretsDir);
    const pushPublisherService = getSharedPushPublisherService(pushRelayFilePath, () => {
      const store = createPushRegistrationStore({ filePath: pushRelayFilePath, logger });
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
        // The name the user actually recognizes — the macOS ComputerName ("Arul's
        // Mac Studio"), same as the sync device registry publishes. `os.hostname()`
        // is the network hostname ("Mac.lan"), and Activity showing that made the
        // machine look like a different one from the one in the sync UI. Passed as
        // a getter, not a value: `resolveDeviceDisplayName` answers with the
        // hostname fallback synchronously and swaps in the ComputerName when its
        // async probe lands, so a value captured here would latch the fallback for
        // the life of the brain. Off darwin it resolves to `os.hostname()` anyway,
        // so Windows/Linux keep exactly the name they publish today.
        machineName: () => resolveDeviceDisplayName(),
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
        activityRosterProvider: resolvedArgs.syncRuntime?.activityRosterProvider,
      };
    });
    pushPublisherService.setActivityRosterProvider(
      resolvedArgs.syncRuntime?.activityRosterProvider ?? null,
    );
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
        // Deletion is the only path that removes a chat from the sidebar, so it
        // is also the moment Activity has to drop the row. Without this the
        // deleted chat lingers in the account feed until an unrelated flush.
        subscribeSessionRemovals: (cb) =>
          sessionService.onChanged((event) => {
            if (event.reason === "deleted") cb(event.sessionId);
          }),
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
              status: session.status,
              runtimeState: session.runtimeState ?? null,
              settledAt: session.settledAt ?? null,
              settleOverride: session.settleOverride ?? null,
            };
          } catch {
            return null;
          }
        },
      })
      : () => {};
    // Detach only this scope's signals; the shared publisher outlives the scope.
    teardown.push(() => detachPushSources());
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
    teardown.push(() => usageTrackingService.dispose());
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
      listInstalledPluginIds,
    });
    teardown.push(() => storageInsightsService.dispose());
    const budgetCapService = createBudgetCapService({
      db,
      logger,
      projectConfigService,
      usageTrackingService,
    });
    // Cloud tunnel relay (phone → Cloudflare DO → this brain). The store
    // instance is shared with the sync service so the relay candidate in
    // pairingConnectInfo and the tunnel client use one machine identity.
    const { createMachineRelayTunnel } = await import("./services/sync/machineRelayTunnel");
    const { tunnel: syncTunnelClientService, gate: relayTunnelGate } = await createMachineRelayTunnel({
      logger,
      configStore: cloudRelayStore,
      configPath: cloudRelayFilePath,
      accountAuthService,
      hostListener: resolvedArgs.syncRuntime?.sharedSyncListener ?? null,
      onPublicationStateChanged: () => {
        // Relay state changes are machine-level; without this nudge an idle
        // machine emits no sync-status snapshot and the desktop relay banner
        // never appears (or never clears).
        syncService?.notifyRouteStateChanged();
        resolvedArgs.syncRuntime?.requestAccountMachinePublish?.();
      },
      captureAnalytics: (input) => {
        productAnalyticsService.captureInternal(input);
      },
    });
    // The tunnel client is machine-level and shared across scopes — closing one
    // project must not sever the relay for the others. The daemon's shutdown path
    // (disposeServeResources) stops it. Drop only THIS scope's lease
    // subscription, or a disposed scope could later stop the shared tunnel on a
    // lease transition it no longer has any business observing.
    teardown.push(() => relayTunnelGate.dispose());
    // Registered before the sync service exists: the closure reads the variable
    // at drain time, so a throw inside the initialization below still stops it.
    teardown.push(() => syncService?.dispose());

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
        cursorCloudFleetService,
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
        // The same instance `plugin.usageSummary` reads: the host writes frame
        // counts into it, and a host restart must not swap it for another.
        pluginSyncMeter,
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
    teardown.push(() => searchService.dispose());
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
      cursorCloudFleetService,
      orchestrationService,
      ctoStateService,
      ctoMemoryService,
      adeProjectService,
      githubService: headlessLinearServices.githubService,
      accountAuthService,
      linearCredentialService: headlessLinearServices.linearCredentialService,
      linearOAuthService,
      prService: headlessLinearServices.prService,
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
      cursorCloudIngressService,
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
      pluginHostService,
      // Shutdown drains the same stack the construction path filled, in reverse
      // acquisition order: a service is always stopped before the services it was
      // built from, and the database closes last. Keeping one list means the
      // failure path and the shutdown path cannot drift apart.
      dispose: () => {
        teardown.drain();
      }
    };

    // Plugin code authenticates at agent role: it may reach every allowlisted
    // action that is not operator-only, and nothing else. Reusing the automation
    // predicate keeps that ceiling defined in exactly one place.
    // Plugin changes are machine-wide, so every open project republishes them
    // into its own event buffer. See pluginEvents.ts for the wire contract.
    const unsubscribePluginChanges = subscribeToPluginChanges((event) => {
      pushEvent("runtime", { type: PLUGIN_CHANGED_EVENT_TYPE, ...event });
    });

    // The generic webhook drain: one poll for every installed plugin that
    // declares `webhookIngress`, replacing what `cursorCloudIngressService`
    // does for exactly one feature. Constructed HERE rather than inside the
    // machine-scoped host because its ledger and relay cursor live in this
    // project's database; the host lends it the install roster and the child
    // it delivers into, so the two are built as a pair.
    const pluginWebhookIngressService = createPluginWebhookIngressService({
      db,
      projectId,
      logger,
      listPlugins: () => pluginHostService.listWebhookIngressPlugins(),
      secrets: pluginHostService.secretsForWebhookIngress(),
      deliver: (webhookPluginId, payload) =>
        pluginHostService.deliverWebhookEvent(webhookPluginId, payload),
      getAccountAccessToken,
    });
    teardown.push(() => pluginWebhookIngressService.stop());

    detachPluginHostBinding = (() => {
      const attachment = pluginHostService.attachProject({
        projectId,
        projectRoot,
        db,
        syncMeter: pluginSyncMeter,
        webhookIngress: {
          ack: (webhookPluginId, deliveryId) =>
            pluginWebhookIngressService.ack(webhookPluginId, deliveryId),
          urlFor: (webhookPluginId, channelId) =>
            pluginWebhookIngressService.urlFor(webhookPluginId, channelId),
          getStatus: (webhookPluginId) => pluginWebhookIngressService.getStatus(webhookPluginId),
        },
        // Panels on a phone or another computer otherwise wait out the host's
        // poll; this is a no-op when nobody has one open.
        onPluginDataChanged: () => {
          syncService?.getHostService()?.notifyPluginDataChanged();
        },
        // `ade.automations.emitTrigger` lands here. Not routed through
        // `invokeAdeAction` above and so not subject to its allowlist: this is an
        // SDK verb, not an ADE action, and the ceiling it needs is a different
        // one — the manifest must have DECLARED the trigger, which the SDK server
        // checks before this is ever called.
        //
        // Absent when the automations feature is off, which the SDK server turns
        // into `unsupported_method` rather than a silent success.
        ...(automationService
          ? {
            emitAutomationTrigger: async (emitArgs: {
              pluginId: string;
              triggerId: string;
              payload?: Record<string, unknown>;
            }) => {
              await automationService.dispatchPluginTrigger(emitArgs);
            },
          }
          : {}),
        invokeAdeAction: async (domain, action, args, caller) => {
          const actionDomain = domain as AdeActionDomain;
          if (!isAutomationAllowedAdeAction(actionDomain, action)) {
            throw new PluginSdkError(
              "not_permitted",
              `Action '${domain}.${action}' is not available to plugins.`,
            );
          }
          // Per-verb refusals that need no runtime state, kept in one testable
          // place (`pluginActionRefusalMessage`): the account domain, the two
          // schedulers, and the automations rule writers.
          const staticRefusal = pluginActionRefusalMessage(actionDomain, action);
          if (staticRefusal) {
            throw new PluginSdkError("not_permitted", staticRefusal);
          }
          // A plugin asking for another plugin's domain gets the same refusal a
          // user's agent gets. Named, so a plugin author reading its own error log
          // learns which package it actually depends on.
          //
          // The GATE is `allGatedActionDomains`, not the message builder.
          // `buildGatedDomainDenial` returns null for two different reasons — the
          // domain is not gated, or it is gated but no catalog can name its owner
          // — and every gated domain here (`linear_credentials`, `ios_simulator`,
          // `app_control`, …) is also in `ADE_ACTION_ALLOWLIST`, so there is no
          // generic unknown-domain error below to land in. Treating the second
          // null as a pass would mean a machine with an unreadable bundled root
          // or a cold registry cache hands those domains straight to any plugin.
          // The catalog decides how much advice the sentence carries, never
          // whether the call is allowed.
          if (allGatedActionDomains().has(actionDomain)) {
            const gated = buildGatedDomainDenial(actionDomain);
            throw new PluginSdkError(
              "not_permitted",
              gated?.message ?? `Action domain '${domain}' belongs to another plugin.`,
            );
          }
          const service = getAdeActionDomainServices(runtime)[actionDomain];
          const callable = service?.[action];
          if (typeof callable !== "function") {
            throw new PluginSdkError(
              "internal_error",
              `Action '${domain}.${action}' is unavailable in this runtime.`,
            );
          }
          return await (callable as (input?: Record<string, unknown>) => Promise<unknown>).call(
            service,
            withPluginCallerProvenance(
              actionDomain,
              action,
              withoutPluginAuthoredProvenance(actionDomain, args),
              caller,
            ),
          );
        },
      });
      // Started only after the binding exists: the drain's first tick reaches
      // straight back into the host for the install roster, and a tick that
      // beat the attach would find no project scope to ack into.
      pluginWebhookIngressService.start();
      return () => {
        unsubscribePluginChanges();
        pluginWebhookIngressService.stop();
        attachment.detach();
      };
    })();
    // Drops only THIS scope's plugin binding. The host itself is machine-scoped
    // and outlives the project; the daemon disposes it at shutdown.
    teardown.push(() => detachPluginHostBinding?.());

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
      unavailableReason(domain: string): string | null {
        return gatedDomainUnavailableReason(domain);
      },
    };
    automationService?.bindAdeActionRegistry(adeActionLookup);

    usageTrackingService.start();
    runtimeCreated = true;
    return runtime;
  } finally {
    if (!runtimeCreated) {
      // There is no runtime, so nothing else will ever call `dispose`. Release
      // every resource the failed construction acquired — the database handle
      // included. Each release runs in its own try/catch inside `drain`, so a
      // failing release neither stops the drain nor masks the startup failure.
      teardown.drain();
    }
  }
}
