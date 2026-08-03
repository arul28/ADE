import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAgentChatTurnRecoveryAction } from "../../../../desktop/src/shared/types/chat";
import { runWithAbortSignal } from "./abortSignal";
import type {
  AgentChatCreateArgs,
  AgentChatCreateScheduledWorkArgs,
  AgentChatAcceptCrossMachineHandoffArgs,
  AgentChatArchiveArgs,
  AgentChatClaudePermissionMode,
  AgentChatTranscriptEntry,
  AgentChatEventHistorySnapshot,
  AgentChatApproveArgs,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCodexClearGoalArgs,
  AgentChatCodexGetGoalArgs,
  AgentChatCodexSetGoalArgs,
  AgentChatCodexSetGoalStatusArgs,
  AgentChatContextUsageArgs,
  AgentChatCrossMachineDestinationPreflightArgs,
  AgentChatDroidPermissionMode,
  AgentChatFileRef,
  AgentChatGetSummaryArgs,
  AgentChatGetTurnFileDiffArgs,
  AgentChatHandoffArgs,
  AgentChatLaunchArgs,
  AgentChatListArgs,
  AgentChatMainTranscriptArgs,
  AgentChatModelCatalogArgs,
  AgentChatSuggestLaneNameArgs,
  AgentChatModelCatalogMode,
  AgentChatModelCatalogRefreshProvider,
  AgentChatOpenCodePermissionMode,
  AgentChatParallelLaunchState,
  AgentChatParallelLaunchStateArgs,
  AgentChatPermissionMode,
  AgentChatPrepareCrossMachineHandoffArgs,
  AgentChatMarkCrossMachineHandoffArgs,
  AgentChatProvider,
  AgentChatRewindFilesArgs,
  AgentChatRespondToInputArgs,
  AgentChatSendArgs,
  AgentChatSetParallelLaunchStateArgs,
  AgentChatValidateCrossMachineSourceArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSlashCommandsArgs,
  AgentChatSteerArgs,
  AgentChatSubagentListArgs,
  AgentChatSubagentTranscriptArgs,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatDispatchSteerArgs,
  AgentChatCancelDispatchedSteerArgs,
  AgentChatInterruptArgs,
  AgentChatRestoreCancelledQueueArgs,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverTurnArgs,
  AgentChatResolveUnprocessedMessageArgs,
  AgentChatUpdateSessionArgs,
  AddGitHubPrStackPullRequestsArgs,
  AddPrCommentArgs,
  AiReviewSummaryArgs,
  ApplyLaneTemplateArgs,
  ArchiveLaneArgs,
  ChatTerminalActiveForChatArgs,
  ChatTerminalListArgs,
  ClosePrArgs,
  CleanupPrBranchArgs,
  CtoIdentity,
  CreateChildLaneArgs,
  CommitIntegrationArgs,
  CreateLaneArgs,
  CreateLaneFromPrBranchArgs,
  CreateLaneFromUnstagedArgs,
  CreatePrFromLaneArgs,
  CreateIntegrationLaneForProposalArgs,
  CreateGitHubPrStackArgs,
  CleanupIntegrationWorkflowArgs,
  DeleteLaneArgs,
  DeletePrArgs,
  DeleteIntegrationProposalArgs,
  DismissIntegrationCleanupArgs,
  DraftPrDescriptionArgs,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GitBatchFileActionArgs,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCreateTagArgs,
  GitFileActionArgs,
  GitGenerateCommitMessageArgs,
  GitGetCommitMessageArgs,
  GitGetFileHistoryArgs,
  GitCheckoutBranchArgs,
  GitListBranchesArgs,
  GitListCommitFilesArgs,
  GitPullArgs,
  GitPullMode,
  GitPushArgs,
  GitResetCommitArgs,
  GitRevertArgs,
  GitGetUserIdentityArgs,
  GitHubRepoRef,
  GitHubStatus,
  GitStashPushArgs,
  GitStashRefArgs,
  GitSyncArgs,
  ImportBranchLaneArgs,
  LandPrArgs,
  LinearConnectionStatus,
  PersonalChatScopeContract,
  PrGithubCoords,
  PublishProjectInput,
  PublishProjectResult,
  ProjectConfigCandidate,
  ProjectConfigFile,
  ProjectConfigSnapshot,
  LaneEnvInitConfig,
  LaneEnvInitProgress,
  LaneDetailPayload,
  LaneListSnapshot,
  LaneOverlayOverrides,
  LaneStateSnapshotSummary,
  ListLanesArgs,
  ListIntegrationWorkflowsArgs,
  ListGitHubPrStacksArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  LinkPrToLaneArgs,
  PostPrReviewCommentArgs,
  PrAgentPermissionMode,
  PrAiResolutionContext,
  PrAiResolutionGetSessionArgs,
  PrAiResolutionGetSessionResult,
  PrAiResolutionSessionInfo,
  PrAiResolutionSessionStatus,
  PrAiResolutionStartArgs,
  PrAiResolutionStartResult,
  RebasePushArgs,
  RebaseStartArgs,
  RenameLaneArgs,
  ReopenPrArgs,
  RecheckIntegrationStepArgs,
  ReactToPrCommentArgs,
  ReplyToPrReviewThreadArgs,
  ReparentLaneArgs,
  RequestPrReviewersArgs,
  RerunPrChecksArgs,
  SetPrLabelsArgs,
  SetPrReviewThreadResolvedArgs,
  SimulateIntegrationArgs,
  StartIntegrationResolutionArgs,
  SubmitPrReviewArgs,
  UnstackGitHubPrStackArgs,
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
  ExternalSessionListArgs,
  ExternalSessionProvider,
  ExternalSessionSummary,
  SyncImportExternalSessionArgs,
  SyncImportExternalSessionResult,
  SyncListExternalSessionsArgs,
  SyncListExternalSessionsResult,
  SyncCommandPayload,
  SyncRemoteCommandAction,
  SyncRemoteCommandDescriptor,
  SyncRemoteCommandPolicy,
  SyncPairingConnectInfo,
  SyncSendToSessionArgs,
  SyncSendToSessionResult,
  SyncStartCliSessionArgs,
  SyncStartCliSessionResult,
  SyncWebPairingInfo,
  SyncRunQuickCommandArgs,
  LaneBranchDriftResolution,
  SessionSettleOverride,
  SessionWakeReason,
  UpdateSessionMetaArgs,
  UpdateIntegrationProposalArgs,
  TerminalToolType,
  UpdateBranchArgs,
  UpdateLaneAppearanceArgs,
  UpdatePrBodyArgs,
  UpdatePrTitleArgs,
  WriteTextAtomicArgs,
} from "../../../../desktop/src/shared/types";
import { isAdeUsageRangePreset, isAdeUsageScope } from "../../../../desktop/src/shared/types";
import {
  parseSessionSettleOverride,
  SESSION_WAKE_REASONS,
} from "../../../../desktop/src/shared/types";
import type { OrchestrationRunCreateRequest } from "../../../../desktop/src/shared/types/orchestration";
import {
  PERSONAL_CHAT_ACTIONS,
  isPersonalChatActionQueueable,
  isPersonalChatActionViewerAllowed,
} from "../../../../desktop/src/shared/types/personalChats";
import {
  buildTrackedCliLaunchCommand,
  deriveTrackedCliInitialInputSessionMeta,
  isLaunchProfile,
  isTrackedCliPermissionMode,
  LAUNCH_PROFILE_TITLE,
  LAUNCH_PROFILE_TOOL_TYPE,
  resolveCleanShellLaunchFields,
  validateLaunchProfilePermissionMode,
  type TrackedCliLaunchCommand,
} from "../../../../desktop/src/shared/cliLaunch";
import { parseDeeplink, type ParseError } from "../../../../desktop/src/shared/deeplinks";
import { buildPairingQrPayload } from "../../../../desktop/src/shared/pairingQr";
import { buildWebClientPairUrl } from "../../../../desktop/src/shared/webClientUrl";
import { buildPrAiResolutionContextKey } from "../../../../desktop/src/shared/types";
import { getModelById } from "../../../../desktop/src/shared/modelRegistry";
import {
  PUSH_GET_STATUS_ACTION,
  PUSH_REGISTER_DEVICE_ACTION,
  PUSH_REPORT_LIVE_ACTIVITY_TOKEN_ACTION,
  PUSH_SET_PREFS_ACTION,
  PUSH_UNREGISTER_DEVICE_ACTION,
  type PushDeliveryStatus,
  type PushDeviceRegistration,
  type PushLiveActivityTokenReport,
  type PushNotificationPrefs,
  type PushQuietHours,
} from "../../../../desktop/src/shared/types/push";
import type { PushPublisherService } from "../push/pushPublisherService";
import { deriveDeterministicLaneNameFromPrompt } from "../../../../desktop/src/shared/laneNameFallback";
import { resolveLaneCreateRemoteBase } from "../laneCreateRemoteBase";
import { normalizePrCreationStrategy } from "../../../../desktop/src/shared/prStrategy";
import { readImageFileAndSniffMime, saveImageTempAttachment } from "../imageAttachment";
import { buildAiSettingsStatus, getUnavailableAiStatus, isDatabaseClosedError } from "../../../../desktop/src/main/services/ai/aiSettingsStatus";
import type { createAiIntegrationService } from "../../../../desktop/src/main/services/ai/aiIntegrationService";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import { resolveSmartLinkPreview } from "../../../../desktop/src/main/services/chat/smartLinkPreviewService";
import { resolveCodexComputerUseMcpConfig } from "../../../../desktop/src/main/utils/codexComputerUse";
import type { createCtoStateService } from "../../../../desktop/src/main/services/cto/ctoStateService";
import type { CtoMemoryService } from "../../../../desktop/src/main/services/cto/ctoMemoryService";
import type { createLinearCredentialService } from "../../../../desktop/src/main/services/cto/linearCredentialService";
import {
  LINEAR_MOBILE_OAUTH_REDIRECT_URI,
  type createLinearOAuthService,
} from "../../../../desktop/src/main/services/cto/linearOAuthService";
import type { createLinearIssueTracker } from "../../../../desktop/src/main/services/cto/linearIssueTracker";
import { matchLaneOverlayPolicies } from "../../../../desktop/src/main/services/config/laneOverlayMatcher";
import type { createProjectConfigService } from "../../../../desktop/src/main/services/config/projectConfigService";
import type { createConflictService } from "../../../../desktop/src/main/services/conflicts/conflictService";
import { appendDiffTruncationNotice, MAX_DIFF_SIDE_TEXT_BYTES, type createDiffService } from "../../../../desktop/src/main/services/diffs/diffService";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import { runGit } from "../../../../desktop/src/main/services/git/git";
import type { createGitOperationsService } from "../../../../desktop/src/main/services/git/gitOperationsService";
import type { createGithubService } from "../../../../desktop/src/main/services/github/githubService";
import type { createOperationService } from "../../../../desktop/src/main/services/history/operationService";
import type { createAutoRebaseService } from "../../../../desktop/src/main/services/lanes/autoRebaseService";
import type { createLaneEnvironmentService } from "../../../../desktop/src/main/services/lanes/laneEnvironmentService";
import { restoreRecreatedLaneRuntime } from "../../../../desktop/src/main/services/lanes/laneRuntimeLifecycle";
import type { createLaneService } from "../../../../desktop/src/main/services/lanes/laneService";
import type { createLaneTemplateService } from "../../../../desktop/src/main/services/lanes/laneTemplateService";
import type { createPortAllocationService } from "../../../../desktop/src/main/services/lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../../../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { createOrchestrationDomainService } from "../../../../desktop/src/main/services/orchestration/orchestrationDomain";
import type { createOrchestrationService } from "../../../../desktop/src/main/services/orchestration/orchestrationService";
import type { createPrService } from "../../../../desktop/src/main/services/prs/prService";
import type { createPrSummaryService } from "../../../../desktop/src/main/services/prs/prSummaryService";
import type { createPtyService } from "../../../../desktop/src/main/services/pty/ptyService";
import type { createUsageTrackingService } from "../../../../desktop/src/main/services/usage/usageTrackingService";
import type { ProductAnalyticsService } from "../../../../desktop/src/main/services/analytics/productAnalyticsService";
import { parseProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";
import { deleteTerminalSessionWithRuntimeCleanup } from "../../../../desktop/src/main/services/sessions/deleteTerminalSession";
import { settleTerminalSession } from "../../../../desktop/src/main/services/sessions/settleTerminalSession";
import type { createSessionDeltaService } from "../../../../desktop/src/main/services/sessions/sessionDeltaService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import { getSharedModelPickerStore, type ModelPickerStore } from "../modelPickerStore";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { getErrorMessage, resolvePathWithinRoot } from "../../../../desktop/src/main/services/shared/utils";
import { sanitizeResumeTargetId } from "../../../../desktop/src/main/utils/terminalSessionSignals";
import type { SyncPinStore } from "./syncPinStore";

export type ExternalSessionsRemoteService = {
  list(args?: ExternalSessionListArgs): Promise<ExternalSessionSummary[]>;
  importExternalSession(args: ExternalSessionImportArgs): Promise<ExternalSessionImportResult>;
};

const EXTERNAL_SESSION_PROVIDERS = new Set<ExternalSessionProvider>([
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
]);

type SyncRemoteCommandServiceArgs = {
  /**
   * Per-project cr-sqlite DB. Source of truth for the model-picker store
   * (favorites + recents) when no explicit `getModelPickerStore` accessor is
   * wired, so the sync host never falls back to an empty store in production.
   * Optional only so unit tests that never touch `modelPicker.*` can omit it;
   * production callers (bootstrap, syncHostService) always pass it.
   */
  db?: AdeDb;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  productAnalyticsService?: ProductAnalyticsService | null;
  projectRoot?: string;
  laneService: ReturnType<typeof createLaneService>;
  prService: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
  ptyService: ReturnType<typeof createPtyService>;
  sessionService: ReturnType<typeof createSessionService>;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
  fileService: ReturnType<typeof createFileService>;
  gitService?: ReturnType<typeof createGitOperationsService>;
  githubService?: ReturnType<typeof createGithubService> | null;
  diffService?: ReturnType<typeof createDiffService>;
  conflictService?: ReturnType<typeof createConflictService>;
  operationService?: ReturnType<typeof createOperationService> | null;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  agentChatService?: ReturnType<typeof createAgentChatService>;
  personalChatScope?: Pick<PersonalChatScopeContract, "call" | "streamEvents">;
  orchestrationService?: ReturnType<typeof createOrchestrationService> | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  ctoMemoryService?: CtoMemoryService | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearOAuthService?: ReturnType<typeof createLinearOAuthService> | null;
  /**
   * Resolvers for services created after createSyncService in main.ts.
   * Router handlers read them lazily so init order is not load-bearing.
   */
  getLinearIssueTracker?: () => ReturnType<typeof createLinearIssueTracker> | null;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  portAllocationService?: ReturnType<typeof createPortAllocationService> | null;
  laneEnvironmentService?: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService?: ReturnType<typeof createLaneTemplateService> | null;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
  externalSessionsService?: ExternalSessionsRemoteService | null;
  getExternalSessionsService?: () => ExternalSessionsRemoteService | null;
  /**
   * Deterministic stamp of the sync host's in-memory lane presence
   * (`devicesOpen`). The host decorates lane list/detail payloads with
   * presence AFTER this service builds them, so the conditional-response
   * signatures fold the stamp in — otherwise a presence-only change (another
   * device opening a lane) would keep matching `ifNoneMatch` and the client
   * would hold a stale presence indicator until an unrelated lane change.
   */
  getLanePresenceStamp?: () => string;
  /**
   * Lazy accessor for the model picker store (favorites + recents, backed by
   * the per-project cr-sqlite DB). iOS hits these via the `modelPicker.*` sync
   * commands so favorites/recents stay in sync with desktop + TUI. Optional —
   * when unset, handlers fall back to the per-db shared store built from
   * `args.db`, so the sync host always reads/writes the real DB rather than an
   * empty stub.
   */
  getModelPickerStore?: () => ModelPickerStore | null;
  /**
   * Optional handler for the `deeplinks.open` sync command. iOS uses this to
   * bounce a cross-machine `ade://...` or `https://ade-app.dev/open?...` URL
   * to the paired desktop ("Send to your Mac"). Desktop main.ts wires this up
   * to parseDeeplink +
   * appNavigationService; in the ade-cli/runtime context (no desktop windows
   * present) the handler is intentionally unset and the command returns a
   * clear "not available" error.
   */
  dispatchDeeplinkUrl?: (url: string) => Promise<{ ok: boolean; message?: string }>;
  /**
   * Brain→push-relay publisher. When present, the `push.*` runtime commands
   * hand device registrations / prefs / Live Activity tokens to it; when absent
   * (e.g. sync host with push publishing off) the commands no-op with a clear
   * error so the phone can surface "push publishing is not running".
   */
  pushPublisherService?: PushPublisherService | null;
  /**
   * Machine-level pairing PIN store. Required by `sync.getWebPairingInfo`,
   * which only runs after the paired command channel is authenticated.
   */
  syncPinStore?: SyncPinStore | null;
  /**
   * Builds the same connect info advertised by sync status / pairing QR,
   * including direct address candidates and the optional relay candidate.
   */
  getPairingConnectInfo?: () => SyncPairingConnectInfo | null;
  /** Issues a short-lived one-time grant for the desktop runtime channels. */
  issueRuntimeHostPairingGrant?: () => string;
  /** Whether the account-gated machine relay is currently available. */
  isCloudRelayEnabled?: () => boolean;
  logger: Logger;
};

export type SyncRemoteCommandExecutionContext = {
  signal?: AbortSignal;
};

type RegisteredRemoteCommand = {
  descriptor: SyncRemoteCommandDescriptor;
  observesAbort: boolean;
  handler: (
    args: Record<string, unknown>,
    context: SyncRemoteCommandExecutionContext,
  ) => Promise<unknown>;
};

export const AI_STATUS_REMOTE_COMMAND_TIMEOUT_MS = 30_000;

async function runAiStatusWithTimeout<T>(
  run: () => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(
      `ai.getStatus timed out after ${AI_STATUS_REMOTE_COMMAND_TIMEOUT_MS}ms.`,
    );
    error.name = "TimeoutError";
    controller.abort(error);
  }, AI_STATUS_REMOTE_COMMAND_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await runWithAbortSignal(
      run,
      controller.signal,
      "Remote command aborted.",
    );
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatDeeplinkParseError(error: ParseError): string {
  switch (error.kind) {
    case "malformed":
      return error.reason;
    case "unsupported_scheme":
      return `unsupported scheme '${error.scheme}'`;
    case "unsupported_host":
      return `unsupported host '${error.host}'`;
    case "unknown_type":
      return `unknown type '${error.type}'`;
    case "empty":
      return error.kind;
  }
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function payloadSignature(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Conditional-response envelope shared by the lane list/detail commands: when
 * the caller's ifNoneMatch equals the current payload signature, return the
 * lightweight notModified shell instead of the full payload. The full payload
 * is still computed (the signature comes from it), so this saves transport and
 * client decode/DB work, not host compute.
 */
function respondWithSignature<T extends object, E extends object>(
  response: T,
  ifNoneMatch: string | null | undefined,
  emptyResponse: E,
  signatureSalt = "",
): (T | E) & { signature: string; notModified: boolean } {
  // The salt folds host-decorated state (lane presence) into the signature so
  // a presence-only change invalidates the client's cached copy even though
  // the undecorated payload is byte-identical.
  const signature = payloadSignature(signatureSalt ? { response, signatureSalt } : response);
  if (ifNoneMatch && ifNoneMatch === signature) {
    return { ...emptyResponse, signature, notModified: true };
  }
  return { ...response, signature, notModified: false };
}

function asConfidenceThreshold(value: unknown): number | undefined {
  const numeric = asOptionalNumber(value);
  if (numeric == null) return undefined;
  if (numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function asNullableTrimmedString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return asTrimmedString(value) ?? undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asTrimmedString(entry)).filter((entry): entry is string => Boolean(entry));
}

function emptyLinearQuickView(connection: Record<string, unknown>) {
  return {
    connection,
    organization: null,
    viewer: null,
    projects: [],
    teams: [],
    assignedIssues: [],
    recentIssues: [],
    fetchedAt: new Date().toISOString(),
    sdk: { packageName: "@linear/sdk", surfaces: [] },
  };
}

async function getConnectedLinearIssueTracker(
  args: SyncRemoteCommandServiceArgs,
): Promise<ReturnType<typeof createLinearIssueTracker> | null> {
  const credentialStatus = args.linearCredentialService?.getStatus() ?? {
    tokenStored: false,
  };
  if (!credentialStatus.tokenStored) return null;
  const linearIssueTracker = args.getLinearIssueTracker?.() ?? null;
  if (!linearIssueTracker) return null;
  const status = await linearIssueTracker.getConnectionStatus().catch(() => null);
  return status?.connected ? linearIssueTracker : null;
}

function buildDisconnectedLinearConnectionStatus(
  args: SyncRemoteCommandServiceArgs,
  message: string,
): LinearConnectionStatus {
  const credentialStatus = args.linearCredentialService?.getStatus() ?? {
    tokenStored: false,
    authMode: null,
    tokenExpiresAt: null,
    oauthConfigured: false,
  };
  return {
    tokenStored: Boolean(credentialStatus.tokenStored),
    connected: false,
    viewerId: null,
    viewerName: null,
    organizationId: null,
    organizationName: null,
    organizationUrlKey: null,
    organizationLogoUrl: null,
    checkedAt: new Date().toISOString(),
    authMode: credentialStatus.authMode,
    oauthAvailable: credentialStatus.oauthConfigured,
    tokenExpiresAt: credentialStatus.tokenExpiresAt,
    message,
  };
}

async function buildLinearConnectionStatus(
  args: SyncRemoteCommandServiceArgs,
  messageOverride?: string,
): Promise<LinearConnectionStatus> {
  const credentialStatus = args.linearCredentialService?.getStatus() ?? {
    tokenStored: false,
    authMode: null,
    tokenExpiresAt: null,
    oauthConfigured: false,
  };
  const tokenStored = Boolean(credentialStatus.tokenStored);
  const checkedAt = new Date().toISOString();
  const linearIssueTracker = args.getLinearIssueTracker?.() ?? null;
  if (!linearIssueTracker || !tokenStored) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt,
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: messageOverride ?? (tokenStored ? "Linear tracker service unavailable." : "Linear token not configured."),
    };
  }
  const status = await linearIssueTracker.getConnectionStatus();
  return {
    tokenStored,
    connected: status.connected,
    viewerId: status.viewerId,
    viewerName: status.viewerName,
    organizationId: status.organizationId,
    organizationName: status.organizationName,
    organizationUrlKey: status.organizationUrlKey,
    organizationLogoUrl: status.organizationLogoUrl,
    checkedAt,
    authMode: credentialStatus.authMode,
    oauthAvailable: credentialStatus.oauthConfigured,
    tokenExpiresAt: credentialStatus.tokenExpiresAt,
    message: messageOverride ?? status.message,
  };
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, entry]) => [key.trim(), typeof entry === "string" ? entry.trim() : ""] as const)
    .filter(([key, entry]) => key.length > 0 && entry.length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function parseAgentChatFileRefs(value: unknown): AgentChatFileRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: AgentChatFileRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = asTrimmedString(entry.path);
    let type: "image" | "file" | null = null;
    if (entry.type === "image") type = "image";
    else if (entry.type === "file") type = "file";
    if (!path || !type) continue;
    attachments.push({ path, type });
  }
  return attachments;
}

function parseCursorConfigValues(
  value: unknown,
): AgentChatUpdateSessionArgs["cursorConfigValues"] | AgentChatCreateArgs["cursorConfigValues"] {
  if (value == null) return null;
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string | boolean | number] => (
        typeof entry[1] === "string"
        || typeof entry[1] === "boolean"
        || (typeof entry[1] === "number" && Number.isFinite(entry[1]))
      ))
      .map(([key, entryValue]): [string, string | boolean | number] => [key.trim(), entryValue])
      .filter(([key]) => key.length > 0),
  );
}

function requireString(value: unknown, message: string): string {
  const parsed = asTrimmedString(value);
  if (!parsed) throw new Error(message);
  return parsed;
}

function requireStringArray(value: unknown, message: string): string[] {
  const parsed = asStringArray(value);
  if (parsed.length === 0) throw new Error(message);
  return parsed;
}

function requireService<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

function parseGetWebPairingInfoArgs(_value: Record<string, unknown>): Record<string, never> {
  return {};
}

function parsePublishCurrentProjectArgs(value: Record<string, unknown>): PublishProjectInput {
  const owner = asTrimmedString(value.owner);
  const description = asTrimmedString(value.description);
  return {
    ...(owner ? { owner } : {}),
    name: requireString(value.name, "github.publishCurrentProject requires name."),
    ...(description ? { description } : {}),
    isPrivate: asOptionalBoolean(value.isPrivate) ?? true,
  };
}

function requireProjectRoot(args: SyncRemoteCommandServiceArgs, action: string): string {
  return requireString(args.projectRoot, `${action} requires a project root.`);
}

function parseSessionIdArgs(value: Record<string, unknown>, action: string): { sessionId: string } {
  return {
    sessionId: requireString(value.sessionId, `${action} requires sessionId.`),
  };
}

const REMOTE_WAKE_REASONS: readonly SessionWakeReason[] = SESSION_WAKE_REASONS;

function parseRemoteSessionIds(value: Record<string, unknown>, action: string): string[] {
  if (!Array.isArray(value.sessionIds)) throw new Error(`${action} requires a sessionIds array.`);
  const ids = value.sessionIds.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  if (!ids.length) throw new Error(`${action} requires at least one session id.`);
  return ids;
}

/**
 * Snooze deadlines arrive from clients that have no local clock authority, so
 * they must be a parseable ISO timestamp; `sessionService` would otherwise
 * silently return false and the client would show a no-op.
 *
 * A deadline at or before now is rejected for the same reason: snoozed-ness is
 * DERIVED (`snoozedUntilMs > Date.now()`), so writing a past deadline "succeeds"
 * and leaves the row exactly as visible as it was — a silent no-op the caller
 * would report as done. The CLI's `--until` and the desktop CTO tool reject
 * past deadlines identically; the sync path is the third door onto the same
 * write and must not be the lenient one.
 */
