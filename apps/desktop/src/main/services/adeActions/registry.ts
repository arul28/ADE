import { normalizeCompactionSettings } from "../../../shared/compactionSettings";
import { AdeExpectedError } from "../../../shared/expectedError";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitHubIssueCreateInput, parseGitHubIssueUpdate } from "../../../shared/laneGitHubIssue";
import { parseGitHubIssueListState } from "../../../shared/githubIssueList";
import { readImageFileAsDataUrl } from "../chat/imageAttachmentConverter";
import { createHash } from "node:crypto";
import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { ingestSceneSnapshot } from "../scenes/sceneSnapshotIngest";
import {
  addOpenCodeOAuthStatusListener,
  cancelOAuth as cancelOpenCodeOAuth,
  clearProviderKey as clearOpenCodeProviderKey,
  listAuthMethods as listOpenCodeAuthMethods,
  setProviderKey as setOpenCodeProviderKey,
  startOAuth as startOpenCodeOAuth,
  type OpenCodeAuthDeps,
} from "../opencode/openCodeAuthService";
import {
  activateOpenCodeAccount,
  connectOpenCodeCloudLogin,
  listOpenCodeAccounts,
  removeOpenCodeAccount,
  renameOpenCodeAccount,
} from "../opencode/openCodeAccounts";
import {
  addPiAuthStatusListener,
  cancelPiLogin,
  listPiLoginProviders,
  startPiLogin,
  submitPiLoginPrompt,
} from "../ai/piAuthService";
import {
  addCursorSdkAuthStatusListener,
  cancelCursorSdkLogin,
  getCursorSdkAuthStatus,
  loginCursorSdk,
  logoutCursorSdk,
} from "../ai/cursorSdkAuth";
import {
  getApiCredentialSummary,
  listApiCredentials,
  removeApiCredential,
  storeApiCredential,
} from "../ai/apiKeyStore";
import type { ApiCredentialStoreArgs } from "../../../shared/types/apiCredentials";
import type { JevDecideRequest } from "../../../shared/types/jev";
import { readTerminalListWatchesArgs, readTerminalUnwatchArgs, readTerminalWatchArgs } from "../../../shared/terminalWatch";
import type {
  AntigravitySignInCancelArgs,
  AntigravitySignInCompleteArgs,
  AntigravitySignInStartArgs,
} from "../../../shared/types/config";
import { getLastFetchedAt as getModelsDevLastFetchedAt, refreshNow as refreshModelsDevNow } from "../ai/modelsDevService";
import { buildHarnessLaunchEnv, listHarnessRouteCatalog } from "../chat/harnessRouteCatalog";
import { testHarnessRoute } from "../chat/harnessRouteTest";
import { resolveHarnessPresetForLaunch } from "../chat/harnessPresetLaunch";
import { prepareHarnessLaunch } from "../chat/harnessLaunchPrepare";
import { isHarnessPresetBody } from "../../../shared/harnessPresets";
import {
  BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import type {
  AutomationManualTriggerRequest,
  AutomationTestCleanupResult,
  AutomationTestPlan,
  AutomationTestRequest,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
  AutomationRuleSummary,
  AutomationScheduledCleanup,
  AutomationWebhookTestRequest,
  AutomationWebhookEndpoint,
  AutomationWebhookDeliverySummary,
  AutomationWebhookDelivery,
  AutomationWebhookTestResult,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
} from "../../../shared/types/automations";
import {
  CUSTOM_NOTIFICATION_HOURLY_LIMIT,
  customNotificationProblem,
  type AttentionPreferenceScope,
  type AttentionPreferences,
  type AttentionPresence,
} from "../../../shared/types/attention";
import { normalizeCustomNotificationLink } from "../../../shared/customNotificationLink";
import { deriveProjectId } from "../../../../../ade-cli/src/services/projects/projectRegistry";
import { remoteMcpActionHandlers } from "../../../../../ade-cli/src/services/remoteMcp/remoteMcpService";
import { REMOTE_MCP_SETTINGS_PREFIX } from "../../../../../ade-cli/src/services/remoteMcp/remoteMcpAccount";
import { REMOTE_MCP_VAULT_KIND } from "../../../../../ade-cli/src/services/remoteMcp/remoteMcpStore";
import {
  PushRelayNotifyRateLimitedError,
  PushRelayRequestError,
} from "../../../../../ade-cli/src/services/push/pushRelayClient";
import type { ComputerUseOwnerSnapshotArgs } from "../../../shared/types/computerUseArtifacts";
import { buildMacDesktopDomainService } from "../macDesktop/macDesktopActionDomain";
import { normalizeExternalSessionDetailArgs } from "../externalSessions/externalSessionDetail";
import type {
  ChatMentionSuggestArgs,
  ChatMentionSuggestResult,
} from "../../../shared/types/chatMentions";
import type {
  AdeChatSessionSummaryActionResult,
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  AgentChatGetTurnFileDiffArgs,
  AgentChatLaunchCliArgs,
  AgentChatLaunchCliResult,
  AgentChatParallelLaunchState,
  AgentChatSetParallelLaunchStateArgs,
  AgentChatTurnFileDiff,
  DraftClaimArgs,
  DraftCreateArgs,
  DraftDeleteArgs,
  DraftGetArgs,
  DraftUpdateArgs,
} from "../../../shared/types/chat";
import type { AutomationRule } from "../../../shared/types/config";
import { isAcpChatProvider } from "../../../shared/types/chat";
import { collectAcpProviderDiagnostics } from "../ai/acpProviderDiagnostics";
import { stripHostOnlyChatMetadata } from "../../../shared/chatAutoResume";
import { areAutomationsEnabledForPackagedState } from "../../../shared/automationAvailability";
import type { LinearIngressStatus } from "../automations/linearIngressService";
import type { AutomationWebhookTriggerConfig } from "../../../shared/types/config";
import {
  buildWebhookAutomationDraft,
  listWebhookAutomations,
  webhookSetupGuide,
  webhookTriggersOf,
  type WebhookAutomationCreateArgs,
  listProjectSecretNames,
  type WebhookSetupGuide,
} from "../automations/webhookAutomationFactory";
import { defaultAutomationChatModelId } from "../automations/automationService";
import type { AutomationWebhookListEntry, SessionAttentionSource } from "../../../shared/types";
import { isTrackedAgentCliToolType } from "../../../shared/types";
import {
  claimDraft,
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  updateDraft,
} from "../chat/draftService";
import type {
  AiConfig,
  AcknowledgeLaneDependencyStatusArgs,
  ApplyLaneTemplateArgs,
  GetLaneDependencyStatusArgs,
  LaneDependencyStatus,
  ArchiveAndReclaimLaneArgs,
  DeleteLaneArgs,
  DeleteLaneResult,
  FileChangeEvent,
  LaneEnvInitProgress,
  LaneListSnapshot,
  LanePreviewInfo,
  ListSessionsArgs,
  ListLanesArgs,
  UpdateSessionMetaArgs,
  ReadTranscriptTailArgs,
  ProxyStatus,
  AiFeatureKey,
  AiSettingsStatus,
  CtoAttentionState,
  CtoRunProjectScanResult,
  CursorCloudServiceTier,
  CtoStartFreshSessionResult,
  CtoThreadHealth,
  CtoLinearQuickView,
  LinearConnectionStatus,
} from "../../../shared/types";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  legacyAttachmentCapMessage,
  maxBase64EncodedLength,
} from "../../../shared/chatAttachmentLimits";
import {
  projectAttachmentsDir,
  stageAttachmentBytes,
  stageAttachmentCopy,
} from "../../../shared/chatAttachmentStagingFs";
import {
  buildLaneEnvTeardown,
  ensureActiveLanePortLease,
  releaseLaneRuntimeResources,
  restoreUnarchivedLaneRuntime,
} from "../lanes/laneRuntimeLifecycle";
import { createArchiveService } from "../archive/archiveService";
import { runLaneEnvironmentSetup, type LaneEnvironmentSetupDeps } from "../lanes/laneEnvironmentSetup";
import {
  acknowledgeLaneDependencyStatus,
  readLaneDependencyStatus,
  type LaneDependencyStatusDeps,
} from "../lanes/laneDependencyStatus";
import {
  parseChatLaunchArgs,
  parseChatLaunchCompleteClientArgs,
  parseChatLaunchIdArgs,
  parseChatLaunchQueueMessageArgs,
} from "../chat/chatLaunchArgs";
import { resolveLaneOverlayContext } from "../lanes/laneOverlayContext";
import { appendDiffTruncationNotice, MAX_DIFF_SIDE_TEXT_BYTES } from "../diffs/diffService";
import { isPathInside } from "../shared/pathCompare";
import { getMachineProviderInstanceStore, resolveChatInstanceId } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { isProviderInstanceProvider } from "../../../shared/types/providerInstances";
import { buildUsageLimitsReport } from "../../../shared/usageLimitsReport";
import { runGit } from "../git/git";
// The turn diff is shared with the local ipcMain handler; see chat/turnFileDiff.ts.
export { getTurnFileDiffFromGit } from "../chat/turnFileDiff";
import { getTurnFileDiffFromGit } from "../chat/turnFileDiff";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import { buildLaneListSnapshots } from "../lanes/laneListSnapshotService";
import { getErrorMessage, isRecord, nowIso, resolveWithinAllowedRoots } from "../shared/utils";
import { parseLinearGraphQLInput } from "../cto/linearGraphQLInput";
import type { CtoMemoryTags } from "../cto/ctoMemoryService";
import { launchAgentChatCli } from "../chat/agentChatCliLaunch";
import { getSourceFaviconService, type ResolveSourceFaviconsArgs } from "../chat/sourceFaviconService";
import { resolveSmartLinkImage } from "../chat/smartLinkPreviewService";
import { assertCursorCloudRenameAllowed } from "../../../shared/cursorCloudNaming";
import { deleteTerminalSessionWithRuntimeCleanup } from "../sessions/deleteTerminalSession";
import { getMachineProviderLoginRunner } from "../providerAccounts/machineProviderLoginRunner";
import { refreshProviderAccounts } from "../providerAccounts/refreshProviderAccounts";
import { removeProviderAccount, signOutProviderAccount } from "../providerAccounts/signOutProviderAccount";
import { settleTerminalSession } from "../sessions/settleTerminalSession";
import {
  getSessionLifecycleSettings,
  setSessionLifecycleSettings,
} from "../sessions/sessionLifecycleSettings";
import {
  getSessionWithChatProjection,
  listSessionsWithChatProjection,
} from "../sessions/chatSessionProjection";
import { createAccountActionDomainService } from "../../../../../ade-cli/src/services/account/accountAuthService";
import { createProxyActionDomainService } from "../../../../../ade-cli/src/services/proxy/proxyService";
import {
  captureSecretRequestedAnalytics,
  captureNotificationSentAnalytics,
  captureWebhookUrlCreatedAnalytics,
  captureAutomationTestAnalytics,
  captureProviderAccountSettingsChange,
  providerAccountAnalyticsCapture,
} from "../analytics/featureProductAnalytics";

// The names themselves live in `./domains`, which has no imports, so consumers
// that need only the vocabulary (the analytics policy) do not have to load this
// module's whole service graph to get it. Re-exported here because this is
// where every existing caller looks for them.
import type { AdeActionDomain } from "./domains";
import { ADE_ACTION_ALLOWLIST, isAutomationAllowedAdeAction } from "./actionPolicy";
import type { AutomationAdeActionRegistry } from "../automations/automationService";
import {
  asActionRecord,
  optionalNonEmptyString,
  readBranchDriftResolution,
  readChatHistoryActionArgs,
  readObjectActionArg,
  readOptionalIntegerActionField,
  readRuntimeFileWatchSenderId,
  readSessionIdList,
  readSettleOverride,
  readStringActionArg,
  readWakeReason,
  requireCloudAgentProvider,
  requireNonEmptyString,
  requireSnoozeDeadline,
  toRuntimeFileWatchArgs,
} from "./actionArgs";
import { createSessionBoardMoveActions } from "./sessionBoardMove";
import { noteSessionInputOrigin } from "../chat/sessionInputOrigins";
import { requestProjectSecretFromUser } from "../secrets/projectSecretRequest";
import { machineSecretTempFiles } from "../secrets/secretTempFiles";
import { isClaudePromptCacheTtl } from "../../../shared/claudePromptCache";

export { ADE_ACTION_DOMAIN_NAMES } from "./domains";
export type { AdeActionDomain } from "./domains";

/* Policy (who may call what) and the documented input shapes both live in
   siblings now: they are pure data with no runtime dependency, and 1,200 lines
   of table in the middle of the registry buried the wiring it exists for.
   The gate's PREDICATES moved with the tables they read, for the same reason.
   Re-exported here so every existing call site keeps its import. */
export {
  ADE_ACTION_ALLOWLIST,
  ADE_ACTION_CTO_ONLY,
  callerHasRoleAtLeast,
  isAllowedAdeAction,
  isAutomationAllowedAdeAction,
  isCtoOnlyAdeAction,
  isSecretBearingAdeAction,
  isUserOnlyAdeAction,
  listAllowedAdeActionNames,
  scopeAccountStatusForRole,
  userSettingWrite,
} from "./actionPolicy";
export type { AdeActionRole, CtoOnlyRule } from "./actionPolicy";
export {
  getAdeActionInputContract,
} from "./actionInputContracts";
export type { AdeActionInputContract } from "./actionInputContracts";

/* The `unknown -> typed` argument readers moved to `./actionArgs` with the two
   that were already there — one answer to "how does an action read its input",
   rather than a boundary drawn around whichever two a sibling happened to need.
   Not re-exported: nothing outside this file ever imported them (they were
   module-private here), and a pass-through would be a second import path for
   values that already have one. */

/* The Work-board drag lives in `./sessionBoardMove`: it owns module-level
   mutable state with live timers, which does not belong inside a registry of
   stateless domain services. Only the two names callers reach for through the
   registry are re-exported — the sync command table's builder and the quit
   drain `main.ts` runs. Everything else (the texts, the staging-map test seams,
   the move-target vocabulary) is imported from `./sessionBoardMove` or
   `shared/types/chat` directly, and a pass-through here would be a second
   import path for values that already have one. */
export { createSessionBoardMoveActions, flushStagedBoardMoves } from "./sessionBoardMove";

/**
 * Caller-supplied chat metadata, minus the keys only the host may set.
 *
 * `scheduledWake` and `usageLimitResume: "manual"` each exempt their message
 * from the auto-resume cancel sweep. That exemption is the host telling itself
 * "I already dealt with the row"; an action caller saying it is just a message
 * that leaves the chat's resume armed through real activity, to fire
 * unattended later. The host's own paths build their metadata internally and
 * never come through here.
 */
function withoutHostOnlyChatMetadata(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return record;
  const { metadata: _hostOnlyStripped, ...rest } = record;
  const stripped = stripHostOnlyChatMetadata(metadata as Record<string, unknown>);
  return stripped ? { ...rest, metadata: stripped } : rest;
}

type AutomationsDomainService = {
  list(): AutomationRuleSummary[];
  get(args: { id: string }): AutomationRule | null;
  saveRule(args: AutomationSaveDraftRequest): AutomationSaveDraftResult;
  deleteRule(args: { id: string }): AutomationRuleSummary[];
  toggleRule(args: { id: string; enabled: boolean }): AutomationRuleSummary[];
  triggerManually(args: AutomationManualTriggerRequest): Promise<AutomationRun>;
  planTest(args: AutomationTestRequest): Promise<AutomationTestPlan>;
  runTest(args: AutomationTestRequest): Promise<AutomationRun>;
  cleanUpTestRun(args: { runId: string }): Promise<AutomationTestCleanupResult>;
  getHistory(args: { id: string; limit?: number }): AutomationRun[];
  listRuns(args?: AutomationRunListArgs): AutomationRun[];
  getRunDetail(args: { runId: string }): Promise<AutomationRunDetail | null>;
  getIngressStatus(): AutomationIngressStatus;
  startIngress(): Promise<AutomationIngressStatus>;
  refreshWebhookGatewayStatus(): Promise<AutomationIngressStatus["webhookGateway"]>;
  setWebhookGatewayPublicUrl(args?: { publicUrl?: string | null }): Promise<AutomationIngressStatus["webhookGateway"]>;
  listIngressEvents(args?: { limit?: number }): AutomationIngressEventRecord[];
  listScheduledCleanups(): AutomationScheduledCleanup[];
  cancelScheduledCleanup(args: { id: string }): boolean;
  linearIngressGetStatus(): LinearIngressStatus;
  linearIngressSetup(): Promise<LinearIngressStatus>;
  linearIngressTeardown(): Promise<LinearIngressStatus>;
  linearIngressPollNow(): Promise<LinearIngressStatus>;
  webhookCreateEndpoint(args?: { label?: string | null }): Promise<AutomationWebhookEndpoint>;
  webhookGetEndpoint(args: { hookId: string }): Promise<AutomationWebhookEndpoint>;
  webhookRotateEndpoint(args: { hookId: string }): Promise<AutomationWebhookEndpoint>;
  webhookListDeliveries(args: { hookId: string; limit?: number }): AutomationWebhookDeliverySummary[];
  webhookGetDelivery(args: { id: string }): AutomationWebhookDelivery | null;
  webhookReplayDelivery(args: { id: string }): Promise<AutomationWebhookDeliverySummary | null>;
  webhookSendTest(args: AutomationWebhookTestRequest & { config?: AutomationWebhookTriggerConfig | null }): Promise<AutomationWebhookTestResult>;
  webhookCreateAutomation(args: WebhookAutomationCreateArgs & { callerChatSessionId?: string | null }): Promise<{
    rule: AutomationRuleSummary | null;
    hookId: string;
    setup: WebhookSetupGuide;
  }>;
  webhookList(): Promise<AutomationWebhookListEntry[]>;
  webhookRetire(args: { hookId: string }): Promise<{ hookId: string; retired: boolean; stillUsedBy: string[] }>;
};

function requireWebhooks(runtime: AdeRuntime) {
  if (!runtime.automationIngressService) throw new Error("Automation ingress service is not available.");
  return runtime.automationIngressService.webhooks;
}

