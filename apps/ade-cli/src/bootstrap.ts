import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as nodePty from "node-pty";
import { isSourceCheckoutRuntimeModule } from "./runtimePackaging";
import { createFileLogger, type Logger } from "../../desktop/src/main/services/logging/logger";
import { classifySqliteOpenError, openKvDb, type AdeDb } from "../../desktop/src/main/services/state/kvDb";
import { createRegisteredSyncPeerGate } from "../../desktop/src/main/services/state/syncPeerCompactionGate";
import { stripHostRuntimeEnv } from "../../desktop/src/main/services/shared/hostRuntimeEnv";
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
  SubagentLink,
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
import { chatImportedRefsProvider } from "../../desktop/src/main/services/externalSessions/liveChatProviderRefs";
import { createSupervisedPtyLoader } from "../../desktop/src/main/services/pty/supervisedPtyHost";
import { createTestService } from "../../desktop/src/main/services/tests/testService";
import { createKeybindingsService } from "../../desktop/src/main/services/keybindings/keybindingsService";
import type { createAgentToolsService } from "../../desktop/src/main/services/agentTools/agentToolsService";
import type { createAdeCliService } from "../../desktop/src/main/services/cli/adeCliService";
import type { createDevToolsService } from "../../desktop/src/main/services/devTools/devToolsService";
import { createOnboardingService } from "../../desktop/src/main/services/onboarding/onboardingService";
import { createLaneEnvironmentService } from "../../desktop/src/main/services/lanes/laneEnvironmentService";
import { planNewLaneEnvironment, runLaneEnvironmentSetup } from "../../desktop/src/main/services/lanes/laneEnvironmentSetup";
import { createChatLaunchService, type ChatLaunchService } from "../../desktop/src/main/services/chat/chatLaunchService";
import { resolveChatCreateModel } from "../../desktop/src/main/services/chat/chatCreateModelResolution";
import { resolveLaneCreateRemoteBaseDetailed } from "./services/laneCreateRemoteBase";
import { resolveGitCommit, runGit } from "../../desktop/src/main/services/git/git";
import { createLaneTemplateService } from "../../desktop/src/main/services/lanes/laneTemplateService";
import { createPortAllocationService } from "../../desktop/src/main/services/lanes/portAllocationService";
import { createLaneProxyService } from "../../desktop/src/main/services/lanes/laneProxyService";
import { createProxyService, type ProxyService } from "./services/proxy/proxyService";
import { registerHarnessProxyStarter } from "../../desktop/src/main/services/chat/harnessLaunchPrepare";
import {
  releaseLaneRuntimeResources,
  teardownArchivedLaneEnvironment,
} from "../../desktop/src/main/services/lanes/laneRuntimeLifecycle";
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
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import {
  emitPrCardsForChange,
  type PrCardChange,
  type PrCardChatSink,
  type PrCardDataSource,
} from "../../desktop/src/main/services/prs/prChatCards";
import { createPrPollingService } from "../../desktop/src/main/services/prs/prPollingService";
import { createPrWatchService } from "../../desktop/src/main/services/prs/prWatchService";
import { chatLivenessReader, createPrMergeAutoSettlementService } from "../../desktop/src/main/services/prs/prMergeAutoSettlementService";
import { createPrSummaryService } from "../../desktop/src/main/services/prs/prSummaryService";
import { createCtoStateService } from "../../desktop/src/main/services/cto/ctoStateService";
import { createCtoMemoryService } from "../../desktop/src/main/services/cto/ctoMemoryService";
import { projectContextAccountPort } from "../../desktop/src/main/services/cto/projectContextStore";
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
import { createSyncStatusEventPublisher } from "./services/sync/syncStatusEventPublisher";
import type { createSyncHostService, SyncRuntimeKind } from "./services/sync/syncHostService";
import { getSharedModelPickerStore } from "./services/modelPickerStore";
import { createAutomationIngressService, createKvIngressCursorStore } from "../../desktop/src/main/services/automations/automationIngressService";
import { createLinearAccessTokenGetter, createLinearIngressService } from "../../desktop/src/main/services/automations/linearIngressService";
import { createLinearAgentRuntime, type LinearAgentRuntime } from "../../desktop/src/main/services/cto/linearAgentRuntime";
import { createLinearInboxAttentionService } from "../../desktop/src/main/services/cto/linearInboxAttentionService";
import { linearIssuePatchFromEvent } from "../../desktop/src/main/services/cto/linearLaneSync";
import { createLinearProofPoster } from "../../desktop/src/main/services/cto/linearProofPoster";
import { buildLinearAutomationDispatches } from "../../desktop/src/main/services/automations/linearAutomationDispatch";
import { createCursorCloudIngressService } from "../../desktop/src/main/services/automations/cursorCloudIngressService";
import { createCursorCloudFleetService } from "../../desktop/src/main/services/chat/cursorCloudFleetService";
import { createCloudAgentsServiceFromHost, type CloudAgentsService } from "../../desktop/src/main/services/chat/cloudAgentsService";
import { resolveDevinCloudBinary } from "../../desktop/src/main/services/chat/devinCloudBinary";
import { buildCursorCloudAutomationDispatches } from "../../desktop/src/main/services/automations/cursorCloudAutomationDispatch";
import { openCursorCloudCredentialStore } from "../../desktop/src/main/services/chat/cursorCloudCreateOptions";
import { createAutomationSecretService } from "../../desktop/src/main/services/automations/automationSecretService";
import { createProjectSecretService } from "../../desktop/src/main/services/secrets/projectSecretService";
import type { createGithubService } from "../../desktop/src/main/services/github/githubService";
import { createFeedbackReporterService } from "../../desktop/src/main/services/feedback/feedbackReporterService";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  ADE_BUNDLED_AGENT_SKILLS_DIR_ENV,
  joinAdeAgentSkillRoots,
  splitAdeAgentSkillRoots,
} from "../../desktop/src/shared/agentSkillRoots";
import { adePromptAgentSkillRoots } from "../../desktop/src/main/services/skills/agentSkillRuntimeService";
import {
  attachSharedUsageTrackingScope,
  createUsageTrackingService,
  type UsageTrackingHost,
} from "../../desktop/src/main/services/usage/usageTrackingService";
import { createBudgetCapService } from "../../desktop/src/main/services/usage/budgetCapService";
import { getSharedTurnUsageLedger } from "../../desktop/src/main/services/usage/turnUsageLedger";
import {
  attachSharedUsageResearchUploader,
  createUsageResearchUploader,
} from "../../desktop/src/main/services/usage/usageResearchUploader";
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
import {
  captureAgentTurnSettledAnalytics,
  captureChatAutoResumeAnalytics,
  captureAppControlAnalytics,
  captureMacDesktopAnalytics,
  captureChatMentionsExpandedAnalytics,
  captureClaudeHooksIgnoredAnalytics,
  captureClaudePluginsIgnoredAnalytics,
  captureSessionMetadataRegeneratedAnalytics,
} from "../../desktop/src/main/services/analytics/agentTurnProductAnalytics";
import {
  captureChatAccountSwitchedAnalytics,
  captureNewLaneLaunchAnalytics,
  capturePendingInputDismissedAnalytics,
  captureSessionImportAnalytics,
} from "../../desktop/src/main/services/analytics/featureProductAnalytics";
import { createSessionDeltaService } from "../../desktop/src/main/services/sessions/sessionDeltaService";
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
import { resolveSessionLaneId } from "../../desktop/src/main/services/lanes/resolveSessionLaneId";
import {
  createMacDesktopService,
  type MacDesktopService,
} from "../../desktop/src/main/services/macDesktop/macDesktopService";
import { createMacDesktopLogger } from "../../desktop/src/main/services/macDesktop/macDesktopLogger";
import { createWindowsDesktopSeatAdapter } from "../../desktop/src/main/services/windowsDesktop/windowsDesktopSeatProvider";
import { feedDemoTrackFromChatEvent } from "../../desktop/src/main/services/demoVideo/demoTrackRegistry";
import type { BuiltInBrowserService } from "../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import {
  createBuiltInBrowserDesktopBridgeClient,
  probeDesktopBridge,
  type DesktopBridgeProbe,
} from "./services/builtInBrowser/desktopBridgeClient";
import { createAppControlRecorderBridgeClient } from "./services/builtInBrowser/appControlRecorderBridgeClient";
import { createDemoEngineBridgeClient } from "./services/builtInBrowser/demoEngineBridgeClient";
import { createScenePreviewBridgeClient, type ScenePreviewer } from "./services/builtInBrowser/scenePreviewBridgeClient";
import { createDemoEngineSet } from "../../desktop/src/main/services/demoVideo/demoEngines";
import type { BuiltInBrowserDesktopBridgeClient } from "./services/builtInBrowser/desktopBridgeMethods";
import {
  createRemoteBrowserForwarder,
  withRemoteBrowserForwarding,
} from "./services/builtInBrowser/remoteBrowserForwarder";
import {
  createWorkToolsStateService,
  type WorkToolsStateService,
} from "./services/workTools/workToolsStateService";
import { createWorkToolShowRequests } from "./services/workTools/workToolShowRequests";
import { devServerRegistry } from "../../desktop/src/main/services/devServers/devServerRegistry";
import { createDevServerWatcher } from "../../desktop/src/main/services/devServers/devServerWatcher";
import {
  getSessionInputOrigin,
  RECENT_INPUT_ORIGIN_MS,
} from "../../desktop/src/main/services/chat/sessionInputOrigins";
import { probeLocalhostPort } from "../../desktop/src/main/services/probeLocalhostPort";
import {
  DEV_SERVER_EVENT,
  type DevServerEvent,
  type DevServerRecord,
} from "../../desktop/src/shared/types/builtInBrowser";
import { WORK_TOOLS_STATE_CHANGED_EVENT } from "../../desktop/src/shared/types/workTools";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import { createBrainLogger } from "./services/runtime/brainLogger";
import { createPushRegistrationStore } from "./services/push/pushRegistrationStore";
import { createPushRelayClient } from "./services/push/pushRelayClient";
import { createAccountRuntimeLifecycle } from "./services/account/accountRuntimeLifecycle";
import type { AccountSettingsStore } from "./services/account/accountSettingsStore";
import { createAppleStreamRelayForService } from "../../desktop/src/main/services/ios/appleStreamRelay";
import { setActiveAppleStreamRouter } from "./services/sync/appleStreamListenerRoute";
import { ACCOUNT_SCOPE_ALL, accountDeviceSettingKey } from "../../desktop/src/shared/accountSettingsScope";
import {
  APPLE_DEVICE_SETTING_KEYS,
  DEFAULT_APPLE_REMOTE_BITRATE_KBPS,
  clampAppleRemoteBitrateKbps,
} from "../../desktop/src/shared/appleDeviceSettings";
import { ADE_ACCENT_COLOR } from "../../desktop/src/shared/themeTokens";
import type { AccountVaultStore } from "./services/account/accountVaultStore";
import { getSharedPushPublisherService, resolvePushRelayStateFile, type PushPrNotification, type PushPublisherDeps, type PushPublisherService } from "./services/push/pushPublisherService";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import type { AppNavigationRequest, AppNavigationResult, PortLease, SyncRoleSnapshot, PrSummary } from "../../desktop/src/shared/types";
import type { PrEventPayload } from "../../desktop/src/shared/types/prs";
import { createAutomationService } from "../../desktop/src/main/services/automations/automationService";
import { createAutomationPlannerService } from "../../desktop/src/main/services/automations/automationPlannerService";
import {
  createAutomationAdeActionLookup,
  getAdeActionDomainServices,
} from "../../desktop/src/main/services/adeActions/registry";
import { createLaneWorktreeLockService, LaneWorktreeLockedError, type LaneWorktreeLockService } from "../../desktop/src/main/services/lanes/laneWorktreeLockService";
import {
  createDefaultBranchAutoPullService,
  detectInProgressGitOperation,
  isDefaultBranchMerge,
} from "../../desktop/src/main/services/lanes/defaultBranchAutoPull";
import { parseWorktreeStatusPorcelainV2 } from "../../desktop/src/main/services/lanes/laneBranchDrift";
import { createHeadlessLinearServices } from "./headlessLinearServices";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import { watchCredentialsForRelayRepair } from "./services/credentials/credentialChangeRelayRepair";
import {
  getSignedInAccountAccessToken,
  type AccountAuthService,
} from "./services/account/accountAuthService";
import {
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
  registerAccountConfigProjectRoot,
} from "./services/account/sharedAccountAuthService";
import { attachSharedModelRouter, createModelRouterService } from "../../desktop/src/main/services/router/modelRouterService";
import { createModelRegistryStore, createWorkerRegistryFetcher } from "../../desktop/src/main/services/router/modelRegistryStore";
import { createTeardownStack } from "./services/runtime/startupTeardown";
import {
  adeCliShimDirName,
  packagedCliNodeModulePaths,
  renderAdeCliShim,
  resolveAdeCliShimBrain,
  type AdeCliShimBrain,
} from "./services/runtime/adeCliShim";
import { createEventBuffer, type BufferedEvent, type EventBuffer } from "./eventBuffer";
import { isHighVolumeRuntimeEvent } from "./runtimeEventVolume";
import { appControlEventsFromRuntimeBuffer } from "./services/sync/appControlSyncStream";
import { createPrEventFanout } from "./prEventFanout";
import { createCtoCrossMachineBridge } from "./services/account/ctoCrossMachineBridge";
import type { CtoActionCaller } from "./adeRpcServer";
import { readAutomationsEnvOverride } from "../../desktop/src/shared/automationAvailability";
import { createWebhookRemoteSource } from "../../desktop/src/main/services/automations/webhookAutomationFactory";

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
  relatedPrs?: PrSummary[];
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
        relatedPrs: args.relatedPrs,
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
  projectScopes?: Parameters<typeof createSyncService>[0]["projectScopes"];
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
  /** Whether this runtime serves the RPC endpoint needed by activity reports. */
  sessionActivityReportingEnabled: boolean;
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
  /** Machine-scoped subscription proxy; constructed only when a proxy action is used. */
  proxyService?: ProxyService | null;
  getProxyService?: () => ProxyService;
  oauthRedirectService?: ReturnType<typeof createOAuthRedirectService> | null;
  runtimeDiagnosticsService?: ReturnType<typeof createRuntimeDiagnosticsService> | null;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  operationService: ReturnType<typeof createOperationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  projectSecretService?: ReturnType<typeof createProjectSecretService> | null;
  /** Machine-scoped, so null on a `--no-sync` brain. */
  accountSettingsStore?: AccountSettingsStore | null;
  /** Machine-scoped, so null on a `--no-sync` brain. */
  accountVaultStore?: AccountVaultStore | null;
  conflictService: ReturnType<typeof createConflictService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  diffService: ReturnType<typeof createDiffService>;
  ptyService: ReturnType<typeof createPtyService>;
  testService: ReturnType<typeof createTestService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  chatLaunchService?: ChatLaunchService | null;
  cursorCloudFleetService?: ReturnType<typeof createCursorCloudFleetService> | null;
  cloudAgentsService?: CloudAgentsService | null;
  prService?: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
  fileService?: ReturnType<typeof createFileService> | null;
  ctoStateService: ReturnType<typeof createCtoStateService>;
  ctoMemoryService?: ReturnType<typeof createCtoMemoryService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearOAuthService?: ReturnType<typeof createLinearOAuthService> | null;
  linearAgentRuntime?: LinearAgentRuntime | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  githubService?: ReturnType<typeof createGithubService> | null;
  accountAuthService?: AccountAuthService | null;
  automationService?: ReturnType<typeof createAutomationService> | null;
  automationPlannerService?: ReturnType<typeof createAutomationPlannerService> | null;
  computerUseArtifactBrokerService: ComputerUseArtifactBrokerService;
  iosSimulatorService?: IosSimulatorService | null;
  appControlService?: AppControlService | null;
  /**
   * `ade scene preview`: the attached desktop's scene renderer, over the
   * desktop bridge. Null while no desktop has attached to this brain.
   */
  getScenePreviewer?: () => ScenePreviewer | null;
  macDesktopService?: MacDesktopService | null;
  builtInBrowserService?: BuiltInBrowserService | BuiltInBrowserDesktopBridgeClient | null;
  /** Read-only Work tools-pane state for iOS and the hosted web client. */
  workToolsStateService?: WorkToolsStateService | null;
  /**
   * The local desktop app said hello: re-check that its bridge answers, so
   * recording, demo videos and scene previews use it straight away.
   */
  noteDesktopAppConnected?: () => void;
  syncHostService?: ReturnType<typeof createSyncHostService> | null;
  syncService?: ReturnType<typeof createSyncService> | null;
  pushPublisherService?: PushPublisherService | null;
  automationIngressService?: ReturnType<typeof createAutomationIngressService> | null;
  linearIngressService?: ReturnType<typeof createLinearIngressService> | null;
  cursorCloudIngressService?: ReturnType<typeof createCursorCloudIngressService> | null;
  feedbackReporterService?: ReturnType<typeof createFeedbackReporterService> | null;
  usageTrackingService?: UsageTrackingHost | null;
  productAnalyticsService?: ProductAnalyticsService | null;
  usageProductAnalyticsExporter?: UsageProductAnalyticsExporter | null;
  storageInsightsService?: ReturnType<typeof createStorageInsightsService> | null;
  budgetCapService?: ReturnType<typeof createBudgetCapService> | null;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
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