function parseRemoteSnoozeDeadline(
  value: Record<string, unknown>,
  action: string,
  nowMs: number = Date.now(),
): string {
  const raw = asTrimmedString(value.untilIso) ?? asTrimmedString(value.snoozedUntil);
  if (!raw) throw new Error(`${action} requires an ISO-8601 untilIso.`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${action} requires an ISO-8601 untilIso; received '${raw}'.`);
  }
  if (parsed.getTime() <= nowMs) {
    throw new Error(`${action} requires untilIso to be in the future; received '${raw}'.`);
  }
  return parsed.toISOString();
}

function parseRemoteWakeReason(value: unknown, action: string): SessionWakeReason {
  if (value == null || value === "") return "manual";
  if (typeof value === "string" && (REMOTE_WAKE_REASONS as readonly string[]).includes(value)) {
    return value as SessionWakeReason;
  }
  throw new Error(`${action} reason must be one of: ${REMOTE_WAKE_REASONS.join(", ")}.`);
}

function parseRemoteSettleOverride(value: unknown, action: string): SessionSettleOverride | null {
  const parsed = parseSessionSettleOverride(value);
  if (parsed === undefined) {
    throw new Error(`${action} override must be 'settled', 'active', or null.`);
  }
  return parsed;
}

function parseRemoteBranchDriftResolution(
  value: unknown,
  action: string,
): LaneBranchDriftResolution {
  if (value === "switch-back" || value === "keep-head") return value;
  throw new Error(`${action} resolution must be 'switch-back' or 'keep-head'.`);
}

function parseAgentChatContextUsageArgs(value: Record<string, unknown>): AgentChatContextUsageArgs {
  return parseSessionIdArgs(value, "chat.getContextUsage");
}

function parseAgentChatRewindFilesArgs(value: Record<string, unknown>): AgentChatRewindFilesArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.rewindFiles requires sessionId."),
    userMessageId: requireString(value.userMessageId, "chat.rewindFiles requires userMessageId."),
    dryRun: asOptionalBoolean(value.dryRun),
  };
}

function parseAgentChatTurnFileDiffArgs(value: Record<string, unknown>): AgentChatGetTurnFileDiffArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.getTurnFileDiff requires sessionId."),
    beforeSha: requireString(value.beforeSha, "chat.getTurnFileDiff requires beforeSha."),
    afterSha: requireString(value.afterSha, "chat.getTurnFileDiff requires afterSha."),
    filePath: requireString(value.filePath, "chat.getTurnFileDiff requires filePath."),
  };
}

function parseAgentChatSlashCommandsArgs(value: Record<string, unknown>): AgentChatSlashCommandsArgs {
  return {
    ...(asTrimmedString(value.sessionId) ? { sessionId: asTrimmedString(value.sessionId)! } : {}),
    ...("laneId" in value ? { laneId: value.laneId == null ? null : asTrimmedString(value.laneId) ?? null } : {}),
    ...("provider" in value ? { provider: value.provider == null ? null : asTrimmedString(value.provider) as AgentChatProvider | null } : {}),
    ...("projectRoot" in value ? { projectRoot: value.projectRoot == null ? null : asTrimmedString(value.projectRoot) ?? null } : {}),
  };
}

function parseAgentChatParallelLaunchStateArgs(value: Record<string, unknown>): AgentChatParallelLaunchStateArgs {
  return {
    projectRoot: requireString(value.projectRoot, "chat.getParallelLaunchState requires projectRoot."),
    parentLaneId: requireString(value.parentLaneId, "chat.getParallelLaunchState requires parentLaneId."),
  };
}

function sanitizeParallelLaunchLaneIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean),
  ));
}

function normalizeAgentChatParallelLaunchState(
  value: unknown,
  parentLaneIdFallback: string,
): AgentChatParallelLaunchState | null {
  if (!isRecord(value)) return null;
  const parentLaneId = asTrimmedString(value.parentLaneId) ?? parentLaneIdFallback;
  const createdLaneIds = sanitizeParallelLaunchLaneIds(value.createdLaneIds);
  if (createdLaneIds.length === 0) return null;
  const sentLaneIds = sanitizeParallelLaunchLaneIds(value.sentLaneIds)
    .filter((laneId) => createdLaneIds.includes(laneId));
  const status = value.status === "creating_lanes"
    || value.status === "sending"
    || value.status === "completed"
    || value.status === "cleanup_pending"
    ? value.status
    : sentLaneIds.length >= createdLaneIds.length
      ? "completed"
      : "creating_lanes";
  return {
    parentLaneId,
    createdLaneIds,
    sentLaneIds,
    status,
    updatedAt: asTrimmedString(value.updatedAt) ?? new Date(0).toISOString(),
    lastError: asTrimmedString(value.lastError),
  };
}

function parseAgentChatSetParallelLaunchStateArgs(value: Record<string, unknown>): AgentChatSetParallelLaunchStateArgs {
  const parsed = parseAgentChatParallelLaunchStateArgs(value);
  return {
    ...parsed,
    state: normalizeAgentChatParallelLaunchState(value.state, parsed.parentLaneId),
  };
}

function agentChatParallelLaunchStateKey(projectRoot: string, parentLaneId: string): string {
  return `agent-chat-parallel-launch:${projectRoot}:${parentLaneId}`;
}

function parseHandoffMode(value: unknown, action: string): "brief" | "fork" | undefined {
  if (value == null) return undefined;
  const parsed = asTrimmedString(value);
  if (parsed !== "brief" && parsed !== "fork") {
    throw new Error(`${action} mode must be brief or fork.`);
  }
  return parsed;
}

function parseAgentChatHandoffArgs(value: Record<string, unknown>): AgentChatHandoffArgs {
  const handoffNote = asTrimmedString(value.handoffNote);
  return {
    ...(value as AgentChatHandoffArgs),
    sourceSessionId: requireString(value.sourceSessionId, "chat.handoff requires sourceSessionId."),
    targetModelId: requireString(value.targetModelId, "chat.handoff requires targetModelId.") as AgentChatHandoffArgs["targetModelId"],
    ...(handoffNote ? { handoffNote } : {}),
  };
}

function parseCrossMachineDestinationPreflightArgs(
  value: Record<string, unknown>,
): AgentChatCrossMachineDestinationPreflightArgs {
  const mode = parseHandoffMode(value.mode, "chat.preflightCrossMachineDestination");
  const sourceProvider = asTrimmedString(value.sourceProvider);
  return {
    targetModelId: requireString(
      value.targetModelId,
      "chat.preflightCrossMachineDestination requires targetModelId.",
    ) as AgentChatCrossMachineDestinationPreflightArgs["targetModelId"],
    sourceBranchRef: requireString(
      value.sourceBranchRef,
      "chat.preflightCrossMachineDestination requires sourceBranchRef.",
    ),
    sourceHeadSha: requireString(
      value.sourceHeadSha,
      "chat.preflightCrossMachineDestination requires sourceHeadSha.",
    ),
    ...(mode !== undefined ? { mode } : {}),
    ...(sourceProvider ? { sourceProvider: sourceProvider as AgentChatProvider } : {}),
  };
}

function parseFastForwardCrossMachineHandoffLaneArgs(
  value: Record<string, unknown>,
): { laneId: string; expectedHead: string } {
  return {
    laneId: requireString(
      value.laneId,
      "chat.fastForwardCrossMachineHandoffLane requires laneId.",
    ),
    expectedHead: requireString(
      value.expectedHead,
      "chat.fastForwardCrossMachineHandoffLane requires expectedHead.",
    ),
  };
}

function parsePrepareCrossMachineHandoffArgs(
  value: Record<string, unknown>,
): AgentChatPrepareCrossMachineHandoffArgs {
  const parseNullableString = (key: string): string | null | undefined => {
    if (!(key in value)) return undefined;
    if (value[key] == null) return null;
    if (typeof value[key] !== "string") {
      throw new Error(`chat.prepareCrossMachineHandoff ${key} must be a string or null.`);
    }
    return value[key].trim();
  };
  const parseBoolean = (key: string): boolean | undefined => {
    if (!(key in value)) return undefined;
    if (typeof value[key] !== "boolean") {
      throw new Error(`chat.prepareCrossMachineHandoff ${key} must be a boolean.`);
    }
    return value[key];
  };
  const parseEnum = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    if (!(key in value)) return undefined;
    const parsed = asTrimmedString(value[key]);
    if (!parsed || !allowed.includes(parsed as T)) {
      throw new Error(`chat.prepareCrossMachineHandoff ${key} is invalid.`);
    }
    return parsed as T;
  };
  const parseConfigValues = (): AgentChatPrepareCrossMachineHandoffArgs["cursorConfigValues"] | undefined => {
    if (!("cursorConfigValues" in value)) return undefined;
    if (value.cursorConfigValues == null) return null;
    if (!isRecord(value.cursorConfigValues)) {
      throw new Error("chat.prepareCrossMachineHandoff cursorConfigValues must be an object or null.");
    }
    const entries = Object.entries(value.cursorConfigValues).map(([rawKey, entryValue]) => {
      const key = rawKey.trim();
      if (
        !key
        || !(
          typeof entryValue === "string"
          || typeof entryValue === "boolean"
          || (typeof entryValue === "number" && Number.isFinite(entryValue))
        )
      ) {
        throw new Error("chat.prepareCrossMachineHandoff cursorConfigValues contains an invalid entry.");
      }
      return [key, entryValue] as const;
    });
    return Object.fromEntries(entries);
  };

  const continuationPrompt = parseNullableString("continuationPrompt");
  const reasoningEffort = parseNullableString("reasoningEffort");
  const fastMode = parseBoolean("fastMode");
  const claudePermissionMode = parseEnum("claudePermissionMode", ["default", "auto", "plan", "acceptEdits", "bypassPermissions"] as const);
  const codexApprovalPolicy = parseEnum("codexApprovalPolicy", ["untrusted", "on-request", "on-failure", "never"] as const);
  const codexSandbox = parseEnum("codexSandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
  const codexConfigSource = parseEnum("codexConfigSource", ["flags", "config-toml"] as const);
  const opencodePermissionMode = parseEnum("opencodePermissionMode", ["plan", "edit", "full-auto", "config-toml"] as const);
  const droidPermissionMode = parseEnum("droidPermissionMode", ["read-only", "auto-low", "auto-medium", "auto-high", "agi"] as const);
  const permissionMode = parseEnum("permissionMode", ["default", "auto", "plan", "edit", "full-auto", "config-toml"] as const);
  const cursorModeId = parseNullableString("cursorModeId");
  const cursorConfigValues = parseConfigValues();
  const mode = parseHandoffMode(value.mode, "chat.prepareCrossMachineHandoff");
  return {
    sourceSessionId: requireString(
      value.sourceSessionId,
      "chat.prepareCrossMachineHandoff requires sourceSessionId.",
    ),
    ...(mode !== undefined ? { mode } : {}),
    handoffId: requireString(
      value.handoffId,
      "chat.prepareCrossMachineHandoff requires handoffId.",
    ),
    targetModelId: requireString(
      value.targetModelId,
      "chat.prepareCrossMachineHandoff requires targetModelId.",
    ) as AgentChatPrepareCrossMachineHandoffArgs["targetModelId"],
    ...(continuationPrompt !== undefined ? { continuationPrompt } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(claudePermissionMode !== undefined ? { claudePermissionMode } : {}),
    ...(codexApprovalPolicy !== undefined ? { codexApprovalPolicy } : {}),
    ...(codexSandbox !== undefined ? { codexSandbox } : {}),
    ...(codexConfigSource !== undefined ? { codexConfigSource } : {}),
    ...(opencodePermissionMode !== undefined ? { opencodePermissionMode } : {}),
    ...(droidPermissionMode !== undefined ? { droidPermissionMode } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(cursorModeId !== undefined ? { cursorModeId } : {}),
    ...(cursorConfigValues !== undefined ? { cursorConfigValues } : {}),
  };
}

function parseMarkCrossMachineHandoffArgs(
  value: Record<string, unknown>,
): AgentChatMarkCrossMachineHandoffArgs {
  return {
    sourceSessionId: requireString(
      value.sourceSessionId,
      "chat.markCrossMachineHandoff requires sourceSessionId.",
    ),
    handoffId: requireString(value.handoffId, "chat.markCrossMachineHandoff requires handoffId."),
    targetMachineName: requireString(
      value.targetMachineName,
      "chat.markCrossMachineHandoff requires targetMachineName.",
    ),
    targetLaneId: requireString(
      value.targetLaneId,
      "chat.markCrossMachineHandoff requires targetLaneId.",
    ),
    targetSessionId: requireString(
      value.targetSessionId,
      "chat.markCrossMachineHandoff requires targetSessionId.",
    ),
  };
}

function parseValidateCrossMachineSourceArgs(
  value: Record<string, unknown>,
): AgentChatValidateCrossMachineSourceArgs {
  if (!isRecord(value.capsule)) {
    throw new Error("chat.validateCrossMachineSource requires a capsule.");
  }
  return {
    sourceSessionId: requireString(
      value.sourceSessionId,
      "chat.validateCrossMachineSource requires sourceSessionId.",
    ),
    capsule: value.capsule as AgentChatValidateCrossMachineSourceArgs["capsule"],
    capsuleFingerprint: requireString(
      value.capsuleFingerprint,
      "chat.validateCrossMachineSource requires capsuleFingerprint.",
    ),
  };
}

function parseAcceptCrossMachineHandoffArgs(
  value: Record<string, unknown>,
): AgentChatAcceptCrossMachineHandoffArgs {
  if (!isRecord(value.capsule)) {
    throw new Error("chat.acceptCrossMachineHandoff requires a capsule.");
  }
  return {
    capsule: value.capsule as AgentChatAcceptCrossMachineHandoffArgs["capsule"],
    capsuleFingerprint: requireString(
      value.capsuleFingerprint,
      "chat.acceptCrossMachineHandoff requires capsuleFingerprint.",
    ),
  };
}

function parseAgentChatLaunchArgs(value: Record<string, unknown>): AgentChatLaunchArgs {
  return {
    ...parseAgentChatCreateArgs(value),
    kickoffText: requireString(value.kickoffText, "chat.launch requires kickoffText."),
    ...(asTrimmedString(value.kickoffDisplayText) ? { kickoffDisplayText: asTrimmedString(value.kickoffDisplayText)! } : {}),
    ...(Array.isArray(value.contextAttachments) ? { contextAttachments: value.contextAttachments as AgentChatLaunchArgs["contextAttachments"] } : {}),
  };
}

function parseWarmupModelArgs(value: Record<string, unknown>): { sessionId: string; modelId: string } {
  return {
    sessionId: requireString(value.sessionId, "chat.warmupModel requires sessionId."),
    modelId: requireString(value.modelId, "chat.warmupModel requires modelId."),
  };
}

function parseTerminalRecord(value: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function optionalTerminalString(
  record: Record<string, unknown>,
  field: string,
  maxLength = 4096,
  trim = true,
): string | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid terminal payload: ${field} must be a string`);
  const text = trim ? value.trim() : value;
  if (text.includes("\0")) throw new Error(`Invalid terminal payload: ${field} cannot contain null bytes`);
  if (text.length > maxLength) throw new Error(`Invalid terminal payload: ${field} is too long`);
  return text;
}