function buildAutomationsDomainService(runtime: AdeRuntime): AutomationsDomainService | null {
  const automationService = runtime.automationService;
  const plannerService = runtime.automationPlannerService;
  const projectConfigService = runtime.projectConfigService;
  if (!automationService || !plannerService || !projectConfigService) return null;
  return {
    list: () => automationService.list(),
    get: ({ id }) => {
      const trimmed = id?.trim();
      if (!trimmed) return null;
      return projectConfigService.get().effective.automations.find((r) => r.id === trimmed) ?? null;
    },
    saveRule: (args) => plannerService.saveDraft(args),
    deleteRule: ({ id }) => automationService.deleteRule({ id }),
    toggleRule: ({ id, enabled }) => automationService.toggle({ id, enabled }),
    triggerManually: (args) => automationService.triggerManually(args),
    planTest: (args) => automationService.planTest(args),
    runTest: async (args) => {
      const mode = args?.mode === "live" ? "live" : "safe";
      try {
        const run = await automationService.runTest(args);
        captureAutomationTestAnalytics({ analytics: runtime.productAnalyticsService, surface: "api", mode, outcome: "completed" });
        return run;
      } catch (error) {
        captureAutomationTestAnalytics({ analytics: runtime.productAnalyticsService, surface: "api", mode, outcome: "failed" });
        throw error;
      }
    },
    cleanUpTestRun: (args) => automationService.cleanUpTestRun(args),
    getHistory: (args) => automationService.getHistory(args),
    listRuns: (args = {}) => automationService.listRuns(args),
    getRunDetail: ({ runId }) => automationService.getRunDetail({ runId }),
    getIngressStatus: () => automationService.getIngressStatus(),
    startIngress: async () => {
      if (!runtime.automationIngressService) throw new Error("Automation ingress service is not available.");
      await runtime.automationIngressService.start();
      return automationService.getIngressStatus();
    },
    refreshWebhookGatewayStatus: () => automationService.refreshWebhookGatewayStatus(),
    setWebhookGatewayPublicUrl: (args = {}) => automationService.setWebhookGatewayPublicUrl(args),
    listIngressEvents: (args = {}) => automationService.listIngressEvents(args.limit),
    listScheduledCleanups: () => automationService.listScheduledCleanups(),
    cancelScheduledCleanup: ({ id }) => automationService.cancelScheduledCleanup(id),
    linearIngressGetStatus: () => requireLinearIngress(runtime).getStatus(),
    linearIngressSetup: () => requireLinearIngress(runtime).setup(),
    linearIngressTeardown: () => requireLinearIngress(runtime).teardown(),
    linearIngressPollNow: async () => {
      const service = requireLinearIngress(runtime);
      await service.pollNow();
      return service.getStatus();
    },
    webhookCreateEndpoint: async (args = {}) => {
      const endpoint = await requireWebhooks(runtime).createEndpoint(args);
      captureWebhookUrlCreatedAnalytics({ analytics: runtime.productAnalyticsService, surface: "api" });
      return endpoint;
    },
    webhookGetEndpoint: (args) => requireWebhooks(runtime).getEndpoint(args),
    webhookRotateEndpoint: (args) => requireWebhooks(runtime).rotateEndpoint(args),
    webhookListDeliveries: (args) => requireWebhooks(runtime).listDeliveries(args),
    webhookGetDelivery: (args) => requireWebhooks(runtime).getDelivery(args),
    webhookReplayDelivery: (args) => requireWebhooks(runtime).replayDelivery(args),
    webhookSendTest: (args) => requireWebhooks(runtime).sendTest(args),
    webhookCreateAutomation: async (args) => {
      const webhooks = requireWebhooks(runtime);
      const endpoint = await webhooks.createEndpoint({ label: args.name ?? null });
      captureWebhookUrlCreatedAnalytics({ analytics: runtime.productAnalyticsService, surface: "api" });
      const draft = buildWebhookAutomationDraft({
        ...args,
        // A chat creating the rule is its origin; "this chat" is the caller's own chat.
        originChatSessionId: args.originChatSessionId ?? args.callerChatSessionId ?? null,
        hookId: endpoint.hookId,
        // The same default a new automation gets in the builder.
        defaultModelId: defaultAutomationChatModelId(),
      });
      let saved: AutomationSaveDraftResult;
      try {
        saved = plannerService.saveDraft({ draft, confirmations: args.confirmations ?? [] });
      } catch (error) {
        // Nothing saved: the URL must not linger as an orphan.
        await webhooks.retireEndpoint(endpoint.hookId).catch(() => false);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`The webhook automation was not saved: ${message}`);
      }
      // The rule and URL exist from here on, so describing them must not fail
      // the call: a retry would make a second of each. The URL read back falls
      // back to the one just made, and the trigger to the draft's.
      const trigger = webhookTriggersOf(saved.rule)[0] ?? webhookTriggersOf(draft)[0]!;
      const secretName = trigger.signature?.secretName ?? null;
      return {
        rule: automationService.list().find((rule) => rule.id === saved.rule!.id) ?? null,
        hookId: endpoint.hookId,
        setup: webhookSetupGuide({
          endpoint: await webhooks.getEndpoint({ hookId: endpoint.hookId }).catch(() => endpoint),
          trigger,
          secretSaved: Boolean(secretName && listProjectSecretNames(runtime.projectSecretService).has(secretName)),
        }),
      };
    },
    webhookList: async () => {
      const webhooks = requireWebhooks(runtime);
      return await listWebhookAutomations({
        rules: automationService.list(),
        webhooks,
        projectSecrets: runtime.projectSecretService,
      });
    },
    webhookRetire: async ({ hookId }) => {
      const id = hookId?.trim();
      if (!id) throw new Error("hookId is required (wh-…).");
      const stillUsedBy = automationService.list()
        .filter((rule) => webhookTriggersOf(rule).some((trigger) => trigger.hookId === id))
        .map((rule) => rule.name);
      if (stillUsedBy.length) {
        throw new Error(`Still used by ${stillUsedBy.join(", ")}. Delete or change that automation first; deleting it retires the URL.`);
      }
      return { hookId: id, retired: await requireWebhooks(runtime).retireEndpoint(id), stillUsedBy };
    },
  };
}

function requireLinearIngress(runtime: AdeRuntime): NonNullable<AdeRuntime["linearIngressService"]> {
  const service = runtime.linearIngressService;
  if (!service) throw new Error("Linear ingress is not available on this runtime.");
  return service;
}

type IssueDomainService = {
  addComment(args: { owner?: string; name?: string; number: number; body: string }): Promise<unknown>;
  setLabels(args: { owner?: string; name?: string; number: number; labels: string[] }): Promise<unknown>;
  close(args: { owner?: string; name?: string; number: number; reason?: "completed" | "not_planned" }): Promise<unknown>;
  reopen(args: { owner?: string; name?: string; number: number }): Promise<unknown>;
  assign(args: { owner?: string; name?: string; number: number; assignees: string[] }): Promise<unknown>;
  setTitle(args: { owner?: string; name?: string; number: number; title: string }): Promise<unknown>;
};

function buildIssueDomainService(runtime: AdeRuntime): IssueDomainService | null {
  const githubService = runtime.githubService;
  if (!githubService) return null;

  const resolveRepo = async (owner?: string, name?: string): Promise<{ owner: string; name: string }> => {
    if (owner && name) return { owner, name };
    const repo = await githubService.detectRepo();
    if (!repo) throw new Error("Unable to detect GitHub repo; pass owner/name explicitly.");
    return { owner: repo.owner, name: repo.name };
  };

  return {
    addComment: async ({ owner, name, number, body }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.addIssueComment(repo.owner, repo.name, number, body);
    },
    setLabels: async ({ owner, name, number, labels }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.setIssueLabels(repo.owner, repo.name, number, labels);
    },
    close: async ({ owner, name, number, reason }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.closeIssue(repo.owner, repo.name, number, reason);
    },
    reopen: async ({ owner, name, number }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.reopenIssue(repo.owner, repo.name, number);
    },
    assign: async ({ owner, name, number, assignees }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.assignIssue(repo.owner, repo.name, number, assignees);
    },
    setTitle: async ({ owner, name, number, title }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.setIssueTitle(repo.owner, repo.name, number, title);
    },
  };
}

type OpaqueService = Record<string, unknown>;

function toService(value: unknown): OpaqueService | null {
  return (value ?? null) as OpaqueService | null;
}

const ADE_MCP_ACCOUNT_ROWS_REFUSED =
  "ADE MCP's own account data (its connections, account secret and computers) is managed in Settings → ADE MCP, not through actions.";

/**
 * The account vault without ADE MCP's rows. They hold the connections' token
 * hashes and the account secret: a caller that could write one could mint
 * itself a permanent token, and one that could read the secret could answer
 * for the account. Refused for every caller, Settings included; the remote
 * MCP service reads and writes them in-process (remoteMcpShared.ts), never
 * through this domain.
 */
function buildAccountVaultDomainService(runtime: AdeRuntime): OpaqueService | null {
  const store = runtime.accountVaultStore;
  if (!store) return null;
  const guard = (kind: unknown): void => {
    if (kind === REMOTE_MCP_VAULT_KIND) throw new AdeExpectedError(ADE_MCP_ACCOUNT_ROWS_REFUSED, "user");
  };
  type Store = typeof store;
  return {
    list: (scope?: string) => store.list(scope).filter((row) => row.kind !== REMOTE_MCP_VAULT_KIND),
    get: (...args: Parameters<Store["get"]>) => {
      guard(args[1]);
      return store.get(...args);
    },
    set: (...args: Parameters<Store["set"]>) => {
      guard(args[1]);
      return store.set(...args);
    },
    remove: (...args: Parameters<Store["remove"]>) => {
      guard(args[1]);
      return store.remove(...args);
    },
    sync: (...args: Parameters<Store["sync"]>) => store.sync(...args),
    pendingKeys: (...args: Parameters<Store["pendingKeys"]>) => {
      guard(args[1]);
      return store.pendingKeys(...args);
    },
  };
}

/**
 * The account settings without writes to ADE MCP's keys (`ade_mcp.*`): its
 * on/off switch and each computer's entry, whose endpoint key says where the
 * account's calls go. Reads stay. The remote MCP service writes them
 * in-process, never through this domain.
 */
function buildAccountSettingsDomainService(runtime: AdeRuntime): OpaqueService | null {
  const store = runtime.accountSettingsStore;
  if (!store) return null;
  const guard = (key: unknown): void => {
    if (typeof key === "string" && key.startsWith(REMOTE_MCP_SETTINGS_PREFIX)) {
      throw new AdeExpectedError(ADE_MCP_ACCOUNT_ROWS_REFUSED, "user");
    }
  };
  type Store = typeof store;
  return {
    list: (...args: Parameters<Store["list"]>) => store.list(...args),
    deletedKeys: (...args: Parameters<Store["deletedKeys"]>) => store.deletedKeys(...args),
    get: (...args: Parameters<Store["get"]>) => store.get(...args),
    set: (...args: Parameters<Store["set"]>) => {
      guard(args[1]);
      return store.set(...args);
    },
    remove: (...args: Parameters<Store["remove"]>) => {
      guard(args[1]);
      return store.remove(...args);
    },
    sync: () => store.sync(),
  };
}

function buildProxyDomainService(runtime: AdeRuntime): OpaqueService | null {
  const proxyService = runtime.getProxyService?.() ?? runtime.proxyService;
  return proxyService ? toService(createProxyActionDomainService(proxyService)) : null;
}

/**
 * ADE MCP for Settings. Every write is user-only (the desktop), so an
 * agent can neither read nor grant it; `ade mcp` reaches the same service
 * through the machine method `remoteMcp.call`.
 */
function buildRemoteMcpDomainService(runtime: AdeRuntime): OpaqueService | null {
  const service = runtime.remoteMcpService;
  if (!service) return null;
  const handlers = remoteMcpActionHandlers(service, "desktop");
  return Object.fromEntries(
    Object.entries(handlers).map(([action, handler]) => [action, (args?: Record<string, unknown>) => handler(args ?? {})]),
  );
}

function buildKeepAwakeDomainService(runtime: AdeRuntime): OpaqueService | null {
  const service = runtime.keepAwakeService;
  if (!service) return null;
  return {
    getSnapshot: () => service.getSnapshot(),
    setLevel: (args: { level?: unknown }) => service.setLevel(args?.level),
    migrateLegacyPreference: (args: { level?: unknown }) =>
      service.migrateLegacyPreference(args?.level),
    fixSystemSleep: () => service.fixSystemSleep(),
  };
}

// The base64/in-memory ceiling, single-sourced so the constant and the
// rejection message can never drift apart.
const MAX_TEMP_ATTACHMENT_BYTES = LEGACY_MAX_CHAT_ATTACHMENT_BYTES;
const FILE_SEARCH_SESSION_LANE_CACHE_MAX = 200;
// Only non-identity sessions are cached: a regular chat session's lane binding
// is immutable (updateSession exposes no laneId; handoffs create new sessions),
// but resumeSession can migrate a primary-pinned identity (CTO/worker) session
// to the canonical primary lane, so those resolve fresh every call.
const fileSearchLaneIdBySessionId = new Map<string, string>();

function agentChatParallelLaunchStateKey(projectRoot: string, parentLaneId: string): string {
  return `agent-chat-parallel-launch:${projectRoot}:${parentLaneId}`;
}

function rememberFileSearchLaneId(sessionId: string, laneId: string): void {
  if (fileSearchLaneIdBySessionId.has(sessionId)) {
    fileSearchLaneIdBySessionId.delete(sessionId);
  }
  fileSearchLaneIdBySessionId.set(sessionId, laneId);
  while (fileSearchLaneIdBySessionId.size > FILE_SEARCH_SESSION_LANE_CACHE_MAX) {
    const oldest = fileSearchLaneIdBySessionId.keys().next().value;
    if (typeof oldest !== "string") break;
    fileSearchLaneIdBySessionId.delete(oldest);
  }
}

function readSessionLaneId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const laneId = value.laneId;
  return typeof laneId === "string" && laneId.trim() ? laneId.trim() : null;
}

function isLaneCacheableSession(value: unknown): boolean {
  return isRecord(value) && !value.identityKey;
}

async function resolveFileSearchLaneId(agentChatService: unknown, sessionId: string): Promise<string | null> {
  const cached = fileSearchLaneIdBySessionId.get(sessionId);
  if (cached) return cached;

  const service = agentChatService as {
    getSessionSummary?: (sessionId: string) => Promise<unknown> | unknown;
    listSessions?: () => Promise<unknown> | unknown;
  };

  if (typeof service.getSessionSummary === "function") {
    try {
      const summary = await service.getSessionSummary(sessionId);
      const laneId = readSessionLaneId(summary);
      if (laneId) {
        if (isLaneCacheableSession(summary)) rememberFileSearchLaneId(sessionId, laneId);
        return laneId;
      }
    } catch {
      // Fall back to listSessions below for older or partially available runtimes.
    }
  }

  if (typeof service.listSessions !== "function") return null;
  const sessions = await service.listSessions();
  if (!Array.isArray(sessions)) return null;
  const session = sessions.find((entry) => isRecord(entry) && entry.sessionId === sessionId);
  const laneId = readSessionLaneId(session);
  if (laneId) {
    if (isLaneCacheableSession(session)) rememberFileSearchLaneId(sessionId, laneId);
  }
  return laneId;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeAgentChatParallelLaunchState(
  raw: unknown,
  parentLaneId: string,
): AgentChatParallelLaunchState | null {
  if (!isRecord(raw)) return null;
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!["creating_lanes", "sending", "completed", "cleanup_pending"].includes(status)) return null;
  return {
    parentLaneId,
    createdLaneIds: normalizeStringList(raw.createdLaneIds),
    sentLaneIds: normalizeStringList(raw.sentLaneIds),
    status: status as AgentChatParallelLaunchState["status"],
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.trim().length
      ? raw.updatedAt
      : new Date().toISOString(),
    lastError: typeof raw.lastError === "string" && raw.lastError.trim().length ? raw.lastError.trim() : null,
  };
}


async function saveAgentChatTempAttachment(projectRoot: string, arg: { data?: string; filename?: string }): Promise<{ path: string }> {
  const maxEncodedLength = maxBase64EncodedLength(MAX_TEMP_ATTACHMENT_BYTES);
  if (typeof arg.data !== "string") {
    throw new Error("Temporary attachment data is required.");
  }
  if (arg.data.length > maxEncodedLength) {
    throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  }
  const content = Buffer.from(arg.data, "base64");
  if (content.byteLength > MAX_TEMP_ATTACHMENT_BYTES) {
    throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  }
  return await stageAttachmentBytes({
    content,
    filename: typeof arg.filename === "string" ? arg.filename : null,
    attachmentsDir: projectAttachmentsDir(projectRoot),
  });
}

/** The refusal for an image path outside every folder a chat image can live in. */
const AGENT_CHAT_IMAGE_PATH_REFUSAL = "Image path is outside the folders ADE shows chat images from.";

/**
 * The folders a chat image on this machine can come from: the project, each
 * lane's worktree (a lane can live outside the project), the temp folders an
 * agent saves screenshots to, and the user folders a person drops pictures in.
 * The same set the desktop's own reader allows, plus lanes and the desktop, so
 * one read on the owning machine answers for every image a chat shows.
 */
function agentChatImageRoots(runtime: AdeRuntime): string[] {
  const home = os.homedir();
  const roots = [
    runtime.projectRoot,
    ...(runtime.fileService?.listWorkspaces().map((workspace) => workspace.rootPath) ?? []),
    os.tmpdir(),
    // On macOS the temp folder is under /var/folders, but agents save to /tmp.
    ...(process.platform === "darwin" ? ["/tmp"] : []),
    ...(home ? ["Downloads", "Documents", "Desktop"].map((name) => path.join(home, name)) : []),
  ];
  return [...new Set(roots.filter((root) => typeof root === "string" && root.trim().length > 0))];
}

function resolveAgentChatImagePath(runtime: AdeRuntime, rawPath: unknown): string {
  const value = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!value) throw new Error("Image path is required.");
  // A relative path names a file in the project.
  const candidate = path.isAbsolute(value) ? value : path.resolve(runtime.projectRoot, value);
  return resolveWithinAllowedRoots(agentChatImageRoots(runtime), candidate, AGENT_CHAT_IMAGE_PATH_REFUSAL);
}

async function getAgentChatImageDataUrl(
  runtime: AdeRuntime,
  arg: { path?: string },
): Promise<{ dataUrl: string }> {
  const imagePath = resolveAgentChatImagePath(runtime, arg.path);
  const { dataUrl } = await readImageFileAsDataUrl(imagePath, { logger: runtime.logger });
  return { dataUrl };
}

/**
 * A send's text. Required, except on a user send that carries the chat's
 * pending thread comments: those can go on their own, and the host builds the
 * message text from them.
 */
function readSendText(record: Record<string, unknown>): string {
  if (record.includeThreadComments === true) return typeof record.text === "string" ? record.text : "";
  return requireNonEmptyString(record.text, "text");
}

