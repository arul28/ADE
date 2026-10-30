import { stripInheritedProviderHomeEnv, stripParentClaudeSessionEnv } from "../shared/parentAgentEnv";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, protocol, safeStorage, screen, type WebContents } from "electron";
import { initMainSentry, isMainSentryStarted } from "./sentry/initMain";
import { configureOutboundProxyFromEnv, trustSystemCertificates } from "./services/shared/outboundNetwork";
import { SENTRY_ENABLED_ARGV } from "../shared/sentry/config";
import { flushSentry } from "../shared/sentry/capture";
import { registerSentryDiagnosticAttachment, registerSentryDiagnosticContext } from "../shared/sentry/diagnostics";
import { setSentryUserResolver } from "../shared/sentry/eventFilter";

if (app.isPackaged && process.env.ADE_RUNTIME_PACKAGED === undefined) {
  process.env.ADE_RUNTIME_PACKAGED = "1";
}

// When the terminal that launched ADE goes away, the next write to stdout/stderr raises
// EPIPE. Without a listener that surfaces as an uncaughtException and tears down the app.
// These targeted listeners are the intended guard for that case: they swallow broken-pipe
// errors on these two streams only and rethrow everything else. The global
// `uncaughtException` handler deliberately does NOT exempt EPIPE/ERR_STREAM_DESTROYED, so
// broken-stream faults from other subsystems still surface.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    throw err;
  });
}

// The first durable line of the launch, and the earliest statement in this file
// that can write one: everything below — the `ade://` claim, the single-instance
// lock, the whole of `whenReady` — used to happen before any structured logger
// existed, because the only one was built inside the project-open paths. A
// report from a machine where no project ever opened had no main-process log at
// all. Machine-scoped by construction (`~/.ade/runtime/desktop-main.jsonl`), so
// a headless `ade report-issue` finds it too. See `machineLogger.ts`.
logMachineEvent("info", "desktop.main_started", {
  pid: process.pid,
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  packageChannel: process.env.ADE_PACKAGE_CHANNEL ?? null,
  platform: process.platform,
});

import { UNAVAILABLE_CAPTURE_GESTURE_HEALTH } from "./services/capture/captureGestureState";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NodePty from "node-pty";
type NodePtyType = typeof NodePty;
import { isAdeRuntimeNamedPipePath } from "../shared/adeRuntimeIpc";
import {
  PACKAGE_CHANNEL_ARGV_PREFIX,
  appPackageChannelDisplayName,
  normalizeAppPackageChannel,
} from "../shared/packageChannel";
import {
  areAutomationsEnabledForPackagedState,
} from "../shared/automationAvailability";
import {
  handleDeeplinkUrl,
  isAdeDeeplinkArg,
  registerAdeProtocolHandler,
} from "./services/deeplinks/protocolHandler";
import { buildDeeplink } from "../shared/deeplinks";
import {
  createDesktopAlertPresenter,
  readDesktopAlertEvent,
  type DesktopAlert,
} from "./services/attention/desktopAlertPresenter";
import {
  appNavigationOwnership,
  dispatchOwnerAwareNavigation,
  ownerNavigationFailureCopy,
} from "./services/deeplinks/ownerAwareNavigation";
import { resolveLocalProjectRoot } from "./services/deeplinks/localProjectResolution";
import {
  selectRemoteHostWindow,
  selectWindowForProjectNavigation,
} from "./services/deeplinks/projectNavigationWindowSelection";
import { registerIpc } from "./services/ipc/registerIpc";
import { connectBrowserToNowPlaying, registerHomeWidgetsIpc } from "./services/home/registerHomeWidgetsIpc";
import { registerAppBundleOwnershipIpc } from "./services/updates/registerAppBundleOwnershipIpc";
import { registerMusicIpc } from "./services/music/registerMusicIpc";
import { createMusicTokenStore } from "./services/music/musicTokenStore";
import { AttemptedProjectRoots } from "./services/ipc/knownProjectRoots";
import { createFileLogger } from "./services/logging/logger";
import {
  flushMachineMainLog,
  getMachineMainLogger,
  logMachineEvent,
} from "./services/logging/machineLogger";
import {
  createProductAnalyticsService,
  defaultProductAnalyticsStateFile,
  getSharedProductAnalyticsService,
} from "./services/analytics/productAnalyticsService";
import { detectInstallSource } from "./services/analytics/installSource";
import {
  captureAgentTurnSettledAnalytics,
  captureChatAutoResumeAnalytics,
  captureMacDesktopAnalytics,
  captureAppleDeviceAnalytics,
  captureAppControlAnalytics,
  captureChatHandoffReplayAnalytics,
  captureChatSideChatAnalytics,
  captureChatCompactionAnalytics,
  captureChatMentionsExpandedAnalytics,
  captureClaudeHooksIgnoredAnalytics,
  captureClaudePluginsIgnoredAnalytics,
  captureSessionMetadataRegeneratedAnalytics,
} from "./services/analytics/agentTurnProductAnalytics";
import { captureChatAccountSwitchedAnalytics, captureFeatureUsedAnalytics, capturePendingInputDismissedAnalytics, captureSessionImportAnalytics } from "./services/analytics/featureProductAnalytics";
import { initPerfRunFromEnv } from "./services/perf/perfLog";
import { startMetricsSampler } from "./services/perf/metricsSampler";
import { registerPerfIpcHandlers } from "./services/perf/perfIpc";
import {
  ADE_WINDOWS_APP_USER_MODEL_ID,
  windowChromeOptions,
  windowsTitleBarOverlay,
  type WindowsTitleBarOverlayTheme,
} from "./windowAppearance";
import { openKvDb } from "./services/state/kvDb";
import { createRegisteredSyncPeerGate } from "./services/state/syncPeerCompactionGate";
import { ensureAdeDirs } from "./services/state/projectState";
import {
  persistableRemoteProjectIconDataUrl,
  persistableRemoteProjectBinding,
  readGlobalState,
  readGlobalStateForUpdate,
  type GlobalState,
  type RecentProject,
  upsertRecentProject,
  writeGlobalState,
} from "./services/state/globalState";
import {
  fitMainWindowBounds,
  parseMainWindowState,
  trackMainWindowState,
  type MainWindowState,
} from "./services/state/mainWindowState";
import { createLaneService, type LaneDeleteTeardownDeps } from "./services/lanes/laneService";
import { createLaneEnvironmentService } from "./services/lanes/laneEnvironmentService";
import { createLaneTemplateService } from "./services/lanes/laneTemplateService";
import { createProjectNewLaneSettings } from "./services/lanes/newLaneSettingsStore";
import { runDefaultLaneEnvironmentSetup } from "./services/lanes/laneEnvironmentSetup";
import { createLaneWorktreeLockService } from "./services/lanes/laneWorktreeLockService";
import { createPortAllocationService } from "./services/lanes/portAllocationService";
import { createLaneProxyService } from "./services/lanes/laneProxyService";
import { createProxyService, type ProxyService } from "../../../ade-cli/src/services/proxy/proxyService";
import { setHarnessProxyStarter } from "./services/chat/harnessLaunchPrepare";
import {
  releaseLaneRuntimeResources,
  teardownArchivedLaneEnvironment,
} from "./services/lanes/laneRuntimeLifecycle";
import { createOAuthRedirectService } from "./services/lanes/oauthRedirectService";
import { createRuntimeDiagnosticsService } from "./services/lanes/runtimeDiagnosticsService";
import {
  createSessionService,
  STALE_RUNNING_SESSION_RESCAN_DELAY_MS,
} from "./services/sessions/sessionService";
import { createLateBoundSettle, createSettleWiring } from "./services/sessions/settleWiring";
import { createSessionDeltaService } from "./services/sessions/sessionDeltaService";
import { createPtyService } from "./services/pty/ptyService";
import { terminalShellPreferenceStoreFor } from "./services/pty/terminalShells";
import { createSupervisedPtyLoader } from "./services/pty/supervisedPtyHost";
import {
  normalizePtyDataSubscriptions,
  setPtyDataSubscriptionsForSender,
  shouldSendPtyDataToWebContents,
} from "./services/pty/ptyDataSubscriptions";
import {
  heldAppControlFrameLanes,
  normalizeAppControlFrameLaneIds,
  setAppControlFrameLanesForSender,
  setAppControlFrameLanesListener,
  shouldSendAppControlFrameToWebContents,
} from "./services/appControl/appControlFrameSubscriptions";
import { appControlFrameEventLaneId } from "../shared/appControlFrameDemand";
import { createProcessRegistryService } from "./services/runtime/processRegistryService";
import { createDiffService } from "./services/diffs/diffService";
import { createExternalFilesWorkspaceRegistry, createFileService, type FileServiceLaneAdapter } from "./services/files/fileService";
import { createConflictService } from "./services/conflicts/conflictService";
import { createProjectConfigService } from "./services/config/projectConfigService";
import { createDiskPressureMonitor } from "./services/storage/diskPressure";
import { createStorageInsightsService } from "./services/storage/storageInsightsService";
import {
  createProjectHealthService,
  createProjectHealthTurnStateReader,
} from "../../../ade-cli/src/services/projects/projectHealth/projectHealthService";
import { recoverOrphanedAdeAgentProcesses } from "./services/processes/orphanedAgentProcessReaper";
import { createTestService } from "./services/tests/testService";
import { createOperationService } from "./services/history/operationService";
import { createGitOperationsService } from "./services/git/gitOperationsService";
import { createProjectSearchService } from "./services/search/searchServiceWiring";
import type { SearchService } from "./services/search/searchService";
import { createExternalSessionsService } from "./services/externalSessions/externalSessionsService";
import { chatImportedRefsProvider } from "./services/externalSessions/liveChatProviderRefs";
import {
  GitUntrustedFolderError,
  gitOwnershipReason,
  gitUntrustedFolderProblem,
  runGit,
  trustGitSafeDirectory,
} from "./services/git/git";
import { ACTION_NOT_CALLABLE_CODE, codedError, GIT_UNTRUSTED_FOLDER_CODE, isCodedError, isUnsupportedAdeActionError } from "../shared/codedError";
import { createJobEngine } from "./services/jobs/jobEngine";
import { createTranscriptionService } from "./services/transcription/transcriptionService";
import { installEditableContextMenu } from "./editorContextMenu";
import { createAppCommandSender } from "./appCommandDispatch";
import { createAiIntegrationService } from "./services/ai/aiIntegrationService";
import {
  augmentProcessPathWithShellAndKnownCliDirs,
  getPathEnvValue,
  mergePathEntries,
  onShellPathRefreshed,
  primeShellPathCache,
  readSavedShellPaths,
  saveShellPaths,
  setPathEnvValue,
  SHELL_PATH_CACHE_FILE,
} from "./services/ai/cliExecutableResolver";
import { createAgentChatService, listMachineProviderAccountChatLoad, writeSessionLinearIssueContextFile } from "./services/chat/agentChatService";
import { disposeAllCursorSdkConnections } from "./services/chat/cursorSdkPool";
import { recoverCursorSdkWorkerOrphans } from "./services/chat/cursorSdkWorkerOrphans";
import { createChatRuntimeBudget } from "./services/chat/chatRuntimeBudget";
import { createGithubService } from "./services/github/githubService";
import { createProjectScaffoldService } from "./services/projects/projectScaffoldService";
import { createProjectTabDragService } from "./services/projects/projectTabDragService";
import { consumeFirstOpenStabilityMarker } from "./services/projects/projectLocalDatabase";
import { createPrService } from "./services/prs/prService";
import { createPrPollingService } from "./services/prs/prPollingService";
import { createPrWatchService } from "./services/prs/prWatchService";
import { createTerminalWatchService } from "./services/pty/terminalWatchService";
import { createPrShellLinkWatcher, shellPrBodyRepairVia } from "./services/prs/prShellLinkWatcher";
import { chatLivenessReader, createPrMergeAutoSettlementService } from "./services/prs/prMergeAutoSettlementService";
import {
  emitPrCardsForChange,
} from "./services/prs/prChatCards";
import { openExternalUrl } from "./services/shared/externalLinks";
import {
  CaptureHelper,
  resolveCaptureHelperExecutablePath,
} from "./services/capture/captureHelper";
import type {
  CaptureGestureFailure,
  CaptureGestureHealth,
  CaptureGestureShot,
} from "../shared/types/captureGesture";
import { fitCaptureShotToAttachmentLimit } from "./services/capture/captureShotFit";
import { pickCaptureGestureWindow } from "./services/capture/captureGestureTarget";
import {
  reportCaptureGesture,
  type CaptureGestureOutcome,
} from "./services/analytics/captureGestureProductAnalytics";

import {
  attentionItemNavigationRequest,
  remoteBindingMatchesProject,
} from "./services/attention/attentionItemRouting";
import { pathKey, pathsEqual } from "./services/shared/pathCompare";
import {
  assertLocalProjectDataAvailable,
  deriveProjectId,
  ProjectRegistry,
  recordLocalProjectDatabaseIdentity,
} from "../../../ade-cli/src/services/projects/projectRegistry";
import { projectRegistryDiagnosticAttachment } from "../../../ade-cli/src/services/projects/projectRegistryJournal";
import { isRemoteMachineEvent } from "./sentry/desktopDiagnostics";
import { buildRosterSnapshot } from "../../../ade-cli/src/services/sync/rosterBuilder";
import { activeCompileCacheDir, scheduleStaleCompileCachePrune } from "../../../ade-cli/src/services/runtime/compileCachePrune";
import {
  detectDefaultBaseRef,
  resolveRepoRoot,
  toProjectInfo,
  upsertProjectRow,
} from "./services/projects/projectService";
import {
  inspectRecentProject,
  readGitOriginUrl,
  type RecentProjectInspection,
} from "./services/projects/recentProjectSummary";
import { browseProjectDirectories } from "./services/projects/projectBrowserService";
import { resolveWindowTabRoots } from "./services/projects/windowTabRootAuthorization";
import { resolveMobileProjectIconDataUrl } from "./services/projects/projectIconThumbnail";
import { decodeProjectIconUpload, importProjectIconBytes } from "./services/projects/projectIconResolver";
import { normalizeStartupProjectState, resolveStartupProject } from "./services/projects/startupProjectResolver";
import { selectUpdateWorkspaceRestore } from "./services/updates/updateWorkspace";
import { createAdeProjectService } from "./services/projects/adeProjectService";
import { createConfigReloadService } from "./services/projects/configReloadService";
import { IPC } from "../shared/ipc";
import { readRuntimeActionRequest } from "./services/ipc/ipcTimeouts";
import { remoteProjectBindingKey } from "../shared/projectIdentity";
import { resolveAdeLayout } from "../shared/adeLayout";
import { mobileProjectRepositoryIdentityFromGitOrigin } from "../shared/syncMobileProjectIdentity";
import type {
  OpenProjectBinding,
  RemoteOpenProjectBinding,
  AppNavigationRequest,
  AgentChatInterruptedChatRef,
  AttentionItem,
  AttentionPreferences,
  AppMenuCommand,
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
  SyncProjectSetIconRequestPayload,
  SyncProjectSetIconResultPayload,
  SyncProjectOpenRequestPayload,
  SyncPeerConnectionState,
  SyncProjectConnectionPayload,
  SyncProjectSwitchRequestPayload,
  SyncProjectSwitchResultPayload,
  RecentlyInstalledUpdate,
  UpdateInstallImpact,
  UpdateInterruptedChat,
} from "../shared/types";
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
import {
  resolveMachineAdeDir,
  resolveMachineAdeLayout,
  resolveMachineEndpointNames,
} from "../../../ade-cli/src/services/projects/machineLayout";
import { takeMachineResetReceipt } from "./services/runtime/machineResetLauncher";
import { localIpcListenOptions } from "../../../ade-cli/src/services/runtime/localIpcListenOptions";
import { readSavedUpdateTrack, writeSavedUpdateTrack } from "../../../ade-cli/src/services/runtime/updateTrackStore";
import {
  shippedVersionOrNull,
  UPDATE_TRACK_ARGV_PREFIX,
  updateTrackOfVersion,
  type UpdateTrack,
} from "../shared/updateTrack";
import { normalizeProjectRootPath } from "../../../ade-cli/src/services/projects/projectRoots";
import {
  ACCOUNT_SESSION_CREDENTIAL_KEY,
  getSignedInAccountAccessToken,
  type AccountAuthService,
} from "../../../ade-cli/src/services/account/accountAuthService";
import { createPushRelayClient } from "../../../ade-cli/src/services/push/pushRelayClient";
import { createPushRegistrationStore } from "../../../ade-cli/src/services/push/pushRegistrationStore";
import { resolvePushRelayStateFile } from "../../../ade-cli/src/services/push/pushPublisherService";
import {
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
  registerAccountConfigProjectRoot,
} from "../../../ade-cli/src/services/account/sharedAccountAuthService";
import { checkRuntimeServiceRemovable, installRuntimeService, uninstallRuntimeService } from "../../../ade-cli/src/serviceManager";
import {
  deferToRunningWindowsInstall,
  startWindowsInstallProgress,
  takeWindowsInstallProgressReport,
  takeWindowsLaunchRequest,
} from "./services/updates/windowsInstallProgress";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
  isElectronSafeStorageCredentialFile,
  type SyncCredentialStore,
} from "../../../ade-cli/src/services/credentials/credentialStore";
import { adoptFileBackedCredentials } from "../../../ade-cli/src/services/credentials/credentialStoreAdoption";
import { readExistingOsBoundKeyMaterialAsync } from "../../../ade-cli/src/services/credentials/osBoundKeyMaterial";
import {
  createRoutedCredentialStore,
  createUnavailableCredentialStore,
} from "../../../ade-cli/src/services/credentials/credentialStoreRouting";
import { createKeybindingsService } from "./services/keybindings/keybindingsService";
import { createAgentToolsService } from "./services/agentTools/agentToolsService";
import { createAdeCliService } from "./services/cli/adeCliService";
import { runAdeCliAutoInstall } from "./services/cli/adeCliAutoInstall";
import { createDevToolsService } from "./services/devTools/devToolsService";
import { createOnboardingService } from "./services/onboarding/onboardingService";
import { createAutomationService } from "./services/automations/automationService";
import { createAutomationPlannerService } from "./services/automations/automationPlannerService";
import { createAutomationSecretService } from "./services/automations/automationSecretService";
import { createProjectSecretService } from "./services/secrets/projectSecretService";
import { initApiKeyStore } from "./services/ai/apiKeyStore";
import { createAutomationIngressService, createKvIngressCursorStore } from "./services/automations/automationIngressService";
import { createLinearAccessTokenGetter, createLinearIngressService } from "./services/automations/linearIngressService";
import { buildLinearAutomationDispatches } from "./services/automations/linearAutomationDispatch";
import { createCursorCloudIngressService } from "./services/automations/cursorCloudIngressService";
import { createCursorCloudFleetService } from "./services/chat/cursorCloudFleetService";
import { createCloudAgentsServiceFromHost } from "./services/chat/cloudAgentsService";
import { resolveDevinCloudBinary } from "./services/chat/devinCloudBinary";
import { buildCursorCloudAutomationDispatches } from "./services/automations/cursorCloudAutomationDispatch";
import { openCursorCloudCredentialStore } from "./services/chat/cursorCloudCreateOptions";
import { createGithubPollingService } from "./services/automations/githubPollingService";
import {
  createAutomationAdeActionLookup,
  flushStagedBoardMoves,
  getAdeActionDomainServices,
  requestSessionAttentionForRuntime,
} from "./services/adeActions/registry";
import {
  createUsageTrackingService,
  isUsageSnapshot,
  type AccountRollupFetcher,
} from "./services/usage/usageTrackingService";
import { bootedUsageScopeRoot } from "./services/usage/bootedUsageScope";
import { createMuseQuotaStore } from "./services/usage/museLiveQuota";
import { createBudgetCapService } from "./services/usage/budgetCapService";
import {
  markMachineStateMigrationComplete,
  readMachineRegistryRecentProjects,
  runMachineStateMigration,
} from "./services/runtime/machineStateMigration";
import {
  markMachineTrustResetComplete,
  runMachineTrustResetMigration,
} from "./services/runtime/machineTrustResetMigration";
import { createCtoStateService } from "./services/cto/ctoStateService";
import { createCtoMemoryService } from "./services/cto/ctoMemoryService";
import { createLinearCredentialService } from "./services/cto/linearCredentialService";
import { createAccountVaultBridge } from "./services/account/accountVaultBridge";
import { createMcpRegistryAuthTokenResolver } from "./services/mcp/mcpRegistryService";
import { MCP_SECRET_VAULT_KIND } from "../shared/mcpRegistry";
import { getOrCreateLocalAccountMachineIdentity } from "./services/account/localMachineIdentity";
import { stampCustomNotificationLinkOwner } from "../shared/customNotificationLink";
import {
  buildRendererCspPolicy,
  isRendererFrameNavigationAllowed,
  shouldApplyRendererCsp,
} from "./rendererCsp";
import {
  RENDERER_RECOVERY_DELAY_MS,
  RENDERER_RECOVERY_WINDOW_MS,
  coarseRenderProcessGoneReason,
  createRendererCrashRecoveryBudget,
  isRecoverableRenderProcessGone,
} from "./rendererCrashRecovery";
import { isWindowLoadTargetGone } from "./windowLoadTarget";
import { createLinearClient } from "./services/cto/linearClient";
import { createLinearIssueTracker, type LinearIssueTracker } from "./services/cto/linearIssueTracker";
import { createLinearLiveStatusService, type LinearLiveStatusService } from "./services/cto/linearLiveStatusService";
import { createLinearChatLinkPublisher, publishLinearLaneCard } from "./services/cto/linearLaneCardService";
import { createComputerUseArtifactBrokerService } from "./services/computerUse/computerUseArtifactBrokerService";
import {
  respondToArtifactProtocolRequest,
  type ArtifactServeRefusal,
  type ArtifactServeScope,
  type RemoteArtifactRangeReader,
} from "./services/computerUse/artifactStreamProtocol";
import { createArtifactMediaServer } from "./services/computerUse/artifactMediaServer";
import { respondToSceneProtocolRequest } from "./services/scenes/sceneDocumentStore";
import { createIosSimulatorService } from "./services/ios/iosSimulatorService";
import { createMacDesktopService } from "./services/macDesktop/macDesktopService";
import { createMacDesktopLogger } from "./services/macDesktop/macDesktopLogger";
import { createWindowsDesktopSeatAdapter } from "./services/windowsDesktop/windowsDesktopSeatProvider";
import { createLinuxDesktopSeatAdapter } from "./services/linuxDesktop/linuxDesktopSeatProvider";
import { feedDemoTrackFromChatEvent } from "./services/demoVideo/demoTrackRegistry";
import { createAppleStreamRelayForService } from "./services/ios/appleStreamRelay";
import { hasAppleLocalViewer } from "./services/ios/appleLocalViewers";
import { setActiveAppleStreamRouter } from "../../../ade-cli/src/services/sync/appleStreamListenerRoute";
import { DEFAULT_APPLE_REMOTE_BITRATE_KBPS } from "../shared/appleDeviceSettings";
import { createAppControlService } from "./services/appControl/appControlService";
import { createAppControlScreencastRecorderHost } from "./services/appControl/appControlScreencastRecorderHost";
import { createChromiumDemoEngine } from "./services/demoVideo/chromiumDemoEngine";
import { createDemoEngineSet } from "./services/demoVideo/demoEngines";
import { resolveSessionLaneId } from "./services/lanes/resolveSessionLaneId";
import { createBuiltInBrowserService } from "./services/builtInBrowser/builtInBrowserService";
import { createBuiltInBrowserHandoffSessionListener } from "./services/builtInBrowser/builtInBrowserHandoffSession";
import { BUILT_IN_BROWSER_PARTITION } from "./services/builtInBrowser/builtInBrowserConstants";
import { startBuiltInBrowserDesktopBridgeServer } from "./services/builtInBrowser/desktopBridgeServer";
import { renderScenePreview } from "./services/scenes/scenePreviewRenderer";
import { configureBuiltInBrowserWebAuthn } from "./services/builtInBrowser/builtInBrowserWebAuthn";
import { LocalRuntimeConnectionPool } from "./services/localRuntime/localRuntimeConnectionPool";
import { createSyncService } from "./services/sync/syncService";
import { blockPackagedLaunchForCrossChannelSyncConflict } from "./services/sync/packagedSyncHostLaunchGate";
import { createAutoUpdateService, shouldShowInstalledNotice } from "./services/updates/autoUpdateService";
import { createLatestByTrackReader } from "./services/updates/latestByTrack";
import { fetchAdeLatestRelease } from "./services/github/adeReleaseFeed";
import { fetchReleaseManifestJson } from "../../../ade-cli/src/lib/releaseAssets";
import { resolveContinueAfterRestart } from "../../../ade-cli/src/services/runtime/continueAfterRestartStore";
import {
  INSTALL_UPDATE_ARG,
  nativeUpdateMenuItem,
  nativeUpdateMenuLabel,
  runNativeUpdateInstall,
} from "./services/updates/nativeUpdateInstall";
import { createRemoteUpdateInstaller, type RemoteUpdateInstaller } from "./services/updates/remoteUpdateInstall";
import { createKeepAwakeService } from "./services/power/keepAwakeService";
import { getPowerStateService } from "./services/power/powerStateService";
import { createMachinePowerBrainBridge } from "./services/power/machinePowerBrainBridge";
import { runUpdateTransaction } from "./services/updates/updateTransaction";
import { createInstallOnQuitController, type InstallOnQuitDecision } from "./services/updates/installOnQuit";
import { recordInstalledDesktopApp } from "./services/native/nativeHelperPaths";
import {
  checkRuntimeIdentity,
  runVerifiedRuntimeRestart,
} from "./services/updates/runtimeRestartVerification";
import { createProjectRecoveryService, restartBrainForRepair } from "./services/runtime/projectRecoveryService";
import {
  classifyProjectActivity,
  createProjectMoveController,
  remapGlobalStateForMove,
  replaceMovedRoots,
} from "./services/projects/projectMoveController";
import { createQuitPrompt } from "./services/runtime/quitPrompt";
import { createUpdateImpactProbe, settledWithin } from "./services/runtime/updateImpactProbe";
import { registerBackgroundServiceControls } from "./services/runtime/backgroundServiceControls";
import { createOpenProjectDataWatch } from "./services/runtime/openProjectDataWatch";
import { createAutoDiagnosticsService } from "./services/diagnostics/autoDiagnosticsService";
import { resolveAutoDiagnosticsStateFile } from "./services/diagnostics/autoDiagnosticsStore";
import { collectDiagnosticReport } from "./services/diagnostics/diagnosticReportService";
import { createAgentToolsCacheService } from "./services/tools/agentToolsCacheService";
import { enablePinnedToolFetch } from "../../../ade-cli/src/services/tools/onDemand";
import { DEFAULT_RELEASE_REPOSITORY } from "./services/updates/autoUpdateVersions";
import { cleanupStaleTempArtifacts } from "./services/runtime/tempCleanupService";
import type { Logger } from "./services/logging/logger";
import { resolveDesktopUserDataPath, resolveElectronAppDataPath } from "./desktopUserDataPath";
import { createWebhookRemoteSource } from "./services/automations/webhookAutomationFactory";

/** One warm-runtime budget for every project context in this process. */
const chatRuntimeBudget = createChatRuntimeBudget();

/** The desktop's windows, in a project service's App Control frame demand. */
const APP_CONTROL_WINDOWS_FRAME_DEMAND_SOURCE = "desktop-windows";


const AUTO_UPDATER_CACHE_DIR_NAME = "ade-desktop-updater";
/** Appended to the user agent of the app window when it loads from the Vite dev server. */
const DEV_APP_WINDOW_USER_AGENT_MARK = "ADEDevShell";

// Alpha is the only package channel: a branch build with its own app id and
// its own ADE home. Beta is not a channel; it is an update track of the
// normal install (docs/plans/beta-track.md), so nothing here may read "beta"
// out of a name or a version.
type AdePackageChannel = "alpha";

function normalizeAdeReleaseRepository(value: unknown): string | null {
  const normalized = typeof value === "string"
    ? value.trim().replace(/^\/+|\/+$/g, "")
    : "";
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function readBundledAdeReleaseRepository(): string {
  try {
    const packageJsonPath = path.join(app.getAppPath(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      adeReleaseRepository?: unknown;
    };
    const bundledRepository = normalizeAdeReleaseRepository(packageJson.adeReleaseRepository);
    if (bundledRepository) return bundledRepository;
  } catch {
    // Older packages use the upstream repository default.
  }
  if (!app.isPackaged) {
    return normalizeAdeReleaseRepository(process.env.ADE_RELEASE_REPOSITORY)
      ?? DEFAULT_RELEASE_REPOSITORY;
  }
  return DEFAULT_RELEASE_REPOSITORY;
}

function normalizeAdePackageChannel(value: unknown): AdePackageChannel | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "alpha" ? normalized : null;
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
  } catch {
    // Dev builds and older packaged apps do not need channel metadata.
  }

  const appName = app.getName();
  if (/\balpha\b/i.test(appName)) return "alpha";
  return null;
}

function applyPackagedChannelDefaults(): void {
  const channel = readBundledAdePackageChannel();
  if (!channel) return;

  process.env.ADE_PACKAGE_CHANNEL = process.env.ADE_PACKAGE_CHANNEL || channel;
  process.env.ADE_DESKTOP_APP_NAME = process.env.ADE_DESKTOP_APP_NAME || "ADE Alpha";
  process.env.ADE_HOME = process.env.ADE_HOME || path.join(os.homedir(), `.ade-${channel}`);
}

applyPackagedChannelDefaults();

// Opened by hand while a Windows update installs: this is the old copy, and the
// installer would kill it a few seconds into startup. The update window comes
// forward instead, before ADE starts anything of its own.
if (
  process.platform === "win32"
  && app.isPackaged
  && deferToRunningWindowsInstall({
    channel: normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL),
    appVersion: app.getVersion(),
  })
) {
  process.exit(0);
}
const packagedReleaseRepository = readBundledAdeReleaseRepository();

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
// Error tracking starts here: the earliest point where its crash dumps and
// offline queue have a userData directory to live in.
initMainSentry({
  // The runtime action channels (this machine's brain and a paired machine's)
  // carry every action; name the action.
  ipcLabel: (channel, args) => {
    if (channel !== IPC.localRuntimeCallAction && channel !== IPC.remoteRuntimeCallAction) return channel;
    const request = readRuntimeActionRequest(args);
    if (!request) return channel;
    return request.action ? `${request.domain}.${request.action}` : request.domain;
  },
});

function resolveAutoUpdaterCacheDir(): string {
  const homeDir = os.homedir();
  // Per channel. Stable keeps the bare name so an existing install's staged
  // download is not orphaned; a channel build gets its own directory so two
  // channels cannot stage different versions over each other.
  const channel = normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL);
  const cacheDirName = channel ? `${AUTO_UPDATER_CACHE_DIR_NAME}-${channel}` : AUTO_UPDATER_CACHE_DIR_NAME;
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"),
      cacheDirName,
    );
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Caches", cacheDirName);
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(homeDir, ".cache"),
    cacheDirName,
  );
}

/**
 * Electron apps launched from macOS Dock/Finder inherit a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) that misses user-installed CLI tools like
 * `claude`. Resolve the user's login shell PATH so child processes spawned by
 * the AI SDK can locate the CLI.
 */
function fixElectronShellPath(): void {
  // The shells' answers from the last launch are used at once, and refreshed
  // in the background: a login and an interactive shell no longer run before
  // the first window (only the first launch, with nothing saved, waits).
  const cacheFile = path.join(app.getPath("userData"), SHELL_PATH_CACHE_FILE);
  primeShellPathCache(readSavedShellPaths(cacheFile));
  const launchEnv = { ...process.env };
  const apply = (): void => {
    const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
      env: launchEnv,
      includeInteractiveShell: true,
      timeoutMs: 1_500,
    });
    if (nextPath) {
      // Use setPathEnvValue so Windows processes inheriting a `Path` key collapse
      // to a single canonical entry (direct `process.env.PATH = …` can leave a
      // stale `Path` behind that later readers pick up instead).
      setPathEnvValue(process.env, nextPath);
    }
  };
  apply();
  saveShellPaths(cacheFile);
  onShellPathRefreshed(() => {
    // Directories added to PATH since launch (an ADE CLI bin dir, say) stay:
    // the refreshed shell answer goes first, the current entries after it.
    const current = getPathEnvValue(process.env);
    apply();
    setPathEnvValue(process.env, mergePathEntries(getPathEnvValue(process.env), current));
    saveShellPaths(cacheFile);
  });
}

// Must run before any service or child process is created.
fixElectronShellPath();
// Main's own fetch/https: a proxy the environment names, and the OS's trusted
// CAs (read off the main thread). Electron's net.fetch already follows the OS.
configureOutboundProxyFromEnv(process.env, getMachineMainLogger());
void trustSystemCertificates(getMachineMainLogger());

let adeCliAutoInstallScheduled = false;

/**
 * Set while the launch opens its startup project, after the first window is
 * already on screen. That window's session (and the launch's recovery
 * question) answer once it settles, so its renderer shows the "Starting ADE"
 * splash meanwhile instead of the welcome screen.
 */
let startupProjectOpen: Promise<void> | null = null;
/**
 * How long the first window waits on the launch's project opens before it
 * shows what has opened. Under the 30 s IPC default, so the window's session
 * read answers instead of timing out.
 */
const STARTUP_PROJECT_WINDOW_WAIT_MS = 20_000;
/** How long a dev window waits to clear its cache before it loads anyway. */
const DEV_CACHE_CLEAR_WAIT_MS = 3_000;