function optionalTerminalNumber(
  record: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid terminal payload: ${field} must be a finite number`);
  }
  const next = Math.floor(value);
  if (next < min || next > max) throw new Error(`Invalid terminal payload: ${field} is out of range`);
  return next;
}

function parseTerminalListArgs(value: Record<string, unknown>): ChatTerminalListArgs {
  const record = parseTerminalRecord(value);
  return {
    chatSessionId: optionalTerminalString(record, "chatSessionId", 128),
    laneId: optionalTerminalString(record, "laneId", 512),
    limit: optionalTerminalNumber(record, "limit", 1, 500),
  };
}

function parseTerminalActiveForChatArgs(value: Record<string, unknown>): ChatTerminalActiveForChatArgs {
  const record = parseTerminalRecord(value);
  const chatSessionId = optionalTerminalString(record, "chatSessionId", 128);
  if (!chatSessionId) throw new Error("Invalid terminal payload: chatSessionId is required");
  return { chatSessionId };
}

function parseGitUserIdentityArgs(value: Record<string, unknown>): GitGetUserIdentityArgs {
  return {
    laneId: requireString(value.laneId, "git.getUserIdentity requires laneId."),
  };
}

function parseListOperationsArgs(value: Record<string, unknown>): ListOperationsArgs {
  const status = asTrimmedString(value.status);
  return {
    ...(asTrimmedString(value.laneId) ? { laneId: asTrimmedString(value.laneId)! } : {}),
    ...(asTrimmedString(value.kind) ? { kind: asTrimmedString(value.kind)! } : {}),
    ...(status === "running" || status === "succeeded" || status === "failed" || status === "canceled" ? { status } : {}),
    ...(asOptionalNumber(value.limit) != null ? { limit: asOptionalNumber(value.limit)! } : {}),
  };
}

function parseDeletePrArgs(value: Record<string, unknown>): DeletePrArgs {
  return {
    prId: requirePrId(value, "prs.delete"),
    closeOnGitHub: asOptionalBoolean(value.closeOnGitHub),
    archiveLane: asOptionalBoolean(value.archiveLane),
  };
}

function parseCleanupPrBranchArgs(value: Record<string, unknown>): CleanupPrBranchArgs {
  return {
    prId: requirePrId(value, "prs.cleanupBranch"),
    deleteLocalBranch: asOptionalBoolean(value.deleteLocalBranch),
    deleteRemoteBranch: asOptionalBoolean(value.deleteRemoteBranch),
    ...(asTrimmedString(value.remoteName) ? { remoteName: asTrimmedString(value.remoteName)! } : {}),
  };
}

function parsePostPrReviewCommentArgs(value: Record<string, unknown>): PostPrReviewCommentArgs {
  return {
    prId: requirePrId(value, "prs.postReviewComment"),
    threadId: requireString(value.threadId, "prs.postReviewComment requires threadId."),
    body: requireString(value.body, "prs.postReviewComment requires body."),
  };
}

function parseStartPrAiResolutionArgs(value: Record<string, unknown>): PrAiResolutionStartArgs {
  return {
    context: isRecord(value.context) ? value.context as PrAiResolutionContext : {} as PrAiResolutionContext,
    model: requireString(value.model, "prs.aiResolutionStart requires model."),
    ...("reasoning" in value ? { reasoning: value.reasoning == null ? null : asTrimmedString(value.reasoning) ?? null } : {}),
    ...(asTrimmedString(value.permissionMode) ? { permissionMode: asTrimmedString(value.permissionMode)! as PrAgentPermissionMode } : {}),
    ...("additionalInstructions" in value
      ? { additionalInstructions: value.additionalInstructions == null ? null : asTrimmedString(value.additionalInstructions) ?? null }
      : {}),
  };
}

function parseGetPrAiResolutionSessionArgs(value: Record<string, unknown>): PrAiResolutionGetSessionArgs {
  return {
    context: isRecord(value.context) ? value.context as PrAiResolutionContext : {} as PrAiResolutionContext,
  };
}

function parseProjectConfigSaveArgs(value: Record<string, unknown>): { candidate: ProjectConfigCandidate } {
  if (!isRecord(value.candidate)) throw new Error("projectConfig.save requires candidate.");
  return { candidate: value.candidate as ProjectConfigCandidate };
}

// `ai.apiKeys` holds live provider API keys (spent by aiIntegrationService and
// openCodeRuntime), and the top-level `providers` bag is an unvalidated
// passthrough that historically carried the same. Neither is reachable from a
// paired peer: reads drop them, and writes keep whatever is already on disk.
// The write side matters as much as the read side — every Settings section
// saves a get→edit→save round trip of the whole file, so a redacted read fed
// back verbatim would otherwise erase the host's keys.
function stripProjectConfigCredentials<T extends { ai?: unknown; providers?: unknown }>(file: T): T {
  const { providers: _providers, ...rest } = file;
  if (!isRecord(rest.ai) || !("apiKeys" in rest.ai)) return rest as T;
  const { apiKeys: _apiKeys, ...ai } = rest.ai;
  return { ...rest, ai } as T;
}

function redactProjectConfigSnapshotForRemote(snapshot: ProjectConfigSnapshot): ProjectConfigSnapshot {
  return {
    ...snapshot,
    shared: stripProjectConfigCredentials(snapshot.shared),
    local: stripProjectConfigCredentials(snapshot.local),
    effective: stripProjectConfigCredentials(snapshot.effective),
  };
}

function restoreProjectConfigCredentials(candidate: ProjectConfigFile, onDisk: ProjectConfigFile): ProjectConfigFile {
  const stripped = stripProjectConfigCredentials(candidate);
  const apiKeys = isRecord(onDisk.ai) && isRecord(onDisk.ai.apiKeys) ? onDisk.ai.apiKeys : null;
  return {
    ...stripped,
    ...(apiKeys ? { ai: { ...(stripped.ai ?? {}), apiKeys } } : {}),
    ...(onDisk.providers ? { providers: onDisk.providers } : {}),
  };
}

function mergeProjectConfigCandidateForRemote(
  candidate: ProjectConfigCandidate,
  onDisk: ProjectConfigSnapshot,
): ProjectConfigCandidate {
  return {
    shared: restoreProjectConfigCredentials(candidate.shared, onDisk.shared),
    local: restoreProjectConfigCredentials(candidate.local, onDisk.local),
  };
}

function parseOrchestrationRunCreateArgs(value: Record<string, unknown>): OrchestrationRunCreateRequest & { laneId: string } {
  return {
    ...(value as OrchestrationRunCreateRequest & { laneId: string }),
    laneId: requireString(value.laneId, "orchestration.runCreate requires laneId."),
  };
}

async function summarizeChatSessionForRemote(
  agentChatService: ReturnType<typeof createAgentChatService>,
  session: AgentChatSession,
): Promise<AgentChatSessionSummary> {
  const summary = await agentChatService.getSessionSummary(session.id);
  if (summary) return summary;

  return {
    sessionId: session.id,
    laneId: session.laneId,
    provider: session.provider,
    model: session.model,
    ...(session.modelId ? { modelId: session.modelId } : {}),
    ...(session.sessionProfile ? { sessionProfile: session.sessionProfile } : {}),
    reasoningEffort: session.reasoningEffort ?? null,
    fastMode: session.fastMode === true,
    executionMode: session.executionMode ?? null,
	    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
	    ...(session.interactionMode !== undefined ? { interactionMode: session.interactionMode } : {}),
	    ...(session.claudePermissionMode ? { claudePermissionMode: session.claudePermissionMode } : {}),
	    ...(session.claudeOutputStyle ? { claudeOutputStyle: session.claudeOutputStyle } : {}),
	    ...(session.codexApprovalPolicy ? { codexApprovalPolicy: session.codexApprovalPolicy } : {}),
    ...(session.codexSandbox ? { codexSandbox: session.codexSandbox } : {}),
    ...(session.codexConfigSource ? { codexConfigSource: session.codexConfigSource } : {}),
    ...(session.opencodePermissionMode ? { opencodePermissionMode: session.opencodePermissionMode } : {}),
    ...(session.droidPermissionMode ? { droidPermissionMode: session.droidPermissionMode } : {}),
    ...(session.cursorModeSnapshot ? { cursorModeSnapshot: session.cursorModeSnapshot } : {}),
    ...(session.cursorModeId !== undefined ? { cursorModeId: session.cursorModeId } : {}),
    ...(session.cursorConfigValues ? { cursorConfigValues: session.cursorConfigValues } : {}),
    ...(session.identityKey ? { identityKey: session.identityKey } : {}),
    ...(session.surface ? { surface: session.surface } : {}),
    automationId: session.automationId ?? null,
    automationRunId: session.automationRunId ?? null,
    ...(session.capabilityMode ? { capabilityMode: session.capabilityMode } : {}),
    completion: session.completion ?? null,
    status: session.status,
    currentTurnStartedAt: session.currentTurnStartedAt ?? null,
    idleSinceAt: session.idleSinceAt ?? null,
    startedAt: session.createdAt,
    endedAt: null,
    lastActivityAt: session.lastActivityAt,
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    ...(session.requestedCwd !== undefined ? { requestedCwd: session.requestedCwd } : {}),
  };
}

function parsePushQuietHours(value: unknown): PushQuietHours | null {
  if (!isRecord(value)) return null;
  const start = asTrimmedString(value.start);
  const end = asTrimmedString(value.end);
  const timezone = asTrimmedString(value.timezone);
  if (!start || !end || !timezone) return null;
  return { start, end, timezone };
}

function parsePushPrefs(value: unknown): PushNotificationPrefs {
  if (!isRecord(value)) {
    return { enabled: true, liveActivitiesEnabled: true, mutedSessionIds: [], quietHours: null };
  }
  return {
    enabled: value.enabled !== false,
    liveActivitiesEnabled: value.liveActivitiesEnabled !== false,
    mutedSessionIds: asStringArray(value.mutedSessionIds),
    quietHours: parsePushQuietHours(value.quietHours),
  };
}

function parsePushRegisterDeviceArgs(value: Record<string, unknown>): PushDeviceRegistration {
  const apsEnvironmentRaw = asTrimmedString(value.apsEnvironment);
  if (apsEnvironmentRaw !== "sandbox" && apsEnvironmentRaw !== "production") {
    throw new Error("push.registerDevice requires apsEnvironment (sandbox|production).");
  }
  const pushToStartToken = asTrimmedString(value.pushToStartToken);
  const clearPushToStartToken = value.clearPushToStartToken === true;
  if (pushToStartToken && clearPushToStartToken) {
    throw new Error(
      "push.registerDevice cannot set and clear pushToStartToken together.",
    );
  }
  return {
    deviceId: requireString(value.deviceId, "push.registerDevice requires deviceId."),
    bundleId: requireString(value.bundleId, "push.registerDevice requires bundleId."),
    apsEnvironment: apsEnvironmentRaw,
    apnsToken: asTrimmedString(value.apnsToken),
    pushToStartToken,
    clearPushToStartToken,
    platform: asTrimmedString(value.platform),
    deviceName: asTrimmedString(value.deviceName),
    prefs: isRecord(value.prefs) ? parsePushPrefs(value.prefs) : null,
  };
}

function parsePushLiveActivityTokenArgs(value: Record<string, unknown>): PushLiveActivityTokenReport {
  return {
    deviceId: requireString(value.deviceId, "push.reportLiveActivityToken requires deviceId."),
    activityId: requireString(value.activityId, "push.reportLiveActivityToken requires activityId."),
    token: asTrimmedString(value.token),
  };
}

function parseListLanesArgs(value: Record<string, unknown>): ListLanesArgs {
  return {
    includeArchived: asOptionalBoolean(value.includeArchived),
    includeStatus: asOptionalBoolean(value.includeStatus),
    includeConflictStatus: asOptionalBoolean(value.includeConflictStatus),
    includeRebaseSuggestions: asOptionalBoolean(value.includeRebaseSuggestions),
    includeAutoRebaseStatus: asOptionalBoolean(value.includeAutoRebaseStatus),
  };
}

function parseCreateLaneArgs(value: Record<string, unknown>): CreateLaneArgs {
  return {
    name: requireString(value.name, "lanes.create requires name."),
    ...(asTrimmedString(value.description) ? { description: asTrimmedString(value.description)! } : {}),
    ...(asTrimmedString(value.parentLaneId) ? { parentLaneId: asTrimmedString(value.parentLaneId)! } : {}),
    ...(asTrimmedString(value.baseBranch) ? { baseBranch: asTrimmedString(value.baseBranch)! } : {}),
    ...(asTrimmedString(value.branchName) ? { branchName: asTrimmedString(value.branchName)! } : {}),
    ...(asTrimmedString(value.startPoint) ? { startPoint: asTrimmedString(value.startPoint)! } : {}),
    ...(isRecord(value.linearIssue) ? { linearIssue: value.linearIssue as CreateLaneArgs["linearIssue"] } : {}),
  };
}

function parseSuggestLaneNameArgs(value: Record<string, unknown>): AgentChatSuggestLaneNameArgs {
  return {
    prompt: requireString(value.prompt, "lanes.suggestName requires prompt."),
    modelId: requireString(value.modelId, "lanes.suggestName requires modelId."),
    laneId: requireString(value.laneId, "lanes.suggestName requires laneId."),
    // The model the chat itself was launched with. Distinct from `modelId` (the
    // configured naming model): dropping it here would strand the host-side
    // naming fallback chain on the naming provider even when that provider is
    // broken, which is the exact case the field exists to escape.
    ...(asTrimmedString(value.chatModelId) ? { chatModelId: asTrimmedString(value.chatModelId)! } : {}),
    ...(asTrimmedString(value.fallbackName) ? { fallbackName: asTrimmedString(value.fallbackName)! } : {}),
    ...(asTrimmedString(value.temporaryBranch) ? { temporaryBranch: asTrimmedString(value.temporaryBranch)! } : {}),
    ...(parseAgentChatFileRefs(value.attachments) ? { attachments: parseAgentChatFileRefs(value.attachments)! } : {}),
  };
}

function parseCreateChildLaneArgs(value: Record<string, unknown>): CreateChildLaneArgs {
  return {
    name: requireString(value.name, "lanes.createChild requires name."),
    parentLaneId: requireString(value.parentLaneId, "lanes.createChild requires parentLaneId."),
    ...(asTrimmedString(value.description) ? { description: asTrimmedString(value.description)! } : {}),
    ...(asTrimmedString(value.folder) ? { folder: asTrimmedString(value.folder)! } : {}),
    ...(asTrimmedString(value.baseBranchRef) ? { baseBranchRef: asTrimmedString(value.baseBranchRef)! } : {}),
    ...(asTrimmedString(value.branchName) ? { branchName: asTrimmedString(value.branchName)! } : {}),
    ...(isRecord(value.linearIssue) ? { linearIssue: value.linearIssue as CreateChildLaneArgs["linearIssue"] } : {}),
  };
}

function parseCreateLaneFromUnstagedArgs(value: Record<string, unknown>): CreateLaneFromUnstagedArgs {
  return {
    name: requireString(value.name, "lanes.createFromUnstaged requires name."),
    sourceLaneId: requireString(value.sourceLaneId, "lanes.createFromUnstaged requires sourceLaneId."),
  };
}

function parseImportBranchArgs(value: Record<string, unknown>): ImportBranchLaneArgs {
  return {
    branchRef: requireString(value.branchRef, "lanes.importBranch requires branchRef."),
    ...(asTrimmedString(value.name) ? { name: asTrimmedString(value.name)! } : {}),
    ...(asTrimmedString(value.description) ? { description: asTrimmedString(value.description)! } : {}),
    ...(asTrimmedString(value.baseBranch) ? { baseBranch: asTrimmedString(value.baseBranch)! } : {}),
  };
}

function parseArchiveLaneArgs(value: Record<string, unknown>, action: string): ArchiveLaneArgs {
  return {
    laneId: requireString(value.laneId, `${action} requires laneId.`),
  };
}

function parseDeleteLaneArgs(value: Record<string, unknown>): DeleteLaneArgs {
  return {
    laneId: requireString(value.laneId, "lanes.delete requires laneId."),
    deleteBranch: asOptionalBoolean(value.deleteBranch),
    deleteRemoteBranch: asOptionalBoolean(value.deleteRemoteBranch),
    ...(asTrimmedString(value.remoteName) ? { remoteName: asTrimmedString(value.remoteName)! } : {}),
    force: asOptionalBoolean(value.force),
  };
}

function parseRenameLaneArgs(value: Record<string, unknown>): RenameLaneArgs {
  return {
    laneId: requireString(value.laneId, "lanes.rename requires laneId."),
    name: requireString(value.name, "lanes.rename requires name."),
  };
}

function parseReparentLaneArgs(value: Record<string, unknown>): ReparentLaneArgs {
  const stackBaseBranchRef = asTrimmedString(value.stackBaseBranchRef);
  return {
    laneId: requireString(value.laneId, "lanes.reparent requires laneId."),
    newParentLaneId: requireString(value.newParentLaneId, "lanes.reparent requires newParentLaneId."),
    ...(stackBaseBranchRef ? { stackBaseBranchRef } : {}),
  };
}

function parseUpdateLaneAppearanceArgs(value: Record<string, unknown>): UpdateLaneAppearanceArgs {
  const parsed: UpdateLaneAppearanceArgs = {
    laneId: requireString(value.laneId, "lanes.updateAppearance requires laneId."),
  };
  if ("color" in value) {
    parsed.color = value.color == null ? null : asTrimmedString(value.color) ?? null;
  }
  if ("icon" in value) {
    parsed.icon = value.icon == null ? null : (asTrimmedString(value.icon) as UpdateLaneAppearanceArgs["icon"]);
  }
  if ("tags" in value) {
    parsed.tags = value.tags == null ? null : asStringArray(value.tags);
  }
  return parsed;
}

function parseRebaseStartArgs(value: Record<string, unknown>): RebaseStartArgs {
  return {
    laneId: requireString(value.laneId, "lanes.rebaseStart requires laneId."),
    ...(asTrimmedString(value.scope) ? { scope: value.scope as RebaseStartArgs["scope"] } : {}),
    ...(asTrimmedString(value.pushMode) ? { pushMode: value.pushMode as RebaseStartArgs["pushMode"] } : {}),
    ...(asTrimmedString(value.actor) ? { actor: asTrimmedString(value.actor)! } : {}),
    ...(asTrimmedString(value.reason) ? { reason: asTrimmedString(value.reason)! } : {}),
    ...(asTrimmedString(value.baseBranchOverride) ? { baseBranchOverride: asTrimmedString(value.baseBranchOverride)! } : {}),
  };
}

function parseRebasePushArgs(value: Record<string, unknown>): RebasePushArgs {
  return {
    runId: requireString(value.runId, "lanes.rebasePush requires runId."),
    laneIds: requireStringArray(value.laneIds, "lanes.rebasePush requires laneIds."),
  };
}

function parseRunIdArgs(value: Record<string, unknown>, action: string): { runId: string } {
  return {
    runId: requireString(value.runId, `${action} requires runId.`),
  };
}

function parseListSessionsArgs(value: Record<string, unknown>): ListSessionsArgs {
  const laneId = asTrimmedString(value.laneId);
  const status = asTrimmedString(value.status) as ListSessionsArgs["status"];
  const limit = asOptionalNumber(value.limit);
  return {
    ...(laneId ? { laneId } : {}),
    ...(status ? { status } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
  };
}

function parseUpdateSessionMetaArgs(value: Record<string, unknown>): UpdateSessionMetaArgs {
  const parsed: UpdateSessionMetaArgs = {
    sessionId: requireString(value.sessionId, "work.updateSessionMeta requires sessionId."),
  };

  if ("pinned" in value) parsed.pinned = value.pinned === true;
  if ("manuallyNamed" in value) parsed.manuallyNamed = value.manuallyNamed === true;
  if ("title" in value) parsed.title = value.title == null ? undefined : requireString(value.title, "work.updateSessionMeta requires a non-empty title when title is provided.");
  if ("goal" in value) parsed.goal = value.goal == null ? null : asTrimmedString(value.goal) ?? null;
  if ("toolType" in value) {
    parsed.toolType = value.toolType == null
      ? null
      : asTrimmedString(value.toolType) as UpdateSessionMetaArgs["toolType"];
  }
  if ("resumeCommand" in value) {
    parsed.resumeCommand = value.resumeCommand == null ? null : asTrimmedString(value.resumeCommand) ?? null;
  }

  return parsed;
}

function parseQuickCommandArgs(value: Record<string, unknown>): SyncRunQuickCommandArgs {
  const laneId = requireString(value.laneId, "work.runQuickCommand requires laneId.");
  const title = requireString(value.title, "work.runQuickCommand requires title.");
  const toolType = asTrimmedString(value.toolType);
  const startupCommand = asTrimmedString(value.startupCommand);
  if (!startupCommand && toolType !== "shell") {
    throw new Error("work.runQuickCommand requires startupCommand unless toolType is shell.");
  }
  return {
    laneId,
    title,
    ...(startupCommand ? { startupCommand } : {}),
    cols: asOptionalNumber(value.cols),
    rows: asOptionalNumber(value.rows),
    toolType,
    tracked: asOptionalBoolean(value.tracked),
  };
}

const DEFAULT_CLI_COLS = 120;
const DEFAULT_CLI_ROWS = 36;
const MAX_CLI_COLS = 400;
const MAX_CLI_ROWS = 200;

function clampCliDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
}

function parseCliProvider(value: unknown): SyncStartCliSessionArgs["provider"] {
  const provider = asTrimmedString(value)?.toLowerCase();
  if (!isLaunchProfile(provider)) throw new Error("work.startCliSession requires provider.");
  return provider;
}

function parseCliPermissionMode(value: unknown): SyncStartCliSessionArgs["permissionMode"] {
  const mode = asTrimmedString(value);
  return isTrackedCliPermissionMode(mode) ? mode : "default";
}

function parseOptionalCliPermissionMode(value: unknown): SyncSendToSessionArgs["permissionMode"] {
  const mode = asTrimmedString(value);
  return isTrackedCliPermissionMode(mode) ? mode : undefined;
}

function parseOptionalCodexApprovalPolicy(value: unknown): SyncSendToSessionArgs["codexApprovalPolicy"] {
  const policy = asTrimmedString(value);
  return policy === "untrusted" || policy === "on-request" || policy === "on-failure" || policy === "never"
    ? policy
    : undefined;
}

function parseOptionalCodexSandbox(value: unknown): SyncSendToSessionArgs["codexSandbox"] {
  const sandbox = asTrimmedString(value);
  return sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access"
    ? sandbox
    : undefined;
}

function parseOptionalCodexConfigSource(value: unknown): SyncSendToSessionArgs["codexConfigSource"] {
  const source = asTrimmedString(value);
  return source === "flags" || source === "config-toml" ? source : undefined;
}

function parseStartCliSessionArgs(value: Record<string, unknown>): SyncStartCliSessionArgs {
  const laneId = requireString(value.laneId, "work.startCliSession requires laneId.");
  const provider = parseCliProvider(value.provider);
  const initialInput = typeof value.initialInput === "string" && value.initialInput.trim().length > 0
    ? value.initialInput.slice(0, 20_000)
    : null;
  return {
    laneId,
    provider,
    permissionMode: parseCliPermissionMode(value.permissionMode),
    title: asTrimmedString(value.title),
    initialInput,
    cols: asOptionalNumber(value.cols),
    rows: asOptionalNumber(value.rows),
    model: asTrimmedString(value.model),
    modelId: asTrimmedString(value.modelId),
    reasoningEffort: asTrimmedString(value.reasoningEffort),
    fastMode: asOptionalBoolean(value.fastMode) ?? asOptionalBoolean(value.codexFastMode),
  };
}

function parseExternalSessionProvider(value: unknown, action: string): ExternalSessionProvider {
  const provider = asTrimmedString(value)?.toLowerCase();
  if (!provider || !EXTERNAL_SESSION_PROVIDERS.has(provider as ExternalSessionProvider)) {
    throw new Error(`${action} requires a valid provider.`);
  }
  return provider as ExternalSessionProvider;
}

function parseListExternalSessionsArgs(value: Record<string, unknown>): SyncListExternalSessionsArgs {
  const result: SyncListExternalSessionsArgs = {};
  if (value.providers != null) {
    if (!Array.isArray(value.providers)) throw new Error("work.listExternalSessions providers must be an array.");
    result.providers = value.providers.map((provider) =>
      parseExternalSessionProvider(provider, "work.listExternalSessions"));
  }
  if (value.laneId != null) {
    if (typeof value.laneId !== "string") throw new Error("work.listExternalSessions laneId must be a string.");
    result.laneId = value.laneId.trim();
  }
  if (value.cwd != null) {
    if (typeof value.cwd !== "string") throw new Error("work.listExternalSessions cwd must be a string.");
    result.cwd = value.cwd.trim();
  }
  if (value.scope != null) {
    if (value.scope !== "project" && value.scope !== "all") {
      throw new Error("work.listExternalSessions scope must be project or all.");
    }
    result.scope = value.scope;
  }
  if (value.limit != null) {
    if (typeof value.limit !== "number" || !Number.isFinite(value.limit)) {
      throw new Error("work.listExternalSessions limit must be a finite number.");
    }
    result.limit = Math.max(1, Math.min(100, Math.floor(value.limit)));
  }
  if (value.sessionId != null) {
    if (typeof value.sessionId !== "string") throw new Error("work.listExternalSessions sessionId must be a string.");
    result.sessionId = value.sessionId.trim();
  }
  return result;
}

function parseImportExternalSessionArgs(value: Record<string, unknown>): SyncImportExternalSessionArgs {
  const provider = parseExternalSessionProvider(value.provider, "work.importExternalSession");
  const sessionId = requireString(value.sessionId, "work.importExternalSession requires sessionId.");
  const laneId = requireString(value.laneId, "work.importExternalSession requires laneId.");
  const target = asTrimmedString(value.target);
  if (target !== "cli" && target !== "chat") {
    throw new Error("work.importExternalSession target must be cli or chat.");
  }
  const mode = asTrimmedString(value.mode);
  if (mode !== "resume" && mode !== "fork") {
    throw new Error("work.importExternalSession mode must be resume or fork.");
  }
  return {
    provider,
    sessionId,
    laneId,
    target,
    mode,
    ...(asTrimmedString(value.model) ? { model: asTrimmedString(value.model)! } : {}),
    ...(asTrimmedString(value.reasoningEffort) ? { reasoningEffort: asTrimmedString(value.reasoningEffort)! } : {}),
    ...(typeof value.fastMode === "boolean" ? { fastMode: value.fastMode } : {}),
    ...(asTrimmedString(value.permissionMode) ? { permissionMode: asTrimmedString(value.permissionMode)! } : {}),
  };
}

function resolveExternalSessionsService(args: SyncRemoteCommandServiceArgs): ExternalSessionsRemoteService {
  return requireService(
    args.getExternalSessionsService?.() ?? args.externalSessionsService,
    "External sessions service not available.",
  );
}

function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return t === "cursor" || t.endsWith("-chat");
}

function sessionNeedsResumeTargetHydration(session: {
  tracked: boolean;
  status: string;
  toolType: string | null;
  resumeMetadata?: { targetId?: string | null } | null;
}): boolean {
  if (!session.tracked || session.status === "running") return false;
  if (sanitizeResumeTargetId(session.resumeMetadata?.targetId ?? null)) return false;
  return (
    session.toolType === "claude"
    || session.toolType === "codex"
    || session.toolType === "claude-orchestrated"
    || session.toolType === "codex-orchestrated"
  );
}

function projectChatOntoSession(
  session: ReturnType<SyncRemoteCommandServiceArgs["ptyService"]["enrichSessions"]>[number],
  chat: AgentChatSessionSummary,
) {
  const base = {
    ...session,
    currentTurnStartedAt: chat.currentTurnStartedAt ?? null,
    ...(chat.orchestrationRunId
      ? {
          orchestrationRunId: chat.orchestrationRunId,
          orchestrationRole: chat.orchestrationRole,
          orchestrationTag: chat.orchestrationTag,
        }
      : {}),
  };
  if (chat.awaitingInput) {
    return {
      ...base,
      runtimeState: "waiting-input" as const,
      chatIdleSinceAt: null,
      pendingInputItemId: chat.pendingInputItemId ?? session.pendingInputItemId ?? null,
      attentionSource: "provider_structured" as const,
    };
  }
  if (chat.status === "active") {
    return {
      ...base,
      runtimeState: "running" as const,
      chatIdleSinceAt: null,
      pendingInputItemId: null,
      attentionSource: session.attentionSource === "provider_structured" ? null : session.attentionSource,
    };
  }
  if (chat.status === "idle" || chat.status === "ended") {
    return {
      ...base,
      runtimeState: "idle" as const,
      chatIdleSinceAt: chat.idleSinceAt ?? null,
      pendingInputItemId: null,
      attentionSource: session.attentionSource === "provider_structured" ? null : session.attentionSource,
    };
  }
  return base;
}

async function getRemoteWorkSession(
  args: SyncRemoteCommandServiceArgs,
  sessionId: string,
) {
  let session = args.sessionService.get(sessionId);
  if (!session) return null;
  if (sessionNeedsResumeTargetHydration(session)) {
    try {
      await args.ptyService.ensureResumeTargets([session.id]);
      const hydrated = args.sessionService.get(sessionId);
      if (hydrated) session = hydrated;
    } catch (error) {
      args.logger.warn("sessions.resume_target_hydration_failed", {
        sessionIds: [session.id],
        err: String(error),
      });
    }
  }
  let enriched = args.ptyService.enrichSessions([session])[0] ?? {
    ...session,
    runtimeState: args.ptyService.getRuntimeState(session.id, session.status),
  };
  if (enriched.status === "running" && isChatToolType(enriched.toolType)) {
    try {
      const chat = await args.agentChatService?.getSessionSummary(enriched.id);
      if (chat) enriched = projectChatOntoSession(enriched, chat);
    } catch {
      // Detail reads should still return the persisted session if chat state
      // hydration fails during runtime restart/recovery.
    }
  }
  return enriched;
}

function resolveControllerSuppliedPath(rawPath: string, projectRoot: string): string {
  let inputPath = rawPath;
  if (/^ade-artifact:\/\/project(?:\/|$)/i.test(inputPath)) {
    const parsed = new URL(inputPath);
    inputPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  }
  if (/^file:\/\//i.test(inputPath)) {
    try {
      inputPath = fileURLToPath(inputPath);
    } catch {
      inputPath = decodeURIComponent(inputPath.replace(/^file:\/\//i, ""));
    }
  }
  return path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath));
}

function resolveAllowedProjectPath(args: SyncRemoteCommandServiceArgs, rawPath: unknown, action: string): string {
  const raw = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!raw) throw new Error("Missing path.");
  const projectRoot = requireProjectRoot(args, action);
  const normalized = resolveControllerSuppliedPath(raw, projectRoot);
  return resolvePathWithinRoot(projectRoot, normalized);
}

async function saveAgentChatTempAttachment(
  args: SyncRemoteCommandServiceArgs,
  payload: Record<string, unknown>,
): Promise<{ path: string; mimeType: string; previewDataUrl: string | null }> {
  const projectRoot = requireProjectRoot(args, "chat.saveTempAttachment");
  return await saveImageTempAttachment(path.join(projectRoot, ".ade", "attachments"), payload);
}

function inferPrAiProvider(modelId: string): "codex" | "claude" {
  const descriptor = getModelById(modelId);
  return descriptor?.family === "anthropic" ? "claude" : "codex";
}

function collectPrAiSourceLaneIds(context: PrAiResolutionContext): string[] {
  const sourceLaneIds = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) sourceLaneIds.add(normalized);
  };
  for (const laneId of context.sourceLaneIds ?? []) {
    add(laneId);
  }
  add(context.sourceLaneId ?? null);
  if (context.sourceTab !== "integration") {
    add(context.laneId ?? null);
  }
  return Array.from(sourceLaneIds);
}

function mapPrAiPermissionMode(mode: PrAgentPermissionMode): AgentChatPermissionMode {
  if (mode === "full_edit") return "full-auto";
  if (mode === "guarded_edit") return "edit";
  if (mode === "read_only") return "plan";
  return mode;
}

function mapPrAiPermissionModeToNativeFields(
  mode: PrAgentPermissionMode,
  provider: string,
): Partial<Pick<AgentChatCreateArgs, "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode" | "droidPermissionMode" | "cursorModeId">> {
  const legacy = mapPrAiPermissionMode(mode);
  if (provider === "claude") {
    const map: Record<string, AgentChatClaudePermissionMode> = {
      "full-auto": "bypassPermissions",
      "edit": "acceptEdits",
      "plan": "plan",
      "default": "default",
    };
    return { claudePermissionMode: map[legacy] ?? "default" };
  }
  if (provider === "codex") {
    if (legacy === "config-toml") {
      return {
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "config-toml",
      };
    }
    if (legacy === "full-auto") return { codexApprovalPolicy: "never", codexSandbox: "danger-full-access", codexConfigSource: "flags" };
    if (legacy === "edit" || legacy === "default") return { codexApprovalPolicy: "on-request", codexSandbox: "workspace-write", codexConfigSource: "flags" };
    return { codexApprovalPolicy: "on-request", codexSandbox: "read-only", codexConfigSource: "flags" };
  }
  if (provider === "droid") {
    if (legacy === "full-auto") return { droidPermissionMode: "auto-high" };
    if (legacy === "edit") return { droidPermissionMode: "auto-low" };
    return { droidPermissionMode: "read-only" };
  }
  if (provider === "cursor") {
    if (legacy === "full-auto") return { cursorModeId: "full-auto" };
    if (legacy === "plan") return { cursorModeId: "plan" };
    return { cursorModeId: "agent" };
  }
  const umap: Record<string, AgentChatOpenCodePermissionMode> = {
    "full-auto": "full-auto",
    "edit": "edit",
    "plan": "plan",
    "config-toml": "config-toml",
  };
  return { opencodePermissionMode: umap[legacy] ?? "edit" };
}

function deriveAiPermissionModeFromSummary(
  summary: Pick<AgentChatSessionSummary, "provider" | "permissionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode" | "droidPermissionMode" | "cursorModeId"> | null | undefined,
): PrAgentPermissionMode | null {
  if (!summary) return null;
  if (summary.permissionMode) return summary.permissionMode;
  if (summary.provider === "claude") {
    if (summary.claudePermissionMode === "bypassPermissions") return "full-auto";
    if (summary.claudePermissionMode === "acceptEdits") return "edit";
    if (summary.claudePermissionMode === "plan") return "plan";
    if (summary.claudePermissionMode === "default") return "default";
    return null;
  }
  if (summary.provider === "codex") {
    if (summary.codexConfigSource === "config-toml") return "config-toml";
    if (summary.codexApprovalPolicy === "never" && summary.codexSandbox === "danger-full-access") return "full-auto";
    if (summary.codexSandbox === "workspace-write") return "default";
    if (summary.codexSandbox === "read-only") return "plan";
    return null;
  }
  if (summary.provider === "droid") {
    if (summary.droidPermissionMode === "auto-high") return "full-auto";
    if (summary.droidPermissionMode === "auto-low" || summary.droidPermissionMode === "auto-medium") return "edit";
    if (summary.droidPermissionMode === "read-only") return "plan";
    return null;
  }
  if (summary.provider === "cursor") {
    if (summary.cursorModeId === "full-auto") return "full-auto";
    if (summary.cursorModeId === "agent") return "edit";
    if (summary.cursorModeId === "ask" || summary.cursorModeId === "plan") return "plan";
    return null;
  }
  if (summary.opencodePermissionMode === "full-auto") return "full-auto";
  if (summary.opencodePermissionMode === "edit") return "edit";
  if (summary.opencodePermissionMode === "plan") return "plan";
  if (summary.opencodePermissionMode === "config-toml") return "config-toml";
  return null;
}

function mapExternalResolverStatusToPrAi(status: string): PrAiResolutionSessionStatus {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "canceled") return "cancelled";
  return "running";
}

function buildPrAiDisplayText(context: PrAiResolutionContext): string {
  if (context.sourceTab === "rebase") return "Resolve this rebase with AI.";
  if (context.sourceTab === "integration") {
    return context.proposalId
      ? "Resolve this integration proposal with AI."
      : "Resolve this integration PR with AI.";
  }
  return "Resolve this PR with AI.";
}

function buildPrAiSessionInfo(args: {
  context: PrAiResolutionContext;
  contextKey: string;
  sessionId: string;
  provider: "codex" | "claude";
  model: string | null;
  modelId: string | null;
  reasoning: string | null;
  permissionMode: PrAgentPermissionMode | null;
  status: PrAiResolutionSessionStatus;
}): PrAiResolutionSessionInfo {
  return {
    contextKey: args.contextKey,
    sessionId: args.sessionId,
    provider: args.provider,
    model: args.model,
    modelId: args.modelId,
    reasoning: args.reasoning,
    permissionMode: args.permissionMode,
    context: args.context,
    status: args.status,
  };
}

type PrAiRuntimeSession = {
  sessionId: string;
  ptyId: string | null;
  runId: string;
  provider: "codex" | "claude";
  contextKey: string;
  context: PrAiResolutionContext;
  modelId: string;
  reasoning: string | null;
  permissionMode: PrAgentPermissionMode;
  pollTimer: ReturnType<typeof setInterval> | null;
  finalizing: boolean;
};

type PrAiRuntimeState = {
  sessions: Map<string, PrAiRuntimeSession>;
  sessionsByContextKey: Map<string, string>;
};

function clearPrAiSession(state: PrAiRuntimeState, sessionId: string): void {
  const runtime = state.sessions.get(sessionId);
  if (!runtime) return;
  if (runtime.pollTimer) clearInterval(runtime.pollTimer);
  if (state.sessionsByContextKey.get(runtime.contextKey) === sessionId) {
    state.sessionsByContextKey.delete(runtime.contextKey);
  }
  state.sessions.delete(sessionId);
}

async function finalizePrAiSession(
  args: SyncRemoteCommandServiceArgs,
  state: PrAiRuntimeState,
  sessionId: string,
  opts: { forceStatus?: "cancelled" | "completed" | "failed"; message?: string } = {},
): Promise<void> {
  const runtime = state.sessions.get(sessionId);
  if (!runtime || runtime.finalizing) return;
  runtime.finalizing = true;
  const conflictService = requireService(args.conflictService, "Conflict service not available.");
  try {
    const detail = args.sessionService.get(sessionId);
    const derivedExitCode = opts.forceStatus === "cancelled"
      ? 130
      : (detail?.exitCode ?? (detail?.status === "completed" ? 0 : 1));
    try {
      await conflictService.finalizeResolverSession({
        runId: runtime.runId,
        exitCode: derivedExitCode,
      });
    } catch (error) {
      args.logger.debug("sync.prs_ai_resolution_finalize_failed", {
        sessionId,
        runId: runtime.runId,
        error: getErrorMessage(error),
      });
    }
  } finally {
    clearPrAiSession(state, sessionId);
  }
}

async function getRemotePrAiResolutionSession(
  args: SyncRemoteCommandServiceArgs,
  state: PrAiRuntimeState,
  payload: Record<string, unknown>,
): Promise<PrAiResolutionGetSessionResult> {
  const context = parseGetPrAiResolutionSessionArgs(payload).context;
  const contextKey = buildPrAiResolutionContextKey(context);
  const liveSessionId = state.sessionsByContextKey.get(contextKey);
  const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
  const conflictService = requireService(args.conflictService, "Conflict service not available.");
  const sessionSummaries = await agentChatService.listSessions();

  if (liveSessionId) {
    const runtime = state.sessions.get(liveSessionId);
    if (runtime) {
      const summary = sessionSummaries.find((entry) => entry.sessionId === liveSessionId) ?? null;
      return buildPrAiSessionInfo({
        context: runtime.context,
        contextKey,
        sessionId: liveSessionId,
        provider: runtime.provider,
        model: summary?.model ?? runtime.modelId,
        modelId: summary?.modelId ?? runtime.modelId,
        reasoning: summary?.reasoningEffort ?? runtime.reasoning,
        permissionMode: deriveAiPermissionModeFromSummary(summary) ?? runtime.permissionMode,
        status: "running",
      });
    }
    state.sessionsByContextKey.delete(contextKey);
  }

  const persistedRun = conflictService
    .listExternalResolverRuns({ limit: 200 })
    .find((entry) => entry.resolverContextKey === contextKey && entry.sessionId);
  if (!persistedRun?.sessionId) return null;

  const summary = sessionSummaries.find((entry) => entry.sessionId === persistedRun.sessionId) ?? null;
  return buildPrAiSessionInfo({
    context,
    contextKey,
    sessionId: persistedRun.sessionId,
    provider: persistedRun.provider,
    model: summary?.model ?? persistedRun.model ?? null,
    modelId: summary?.modelId ?? persistedRun.model ?? null,
    reasoning: summary?.reasoningEffort ?? persistedRun.reasoningEffort ?? null,
    permissionMode: deriveAiPermissionModeFromSummary(summary) ?? persistedRun.permissionMode ?? null,
    status: mapExternalResolverStatusToPrAi(persistedRun.status),
  });
}

async function startRemotePrAiResolution(
  args: SyncRemoteCommandServiceArgs,
  state: PrAiRuntimeState,
  payload: Record<string, unknown>,
): Promise<PrAiResolutionStartResult> {
  const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
  const conflictService = requireService(args.conflictService, "Conflict service not available.");
  const parsed = parseStartPrAiResolutionArgs(payload);
  const context = parsed.context;
  const model = parsed.model.trim();
  const targetLaneId = typeof context.targetLaneId === "string" ? context.targetLaneId.trim() : "";
  const sourceLaneIds = collectPrAiSourceLaneIds(context);
  const permissionMode: PrAgentPermissionMode = parsed.permissionMode ?? "default";
  const reasoning = typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0
    ? parsed.reasoning.trim()
    : null;
  const additionalInstructions = typeof parsed.additionalInstructions === "string" && parsed.additionalInstructions.trim().length > 0
    ? parsed.additionalInstructions.trim()
    : null;
  let runId = "";

  if (!model) {
    const sessionId = randomUUID();
    const error = "Model is required to start AI resolution.";
    return { sessionId, provider: "codex", ptyId: null, status: "failed", error, context };
  }
  if (!targetLaneId) {
    const sessionId = randomUUID();
    const error = "Target lane is required to start AI resolution.";
    return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
  }
  if (sourceLaneIds.length === 0) {
    const sessionId = randomUUID();
    const error = "At least one source lane is required to start AI resolution.";
    return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
  }

  try {
    const provider = inferPrAiProvider(model);
    const modelDescriptor = getModelById(model);
    const prep = await conflictService.prepareResolverSession({
      provider,
      targetLaneId,
      sourceLaneIds,
      cwdLaneId: typeof context.integrationLaneId === "string" && context.integrationLaneId.trim().length > 0
        ? context.integrationLaneId.trim()
        : (typeof context.laneId === "string" && context.laneId.trim().length > 0
          ? context.laneId.trim()
          : undefined),
      proposalId: typeof context.proposalId === "string" && context.proposalId.trim().length > 0
        ? context.proposalId.trim()
        : undefined,
      sourceTab: context.sourceTab,
      scenario: context.scenario ?? (sourceLaneIds.length > 1 ? "integration-merge" : "single-merge"),
      model,
      reasoningEffort: reasoning,
      permissionMode,
      additionalInstructions,
      originSurface:
        context.sourceTab === "integration" ? "integration"
          : context.sourceTab === "rebase" ? "rebase"
            : "manual",
    });
    runId = prep.runId;
    if (prep.status === "blocked") {
      const sessionId = randomUUID();
      const reason = prep.contextGaps.length
        ? prep.contextGaps.map((gap) => gap.message).join(", ")
        : "Resolver session blocked due to insufficient context.";
      return { sessionId, provider, ptyId: null, status: "failed", error: reason, context };
    }

    const session = await agentChatService.createSession({
      laneId: prep.cwdLaneId,
      provider,
      model: modelDescriptor?.shortId ?? model,
      ...(modelDescriptor?.id ? { modelId: modelDescriptor.id } : {}),
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
      ...mapPrAiPermissionModeToNativeFields(permissionMode, provider),
    });
    const promptText = fs.readFileSync(prep.promptFilePath, "utf8");
    const runtimeContext: PrAiResolutionContext = {
      ...context,
      laneId: prep.cwdLaneId,
      targetLaneId,
      sourceLaneId: sourceLaneIds[0] ?? context.sourceLaneId ?? context.laneId ?? null,
      sourceLaneIds,
      integrationLaneId: prep.integrationLaneId ?? context.integrationLaneId ?? null,
    };
    const contextKey = buildPrAiResolutionContextKey(runtimeContext);
    const runtime: PrAiRuntimeSession = {
      sessionId: session.id,
      ptyId: null,
      runId: prep.runId,
      provider,
      contextKey,
      context: runtimeContext,
      modelId: model,
      reasoning,
      permissionMode,
      pollTimer: null,
      finalizing: false,
    };
    await conflictService.attachResolverSession({
      runId: prep.runId,
      ptyId: null,
      sessionId: session.id,
      command: [],
    });
    runtime.pollTimer = setInterval(() => {
      const current = state.sessions.get(runtime.sessionId);
      if (!current || current.finalizing) return;
      const detail = args.sessionService.get(runtime.sessionId);
      if (!detail || detail.status === "running") return;
      void finalizePrAiSession(args, state, runtime.sessionId);
    }, 1_000);
    state.sessions.set(runtime.sessionId, runtime);
    state.sessionsByContextKey.set(contextKey, runtime.sessionId);
    void agentChatService.sendMessage({
      sessionId: runtime.sessionId,
      text: promptText,
      displayText: buildPrAiDisplayText(runtimeContext),
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
    }).catch(async (error: unknown) => {
      args.logger.warn("sync.prs_ai_resolution_send_failed", {
        sessionId: runtime.sessionId,
        runId: prep.runId,
        error: getErrorMessage(error),
      });
      await finalizePrAiSession(args, state, runtime.sessionId, {
        forceStatus: "failed",
        message: getErrorMessage(error),
      });
    });
    return {
      sessionId: runtime.sessionId,
      provider,
      ptyId: null,
      status: "started",
      error: null,
      context: runtimeContext,
    };
  } catch (error) {
    if (runId) {
      try {
        await conflictService.finalizeResolverSession({ runId, exitCode: 1 });
      } catch {
        // Best-effort cleanup mirrors desktop IPC behavior.
      }
    }
    const sessionId = randomUUID();
    const message = getErrorMessage(error);
    return {
      sessionId,
      provider: inferPrAiProvider(model),
      ptyId: null,
      status: "failed",
      error: message,
      context,
    };
  }
}

async function getRemoteTurnFileDiff(args: SyncRemoteCommandServiceArgs, payload: Record<string, unknown>) {
  const parsed = parseAgentChatTurnFileDiffArgs(payload);
  const cwd = requireProjectRoot(args, "chat.getTurnFileDiff");
  const language = parsed.filePath.split(".").pop() ?? undefined;
  const readSide = async (spec: string): Promise<{ exists: boolean; text: string; isTruncated?: boolean; isBinary?: boolean }> => {
    const result = await runGit(["show", spec], {
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: MAX_DIFF_SIDE_TEXT_BYTES + 64 * 1024,
    });
    if (result.exitCode !== 0) return { exists: false, text: "" };
    const buf = Buffer.from(result.stdout, "utf8");
    if (buf.includes(0)) return { exists: true, text: "", isBinary: true };
    if (buf.length <= MAX_DIFF_SIDE_TEXT_BYTES) return { exists: true, text: result.stdout };
    return {
      exists: true,
      text: appendDiffTruncationNotice(buf.subarray(0, MAX_DIFF_SIDE_TEXT_BYTES).toString("utf8")),
      isTruncated: true,
    };
  };
  const original = await readSide(`${parsed.beforeSha}:${parsed.filePath}`);
  const modified = await readSide(`${parsed.afterSha}:${parsed.filePath}`);
  return {
    path: parsed.filePath,
    mode: "commit",
    language,
    original,
    modified,
    ...(original.isBinary || modified.isBinary ? { isBinary: true } : {}),
  };
}

async function listRemoteWorkSessions(
  args: SyncRemoteCommandServiceArgs,
  filters: ListSessionsArgs,
) {
  const sessions = args.ptyService.enrichSessions(args.sessionService.list(filters));
  const laneId = typeof filters.laneId === "string" ? filters.laneId.trim() : "";
  const allChats = await args.agentChatService
    ?.listSessions(laneId || undefined, { includeIdentity: true })
    .catch(() => [] as AgentChatSessionSummary[]) ?? [];

  const identitySessionIds = new Set(
    allChats.filter((chat) => Boolean(chat.identityKey)).map((chat) => chat.sessionId),
  );
  const visibleSessions = identitySessionIds.size > 0
    ? sessions.filter((session) => !identitySessionIds.has(session.id))
    : sessions;

  const chatSummaryBySessionId = new Map(
    allChats.filter((chat) => !chat.identityKey).map((chat) => [chat.sessionId, chat] as const),
  );
  if (chatSummaryBySessionId.size === 0) return visibleSessions;

  return visibleSessions.map((session) => {
    if (!isChatToolType(session.toolType) || session.status !== "running") return session;
    const chat = chatSummaryBySessionId.get(session.id);
    if (!chat) return session;
    return projectChatOntoSession(session, chat);
  });
}

function parseSendToSessionArgs(value: Record<string, unknown>): SyncSendToSessionArgs {
  const text = requireString(value.text, "work.sendToSession requires text.");
  return {
    sessionId: requireString(value.sessionId, "work.sendToSession requires sessionId."),
    text,
    cols: asOptionalNumber(value.cols),
    rows: asOptionalNumber(value.rows),
    model: asTrimmedString(value.model),
    reasoningEffort: asTrimmedString(value.reasoningEffort),
    fastMode: asOptionalBoolean(value.fastMode),
    permissionMode: parseOptionalCliPermissionMode(value.permissionMode),
    codexApprovalPolicy: parseOptionalCodexApprovalPolicy(value.codexApprovalPolicy),
    codexSandbox: parseOptionalCodexSandbox(value.codexSandbox),
    codexConfigSource: parseOptionalCodexConfigSource(value.codexConfigSource),
  };
}

function parseStopRuntimeArgs(value: Record<string, unknown>): { sessionId: string } {
  return {
    sessionId: requireString(value.sessionId, "work.stopRuntime requires sessionId."),
  };
}

function parseAgentChatListArgs(value: Record<string, unknown>): AgentChatListArgs {
  return {
    ...(asTrimmedString(value.laneId) ? { laneId: asTrimmedString(value.laneId)! } : {}),
    includeAutomation: asOptionalBoolean(value.includeAutomation),
    includeArchived: asOptionalBoolean(value.includeArchived),
  };
}

function parseAgentChatGetSummaryArgs(value: Record<string, unknown>): AgentChatGetSummaryArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.getSummary requires sessionId."),
  };
}

function parseAgentChatCreateArgs(value: Record<string, unknown>): AgentChatCreateArgs {
  const parsed: AgentChatCreateArgs = {
    laneId: requireString(value.laneId, "chat.create requires laneId."),
    provider: (asTrimmedString(value.provider) ?? "codex") as AgentChatCreateArgs["provider"],
    model: asTrimmedString(value.model) ?? "",
    ...(asTrimmedString(value.modelId) ? { modelId: asTrimmedString(value.modelId)! } : {}),
    ...(asTrimmedString(value.reasoningEffort) ? { reasoningEffort: asTrimmedString(value.reasoningEffort)! } : {}),
  };

  if ("sessionProfile" in value) parsed.sessionProfile = value.sessionProfile == null ? undefined : asTrimmedString(value.sessionProfile) as AgentChatCreateArgs["sessionProfile"];
  if ("permissionMode" in value) parsed.permissionMode = value.permissionMode == null ? undefined : asTrimmedString(value.permissionMode) as AgentChatCreateArgs["permissionMode"];
  if ("interactionMode" in value) parsed.interactionMode = value.interactionMode == null ? null : asTrimmedString(value.interactionMode) as AgentChatCreateArgs["interactionMode"];
  if ("claudePermissionMode" in value) parsed.claudePermissionMode = value.claudePermissionMode == null ? undefined : asTrimmedString(value.claudePermissionMode) as AgentChatCreateArgs["claudePermissionMode"];
  if ("claudeOutputStyle" in value) parsed.claudeOutputStyle = value.claudeOutputStyle == null ? null : asTrimmedString(value.claudeOutputStyle) ?? null;
  if ("codexApprovalPolicy" in value) parsed.codexApprovalPolicy = value.codexApprovalPolicy == null ? undefined : asTrimmedString(value.codexApprovalPolicy) as AgentChatCreateArgs["codexApprovalPolicy"];
  if ("codexSandbox" in value) parsed.codexSandbox = value.codexSandbox == null ? undefined : asTrimmedString(value.codexSandbox) as AgentChatCreateArgs["codexSandbox"];
  if ("codexConfigSource" in value) parsed.codexConfigSource = value.codexConfigSource == null ? undefined : asTrimmedString(value.codexConfigSource) as AgentChatCreateArgs["codexConfigSource"];
  if ("fastMode" in value || "codexFastMode" in value) {
    parsed.fastMode = asOptionalBoolean(value.fastMode) ?? asOptionalBoolean(value.codexFastMode);
  }
  if ("opencodePermissionMode" in value) parsed.opencodePermissionMode = value.opencodePermissionMode == null ? undefined : asTrimmedString(value.opencodePermissionMode) as AgentChatCreateArgs["opencodePermissionMode"];
  if ("droidPermissionMode" in value) parsed.droidPermissionMode = value.droidPermissionMode == null ? undefined : (asTrimmedString(value.droidPermissionMode) ?? undefined) as AgentChatCreateArgs["droidPermissionMode"];
  if ("cursorModeId" in value) parsed.cursorModeId = value.cursorModeId == null ? null : asTrimmedString(value.cursorModeId) ?? null;
  if ("cursorConfigValues" in value) parsed.cursorConfigValues = parseCursorConfigValues(value.cursorConfigValues);
  if ("requestedCwd" in value) parsed.requestedCwd = value.requestedCwd == null ? undefined : requireString(value.requestedCwd, "chat.create requires a non-empty requestedCwd when provided.");

  return parsed;
}

function parseAgentChatSendArgs(value: Record<string, unknown>): AgentChatSendArgs {
  const attachments = parseAgentChatFileRefs(value.attachments);
  return {
    sessionId: requireString(value.sessionId, "chat.send requires sessionId."),
    text: requireString(value.text, "chat.send requires text."),
    ...(asTrimmedString(value.displayText) ? { displayText: asTrimmedString(value.displayText)! } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(asTrimmedString(value.reasoningEffort) ? { reasoningEffort: asTrimmedString(value.reasoningEffort)! } : {}),
    ...(asTrimmedString(value.executionMode) ? { executionMode: asTrimmedString(value.executionMode)! as AgentChatSendArgs["executionMode"] } : {}),
    ...(asTrimmedString(value.interactionMode) ? { interactionMode: asTrimmedString(value.interactionMode)! as AgentChatSendArgs["interactionMode"] } : {}),
  };
}

function parseAgentChatSteerArgs(value: Record<string, unknown>): AgentChatSteerArgs {
  const attachments = parseAgentChatFileRefs(value.attachments);
  const dispatchMode = value.dispatchMode;
  if (dispatchMode !== undefined && dispatchMode !== "inline" && dispatchMode !== "interrupt") {
    throw new Error("chat.steer dispatchMode must be 'inline' or 'interrupt'.");
  }
  return {
    sessionId: requireString(value.sessionId, "chat.steer requires sessionId."),
    text: requireString(value.text, "chat.steer requires text."),
    ...(attachments?.length ? { attachments } : {}),
    ...(dispatchMode ? { dispatchMode } : {}),
  };
}

function parseAgentChatCancelSteerArgs(value: Record<string, unknown>): AgentChatCancelSteerArgs {
  if (value.requireQueued !== undefined && typeof value.requireQueued !== "boolean") {
    throw new Error("chat.cancelSteer requireQueued must be a boolean.");
  }
  return {
    sessionId: requireString(value.sessionId, "chat.cancelSteer requires sessionId."),
    steerId: requireString(value.steerId, "chat.cancelSteer requires steerId."),
    ...(value.requireQueued === true ? { requireQueued: true } : {}),
  };
}

function parseAgentChatEditSteerArgs(value: Record<string, unknown>): AgentChatEditSteerArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.editSteer requires sessionId."),
    steerId: requireString(value.steerId, "chat.editSteer requires steerId."),
    text: requireString(value.text, "chat.editSteer requires text."),
  };
}

function parseAgentChatDispatchSteerArgs(value: Record<string, unknown>): AgentChatDispatchSteerArgs {
  const mode = value.mode;
  if (mode !== "inline" && mode !== "interrupt") {
    throw new Error("chat.dispatchSteer requires mode of 'inline' or 'interrupt'.");
  }
  return {
    sessionId: requireString(value.sessionId, "chat.dispatchSteer requires sessionId."),
    steerId: requireString(value.steerId, "chat.dispatchSteer requires steerId."),
    mode,
  };
}

function parseAgentChatCancelDispatchedSteerArgs(value: Record<string, unknown>): AgentChatCancelDispatchedSteerArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.cancelDispatchedSteer requires sessionId."),
    steerId: requireString(value.steerId, "chat.cancelDispatchedSteer requires steerId."),
  };
}

function parseAgentChatInterruptArgs(value: Record<string, unknown>): AgentChatInterruptArgs {
  const mode = value.mode;
  if (mode !== undefined && mode !== "stop_and_clear" && mode !== "stop_only") {
    throw new Error("chat.interrupt mode must be 'stop_and_clear' or 'stop_only'.");
  }
  return {
    sessionId: requireString(value.sessionId, "chat.interrupt requires sessionId."),
    ...(mode ? { mode } : {}),
  };
}

function parseAgentChatRestoreCancelledQueueArgs(value: Record<string, unknown>): AgentChatRestoreCancelledQueueArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.restoreCancelledQueue requires sessionId."),
    recoveryId: requireString(value.recoveryId, "chat.restoreCancelledQueue requires recoveryId."),
  };
}

function parseAgentChatRecoverCodexTurnArgs(value: Record<string, unknown>): AgentChatRecoverCodexTurnArgs {
  const action = requireString(value.action, "chat.recoverCodexTurn requires action.");
  if (
    action !== "wait"
    && action !== "steer"
    && action !== "interrupt_retry_same_thread"
    && action !== "restart_resume_thread"
  ) {
    throw new Error(`chat.recoverCodexTurn received unsupported action '${action}'.`);
  }
  return {
    sessionId: requireString(value.sessionId, "chat.recoverCodexTurn requires sessionId."),
    turnId: requireString(value.turnId, "chat.recoverCodexTurn requires turnId."),
    action,
  };
}

function parseAgentChatRecoverTurnArgs(value: Record<string, unknown>): AgentChatRecoverTurnArgs {
  const action = requireString(value.action, "chat.recoverTurn requires action.");
  if (!isAgentChatTurnRecoveryAction(action)) {
    throw new Error(`chat.recoverTurn received unsupported action '${action}'.`);
  }
  return {
    sessionId: requireString(value.sessionId, "chat.recoverTurn requires sessionId."),
    turnId: requireString(value.turnId, "chat.recoverTurn requires turnId."),
    action,
  };
}

function parseAgentChatResolveUnprocessedMessageArgs(
  value: Record<string, unknown>,
): AgentChatResolveUnprocessedMessageArgs {
  const action = requireString(
    value.action,
    "chat.resolveUnprocessedMessage requires action.",
  );
  if (action !== "run_next" && action !== "dismiss") {
    throw new Error(`chat.resolveUnprocessedMessage received unsupported action '${action}'.`);
  }
  return {
    sessionId: requireString(
      value.sessionId,
      "chat.resolveUnprocessedMessage requires sessionId.",
    ),
    steerId: requireString(
      value.steerId,
      "chat.resolveUnprocessedMessage requires steerId.",
    ),
    action,
  };
}

function parseAgentChatApproveArgs(value: Record<string, unknown>): AgentChatApproveArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.approve requires sessionId."),
    itemId: requireString(value.itemId, "chat.approve requires itemId."),
    decision: requireString(value.decision, "chat.approve requires decision.") as AgentChatApproveArgs["decision"],
    ...(asTrimmedString(value.responseText) ? { responseText: asTrimmedString(value.responseText)! } : {}),
  };
}

function parseAgentChatRespondToInputArgs(value: Record<string, unknown>): AgentChatRespondToInputArgs {
  const parsed: AgentChatRespondToInputArgs = {
    sessionId: requireString(value.sessionId, "chat.respondToInput requires sessionId."),
    itemId: requireString(value.itemId, "chat.respondToInput requires itemId."),
  };

  if (typeof value.decision === "string" && value.decision.trim().length > 0) {
    parsed.decision = value.decision.trim() as AgentChatRespondToInputArgs["decision"];
  }
  if (isRecord(value.answers)) {
    parsed.answers = Object.fromEntries(
      Object.entries(value.answers).map(([key, entry]) => {
        if (Array.isArray(entry)) {
          return [key, entry.map((item) => String(item))];
        }
        return [key, String(entry)];
      }),
    );
  }
  if (typeof value.responseText === "string" && value.responseText.trim().length > 0) {
    parsed.responseText = value.responseText.trim();
  }
  return parsed;
}

function parseAgentChatUpdateSessionArgs(value: Record<string, unknown>): AgentChatUpdateSessionArgs {
  const parsed: AgentChatUpdateSessionArgs = {
    sessionId: requireString(value.sessionId, "chat.updateSession requires sessionId."),
  };

  if ("title" in value) parsed.title = value.title == null ? null : asTrimmedString(value.title) ?? null;
  if ("modelId" in value) parsed.modelId = value.modelId == null ? undefined : asTrimmedString(value.modelId) as AgentChatUpdateSessionArgs["modelId"];
  if ("reasoningEffort" in value) parsed.reasoningEffort = value.reasoningEffort == null ? null : asTrimmedString(value.reasoningEffort) ?? null;
  if ("permissionMode" in value) parsed.permissionMode = value.permissionMode == null ? undefined : asTrimmedString(value.permissionMode) as AgentChatUpdateSessionArgs["permissionMode"];
  if ("interactionMode" in value) parsed.interactionMode = value.interactionMode == null ? null : asTrimmedString(value.interactionMode) as AgentChatUpdateSessionArgs["interactionMode"];
  if ("claudePermissionMode" in value) parsed.claudePermissionMode = value.claudePermissionMode == null ? undefined : asTrimmedString(value.claudePermissionMode) as AgentChatUpdateSessionArgs["claudePermissionMode"];
  if ("codexApprovalPolicy" in value) parsed.codexApprovalPolicy = value.codexApprovalPolicy == null ? undefined : asTrimmedString(value.codexApprovalPolicy) as AgentChatUpdateSessionArgs["codexApprovalPolicy"];
  if ("codexSandbox" in value) parsed.codexSandbox = value.codexSandbox == null ? undefined : asTrimmedString(value.codexSandbox) as AgentChatUpdateSessionArgs["codexSandbox"];
  if ("codexConfigSource" in value) parsed.codexConfigSource = value.codexConfigSource == null ? undefined : asTrimmedString(value.codexConfigSource) as AgentChatUpdateSessionArgs["codexConfigSource"];
  if ("fastMode" in value || "codexFastMode" in value) {
    parsed.fastMode = asOptionalBoolean(value.fastMode) ?? asOptionalBoolean(value.codexFastMode);
  }
  if ("opencodePermissionMode" in value) parsed.opencodePermissionMode = value.opencodePermissionMode == null ? undefined : asTrimmedString(value.opencodePermissionMode) as AgentChatUpdateSessionArgs["opencodePermissionMode"];
  if ("droidPermissionMode" in value) parsed.droidPermissionMode = value.droidPermissionMode == null ? undefined : asTrimmedString(value.droidPermissionMode) as AgentChatUpdateSessionArgs["droidPermissionMode"];
  if ("cursorModeId" in value) parsed.cursorModeId = value.cursorModeId == null ? null : asTrimmedString(value.cursorModeId) ?? null;
  if ("cursorConfigValues" in value) {
    parsed.cursorConfigValues = parseCursorConfigValues(value.cursorConfigValues);
  }
  if ("manuallyNamed" in value) parsed.manuallyNamed = value.manuallyNamed === true;
  return parsed;
}

function parseAgentChatCodexGetGoalArgs(value: Record<string, unknown>): AgentChatCodexGetGoalArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.getCodexGoal requires sessionId."),
  };
}

function parseAgentChatCodexSetGoalArgs(value: Record<string, unknown>): AgentChatCodexSetGoalArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.setCodexGoal requires sessionId."),
    objective: requireString(value.objective, "chat.setCodexGoal requires objective."),
  };
}

function parseAgentChatCodexSetGoalStatusArgs(value: Record<string, unknown>): AgentChatCodexSetGoalStatusArgs {
  const status = requireString(value.status, "chat.setCodexGoalStatus requires status.");
  if (status !== "active" && status !== "paused" && status !== "blocked" && status !== "complete") {
    throw new Error("chat.setCodexGoalStatus requires status to be active, paused, blocked, or complete.");
  }
  return {
    sessionId: requireString(value.sessionId, "chat.setCodexGoalStatus requires sessionId."),
    status,
  };
}

function parseAgentChatCodexClearGoalArgs(value: Record<string, unknown>): AgentChatCodexClearGoalArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.clearCodexGoal requires sessionId."),
  };
}

function parseAgentChatArchiveArgs(value: Record<string, unknown>, action: string): AgentChatArchiveArgs {
  return {
    sessionId: requireString(value.sessionId, `${action} requires sessionId.`),
  };
}

function parseGetTranscriptArgs(value: Record<string, unknown>): {
  sessionId: string;
  limit?: number;
  maxChars?: number;
  cursor?: number;
  cursorKind?: "byte";
} {
  return {
    sessionId: requireString(value.sessionId, "chat.getTranscript requires sessionId."),
    limit: asOptionalNumber(value.limit),
    maxChars: asOptionalNumber(value.maxChars),
    cursor: parseTranscriptCursor(value.cursor),
    ...(value.cursorKind === "byte" ? { cursorKind: "byte" as const } : {}),
  };
}

function parseAgentChatSubagentTranscriptArgs(value: Record<string, unknown>): AgentChatSubagentTranscriptArgs {
  const parsed: AgentChatSubagentTranscriptArgs = {
    sessionId: requireString(value.sessionId, "chat.getSubagentTranscript requires sessionId."),
    agentId: requireString(value.agentId, "chat.getSubagentTranscript requires agentId."),
  };
  const taskId = asTrimmedString(value.taskId);
  const laneId = asTrimmedString(value.laneId);
  const limit = asOptionalNumber(value.limit);
  const offset = asOptionalNumber(value.offset);
  if (taskId) parsed.taskId = taskId;
  if (laneId) parsed.laneId = laneId;
  if (limit !== undefined) parsed.limit = limit;
  if (offset !== undefined) parsed.offset = offset;
  return parsed;
}

function parseAgentChatMainTranscriptArgs(value: Record<string, unknown>): AgentChatMainTranscriptArgs {
  const parsed: AgentChatMainTranscriptArgs = {
    sessionId: requireString(value.sessionId, "chat.getMainTranscript requires sessionId."),
  };
  const limit = asOptionalNumber(value.limit);
  const offset = asOptionalNumber(value.offset);
  if (limit !== undefined) parsed.limit = limit;
  if (offset !== undefined) parsed.offset = offset;
  return parsed;
}

function parseAgentChatSubagentListArgs(value: Record<string, unknown>): AgentChatSubagentListArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.listSubagents requires sessionId."),
  };
}

// Pagination cursor for chat.getTranscript. New hosts use the logical JSONL
// byte offset of the oldest entry returned. Offsets remain stable while the
// append-only transcript grows and avoid parsing the full transcript.
function parseTranscriptCursor(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim().length ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return undefined;
  const index = Math.floor(parsed);
  return index >= 0 ? index : undefined;
}

const TRANSCRIPT_PAGE_DEFAULT_LIMIT = 200;
const TRANSCRIPT_PAGE_MAX_LIMIT = 1_000;
const TRANSCRIPT_PAGE_DEFAULT_MAX_CHARS = 600_000;
const TRANSCRIPT_PAGE_MAX_CHARS = 2_000_000;

function boundTranscriptEntriesByChars(
  page: AgentChatTranscriptEntry[],
  maxChars: number,
): { entries: AgentChatTranscriptEntry[]; truncated: boolean } {
  let remainingChars = maxChars;
  let truncated = false;
  const bounded: AgentChatTranscriptEntry[] = [];
  for (let index = page.length - 1; index >= 0; index -= 1) {
    const entry = page[index]!;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
    if (entry.text.length <= remainingChars) {
      bounded.push(entry);
      remainingChars -= entry.text.length;
      continue;
    }
    bounded.push({
      ...entry,
      text: remainingChars > 3
        ? `${entry.text.slice(0, remainingChars - 3).trimEnd()}...`
        : entry.text.slice(0, remainingChars),
    });
    truncated = true;
    break;
  }
  bounded.reverse();
  return { entries: bounded, truncated };
}

function parseGitFileActionArgs(value: Record<string, unknown>, action: string): GitFileActionArgs {
  return {
    laneId: requireString(value.laneId, `${action} requires laneId.`),
    path: requireString(value.path, `${action} requires path.`),
  };
}

function parseGitBatchFileActionArgs(value: Record<string, unknown>, action: string): GitBatchFileActionArgs {
  return {
    laneId: requireString(value.laneId, `${action} requires laneId.`),
    paths: requireStringArray(value.paths, `${action} requires paths.`),
  };
}

function parseWriteTextAtomicArgs(value: Record<string, unknown>): WriteTextAtomicArgs {
  if (typeof value.text !== "string") {
    throw new Error("files.writeTextAtomic requires text.");
  }
  return {
    laneId: requireString(value.laneId, "files.writeTextAtomic requires laneId."),
    path: requireString(value.path, "files.writeTextAtomic requires path."),
    text: value.text,
  };
}

function parseGitCommitArgs(value: Record<string, unknown>): GitCommitArgs {
  return {
    laneId: requireString(value.laneId, "git.commit requires laneId."),
    message: requireString(value.message, "git.commit requires message."),
    amend: asOptionalBoolean(value.amend),
  };
}

function parseGitGenerateCommitMessageArgs(value: Record<string, unknown>): GitGenerateCommitMessageArgs {
  return {
    laneId: requireString(value.laneId, "git.generateCommitMessage requires laneId."),
    amend: asOptionalBoolean(value.amend),
  };
}

function parseGitListRecentCommitsArgs(value: Record<string, unknown>): { laneId: string; limit?: number } {
  return {
    laneId: requireString(value.laneId, "git.listRecentCommits requires laneId."),
    limit: asOptionalNumber(value.limit),
  };
}

function parseGitListCommitFilesArgs(value: Record<string, unknown>): GitListCommitFilesArgs {
  return {
    laneId: requireString(value.laneId, "git.listCommitFiles requires laneId."),
    commitSha: requireString(value.commitSha, "git.listCommitFiles requires commitSha."),
  };
}

function parseGitGetCommitMessageArgs(value: Record<string, unknown>): GitGetCommitMessageArgs {
  return {
    laneId: requireString(value.laneId, "git.getCommitMessage requires laneId."),
    commitSha: requireString(value.commitSha, "git.getCommitMessage requires commitSha."),
  };
}

function parseGitGetCommitArgs(value: Record<string, unknown>): { laneId: string; commitSha: string } {
  return {
    laneId: requireString(value.laneId, "git.getCommit requires laneId."),
    commitSha: requireString(value.commitSha, "git.getCommit requires commitSha."),
  };
}

function parseGitOpenPrForBranchArgs(value: Record<string, unknown>): { laneId: string; branch?: string } {
  const branch = asTrimmedString(value.branch);
  return {
    laneId: requireString(value.laneId, "git.getOpenPrForBranch requires laneId."),
    ...(branch ? { branch } : {}),
  };
}

function parseGitCommitReachabilityArgs(value: Record<string, unknown>): { laneId: string; commitSha: string } {
  return {
    laneId: requireString(value.laneId, "git.isCommitInLaneHistory requires laneId."),
    commitSha: requireString(value.commitSha, "git.isCommitInLaneHistory requires commitSha."),
  };
}

function parseGitGetFileHistoryArgs(value: Record<string, unknown>): GitGetFileHistoryArgs {
  return {
    laneId: requireString(value.laneId, "git.getFileHistory requires laneId."),
    path: requireString(value.path, "git.getFileHistory requires path."),
    limit: asOptionalNumber(value.limit),
  };
}

function parseGitRevertArgs(value: Record<string, unknown>): GitRevertArgs {
  return {
    laneId: requireString(value.laneId, "git.revertCommit requires laneId."),
    commitSha: requireString(value.commitSha, "git.revertCommit requires commitSha."),
  };
}

function parseGitCherryPickArgs(value: Record<string, unknown>): GitCherryPickArgs {
  return {
    laneId: requireString(value.laneId, "git.cherryPickCommit requires laneId."),
    commitSha: requireString(value.commitSha, "git.cherryPickCommit requires commitSha."),
  };
}

function parseGitCreateTagArgs(value: Record<string, unknown>): GitCreateTagArgs {
  return {
    laneId: requireString(value.laneId, "git.createTag requires laneId."),
    commitSha: requireString(value.commitSha, "git.createTag requires commitSha."),
    tagName: requireString(value.tagName, "git.createTag requires tagName."),
    ...(asTrimmedString(value.message) ? { message: asTrimmedString(value.message)! } : {}),
  };
}

function parseGitResetCommitArgs(value: Record<string, unknown>): GitResetCommitArgs {
  const mode = requireString(value.mode, "git.resetToCommit requires mode.");
  if (mode !== "soft" && mode !== "mixed" && mode !== "hard") {
    throw new Error("git.resetToCommit mode must be soft, mixed, or hard.");
  }
  return {
    laneId: requireString(value.laneId, "git.resetToCommit requires laneId."),
    commitSha: requireString(value.commitSha, "git.resetToCommit requires commitSha."),
    mode,
  };
}

function parseGitStashPushArgs(value: Record<string, unknown>): GitStashPushArgs {
  return {
    laneId: requireString(value.laneId, "git.stashPush requires laneId."),
    ...(asTrimmedString(value.message) ? { message: asTrimmedString(value.message)! } : {}),
    includeUntracked: asOptionalBoolean(value.includeUntracked),
  };
}

function parseGitStashRefArgs(value: Record<string, unknown>, action: string): GitStashRefArgs {
  const stashOid = asTrimmedString(value.stashOid);
  const destructive = action === "git.stashPop" || action === "git.stashDrop";
  if (destructive && !stashOid) {
    throw new Error(`${action} requires stashOid.`);
  }
  return {
    laneId: requireString(value.laneId, `${action} requires laneId.`),
    stashRef: requireString(value.stashRef, `${action} requires stashRef.`),
    ...(stashOid ? { stashOid } : {}),
  };
}

function parseGitSyncArgs(value: Record<string, unknown>): GitSyncArgs {
  return {
    laneId: requireString(value.laneId, "git.sync requires laneId."),
    ...(asTrimmedString(value.mode) ? { mode: value.mode as GitSyncArgs["mode"] } : {}),
    ...(asTrimmedString(value.baseRef) ? { baseRef: asTrimmedString(value.baseRef)! } : {}),
  };
}

function normalizeGitPullMode(value: unknown, action: string): GitPullMode | undefined {
  const raw = asTrimmedString(value);
  if (!raw) return undefined;
  const mode = raw === "ff_only" ? "ff-only" : raw;
  if (mode !== "ff-only" && mode !== "rebase" && mode !== "merge") {
    throw new Error(`${action} mode must be ff-only, rebase, or merge.`);
  }
  return mode;
}

function parseGitPullArgs(value: Record<string, unknown>): GitPullArgs {
  const mode = normalizeGitPullMode(value.mode, "git.pull");
  return {
    laneId: requireString(value.laneId, "git.pull requires laneId."),
    ...(mode ? { mode } : {}),
  };
}

function parseGitPushArgs(value: Record<string, unknown>): GitPushArgs {
  return {
    laneId: requireString(value.laneId, "git.push requires laneId."),
    forceWithLease: asOptionalBoolean(value.forceWithLease),
  };
}

function parseGetDiffChangesArgs(value: Record<string, unknown>): GetDiffChangesArgs {
  return {
    laneId: requireString(value.laneId, "git.getChanges requires laneId."),
  };
}

function parseGetFileDiffArgs(value: Record<string, unknown>): GetFileDiffArgs {
  return {
    laneId: requireString(value.laneId, "git.getFile requires laneId."),
    path: requireString(value.path, "git.getFile requires path."),
    mode: requireString(value.mode, "git.getFile requires mode.") as GetFileDiffArgs["mode"],
    ...(asTrimmedString(value.compareRef) ? { compareRef: asTrimmedString(value.compareRef)! } : {}),
    ...(asTrimmedString(value.compareTo) ? { compareTo: value.compareTo as GetFileDiffArgs["compareTo"] } : {}),
  };
}

function parseGetFilePatchArgs(value: Record<string, unknown>): GetFileDiffArgs {
  return {
    laneId: requireString(value.laneId, "git.getFilePatch requires laneId."),
    path: requireString(value.path, "git.getFilePatch requires path."),
    mode: requireString(value.mode, "git.getFilePatch requires mode.") as GetFileDiffArgs["mode"],
    ...(asTrimmedString(value.compareRef) ? { compareRef: asTrimmedString(value.compareRef)! } : {}),
    ...(asTrimmedString(value.compareTo) ? { compareTo: value.compareTo as GetFileDiffArgs["compareTo"] } : {}),
  };
}

function parseGitListBranchesArgs(value: Record<string, unknown>): GitListBranchesArgs {
  return {
    laneId: requireString(value.laneId, "git.listBranches requires laneId."),
  };
}

function parseGitCheckoutBranchArgs(value: Record<string, unknown>): GitCheckoutBranchArgs {
  return {
    laneId: requireString(value.laneId, "git.checkoutBranch requires laneId."),
    branchName: requireString(value.branchName, "git.checkoutBranch requires branchName."),
    ...(asTrimmedString(value.mode) ? { mode: value.mode as GitCheckoutBranchArgs["mode"] } : {}),
    ...(asTrimmedString(value.startPoint) ? { startPoint: asTrimmedString(value.startPoint)! } : {}),
    ...(asTrimmedString(value.baseRef) ? { baseRef: asTrimmedString(value.baseRef)! } : {}),
    ...(asOptionalBoolean(value.acknowledgeActiveWork) !== undefined
      ? { acknowledgeActiveWork: asOptionalBoolean(value.acknowledgeActiveWork) }
      : {}),
  };
}

function parseConflictLaneArgs(value: Record<string, unknown>, action: string): { laneId: string } {
  return {
    laneId: requireString(value.laneId, `${action} requires laneId.`),
  };
}

function parseLaneIdArgs(value: Record<string, unknown>, action: string): { laneId: string } {
  return parseConflictLaneArgs(value, action);
}

function parseCursorModelSource(value: unknown): "sdk" | "cli" | "all" | null {
  const source = asTrimmedString(value);
  return source === "sdk" || source === "cli" || source === "all" ? source : null;
}

function parseChatModelsArgs(value: Record<string, unknown>): {
  provider: AgentChatProvider;
  activateRuntime?: boolean;
  cursorSource?: "sdk" | "cli" | "all";
} {
  const cursorSource = parseCursorModelSource(value.cursorSource);
  return {
    provider: (asTrimmedString(value.provider) ?? "codex") as AgentChatProvider,
    ...(value.activateRuntime === true ? { activateRuntime: true } : {}),
    ...(cursorSource ? { cursorSource } : {}),
  };
}

function parseChatModelCatalogArgs(value: Record<string, unknown>): AgentChatModelCatalogArgs {
  const mode = asTrimmedString(value.mode) as AgentChatModelCatalogMode | null;
  const refreshProvider = asTrimmedString(value.refreshProvider) as AgentChatModelCatalogRefreshProvider | null;
  const cursorSource = parseCursorModelSource(value.cursorSource);
  return {
    ...(mode === "cached" || mode === "refresh-stale" || mode === "force" ? { mode } : {}),
    ...(
      refreshProvider === "opencode"
      || refreshProvider === "cursor"
      || refreshProvider === "droid"
      || refreshProvider === "lmstudio"
      || refreshProvider === "ollama"
        ? { refreshProvider }
        : {}
    ),
    ...(cursorSource ? { cursorSource } : {}),
  };
}

function requirePrId(value: Record<string, unknown>, action: string): string {
  return requireString(value.prId, `${action} requires prId.`);
}

function requirePrGithubCoords(value: Record<string, unknown>, action: string): PrGithubCoords {
  const repoOwner = requireString(value.repoOwner, `${action} requires repoOwner.`);
  const repoName = requireString(value.repoName, `${action} requires repoName.`);
  const githubPrNumber = asOptionalNumber(value.githubPrNumber);
  if (githubPrNumber == null || !Number.isInteger(githubPrNumber) || githubPrNumber <= 0) {
    throw new Error(`${action} requires a positive integer githubPrNumber.`);
  }
  return { repoOwner, repoName, githubPrNumber };
}

function parseGithubStackRepo(
  value: Record<string, unknown>,
  action: string,
): GitHubRepoRef | undefined {
  const owner = asTrimmedString(value.repoOwner);
  const name = asTrimmedString(value.repoName);
  if (!owner && !name) return undefined;
  if (!owner || !name) throw new Error(`${action} requires both repoOwner and repoName.`);
  return { owner, name };
}

function requirePositiveIntegerArray(value: unknown, message: string): number[] {
  if (!Array.isArray(value)) throw new Error(message);
  const numbers = value.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isInteger(entry) || entry <= 0)) {
    throw new Error(message);
  }
  return numbers;
}

function parseListGithubStacksArgs(
  value: Record<string, unknown>,
  action: string,
): ListGitHubPrStacksArgs {
  const repo = parseGithubStackRepo(value, action);
  return repo ? { repo } : {};
}

function parseCreateGithubStackArgs(value: Record<string, unknown>): CreateGitHubPrStackArgs {
  const repo = parseGithubStackRepo(value, "prs.createGithubStack");
  return {
    ...(repo ? { repo } : {}),
    pullRequests: requirePositiveIntegerArray(
      value.pullRequests,
      "prs.createGithubStack requires positive integer pullRequests.",
    ),
  };
}

function parseAddGithubStackPullRequestsArgs(
  value: Record<string, unknown>,
): AddGitHubPrStackPullRequestsArgs {
  const repo = parseGithubStackRepo(value, "prs.addGithubStackPullRequests");
  const stackNumber = asOptionalNumber(value.stackNumber);
  if (stackNumber == null || !Number.isInteger(stackNumber) || stackNumber <= 0) {
    throw new Error("prs.addGithubStackPullRequests requires a positive integer stackNumber.");
  }
  return {
    ...(repo ? { repo } : {}),
    stackNumber,
    pullRequests: requirePositiveIntegerArray(
      value.pullRequests,
      "prs.addGithubStackPullRequests requires positive integer pullRequests.",
    ),
  };
}

function parseUnstackGithubStackArgs(
  value: Record<string, unknown>,
): UnstackGitHubPrStackArgs {
  const repo = parseGithubStackRepo(value, "prs.unstackGithubStack");
  const stackNumber = asOptionalNumber(value.stackNumber);
  if (stackNumber == null || !Number.isInteger(stackNumber) || stackNumber <= 0) {
    throw new Error("prs.unstackGithubStack requires a positive integer stackNumber.");
  }
  return {
    ...(repo ? { repo } : {}),
    stackNumber,
  };
}

function parseCreatePrArgs(value: Record<string, unknown>): CreatePrFromLaneArgs {
  const laneId = asTrimmedString(value.laneId);
  const title = asTrimmedString(value.title);
  const body = typeof value.body === "string" ? value.body : "";
  if (!laneId || !title) throw new Error("prs.createFromLane requires laneId and title.");
  const strategy: CreatePrFromLaneArgs["strategy"] =
    normalizePrCreationStrategy(asTrimmedString(value.strategy)) ?? undefined;
  return {
    laneId,
    title,
    body,
    draft: value.draft === true,
    ...(asTrimmedString(value.baseBranch) ? { baseBranch: asTrimmedString(value.baseBranch)! } : {}),
    ...(asStringArray(value.labels).length ? { labels: asStringArray(value.labels) } : {}),
    ...(asStringArray(value.reviewers).length ? { reviewers: asStringArray(value.reviewers) } : {}),
    ...(typeof value.allowDirtyWorktree === "boolean" ? { allowDirtyWorktree: value.allowDirtyWorktree } : {}),
    ...(typeof value.closeLinearIssueOnMerge === "boolean" ? { closeLinearIssueOnMerge: value.closeLinearIssueOnMerge } : {}),
    ...(strategy ? { strategy } : {}),
  };
}

function parseLinkPrToLaneArgs(value: Record<string, unknown>): LinkPrToLaneArgs {
  return {
    laneId: requireString(value.laneId, "prs.linkToLane requires laneId."),
    prUrlOrNumber: requireString(value.prUrlOrNumber, "prs.linkToLane requires prUrlOrNumber."),
  };
}

function parseCreateLaneFromPrBranchArgs(value: Record<string, unknown>): CreateLaneFromPrBranchArgs {
  const repoOwner = requireString(value.repoOwner, "prs.createLaneFromPrBranch requires repoOwner.");
  const repoName = requireString(value.repoName, "prs.createLaneFromPrBranch requires repoName.");
  const githubPrNumber = asOptionalNumber(value.githubPrNumber);
  if (githubPrNumber == null || !Number.isInteger(githubPrNumber) || githubPrNumber <= 0) {
    throw new Error("prs.createLaneFromPrBranch requires a positive integer githubPrNumber.");
  }
  return { repoOwner, repoName, githubPrNumber };
}

function parseDraftPrDescriptionArgs(value: Record<string, unknown>): DraftPrDescriptionArgs {
  return {
    laneId: requireString(value.laneId, "prs.draftDescription requires laneId."),
    ...(asTrimmedString(value.model) ? { model: asTrimmedString(value.model)! } : {}),
    ...("reasoningEffort" in value
      ? { reasoningEffort: value.reasoningEffort == null ? null : (asTrimmedString(value.reasoningEffort) ?? null) }
      : {}),
    ...(asTrimmedString(value.baseBranch) ? { baseBranch: asTrimmedString(value.baseBranch)! } : {}),
    ...(typeof value.closeLinearIssueOnMerge === "boolean" ? { closeLinearIssueOnMerge: value.closeLinearIssueOnMerge } : {}),
  };
}

function parseLandPrArgs(value: Record<string, unknown>): LandPrArgs {
  const prId = requirePrId(value, "prs.land");
  const method = asTrimmedString(value.method) as LandPrArgs["method"];
  if (!method || !["merge", "squash", "rebase"].includes(method)) {
    throw new Error("prs.land requires method to be merge, squash, or rebase.");
  }
  const bypassRules = asOptionalBoolean(value.bypassRules);
  const archiveLane = asOptionalBoolean(value.archiveLane);
  // Optional pass-through so the mobile/remote merge surface can drive the same
  // bypass + editable commit-message flow as desktop (commit message ignored by
  // the `rebase` method downstream). Strings are trimmed; blanks are dropped.
  const commitTitle = asTrimmedString(value.commitTitle);
  const commitBody = asTrimmedString(value.commitBody);
  const expectedHeadSha = asTrimmedString(value.expectedHeadSha);
  return {
    prId,
    method,
    ...(bypassRules !== undefined ? { bypassRules } : {}),
    ...(archiveLane !== undefined ? { archiveLane } : {}),
    ...(commitTitle ? { commitTitle } : {}),
    ...(commitBody ? { commitBody } : {}),
    ...(expectedHeadSha ? { expectedHeadSha } : {}),
  };
}

function parseUpdateBranchArgs(value: Record<string, unknown>): UpdateBranchArgs {
  const prId = requirePrId(value, "prs.updateBranch");
  const strategy = asTrimmedString(value.strategy) as UpdateBranchArgs["strategy"];
  if (!strategy || !["merge", "rebase"].includes(strategy)) {
    throw new Error("prs.updateBranch requires strategy to be merge or rebase.");
  }
  const expectedHeadSha = asTrimmedString(value.expectedHeadSha);
  return {
    prId,
    strategy,
    ...(expectedHeadSha ? { expectedHeadSha } : {}),
  };
}

function parseClosePrArgs(value: Record<string, unknown>): ClosePrArgs {
  return {
    prId: requirePrId(value, "prs.close"),
    ...(typeof value.comment === "string" ? { comment: value.comment } : {}),
  };
}

function parseReopenPrArgs(value: Record<string, unknown>): ReopenPrArgs {
  return {
    prId: requirePrId(value, "prs.reopen"),
  };
}

function parseRequestReviewersArgs(value: Record<string, unknown>): RequestPrReviewersArgs {
  const prId = requirePrId(value, "prs.requestReviewers");
  const reviewers = asStringArray(value.reviewers);
  const teamReviewers = asStringArray(value.teamReviewers);
  if (reviewers.length === 0 && teamReviewers.length === 0) {
    throw new Error("prs.requestReviewers requires at least one reviewer or team reviewer.");
  }
  return {
    prId,
    ...(reviewers.length ? { reviewers } : {}),
    ...(teamReviewers.length ? { teamReviewers } : {}),
  };
}

function parseRerunPrChecksArgs(value: Record<string, unknown>): RerunPrChecksArgs {
  const parseIds = (key: "actionJobIds" | "checkRunIds"): number[] | undefined => {
    const candidate = value[key];
    if (candidate == null) return undefined;
    if (!Array.isArray(candidate)) {
      throw new Error(`prs.rerunChecks requires ${key} to be an array of numbers when provided.`);
    }
    return candidate.map((entry) => {
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
        throw new Error(`prs.rerunChecks requires ${key} to be an array of numbers when provided.`);
      }
      return entry;
    });
  };
  const actionJobIds = parseIds("actionJobIds");
  const checkRunIds = parseIds("checkRunIds");
  return {
    prId: requirePrId(value, "prs.rerunChecks"),
    ...(actionJobIds?.length ? { actionJobIds } : {}),
    ...(checkRunIds?.length ? { checkRunIds } : {}),
  };
}

function parseAddPrCommentArgs(value: Record<string, unknown>): AddPrCommentArgs {
  return {
    prId: requirePrId(value, "prs.addComment"),
    body: requireString(value.body, "prs.addComment requires body."),
    ...(asTrimmedString(value.inReplyToCommentId) ? { inReplyToCommentId: asTrimmedString(value.inReplyToCommentId)! } : {}),
  };
}

function parseUpdatePrTitleArgs(value: Record<string, unknown>): UpdatePrTitleArgs {
  return {
    prId: requirePrId(value, "prs.updateTitle"),
    title: requireString(value.title, "prs.updateTitle requires title."),
  };
}

function parseUpdatePrBodyArgs(value: Record<string, unknown>): UpdatePrBodyArgs {
  return {
    prId: requirePrId(value, "prs.updateBody"),
    body: typeof value.body === "string" ? value.body : "",
  };
}

function parseSetPrLabelsArgs(value: Record<string, unknown>): SetPrLabelsArgs {
  return {
    prId: requirePrId(value, "prs.setLabels"),
    labels: asStringArray(value.labels),
  };
}

function parseSubmitPrReviewArgs(value: Record<string, unknown>): SubmitPrReviewArgs {
  const event = asTrimmedString(value.event);
  if (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") {
    throw new Error("prs.submitReview requires event to be APPROVE, REQUEST_CHANGES, or COMMENT.");
  }
  return {
    prId: requirePrId(value, "prs.submitReview"),
    event,
    ...(typeof value.body === "string" ? { body: value.body } : {}),
  };
}

function parseReplyToReviewThreadArgs(value: Record<string, unknown>): ReplyToPrReviewThreadArgs {
  return {
    prId: requirePrId(value, "prs.replyToReviewThread"),
    threadId: requireString(value.threadId, "prs.replyToReviewThread requires threadId."),
    body: requireString(value.body, "prs.replyToReviewThread requires body."),
  };
}

function parseSetReviewThreadResolvedArgs(value: Record<string, unknown>): SetPrReviewThreadResolvedArgs {
  return {
    prId: requirePrId(value, "prs.setReviewThreadResolved"),
    threadId: requireString(value.threadId, "prs.setReviewThreadResolved requires threadId."),
    resolved: value.resolved === true,
  };
}

function parseReactToCommentArgs(value: Record<string, unknown>): ReactToPrCommentArgs {
  const content = asTrimmedString(value.content);
  if (!content) throw new Error("prs.reactToComment requires content.");
  return {
    prId: requirePrId(value, "prs.reactToComment"),
    commentId: requireString(value.commentId, "prs.reactToComment requires commentId."),
    content: content as ReactToPrCommentArgs["content"],
  };
}

function parseAiReviewSummaryArgs(value: Record<string, unknown>): AiReviewSummaryArgs {
  return {
    prId: requirePrId(value, "prs.aiReviewSummary"),
    ...(asTrimmedString(value.model) ? { model: asTrimmedString(value.model)! } : {}),
  };
}

function parseListIntegrationWorkflowsArgs(value: Record<string, unknown>): ListIntegrationWorkflowsArgs {
  const view = asTrimmedString(value.view);
  return view ? { view: view as ListIntegrationWorkflowsArgs["view"] } : {};
}

function parseSimulateIntegrationArgs(value: Record<string, unknown>): SimulateIntegrationArgs {
  return {
    sourceLaneIds: requireStringArray(value.sourceLaneIds, "prs.simulateIntegration requires sourceLaneIds."),
    baseBranch: requireString(value.baseBranch, "prs.simulateIntegration requires baseBranch."),
    ...(typeof value.persist === "boolean" ? { persist: value.persist } : {}),
    ...(typeof value.mergeIntoLaneId === "string" || value.mergeIntoLaneId === null
      ? { mergeIntoLaneId: value.mergeIntoLaneId }
      : {}),
  };
}

function parseCommitIntegrationArgs(value: Record<string, unknown>): CommitIntegrationArgs {
  return {
    proposalId: requireString(value.proposalId, "prs.commitIntegration requires proposalId."),
    integrationLaneName: requireString(value.integrationLaneName, "prs.commitIntegration requires integrationLaneName."),
    title: requireString(value.title, "prs.commitIntegration requires title."),
    ...(typeof value.body === "string" ? { body: value.body } : {}),
    ...(typeof value.draft === "boolean" ? { draft: value.draft } : {}),
    ...(typeof value.pauseOnConflict === "boolean" ? { pauseOnConflict: value.pauseOnConflict } : {}),
    ...(typeof value.allowDirtyWorktree === "boolean" ? { allowDirtyWorktree: value.allowDirtyWorktree } : {}),
    ...(typeof value.preferredIntegrationLaneId === "string" || value.preferredIntegrationLaneId === null
      ? { preferredIntegrationLaneId: value.preferredIntegrationLaneId }
      : {}),
  };
}

function parseUpdateIntegrationProposalArgs(value: Record<string, unknown>): UpdateIntegrationProposalArgs {
  return {
    proposalId: requireString(value.proposalId, "prs.updateIntegrationProposal requires proposalId."),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.body === "string" ? { body: value.body } : {}),
    ...(typeof value.draft === "boolean" ? { draft: value.draft } : {}),
    ...(typeof value.integrationLaneName === "string" ? { integrationLaneName: value.integrationLaneName } : {}),
    ...(typeof value.preferredIntegrationLaneId === "string" || value.preferredIntegrationLaneId === null
      ? { preferredIntegrationLaneId: value.preferredIntegrationLaneId }
      : {}),
    ...(typeof value.mergeIntoHeadSha === "string" || value.mergeIntoHeadSha === null
      ? { mergeIntoHeadSha: value.mergeIntoHeadSha }
      : {}),
  };
}

function parseDeleteIntegrationProposalArgs(value: Record<string, unknown>): DeleteIntegrationProposalArgs {
  return {
    proposalId: requireString(value.proposalId, "prs.deleteIntegrationProposal requires proposalId."),
    ...(typeof value.deleteIntegrationLane === "boolean" ? { deleteIntegrationLane: value.deleteIntegrationLane } : {}),
  };
}

function parseDismissIntegrationCleanupArgs(value: Record<string, unknown>): DismissIntegrationCleanupArgs {
  return {
    proposalId: requireString(value.proposalId, "prs.dismissIntegrationCleanup requires proposalId."),
  };
}

function parseCleanupIntegrationWorkflowArgs(value: Record<string, unknown>): CleanupIntegrationWorkflowArgs {
  const rawLaneIds = Array.isArray(value.archiveSourceLaneIds) ? value.archiveSourceLaneIds : [];
  const archiveSourceLaneIds = rawLaneIds
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return {
    proposalId: requireString(value.proposalId, "prs.cleanupIntegrationWorkflow requires proposalId."),
    ...(typeof value.archiveIntegrationLane === "boolean" ? { archiveIntegrationLane: value.archiveIntegrationLane } : {}),
    ...(archiveSourceLaneIds.length > 0 ? { archiveSourceLaneIds } : {}),
  };
}

function parseCreateIntegrationLaneForProposalArgs(value: Record<string, unknown>): CreateIntegrationLaneForProposalArgs {
  return {
    proposalId: requireString(value.proposalId, "prs.createIntegrationLaneForProposal requires proposalId."),
  };
}

function parseStartIntegrationResolutionArgs(value: Record<string, unknown>): StartIntegrationResolutionArgs {
  return {
    proposalId: requireString(value.proposalId, "prs.startIntegrationResolution requires proposalId."),
    laneId: requireString(value.laneId, "prs.startIntegrationResolution requires laneId."),
  };
}

function parseRecheckIntegrationStepArgs(value: Record<string, unknown>): RecheckIntegrationStepArgs {
  return {
    proposalId: requireString(value.proposalId, "prs.recheckIntegrationStep requires proposalId."),
    laneId: requireString(value.laneId, "prs.recheckIntegrationStep requires laneId."),
  };
}

function mergeLaneDockerConfig(
  current: { composePath?: string; services?: string[]; projectPrefix?: string } | undefined,
  next: { composePath?: string; services?: string[]; projectPrefix?: string } | undefined,
) {
  if (!current && !next) return undefined;
  if (!current) return next ? { ...next, ...(next.services ? { services: [...next.services] } : {}) } : undefined;
  if (!next) return { ...current, ...(current.services ? { services: [...current.services] } : {}) };
  return {
    ...current,
    ...next,
    ...(next.services != null
      ? { services: [...next.services] }
      : current.services != null
        ? { services: [...current.services] }
        : {}),
  };
}

function mergeLaneEnvInitConfig(
  current: LaneEnvInitConfig | undefined,
  next: LaneEnvInitConfig | undefined,
): LaneEnvInitConfig | undefined {
  if (!current && !next) return undefined;
  if (!current) {
    return next
      ? {
          ...(next.envFiles ? { envFiles: [...next.envFiles] } : {}),
          ...(mergeLaneDockerConfig(undefined, next.docker) ? { docker: mergeLaneDockerConfig(undefined, next.docker) } : {}),
          ...(next.dependencies ? { dependencies: [...next.dependencies] } : {}),
          ...(next.mountPoints ? { mountPoints: [...next.mountPoints] } : {}),
          ...(next.copyPaths ? { copyPaths: [...next.copyPaths] } : {}),
        }
      : undefined;
  }
  if (!next) {
    return {
      ...(current.envFiles ? { envFiles: [...current.envFiles] } : {}),
      ...(mergeLaneDockerConfig(undefined, current.docker) ? { docker: mergeLaneDockerConfig(undefined, current.docker) } : {}),
      ...(current.dependencies ? { dependencies: [...current.dependencies] } : {}),
      ...(current.mountPoints ? { mountPoints: [...current.mountPoints] } : {}),
      ...(current.copyPaths ? { copyPaths: [...current.copyPaths] } : {}),
    };
  }
  return {
    envFiles: [...(current.envFiles ?? []), ...(next.envFiles ?? [])],
    ...(mergeLaneDockerConfig(current.docker, next.docker) ? { docker: mergeLaneDockerConfig(current.docker, next.docker) } : {}),
    dependencies: [...(current.dependencies ?? []), ...(next.dependencies ?? [])],
    mountPoints: [...(current.mountPoints ?? []), ...(next.mountPoints ?? [])],
    copyPaths: [...(current.copyPaths ?? []), ...(next.copyPaths ?? [])],
  };
}

function mergeLaneOverrides(base: LaneOverlayOverrides, next: Partial<LaneOverlayOverrides>): LaneOverlayOverrides {
  return {
    ...base,
    ...next,
    ...(base.env || next.env ? { env: { ...(base.env ?? {}), ...(next.env ?? {}) } } : {}),
    ...(base.testSuiteIds || next.testSuiteIds ? { testSuiteIds: [...(next.testSuiteIds ?? base.testSuiteIds ?? [])] } : {}),
    ...(mergeLaneEnvInitConfig(base.envInit, next.envInit) ? { envInit: mergeLaneEnvInitConfig(base.envInit, next.envInit) } : {}),
  };
}

function applyLeaseToOverrides(
  overrides: LaneOverlayOverrides,
  lease: { status: string; rangeStart: number; rangeEnd: number } | null,
): LaneOverlayOverrides {
  if (!lease || lease.status !== "active" || overrides.portRange) {
    return { ...overrides };
  }
  return {
    ...overrides,
    portRange: { start: lease.rangeStart, end: lease.rangeEnd },
  };
}

/**
 * Strict resolver for identity-pinned sessions (CTO + worker agents). Never
 * slips a foreign lane through via a `lanes[0]` fallback — if no primary lane
 * exists, the caller must error out rather than silently host the identity on
 * a non-primary lane.
 */
async function resolvePrimaryLaneIdOnlyForSync(args: SyncRemoteCommandServiceArgs): Promise<string> {
  await args.laneService.ensurePrimaryLane?.().catch(() => {});
  const lanes = await args.laneService.list({ includeArchived: false, includeStatus: false });
  return lanes.find((lane) => lane.laneType === "primary")?.id ?? "";
}

function resolveLaneWorktreePathForSync(args: SyncRemoteCommandServiceArgs, laneId: string): string | null {
  try {
    const lane = args.laneService.getLaneBaseAndBranch(laneId);
    const trimmed = typeof lane?.worktreePath === "string" ? lane.worktreePath.trim() : "";
    if (trimmed.length) return trimmed;
  } catch {
    // Ignore and let the caller fall back to process/app skill roots.
  }
  return null;
}

async function resolveLaneOverlayContext(
  args: SyncRemoteCommandServiceArgs,
  laneId: string,
  options: { includeArchived?: boolean } = {},
) {
  const projectConfigService = requireService(args.projectConfigService, "Project config service not available.");
  const lanes = await args.laneService.list({
    includeStatus: false,
    ...(options.includeArchived === true ? { includeArchived: true } : {}),
  });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`Lane not found: ${laneId}`);

  const config = projectConfigService.getEffective();
  const overlayOverrides = matchLaneOverlayPolicies(lane, config.laneOverlayPolicies ?? []);
  const lease = args.portAllocationService?.getLease(lane.id) ?? null;
  const overrides = applyLeaseToOverrides(overlayOverrides, lease);
  const envInitConfig = args.laneEnvironmentService?.resolveEnvInitConfig(config.laneEnvInit, overrides);

  return {
    lane,
    overrides,
    envInitConfig,
  };
}

async function deleteLaneWithRuntimeCleanup(
  args: SyncRemoteCommandServiceArgs,
  payload: Record<string, unknown>,
): Promise<{ ok: true }> {
  const deleteArgs = parseDeleteLaneArgs(payload);
  const envContext = args.laneEnvironmentService
    ? await resolveLaneOverlayContext(args, deleteArgs.laneId, { includeArchived: true }).catch((error: unknown) => {
        args.logger.warn("sync_remote.lane_env_cleanup.pre_delete_context_failed", {
          laneId: deleteArgs.laneId,
          err: String(error),
        });
        return null;
      })
    : null;
  const teardownEnv = args.laneEnvironmentService && envContext?.envInitConfig
    ? async () => {
        await args.laneEnvironmentService!.cleanupLaneEnvironment(envContext.lane, envContext.envInitConfig);
      }
    : undefined;

  await args.laneService.delete(deleteArgs, { teardownEnv });
  args.portAllocationService?.release(deleteArgs.laneId);
  return { ok: true };
}

async function unarchiveLaneWithRuntimeSetup(
  args: SyncRemoteCommandServiceArgs,
  payload: Record<string, unknown>,
): Promise<{ ok: true }> {
  const archiveArgs = parseArchiveLaneArgs(payload, "lanes.unarchive");
  const result = await args.laneService.unarchive(archiveArgs);
  if (!result.worktreeRecreated) {
    return { ok: true };
  }
  try {
    await restoreRecreatedLaneRuntime(args, archiveArgs.laneId);
  } catch (error) {
    // Keep the established mobile command response stable. The worktree was
    // restored successfully; environment setup can be retried separately.
    args.logger.warn("sync_remote.lane_env_setup.post_unarchive_failed", {
      laneId: archiveArgs.laneId,
      err: String(error),
    });
  }
  return { ok: true };
}

async function resolveChatCreateArgs<T extends AgentChatCreateArgs>(
  service: ReturnType<typeof createAgentChatService>,
  payload: T,
): Promise<T> {
  if (payload.model.trim().length > 0) return payload;
  const available = await service.getAvailableModels({
    provider: payload.provider,
    ...(payload.provider === "opencode" ? { activateRuntime: true } : {}),
  });
  const chosen = available[0];
  if (!chosen) {
    throw new Error(`No configured ${payload.provider} chat model is available on the host.`);
  }
  return {
    ...payload,
    model: chosen.id,
    ...(!payload.modelId && chosen.modelId ? { modelId: chosen.modelId } : {}),
  };
}

function sessionStatusBucket(argsIn: {
  status: string;
  runtimeState?: string | null;
  settledAt?: string | null;
  settleOverride?: "settled" | "active" | null;
  attentionRequestedAt?: string | null;
  pendingInputItemId?: string | null;
  attentionSource?: "agent_explicit" | "provider_structured" | "user" | null;
  lastTurnFailedAt?: string | null;
}): "running" | "awaiting-input" | "ended" {
  // Mirrors the settled-tier precedence in shared/sessionCanonicalState.ts:
  // an escalated ask outranks everything; a declared settle is the quiet
  // bucket but only AT REST (background wakes count as running); a dead chat
  // turn is not running. The tri-state override is consulted at that same
  // declared-settle tier: "active" is an explicit keep-active pin that
  // suppresses settle, "settled" behaves like a declared settle.
  if (
    argsIn.attentionRequestedAt
    || argsIn.pendingInputItemId
    || argsIn.attentionSource === "provider_structured"
  ) return "awaiting-input";
  const effectiveSettled = argsIn.settleOverride === "active"
    ? false
    : argsIn.settleOverride === "settled" || Boolean(argsIn.settledAt);
  if (effectiveSettled && (argsIn.status !== "running" || argsIn.runtimeState === "idle")) return "ended";
  if (argsIn.lastTurnFailedAt) return "ended";
  if (argsIn.status === "running") {
    return "running";
  }
  return "ended";
}

function summarizeLaneRuntime(
  laneId: string,
  // Declares every field sessionStatusBucket actually reads. These arrive on the
  // rows from sessionService.list() at runtime; leaving them off the type meant the
  // settled tier looked dead here even though it was being evaluated.
  sessions: Array<{
    laneId: string;
    status: string;
    lastOutputPreview: string | null;
    runtimeState?: string | null;
    settledAt?: string | null;
    settleOverride?: "settled" | "active" | null;
    attentionRequestedAt?: string | null;
    lastTurnFailedAt?: string | null;
  }>,
): LaneListSnapshot["runtime"] {
  let runningCount = 0;
  let awaitingInputCount = 0;
  let endedCount = 0;
  let sessionCount = 0;
  for (const session of sessions) {
    if (session.laneId !== laneId) continue;
    sessionCount += 1;
    const bucket = sessionStatusBucket(session);
    if (bucket === "running") runningCount += 1;
    else if (bucket === "awaiting-input") awaitingInputCount += 1;
    else endedCount += 1;
  }
  const bucket = awaitingInputCount > 0
    ? "awaiting-input"
    : runningCount > 0
      ? "running"
      : endedCount > 0
        ? "ended"
        : "none";
  return {
    bucket,
    runningCount,
    awaitingInputCount,
    endedCount,
    sessionCount,
  };
}

async function buildLaneListSnapshots(
  args: SyncRemoteCommandServiceArgs,
  lanes: Awaited<ReturnType<ReturnType<typeof createLaneService>["list"]>>,
  options: ListLanesArgs = {},
): Promise<LaneListSnapshot[]> {
  const [rawSessions, chatSessions, rebaseSuggestions, autoRebaseStatuses, stateSnapshots, batchAssessment] = await Promise.all([
    Promise.resolve(args.sessionService.list({ limit: 500 })),
    args.agentChatService?.listSessions(undefined, { includeAutomation: true }).catch(() => [])
      ?? Promise.resolve([]),
    options.includeRebaseSuggestions === false
      ? Promise.resolve([])
      : Promise.resolve(args.rebaseSuggestionService?.listSuggestions({ lanes }) ?? []),
    options.includeAutoRebaseStatus === false
      ? Promise.resolve([])
      : Promise.resolve(args.autoRebaseService?.listStatuses({ lanes }) ?? []),
    Promise.resolve(args.laneService.listStateSnapshots()),
    options.includeConflictStatus === false
      ? Promise.resolve(null)
      : args.conflictService?.getBatchAssessment({ lanes }).catch(() => null) ?? Promise.resolve(null),
  ]);
  const chatBySessionId = new Map(chatSessions.map((chat) => [chat.sessionId, chat] as const));
  const sessions = rawSessions.map((session) => {
    const chat = chatBySessionId.get(session.id);
    return chat ? projectChatOntoSession(session, chat) : session;
  });

  const rebaseByLaneId = new Map(rebaseSuggestions.map((entry) => [entry.laneId, entry] as const));
  const autoRebaseByLaneId = new Map(autoRebaseStatuses.map((entry) => [entry.laneId, entry] as const));
  const stateByLaneId = new Map(stateSnapshots.map((entry) => [entry.laneId, entry] as const));
  const conflictByLaneId = new Map((batchAssessment?.lanes ?? []).map((entry) => [entry.laneId, entry] as const));

  return lanes.map((lane) => ({
    lane,
    runtime: summarizeLaneRuntime(lane.id, sessions),
    rebaseSuggestion: rebaseByLaneId.get(lane.id) ?? null,
    autoRebaseStatus: autoRebaseByLaneId.get(lane.id) ?? null,
    conflictStatus: conflictByLaneId.get(lane.id) ?? null,
    stateSnapshot: stateByLaneId.get(lane.id) ?? null,
    // Deprecated, always false. Shipped iOS builds decode this as a
    // non-optional Bool; dropping the key blanks their lane list. See the
    // field's doc comment in shared/types/lanes.ts.
    adoptableAttached: false,
  }));
}

type LaneDetailRequestArgs = {
  laneId: string;
  ifNoneMatch?: string;
};

function parseLaneDetailRequestArgs(value: Record<string, unknown>): LaneDetailRequestArgs {
  return {
    laneId: requireString(value.laneId, "lanes.getDetail requires laneId."),
    ...(asTrimmedString(value.ifNoneMatch) ? { ifNoneMatch: asTrimmedString(value.ifNoneMatch)! } : {}),
  };
}

async function buildLaneDetailPayload(args: SyncRemoteCommandServiceArgs, laneId: string): Promise<LaneDetailPayload> {
  const lane = await args.laneService.getSummary(laneId, { includeStatus: true });
  if (!lane) throw new Error(`Lane not found: ${laneId}`);

  const stackChain = await args.laneService.getStackChain(laneId);
  const parentLane = lane.parentLaneId
    ? await args.laneService.getSummary(lane.parentLaneId, { includeStatus: true })
    : null;
  const suggestionLanes = parentLane ? [lane, parentLane] : [lane];

  const [
    children,
    sessions,
    chatSessions,
    rebaseSuggestions,
    autoRebaseStatuses,
    stateSnapshot,
    recentCommits,
    diffChanges,
    stashes,
    syncStatus,
    conflictState,
    conflictStatus,
    overlaps,
    envInitProgress,
  ] = await Promise.all([
    args.laneService.getChildren(laneId),
    Promise.resolve(args.sessionService.list({ laneId, limit: 200 })),
    args.agentChatService?.listSessions(laneId, { includeAutomation: true }).catch(() => []) ?? Promise.resolve([]),
    Promise.resolve(args.rebaseSuggestionService?.listSuggestions({ lanes: suggestionLanes }) ?? []),
    Promise.resolve(args.autoRebaseService?.listStatuses({ lanes: [lane] }) ?? []),
    Promise.resolve(args.laneService.getStateSnapshot(laneId)),
    args.gitService?.listRecentCommits({ laneId, limit: 20 }) ?? Promise.resolve([]),
    args.diffService?.getChanges(laneId).catch(() => null) ?? Promise.resolve(null),
    args.gitService?.listStashes({ laneId }) ?? Promise.resolve([]),
    args.gitService?.getSyncStatus({ laneId }).catch(() => null) ?? Promise.resolve(null),
    args.gitService?.getConflictState({ laneId }).catch(() => null) ?? Promise.resolve(null),
    args.conflictService?.getLaneStatus({ laneId }).catch(() => null) ?? Promise.resolve(null),
    args.conflictService?.listOverlaps({ laneId }).catch(() => []) ?? Promise.resolve([]),
    Promise.resolve(args.laneEnvironmentService?.getProgress(laneId) ?? null),
  ]);

  return {
    lane,
    runtime: summarizeLaneRuntime(
      laneId,
      sessions.map((session) => {
        const chat = chatSessions.find((candidate) => candidate.sessionId === session.id);
        return chat ? projectChatOntoSession(session, chat) : session;
      }),
    ),
    stackChain,
    children,
    stateSnapshot: stateSnapshot as LaneStateSnapshotSummary | null,
    rebaseSuggestion: rebaseSuggestions.find((entry) => entry.laneId === laneId) ?? null,
    autoRebaseStatus: autoRebaseStatuses.find((entry) => entry.laneId === laneId) ?? null,
    conflictStatus,
    overlaps,
    syncStatus,
    conflictState,
    recentCommits,
    diffChanges,
    stashes,
    envInitProgress,
    sessions,
    chatSessions,
  };
}

type RemoteCommandRegistrationPolicy = SyncRemoteCommandPolicy & {
  observesAbort?: boolean;
};

type RemoteCommandRegistrar = (
  action: SyncRemoteCommandAction,
  policy: RemoteCommandRegistrationPolicy,
  handler: (
    payload: Record<string, unknown>,
    context: SyncRemoteCommandExecutionContext,
  ) => Promise<unknown>,
  scope?: SyncRemoteCommandDescriptor["scope"],
) => void;

type RemoteCommandRegistrationDeps = {
  args: SyncRemoteCommandServiceArgs;
  register: RemoteCommandRegistrar;
};

function registerLaneRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("lanes.list", { viewerAllowed: true }, async (payload) => args.laneService.list(parseListLanesArgs(payload)));
  register("lanes.listDeleteProgress", { viewerAllowed: true }, async () => args.laneService.listDeleteProgress());
  register("lanes.getBranchDrift", { viewerAllowed: true }, async (payload) =>
    args.laneService.getBranchDrift({
      laneId: requireString(payload.laneId, "lanes.getBranchDrift requires laneId."),
    }));
  register("lanes.resolveBranchDrift", { viewerAllowed: true, queueable: true }, async (payload) => {
    const expectedHeadBranchRef = asTrimmedString(payload.expectedHeadBranchRef);
    return args.laneService.resolveBranchDrift({
      laneId: requireString(payload.laneId, "lanes.resolveBranchDrift requires laneId."),
      resolution: parseRemoteBranchDriftResolution(payload.resolution, "lanes.resolveBranchDrift"),
      ...(expectedHeadBranchRef ? { expectedHeadBranchRef } : {}),
      ...(payload.acknowledgeActiveWork === true ? { acknowledgeActiveWork: true } : {}),
    });
  });
  register("lanes.refreshSnapshots", { viewerAllowed: true }, async (payload) => {
    const listArgs = parseListLanesArgs(payload);
    const refreshed = await args.laneService.refreshSnapshots(listArgs);
    const response = {
      ...refreshed,
      snapshots: await buildLaneListSnapshots(args, refreshed.lanes, listArgs),
    };
    return respondWithSignature(response, asTrimmedString(payload.ifNoneMatch), {
      refreshedCount: 0,
      lanes: [],
      snapshots: null,
    }, args.getLanePresenceStamp?.() ?? "");
  });
  register("lanes.getDetail", { viewerAllowed: true }, async (payload) => {
    const detailArgs = parseLaneDetailRequestArgs(payload);
    const response = await buildLaneDetailPayload(args, detailArgs.laneId);
    return respondWithSignature(response, detailArgs.ifNoneMatch, {}, args.getLanePresenceStamp?.() ?? "");
  });
  register("lanes.create", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseCreateLaneArgs(payload);
    // Mobile/CLI callers that don't pick a base (hub composer auto-create, the
    // create sheet's default) must branch from the project's configured
    // new-lane base — remote-first, matching desktop's create-lane dialog —
    // not from the possibly-stale LOCAL primary tip.
    if (!parsed.baseBranch && !parsed.startPoint && !parsed.parentLaneId) {
      const remoteBase = await resolveLaneCreateRemoteBase(args);
      if (remoteBase) return args.laneService.create({ ...parsed, baseBranch: remoteBase });
    }
    return args.laneService.create(parsed);
  });
  // Background lane naming for mobile auto-create. Deliberately NOT queueable:
  // when the phone is offline we want the call to fail fast so the client uses
  // its deterministic fallback name, never a stale queued suggestion. The naming
  // job (suggestLaneNameFromPrompt) already honors the host `titleGenerationEnabled`
  // setting and clamps the name; any null service / error here falls back to the
  // same deterministic name the client would have used on its own.
  register("lanes.suggestName", { viewerAllowed: true }, async (payload) => {
    const parsed = parseSuggestLaneNameArgs(payload);
    // Last-resort fallback: prefer the client's own deterministic name (so the
    // mobile fallback matches exactly what it used before this feature), then
    // derive one from the prompt if the client supplied none.
    const fallback = () => {
      const provided = parsed.fallbackName?.trim();
      return provided && provided.length ? provided : deriveDeterministicLaneNameFromPrompt(parsed.prompt);
    };
    if (!args.agentChatService) {
      const name = fallback();
      args.logger.warn("sync.lanes_suggest_name_service_unavailable", {
        laneId: parsed.laneId,
        modelId: parsed.modelId,
        fallbackName: name,
      });
      return { name };
    }
    try {
      const generated = typeof args.agentChatService.generateAutoLaneIdentity === "function"
        ? await args.agentChatService.generateAutoLaneIdentity(parsed)
        : { laneTitle: await args.agentChatService.suggestLaneNameFromPrompt(parsed) };
      const hostApplied = "laneRenameOutcome" in generated;
      const trimmed = generated.laneTitle.trim();
      if (!trimmed.length) {
        const fallbackName = fallback();
        args.logger.warn("sync.lanes_suggest_name_empty_result", {
          laneId: parsed.laneId,
          modelId: parsed.modelId,
          fallbackName,
        });
        return { name: fallbackName, hostApplied };
      }
      if (trimmed === fallback()) {
        args.logger.info("sync.lanes_suggest_name_kept_fallback", {
          laneId: parsed.laneId,
          modelId: parsed.modelId,
          fallbackName: trimmed,
        });
        return { name: trimmed, hostApplied };
      }
      args.logger.info("sync.lanes_suggest_name_succeeded", {
        laneId: parsed.laneId,
        modelId: parsed.modelId,
        name: trimmed,
      });
      return { name: trimmed, hostApplied };
    } catch (error) {
      const fallbackName = fallback();
      args.logger.warn("sync.lanes_suggest_name_failed", {
        laneId: parsed.laneId,
        modelId: parsed.modelId,
        fallbackName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { name: fallbackName };
    }
  });
  register("lanes.createChild", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.createChild(parseCreateChildLaneArgs(payload)));
  register("lanes.createFromUnstaged", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.laneService.createFromUnstaged(parseCreateLaneFromUnstagedArgs(payload)));
  register("lanes.importBranch", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.laneService.importBranch(parseImportBranchArgs(payload)));
  register("lanes.previewBranchSwitch", { viewerAllowed: true }, async (payload) =>
    args.laneService.previewBranchSwitch(parseGitCheckoutBranchArgs(payload)));
  // Every git worktree is now a lane the moment it exists, so there is nothing
  // left to select, attach, or adopt. These three stay REGISTERED (and so keep
  // appearing in hello_ok.features.commandRouting.actions) because they are in
  // MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS: dropping them would flip an
  // otherwise healthy host into "limited" mode for every phone, new or old.
  // Instead the list returns empty — an older phone's attach sheet renders its
  // own "nothing to add" state — and the two mutations fail with a message the
  // phone surfaces verbatim.
  register("lanes.listUnregisteredWorktrees", { viewerAllowed: true }, async () => []);
  register("lanes.attach", { viewerAllowed: true, queueable: true }, async () => {
    throw new Error("Attaching worktrees is no longer supported — every git worktree in the project already appears as a lane.");
  });
  register("lanes.adoptAttached", { viewerAllowed: true, queueable: true }, async () => {
    throw new Error("Adopting attached lanes is no longer supported — every git worktree in the project is managed as a lane.");
  });
  register("lanes.rename", { viewerAllowed: true, queueable: true }, async (payload) => {
    args.laneService.rename(parseRenameLaneArgs(payload));
    return { ok: true };
  });
  register("lanes.reparent", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.laneService.reparent(parseReparentLaneArgs(payload)));
  register("lanes.updateAppearance", { viewerAllowed: true, queueable: true }, async (payload) => {
    args.laneService.updateAppearance(parseUpdateLaneAppearanceArgs(payload));
    return { ok: true };
  });
  register("lanes.archive", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.laneService.archive(parseArchiveLaneArgs(payload, "lanes.archive"));
    return { ok: true };
  });
  register("lanes.unarchive", { viewerAllowed: true, queueable: true }, async (payload) =>
    unarchiveLaneWithRuntimeSetup(args, payload));
  register("lanes.delete", { viewerAllowed: true, queueable: true }, async (payload) =>
    deleteLaneWithRuntimeCleanup(args, payload));
  register("lanes.getStackChain", { viewerAllowed: true }, async (payload) =>
    args.laneService.getStackChain(requireString(payload.laneId, "lanes.getStackChain requires laneId.")));
  register("lanes.getChildren", { viewerAllowed: true }, async (payload) =>
    args.laneService.getChildren(requireString(payload.laneId, "lanes.getChildren requires laneId.")));
  register("lanes.rebaseStart", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.rebaseStart(parseRebaseStartArgs(payload)));
  register("lanes.rebasePush", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.rebasePush(parseRebasePushArgs(payload)));
  register("lanes.rebaseRollback", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.rebaseRollback(parseRunIdArgs(payload, "lanes.rebaseRollback")));
  register("lanes.rebaseAbort", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.rebaseAbort(parseRunIdArgs(payload, "lanes.rebaseAbort")));
  register("lanes.listRebaseSuggestions", { viewerAllowed: true }, async () => args.rebaseSuggestionService?.listSuggestions() ?? []);
  register("lanes.dismissRebaseSuggestion", { viewerAllowed: true, queueable: true }, async (payload) => {
    const laneId = requireString(payload.laneId, "lanes.dismissRebaseSuggestion requires laneId.");
    if (args.rebaseSuggestionService) {
      await args.rebaseSuggestionService.dismiss({ laneId });
    }
    return { ok: true };
  });
  register("lanes.deferRebaseSuggestion", { viewerAllowed: true, queueable: true }, async (payload) => {
    const laneId = requireString(payload.laneId, "lanes.deferRebaseSuggestion requires laneId.");
    const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(asOptionalNumber(payload.minutes) ?? 60)));
    if (args.rebaseSuggestionService) {
      await args.rebaseSuggestionService.defer({
        laneId,
        minutes,
      });
    }
    return { ok: true };
  });
  register("lanes.listAutoRebaseStatuses", { viewerAllowed: true }, async () => args.autoRebaseService?.listStatuses() ?? []);
  register("lanes.dismissAutoRebaseStatus", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.autoRebaseService) return { ok: true };
    await args.autoRebaseService.dismissStatus({
      laneId: requireString(payload.laneId, "lanes.dismissAutoRebaseStatus requires laneId."),
    });
    return { ok: true };
  });
  register("lanes.listTemplates", { viewerAllowed: true }, async () => args.laneTemplateService?.listTemplates() ?? []);
  register("lanes.getDefaultTemplate", { viewerAllowed: true }, async () => args.laneTemplateService?.getDefaultTemplateId() ?? null);
  register("lanes.getEnvStatus", { viewerAllowed: true }, async (payload) => args.laneEnvironmentService?.getProgress(requireString(payload.laneId, "lanes.getEnvStatus requires laneId.")) ?? null);
  register("lanes.initEnv", { viewerAllowed: true, queueable: true }, async (payload) => {
    const laneEnvironmentService = requireService(args.laneEnvironmentService, "Lane environment service not available.");
    const laneId = requireString(payload.laneId, "lanes.initEnv requires laneId.");
    const context = await resolveLaneOverlayContext(args, laneId);
    if (!context.envInitConfig) {
      const now = new Date().toISOString();
      return {
        laneId,
        steps: [],
        startedAt: now,
        completedAt: now,
        overallStatus: "completed",
      } satisfies LaneEnvInitProgress;
    }
    return await laneEnvironmentService.initLaneEnvironment(context.lane, context.envInitConfig, context.overrides);
  });
  register("lanes.applyTemplate", { viewerAllowed: true, queueable: true }, async (payload) => {
    const laneTemplateService = requireService(args.laneTemplateService, "Lane template service not available.");
    const laneEnvironmentService = requireService(args.laneEnvironmentService, "Lane environment service not available.");
    const parsed = {
      laneId: requireString(payload.laneId, "lanes.applyTemplate requires laneId."),
      templateId: requireString(payload.templateId, "lanes.applyTemplate requires templateId."),
    } satisfies ApplyLaneTemplateArgs;
    const context = await resolveLaneOverlayContext(args, parsed.laneId);
    const template = laneTemplateService.getTemplate(parsed.templateId);
    if (!template) throw new Error(`Template not found: ${parsed.templateId}`);
    const templateEnvInit = laneTemplateService.resolveTemplateAsEnvInit(template);
    const mergedOverrides = mergeLaneOverrides(context.overrides, {
      ...(template.envVars ? { env: template.envVars } : {}),
      ...(!context.overrides.portRange && template.portRange ? { portRange: template.portRange } : {}),
      envInit: templateEnvInit,
    });
    const mergedEnvInitConfig = mergeLaneEnvInitConfig(context.envInitConfig, templateEnvInit) ?? templateEnvInit;
    return await laneEnvironmentService.initLaneEnvironment(context.lane, mergedEnvInitConfig, mergedOverrides);
  });
}

function registerWorkRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("work.getSession", { viewerAllowed: true }, async (payload) =>
    getRemoteWorkSession(args, parseSessionIdArgs(payload, "work.getSession").sessionId));
  register("work.deleteSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const sessionId = requireString(payload.sessionId, "Session id is required.");
    await deleteTerminalSessionWithRuntimeCleanup({
      sessionId,
      sessionService: args.sessionService,
      ptyService: args.ptyService,
    });
  });
  register("work.getSessionDelta", { viewerAllowed: true }, async (payload) =>
    args.sessionDeltaService?.getSessionDelta(parseSessionIdArgs(payload, "work.getSessionDelta").sessionId) ?? null);
  register("work.listSessions", { viewerAllowed: true }, async (payload) => listRemoteWorkSessions(args, parseListSessionsArgs(payload)));
  register("work.updateSessionMeta", { viewerAllowed: true, queueable: true }, async (payload) => {
    args.sessionService.updateMeta(parseUpdateSessionMetaArgs(payload));
    return { ok: true };
  });
  // ---------------------------------------------------------------------
  // Session lifecycle over sync. Mobile and the hosted web client have no
  // local DB, so settle/snooze/wake are only reachable through these.
  // ---------------------------------------------------------------------
  register("session.settleSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const sessionId = requireString(payload.sessionId, "session.settleSession requires sessionId.");
    const outcome = asTrimmedString(payload.outcome);
    const settled = await settleTerminalSession({
      sessionId,
      opts: {
        ...(outcome ? { outcome } : {}),
        ...(payload.dismissPendingInput === true ? { dismissPendingInput: true } : {}),
      },
      sessionService: args.sessionService,
      agentChatService: args.agentChatService ?? null,
      ptyService: args.ptyService,
    });
    if (!settled) throw new Error(`Session '${sessionId}' was not found.`);
    return { ok: true, sessionId };
  });
  register("session.unsettleSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const sessionId = requireString(payload.sessionId, "session.unsettleSession requires sessionId.");
    return { ok: args.sessionService.unsettleSession(sessionId), sessionId };
  });
  register("session.settleSessions", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.sessionService.settleSessions(parseRemoteSessionIds(payload, "session.settleSessions")));
  register("session.unsettleSessions", { viewerAllowed: true, queueable: true }, async (payload) => {
    args.sessionService.unsettleSessions(parseRemoteSessionIds(payload, "session.unsettleSessions"));
    return { ok: true };
  });
  register("session.snoozeSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const sessionId = requireString(payload.sessionId, "session.snoozeSession requires sessionId.");
    const untilIso = parseRemoteSnoozeDeadline(payload, "session.snoozeSession");
    const ok = args.sessionService.snoozeSession(sessionId, untilIso);
    if (!ok) throw new Error(`Session '${sessionId}' was not found.`);
    return { ok, sessionId, snoozedUntil: untilIso };
  });
  register("session.snoozeSessions", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.sessionService.snoozeSessions(
      parseRemoteSessionIds(payload, "session.snoozeSessions"),
      parseRemoteSnoozeDeadline(payload, "session.snoozeSessions"),
    ));
  register("session.wakeSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const sessionId = requireString(payload.sessionId, "session.wakeSession requires sessionId.");
    const reason = parseRemoteWakeReason(payload.reason, "session.wakeSession");
    return { ok: args.sessionService.wakeSession(sessionId, reason), sessionId, reason };
  });
  register("session.wakeSessions", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.sessionService.wakeSessions(
      parseRemoteSessionIds(payload, "session.wakeSessions"),
      parseRemoteWakeReason(payload.reason, "session.wakeSessions"),
    ));
  register("session.setSettleOverride", { viewerAllowed: true, queueable: true }, async (payload) => {
    const sessionId = requireString(payload.sessionId, "session.setSettleOverride requires sessionId.");
    const override = parseRemoteSettleOverride(payload.override, "session.setSettleOverride");
    const ok = args.sessionService.setSettleOverride(sessionId, override);
    if (!ok) throw new Error(`Session '${sessionId}' was not found.`);
    return { ok, sessionId, settleOverride: override };
  });
  register("session.clearWokeMarker", { viewerAllowed: true, queueable: true }, async (payload) => {
    const sessionId = requireString(payload.sessionId, "session.clearWokeMarker requires sessionId.");
    return { ok: args.sessionService.clearWokeMarker(sessionId), sessionId };
  });
  register("work.runQuickCommand", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseQuickCommandArgs(payload);
    return await args.ptyService.create({
      laneId: parsed.laneId,
      title: parsed.title,
      ...(parsed.startupCommand ? { startupCommand: parsed.startupCommand } : {}),
      tracked: parsed.tracked ?? true,
      cols: parsed.cols ?? 120,
      rows: parsed.rows ?? 36,
      toolType: (parsed.toolType ?? "shell") as TerminalToolType,
    });
  });
  register("work.startCliSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseStartCliSessionArgs(payload);
    const cols = clampCliDimension(parsed.cols, DEFAULT_CLI_COLS, 20, MAX_CLI_COLS);
    const rows = clampCliDimension(parsed.rows, DEFAULT_CLI_ROWS, 4, MAX_CLI_ROWS);
    const { provider } = parsed;
    const permissionMode = parsed.permissionMode ?? "default";
    validateLaunchProfilePermissionMode(provider, permissionMode);
    const toolType = LAUNCH_PROFILE_TOOL_TYPE[provider] as TerminalToolType;
    const initialInputMeta = deriveTrackedCliInitialInputSessionMeta({
      provider,
      title: parsed.title,
      initialInput: parsed.initialInput,
    });
    const title = initialInputMeta.title || LAUNCH_PROFILE_TITLE[provider];
    const preassignedSessionId = provider === "claude" ? randomUUID() : undefined;
    const codexComputerUse = provider === "codex"
      ? await resolveCodexComputerUseMcpConfig()
      : null;

    function resolveLaunch(): Partial<TrackedCliLaunchCommand> {
      if (provider === "shell") {
        return resolveCleanShellLaunchFields({
          platform: process.platform,
          shell: process.env.SHELL,
          comSpec: process.env.ComSpec,
        });
      }
      return buildTrackedCliLaunchCommand({
        provider,
        permissionMode,
        sessionId: preassignedSessionId,
        model: parsed.modelId ?? parsed.model ?? undefined,
        reasoningEffort: parsed.reasoningEffort ?? undefined,
        fastMode: parsed.fastMode ?? undefined,
        initialPrompt: parsed.initialInput,
        laneWorktreePath: resolveLaneWorktreePathForSync(args, parsed.laneId),
        ...(provider === "codex" ? { codexComputerUse } : {}),
      });
    }

    const launch = resolveLaunch();
    const result = await args.ptyService.create({
      ...(preassignedSessionId ? { sessionId: preassignedSessionId } : {}),
      allowNewSessionId: Boolean(preassignedSessionId),
      laneId: parsed.laneId,
      title,
      tracked: true,
      toolType,
      cols,
      rows,
      ...launch,
    });

    if (initialInputMeta.goal) {
      const session = args.sessionService.get(result.sessionId);
      args.sessionService.updateMeta({
        sessionId: result.sessionId,
        ...(session?.goal?.trim().length ? {} : { goal: initialInputMeta.goal }),
        ...(initialInputMeta.promptTitle && title === initialInputMeta.promptTitle
          ? { title: initialInputMeta.promptTitle, manuallyNamed: false }
          : {}),
      });
    }

    const session = args.sessionService.get(result.sessionId);
    const enriched = session ? args.ptyService.enrichSessions([session])[0] ?? session : null;
    return {
      sessionId: result.sessionId,
      ptyId: result.ptyId,
      session: enriched,
    } satisfies SyncStartCliSessionResult;
  });
  register("work.resumeCliSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    // Mirror of the desktop resume affordance: relaunch an ended/orphaned
    // agent CLI session's runtime (same sessionId, provider resume metadata).
    const value = (payload ?? {}) as Record<string, unknown>;
    const sessionId = requireString(value.sessionId, "work.resumeCliSession requires sessionId.");
    const cols = typeof value.cols === "number" && Number.isFinite(value.cols)
      ? clampCliDimension(value.cols, DEFAULT_CLI_COLS, 20, MAX_CLI_COLS)
      : undefined;
    const rows = typeof value.rows === "number" && Number.isFinite(value.rows)
      ? clampCliDimension(value.rows, DEFAULT_CLI_ROWS, 4, MAX_CLI_ROWS)
      : undefined;
    const result = await args.ptyService.resumeSession({
      sessionId,
      ...(cols != null ? { cols } : {}),
      ...(rows != null ? { rows } : {}),
    });
    return {
      sessionId: result.sessionId,
      ptyId: result.ptyId,
      session: result.session,
    } satisfies SyncStartCliSessionResult;
  });
  register("work.listExternalSessions", { viewerAllowed: true }, async (payload) => {
    const parsed = parseListExternalSessionsArgs(payload);
    const result = await resolveExternalSessionsService(args).list(parsed);
    return result satisfies SyncListExternalSessionsResult;
  });
  register("work.importExternalSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseImportExternalSessionArgs(payload);
    const result = await resolveExternalSessionsService(args).importExternalSession(parsed);
    return result satisfies SyncImportExternalSessionResult;
  });
  register("work.sendToSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseSendToSessionArgs(payload);
    const result = await args.ptyService.sendToSession({
      sessionId: parsed.sessionId,
      text: parsed.text,
      ...(parsed.cols != null ? { cols: parsed.cols } : {}),
      ...(parsed.rows != null ? { rows: parsed.rows } : {}),
      ...(parsed.model != null ? { model: parsed.model } : {}),
      ...(parsed.reasoningEffort != null ? { reasoningEffort: parsed.reasoningEffort } : {}),
      ...(parsed.fastMode != null ? { fastMode: parsed.fastMode } : {}),
      ...(parsed.permissionMode != null ? { permissionMode: parsed.permissionMode } : {}),
      ...(parsed.codexApprovalPolicy != null ? { codexApprovalPolicy: parsed.codexApprovalPolicy } : {}),
      ...(parsed.codexSandbox != null ? { codexSandbox: parsed.codexSandbox } : {}),
      ...(parsed.codexConfigSource != null ? { codexConfigSource: parsed.codexConfigSource } : {}),
    });
    return result satisfies SyncSendToSessionResult;
  });
  register("work.stopRuntime", { viewerAllowed: true, queueable: true }, async (payload) => {
    const { sessionId } = parseStopRuntimeArgs(payload);
    const session = args.sessionService.get(sessionId);
    if (session?.ptyId) {
      await args.ptyService.dispose({ ptyId: session.ptyId, sessionId });
    }
    return { ok: true };
  });
}

function registerChatRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("chat.resolveSmartLinkPreview", { viewerAllowed: true, observesAbort: true }, async (payload) => {
    const url = requireString(payload.url, "chat.resolveSmartLinkPreview requires url.");
    const linearIssueTracker = await getConnectedLinearIssueTracker(args);
    return resolveSmartLinkPreview({
      url,
      githubService: args.githubService,
      linearIssueTracker,
    });
  });
  register("chat.getSlashCommands", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getSlashCommands(
      parseAgentChatSlashCommandsArgs(payload),
    ));
  register("chat.getParallelLaunchState", { viewerAllowed: true }, async (payload) => {
    const db = requireService(args.db, "Database not available.");
    const parsed = parseAgentChatParallelLaunchStateArgs(payload);
    const key = agentChatParallelLaunchStateKey(parsed.projectRoot, parsed.parentLaneId);
    return normalizeAgentChatParallelLaunchState(db.getJson(key), parsed.parentLaneId);
  });
  register("chat.setParallelLaunchState", { viewerAllowed: true }, async (payload) => {
    const db = requireService(args.db, "Database not available.");
    const parsed = parseAgentChatSetParallelLaunchStateArgs(payload);
    const key = agentChatParallelLaunchStateKey(parsed.projectRoot, parsed.parentLaneId);
    db.setJson(key, parsed.state ?? null);
  });
  register("chat.handoff", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").handoffSession(
      parseAgentChatHandoffArgs(payload),
    ));
  register("chat.prepareCrossMachineHandoff", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").prepareCrossMachineHandoff(
      parsePrepareCrossMachineHandoffArgs(payload),
    ));
  register("chat.validateCrossMachineSource", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").validateCrossMachineSource(
      parseValidateCrossMachineSourceArgs(payload),
    ));
  register("chat.preflightCrossMachineDestination", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").preflightCrossMachineDestination(
      parseCrossMachineDestinationPreflightArgs(payload),
    ));
  register("chat.fastForwardCrossMachineHandoffLane", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").fastForwardCrossMachineHandoffLane(
      parseFastForwardCrossMachineHandoffLaneArgs(payload),
    ));
  register("chat.acceptCrossMachineHandoff", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").acceptCrossMachineHandoff(
      parseAcceptCrossMachineHandoffArgs(payload),
    ));
  register("chat.markCrossMachineHandoff", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").markCrossMachineHandoff(
      parseMarkCrossMachineHandoffArgs(payload),
    ));
  register("chat.getContextUsage", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getContextUsage(
      parseAgentChatContextUsageArgs(payload),
    ));
  register("chat.rewindFiles", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").rewindFiles(
      parseAgentChatRewindFilesArgs(payload),
    ));
  register("chat.getTurnFileDiff", { viewerAllowed: true }, async (payload) => getRemoteTurnFileDiff(args, payload));
  register("chat.saveTempAttachment", { viewerAllowed: true }, async (payload) =>
    saveAgentChatTempAttachment(args, payload));
  register("chat.warmupModel", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").warmupModel(parseWarmupModelArgs(payload)));
  register("chat.launch", { viewerAllowed: true, queueable: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatLaunchArgs(payload);
    const session = await agentChatService.launchHeadless(await resolveChatCreateArgs(agentChatService, parsed));
    return summarizeChatSessionForRemote(agentChatService, session);
  });
  register("chat.getImageDataUrl", { viewerAllowed: true }, async (payload) => {
    const filePath = resolveAllowedProjectPath(args, payload.path, "chat.getImageDataUrl");
    const { data, mimeType } = await readImageFileAndSniffMime(filePath);
    return { dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
  });
  register("chat.listSessions", { viewerAllowed: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatListArgs(payload);
    return agentChatService.listSessions(parsed.laneId, {
      includeAutomation: parsed.includeAutomation,
      includeArchived: parsed.includeArchived,
    });
  });
  register("chat.getSummary", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getSessionSummary(parseAgentChatGetSummaryArgs(payload).sessionId));
  register("chat.createScheduledWork", { viewerAllowed: false, queueable: false }, async (payload) => {
    const recurring = asOptionalBoolean(payload.recurring);
    const reason = asTrimmedString(payload.reason);
    if (payload.cron != null && (typeof payload.cron !== "string" || payload.cron.trim().length === 0)) {
      throw new Error("chat.createScheduledWork cron must be a non-empty string.");
    }
    if (payload.runAt != null && (typeof payload.runAt !== "string" || payload.runAt.trim().length === 0)) {
      throw new Error("chat.createScheduledWork runAt must be a non-empty string.");
    }
    const cron = asTrimmedString(payload.cron);
    const runAt = asTrimmedString(payload.runAt);
    if (payload.delaySeconds != null && typeof payload.delaySeconds !== "number") {
      throw new Error("chat.createScheduledWork delaySeconds must be a number.");
    }
    const base = {
      sessionId: requireString(payload.sessionId, "chat.createScheduledWork requires sessionId."),
      prompt: requireString(payload.prompt, "chat.createScheduledWork requires prompt."),
      ...(reason ? { reason } : {}),
    };
    const scheduleInputCount = Number(Boolean(cron))
      + Number(Boolean(runAt))
      + Number(typeof payload.delaySeconds === "number");
    if (scheduleInputCount !== 1) {
      throw new Error("chat.createScheduledWork requires exactly one of cron, runAt, or delaySeconds.");
    }
    let createArgs: AgentChatCreateScheduledWorkArgs;
    if (cron) {
      createArgs = {
        ...base,
        cron,
        ...(recurring !== undefined ? { recurring } : {}),
      };
    } else if (runAt) {
      if (recurring === true) {
        throw new Error("chat.createScheduledWork runAt schedules cannot recur.");
      }
      createArgs = { ...base, runAt, recurring: false };
    } else if (typeof payload.delaySeconds === "number") {
      if (recurring === true) {
        throw new Error("chat.createScheduledWork delaySeconds schedules cannot recur.");
      }
      createArgs = { ...base, delaySeconds: payload.delaySeconds, recurring: false };
    } else {
      throw new Error("chat.createScheduledWork requires delaySeconds.");
    }
    return requireService(args.agentChatService, "Agent chat service not available.").createScheduledWork(createArgs);
  });
  register("chat.listScheduledWork", { viewerAllowed: true, queueable: false }, async (payload) => {
    const sessionId = asTrimmedString(payload.sessionId);
    return requireService(args.agentChatService, "Agent chat service not available.").listScheduledWork({
      ...(sessionId ? { sessionId } : {}),
      ...(payload.includeTerminal === true ? { includeTerminal: true } : {}),
    });
  });
  register("chat.cancelScheduledWork", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").cancelScheduledWork({
      sessionId: requireString(payload.sessionId, "chat.cancelScheduledWork requires sessionId."),
      scheduleId: requireString(payload.scheduleId, "chat.cancelScheduledWork requires scheduleId."),
    }));
  register("chat.setScheduledWorkPaused", { viewerAllowed: true, queueable: false }, async (payload) => {
    const paused = asOptionalBoolean(payload.paused);
    if (paused === undefined) throw new Error("chat.setScheduledWorkPaused requires paused.");
    return requireService(args.agentChatService, "Agent chat service not available.").setScheduledWorkPaused({
      sessionId: requireString(payload.sessionId, "chat.setScheduledWorkPaused requires sessionId."),
      paused,
    });
  });
  register("chat.getChatEventHistory", { viewerAllowed: true, observesAbort: true }, async (payload, context): Promise<AgentChatEventHistorySnapshot> => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const sessionId = requireString(payload.sessionId, "chat.getChatEventHistory requires sessionId.");
    const maxEvents = asOptionalNumber(payload.maxEvents);
    const maxBytes = asOptionalNumber(payload.maxBytes);
    const options = {
      ...(maxEvents != null ? { maxEvents } : {}),
      ...(maxBytes != null ? { maxBytes } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    };
    const historyOptions = Object.keys(options).length > 0 ? options : undefined;
    return await agentChatService.getChatEventHistory(sessionId, historyOptions);
  });
  register("chat.getTranscript", { viewerAllowed: true, observesAbort: true }, async (payload, context) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseGetTranscriptArgs(payload);
    const limit = Math.max(1, Math.min(TRANSCRIPT_PAGE_MAX_LIMIT, Math.floor(parsed.limit ?? TRANSCRIPT_PAGE_DEFAULT_LIMIT)));
    const maxChars = Math.max(200, Math.min(TRANSCRIPT_PAGE_MAX_CHARS, Math.floor(parsed.maxChars ?? TRANSCRIPT_PAGE_DEFAULT_MAX_CHARS)));
    if (parsed.cursorKind !== "byte") {
      if (parsed.cursor == null) {
        const result = await agentChatService.getChatTranscript({
          sessionId: parsed.sessionId,
          limit,
          maxChars,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const oldestReturnedIndex = result.totalEntries - result.entries.length;
        return {
          ...result,
          nextCursor: oldestReturnedIndex > 0 ? String(oldestReturnedIndex) : null,
        };
      }
      const allEntries = await agentChatService.readTranscript(
        parsed.sessionId,
        undefined,
        undefined,
        context.signal,
      );
      const end = Math.max(0, Math.min(parsed.cursor, allEntries.length));
      const start = Math.max(0, end - limit);
      const { entries, truncated } = boundTranscriptEntriesByChars(allEntries.slice(start, end), maxChars);
      const oldestReturnedIndex = end - entries.length;
      const hasMore = oldestReturnedIndex > 0 && entries.length > 0;
      return {
        sessionId: parsed.sessionId,
        entries,
        truncated: truncated || hasMore,
        totalEntries: allEntries.length,
        nextCursor: hasMore ? String(oldestReturnedIndex) : null,
      };
    }
    const page = await agentChatService.getChatTranscriptPage({
      sessionId: parsed.sessionId,
      ...(parsed.cursor != null ? { beforeOffset: parsed.cursor } : {}),
      limit,
      maxChars,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return {
      ...page,
      nextCursor: page.nextCursor == null ? null : String(page.nextCursor),
    };
  });
  register("chat.getSubagentTranscript", { viewerAllowed: true, queueable: false, observesAbort: true }, async (payload, context) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatSubagentTranscriptArgs(payload);
    return context.signal
      ? agentChatService.getSubagentTranscript(parsed, context.signal)
      : agentChatService.getSubagentTranscript(parsed);
  });
  register("chat.getMainTranscript", { viewerAllowed: true, queueable: false, observesAbort: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getMainTranscript(
      parseAgentChatMainTranscriptArgs(payload),
    ));
  register("chat.listSubagents", { viewerAllowed: true, queueable: false, observesAbort: true }, async (payload, context) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatSubagentListArgs(payload);
    return context.signal
      ? agentChatService.listSubagents(parsed, context.signal)
      : agentChatService.listSubagents(parsed);
  });
  const getChatEventHistoryPage = async (
    payload: Record<string, unknown>,
    context: SyncRemoteCommandExecutionContext,
  ) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const sessionId = requireString(payload.sessionId, "chat.getChatEventHistoryPage requires sessionId.");
    const beforeOffset = typeof payload.beforeOffset === "number" && Number.isFinite(payload.beforeOffset)
      ? payload.beforeOffset
      : 0;
    const maxBytes = typeof payload.maxBytes === "number" && Number.isFinite(payload.maxBytes) && payload.maxBytes > 0
      ? payload.maxBytes
      : undefined;
    return await agentChatService.getChatEventHistoryPage(sessionId, {
      beforeOffset,
      ...(maxBytes != null ? { maxBytes } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  };
  // Byte-offset transcript pagination for chat event envelopes (scroll-back
  // beyond the hydrated tail). The canonical action mirrors the desktop/TUI
  // ADE action surface; the legacy agentChat.* name remains for older mobile
  // clients that learned the first sync-only spelling.
  register("chat.getChatEventHistoryPage", { viewerAllowed: true, observesAbort: true }, getChatEventHistoryPage);
  register("agentChat.getEventHistoryPage", { viewerAllowed: true, observesAbort: true }, getChatEventHistoryPage);
  register("chat.create", { viewerAllowed: true, queueable: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatCreateArgs(payload);
    const session = await agentChatService.createSession(await resolveChatCreateArgs(agentChatService, parsed));
    return summarizeChatSessionForRemote(agentChatService, session);
  });
  register("chat.send", { viewerAllowed: true, queueable: true }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.").sendMessage(
      parseAgentChatSendArgs(payload),
      { awaitDispatch: false, routeActiveToSteer: true },
    );
    return isRecord(result) ? { ...result, ok: true } : { ok: true };
  });
  register("chat.interrupt", { viewerAllowed: true, queueable: false }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.").interrupt(parseAgentChatInterruptArgs(payload));
    return { ...result, ok: true };
  });
  register("chat.interruptWithQueueMode", { viewerAllowed: true, queueable: false }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.").interrupt(parseAgentChatInterruptArgs(payload));
    return { ...result, ok: true };
  });
  register("chat.restoreCancelledQueue", { viewerAllowed: true, queueable: false }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.")
      .restoreCancelledQueue(parseAgentChatRestoreCancelledQueueArgs(payload));
    return { ...result, ok: true };
  });
  register("chat.recoverCodexTurn", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.")
      .recoverCodexTurn(parseAgentChatRecoverCodexTurnArgs(payload)));
  register("chat.recoverTurn", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.")
      .recoverTurn(parseAgentChatRecoverTurnArgs(payload)));
  register("chat.resolveUnprocessedMessage", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.")
      .resolveUnprocessedMessage(parseAgentChatResolveUnprocessedMessageArgs(payload)));
  register("chat.steer", { viewerAllowed: true, queueable: false }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.")
      .steerUserMessage(parseAgentChatSteerArgs(payload));
    return isRecord(result) ? { ...result, ok: true } : { ok: true };
  });
  register("chat.cancelSteer", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").cancelSteer(parseAgentChatCancelSteerArgs(payload));
    return { ok: true };
  });
  register("chat.editSteer", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").editSteer(parseAgentChatEditSteerArgs(payload));
    return { ok: true };
  });
  register("chat.dispatchSteer", { viewerAllowed: true, queueable: false }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.").dispatchSteer(parseAgentChatDispatchSteerArgs(payload));
    return { ok: true, dispatchedAt: result.dispatchedAt };
  });
  register("chat.cancelDispatchedSteer", { viewerAllowed: true, queueable: false }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.").cancelDispatchedSteer(parseAgentChatCancelDispatchedSteerArgs(payload));
    return { ok: true, cancelled: result.cancelled };
  });
  register("chat.approve", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").approveToolUse(parseAgentChatApproveArgs(payload));
    return { ok: true };
  });
  register("chat.respondToInput", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").respondToInput(parseAgentChatRespondToInputArgs(payload));
    return { ok: true };
  });
  // Restart: fired by iOS Live Activity + Attention Drawer "Restart" pill on
  // a failed agent. Keep this explicit failure-recovery action distinct from
  // ordinary continuation, which is handled by chat.send.
  register("chat.restart", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").resumeSession({
      sessionId: requireString(payload.sessionId, "chat.restart requires sessionId."),
    }));
  register("chat.updateSession", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").updateSession(parseAgentChatUpdateSessionArgs(payload)));
  register("chat.getCodexGoal", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getCodexGoal(parseAgentChatCodexGetGoalArgs(payload)));
  register("chat.setCodexGoal", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").setCodexGoal(parseAgentChatCodexSetGoalArgs(payload)));
  register("chat.setCodexGoalStatus", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").setCodexGoalStatus(parseAgentChatCodexSetGoalStatusArgs(payload)));
  register("chat.clearCodexGoal", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").clearCodexGoal(parseAgentChatCodexClearGoalArgs(payload)));
  register("chat.archive", { viewerAllowed: true, queueable: true }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").archiveSession(parseAgentChatArchiveArgs(payload, "chat.archive"));
    return { ok: true };
  });
  register("chat.unarchive", { viewerAllowed: true, queueable: true }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").unarchiveSession(parseAgentChatArchiveArgs(payload, "chat.unarchive"));
    return { ok: true };
  });
  register("chat.delete", { viewerAllowed: true, queueable: true }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").deleteSession(parseAgentChatArchiveArgs(payload, "chat.delete"));
    return { ok: true };
  });
  register("chat.models", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getAvailableModels(parseChatModelsArgs(payload)));
  register("chat.modelCatalog", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getModelCatalog(parseChatModelCatalogArgs(payload)));

}

function registerPersonalChatRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  const scope = args.personalChatScope;
  if (!scope) return;
  for (const action of PERSONAL_CHAT_ACTIONS) {
    const observesAbort = action === "read"
      || action === "getEventHistory"
      || action === "getEventHistoryPage";
    register(
      `personalChats.${action}`,
      {
        viewerAllowed: isPersonalChatActionViewerAllowed(action),
        queueable: isPersonalChatActionQueueable(action),
        ...(observesAbort ? { observesAbort: true } : {}),
      },
      async (payload, context) => (
        await (
          context.signal
            ? scope.call(action, payload, context.signal)
            : scope.call(action, payload)
        )
      ).result,
      "runtime",
    );
  }
  register(
    "personalChats.streamEvents",
    { viewerAllowed: true, queueable: false },
    async (payload) => await scope.streamEvents(payload),
    "runtime",
  );
}

function registerPushRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  const publisher = args.pushPublisherService ?? null;
  const unavailable = (action: string) => async (): Promise<never> => {
    throw new Error(`${action} is unavailable: push publishing is not running on this ADE machine.`);
  };

  register(
    "attention.getMachineSnapshot",
    { viewerAllowed: true },
    publisher
      ? async () => publisher.getMachineAttentionSnapshot()
      : unavailable("attention.getMachineSnapshot"),
    "runtime",
  );

  register(
    "attention.acknowledgeMachine",
    { viewerAllowed: true, queueable: false },
    publisher
      ? async (payload) => {
        const itemIds = Array.isArray(payload.itemIds)
          ? payload.itemIds
            .filter((value): value is string =>
              typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim())
            .slice(0, 64)
          : [];
        if (itemIds.length === 0) {
          throw new Error("attention.acknowledgeMachine requires at least one item id.");
        }
        const sourceRevisions = isRecord(payload.sourceRevisions)
          ? Object.fromEntries(
              Object.entries(payload.sourceRevisions)
                .filter((entry): entry is [string, number] =>
                  Number.isFinite(entry[1])),
            )
          : {};
        if (itemIds.some((itemId) => !Number.isFinite(sourceRevisions[itemId]))) {
          throw new Error(
            "attention.acknowledgeMachine requires the source revision for every item.",
          );
        }
        if (
          payload.expectedAccountOwnerId !== null
          && typeof payload.expectedAccountOwnerId !== "string"
        ) {
          throw new Error(
            "attention.acknowledgeMachine requires the machine snapshot account owner.",
          );
        }
        await publisher.acknowledgeMachineAttention({
          itemIds,
          sourceRevisions,
          expectedAccountOwnerId: asTrimmedString(payload.expectedAccountOwnerId),
          ...(typeof payload.seenAt === "string" ? { seenAt: payload.seenAt } : {}),
          ...(payload.dismissedAt === null || typeof payload.dismissedAt === "string"
            ? { dismissedAt: payload.dismissedAt }
            : {}),
        });
        return { ok: true };
      }
      : unavailable("attention.acknowledgeMachine"),
    "runtime",
  );

  register(
    PUSH_REGISTER_DEVICE_ACTION as SyncRemoteCommandAction,
    { viewerAllowed: true },
    publisher
      ? async (payload) => publisher.handleDeviceRegistered(parsePushRegisterDeviceArgs(payload))
      : unavailable(PUSH_REGISTER_DEVICE_ACTION),
    "runtime",
  );

  register(
    PUSH_UNREGISTER_DEVICE_ACTION as SyncRemoteCommandAction,
    { viewerAllowed: true },
    publisher
      ? async (payload) => {
        await publisher.handleUnregister(requireString(payload.deviceId, "push.unregisterDevice requires deviceId."));
        return { ok: true };
      }
      : unavailable(PUSH_UNREGISTER_DEVICE_ACTION),
    "runtime",
  );

  register(
    PUSH_SET_PREFS_ACTION as SyncRemoteCommandAction,
    { viewerAllowed: true },
    publisher
      ? async (payload) => {
        const deviceId = requireString(payload.deviceId, "push.setPrefs requires deviceId.");
        const applied = publisher.setPrefs(deviceId, parsePushPrefs(payload.prefs));
        return { ok: applied };
      }
      : unavailable(PUSH_SET_PREFS_ACTION),
    "runtime",
  );

  register(
    PUSH_REPORT_LIVE_ACTIVITY_TOKEN_ACTION as SyncRemoteCommandAction,
    { viewerAllowed: true },
    publisher
      ? async (payload) => {
        await publisher.handleLiveActivityToken(parsePushLiveActivityTokenArgs(payload));
        return { ok: true };
      }
      : unavailable(PUSH_REPORT_LIVE_ACTIVITY_TOKEN_ACTION),
    "runtime",
  );

  register(
    PUSH_GET_STATUS_ACTION as SyncRemoteCommandAction,
    { viewerAllowed: true },
    publisher
      ? async (payload) => publisher.getDeliveryStatus(asTrimmedString(payload.deviceId))
      : async () => ({
        publisherEnabled: false,
        relayUrl: null,
        relayApnsConfigured: null,
        deviceRegistered: false,
        registeredDeviceCount: 0,
        lastPublishAt: null,
        lastPublishError: null,
        lastRelayContactAt: null,
      } satisfies PushDeliveryStatus),
    "runtime",
  );
}

function registerSyncRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register(
    "sync.getWebPairingInfo",
    // Returns the raw pairing PIN and a ready-to-use pairing URL, so a paired
    // viewer could onboard further devices without the owner. Host-local only,
    // same as `sync.getDesktopPairingInfo` below.
    { viewerAllowed: false },
    async (payload): Promise<SyncWebPairingInfo> => {
      parseGetWebPairingInfoArgs(payload);
      const syncPinStore = requireService(args.syncPinStore, "Sync PIN store is not available.");
      const getPairingConnectInfo = requireService(
        args.getPairingConnectInfo,
        "Sync pairing connect info is not available.",
      );
      const connectInfo = requireService(getPairingConnectInfo(), "Sync pairing connect info is not available.");
      const pinConfigured = syncPinStore.hasPin();
      const code = pinConfigured ? syncPinStore.getPin() : null;
      const hasRelayCandidate = connectInfo.addressCandidates.some((candidate) =>
        candidate.kind === "relay" && candidate.host.trim().length > 0);
      return {
        pairingUrl: buildWebClientPairUrl(buildPairingQrPayload({ connectInfo, pinConfigured })),
        code: code ?? null,
        pinConfigured,
        machineName: connectInfo.hostIdentity.name,
        relayEnabled: args.isCloudRelayEnabled?.() ?? hasRelayCandidate,
        hasRelayCandidate,
      };
    },
    "runtime",
  );
  register(
    "sync.getDesktopPairingInfo",
    // The desktop calls this through its local runtime connection. Paired
    // viewers must not mint grants for the privileged runtime channels.
    { viewerAllowed: false },
    async (payload): Promise<SyncWebPairingInfo> => {
      parseGetWebPairingInfoArgs(payload);
      const syncPinStore = requireService(args.syncPinStore, "Sync PIN store is not available.");
      const getPairingConnectInfo = requireService(
        args.getPairingConnectInfo,
        "Sync pairing connect info is not available.",
      );
      const issueGrant = requireService(
        args.issueRuntimeHostPairingGrant,
        "Desktop runtime pairing grants are not available.",
      );
      const connectInfo = requireService(getPairingConnectInfo(), "Sync pairing connect info is not available.");
      const pinConfigured = syncPinStore.hasPin();
      const code = pinConfigured ? syncPinStore.getPin() : null;
      const hasRelayCandidate = connectInfo.addressCandidates.some((candidate) =>
        candidate.kind === "relay" && candidate.host.trim().length > 0);
      return {
        pairingUrl: buildWebClientPairUrl(buildPairingQrPayload({
          connectInfo,
          runtimeHostGrant: issueGrant(),
          pinConfigured,
        })),
        code: code ?? null,
        pinConfigured,
        machineName: connectInfo.hostIdentity.name,
        relayEnabled: args.isCloudRelayEnabled?.() ?? hasRelayCandidate,
        hasRelayCandidate,
      };
    },
    "runtime",
  );
}

function registerModelPickerRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  // Cross-surface ModelPicker favorites + recents — see modelPickerStore.ts.
  // Mirrors the direct JSON-RPC `modelPicker.*` methods on adeRpcServer so iOS
  // (which routes through the WebSocket sync command envelope) shares the same
  // per-project cr-sqlite-backed store. Falls back to the per-db shared store
  // built from `args.db` when no explicit accessor is wired — so the sync host
  // always reads/writes the real DB rather than an empty stub.
  const requireModelPickerStore = (): ModelPickerStore => {
    const injected = args.getModelPickerStore?.();
    if (injected) return injected;
    if (!args.db) {
      throw new Error("Model picker store is not available: no DB wired for this runtime.");
    }
    return getSharedModelPickerStore(args.db);
  };

  register("modelPicker.getFavorites", { viewerAllowed: true }, async () => ({
    favorites: requireModelPickerStore().getFavorites(),
  }));
  register("modelPicker.setFavorites", { viewerAllowed: true }, async (payload) => {
    const rawFavorites = (payload as { favorites?: unknown }).favorites;
    const favoritesInput = Array.isArray(rawFavorites)
      ? rawFavorites.filter((entry): entry is string => typeof entry === "string")
      : [];
    return { favorites: requireModelPickerStore().setFavorites(favoritesInput) };
  });
  register("modelPicker.toggleFavorite", { viewerAllowed: true }, async (payload) => {
    const modelId = typeof (payload as { modelId?: unknown }).modelId === "string"
      ? ((payload as { modelId?: string }).modelId as string)
      : "";
    return requireModelPickerStore().toggleFavorite(modelId);
  });
  register("modelPicker.getRecents", { viewerAllowed: true }, async () => ({
    recents: requireModelPickerStore().getRecents(),
  }));
  register("modelPicker.pushRecent", { viewerAllowed: true }, async (payload) => {
    const modelId = typeof (payload as { modelId?: unknown }).modelId === "string"
      ? ((payload as { modelId?: string }).modelId as string)
      : "";
    return { recents: requireModelPickerStore().pushRecent(modelId) };
  });
}

function registerCtoRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("cto.ensureSession", { viewerAllowed: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const laneId = await resolvePrimaryLaneIdOnlyForSync(args);
    if (!laneId) throw new Error("No primary lane is available to host the CTO chat session.");
    const modelId = asTrimmedString(payload.modelId);
    const reasoningEffort = asTrimmedString(payload.reasoningEffort);
    const session = await agentChatService.ensureIdentitySession({
      identityKey: "cto",
      laneId,
      modelId: modelId ?? null,
      reasoningEffort: reasoningEffort ?? null,
      permissionMode: "full-auto",
    });
    return summarizeChatSessionForRemote(agentChatService, session);
  });

  register("cto.getState", { viewerAllowed: true }, async (payload) => {
    const ctoStateService = requireService(args.ctoStateService, "CTO state service not available.");
    const recentLimit = asOptionalNumber(payload.recentLimit);
    return ctoStateService.getSnapshot(recentLimit ?? 20);
  });
  register("cto.getAttention", { viewerAllowed: true }, async () => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    // Strictly read-only: `getCtoAttention` never calls ensureIdentitySession,
    // so a phone drawing a badge cannot materialize a primary lane and a CTO
    // chat session as a side effect. Returns CtoAttentionState verbatim.
    return agentChatService.getCtoAttention();
  });
  register("cto.getMemory", { viewerAllowed: true }, async () => {
    const ctoMemoryService = requireService(args.ctoMemoryService, "CTO memory service not available.");
    // Returns the exact CtoMemorySnapshot shape the iOS client decodes:
    // { memory, threadState, dailyLog, dailyLogDate, updatedAt }.
    return ctoMemoryService.getSnapshot();
  });
  register("cto.getLinearConnectionStatus", { viewerAllowed: true }, async () =>
    buildLinearConnectionStatus(args));
  register("cto.startLinearMobileOAuth", { viewerAllowed: true }, async () => {
    const linearOAuthService = requireService(
      args.linearOAuthService,
      "Linear OAuth service not available.",
    );
    return linearOAuthService.startExternalSession({
      redirectUri: LINEAR_MOBILE_OAUTH_REDIRECT_URI,
    });
  });
  register("cto.completeLinearMobileOAuth", { viewerAllowed: true }, async (payload) => {
    const linearOAuthService = requireService(
      args.linearOAuthService,
      "Linear OAuth service not available.",
    );
    const result = await linearOAuthService.completeExternalSession({
      sessionId: requireString(
        payload.sessionId,
        "cto.completeLinearMobileOAuth requires sessionId.",
      ),
      code: requireString(payload.code, "cto.completeLinearMobileOAuth requires code."),
      state: requireString(payload.state, "cto.completeLinearMobileOAuth requires state."),
    });
    // On failure, report the ACTUAL current status (the prior token may still
    // be valid — e.g. a reconnect whose fresh exchange failed) with the failure
    // reason attached, instead of forcing an unconditional disconnected status.
    return result.ok
      ? buildLinearConnectionStatus(args)
      : buildLinearConnectionStatus(args, result.message);
  });
  // Direct credential-store writes. Paired viewers (phones, browsers) get the
  // interactive `*LinearMobileOAuth` pair instead: that token is minted by
  // Linear against a host-issued session, whereas these two accept an arbitrary
  // secret — or wipe the owner's — from whatever device is on the socket. The
  // registry is the gate here, not the absence of client wiring.
  register("cto.setLinearToken", { viewerAllowed: false }, async (payload) => {
    const linearCredentialService = requireService(
      args.linearCredentialService,
      "Linear credential service not available.",
    );
    linearCredentialService.setToken(
      requireString(payload.token, "cto.setLinearToken requires token."),
    );
    return buildLinearConnectionStatus(args);
  });
  register("cto.clearLinearToken", { viewerAllowed: false }, async () => {
    const linearCredentialService = requireService(
      args.linearCredentialService,
      "Linear credential service not available.",
    );
    linearCredentialService.clearToken();
    return buildDisconnectedLinearConnectionStatus(args, "Linear token not configured.");
  });
  register("cto.getLinearQuickView", { viewerAllowed: true }, async () => {
    const credentialStatus = args.linearCredentialService?.getStatus() ?? {
      tokenStored: false,
      authMode: null,
      tokenExpiresAt: null,
      oauthConfigured: false,
    };
    const tokenStored = Boolean(credentialStatus.tokenStored);
    const checkedAt = new Date().toISOString();
    const linearIssueTracker = args.getLinearIssueTracker?.() ?? null;
    const unavailableConnection = {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt,
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: tokenStored ? "Linear tracker service unavailable." : "Linear token not configured.",
    };
    if (!linearIssueTracker || !tokenStored) return emptyLinearQuickView(unavailableConnection);
    const status = await linearIssueTracker.getConnectionStatus();
    const connection = {
      tokenStored,
      connected: status.connected,
      viewerId: status.viewerId,
      viewerName: status.viewerName,
      organizationId: status.organizationId,
      organizationName: status.organizationName,
      organizationUrlKey: status.organizationUrlKey,
      organizationLogoUrl: status.organizationLogoUrl,
      checkedAt,
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: status.message,
    };
    if (!status.connected) return emptyLinearQuickView(connection);
    return linearIssueTracker.getQuickView(connection);
  });
  register("cto.getLinearIssuePickerData", { viewerAllowed: true }, async () => {
    const linearIssueTracker = await getConnectedLinearIssueTracker(args);
    if (!linearIssueTracker) {
      return { projects: [], users: [], states: [] };
    }
    const [projects, users, states] = await Promise.all([
      linearIssueTracker.listProjects().catch(() => []),
      linearIssueTracker.listUsers().catch(() => []),
      linearIssueTracker.listWorkflowStates().catch(() => []),
    ]);
    return { projects, users, states };
  });
  register("cto.searchLinearIssues", { viewerAllowed: true }, async (payload) => {
    const linearIssueTracker = await getConnectedLinearIssueTracker(args);
    if (!linearIssueTracker) {
      return { issues: [], pageInfo: { hasNextPage: false, endCursor: null } };
    }
    const projectId = asNullableTrimmedString(payload.projectId);
    const projectSlug = asNullableTrimmedString(payload.projectSlug);
    const teamKey = asNullableTrimmedString(payload.teamKey);
    const stateTypes = asStringArray(payload.stateTypes);
    const assigneeId = asNullableTrimmedString(payload.assigneeId);
    const priority = asOptionalNumber(payload.priority);
    const searchQuery = asNullableTrimmedString(payload.query);
    const first = asOptionalNumber(payload.first);
    const after = asNullableTrimmedString(payload.after);
    const includeArchived = asOptionalBoolean(payload.includeArchived);
    const query = {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(projectSlug !== undefined ? { projectSlug } : {}),
      ...(teamKey !== undefined ? { teamKey } : {}),
      ...(stateTypes.length ? { stateTypes } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(searchQuery !== undefined ? { query: searchQuery } : {}),
      ...(first !== undefined ? { first } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(includeArchived !== undefined ? { includeArchived } : {}),
    };
    return linearIssueTracker.searchIssues(query);
  });
  register("cto.getLinearIssueComments", { viewerAllowed: true }, async (payload) => {
    const issueId = asTrimmedString(payload.issueId);
    if (!issueId) return [];
    const linearIssueTracker = await getConnectedLinearIssueTracker(args);
    if (!linearIssueTracker) return [];
    return linearIssueTracker.fetchIssueComments(issueId);
  });
  register("cto.updateIdentity", { viewerAllowed: true, queueable: true }, async (payload) => {
    const ctoStateService = requireService(args.ctoStateService, "CTO state service not available.");
    const patch = isRecord(payload.patch) ? (payload.patch as Partial<CtoIdentity>) : {};
    return ctoStateService.updateIdentity(patch);
  });
}

function registerGitAndFileRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("git.getChanges", { viewerAllowed: true }, async (payload) =>
    requireService(args.diffService, "Diff service not available.").getChanges(parseGetDiffChangesArgs(payload).laneId));
  register("git.getFile", { viewerAllowed: true }, async (payload) => {
    const diffService = requireService(args.diffService, "Diff service not available.");
    const parsed = parseGetFileDiffArgs(payload);
    return await diffService.getFileDiff({
      laneId: parsed.laneId,
      filePath: parsed.path,
      mode: parsed.mode,
      compareRef: parsed.compareRef,
      compareTo: parsed.compareTo,
    });
  });
  register("git.getFilePatch", { viewerAllowed: true }, async (payload) => {
    const diffService = requireService(args.diffService, "Diff service not available.");
    const parsed = parseGetFilePatchArgs(payload);
    return await diffService.getFilePatch({
      laneId: parsed.laneId,
      filePath: parsed.path,
      mode: parsed.mode,
      compareRef: parsed.compareRef,
      compareTo: parsed.compareTo,
    });
  });
  register("git.getUserIdentity", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getUserIdentity(parseGitUserIdentityArgs(payload)));
  register("files.writeTextAtomic", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseWriteTextAtomicArgs(payload);
    args.fileService.writeTextAtomic({ laneId: parsed.laneId, relPath: parsed.path, text: parsed.text });
    return { ok: true };
  });
  register("git.stageFile", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").stageFile(parseGitFileActionArgs(payload, "git.stageFile")));
  register("git.stageAll", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").stageAll(parseGitBatchFileActionArgs(payload, "git.stageAll")));
  register("git.unstageFile", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").unstageFile(parseGitFileActionArgs(payload, "git.unstageFile")));
  register("git.unstageAll", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").unstageAll(parseGitBatchFileActionArgs(payload, "git.unstageAll")));
  register("git.discardFile", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").discardFile(parseGitFileActionArgs(payload, "git.discardFile")));
  register("git.restoreStagedFile", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").restoreStagedFile(parseGitFileActionArgs(payload, "git.restoreStagedFile")));
  register("git.commit", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").commit(parseGitCommitArgs(payload)));
  register("git.generateCommitMessage", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").generateCommitMessage(parseGitGenerateCommitMessageArgs(payload)));
  register("git.listRecentCommits", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").listRecentCommits(parseGitListRecentCommitsArgs(payload)));
  register("git.listCommitFiles", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").listCommitFiles(parseGitListCommitFilesArgs(payload)));
  register("git.getFileHistory", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getFileHistory(parseGitGetFileHistoryArgs(payload)));
  register("git.getCommitMessage", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getCommitMessage(parseGitGetCommitMessageArgs(payload)));
  register("git.getCommit", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getCommit(parseGitGetCommitArgs(payload)));
  register("git.isCommitInLaneHistory", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").isCommitInLaneHistory(parseGitCommitReachabilityArgs(payload)));
  register("git.revertCommit", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").revertCommit(parseGitRevertArgs(payload)));
  register("git.cherryPickCommit", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").cherryPickCommit(parseGitCherryPickArgs(payload)));
  register("git.createTag", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").createTag(parseGitCreateTagArgs(payload)));
  register("git.resetToCommit", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").resetToCommit(parseGitResetCommitArgs(payload)));
  register("git.stashPush", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").stashPush(parseGitStashPushArgs(payload)));
  register("git.stashList", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").listStashes(parseConflictLaneArgs(payload, "git.stashList")));
  register("git.stashApply", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").stashApply(parseGitStashRefArgs(payload, "git.stashApply")));
  register("git.stashPop", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").stashPop(parseGitStashRefArgs(payload, "git.stashPop")));
  register("git.stashDrop", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").stashDrop(parseGitStashRefArgs(payload, "git.stashDrop")));
  register("git.stashClear", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").stashClear(parseConflictLaneArgs(payload, "git.stashClear")));
  register("git.fetch", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").fetch(parseConflictLaneArgs(payload, "git.fetch")));
  register("git.pull", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").pull(parseGitPullArgs(payload)));
  register("git.undoLastHeadChange", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").undoLastHeadChange(parseConflictLaneArgs(payload, "git.undoLastHeadChange")));
  register("git.redoLastHeadChange", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").redoLastHeadChange(parseConflictLaneArgs(payload, "git.redoLastHeadChange")));
  register("git.getSyncStatus", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getSyncStatus(parseConflictLaneArgs(payload, "git.getSyncStatus")));
  register("git.getOriginRemote", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getOriginRemote(parseConflictLaneArgs(payload, "git.getOriginRemote")));
  register("git.getOpenPrForBranch", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getOpenPrForBranch(parseGitOpenPrForBranchArgs(payload)));
  register("git.sync", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").sync(parseGitSyncArgs(payload)));
  register("git.push", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").push(parseGitPushArgs(payload)));
  register("git.getConflictState", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").getConflictState(parseConflictLaneArgs(payload, "git.getConflictState")));
  register("git.rebaseContinue", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").rebaseContinue(parseConflictLaneArgs(payload, "git.rebaseContinue")));
  register("git.rebaseAbort", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").rebaseAbort(parseConflictLaneArgs(payload, "git.rebaseAbort")));
  register("git.mergeContinue", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").mergeContinue(parseConflictLaneArgs(payload, "git.mergeContinue")));
  register("git.mergeAbort", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").mergeAbort(parseConflictLaneArgs(payload, "git.mergeAbort")));
  register("git.listBranches", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").listBranches(parseGitListBranchesArgs(payload)));
  register("git.checkoutBranch", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").checkoutBranch(parseGitCheckoutBranchArgs(payload)));
}

function registerTerminalRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("terminal.list", { viewerAllowed: true }, async (payload) =>
    args.ptyService.listTerminals(parseTerminalListArgs(payload)));
  register("terminal.activeForChat", { viewerAllowed: true }, async (payload) =>
    args.ptyService.activeForChat(parseTerminalActiveForChatArgs(payload)));
}

function registerConflictRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("conflicts.getLaneStatus", { viewerAllowed: true }, async (payload) =>
    requireService(args.conflictService, "Conflict service not available.").getLaneStatus(parseConflictLaneArgs(payload, "conflicts.getLaneStatus")));
  register("conflicts.listOverlaps", { viewerAllowed: true }, async (payload) =>
    requireService(args.conflictService, "Conflict service not available.").listOverlaps(parseConflictLaneArgs(payload, "conflicts.listOverlaps")));
  register("conflicts.getBatchAssessment", { viewerAllowed: true }, async () =>
    requireService(args.conflictService, "Conflict service not available.").getBatchAssessment());
}

function registerMiscRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("rebase.scanNeeds", { viewerAllowed: true }, async () =>
    requireService(args.conflictService, "Conflict service not available.").scanRebaseNeeds());
  register("rebase.execute", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.conflictService, "Conflict service not available.").rebaseLane(
      payload as Parameters<ReturnType<typeof createConflictService>["rebaseLane"]>[0],
    ));
  register("history.listOperations", { viewerAllowed: true }, async (payload) =>
    requireService(args.operationService, "Operation service not available.").list(parseListOperationsArgs(payload)));
  register("github.getStatus", { viewerAllowed: true, observesAbort: true }, async (payload): Promise<GitHubStatus> =>
    requireService(args.githubService, "GitHub service not available.").getStatus({
      forceRefresh: payload.forceRefresh === true,
    }));
  register("github.getRemoteStatus", { viewerAllowed: true, observesAbort: true }, async (): Promise<{ repo: GitHubRepoRef | null; hasOrigin: boolean }> =>
    requireService(args.githubService, "GitHub service not available.").getRemoteStatus());
  register("github.publishCurrentProject", { viewerAllowed: true }, async (payload): Promise<PublishProjectResult> => {
    const { owner, name, description, isPrivate } = parsePublishCurrentProjectArgs(payload);
    return await requireService(args.githubService, "GitHub service not available.").publishCurrentProject({
      ...(owner ? { owner } : {}),
      name,
      ...(description ? { description } : {}),
      isPrivate,
    });
  }, "project");
  register("projectConfig.get", { viewerAllowed: true }, async () =>
    redactProjectConfigSnapshotForRemote(
      requireService(args.projectConfigService, "Project config service not available.").get(),
    ));
  register("projectConfig.save", { viewerAllowed: true }, async (payload) => {
    const projectConfigService = requireService(args.projectConfigService, "Project config service not available.");
    const candidate = mergeProjectConfigCandidateForRemote(
      parseProjectConfigSaveArgs(payload).candidate,
      projectConfigService.get(),
    );
    return redactProjectConfigSnapshotForRemote(projectConfigService.save(candidate));
  });
  register("ai.getStatus", { viewerAllowed: true, observesAbort: true }, async (payload, context) => {
    try {
      return await runAiStatusWithTimeout(
        () => buildAiSettingsStatus(args.aiIntegrationService, {
          force: payload.force === true,
          refreshOpenCodeInventory: payload.refreshOpenCodeInventory === true,
        }),
        context.signal,
      );
    } catch (error) {
      if (isDatabaseClosedError(error)) return getUnavailableAiStatus();
      throw error;
    }
  });
  register("orchestration.runCreate", { viewerAllowed: true }, async (payload) => {
    const orchestrationService = requireService(args.orchestrationService, "Orchestration service not available.");
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    return createOrchestrationDomainService({
      orchestrationService,
      laneService: {
        getLaneWorktreePath: (laneId: string) => args.laneService.getLaneWorktreePath(laneId),
      },
      agentChatService,
    }).runCreate(parseOrchestrationRunCreateArgs(payload));
  });
}

function registerPrAndDeeplinkRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("prs.list", { viewerAllowed: true, observesAbort: true }, async () => args.prService.listAll());
  register("prs.listOpenForRepo", { viewerAllowed: true, observesAbort: true }, async () => args.prService.listOpenPullRequests());
  register("prs.getForLane", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.getForLane(parseLaneIdArgs(payload, "prs.getForLane").laneId));
  // Manual per-badge ⟳ sync + focus reconcile, so the web/mobile surfaces reach
  // the same heal path as desktop (both are already in ADE_ACTION_ALLOWLIST.pr).
  register("prs.syncLanePr", { viewerAllowed: true }, async (payload) =>
    args.prService.syncLanePr(parseLaneIdArgs(payload, "prs.syncLanePr").laneId));
  register("prs.reconcileOnFocus", { viewerAllowed: true }, async (payload) =>
    args.prService.reconcileOnFocus({ force: payload?.force === true }));
  register("prs.refresh", { viewerAllowed: true, observesAbort: true }, async (payload) => {
    const prId = asTrimmedString(payload.prId);
    const prIds = asStringArray(payload.prIds);
    let refreshArgs: { prId?: string; prIds?: string[] } = {};
    if (prId) refreshArgs = { prId };
    else if (prIds.length > 0) refreshArgs = { prIds };
    await args.prService.refresh(refreshArgs);
    const allPrs = await args.prService.listAll();
    const requestedPrIds = new Set(prId ? [prId] : prIds);
    const prs = requestedPrIds.size > 0 ? allPrs.filter((pr) => requestedPrIds.has(pr.id)) : allPrs;
    let refreshedCount = prs.length;
    if (prId) refreshedCount = 1;
    else if (prIds.length > 0) refreshedCount = prIds.length;
    const snapshots = prId
      ? args.prService.listSnapshots({ prId }).filter((snapshot) => requestedPrIds.has(snapshot.prId))
      : requestedPrIds.size > 0
        ? args.prService.listSnapshots().filter((snapshot) => requestedPrIds.has(snapshot.prId))
        : args.prService.listSnapshots();
    return {
      refreshedCount,
      prs,
      snapshots,
    };
  });
  // iOS "Send to your Mac" deeplink bounce. Mobile cannot natively open a
  // lane / repo-branch / cross-repo PR deeplink, so it forwards the URL to
  // the paired desktop via this command. Desktop main.ts wires up
  // `dispatchDeeplinkUrl` to parse the URL and route through the renderer's
  // navigation service. In the ade-cli runtime (no desktop windows) the
  // handler returns a clear "not available" so the iOS caller can fall back.
  register("deeplinks.open", { viewerAllowed: true, queueable: false }, async (payload) => {
    const url = asTrimmedString(payload.url);
    if (!url) {
      throw new Error("deeplinks.open requires a url.");
    }
    const parsedDeeplink = parseDeeplink(url);
    if (!parsedDeeplink.ok) {
      throw new Error(`Invalid deeplink: ${formatDeeplinkParseError(parsedDeeplink.error)}`);
    }
    if (!args.dispatchDeeplinkUrl) {
      return {
        ok: false,
        message: "Desktop navigation is unavailable in this runtime.",
      };
    }
    return await args.dispatchDeeplinkUrl(url);
  });
  register("prs.getDetail", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getDetail(requirePrId(payload, "prs.getDetail")));
  register("prs.postReviewComment", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.postReviewComment(parsePostPrReviewCommentArgs(payload)));
  register("prs.getAiSummary", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prSummaryService?.getSummary(requirePrId(payload, "prs.getAiSummary")) ?? null);
  register("prs.regenerateAiSummary", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.prSummaryService, "PR summary service not available.").regenerateSummary(
      requirePrId(payload, "prs.regenerateAiSummary"),
    ));
  register("prs.getIntegrationResolutionState", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.getIntegrationResolutionState(
      requireString(payload.proposalId, "prs.getIntegrationResolutionState requires proposalId."),
    ));
  register("prs.delete", { viewerAllowed: false, queueable: true }, async (payload) =>
    args.prService.delete(parseDeletePrArgs(payload)));
  register("prs.cleanupBranch", { viewerAllowed: false, queueable: true }, async (payload) =>
    args.prService.cleanupBranch(parseCleanupPrBranchArgs(payload)));
  register("prs.listProposals", { viewerAllowed: true, observesAbort: true }, async () => args.prService.listIntegrationProposals());
  register("prs.getMergeContext", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.getMergeContext(requirePrId(payload, "prs.getMergeContext")));
  register("prs.getMergeContexts", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.getMergeContexts(asStringArray(payload.prIds)));
  register("prs.listWithConflicts", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.listWithConflicts({ includeConflictAnalysis: payload.includeConflictAnalysis === true }));
  register("prs.listSnapshots", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.listSnapshots({
      ...(asTrimmedString(payload.prId) ? { prId: asTrimmedString(payload.prId)! } : {}),
    }));
  register("prs.getStatus", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getStatus(requirePrId(payload, "prs.getStatus")));
  register("prs.getChecks", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getChecks(requirePrId(payload, "prs.getChecks")));
  register("prs.getReviews", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getReviews(requirePrId(payload, "prs.getReviews")));
  register("prs.getComments", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getComments(requirePrId(payload, "prs.getComments")));
  register("prs.getFiles", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getFiles(requirePrId(payload, "prs.getFiles")));
  register("prs.getGitHubSnapshot", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.getGithubSnapshot({
      force: payload.force === true,
      includeExternalClosed: payload.includeExternalClosed === true,
      revalidate: payload.revalidate !== false,
      includeStateCounts: payload.includeStateCounts === true,
      ...(typeof payload.historyPageLimit === "number" && Number.isFinite(payload.historyPageLimit)
        ? { historyPageLimit: Math.max(1, Math.floor(payload.historyPageLimit)) }
        : {}),
    }));
  register("prs.listGithubStacks", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.listGithubStacks(parseListGithubStacksArgs(payload, "prs.listGithubStacks")));
  register("prs.syncGithubStacks", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.syncGithubStacks(parseListGithubStacksArgs(payload, "prs.syncGithubStacks")));
  register("prs.getReviewThreads", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getReviewThreads(requirePrId(payload, "prs.getReviewThreads")));
  register("prs.getActionRuns", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getActionRuns(requirePrId(payload, "prs.getActionRuns")));
  register("prs.getActivity", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getActivity(requirePrId(payload, "prs.getActivity")));
  register("prs.getDeployments", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getDeployments(requirePrId(payload, "prs.getDeployments")));
  register("prs.getWorkflowGraph", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getWorkflowGraph({
    prId: requirePrId(payload, "prs.getWorkflowGraph"),
    force: payload.force === true,
  }));
  register("prs.getCheckLog", { viewerAllowed: true, observesAbort: true }, async (payload) => {
    const jobId = asOptionalNumber(payload.jobId);
    if (jobId == null || !Number.isInteger(jobId) || jobId <= 0) {
      throw new Error("prs.getCheckLog requires a positive integer jobId.");
    }
    const maxLines = asOptionalNumber(payload.maxLines);
    return args.prService.getCheckLog({
      prId: requirePrId(payload, "prs.getCheckLog"),
      jobId,
      ...(maxLines != null ? { maxLines } : {}),
    });
  });
  // Coordinate-based PR reads for PRs that are not mapped to an ADE lane (no DB
  // row). The preload sends these `*ByGithub` runtime actions before falling
  // back to IPC, so the socket runtime must register them alongside the
  // row-based reads. Args are GitHub coordinates: { repoOwner, repoName, githubPrNumber }.
  register("prs.getDetailByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getDetailByGithub(requirePrGithubCoords(payload, "prs.getDetailByGithub")));
  register("prs.getFilesByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getFilesByGithub(requirePrGithubCoords(payload, "prs.getFilesByGithub")));
  register("prs.getCommitsByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getCommitsByGithub(requirePrGithubCoords(payload, "prs.getCommitsByGithub")));
  register("prs.getActionRunsByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getActionRunsByGithub(requirePrGithubCoords(payload, "prs.getActionRunsByGithub")));
  register("prs.getActivityByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getActivityByGithub(requirePrGithubCoords(payload, "prs.getActivityByGithub")));
  register("prs.getStatusByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getStatusByGithub(requirePrGithubCoords(payload, "prs.getStatusByGithub")));
  register("prs.getChecksByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getChecksByGithub(requirePrGithubCoords(payload, "prs.getChecksByGithub")));
  register("prs.getReviewsByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getReviewsByGithub(requirePrGithubCoords(payload, "prs.getReviewsByGithub")));
  register("prs.getCommentsByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getCommentsByGithub(requirePrGithubCoords(payload, "prs.getCommentsByGithub")));
  register("prs.getReviewThreadsByGithub", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.getReviewThreadsByGithub(requirePrGithubCoords(payload, "prs.getReviewThreadsByGithub")));
  register("prs.getMobileGithubDetail", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.getMobileGithubDetail(requirePrGithubCoords(payload, "prs.getMobileGithubDetail")));
  register("prs.createFromLane", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.createFromLane(parseCreatePrArgs(payload)));
  register("prs.createGithubStack", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.createGithubStack(parseCreateGithubStackArgs(payload)));
  register("prs.addGithubStackPullRequests", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.addGithubStackPullRequests(parseAddGithubStackPullRequestsArgs(payload)));
  register("prs.unstackGithubStack", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.unstackGithubStack(parseUnstackGithubStackArgs(payload)));
  register("prs.linkToLane", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.linkToLane(parseLinkPrToLaneArgs(payload)));
  register("prs.preflightCreateLaneFromPrBranch", { viewerAllowed: true, observesAbort: true }, async (payload) => args.prService.preflightCreateLaneFromPrBranch(parseCreateLaneFromPrBranchArgs(payload)));
  register("prs.createLaneFromPrBranch", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.createLaneFromPrBranch(parseCreateLaneFromPrBranchArgs(payload)));
  register("prs.draftDescription", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.draftDescription(parseDraftPrDescriptionArgs(payload)));
  register("prs.land", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.land(parseLandPrArgs(payload)));
  register("prs.updateBranch", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.updateBranch(parseUpdateBranchArgs(payload)));
  register("prs.close", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.closePr(parseClosePrArgs(payload));
    return { ok: true };
  });
  register("prs.reopen", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.reopenPr(parseReopenPrArgs(payload));
    return { ok: true };
  });
  register("prs.requestReviewers", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.requestReviewers(parseRequestReviewersArgs(payload));
    return { ok: true };
  });
  register("prs.rerunChecks", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.rerunChecks(parseRerunPrChecksArgs(payload));
    return { ok: true };
  });
  register("prs.addComment", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.addComment(parseAddPrCommentArgs(payload)));
  register("prs.updateTitle", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.updateTitle(parseUpdatePrTitleArgs(payload));
    return { ok: true };
  });
  register("prs.updateBody", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.updateBody(parseUpdatePrBodyArgs(payload));
    return { ok: true };
  });
  register("prs.setLabels", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.setLabels(parseSetPrLabelsArgs(payload));
    return { ok: true };
  });
  register("prs.submitReview", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.submitReview(parseSubmitPrReviewArgs(payload));
    return { ok: true };
  });
  register("prs.replyToReviewThread", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.replyToReviewThread(parseReplyToReviewThreadArgs(payload)));
  register("prs.setReviewThreadResolved", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.setReviewThreadResolved(parseSetReviewThreadResolvedArgs(payload)));
  register("prs.reactToComment", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.reactToComment(parseReactToCommentArgs(payload));
    return { ok: true };
  });
  register("prs.aiReviewSummary", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.aiReviewSummary(parseAiReviewSummaryArgs(payload)));
  register("prs.simulateIntegration", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.simulateIntegration(parseSimulateIntegrationArgs(payload)));
  register("prs.commitIntegration", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.commitIntegration(parseCommitIntegrationArgs(payload)));
  register("prs.listIntegrationWorkflows", { viewerAllowed: true, observesAbort: true }, async (payload) =>
    args.prService.listIntegrationWorkflows(parseListIntegrationWorkflowsArgs(payload)));
  register("prs.updateIntegrationProposal", { viewerAllowed: true, queueable: true }, async (payload) => {
    args.prService.updateIntegrationProposal(parseUpdateIntegrationProposalArgs(payload));
    return { ok: true };
  });
  register("prs.deleteIntegrationProposal", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.deleteIntegrationProposal(parseDeleteIntegrationProposalArgs(payload)));
  register("prs.dismissIntegrationCleanup", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.dismissIntegrationCleanup(parseDismissIntegrationCleanupArgs(payload)));
  register("prs.cleanupIntegrationWorkflow", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.cleanupIntegrationWorkflow(parseCleanupIntegrationWorkflowArgs(payload)));
  register("prs.createIntegrationLaneForProposal", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.createIntegrationLaneForProposal(parseCreateIntegrationLaneForProposalArgs(payload)));
  register("prs.startIntegrationResolution", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.startIntegrationResolution(parseStartIntegrationResolutionArgs(payload)));
  const prAiState: PrAiRuntimeState = {
    sessions: new Map(),
    sessionsByContextKey: new Map(),
  };
  register("prs.aiResolutionGetSession", { viewerAllowed: true }, async (payload) =>
    getRemotePrAiResolutionSession(args, prAiState, payload));
  register("prs.aiResolutionStart", { viewerAllowed: true }, async (payload) =>
    startRemotePrAiResolution(args, prAiState, payload));
  register("prs.recheckIntegrationStep", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.recheckIntegrationStep(parseRecheckIntegrationStepArgs(payload)));
  register("prs.getMobileSnapshot", { viewerAllowed: true, observesAbort: true }, async () => args.prService.getMobileSnapshot());
}

export function createSyncRemoteCommandService(args: SyncRemoteCommandServiceArgs) {
  const registry = new Map<SyncRemoteCommandAction, RegisteredRemoteCommand>();

  const register = (
    action: SyncRemoteCommandAction,
    policy: RemoteCommandRegistrationPolicy,
    handler: (
      payload: Record<string, unknown>,
      context: SyncRemoteCommandExecutionContext,
    ) => Promise<unknown>,
    scope: SyncRemoteCommandDescriptor["scope"] = "project",
  ) => {
    const { observesAbort = false, ...descriptorPolicy } = policy;
    registry.set(action, {
      descriptor: { action, scope, policy: descriptorPolicy },
      observesAbort,
      handler,
    });
  };

  register("analytics.capture", { viewerAllowed: true }, async (payload) => {
    if (!args.productAnalyticsService) {
      return { accepted: false, reason: "not_configured" };
    }
    const parsed = parseProductAnalyticsCapture(payload);
    if (!parsed.ok) return { accepted: false, reason: parsed.reason };
    return args.productAnalyticsService.capture(parsed.value);
  }, "runtime");

  register("analytics.flush", { viewerAllowed: true }, async () =>
    args.productAnalyticsService ? await args.productAnalyticsService.flush() : false,
  "runtime");

  register("analytics.getStatus", { viewerAllowed: true }, async () =>
    args.productAnalyticsService?.getStatus() ?? {
      configured: false,
      enabled: true,
      effective: false,
      host: "not_configured",
      dailyBudget: 200,
      acceptedToday: 0,
      droppedToday: 0,
      day: new Date().toISOString().slice(0, 10),
    }, "runtime");

  // Consent for a paired browser/phone is peer-scoped by SyncHostService.
  // This handler intentionally never changes the machine-wide preference.
  register("analytics.setClientEnabled", { viewerAllowed: true }, async (payload) => {
    if (typeof payload.enabled !== "boolean") {
      throw new Error("analytics.setClientEnabled requires a boolean enabled value.");
    }
    return args.productAnalyticsService?.getStatus() ?? {
      configured: false,
      enabled: true,
      effective: false,
      host: "not_configured",
      dailyBudget: 200,
      acceptedToday: 0,
      droppedToday: 0,
      day: new Date().toISOString().slice(0, 10),
    };
  }, "runtime");

  register("usage.getAdeStats", { viewerAllowed: true }, async (payload) => {
    if (!args.usageTrackingService) throw new Error("Usage stats are not available in this runtime.");
    const preset = asTrimmedString(payload.preset);
    if (preset && !isAdeUsageRangePreset(preset)) {
      throw new Error("usage.getAdeStats preset must be today, 7d, 30d, year, or all.");
    }
    const scope = asTrimmedString(payload.scope);
    if (scope && !isAdeUsageScope(scope)) {
      throw new Error("usage.getAdeStats scope must be machine or project.");
    }
    const since = asTrimmedString(payload.since);
    if (since && Number.isNaN(Date.parse(since))) {
      throw new Error("usage.getAdeStats since must be an ISO timestamp.");
    }
    const until = asTrimmedString(payload.until);
    if (until && Number.isNaN(Date.parse(until))) {
      throw new Error("usage.getAdeStats until must be an ISO timestamp.");
    }
    return await args.usageTrackingService.getAdeUsageStats({
      ...(isAdeUsageRangePreset(preset) ? { preset } : {}),
      ...(isAdeUsageScope(scope) ? { scope } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    });
  });

  register("usage.getQuotaSnapshot", { viewerAllowed: true }, async () => {
    if (!args.usageTrackingService) throw new Error("Usage quota is not available in this runtime.");
    return args.usageTrackingService.getUsageSnapshot();
  }, "runtime");

  register("usage.refreshQuota", { viewerAllowed: true }, async () => {
    if (!args.usageTrackingService) throw new Error("Usage quota is not available in this runtime.");
    return await args.usageTrackingService.forceRefresh({ allowInteractiveAuth: false });
  }, "runtime");

  registerLaneRemoteCommands({ args, register });
  registerWorkRemoteCommands({ args, register });
  registerChatRemoteCommands({ args, register });
  registerPersonalChatRemoteCommands({ args, register });
  registerModelPickerRemoteCommands({ args, register });
  registerPushRemoteCommands({ args, register });
  registerSyncRemoteCommands({ args, register });
  registerCtoRemoteCommands({ args, register });
  registerGitAndFileRemoteCommands({ args, register });
  registerTerminalRemoteCommands({ args, register });
  registerConflictRemoteCommands({ args, register });
  registerMiscRemoteCommands({ args, register });
  registerPrAndDeeplinkRemoteCommands({ args, register });
  return {
    getSupportedActions(): SyncRemoteCommandAction[] {
      return [...registry.keys()];
    },

    getDescriptors(): SyncRemoteCommandDescriptor[] {
      return [...registry.values()].map((entry) => entry.descriptor);
    },

    getAbortObservingActions(): SyncRemoteCommandAction[] {
      return [...registry.values()]
        .filter((entry) => entry.observesAbort)
        .map((entry) => entry.descriptor.action as SyncRemoteCommandAction);
    },

    getPolicy(action: string): SyncRemoteCommandPolicy | null {
      return registry.get(action as SyncRemoteCommandAction)?.descriptor.policy ?? null;
    },

    getDescriptor(action: string): SyncRemoteCommandDescriptor | null {
      return registry.get(action as SyncRemoteCommandAction)?.descriptor ?? null;
    },

    async execute(
      payload: SyncCommandPayload,
      context: SyncRemoteCommandExecutionContext = {},
    ): Promise<unknown> {
      const handler = registry.get(payload.action as SyncRemoteCommandAction);
      if (!handler) {
        throw new Error(`Unsupported remote command: ${payload.action}`);
      }
      const commandArgs = isRecord(payload.args) ? payload.args : {};
      args.logger.debug?.("sync.remote_command.execute", {
        action: payload.action,
        scope: handler.descriptor.scope,
        policy: handler.descriptor.policy,
      });
      const run = () => handler.handler(commandArgs, context);
      return handler.observesAbort
        ? await runWithAbortSignal(
            run,
            context.signal,
            "Remote command aborted.",
          )
        : await run();
    },
  };
}

export type SyncRemoteCommandService = ReturnType<typeof createSyncRemoteCommandService>;