function buildChatDomainService(runtime: AdeRuntime): OpaqueService | null {
  const agentChatService = runtime.agentChatService;
  if (!agentChatService) return null;
  const base = agentChatService as unknown as OpaqueService;
  const launches = () => requireService(runtime.chatLaunchService, "Chat launch service not available.");
  const service: OpaqueService = {
    ...base,
    // Machine-level and stateless per chat: the Sources list asks for the
    // icons of domains it already shows. Same resolver as the sync command.
    resolveSourceFavicons: (args?: unknown) =>
      getSourceFaviconService().resolve(asActionRecord(args) as ResolveSourceFaviconsArgs),
    // Stateless and public-only, like favicons: a link hover card's og:image.
    resolveSmartLinkImage: (args?: unknown) => {
      const url = asActionRecord(args).url;
      return resolveSmartLinkImage({ url: typeof url === "string" ? url : "" });
    },
    ensureCtoSession: async (args?: { modelId?: string | null; reasoningEffort?: string | null }) => {
      const laneId = await resolvePrimaryLaneId(runtime);
      return agentChatService.ensureIdentitySession({
        identityKey: "cto",
        laneId,
        modelId: args?.modelId ?? null,
        reasoningEffort: args?.reasoningEffort ?? null,
        permissionMode: "full-auto",
      });
    },
    // New-lane launches (shared/types/chatLaunch.ts). Brain-owned end to end;
    // payloads go through the same parser as the sync `chat.startLaunch` …
    // commands (chat/chatLaunchArgs.ts), and the service auto-picks an empty model.
    startLaunch: (args?: unknown) => launches().start(parseChatLaunchArgs(args)),
    getLaunch: (args?: unknown) =>
      runtime.chatLaunchService?.get(parseChatLaunchIdArgs(args, "chat.getLaunch")) ?? null,
    listLaunches: () => runtime.chatLaunchService?.list() ?? [],
    cancelLaunch: (args?: unknown) => launches().cancel(parseChatLaunchIdArgs(args, "chat.cancelLaunch")),
    retryLaunch: (args?: unknown) => launches().retry(parseChatLaunchIdArgs(args, "chat.retryLaunch")),
    startLaunchNow: (args?: unknown) => launches().startNow(parseChatLaunchIdArgs(args, "chat.startLaunchNow")),
    queueLaunchMessage: (args?: unknown) => launches().queueMessage(parseChatLaunchQueueMessageArgs(args)),
    completeLaunchClient: (args?: unknown) => launches().completeClient(parseChatLaunchCompleteClientArgs(args)),
    getParallelLaunchState: (args?: { parentLaneId?: string }) => {
      const parentLaneId = requireNonEmptyString(args?.parentLaneId, "parentLaneId");
      const key = agentChatParallelLaunchStateKey(runtime.projectRoot, parentLaneId);
      return normalizeAgentChatParallelLaunchState(
        runtime.db.getJson<AgentChatParallelLaunchState | null>(key),
        parentLaneId,
      );
    },
    launchCli: async (
      args: AgentChatLaunchCliArgs,
    ): Promise<AgentChatLaunchCliResult> =>
      launchAgentChatCli(args, {
        laneService: requireService(
          runtime.laneService,
          "Lane service not available.",
        ),
        ptyService: requireService(
          runtime.ptyService,
          "Terminal service not available.",
        ),
      }),
    // Object form `{ laneId?, ...options }`, or the desktop's positional
    // `argsList [laneId?, options?]`.
    listSessions: (args?: unknown, positionalOptions?: unknown) => {
      const positional = typeof args === "string" || (args == null && positionalOptions != null);
      const record = positional ? asActionRecord(positionalOptions) : asActionRecord(args);
      const rawLaneId = positional ? args : record.laneId;
      const laneId = typeof rawLaneId === "string" && rawLaneId.trim()
        ? rawLaneId.trim()
        : undefined;
      const sessionIds = Array.isArray(record.sessionIds)
        ? record.sessionIds.filter((id): id is string => typeof id === "string")
        : null;
      const options = {
        ...(typeof record.includeArchived === "boolean" ? { includeArchived: record.includeArchived } : {}),
        ...(typeof record.includeAutomation === "boolean" ? { includeAutomation: record.includeAutomation } : {}),
        ...(typeof record.includeIdentity === "boolean" ? { includeIdentity: record.includeIdentity } : {}),
        ...(sessionIds ? { sessionIds } : {}),
      };
      return agentChatService.listSessions(
        laneId,
        Object.keys(options).length ? options : undefined,
      );
    },
    readTranscript: async (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.readTranscript");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const limitValue = record.limit;
      const parsedLimit = typeof limitValue === "number"
        ? limitValue
        : typeof limitValue === "string" && limitValue.trim()
          ? Number.parseInt(limitValue, 10)
          : undefined;
      const limit = typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.floor(parsedLimit)))
        : undefined;
      const maxCharsValue = record.maxChars;
      const parsedMaxChars = typeof maxCharsValue === "number"
        ? maxCharsValue
        : typeof maxCharsValue === "string" && maxCharsValue.trim()
          ? Number.parseInt(maxCharsValue, 10)
          : undefined;
      const maxChars = typeof parsedMaxChars === "number" && Number.isFinite(parsedMaxChars)
        ? Math.max(200, Math.min(120_000, Math.floor(parsedMaxChars)))
        : 8_000;
      const since = typeof record.since === "string" && record.since.trim()
        ? record.since.trim()
        : undefined;
      const chatService = agentChatService as {
        readTranscript?: (sessionId: string, limit?: number, since?: string) => Promise<unknown> | unknown;
        getChatTranscript?: (args: { sessionId: string; limit?: number; maxChars?: number }) => Promise<unknown> | unknown;
      };
      if (typeof chatService.getChatTranscript === "function") {
        const transcript = await chatService.getChatTranscript({
          sessionId,
          ...(limit !== undefined ? { limit } : {}),
          maxChars,
        });
        const entries = Array.isArray(transcript)
          ? transcript
          : isRecord(transcript) && Array.isArray(transcript.entries)
            ? transcript.entries
            : [];
        if (!since) return transcript;
        const sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs)) return transcript;
        const filteredEntries = entries.filter((entry) => {
          if (!isRecord(entry) || typeof entry.timestamp !== "string") return true;
          const timestampMs = Date.parse(entry.timestamp);
          return !Number.isFinite(timestampMs) || timestampMs >= sinceMs;
        });
        return isRecord(transcript)
          ? { ...transcript, entries: filteredEntries }
          : filteredEntries;
      }
      if (typeof chatService.readTranscript === "function") {
        const entries = await chatService.readTranscript(sessionId, limit, since);
        if (!Array.isArray(entries)) return entries;
        let remaining = maxChars;
        const bounded: unknown[] = [];
        for (let index = entries.length - 1; index >= 0 && remaining > 0; index -= 1) {
          const entry = entries[index];
          if (!isRecord(entry) || typeof entry.text !== "string") {
            bounded.push(entry);
            continue;
          }
          const text = entry.text.length <= remaining
            ? entry.text
            : `${entry.text.slice(0, Math.max(0, remaining - 3)).trimEnd()}...`;
          bounded.push({ ...entry, text });
          remaining -= text.length;
        }
        return bounded.reverse();
      }
      throw new Error("Chat transcript reads are not available in this runtime.");
    },
    readTranscriptPage: async (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.readTranscriptPage");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const readBoundedInteger = (
        value: unknown,
        fallback: number | undefined,
        min: number,
        max: number,
      ): number | undefined => {
        const parsed = typeof value === "number"
          ? value
          : typeof value === "string" && value.trim()
            ? Number.parseInt(value, 10)
            : fallback;
        return typeof parsed === "number" && Number.isFinite(parsed)
          ? Math.max(min, Math.min(max, Math.floor(parsed)))
          : undefined;
      };
      const beforeOffset = readBoundedInteger(record.beforeOffset, undefined, 0, Number.MAX_SAFE_INTEGER);
      const limit = readBoundedInteger(record.limit, 20, 1, 100);
      const maxChars = readBoundedInteger(record.maxChars, 8_000, 200, 120_000);
      const chatService = agentChatService as {
        getChatTranscriptPage?: (args: {
          sessionId: string;
          beforeOffset?: number;
          limit?: number;
          maxChars?: number;
        }) => Promise<unknown> | unknown;
      };
      if (typeof chatService.getChatTranscriptPage !== "function") {
        throw new Error("Paged chat transcript reads are not available in this runtime.");
      }
      return chatService.getChatTranscriptPage({
        sessionId,
        ...(beforeOffset !== undefined ? { beforeOffset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
      });
    },
    sendMessage: async (args?: unknown) => {
      const { inputOrigin, ...record } = readObjectActionArg(args, "chat.sendMessage");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const text = readSendText(record);
      // Which desktop is talking to this chat: "show this" requests go there.
      noteSessionInputOrigin(sessionId, inputOrigin);
      await agentChatService.sendMessage({
        ...withoutHostOnlyChatMetadata(record),
        sessionId,
        text,
      } as never);
      return {
        ok: true,
        accepted: true,
        sessionId,
        note: "Message accepted by the ADE chat service; provider dispatch continues asynchronously.",
      };
    },
    messageSession: async (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.messageSession");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const text = requireNonEmptyString(record.text, "text");
      if (typeof agentChatService.messageSession !== "function") {
        throw new Error("Chat messageSession is not available in this runtime.");
      }
      return agentChatService.messageSession({
        ...withoutHostOnlyChatMetadata(record),
        sessionId,
        text,
      } as never);
    },
    steer: async (args?: unknown) => {
      const { inputOrigin, ...record } = readObjectActionArg(args, "chat.steer");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const text = readSendText(record);
      noteSessionInputOrigin(sessionId, inputOrigin);
      if (typeof agentChatService.steer !== "function") {
        throw new Error("Chat steer is not available in this runtime.");
      }
      // Steer reaches the same dispatch commit point a send does — the
      // accepted branch of the steer queue runs the auto-resume sweep — so the
      // host-only markers have to be stripped here for the same reason.
      return agentChatService.steer({
        ...withoutHostOnlyChatMetadata(record),
        sessionId,
        text,
      } as never);
    },
    setParallelLaunchState: (args?: AgentChatSetParallelLaunchStateArgs) => {
      const parentLaneId = requireNonEmptyString(args?.parentLaneId, "parentLaneId");
      const key = agentChatParallelLaunchStateKey(runtime.projectRoot, parentLaneId);
      runtime.db.setJson(key, normalizeAgentChatParallelLaunchState(args?.state ?? null, parentLaneId));
    },
    listDrafts: () => listDrafts(runtime.db),
    getDraft: (args?: DraftGetArgs) => {
      const record = readObjectActionArg(args, "chat.getDraft");
      return getDraft(runtime.db, requireNonEmptyString(record.id, "id"));
    },
    createDraft: (args?: DraftCreateArgs) => {
      const record = readObjectActionArg(args, "chat.createDraft");
      // The service owns validation for both text and attachment-only drafts.
      // Keeping the full object intact is essential on the daemon path: this is
      // the path every runtime-backed desktop uses.
      const created = createDraft(runtime.db, record);
      // A newly armed send should not wait for the periodic sweep to be seen.
      // Optional on purpose: re-arming is an optimisation, and a service that
      // cannot do it still picks the row up on its next sweep.
      agentChatService.refreshDraftScheduler?.();
      return created;
    },
    deleteDraft: (args?: DraftDeleteArgs) => {
      const record = readObjectActionArg(args, "chat.deleteDraft");
      const deleted = deleteDraft(runtime.db, requireNonEmptyString(record.id, "id"));
      agentChatService.refreshDraftScheduler?.();
      return deleted;
    },
    updateDraft: (args?: DraftUpdateArgs) => {
      const record = readObjectActionArg(args, "chat.updateDraft");
      const updated = updateDraft(runtime.db, record);
      agentChatService.refreshDraftScheduler?.();
      return updated;
    },
    claimDraft: (args?: DraftClaimArgs) => {
      const record = readObjectActionArg(args, "chat.claimDraft");
      return claimDraft(runtime.db, requireNonEmptyString(record.id, "id"));
    },
    // Delivers the draft as a real user turn now, whatever its fire time. Owned
    // by the chat service rather than the draft store: sending is a chat
    // concern, and this is the same path the scheduler uses at a fire time.
    sendDraftNow: async (args?: { id?: string }) => {
      const record = readObjectActionArg(args, "chat.sendDraftNow");
      return await agentChatService.sendDraftNow(requireNonEmptyString(record.id, "id"));
    },
    fileSearch: async (args?: AgentChatFileSearchArgs): Promise<AgentChatFileSearchResult[]> => {
      const sessionId = requireNonEmptyString(args?.sessionId, "sessionId");
      const query = typeof args?.query === "string" ? args.query : "";
      const laneId = await resolveFileSearchLaneId(agentChatService, sessionId);
      if (!laneId || !runtime.fileService) return [];
      if (!query.trim()) {
        const warmQuickOpenIndex = (runtime.fileService as {
          warmQuickOpenIndex?: (args: { workspaceId: string; includeIgnored?: boolean }) => Promise<void>;
        }).warmQuickOpenIndex;
        if (typeof warmQuickOpenIndex === "function") {
          void warmQuickOpenIndex({ workspaceId: laneId }).catch(() => undefined);
        }
        return [];
      }
      const matches = await runtime.fileService.quickOpen({
        workspaceId: laneId,
        query,
        limit: 20,
      });
      return matches.map((match) => ({
        path: match.path,
        ...(typeof match.score === "number" ? { score: match.score } : {}),
      }));
    },
    // Composer @-mention suggestions (chats / lanes / terminals) for the
    // active project. Roster-only reads; no transcript or PTY work happens
    // here, so this is safe at keystroke rate.
    listMentionSuggestions: (args?: unknown): Promise<ChatMentionSuggestResult> => {
      // Action args cross a process boundary, so narrow rather than cast: only
      // the two string fields of the contract are forwarded.
      const record = (args ?? {}) as Record<string, unknown>;
      const query = typeof record.query === "string" ? record.query : "";
      const excludeSessionId = typeof record.excludeSessionId === "string"
        ? record.excludeSessionId
        : undefined;
      const suggestArgs: ChatMentionSuggestArgs = {
        query,
        ...(excludeSessionId ? { excludeSessionId } : {}),
      };
      return agentChatService.listMentionSuggestions(suggestArgs);
    },
    getTurnFileDiff: (args?: AgentChatGetTurnFileDiffArgs) => {
      if (!args) throw new Error("Turn file diff args are required.");
      return getTurnFileDiffFromGit(runtime.projectRoot, args);
    },
    saveTempAttachment: (args?: { data?: string; filename?: string }) =>
      saveAgentChatTempAttachment(runtime.projectRoot, args ?? {}),
    // The composer's same-machine attachment staging. The renderer only reaches
    // it after `getAttachmentStagingMode` answered `copy`, which it only does
    // when the chat's machine binding IS this machine — so in the product the
    // unconstrained source path is always one this user just dragged in.
    //
    // That is a statement about the UI, not a boundary, and there is no gate
    // here: this IS reachable over sync RPC from a paired peer. The handler
    // serving that channel is the same zero-argument factory the local unix
    // socket gets (`setSyncRuntimeRpcHandlerFactory` in cli.ts), and
    // `SessionState` carries no transport origin, so nothing downstream can
    // tell the two callers apart. A paired peer can therefore read any file on
    // this disk through here.
    //
    // Not an escalation, for two reasons. Opening that channel at all requires
    // a runtime-host pairing grant (syncPairedChannelService refuses `rpc_open`
    // without one), and a peer holding it already reaches `chat.launchCli` —
    // arbitrary processes on this machine — through the same door. Pairing,
    // not this allowlist, is where that trust is decided.
    copyTempAttachment: (args?: { sourcePath?: string; filename?: string }) =>
      stageAttachmentCopy({
        sourcePath: typeof args?.sourcePath === "string" ? args.sourcePath : "",
        filename: typeof args?.filename === "string" ? args.filename : null,
        attachmentsDir: projectAttachmentsDir(runtime.projectRoot),
      }),
    /**
     * Mint a ticket for the streamed HTTP upload route so a paired desktop can
     * stage a file it holds WITHOUT base64-inflating it through two heaps.
     *
     * This is the registry half of the same feature `chat.createAttachmentUpload`
     * serves on the sync command channel (mobile and other sync clients). Both
     * mint from the host's one `AttachmentUploadRegistry` instance — a ticket is
     * only redeemable by the request handler that shares that map, so a
     * second registry here would issue tickets no route recognises.
     */
    createAttachmentUpload: (args?: { filename?: string }) => {
      const syncHost = runtime.syncHostService;
      if (!syncHost) {
        throw new Error("This machine is not sharing this project, so it cannot accept attachment uploads.");
      }
      const filename = typeof args?.filename === "string" ? args.filename.trim() : "";
      return syncHost.issueAttachmentUploadTicket({
        projectRoot: runtime.projectRoot,
        filename: filename || "attachment",
      });
    },
    getImageDataUrl: (args?: { path?: string }) =>
      getAgentChatImageDataUrl(runtime, args ?? {}),
  };
  if (typeof base.createSession === "function") {
    service.createSession = (args?: unknown) =>
      agentChatService.createSession(readObjectActionArg(args, "chat.createSession") as never);
  }
  if (typeof base.getAvailableModels === "function") {
    service.getAvailableModels = (args?: unknown) =>
      agentChatService.getAvailableModels(readObjectActionArg(args, "chat.getAvailableModels") as never);
  }
  if (typeof base.getSessionSummary === "function") {
    service.getSessionSummary = async (
      args?: unknown,
    ): Promise<AdeChatSessionSummaryActionResult | null> => {
      const summary = await agentChatService.getSessionSummary(
        readStringActionArg(args, "sessionId"),
      );
      if (!summary) return null;
      const sessionActivity = runtime.sessionService?.getByChatSessionId?.(summary.sessionId);
      // The host zone is added here rather than on `AgentChatSessionSummary`
      // itself so the per-row list payload does not carry the same constant N
      // times; `chat.createScheduledWork` reports the same value the same way.
      // See `AdeChatSessionSummaryActionResult` for the full reasoning.
      return {
        ...summary,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(sessionActivity ? { activityStatus: sessionActivity.activityStatus ?? null } : {}),
      };
    };
  }
  if (typeof base.getTurnStatus === "function") {
    service.getTurnStatus = (args?: unknown) =>
      agentChatService.getTurnStatus(readStringActionArg(args, "sessionId"));
  }
  // Actions arrive as one object (`ade chat ask --clear` sends `{ sessionId }`);
  // the service takes the id itself.
  if (typeof base.clearAsk === "function") {
    service.clearAsk = (args?: unknown) =>
      agentChatService.clearAsk(readStringActionArg(args, "sessionId"));
  }
  if (typeof base.listScheduledWork === "function") {
    service.listScheduledWork = (args?: unknown) => {
      const record = args === undefined
        ? {}
        : readObjectActionArg(args, "chat.listScheduledWork");
      const sessionId = typeof record.sessionId === "string" && record.sessionId.trim()
        ? record.sessionId.trim()
        : undefined;
      return agentChatService.listScheduledWork({
        ...(sessionId ? { sessionId } : {}),
        ...(record.includeTerminal === true ? { includeTerminal: true } : {}),
      });
    };
  }
  if (typeof base.getScheduledWorkState === "function") {
    service.getScheduledWorkState = (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.getScheduledWorkState");
      return agentChatService.getScheduledWorkState({
        sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
      });
    };
  }
  if (typeof base.cancelScheduledWork === "function") {
    service.cancelScheduledWork = (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.cancelScheduledWork");
      return agentChatService.cancelScheduledWork({
        sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
        scheduleId: requireNonEmptyString(record.scheduleId, "scheduleId"),
      });
    };
  }
  if (typeof base.resumeUsageLimitNow === "function") {
    service.resumeUsageLimitNow = (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.resumeUsageLimitNow");
      return agentChatService.resumeUsageLimitNow({
        sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
      });
    };
  }
  if (typeof base.continueUsageLimitOnAlternate === "function") {
    service.continueUsageLimitOnAlternate = (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.continueUsageLimitOnAlternate");
      return agentChatService.continueUsageLimitOnAlternate({
        sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
      });
    };
  }
  if (typeof base.switchAccount === "function") {
    service.switchAccount = (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.switchAccount");
      return agentChatService.switchAccount({
        sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
        instanceId: requireNonEmptyString(record.instanceId, "instanceId"),
      });
    };
  }
  if (typeof base.getChatEventHistory === "function") {
    service.getChatEventHistory = (args?: unknown, positionalOptions?: unknown) => {
      const actionArgs = positionalOptions === undefined ? args : [args, positionalOptions];
      const { sessionId, options } = readChatHistoryActionArgs(actionArgs, "chat.getChatEventHistory");
      const maxEvents = readOptionalIntegerActionField(options.maxEvents, "maxEvents");
      const maxBytes = readOptionalIntegerActionField(options.maxBytes, "maxBytes");
      const afterOffset = readOptionalIntegerActionField(options.afterOffset, "afterOffset");
      const historyGeneration = readOptionalIntegerActionField(options.historyGeneration, "historyGeneration");
      return agentChatService.getChatEventHistory(sessionId, {
        ...(maxEvents !== undefined ? { maxEvents } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(afterOffset !== undefined ? { afterOffset } : {}),
        ...(historyGeneration !== undefined ? { historyGeneration } : {}),
      });
    };
  }
  if (typeof base.getChatEventHistoryPage === "function") {
    service.getChatEventHistoryPage = (args?: unknown, positionalOptions?: unknown) => {
      const actionArgs = positionalOptions === undefined ? args : [args, positionalOptions];
      const { sessionId, options } = readChatHistoryActionArgs(actionArgs, "chat.getChatEventHistoryPage");
      const beforeOffset = readOptionalIntegerActionField(options.beforeOffset, "beforeOffset");
      if (beforeOffset === undefined) {
        throw new Error("Expected 'beforeOffset' to be a finite number.");
      }
      const maxBytes = readOptionalIntegerActionField(options.maxBytes, "maxBytes");
      return agentChatService.getChatEventHistoryPage(sessionId, {
        beforeOffset,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
    };
  }
  if (typeof agentChatService.getModelCatalog === "function") {
    service.modelCatalog = (args?: unknown) =>
      agentChatService.getModelCatalog(readObjectActionArg(args, "chat.modelCatalog") as never);
  }
  return service;
}

async function resolvePrimaryLaneId(runtime: AdeRuntime): Promise<string> {
  const laneService = requireService(runtime.laneService, "Lane service not available.");
  await laneService.ensurePrimaryLane();
  const lanes = await laneService.list();
  const primary = lanes.find((lane) => lane.laneType === "primary");
  if (!primary?.id) {
    throw new Error("No primary lane is available to host the identity chat session.");
  }
  return primary.id;
}

function buildCtoStateDomainService(runtime: AdeRuntime): OpaqueService | null {
  const ctoStateService = runtime.ctoStateService;
  if (!ctoStateService) return null;
  return {
    ...(ctoStateService as unknown as OpaqueService),
    runProjectScan: async (): Promise<CtoRunProjectScanResult> => {
      const detection = await runtime.onboardingService?.detectDefaults().catch(() => null) ?? null;
      return { detection };
    },
    /**
     * Read-only attention probe for the hidden CTO thread. Delegates to the
     * chat service so this transport cannot derive "needs you" differently from
     * the plain-IPC one.
     */
    getAttention: async (): Promise<CtoAttentionState> =>
      (await runtime.agentChatService?.getCtoAttention())
      ?? { status: "unknown", awaitingInput: false, since: null },
    /**
     * Read-only: can the CTO thread take a turn, and should it be rotated?
     *
     * Open to every role for the same reason `getAttention` is — it answers a
     * question about a badge, creates nothing, and returns no content.
     */
    getThreadHealth: async (): Promise<CtoThreadHealth> =>
      (await runtime.agentChatService?.getCtoThreadHealth())
      ?? {
        sessionId: null,
        canTakeTurn: true,
        blockedReason: null,
        lastTurnFailure: null,
        context: null,
        rotationAdvised: false,
      },
    /**
     * Retire the CTO thread and start a clean one.
     *
     * CTO-only (see `ADE_ACTION_CTO_ONLY.cto_state`): it ends the conversation
     * every other surface is talking to. Nothing the CTO remembers is touched —
     * identity, memory, the daily log and project state all carry over, and the
     * outgoing thread is distilled into memory before it is retired.
     */
    startFreshSession: async (): Promise<CtoStartFreshSessionResult> => {
      const agentChatService = runtime.agentChatService;
      if (!agentChatService) throw new Error("The chat service is not available on this machine.");
      await runtime.laneService?.ensurePrimaryLane();
      const lanes = (await runtime.laneService?.list()) ?? [];
      const laneId = lanes.find((lane) => lane.laneType === "primary")?.id;
      if (!laneId) throw new Error("No primary lane is available to host the CTO chat session.");
      const result = await agentChatService.startFreshIdentitySession({ identityKey: "cto", laneId });
      return {
        sessionId: result.session.id,
        previousSessionId: result.previousSessionId,
        handoff: result.handoff,
      };
    },
  };
}

function buildCtoMemoryDomainService(runtime: AdeRuntime): OpaqueService | null {
  const ctoMemoryService = runtime.ctoMemoryService;
  if (!ctoMemoryService) return null;
  return {
    getSnapshot: () => ctoMemoryService.getSnapshot(),
    updateMemory: (args?: { memory?: string }) => {
      // A missing field must not silently blank the durable memory file; only
      // an explicit string (including a deliberate "") is a valid rewrite —
      // and clearing writes archive the replaced content.
      if (typeof args?.memory !== "string") {
        throw new Error("updateMemory requires a string `memory` field.");
      }
      ctoMemoryService.writeMemory(args.memory);
      return ctoMemoryService.getSnapshot();
    },
    searchMemory: (args?: { query?: string; limit?: number; tags?: CtoMemoryTags }) => {
      const query = args?.query ?? "";
      const rows = ctoMemoryService.searchMemory(query, {
        limit: args?.limit ?? 20,
        ...(args?.tags ? { tags: args.tags } : {}),
      });
      return { query, rows };
    },
    /**
     * One of the three non-CTO methods on this domain — see the `cto_memory`
     * rule in `actionPolicy.ts`, which is `allExcept` so everything else here
     * is CTO-only by omission. Append-only: it cannot read or modify durable
     * memory, so a worker handing up a finding gains no view of what the CTO
     * already knows (the other two, `getSnapshot` and `searchMemory`, can read
     * it; see that rule for why they stay open).
     */
    recordDiscovery: (args?: { fact?: string; tags?: CtoMemoryTags }) => {
      if (typeof args?.fact !== "string" || !args.fact.trim().length) {
        throw new Error("recordDiscovery requires a non-empty string `fact` field.");
      }
      return ctoMemoryService.recordDiscovery(args.fact, args.tags ?? null);
    },
  };
}

/**
 * Deliberately NOT a spread of the broker.
 *
 * Spreading it published every broker method as an action, including `ingest` —
 * the one writer that creates proof-drawer records. `ade actions call
 * computer_use_artifacts.ingest` then reached the broker directly, skipping the
 * `ingest_computer_use_artifacts` RPC tool where `validateComputerUseOwnerClaims`
 * and the authorized caller-root check live. Proof entry stays on the validated
 * tool path; this domain exposes reads and record lifecycle only.
 */
function buildComputerUseArtifactsDomainService(runtime: AdeRuntime): OpaqueService | null {
  const broker = runtime.computerUseArtifactBrokerService;
  if (!broker) return null;
  return {
    listArtifacts: (args?: Parameters<typeof broker.listArtifacts>[0]) => broker.listArtifacts(args),
    deleteArtifacts: (args: Parameters<typeof broker.deleteArtifacts>[0]) => broker.deleteArtifacts(args),
    listBrokenArtifacts: (args?: Parameters<typeof broker.listBrokenArtifacts>[0]) =>
      broker.listBrokenArtifacts(args),
    pruneBrokenArtifacts: () => broker.pruneBrokenArtifacts(),
    recoverArtifact: (args: Parameters<typeof broker.recoverArtifact>[0]) => broker.recoverArtifact(args),
    updateArtifactReview: (args: Parameters<typeof broker.updateArtifactReview>[0]) =>
      broker.updateArtifactReview(args),
    readArtifactPreview: (args: Parameters<typeof broker.readArtifactPreview>[0]) =>
      broker.readArtifactPreview(args),
    readArtifactRange: (args: Parameters<typeof broker.readArtifactRange>[0]) =>
      broker.readArtifactRange(args),
    getBackendStatus: () => broker.getBackendStatus(),
    getOwnerSnapshot: (args?: ComputerUseOwnerSnapshotArgs) => {
      if (!args?.owner) throw new Error("owner is required.");
      return buildComputerUseOwnerSnapshot({
        broker,
        owner: args.owner,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
    },
    /**
     * File a scene snapshot the desktop already wrote into the artifact store.
     *
     * The generic `ingest` stays absent for the reason above — agents create
     * proof only through the validated RPC tool. This is the narrow exception
     * and it is CTO-only. The path jail, the symlink resolution and the owner
     * check are the whole of it, so they live in `scenes/sceneSnapshotIngest`
     * rather than inline in a dispatch table where they read as boilerplate.
     */
    ingestSceneSnapshot: async (args?: {
      path?: unknown;
      title?: unknown;
      sessionId?: unknown;
      sceneScopeKey?: unknown;
    }): Promise<{ filed: boolean; ownerSessionId: string | null; artifactId: string | null }> =>
      ingestSceneSnapshot({
        projectRoot: runtime.projectRoot,
        broker,
        agentChatService: runtime.agentChatService ?? null,
        args,
      }),
  };
}

/**
 * `ade notify`: a push the caller wrote, to every phone on the account. Open to
 * agents and automation steps; the relay caps an account at
 * `CUSTOM_NOTIFICATION_HOURLY_LIMIT` an hour.
 */
/**
 * `attention.sendNotification`, and `notify.send` for `ade notify` (which runs
 * machine-wide, outside any project). `projectRoot` names the project a chat
 * or PR link belongs to; it defaults to the runtime's own, and null stamps no
 * project.
 */
export function buildSendNotificationAction(
  runtime: Pick<AdeRuntime, "accountAuthService" | "projectRoot" | "productAnalyticsService">,
  send: NonNullable<AdeRuntime["sendCustomNotification"]>,
  options: { projectRoot?: string | null } = {},
) {
  const projectRoot = options.projectRoot === undefined ? runtime.projectRoot : options.projectRoot;
  return async (args?: { title?: unknown; body?: unknown; open?: unknown }) => {
    // The link is checked apart from the text: an automation whose trigger
    // left a link value empty still sends its notification, opening ADE, and
    // says why the link was left off. `ade notify` refuses a bad link itself.
    const problem = customNotificationProblem({ title: args?.title, body: args?.body });
    if (problem) throw new Error(problem);
    if (args?.open != null && typeof args.open !== "string") {
      throw new Error("The open link must be text.");
    }
    // A process without the account service (desktop automations) learns the
    // sign-in state from the relay's 401 below instead.
    if (runtime.accountAuthService && !runtime.accountAuthService.getStatus().signedIn) {
      throw new Error(
        "Sign in to ADE first: run `ade login`. Notifications go to the phones on your ADE account.",
      );
    }
    const body = typeof args?.body === "string" ? args.body.trim() : "";
    const rawOpen = typeof args?.open === "string" ? args.open.trim() : "";
    const link = rawOpen ? normalizeCustomNotificationLink(rawOpen) : null;
    try {
      const result = await send({
        title: String(args?.title).trim(),
        body: body || null,
        deepLink: link?.ok ? link.link : null,
        // The sender stamps its machine onto a chat or PR link; the project
        // is this one, by the id every machine derives the same way.
        projectId: projectRoot ? deriveProjectId(projectRoot) : null,
      });
      captureNotificationSentAnalytics({
        analytics: runtime.productAnalyticsService,
        surface: "api",
        outcome: result.devices > 0 && result.failed === 0 ? "completed" : "failed",
      });
      return {
        sent: result.delivered > 0,
        ...result,
        ...(link && !link.ok ? { linkSkipped: link.problem } : {}),
      };
    } catch (error) {
      captureNotificationSentAnalytics({
        analytics: runtime.productAnalyticsService,
        surface: "api",
        outcome: error instanceof PushRelayNotifyRateLimitedError ? "skipped_budget" : "failed",
      });
      if (error instanceof PushRelayNotifyRateLimitedError) {
        const minutes = error.retryAfterSeconds ? Math.max(1, Math.ceil(error.retryAfterSeconds / 60)) : null;
        throw new Error(
          `This account has sent ${CUSTOM_NOTIFICATION_HOURLY_LIMIT} notifications in the last hour.`
            + (minutes ? ` Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` : " Try again later."),
        );
      }
      if (error instanceof PushRelayRequestError && error.status === 401) {
        throw new Error("Your ADE sign-in did not work. Run `ade login`, then try again.");
      }
      throw error;
    }
  };
}

function buildAttentionDomainService(runtime: AdeRuntime): OpaqueService | null {
  const publisher = runtime.pushPublisherService;
  if (!publisher) {
    // Desktop automations run without a publisher; they can still notify.
    const send = runtime.sendCustomNotification;
    return send ? { sendNotification: buildSendNotificationAction(runtime, send) } : null;
  }
  const requireCurrentAccountOwner = (value: unknown): string => {
    const accountOwnerId = typeof value === "string" ? value.trim() : "";
    const status = runtime.accountAuthService?.getStatus();
    const currentOwnerId = status?.signedIn ? status.userId?.trim() || null : null;
    if (!accountOwnerId || currentOwnerId !== accountOwnerId) {
      throw new Error("The ADE account changed before Activity preferences could be used.");
    }
    return accountOwnerId;
  };
  return {
    getSnapshot: (args?: { since?: number; streamId?: string | null }) =>
      publisher.getAttentionSnapshot(
        Number.isFinite(Number(args?.since))
          ? Math.max(0, Math.trunc(Number(args?.since)))
          : 0,
        typeof args?.streamId === "string" && args.streamId.trim()
          ? args.streamId.trim()
          : null,
      ),
    acknowledge: (args?: {
      itemIds?: unknown;
      seenAt?: unknown;
      dismissedAt?: unknown;
    }) => {
      const itemIds = Array.isArray(args?.itemIds)
        ? args.itemIds
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim())
          .slice(0, 64)
        : [];
      if (itemIds.length === 0) throw new Error("itemIds must include at least one attention item.");
      return publisher.acknowledgeAttention({
        itemIds,
        ...(typeof args?.seenAt === "string" ? { seenAt: args.seenAt } : {}),
        ...(args?.dismissedAt === null || typeof args?.dismissedAt === "string"
          ? { dismissedAt: args.dismissedAt }
          : {}),
      });
    },
    reportPresence: (args?: AttentionPresence) => {
      if (!args || typeof args.deviceId !== "string") {
        throw new Error("A valid Activity presence payload is required.");
      }
      return publisher.reportAttentionPresence(args);
    },
    getPreferences: (args?: { accountOwnerId?: unknown }) =>
      publisher.getAttentionPreferences(
        requireCurrentAccountOwner(args?.accountOwnerId),
      ),
    putPreferences: (args?: {
      accountOwnerId?: unknown;
      preferences?: AttentionPreferences;
    }) => {
      if (!args?.preferences || typeof args.preferences !== "object") {
        throw new Error("A valid Activity preferences payload is required.");
      }
      return publisher.putAttentionPreferences(
        requireCurrentAccountOwner(args.accountOwnerId),
        args.preferences,
      );
    },
    sendNotification: buildSendNotificationAction(runtime, (notification) =>
      publisher.sendCustomNotification(notification)),
    putMachinePreferences: (args?: {
      accountOwnerId?: unknown;
      machineKey?: unknown;
      preferences?: unknown;
    }) => {
      if (typeof args?.machineKey !== "string" || args.machineKey.length === 0) {
        throw new Error("A machineKey is required.");
      }
      if (!args?.preferences || typeof args.preferences !== "object") {
        throw new Error("A valid Activity machine preferences payload is required.");
      }
      return publisher.putAttentionMachinePreferences(
        requireCurrentAccountOwner(args.accountOwnerId),
        args.machineKey,
        args.preferences as Partial<AttentionPreferenceScope>,
      );
    },
  };
}

/**
 * Raise a session's hand: the one path behind `ade chat ask`. Writes the
 * attention marker, flips a live terminal to waiting-input, and pushes the
 * question to paired phones. ADE's own turn-end question check
 * (`turn_end_question`) comes through here too, so its hand reads and
 * notifies exactly like one the agent raised. False when the session is gone.
 */
export function requestSessionAttentionForRuntime(
  runtime: AdeRuntime,
  args: {
    sessionId: string;
    message: string;
    source?: SessionAttentionSource;
    alertTitle?: string | null;
    alertBody?: string | null;
  },
): boolean {
  const sessionService = runtime.sessionService;
  if (!sessionService) return false;
  const { sessionId, message } = args;
  if (!sessionService.requestAttention(sessionId, message, args.source)) return false;
  const session = sessionService.get(sessionId);
  const isTrackedCli = isTrackedAgentCliToolType(session?.toolType);
  const hasLivePty = runtime.ptyService?.hasLivePty(sessionId) ?? false;
  if (hasLivePty) {
    runtime.ptyService.markSessionAttentionRequested(sessionId);
    runtime.ptyService.setSessionRuntimeState(sessionId, "waiting-input");
  }
  try {
    runtime.pushPublisherService?.handleSessionAttentionRequested(runtime.projectId, {
      sessionId,
      kind: isTrackedCli || hasLivePty ? "cli" : "chat",
      title: session?.title ?? "ADE session",
      message,
      laneId: session?.laneId ?? null,
      // Only asks whose headline is the ask itself set these — today that is
      // `ade browser handoff`, which pushes "Sign in for me" / the reason.
      alertTitle: args.alertTitle,
      alertBody: args.alertBody,
    });
  } catch (error) {
    runtime.logger.warn("session.attention_notification_failed", {
      sessionId,
      error: getErrorMessage(error),
    });
  }
  return true;
}

function buildSessionDomainService(runtime: AdeRuntime): OpaqueService | null {
  const sessionService = runtime.sessionService;
  if (!sessionService) return null;
  return {
    ...(sessionService as unknown as OpaqueService),
    async updateMeta(args?: unknown) {
      // Preload prefers this runtime action over IPC, so the IPC rename guard
      // never runs in a connected desktop. Override the spread `updateMeta`.
      const record = (args && typeof args === "object" && !Array.isArray(args)
        ? args
        : {}) as UpdateSessionMetaArgs;
      await assertCursorCloudRenameAllowed(
        runtime.agentChatService
          ? (sessionId) => runtime.agentChatService!.getSessionSummary(sessionId)
          : null,
        record,
      );
      return sessionService.updateMeta(record);
    },
    async list(args?: ListSessionsArgs | null) {
      return listSessionsWithChatProjection(runtime, args ?? {});
    },
    async get(arg?: unknown) {
      const sessionId = readStringActionArg(arg, "sessionId");
      return getSessionWithChatProjection(runtime, sessionId);
    },
    getLifecycleSettings: () => getSessionLifecycleSettings(runtime.db),
    updateLifecycleSettings: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.updateLifecycleSettings");
      if (typeof record.autoSettleLaneSessionsOnPrMerge !== "boolean") {
        throw new Error("autoSettleLaneSessionsOnPrMerge must be a boolean.");
      }
      return setSessionLifecycleSettings({
        db: runtime.db,
        settings: {
          autoSettleLaneSessionsOnPrMerge: record.autoSettleLaneSessionsOnPrMerge,
        },
        currentPrs: runtime.prService?.listAll() ?? [],
      });
    },
    requestSessionAttention: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.requestSessionAttention");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const message = requireNonEmptyString(record.message, "message");
      const raised = requestSessionAttentionForRuntime(runtime, {
        sessionId,
        message,
        alertTitle: optionalNonEmptyString(record.alertTitle),
        alertBody: optionalNonEmptyString(record.alertBody),
      });
      if (!raised) {
        // This action and the two after it are only asked for by agents and
        // the CLI (`ade` status/attention), which can name a session that is
        // gone: their answer, not a fault. The settle/snooze actions below
        // also serve ADE's own Work UI on every machine, where "not found"
        // can be a misrouted call (the wrong machine), so they stay reported.
        throw new AdeExpectedError(`Session '${sessionId}' was not found.`, "user");
      }
      return { ok: true, sessionId };
    },
    setSessionStatusNote: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.setSessionStatusNote");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      if (typeof record.note !== "string") {
        throw new Error("setSessionStatusNote requires a string `note` field.");
      }
      if (!sessionService.setStatusNote(sessionId, record.note || null)) {
        throw new AdeExpectedError(`Session '${sessionId}' was not found.`, "user");
      }
      return { ok: true, sessionId };
    },
    setSessionActivity: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.setSessionActivity");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const value = record.value;
      if (value !== null && typeof value !== "string") {
        throw new Error("setSessionActivity requires a supported string `value` or null.");
      }
      if (!sessionService.setSessionActivity(sessionId, value)) {
        throw new AdeExpectedError(`Session '${sessionId}' was not found.`, "user");
      }
      return { ok: true, sessionId, value };
    },
    // -----------------------------------------------------------------------
    // There is deliberately NO `settleSelfSession` / `unsettleSelfSession`
    // pair here any more (removed 2026-07). An agent used to be able to file
    // its own Work row into the quiet tier via `ade chat settle` — but whether
    // work is genuinely finished is a subjective judgment, and agents are
    // unreliable at making it. A chat that settles itself vanishes from the
    // user's active list on the agent's say-so, which is exactly the wrong
    // default. Settlement now has only two writers:
    //   1. a human, through the desktop rows/bulk actions or the `ade code`
    //      TUI (both connect at cto role, hence the CTO-only gate above), and
    //   2. the deterministic PR-merge policy in
    //      services/prs/prMergeAutoSettlementService.ts, which calls
    //      sessionService directly and never touches this bridge.
    // If you are about to re-add a caller-scoped settle action, don't: the
    // product decision is that agents declare outcomes in prose, not by
    // mutating lifecycle columns.
    // -----------------------------------------------------------------------
    settleSession: async (args?: unknown) => {
      const record = readObjectActionArg(args, "session.settleSession");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const outcome = typeof record.outcome === "string" && record.outcome.trim()
        ? record.outcome
        : undefined;
      const dismissPendingInput = record.dismissPendingInput === true;
      if (!await settleTerminalSession({
        sessionId,
        opts: {
          ...(outcome ? { outcome } : {}),
          ...(dismissPendingInput ? { dismissPendingInput: true } : {}),
          source: "user",
        },
        sessionService,
        agentChatService: runtime.agentChatService,
        ptyService: runtime.ptyService,
      })) {
        throw new Error(`Session '${sessionId}' was not found.`);
      }
      return { ok: true, sessionId };
    },
    // Single-row unsettle for the same user-driven surfaces as `settleSession`
    // (desktop row menu on a remote-bound project, `ade code`'s
    // `/session unsettle`). It is the undo for a user's own settle, so it is
    // gated identically — an agent lifting a settle the user deliberately took
    // is the same category of problem as an agent taking one.
    unsettleSession: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.unsettleSession");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      if (!sessionService.unsettleSession(sessionId)) {
        throw new Error(`Session '${sessionId}' was not found.`);
      }
      return { ok: true, sessionId };
    },
    // Bulk settle/unsettle for renderer surfaces on remote-bound projects
    // (mirrors deleteSession's generic trust posture).
    settleSessions: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.settleSessions");
      const sessionIds = Array.isArray(record.sessionIds)
        ? record.sessionIds.filter((id): id is string => typeof id === "string")
        : [];
      // The sync remote-command path honours `dismissPendingInput` for a single
      // session. This bulk action does not, and used to drop the key silently —
      // so the same argument meant "dismiss the prompt" over sync and nothing at
      // all here. Fail loudly instead of settling while quietly ignoring half of
      // what was asked; `session.settleSession` is the path that dismisses.
      //
      // Why the flag lives on the PLURAL action over sync at all, since that
      // looks backwards from here: mobile cannot reach the singular one —
      // `session.settleSession` is absent from the mobile compatibility lists
      // in `shared/syncMobileCompatibility.ts`, so the phone only ever has
      // `settleSessions`. This registry has no such constraint, so it refuses
      // rather than duplicating the single-id special case.
      if (record.dismissPendingInput === true) {
        throw new Error(
          "session.settleSessions does not dismiss pending input; use session.settleSession for a single session.",
        );
      }
      return sessionService.settleSessions(sessionIds);
    },
    unsettleSessions: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.unsettleSessions");
      const sessionIds = Array.isArray(record.sessionIds)
        ? record.sessionIds.filter((id): id is string => typeof id === "string")
        : [];
      sessionService.unsettleSessions(sessionIds);
      return { ok: true };
    },
    /**
     * Work a settle could not confirm it stopped (design 3d option 3).
     *
     * Read-only, and the reason it exists: option 3 was signed off on the
     * condition that the residue stay DISCOVERABLE rather than merely recorded.
     * Without a read path, "settled" would quietly mean "and something may still
     * be running" — the exact outcome the option was chosen to avoid.
     */
    getSettleResidue: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.getSettleResidue");
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
      if (!sessionId) throw new Error("session.getSettleResidue requires sessionId.");
      return sessionService.getSettleResidue(sessionId) ?? { recordedAt: null, items: [] };
    },
    // -----------------------------------------------------------------------
    // Snooze / wake / settle-override. Snooze is a synced VISIBILITY overlay:
    // it hides a row until its deadline without touching lifecycle columns, so
    // an agent can quiet something it is waiting on and let a hand-raise
    // (needs-you, error, turn-complete) wake it early.
    // -----------------------------------------------------------------------
    snoozeSession: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.snoozeSession");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const untilIso = requireSnoozeDeadline(record.untilIso);
      if (!sessionService.snoozeSession(sessionId, untilIso)) {
        throw new Error(`Session '${sessionId}' was not found.`);
      }
      return { ok: true, sessionId, snoozedUntil: untilIso };
    },
    snoozeSessions: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.snoozeSessions");
      const sessionIds = readSessionIdList(record.sessionIds, "session.snoozeSessions");
      const untilIso = requireSnoozeDeadline(record.untilIso);
      return sessionService.snoozeSessions(sessionIds, untilIso);
    },
    wakeSession: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.wakeSession");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const reason = readWakeReason(record.reason, "session.wakeSession");
      return { ok: sessionService.wakeSession(sessionId, reason), sessionId, reason };
    },
    wakeSessions: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.wakeSessions");
      const sessionIds = readSessionIdList(record.sessionIds, "session.wakeSessions");
      const reason = readWakeReason(record.reason, "session.wakeSessions");
      return sessionService.wakeSessions(sessionIds, reason);
    },
    setSettleOverride: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.setSettleOverride");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const override = readSettleOverride(record.override, "session.setSettleOverride");
      if (!sessionService.setSettleOverride(sessionId, override)) {
        throw new Error(`Session '${sessionId}' was not found.`);
      }
      return { ok: true, sessionId, settleOverride: override };
    },
    ...createSessionBoardMoveActions({
      sessionService,
      agentChatService: runtime.agentChatService,
      logger: runtime.logger,
    }),
    clearWokeMarker: (args?: unknown) => {
      const record = readObjectActionArg(args, "session.clearWokeMarker");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      if (!sessionService.clearWokeMarker(sessionId)) {
        throw new Error(`Session '${sessionId}' was not found.`);
      }
      return { ok: true, sessionId };
    },
    deleteSession: (arg?: { sessionId?: string } | string) => {
      const sessionId = typeof arg === "string"
        ? requireNonEmptyString(arg, "sessionId")
        : requireNonEmptyString(arg?.sessionId, "sessionId");
      return deleteTerminalSessionWithRuntimeCleanup({
        sessionId,
        sessionService,
        ptyService: requireService(runtime.ptyService, "Terminal service not available."),
      });
    },
    readTranscriptTail: (args?: ReadTranscriptTailArgs) => {
      const sessionId = requireNonEmptyString(args?.sessionId, "sessionId");
      const maxBytes = typeof args?.maxBytes === "number" && Number.isFinite(args.maxBytes)
        ? Math.max(1024, Math.min(2_000_000, Math.floor(args.maxBytes)))
        : 160_000;
      return runtime.ptyService?.readTranscriptTail({
        sessionId,
        maxBytes,
        raw: args?.raw === true,
        alignToLineBoundary: args?.raw === true,
      }) ?? "";
    },
    getDelta: (args?: { sessionId?: string } | string) => {
      const sessionId = typeof args === "string"
        ? requireNonEmptyString(args, "sessionId")
        : requireNonEmptyString(args?.sessionId, "sessionId");
      return runtime.sessionDeltaService?.getSessionDelta(sessionId) ?? null;
    },
    backfillDeltas: (args?: { limit?: number; since?: string | null }) => {
      const limit = typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(1_000, Math.floor(args.limit)))
        : 500;
      const since = typeof args?.since === "string" && args.since.trim()
        ? args.since.trim()
        : null;
      return runtime.sessionDeltaService?.backfillMissingSessionDeltas({ limit, since }) ?? {
        scanned: 0,
        computed: 0,
        skipped: 0,
        failed: 0,
      };
    },
  };
}