function ensureAdeCliShim(entryPath: string, brain: AdeCliShimBrain): { dir: string; path: string } | null {
  const shimDir = path.join(os.tmpdir(), "ade-cli-shims", adeCliShimDirName(entryPath, process.execPath, brain));
  const shimPath = path.join(shimDir, process.platform === "win32" ? "ade.cmd" : "ade");
  try {
    fs.mkdirSync(shimDir, { recursive: true });
    const body = renderAdeCliShim({
      entryPath,
      execPath: process.execPath,
      brain,
      nodeModulePaths: packagedCliNodeModulePaths(entryPath),
    });
    if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== body) {
      fs.writeFileSync(shimPath, body, "utf8");
    }
    if (process.platform !== "win32") fs.chmodSync(shimPath, 0o755);
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
 * `brain.jsonl`, for the Mac Desktop service. One per process: the driver, its
 * displays and its permission probes are machine facts, whichever project
 * runtime spawned the helper. Null when the machine layout cannot be resolved,
 * in which case the service still logs to its project log.
 */
let macDesktopMachineLogger: Logger | null | undefined;

function getMacDesktopMachineLogger(): Logger | null {
  if (macDesktopMachineLogger !== undefined) return macDesktopMachineLogger;
  try {
    macDesktopMachineLogger = createBrainLogger(path.join(resolveMachineAdeLayout().runtimeDir, "brain.jsonl"));
  } catch {
    macDesktopMachineLogger = null;
  }
  return macDesktopMachineLogger;
}

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
  options: {
    cliEntry?: string | null;
    resourcesPath?: string | null;
    cwd?: string | null;
    /** The brain the shim defaults to. This process's own, unless a test says otherwise. */
    brain?: AdeCliShimBrain;
  } = {},
): NodeJS.ProcessEnv {
  cleanupLegacyBundledAdeSkillsForCli();
  const next: NodeJS.ProcessEnv = stripHostRuntimeEnv({ ...baseEnv });
  const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
    env: next,
    includeInteractiveShell: true,
    timeoutMs: 1_000,
  });
  if (nextPath) setPathEnvValue(next, nextPath);
  const cliEntry = options.cliEntry === undefined ? resolveCurrentAdeCliEntry() : options.cliEntry;
  if (cliEntry) {
    const shim = ensureAdeCliShim(cliEntry, options.brain ?? resolveAdeCliShimBrain(process.env));
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
  next[ADE_AGENT_SKILLS_DIRS_ENV] = joinAdeAgentSkillRoots(adePromptAgentSkillRoots({
    env: next,
    cwd: options.cwd ?? process.cwd(),
  }));
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

type ChatOwnedDevice = {
  releaseIfOwnedBy: (sessionId: string) => Promise<unknown>;
};

/**
 * Drops a chat's hold on a device when the chat ends.
 *
 * Headless chat (omitted / headless-stub runtime) has no session-end listener.
 * Calling the desktop method unguarded threw during brain startup and left CLI
 * tests hanging on a runtime that never came up.
 *
 * The `logEvent` parameter is not decoration: both the iOS simulator and the
 * Mac Desktop display bind through here, and a failure logged under the wrong
 * feature's event name is a failure nobody looking at that feature will find.
 */
export function bindDeviceReleaseOnChatEnd(args: {
  agentChatService: ChatSessionEndedListenerHost | null;
  device: ChatOwnedDevice | null;
  logEvent: string;
  logger: Pick<Logger, "debug">;
}): boolean {
  const registerChatSessionEndedListener = args.agentChatService?.registerChatSessionEndedListener;
  if (typeof registerChatSessionEndedListener !== "function" || !args.device) {
    return false;
  }
  const device = args.device;
  registerChatSessionEndedListener.call(args.agentChatService, (sessionId) => {
    void device.releaseIfOwnedBy(sessionId).catch((error) => {
      args.logger.debug(args.logEvent, {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  return true;
}

/** The iOS simulator's binding. Kept named for the call sites and the test. */
export function bindIosSimulatorReleaseOnChatEnd(args: {
  agentChatService: ChatSessionEndedListenerHost | null;
  iosSimulatorService: ChatOwnedDevice | null;
  logger: Pick<Logger, "debug">;
}): boolean {
  return bindDeviceReleaseOnChatEnd({
    agentChatService: args.agentChatService,
    device: args.iosSimulatorService,
    logEvent: "ios_simulator.release_on_chat_end_failed",
    logger: args.logger,
  });
}

export async function createAdeRuntime(args: {
  projectRoot: string;
  /** Control endpoint this runtime actually bound, for chat ownership stamps. */
  runtimeSocketPath?: string | null;
  workspaceRoot?: string;
  primaryWorktreePath?: string;
  chatRuntime?: "headless-stub" | "agent";
  /**
   * How much of the runtime to build.
   *
   * - "full": everything (the machine brain / project daemon).
   * - "chat": the TUI + personal-chat runtime. Drops iOS-sim, app-control, and
   *   the built-in browser bridge, all of which need a desktop host.
   * - "embedded": "chat" minus everything an external embedder must not get.
   *   Automations, their ingress rule dispatch, and auto-update are off, and
   *   sync is forced off no matter what the caller passed — an embedded runtime
   *   is a guest inside somebody else's process and must never take machine
   *   brain authority or restart the machine's ADE.
   *
   * Personal chats work identically under all three: nothing personal chats
   * needs is trimmed by any profile.
   */
  runtimeProfile?: "full" | "chat" | "embedded";
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
  const embeddedRuntime = resolvedArgs.runtimeProfile === "embedded";
  // "embedded" is a strict subset of "chat", so every chat-profile trim applies
  // to it too rather than being re-listed at each site.
  const chatOnlyRuntime = resolvedArgs.runtimeProfile === "chat" || embeddedRuntime;
  const runtimeProfileLabel = embeddedRuntime ? "embedded" : chatOnlyRuntime ? "chat" : "full";
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
  const runtimeSocketPath = typeof resolvedArgs.runtimeSocketPath === "string"
    ? resolvedArgs.runtimeSocketPath.trim() || paths.socketPath
    : paths.socketPath;
  const sessionActivityReportingEnabled = !embeddedRuntime && Boolean(runtimeSocketPath);
  const logger = createFileLogger(path.join(paths.logsDir, "ade-cli.jsonl"));
  const diskPressureMonitor = createDiskPressureMonitor({
    roots: [projectRoot, resolveMachineAdeLayout().adeDir],
  });
  // An embedded runtime is a guest inside an external process. It must never
  // take machine-brain authority, host a sync listener, or answer for the
  // machine's devices, so sync options are dropped here rather than at each of
  // the twenty read sites below — one place to check the invariant holds.
  const syncRuntimeOptions = embeddedRuntime ? undefined : resolvedArgs.syncRuntime;
  let syncService: ReturnType<typeof createSyncService> | null = null;
  const hasSyncPeers = createRegisteredSyncPeerGate({
    syncEnabled: syncRuntimeOptions?.enabled === true,
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

  // The subscription proxy owns a downloaded binary and a machine-level
  // auth directory. Keep both out of boot and create them only when an
  // action, CLI command, or sync read actually asks for the proxy.
  let proxyService: ProxyService | null = null;
  let productAnalyticsForProxy: ProductAnalyticsService | null = null;
  const getProxyService = (): ProxyService => {
    if (!proxyService) {
      proxyService = createProxyService({
        adeHome: resolveMachineAdeLayout().adeDir,
        // `productAnalyticsForProxy` is assigned further below.
        getAnalytics: () => productAnalyticsForProxy,
      });
      teardown.push(() => proxyService?.dispose() ?? Promise.resolve());
    }
    return proxyService;
  };
  // Routed launches (a model translated through the proxy) start it on
  // demand; see `harnessLaunchPrepare.ts`.
  // Every project runtime points at the same machine-level proxy. Keep only
  // live runtimes registered so launches cannot recreate a disposed service.
  const releaseHarnessProxyStarter = registerHarnessProxyStarter(() => getProxyService().ensureRunning());
  teardown.push(() => releaseHarnessProxyStarter());

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
        runtimeMode: syncRuntimeOptions?.runtimeKind ?? (chatOnlyRuntime ? "chat_runtime" : "project_runtime"),
      }));
    productAnalyticsForProxy = productAnalyticsService;
    const usageProductAnalyticsExporter = createUsageProductAnalyticsExporter({
      db,
      analytics: productAnalyticsService,
      logger,
    });
    teardown.push(() => usageProductAnalyticsExporter.stop());
    usageProductAnalyticsExporter.start();

    const operationService = createOperationService({ db, projectId });
    const keybindingsService = createKeybindingsService({ db });
    // Screencast frames reach live viewers but are never kept for replay.
    const eventBuffer = createEventBuffer(undefined, { isTransient: isHighVolumeRuntimeEvent });

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
      subagentLinks: ((parentSessionIds: readonly string[]) => Promise<SubagentLink[]>) | null;
    } = { run: null, report: null, residue: null, subagentLinks: null };
    const sessionService = createSessionService({
      db,
      runSettleTeardown: async (sessionId, ctx) =>
        settleTeardownRef.run ? await settleTeardownRef.run(sessionId, ctx) : { residue: [], confirmed: false },
      onRemoteSettleWrite: (args) => settleTeardownRef.report?.(args),
      onSettleResidue: (args) => settleTeardownRef.residue?.(args),
      listSubagentLinks: async (parentSessionIds) =>
        settleTeardownRef.subagentLinks ? await settleTeardownRef.subagentLinks(parentSessionIds) : [],
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
          runtimeProfile: runtimeProfileLabel,
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
    registerAccountConfigProjectRoot(projectRoot);
    const accountAuthService = getSharedAccountAuthService({
      projectRoots: () => [projectRoot],
      logger,
    });
    const accountStoreAdeDir = resolveMachineAdeLayout().adeDir;
    const syncDeviceIdPath = path.join(
      syncRuntimeOptions?.phonePairingStateDir ?? resolveMachineAdeLayout().secretsDir,
      "sync-device-id",
    );
    const readSyncDeviceId = (): string | null => {
      try {
        return fs.readFileSync(syncDeviceIdPath, "utf8").trim() || null;
      } catch {
        return null;
      }
    };
    const pushRelayFilePath = resolvePushRelayStateFile(resolveMachineAdeLayout().secretsDir);
    let projectSecretServiceForAccount: ReturnType<typeof createProjectSecretService> | null = null;
    let linearCredentialServiceForAccount: ReturnType<typeof createLinearCredentialService> | null = null;
    const getAccountAccessToken = (
      options?: Parameters<typeof getSignedInAccountAccessToken>[1],
    ) => getSignedInAccountAccessToken(accountAuthService, options);
    const accountRuntimeLifecycle = createAccountRuntimeLifecycle({
      enabled: syncRuntimeOptions?.enabled === true,
      accountStoreAdeDir,
      pushRelayFilePath,
      syncDeviceIdPath,
      receiptDir: accountStoreAdeDir,
      logger,
      accountAuthService,
      getAccountAccessToken,
      getContexts: () => [{
        project: { rootPath: projectRoot },
        linearCredentialService: linearCredentialServiceForAccount,
        projectSecretService: projectSecretServiceForAccount,
      }],
      teardown,
    });
    const {
      accountSettingsStore,
      accountVaultStore,
    } = accountRuntimeLifecycle;
    initApiKeyStore(projectRoot, {
      credentialStore: new EncryptedFileCredentialStore(),
      getAccountVault: accountRuntimeLifecycle.getAccountVault,
      getAccountUserId: () => accountAuthService.getStatus().userId,
      logger,
      analytics: productAnalyticsService,
    });
    const projectSecretService = createProjectSecretService(projectRoot, {
      getAccountVault: accountRuntimeLifecycle.getAccountVault,
      getAccountUserId: () => accountAuthService.getStatus().userId,
      logger,
    });
    projectSecretServiceForAccount = projectSecretService;
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

    // Archiving a lane brings down the Docker services its env init started —
    // the same teardown delete and archive-and-reclaim run. Late-bound because
    // the lane service is constructed before the project config service.
    laneService.setOnLaneArchivedEnvTeardown((laneId) =>
      teardownArchivedLaneEnvironment(
        { laneService, projectConfigService, laneEnvironmentService, logger },
        laneId,
      ),
    );

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
      // A long-lived agent runtime (the machine brain) keeps the model
      // directory current; one-shot CLI commands and embedded guests stay
      // offline and use the bundled/disk copy.
      modelManifest: {
        adeVersion: process.env.ADE_CLI_VERSION?.trim() || BUNDLED_ADE_VERSION || null,
        fetchRemote: resolvedArgs.chatRuntime === "agent" && !embeddedRuntime,
      },
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
      aiIntegrationService,
      sessionService,
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
    const syncStatusEventPublisher = createSyncStatusEventPublisher<SyncRoleSnapshot>({
      emit: (snapshot) => pushEvent("runtime", { type: "sync-status", snapshot }),
    });
    teardown.push(() => syncStatusEventPublisher.dispose());
    // The late-bound push publisher feeds tracked CLI runtime states into the
    // phone's Live Activity.

    const ptyService = createPtyService({
      projectRoot,
      runtimeSocketPath,
      sessionActivityReportingEnabled,
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

    // Keeps the primary checkout's default branch current: fast-forward only,
    // on startup and a background timer, and only when every safety gate in
    // `evaluateDefaultBranchAutoPull` passes. It lives in the brain because the
    // brain owns the project's checkout whether or not a desktop is attached.
    // The gate compares HEAD with the project's default branch (`baseRef`),
    // not the primary lane's `branch_ref` — that one follows whatever branch
    // the primary checkout has out, which would pull any branch.
    const defaultBranchAutoPullService = createDefaultBranchAutoPullService({
      logger,
      getPrimaryLane: () => {
        const primary = laneService.getPrimaryLane();
        return primary ? { ...primary, branchRef: baseRef } : null;
      },
      readWorktreeStatus: async (worktreePath) => {
        const res = await runGit(
          ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "-z"],
          { cwd: worktreePath, timeoutMs: 10_000 },
        );
        if (res.exitCode !== 0) return null;
        const parsed = parseWorktreeStatusPorcelainV2(res.stdout);
        return { staged: parsed.staged, unstaged: parsed.unstaged, headBranchRef: parsed.headBranchRef };
      },
      detectInProgressOperation: async (worktreePath) => {
        const res = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath, timeoutMs: 5_000 });
        if (res.exitCode !== 0) return null;
        const gitDir = res.stdout.trim();
        return gitDir ? detectInProgressGitOperation(gitDir) : null;
      },
      isWorktreeLocked: (laneId) => laneWorktreeLockService.getActiveForLane(laneId).length > 0,
      acquireWorktreeLock: (lane) => {
        try {
          const acquired = laneWorktreeLockService.acquire({
            laneId: lane.laneId,
            worktreePath: lane.worktreePath,
            ownerKind: "git_mutation",
            ownerLabel: "Auto-pull default branch",
          });
          return { release: () => laneWorktreeLockService.release({ token: acquired.token }) };
        } catch (error) {
          if (error instanceof LaneWorktreeLockedError) return null;
          throw error;
        }
      },
      readSyncStatus: async (laneId) => {
        const status = await gitService.getSyncStatus({ laneId });
        return { hasUpstream: status.hasUpstream, ahead: status.ahead, behind: status.behind };
      },
      fetch: async (laneId) => {
        await gitService.fetch({ laneId });
      },
      pullFastForward: async (laneId) => {
        await gitService.pull({ laneId, mode: "ff-only" });
      },
    });
    // Embedded runtimes are guests inside an external process and must not
    // take machine-brain authority over the project's checkout.
    if (!embeddedRuntime) defaultBranchAutoPullService.start();
    teardown.push(() => defaultBranchAutoPullService.stop());

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

    // Set once the runtime below is assembled; the CTO's home-machine actions read it.
    let runtimeForCtoActions: AdeRuntime | null = null;
    const ctoMemoryService = createCtoMemoryService({
      adeDir: paths.adeDir,
      logger,
      account: accountSettingsStore
        ? projectContextAccountPort({ projectRoot, store: accountSettingsStore })
        : null,
    });
    const ctoAppVersion = process.env.ADE_CLI_VERSION?.trim() || BUNDLED_ADE_VERSION || "0.0.0";
    // The CTO's generic actions on this machine run through the same RPC
    // dispatcher, under the same CTO caller identity, as they would from
    // another machine. Built once, when the runtime exists and a tool needs it.
    let ctoLocalActionCaller: Promise<CtoActionCaller> | null = null;
    const getCtoLocalActionCaller = (): Promise<CtoActionCaller> | null => {
      const runtime = runtimeForCtoActions;
      if (!runtime) return null;
      ctoLocalActionCaller ??= import("./adeRpcServer")
        .then(({ createCtoActionCaller }) => createCtoActionCaller({ runtime, serverVersion: ctoAppVersion }))
        .catch((error) => {
          ctoLocalActionCaller = null;
          throw error;
        });
      return ctoLocalActionCaller;
    };
    // The CTO acting on the account's other machines, for this project's
    // repository there. Built when the CTO's tools are, and reads nothing from
    // the account until one of them reaches another machine.
    let ctoCrossMachine: ReturnType<typeof createCtoCrossMachineBridge> | null = null;
    const getCtoCrossMachine = () => {
      ctoCrossMachine ??= createCtoCrossMachineBridge({
        projectRoot,
        appVersion: ctoAppVersion,
        logger,
        getLocalActionCaller: getCtoLocalActionCaller,
        getAccess: () => ctoStateService.getCrossMachineAccess(),
      });
      return ctoCrossMachine;
    };
    const ctoStateService = createCtoStateService({
      db,
      projectId,
      adeDir: paths.adeDir,
      ctoMemoryService,
      capabilities: { crossMachine: true },
      // Resolved on every refresh, not captured here: the chat and automation
      // services are constructed further down, so the live block must read
      // them through a thunk rather than pin whatever was null at this point.
      getLiveStateSources: () => {
        const chat = agentChatService;
        if (!chat) return null;
        return {
          laneService,
          prService: headlessLinearServices.prService,
          automationService: automationServiceRef,
          listChats: chat.listSessions,
          // Only a bridge the CTO's tools already built: the live-state block
          // must not be what starts reading the account directory.
          crossMachine: ctoCrossMachine,
        };
      },
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
    /**
     * Apple device settings are per computer (Settings › This computer › Apple
     * devices): this device's own value first, then the account-wide value
     * older desktops wrote. Read lazily, so a value that syncs in later lands.
     */
    const readAppleDeviceSetting = (key: string): unknown => {
      let deviceKey: string | null = null;
      try {
        deviceKey = accountDeviceSettingKey(syncService?.getLocalDeviceId() ?? null, key);
      } catch {
        deviceKey = null;
      }
      const own = deviceKey ? accountSettingsStore?.get(ACCOUNT_SCOPE_ALL, deviceKey) : undefined;
      return own ?? accountSettingsStore?.get(ACCOUNT_SCOPE_ALL, key);
    };
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
        /*
         * The reverse map, and it matters MORE here than in the desktop.
         *
         * Agent `ade apple` calls arrive at the brain, and an agent whose shell
         * carries no `ADE_LANE_ID` — every OpenCode agent, since one shared
         * `opencode serve` cannot hold a per-chat environment — names no lane.
         * Without this the service falls back to "whichever single lane is
         * running something", and one agent's screenshot was filed against an
         * unrelated lane. The desktop got this dep first and the brain did not,
         * which is exactly why the live check still failed after the fix.
         */
        resolveLaneIdForPath: (absolutePath: string): string | null => {
          try {
            return laneService.getLaneIdForPath(absolutePath);
          } catch {
            return null;
          }
        },
        // The lanes DB backs `lane_apple_devices`; without it a lane device is
        // remembered only for the life of the process.
        laneDeviceStore: db,
        // The recording halves that live outside the simulator service: the
        // proof-drawer broker that files a pinned recording, and the overlay
        // switches from account settings. Without these the constructed
        // recorder writes video nobody can find and draws overlays the user
        // switched off.
        recordingDeps: {
          artifactFiler: computerUseArtifactBrokerService,
          readOverlaySetting: (key) => {
            const value = readAppleDeviceSetting(key);
            return typeof value === "boolean" ? value : undefined;
          },
          // ADE's own accent, mirrored in `shared/themeTokens.ts` and guarded
          // by a test against `renderer/index.css`. The recorder ran on its
          // own hardcoded blue before this, so every tap ring in every proof
          // video was a colour that appears nowhere in the product.
          accentColor: () => ADE_ACCENT_COLOR,
        },
        onEvent: (event) => pushEvent("runtime", {
          type: "ios_simulator_event",
          // An agent revealing the device opens it where the user is talking from.
          event: event.type === "drawer-open-requested" && event.chatSessionId
            ? {
              ...event,
              targetClientId: getSessionInputOrigin(event.chatSessionId, { maxAgeMs: RECENT_INPUT_ORIGIN_MS })?.clientId ?? null,
            }
            : event,
        }),
        // Lane-device cleanup and idle power-off for this project.
        backgroundMaintenance: true,
      });
    teardown.push(() => iosSimulatorService?.dispose());
    if (iosSimulatorService) {
      // An archived or deleted lane lets go of its Apple device session here;
      // the device itself goes in `releaseLaneAppleDevice`.
      laneTeardownDeps.iosSimulatorService = {
        stopForLane: (laneId: string) => iosSimulatorService.stopForLane(laneId),
      };
    }
    /**
     * Brain-side video forwarder for remote viewers.
     *
     * Only the brain can read the helper's loopback body, so this is the one
     * hop between a phone / web tab / Windows desktop and the device screen.
     * It registers itself with the sync listener's socket router rather than
     * being threaded through the listener constructors: the listener is
     * machine-wide and outlives project switches, while this is per-project.
     */
    const appleRemoteBitrateKbpsCap = (): number | null => {
      try {
        const value = readAppleDeviceSetting(APPLE_DEVICE_SETTING_KEYS.remoteBitrateKbpsCap);
        return typeof value === "number" && Number.isFinite(value)
          ? clampAppleRemoteBitrateKbps(value)
          : DEFAULT_APPLE_REMOTE_BITRATE_KBPS;
      } catch {
        return DEFAULT_APPLE_REMOTE_BITRATE_KBPS;
      }
    };
    const appleStreamRelay = iosSimulatorService
      ? createAppleStreamRelayForService({
        service: iosSimulatorService,
        remoteBitrateKbpsCap: appleRemoteBitrateKbpsCap,
        logger,
      })
      : null;
    if (appleStreamRelay) {
      const detachAppleStreamRoute = setActiveAppleStreamRouter(appleStreamRelay);
      teardown.push(() => {
        detachAppleStreamRoute();
        appleStreamRelay.dispose();
      });
    }
    // Late-bound chat session lookup. agentChatService is created after
    // appControlService below, so we capture a holder that the resolveLaneId
    // closure reads at call time. The chat session store lives in agentChatService
    // (getSessionSummary), not in sessionService (which holds terminal sessions).
    const agentChatServiceHolder: { current: ReturnType<typeof createAgentChatService> | null } = { current: null };
    // `built_in_browser` is hosted by the desktop's Electron main process (the
    // browser pane owns a WebContentsView). The runtime daemon proxies calls
    // through `<adeHome>/sock/desktop-bridge.sock`; if no desktop is running,
    // individual calls fail clearly. Override the socket path with
    // `ADE_DESKTOP_BRIDGE_SOCKET_PATH` for dev launches that use a non-default
    // ADE home.
    const builtInBrowserBridgeSocketPath =
      process.env.ADE_DESKTOP_BRIDGE_SOCKET_PATH?.trim()
      || resolveMachineAdeLayout().desktopBridgeSocketPath;
    // Whether the desktop app answers on its bridge, as last probed. The brain
    // asks for itself rather than waiting to be told: it probes at start, when
    // a desktop connects, and in the background whenever the answer is older
    // than DESKTOP_BRIDGE_PROBE_STALE_MS and someone reads it. Browser calls do
    // not read it at all — each one just dials the socket.
    // `result` is null until the first probe answers.
    let desktopBridgeProbe: { result: DesktopBridgeProbe | null; at: number } = { result: null, at: 0 };
    let desktopBridgeProbeInFlight: Promise<void> | null = null;
    const DESKTOP_BRIDGE_PROBE_STALE_MS = 10_000;
    const refreshDesktopBridgeProbe = (): Promise<void> => {
      if (desktopBridgeProbeInFlight) return desktopBridgeProbeInFlight;
      desktopBridgeProbeInFlight = probeDesktopBridge({ socketPath: builtInBrowserBridgeSocketPath })
        .then((result) => {
          const changed = desktopBridgeProbe.result?.attached !== result.attached;
          desktopBridgeProbe = { result, at: Date.now() };
          if (changed) {
            logger[result.attached ? "info" : "warn"]("built_in_browser_bridge.desktop_probe", {
              socketPath: builtInBrowserBridgeSocketPath,
              projectRoot,
              attached: result.attached,
              ...(result.attached ? {} : { kind: result.kind, reason: result.reason }),
            });
          }
        })
        .finally(() => {
          desktopBridgeProbeInFlight = null;
        });
      return desktopBridgeProbeInFlight;
    };
    const readDesktopBridgeProbe = (): DesktopBridgeProbe | null => {
      if (Date.now() - desktopBridgeProbe.at > DESKTOP_BRIDGE_PROBE_STALE_MS) {
        void refreshDesktopBridgeProbe();
      }
      return desktopBridgeProbe.result;
    };
    const desktopBridgeAttached = (): boolean => readDesktopBridgeProbe()?.attached === true;
    /** Why the desktop app does not answer; null while it does or before the first probe. */
    const desktopBridgeUnattachedReason = (): string | null => {
      const probe = readDesktopBridgeProbe();
      return probe && !probe.attached ? probe.reason : null;
    };
    // Windows/Linux App Control recording runs in the desktop's encoder, over
    // the desktop bridge. Set once the bridge client exists (below); null
    // while no desktop has attached here, which refuses a screencast start.
    const desktopBridgeHolder: {
      current: ReturnType<typeof createAppControlRecorderBridgeClient> | null;
      /** The desktop's Chromium demo engine, over the same bridge. */
      demoEngine: ReturnType<typeof createDemoEngineBridgeClient> | null;
      /** The desktop's scene previewer, over the same bridge. */
      scenePreview: ScenePreviewer | null;
    } = { current: null, demoEngine: null, scenePreview: null };
    const appControlService = chatOnlyRuntime
      ? null
      : createAppControlService({
        projectRoot,
        logger,
        ptyService,
        onEvent: (event) => {
          if (event.type === "session-started") {
            captureAppControlAnalytics({ analytics: productAnalyticsService, outcome: "started" });
          }
          pushEvent("runtime", { type: "app_control_event", event });
        },
        resolveChatLaneId: async (chatId) => {
          if (!agentChatServiceHolder.current) return null;
          const chatSession = await agentChatServiceHolder.current.getSessionSummary(chatId).catch(() => null);
          return chatSession?.laneId ?? null;
        },
        getScreencastRecorder: () =>
          desktopBridgeAttached() ? desktopBridgeHolder.current : null,
        getChromiumDemoEngine: () =>
          desktopBridgeAttached() ? desktopBridgeHolder.demoEngine : null,
        // A lane may not attach to an app another lane's Mac Desktop holds.
        // Read at call time: the Mac Desktop service is built just below.
        macDesktopLaneForProcess: (pid: number): string | null => macDesktopService?.laneForProcess(pid) ?? null,
        ingestArtifacts: (request) => computerUseArtifactBrokerService.ingest(request),
        resolvePrimaryPrUrl: (laneId: string): string | null =>
          prServiceRef?.getForLane(laneId)?.githubUrl ?? null,
        resolveLaneName: async (laneId: string): Promise<string | null> => {
          const lane = await laneService.getSummary(laneId).catch(() => null);
          return lane?.name ?? null;
        },
        resolveLaneWorktreePath: async (laneId: string): Promise<string | null> => {
          const lane = await laneService.getSummary(laneId, { includeStatus: false }).catch(() => null);
          return lane?.worktreePath ?? null;
        },
        // No fallback lane: a session whose lane cannot be resolved is refused.
        resolveLaneId: ({ cwd, laneId, chatSessionId }) => resolveSessionLaneId({
          laneId,
          chatSessionId,
          cwd,
          getChatLaneId: async (chatId) => {
            if (!agentChatServiceHolder.current) return null;
            const chatSession = await agentChatServiceHolder.current.getSessionSummary(chatId).catch(() => null);
            return chatSession?.laneId ?? null;
          },
          isLiveLane: (id) => laneService.findLaneIdentity(id) !== null,
          laneIdForPath: (absolutePath) => laneService.getLaneIdForPath(absolutePath),
          isPrimaryLane: async (id) => (await laneService.getSummary(id, { includeStatus: false }))?.laneType === "primary",
        }),
      });
    // Teardown runs last-in first-out. The recorder bridge client is created
    // further down, but its release is registered here so it runs AFTER
    // appControlService.dispose: the service cancels its running recordings
    // through that client, and a client disposed first drops the cancels,
    // orphaning the desktop's encoder window for the lane.
    teardown.push(() => {
      const bridge = desktopBridgeHolder.current;
      desktopBridgeHolder.current = null;
      bridge?.dispose();
      const demoEngine = desktopBridgeHolder.demoEngine;
      desktopBridgeHolder.demoEngine = null;
      demoEngine?.dispose();
      const scenePreview = desktopBridgeHolder.scenePreview;
      desktopBridgeHolder.scenePreview = null;
      scenePreview?.dispose();
    });
    teardown.push(() => appControlService?.dispose());
    if (appControlService) {
      // An archived or deleted lane takes its App Control session with it.
      laneTeardownDeps.appControlService = {
        stopForLane: (laneId: string) => appControlService.stopForLane(laneId),
      };
    }
    /**
     * One private macOS screen per lane.
     *
     * Constructed next to the iOS simulator and App Control services, and for
     * the same reason: it owns a host capability a chat can claim, so it needs
     * the same chat-end release and the same lane teardown. It is created on
     * every platform — `getStatus` answers everywhere and says `supported:
     * false` off macOS, which is what lets a Windows desktop hide the tab by
     * reading rather than by catching a throw.
     */
    const macDesktopLogger = createMacDesktopLogger(logger, getMacDesktopMachineLogger());
    const macDesktopService = chatOnlyRuntime
      ? null
      : createMacDesktopService({
        projectRoot,
        logger: macDesktopLogger,
        // Windows hosts reuse the whole seat service; only the helper, the
        // provider, and the permission story differ. `adeHome` is what the
        // helper's host mode takes as `--ade-home`.
        seat: process.platform === "win32"
          ? createWindowsDesktopSeatAdapter({
            logger: macDesktopLogger,
            adeHome: resolveMachineAdeLayout().adeDir,
          })
          : null,
        adeHome: resolveMachineAdeLayout().adeDir,
        // `ade-media` on macOS; the attached desktop's Chromium engine (over
        // the desktop bridge) everywhere, which is what turns a Windows lane's
        // MP4 recording into its demo. Read per stop: a desktop may attach late.
        demoEngines: createDemoEngineSet({
          logger: macDesktopLogger,
          getChromiumDemoEngine: () =>
            desktopBridgeAttached() ? desktopBridgeHolder.demoEngine : null,
          getChromiumUnavailableReason: desktopBridgeUnattachedReason,
        }),
        onEvent: (event) => pushEvent("runtime", { type: "mac_desktop_event", event }),
        resolveLaneWorktreePath: (laneId: string): string | null => {
          try {
            return laneService.getLaneWorktreePath(laneId);
          } catch {
            return null;
          }
        },
        resolveLaneName: async (laneId: string): Promise<string | null> => {
          const lane = await laneService.getSummary(laneId).catch(() => null);
          return lane?.name ?? null;
        },
        // The lane's primary pull request becomes a `github_pr` proof owner
        // with the existing `published_to` relation, exactly as the browser and
        // simulator proof paths do.
        resolvePrimaryPrUrl: (laneId: string): string | null =>
          prServiceRef?.getForLane(laneId)?.githubUrl ?? null,
        ingestArtifacts: (request) => computerUseArtifactBrokerService.ingest(request),
        isArtifactFileReferenced: (filePath) => computerUseArtifactBrokerService.isFileReferenced(filePath),
        // A lane may not claim another lane's App Control app onto its screen.
        appControlLaneForProcess: (pid: number): Promise<string | null> | null =>
          appControlService?.laneForAppProcess(pid) ?? null,
        // The lease question rides the normal pending-input card.
        requestChatInput: async (input) => {
          const chat = agentChatServiceHolder.current;
          if (!chat?.requestChatInput) {
            throw new Error("This runtime cannot ask for input, so real desktop input cannot be granted.");
          }
          return await chat.requestChatInput(input);
        },
        readSetting: <T,>(key: string): T | null => db.getJson<T>(key),
        writeSetting: (key: string, value: unknown) => db.setJson(key, value),
        captureAnalytics: (properties) => captureMacDesktopAnalytics({
          analytics: productAnalyticsService,
          properties,
        }),
      });
    teardown.push(() => macDesktopService?.dispose());
    // With no desktop attached HERE, `browser open` is still satisfiable: a
    // desktop that holds a remote pin on this machine can open the URL in its
    // own browser and reach this machine's localhost through a port-forward.
    const remoteBrowserForwarder = chatOnlyRuntime
      ? null
      : createRemoteBrowserForwarder({
        emitEvent: (payload) => pushEvent("runtime", payload),
        logger,
        resolveOrigin: (chatSessionId) => getSessionInputOrigin(chatSessionId),
      });
    if (remoteBrowserForwarder) teardown.push(() => remoteBrowserForwarder.dispose());
    const builtInBrowserBridge: BuiltInBrowserDesktopBridgeClient | null = remoteBrowserForwarder
      ? withRemoteBrowserForwarding(
        createBuiltInBrowserDesktopBridgeClient({
          socketPath: builtInBrowserBridgeSocketPath,
          projectRoot,
          logger,
        }),
        remoteBrowserForwarder,
      )
      : null;
    if (appControlService) {
      const appControlRecorderBridge = createAppControlRecorderBridgeClient({
        socketPath: builtInBrowserBridgeSocketPath,
        logger,
      });
      desktopBridgeHolder.current = appControlRecorderBridge;
      desktopBridgeHolder.demoEngine = createDemoEngineBridgeClient({
        socketPath: builtInBrowserBridgeSocketPath,
        logger,
      });
      desktopBridgeHolder.scenePreview = createScenePreviewBridgeClient({
        socketPath: builtInBrowserBridgeSocketPath,
      });
      void refreshDesktopBridgeProbe();
      // Released by the teardown step registered before appControlService's.
    }
    teardown.push(() => {
      builtInBrowserBridge?.dispose();
    });

    // Dev servers this project's lanes run: what terminals and agent shells
    // printed, plus what the listener scan finds. Published on the runtime
    // stream so a desktop on another machine lights up its Browser the same
    // way one on this machine does.
    const devServerWatcher = chatOnlyRuntime
      ? null
      : createDevServerWatcher({
        registry: devServerRegistry,
        projectRoot,
        listLaneRoots: async () =>
          (await laneService.list({ includeArchived: false, includeStatus: false }))
            .map((lane) => ({ laneId: lane.id, root: lane.worktreePath })),
        logger,
      });
    if (devServerWatcher) {
      const publishDevServer = (kind: DevServerEvent["kind"]) => (record: DevServerRecord) => {
        if (!devServerWatcher.ownsRecord(record)) return;
        pushEvent("runtime", { type: DEV_SERVER_EVENT, event: { kind, server: record } satisfies DevServerEvent });
      };
      const stopDetected = devServerRegistry.onDetected(publishDevServer("detected"));
      const stopRemoved = devServerRegistry.onRemoved(publishDevServer("removed"));
      teardown.push(() => {
        stopDetected();
        stopRemoved();
        devServerWatcher.dispose();
      });
    }

    // Read-only view of the Work tools pane for iOS and the hosted web client.
    // Built here because it is the first point where BOTH of its sources exist:
    // the in-process App Control service and the desktop browser bridge.
    const workToolsStateService = createWorkToolsStateService({
      projectRoot,
      // Deliberately `getStatusForRuntime`, not `getStatus`: the aggregator
      // needs the project-scoped, read-only projection, not one chat's view.
      getBrowserStatus: builtInBrowserBridge
        ? () => builtInBrowserBridge.getStatusForRuntime()
        : null,
      getAppControlStatus: appControlService
        ? (laneId) => appControlService.getStatus({ laneId })
        : null,
      // The runtime's own Mac Desktop service, read-only: the mirror holds
      // `getStatus` + `subscribe` and nothing that can start a display or move
      // a pointer. Null only on a chat-only runtime, which builds no service.
      macDesktopService,
      onStateChanged: (laneId) =>
        pushEvent("runtime", { type: WORK_TOOLS_STATE_CHANGED_EVENT, laneId }),
      // `ade ui show`: the desktops on this project read the same runtime
      // stream, so the request reaches a paired desktop on another machine too.
      showRequests: createWorkToolShowRequests({
        emitEvent: (payload) => pushEvent("runtime", payload),
        logger,
        // Show it on the screen of whoever is talking to the chat.
        resolveTargetClientId: (chatSessionId, kind) => getSessionInputOrigin(
          chatSessionId,
          kind === "auto" ? { maxAgeMs: RECENT_INPUT_ORIGIN_MS } : {},
        )?.clientId ?? null,
      }),
      devServers: devServerWatcher
        ? {
          list: async (args) => {
            // Someone is looking at a Browser: make the answer current first.
            await devServerWatcher.refresh();
            return devServerRegistry.list(args).filter(devServerWatcher.ownsRecord);
          },
          probePort: (port) => probeLocalhostPort(port),
        }
        : null,
      logger,
    });
    teardown.push(() => workToolsStateService.dispose());

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
      laneWorktreeLockService,
      autoRebaseService,
      rebaseSuggestionService,
      openExternal: async () => {},
      onGitHubStatusChanged: (status) =>
        pushEvent("runtime", { type: "github_status_changed", event: status }),
      getAccountAccessToken,
      getAccountVault: accountRuntimeLifecycle.getAccountVault,
      getAccountUserId: () => accountAuthService.getStatus().userId,
      getDeviceId: readSyncDeviceId,
      refreshDefaultBranchAfterMerge: embeddedRuntime
        ? undefined
        : async (baseBranch) => {
            // A merge into a stacked parent branch leaves the default branch alone.
            if (!isDefaultBranchMerge(baseBranch, baseRef)) return;
            await defaultBranchAutoPullService.runOnce();
          },
    });
    linearCredentialServiceForAccount = headlessLinearServices.linearCredentialService;
    teardown.push(() => headlessLinearServices.dispose());
    linearIssueTrackerRef = headlessLinearServices.linearIssueTracker;
    githubServiceRef = headlessLinearServices.githubService as ReturnType<typeof createGithubService>;
    prServiceRef = headlessLinearServices.prService;
    // Follow-up PR branches an agent cuts inside its lane worktree: link their
    // PRs to the lane (and to the chats that were open when they were made).
    laneService.setOnBranchHistoryObserved((args) => {
      void prServiceRef?.autoLinkLaneBranchHistory(args);
    });
    if (macDesktopService) {
      // Runs on every platform: off macOS `destroyForLane` is a no-op, so the
      // teardown step never has to know what host it is on.
      laneTeardownDeps.macDesktopService = {
        destroyForLane: (laneId: string) => macDesktopService.destroyForLane(laneId),
      };
    }
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
    // Built after the chat service; smart balance and the usage-limit account
    // switch read it through this late binding.
    let usageTrackingServiceRef: ReturnType<typeof attachSharedUsageTrackingScope> | null = null;
    // Machine-level, like the quota poller: every project scope in this brain
    // writes one ledger under `<adeHome>/usage/`.
    const turnUsageLedger = getSharedTurnUsageLedger(resolveMachineAdeLayout().adeDir, logger);
    // Machine-level as well: one daily usage research report per finished
    // local day, read from that ledger. It sends nothing while product
    // analytics is off, and `ADE_USAGE_RESEARCH=0` turns it off.
    const detachUsageResearch = attachSharedUsageResearchUploader(resolveMachineAdeLayout().adeDir, () =>
      createUsageResearchUploader({
        adeDir: resolveMachineAdeLayout().adeDir,
        store: turnUsageLedger.store,
        analytics: productAnalyticsService,
        appVersion: process.env.ADE_CLI_VERSION?.trim() || BUNDLED_ADE_VERSION || "0.0.0",
        logger,
      }));
    teardown.push(() => detachUsageResearch());

    // Machine-level as well: the model router in shadow mode. It reads the
    // daily model registry from the account directory (signed-in accounts
    // only), this brain's model catalog, and the ledger's quota windows, and
    // logs the route it would have picked for each subagent. It changes no
    // turn. `ADE_MODEL_ROUTER_SHADOW=0` turns the watching off.
    const sharedModelRouter = attachSharedModelRouter({
      adeDir: resolveMachineAdeLayout().adeDir,
      modelSource: async (provider) => (await agentChatService?.getAvailableModels({ provider })) ?? [],
      create: (getAvailableModels) => createModelRouterService({
        usageDir: turnUsageLedger.store.dir,
        registry: createModelRegistryStore({
          dir: path.join(resolveMachineAdeLayout().adeDir, "router"),
          overrideFile: process.env.ADE_MODEL_REGISTRY_FILE?.trim() || null,
          logger,
          fetchSnapshot: createWorkerRegistryFetcher({
            baseUrl: () => getSharedAccountDirectoryBaseUrl({ projectRoots: () => [projectRoot] }),
            getToken: async () => {
              const token = await getAccountAccessToken();
              if (!token) throw new Error("not signed in");
              return token;
            },
          }),
        }),
        getAvailableModels,
        readTurns: (sinceMs) => turnUsageLedger.store.readTurns({ sinceMs }),
        readQuotaSamples: (sinceMs) => turnUsageLedger.store.readQuotaSamples({ sinceMs }),
        logger,
      }),
    });
    teardown.push(() => sharedModelRouter.detach());
    const modelRouter = sharedModelRouter.service;

    let agentChatService = headlessLinearServices.agentChatService as unknown as ReturnType<typeof createAgentChatService> | null;
    // Built after automations; chat events reach it through this late binding.
    let linearAgentRuntime: LinearAgentRuntime | null = null;
    if (resolvedArgs.chatRuntime === "agent") {
      agentChatService = createAgentChatService({
        machineAdeHome: resolveMachineAdeLayout().adeDir,
        runtimeBudget: chatRuntimeBudget,
        projectRoot,
        runtimeSocketPath,
        sessionActivityReportingEnabled,
        adeDir: paths.adeDir,
        transcriptsDir: paths.transcriptsDir,
        fileService: headlessLinearServices.fileService,
        linearIssueTracker: headlessLinearServices.linearIssueTracker,
        githubService: headlessLinearServices.githubService,
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
        getAccountUsage: () => usageTrackingServiceRef,
        getUsageService: () => usageTrackingServiceRef,
        conflictService,
        computerUseArtifactBrokerService,
        // One line of system prompt and the per-turn time-lapse clip, both
        // behind the same synchronous gate: the send path must not await a
        // service to decide to say nothing, so it reads the in-memory display
        // registry, and an idle lane pays nothing.
        macDesktopTurnRecorder: macDesktopService
          ? {
            hasDisplaySync: (laneId) => macDesktopService.hasDisplaySync(laneId),
            supportsLaneDisplaySync: () => macDesktopService.supportsLaneDisplaySync(),
            beginTurn: (args) => macDesktopService.beginTurn(args),
            noteTurnEnded: (args) => macDesktopService.noteTurnEnded(args),
          }
          : null,
        laneService,
        sessionService,
        processRegistry,
        projectConfigService,
        db,
        aiIntegrationService,
        ctoStateService,
        ctoMemoryService,
        // The CTO acting on the account's other machines, for this project's
        // repository there. Built on first use: most CTO turns never leave the
        // home machine, and a project with no CTO turns never pays for it.
        getCtoCrossMachine,
        logger,
        appVersion: "ade-cli",
        getAdeCliAgentEnv: createHeadlessAdeCliAgentEnv,
        getLocalGitHubToken: () => headlessLinearServices.githubService.getGitTransportTokenOrThrowAsync(),
        onLinearIssueChatLinked: publishLinearChatLink,
        onEvent: (event) => {
          feedDemoTrackFromChatEvent(event);
          linearAgentRuntime?.onChatEvent(event);
          pushEvent("runtime", event as unknown as Record<string, unknown>);
        },
        onTurnSettled: (event) => captureAgentTurnSettledAnalytics({
          analytics: productAnalyticsService,
          projectId,
          event,
        }),
        turnUsageLedger,
        modelRouter,
        onClaudeHooksIgnored: (event) => captureClaudeHooksIgnoredAnalytics({
          analytics: productAnalyticsService,
          projectId,
          event,
        }),
        onClaudePluginsIgnored: (event) => captureClaudePluginsIgnoredAnalytics({
          analytics: productAnalyticsService,
          projectId,
          event,
        }),
        onChatMentionsExpanded: (event) => captureChatMentionsExpandedAnalytics({
          analytics: productAnalyticsService,
          projectId,
          sessionId: event.sessionId,
        }),
        onSessionMetadataRegenerated: (event) => captureSessionMetadataRegeneratedAnalytics({
          analytics: productAnalyticsService,
          projectId,
          event,
        }),
        onAutoResumeOutcome: (properties) => captureChatAutoResumeAnalytics({
          analytics: productAnalyticsService,
          properties,
        }),
        onPendingInputDismissed: ({ provider }) => capturePendingInputDismissedAnalytics({
          analytics: productAnalyticsService,
          surface: "api",
          provider,
        }),
        onAccountSwitched: ({ provider }) => captureChatAccountSwitchedAnalytics({
          analytics: productAnalyticsService,
          surface: "api",
          provider,
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
    // The broker judges an attached video against the chat's turn start.
    computerUseArtifactBrokerService.setChatTurnStartResolver(
      (sessionId) => agentChatService?.getTurnStartedAt?.(sessionId) ?? null,
    );
    computerUseArtifactBrokerService.setChatTurnIdResolver(
      (sessionId) => agentChatService?.getTurnId?.(sessionId) ?? null,
    );
    bindIosSimulatorReleaseOnChatEnd({
      agentChatService,
      iosSimulatorService,
      logger,
    });
    // A chat that ends must drop its Mac Desktop input lease; otherwise the
    // lane stays un-drivable until the lease TTL lapses.
    bindDeviceReleaseOnChatEnd({
      agentChatService,
      device: macDesktopService
        ? { releaseIfOwnedBy: (sessionId: string) => macDesktopService.releaseIfOwnedBy(sessionId) }
        : null,
      logEvent: "mac_desktop.release_on_chat_end_failed",
      logger,
    });
    // A chat that ends releases the App Control session it owns: ADE quits
    // the app it launched and detaches one it only attached to.
    bindDeviceReleaseOnChatEnd({
      agentChatService,
      device: appControlService
        ? { releaseIfOwnedBy: (sessionId: string) => appControlService.stopForChat(sessionId) }
        : null,
      logEvent: "app_control.release_on_chat_end_failed",
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
      settleTeardownRef.subagentLinks = settleWiring.listSubagentLinks;
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
    const chatLaunchService = agentChatService
      ? createChatLaunchService({
        launchesDir: path.join(paths.cacheDir, "chat-launches"),
        logger,
        laneService,
        agentChatService,
        usesLocalLaneBase: () => {
          try {
            return projectConfigService.getEffective().git?.newLaneBaseSource === "local";
          } catch {
            return false;
          }
        },
        resolveBase: async (progress) => {
          const resolution = await resolveLaneCreateRemoteBaseDetailed({
            laneService,
            gitService,
            projectConfigService,
            ...(progress?.signal ? { signal: progress.signal } : {}),
            ...(progress?.onWaitingForStaleFetch ? { onWaitingForStaleFetch: progress.onWaitingForStaleFetch } : {}),
          });
          const { baseRef, fetchSucceeded, fetchOutcome, fetchError, freshness, stale } = resolution;
          const fetch = !baseRef
            ? "skipped"
            : fetchSucceeded === false
              ? (fetchOutcome === "timeout" ? "timeout" : "failed")
              : "ok";
          return {
            baseRef,
            fetch,
            fetchError: fetchError ?? null,
            lastFetchedAtMs: freshness?.lastFetchedAtMs ?? null,
            baseCommittedAtMs: freshness?.committedAtMs ?? null,
            behindLocal: freshness?.behindLocal ?? null,
            stale: stale === true,
          };
        },
        resolveCommit: (ref) => resolveGitCommit(ref, projectRoot),
        resolveChatCreate: (create) => resolveChatCreateModel(agentChatService, create),
        planEnvironment: (requestedTemplateId) => {
          const effective = projectConfigService.getEffective();
          const requested = requestedTemplateId?.trim() || null;
          const templateId = requested || laneTemplateService.getDefaultTemplateId();
          const template = templateId ? laneTemplateService.getTemplate(templateId) : null;
          // An explicitly requested template that no longer resolves must fail
          // the launch, not silently run without it. A stale DEFAULT template
          // still degrades quietly as before.
          if (requested && !template) {
            throw new Error(`The selected lane template no longer exists: ${requested}`);
          }
          return planNewLaneEnvironment({
            laneEnvInit: effective.laneEnvInit ?? null,
            laneOverlayPolicies: effective.laneOverlayPolicies ?? null,
            defaultTemplate: template,
          });
        },
        runEnvironment: ({ laneId, templateId }) =>
          runLaneEnvironmentSetup(
            {
              laneService,
              projectConfigService,
              portAllocationService,
              laneEnvironmentService,
              laneTemplateService,
            },
            { laneId, templateId },
          ),
        onEnvironmentEvent: (listener) => laneEnvironmentService.onEvent(listener),
        abortEnvironment: ({ laneId, worktreePath }) => {
          laneEnvironmentService.abortLaneEnvironment(laneId, worktreePath);
        },
        emit: (event) => pushEvent("runtime", { type: "chat_launch_event", event }),
        onOutcome: ({ outcome, provider }) => captureNewLaneLaunchAnalytics({
          analytics: productAnalyticsService,
          surface: "api",
          outcome,
          provider,
        }),
      })
      : null;
    if (chatLaunchService) teardown.push(() => chatLaunchService.dispose());
    // Automations are unattended work the machine's own ADE schedules and owns.
    // An embedded runtime runs inside somebody else's process on somebody
    // else's lifecycle, so it must not start rules, fire ingress dispatches, or
    // compete with the real brain for them. The ingress service itself still
    // builds (it is the shared webhook plumbing and no-ops without rules).
    const automationFeatureEnabled = !embeddedRuntime && automationsEnabledForHeadlessRuntime();
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
      webhooks: {
        db,
        projectId,
        readSecret: (name) => {
          try {
            return projectSecretService.get({ name }).value;
          } catch {
            return null;
          }
        },
      },
      // 30s halves worst-case webhook latency. Each poll is one request to our
      // own relay worker (no GitHub data cost); the service floors at 30s.
      pollIntervalMs: 30_000,
    });
    teardown.push(() => automationIngressService?.dispose());
    const headlessLinearAccessToken = createLinearAccessTokenGetter(headlessLinearServices.linearCredentialService);
    const agentChat = agentChatService;
    linearAgentRuntime = automationService && agentChat
      ? createLinearAgentRuntime({
        db,
        logger,
        automationService,
        getLinearAccessToken: headlessLinearAccessToken,
        getAccountAccessToken,
        getAccountId: () => accountAuthService.getStatus().userId ?? null,
        getMachineId: readSyncDeviceId,
        projectId,
        chat: {
          sendMessage: (args) => agentChat.sendMessage(args, { routeActiveToSteer: true }),
          interrupt: (args) => agentChat.interrupt(args),
          respondToInput: (args) => agentChat.respondToInput(args),
          getAvailableModels: (args) => agentChat.getAvailableModels(args),
        },
        laneService,
        fetchIssue: (issueId) => headlessLinearServices.linearClient.fetchIssueById(issueId),
      })
      : null;
    teardown.push(() => linearAgentRuntime?.dispose());
    // Linear inbox items about a lane's issue raise "needs you" on that lane.
    // Skipped in an embedded runtime: the real brain owns attention.
    const linearInboxAttention = embeddedRuntime
      ? null
      : createLinearInboxAttentionService({
        logger,
        kv: db,
        isLinearConnected: () => headlessLinearServices.linearCredentialService.getStatus().tokenStored === true,
        listNotifications: () => headlessLinearServices.linearClient.listNotifications({ first: 50 }),
        listLanes: () => laneService.list({ includeArchived: false }),
        latestSessionInLane: (laneId) => sessionService.list({ laneId, limit: 1 })[0]?.id ?? null,
        requestAttention: (sessionId, message) => {
          sessionService.requestAttention(sessionId, message, "linear");
        },
      });
    linearInboxAttention?.start();
    // A PR for a Linear issue carries the lane's proof onto the issue.
    const postLinearProof = createLinearProofPoster({
      logger,
      kv: db,
      listLaneProof: (laneId) => computerUseArtifactBrokerService.listArtifacts({ owner: { kind: "lane", id: laneId } }),
      resolveFilePath: (artifact) => computerUseArtifactBrokerService.resolveArtifactFilePath(artifact),
      uploadAttachment: (args) => headlessLinearServices.linearClient.uploadAttachment(args),
      createComment: (issueId, body) => headlessLinearServices.linearClient.createComment(issueId, body),
    });
    headlessLinearServices.prService.setLinearPrPublishedHandler(async ({ lane, issueIds, prNumber, githubUrl }) => {
      await postLinearProof({ laneId: lane.id, laneName: lane.name, issueIds, prNumber, githubUrl });
    });
    teardown.push(() => linearInboxAttention?.stop());
    if (linearAgentRuntime) {
      const agentRelay = linearAgentRuntime.relay;
      linearOAuthService.setAgentTokenHandler(async (token) => {
        await agentRelay.install(token);
      });
      // Joining the member map is what routes a person's own delegations to
      // their own machines. Only a personal OAuth sign-in joins on its own (an
      // API key may be shared), and it never takes over a mapping that routes
      // to another ADE account; Settings asks before it does that.
      if (headlessLinearServices.linearCredentialService.getStatus().authMode === "oauth") {
        void agentRelay.registerMember().catch(() => {});
      }
    }
    const linearIngressService = automationService
      ? createLinearIngressService({
        db,
        projectId,
        credentialStore: new EncryptedFileCredentialStore({
          secretsDir: path.join(paths.adeDir, "secrets"),
        }),
        getLinearClient: () => headlessLinearServices.linearClient,
        getLinearAccessToken: headlessLinearAccessToken,
        getAccountAccessToken,
        cursorStore: createKvIngressCursorStore(db),
        hasEnabledLinearRules: () => automationService?.hasEnabledLinearRules() ?? false,
        getAgentSubscribeTarget: () => linearAgentRuntime?.relay.subscribeTarget() ?? Promise.resolve(null),
        // Linear-linked lanes stay in step with Linear even with no rules.
        wantsLinearEvents: () => {
          try {
            return laneService.hasLinearLinkedLanes();
          } catch {
            return false;
          }
        },
        isAdeAppConnection: () => {
          const credentials = headlessLinearServices.linearCredentialService;
          return credentials.getStatus().authMode === "oauth"
            && credentials.getOAuthClientSource() === "ade-app";
        },
        dispatch: async (record) => {
          const issuePatch = linearIssuePatchFromEvent(record);
          if (issuePatch) {
            try {
              laneService.refreshLinearIssueSnapshots(issuePatch);
            } catch (error) {
              logger.warn("linear.lane_snapshot_refresh_failed", { eventId: record.eventId, error: error instanceof Error ? error.message : String(error) });
            }
          }
          if (!automationService) return;
          linearAgentRuntime?.dispatch(record);
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
      // Only a project with an enabled cursor.* rule polls the relay.
      wantsEvents: () => automationService?.hasEnabledCursorCloudRules() ?? false,
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
      // Unconfigured counts as available: enabling the first cursor.* rule is
      // what starts the self-configuring poll, so gating on "ready" would make
      // that first rule impossible to enable.
      const status = cursorCloudIngressService.getStatus();
      return status.state !== "error" || Boolean(status.webhookId);
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
    const cloudAgentsService = createCloudAgentsServiceFromHost({
      projectRoot,
      logger,
      laneService,
      getAgentChatService: () => agentChatService ?? null,
      cursorFleet: cursorCloudFleetService,
      archiveCursorAgent: (agentId) => aiIntegrationService.archiveCursorCloudAgent(agentId),
      unarchiveCursorAgent: (agentId) => aiIntegrationService.unarchiveCursorCloudAgent(agentId),
      cursorCreateRun: (args) => aiIntegrationService.createCursorCloudRun({ ...args, workOnCurrentBranch: true }),
      resolveDevinBinary: resolveDevinCloudBinary,
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

    // PR Watch / Ship: wakes a chat on this brain when its watched PR changes.
    const chatForPrWatch = agentChatService;
    const prWatchService = chatForPrWatch
      ? createPrWatchService({
        logger,
        prService: headlessLinearServices.prService,
        sessionService,
        messageSession: (args) => chatForPrWatch.messageSession(args),
        emitPrEvent,
        getGithubBackgroundPauseUntilMs: () =>
          headlessLinearServices.githubService.getBackgroundRequestPauseUntilMs(),
      })
      : null;
    if (prWatchService) teardown.push(() => prWatchService.dispose());

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
      onPullRequestsChanged: async ({ prs, changedPrs, changes }) => {
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
        prWatchService?.onPullRequestsChanged(changes.map((change) => change.pr.id));
        await emitRuntimePrCardsForChanges({
          changes,
          dataSource: headlessLinearServices.prService,
          chat: agentChatService,
          logger,
          relatedPrs: prs,
        });
      },
    });
    teardown.push(() => prPollingService.dispose());
    prPollingService.start();
    prWatchService?.start();
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
      syncRuntimeOptions?.phonePairingStateDir ?? resolveMachineAdeLayout().secretsDir,
      "sync-cloud-relay.json",
    );
    const cloudRelayStore = createSyncCloudRelayStore({ filePath: cloudRelayFilePath });
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
          return { machineKey, deviceId: readSyncDeviceId() };
        },
        activityRosterProvider: syncRuntimeOptions?.activityRosterProvider,
      };
    });
    pushPublisherService.setActivityRosterProvider(
      syncRuntimeOptions?.activityRosterProvider ?? null,
    );

    // The lifecycle performs the first vault pull before it allows the
    // receipt-backed migration to inspect local credentials.
    await accountRuntimeLifecycle.initialize();
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
    let usageTrackingService: ReturnType<typeof attachSharedUsageTrackingScope>;
    // Provider quota belongs to the machine, so this daemon polls it once and
    // every project scope attaches to that one poller. Per-project inputs (the
    // database ADE's own stats and account rollups live in, the repository
    // GitHub activity is read from) ride on the scope, so project-scoped
    // answers stay per project while the quota meter cannot drift between
    // windows.
    usageTrackingService = attachSharedUsageTrackingScope(
      resolveMachineAdeLayout().adeDir,
      () => createUsageTrackingService({
        logger,
        pollIntervalMs: 120_000,
        dependencies: {
          captureInternalAnalytics: (input) => productAnalyticsService.captureInternal(input),
          turnUsageLedger,
          modelRouter,
        },
      }),
      {
        key: `${projectId}:${projectRoot}`,
        db,
        projectRoot,
        logger,
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
      },
    );
    usageTrackingServiceRef = usageTrackingService;
    // Detaches this project. The shared poller keeps running for the scopes
    // that are still open and shuts down only with the last one.
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
      hostListener: syncRuntimeOptions?.sharedSyncListener ?? null,
      onPublicationStateChanged: () => {
        // Relay state changes are machine-level; without this nudge an idle
        // machine emits no sync-status snapshot and the desktop relay banner
        // never appears (or never clears).
        syncService?.notifyRouteStateChanged();
        syncRuntimeOptions?.requestAccountMachinePublish?.();
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
    if (syncRuntimeOptions?.enabled && agentChatService) {
      const { createSyncService } = await import("./services/sync/syncService");
      syncService = createSyncService({
        db,
        usageTrackingService,
        getProxyService: () => getProxyService(),
        accountSettingsStore,
        productAnalyticsService,
        logger,
        getAccountDirectoryHealth: syncRuntimeOptions.getAccountDirectoryHealth,
        requestAccountMachinePublish: syncRuntimeOptions.requestAccountMachinePublish,
        accountAuthService,
        projectId: syncRuntimeOptions.registryProjectId ?? projectId,
        runtimeProjectId: projectId,
        projectRoot,
        appVersion: syncRuntimeOptions.appVersion ?? "ade-cli",
        runtimeKind: syncRuntimeOptions.runtimeKind ?? "headless",
        sessionActivityReportingEnabled,
        localDeviceIdPath: syncRuntimeOptions.localDeviceIdPath,
        phonePairingStateDir: syncRuntimeOptions.phonePairingStateDir,
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
          projectConfigService,
        portAllocationService,
        laneEnvironmentService,
        laneTemplateService,
        rebaseSuggestionService,
        autoRebaseService,
        computerUseArtifactBrokerService,
        agentChatService,
        chatLaunchService,
        cursorCloudFleetService,
        cloudAgentsService,
        pushPublisherService,
        ctoStateService,
        ctoMemoryService,
        linearCredentialService: headlessLinearServices.linearCredentialService,
        linearOAuthService,
        getLinearIssueTracker: () => headlessLinearServices.linearIssueTracker,
        getExternalSessionsService: () => externalSessionsService,
        workToolsStateService,
        macDesktopService,
        // App Control's `onEvent` feeds the runtime event buffer; the live
        // view for phones and the web client reads the same events there.
        appControl: appControlService
          ? {
              getStatus: appControlService.getStatus,
              subscribeEvents: appControlEventsFromRuntimeBuffer(eventBuffer),
              getLatestFrame: appControlService.getLatestFrame,
              setFrameDemand: appControlService.setFrameDemand,
            }
          : null,
        appleDeviceService: iosSimulatorService,
        getWebhookAutomations: () => createWebhookRemoteSource({
          automationService,
          webhooks: automationIngressService?.webhooks,
          projectSecrets: projectSecretService,
        }),
        appleStreamRelay,
        getAppleRemoteBitrateKbpsCap: appleRemoteBitrateKbpsCap,
        sharedSyncListener: syncRuntimeOptions.sharedSyncListener ?? null,
        hostStartupEnabled: syncRuntimeOptions.hostStartupEnabled ?? true,
        hostDiscoveryEnabled: syncRuntimeOptions.hostDiscoveryEnabled ?? true,
        forceHostRole: syncRuntimeOptions.forceHostRole ?? false,
        projectCatalogProvider: syncRuntimeOptions.projectCatalogProvider,
        rosterProvider: syncRuntimeOptions.rosterProvider,
        foreignChatProvider: syncRuntimeOptions.foreignChatProvider,
        personalChatScope: syncRuntimeOptions.personalChatScope,
        remoteCommandExecutor: syncRuntimeOptions.remoteCommandExecutor,
        projectScopes: syncRuntimeOptions.projectScopes,
        getModelPickerStore: () => getSharedModelPickerStore(db),
        cloudRelayStore,
        syncTunnelClientService,
        // Coalesced, not queued. A reconnect storm reports hundreds of status
        // transitions a second and each one is a full snapshot; pushing them
        // straight onto the event buffer is what buffered `rpc_data` past the
        // host's required-send ceiling and closed the paired transport. See
        // `syncStatusEventPublisher`.
        onStatusChanged: (snapshot) => {
          syncStatusEventPublisher.publish(snapshot);
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
      if (syncRuntimeOptions?.initializeInBackground === true) {
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
        prWatchService?.onPrEvent(event);
      },
    ));
    externalSessionsService = createExternalSessionsService({
      projectRoot,
      laneService,
      sessionService,
      ptyService,
      logger,
      chatImporter: agentChatService,
      ...(agentChatService ? { chatImportedRefsProvider: chatImportedRefsProvider(agentChatService) } : {}),
      chatSessionsDir: paths.chatSessionsDir,
      onImportOutcome: ({ provider, target, mode, outcome }) => captureSessionImportAnalytics({
        analytics: productAnalyticsService,
        surface: "api",
        target,
        mode,
        outcome,
        provider,
      }),
    });

    const runtime: AdeRuntime = {
      projectRoot,
      workspaceRoot,
      projectId,
      project,
      paths,
      sessionActivityReportingEnabled,
      logger,
      db,
      keybindingsService,
      laneService,
      laneEnvironmentService,
      laneTemplateService,
      portAllocationService,
      laneProxyService,
      get proxyService(): ProxyService | null {
        return proxyService;
      },
      getProxyService,
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
      accountSettingsStore,
      accountVaultStore,
      conflictService,
      gitService,
      diffService,
      syncService,
      pushPublisherService,
      syncHostService: syncService?.getHostService() ?? null,
      laneWorktreeLockService,
      ptyService,
      testService,
      searchService,
      externalSessionsService,
      aiIntegrationService,
      agentChatService,
      chatLaunchService,
      cursorCloudFleetService,
      cloudAgentsService,
      ctoStateService,
      ctoMemoryService,
      adeProjectService,
      githubService: headlessLinearServices.githubService,
      accountAuthService,
      linearCredentialService: headlessLinearServices.linearCredentialService,
      linearOAuthService,
      linearAgentRuntime,
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
      getScenePreviewer: () => (desktopBridgeAttached() ? desktopBridgeHolder.scenePreview : null),
      macDesktopService,
      builtInBrowserService: builtInBrowserBridge,
      workToolsStateService,
      noteDesktopAppConnected: () => {
        // A probe already in flight may have started before this desktop was
        // listening, so ask again once it settles.
        void (desktopBridgeProbeInFlight ?? Promise.resolve()).then(() => refreshDesktopBridgeProbe());
      },
      eventBuffer,
      isPackaged: !isSourceCheckoutRuntimeModule(currentModulePath),
      // Shutdown drains the same stack the construction path filled, in reverse
      // acquisition order: a service is always stopped before the services it was
      // built from, and the database closes last. Keeping one list means the
      // failure path and the shutdown path cannot drift apart.
      dispose: () => {
        teardown.drain();
      }
    };

    automationService?.bindAdeActionRegistry(
      createAutomationAdeActionLookup(() => getAdeActionDomainServices(runtime)),
    );
    runtimeForCtoActions = runtime;

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