/**
 * Makes `ade` exist for a user who never opens Settings. Every guard that
 * matters — already on PATH, already settled once, silent failure — lives in
 * `runAdeCliAutoInstall`; this only schedules it. Both project-open and dormant
 * startup reach here, so the process-wide latch keeps it to a single attempt.
 *
 * Its outcome goes to the MACHINE log, not the caller's. Whether this computer
 * ever got the `ade` command is a fact about the computer: filed per project it
 * landed wherever the latch happened to win, and on the dormant path it landed
 * in a `userData` log no report collects at all — so "did the auto-install
 * run?" was unanswerable from the one document meant to answer it.
 */
function installAdeCliForTerminalInBackground(
  adeCliService: ReturnType<typeof createAdeCliService>,
  globalStatePath: string,
): void {
  if (adeCliAutoInstallScheduled) return;
  adeCliAutoInstallScheduled = true;
  const logger = getMachineMainLogger();
  // A convenience, not startup work: it can spawn the packaged installer and
  // append to a shell profile, so it stays off the path to the first window.
  const task = setImmediate(() => {
    void runAdeCliAutoInstall({
      adeCli: adeCliService,
      logger,
      readState: () => readGlobalState(globalStatePath),
      writeState: (state) => writeGlobalState(globalStatePath, state),
      repairRequestPath: path.join(resolveMachineAdeLayout().runtimeDir, "cli-shim-repair-request"),
    }).catch((error) => {
      logger.warn("ade_cli.auto_install_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  task.unref?.();
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
// In startup stability mode, only enable essential background tasks by default.
// Use ADE_ENABLE_ALL_BACKGROUND_TASKS=1 or individual flags to enable others.
const defaultEnabledBackgroundTaskFlags = new Set<string>([
  "ADE_ENABLE_CONFIG_RELOAD",
  "ADE_ENABLE_USAGE_TRACKING",
  "ADE_ENABLE_HEAD_WATCHER",
  "ADE_ENABLE_PORT_ALLOCATION_RECOVERY",
  "ADE_ENABLE_PR_POLLING",
  // reconcile-on-focus is the default catch-up safety net (the brain has no PR
  // poller), so it stays enabled even in stability mode. Its own kill switch is
  // ADE_DISABLE_PR_RECONCILE (enforced in scheduleReconcile), NOT this flag.
  "ADE_ENABLE_PR_RECONCILE",
  "ADE_ENABLE_SYNC_INIT",
  "ADE_ENABLE_AUTOMATION_INGRESS",
]);

// ---------------------------------------------------------------------------
// PR reconcile-on-focus: global anti-stampede limiter.
//
// The brain's PR poller only refreshes tracked rows each tick and discovers new
// lane PRs on a slow cadence, so when a project comes into focus/opens we run a
// throttled catch-up reconcile (prService.reconcileOnFocus). Projects on other
// machines: see `requestMachinePrReconcile`. Per-project throttle +
// single-flight lives on each prService instance; THIS module-level limiter
// caps the whole app at RECONCILE_GLOBAL_MAX concurrent reconciles and staggers
// extra opens with jitter so launching several projects at once cannot stampede
// GitHub. The active-or-scheduled counter (not just in-flight) is what prevents
// a burst of near-simultaneous opens from each passing the cap before any has
// begun.
// ---------------------------------------------------------------------------
/**
 * Every project open/switch attempt is recorded here, successful or not, so the
 * recovery and diagnostics IPC handlers can accept the root the user just
 * picked even when its first open failed before it could reach the
 * recent-projects list. See `services/ipc/knownProjectRoots.ts`.
 */
const attemptedProjectRoots = new AttemptedProjectRoots();

const RECONCILE_GLOBAL_MAX = 1;
let reconcileActiveOrScheduled = 0;
const pendingReconciles: Array<() => void> = [];

function reconcileJitterMs(): number {
  // 150–600ms stagger so multiple near-simultaneous opens don't fire together.
  return 150 + Math.floor(Math.random() * 450);
}

function drainNextReconcile(): void {
  const next = pendingReconciles.shift();
  if (!next) return;
  reconcileActiveOrScheduled += 1;
  setTimeout(next, reconcileJitterMs());
}

// Queue a fire-and-forget reconcile behind the app-wide cap. `runner` is built
// per-project by buildReconcileRunner (which re-resolves the live context at
// fire time and routes in-process vs. daemon), so this function only owns
// global staggering/queueing — not the null-context or routing decision.
function scheduleReconcile(runner: () => Promise<unknown>): void {
  // Default-ON with a kill switch; never gated behind PR polling.
  if (process.env.ADE_DISABLE_PR_RECONCILE === "1") return;
  const run = () => {
    Promise.resolve(runner())
      .catch(() => {
        // reconcile is best-effort; guard the microtask too
      })
      .finally(() => {
        reconcileActiveOrScheduled -= 1;
        drainNextReconcile();
      });
  };
  if (reconcileActiveOrScheduled < RECONCILE_GLOBAL_MAX) {
    reconcileActiveOrScheduled += 1;
    setTimeout(run, reconcileJitterMs());
  } else {
    pendingReconciles.push(run);
  }
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// The Claude CLI refuses to start if it detects it is inside another Claude Code
// session (nested session guard). ADE is a host app, not a nested session, so
// strip the marker env var so the SDK can spawn the CLI cleanly.
// The same holds for every other marker of a parent Claude session: a `claude`
// in an ADE terminal would inherit them and stop saving its transcript.
stripParentClaudeSessionEnv(process.env);
// An app started from an agent's shell must not read that agent's provider
// account as the machine's default one, nor hand it to the brain it spawns.
stripInheritedProviderHomeEnv(process.env);

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
      const primary = new ElectronSafeStorageCredentialStore({
        secretsDir,
        safeStorage,
        legacyStore,
      });
      // Credentials the ADE brain and the CLI co-own live in the shared machine
      // file, so the desktop app must READ them there too — the Electron-only
      // store cannot see them, and a build that wrote one into it signs the
      // brain out.
      adoptFileBackedCredentials({ primary, fileStore: legacyStore, identity: secretsDir });
      return createRoutedCredentialStore({ primary, fileStore: legacyStore });
    }
  } catch {
    // Fall through to the file store when Electron cannot reach the OS keychain.
  }
  if (
    isElectronSafeStorageCredentialFile(safeCredentialsPath)
    || isElectronSafeStorageCredentialFile(legacyCredentialsPath)
  ) {
    // The shared file needs no keychain, so the credentials the brain co-owns
    // stay reachable even while the Electron-only ones are locked away.
    return createRoutedCredentialStore({
      primary: createUnavailableCredentialStore(
        "Electron safeStorage is unavailable; unlock the OS credential store to read ADE credentials.",
      ),
      fileStore: legacyStore,
    });
  }
  return legacyStore;
}

// Voice-to-text transcription is a project-independent capability (it only needs
// the bundled transcribe-cli binary + model + shared glossary), so it lives as a single
// shared instance threaded into every project/dormant context. Constructed lazily
// on first context build.
let sharedTranscriptionService: ReturnType<typeof createTranscriptionService> | null = null;
function getSharedTranscriptionService(logger: Logger): ReturnType<typeof createTranscriptionService> {
  if (!sharedTranscriptionService) {
    sharedTranscriptionService = createTranscriptionService({
      logger,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      // The ~464 MB model is downloaded at runtime (not bundled) into userData
      // so it never bloats the auto-update zip. See speechModelStore.
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

async function createWindow(args: {
  logger?: Logger;
  /**
   * Reports a lost renderer as a product fact. Optional so window creation
   * stays usable before the analytics service exists.
   */
  onRendererRecovery?: (outcome: { crash_reason: string; recovered: boolean }) => void;
  onCreated?: (win: BrowserWindow) => void;
  onCloseRequested?: (win: BrowserWindow, event: Electron.Event) => void;
  /**
   * Opens the window at these bounds without taking focus. A tab dragged out
   * of another window uses this: the new window must appear under the cursor
   * and must not steal the pointer from the window that owns the drag.
   */
  bounds?: { x: number; y: number; width: number; height: number };
  /**
   * Where the last window sat. Used only without `bounds`, and only when that
   * spot is still on a connected display.
   */
  restoreState?: MainWindowState | null;
  /** Receives this window's position and size as they change. */
  onWindowStateChange?: (state: MainWindowState) => void;
  /**
   * Created without showing it: the launch that lands a quit-install runs
   * with no window, and shows this one only if the person opens ADE.
   */
  hidden?: boolean;
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

  /**
   * The narrowest window the PRs tab can render without clipping.
   *
   * Electron defaults `minWidth` to 0, so nothing stopped a drag below the point
   * where a pane's own minimum could not be honoured — and the PR detail pane
   * clips rather than scrolls, so the merge box simply disappeared. This is the
   * sum of that surface's floors: the PR list (260) + the drag gutter (8) + the
   * detail pane (758, itself the thread's 360 + a gutter + the info rail's 390).
   * Those constants live in `components/prs/tabs/GitHubTabView.tsx` and
   * `components/prs/detail/PrDetailTimelineRails.tsx`; `GITHUB_PR_DETAIL_MIN_PX`
   * is derived from the rail constants there so the two halves cannot drift
   * silently. It sits well under both default widths above.
   */
  const MIN_WINDOW_WIDTH = 1026;

  const restoreState = args.bounds ? null : args.restoreState ?? null;
  const restoredBounds = restoreState
    ? fitMainWindowBounds(
        restoreState.bounds,
        screen.getAllDisplays().map((display) => display.workArea),
        MIN_WINDOW_WIDTH,
      )
    : null;

  const win = new BrowserWindow({
    ...(args.bounds ?? restoredBounds ?? defaultWindowBounds),
    ...(args.bounds || args.hidden ? { show: false } : {}),
    ...(restoredBounds && restoreState?.fullScreen && !args.hidden ? { fullscreen: true } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    icon,
    ...windowChromeOptions(process.platform),
    // Match renderer dark theme to avoid a flash on load.
    backgroundColor: "#0F0D14",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // The renderer gates the channel badge/notice synchronously at first
      // paint, so the channel has to arrive without an IPC round trip. argv is
      // the deterministic carrier: this runs long after
      // applyPackagedChannelDefaults(), and unlike the inherited environment it
      // does not depend on when Chromium snapshotted process.env.
      additionalArguments: [
        `${PACKAGE_CHANNEL_ARGV_PREFIX}${normalizeAppPackageChannel(process.env.ADE_PACKAGE_CHANNEL)}`,
        // Same reason: the "Beta" label next to the logo is drawn at first paint.
        `${UPDATE_TRACK_ARGV_PREFIX}${updateTrackOfVersion(app.getVersion())}`,
        ...(isMainSentryStarted() ? [SENTRY_ENABLED_ARGV] : []),
      ],
    },
  });

  if (restoredBounds && restoreState?.maximized && !restoreState.fullScreen && !args.hidden) win.maximize();
  if (args.onWindowStateChange) trackMainWindowState(win, args.onWindowStateChange);
  args.onCreated?.(win);
  if (args.bounds) win.showInactive();
  installEditableContextMenu(win);

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const src = typeof params.src === "string" ? params.src : "";
    if (!isAllowedAdeBrowserWebviewSource(src)) {
      event.preventDefault();
      args.logger?.warn("window.webview_blocked", { src });
      return;
    }
    delete webPreferences.preload;
    delete (webPreferences as Record<string, unknown>).preloadURL;
    webPreferences.partition = BUILT_IN_BROWSER_PARTITION;
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

  const rendererRecoveryBudget = createRendererCrashRecoveryBudget();

  win.webContents.on("render-process-gone", (_event, details) => {
    args.logger?.error("window.render_process_gone", {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
      url: win.webContents.getURL(),
    });

    // Monotonic on purpose: the budget is a rolling time window, and a wall-clock
    // correction mid-crash-storm would either free the budget early or freeze it.
    const decision = rendererRecoveryBudget.requestAttempt(details.reason, performance.now());
    // A lost renderer is a product-level failure category, reported once per
    // occurrence with Electron's own closed reason enum. `recovered` describes
    // the OUTCOME, not the intent: a reload that was attempted and then failed
    // is a window that stayed down, and reporting it as recovered would make the
    // metric describe our try rather than the user's result. The budget bounds
    // the volume — a boot-crash loop stops trying, so it cannot emit forever.
    const crashReason = coarseRenderProcessGoneReason(details.reason);
    const reportRecovery = (recovered: boolean): void => {
      if (!isRecoverableRenderProcessGone(details.reason)) return;
      args.onRendererRecovery?.({ crash_reason: crashReason, recovered });
    };
    if (!decision.recover) {
      if (decision.cause === "budget-exhausted") {
        args.logger?.error("window.render_process_recovery_abandoned", {
          windowId: win.id,
          reason: details.reason,
          attempts: decision.attempts,
          windowMs: RENDERER_RECOVERY_WINDOW_MS,
        });
        reportRecovery(false);
      }
      return;
    }
    const attempt = decision.attempt;

    setTimeout(() => {
      if (win.isDestroyed()) return;
      const recoveryUrl = getRendererUrl();
      args.logger?.warn("window.render_process_recovering", {
        windowId: win.id,
        reason: details.reason,
        attempt,
        url: recoveryUrl,
      });
      // Load the canonical renderer URL rather than reloading whatever was last
      // committed: a crash on the load-failure fallback page would otherwise
      // just reload the error page.
      win.loadURL(recoveryUrl).then(
        () => reportRecovery(true),
        (error) => {
          args.logger?.error("window.render_process_recovery_failed", {
            windowId: win.id,
            reason: details.reason,
            attempt,
            // The Error itself, so `logBridge` lifts it into the Sentry event
            // and the issue groups by the real failure; `errorText` keeps the
            // sentence on disk, which `JSON.stringify` writes an Error without.
            error,
            errorText: toErrorMessage(error),
          });
          reportRecovery(false);
        },
      );
    }, RENDERER_RECOVERY_DELAY_MS);
  });

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    args.logger?.error("window.preload_error", {
      windowId: win.id,
      preloadPath,
      // The Error itself, so `logBridge` lifts it into the Sentry event and the
      // issue groups by the real failure; `errorText` keeps the sentence on
      // disk, which `JSON.stringify` writes an Error without.
      error,
      errorText: toErrorMessage(error),
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
    // Bounded: both calls go through Chromium's network service, and one that
    // has crashed or stalled (it reads the Keychain too) never answers.
    // Unbounded, the launch never finishes creating this window, the startup
    // gate never opens, and every window-session call waits out its timeout.
    const outcome = await settledWithin<"cleared" | "failed" | "timed_out">(
      (async () => {
        try {
          await win.webContents.session.clearCache();
          await win.webContents.session.clearStorageData({
            storages: ["serviceworkers", "cachestorage"],
          });
          return "cleared" as const;
        } catch (error) {
          args.logger?.warn("renderer.dev_cache_clear_failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return "failed" as const;
        }
      })(),
      DEV_CACHE_CLEAR_WAIT_MS,
      "timed_out",
    );
    if (outcome === "timed_out") {
      args.logger?.warn("renderer.dev_cache_clear_skipped", { waitMs: DEV_CACHE_CLEAR_WAIT_MS });
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

  /**
   * Scenes navigating themselves.
   *
   * A scene is agent-authored code in a sandboxed frame with its own origin and
   * its own CSP (`connect-src 'none'`, no remote images), so it cannot FETCH
   * anything out. Navigating the frame is the one route that policy does not
   * close: `location = "https://elsewhere/?" + secret` is a navigation, not a
   * fetch. The renderer's own `frame-src` already bounds where a nested
   * context may go and is the first door; this is the second, because a
   * `frame-src` widened for some unrelated reason must not silently reopen it.
   *
   * Main frames keep the stricter rule above. Subframes are answered by
   * `isRendererFrameNavigationAllowed`, which iterates the same
   * `FRAME_SRC_EXTRA_SCHEMES` / `PACKAGED_FRAME_SCHEMES` literals the CSP's
   * `frame-src` is built from, so there is no hand-copied list to drift. It is
   * tighter than `frame-src` in one place on purpose: local http is allowed
   * only while a dev server is configured.
   */
  win.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    const url = event.url;
    if (
      isRendererFrameNavigationAllowed(url, {
        rendererUrl: getRendererUrl(),
        devServerUrl: process.env.VITE_DEV_SERVER_URL ?? null,
      })
    ) {
      return;
    }
    event.preventDefault();
    args.logger?.warn("window.frame_navigation_blocked", { url });
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
  if (/^https?:/i.test(rendererUrl)) {
    // The window loads from the Vite dev server (an unpackaged launch does so
    // with or without VITE_DEV_SERVER_URL). The server uses this mark to tell
    // the app window from a page of the built-in browser, which has the same
    // Electron user agent (`skipBrowserMockSnapshotForAppWindow` in vite.config.ts).
    win.webContents.setUserAgent(`${win.webContents.getUserAgent()} ${DEV_APP_WINDOW_USER_AGENT_MARK}`);
  }

  args.logger?.info("window.loading_url", {
    windowId: win.id,
    url: rendererUrl,
  });

  try {
    await win.loadURL(rendererUrl);
  } catch (error) {
    // The load did not finish because there is no window left to finish it in:
    // the app is quitting, or the user closed the window while the renderer was
    // still coming up. Chromium words that exactly like a real failure —
    // `ERR_FAILED (-2) loading '<url>'` — so it cannot be told apart by message.
    // A second launch that lost the single-instance lock reached here after
    // `app.quit()` before `ready` (2026-10-16, ADE-DESKTOP-1T): the boot ran in
    // a process that was already leaving and closed the window under the load.
    // A lock loser now exits before the boot (see `registerAdeProtocolHandler`),
    // so this branch is for a window closed mid-load by someone else.
    //
    // A warning, not an error: nothing failed, and the fallback page below has
    // nobody to be shown to — loading it anyway throws `Object has been
    // destroyed` out of the un-caught `app.whenReady()` chain, which is how this
    // line used to cost an unhandled rejection on top of the issue.
    if (isWindowLoadTargetGone(win)) {
      args.logger?.warn("window.load_url_abandoned", {
        windowId: win.id,
        url: rendererUrl,
        err: toErrorMessage(error),
      });
      return win;
    }
    args.logger?.error("window.load_url_failed", {
      windowId: win.id,
      url: rendererUrl,
      // The Error itself, so `logBridge` lifts it into the Sentry event and the
      // issue groups by the real failure; `errorText` keeps the sentence on
      // disk, which `JSON.stringify` writes an Error without.
      error,
      errorText: toErrorMessage(error),
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
  {
    // Agent-authored scenes. Non-standard on purpose: a non-standard scheme
    // gives the frame an opaque origin, which is exactly what a document ADE
    // did not write should get. It never streams because a scene is a single
    // in-memory string, and it never touches the filesystem at all.
    scheme: "ade-scene",
    privileges: { standard: false, supportFetchAPI: true, stream: false },
  },
]);

// Only Stable claims `ade://` as the default handler. Beta and Alpha still
// install the single-instance lock + `open-url` listeners (so a manual
// `duti` binding still works), but they don't ask the OS to make them the
// default on boot. Source builds and dev Electron launches never claim the OS
// binding; they only listen for URLs explicitly delivered to that process.
const deeplinkChannel = normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL);
const deeplinkClaimAsDefault = app.isPackaged && deeplinkChannel === null;

if (process.platform === "win32") {
  app.setAppUserModelId(ADE_WINDOWS_APP_USER_MODEL_ID);
}

const pendingAppNavigationRequests: AppNavigationRequest[] = [];
let dispatchAppNavigationRequest: ((request: AppNavigationRequest) => void) | null = null;
let dispatchAppNavigationForProjectRoot:
  | ((targetProjectRoot: string, request: AppNavigationRequest) => void)
  | null = null;

// Queue rather than drop when the window layer has not registered its
// dispatcher yet. Activity opens, `ade://` deeplinks, and file opens can all fire
// during launch, and a silent no-op is indistinguishable from a dead button.
const MAX_PENDING_APP_NAVIGATION_REQUESTS = 32;

// How long a launch waits for the post-update transaction to release the pool
// before going ahead without it. Every install recorded so far took two to four
// seconds for the whole transaction, so this is the "this install is not going
// the way it should" bound, not a budget the working case reaches — the pool
// itself grants a service install 90s and its window 120s, but a launch has no
// window on screen yet and holding one back that long reads as a hang. Past
// this, a launch with something to open falls back to what it did before the
// wait; the resume, which needs no window, does not (see below).
const POST_UPDATE_TRANSACTION_WAIT_MS = 30_000;

const dispatchOrQueueAppNavigationRequest = (request: AppNavigationRequest): void => {
  if (!dispatchAppNavigationRequest) {
    pendingAppNavigationRequests.push(request);
    if (pendingAppNavigationRequests.length > MAX_PENDING_APP_NAVIGATION_REQUESTS) {
      pendingAppNavigationRequests.splice(
        0,
        pendingAppNavigationRequests.length - MAX_PENDING_APP_NAVIGATION_REQUESTS,
      );
    }
    // Durable in the machine log and still on stdout; `logMachineEvent` owns
    // both, and swallows a failure of either — a missing console must never
    // break navigation queueing.
    logMachineEvent("warn", "app_navigation.queued_before_dispatcher_ready", {
      target: request.target.kind,
      source: request.source,
      queued: pendingAppNavigationRequests.length,
    });
    return;
  }
  dispatchAppNavigationRequest(request);
};

// Register the user-facing `ade://` deeplink scheme + single-instance lock so a
// second `open ade://...` invocation reuses the running window. Dispatch to the
// focused window's renderer via the existing IPC.appNavigate channel.
// A dev app that lost the single-instance lock shares its user-data folder with
// another running dev app. Without this it would exit with no message, and the
// user would see nothing happen. Say so and exit instead.
function exitDevAppSharingUserData(): void {
  const userData = app.getPath("userData");
  let holder = "another ADE dev app";
  try {
    const target = fs.readlinkSync(path.join(userData, "SingletonLock"));
    holder = `another ADE dev app (pid ${target.slice(target.lastIndexOf("-") + 1)})`;
  } catch {
    // Windows, or no readable lock link: the generic name will do.
  }
  const message = `${holder} is already using ${userData}. Close it, or start this one with `
    + "ADE_DESKTOP_USER_DATA_PATH=<another folder>. `npm run dev:desktop` from a lane worktree picks a folder of its own.";
  logMachineEvent("error", "desktop.dev_user_data_in_use", { userData, holder });
  flushMachineMainLog();
  process.stderr.write(`[ade] ${message}\n`);
  app.exit(1);
}

registerAdeProtocolHandler({
  claimAsDefault: deeplinkClaimAsDefault,
  dispatch: dispatchOrQueueAppNavigationRequest,
  // Which scheme this build claimed, and which process won the single-instance
  // lock, are facts about the computer, not about any project — and they are
  // decided before one can be open. They were `console.log` only because no
  // structured logger existed this early; the machine log does.
  log: (event, fields) => logMachineEvent("info", event, fields),
  flushLog: flushMachineMainLog,
  ...(app.isPackaged ? {} : { onLockLostWithoutForward: exitDevAppSharingUserData }),
  // Read only when the lock is lost, for the log line: the update install writes
  // `pendingInstallUpdate` into the global state file, and only the launch that
  // lands the install clears it.
  hasPendingInstallUpdate: () =>
    Boolean(readGlobalState(path.join(app.getPath("userData"), "ade-state.json")).pendingInstallUpdate),
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

/** Set once the updater exists; the Windows jump-list task reaches it through `second-instance`. */
let requestNativeUpdateInstall: (() => void) | null = null;
/** A jump-list request that arrived before the updater existed (ADE starting up, or started by it). */
let nativeUpdateInstallPending = process.platform === "win32" && process.argv.includes(INSTALL_UPDATE_ARG);

app.on("second-instance", (_event, argv) => {
  if (process.platform === "darwin") return;
  if (argv.includes(INSTALL_UPDATE_ARG)) {
    if (requestNativeUpdateInstall) requestNativeUpdateInstall();
    else nativeUpdateInstallPending = true;
    return;
  }
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

// One Muse quota store for the process: the chat service records what its hosts
// report, and the usage tracker publishes it in the header meter.
const museQuota = createMuseQuotaStore();

app.whenReady().then(async () => {
  // Perf run init — must come first so subsequent IPC + sampler hooks can see the active run.
  const perfRun = initPerfRunFromEnv();
  if (perfRun) {
    startMetricsSampler();
  }

  if (await blockPackagedLaunchForCrossChannelSyncConflict({
    isPackaged: app.isPackaged,
    channel: normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL),
  })) {
    return;
  }
  // A standalone brain (`ade brain update`) has no app resources: this record
  // is how it finds this app, its version and its signed native helpers.
  recordInstalledDesktopApp({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    executablePath: process.execPath,
    version: app.getVersion(),
    logger: getMachineMainLogger(),
  });

  /** Canonical artifacts dir for the active project; ade-artifact:// and the media server only serve under this path. */
  let adeArtifactAllowedDir: string | null = null;
  /** Reads proof bytes from a paired computer; set once the runtime bridge is up. */
  let remoteArtifactRangeReader: RemoteArtifactRangeReader | null = null;

  /**
   * The project a proof read is served from. A URL that names a `root` is
   * served from that project, and only when it is open on this computer: a
   * chat's proof must not depend on which window last had focus. A URL with no
   * `root` (an older stored uri) keeps the focused project. Either way the
   * path stays jailed in that one project's `.ade/artifacts`.
   */
  const artifactServeScope = (requestedRoot: string | null): ArtifactServeScope => {
    if (!requestedRoot) return { projectRoot: activeProjectRoot, allowedDir: adeArtifactAllowedDir };
    let openRoot: string | null = null;
    for (const root of projectContexts.keys()) {
      if (pathsEqual(root, requestedRoot)) {
        openRoot = root;
        break;
      }
    }
    if (!openRoot) return { projectRoot: null, allowedDir: null, refusal: "unknown-project" };
    try {
      return { projectRoot: openRoot, allowedDir: resolveAdeLayout(openRoot).artifactsDir };
    } catch {
      return { projectRoot: openRoot, allowedDir: null };
    }
  };
  const logArtifactServeRefusal = (refusal: ArtifactServeRefusal): void => {
    logMachineEvent("warn", "computer_use.artifact_serve_refused", refusal);
  };

  // Proof videos play from this loopback server, not `ade-artifact://`:
  // `protocol.handle` cannot answer the second Range read a long recording
  // needs. It starts on the first renderer ask and closes on quit.
  const artifactMediaServer = createArtifactMediaServer({
    localScope: artifactServeScope,
    remoteReader: () => remoteArtifactRangeReader,
    warn: (message, details) => logMachineEvent("warn", "computer_use.artifact_media_failed", { message, ...details }),
    onRefused: logArtifactServeRefusal,
  });
  ipcMain.handle(IPC.computerUseMediaBaseUrl, () => artifactMediaServer.baseUrl());
  // Saves a proof video that plays from the media server. The renderer cannot
  // read that server (a different origin with no CORS) and the whole-file
  // preview read stops at 10 MB, so main asks where to save and streams the
  // file there. Only URLs on this app's own media server are accepted.
  ipcMain.handle(
    IPC.computerUseSaveMediaAs,
    async (event, arg: { url?: unknown; fileName?: unknown }): Promise<{ saved: boolean; path?: string }> => {
      const url = typeof arg?.url === "string" ? arg.url : "";
      const base = await artifactMediaServer.baseUrl();
      if (!url || !url.startsWith(base.replace(/\/+$/, "") + "/")) {
        throw new Error("Only proof media from ADE's media server can be saved this way.");
      }
      const fileName = typeof arg?.fileName === "string" && arg.fileName.trim()
        ? path.basename(arg.fileName.trim())
        : "ade-proof.mp4";
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = { title: "Save proof", defaultPath: path.join(app.getPath("downloads"), fileName) };
      const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return { saved: false };
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`The media server answered ${response.status}.`);
      const { Readable } = await import("node:stream");
      const { pipeline } = await import("node:stream/promises");
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), fs.createWriteStream(choice.filePath));
      return { saved: true, path: choice.filePath };
    },
  );
  app.on("will-quit", () => {
    void artifactMediaServer.close();
  });

  // Handle ade-scene:// requests — serves agent-authored scenes from memory.
  // The id in `ade-scene://view/<id>` is a key into `sceneDocumentStore`, never
  // a path: this scheme has no filesystem reach by construction, so there is no
  // jail here to widen and none of `ade-artifact`'s allow-root applies to it.
  protocol.handle("ade-scene", (request) => {
    const { status, body, headers } = respondToSceneProtocolRequest(request.url);
    return new Response(body, { status, headers });
  });

  // Handle ade-artifact:// requests — serves local files for proof drawer images.
  protocol.handle("ade-artifact", (request) => respondToArtifactProtocolRequest(
    request,
    artifactServeScope,
    logArtifactServeRefusal,
  ));
  // What this computer's GPU was told to do, decided before any project opens.
  logMachineEvent("info", "app.hardware_acceleration", {
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
      key: readString(record, "key") ?? remoteProjectBindingKey(targetId, projectId),
      targetId,
      runtimeName: readString(record, "runtimeName") ?? "Remote",
      transport: record.transport === "paired" ? "paired" : "ssh",
      ...(hostname ? { hostname } : {}),
      projectId,
      rootPath,
      displayName: readString(record, "displayName") ?? path.basename(rootPath),
      ...(readString(record, "gitOriginUrl")
        ? { gitOriginUrl: readString(record, "gitOriginUrl") }
        : {}),
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
  /**
   * A binding that came from a renderer. Main stores and persists it, so it is
   * rebuilt field by field: a remote binding goes through the saved-binding
   * parser with its key recomputed, and a local one needs a string root.
   */
  const sanitizeRendererProjectBinding = (value: unknown): OpenProjectBinding | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind === "remote") {
      const remote = parseSavedRemoteProjectBinding(value);
      return remote ? { ...remote, key: remoteProjectBindingKey(remote.targetId, remote.projectId) } : null;
    }
    const rootPath = readString(record, "rootPath")?.trim();
    if (record.kind !== "local" || !rootPath) return null;
    return {
      kind: "local",
      key: `local:${rootPath}`,
      rootPath,
      displayName: readString(record, "displayName") ?? path.basename(rootPath),
    };
  };

  const readLastRemoteProjectBinding = (): RemoteOpenProjectBinding | null =>
    parseSavedRemoteProjectBinding(
      readGlobalState(globalStatePath).lastRemoteProjectBinding,
    );
  const readSavedMainWindowState = (): MainWindowState | null =>
    parseMainWindowState(readGlobalState(globalStatePath).mainWindow);
  const saveMainWindowState = (mainWindow: MainWindowState): void => {
    let current: GlobalState;
    try {
      current = readGlobalStateForUpdate(globalStatePath);
    } catch (error) {
      // An unreadable or corrupt file: skip the geometry rather than replace
      // the whole file (recents, update and browser settings) with it.
      logMachineEvent("warn", "desktop.main_window_state_save_skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    writeGlobalState(globalStatePath, { ...current, mainWindow });
  };
  const readLocalRecentProjects = (): RecentProject[] =>
    (readGlobalState(globalStatePath).recentProjects ?? [])
      .filter((entry) => !entry.remote);

  const machineAdeLayout = resolveMachineAdeLayout();
  // First launch after a hard reset: say what it saved and what it could not
  // remove. A clean reset with nothing rescued needs no dialog; the fresh
  // first-run screens say enough.
  const resetReceipt = takeMachineResetReceipt(machineAdeLayout.adeDir);
  if (resetReceipt) {
    logMachineEvent(resetReceipt.ok ? "info" : "warn", "desktop.machine_reset_receipt", {
      ok: resetReceipt.ok,
      removed: resetReceipt.removed.length,
      rescued: resetReceipt.rescued.length,
      failed: resetReceipt.failed.length,
    });
    if (resetReceipt.rescued.length || resetReceipt.failed.length) {
      const lines = [
        ...resetReceipt.rescued.map((lane) => lane.mode === "move"
          ? `Lane "${lane.lane}" was moved to ${lane.location}.`
          : `Lane "${lane.lane}" was saved on branch ${lane.branch} in ${lane.projectRoot}.`),
        ...resetReceipt.failed.slice(0, 10).map((failure) => `Not removed: ${failure.target} (${failure.error})`),
      ];
      void dialog.showMessageBox({
        type: resetReceipt.failed.length ? "warning" : "info",
        message: resetReceipt.failed.length ? "ADE was reset, with a few problems" : "ADE was reset",
        detail: lines.join("\n"),
      }).catch(() => undefined);
    }
  }
  // One subscription proxy supervisor belongs to this ADE install, not to the
  // currently-open project. Project contexts all point at the same machine
  // state.json; keeping the lazy instance here prevents duplicate children and
  // ensures closing one project cannot stop another project's proxy.
  let subscriptionProxyService: ProxyService | null = null;
  const getSubscriptionProxyService = (): ProxyService => {
    if (!subscriptionProxyService) {
      subscriptionProxyService = createProxyService({
        adeHome: machineAdeLayout.adeDir,
        getAnalytics: () => productAnalyticsService,
      });
    }
    return subscriptionProxyService;
  };
  setHarnessProxyStarter(() => getSubscriptionProxyService().ensureRunning());
  const startupState = normalizeStartupProjectState({
    saved,
    additionalRecentProjects: readMachineRegistryRecentProjects(
      machineAdeLayout,
      saved.recentProjects ?? [],
    ),
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
  // Ship the clarified connection trust model with a clean slate. Development
  // launches never touch a developer's saved machine list; each packaged
  // Stable/Beta/Alpha home owns an independent one-time marker.
  let machineTrustResetRestartRequired = false;
  if (app.isPackaged) {
    try {
      machineTrustResetRestartRequired = runMachineTrustResetMigration(machineAdeLayout).restartRequired;
    } catch (error) {
      // Leave the reset incomplete so the next launch retries. A filesystem
      // permission problem must not prevent ADE itself from starting. The
      // subject is this machine's saved machine list, so it belongs in the
      // machine log — and it fires before a project logger could exist.
      logMachineEvent("warn", "machine_trust_reset.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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

  // Window chrome: only Windows has a caption strip ADE owns. macOS traffic
  // lights are laid out and recoloured by the OS, so the renderer's calls are
  // a no-op there rather than a second, competing source of truth.
  ipcMain.handle(
    IPC.appSetTitleBarOverlay,
    (
      event,
      arg: { theme?: WindowsTitleBarOverlayTheme; zoomFactor?: number } = {},
    ): { applied: boolean } => {
      if (process.platform !== "win32") return { applied: false };
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { applied: false };
      try {
        win.setTitleBarOverlay(windowsTitleBarOverlay(arg));
        return { applied: true };
      } catch {
        // A window created without `titleBarOverlay` throws rather than
        // no-opping; nothing else about the window depends on this succeeding.
        return { applied: false };
      }
    },
  );

  ipcMain.handle(IPC.ptyDataSubscriptions, (event, arg: { ptyIds?: unknown } | undefined) => {
    setPtyDataSubscriptionsForSender(
      event.sender,
      normalizePtyDataSubscriptions(arg?.ptyIds),
    );
  });

  ipcMain.handle(IPC.appControlFrameSubscriptions, (event, arg: { laneIds?: unknown } | undefined) => {
    setAppControlFrameLanesForSender(
      event.sender,
      normalizeAppControlFrameLaneIds(arg?.laneIds),
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

  // The desktop bridge's log, which the demo engine shares.
  const builtInBrowserBridgeLogger = createFileLogger(
    path.join(app.getPath("userData"), "desktop-bridge.jsonl"),
  );
  // The Chromium demo engine (renders `.aderaw` captures on any OS). One per
  // desktop, shared by the built-in browser's recorder, App Control and the
  // runtime daemon (over the bridge below), so jobs queue on one hidden renderer.
  const chromiumDemoEngine = createChromiumDemoEngine({ logger: builtInBrowserBridgeLogger });
  const builtInBrowserService = createBuiltInBrowserService({
    getLogger: () => getActiveContext().logger,
    demoEngine: chromiumDemoEngine,
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
    getFallbackWindowForProjectRoot: (projectRoot) => {
      // Only ADE app windows (never the hidden recording/demo renderers): one
      // that opened this checkout, else the focused one, else any.
      const normalizedRoot = normalizeProjectRoot(projectRoot);
      const appWindows = BrowserWindow.getAllWindows().filter(
        (win) => !win.isDestroyed()
          && (windowProjectRoots.has(win.id) || windowProjectBindings.has(win.id)),
      );
      const knowsRoot = (win: BrowserWindow) =>
        [...(windowKnownLocalProjectRoots.get(win.id) ?? [])].some((root) => pathsEqual(root, normalizedRoot));
      return appWindows.find(knowsRoot)
        ?? appWindows.find((win) => win.isFocused())
        ?? appWindows[0]
        ?? null;
    },
    getFallbackWindowForPersonalCollection: () => {
      // Personal chats have no project binding to route through. When an agent
      // opens a tab without showing the Browser pane, host its capture surface
      // in the focused ADE window (or the first live one) without activating
      // the personal collection in that window.
      const appWindows = BrowserWindow.getAllWindows().filter(
        (win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
      );
      return appWindows.find((win) => win.isFocused())
        ?? appWindows[0]
        ?? null;
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
    // `browser.autoOpenDevServer` is per project, and the browser service is
    // process-wide — so resolve the setting from the project that owns the lane
    // the ready line was printed in, not from whichever window happens to be in
    // front. Reading the foreground project meant a project that had opted out
    // still got auto-opened tabs while another project was focused.
    isDevServerAutoOpenEnabled: async (record) => {
      const laneId = record.source.laneId;
      if (laneId) {
        for (const ctx of projectContexts.values()) {
          const lane = await ctx.laneService?.getSummary(laneId, { includeStatus: false })
            .catch(() => null);
          if (!lane) continue;
          return ctx.projectConfigService?.getEffective().browser?.autoOpenDevServer ?? true;
        }
      }
      return getActiveContext().projectConfigService?.getEffective().browser?.autoOpenDevServer ?? true;
    },
    // The origin-approval prompt names the chat and lane the way the person
    // knows them. A chat belongs to one project context; its session row
    // carries both its title and its lane's name.
    // A runtime-backed project keeps its chats in the brain, so the local
    // session row can be missing; the chat service and the lane still answer.
    describeAgent: async ({ laneId, chatSessionId }) => {
      for (const [projectRoot, ctx] of projectContexts) {
        const session = chatSessionId ? ctx.sessionService?.get(chatSessionId) ?? null : null;
        if (session && session.title && session.laneName) {
          return { chatTitle: session.title, laneName: session.laneName, projectRoot };
        }
        const summary = chatSessionId
          ? await ctx.agentChatService?.getSessionSummary(chatSessionId).catch(() => null) ?? null
          : null;
        const chatTitle = session?.title || summary?.title || null;
        const resolvedLaneId = laneId || summary?.laneId || null;
        const lane = resolvedLaneId
          ? await ctx.laneService?.getSummary(resolvedLaneId, { includeStatus: false }).catch(() => null) ?? null
          : null;
        if (session || summary || lane) {
          return { chatTitle, laneName: session?.laneName || lane?.name || null, projectRoot };
        }
        // A runtime-backed context has neither service here: ask its brain.
        if (!shouldUseInProcessProjectRuntime()) {
          const fromBrain = await describeAgentFromRuntime(projectRoot, laneId, chatSessionId);
          if (fromBrain) return fromBrain;
        }
      }
      return null;
    },
    // "Agents can use the ADE browser" is machine-wide, like the browser
    // profile it protects, so it lives in the desktop's global state. Electron
    // main owns the browser, so main is where every caller — a local chat, the
    // brain's desktop bridge, a remote runtime forwarding to this Mac — is
    // checked against it.
    agentAccessStore: {
      read: () => readGlobalState(globalStatePath).builtInBrowserAgentAccess ?? null,
      write: (next) => {
        const current = readGlobalState(globalStatePath);
        writeGlobalState(globalStatePath, { ...current, builtInBrowserAgentAccess: next });
      },
    },
    onAgentAccessChange: (snapshot) => broadcast(IPC.builtInBrowserAgentAccessEvent, snapshot),
    // Tab limit, download folder and standing permission grants. Same file,
    // same read-modify-write as the agent-access block above.
    browserSettingsStore: {
      read: () => readGlobalState(globalStatePath).builtInBrowserSettings ?? null,
      write: (next) => {
        const current = readGlobalState(globalStatePath);
        writeGlobalState(globalStatePath, { ...current, builtInBrowserSettings: next });
      },
    },
    onBrowserSettingsChange: (settings) => broadcast(IPC.builtInBrowserSettingsEvent, settings),
    onHandoff: createBuiltInBrowserHandoffSessionListener({
      getLogger: () => getActiveContext().logger,
      // A chat session belongs to exactly one project context, and a handoff can
      // outlive whichever project happens to be active — so find the context
      // that actually owns the row instead of assuming the foreground one.
      resolveServices: (chatSessionId) => {
        for (const ctx of projectContexts.values()) {
          if (!ctx.sessionService?.get(chatSessionId)) continue;
          return {
            sessionService: ctx.sessionService,
            agentChatService: ctx.agentChatService,
          };
        }
        return { sessionService: null, agentChatService: null };
      },
    }),
  });

  // Side-channel JSON-RPC server that lets the runtime daemon proxy
  // `ade browser …` CLI calls into this Electron main process.
  // The daemon runs under ELECTRON_RUN_AS_NODE and can't host the browser
  // service itself (it needs WebContentsView). The bridge socket lives under
  // `<adeHome>/sock/desktop-bridge.sock`; the daemon discovers it via
  // resolveMachineAdeLayout() or ADE_DESKTOP_BRIDGE_SOCKET_PATH.
  const builtInBrowserBridgeSocketPath =
    process.env.ADE_DESKTOP_BRIDGE_SOCKET_PATH?.trim()
    || machineAdeLayout.desktopBridgeSocketPath;
  // The App Control screencast encoder (Windows/Linux recording engine). One
  // per desktop: recordings are keyed per lane, and lane ids are unique across
  // projects. In-process project contexts use it directly; the runtime daemon
  // reaches it over the bridge below. It opens no window until a recording starts.
  const appControlScreencastRecorder = createAppControlScreencastRecorderHost({
    logger: builtInBrowserBridgeLogger,
  });
  let builtInBrowserBridgeServer: ReturnType<typeof startBuiltInBrowserDesktopBridgeServer> | null = null;
  // "Update & restart" pressed on another machine, forwarded by this machine's
  // brain. Built once the update service exists, further down.
  let remoteUpdateInstaller: RemoteUpdateInstaller | null = null;
  /** Windows: this desktop runs elevated, so the background service cannot reach it. */
  let elevatedDesktop = false;
  ipcMain.handle(IPC.appGetElevatedDesktop, () => elevatedDesktop);
  try {
    builtInBrowserBridgeServer = startBuiltInBrowserDesktopBridgeServer({
      socketPath: builtInBrowserBridgeSocketPath,
      // Windows: an older brain dials the bridge pipe name an older ADE derived.
      aliasSocketPaths: process.env.ADE_DESKTOP_BRIDGE_SOCKET_PATH?.trim()
        ? []
        : resolveMachineEndpointNames().desktopBridge.slice(1),
      service: builtInBrowserService,
      logger: builtInBrowserBridgeLogger,
      appControlScreencastRecorder,
      demoEngine: chromiumDemoEngine,
      getAppUpdateInstaller: () => remoteUpdateInstaller,
      // `ade scene preview`: a hidden, isolated window per render. The fonts
      // come from the packaged renderer's assets, or the packages in a dev run.
      scenePreview: (request) => renderScenePreview(request, {
        appPath: app.getAppPath(),
        rendererDir: path.join(__dirname, "../renderer"),
        logger: builtInBrowserBridgeLogger,
      }),
      // Windows: an elevated desktop's pipe refuses the background service.
      // A lasting state, so the renderer docks a banner for it.
      onElevatedDesktop: () => {
        elevatedDesktop = true;
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          try {
            win.webContents.send(IPC.appElevatedDesktopChanged, true);
          } catch {
            // ignore
          }
        }
      },
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
  /**
   * Windows whose renderer has announced that its menu-command subscriber is
   * mounted. Cleared on every main-frame navigation and on window close, so a
   * reload puts the window back to "answer ⌘W from here" until it re-acks.
   */
  const windowCommandSubscribers = new Set<number>();
  /** Native-menu commands (zoom, ⌘F, ⌘W) offered to the renderer before the app answers them. */
  const appCommandSender = createAppCommandSender<BrowserWindow>({
    hasRenderer: (windowId) => windowProjectRoots.has(windowId),
    hasCommandSubscriber: (windowId) => windowCommandSubscribers.has(windowId),
  });
  /**
   * Ctrl/Cmd + mouse wheel zooms the app like the View menu does. Chromium
   * reports the gesture as `zoom-changed` on the window's own page and leaves
   * the zoom to us; a page that handles the wheel itself (a viewer's pan and
   * zoom, the built-in browser's webview) never raises it here. One step per
   * 100 ms, so a trackpad's burst of wheel events is not a dozen steps.
   */
  const WHEEL_ZOOM_STEP_MS = 100;
  const attachWheelZoom = (win: BrowserWindow): void => {
    let lastStepAt = 0;
    win.webContents.on("zoom-changed", (_event, direction) => {
      const now = performance.now();
      if (now - lastStepAt < WHEEL_ZOOM_STEP_MS) return;
      lastStepAt = now;
      appCommandSender({ kind: "zoom", command: direction }, win);
    });
  };
  ipcMain.on(IPC.appCommandsReady, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    windowCommandSubscribers.add(win.id);
  });
  const windowProjectTabRoots = new Map<number, Set<string>>();
  /**
   * Every local project root this window has actually opened during this
   * session, kept as the window's local runtime scope.
   *
   * `windowProjectTabRoots` is replaced wholesale by the renderer on every tab
   * change and `windowProjectRoots` is nulled the moment the tab binds to a
   * remote machine, so neither can answer "was this window ever working in this
   * local checkout?". A chat pinned to "This computer" is exactly that question:
   * its lane lives on this machine no matter which machine the project tab is
   * currently bound to, and rejecting it left cross-machine Work views unable to
   * act on their own local sessions. Membership is only ever granted by the
   * window opening the project itself, never by a renderer-supplied path.
   */
  const windowKnownLocalProjectRoots = new Map<number, Set<string>>();

  const rememberWindowKnownLocalProjectRoot = (
    windowId: number | null,
    rootPath: string | null | undefined,
  ): void => {
    if (windowId == null || !rootPath) return;
    const roots = windowKnownLocalProjectRoots.get(windowId) ?? new Set<string>();
    roots.add(rootPath);
    windowKnownLocalProjectRoots.set(windowId, roots);
  };
  const windowPendingProjectRoots = new Map<number, Map<string, number>>();
  const windowProjectBindings = new Map<number, RemoteOpenProjectBinding>();
  const ipcWindowScope = new AsyncLocalStorage<number | null>();
  const rpcSocketCleanupByRoot = new Map<string, () => void>();
  const projectLastActivatedAt = new Map<string, number>();
  const mobileSyncHandoffLeases = new Map<string, number>();
  const mobileSyncHandoffLeaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const mobileSyncPreparationPromises = new Map<string, Promise<SyncProjectSwitchResultPayload>>();
  const localRuntimeLogger = createFileLogger(path.join(app.getPath("userData"), "local-runtime.jsonl"));
  /**
   * The signed-in account owner, once there is an auth service to ask.
   *
   * Late-bound because the account services are built far below, while the
   * diagnostics report builder that hashes this id is built up here next to its
   * triggers. Null before then simply means an unattributed report.
   *
   * It has to stay late-bound: `getSharedAccountAuthService` caches ONE service
   * per secrets directory and the FIRST caller's options are the ones that
   * survive, so calling it here — before `accountBridge` and `runtimeBridge`
   * pass theirs — would silently pin the whole app to a default-configured
   * account service. The reference is filled in beside the call that legitimately
   * constructs it; the reader itself is a const so no later assignment can
   * quietly repoint it somewhere else.
   */
  let accountAuthServiceForOwnerId: AccountAuthService | null = null;
  const readAccountOwnerId = (): string | null => {
    const status = accountAuthServiceForOwnerId?.getStatus();
    return status?.signedIn ? status.userId?.trim() || null : null;
  };
  const productAnalyticsStateFile = defaultProductAnalyticsStateFile(machineAdeLayout.adeDir);
  const productAnalyticsService = getSharedProductAnalyticsService(productAnalyticsStateFile, () =>
    createProductAnalyticsService({
      stateFilePath: productAnalyticsStateFile,
      logger: localRuntimeLogger,
      appVersion: app.getVersion(),
      runtimeMode: app.isPackaged ? "desktop_packaged" : "desktop_development",
    }));
  setSentryUserResolver(() => productAnalyticsService.getDistinctId());
  /**
   * One reporter for every window: a third `createWindow` site that forgets to
   * wire this would silently stop reporting lost renderers.
   */
  const reportRendererRecovery = (outcome: { crash_reason: string; recovered: boolean }): void => {
    productAnalyticsService.captureInternal({
      event: "ade_renderer_recovered",
      surface: "desktop",
      properties: outcome,
    });
  };
  productAnalyticsService.captureInternal({
    event: "ade_app_installed",
    surface: "desktop",
    properties: {
      install_source: detectInstallSource({
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        configuredSource: process.env.ADE_INSTALL_SOURCE,
        appImagePath: process.env.APPIMAGE,
      }),
    },
  });
  productAnalyticsService.capture({
    event: "ade_app_opened",
    surface: "desktop",
    dedupeKey: "desktop-app-opened",
    minimumIntervalMs: 30 * 60_000,
    properties: {
      entry_point: pendingStartupProjectRoot ? "project_file" : envRoot ? "environment" : "app_icon",
      is_packaged: app.isPackaged,
      // Beta is a track of the normal install; its builds say so by version.
      release_channel: !app.isPackaged ? "development" : packagedChannel ?? updateTrackOfVersion(app.getVersion()),
    },
  });
  const shouldRepairRuntimeServiceOnFallback =
    app.isPackaged
    && process.env.NODE_ENV !== "test"
    && process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL !== "1";
  // Set once the diagnostics service exists, which is created after the pool.
  let reportAppFallback: ((reason: string) => void) | null = null;
  let reportedAppFallbackSince: string | null = null;
  const localRuntimePool = new LocalRuntimeConnectionPool(app.getVersion(), localRuntimeLogger, {
    // A dev app's brain must never compete for the machine-wide sync host
    // lease: on 2026-09-21 a lane dev brain on a custom socket took the lease
    // from the installed ADE twice, and the agents running under that brain
    // died with it. Set ADE_DEV_RUNTIME_SYNC=1 to opt a dev brain in on purpose.
    disableSync: !app.isPackaged && process.env.ADE_DEV_RUNTIME_SYNC !== "1",
    preferServiceRepair: shouldRepairRuntimeServiceOnFallback,
    onRuntimeStatusChange: (status) => {
      broadcast(IPC.appRuntimeStatusChanged, status);
      // A service manager that refused the brain is the fleet failure nobody
      // reports by hand: ADE keeps working, so nobody presses anything.
      const fallback = status.appFallback;
      if (fallback && fallback.since !== reportedAppFallbackSince) {
        reportedAppFallbackSince = fallback.since;
        reportAppFallback?.(fallback.reason);
      }
    },
    onRuntimeModeChange: (mode) => {
      localRuntimeLogger.warn("local_runtime.runtime_mode_changed", { mode });
      if (!Notification.isSupported()) return;
      try {
        const notification = mode === "isolated"
          ? new Notification({
              title: "ADE is running in fallback mode",
              body: "The ADE background service did not restart cleanly. Phone sync and connections from other machines are unavailable while ADE keeps retrying in the background.",
            })
          : new Notification({
              title: "ADE service restored",
              body: "Phone sync and connections from other machines are available again.",
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
  // Every desktop report says which brain it talked to and which project id
  // it held per folder; a report about an unknown project id also gets the
  // machine's project list and its journal (`shared/sentry/diagnostics.ts`).
  registerSentryDiagnosticContext("brain_connection", () => localRuntimePool.diagnosticSnapshot());
  // A failure on another machine's brain is about that machine's list.
  const attachProjectRegistry = projectRegistryDiagnosticAttachment(new ProjectRegistry(machineAdeLayout).diagnosticPaths());
  registerSentryDiagnosticAttachment("project-registry", (event) => (isRemoteMachineEvent(event) ? null : attachProjectRegistry(event)));
  // App Control screencasts follow what the windows show: a lane no window
  // holds streams no frames, in the brain or in a project hosted here.
  setAppControlFrameLanesListener(() => {
    const lanes = heldAppControlFrameLanes();
    localRuntimePool.setAppControlFrameLanes(lanes);
    for (const ctx of projectContexts.values()) {
      ctx.appControlService?.setFrameDemand(APP_CONTROL_WINDOWS_FRAME_DEMAND_SOURCE, lanes);
    }
  });
  const accountVaultBridge = createAccountVaultBridge({
    getPool: () => localRuntimePool,
    getRootPath: () => bootedUsageScopeRoot([...projectContexts.values()]),
    logger: localRuntimeLogger,
  });
  const resolveMcpAuthToken = createMcpRegistryAuthTokenResolver({
    adeHome: machineAdeLayout.adeDir,
    readSecret: async (key) => {
      const result = await accountVaultBridge.get("all", MCP_SECRET_VAULT_KIND, key);
      return result.ok ? result.value : null;
    },
    writeSecret: async (key, value) => (await accountVaultBridge.set("all", MCP_SECRET_VAULT_KIND, key, value)).ok,
    logger: localRuntimeLogger,
  });
  // Carry this machine's OS-level suspend/resume into the brain, which has no
  // such hook of its own and owns the account-directory publisher. Registered
  // here rather than lazily so the beat is already wired the first time the lid
  // closes, and disposed with the app below.
  const machinePowerBrainBridge = createMachinePowerBrainBridge({
    powerSource: getPowerStateService(),
    logger: localRuntimeLogger,
    report: ({ kind, budgetMs }) => localRuntimePool.callSync(
      "machine.reportPowerTransition",
      { kind, budgetMs },
      { timeoutMs: budgetMs },
    ),
  });
  const mirrorDesktopRecentProjectToMachineCatalog = (rootPath: string): void => {
    void localRuntimePool.ensureProject(rootPath, {
      catalogVisibility: "recent",
      registrationSource: "desktop",
    }).catch((error) => {
      localRuntimeLogger.warn("local_runtime.recent_project_mirror_failed", {
        rootPath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  if (shouldAttemptRuntimeServiceInstall) {
    void localRuntimePool.installServiceBestEffort({
      forceRestart: machineTrustResetRestartRequired,
    })
      .then(() => {
        const status = localRuntimePool.getStatus().serviceInstall;
        if (status.state === "installed") {
          markMachineStateMigrationComplete({ layout: machineAdeLayout });
          // The reset is complete only once the brain has actually been
          // replaced. A forced install may legitimately decline to restart a
          // brain that is still starting up (it waits for it instead), and
          // that brain loaded the pre-reset files; leaving the marker unset
          // makes the next launch restart it for real.
          if (machineTrustResetRestartRequired && status.restarted === true) {
            markMachineTrustResetComplete(machineAdeLayout);
          }
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

  /**
   * The chat title and lane name for the browser agent-access prompt, read
   * from the project's brain. A runtime-backed project keeps its chats and
   * lanes there, not in this process. Best-effort: on any failure the prompt
   * falls back to short ids.
   */
  const describeAgentFromRuntime = async (
    projectRoot: string,
    laneId: string | null,
    chatSessionId: string | null,
  ): Promise<{ chatTitle: string | null; laneName: string | null; projectRoot: string } | null> => {
    const read = async (request: { domain: string; action: string; args?: Record<string, unknown>; argsList?: unknown[] }) => {
      try {
        const response = await localRuntimePool.callActionForRoot(projectRoot, request);
        return response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : null;
      } catch {
        return null;
      }
    };
    const summary = chatSessionId
      ? await read({ domain: "chat", action: "getSessionSummary", argsList: [chatSessionId] })
      : null;
    const resolvedLaneId = laneId || (typeof summary?.laneId === "string" ? summary.laneId : null);
    const lane = resolvedLaneId
      ? await read({ domain: "lane", action: "getSummary", args: { laneId: resolvedLaneId, includeStatus: false } })
      : null;
    const chatTitle = typeof summary?.title === "string" && summary.title.trim() ? summary.title : null;
    const laneName = typeof lane?.name === "string" && lane.name.trim() ? lane.name : null;
    return chatTitle || laneName ? { chatTitle, laneName, projectRoot } : null;
  };

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
    // The gate on what may join the window's local runtime scope lives in
    // `resolveWindowTabRoots` (see it for why a renderer-named path is not
    // enough), so it can be tested without standing up a window.
    const { tabRoots, authorizedLocalRoots } = resolveWindowTabRoots({
      rootPaths,
      activeRoot: windowProjectRoots.get(windowId) ?? null,
      normalizeRoot: normalizeProjectRoot,
      isOpenedProjectRoot: (root) => projectForRoot(root) != null,
    });
    windowProjectTabRoots.set(windowId, tabRoots);
    for (const root of authorizedLocalRoots) {
      rememberWindowKnownLocalProjectRoot(windowId, root);
    }
    persistUpdateWorkspace();
    scheduleProjectContextRebalance();
    return projectsForWindowTabs(windowId);
  };

  /** A recent-project entry for `project`; a local project replaces any saved remote binding. */
  const withRecentProject = (
    current: GlobalState,
    project: ProjectInfo,
    options: { recordLastProject?: boolean; recordRecent?: boolean; preserveRecentOrder?: boolean },
  ): GlobalState => {
    const state = upsertRecentProject(current, project, options);
    delete state.lastRemoteProjectBinding;
    return state;
  };

  const persistUpdateWorkspace = (): void => {
    writeGlobalState(globalStatePath, withUpdateWorkspace(readGlobalState(globalStatePath)));
  };

  const withUpdateWorkspace = (current: GlobalState): GlobalState => {
    const localRoots: string[] = [];
    let fallbackActiveRoot: string | null = null;
    for (const [windowId, tabRoots] of windowProjectTabRoots) {
      for (const root of tabRoots) {
        if (!localRoots.some((existing) => pathsEqual(existing, root))) localRoots.push(root);
      }
      const bound = windowProjectRoots.get(windowId) ?? null;
      if (bound && localRoots.some((root) => pathsEqual(root, bound))) fallbackActiveRoot = bound;
    }
    const activeLocalRoot = activeProjectRoot && localRoots.some((root) => pathsEqual(root, activeProjectRoot))
      ? activeProjectRoot
      : fallbackActiveRoot;
    return {
      ...current,
      updateWorkspace: {
        localRoots,
        activeLocalRoot,
      },
    };
  };

  const bindingForLocalProject = (project: ProjectInfo | null): OpenProjectBinding | null =>
    project && !shouldUseInProcessProjectRuntime()
      ? {
        kind: "local",
        key: `local:${project.rootPath}`,
        rootPath: project.rootPath,
        displayName: project.displayName,
        gitOriginUrl: readGitOriginUrl(project.rootPath),
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

  const setForegroundProject = (
    projectRoot: string | null,
    options: { persistRecent?: boolean } = {},
  ): void => {
    activeProjectRoot = projectRoot ? normalizeProjectRoot(projectRoot) : null;
    void reconcileSyncHostContexts().then(() => {
      notifyMobileSyncProjectCatalogChanged();
    });
    if (activeProjectRoot) {
      projectLastActivatedAt.set(activeProjectRoot, Date.now());
      const activeCtx = projectContexts.get(activeProjectRoot);
      if (activeCtx && options.persistRecent !== false) {
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

  // Build the fire-time reconcile runner for a project. The queued entry
  // re-resolves the LIVE context when it actually fires, so a project evicted
  // between scheduling and firing simply drops out instead of reconciling a
  // defunct service (avoids stale-closure GitHub calls). In-process runtimes
  // reconcile directly; a dormant/runtime-backed (production) context has no
  // local prService, so the catch-up sweep is routed to the daemon's `pr`
  // domain where the always-on runtime actually owns prService.
  const buildReconcileRunner = (projectRoot: string): (() => Promise<unknown>) => {
    return async () => {
      const liveCtx = projectContexts.get(projectRoot);
      if (!liveCtx) return; // evicted before firing → drop
      if (liveCtx.prService) {
        await liveCtx.prService.reconcileOnFocus();
        return;
      }
      // Dormant/runtime-backed context: prService lives in the daemon runtime.
      await localRuntimePool
        .callActionForRoot(projectRoot, { domain: "pr", action: "reconcileOnFocus" })
        .catch(() => {
          // best-effort; the daemon may be reconnecting after a restart
        });
    };
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
        rememberWindowKnownLocalProjectRoot(windowId, normalizedRoot);
      }
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed()) {
        builtInBrowserService.attachToWindow(win);
      }
    }
    const ctx = normalizedRoot ? projectContexts.get(normalizedRoot) ?? null : null;
    if (options.foreground ?? true) {
      // The recent entry is written below, in one write with the workspace roots.
      setForegroundProject(normalizedRoot, { persistRecent: false });
    }
    if (normalizedRoot) {
      projectLastActivatedAt.set(normalizedRoot, Date.now());
      if (ctx) {
        // Fire-and-forget catch-up reconcile on warm-reuse / deep-link focus.
        // Throttled per-project + globally capped, so this never blocks focus.
        // The runner routes in-process vs. daemon and re-resolves the live
        // context at fire time (production contexts are dormant here).
        scheduleReconcile(buildReconcileRunner(normalizedRoot));
      }
      if (!shouldUseInProcessProjectRuntime()) {
        // Desktop foregrounding is independent from phone sync project selection:
        // registering the project lets desktop clients route RPC by projectId without
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
    // One read and one fsync'd write of the global state for the whole bind:
    // the recent entry and the window's workspace roots used to be written
    // separately, three times per project switch.
    const updatesWorkspace = windowId != null && normalizedRoot != null;
    if (ctx || updatesWorkspace) {
      let state = readGlobalState(globalStatePath);
      if (ctx) state = withRecentProject(state, ctx.project, { recordLastProject: false, preserveRecentOrder: true });
      if (updatesWorkspace) state = withUpdateWorkspace(state);
      writeGlobalState(globalStatePath, state);
      if (ctx) mirrorDesktopRecentProjectToMachineCatalog(ctx.project.rootPath);
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
    const persistedBinding = persistableRemoteProjectBinding({
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
          transport: binding.transport ?? "ssh",
          hostname: binding.hostname || binding.runtimeName,
          ...(binding.gitOriginUrl
            ? { gitOriginUrl: binding.gitOriginUrl }
            : {}),
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
    shouldSendTo?: (webContents: WebContents) => boolean,
  ): void => {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    for (const win of BrowserWindow.getAllWindows()) {
      const isActiveInWindow = windowProjectRoots.get(win.id) === normalizedRoot;
      const isOpenTabInWindow = windowProjectTabRoots.get(win.id)?.has(normalizedRoot) === true;
      if (!isActiveInWindow && !isOpenTabInWindow) continue;
      if (shouldSendTo && !shouldSendTo(win.webContents)) continue;
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
  let runtimeServiceUninstalledForUpdate = false;
  let autoUpdateInstallRollbackReason: string | null = null;
  // The launch half of an install holds the pool in an update window until it
  // finishes, and nothing connects while that window is open. Launch work that
  // has to reach a runtime waits on this. Null on every launch that is not
  // landing an install.
  let postUpdateTransactionDone: Promise<void> | null = null;
  const reinstallRuntimeServiceAfterUpdateAbort = async (reason: string): Promise<void> => {
    // The install is off. Normal recovery owns the service again from here,
    // whether or not this abort has anything to reinstall.
    localRuntimePool.endUpdateWindow(`install_aborted:${reason}`);
    if (!runtimeServiceUninstalledForUpdate) return;
    const result = await installRuntimeService();
    const payload = {
      reason,
      ok: result.ok,
      serviceName: result.serviceName,
      path: result.path,
      message: result.message,
      selfMutationBlocked: result.selfMutationBlocked === true,
    };
    if (!result.ok) {
      updateLogger.error("autoUpdate.runtime_service_reinstall_after_abort_failed", payload);
      throw new Error(result.message);
    }
    runtimeServiceUninstalledForUpdate = false;
    updateLogger.info("autoUpdate.runtime_service_reinstalled_after_abort", payload);
  };
  const prepareAutoUpdateInstall = async (
    resumeRequested: boolean,
    { closeAfterInstall }: { closeAfterInstall: boolean },
  ): Promise<UpdateInterruptedChat[]> => {
    updateLogger.info("autoUpdate.prepare_quit_and_install_start", {
      serviceManaged: shouldRepairRuntimeServiceOnFallback,
      resumeRequested,
      closeAfterInstall,
    });
    // Windows are still open here. The quit that follows closes them, and each
    // closed handler would otherwise save an empty tab list over this snapshot.
    persistUpdateWorkspace();
    // From here until the app quits, the missing (or old) background service
    // is the update working. The pool must not answer it with a repair that
    // reinstalls what this function is about to remove.
    localRuntimePool.beginUpdateWindow("prepare_quit_and_install");
    runtimeServiceUninstalledForUpdate = false;
    autoUpdateInstallRollbackReason = null;
    // Read the interrupted chats while the runtime is definitely reachable;
    // the service uninstall below can take the brain down. Nothing is armed
    // here — the list is persisted with the pending install and only becomes a
    // resume on the launch that actually lands it. That is what makes an
    // aborted handoff harmless: no install, no resume rows.
    const interruptedChats = resumeRequested
      ? (await updateImpactProbe.liveChats()).filter((chat) => chat.resumable !== false)
      : [];
    // An install the person quit into stops nothing. The feed re-check before
    // this took seconds, and a chat can have started meanwhile; this throws
    // (and the quit stays a plain quit) when one did.
    if (closeAfterInstall) {
      const version = autoUpdateService.getSnapshot().version;
      if (version) await installOnQuit.confirmBeforeServiceStop(version);
    }
    if (!shouldRepairRuntimeServiceOnFallback) {
      updateLogger.info("autoUpdate.prepare_quit_and_install_done", {
        serviceManaged: false,
      });
      return interruptedChats;
    }
    const result = await uninstallRuntimeService();
    if (!result.ok) {
      // Nothing was removed and the install will not proceed, so recovery must
      // get its normal freedom back immediately.
      localRuntimePool.endUpdateWindow("uninstall_before_install_failed");
    }
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
    runtimeServiceUninstalledForUpdate = true;
    if (autoUpdateInstallRollbackReason) {
      await reinstallRuntimeServiceAfterUpdateAbort(autoUpdateInstallRollbackReason);
      return interruptedChats;
    }
    updateLogger.info("autoUpdate.prepare_quit_and_install_done", {
      serviceManaged: true,
    });
    return interruptedChats;
  };
  const rollbackAutoUpdateInstall = async (reason: string): Promise<void> => {
    autoUpdateInstallRollbackReason = reason;
    await reinstallRuntimeServiceAfterUpdateAbort(reason);
  };
  // Channel builds do not check for updates. There is no per-channel publish
  // feed: an Alpha would poll Stable's feed and offer to "update" itself into
  // a Stable installer with a different appId and ADE home.
  const hasUpdateFeed = app.isPackaged && !normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL);
  const autoUpdateService = createAutoUpdateService({
    logger: updateLogger,
    currentVersion: app.getVersion(),
    globalStatePath,
    updaterCacheDir: app.isPackaged ? resolveAutoUpdaterCacheDir() : undefined,
    installTargetPath: process.execPath,
    autoCheckEnabled: hasUpdateFeed,
    // Stable and Beta are tracks of this same install, not channels: the
    // machine's choice lives in ~/.ade/update-track.json so the brain and the
    // CLI read the same one (docs/plans/beta-track.md). A channel build (Alpha)
    // has no feed and no track.
    ...(hasUpdateFeed
      ? {
          readSelectedTrack: () => readSavedUpdateTrack()?.track ?? null,
          writeSelectedTrack: (track: UpdateTrack) => {
            writeSavedUpdateTrack(track);
          },
          // The newest build of both tracks, so a machine on the other track
          // is offered the newest build on its own (Settings › Update other machines).
          latestByTrack: createLatestByTrackReader({
            fetchJson: fetchReleaseManifestJson,
            fetchStableFallback: async () => (await fetchAdeLatestRelease())?.version ?? null,
            logger: updateLogger,
          }),
        }
      : {}),
    beforeQuitAndInstall: prepareAutoUpdateInstall,
    stopOwnedRuntimeCooperatively: (options) => localRuntimePool.stopOwnedRuntimeCooperatively(options),
    rollbackQuitAndInstall: rollbackAutoUpdateInstall,
    onInstallHandoff: process.platform === "win32" && app.isPackaged
      ? ({ version, installerPath, closeAfterInstall }) => startWindowsInstallProgress({
          channel: normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL),
          productName: appPackageChannelDisplayName(normalizeAppPackageChannel(process.env.ADE_PACKAGE_CHANNEL)),
          currentVersion: app.getVersion(),
          targetVersion: version,
          appExe: process.execPath,
          installerPath,
          resourcesPath: process.resourcesPath,
          adeHome: resolveMachineAdeDir(),
          quitInstall: closeAfterInstall,
          log: (event, data) => updateLogger.info(event, data),
        })
      : undefined,
    // The remedy for a wedged updater session. Same quit warnings as any quit,
    // so running agents are never ended without the user seeing them.
    relaunchApp: () => requestQuitAfterWarnings(null, "relaunch"),
    getRuntimeActivitySummary: () => localRuntimePool.activitySummary(),
    productAnalyticsService,
    releaseRepository: packagedReleaseRepository,
    forceQuit: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.destroy();
        } catch {
          // Keep escalating through every window; app.exit is the hard bound.
        }
      }
      app.exit(0);
    },
  });
  // Once per launch, to Sentry Logs: how many machines run a build is what
  // the beta gate reads before a beta becomes stable.
  updateLogger.info("app.started", {
    version: app.getVersion(),
    runningTrack: updateTrackOfVersion(app.getVersion()),
    selectedTrack: hasUpdateFeed ? readSavedUpdateTrack()?.track ?? null : null,
    packageChannel: normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL) ?? "stable",
    platform: process.platform,
    arch: process.arch,
    afterUpdate: process.argv.includes("--updated"),
  });
  // Installing a waiting update as ADE quits, and the hidden launch that lands
  // it (`installOnQuit.ts`). The probe and pool are read only once a quit asks.
  const installOnQuit = createInstallOnQuitController({
    logger: updateLogger,
    updates: autoUpdateService,
    readRuntimeMode: () => localRuntimePool.getStatus().runtimeMode,
    collectImpact: (timeoutMs) => updateImpactProbe.collect(timeoutMs),
    hideWindows: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.hide();
      }
    },
    dock: process.platform === "darwin"
      ? { hide: () => app.dock?.hide(), show: () => void app.dock?.show() }
      : null,
  });
  if (process.platform === "win32" && app.isPackaged) {
    // The update window keeps running until this launch's window is on screen,
    // so its account is read a little later, once it has closed itself.
    setTimeout(() => {
      const report = takeWindowsInstallProgressReport(normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL));
      if (report) updateLogger.info("autoUpdate.install_progress_report", { lines: report });
    }, 30_000).unref();
  }
  remoteUpdateInstaller = createRemoteUpdateInstaller({
    getService: () => autoUpdateService,
    // The same gate as the update checks themselves: a development or channel
    // build has no feed of its own, so the brain updates its standalone runtime.
    supported: hasUpdateFeed,
    // Only a service-managed app uninstalls its service before installing.
    preflightInstall: shouldRepairRuntimeServiceOnFallback ? checkRuntimeServiceRemovable : undefined,
    logger: updateLogger,
  });
  // The brain owns the turn-following lock so it survives this app quitting.
  // This desktop service handles GUI-authorized local OS changes and starts
  // its old in-process blocker only when a connected brain lacks the new action.
  const keepAwakeService = createKeepAwakeService({
    globalStatePath,
    powerSaveBlocker,
    readActiveTurns: async () => (await localRuntimePool.activitySummary()).activeAgentTurns,
    logger: {
      info: (event, data) => updateLogger.info(event, data as Record<string, unknown> | undefined),
      warn: (event, data) => updateLogger.warn(event, data as Record<string, unknown> | undefined),
    },
    productAnalyticsService,
  });
  // Pinned agent tools are fetched, not bundled. The brain kicks its own
  // background fetch on `ade serve`, but the desktop app can be launched
  // against a brain that is already running (or one that failed its fetch), so
  // it kicks its own coalesced pass and owns the UI-facing progress state.
  // Source checkouts resolve the lockfile-pinned tools from node_modules, so
  // the startup pass is packaged-only rather than a dev-loop download; a dev
  // run still downloads the download-only tools (droid, devin, pi, …) on demand.
  const agentToolsCacheService = createAgentToolsCacheService({
    logger: updateLogger,
    productAnalyticsService,
  });
  if (process.env.NODE_ENV !== "test" && process.env.ADE_DISABLE_TOOLS_FETCH !== "1") {
    // Tools this machine shows no sign of using download when something needs them.
    enablePinnedToolFetch(updateLogger, { downloadOnly: !app.isPackaged });
    if (app.isPackaged) {
      void agentToolsCacheService.ensureMissing().catch(() => {
        // Per-tool failures are already recorded on the snapshot and in the log;
        // a rejected kick must never take down app startup.
      });
    }
  }

  // ACP agents ADE runs with a per-launch temp directory of its own (Antigravity
  // unpacks about 1 GB there) delete it on exit; a force-killed ADE leaves it
  // behind. Reclaim the ones whose owning ADE process is gone, off the boot path.
  if (process.env.NODE_ENV !== "test") {
    const scratchSweepTimer = setTimeout(() => {
      void import("./services/chat/acpHost/acpScratchDirs")
        .then(({ startAcpScratchSweepOnce }) => startAcpScratchSweepOnce())
        .catch(() => undefined);
    }, 60_000);
    scratchSweepTimer.unref?.();
  }

  /**
   * Automatic diagnostics: the report nobody was going to press the button for.
   *
   * Built here, ahead of the recovery service and the post-update transaction,
   * because those two are triggers. It owns the Settings toggle, the per-install
   * daily budget (shared on disk with the brain) and the send; every trigger is
   * one call that cannot throw.
   */
  const autoDiagnosticsService = createAutoDiagnosticsService({
    stateFilePath: resolveAutoDiagnosticsStateFile(machineAdeLayout.adeDir),
    appVersion: app.getVersion(),
    logger: localRuntimeLogger,
    capture: (input) => productAnalyticsService.capture(input),
    buildReport: async (request) => {
      const projectRoot = request.projectRoot?.trim() || null;
      const result = await collectDiagnosticReport(
        {
          appVersion: app.getVersion(),
          packageChannel: normalizeAppPackageChannel(process.env.ADE_PACKAGE_CHANNEL),
          isPackaged: app.isPackaged,
          userDataPath: app.getPath("userData"),
          reportsDir: path.join(app.getPath("userData"), "diagnostic-reports"),
          installId: productAnalyticsService.getDistinctId(),
          accountUserId: readAccountOwnerId(),
          getLocalRuntimeStatus: () => localRuntimePool.getStatusAfterServiceProbe(),
          // Deliberately no `diagnoseProject`. The recovery diagnosis is itself
          // one of the triggers, so asking for a fresh one while building the
          // report about it would re-enter the code path that asked for it.
          // The diagnosis that fired this is already in the report's context.
        },
        {
          surface: request.surface,
          headline: request.headline ?? null,
          code: request.code ?? request.failureCode,
          technicalDetail: request.technicalDetail ?? null,
          projectRoot,
          extraNotes: request.extraNotes,
        },
      );
      return { report: result.report, filePath: result.filePath, installId: result.installId };
    },
    // Fast path only. `webContents.send` does not throw when the renderer has
    // crashed or has not mounted its toast host, so nothing here can tell that
    // the user was actually shown anything — which is why the send stays marked
    // pending regardless and only a renderer's acknowledgement retires it. A
    // window that gets both keys the toast on the same id and sees one.
    onSent: (notice) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send(IPC.diagnosticsAutoSent, notice);
        } catch {
          // A window tearing down simply does not get this toast.
        }
      }
    },
  });

  // A project whose database disappears or is swapped while open gets the
  // recovery screen instead of every panel failing.
  const openProjectDataWatch = createOpenProjectDataWatch({
    openRoots: function* () {
      for (const [root, ctx] of projectContexts) if (ctx.project) yield root;
    },
    onChange: (projectRoot, status) => {
      localRuntimeLogger.warn("project.data_moved_while_open", { projectRoot, status });
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send(IPC.recoveryProjectDataMissing, { projectRoot, status });
        } catch {
          // A closing window has nothing to show it in.
        }
      }
    },
  });
  app.on("will-quit", () => openProjectDataWatch.dispose());
  // The one recovery service for this machine. It owns `restartServiceAndWait`,
  // the verified restart sequence behind the Repair button, and the post-update
  // transaction below reuses it rather than growing a second restart path.
  // Sharing the instance also keeps its repair/restart mutual exclusion real.
  const machineRecoveryService = createProjectRecoveryService({
    adeHome: machineAdeLayout.adeDir,
    logger: localRuntimeLogger,
    connectionPool: localRuntimePool,
    openProjectDataProblem: (projectRoot) => openProjectDataWatch.problem(normalizeProjectRoot(projectRoot)),
    closeProject: async (projectRoot) => {
      await closeProjectByPath(projectRoot);
      // After the close, so a tick that was already running cannot put the
      // closed project's identity back.
      openProjectDataWatch.forget(normalizeProjectRoot(projectRoot));
    },
    // One call at the point the diagnosis is final. The service's own budget
    // makes a re-diagnosed screen cost nothing.
    onTerminalDiagnosis: ({ code, projectRoot }) => {
      // `report` is documented never to reject, and the same belt-and-braces
      // catch the update transaction below carries applies here: a rejection
      // from a path that is meant to be silent must not become an unhandled
      // rejection in the main process.
      void autoDiagnosticsService
        .report({
          failureCode: code,
          surface: "project_recovery",
          projectRoot,
        })
        .catch(() => undefined);
    },
  });

  // Moving a project to a new folder (macOS). The move runs here, in the
  // process that owns the windows, because it has to close the project in
  // every window and in the background service, then reopen it at the new
  // location. The engine itself is shared with the CLI.
  const projectMoveController = process.platform === "darwin"
    ? createProjectMoveController({
        logger: localRuntimeLogger,
        getActivity: async (projectRoot) => {
          const root = normalizeProjectRoot(projectRoot);
          const inProcess = shouldUseInProcessProjectRuntime() ? projectContexts.get(root)?.agentChatService ?? null : null;
          const chats = inProcess
            ? runtimeChatRefs(await inProcess.listInterruptedChats())
            : runtimeChatRefs((await localRuntimePool.callActionForRoot(root, { domain: "chat", action: "listInterruptedChats" })).result);
          const sessions = inProcess
            ? []
            : (await localRuntimePool.callActionForRoot(root, { domain: "session", action: "list" })).result;
          return classifyProjectActivity(chats.map((chat) => chat.title), sessions);
        },
        releaseProject: async (projectRoot) => {
          const root = normalizeProjectRoot(projectRoot);
          await closeProjectByPath(root);
          openProjectDataWatch.forget(root);
          const record = new ProjectRegistry().findByRootPath(root);
          if (record) await localRuntimePool.removeProject(root, record.projectId);
        },
        afterMove: async (record, windowId) => {
          writeGlobalState(globalStatePath, remapGlobalStateForMove(readGlobalState(globalStatePath), record, normalizeProjectRoot));
          // Every window that knew the project keeps it, at its new folder.
          for (const roots of [...windowKnownLocalProjectRoots.values(), ...windowProjectTabRoots.values()]) {
            replaceMovedRoots(roots, record, normalizeProjectRoot);
          }
          attemptedProjectRoots.record(record.destinationRoot);
          await ipcWindowScope.run(windowId, () => switchProjectFromDialog(record.destinationRoot));
          // A switch the renderer did not start: tell the window, so its
          // cached binding (and every call it routes) uses the new folder.
          if (windowId != null) bindWindowToProject(windowId, record.destinationRoot, { emit: true });
          persistUpdateWorkspace();
        },
        afterFailedMove: async (sourceRoot, windowId) => {
          if (!fs.existsSync(sourceRoot)) return;
          await ipcWindowScope.run(windowId, () => switchProjectFromDialog(sourceRoot));
          if (windowId != null) bindWindowToProject(windowId, sourceRoot, { emit: true });
        },
        emitProgress: (progress) => broadcast(IPC.projectMoveProgress, progress),
      })
    : null;
  // A move a crash interrupted is settled before the last project reopens
  // (awaited below), so recents point at wherever the project ended up.
  const projectMoveRecovery = (projectMoveController?.recover() ?? Promise.resolve([])).then((settled) => {
    for (const record of settled) {
      if (record.state !== "done") continue;
      writeGlobalState(globalStatePath, remapGlobalStateForMove(readGlobalState(globalStatePath), record, normalizeProjectRoot));
    }
  });
  reportAppFallback = (reason) => {
    void autoDiagnosticsService
      .report({ failureCode: `app_fallback_${reason}`, surface: "local_runtime" })
      .catch(() => undefined);
  };

  const shouldRefreshRuntimeServiceAfterUpdate =
    app.isPackaged
    && process.env.NODE_ENV !== "test"
    && process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL !== "1"
    && autoUpdateService.getSnapshot().recentlyInstalled != null;
  // The person quit ADE and the quit installed this update. When this is the
  // updater's own relaunch, it only finishes the install: the transaction below
  // moves the background service to the new build with no window and no Dock
  // icon, and then ADE closes again (`installOnQuit.ts`). Anything the person
  // does meanwhile shows it.
  if (installOnQuit.beginLaunch({
    refreshingAfterUpdate: shouldRefreshRuntimeServiceAfterUpdate,
    landed: autoUpdateService.landedQuitInstall(),
    platform: process.platform,
    argv: process.argv,
    env: process.env,
    version: app.getVersion(),
    // Read on every packaged Windows launch, so a note never outlives the
    // install it was made during.
    launchRequested: process.platform === "win32" && app.isPackaged && takeWindowsLaunchRequest({
      channel: normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL),
      appVersion: app.getVersion(),
    }),
  })) {
    app.on("activate", () => installOnQuit.reveal("activate"));
    app.on("second-instance", () => installOnQuit.reveal("second_instance"));
    app.on("open-url", () => installOnQuit.reveal("open_url"));
    app.on("open-file", () => installOnQuit.reveal("open_file"));
  }
  if (shouldRefreshRuntimeServiceAfterUpdate) {
    // Applying an update is ONE transaction — app swap, background service
    // reinstalled, service restarted, service answering. Replacing
    // /Applications/ADE.app leaves the old service still running the old code,
    // so this relaunch finishes the job once and says which step failed if one
    // did. Platform-agnostic: both the install and the restart dispatch through
    // the ade-cli service manager, which picks launchd or the Windows
    // per-user service itself.
    const recentlyInstalledVersion =
      autoUpdateService.getSnapshot().recentlyInstalled?.version ?? null;
    // What the service must be answering as once this transaction finishes. The
    // installed version is the fallback for an update that did not name one.
    const expectedRuntimeVersion = recentlyInstalledVersion ?? app.getVersion();
    // The post-relaunch half of the same update. The pool's own repair path
    // would otherwise race these steps: it reinstalls and restarts the service
    // this transaction is already reinstalling and restarting.
    localRuntimePool.beginUpdateWindow("post_update_transaction");
    postUpdateTransactionDone = runUpdateTransaction({
      installedVersion: app.getVersion(),
      expectedVersion: recentlyInstalledVersion,
      reinstallService: async () => {
        // Read who is serving this machine BEFORE the service is replaced. A
        // pre-update brain that outlives the reinstall can only be recognised
        // afterwards if it was seen once beforehand, and this probe is what
        // records it.
        await localRuntimePool.probeMachineRuntimeIdentity().catch(() => null);
        await localRuntimePool.installServiceBestEffort();
        const status = localRuntimePool.getStatus().serviceInstall;
        if (status.state === "installed") {
          markMachineStateMigrationComplete({ layout: machineAdeLayout });
        }
        // "skipped" is a legitimate no-op (a protocol-compatible newer brain is
        // already running); only a real failure is a failed step.
        return {
          ok: status.state !== "failed",
          detail: status.message?.trim() ?? "",
        };
      },
      // The app and the brain move together on an update, so restarting is the
      // default — but a relaunch where the service is ALREADY answering as the
      // new build has nothing to restart, and bouncing it there kills live work
      // for no gain. That skip has to be earned by identity, not by a bare
      // "something answered": the pre-update brain can survive the service
      // reinstall, let a replacement bind the socket, and keep the machine-wide
      // sync lease — which is exactly what a green "restart not needed" hid.
      restartService: () => runVerifiedRuntimeRestart({
        expectedVersion: expectedRuntimeVersion,
        probeIdentity: () => localRuntimePool.probeMachineRuntimeIdentity(),
        restartService: () => machineRecoveryService.restartBrain(),
        readStaleRuntime: () => localRuntimePool.getStaleMismatchedRuntime(),
        // Each restart attempt waits on the socket, so two of them plus the
        // reinstall can outlast the window opened when the transaction began.
        // Re-arming per attempt keeps opportunistic repair out of a restart
        // that is still progressing, and a brain that never answers still
        // lets the window expire.
        onAttemptStart: () => localRuntimePool.beginUpdateWindow("post_update_transaction"),
        log: (event, meta) => updateLogger.info(event, meta),
      }),
      checkHealth: async () => {
        const { identity, verdict } = await checkRuntimeIdentity({
          expectedVersion: expectedRuntimeVersion,
          probeIdentity: () => localRuntimePool.probeMachineRuntimeIdentity(),
          readStaleRuntime: () => localRuntimePool.getStaleMismatchedRuntime(),
        });
        return {
          ok: verdict.matches,
          version: identity?.version ?? null,
          detail: verdict.detail,
        };
      },
    })
      .then((result) => {
        autoUpdateService.setUpdateTransaction(result);
        if (result.ok) {
          updateLogger.info("autoUpdate.transaction_completed", {
            version: result.version,
            steps: result.steps,
          });
          return;
        }
        const failedStep = result.steps.find((step) => step.status === "failed")?.id ?? null;
        updateLogger.error("autoUpdate.transaction_failed", {
          version: result.version,
          failedStep,
          failureMessage: result.failureMessage,
          steps: result.steps,
        });
        // An update that half-landed is the failure people least often report
        // and the one hardest to reconstruct afterwards.
        if (failedStep) {
          void autoDiagnosticsService
            .report({
              failureCode: `update_${failedStep}`,
              surface: "update_transaction",
            })
            .catch(() => undefined);
        }
      })
      .catch((error) => {
        // runUpdateTransaction never rejects; this only guards a broken
        // listener so a bad update notice can never take down startup.
        updateLogger.warn("autoUpdate.transaction_publish_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        localRuntimePool.endUpdateWindow("post_update_transaction");
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
    // but the db is gitignored and machine-local. A missing db, or a scaffold
    // first-open marker, means this machine has not finished a real bind yet.
    assertLocalProjectDataAvailable(projectRoot);
    const hadAdeDir = fs.existsSync(path.join(projectRoot, ".ade", "ade.db"));
    const scaffoldedFirstOpen = consumeFirstOpenStabilityMarker(projectRoot);
    const adePaths = ensureAdeDirs(projectRoot);
    const logger = createFileLogger(path.join(adePaths.logsDir, "main.jsonl"));
    registerAccountConfigProjectRoot(projectRoot);
    const accountAuthService = getSharedAccountAuthService({
      projectRoots: () => [projectRoot],
      logger,
    });
    initApiKeyStore(projectRoot, {
      credentialStore: createDesktopCredentialStore(machineAdeLayout.secretsDir),
      getAccountVault: () => accountVaultBridge,
      getAccountUserId: () => accountAuthService.getStatus().userId,
      logger,
      analytics: productAnalyticsService,
    });
    const getAccountAccessToken = () => getSignedInAccountAccessToken(accountAuthService);
    const diskPressureMonitor = createDiskPressureMonitor({
      roots: [projectRoot, machineAdeLayout.adeDir],
      logger,
    });
    const packagedFirstOpenStabilityMode =
      app.isPackaged
      && (!hadAdeDir || scaffoldedFirstOpen)
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

    let syncServiceRef: ReturnType<typeof createSyncService> | null = null;
    const hasSyncPeers = createRegisteredSyncPeerGate({
      syncEnabled: true,
      getSyncService: () => syncServiceRef,
    });
    const db = await measureProjectInitStep("db_open", () =>
      openKvDb(adePaths.dbPath, logger, {
        hasSyncPeers,
        appVersion: shippedVersionOrNull(app.getVersion()),
      }),
    );
    recordLocalProjectDatabaseIdentity(projectRoot, logger);
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
    installAdeCliForTerminalInBackground(adeCliService, globalStatePath);
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
    let conflictServiceRef: ReturnType<typeof createConflictService> | null =
      null;
    let prServiceRef: ReturnType<typeof createPrService> | null = null;
    const searchServiceHolder: { current: SearchService | null } = { current: null };
    let prPollingServiceRef: ReturnType<typeof createPrPollingService> | null =
      null;
    let automationIngressServiceRef: ReturnType<typeof createAutomationIngressService> | null =
      null;
    let testServiceRef: ReturnType<typeof createTestService> | null = null;
    let laneServiceRef: ReturnType<typeof createLaneService> | null = null;
    let gitServiceRef: ReturnType<typeof createGitOperationsService> | null =
      null;
    let linearIssueTrackerRef: LinearIssueTracker | null = null;
    let linearLiveStatusServiceRef: LinearLiveStatusService | null = null;
    const linearLiveStatusLaunchKeys = new Set<string>();
    const publishLinearChatCard = createLinearChatLinkPublisher({
      getIssueTracker: () => linearIssueTrackerRef,
      resolveEnvelope: async ({ laneId }) => {
        const repo = await githubService.getRepoOrThrow().catch(() => null);
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

      const pr = prServiceRef?.getForLane(laneId);
      if (pr) {
        prServiceRef?.markHotRefresh([pr.id]);
      }
    };

    const laneTeardownDeps: LaneDeleteTeardownDeps = {};
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
      onLifecycleEvent: (event) => {
        emitProjectEvent(projectRoot, IPC.lanesLifecycleEvent, event);
        if (event.laneId) searchServiceHolder.current?.notifyLaneActivity(event.laneId);
      },
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
    await measureProjectInitStep("lane.ensure_primary", () =>
      laneService.ensurePrimaryLane(),
    );

    const laneWorktreeLockService = createLaneWorktreeLockService({
      db,
      logger,
    });
    laneWorktreeLockService.sweepExpired();

    // Late-bound: the chat service that owns the work does not exist yet at
    // this point, and the settle path must not depend on construction order.
    const lateSettle = createLateBoundSettle();
    const sessionService = createSessionService({
      db,
      logger,
      checkSettle: lateSettle.checkSettle,
      onRemoteSettleWrite: lateSettle.onRemoteSettleWrite,
      listSubagentLinks: lateSettle.listSubagentLinks,
      // Read at call time: the automation service is built later.
      onChatSettled: (chat) => automationService?.onSessionSettled(chat),
    });
    sessionService.onChanged((event) => {
      emitProjectEvent(projectRoot, IPC.sessionsChanged, event);
    });
    // Inbound settle-tuple writes go through the chokepoint instead of landing
    // raw, so a peer's decision gains this host's revision, settling window and
    // abort semantics (R7). Registered here because the DB layer must not know
    // what a settle means.
    db.sync.setRemoteSettleTupleHandler((changes) => {
      sessionService.reconcileRemoteSettleTuple(changes);
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
      STALE_RUNNING_SESSION_RESCAN_DELAY_MS,
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
    const projectSecretService = createProjectSecretService(projectRoot, {
      getAccountVault: () => accountVaultBridge,
      getAccountUserId: () => accountAuthService.getStatus().userId,
      logger,
    });

    const laneEnvironmentService = createLaneEnvironmentService({
      projectRoot,
      adeDir: adePaths.adeDir,
      logger,
      broadcastEvent: (ev) =>
        emitProjectEvent(projectRoot, IPC.lanesEnvEvent, ev),
      // Setup scripts run unrestricted shell and can come from repo-committed
      // shared config, so the executor gets the same trust gate test suites use.
    });

    // The in-process host has no account store: new-lane settings stay in a
    // file in this project's `.ade` folder (the brain files them under the
    // account).
    const newLaneSettings = createProjectNewLaneSettings({
      projectRoot,
      adeDir: adePaths.adeDir,
      projectConfigService,
      logger,
      readOriginUrl: () => readGitOriginUrl(projectRoot),
    });
    const laneTemplateService = createLaneTemplateService({
      projectConfigService,
      logger,
      newLaneSettings,
    });
    laneService.setNewLaneSettingsStore(newLaneSettings, {
      validateTemplateId: (templateId) => {
        if (!laneTemplateService.getTemplate(templateId)) throw new Error(`Unknown lane template: ${templateId}`);
      },
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
      modelManifest: { adeVersion: app.getVersion(), fetchRemote: true },
    });

    const onboardingService = createOnboardingService({
      db,
      logger,
      projectRoot,
      projectId,
      freshProject: !hadAdeDir,
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

    let githubRelaySecretService: ReturnType<typeof createAutomationSecretService> | null = null;
    const githubService = createGithubService({
      logger,
      projectRoot,
      appDataDir: app.getPath("userData"),
      credentialStore: createDesktopCredentialStore(machineAdeLayout.secretsDir),
      githubRelaySecretReader: (ref) => githubRelaySecretService?.getSecret(ref) ?? null,
      getAccountAccessToken,
      // A repaired or removed App credential ends the relay's auth-pending
      // cooldown at once. Wired here rather than inside either service: the
      // ingress loop must stay free of GitHub internals, and only this owner
      // holds both of them.
      onAppUserAuthChanged: () => {
        void automationIngressServiceRef?.pollNow().catch(() => undefined);
      },
    });

    const projectScaffoldService = createProjectScaffoldService({
      logger,
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
      projectConfigService,
      conflictService,
      getLinearIssueTracker: () => linearIssueTrackerRef,
      getLinearLiveStatusService: () => linearLiveStatusServiceRef,
      onHotRefreshChanged: () => {
        prPollingServiceRef?.poke();
      },
      openExternal: openExternalUrl,
    });
    prServiceRef = prService;
    let agentChatServiceRef: ReturnType<typeof createAgentChatService> | null =
      null;
    let prWatchServiceRef: ReturnType<typeof createPrWatchService> | null = null;
    let terminalWatchServiceRef: ReturnType<typeof createTerminalWatchService> | null = null;

    const rpcEventBuffer = createEventBuffer();
    const emitPrEvent = (event: PrEventPayload): void => {
      emitProjectEvent(projectRoot, IPC.prsEvent, event);
      rpcEventBuffer.push({
        timestamp: new Date().toISOString(),
        category: "runtime",
        payload: { type: "pr_event", event },
      });
      if (event.type === "prs-updated") {
        for (const pr of event.prs) searchServiceHolder.current?.notifyPrChanged(pr.id);
      }
    };

    // Wire auto-map-by-branch: the PR service emits Undo-able toasts through the
    // PR event channel, and a freshly created worktree lane triggers a
    // best-effort auto-map of any existing open PR on its branch (Trigger #1).
    prService.setEventEmitter((event) => {
      emitPrEvent(event);
      prWatchServiceRef?.onPrEvent(event);
    });
    laneService.setOnWorktreeLaneCreated((lane) => {
      void prService.tryAutoMapLaneByBranch(lane.id);
    });
    laneService.setOnBranchHistoryObserved((args) => {
      void prService.autoLinkLaneBranchHistory(args);
    });

    let prMergeAutoSettlementServiceRef: ReturnType<typeof createPrMergeAutoSettlementService> | null = null;
    const prPollingService = createPrPollingService({
      logger,
      prService,
      projectConfigService,
      db,
      isGithubRelayHealthy: () => automationIngressServiceRef?.isGithubRelayHealthy() === true,
      getGithubBackgroundPauseUntilMs: () => githubService.getBackgroundRequestPauseUntilMs(),
      onEvent: emitPrEvent,
      onPullRequestsSnapshot: (snapshot) =>
        prMergeAutoSettlementServiceRef?.processSnapshot(snapshot),
      onPullRequestsChanged: async ({ prs, changedPrs, changes }) => {
        if (changedPrs.length > 0) {
          // Poll results must not start another hot-refresh window; doing so
          // turns active CI into an unbounded high-frequency GitHub API loop.
          for (const pr of changedPrs) searchServiceHolder.current?.notifyPrChanged(pr.id);
        }
        await Promise.all(
          changes.map(
            ({
              pr,
              previousState,
              previousChecksStatus,
              previousReviewStatus,
              checksFailureAnnounced,
              prChanged,
            }) => {
              automationService?.onPullRequestChanged?.({
                pr,
                previousState,
                previousChecksStatus,
                previousReviewStatus,
                checksFailureAnnounced,
                prChanged,
              });
              return Promise.resolve();
            },
          ),
        );
        const chatService = agentChatServiceRef;
        prWatchServiceRef?.onPullRequestsChanged(changes.map((change) => change.pr.id));
        if (chatService) {
          await Promise.all(changes.map(async (change) => {
            try {
              await emitPrCardsForChange({
                change,
                dataSource: prService,
                chat: chatService,
                relatedPrs: prs,
              });
            } catch (error) {
              logger.warn("prs.chat_card_emit_failed", {
                prId: change.pr.id,
                laneId: change.pr.laneId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }));
        }
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
    };

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
      runtimeSocketPath: machineAdeLayout.socketPath,
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
        searchServiceHolder.current?.notifyTerminalData(ev.sessionId);
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
      diskPressureMonitor,
      appVersion: app.getVersion(),
      terminalShellPreferences: terminalShellPreferenceStoreFor(resolveMachineAdeDir(), logger),
      loadPty,
      disposePtyBackend: ptyBackend?.dispose,
    });

    // Wire teardown deps for laneService.delete now that the underlying services exist.
    laneTeardownDeps.ptyService = {
      countActiveForLane: (laneId) => ptyService.countActiveForLane(laneId),
      disposeForLane: (laneId) => ptyService.disposeForLane(laneId),
    };
    laneTeardownDeps.fileWatcherService = {
      countActiveForWorkspace: (id) => fileService.countActiveWatchersForWorkspace(id),
      stopAllForWorkspace: (id) => fileService.stopAllWatchersForWorkspace(id),
    };
    laneTeardownDeps.sessionService = sessionService;
    // Lanes archived before archive took their chats along keep those chats
    // visible under an "Archived lane" header; archive them once per project.
    try {
      const archivedSessionCount = sessionService.archiveSessionsOfArchivedLanes();
      if (archivedSessionCount > 0) {
        logger.info("lane.archive.sessions_backfilled", { archivedSessionCount });
      }
    } catch (error) {
      logger.warn("lane.archive.sessions_backfill_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const sessionDeltaService = createSessionDeltaService({
      db,
      projectId,
      laneService,
      sessionService,
    });
    sessionDeltaServiceRef = sessionDeltaService;

    const ctoMemoryService = createCtoMemoryService({
      adeDir: adePaths.adeDir,
      logger,
    });

    const ctoStateService = createCtoStateService({
      db,
      projectId,
      adeDir: adePaths.adeDir,
      ctoMemoryService,
      // Resolved on every refresh, not captured here: the chat service does not
      // exist yet at this point in boot, and the live block must not be pinned
      // to whatever was null when the CTO service was constructed.
      getLiveStateSources: () => {
        const chat = agentChatServiceRef;
        if (!chat) return null;
        return {
          laneService,
          prService: prServiceRef,
          automationService,
          listChats: chat.listSessions,
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

    const automationSecretService = createAutomationSecretService({
      adeDir: adePaths.adeDir,
      logger,
    });
    githubRelaySecretService = automationSecretService;

    const linearCredentialStore = createDesktopCredentialStore(path.join(adePaths.adeDir, "secrets"));
    const linearCredentialService = createLinearCredentialService({
      adeDir: adePaths.adeDir,
      logger,
      credentialStore: linearCredentialStore,
      getAccountVault: () => accountVaultBridge,
      getAccountUserId: () => accountAuthService.getStatus().userId,
      getDeviceId: () => {
        try {
          return fs.readFileSync(
            path.join(machineAdeLayout.secretsDir, "sync-device-id"),
            "utf8",
          ).trim() || null;
        } catch {
          return null;
        }
      },
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

    /**
     * An OS notification about one chat that opens it on click. Skipped while
     * any ADE window is focused: there is no per-window "which chat is open"
     * signal in main, and the chat's own transcript already says what happened.
     */
    const showChatOsNotification = (args: {
      sessionId: string;
      title: string;
      body: string;
      source: string;
      failureEvent: string;
    }): void => {
      if (!Notification.isSupported()) return;
      if (BrowserWindow.getFocusedWindow()) return;
      try {
        const notification = new Notification({ title: args.title, body: args.body });
        // Clicking it opens the chat, through the same protocol dispatcher
        // an `ade://` click from outside the app goes through.
        notification.on("click", () => {
          handleDeeplinkUrl(
            buildDeeplink({ kind: "session", sessionId: args.sessionId }, { form: "ade" }),
            args.source,
            (request) => {
              if (dispatchAppNavigationForProjectRoot) {
                dispatchAppNavigationForProjectRoot(projectRoot, request);
                return;
              }
              dispatchOrQueueAppNavigationRequest(request);
            },
            (event, fields) => logger.warn(event, fields),
          );
        });
        notification.show();
      } catch (error) {
        logger.warn(args.failureEvent, {
          sessionId: args.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const agentChatService = createAgentChatService({
      museQuota,
      // One value per machine (in-process runtimes in dev share this machine's).
      readContinueAfterRestart: () => resolveContinueAfterRestart(),
      // A lane a batch move imported here gets the same setup a new lane
      // does: the default lane template, else the project's lane env config.
      runCrossMachineLaneSetup: async (laneId) => {
        await runDefaultLaneEnvironmentSetup(
          { laneService, projectConfigService, portAllocationService, laneEnvironmentService, laneTemplateService },
          laneId,
        );
      },
      // This host's account machine key, so a scheduled send that names a
      // machine can be matched to it. Resolved lazily and defensively: the
      // bridge may not exist yet at construction time, and a null simply means
      // this runtime owns only machine-agnostic sends.
      getLocalMachineKey: () => {
        try {
          return ipcBridge?.getLocalMachineIdentity?.().machineKey ?? null;
        } catch {
          return null;
        }
      },
      machineAdeHome: machineAdeLayout.adeDir,
      resolveMcpAuthToken,
      runtimeBudget: chatRuntimeBudget,
      projectRoot,
      analytics: productAnalyticsService,
      runtimeSocketPath: machineAdeLayout.socketPath,
      transcriptsDir: adePaths.transcriptsDir,
      fileService,
      linearIssueTracker,
      githubService,
      getSearchService: () => searchServiceHolder.current,
      prService,
      diskPressureMonitor,
      // Electron's `suspend` fires a beat BEFORE the machine goes down, which
      // is the only moment a turn in flight can still be told why it is about
      // to stall.
      hostPowerSource: getPowerStateService(),
      // Machine-wide, not per-project: "Don't ask again" on Claude's
      // resume-return dialog is a decision about this person's habits, and
      // asking again in the next project would read as the setting not working.
      claudeResumeDialogPreference: {
        isDismissed: () => readGlobalState(globalStatePath).claudeResumeReturnDismissed === true,
        markDismissed: () => {
          const state = readGlobalState(globalStatePath);
          if (state.claudeResumeReturnDismissed === true) return;
          writeGlobalState(globalStatePath, { ...state, claudeResumeReturnDismissed: true });
        },
      },
      getTestService: () => testServiceRef,
      getTerminalWatchService: () => terminalWatchServiceRef,
      ptyService,
      getAutomationService: () => automationService,
      getAccountUsage: () => usageTrackingService,
      // The CTO's domain coverage. All lazy — several of these are created
      // later in this same bootstrap, and the CTO's tool map is only built when
      // a CTO session actually runs.
      getAutomationPlannerService: () => automationPlannerService,
      getUsageService: () => usageTrackingService,
      getBudgetService: () => budgetCapService,
      // Names and metadata only. `projectSecretService.get`/`exportEnv` are
      // deliberately NOT reachable from any CTO tool.
      getProjectSecretService: () => ({ list: () => projectSecretService.list() }),
      getIosSimulatorService: () => iosSimulatorService,
      // Lazy like the rest: `macDesktopService` is constructed further down
      // this same bootstrap, and every call here is read per-turn.
      macDesktopRuntime: {
        hasDisplaySync: (laneId) => macDesktopService.hasDisplaySync(laneId),
        supportsLaneDisplaySync: () => macDesktopService.supportsLaneDisplaySync(),
      },
      getAppControlService: () => appControlService,
      getBuiltInBrowserService: () => builtInBrowserService,
      getGitService: () => gitServiceRef,
      conflictService,
      laneService,
      sessionService,
      processRegistry,
      projectConfigService,
      db,
      aiIntegrationService,
      ctoStateService,
      ctoMemoryService,
      logger,
      appVersion: app.getVersion(),
      getAdeCliAgentEnv: adeCliService.agentEnv,
      getLocalGitHubToken: () => githubService.getGitTransportTokenOrThrowAsync(),
      onLinearIssueChatLinked: publishLinearChatLink,
      onEvent: (event) => {
        feedDemoTrackFromChatEvent(event);
        emitProjectEvent(projectRoot, IPC.agentChatEvent, event);
      },
      onTurnSettled: (event) => captureAgentTurnSettledAnalytics({
        analytics: productAnalyticsService,
        projectId,
        event,
      }),
      requestSessionAttention: (request) =>
        requestSessionAttentionForRuntime(buildAdeActionRuntimeForAutomations(), request),
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
      // `@mac:` mentions on the in-process path. Activity (projects, lanes,
      // chats) is brain-owned and not readable here, so the snapshot reports
      // it as unavailable rather than guessing.
      accountMachineMentions: {
        listAccountMachines: () => ipcBridge
          ? ipcBridge.listAccountMachines()
          : Promise.resolve({ state: "unavailable" as const, machines: [], message: null }),
        getLocalMachineKey: () => ipcBridge?.getLocalMachineIdentity().machineKey ?? null,
      },
      onCompactionOutcome: (event) => captureChatCompactionAnalytics({
        analytics: productAnalyticsService,
        projectId,
        event,
      }),
      onChatHandoffReplay: (event) => captureChatHandoffReplayAnalytics({
        analytics: productAnalyticsService,
        projectId,
        event,
      }),
      onSideChatOutcome: (event) => captureChatSideChatAnalytics({
        analytics: productAnalyticsService,
        projectId,
        event,
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
      onUsageLimitAutoResumed: ({ sessionId, title }) => {
        showChatOsNotification({
          sessionId,
          title: "Chat resumed",
          body: title?.trim()
            ? `"${title.trim()}" continued after its usage limit reset.`
            : "A chat continued after its usage limit reset.",
          source: "notification:usage_limit_resume",
          failureEvent: "agent_chat.usage_limit_resume_notification_failed",
        });
      },
      onGoalEnded: ({ sessionId, title, objective, outcome }) => {
        showChatOsNotification({
          sessionId,
          title: outcome === "reached" ? "Goal reached" : "Goal blocked",
          body: `${title ? `"${title}": ` : ""}${objective}`,
          source: "notification:goal_ended",
          failureEvent: "agent_chat.goal_ended_notification_failed",
        });
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
    const prShellLinkWatcher = createPrShellLinkWatcher({
      logger,
      subscribeToEvents: (callback) => agentChatService.subscribeToEvents(callback),
      linkShellPrAction: (args) => prService.linkShellPrAction(args),
      // The broker is built further down; the closure reads it once a chat
      // command arrives, long after startup.
      repairShellPrBody: (args) => shellPrBodyRepairVia({ prService, proof: computerUseArtifactBrokerService })(args),
    });
    prShellLinkWatcher.start();
    prWatchServiceRef = createPrWatchService({
      logger,
      prService,
      sessionService,
      messageSession: (args) => agentChatService.messageSession(args),
      isChatMovedAway: (sessionId) => Boolean(agentChatService.getCrossMachineMoveLock(sessionId, "pr_watch")),
      emitPrEvent,
      getGithubBackgroundPauseUntilMs: () => githubService.getBackgroundRequestPauseUntilMs(),
    });
    terminalWatchServiceRef = createTerminalWatchService({
      logger,
      ptyService,
      sessionService,
      messageSession: (args) => agentChatService.messageSession(args),
      getChatLiveness: chatLivenessReader(agentChatService),
      isChatMovedAway: (sessionId) => Boolean(agentChatService.getCrossMachineMoveLock(sessionId, "terminal_watch")),
    });
    prMergeAutoSettlementServiceRef = createPrMergeAutoSettlementService({
      db,
      projectId,
      sessionService,
      emitEvent: emitPrEvent,
      logger,
      getChatLiveness: chatLivenessReader(agentChatService),
    });
    laneTeardownDeps.agentChatService = {
      countActiveForLane: (laneId) => agentChatService.countActiveForLane(laneId),
      disposeForLane: (laneId) => agentChatService.disposeForLane(laneId),
    };
    lateSettle.bind(createSettleWiring({
      agentChatService,
      logger,
      analytics: productAnalyticsService ?? null,
      surface: "desktop",
    }));
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
        prService,
        onEvent: (event) =>
          emitProjectEvent(projectRoot, IPC.automationsEvent, event),
      });
    }
    // Constructed even when automations are unavailable (packaged builds):
    // the relay poll feeds prService.ingestGithubWebhook for PR freshness,
    // while automation rule dispatch stays gated on automationService.
    const automationIngressService = createAutomationIngressService({
      logger,
      automationService: automationService ?? null,
      prService,
      // Webhook-driven PR changes poke the poller so `prs-updated` reaches the
      // renderer now instead of on the next scheduled tick.
      onPrStateIngested: (prIds) => prPollingServiceRef?.reconcilePrs(prIds),
      secretService: automationSecretService,
      githubService,
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
      // 30s halves worst-case webhook latency. Each poll is one request to
      // our own relay worker (no GitHub data cost); the service floors at 30s.
      pollIntervalMs: 30_000,
    });
    automationIngressServiceRef = automationIngressService;

    const githubPollingService = automationService
      ? createGithubPollingService({
          logger,
          githubService,
          automationService,
          hasEnabledGithubRules: () => automationService?.hasEnabledGithubRules() ?? false,
        })
      : null;

    const linearIngressService = automationService
      ? createLinearIngressService({
          db,
          projectId,
          credentialStore: linearCredentialStore,
          getLinearClient: () => linearClient,
          getLinearAccessToken: createLinearAccessTokenGetter(linearCredentialService),
          getAccountAccessToken,
          cursorStore: createKvIngressCursorStore(db),
          hasEnabledLinearRules: () => automationService?.hasEnabledLinearRules() ?? false,
          isAdeAppConnection: () =>
            linearCredentialService.getStatus().authMode === "oauth"
            && linearCredentialService.getOAuthClientSource() === "ade-app",
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
        await agentChatService.handleCursorCloudStatusChange(record).catch((error) => {
          logger.warn("agent_chat.cursor_cloud_status_change_failed", {
            eventId: record.eventId,
            agentId: record.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        emitProjectEvent(projectRoot, IPC.aiCursorCloudFleetEvent, {
          agentId: record.agentId,
          status: record.status,
          summary: record.summary,
          branchName: record.branchName,
          prUrl: record.prUrl,
          eventId: record.eventId,
          createdAt: record.createdAt,
        });
        cursorCloudFleetService?.invalidateCache();
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
      openCursorCloudChat: (args) => agentChatService.openCursorCloudChat(args),
      cancelCursorCloudRun: (args) => agentChatService.cancelCursorCloudRun(args),
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
      getAgentChatService: () => agentChatService,
      cursorFleet: cursorCloudFleetService,
      archiveCursorAgent: (agentId) => aiIntegrationService.archiveCursorCloudAgent(agentId),
      unarchiveCursorAgent: (agentId) => aiIntegrationService.unarchiveCursorCloudAgent(agentId),
      cursorCreateRun: (args) => aiIntegrationService.createCursorCloudRun({ ...args, workOnCurrentBranch: true }),
      resolveDevinBinary: resolveDevinCloudBinary,
    });
    automationService?.setCursorCloudIngressAvailable(() => {
      // Unconfigured counts as available: enabling the first cursor.* rule is
      // what starts the self-configuring poll, so gating on "ready" would make
      // that first rule impossible to enable.
      const status = cursorCloudIngressService.getStatus();
      return status.state !== "error" || Boolean(status.webhookId);
    });

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

    const computerUseArtifactBrokerService =
      createComputerUseArtifactBrokerService({
        db,
        projectId,
        projectRoot,
        additionalAllowedImportRoots: [path.join(app.getPath("userData"), "browser-observations")],
        logger,
        onEvent: (payload) =>
          emitProjectEvent(projectRoot, IPC.computerUseEvent, payload),
      });
    agentChatService.setComputerUseArtifactBrokerService(
      computerUseArtifactBrokerService,
    );
    // The broker judges an attached video against the chat's turn start.
    computerUseArtifactBrokerService.setChatTurnStartResolver(
      (sessionId) => agentChatService.getTurnStartedAt(sessionId),
    );
    computerUseArtifactBrokerService.setChatTurnIdResolver(
      (sessionId) => agentChatService.getTurnId(sessionId),
    );

    // Backfill starts well past the boot window so index writes never compete
    // with project startup.
    const searchService = createProjectSearchService({
      cacheDir: adePaths.cacheDir,
      transcriptsDir: adePaths.transcriptsDir,
      chatTranscriptsDir: adePaths.chatTranscriptsDir,
      logger,
      sessionService,
      laneService,
      agentChatService,
      prService,
      gitService,
      repoSlug: async () => {
        const status = await githubService.getRemoteStatus().catch(() => ({ repo: null }));
        return status.repo ?? null;
      },
      fileService,
      artifactBroker: computerUseArtifactBrokerService,
      linearIssueTracker,
      backfillDelayMs: 10_000,
    });
    searchServiceHolder.current = searchService;
    const externalSessionsService = createExternalSessionsService({
      projectRoot,
      laneService,
      sessionService,
      ptyService,
      logger,
      chatImporter: agentChatService,
      chatImportedRefsProvider: chatImportedRefsProvider(agentChatService),
      chatSessionsDir: resolveAdeLayout(projectRoot).chatSessionsDir,
      homeDir: os.homedir(),
      env: process.env,
      onImportOutcome: ({ provider, target, mode, outcome }) => captureSessionImportAnalytics({
        analytics: productAnalyticsService,
        surface: "desktop",
        target,
        mode,
        outcome,
        provider,
      }),
    });
    const iosSimulatorService = createIosSimulatorService({
      projectRoot,
      logger,
      captureAnalytics: (outcome) => captureAppleDeviceAnalytics({ analytics: productAnalyticsService, outcome }),
      // Lane-scoped calls build the lane's worktree, not the primary checkout.
      resolveLaneWorktreePath: (laneId: string): string | null => {
        try {
          return laneService.getLaneWorktreePath(laneId);
        } catch {
          return null;
        }
      },
      // The reverse, so a caller that names no lane is placed by the worktree
      // it is standing in rather than by whichever lane happens to be busy.
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
      // The recording halves that live outside the simulator service. Overlay
      // switches are account-synced and reach the main process only through
      // the renderer today, so the recorder's own defaults (both ON) stand
      // until a main-process reader exists; the proof-drawer broker is real.
      recordingDeps: { artifactFiler: computerUseArtifactBrokerService },
      onEvent: (payload) =>
        emitProjectEvent(projectRoot, IPC.iosSimulatorEvent, payload),
      // Lane-device cleanup and idle power-off for this project.
      backgroundMaintenance: true,
    });
    // An archived or deleted lane lets go of its Apple device session here;
    // the device itself goes in `releaseLaneAppleDevice`.
    laneTeardownDeps.iosSimulatorService = {
      stopForLane: (laneId: string) => iosSimulatorService.stopForLane(laneId),
    };
    /**
     * Brain-side video forwarder for this embedded host.
     *
     * The daemon brain wires the same relay from `bootstrap.ts`; this is the
     * desktop-embedded sync host, which serves the same `apple.*` commands to a
     * phone or a web tab when the desktop is the one hosting. Without an
     * account settings store here the remote cap is the shipped default.
     */
    const appleStreamRelay = createAppleStreamRelayForService({
      service: iosSimulatorService,
      remoteBitrateKbpsCap: () => DEFAULT_APPLE_REMOTE_BITRATE_KBPS,
      // This host has a renderer, so the last phone or web viewer leaving must
      // not stop a capture the Apple column is still showing. Ask both the
      // main-process registry (direct IPC starts) and the service's own tracker
      // (runtime-action starts, which never reach the IPC handler).
      hasLocalViewer: (laneId) =>
        hasAppleLocalViewer(laneId) || (iosSimulatorService.hasLocalViewer?.(laneId) ?? false),
      logger,
    });
    const detachAppleStreamRoute = setActiveAppleStreamRouter(appleStreamRelay);
    app.on("will-quit", () => {
      detachAppleStreamRoute();
      appleStreamRelay.dispose();
    });
    agentChatService.registerChatSessionEndedListener((sessionId) => {
      void iosSimulatorService.releaseIfOwnedBy(sessionId).catch((error) => {
        logger.debug("ios_simulator.release_on_chat_end_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    /**
     * The lane's private macOS screen.
     *
     * Constructed on EVERY platform, next to the simulator and for the same
     * reason: `getStatus` answers everywhere and says `supported: false` off
     * macOS, which is how a Windows or Linux desktop hides the tab by reading
     * rather than by catching a throw. A service that only existed on darwin
     * would make that read itself the error.
     *
     * `onEvent` is the half the renderer's local event fan-out depends on: the
     * service's own `subscribe` is for in-process readers constructed after it
     * (the Work tools mirror), while this is what reaches a window.
     */
    const macDesktopLogger = createMacDesktopLogger(logger, getMachineMainLogger());
    const macDesktopService = createMacDesktopService({
      projectRoot,
      // Also `desktop-main.jsonl`: see `macDesktopLogger.ts`.
      logger: macDesktopLogger,
      // Windows hosts reuse the whole seat service; only the helper, the
      // provider, and the permission story differ. Every other host keeps the
      // Mac adapter (and its unchanged macOS behavior).
      seat: process.platform === "win32"
        ? createWindowsDesktopSeatAdapter({
          logger: macDesktopLogger,
          adeHome: process.env.ADE_HOME?.trim() || path.join(os.homedir(), ".ade"),
        })
        : process.platform === "linux"
          ? createLinuxDesktopSeatAdapter({
            logger: macDesktopLogger,
            adeHome: process.env.ADE_HOME?.trim() || path.join(os.homedir(), ".ade"),
          })
          : null,
      adeHome: process.env.ADE_HOME?.trim() || null,
      // `ade-media` on macOS; this desktop's Chromium engine everywhere, which
      // is what turns a Windows lane's MP4 recording into its demo.
      demoEngines: createDemoEngineSet({
        logger: macDesktopLogger,
        getChromiumDemoEngine: () => chromiumDemoEngine,
      }),
      onEvent: (payload) => emitProjectEvent(projectRoot, IPC.macDesktopEvent, payload),
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
      // The lane's primary pull request becomes a `github_pr` proof owner with
      // the existing `published_to` relation, as the browser and simulator
      // proof paths already do.
      resolvePrimaryPrUrl: (laneId: string): string | null =>
        prService?.getForLane(laneId)?.githubUrl ?? null,
      ingestArtifacts: (request) => computerUseArtifactBrokerService.ingest(request),
      // A lane may not claim another lane's App Control app. Read at call
      // time: the App Control service is built just below.
      appControlLaneForProcess: (pid: number) => appControlService.laneForAppProcess(pid),
      // The real-input lease question rides the normal pending-input card, the
      // same one `ade chat ask` and MCP elicitation resolve through.
      requestChatInput: (input) => agentChatService.requestChatInput(input),
      readSetting: <T,>(key: string): T | null => db.getJson<T>(key),
      writeSetting: (key: string, value: unknown) => db.setJson(key, value),
      captureAnalytics: (properties) => captureMacDesktopAnalytics({
        analytics: productAnalyticsService,
        properties,
      }),
    });
    // Runs on every platform: off macOS `destroyForLane` is a no-op, so the
    // teardown step never has to know what host it is on. Without this wiring a
    // deleted lane left its display, its parked windows and its encoder behind
    // on the desktop host — the CLI brain has had it since the feature landed.
    laneTeardownDeps.macDesktopService = {
      destroyForLane: (laneId: string) => macDesktopService.destroyForLane(laneId),
    };
    // A chat that ends drops its lease on every platform — the one Mac Desktop
    // call that is not macOS-only, because a lease must never outlive its chat.
    agentChatService.registerChatSessionEndedListener((sessionId) => {
      void macDesktopService.releaseIfOwnedBy(sessionId).catch((error) => {
        logger.debug("mac_desktop.release_on_chat_end_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    // `drawer-open-requested` is emitted by the service itself, not wrapped on
    // here: production launches go to the brain daemon, which has no wrapper, so
    // a wrapper-only emitter made `--open-drawer` and an agent's inspect/select
    // reveal inert on the path agents actually use. Both hosts feed the same
    // renderer subscriber, so wrapping here as well would double-open.
    const appControlService = createAppControlService({
      projectRoot,
      logger,
      ptyService,
      // No fallback lane: a session whose lane cannot be resolved is refused.
      resolveLaneId: ({ cwd, laneId, chatSessionId }) => resolveSessionLaneId({
        laneId,
        chatSessionId,
        cwd,
        getChatLaneId: async (chatId) => {
            const chatSession = await agentChatService.getSessionSummary(chatId).catch(() => null);
            return chatSession?.laneId ?? null;
          },
        isLiveLane: (id) => laneService.findLaneIdentity(id) !== null,
        laneIdForPath: (absolutePath) => laneService.getLaneIdForPath(absolutePath),
        isPrimaryLane: async (id) => (await laneService.getSummary(id, { includeStatus: false }))?.laneType === "primary",
      }),
      resolveChatLaneId: async (chatId) => {
        const chatSession = await agentChatService.getSessionSummary(chatId).catch(() => null);
        return chatSession?.laneId ?? null;
      },
      resolveLaneWorktreePath: async (laneId) =>
        (await laneService.getSummary(laneId, { includeStatus: false }).catch(() => null))?.worktreePath ?? null,
      onEvent: (payload) => {
        if (payload.type === "session-started") {
          captureAppControlAnalytics({ analytics: productAnalyticsService, outcome: "started" });
        }
        emitProjectEvent(
          projectRoot,
          IPC.appControlEvent,
          payload,
          payload.type === "frame"
            ? (webContents) => shouldSendAppControlFrameToWebContents(
              webContents,
              appControlFrameEventLaneId(payload),
            )
            : undefined,
        );
      },
      // Recording: macOS records the app's window with the desktop helper
      // (the service's default); Windows/Linux use this desktop's encoder.
      getScreencastRecorder: () => appControlScreencastRecorder,
      getChromiumDemoEngine: () => chromiumDemoEngine,
      // A lane may not attach to an app another lane's Mac Desktop holds.
      macDesktopLaneForProcess: (pid: number) => macDesktopService.laneForProcess(pid),
      ingestArtifacts: (request) => computerUseArtifactBrokerService.ingest(request),
      resolvePrimaryPrUrl: (laneId: string): string | null =>
        prService?.getForLane(laneId)?.githubUrl ?? null,
      resolveLaneName: async (laneId: string): Promise<string | null> => {
        const lane = await laneService.getSummary(laneId).catch(() => null);
        return lane?.name ?? null;
      },
    });
    appControlService.setFrameDemand(APP_CONTROL_WINDOWS_FRAME_DEMAND_SOURCE, heldAppControlFrameLanes());
    // The session is per lane and owned by a chat: it goes when the chat ends
    // and when its lane is archived or deleted.
    agentChatService.registerChatSessionEndedListener((sessionId) => {
      void appControlService.stopForChat(sessionId).catch((error: unknown) => {
        logger.debug("app_control.release_on_chat_end_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    laneTeardownDeps.appControlService = {
      stopForLane: (laneId: string) => appControlService.stopForLane(laneId),
    };
    const usageTrackingService = createUsageTrackingService({
      logger,
      db,
      museQuota,
      pollIntervalMs: 120_000,
      // In-process (tests): unbound windows have no runtime pump, so this
      // tracker is the producer and must broadcast. Production project open
      // never reaches this constructor — it uses `initRuntimeBackedProjectContext`
      // with `usageTrackingService: null`. The remaining production caller is
      // mobile-sync context init, which must not start a second poller or
      // broadcast into the same channel the brain bridge already feeds.
      onUpdate: (snapshot) => {
        if (shouldUseInProcessProjectRuntime()) {
          broadcast(IPC.usageEvent, snapshot);
          return;
        }
        emitProjectEvent(projectRoot, IPC.usageEvent, snapshot);
      },
      projectRoot,
      dependencies: {
        // Only the project-bound context reports scope adoption. The dormant
        // machine-level tracker below has no project, and the CLI-hosted brain
        // is a runtime rather than the desktop surface this fact is scoped to;
        // the per-scope daily dedupe key covers the Hub read either way.
        captureAnalytics: (input) => {
          productAnalyticsService.capture(input);
        },
        captureInternalAnalytics: (input) => productAnalyticsService.captureInternal(input),
        // Smart balance sees the chats this machine owns: running chats burn
        // now, open-but-idle chats reserve room. The chat service owns the
        // lifecycle; balance owns the weights.
        listProviderAccountChatLoad: listMachineProviderAccountChatLoad,
      },
    });
    const storageInsightsService = createStorageInsightsService({
      projectRoot,
      adeHome: machineAdeLayout.adeDir,
      db,
      logger,
      diskPressure: diskPressureMonitor,
      isPathActive: (filePath) =>
        agentChatService.isTranscriptPathActive(filePath)
        || ptyService.isTranscriptPathActive(filePath)
        || iosSimulatorService.isBuildPathActive(filePath),
      projectId,
      // The index file is held open by the search service; it compacts on request.
      compactSearchIndex: () =>
        searchServiceHolder.current?.compactIndex()
        ?? { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "unsupported" },
      laneService,
      projectConfigService,
      releaseLaneRuntimeResources: (laneId) => {
        releaseLaneRuntimeResources({ portAllocationService, laneProxyService }, laneId);
      },
      captureAnalytics: (input) => {
        productAnalyticsService.capture(input);
      },
    // Removing proof files from Settings must drop their records too,
    // otherwise the drawer keeps listing items whose bytes are gone.
    purgeProofRecordsUnder: (removedPath) => {
      computerUseArtifactBrokerService.purgeArtifactRecordsUnder(removedPath);
    },
    });
    const projectHealthService = createProjectHealthService({
      projectRoot,
      db,
      logger,
      listLanes: () => laneService.list({ includeArchived: false }),
      readChatTurnStates: createProjectHealthTurnStateReader(agentChatService),
      openTerminal: async (request) => {
        await ptyService.create({
          laneId: request.laneId,
          cwd: request.cwd,
          cols: 120,
          rows: 32,
          title: request.title,
          tracked: true,
          startupCommand: request.command,
        });
      },
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
    const rosterOpenedAt = Date.now();
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
      sessionService,
      ptyService,
      projectConfigService,
      portAllocationService,
      laneEnvironmentService,
      laneTemplateService,
      computerUseArtifactBrokerService,
      appleDeviceService: iosSimulatorService,
      getWebhookAutomations: () => createWebhookRemoteSource({
        automationService,
        webhooks: automationIngressService?.webhooks,
        projectSecrets: projectSecretService,
      }),
      appleStreamRelay,
      getAppleRemoteBitrateKbpsCap: () => DEFAULT_APPLE_REMOTE_BITRATE_KBPS,
      agentChatService,
      cursorCloudFleetService,
      cloudAgentsService,
      ctoStateService,
      linearCredentialService,
      getLinearIssueTracker: () => linearIssueTracker,
      getExternalSessionsService: () => externalSessionsService,
      macDesktopService,
      usageTrackingService,
      hostStartupEnabled: syncHostAutoStart,
      // Never the machine brain. It claims the cluster record only while its
      // own host startup is on (the ADE_ENABLE_DESKTOP_SYNC_HOST debug host).
      mayClaimCluster: false,
      phonePairingStateDir: machineAdeLayout.secretsDir,
      hostDiscoveryEnabled: isMobileSyncHostContext,
      forceHostRole: false,
      // The brain's roster builder over this window's one project. Without a
      // roster the host omits `rosterPeer`, and a phone reads that as an old
      // ADE and asks the user to update a current one.
      rosterProvider: {
        buildSnapshot: () =>
          buildRosterSnapshot({
            projectRegistry: {
              list: () => [{
                projectId,
                rootPath: projectRoot,
                displayName: project.displayName,
                gitOriginUrl: readGitOriginUrl(projectRoot),
                lastOpenedAt: rosterOpenedAt,
                catalogVisibility: "recent",
              }],
            },
            scopeRegistry: {
              getIfBooted: (id) =>
                id === projectId ? Promise.resolve({ runtime: { agentChatService, ptyService } }) : null,
            },
            hostProjectId: projectId,
            logger,
          }),
      },
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
        setProjectIcon: setMobileSyncProjectIcon,
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
    const automationPlannerService = automationService
      ? createAutomationPlannerService({
          logger,
          projectRoot,
          projectConfigService,
          laneService,
          automationService,
        })
      : null;

    if (shouldUseInProcessProjectRuntime()) {
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
    }

    const budgetCapService = createBudgetCapService({
      db,
      logger,
      projectConfigService,
      usageTrackingService,
    });

    scheduleBackgroundProjectTask(
      "prs.polling_start",
      () => {
        prPollingService.start();
        prWatchServiceRef?.start();
      },
      (error) => {
        logger.warn("prs.polling_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      0,
      "ADE_ENABLE_PR_POLLING",
    );

    // Cold-open catch-up reconcile. Routed through the global limiter (not a
    // direct call) so a burst of project opens still staggers under the app-wide
    // concurrency cap. The per-project throttle on the service makes it a no-op
    // if a focus reconcile already ran within the min-interval.
    scheduleBackgroundProjectTask(
      "prs.reconcile_on_open",
      () => {
        scheduleReconcile(buildReconcileRunner(projectRoot));
      },
      (error) => {
        logger.warn("prs.reconcile_on_open_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      reconcileJitterMs(),
      "ADE_ENABLE_PR_RECONCILE",
    );

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

    if (linearIngressService) {
      scheduleBackgroundProjectTask(
        "automations.linear_ingress_start",
        () => linearIngressService.start(),
        (error) => {
          logger.warn("automations.linear_ingress_start_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
        0,
        "ADE_ENABLE_AUTOMATION_INGRESS",
      );
    }

    if (cursorCloudIngressService) {
      scheduleBackgroundProjectTask(
        "automations.cursor_cloud_ingress_start",
        () => cursorCloudIngressService.start(),
        (error) => {
          logger.warn("automations.cursor_cloud_ingress_start_failed", {
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
    if (recordRecent !== false && userSelectedProject) {
      mirrorDesktopRecentProjectToMachineCatalog(project.rootPath);
    }

    // ── ADE RPC Socket Server (embedded mode) ─────────────────────
    const rpcRuntime = {
      projectRoot,
      workspaceRoot: projectRoot,
      projectId,
      project,
      paths: adePaths as unknown as AdeRuntimePaths,
      sessionActivityReportingEnabled: true,
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
      getProxyService: getSubscriptionProxyService,
      get proxyService(): ProxyService | null {
        return subscriptionProxyService;
      },
      oauthRedirectService,
      runtimeDiagnosticsService,
      sessionService,
      operationService,
      projectConfigService,
      projectSecretService,
      projectHealthService,
      conflictService,
      gitService,
      diffService,
      ptyService,
      testService,
      aiIntegrationService,
      agentChatService,
      prService,
      fileService,
      searchService,
      externalSessionsService,
      ctoStateService,
      ctoMemoryService,
      linearCredentialService,
      linearIssueTracker,
      githubService,
      automationService,
      automationPlannerService,
      computerUseArtifactBrokerService,
      iosSimulatorService,
      macDesktopService,
      appControlService,
      builtInBrowserService,
      syncHostService: syncService.getHostService(),
      syncService,
      automationIngressService,
      linearIngressService,
      cursorCloudIngressService,
      cursorCloudFleetService,
      cloudAgentsService,
      usageTrackingService,
      storageInsightsService,
      budgetCapService,
      sessionDeltaService,
      autoUpdateService,
      appNavigationService: {
        navigate: async (request: AppNavigationRequest) => {
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
      const activeRpcSocketPath = rpcSocketPath;

      if (!isAdeRuntimeNamedPipePath(activeRpcSocketPath)) {
        try {
          fs.unlinkSync(activeRpcSocketPath);
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
          server.listen(localIpcListenOptions(activeRpcSocketPath));
        }),
      );
      logger.warn("rpc.socket_server_started", {
        socketPath: activeRpcSocketPath,
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
    automationService?.bindAdeActionRegistry(
      createAutomationAdeActionLookup(() => getAdeActionDomainServices(buildAdeActionRuntimeForAutomations())),
    );

    // Helper: materialize an AdeRuntime-shaped bag from the current set of
    // locally-created services so that the registry's service map resolves.
    // Using a function closure means this stays reactive to late-bound refs
    // like CTO state bindings.
    // Desktop automations run in this process, where no push publisher lives.
    // A "Send notification" step still reaches the relay directly, with the
    // same account sign-in and machine identity the brain's publisher uses.
    let automationNotifyRelay: {
      client: ReturnType<typeof createPushRelayClient>;
      store: ReturnType<typeof createPushRegistrationStore>;
    } | null = null;
    const sendCustomNotificationFromDesktop: NonNullable<AdeRuntime["sendCustomNotification"]> = async (
      notification,
    ) => {
      if (!automationNotifyRelay) {
        const authService = getSharedAccountAuthService();
        const store = createPushRegistrationStore({
          filePath: resolvePushRelayStateFile(machineAdeLayout.secretsDir),
        });
        const client = createPushRelayClient({
          store,
          logger: localRuntimeLogger,
          getAccountAccessToken: (options) => getSignedInAccountAccessToken(authService, options),
          getAccountUserId: () => {
            const status = authService.getStatus();
            return status.signedIn ? status.userId?.trim() || null : null;
          },
        });
        automationNotifyRelay = { client, store };
      }
      const { projectId, ...rest } = notification;
      let accountMachineKey: string | null = null;
      try {
        accountMachineKey = getOrCreateLocalAccountMachineIdentity({
          secretsDir: machineAdeLayout.secretsDir,
        }).machineKey;
      } catch {
        // No machine identity: the link goes out as written.
      }
      return await automationNotifyRelay.client.sendAccountNotification({
        ...rest,
        deepLink: rest.deepLink
          ? stampCustomNotificationLinkOwner(rest.deepLink, { accountMachineKey, projectId })
          : null,
        machineKey: automationNotifyRelay.store.getOrCreateIdentity().machineKey,
      });
    };

    function buildAdeActionRuntimeForAutomations(): AdeRuntime {
      return {
        // The notification step names its project (so a chat or PR link opens
        // on this machine), refuses while signed out, and is counted.
        projectRoot,
        accountAuthService,
        productAnalyticsService,
        sendCustomNotification: sendCustomNotificationFromDesktop,
        laneService,
        gitService,
        diffService,
        conflictService,
        prService,
        testService,
        agentChatService,
        ctoStateService,
        sessionService,
        operationService,
        projectConfigService,
        projectSecretService,
        projectHealthService,
        linearIssueTracker,
        fileService,
        ptyService,
        terminalWatchService: terminalWatchServiceRef,
        computerUseArtifactBrokerService,
        iosSimulatorService,
        macDesktopService,
        appControlService,
        builtInBrowserService,
        automationService,
        automationPlannerService,
        githubService,
        keybindingsService,
        onboardingService,
        usageTrackingService,
        storageInsightsService,
        budgetCapService,
        autoUpdateService,
        getProxyService: getSubscriptionProxyService,
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
      getProxyService: getSubscriptionProxyService,
      get proxyService(): ProxyService | null {
        return subscriptionProxyService;
      },
      oauthRedirectService,
      runtimeDiagnosticsService,
      sessionService,
      processRegistry,
      diskPressureMonitor,
      ptyService,
      diffService,
      fileService,
      operationService,
      gitService,
      conflictService,
      aiIntegrationService,
      githubService,
      projectScaffoldService,
      prService,
      prPollingService,
      prWatchService: prWatchServiceRef,
      terminalWatchService: terminalWatchServiceRef,
      prShellLinkWatcher,
      computerUseArtifactBrokerService,
      iosSimulatorService,
      macDesktopService,
      appControlService,
      searchService,
      externalSessionsService,
      jobEngine,
      transcriptionService: getSharedTranscriptionService(logger),
      automationService,
      automationPlannerService,
      automationIngressService,
      linearIngressService,
      cursorCloudIngressService,
      githubPollingService,
      usageTrackingService,
      storageInsightsService,
      projectHealthService,
      budgetCapService,
      syncHostService: syncService.getHostService(),
      syncService,
      agentChatService,
      projectConfigService,
      projectSecretService,
      sessionDeltaService,
      testService,
      ctoStateService,
      ctoMemoryService,
      adeProjectService,
      linearCredentialService,
      linearIssueTracker,
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
    assertLocalProjectDataAvailable(projectRoot);
    const adePaths = ensureAdeDirs(projectRoot);
    const logger = createFileLogger(path.join(adePaths.logsDir, "main.jsonl"));
    const project = toProjectInfo(projectRoot, baseRef);
    // The brain's registration and this window's own database open do not
    // depend on each other; a project open waited for one, then the other.
    const [registered, opened] = await Promise.allSettled([
      localRuntimePool.ensureProject(projectRoot),
      openKvDb(adePaths.dbPath, logger, {
        // The machine runtime owns sync and the real storage doctor in this mode;
        // this dormant fallback has no authoritative local peer signal.
        hasSyncPeers: () => true,
        appVersion: shippedVersionOrNull(app.getVersion()),
      }),
    ]);
    if (registered.status === "rejected") {
      if (opened.status === "fulfilled") {
        try { opened.value.close(); } catch { /* the registration error is the one to report */ }
      }
      throw registered.reason;
    }
    if (opened.status === "rejected") throw opened.reason;
    const runtimeProject = registered.value;
    const db = opened.value;
    recordLocalProjectDatabaseIdentity(projectRoot, logger);
    const shellContext = createDormantProjectContext(projectRoot, { enableUsageTracking: false });
    const storageInsightsService = createStorageInsightsService({
      projectRoot,
      adeHome: machineAdeLayout.adeDir,
      db,
      logger,
      // Daemon-backed mode: the brain owns activity tracking and runs the real compression sweep
      // (see apps/ade-cli/src/bootstrap.ts); this fallback instance deliberately refuses to compress
      // because activity cannot be known here. It also never arms the maintenance timers (no
      // diskPressure supplied), so it only runs maintenance if runMaintenanceNow is called directly.
      isPathActive: () => true,
      projectId: runtimeProject.projectId,
      captureAnalytics: (input) => {
        productAnalyticsService.capture(input);
      },
    });
    const diskPressureMonitor = createDiskPressureMonitor({
      roots: [projectRoot, machineAdeLayout.adeDir],
      logger,
    });

    logger.info("project.runtime_bound", {
      projectRoot,
      projectId: runtimeProject.projectId,
      mode: "local_runtime_daemon",
    });
    return {
      ...shellContext,
      db,
      logger,
      project,
      projectId: runtimeProject.projectId,
      adeDir: adePaths.adeDir,
      hasUserSelectedProject: userSelectedProject,
      adeCliService: shellContext.adeCliService,
      builtInBrowserService,
      diskPressureMonitor,
      // The machine brain owns quota polling and streams its snapshots through
      // the runtime event pump. A second renderer-side tracker races those
      // events and can make the compact header disagree with the open panel.
      usageTrackingService: null,
      storageInsightsService,
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
    installAdeCliForTerminalInBackground(adeCliService, globalStatePath);
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
        museQuota,
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
        dependencies: {
          captureInternalAnalytics: (input) => productAnalyticsService.captureInternal(input),
        },
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
      getProxyService: getSubscriptionProxyService,
      oauthRedirectService: null,
      runtimeDiagnosticsService: null,
      sessionService: null,
      diskPressureMonitor: null,
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
      prService: null,
      prPollingService: null,
      prWatchService: null,
      terminalWatchService: null,
      jobEngine: null,
      transcriptionService: getSharedTranscriptionService(logger),
      automationService: null,
      automationPlannerService: null,
      automationIngressService: null,
      linearIngressService: null,
      cursorCloudIngressService: null,
      githubPollingService: null,
      usageTrackingService,
      budgetCapService: null,
      syncHostService: null,
      syncService: null,
      projectConfigService: null,
      projectSecretService: null,
      sessionDeltaService: null,
      testService: null,
      ctoStateService: null,
      ctoMemoryService: null,
      adeProjectService: null,
      linearCredentialService: null,
      linearIssueTracker: null,
      configReloadService: null,
    };
  };

  /**
   * One main-process subscription to the brain's shared usage tracker.
   *
   * Windows with no local project binding — Welcome, Hub/Account, a
   * remote-machine tab — accept usage only on the local `IPC.usageEvent`
   * channel, and the dormant in-process tracker that used to feed it is stopped
   * whenever a project is open. Without this they sat frozen at whatever the
   * disk cache held while every bound window moved. Bound windows ignore this
   * channel, so broadcasting costs nothing and cannot double-deliver.
   *
   * The brain exposes usage per project scope, so the bridge borrows any booted
   * scope; every scope is fed by the same machine-level poller.
   */
  /**
   * Desktop notifications for agents that need the user, failed, reached a
   * goal, or sent the user a message. Fed by this computer's brain (below, on
   * the machine event bridge) and by the account snapshots windows poll (for
   * chats on other machines). See `desktopAlertPresenter.ts`.
   */
  let attentionPreferencesForAlerts: { ownerId: string; preferences: AttentionPreferences } | null = null;
  /** Electron drops a click on a notification nothing references any more. */
  const liveDesktopAlertNotifications = new Set<Notification>();
  let desktopAlertClickOwner: string | null | undefined;
  /**
   * Alerts a window was asked to toast, by item id. The toast's Open sends
   * back only the id, and main opens what it recorded, so a window cannot
   * name an arbitrary chat or item to open or mark seen.
   */
  const toastedDesktopAlerts = new Map<string, { alert: DesktopAlert; ownerId: string | null }>();
  const rememberToastedDesktopAlert = (alert: DesktopAlert): void => {
    toastedDesktopAlerts.delete(alert.itemId);
    toastedDesktopAlerts.set(alert.itemId, { alert, ownerId: readAccountOwnerId() });
    while (toastedDesktopAlerts.size > 32) {
      const oldest = toastedDesktopAlerts.keys().next();
      if (oldest.done) break;
      toastedDesktopAlerts.delete(oldest.value);
    }
  };
  /**
   * `ownerId` is the account signed in when the alert was shown. Opening an
   * old alert after a switch does nothing: its chat and item ids belong to the
   * account that showed it, so handing them to the new account's renderer
   * would open the wrong thing (and the same item id can exist under the new
   * account).
   */
  const openDesktopAlert = (alert: DesktopAlert, ownerId: string | null): void => {
    if (ownerId !== readAccountOwnerId()) return;
    // Opening it is seeing it: the phone, still waiting out desktop-first,
    // stays quiet. Best effort; a failure only means the phone gets it later.
    void ipcBridge?.markAttentionItemSeen(alert.itemId, alert.alertFingerprint ?? null).catch((error: unknown) => {
      logMachineEvent("info", "attention.desktop_alert_mark_seen_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (alert.item) {
      void navigateFromAttentionItem(alert.item, attentionItemNavigationRequest(alert.item))
        .catch((error) => logMachineEvent("warn", "attention.desktop_alert_open_failed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      return;
    }
    handleDeeplinkUrl(
      buildDeeplink({ kind: "session", sessionId: alert.sessionId }, { form: "ade" }),
      "notification:attention",
      dispatchOrQueueAppNavigationRequest,
    );
  };
  const desktopAlertPresenter = createDesktopAlertPresenter({
    isSupported: () => Notification.isSupported(),
    isAppFocused: () => Boolean(BrowserWindow.getFocusedWindow()),
    getDeviceId: () => ipcBridge?.getLocalMachineIdentity().deviceId ?? null,
    getAccountOwnerId: () => readAccountOwnerId(),
    getPreferences: () => {
      const ownerId = readAccountOwnerId();
      return ownerId && attentionPreferencesForAlerts?.ownerId === ownerId
        ? attentionPreferencesForAlerts.preferences
        : null;
    },
    show: (alert, onClick) => {
      try {
        const ownerId = readAccountOwnerId();
        const notification = new Notification({ title: alert.title, ...(alert.body ? { body: alert.body } : {}) });
        liveDesktopAlertNotifications.add(notification);
        const release = () => liveDesktopAlertNotifications.delete(notification);
        notification.on("click", () => {
          release();
          // `open` runs synchronously inside onClick and reads this, so the
          // account the notification was shown under travels with the click.
          desktopAlertClickOwner = ownerId;
          try {
            onClick();
          } finally {
            desktopAlertClickOwner = undefined;
          }
        });
        notification.on("close", release);
        notification.show();
        // A notification the user never touches still has to let go.
        setTimeout(release, 10 * 60_000).unref?.();
      } catch (error) {
        logMachineEvent("warn", "attention.desktop_alert_failed", {
          kind: alert.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    toastInFocusedWindow: (alert) => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused || focused.isDestroyed()) return;
      rememberToastedDesktopAlert(alert);
      focused.webContents.send(IPC.attentionAlert, alert);
    },
    open: (alert) => openDesktopAlert(
      alert,
      desktopAlertClickOwner !== undefined ? desktopAlertClickOwner : readAccountOwnerId(),
    ),
  });

  let machineUsageEventRoot: string | null = null;
  let machineUsageEventCleanup: (() => void) | null = null;
  let machineUsageEventRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Assigned by `registerIpc` once the account directory and the paired remote
   * connection pool exist.
   *
   * The brain owns the rollup store but has no client for calling another
   * machine's ADE; the desktop app has the transport but no longer owns the
   * tracker. Main is the only place that sees both, so it runs the fan-out and
   * pushes the result into the brain's shared tracker.
   */
  let machineAccountRollupFetcher: AccountRollupFetcher | null = null;
  let machineAccountRollupRefreshInFlight: Promise<void> | null = null;
  let machineAccountRollupRefreshedAtMs = 0;
  /**
   * Floor on the desktop fan-out. Usage events fire far more often than the
   * tracker's own getAdeUsageStats-driven refresh (30 s), so this is 60 s.
   */
  const MACHINE_ACCOUNT_ROLLUP_MIN_INTERVAL_MS = 60_000;
  const MACHINE_ACCOUNT_ROLLUP_TIMEOUT_MS = 4_000;
  /** Re-arm delay after the brain's event stream ends or refuses to open. */
  const MACHINE_USAGE_EVENT_RETRY_MS = 5_000;

  const pushAccountRollupsToBrain = (rootPath: string): void => {
    const fetcher = machineAccountRollupFetcher;
    if (!fetcher || machineAccountRollupRefreshInFlight) return;
    const startedAtMs = Date.now();
    if (startedAtMs - machineAccountRollupRefreshedAtMs < MACHINE_ACCOUNT_ROLLUP_MIN_INTERVAL_MS) return;
    machineAccountRollupRefreshedAtMs = startedAtMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MACHINE_ACCOUNT_ROLLUP_TIMEOUT_MS);
    timer.unref?.();
    const task = (async () => {
      try {
        const result = await fetcher({
          timeoutMs: MACHINE_ACCOUNT_ROLLUP_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (result.rollups.length === 0 && result.failures.length === 0) return;
        await localRuntimePool.callActionForRoot(rootPath, {
          domain: "usage",
          action: "applyAccountRollups",
          args: { rollups: result.rollups, failures: result.failures },
        });
      } catch (error) {
        // Best effort by construction: the brain renders account scope from its
        // durable rollups whether or not this ever lands.
        dormantContext?.logger?.debug("usage.account_rollup_push_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      if (machineAccountRollupRefreshInFlight === task) {
        machineAccountRollupRefreshInFlight = null;
      }
    });
    machineAccountRollupRefreshInFlight = task;
  };

  const syncMachineUsageEventBridge = (): void => {
    if (shouldUseInProcessProjectRuntime()) return;
    const desired = bootedUsageScopeRoot([...projectContexts.values()]);
    if (desired === machineUsageEventRoot) return;
    machineUsageEventCleanup?.();
    machineUsageEventCleanup = null;
    machineUsageEventRoot = desired;
    if (!desired) return;
    const root = desired;
    void localRuntimePool
      .subscribeEventsForRoot(
        root,
        { category: "runtime", replay: false },
        (event) => {
          if (machineUsageEventRoot !== root) return;
          if (event.payload?.type === "attention_alert") {
            const alert = readDesktopAlertEvent(event.payload);
            if (alert) desktopAlertPresenter.presentLocal(alert);
            return;
          }
          if (event.payload?.type !== "usage") return;
          const snapshot = event.payload.snapshot;
          if (!isUsageSnapshot(snapshot)) return;
          broadcast(IPC.usageEvent, snapshot);
          pushAccountRollupsToBrain(root);
        },
        () => {
          if (machineUsageEventRoot !== root) return;
          machineUsageEventRoot = null;
          machineUsageEventCleanup = null;
          // A recycled brain ends the stream. Nothing else would re-arm the
          // bridge until a project happened to open or close, which would leave
          // every unbound window silently frozen in the meantime.
          scheduleMachineUsageEventRetry();
        },
      )
      .then((cleanup) => {
        // The chosen root can close while the subscription is being set up.
        if (machineUsageEventRoot !== root) {
          cleanup();
          return;
        }
        machineUsageEventCleanup = cleanup;
      })
      .catch((error) => {
        if (machineUsageEventRoot === root) machineUsageEventRoot = null;
        dormantContext?.logger?.debug("usage.machine_event_bridge_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleMachineUsageEventRetry();
      });
  };

  function scheduleMachineUsageEventRetry(): void {
    if (machineUsageEventRetryTimer || projectContexts.size === 0) return;
    machineUsageEventRetryTimer = setTimeout(() => {
      machineUsageEventRetryTimer = null;
      syncMachineUsageEventBridge();
    }, MACHINE_USAGE_EVENT_RETRY_MS);
    machineUsageEventRetryTimer.unref?.();
  }

  const syncDormantUsageTrackingState = (): void => {
    syncMachineUsageEventBridge();
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
    // A staged board move whose project is closing, before anything it needs is
    // gone. Its status write already landed and its message is still sitting
    // behind a 5-second timer; the disposal below closes the chat service that
    // dispatch sends through and the database a failed dispatch reverses into,
    // while the timer stays armed and fires against both. Awaited here for the
    // same reason the shutdown sequence awaits it — an unawaited drain races
    // the very teardown it is trying to get ahead of.
    //
    // Scoped to THIS context's session service, which is what identifies the
    // project: every context builds its own board-move actions over its own
    // session service, and a global flush would dispatch another project's
    // pending move early, ending an undo window its user is still looking at.
    if (ctx.sessionService) {
      try {
        await flushStagedBoardMoves({ sessionService: ctx.sessionService });
      } catch (error) {
        ctx.logger.error("app.staged_board_move_flush_failed", {
          projectRoot: ctx.project?.rootPath ?? null,
          // The Error itself, so `logBridge` lifts it into the Sentry event and
          // the issue groups by the real failure; `errorText` keeps the
          // sentence on disk, which `JSON.stringify` writes an Error without.
          error,
          errorText: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
      ctx.storageInsightsService?.dispose();
    } catch {
      // Scheduled maintenance teardown is best effort.
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
      ctx.prWatchService?.dispose();
      ctx.terminalWatchService?.dispose();
      ctx.prShellLinkWatcher?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.automationIngressService?.dispose();
    } catch {
      // ignore
    }
    try {
      ctx.linearIngressService?.stop();
    } catch {
      // ignore
    }
    try {
      ctx.cursorCloudIngressService?.stop();
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
      ctx.usageTrackingService?.dispose();
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
      // Destroys this project's virtual displays and stops the driver. A leaked
      // display outlives the process it was created by, so the teardown path
      // matters more here than for a service that only holds memory.
      ctx.macDesktopService?.dispose?.();
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
      ctx.ptyService?.disposeAll();
    } catch {
      // ignore
    }
    try {
      await ctx.agentChatService?.disposeAll();
    } catch {
      // ignore
    }
    // After pty/process/chat teardown so their final events cannot land on a
    // disposed search service.
    try {
      ctx.searchService?.dispose();
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
    gitOriginUrl?: string | null,
  ): Promise<SyncMobileProjectSummary> {
    let laneCount = recent?.summary.laneCount ?? 0;
    if (!recent?.summary.laneCount && ctx.laneService) {
      try {
        laneCount = (await ctx.laneService.list({ includeArchived: false })).length;
      } catch {
        laneCount = 0;
      }
    }
    let repositoryIdentity = mobileProjectRepositoryIdentityFromGitOrigin(gitOriginUrl);
    if (!repositoryIdentity.repoOwner || !repositoryIdentity.repoName) {
      try {
        const remote = await ctx.githubService.getRemoteStatus();
        if (remote.repo) {
          repositoryIdentity = {
            repoOwner: remote.repo.owner,
            repoName: remote.repo.name,
          };
        }
      } catch {
        // Repository identity is optional. Keep the paired null fallback so a
        // client never guesses ownership from the project display name.
      }
    }
    return {
      id: ctx.projectId || recent?.projectId || `root:${normalizeProjectRoot(ctx.project.rootPath)}`,
      displayName: ctx.project.displayName,
      rootPath: ctx.project.rootPath,
      ...repositoryIdentity,
      defaultBaseRef: ctx.project.baseRef,
      lastOpenedAt: recent?.summary.lastOpenedAt ?? null,
      iconDataUrl: mobileProjectIconDataUrl(ctx.project.rootPath),
      laneCount,
      isAvailable: fs.existsSync(ctx.project.rootPath),
      isCached: false,
      isOpen: true,
    };
  }

  function mobileProjectSummaryForRecent(
    recent: RecentProjectInspection,
    gitOriginUrl?: string | null,
  ): SyncMobileProjectSummary {
    const normalizedRoot = normalizeProjectRoot(recent.summary.rootPath);
    return {
      id: recent.projectId ?? `root:${normalizedRoot}`,
      displayName: recent.summary.displayName,
      rootPath: recent.summary.rootPath,
      ...mobileProjectRepositoryIdentityFromGitOrigin(gitOriginUrl),
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
    // Do not start or repair the machine runtime just to decorate a desktop
    // fallback catalog. When it is already connected, its registry is the
    // canonical and cheap source of git origins; otherwise current hosts send
    // paired null coordinates and mobile treats repository-scoped links as
    // unverified instead of guessing from a same-named folder.
    const runtimeProjects = localRuntimePool.getStatus().connectionState === "connected"
      ? await localRuntimePool.projects().catch(() => [])
      : [];
    const runtimeProjectByRoot = new Map(
      runtimeProjects
        .map((project) => [normalizeProjectRoot(project.rootPath), project] as const),
    );
    const byRoot = new Map<string, SyncMobileProjectSummary>();
    for (const recent of recentProjects) {
      const root = normalizeProjectRoot(recent.summary.rootPath);
      byRoot.set(
        root,
        mobileProjectSummaryForRecent(recent, runtimeProjectByRoot.get(root)?.gitOriginUrl),
      );
    }
    const contextSummaries = await Promise.all(
      [...projectContexts.entries()]
        .filter(([root]) => recentByRoot.has(root))
        .map(async ([root, ctx]) =>
          [
            root,
            await mobileProjectSummaryForContext(
              ctx,
              recentByRoot.get(root) ?? null,
              runtimeProjectByRoot.get(root)?.gitOriginUrl,
            ),
          ] as const
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
    } catch (error) {
      // Trusting a folder is only offered on the desktop, where the user can
      // see which folder and who owns it; say why instead of "not a repo".
      if (error instanceof GitUntrustedFolderError) throw new Error(error.message);
      throw new Error("Choose a Git repository folder.");
    }
  }

  async function mobileProjectSummaryForRoot(rootPath: string | null | undefined): Promise<SyncMobileProjectSummary> {
    const normalizedRoot = await resolveMobileSyncProjectRoot(rootPath);
    const ctx = await ensureProjectContextForMobileSync(normalizedRoot);
    const runtimeProject = await localRuntimePool.ensureProject(normalizedRoot, {
      catalogVisibility: "recent",
      registrationSource: "mobile",
    });
    return await mobileProjectSummaryForContext(
      ctx,
      recentProjectInspectionForRoot(normalizedRoot),
      runtimeProject.gitOriginUrl,
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

  /**
   * A phone's "Change icon…" for a project this desktop hosts: the same store
   * the desktop's own icon editor writes, so the next catalog carries it.
   */
  async function setMobileSyncProjectIcon(
    input: SyncProjectSetIconRequestPayload,
  ): Promise<SyncProjectSetIconResultPayload> {
    const requestedProjectId = typeof input.projectId === "string" && input.projectId.trim()
      ? input.projectId.trim()
      : null;
    const requestedRoot = typeof input.rootPath === "string" && input.rootPath.trim()
      ? normalizeProjectRoot(input.rootPath)
      : null;
    const localRecents = (readGlobalState(globalStatePath).recentProjects ?? []).filter((entry) => !entry.remote);
    const knownRoots = new Set([
      ...localRecents.map((entry) => normalizeProjectRoot(entry.rootPath)),
      ...projectContexts.keys(),
    ]);
    const rootFromId = requestedProjectId == null
      ? null
      : [...projectContexts.entries()].find(([, ctx]) => ctx.projectId === requestedProjectId)?.[0] ?? null;
    const root = requestedRoot && knownRoots.has(requestedRoot) ? requestedRoot : rootFromId;
    if (!root) {
      return {
        ok: false,
        message: "That project is not on this ADE machine.",
        projectId: requestedProjectId,
        rootPath: requestedRoot,
      };
    }
    try {
      const upload = decodeProjectIconUpload(input, "project_set_icon_request");
      importProjectIconBytes(root, upload.fileName, upload.data);
    } catch (error) {
      return {
        ok: false,
        message: `Could not set the project icon: ${error instanceof Error ? error.message : String(error)}`,
        projectId: requestedProjectId,
        rootPath: root,
      };
    }
    return {
      ok: true,
      projectId: requestedProjectId,
      rootPath: root,
      iconDataUrl: mobileProjectIconDataUrl(root),
    };
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
    try {
      await localRuntimePool.setProjectCatalogVisibility(
        rootToForget,
        "system",
        "mobile",
      );
    } catch (error) {
      console.warn("sync.mobile_project_forget_registry_failed", {
        rootPath: rootToForget,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    writeGlobalState(globalStatePath, withRecentProject(readGlobalState(globalStatePath), project, options));
    if (options.recordRecent !== false) {
      mirrorDesktopRecentProjectToMachineCatalog(project.rootPath);
    }
  };

  const projectOpenLogger = createFileLogger(
    path.join(app.getPath("userData"), "project-open.jsonl"),
  );

  /**
   * `resolveRepoRoot` for a folder the user chose to open. When git refuses it
   * for belonging to another account (safe.directory), this throws a
   * `git_untrusted_folder` coded error and the renderer asks "Trust this
   * folder?". Only after the user says yes does the retry arrive with
   * `trustGitOwnership`, and only then is that one folder added to their
   * global safe.directory list. Nothing else — background scans, agents, the
   * CLI, mobile — ever trusts a folder.
   *
   * The flag alone is not enough: main records which renderer it asked, about
   * which folder, and honours `trustGitOwnership` once, only from that
   * renderer and only for that folder. A renderer that sends the flag on a
   * first call, or for a folder it was never asked about, gets the prompt.
   */
  /** webContents id → the folder main asked that renderer to trust. Spent on the next answer. */
  const pendingGitTrustPrompts = new Map<number, { gitPath: string; expiresAt: number }>();
  const GIT_TRUST_PROMPT_TTL_MS = 10 * 60_000;

  const resolveRepoRootForUserOpen = async (
    selectedPath: string,
    trustGitOwnership: boolean,
    webContentsId: number | null,
  ): Promise<string> => {
    // A trust answer is spent by the call that carries it, whatever happens.
    const asked = trustGitOwnership && webContentsId != null ? pendingGitTrustPrompts.get(webContentsId) ?? null : null;
    if (trustGitOwnership && webContentsId != null) pendingGitTrustPrompts.delete(webContentsId);
    try {
      return await resolveRepoRoot(selectedPath, { userChosen: true });
    } catch (error) {
      const problem = gitUntrustedFolderProblem(error);
      if (!problem) throw error;
      const answered = Boolean(
        asked && asked.expiresAt > Date.now() && pathsEqual(asked.gitPath, problem.path),
      );
      if (!answered) {
        projectOpenLogger.info("project.open.git_untrusted_folder", {
          selectedPath,
          gitPath: problem.path,
          owner: problem.owner ?? null,
          ...(trustGitOwnership ? { unaskedTrust: true } : {}),
        });
        if (webContentsId != null) {
          pendingGitTrustPrompts.set(webContentsId, {
            gitPath: problem.path,
            expiresAt: Date.now() + GIT_TRUST_PROMPT_TTL_MS,
          });
        }
        throw codedError(gitOwnershipReason(problem), GIT_UNTRUSTED_FOLDER_CODE);
      }
      const trusted = await trustGitSafeDirectory(problem.path);
      projectOpenLogger.info("project.open.git_folder_trusted", {
        selectedPath,
        safeDirectory: trusted.spec,
        added: trusted.added,
      });
      try {
        return await resolveRepoRoot(selectedPath, { userChosen: true });
      } catch (retryError) {
        // Still refused after trusting (git spells the folder differently, or
        // a parent needs it too): say so plainly rather than asking again.
        if (retryError instanceof GitUntrustedFolderError) throw new Error(retryError.message);
        throw retryError;
      }
    }
  };

  const switchProjectFromDialog = async (
    selectedPath: string,
    options: { trustGitOwnership?: boolean; webContentsId?: number | null } = {},
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
      // A switch to a project that is already open names its root, which git
      // resolved when it opened. Asking git again (and detecting its base ref,
      // which only a new context uses) is work every tab switch threw away.
      const openRoot = normalizeProjectRoot(selectedPath);
      const reusesOpenRoot = options.trustGitOwnership !== true
        && projectContexts.has(openRoot)
        && isLikelyRepoRoot(openRoot);
      repoRoot = reusesOpenRoot ? openRoot : normalizeProjectRoot(
        await resolveRepoRootForUserOpen(
          selectedPath,
          options.trustGitOwnership === true,
          options.webContentsId ?? null,
        ),
      ); // require a real git repo for onboarding.
      // INVARIANT: a root is recorded as "attempted" only once it has been
      // proven to be a real git repository on disk — `resolveRepoRoot` throws
      // otherwise. The registry widens what a renderer may later name in
      // diagnostics/recovery calls, so recording an unvalidated string would
      // let a renderer launder any path on the machine into a known root by
      // calling `projectOpenRepo` with it first. Still recorded BEFORE the
      // init steps below, which are exactly the ones that fail with coded
      // errors (disk_full, db_integrity, brain_not_installed) on a first open
      // that never reaches the recent-projects list — the recovery screen for
      // that root is what this registry exists to keep working.
      attemptedProjectRoots.record(repoRoot);
      if (repoRoot !== normalizeProjectRoot(selectedPath)) {
        attemptedProjectRoots.record(selectedPath);
        pendingRepoRootCleanup = authorizePendingWindowProjectRoot(windowId, repoRoot);
      }
      // Kick off base-ref detection IN PARALLEL with the existing-context
      // check and any recent-project bookkeeping. For a cold open this shaves
      // 200-600ms off (git symbolic-ref + rev-parse run during work we'd be
      // doing anyway). A context that is already open needs no base ref, so
      // its fast path starts none.
      const baseRefStartedAt = Date.now();
      const detectBaseRef = () => detectDefaultBaseRef(repoRoot!)
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
      const baseRefPromise = reusesOpenRoot ? null : detectBaseRef();
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
        // `bindWindowToProject` writes a listed project's recent entry in
        // place; only a project missing from the list still needs this write.
        if (!isKnownRecentProject) {
          scheduleOpenRecentPersist(existing.project, {
            recordLastProject: false,
            preserveRecentOrder: false,
          }, "persist_recent_reused");
        }
        const bindStartedAt = Date.now();
        bindWindowToProject(windowId, repoRoot, { emit: true, foreground: true });
        logOpenStep("bind_window_reused", bindStartedAt);
        const rebalanceStartedAt = Date.now();
        scheduleProjectContextRebalance();
        logOpenStep("schedule_rebalance_reused", rebalanceStartedAt);
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
          const baseRef = await (baseRefPromise ?? detectBaseRef());
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
        // The error itself, under the key `logBridge` lifts: an `Error`
        // instance becomes the Sentry event's exception, so the issue is
        // titled and grouped by the real failure. A stringified copy left
        // every project-open failure in the fleet under one issue named
        // "project.open.failed", with the reason buried in `extra` — which is
        // what made this failure class unreadable.
        error,
        // The message as text beside it, because `JSON.stringify` writes an
        // `Error` as `{}`: without this the line on disk would lose the
        // sentence every log grep and `ade report-issue` reads.
        errorText: error instanceof Error ? error.message : String(error),
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
    persistUpdateWorkspace();
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
      if (nextRoot == null) persistUpdateWorkspace();
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
  let shutdownReason: string | null = null;
  let mainExitRecorded = false;
  let quitWarningAcknowledged = false;
  let quitConfirmationInFlight = false;
  let shutdownForceTimer: NodeJS.Timeout | null = null;
  /**
   * The bookend to `desktop.main_started`, in the same machine log. A launch
   * line with no exit line for the previous pid is a crash or a kill; without
   * it a crash, a quit and an app that is still running read the same, which
   * is what left a 33-hour gap in update checks unexplained. Flushed at once:
   * the process ends in this frame.
   */
  const recordMainExit = (reason: string, exitCode: number | null): void => {
    if (mainExitRecorded) return;
    mainExitRecorded = true;
    logMachineEvent("info", "desktop.main_exiting", {
      pid: process.pid,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      reason,
      exitCode,
    });
    flushMachineMainLog();
  };
  let captureHelper: CaptureHelper | null = null;
  /**
   * The ADE window the user was last in.
   *
   * Recorded here rather than derived on demand because the capture gesture
   * fires while ADE is in the background — `BrowserWindow.getFocusedWindow()`
   * is null at exactly the moment the answer is needed.
   */
  let lastFocusedAdeWindowId: number | null = BrowserWindow.getFocusedWindow()?.id ?? null;
  app.on("browser-window-focus", (_event, window) => {
    if (!window.isDestroyed()) lastFocusedAdeWindowId = window.id;
  });

  const shutdownOpenCodeServersBestEffort = (): void => {
    try {
      const { shutdownOpenCodeServers } = require("./services/opencode/openCodeServer");
      shutdownOpenCodeServers();
    } catch {
      // ignore if module not loaded
    }
  };

  /**
   * A login-import read sits behind an OS credential prompt with no timeout by
   * design. Quitting ADE while one is up would otherwise leave an orphaned
   * `Electron (ELECTRON_RUN_AS_NODE)` process still holding that prompt, since
   * Node does not reap non-detached children when the parent exits on macOS.
   */
  const terminateLoginImportWorkersBestEffort = (): void => {
    try {
      const { terminateLoginImportReadWorkers } = require(
        "./services/builtInBrowser/loginImport/loginImportReadWorkerClient",
      );
      terminateLoginImportReadWorkers();
    } catch {
      // ignore if module not loaded
    }
  };

  /** A wedged first-run discovery child would otherwise outlive ADE's quit. */
  const terminateOnboardingDiscoveryWorkersBestEffort = (): void => {
    try {
      const { terminateOnboardingDiscoveryWorkers } = require(
        "./services/onboarding/onboardingDiscoveryClient",
      );
      terminateOnboardingDiscoveryWorkers();
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
    // First, before anything is torn down. A staged board move has already
    // written the status columns; its message is what is still pending, and
    // dispatching it needs a live `agentChatService` (disposed below) and an
    // unflushed db (flushed below), so it cannot be the last statement here.
    //
    // Best effort only: this function is synchronous and the forced/exit paths
    // call `app.exit` in the same frame, so a slow provider send can be cut off
    // — `undoBoardMove` reports `unknown_move` for that case rather than
    // claiming the message was delivered.
    //
    // Skipped on the fast-kill prelude. `requestAppShutdown` calls this before
    // it installs `shutdownPromise`, and a drain here CLAIMS each staged move
    // synchronously — so firing it would empty the map and turn the awaited
    // drain a few lines later into a no-op, trading the one guaranteed path
    // for an unawaited attempt against a service being disposed in this frame.
    if (!reason.startsWith("fast_kill:")) {
      void flushStagedBoardMoves().catch(() => {
        // A failed drain must never block shutdown.
      });
    }
    try {
      captureHelper?.dispose();
    } catch {
      // ignore
    }
    captureHelper = null;
    try {
      autoUpdateService?.dispose();
    } catch {
      // ignore
    }
    try {
      keepAwakeService?.dispose();
    } catch {
      // ignore
    }
    disposeSharedTranscriptionService();
    try {
      machinePowerBrainBridge.dispose();
    } catch {
      // ignore
    }
    // Deliberately NOT on the fast-kill prelude. The pool is not a resource to
    // free first: it is the transport the rest of this teardown still uses —
    // `replaceDormantContext` and every `closeProjectContext` below reach it
    // through the machine usage-event bridge, and the renderer is still alive
    // (its windows are only destroyed in `finalizeAppExit`), polling it over
    // IPC. Disposing it here answered those calls with "the pool is disposed",
    // which is an internal invariant, and `ipcCapture` reported each one to
    // Sentry. The shutdown body's own completion, the force timer, `will-quit`
    // and `process.once("exit")` all still dispose it, so nothing is leaked by
    // waiting.
    if (!reason.startsWith("fast_kill:")) {
      try {
        localRuntimePool.dispose();
      } catch {
        // ignore
      }
    }
    const contexts = new Set<AppContext>(projectContexts.values());
    contexts.add(getActiveContext());

    // The subscription proxy is machine-scoped and is deliberately not part of
    // per-context disposal. Quit is the one owner-level teardown that stops it.
    if (subscriptionProxyService) {
      try {
        void subscriptionProxyService.dispose().catch(() => {
          // Shutdown is best effort; the process is already leaving.
        });
      } catch {
        // ignore
      }
    }

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
    // Chat disposal above leaves the shared Cursor one-shot workers, which
    // belong to no session. The IPC dispose goes out now; the workers also
    // exit on their own once this process is gone.
    void disposeAllCursorSdkConnections().catch(() => {});
    terminateLoginImportWorkersBestEffort();
    terminateOnboardingDiscoveryWorkersBestEffort();
  };

  /**
   * Stop the renderer before the process's services are torn down.
   *
   * A live window is a producer: its runtime event pump, status poll and
   * attention poll all reach `localRuntimePool` over IPC, and an IPC handler
   * that rejects is reported to Sentry (`main/sentry/ipcCapture.ts`). Tearing
   * the pool down under a live renderer therefore turns an ordinary quit into a
   * reported defect. Every window is destroyed here, while the pool is still
   * alive, so nothing is left to call it. `app.exit` destroys them anyway; this
   * only makes that happen first.
   */
  const destroyWindowsForExit = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.destroy();
      } catch {
        // Keep escalating through every window; app.exit is the hard bound.
      }
    }
  };

  const finalizeAppExit = (exitCode: number): void => {
    if (shutdownFinalized) return;
    shutdownFinalized = true;
    if (shutdownForceTimer) {
      clearTimeout(shutdownForceTimer);
      shutdownForceTimer = null;
    }
    destroyWindowsForExit();
    runImmediateProcessCleanup("process_exit_finalize");
    recordMainExit(shutdownReason ?? "finalize", exitCode);
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
    shutdownReason = args.reason;
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

      // Deliver any staged board move before teardown starts. This is the only
      // awaited drain: `staged.dispatch()` sends a chat message, so it needs a
      // live `agentChatService` and an unflushed db — both gone by the time
      // `closeAllProjectContexts` / `runImmediateProcessCleanup` have run. It
      // sits first so a slow browser-storage flush cannot eat its budget; the
      // force timer still bounds the whole sequence.
      try {
        await flushStagedBoardMoves();
      } catch (error) {
        shutdownLogger.error("app.staged_board_move_flush_failed", {
          reason: args.reason,
          // The Error itself, so `logBridge` lifts it into the Sentry event and
          // the issue groups by the real failure; `errorText` keeps the
          // sentence on disk, which `JSON.stringify` writes an Error without.
          error,
          errorText: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        autoUpdateService?.dispose();
      } catch {
        // ignore
      }
      try {
        keepAwakeService?.dispose();
      } catch {
        // ignore
      }
      try {
        await builtInBrowserService.flushStorage();
      } catch (error) {
        shutdownLogger.error("app.browser_storage_flush_failed", {
          reason: args.reason,
          // The Error itself, so `logBridge` lifts it into the Sentry event and
          // the issue groups by the real failure; `errorText` keeps the
          // sentence on disk, which `JSON.stringify` writes an Error without.
          error,
          errorText: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        builtInBrowserService.dispose();
      } catch {
        // ignore
      }
      try {
        remoteUpdateInstaller?.dispose();
        builtInBrowserBridgeServer?.dispose();
      } catch {
        // ignore
      }
      try {
        appControlScreencastRecorder.dispose();
        chromiumDemoEngine.dispose();
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
          // The Error itself, so `logBridge` lifts it into the Sentry event and
          // the issue groups by the real failure; `errorText` keeps the
          // sentence on disk, which `JSON.stringify` writes an Error without.
          error,
          errorText: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Stop the producers, then let what is already in flight settle, then
        // dispose. The windows go first: their runtime event pump and status
        // polls are the calls that keep arriving, and `runImmediateProcessCleanup`
        // below disposes the pool they reach. What is left in flight is a call
        // that started before the quit — a `callSync` parked in a connect or a
        // service repair — and `drain()` lets it finish instead of answering it
        // with "the pool is disposed", an internal invariant reported to Sentry
        // as a defect. Bounded, so a brain that never answers still cannot hold
        // quit past the force timer.
        destroyWindowsForExit();
        await localRuntimePool.drain({ timeoutMs: 2_000 });
        // Sentry flushes alongside analytics: a crash that triggered this
        // shutdown is the report that must not be lost to the exit. On Windows the
        // brain this desktop spawned is asked to shut down in the same window, and
        // force-killed if it is still up after 3 s.
        await Promise.all([
          productAnalyticsService.shutdown(),
          flushSentry(2_000),
          localRuntimePool.stopOwnedRuntimeCooperatively(),
        ]);
        runImmediateProcessCleanup(`complete:${args.reason}`);
      }
    })().finally(() => {
      finalizeAppExit(exitCode);
    });
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

  /**
   * Runs one chat action across every project runtime this machine knows
   * about: in-process services in test, the runtime action channel in packaged
   * builds. Best-effort — an unreachable runtime contributes nothing. Answers
   * how many projects it asked, which is the only way a caller can tell "no
   * project answered" from "there was no project to ask".
   */
  const forEachProjectRuntime = async (
    run: (target: {
      projectName: string;
      projectRoot: string;
      inProcessService: AppContext["agentChatService"] | null;
    }) => Promise<void>,
    /** Projects with no tab open that the action must still reach. */
    extraRoots: Iterable<string> = [],
  ): Promise<number> => {
    if (shouldUseInProcessProjectRuntime()) {
      const contexts = Array.from(projectContexts.values());
      for (const ctx of contexts) {
        await run({
          projectName: labelForProjectRoot(ctx.project?.rootPath ?? ""),
          projectRoot: ctx.project?.rootPath ?? "",
          inProcessService: ctx.agentChatService,
        });
      }
      return contexts.length;
    }
    // An extra root comes from the brain and can spell an open project's path
    // differently (drive-letter case, slashes), so the set is keyed, not raw.
    const roots = new Map<string, string>();
    for (const root of [...rootsBoundToWindows(), ...projectContexts.keys(), ...extraRoots]) {
      const key = pathKey(root);
      if (!roots.has(key)) roots.set(key, root);
    }
    const targets = Array.from(roots.values());
    await Promise.all(targets.map(async (root) => {
      await run({ projectName: labelForProjectRoot(root), projectRoot: root, inProcessService: null });
    }));
    return targets.length;
  };

  /** The chat list a chat-domain action returned, or nothing. */
  const runtimeChatRefs = (result: unknown): AgentChatInterruptedChatRef[] => {
    const payload = result as { chats?: AgentChatInterruptedChatRef[] } | undefined;
    return Array.isArray(payload?.chats) ? payload.chats : [];
  };

  /**
   * Chats with a live turn in the projects open in a window, asked one project
   * at a time: all an in-process runtime has, and all a brain from before
   * `runtime.updateImpact` can answer.
   */
  const listOpenProjectChats = async (strict: boolean): Promise<UpdateInterruptedChat[]> => {
    const chats: UpdateInterruptedChat[] = [];
    await forEachProjectRuntime(async ({ projectName, projectRoot, inProcessService }) => {
      try {
        const refs = inProcessService
          ? runtimeChatRefs(await inProcessService.listInterruptedChats())
          : runtimeChatRefs((await localRuntimePool.callActionForRoot(projectRoot, {
              domain: "chat",
              action: "listInterruptedChats",
            })).result);
        for (const chat of refs) {
          chats.push({
            sessionId: chat.sessionId,
            title: chat.title,
            projectName,
            projectRoot,
            ...(chat.continueHold !== undefined ? { continueHold: chat.continueHold } : {}),
          });
        }
      } catch (error) {
        // Best-effort for the dialogs; a decision that stops agents needs every project.
        if (strict) throw error;
      }
    });
    return chats;
  };

  /**
   * Live chats for a decision that stops or resumes agents. Null when any
   * project could not answer in time, so "unknown" is never read as "none".
   */
  const collectLiveChatsOrNull = async (timeoutMs = 3_000): Promise<UpdateInterruptedChat[] | null> =>
    await settledWithin<UpdateInterruptedChat[] | null>(
      updateImpactProbe.liveChats({ strict: true }),
      timeoutMs,
      null,
    );

  // Arms one durable continue row per chat a restart interrupted: on the
  // launch that lands an install, with the ids the previous process persisted
  // (a freshly started brain has no live turns to discover), and after a
  // quit-prompt Repair.
  const armResumeForChats = async (
    chats: readonly Pick<UpdateInterruptedChat, "sessionId" | "projectRoot">[],
  ): Promise<UpdateInterruptedChat[]> => {
    if (chats.length === 0) return [];
    const sessionIds = chats.map((chat) => chat.sessionId);
    const armed: UpdateInterruptedChat[] = [];
    // A chat's project may have no tab open; its root is how the arm reaches it.
    const chatRoots = chats.flatMap((chat) => (chat.projectRoot ? [chat.projectRoot] : []));
    const projectsAsked = await forEachProjectRuntime(async ({ projectName, projectRoot, inProcessService }) => {
      try {
        const refs = inProcessService
          ? runtimeChatRefs(await inProcessService.armUpdateResume({ sessionIds }))
          : runtimeChatRefs((await localRuntimePool.callActionForRoot(projectRoot, {
              domain: "chat",
              action: "armUpdateResume",
              args: { sessionIds },
            })).result);
        for (const chat of refs) {
          armed.push({ sessionId: chat.sessionId, title: chat.title, projectName });
        }
      } catch (error) {
        localRuntimeLogger.warn("update_resume.arm_failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, chatRoots);
    // Nothing to ask is never a good answer: no project was reachable to ask,
    // and the continue row the user asked for is missing. Left unsaid, this is
    // exactly how a resume disappears without a trace. A chat that names its
    // own project is asked there directly, so a refusal shows up as
    // `update_resume.arm_failed` instead — a log dig looks for both.
    if (projectsAsked === 0) {
      localRuntimeLogger.warn("update_resume.arm_no_project", { chats: sessionIds.length });
    }
    return armed;
  };

  /**
   * Drops the sessions that actually armed from the persisted resume list, so
   * the next launch does not arm them a second time. Sessions whose project was
   * not reachable stay on the list and get another attempt on a later launch.
   */
  const consumeArmedResumeChats = (sessionIds: readonly string[]): void => {
    if (sessionIds.length === 0) return;
    const armed = new Set(sessionIds);
    try {
      const state = readGlobalState(globalStatePath);
      const installed = state.recentlyInstalledUpdate;
      const remaining = (installed?.resumedChats ?? []).filter((chat) => !armed.has(chat.sessionId));
      if (!installed || remaining.length === (installed.resumedChats?.length ?? 0)) return;
      const { resumedChats: _armed, ...installedWithoutResume } = installed;
      let nextInstalled: RecentlyInstalledUpdate | undefined;
      if (remaining.length > 0) {
        nextInstalled = { ...installed, resumedChats: remaining };
      } else if (shouldShowInstalledNotice(installed)) {
        // Nothing left to arm: the record stays for the installed notice, the
        // only thing it has left to say.
        nextInstalled = installedWithoutResume;
      } else {
        // Dismissed, and nothing left to arm: nothing keeps it here.
        nextInstalled = undefined;
      }
      writeGlobalState(globalStatePath, {
        ...state,
        recentlyInstalledUpdate: nextInstalled,
      });
    } catch {
      // Best-effort: a failed consume only means a later launch retries.
    }
  };

  /**
   * Arms one continue row per chat it is handed, and drops the ones that armed
   * from the record. Its contract is one call per launch: a chat armed twice
   * gets its row re-scheduled, and a row that has already fired tells the chat
   * to continue a second time. The single call site is in the launch, on the
   * far side of the update transaction that would refuse the runtime.
   */
  const armOwedResumes = async (
    owed: readonly Pick<UpdateInterruptedChat, "sessionId" | "projectRoot">[],
  ): Promise<void> => {
    const armed = await armResumeForChats(owed);
    consumeArmedResumeChats(armed.map((chat) => chat.sessionId));
  };

  // Phones connected through ADE phone sync, which drop while ADE restarts.
  // Mirrors the lane-delete quit probe: in-process services in dev, runtime
  // actions against the brain in packaged builds. Best-effort — an unreachable
  // runtime simply reports no phones.
  const collectConnectedPhones = async (): Promise<UpdateInstallImpact["connectedPhones"]> => {
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
    return Array.from(phonesById, ([deviceId, deviceName]) => ({ deviceId, deviceName }));
  };

  // What restarting ADE on this computer stops, for the update and quit
  // dialogs. In-process project runtimes (tests) have no brain to ask.
  const updateImpactProbe = createUpdateImpactProbe({
    logger: updateLogger,
    readMachineImpact: shouldUseInProcessProjectRuntime() ? null : () => localRuntimePool.updateImpact(),
    readMachineActivity: shouldUseInProcessProjectRuntime() ? null : () => localRuntimePool.activitySummary(),
    listOpenProjectChats,
    listConnectedPhones: collectConnectedPhones,
    readContinueAfterRestart: () => resolveContinueAfterRestart(),
  });

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

  const quitPrompt = createQuitPrompt({
    logger: localRuntimeLogger,
    globalStatePath,
    getRuntimeStatus: () => localRuntimePool.getStatus(),
    collectImpact: () => updateImpactProbe.collect(1_500),
    collectLiveChats: () => collectLiveChatsOrNull(),
    restartService: () => restartBrainForRepair(machineRecoveryService, productAnalyticsService),
    armResume: (chats) => armResumeForChats(chats),
  });
  registerBackgroundServiceControls({
    logger: localRuntimeLogger,
    analytics: productAnalyticsService,
    manageService: shouldRepairRuntimeServiceOnFallback,
    pool: localRuntimePool,
    collectLiveChats: () => collectLiveChatsOrNull(),
    getRunningLaneDeleteLabels,
    isRepairing: () => quitPrompt.isRepairing() || machineRecoveryService.isRecovering(),
    isShuttingDown: () => shutdownRequested,
    shutdown: (reason) => requestAppShutdown({ reason, exitCode: 0 }),
  });

  const confirmQuitWarning = async (
    ownerWindow: BrowserWindow | null | undefined,
    relaunch: boolean,
    plannedInstall: InstallOnQuitDecision | null = null,
  ): Promise<boolean> => {
    if (shutdownRequested || quitWarningAcknowledged) return true;
    const updateOnQuit = plannedInstall
      ? { version: plannedInstall.version, installs: plannedInstall.action === "install" }
      : null;
    if (!(await quitPrompt.confirm(ownerWindow, relaunch, { updateOnQuit }))) return false;
    quitWarningAcknowledged = true;
    return true;
  };

  const confirmCloseWindowWarning = (ownerWindow: BrowserWindow): boolean => {
    if (shutdownRequested) return true;
    const response = dialog.showMessageBoxSync(ownerWindow, {
      type: "question",
      buttons: ["Keep window open", "Close window"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Close ADE window?",
      message: "Close this ADE window?",
      detail: "ADE keeps running in your other windows.",
    });
    return response === 1;
  };

  const requestQuitAfterWarnings = (
    ownerWindow: BrowserWindow | null | undefined,
    reason: "before_quit" | "window_close" | "relaunch",
  ): Promise<boolean> => {
    // A repair started from the prompt holds the quit: quitting mid-repair
    // would stop the agents it is handing over.
    if (shutdownRequested || quitConfirmationInFlight || quitPrompt.isRepairing()) return Promise.resolve(false);
    quitConfirmationInFlight = true;
    // Resolves whether the person agreed, so "Restart ADE" can tell a restart
    // that is happening from one they cancelled.
    return (async () => {
      try {
        if (!(await confirmNoRunningLaneDeleteForQuit(ownerWindow))) return false;
        const plannedInstall = reason === "relaunch" ? null : await installOnQuit.plan();
        if (!(await confirmQuitWarning(ownerWindow, reason === "relaunch", plannedInstall))) return false;
        // Registered only once the user has agreed, so a cancelled restart
        // cannot turn a later plain quit into a relaunch. app.exit honors it.
        if (reason === "relaunch") app.relaunch();
        else if (await installOnQuit.install(plannedInstall)) return true;
        requestAppShutdown({ reason, exitCode: 0 });
        return true;
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
    if (shutdownRequested || autoUpdateService.isInstallQuitArmed()) return;
    if (closeWindowWithoutQuitPrompt.delete(win.id)) return;
    event.preventDefault();
    if (BrowserWindow.getAllWindows().filter((openWindow) => !openWindow.isDestroyed()).length > 1) {
      if (!confirmCloseWindowWarning(win)) return;
      closeWindowWithoutPrompt(win);
      return;
    }
    void requestQuitAfterWarnings(win, "window_close");
  };

  const FILE_LIMIT_CODES = new Set(["EMFILE", "ENFILE"]);
  let emfileWarned = false;
  // NOTE: a dead stdout/stderr pipe is handled by the targeted `error` listeners on
  // process.stdout/process.stderr at the top of this file. This handler deliberately does
  // NOT blanket-exempt EPIPE/ERR_STREAM_DESTROYED: those codes from any other subsystem
  // (writing to an exited child's stdin, a torn-down socket) are real faults and must be
  // logged rather than silently swallowed.
  process.on("uncaughtException", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (FILE_LIMIT_CODES.has(code)) return;
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
    const installQuit = autoUpdateService.isInstallQuitArmed();
    autoUpdateService.notifyQuitHandoffStarted();
    runImmediateProcessCleanup("will_quit");
    disposeSharedTranscriptionService();
    // The update installer's quit ends here instead of in finalizeAppExit.
    recordMainExit(shutdownReason ?? (installQuit ? "update_install" : "will_quit"), null);
  });

  try {
    const { recoverManagedOpenCodeOrphans } = require("./services/opencode/openCodeServer");
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
  // Cursor SDK workers a dead brain or a crashed main left behind. Only
  // workers whose owner is dead are touched.
  void recoverCursorSdkWorkerOrphans({ logger: getActiveContext().logger }).catch((error: unknown) => {
    getActiveContext().logger.warn("agent_chat.cursor_sdk_worker_orphan_sweep_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
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
  // Onboarding shows live fetch progress for the pinned agent CLIs; push it the
  // same way update progress is pushed rather than making the renderer poll.
  agentToolsCacheService.onStateChange((snapshot) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC.aiToolsCacheEvent, snapshot);
    });
  });

  const firstOpenWindowProjectRoot = (): string | null => {
    for (const win of BrowserWindow.getAllWindows()) {
      const root = windowProjectRoots.get(win.id);
      if (root) return root;
    }
    return null;
  };

  const assignWindowSession = (
    windowId: number,
    projectRoot: string | null,
    remoteBinding: RemoteOpenProjectBinding | null,
  ): void => {
    let normalizedRoot: string | null = null;
    if (!remoteBinding && projectRoot) {
      normalizedRoot = normalizeProjectRoot(projectRoot);
    }
    windowProjectRoots.set(windowId, normalizedRoot);
    windowProjectTabRoots.set(windowId, normalizedRoot ? new Set([normalizedRoot]) : new Set());
    rememberWindowKnownLocalProjectRoot(windowId, normalizedRoot);
    if (remoteBinding) {
      windowProjectBindings.set(windowId, remoteBinding);
    } else {
      windowProjectBindings.delete(windowId);
    }
  };

  const registerWindowSession = (
    win: BrowserWindow,
    projectRoot: string | null = null,
    remoteBinding: RemoteOpenProjectBinding | null = null,
  ): void => {
    assignWindowSession(win.id, projectRoot, remoteBinding);
    // The page's own focus also drops when a pane that is its own web view
    // (the built-in browser) takes focus; the OS window's does not. Sent on
    // every change and after each page load, so a reload starts truthful.
    const sendWindowFocus = (focused: boolean) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send(IPC.appWindowFocusChanged, focused);
    };
    win.on("blur", () => sendWindowFocus(false));
    win.webContents.on("did-finish-load", () => sendWindowFocus(win.isFocused()));
    win.on("focus", () => {
      sendWindowFocus(true);
      const focusedRemoteBinding = windowProjectBindings.get(win.id) ?? null;
      const focusedRoot = windowProjectRoots.get(win.id) ?? null;
      if (focusedRemoteBinding) {
        persistLastRemoteProjectBinding(focusedRemoteBinding);
      } else if (focusedRoot != null) {
        clearLastRemoteProjectBinding();
        setForegroundProject(focusedRoot);
        // Genuine window refocus (alt-tab back to an already-open project) doesn't
        // re-run bindWindowToProject, so schedule the catch-up reconcile here too —
        // otherwise a PR merged while ADE was unfocused stays stale until the user
        // switches projects. The per-project 90s throttle + single-flight guard
        // collapses refocus storms into at most one reconcile per window.
        scheduleReconcile(buildReconcileRunner(focusedRoot));
      } else if (!startupProjectOpen && (!activeProjectRoot || !rootsBoundToWindows().has(activeProjectRoot))) {
        // Focusing an unscoped window (e.g. a brand-new File > New Window) must
        // not clobber the foreground project — that would tear down background
        // services and break running work in other windows. Only re-derive the
        // foreground when the current one is no longer bound to any window.
        // The first window is unscoped while the launch opens its project; that
        // project is the foreground one, and the window is bound to it next.
        setForegroundProject(firstOpenWindowProjectRoot());
      }
      builtInBrowserService.attachToWindow(win);
    });
    /*
      A committed main-frame navigation replaces the subscriber with a page
      that has not mounted one yet — a dev reload, or the window being pointed
      at a different entry point. Forgetting the ack here is what keeps ⌘W from
      going dead for the second it takes React to come back.
    */
    win.webContents.on("did-navigate", () => {
      windowCommandSubscribers.delete(win.id);
    });
    win.webContents.on("render-process-gone", () => {
      windowCommandSubscribers.delete(win.id);
    });
    win.on("closed", () => {
      const previousRoot = windowProjectRoots.get(win.id) ?? null;
      windowCommandSubscribers.delete(win.id);
      windowProjectRoots.delete(win.id);
      windowProjectTabRoots.delete(win.id);
      windowKnownLocalProjectRoots.delete(win.id);
      windowPendingProjectRoots.delete(win.id);
      windowProjectBindings.delete(win.id);
      if (activeProjectRoot === previousRoot) {
        setForegroundProject(firstOpenWindowProjectRoot());
      }
      scheduleProjectContextRebalance();
      if (!autoUpdateService.isInstallQuitArmed()) persistUpdateWorkspace();
    });
  };

  const getWindowSession = (windowId: number | null): { windowId: number | null; project: ProjectInfo | null; binding: OpenProjectBinding | null; openProjectTabs: ProjectInfo[]; openProjectTabRoots: string[]; pendingLocalProjectRoots: string[]; knownLocalProjectRoots: string[] } => {
    if (windowId == null) {
      const project = projectForRoot(activeProjectRoot);
      return {
        windowId: null,
        project,
        binding: bindingForLocalProject(project),
        openProjectTabs: project ? [project] : [],
        openProjectTabRoots: project ? [project.rootPath] : [],
        pendingLocalProjectRoots: [],
        knownLocalProjectRoots: project ? [project.rootPath] : [],
      };
    }
    const knownLocalProjectRoots = Array.from(
      windowKnownLocalProjectRoots.get(windowId) ?? [],
    );
    // Every local tab the window shows, loaded or not. `openProjectTabs` lists
    // only projects with a live context, and an idle project's context can be
    // released while its tab stays open.
    const openProjectTabRoots = Array.from(windowProjectTabRoots.get(windowId) ?? []);
    const remoteBinding = windowProjectBindings.get(windowId) ?? null;
    if (remoteBinding) return {
      windowId,
      project: null,
      binding: remoteBinding,
      openProjectTabs: projectsForWindowTabs(windowId),
      openProjectTabRoots,
      pendingLocalProjectRoots: pendingProjectRootsForWindow(windowId),
      knownLocalProjectRoots,
    };
    const project = projectForRoot(windowProjectRoots.get(windowId) ?? null);
    return {
      windowId,
      project,
      binding: bindingForLocalProject(project),
      openProjectTabs: projectsForWindowTabs(windowId),
      openProjectTabRoots,
      pendingLocalProjectRoots: pendingProjectRootsForWindow(windowId),
      knownLocalProjectRoots,
    };
  };

  const openAdeWindow = async (
    args: {
      projectRoot?: string | null;
      /** Opens the window on a project that lives on another machine. */
      remoteBinding?: RemoteOpenProjectBinding | null;
      bounds?: { x: number; y: number; width: number; height: number };
      /** Fires once the window exists, before its project loads. */
      onWindow?: (win: BrowserWindow) => void;
    } = {},
  ): Promise<{ windowId: number | null; project: ProjectInfo | null }> => {
    const openWindows = BrowserWindow.getAllWindows().filter(
      (win) => !win.isDestroyed(),
    );
    const requestedRemote = args.remoteBinding
      ? sanitizeRendererProjectBinding(args.remoteBinding)
      : null;
    if (args.remoteBinding && requestedRemote?.kind !== "remote") {
      throw new Error("Invalid project binding.");
    }
    const restoredRemoteBinding =
      (requestedRemote?.kind === "remote" ? requestedRemote : null)
      ?? (args.projectRoot || openWindows.length > 0
        ? null
        : readLastRemoteProjectBinding());
    const win = await createWindow({
      logger: getActiveContext().logger,
      bounds: args.bounds,
      // A second window opens at the default spot, not on top of the first.
      restoreState: openWindows.length === 0 ? readSavedMainWindowState() : null,
      // A tab dragged out into its own window is not where ADE lives; only a
      // window opened the ordinary way records its place.
      onWindowStateChange: args.bounds ? undefined : saveMainWindowState,
      onRendererRecovery: reportRendererRecovery,
      onCreated: (createdWindow) => {
        attachWheelZoom(createdWindow);
        registerWindowSession(createdWindow, null, restoredRemoteBinding);
        args.onWindow?.(createdWindow);
      },
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
      const handledByOwner = await dispatchOwnerAwareNavigation(request, {
        getLocalMachineKey: () =>
          ipcBridge?.getLocalMachineIdentity().machineKey ?? "",
        resolveLocalProjectRoot: (projectId, projectRoot) =>
          resolveLocalProjectRoot(projectId, projectRoot, {
            candidates: () => [
              ...[...projectContexts.entries()]
                .map(([root, context]) => ({ root, projectId: context.projectId })),
              ...readLocalRecentProjects()
                .map(inspectRecentProject)
                // A remote recent has no local project id, and its root path
                // names a directory on the OTHER machine — resolving a local
                // destination against it would be a wrong answer, not a match.
                .filter((entry): entry is typeof entry & { projectId: string } =>
                  typeof entry.projectId === "string" && entry.projectId.length > 0)
                .map((entry) => ({
                  root: entry.summary.rootPath,
                  projectId: entry.projectId,
                })),
            ],
            pathsEqual,
            deriveProjectId,
          }),
        deliverLocal: async (projectRoot, ownedRequest) => {
          const delivered = await deliverAppNavigationToProject(
            projectRoot,
            ownedRequest,
          );
          if (!delivered.ok) throw new Error(delivered.message);
        },
        findRemote: (accountMachineKey, projectId, projectRoot) =>
          matchingRemoteProjectWindow(
            ipcBridge?.resolveTargetIdForMachineKey(accountMachineKey) ?? null,
            { projectId, rootPath: projectRoot },
          ),
        openRemote: async (accountMachineKey, projectId, projectRoot) => {
          // Never the focused window: a deeplink is a side errand, and rebinding
          // the window the user is working in throws away their project context.
          const win = await acquireRemoteAttentionHostWindow();
          if (!win || win.isDestroyed() || !ipcBridge) {
            throw new Error("No ADE window is available for the owning machine.");
          }
          const binding = await ipcBridge.openAttentionProject({
            machineKey: accountMachineKey,
            projectId,
            rootPath: projectRoot,
            machineName:
              ipcBridge.resolveTargetNameForMachineKey(accountMachineKey),
            windowId: win.id,
          });
          return matchingRemoteProjectWindow(binding.targetId, {
            projectId: binding.projectId,
            rootPath: binding.rootPath,
          }) ?? win;
        },
        deliverRemote: async (handle, ownedRequest) => {
          if (!(handle instanceof BrowserWindow) || handle.isDestroyed()) {
            throw new Error("The owning ADE window is no longer available.");
          }
          if (handle.isMinimized()) handle.restore();
          handle.show();
          handle.focus();
          handle.webContents.send(IPC.appNavigate, ownedRequest);
        },
      });
      if (handledByOwner) return;

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
      const ownership = appNavigationOwnership(request.target);
      getActiveContext().logger.warn("deeplink.dispatch_window_failed", {
        ...(ownership
          ? {
              accountMachineKey: ownership.accountMachineKey,
              projectId: ownership.projectId,
            }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      if (ownership) {
        const copy = ownerNavigationFailureCopy(error);
        void dialog.showMessageBox({
          type: "warning",
          buttons: ["OK"],
          title: copy.title,
          message: copy.message,
          detail: copy.detail,
        }).catch(() => {});
      }
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

  // Windows: the account read below decrypts the machine credential key in a
  // blocking PowerShell child (230-350 ms on this thread). Decrypt it here, off
  // the thread, and wait for it so that read finds the key cached. Started after
  // the dormant context above, so a key that context already read is not read
  // again. The read is read-only: a missing key is still created by the
  // synchronous path, as before. Open-file requests that arrive while this waits
  // queue in `pendingProjectOpenFiles`, because `handleProjectOpenFile` is set
  // after it.
  const accountKeyPrewarm = process.platform === "win32"
    ? readExistingOsBoundKeyMaterialAsync(machineAdeLayout.secretsDir).catch(() => null)
    : null;
  if (accountKeyPrewarm) await accountKeyPrewarm;
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

  const projectTabDrag = createProjectTabDragService({
    sanitizeBinding: sanitizeRendererProjectBinding,
    openWindow: ({ binding, bounds, onWindow }) =>
      binding.kind === "remote"
        ? openAdeWindow({ remoteBinding: binding, bounds, onWindow })
        : openAdeWindow({ projectRoot: binding.rootPath, bounds, onWindow }),
    closeWindow: (win) => closeWindowWithoutPrompt(win),
    sendAdopt: (target, request) => {
      if (!target.webContents.isDestroyed()) {
        target.webContents.send(IPC.appAdoptProjectTab, request);
      }
    },
  });

  const closeAdeWindow = async (windowId: number | null): Promise<{ closed: boolean }> => {
    if (windowId == null) return { closed: false };
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) return { closed: false };
    closeWindowWithoutPrompt(win);
    return { closed: true };
  };

  let nativeUpdateRunning = false;
  const runUpdateFromNativeUi = (win: BrowserWindow | null): void => {
    if (nativeUpdateRunning) return;
    nativeUpdateRunning = true;
    void runNativeUpdateInstall(autoUpdateService, win).finally(() => {
      nativeUpdateRunning = false;
    });
  };
  const installApplicationMenu = (): void => {
    /**
     * Every menu command the renderer gets first, on one route.
     *
     * Zoom (⌘+/−/0) follows the renderer so it takes the same path as the
     * in-app zoom counter (display %, persistence, macOS traffic-light inset);
     * ⌘F and ⌘W go down because Electron eats the accelerator in the browser
     * process and the built-in browser's page has focus in a *different*
     * WebContents, so a renderer keydown binding is shadowed on the packaged
     * app while passing every jsdom test. The renderer decides
     * (`lib/appCommandClaims`) and the app-wide default runs when nobody
     * claims. See `appCommandDispatch.ts` for the fallback rules — a window
     * with no ADE renderer, or one whose renderer cannot be shown to be alive,
     * runs `fallback` instead of losing the keystroke.
     */
    const sendAppCommand = appCommandSender;
    const sendZoomCommand = (
      command: AppZoomCommand,
      browserWindow?: Electron.BaseWindow,
    ): void => {
      sendAppCommand(
        { kind: "zoom", command },
        browserWindow instanceof BrowserWindow
          ? browserWindow
          : BrowserWindow.getFocusedWindow(),
      );
    };
    const sendMenuCommand = (
      command: AppMenuCommand,
      browserWindow: Electron.BaseWindow | undefined,
      fallback?: (win: BrowserWindow) => void,
    ): void => {
      sendAppCommand(
        { kind: "menu", command },
        browserWindow instanceof BrowserWindow
          ? browserWindow
          : BrowserWindow.getFocusedWindow(),
        fallback,
      );
    };
    const template: Electron.MenuItemConstructorOptions[] = [
      ...(process.platform === "darwin"
        ? [{
            label: app.name,
            submenu: [
              { role: "about" as const },
              nativeUpdateMenuItem(autoUpdateService.getSnapshot(), runUpdateFromNativeUi),
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
          {
            // Not `role: "close"`: inside the built-in browser ⌘W has to close
            // the browser TAB, and the last tab was previously unclosable
            // because this accelerator always beat the pane to the keystroke.
            label: "Close",
            accelerator: "CmdOrCtrl+W",
            click: (_item, browserWindow) =>
              sendMenuCommand("close-tab", browserWindow, (win) => win.close()),
          },
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
          { type: "separator" },
          {
            label: "Find…",
            accelerator: "CmdOrCtrl+F",
            click: (_item, browserWindow) => sendMenuCommand("find", browserWindow),
          },
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
          // The numeric keypad's +, - and 0 are separate keys to the
          // accelerator matcher; hidden twins give them the same zoom.
          ...([
            ["CmdOrCtrl+numadd", "in", "Zoom In"],
            ["CmdOrCtrl+numsub", "out", "Zoom Out"],
            ["CmdOrCtrl+num0", "reset", "Actual Size"],
          ] as const).map(([accelerator, command, label]): Electron.MenuItemConstructorOptions => ({
            label,
            accelerator,
            visible: false,
            acceleratorWorksWhenHidden: true,
            click: (_item, browserWindow) => sendZoomCommand(command, browserWindow),
          })),
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
  // The update item's label follows the updater; rebuild only when it changes.
  let nativeUpdateLabel = nativeUpdateMenuLabel(autoUpdateService.getSnapshot());
  autoUpdateService.onStateChange((snapshot) => {
    const label = nativeUpdateMenuLabel(snapshot);
    if (label === nativeUpdateLabel) return;
    nativeUpdateLabel = label;
    if (process.platform === "darwin") installApplicationMenu();
  });
  requestNativeUpdateInstall = () => runUpdateFromNativeUi(BrowserWindow.getFocusedWindow());
  if (nativeUpdateInstallPending) {
    nativeUpdateInstallPending = false;
    requestNativeUpdateInstall();
  }
  if (process.platform === "win32" && app.isPackaged) {
    // The taskbar's right-click menu: the Windows counterpart of the macOS menu item.
    app.setUserTasks([{
      program: process.execPath,
      arguments: INSTALL_UPDATE_ARG,
      iconPath: process.execPath,
      iconIndex: 0,
      title: "Install update and restart",
      description: "Install a downloaded ADE update, or check for one",
    }]);
  }

  let ipcBridge: ReturnType<typeof registerIpc> | null = null;
  const attentionAccountAuthService = getSharedAccountAuthService();
  accountAuthServiceForOwnerId = attentionAccountAuthService;
  const attentionRelayClient = createPushRelayClient({
    store: createPushRegistrationStore({
      filePath: resolvePushRelayStateFile(machineAdeLayout.secretsDir),
    }),
    logger: localRuntimeLogger,
    getAccountAccessToken: (options) =>
      getSignedInAccountAccessToken(attentionAccountAuthService, options),
    getAccountUserId: () => {
      const status = attentionAccountAuthService.getStatus();
      return status.signedIn ? status.userId?.trim() || null : null;
    },
  });

  /**
   * The live window whose remote binding satisfies `predicate`.
   *
   * The single place window bindings are scanned; who counts as a match is
   * `remoteBindingMatchesProject`'s business, not this loop's.
   */
  const matchingRemoteBindingWindow = (
    predicate: (binding: RemoteOpenProjectBinding) => boolean,
  ): BrowserWindow | null => {
    for (const [windowId, binding] of windowProjectBindings) {
      if (!predicate(binding)) continue;
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed()) return win;
    }
    return null;
  };

  /** A window already showing this remote project on this machine. */
  const matchingRemoteProjectWindow = (
    targetId: string | null,
    project: { projectId?: string | null; rootPath?: string | null },
  ): BrowserWindow | null => (
    targetId
      ? matchingRemoteBindingWindow(
        (binding) => remoteBindingMatchesProject(binding, project, targetId),
      )
      : null
  );

  const foregroundAttentionWindow = (win: BrowserWindow): void => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  /**
   * Bring ADE itself in front of other apps. Window show/focus alone does not
   * do this on macOS when the trigger came from outside ADE (a global capture
   * chord), so the window would come forward behind the app the user is in.
   */
  const activateAdeApp = (): void => {
    try {
      // `steal` is macOS-only; other platforms ignore it and rely on the
      // per-window show/focus that follows.
      app.focus({ steal: true });
    } catch {
      // Activation is best-effort: never let it break the navigation itself.
    }
  };

  /**
   * A window with no project of its own — safe to hand to a remote Activity
   * project without destroying anything the user had open.
   */
  const emptyAttentionHostWindow = (): BrowserWindow | null => {
    const focusedWindowId = BrowserWindow.getFocusedWindow()?.id ?? null;
    const windowId = selectRemoteHostWindow(
      BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed())
        .map((win) => ({
          id: win.id,
          hasRemoteBinding: windowProjectBindings.has(win.id),
          activeProjectRoot: windowProjectRoots.get(win.id) ?? null,
          openProjectRoots: windowProjectTabRoots.get(win.id) ?? new Set<string>(),
          focused: win.id === focusedWindowId,
        })),
    );
    if (windowId == null) return null;
    const win = BrowserWindow.fromId(windowId);
    return win && !win.isDestroyed() ? win : null;
  };

  /**
   * Where to put a remote project opened from Activity or a deeplink. Never a
   * window that already holds a project — rebinding one yanks the user's global
   * project context out from under them just because they clicked a
   * notification about another machine.
   */
  const acquireRemoteAttentionHostWindow = async (): Promise<BrowserWindow | null> => {
    const empty = emptyAttentionHostWindow();
    if (empty) return empty;
    const opened = await openAdeWindow();
    return opened.windowId == null ? null : BrowserWindow.fromId(opened.windowId);
  };

  const navigateFromAttentionItem = async (
    item: AttentionItem,
    request: AppNavigationRequest,
  ): Promise<void> => {
    const accountMachineKey = item.machine.accountMachineKey?.trim() ?? "";
    const localMachineKey = ipcBridge?.getLocalMachineIdentity().machineKey ?? "";
    const targetId = accountMachineKey
      ? ipcBridge?.resolveTargetIdForMachineKey(accountMachineKey) ?? null
      : null;
    const requiresRemoteMachine = Boolean(
      accountMachineKey
      && accountMachineKey !== localMachineKey,
    );
    // A canonical foreign-machine identity with no resolved target has no
    // window it may reuse: matching on root path alone would hand it a window
    // bound to a different host that happens to check the repo out at the same
    // path. Every other case names the machine it means, or means none.
    let remoteWindow = requiresRemoteMachine && !targetId
      ? null
      : matchingRemoteBindingWindow(
        (binding) => remoteBindingMatchesProject(binding, item.project, targetId),
      );

    if (requiresRemoteMachine && !remoteWindow) {
      // No window is showing this remote project yet, so give it one of its
      // own — a reusable empty window if there is one, otherwise a new window.
      const win = await acquireRemoteAttentionHostWindow();
      if (!win || win.isDestroyed() || !ipcBridge) {
        throw new Error("ADE could not open the remote Activity destination.");
      }
      const binding = await ipcBridge.openAttentionProject({
        machineKey: accountMachineKey,
        projectId: item.project.projectId,
        // The item's uuid is not an id this runtime knows; its root path is.
        rootPath: item.project.rootPath ?? null,
        machineName: item.machine.name,
        windowId: win.id,
      });
      remoteWindow = matchingRemoteProjectWindow(binding.targetId, item.project) ?? win;
    }

    if (remoteWindow) {
      foregroundAttentionWindow(remoteWindow);
      remoteWindow.webContents.send(IPC.appNavigate, request);
      return;
    }

    // A canonical foreign-machine identity must never fall through to a local
    // project with a coincidentally matching path.
    if (requiresRemoteMachine) {
      throw new Error("The owning ADE machine could not be connected.");
    }

    const projectRoot = item.project.rootPath?.trim() ?? "";
    if (projectRoot && fs.existsSync(projectRoot)) {
      const delivered = await deliverAppNavigationToProject(projectRoot, request);
      if (!delivered.ok) {
        throw new Error(delivered.message);
      }
      return;
    }

    dispatchOrQueueAppNavigationRequest(request);
  };

  /**
   * Where a capture lands. The order is `pickCaptureGestureWindow`; what main
   * adds is the liveness filter, which only Electron can answer.
   * `lastFocusedAdeWindowId` remembers the window the user was last in.
   */
  const captureGestureWindow = (): BrowserWindow | null => {
    const liveWindows = BrowserWindow.getAllWindows().filter(
      (win) => !win.isDestroyed() && !win.webContents.isDestroyed(),
    );
    const focused = BrowserWindow.getFocusedWindow();
    const candidate = pickCaptureGestureWindow({
      liveWindows,
      // A focused window that is mid-teardown is not a target.
      focused: focused && !focused.isDestroyed() && !focused.webContents.isDestroyed() ? focused : null,
      lastFocusedId: lastFocusedAdeWindowId,
    });
    if (!candidate || candidate.isDestroyed() || candidate.webContents.isDestroyed()) return null;
    return candidate;
  };

  /** Both halves live in services; main keeps only the call sites. */
  const reportCapture = (outcome: CaptureGestureOutcome): void =>
    reportCaptureGesture(productAnalyticsService, outcome);

  captureHelper = new CaptureHelper({
    executablePath: resolveCaptureHelperExecutablePath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    logger: getActiveContext().logger,
    // Under the OS temp root rather than userData: these PNGs are a handoff
    // between two processes that lasts milliseconds, and the supervisor deletes
    // each one as it reads it. `windows-uninstall-cleanup.ps1` sweeps the
    // directory for the case where ADE was killed in between.
    // Per channel, not shared. os.tmpdir() is per-user, so Stable, Beta and
    // Alpha all landed on one directory — and `dispose()` removes it, so
    // quitting one channel broke captures in another that was still running.
    outputDirectory: path.join(
      app.getPath("temp"),
      // `?? "stable"` alone put an unpackaged dev build in the installed
      // Stable build's directory — and `CaptureHelper.dispose()` deletes that
      // directory outright, so quitting one broke captures in the other.
      `ade-capture-${normalizeAdePackageChannel(process.env.ADE_PACKAGE_CHANNEL) ?? (app.isPackaged ? "stable" : "dev")}`,
    ),
    onShot: (shot: CaptureGestureShot) => {
      const target = captureGestureWindow();
      if (!target) return;
      const fitted = fitCaptureShotToAttachmentLimit(shot, {
        fromBuffer: (bytes) => nativeImage.createFromBuffer(bytes),
      });
      if (!fitted) {
        reportCapture("too_large");
        target.webContents.send(IPC.captureGestureFailed, {
          reason: "capture-failed",
          source: shot.source,
          message: "That screen is too large to attach, even scaled down.",
        } satisfies CaptureGestureFailure);
        return;
      }
      // Bring ADE forward BEFORE the event: the renderer's fly-in animation is
      // pointless behind another app's window, and the whole gesture means
      // "take me to the CTO with this".
      activateAdeApp();
      foregroundAttentionWindow(target);
      target.webContents.send(IPC.captureGestureShot, fitted);
      reportCapture("delivered");
    },
    onFailure: (failure: CaptureGestureFailure) => {
      const target = captureGestureWindow();
      if (!target) return;
      // A failure does NOT steal focus. The user pressed a chord over someone
      // else's window; yanking them into ADE to read "there was no window in
      // front" is worse than the failure.
      target.webContents.send(IPC.captureGestureFailed, failure);
      // The coarse fact only; `failure.reason` and its message stay local.
      reportCapture("failed");
    },
  });
  // The account bridge is available on the welcome screen, before any project
  // context has initialized the API-key service. Bind the machine credential
  // store once here so a sign-out from that screen still purges account keys.
  initApiKeyStore(path.dirname(machineAdeLayout.adeDir), {
    credentialStore: createDesktopCredentialStore(machineAdeLayout.secretsDir),
    getAccountUserId: () => getSharedAccountAuthService({
      secretsDir: machineAdeLayout.secretsDir,
    }).getStatus().userId,
    analytics: productAnalyticsService,
  });

  // Whether this Mac's ADE.app is root-owned (a password on every update).
  registerAppBundleOwnershipIpc({ logger: getMachineMainLogger(), analytics: productAnalyticsService });
  // The home page's clipboard, machine-health and weather widgets.
  registerHomeWidgetsIpc({
    logger: getMachineMainLogger(),
    // The brain: the ports widget never offers to stop it.
    runtimePids: () => [localRuntimePool.getStatus().pid],
  });
  // Now Playing also hears the built-in browser's tabs.
  connectBrowserToNowPlaying({
    browserTabIdFor: (wc) => {
      const found = builtInBrowserService.locateWebContents(wc);
      return found?.collection === "personal" ? found.tabId : null;
    },
  });

  // The Music tab: Apple Music through an on-demand player host, or Spotify as
  // a Connect remote. Each sign-in stays in its own encrypted file in this
  // app's user data (see musicTokenStore).
  registerMusicIpc({
    credentials: createMusicTokenStore({ dir: path.join(app.getPath("userData"), "music-player"), logger: getMachineMainLogger() }),
    spotifyCredentials: createMusicTokenStore({
      dir: path.join(app.getPath("userData"), "music-player"),
      fileName: "spotify-session.enc",
      serviceName: "Spotify",
      logger: getMachineMainLogger(),
    }),
    directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl({ secretsDir: machineAdeLayout.secretsDir }),
    getAccountToken: () => getSignedInAccountAccessToken(getSharedAccountAuthService({
      secretsDir: machineAdeLayout.secretsDir,
    })),
    logger: getMachineMainLogger(),
    onConnectOutcome: (outcome, provider) => captureFeatureUsedAnalytics({
      analytics: productAnalyticsService,
      surface: "desktop",
      feature: "home",
      action: provider === "spotify" ? "spotify_connected" : "music_connected",
      outcome,
    }),
  });

  // Keep-awake is machine-level in the brain, so Settings reaches it with no
  // project open through the machine method. Two brains cannot answer it:
  // - One that does not manage keep-awake (a dev brain on its own socket, an
  //   embedded one). Its projects cannot either, so this app's own service
  //   does the work (the IPC handler's fallback for a not-callable action).
  // - One from before the method, which takes it for a project method and asks
  //   for a project id. It answers through any project it has; with none,
  //   this app's own service does the work.
  const keepAwakeAction = async (action: string, args?: Record<string, unknown>): Promise<unknown> => {
    try {
      return await localRuntimePool.callSync("keepAwake.call", { action, args: args ?? {} });
    } catch (error) {
      // A brain without the service answers "not callable", which sends the
      // IPC handler to this app's own service.
      if (isUnsupportedAdeActionError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Method keepAwake\.call requires params\.projectId/.test(message)) throw error;
    }
    const projects = await localRuntimePool.projects();
    const rootPath = projects[0]?.rootPath;
    if (!rootPath) {
      throw codedError("This machine's brain can't manage keep-awake without a project.", ACTION_NOT_CALLABLE_CODE);
    }
    const response = await localRuntimePool.callActionForRoot(rootPath, {
      domain: "keep_awake",
      action,
      ...(args ? { args } : {}),
    });
    return response.result;
  };
  // ADE MCP is machine-level in the brain, so Settings reaches it with no
  // project open (a fresh install) through the machine method.
  const remoteMcpAction = async (action: string, args?: Record<string, unknown>): Promise<unknown> =>
    await localRuntimePool.callSync("remoteMcp.call", { action, args: args ?? {} });
  const migrateLegacyKeepAwakePreference = async (): Promise<boolean> => {
    const legacy = readGlobalState(globalStatePath).keepAwakePreferences;
    if (!legacy) {
      keepAwakeService.stopLegacyFallback();
      return true;
    }
    try {
      const result = await keepAwakeAction("migrateLegacyPreference", { level: legacy.level });
      if (!result || typeof result !== "object" || (result as { handled?: unknown }).handled !== true) return false;
      const current = readGlobalState(globalStatePath);
      if (current.keepAwakePreferences?.level === legacy.level) {
        const remaining = { ...current };
        delete remaining.keepAwakePreferences;
        writeGlobalState(globalStatePath, remaining);
      }
      keepAwakeService.stopLegacyFallback();
      return true;
    } catch (error) {
      updateLogger.warn("keepAwake.legacy_preference_migration_deferred", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
  if (readGlobalState(globalStatePath).keepAwakePreferences) {
    void migrateLegacyKeepAwakePreference();
  }

  ipcBridge = registerIpc({
    getCtx: () => {
      const ctx = getActiveContext();
      if (!ctx.autoUpdateService) {
        ctx.autoUpdateService = autoUpdateService;
      }
      if (!ctx.keepAwakeService) {
        ctx.keepAwakeService = keepAwakeService;
      }
      if (!ctx.keepAwakeAction) ctx.keepAwakeAction = keepAwakeAction;
      if (!ctx.remoteMcpAction) ctx.remoteMcpAction = remoteMcpAction;
      if (!ctx.keepAwakeMigrateLegacy) ctx.keepAwakeMigrateLegacy = migrateLegacyKeepAwakePreference;
      if (!ctx.agentToolsCacheService) {
        ctx.agentToolsCacheService = agentToolsCacheService;
      }
      if (!ctx.updateInstallImpactProvider) {
        // The update dialog opens on a click, so it can wait a little longer
        // for a real answer than a quit can.
        ctx.updateInstallImpactProvider = () => updateImpactProbe.collect(3_000);
      }
      return ctx;
    },
    getResourceUsageContexts: () => {
      const contexts = new Set<AppContext>(projectContexts.values());
      contexts.add(getActiveContext());
      return Array.from(contexts);
    },
    purgeClosedAccountCredentials: () => {
      const knownRoots = new Set<string>([
        ...readLocalRecentProjects().map((entry) => entry.rootPath),
        ...attemptedProjectRoots.list(),
      ]);
      for (const projectRoot of knownRoots) {
        const normalizedRoot = normalizeProjectRoot(projectRoot);
        if (projectContexts.has(normalizedRoot)) continue;
        const adeDir = resolveAdeLayout(normalizedRoot).adeDir;
        try {
          createProjectSecretService(normalizedRoot).purgeAccountCredentials();
        } catch (error) {
          getActiveContext().logger.warn("account.closed_project_secrets_purge_failed", {
            projectRoot: normalizedRoot,
            error: error instanceof Error ? error.message : String(error ?? ""),
          });
        }
        try {
          createLinearCredentialService({
            adeDir,
            credentialStore: createDesktopCredentialStore(path.join(adeDir, "secrets")),
          }).purgeAccountCredentials();
        } catch (error) {
          getActiveContext().logger.warn("account.closed_project_linear_purge_failed", {
            projectRoot: normalizedRoot,
            error: error instanceof Error ? error.message : String(error ?? ""),
          });
        }
      }
    },
    getSyncService: () => {
      return getMobileSyncService();
    },
    resolveSyncService: ensureMobileSyncService,
    runWithIpcWindow: (event, fn) =>
      ipcWindowScope.run(BrowserWindow.fromWebContents(event.sender)?.id ?? null, fn),
    getWindowSession,
    waitForStartupProjectOpen: () => startupProjectOpen ?? Promise.resolve(),
    getProjectContext: (projectRoot) =>
      projectContexts.get(normalizeProjectRoot(projectRoot)) ?? null,
    setWindowProjectTabs: rememberWindowProjectTabs,
    bindRemoteProject: bindWindowToRemoteProject,
    localRuntimeConnectionPool: shouldUseInProcessProjectRuntime()
      ? null
      : localRuntimePool,
    projectRecoveryConnectionPool: localRuntimePool,
    injectedProjectRecoveryService: machineRecoveryService,
    projectMoveController,
    onAccountRollupFetcherReady: (fetcher) => {
      machineAccountRollupFetcher = fetcher;
    },
    autoDiagnosticsService,
    createWindow: openAdeWindow,
    projectTabDrag,
    closeWindow: closeAdeWindow,
    switchProjectFromDialog,
    attemptedProjectRoots,
    closeCurrentProject,
    closeProjectByPath,
    globalStatePath,
    releaseRepository: packagedReleaseRepository,
    builtInBrowserService,
    productAnalyticsService,
    updateCaptureGestureSettings: (settings): CaptureGestureHealth => {
      captureHelper?.updateSettings(settings);
      return captureHelper?.getHealth() ?? UNAVAILABLE_CAPTURE_GESTURE_HEALTH;
    },
    getCaptureGestureHealth: (): CaptureGestureHealth =>
      captureHelper?.getHealth() ?? UNAVAILABLE_CAPTURE_GESTURE_HEALTH,
    retryCaptureGesture: (): CaptureGestureHealth =>
      captureHelper?.retry() ?? UNAVAILABLE_CAPTURE_GESTURE_HEALTH,
    captureGestureNow: (): boolean => captureHelper?.captureNow() ?? false,
    openAttentionItem: async (item: AttentionItem) => {
      await navigateFromAttentionItem(item, attentionItemNavigationRequest(item));
    },
    onAttentionAccountSnapshot: (snapshot) => desktopAlertPresenter.observeSnapshot(snapshot),
    onAttentionPreferences: (ownerId, preferences) => {
      attentionPreferencesForAlerts = { ownerId, preferences };
      desktopAlertPresenter.preferencesLoaded();
    },
    onAttentionSessionMuted: (ownerId, sessionId, muted) => {
      const cached = attentionPreferencesForAlerts;
      if (!cached || cached.ownerId !== ownerId) return;
      const others = cached.preferences.mutedSessionIds.filter((id) => id !== sessionId);
      attentionPreferencesForAlerts = {
        ownerId,
        preferences: {
          ...cached.preferences,
          mutedSessionIds: muted ? [...others, sessionId] : others,
        },
      };
    },
    openDesktopAlert: (itemId) => {
      const record = typeof itemId === "string" ? toastedDesktopAlerts.get(itemId) : undefined;
      if (!record) throw new Error("That notification is no longer available. Open the chat from Activity.");
      openDesktopAlert(record.alert, record.ownerId);
    },
    accountAttentionClient: attentionRelayClient,
    getCurrentAccountOwnerId: () => readAccountOwnerId(),
  });
  remoteArtifactRangeReader = ipcBridge.readRemoteArtifactRange;

  // Explicit project launches still bind a project before the renderer boots;
  // normal launches stay on the welcome/recent-project surface.

  registerPerfIpcHandlers();

  await projectMoveRecovery;
  const savedUpdateState = readGlobalState(globalStatePath);
  // A hidden quit-install launch opens no project: it closes once the service
  // is on the new build. The saved workspace stays for the next launch the
  // person makes. Revealed before this point, it opens as any launch does.
  const quitInstallLaunch = installOnQuit.isLaunchHidden();
  const updateWorkspaceRestore = selectUpdateWorkspaceRestore({
    restoreRequested: savedUpdateState.restoreUpdateWorkspaceOnLaunch === true && !quitInstallLaunch,
    explicitLaunch: shouldOpenStartupProject,
    saved: savedUpdateState.updateWorkspace,
    normalizeProjectPath: normalizeProjectRoot,
    isLikelyRepoRoot,
  });
  if (savedUpdateState.restoreUpdateWorkspaceOnLaunch && !quitInstallLaunch) {
    const cleared = readGlobalState(globalStatePath);
    writeGlobalState(globalStatePath, {
      ...cleared,
      restoreUpdateWorkspaceOnLaunch: false,
    });
  }
  // The launch that lands an install is the only one that arms a resume. The
  // previous process persisted the chats it interrupted into the pending
  // install, and reconcile has just moved them onto `recentlyInstalledUpdate`.
  // Arming here rather than at quit is what keeps a failed install harmless:
  // no landed install, no resumed chats, no rows.
  const resumedAfterUpdate = savedUpdateState.recentlyInstalledUpdate?.resumedChats ?? [];
  // The parts of this launch that reach a project. The wait below and the blocks
  // it guards read the same names, so the two cannot drift apart.
  const restoresUpdateWorkspace = updateWorkspaceRestore.localRoots.length > 0;
  const armsResume = resumedAfterUpdate.length > 0;
  // The launch's projects open while the first window is already on screen:
  // its renderer shows the "Starting ADE" splash until they settle (its window
  // session waits on `startupProjectOpen`), so there is no welcome-screen
  // flash, and no launch without a window while a project opens.
  const opensProjectsAtLaunch = shouldOpenStartupProject || restoresUpdateWorkspace || armsResume;
  const openLaunchProjects = async (): Promise<void> => {
    // The post-update transaction refuses every project while its update window is
    // open: opened during it, a project comes back as "ADE is applying an update"
    // and does not open at all. That costs the tab it was restoring and leaves the
    // resume with no project to ask — which is how a checked "resume chats" box
    // disappears without a trace. Only a launch that reaches a project waits; the
    // machine the transaction owns past the wait is one this launch cannot fix.
    if (postUpdateTransactionDone && (shouldOpenStartupProject || restoresUpdateWorkspace || armsResume)) {
      const transactionFinished = await settledWithin(
        postUpdateTransactionDone.then(() => true),
        POST_UPDATE_TRANSACTION_WAIT_MS,
        false,
      );
      if (!transactionFinished) {
        // An install slower than the wait. Everything below opens a project and
        // will be refused by the pool's still-open window, so this launch falls
        // back to what it did before the wait — the tabs the renderer restores
        // itself, and a project to open by hand — rather than holding the
        // window on its splash for as long as that install takes. The resume is
        // not part of that fallback: it opens no project, so it is still armed
        // below, the moment the transaction lets the pool go.
        updateLogger.warn("autoUpdate.post_update_transaction_wait_timeout", {
          waitMs: POST_UPDATE_TRANSACTION_WAIT_MS,
        });
      }
    }

    if (shouldOpenStartupProject && startupProject.rootPath) {
      try {
        await switchProjectFromDialog(startupProject.rootPath);
      } catch (error) {
        // The window asks for this once it loads and shows the recovery
        // screen, instead of a bare welcome screen with no word of why.
        if (isCodedError(error, "project_data_missing")) {
          machineRecoveryService.noteStartupProjectDataMissing(normalizeProjectRoot(startupProject.rootPath));
        }
        setForegroundProject(null);
        replaceDormantContext();
      }
    }

    if (restoresUpdateWorkspace) {
      const warmOrder = [
        ...updateWorkspaceRestore.localRoots.filter((root) => !pathsEqual(root, updateWorkspaceRestore.activeLocalRoot)),
        ...(updateWorkspaceRestore.activeLocalRoot ? [updateWorkspaceRestore.activeLocalRoot] : []),
      ];
      for (const root of warmOrder) {
        try {
          await switchProjectFromDialog(root);
        } catch {
          // A checkout that is gone stays off the restored tab strip.
        }
      }
    }
    if (armsResume) {
      // Armed once, when the pool can answer: with no update transaction running
      // that is now, and otherwise it is the moment that transaction lets go —
      // the same instant everything above needed, however long the install took.
      void (postUpdateTransactionDone ?? Promise.resolve())
        .then(() => armOwedResumes(resumedAfterUpdate))
        .catch((error: unknown) => {
          // The arm step logs its own failures, and the consume is best-effort
          // by design; this guards a throw neither expects. A resume is the last
          // thing that should go unsaid.
          localRuntimeLogger.warn("update_resume.arm_chain_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  };
  // Handled at once: the window is created while this runs, and a failure here
  // must be a log line, not an unhandled rejection.
  const startupProjectOpenTask = opensProjectsAtLaunch
    ? openLaunchProjects().catch((error: unknown) => {
      getActiveContext().logger.warn("startup.project_open_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    : null;
  // Released only once the first window is bound, so no window session can
  // answer between the opens settling and the bind.
  let releaseStartupWindow: () => void = () => {};
  if (startupProjectOpenTask) {
    startupProjectOpen = new Promise<void>((resolve) => {
      releaseStartupWindow = resolve;
    });
  }

  // Before the opens settle this is the saved remote binding when the launch
  // opens no local project; `bindLaunchWindow` corrects it afterwards.
  const initialRemoteProjectBinding =
    shouldOpenStartupProject || restoresUpdateWorkspace ? null : savedRemoteProjectBinding;
  const initialWindow = await createWindow({
    logger: getActiveContext().logger,
    restoreState: readSavedMainWindowState(),
    onWindowStateChange: saveMainWindowState,
    onRendererRecovery: reportRendererRecovery,
    onCreated: (createdWindow) => {
      attachWheelZoom(createdWindow);
      registerWindowSession(createdWindow, null, initialRemoteProjectBinding);
    },
    onCloseRequested: handleMainWindowCloseRequested,
    hidden: quitInstallLaunch,
  });
  if (quitInstallLaunch) {
    // Shown by anything (the person reopening ADE, a deep link, a notification),
    // a hidden quit-install launch stays open as an ordinary one.
    installOnQuit.finishLaunch({
      window: initialWindow,
      transactionDone: postUpdateTransactionDone ?? Promise.resolve(),
      readTransaction: () => autoUpdateService.getSnapshot().updateTransaction,
      anyWindowVisible: () => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible()),
      isShuttingDown: () => shutdownRequested,
      requestShutdown: () => requestAppShutdown({ reason: "update_installed_on_quit", exitCode: 0 }),
    });
  }
  // Binds the first window to what the launch opened, as it was bound when it
  // was created after the opens.
  const bindLaunchWindow = (): void => {
    const restoredLocalRoots = updateWorkspaceRestore.localRoots.filter((root) => projectForRoot(root) != null);
    const restoredActiveRoot = restoredLocalRoots.find((root) => pathsEqual(root, updateWorkspaceRestore.activeLocalRoot))
      ?? restoredLocalRoots[0]
      ?? null;
    const remoteBinding =
      shouldOpenStartupProject || restoredLocalRoots.length > 0 ? null : savedRemoteProjectBinding;
    const windowProjectRoot = remoteBinding
      ? null
      : shouldOpenStartupProject ? activeProjectRoot : restoredActiveRoot;
    if (initialWindow.isDestroyed()) return;
    assignWindowSession(initialWindow.id, windowProjectRoot, remoteBinding);
    if (restoredLocalRoots.length > 0) {
      rememberWindowProjectTabs(initialWindow.id, restoredLocalRoots);
    }
    // The opens made their project the foreground one already; this only
    // matters when another window's focus moved it meanwhile.
    if (windowProjectRoot && activeProjectRoot !== normalizeProjectRoot(windowProjectRoot)) {
      setForegroundProject(windowProjectRoot, { persistRecent: false });
    }
  };
  if (startupProjectOpenTask) {
    try {
      // Bounded: a project open that hangs (an unreachable mount, a brain that
      // stopped answering) must not hold the window on its splash. Past the
      // wait the window binds what has opened and the open finishes on its own.
      const opened = await settledWithin(
        startupProjectOpenTask.then(() => true),
        STARTUP_PROJECT_WINDOW_WAIT_MS,
        false,
      );
      if (!opened) {
        getActiveContext().logger.warn("startup.project_open_wait_exceeded", { waitMs: STARTUP_PROJECT_WINDOW_WAIT_MS });
        // The window answered without the project; give it the project once
        // the open lands, unless the user picked something meanwhile.
        void startupProjectOpenTask.then(() => {
          if (initialWindow.isDestroyed() || windowProjectRoots.get(initialWindow.id) || !activeProjectRoot) return;
          bindWindowToProject(initialWindow.id, activeProjectRoot, { emit: true, foreground: false });
        });
      }
      bindLaunchWindow();
    } finally {
      startupProjectOpen = null;
      releaseStartupWindow();
    }
  }
  builtInBrowserService.attachToWindow(initialWindow);
  initialWindowNavigationReady = true;
  drainPendingAppNavigationRequests();
  // Compile caches of earlier builds go once the first window is up. An explicit
  // ADE_COMPILE_CACHE_DIR or NODE_COMPILE_CACHE is the caller's directory, so it is left alone.
  if (!process.env.ADE_COMPILE_CACHE_DIR?.trim() && !process.env.NODE_COMPILE_CACHE?.trim()) {
    scheduleStaleCompileCachePrune(activeCompileCacheDir(), {
      onPruned: (removed) => logMachineEvent("info", "compile_cache.pruned", { removed }),
    });
  }
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
    // A hidden quit-install launch is revealed by its own listener above.
    if (BrowserWindow.getAllWindows().length === 0) {
      await openAdeWindow();
    }
  });

  app.on("before-quit", (event) => {
    if (shutdownFinalized) return;
    if (autoUpdateService.isInstallQuitArmed()) {
      quitWarningAcknowledged = true;
      return;
    }
    event.preventDefault();
    if (shutdownRequested) return;
    void requestQuitAfterWarnings(null, "before_quit");
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