function requireService<T>(service: T | null | undefined, message: string): T {
  if (!service) throw new Error(message);
  return service;
}

async function resolveLane(runtime: AdeRuntime, laneId: string) {
  const lanes = await runtime.laneService.list({ includeArchived: true, includeStatus: false });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`Lane not found: ${laneId}`);
  return lane;
}

async function resolveActiveLaneIds(runtime: AdeRuntime): Promise<string[]> {
  const lanes = await runtime.laneService.list({ includeArchived: false, includeStatus: false });
  return lanes.map((lane) => lane.id);
}

/**
 * Thin AdeRuntime adapter over the shared resolver in `lanes/laneOverlayContext`.
 * `includeArchived` matches `resolveLane` above: the action domain resolves
 * lanes that may already be archived.
 */
async function resolveLaneOverlayContextForRuntime(runtime: AdeRuntime, laneId: string) {
  return await resolveLaneOverlayContext(
    {
      laneService: runtime.laneService,
      projectConfigService: runtime.projectConfigService,
      portAllocationService: runtime.portAllocationService,
      laneEnvironmentService: runtime.laneEnvironmentService,
    },
    laneId,
    { includeArchived: true },
  );
}

/** Deps for `lane.getDependencyStatus` / `lane.acknowledgeDependencyStatus`: the main checkout of this runtime's project. */
function laneDependencyStatusDeps(runtime: AdeRuntime): LaneDependencyStatusDeps {
  return {
    projectRoot: runtime.projectRoot,
    cacheDir: runtime.paths.cacheDir,
    getDefaultTemplateId: () => runtime.laneTemplateService?.getDefaultTemplateId() ?? null,
    getTemplateCount: () => runtime.laneTemplateService?.listTemplates().length ?? 0,
    logger: runtime.logger,
  };
}

/** Deps for the shared `runLaneEnvironmentSetup` (lane.initEnv / lane.applyTemplate, and `create_lane`'s setup). */
export function laneEnvironmentSetupDeps(
  runtime: AdeRuntime,
  laneEnvironmentService: NonNullable<AdeRuntime["laneEnvironmentService"]>,
): LaneEnvironmentSetupDeps {
  return {
    laneService: runtime.laneService,
    projectConfigService: runtime.projectConfigService,
    portAllocationService: runtime.portAllocationService,
    laneEnvironmentService,
    laneTemplateService: runtime.laneTemplateService ?? null,
  };
}

async function ensureLanePreviewInfo(runtime: AdeRuntime, laneId: string): Promise<LanePreviewInfo | null> {
  const laneProxyService = runtime.laneProxyService;
  const portAllocationService = runtime.portAllocationService;
  if (!laneProxyService || !portAllocationService) return null;

  const lane = await resolveLane(runtime, laneId).catch(() => null);
  if (!lane || lane.archivedAt != null) {
    laneProxyService.removeRoute(laneId);
    return null;
  }

  const lease = portAllocationService.getLease(laneId) ?? portAllocationService.acquire(laneId);
  if (lease.status !== "active") {
    laneProxyService.removeRoute(laneId);
    return null;
  }

  if (!laneProxyService.getStatus().running) {
    await laneProxyService.start().catch((error: unknown) => {
      runtime.logger.warn("lane_proxy.preview_start_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  if (!laneProxyService.getStatus().running) return null;

  const expectedHostname = laneProxyService.generateHostname(laneId, lane.name);
  const health = runtime.runtimeDiagnosticsService
    ? await runtime.runtimeDiagnosticsService.checkLaneHealth(laneId).catch(() => null)
    : null;
  const respondingPort = Number.isInteger(health?.respondingPort)
    && (health?.respondingPort as number) >= lease.rangeStart
    && (health?.respondingPort as number) <= lease.rangeEnd
    ? (health?.respondingPort as number)
    : null;
  const targetPort = respondingPort ?? lease.rangeStart;
  const currentRoute = laneProxyService.getRoute(laneId);
  if (
    !currentRoute ||
    currentRoute.targetPort !== targetPort ||
    currentRoute.hostname !== expectedHostname ||
    currentRoute.status !== "active"
  ) {
    laneProxyService.addRoute(laneId, targetPort, lane.name);
  }
  return laneProxyService.getPreviewInfo(laneId);
}

function buildLaneDomainService(runtime: AdeRuntime): OpaqueService {
  const laneService = runtime.laneService as unknown as OpaqueService;
  const findLaneForArchive = async (laneId: string) => {
    if (typeof runtime.laneService.list !== "function") return null;
    return runtime.laneService
      .list({ includeArchived: true, includeStatus: false })
      .then((lanes) => lanes.find((lane) => lane.id === laneId) ?? null)
      .catch(() => null);
  };
  const notifyLaneArchived = (lane: Awaited<ReturnType<typeof findLaneForArchive>>): void => {
    if (!lane) return;
    runtime.automationService?.onLaneArchived?.({
      laneId: lane.id,
      laneName: lane.name,
      branchRef: lane.branchRef,
      folder: lane.folder ?? null,
    });
  };
  /**
   * The lane id a positional lane action runs against. Two callers hand it over
   * two ways: a CLI command sends it positionally (an `argsList` holding one
   * string), while an automation step — whose editor renders the schema's
   * `laneId` param — and `run_ade_action`'s `args` send the object `{ laneId }`.
   * `getDeleteRisk` and `cancelDelete` take a bare lane id and pass it straight
   * to a `select * from lanes` lookup, and `node:sqlite` refuses an object as a
   * bound parameter ("Unsupported database value at parameter 1: object"), so
   * reading both shapes here is what keeps the object out of the query.
   * `lane.getSummary` needs only the object shape; these two also have
   * positional callers.
   */
  const readLaneIdActionArg = (args: unknown, actionName: string): string =>
    typeof args === "string"
      ? requireNonEmptyString(args, "laneId")
      : requireNonEmptyString(readObjectActionArg(args, actionName).laneId, "laneId");
  return {
    ...laneService,
    getSummary: async (args?: unknown) => {
      const record = readObjectActionArg(args, "lane.getSummary");
      const laneId = requireNonEmptyString(record.laneId, "laneId");
      return runtime.laneService.getSummary(laneId, {
        includeStatus: record.includeStatus !== false,
      });
    },
    getDeleteRisk: async (args?: unknown) =>
      runtime.laneService.getDeleteRisk(readLaneIdActionArg(args, "lane.getDeleteRisk")),
    cancelDelete: async (args?: unknown) =>
      runtime.laneService.cancelDelete(readLaneIdActionArg(args, "lane.cancelDelete")),
    listSnapshots: async (args?: ListLanesArgs): Promise<LaneListSnapshot[]> => {
      const lanes = await runtime.laneService.list({
        includeArchived: Boolean(args?.includeArchived),
        includeStatus: args?.includeStatus !== false,
      });
      return buildLaneListSnapshots(
        {
          laneService: runtime.laneService,
          sessionService: runtime.sessionService,
          ptyService: runtime.ptyService,
          agentChatService: runtime.agentChatService ?? null,
          conflictService: runtime.conflictService ?? null,
          syncService: runtime.syncService ?? null,
          logger: runtime.logger,
        },
        lanes,
        {
          includeConflictStatus: args?.includeConflictStatus !== false,
        },
      );
    },
    /**
     * Branch-drift status read. Returns `null` when the worktree HEAD still
     * matches the lane's recorded branch — the common case — so agents can poll
     * it cheaply before a PR or checkout operation.
     */
    getBranchDrift: async (args?: unknown) => {
      const record = readObjectActionArg(args, "lane.getBranchDrift");
      const laneId = requireNonEmptyString(record.laneId, "laneId");
      return runtime.laneService.getBranchDrift({ laneId });
    },
    resolveBranchDrift: async (args?: unknown) => {
      const record = readObjectActionArg(args, "lane.resolveBranchDrift");
      const laneId = requireNonEmptyString(record.laneId, "laneId");
      const resolution = readBranchDriftResolution(record.resolution, "lane.resolveBranchDrift");
      const expectedHeadBranchRef = typeof record.expectedHeadBranchRef === "string"
        ? record.expectedHeadBranchRef.trim()
        : "";
      return runtime.laneService.resolveBranchDrift({
        laneId,
        resolution,
        ...(expectedHeadBranchRef ? { expectedHeadBranchRef } : {}),
        ...(record.acknowledgeActiveWork === true ? { acknowledgeActiveWork: true } : {}),
      });
    },
    archive: async (args?: { laneId?: string }): Promise<void> => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const lane = await findLaneForArchive(laneId);
      // Docker teardown runs inside `laneService.archive` via the late-bound
      // env-teardown hook, so every archive path gets it, not just this one.
      await runtime.laneService.archive({ laneId });
      try {
        releaseLaneRuntimeResources(runtime, laneId);
      } finally {
        notifyLaneArchived(lane);
      }
    },
    delete: async (args?: DeleteLaneArgs): Promise<DeleteLaneResult> => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const teardownEnv = await buildLaneEnvTeardown(runtime, laneId, { includeArchived: true });
      const result = await runtime.laneService.delete({ ...(args ?? {}), laneId }, { teardownEnv });
      releaseLaneRuntimeResources(runtime, laneId);
      return result;
    },
    getLeftoverWorktree: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      return runtime.laneService.getLeftoverWorktree(laneId);
    },
    deleteLeftoverWorktree: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      return runtime.laneService.deleteLeftoverWorktree(laneId);
    },
    archiveAndReclaim: async (args?: ArchiveAndReclaimLaneArgs) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      if (args?.confirmation !== "RECLAIM") {
        throw new Error('archiveAndReclaim requires confirmation: "RECLAIM".');
      }
      const lane = await findLaneForArchive(laneId);
      const teardownEnv = await buildLaneEnvTeardown(runtime, laneId, { includeArchived: true });
      const result = await runtime.laneService.archiveAndReclaim(
        {
          laneId,
          confirmation: "RECLAIM",
          ...(args.forceDirty === true ? { forceDirty: true } : {}),
        },
        {
          onArchived: () => {
            try {
              releaseLaneRuntimeResources(runtime, laneId);
            } finally {
              notifyLaneArchived(lane);
            }
          },
          teardownEnv,
        },
      );
      return result;
    },
    unarchive: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const result = await runtime.laneService.unarchive({ laneId });
      try {
        await restoreUnarchivedLaneRuntime(runtime, laneId, {
          worktreeRecreated: result.worktreeRecreated === true,
          onDockerError: (error) => {
            runtime.logger.warn("lane_env_setup.post_unarchive_docker_failed", {
              laneId,
              error: getErrorMessage(error),
            });
          },
        });
        return result;
      } catch (error) {
        return { ...result, setupWarning: getErrorMessage(error) };
      }
    },
    initEnv: async (args?: { laneId?: string }): Promise<LaneEnvInitProgress> => {
      const laneEnvironmentService = requireService(runtime.laneEnvironmentService, "Lane environment service not available.");
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      return runLaneEnvironmentSetup(laneEnvironmentSetupDeps(runtime, laneEnvironmentService), { laneId });
    },
    getEnvStatus: (args?: { laneId?: string }) =>
      runtime.laneEnvironmentService?.getProgress(requireNonEmptyString(args?.laneId, "laneId")) ?? null,
    getOverlay: async (args?: { laneId?: string }) => {
      const context = await resolveLaneOverlayContextForRuntime(runtime, requireNonEmptyString(args?.laneId, "laneId"));
      return context.overrides;
    },
    listTemplates: () => runtime.laneTemplateService?.listTemplates() ?? [],
    getTemplate: (args?: { templateId?: string }) =>
      runtime.laneTemplateService?.getTemplate(requireNonEmptyString(args?.templateId, "templateId")) ?? null,
    getDefaultTemplate: () => runtime.laneTemplateService?.getDefaultTemplateId() ?? null,
    setDefaultTemplate: (args?: { templateId?: string | null }) => {
      requireService(runtime.laneTemplateService, "Lane template service not available.").setDefaultTemplateId(args?.templateId ?? null);
    },
    applyTemplate: async (args?: ApplyLaneTemplateArgs): Promise<LaneEnvInitProgress> => {
      // runLaneEnvironmentSetup throws "Lane template service not available." itself.
      const laneEnvironmentService = requireService(runtime.laneEnvironmentService, "Lane environment service not available.");
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const templateId = requireNonEmptyString(args?.templateId, "templateId");
      return runLaneEnvironmentSetup(laneEnvironmentSetupDeps(runtime, laneEnvironmentService), { laneId, templateId });
    },
    saveTemplate: (args?: { template?: unknown }) => {
      const template = args?.template;
      if (!template || typeof template !== "object" || Array.isArray(template)) {
        throw new Error("Lane template payload is required.");
      }
      requireService(runtime.laneTemplateService, "Lane template service not available.").saveTemplate(template as Parameters<NonNullable<AdeRuntime["laneTemplateService"]>["saveTemplate"]>[0]);
    },
    deleteTemplate: (args?: { templateId?: string }) => {
      requireService(runtime.laneTemplateService, "Lane template service not available.").deleteTemplate(requireNonEmptyString(args?.templateId, "templateId"));
    },
    getDependencyStatus: (args?: GetLaneDependencyStatusArgs): Promise<LaneDependencyStatus> =>
      readLaneDependencyStatus(laneDependencyStatusDeps(runtime), { refresh: args?.refresh === true }),
    acknowledgeDependencyStatus: (args?: AcknowledgeLaneDependencyStatusArgs): Promise<LaneDependencyStatus> => {
      const lockfiles = Array.isArray(args?.lockfiles)
        ? args.lockfiles.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : undefined;
      // Only an omitted list means "all"; an empty one changes nothing.
      if (lockfiles && lockfiles.length === 0) {
        return readLaneDependencyStatus(laneDependencyStatusDeps(runtime), { refresh: true });
      }
      return acknowledgeLaneDependencyStatus(laneDependencyStatusDeps(runtime), lockfiles ? { lockfiles } : {});
    },
    portGetLease: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await ensureActiveLanePortLease(runtime, laneId);
      return runtime.portAllocationService?.getLease(laneId) ?? null;
    },
    portListLeases: () => runtime.portAllocationService?.listLeases() ?? [],
    portAcquire: async (args?: { laneId?: string }) => {
      const lease = await ensureActiveLanePortLease(runtime, requireNonEmptyString(args?.laneId, "laneId"));
      if (!lease) throw new Error("Port allocation service not available.");
      return lease;
    },
    portRelease: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      releaseLaneRuntimeResources(runtime, laneId);
    },
    portListConflicts: () => runtime.portAllocationService?.listConflicts() ?? [],
    portRecoverOrphans: async () => {
      if (!runtime.portAllocationService) return [];
      const validIds = new Set(await resolveActiveLaneIds(runtime));
      return runtime.portAllocationService.recoverOrphans(validIds);
    },
    proxyGetStatus: (): ProxyStatus => runtime.laneProxyService?.getStatus() ?? { running: false, proxyPort: 8080, routes: [] },
    proxyStart: (args?: { port?: number }) => requireService(runtime.laneProxyService, "Proxy service not available.").start(args?.port),
    proxyStop: async () => {
      await runtime.laneProxyService?.stop();
    },
    proxyAddRoute: async (args?: { laneId?: string; targetPort?: number }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const targetPort = args?.targetPort;
      if (!Number.isInteger(targetPort) || Number(targetPort) <= 0) {
        throw new Error("targetPort must be a positive integer.");
      }
      const lane = await resolveLane(runtime, laneId);
      return requireService(runtime.laneProxyService, "Proxy service not available.").addRoute(laneId, Number(targetPort), lane.name);
    },
    proxyRemoveRoute: (args?: { laneId?: string }) =>
      runtime.laneProxyService?.removeRoute(requireNonEmptyString(args?.laneId, "laneId")),
    proxyGetPreviewInfo: (args?: { laneId?: string }) =>
      ensureLanePreviewInfo(runtime, requireNonEmptyString(args?.laneId, "laneId")),
    oauthGetStatus: () => runtime.oauthRedirectService?.getStatus() ?? { enabled: false, routingMode: "state-parameter", activeSessions: [], callbackPaths: [] },
    oauthUpdateConfig: (args?: Record<string, unknown>) => {
      requireService(runtime.oauthRedirectService, "OAuth redirect service not available.").updateConfig(args ?? {});
    },
    oauthGenerateRedirectUris: (args?: { provider?: string }) =>
      runtime.oauthRedirectService?.generateRedirectUris(args?.provider) ?? [],
    oauthEncodeState: (args?: { laneId?: string; originalState?: string }) =>
      requireService(runtime.oauthRedirectService, "OAuth redirect service not available.").encodeState(
        requireNonEmptyString(args?.laneId, "laneId"),
        typeof args?.originalState === "string" ? args.originalState : "",
      ),
    oauthDecodeState: (args?: { encodedState?: string }) =>
      runtime.oauthRedirectService?.decodeState(requireNonEmptyString(args?.encodedState, "encodedState")) ?? null,
    oauthListSessions: () => runtime.oauthRedirectService?.listSessions() ?? [],
    diagnosticsGetStatus: async () => {
      const laneIds = await resolveActiveLaneIds(runtime);
      return runtime.runtimeDiagnosticsService?.getStatus(laneIds) ?? {
        lanes: [],
        proxyRunning: false,
        proxyPort: runtime.laneProxyService?.getStatus().proxyPort ?? 0,
        totalRoutes: 0,
        activeConflicts: 0,
        fallbackLanes: [],
      };
    },
    diagnosticsGetLaneHealth: (args?: { laneId?: string }) =>
      runtime.runtimeDiagnosticsService?.getLaneHealth(requireNonEmptyString(args?.laneId, "laneId")) ?? null,
    diagnosticsRunHealthCheck: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      return requireService(runtime.runtimeDiagnosticsService, "Runtime diagnostics service not available.").checkLaneHealth(laneId);
    },
    diagnosticsRunFullCheck: async () => {
      const laneIds = await resolveActiveLaneIds(runtime);
      return runtime.runtimeDiagnosticsService?.checkAllLanes(laneIds) ?? [];
    },
    diagnosticsActivateFallback: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      runtime.runtimeDiagnosticsService?.activateFallback(laneId);
    },
    diagnosticsDeactivateFallback: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      runtime.runtimeDiagnosticsService?.deactivateFallback(laneId);
    },
  };
}

// Bridge provider sign-in status transitions onto each runtime's event buffer
// so remote/web clients (which drain runtimeEvents over the sync/relay channel)
// mirror them, exactly like desktop windows do over IPC. Registered once per
// runtime; the listeners are detached when the runtime is disposed.
const authStatusBridgedRuntimes = new WeakSet<AdeRuntime>();
function ensureAuthStatusRelayBridges(runtime: AdeRuntime): void {
  if (!runtime.eventBuffer || authStatusBridgedRuntimes.has(runtime)) return;
  authStatusBridgedRuntimes.add(runtime);
  const push = (kind: string, event: unknown): void => {
    try {
      runtime.eventBuffer.push({
        timestamp: new Date().toISOString(),
        category: "runtime",
        payload: { kind, event },
      });
    } catch {
      // A full/broken buffer must not break the sign-in flow.
    }
  };
  const unsubscribeOpenCode = addOpenCodeOAuthStatusListener((event) => push("opencodeOAuthStatus", event));
  const unsubscribePi = addPiAuthStatusListener((event) => push("piAuthStatus", event));
  const unsubscribeCursor = addCursorSdkAuthStatusListener((event) => push("cursorAuthStatus", event));
  const dispose = runtime.dispose;
  runtime.dispose = () => {
    unsubscribeOpenCode();
    unsubscribePi();
    unsubscribeCursor();
    dispose();
  };
}

function buildAiDomainService(runtime: AdeRuntime): OpaqueService | null {
  const aiIntegrationService = runtime.aiIntegrationService;
  if (!aiIntegrationService) return null;
  ensureAuthStatusRelayBridges(runtime);
  /**
   * Drop the readiness caches after a key changed.
   *
   * Never throws: the store mutation has already succeeded by the time this
   * runs, so a missing cache must not turn a saved key into a failed call.
   */
  const invalidateReadiness = (provider: string): void => {
    try {
      aiIntegrationService.invalidateProviderReadinessCaches();
    } catch (error) {
      runtime.logger.warn("ai.machine_api_key_cache_invalidation_failed", {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const accountSettingsStore = runtime.accountSettingsStore;
  // OpenCode account changes are provider-account decisions, recorded like
  // Claude and Codex accounts: the harness family only, never the upstream
  // provider, label or account.
  const captureOpenCodeAccount = providerAccountAnalyticsCapture(runtime.productAnalyticsService, "api");
  const captureOpenCodeAccountOutcome = <T extends { ok: boolean }>(
    action: "account_created" | "account_signed_out" | "default_selected",
    result: T,
  ): T => {
    if (result.ok) captureOpenCodeAccount(action, "completed", "opencode");
    return result;
  };
  const buildOpenCodeAuthDeps = (): OpenCodeAuthDeps => ({
    projectRoot: runtime.projectRoot,
    projectConfig: runtime.projectConfigService.getEffective(),
    logger: runtime.logger,
    // Cloud logins are saved to the ADE account through the brain's store.
    accountSettings: accountSettingsStore
      ? {
          isSignedIn: () => runtime.accountAuthService?.getStatus().signedIn === true,
          get: (scope, key) => accountSettingsStore.get(scope, key),
          set: (scope, key, value) => accountSettingsStore.set(scope, key, value),
        }
      : null,
  });
  return {
    getStatus: (args?: { force?: boolean; refreshOpenCodeInventory?: boolean }) =>
      buildAiSettingsStatus(aiIntegrationService, args),
    // Jev decisions for renderer features and `ade actions run`. A runtime
    // without the helper answers like a failed call: null, use the fallback.
    jevDecide: (args?: JevDecideRequest) =>
      runtime.jevService && args ? runtime.jevService.decide(args) : Promise.resolve(null),
    jevStatus: () => runtime.jevService?.status() ?? null,
    opencodeAuthMethods: () => listOpenCodeAuthMethods(buildOpenCodeAuthDeps()),
    opencodeOAuthStart: (args?: { providerId?: string; methodIndex?: number; inputs?: Record<string, string> }) =>
      startOpenCodeOAuth(buildOpenCodeAuthDeps(), {
        providerId: requireNonEmptyString(args?.providerId, "providerId"),
        methodIndex: typeof args?.methodIndex === "number" ? args.methodIndex : 0,
        inputs: args?.inputs,
      }),
    opencodeOAuthCancel: (args?: { providerId?: string }) => {
      cancelOpenCodeOAuth({ providerId: requireNonEmptyString(args?.providerId, "providerId") });
    },
    setOpencodeProviderKey: (args?: { providerId?: string; key?: string }) =>
      setOpenCodeProviderKey(buildOpenCodeAuthDeps(), {
        providerId: requireNonEmptyString(args?.providerId, "providerId"),
        key: requireNonEmptyString(args?.key, "key"),
      }),
    clearOpencodeProviderKey: (args?: { providerId?: string }) =>
      clearOpenCodeProviderKey(buildOpenCodeAuthDeps(), {
        providerId: requireNonEmptyString(args?.providerId, "providerId"),
      }),
    opencodeAccounts: (args?: { providerId?: string | null }) =>
      listOpenCodeAccounts(buildOpenCodeAuthDeps(), { providerId: args?.providerId ?? null }),
    opencodeAccountActivate: async (args?: { id?: string }) =>
      captureOpenCodeAccountOutcome(
        "default_selected",
        await activateOpenCodeAccount(buildOpenCodeAuthDeps(), { id: requireNonEmptyString(args?.id, "id") }),
      ),
    opencodeAccountRename: (args?: { id?: string; label?: string }) =>
      renameOpenCodeAccount(buildOpenCodeAuthDeps(), {
        id: requireNonEmptyString(args?.id, "id"),
        label: requireNonEmptyString(args?.label, "label"),
      }),
    opencodeAccountRemove: async (args?: { id?: string }) =>
      captureOpenCodeAccountOutcome(
        "account_signed_out",
        await removeOpenCodeAccount(buildOpenCodeAuthDeps(), { id: requireNonEmptyString(args?.id, "id") }),
      ),
    opencodeCloudConnect: async (args?: {
      providerId?: string;
      methodIndex?: number;
      inputs?: Record<string, string>;
      label?: string;
    }) =>
      captureOpenCodeAccountOutcome(
        "account_created",
        await connectOpenCodeCloudLogin(buildOpenCodeAuthDeps(), {
          providerId: requireNonEmptyString(args?.providerId, "providerId"),
          methodIndex: typeof args?.methodIndex === "number" ? args.methodIndex : 0,
          inputs: args?.inputs,
          ...(typeof args?.label === "string" ? { label: args.label } : {}),
        }),
      ),
    // Diagnostics report on ADE's pinned CLI on the machine this runtime runs
    // on. Exposed as an action so Settings can show another machine's copy
    // through that machine's own runtime, rather than reading This
    // computer's answer and labelling it theirs.
    acpProviderDiagnostics: (args?: { provider?: string; runDoctor?: boolean }) => {
      const provider = args?.provider;
      if (!isAcpChatProvider(provider)) throw new Error("provider must be one of qwen, kimi, grok, devin.");
      return collectAcpProviderDiagnostics({
        provider,
        cwd: runtime.projectRoot,
        ...(args?.runDoctor === true ? { runDoctor: true } : {}),
      });
    },
    piLoginProviders: () => listPiLoginProviders(),
    piLoginStart: async (args?: { providerId?: string; method?: "oauth" | "api_key" }) => {
      const providerId = requireNonEmptyString(args?.providerId, "providerId");
      const result = await startPiLogin({
        providerId,
        ...(args?.method ? { method: args.method } : {}),
      });
      // Signing in unlocks models, so the readiness cache is stale until it is
      // dropped. The IPC handler does the same; this keeps the action path
      // (remote runtime, `ade actions run`) consistent with it.
      if (result.ok) {
        try {
          aiIntegrationService.invalidateProviderReadinessCaches();
        } catch (error) {
          runtime.logger.warn("ai.pi_auth_cache_invalidation_failed", {
            provider: providerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    },
    piLoginSubmit: (args?: { providerId?: string; requestId?: string; value?: string }) =>
      submitPiLoginPrompt({
        providerId: requireNonEmptyString(args?.providerId, "providerId"),
        requestId: requireNonEmptyString(args?.requestId, "requestId"),
        value: typeof args?.value === "string" ? args.value : "",
      }),
    piLoginCancel: (args?: { providerId?: string }) => {
      cancelPiLogin({ providerId: requireNonEmptyString(args?.providerId, "providerId") });
    },
    cursorAuthStatus: () => getCursorSdkAuthStatus(),
    cursorAuthLogin: async () => {
      const result = await loginCursorSdk();
      if (result.ok) {
        try {
          aiIntegrationService.invalidateProviderReadinessCaches();
        } catch (error) {
          runtime.logger.warn("ai.cursor_auth_cache_invalidation_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    },
    cursorAuthLogout: async () => {
      const result = await logoutCursorSdk();
      try {
        aiIntegrationService.invalidateProviderReadinessCaches();
      } catch (error) {
        runtime.logger.warn("ai.cursor_auth_cache_invalidation_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    },
    cursorAuthCancel: () => {
      cancelCursorSdkLogin();
    },
    // Custom providers: every model a harness can reach outside its own
    // sign-in, a one-token live check, and the terminal launcher's env.
    listHarnessRoutes: (args?: { harness?: unknown }) => {
      const catalog = listHarnessRouteCatalog();
      // Echo a valid filter so a text formatter (`ade harness routes
      // --harness claude`) can show just that harness; the catalog itself is
      // harness-independent.
      return isHarnessPresetBody(args?.harness) ? { ...catalog, harness: args.harness } : catalog;
    },
    testHarnessRoute: (args?: { harness?: unknown; source?: unknown; model?: unknown }) =>
      testHarnessRoute({ harness: args?.harness, source: args?.source, model: args?.model }),
    harnessLaunchEnv: async (args?: { presetId?: string; shell?: string }) => {
      const presetId = requireNonEmptyString(args?.presetId, "presetId");
      // A translated route needs ADE's proxy running before it can resolve,
      // exactly as a chat or CLI launch does.
      await prepareHarnessLaunch({ provider: "", presetId });
      return buildHarnessLaunchEnv(
        {
          presetId,
          ...(args?.shell === "pwsh" || args?.shell === "bash" || args?.shell === "zsh" ? { shell: args.shell } : {}),
        },
        (id) => resolveHarnessPresetForLaunch(id),
      );
    },
    refreshModelsDev: async () => {
      try {
        await refreshModelsDevNow();
      } catch {
        // Surfaced via lastFetchedAt staleness; never throw from a refresh nudge.
      }
      return { lastFetchedAt: getModelsDevLastFetchedAt() };
    },
    getOpenCodeRuntimeDiagnostics: async () => {
      const { getOpenCodeRuntimeDiagnostics } = await import("../opencode/openCodeServer");
      const { servers } = getOpenCodeRuntimeDiagnostics();
      const sharedCount = servers.filter((server) => server.shared).length;
      return { sharedCount, dedicatedCount: servers.length - sharedCount, entries: servers };
    },
    isOpenCodeInstalled: async () => {
      const { resolveOpenCodeBinary } = await import("../opencode/openCodeBinaryManager");
      const info = resolveOpenCodeBinary();
      return { installed: Boolean(info.path), source: info.source };
    },
    // The pinned Muse binary on THIS machine. `ensureMuseBinary` starts a
    // background fetch and returns at once (330-470 MB must not hold a remote
    // action open); callers poll `museBinaryStatus` for progress.
    museBinaryStatus: async () => {
      const { getMuseBinaryStatus } = await import("../ai/museExecutable");
      return getMuseBinaryStatus();
    },
    ensureMuseBinary: async () => {
      const { startMuseBinaryFetch } = await import("../ai/museExecutable");
      return startMuseBinaryFetch();
    },
    // ADE's pinned copy of any provider's tool on THIS machine, for the
    // Settings rows and chat cards of a chat or lane that lives here.
    // `pinnedToolDownload` starts (or joins) the download and returns at
    // once; callers poll `pinnedToolStatus` for progress.
    pinnedToolStatus: async (args?: { provider?: string }) => {
      const provider = requireNonEmptyString(args?.provider, "provider");
      const { getPinnedProviderToolStatus } = await import("../ai/pinnedProviderTools");
      return getPinnedProviderToolStatus(provider);
    },
    // What a provider's agent receives when a lane chat starts on THIS
    // machine: ADE's own text, the user's and project's files, and the
    // measured first turn: a provider page's Initial context window.
    getProviderContextInventory: async (args?: unknown) => {
      const { getProviderContextInventory } = await import("../ai/providerContextInventory");
      return getProviderContextInventory(
        {
          projectRoot: runtime.projectRoot,
          agentChatService: runtime.agentChatService ?? null,
          logger: runtime.logger,
        },
        args,
      );
    },
    pinnedToolDownload: async (args?: { provider?: string }) => {
      const provider = requireNonEmptyString(args?.provider, "provider");
      const { startPinnedProviderToolDownload } = await import("../ai/pinnedProviderTools");
      return startPinnedProviderToolDownload(provider);
    },
    // Antigravity sign-in on THIS machine: the ACP `authenticate` request run
    // by ADE's pinned agent here. A browser elsewhere pastes the 127.0.0.1
    // address Google ended on (`antigravitySignInComplete`), which is forwarded
    // to the agent's listener on this machine only.
    antigravitySignInStatus: async () => {
      const { getAntigravitySignInState } = await import("../ai/antigravitySignIn");
      return getAntigravitySignInState();
    },
    antigravitySignInStart: async (args?: AntigravitySignInStartArgs) => {
      const { startAntigravitySignIn, setAntigravitySignInLogger } = await import("../ai/antigravitySignIn");
      setAntigravitySignInLogger(runtime.logger);
      return startAntigravitySignIn(args as AntigravitySignInStartArgs);
    },
    antigravitySignInComplete: async (args?: AntigravitySignInCompleteArgs) => {
      const { completeAntigravitySignIn } = await import("../ai/antigravitySignIn");
      return completeAntigravitySignIn({
        flowId: requireNonEmptyString(args?.flowId, "flowId"),
        callbackUrl: requireNonEmptyString(args?.callbackUrl, "callbackUrl"),
      });
    },
    antigravitySignInCancel: async (args?: AntigravitySignInCancelArgs) => {
      const { cancelAntigravitySignIn } = await import("../ai/antigravitySignIn");
      return cancelAntigravitySignIn({ flowId: requireNonEmptyString(args?.flowId, "flowId") });
    },
    // Settings > Providers > Muse Code on THIS machine: plugins, marketplaces,
    // skills, hooks, computer use and feedback, through a short-lived
    // Settings-owned `muse serve` host per page visit (never a chat's host).
    museSettings: async (args?: { handleId?: string; request?: unknown }) => {
      const { runMuseSettingsFor, parseMuseSettingsRunArgs } = await import("../ai/museSettingsService");
      return runMuseSettingsFor(
        {
          projectRoot: runtime.projectRoot,
          logger: runtime.logger,
          clientVersion: process.env.ADE_CLI_VERSION?.trim() || undefined,
        },
        parseMuseSettingsRunArgs(args),
      );
    },
    museSettingsClose: async (args?: { handleId?: string }) => {
      const { closeMuseSettingsHost } = await import("../ai/museSettingsService");
      await closeMuseSettingsHost(requireNonEmptyString(args?.handleId, "handleId"));
      return { ok: true as const };
    },
    verifyApiKeyConnection: (args?: { provider?: string }) =>
      aiIntegrationService.verifyApiKeyConnection(requireNonEmptyString(args?.provider, "provider")),
    storeApiKey: (args?: { provider?: string; key?: string }) =>
      aiIntegrationService.storeApiKey(
        requireNonEmptyString(args?.provider, "provider"),
        requireNonEmptyString(args?.key, "key"),
      ),
    deleteApiKey: (args?: { provider?: string }) =>
      aiIntegrationService.deleteApiKey(requireNonEmptyString(args?.provider, "provider")),
    listApiKeys: () => aiIntegrationService.listApiKeys(),
    // The multi-key credential store, as the desktop's `apiCredentials` IPC
    // exposes it, so Settings can list and edit another machine's keys through
    // that machine's own runtime. Summaries only; a key value never comes back.
    listApiCredentials: (args?: { provider?: string }) =>
      listApiCredentials(typeof args?.provider === "string" && args.provider ? args.provider : undefined),
    getApiCredential: (args?: { provider?: string; credentialId?: string }) =>
      getApiCredentialSummary(
        requireNonEmptyString(args?.provider, "provider"),
        typeof args?.credentialId === "string" && args.credentialId ? args.credentialId : undefined,
      ),
    storeApiCredential: (args?: Partial<ApiCredentialStoreArgs>) => {
      const provider = requireNonEmptyString(args?.provider, "provider");
      const credentialId = storeApiCredential({
        ...(args as ApiCredentialStoreArgs),
        provider,
        label: typeof args?.label === "string" ? args.label : "",
        key: requireNonEmptyString(args?.key, "key"),
      });
      invalidateReadiness(provider);
      return getApiCredentialSummary(provider, credentialId);
    },
    removeApiCredential: (args?: { provider?: string; credentialId?: string }) => {
      const provider = requireNonEmptyString(args?.provider, "provider");
      removeApiCredential(
        provider,
        typeof args?.credentialId === "string" && args.credentialId ? args.credentialId : undefined,
      );
      invalidateReadiness(provider);
    },
    updateConfig: (partial?: Partial<AiConfig>) => {
      const projectConfigService = requireService(runtime.projectConfigService, "Project config service not available.");
      projectConfigService.updateAiConfig(partial ?? {});
      void runtime.agentChatService?.refreshScheduledWork();
    },
    listCursorCloudRepositories: (args?: { refresh?: boolean }) =>
      aiIntegrationService.listCursorCloudRepositories({ refresh: args?.refresh === true }),
    listCursorCloudAgents: (args?: { includeArchived?: boolean; limit?: number; cursor?: string | null }) =>
      aiIntegrationService.listCursorCloudAgents(args ?? {}),
    listCursorCloudRuns: (args?: { agentId?: string; limit?: number; cursor?: string | null }) =>
      aiIntegrationService.listCursorCloudRuns({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        ...(args?.limit !== undefined ? { limit: args.limit } : {}),
        ...(args?.cursor !== undefined ? { cursor: args.cursor } : {}),
      }),
    createCursorCloudRun: (args: Parameters<typeof aiIntegrationService.createCursorCloudRun>[0]) =>
      aiIntegrationService.createCursorCloudRun(args),
    getCursorCloudLaneSecretNames: (args?: { laneId?: string }) =>
      aiIntegrationService.getCursorCloudLaneSecretNames(requireNonEmptyString(args?.laneId, "laneId")),
    archiveCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.archiveCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    unarchiveCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.unarchiveCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    deleteCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.deleteCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    getCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.getCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    getCursorAgentUsage: (args?: { agentId?: string; runId?: string | null }) =>
      aiIntegrationService.getCursorAgentUsage({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        ...(typeof args?.runId === "string" ? { runId: args.runId } : {}),
      }),
    listCursorCloudArtifacts: async (args?: { agentId?: string }) => {
      const items = await aiIntegrationService.listCursorCloudArtifacts(requireNonEmptyString(args?.agentId, "agentId"));
      return items.map((entry) => ({
        path: entry.path,
        ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
      }));
    },
    downloadCursorCloudArtifact: (args?: { agentId?: string; path?: string }) =>
      aiIntegrationService.downloadCursorCloudArtifact({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        path: requireNonEmptyString(args?.path, "path"),
      }),
    cursorCloudStreamRun: (args?: { agentId?: string; runId?: string }) => {
      const agentId = requireNonEmptyString(args?.agentId, "agentId");
      const runId = requireNonEmptyString(args?.runId, "runId");
      return { subscriptionId: `cursor-cloud-stream-${agentId}-${runId}` };
    },
    cancelCursorCloudRun: (args?: { agentId?: string; runId?: string }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").cancelCursorCloudRun({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        runId: requireNonEmptyString(args?.runId, "runId"),
      }),
    cursorCloudFollowUp: (args?: {
      agentId?: string;
      prompt?: string;
      idempotencyKey?: string | null;
      modelId?: string | null;
      serviceTier?: CursorCloudServiceTier | null;
    }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").cursorCloudFollowUp({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        prompt: requireNonEmptyString(args?.prompt, "prompt"),
        ...(args?.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
        ...(args?.modelId !== undefined ? { modelId: args.modelId } : {}),
        ...(args?.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {}),
      }),
    openCursorCloudChat: (args?: {
      cloudAgentId?: string;
      laneId?: string;
      sessionId?: string;
      modelId?: string;
      reasoningEffort?: string | null;
      fastMode?: boolean | null;
      serviceTier?: CursorCloudServiceTier | null;
    }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").openCursorCloudChat({
        cloudAgentId: requireNonEmptyString(args?.cloudAgentId, "cloudAgentId"),
        laneId: requireNonEmptyString(args?.laneId, "laneId"),
        ...(args?.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args?.modelId ? { modelId: args.modelId } : {}),
        ...(args?.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
        ...(args?.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
        ...(args?.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {}),
      }),
    watchCursorCloudMirror: (args?: { sessionId?: string; watching?: boolean }) => {
      if (typeof args?.watching !== "boolean") {
        throw new Error("Expected 'watching' to be a boolean.");
      }
      requireService(runtime.agentChatService, "Agent chat service not available.").watchCursorCloudMirror({
        sessionId: requireNonEmptyString(args?.sessionId, "sessionId"),
        watching: args.watching,
      });
    },
    getCursorCloudFleet: (args?: { includeArchived?: boolean; limit?: number }) =>
      requireService(runtime.cursorCloudFleetService, "Cursor Cloud fleet not available.").getFleet({
        includeArchived: args?.includeArchived !== false,
        ...(args?.limit !== undefined ? { limit: args.limit } : {}),
      }),
    resolveCursorCloudAgentLane: (args?: { agentId?: string }) =>
      requireService(runtime.cursorCloudFleetService, "Cursor Cloud fleet not available.").resolveLaneForAgent(
        requireNonEmptyString(args?.agentId, "agentId"),
      ),
    pullCursorCloudAgentIntoLane: (args?: { agentId?: string }) =>
      requireService(runtime.cursorCloudFleetService, "Cursor Cloud fleet not available.").pullIntoLane(
        requireNonEmptyString(args?.agentId, "agentId"),
      ),
    stopCursorCloudAgentRun: (args?: { agentId?: string }) =>
      requireService(runtime.cursorCloudFleetService, "Cursor Cloud fleet not available.").stopAgentRun(
        requireNonEmptyString(args?.agentId, "agentId"),
      ),
    listCloudAgents: (args?: { provider?: string; force?: boolean }) =>
      requireService(runtime.cloudAgentsService, "Cloud agents are not available.").list({
        provider: requireCloudAgentProvider(args?.provider),
        ...(args?.force !== undefined ? { force: args.force === true } : {}),
      }),
    openCloudAgent: (args?: { provider?: string; id?: string }) =>
      requireService(runtime.cloudAgentsService, "Cloud agents are not available.").open({
        provider: requireCloudAgentProvider(args?.provider),
        id: requireNonEmptyString(args?.id, "id"),
      }),
    stopCloudAgent: (args?: { provider?: string; id?: string }) =>
      requireService(runtime.cloudAgentsService, "Cloud agents are not available.").stop({
        provider: requireCloudAgentProvider(args?.provider),
        id: requireNonEmptyString(args?.id, "id"),
      }),
    launchCloudAgent: (args?: { provider?: string; prompt?: string; model?: string | null; platform?: string | null; laneId?: string | null }) =>
      requireService(runtime.cloudAgentsService, "Cloud agents are not available.").launch({
        provider: requireCloudAgentProvider(args?.provider),
        prompt: requireNonEmptyString(args?.prompt, "prompt"),
        model: typeof args?.model === "string" ? args.model : null,
        platform: typeof args?.platform === "string" ? args.platform : null,
        laneId: typeof args?.laneId === "string" && args.laneId.trim() ? args.laneId.trim() : null,
      }),
    archiveCloudAgent: (args?: { provider?: string; id?: string; archived?: boolean }) =>
      requireService(runtime.cloudAgentsService, "Cloud agents are not available.").archive({
        provider: requireCloudAgentProvider(args?.provider),
        id: requireNonEmptyString(args?.id, "id"),
        archived: args?.archived !== false,
      }),
  };
}

const AI_SETTINGS_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "terminal_summaries",
  "initial_context",
];

async function buildAiSettingsStatus(
  aiIntegrationService: NonNullable<AdeRuntime["aiIntegrationService"]>,
  options?: { force?: boolean; refreshOpenCodeInventory?: boolean },
): Promise<AiSettingsStatus> {
  const status = await aiIntegrationService.getStatus({
    force: options?.force === true,
    refreshOpenCodeInventory: options?.refreshOpenCodeInventory === true,
  });
  const usageBatch = aiIntegrationService.getDailyUsageBatch(AI_SETTINGS_FEATURE_KEYS);
  return {
    mode: status.mode,
    availableProviders: status.availableProviders,
    models: status.models,
    detectedAuth: status.detectedAuth,
    providerConnections: status.providerConnections,
    runtimeConnections: status.runtimeConnections,
    availableModelIds: status.availableModelIds,
    opencodeBinaryInstalled: status.opencodeBinaryInstalled,
    opencodeBinarySource: status.opencodeBinarySource,
    opencodeInventoryError: status.opencodeInventoryError,
    opencodeProviders: status.opencodeProviders,
    piInstallation: status.piInstallation,
    apiKeyStore: status.apiKeyStore,
    features: AI_SETTINGS_FEATURE_KEYS.map((feature) => ({
      feature,
      enabled: aiIntegrationService.getFeatureFlag(feature),
      dailyUsage: usageBatch.get(feature) ?? 0,
      dailyLimit: aiIntegrationService.getDailyBudgetLimit(feature),
    })),
    // The `ade-harnesses` skill tells agents to read these two from
    // `ade actions run ai getStatus`; this projection is that call's only
    // source, so dropping them left the documented contract unanswerable from
    // the CLI even though the renderer's IPC status carried them.
    ...(status.harnessPresets?.length ? { harnessPresets: status.harnessPresets } : {}),
    ...(status.providerAccounts?.length ? { providerAccounts: status.providerAccounts } : {}),
  };
}

function clampDockLayout(layout: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(layout)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = Math.max(0, Math.min(100, value));
  }
  return out;
}

type LayoutService = {
  get(args: { layoutId?: unknown }): unknown;
  set(args: { layoutId?: unknown; layout?: unknown }): { layoutId: string; layout: Record<string, number> };
};

function buildLayoutDomainService(runtime: AdeRuntime): LayoutService | null {
  if (!runtime.db) return null;
  return {
    get(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      return runtime.db.getJson(`dock_layout:${layoutId}`);
    },
    set(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      if (!args || !Object.prototype.hasOwnProperty.call(args, "layout")) {
        throw new Error("Missing required 'layout' object. Pass an explicit null to clear.");
      }
      const rawLayout = args.layout;
      let layout: Record<string, number>;
      if (rawLayout === null) {
        layout = {};
      } else if (rawLayout && typeof rawLayout === "object" && !Array.isArray(rawLayout)) {
        layout = clampDockLayout(rawLayout as Record<string, unknown>);
      } else {
        throw new Error("Expected 'layout' to be a plain object or null.");
      }
      runtime.db.setJson(`dock_layout:${layoutId}`, layout);
      return { layoutId, layout };
    },
  };
}

type TilingTreeService = {
  get(args: { layoutId?: unknown }): unknown;
  set(args: { layoutId?: unknown; tree?: unknown }): { layoutId: string; tree: unknown };
};

function buildTilingTreeDomainService(runtime: AdeRuntime): TilingTreeService | null {
  if (!runtime.db) return null;
  return {
    get(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      return runtime.db.getJson(`tiling_tree:${layoutId}`);
    },
    set(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      if (!args || !Object.prototype.hasOwnProperty.call(args, "tree")) {
        throw new Error("Missing required 'tree'. Pass an explicit null to clear.");
      }
      const tree = args.tree;
      if (tree !== null && (typeof tree !== "object" || Array.isArray(tree))) {
        throw new Error("Expected 'tree' to be a plain object or null.");
      }
      runtime.db.setJson(`tiling_tree:${layoutId}`, tree);
      return { layoutId, tree };
    },
  };
}

type TerminalDomainService = {
  list(args?: unknown): unknown;
  read(args?: unknown): Promise<unknown>;
  preview(args?: unknown): Promise<unknown>;
  write(args?: unknown): Promise<unknown>;
  resize(args?: unknown): unknown;
  signal(args?: unknown): unknown;
  activeForChat(args?: unknown): unknown;
  reattachChatCli(args?: unknown): Promise<unknown>;
  watch(args?: unknown): Promise<unknown>;
  unwatch(args?: unknown): unknown;
  listWatches(args?: unknown): unknown;
};

function buildPrDomainService(runtime: AdeRuntime): OpaqueService | null {
  const prService = runtime.prService;
  if (!prService) return null;

  return {
    ...(prService as unknown as OpaqueService),
    // `conditional: true` (newer desktops): `{ prs, signature, notModified }`,
    // so a chat switch whose machine's PR list did not change downloads a
    // signature instead of every PR (half a megabyte on a busy project). Other
    // callers, and every client before this, get the bare array.
    listAll(args?: unknown) {
      const actionArgs = args && typeof args === "object" && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {};
      const laneId = typeof actionArgs.laneId === "string" ? actionArgs.laneId : undefined;
      const prs = prService.listAll(laneId ? { laneId } : {});
      if (actionArgs.conditional !== true) return prs;
      const signature = createHash("sha256").update(JSON.stringify(prs)).digest("hex");
      const ifNoneMatch = typeof actionArgs.ifNoneMatch === "string" ? actionArgs.ifNoneMatch : null;
      return ifNoneMatch === signature
        ? { signature, notModified: true }
        : { prs, signature, notModified: false };
    },
  };
}

function buildGithubDomainService(runtime: AdeRuntime): OpaqueService | null {
  const githubService = runtime.githubService;
  if (!githubService) return null;
  return {
    ...(githubService as unknown as OpaqueService),
    async listRepoLabels(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoLabels(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async listRepoAutolinks(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoAutolinks(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async createRepoAutolink(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.createRepoAutolink(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        {
          keyPrefix: requireNonEmptyString(actionArgs.keyPrefix, "keyPrefix"),
          urlTemplate: requireNonEmptyString(actionArgs.urlTemplate, "urlTemplate"),
          isAlphanumeric: actionArgs.isAlphanumeric === true,
        },
      );
    },
    async getAppInstallationStatus(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.getAppInstallationStatus({
        owner: typeof actionArgs.owner === "string" ? actionArgs.owner : undefined,
        name: typeof actionArgs.name === "string" ? actionArgs.name : undefined,
        forceRefresh: actionArgs.forceRefresh === true,
      });
    },
    async listRepoCollaborators(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoCollaborators(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async listRepoIssues(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const state = actionArgs.state;
      return githubService.listRepoIssues(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        {
          state: state === "open" || state === "closed" || state === "all" ? state : "open",
        },
      );
    },
    async getIssue(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const number = typeof actionArgs.number === "number"
        ? actionArgs.number
        : Number(actionArgs.number);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error("Expected 'number' to be a positive integer.");
      }
      return githubService.getIssue(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        number,
      );
    },
    async getRepoIssueSummary(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.getRepoIssueSummary(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async createIssue(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.createIssue(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        parseGitHubIssueCreateInput(actionArgs.input),
      );
    },
    async listIssueTemplates(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listIssueTemplates(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async linkSubIssue(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const parentNumber = Number(actionArgs.parentNumber);
      const childNumber = Number(actionArgs.childNumber);
      if (!Number.isInteger(parentNumber) || parentNumber <= 0 || !Number.isInteger(childNumber) || childNumber <= 0) {
        throw new Error("Expected positive integer 'parentNumber' and 'childNumber'.");
      }
      return githubService.linkSubIssue(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        parentNumber,
        childNumber,
      );
    },
    async listIssueTypes(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listIssueTypes(requireNonEmptyString(actionArgs.owner, "owner"));
    },
    async getIssueWriteAccess(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.getIssueWriteAccess(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        { force: actionArgs.force === true },
      );
    },
    async updateIssue(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const number = Number(actionArgs.number);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error("Expected 'number' to be a positive integer.");
      }
      return githubService.updateIssue(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        number,
        parseGitHubIssueUpdate(actionArgs.patch),
      );
    },
    async commentOnIssue(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const number = Number(actionArgs.number);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error("Expected 'number' to be a positive integer.");
      }
      return githubService.commentOnIssue(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        number,
        requireNonEmptyString(actionArgs.body, "body"),
      );
    },
    async listRepoMilestones(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoMilestones(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async listRepoIssueList(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoIssueList(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        parseGitHubIssueListState(actionArgs.state),
      );
    },
    async listIssueComments(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const number = typeof actionArgs.number === "number"
        ? actionArgs.number
        : Number(actionArgs.number);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error("Expected 'number' to be a positive integer.");
      }
      return githubService.listIssueComments(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        number,
      );
    },
    async publishCurrentProject(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const isPrivate = actionArgs.isPrivate;
      if (typeof isPrivate !== "boolean") {
        throw new Error("Expected 'isPrivate' to be a boolean.");
      }
      const description = typeof actionArgs.description === "string"
        ? actionArgs.description
        : undefined;
      const owner = typeof actionArgs.owner === "string"
        ? actionArgs.owner.trim()
        : undefined;
      return githubService.publishCurrentProject({
        ...(owner ? { owner } : {}),
        name: requireNonEmptyString(actionArgs.name, "name"),
        description,
        isPrivate,
      });
    },
    async setToken(args?: unknown) {
      githubService.setToken(readStringActionArg(args, "token"));
      const status = await githubService.getStatus();
      const credentialVerification = await githubService.verifyStoredPat(status);
      return { ...status, credentialVerification };
    },
    async clearToken() {
      githubService.clearToken();
      return githubService.getStatus();
    },
  };
}

function buildLinearIssueTrackerDomainService(runtime: AdeRuntime): OpaqueService | null {
  const tracker = runtime.linearIssueTracker;
  if (!tracker) return null;
  const connectionPrecheckCache: LinearConnectionPrecheckCache = {
    checkedAt: 0,
    connection: null,
  };
  return {
    ...(tracker as unknown as OpaqueService),
    async graphql(args?: unknown) {
      await requireRuntimeLinearConnection(runtime, connectionPrecheckCache);
      return tracker.runGraphQL(parseLinearGraphQLInput(asActionRecord(args)));
    },
    async getStatus() {
      return buildRuntimeLinearConnectionStatus(runtime);
    },
    async getConnectionStatus() {
      return buildRuntimeLinearConnectionStatus(runtime);
    },
    async listIssues(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const issues = await tracker.fetchCandidateIssues({
        projectSlugs: asStringArray(actionArgs.projectSlugs ?? actionArgs.projectSlug ?? actionArgs.projects ?? actionArgs.project),
        stateTypes: asStringArray(actionArgs.stateTypes ?? actionArgs.stateType ?? actionArgs.states ?? actionArgs.state),
      });
      const limit = typeof actionArgs.limit === "number" && Number.isFinite(actionArgs.limit)
        ? Math.max(1, Math.min(100, Math.floor(actionArgs.limit)))
        : 20;
      return issues.slice(0, limit);
    },
    async getQuickView(connection?: LinearConnectionStatus): Promise<CtoLinearQuickView> {
      const nextConnection = connection ?? await buildRuntimeLinearConnectionStatus(runtime);
      if (!nextConnection.connected) return createEmptyLinearQuickView(nextConnection);
      try {
        return await tracker.getQuickView(nextConnection);
      } catch (error) {
        return createEmptyLinearQuickView({
          ...nextConnection,
          connected: false,
          viewerId: null,
          viewerName: null,
          checkedAt: nowIso(),
          message: getErrorMessage(error) || "Linear tracker error",
        });
      }
    },
    async getWorkflowCatalog() {
      const [users, labels, states] = await Promise.all([
        tracker.listUsers(),
        tracker.listLabels(),
        tracker.listWorkflowStates(),
      ]);
      return { users, labels, states };
    },
    async getIssuePickerData() {
      return await tracker.getIssuePickerData();
    },
  };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim().length) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

async function buildRuntimeLinearConnectionStatus(runtime: AdeRuntime): Promise<LinearConnectionStatus> {
  const credentialStatus = runtime.linearCredentialService?.getStatus() ?? {
    tokenStored: false,
    authMode: null,
    oauthConfigured: false,
    tokenExpiresAt: null,
  };
  const tokenStored = Boolean(credentialStatus.tokenStored);
  if (!runtime.linearIssueTracker || !tokenStored) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: tokenStored ? "Linear tracker service unavailable." : "Linear token not configured.",
    };
  }
  try {
    const status = await runtime.linearIssueTracker.getConnectionStatus();
    return {
      tokenStored,
      connected: status.connected,
      viewerId: status.viewerId,
      viewerName: status.viewerName,
      organizationId: status.organizationId ?? null,
      organizationName: status.organizationName ?? null,
      organizationUrlKey: status.organizationUrlKey ?? null,
      organizationLogoUrl: status.organizationLogoUrl ?? null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: formatLinearConnectionMessage(status.message, credentialStatus.authMode),
    };
  } catch (error) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: formatLinearConnectionMessage(
        getErrorMessage(error) || "Linear connection check failed.",
        credentialStatus.authMode,
      ),
    };
  }
}

const LINEAR_CONNECTION_PRECHECK_TTL_MS = 30_000;

type LinearConnectionPrecheckCache = {
  checkedAt: number;
  connection: LinearConnectionStatus | null;
};

async function requireRuntimeLinearConnection(
  runtime: AdeRuntime,
  cache?: LinearConnectionPrecheckCache,
): Promise<LinearConnectionStatus> {
  const now = Date.now();
  if (
    cache?.connection?.connected
    && now - cache.checkedAt < LINEAR_CONNECTION_PRECHECK_TTL_MS
  ) {
    return cache.connection;
  }
  const connection = await buildRuntimeLinearConnectionStatus(runtime);
  if (connection.connected) {
    if (cache) {
      cache.connection = connection;
      cache.checkedAt = now;
    }
    return connection;
  }
  if (cache) {
    cache.connection = null;
    cache.checkedAt = 0;
  }
  const message = connection.message?.trim();
  const error = new Error(message ? `Linear is not connected: ${message}` : "Linear is not connected.");
  Object.assign(error, { code: "LINEAR_NOT_CONNECTED", connection });
  throw error;
}

function formatLinearConnectionMessage(
  message: string | null | undefined,
  authMode: "manual" | "oauth" | null | undefined,
): string | null {
  const trimmed = message?.trim();
  if (
    authMode === "manual"
    && trimmed
    && /authentication required|not authenticated/i.test(trimmed)
  ) {
    return "Linear rejected the API key. Paste a Linear personal API key from linear.app/settings/api; it should start with lin_api_.";
  }
  return trimmed || null;
}

function buildLinearOAuthDomainService(runtime: AdeRuntime): OpaqueService | null {
  const service = runtime.linearOAuthService;
  if (!service) return null;
  return {
    async startSession() {
      return service.startSession();
    },
    async getSession(args?: unknown) {
      const session = service.getSession(readStringActionArg(args, "sessionId"));
      if (session.status !== "completed") {
        return session;
      }
      return {
        ...session,
        connection: await buildRuntimeLinearConnectionStatus(runtime),
      };
    },
  };
}

function buildLinearAgentDomainService(runtime: AdeRuntime): OpaqueService | null {
  const agentRuntime = runtime.linearAgentRuntime;
  const oauth = runtime.linearOAuthService;
  if (!agentRuntime) return null;
  return {
    async getOverview() {
      return agentRuntime.getOverview();
    },
    /** Opens Linear's consent screen for an `actor=app` install; poll getInstallSession. */
    async startInstall() {
      if (!oauth) throw new Error("Linear sign-in is unavailable in this runtime.");
      return oauth.startSession({ purpose: "agent-install" });
    },
    async getInstallSession(args?: unknown) {
      if (!oauth) throw new Error("Linear sign-in is unavailable in this runtime.");
      return oauth.getSession(readStringActionArg(args, "sessionId"));
    },
    async registerMember(args?: unknown) {
      await agentRuntime.relay.registerMember({ replace: asActionRecord(args).replace === true });
      return agentRuntime.getOverview();
    },
    async unregisterMember() {
      await agentRuntime.relay.unregisterMember();
      return agentRuntime.getOverview();
    },
    async updateSettings(args?: unknown) {
      const record = asActionRecord(args);
      const fallbackMode = record.fallbackMode === "runner" ? "runner" : "reply";
      await agentRuntime.relay.updateSettings({ fallbackMode, runner: record.runner === "self" ? "self" : null });
      return agentRuntime.getOverview();
    },
    async uninstall() {
      await agentRuntime.relay.uninstall();
      return agentRuntime.getOverview();
    },
  };
}

function createEmptyLinearQuickView(connection: LinearConnectionStatus): CtoLinearQuickView {
  return {
    connection,
    organization: null,
    viewer: null,
    projects: [],
    teams: [],
    assignedIssues: [],
    recentIssues: [],
    fetchedAt: nowIso(),
    sdk: {
      packageName: "@linear/sdk",
      surfaces: [],
    },
  };
}

function buildFileDomainService(runtime: AdeRuntime): OpaqueService | null {
  const fileService = runtime.fileService;
  if (!fileService) return null;
  return {
    ...(fileService as unknown as OpaqueService),
    async watchWorkspace(args?: unknown): Promise<{ ok: true }> {
      const actionArgs = asActionRecord(args);
      const senderId = readRuntimeFileWatchSenderId(actionArgs);
      await fileService.watchWorkspace(
        toRuntimeFileWatchArgs(actionArgs),
        (event: FileChangeEvent) => {
          runtime.eventBuffer.push({
            timestamp: new Date().toISOString(),
            category: "runtime",
            payload: { type: "file_change", event },
          });
        },
        senderId,
      );
      return { ok: true };
    },
    stopWatching(args?: unknown): { ok: true } {
      const actionArgs = asActionRecord(args);
      const senderId = readRuntimeFileWatchSenderId(actionArgs);
      fileService.stopWatching(
        toRuntimeFileWatchArgs(actionArgs),
        senderId,
      );
      return { ok: true };
    },
  };
}

function buildTerminalDomainService(runtime: AdeRuntime): TerminalDomainService | null {
  if (!runtime.ptyService) return null;
  return {
    list(args) {
      return runtime.ptyService.listTerminals(args as Parameters<typeof runtime.ptyService.listTerminals>[0]);
    },
    read(args) {
      return runtime.ptyService.readTerminal(args as Parameters<typeof runtime.ptyService.readTerminal>[0]);
    },
    preview(args) {
      return runtime.ptyService.previewTerminal(args as Parameters<typeof runtime.ptyService.previewTerminal>[0]);
    },
    async write(args) {
      return await runtime.ptyService.writeTerminal(args as Parameters<typeof runtime.ptyService.writeTerminal>[0]);
    },
    resize(args) {
      return runtime.ptyService.resizeTerminal(args as Parameters<typeof runtime.ptyService.resizeTerminal>[0]);
    },
    signal(args) {
      return runtime.ptyService.signalTerminal(args as Parameters<typeof runtime.ptyService.signalTerminal>[0]);
    },
    activeForChat(args) {
      return runtime.ptyService.activeForChat(args as Parameters<typeof runtime.ptyService.activeForChat>[0]);
    },
    async reattachChatCli(args) {
      return await runtime.ptyService.reattachChatCli(args as Parameters<typeof runtime.ptyService.reattachChatCli>[0]);
    },
    // Terminal watches run where the chat runs. A runtime without one (no chat
    // service) answers plainly instead of advertising a watch nobody delivers.
    async watch(args) {
      return await requireTerminalWatchService(runtime).watch(readTerminalWatchArgs(args));
    },
    unwatch(args) {
      return requireTerminalWatchService(runtime).unwatch(readTerminalUnwatchArgs(args));
    },
    listWatches(args) {
      return runtime.terminalWatchService?.listWatches(readTerminalListWatchesArgs(args)) ?? [];
    },
  };
}

function requireTerminalWatchService(runtime: AdeRuntime): NonNullable<AdeRuntime["terminalWatchService"]> {
  if (!runtime.terminalWatchService) {
    throw new Error("Terminal watches are not available on this runtime: it does not run chats.");
  }
  return runtime.terminalWatchService;
}

function buildSearchDomainService(runtime: AdeRuntime): OpaqueService | null {
  const searchService = runtime.searchService;
  if (!searchService) return null;
  return {
    query(args: unknown) {
      return searchService.query((args ?? {}) as Parameters<typeof searchService.query>[0]);
    },
    indexStatus() {
      return searchService.indexStatus();
    },
    rebuildIndex() {
      return searchService.rebuildIndex();
    },
  } as OpaqueService;
}

function buildExternalSessionsDomainService(runtime: AdeRuntime): OpaqueService | null {
  const externalSessionsService = runtime.externalSessionsService;
  if (!externalSessionsService) return null;
  return {
    list(args: unknown) {
      return externalSessionsService.list((args ?? {}) as Parameters<typeof externalSessionsService.list>[0]);
    },
    import(args: unknown) {
      return externalSessionsService.importExternalSession(
        (args ?? {}) as Parameters<typeof externalSessionsService.importExternalSession>[0],
      );
    },
    getDetail(args: unknown) {
      return externalSessionsService.getDetail(normalizeExternalSessionDetailArgs(args ?? {}));
    },
    // `watchDetail`/`unwatchDetail` are deliberately absent: the watch pushes
    // updates on a per-sender Electron IPC channel this action domain cannot
    // reach, so the desktop bridge keeps them on local IPC. A no-op here would
    // have told a remote caller it was watching when nothing would ever arrive.
  } as OpaqueService;
}

export function buildProviderInstancesDomainService(
  runtime: Pick<AdeRuntime, "productAnalyticsService" | "usageTrackingService">,
): OpaqueService {
  // Machine-local by nature: the registry names directories on THIS machine, so
  // the store is reached through its own ADE-home accessor rather than through
  // the runtime graph. The runtime is used only for the brain-owned analytics
  // sink; every machine still has at least its own default account.
  const store = getMachineProviderInstanceStore();
  const capture = providerAccountAnalyticsCapture(runtime.productAnalyticsService, "api");
  const withAccountUsage = (instances: ReturnType<typeof store.list>) => {
    const usage = runtime.usageTrackingService;
    if (!usage) return instances;

    const report = buildUsageLimitsReport(usage.getUsageSnapshot(), { nowMs: Date.now() });
    const byInstanceId = new Map<string, (typeof report.accounts)[number]>();
    for (const account of report.accounts) {
      if (account.instanceId) byInstanceId.set(account.instanceId, account);
    }

    return instances.map((instance) => {
      const account = byInstanceId.get(instance.id);
      if (!account) return instance;
      return {
        ...instance,
        usage: {
          state: account.state,
          readAt: account.readAt,
          note: account.note,
          windows: account.windows.map((window) => ({
            type: window.type,
            label: window.label,
            percentLeft: window.percentLeft,
            resetsAt: window.resetsAt,
            ...(window.unlimited === true ? { unlimited: true as const } : {}),
            ...(typeof window.countLeft === "number" ? { countLeft: window.countLeft } : {}),
            ...(typeof window.countTotal === "number" ? { countTotal: window.countTotal } : {}),
          })),
        },
      };
    });
  };
  // The registry file caches each account's email and plan from its last
  // refresh. A brain that has never refreshed would list every account as
  // "not signed in" until something else asked, which is what the Accounts
  // panel shows on first open. Refresh once per process on the first list;
  // later lists stay synchronous reads and explicit refreshes stay explicit.
  let accountsRefreshedOnce = false;
  return {
    async list(args: unknown) {
      const provider = isRecord(args) && isProviderInstanceProvider(args.provider) ? args.provider : undefined;
      if (!accountsRefreshedOnce) {
        accountsRefreshedOnce = true;
        await store.refreshAccounts().catch(() => {
          // A failed identity read must not hide the accounts themselves; the
          // list below still returns them, marked not signed in.
        });
      }
      return { instances: withAccountUsage(store.list(provider)) };
    },
    create(args: unknown) {
      const input = isRecord(args) ? args : {};
      const result = store.create({
        provider: input.provider,
        label: input.label,
        accentColor: input.accentColor,
      });
      capture("account_created", "completed", result.instance.provider);
      return result;
    },
    async remove(args: unknown) {
      const id = String((isRecord(args) ? args.id : "") ?? "");
      const provider = store.get(id)?.provider;
      const result = await removeProviderAccount(id);
      capture("account_removed", "completed", provider);
      return result;
    },
    async signOut(args: unknown) {
      const id = String((isRecord(args) ? args.id : "") ?? "");
      const instance = await signOutProviderAccount(id, runtime.usageTrackingService);
      capture("account_signed_out", "completed", instance?.provider);
      return { instance };
    },
    rename(args: unknown) {
      const input = isRecord(args) ? args : {};
      return { instance: store.rename(String(input.id ?? ""), input.label) };
    },
    setDefault(args: unknown) {
      const instance = store.setDefault(String((isRecord(args) ? args.id : "") ?? ""));
      capture("default_selected", "completed", instance.provider);
      return { instance };
    },
    loginStart(args: unknown) {
      return {
        login: getMachineProviderLoginRunner().start(String((isRecord(args) ? args.id : "") ?? ""), {
          deviceAuth: isRecord(args) && args.deviceAuth === true,
        }),
      };
    },
    loginStatus(args: unknown) {
      return { login: getMachineProviderLoginRunner().status(String((isRecord(args) ? args.loginId : "") ?? "")) };
    },
    loginSubmitCode(args: unknown) {
      const input = isRecord(args) ? args : {};
      return { login: getMachineProviderLoginRunner().submitCode(String(input.loginId ?? ""), String(input.code ?? "")) };
    },
    loginCancel(args: unknown) {
      return { login: getMachineProviderLoginRunner().cancel(String((isRecord(args) ? args.loginId : "") ?? "")) };
    },
    dismissReplaced(args: unknown) {
      return { instance: store.dismissReplaced(String((isRecord(args) ? args.id : "") ?? "")) };
    },
    setAccent(args: unknown) {
      const input = isRecord(args) ? args : {};
      const accent = input.accentColor;
      return {
        instance: store.setAccent(
          String(input.id ?? ""),
          typeof accent === "string" ? accent : null,
        ),
      };
    },
    getSettings(args: unknown) {
      const provider = isRecord(args) ? args.provider : undefined;
      if (!isProviderInstanceProvider(provider)) {
        throw new Error('A provider is required: "claude" or "codex".');
      }
      return { settings: store.getProviderSettings(provider) };
    },
    setSettings(args: unknown) {
      const input = isRecord(args) ? args : {};
      if (!isProviderInstanceProvider(input.provider)) {
        throw new Error('A provider is required: "claude" or "codex".');
      }
      const requestedSettings = isRecord(input.settings) ? input.settings : {};
      const settings = store.setProviderSettings(input.provider, {
        ...(Object.hasOwn(requestedSettings, "compaction") ? { compaction: requestedSettings.compaction === null ? null : normalizeCompactionSettings(requestedSettings.compaction) } : {}),
        ...(Object.hasOwn(requestedSettings, "subagentPromptCacheTtl") ? { subagentPromptCacheTtl: requestedSettings.subagentPromptCacheTtl === "1h" ? "1h" as const : null } : {}),
        ...(Object.hasOwn(requestedSettings, "mainPromptCacheTtl") ? { mainPromptCacheTtl: isClaudePromptCacheTtl(requestedSettings.mainPromptCacheTtl) ? requestedSettings.mainPromptCacheTtl : null } : {}),
        ...(Object.hasOwn(requestedSettings, "onExtraUsage") ? { onExtraUsage: requestedSettings.onExtraUsage === "stop" ? "stop" as const : null } : {}),
        ...(typeof requestedSettings.smartBalance === "boolean" ? { smartBalance: requestedSettings.smartBalance } : {}),
        ...(typeof requestedSettings.autoStartWindows === "boolean"
          ? { autoStartWindows: requestedSettings.autoStartWindows }
          : {}),
      }, typeof input.instanceId === "string" ? input.instanceId : undefined);
      captureProviderAccountSettingsChange(capture, {
        settings: requestedSettings,
        provider: input.provider,
        instanceId: typeof input.instanceId === "string" ? input.instanceId : undefined,
      });
      return { settings };
    },
    loginCommand(args: unknown) {
      return { loginCommand: store.loginCommand(String((isRecord(args) ? args.id : "") ?? "")) };
    },
    async refresh(args: unknown) {
      const provider = isRecord(args) && isProviderInstanceProvider(args.provider) ? args.provider : undefined;
      const instanceId = isRecord(args) && typeof args.instanceId === "string" ? args.instanceId : undefined;
      return {
        instances: withAccountUsage(
          await refreshProviderAccounts({ provider, instanceId }, runtime.usageTrackingService),
        ),
      };
    },
  } as OpaqueService;
}

/**
 * The project secret service, plus `request`: ask the person in a chat for a
 * secret through the private secret card. `request` needs the chat service,
 * so it is absent on a runtime without one.
 */
function buildProjectSecretDomainService(runtime: AdeRuntime): OpaqueService | null {
  const projectSecretService = runtime.projectSecretService;
  if (!projectSecretService) return null;
  const agentChatService = runtime.agentChatService;
  return {
    ...(projectSecretService as unknown as OpaqueService),
    // Callers by name (agents, `ade secrets`, the Secrets page) get the copy
    // the account holds now, not whatever the last heartbeat brought in.
    get: (args?: unknown) => projectSecretService.getFresh(args as Parameters<typeof projectSecretService.getFresh>[0]),
    list: () => projectSecretService.listFresh(),
    ...(agentChatService
      ? {
          request: async (args?: unknown) => {
            const capture = (outcome: "completed" | "kept" | "cancelled" | "failed") =>
              captureSecretRequestedAnalytics({ analytics: runtime.productAnalyticsService, surface: "api", outcome });
            try {
              const result = await requestProjectSecretFromUser({
                requestChatInput: (input) => agentChatService.requestChatInput(input),
                projectSecrets: projectSecretService,
                // Written here, on the machine that runs the chat: the answer
                // reaches this runtime wherever the person answered from.
                secretFiles: machineSecretTempFiles(runtime.logger),
              }, args);
              capture(result.saved ? "completed" : "kept" in result && result.kept ? "kept" : "cancelled");
              return result;
            } catch (error) {
              capture("failed");
              throw error;
            }
          },
        }
      : {}),
  };
}

function buildStorageDomainService(runtime: AdeRuntime): OpaqueService | null {
  const storageInsightsService = runtime.storageInsightsService;
  if (!storageInsightsService) return null;
  return {
    getSnapshot: (args?: { forceRefresh?: boolean }) => storageInsightsService.getSnapshot(args),
    compressNow: () => storageInsightsService.compressNow(),
    runMaintenanceNow: () => storageInsightsService.runMaintenanceNow(),
    deletedLaneChatsSummary: () => storageInsightsService.deletedLaneChatsSummary(),
    laneBuildOutputRemoved: (args?: { laneId?: string }) =>
      typeof args?.laneId === "string" && args.laneId.trim()
        ? storageInsightsService.laneBuildOutputRemoved(args.laneId.trim())
        : Promise.resolve(null),
    cleanupPreview: (args?: { targets?: Parameters<typeof storageInsightsService.cleanupPreview>[0] }) =>
      storageInsightsService.cleanupPreview(args?.targets ?? []),
    cleanup: (args?: {
      targets?: Parameters<typeof storageInsightsService.cleanup>[0];
      preview?: Parameters<typeof storageInsightsService.cleanup>[1]["preview"];
    }) => storageInsightsService.cleanup(args?.targets ?? [], {
      preview: args?.preview ?? { items: [], totalBytes: 0, blocked: [] },
    }),
  };
}


/**
 * The usage service's own methods, plus `getUsageLimits`: the quota snapshot
 * cut down to what an agent plans with (`ade usage limits`). It also names the
 * account the asking chat runs on, which the usage service cannot see.
 */
function buildUsageDomainService(runtime: AdeRuntime): OpaqueService | null {
  const usage = runtime.usageTrackingService;
  if (!usage) return null;
  // The account mark is extra: a chat or registry that cannot be read leaves it
  // off and says why in the log, and the limits still come back.
  const chatAccount = async (chatSessionId: string): Promise<{ provider: string; instanceId: string } | null> => {
    try {
      const summary = await runtime.agentChatService?.getSessionSummary(chatSessionId);
      const instanceId = summary ? resolveChatInstanceId(summary.provider, summary.instanceId) : null;
      return summary && instanceId ? { provider: summary.provider, instanceId } : null;
    } catch (error) {
      runtime.logger.warn("usage.limits_chat_account_unavailable", { chatSessionId, error: getErrorMessage(error) });
      return null;
    }
  };
  return {
    ...(usage as unknown as OpaqueService),
    getUsageLimits: async (args?: { provider?: unknown; chatSessionId?: unknown }) => {
      const chatSessionId = typeof args?.chatSessionId === "string" ? args.chatSessionId.trim() : "";
      return buildUsageLimitsReport(usage.getUsageSnapshot(), {
        nowMs: Date.now(),
        provider: typeof args?.provider === "string" ? args.provider : null,
        chat: chatSessionId ? await chatAccount(chatSessionId) : null,
      });
    },
  };
}

function buildProjectHealthDomainService(runtime: AdeRuntime): OpaqueService | null {
  const projectHealthService = runtime.projectHealthService;
  if (!projectHealthService) return null;
  return {
    getReport: (args?: { forceRefresh?: boolean }) => projectHealthService.getReport(args ?? {}),
    fix: (args: { fixId: string }) => projectHealthService.fix(args),
  };
}

export function getAdeActionDomainServices(
  runtime: AdeRuntime,
): Partial<Record<AdeActionDomain, OpaqueService | null | undefined>> {
  const automationsEnabled = areAutomationsEnabledForPackagedState(Boolean(runtime.isPackaged));
  return {
    account: runtime.accountAuthService
      ? toService(createAccountActionDomainService(
          runtime.accountAuthService,
          runtime.productAnalyticsService ?? undefined,
        ))
      : null,
    attention: toService(buildAttentionDomainService(runtime)),
    keep_awake: toService(buildKeepAwakeDomainService(runtime)),
    remote_mcp: toService(buildRemoteMcpDomainService(runtime)),
    lane: toService(buildLaneDomainService(runtime)),
    proxy: toService(buildProxyDomainService(runtime)),
    git: toService(runtime.gitService),
    diff: toService(runtime.diffService),
    conflicts: toService(runtime.conflictService),
    pr: toService(buildPrDomainService(runtime)),
    tests: toService(runtime.testService),
    chat: toService(buildChatDomainService(runtime)),
    keybindings: toService(runtime.keybindingsService),
    ai: toService(buildAiDomainService(runtime)),
    onboarding: toService(runtime.onboardingService),
    automation_planner: automationsEnabled ? toService(runtime.automationPlannerService) : null,
    cto_state: toService(buildCtoStateDomainService(runtime)),
    cto_memory: toService(buildCtoMemoryDomainService(runtime)),
    session: toService(buildSessionDomainService(runtime)),
    operation: toService(runtime.operationService),
    ade_project: toService(runtime.adeProjectService),
    project_config: toService(runtime.projectConfigService),
    project_secret: toService(buildProjectSecretDomainService(runtime)),
    account_settings: buildAccountSettingsDomainService(runtime),
    account_vault: buildAccountVaultDomainService(runtime),
    linear_credentials: toService(runtime.linearCredentialService),
    linear_oauth: buildLinearOAuthDomainService(runtime),
    linear_agent: buildLinearAgentDomainService(runtime),
    linear_issue_tracker: toService(buildLinearIssueTrackerDomainService(runtime)),
    github: buildGithubDomainService(runtime),
    jira: toService(runtime.jiraService),
    issues: toService(runtime.issueTrackerService),
    usage: buildUsageDomainService(runtime),
    analytics: toService(runtime.productAnalyticsService),
    storage: toService(buildStorageDomainService(runtime)),
    project_health: toService(buildProjectHealthDomainService(runtime)),
    archive: toService(createArchiveService(runtime)),
    budget: toService(runtime.budgetCapService),
    update: toService(runtime.autoUpdateService),
    file: toService(buildFileDomainService(runtime)),
    pty: toService(runtime.ptyService),
    terminal: toService(buildTerminalDomainService(runtime)),
    layout: toService(buildLayoutDomainService(runtime)),
    tiling_tree: toService(buildTilingTreeDomainService(runtime)),
    work_tools: toService(runtime.workToolsStateService),
    computer_use_artifacts: toService(buildComputerUseArtifactsDomainService(runtime)),
    ios_simulator: toService(runtime.iosSimulatorService),
    // One private macOS screen per lane. The domain's own readers and its
    // platform gate live beside the service in `macDesktopActionDomain.ts`.
    mac_desktop: toService(buildMacDesktopDomainService(runtime)),
    app_control: toService(runtime.appControlService),
    built_in_browser: toService(runtime.builtInBrowserService),
    automations: automationsEnabled ? toService(buildAutomationsDomainService(runtime)) : null,
    issue: toService(buildIssueDomainService(runtime)),
    search: toService(buildSearchDomainService(runtime)),
    "external-sessions": toService(buildExternalSessionsDomainService(runtime)),
    provider_instances: toService(buildProviderInstancesDomainService(runtime)),
  };
}

/**
 * The action lookup `ade-action` automation steps run through. Same allowlist
 * and rule as `run_ade_action`; `getServices` is read on every call, so
 * late-bound services are seen.
 */
export function createAutomationAdeActionLookup(
  getServices: () => Partial<Record<AdeActionDomain, unknown>>,
): AutomationAdeActionRegistry {
  return {
    isAllowed(domain, action) {
      return isAutomationAllowedAdeAction(domain as AdeActionDomain, action);
    },
    getService(domain) {
      return (getServices()[domain as AdeActionDomain] ?? null) as Record<string, unknown> | null;
    },
    listDomains() {
      return Object.keys(ADE_ACTION_ALLOWLIST);
    },
    listActions(domain) {
      return [...(ADE_ACTION_ALLOWLIST[domain as AdeActionDomain] ?? [])]
        // Same rule as `isAllowed`, so nothing listed is refused when run.
        .filter((action) => isAutomationAllowedAdeAction(domain as AdeActionDomain, action));
    },
  };
}
