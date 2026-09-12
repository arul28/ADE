import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
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
import { getLastFetchedAt as getModelsDevLastFetchedAt, refreshNow as refreshModelsDevNow } from "../ai/modelsDevService";
import {
  BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import type {
  AutomationManualTriggerRequest,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
  AutomationRuleSummary,
  AutomationScheduledCleanup,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
} from "../../../shared/types/automations";
import type {
  AttentionPreferenceScope,
  AttentionPreferences,
  AttentionPresence,
} from "../../../shared/types/attention";
import type { ComputerUseOwnerSnapshotArgs } from "../../../shared/types/computerUseArtifacts";
import {
  loadExternalSessionDetail,
  normalizeExternalSessionDetailArgs,
} from "../externalSessions/externalSessionDetail";
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
  PromptStashCreateArgs,
  PromptStashDeleteArgs,
} from "../../../shared/types/chat";
import type { AutomationRule } from "../../../shared/types/config";
import { stripHostOnlyChatMetadata } from "../../../shared/chatAutoResume";
import { areAutomationsEnabledForPackagedState } from "../../../shared/automationAvailability";
import type { LinearIngressStatus } from "../automations/linearIngressService";
import {
  buildPrAiResolutionContextKey,
  isTrackedAgentCliToolType,
} from "../../../shared/types";
import {
  createPromptStash,
  deletePromptStash,
  listPromptStashes,
} from "../chat/promptStashService";
import type {
  AiConfig,
  ApplyLaneTemplateArgs,
  ArchiveAndReclaimLaneArgs,
  DeleteLaneArgs,
  FileChangeEvent,
  LaneEnvInitProgress,
  LaneListSnapshot,
  LanePreviewInfo,
  ListSessionsArgs,
  ListLanesArgs,
  UpdateSessionMetaArgs,
  PrAgentPermissionMode,
  PrAiResolutionContext,
  PrAiResolutionEventPayload,
  PrAiResolutionGetSessionResult,
  PrAiResolutionInputArgs,
  PrAiResolutionSessionInfo,
  PrAiResolutionSessionStatus,
  PrAiResolutionStartArgs,
  PrAiResolutionStartResult,
  ReadTranscriptTailArgs,
  PrAiResolutionStopArgs,
  ProxyStatus,
  AiFeatureKey,
  AiSettingsStatus,
  CtoAttentionState,
  CtoRunProjectScanResult,
  CtoLinearQuickView,
  LinearConnectionStatus,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  legacyAttachmentCapMessage,
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
import {
  mergeLaneEnvInitConfig,
  mergeLaneOverrides,
} from "../lanes/laneEnvInitMerge";
import { resolveLaneOverlayContext } from "../lanes/laneOverlayContext";
import { mergeAiConfig } from "../config/projectConfigService";
import { appendDiffTruncationNotice, MAX_DIFF_SIDE_TEXT_BYTES } from "../diffs/diffService";
import { runGit } from "../git/git";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import { buildLaneListSnapshots } from "../lanes/laneListSnapshotService";
import { mapPermissionModeForModelFamily } from "../prs/resolverUtils";
import { getErrorMessage, isPathEscapeError, isRecord, nowIso, resolvePathWithinRoot } from "../shared/utils";
import { parseLinearGraphQLInput } from "../cto/linearGraphQLInput";
import type { CtoMemoryTags } from "../cto/ctoMemoryService";
import { launchAgentChatCli } from "../chat/agentChatCliLaunch";
import { assertCursorCloudRenameAllowed } from "../../../shared/cursorCloudNaming";
import { deleteTerminalSessionWithRuntimeCleanup } from "../sessions/deleteTerminalSession";
import { settleTerminalSession } from "../sessions/settleTerminalSession";
import {
  getSessionLifecycleSettings,
  setSessionLifecycleSettings,
} from "../sessions/sessionLifecycleSettings";
import {
  getSessionWithChatProjection,
  listSessionsWithChatProjection,
} from "../sessions/chatSessionProjection";
import { createOrchestrationDomainService } from "../orchestration/orchestrationDomain";
import { createAccountActionDomainService } from "../../../../../ade-cli/src/services/account/accountAuthService";

// The names themselves live in `./domains`, which has no imports, so consumers
// that need only the vocabulary (the analytics policy) do not have to load this
// module's whole service graph to get it. Re-exported here because this is
// where every existing caller looks for them.
import type { AdeActionDomain } from "./domains";
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
  requireNonEmptyString,
  requireSnoozeDeadline,
  toRuntimeFileWatchArgs,
} from "./actionArgs";
import { createSessionBoardMoveActions } from "./sessionBoardMove";

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
  listAllowedAdeActionNames,
  scopeAccountStatusForRole,
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
};

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

function buildOrchestrationDomainService(runtime: AdeRuntime): OpaqueService | null {
  const orchestrationService = runtime.orchestrationService;
  const laneService = runtime.laneService;
  const agentChatService = runtime.agentChatService;
  if (!orchestrationService || !laneService || !agentChatService) return null;
  return createOrchestrationDomainService({
    orchestrationService,
    laneService: { getLaneWorktreePath: (laneId: string) => laneService.getLaneWorktreePath(laneId) },
    agentChatService,
  }) as unknown as OpaqueService;
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

async function getTurnFileDiffFromGit(
  projectRoot: string,
  arg: AgentChatGetTurnFileDiffArgs,
): Promise<AgentChatTurnFileDiff> {
  const lang = arg.filePath.split(".").pop() ?? undefined;
  const readSide = async (spec: string): Promise<{
    exists: boolean;
    text: string;
    isTruncated?: boolean;
    isBinary?: boolean;
  }> => {
    const result = await runGit(["show", spec], {
      cwd: projectRoot,
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
  const origResult = await readSide(`${arg.beforeSha}:${arg.filePath}`);
  const modResult = await readSide(`${arg.afterSha}:${arg.filePath}`);
  return {
    path: arg.filePath,
    mode: "commit",
    ...(lang ? { language: lang } : {}),
    original: origResult,
    modified: modResult,
    ...(origResult.isBinary || modResult.isBinary ? { isBinary: true } : {}),
  };
}

async function saveAgentChatTempAttachment(projectRoot: string, arg: { data?: string; filename?: string }): Promise<{ path: string }> {
  const maxEncodedLength = Math.ceil(MAX_TEMP_ATTACHMENT_BYTES / 3) * 4;
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

function resolveAgentChatImagePath(projectRoot: string, rawPath: unknown): string {
  const value = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!value) throw new Error("Image path is required.");
  try {
    return resolvePathWithinRoot(projectRoot, value);
  } catch (error) {
    if (isPathEscapeError(error)) {
      throw new Error("Image path must be inside the project.");
    }
    throw error;
  }
}

function sniffImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
    && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return "image/jpeg";
  }
  if (buffer.length >= 6
    && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38
    && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return "image/gif";
  }
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return "image/webp";
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return "image/bmp";
  }
  if (buffer.length >= 4
    && buffer[0] === 0x00 && buffer[1] === 0x00
    && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return "image/x-icon";
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("utf8");
  const stripped = head.replace(/^\uFEFF/, "").trimStart();
  if (/^<\?xml\b/i.test(stripped) && /<svg\b/i.test(head)) {
    return "image/svg+xml";
  }
  if (/^<svg\b/i.test(stripped)) {
    return "image/svg+xml";
  }
  return null;
}

async function getAgentChatImageDataUrl(projectRoot: string, arg: { path?: string }): Promise<{ dataUrl: string }> {
  const imagePath = resolveAgentChatImagePath(projectRoot, arg.path);
  const stat = await fs.promises.stat(imagePath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (stat.size > MAX_TEMP_ATTACHMENT_BYTES) {
    throw new Error(legacyAttachmentCapMessage("Image"));
  }
  const data = await fs.promises.readFile(imagePath);
  const mimeType = sniffImageMimeType(data);
  if (!mimeType) {
    throw new Error("Path is not an image.");
  }
  return { dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
}

function buildChatDomainService(runtime: AdeRuntime): OpaqueService | null {
  const agentChatService = runtime.agentChatService;
  if (!agentChatService) return null;
  const base = agentChatService as unknown as OpaqueService;
  const service: OpaqueService = {
    ...base,
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
    listSessions: (args?: unknown) => {
      const record = asActionRecord(args);
      const laneId = typeof record.laneId === "string" && record.laneId.trim()
        ? record.laneId.trim()
        : undefined;
      const options = {
        ...(typeof record.includeArchived === "boolean" ? { includeArchived: record.includeArchived } : {}),
        ...(typeof record.includeAutomation === "boolean" ? { includeAutomation: record.includeAutomation } : {}),
        ...(typeof record.includeIdentity === "boolean" ? { includeIdentity: record.includeIdentity } : {}),
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
      const record = readObjectActionArg(args, "chat.sendMessage");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const text = requireNonEmptyString(record.text, "text");
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
      const record = readObjectActionArg(args, "chat.steer");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const text = requireNonEmptyString(record.text, "text");
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
    listPromptStashes: () => listPromptStashes(runtime.db),
    createPromptStash: (args?: PromptStashCreateArgs) => {
      const record = readObjectActionArg(args, "chat.createPromptStash");
      // The service owns validation for both text and attachment-only stashes.
      // Keeping the full object intact is essential on the daemon path: this is
      // the path every runtime-backed desktop uses.
      return createPromptStash(runtime.db, record);
    },
    deletePromptStash: (args?: PromptStashDeleteArgs) => {
      const record = readObjectActionArg(args, "chat.deletePromptStash");
      return deletePromptStash(runtime.db, requireNonEmptyString(record.id, "id"));
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
      getAgentChatImageDataUrl(runtime.projectRoot, args ?? {}),
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
      // The host zone is added here rather than on `AgentChatSessionSummary`
      // itself so the per-row list payload does not carry the same constant N
      // times; `chat.createScheduledWork` reports the same value the same way.
      // See `AdeChatSessionSummaryActionResult` for the full reasoning.
      return { ...summary, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    };
  }
  if (typeof base.getTurnStatus === "function") {
    service.getTurnStatus = (args?: unknown) =>
      agentChatService.getTurnStatus(readStringActionArg(args, "sessionId"));
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
  if (typeof base.getChatEventHistory === "function") {
    service.getChatEventHistory = (args?: unknown, positionalOptions?: unknown) => {
      const actionArgs = positionalOptions === undefined ? args : [args, positionalOptions];
      const { sessionId, options } = readChatHistoryActionArgs(actionArgs, "chat.getChatEventHistory");
      const maxEvents = readOptionalIntegerActionField(options.maxEvents, "maxEvents");
      const maxBytes = readOptionalIntegerActionField(options.maxBytes, "maxBytes");
      return agentChatService.getChatEventHistory(sessionId, {
        ...(maxEvents !== undefined ? { maxEvents } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
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
    getBackendStatus: () => broker.getBackendStatus(),
    getOwnerSnapshot: (args?: ComputerUseOwnerSnapshotArgs) => {
      if (!args?.owner) throw new Error("owner is required.");
      return buildComputerUseOwnerSnapshot({
        broker,
        owner: args.owner,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
    },
  };
}

function buildAttentionDomainService(runtime: AdeRuntime): OpaqueService | null {
  const publisher = runtime.pushPublisherService;
  if (!publisher) return null;
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
      if (!sessionService.requestAttention(sessionId, message)) {
        throw new Error(`Session '${sessionId}' was not found.`);
      }
      const session = sessionService.get(sessionId);
      const isTrackedCli = isTrackedAgentCliToolType(session?.toolType);
      if (isTrackedCli && runtime.ptyService?.hasLivePty(sessionId)) {
        runtime.ptyService.markSessionAttentionRequested(sessionId);
        runtime.ptyService.setSessionRuntimeState(sessionId, "waiting-input");
      }
      try {
        runtime.pushPublisherService?.handleSessionAttentionRequested(runtime.projectId, {
          sessionId,
          kind: isTrackedCli ? "cli" : "chat",
          title: session?.title ?? "ADE session",
          message,
          laneId: session?.laneId ?? null,
          // Only asks whose headline is the ask itself set these — today that is
          // `ade browser handoff`, which pushes "Sign in for me" / the reason.
          alertTitle: optionalNonEmptyString(record.alertTitle),
          alertBody: optionalNonEmptyString(record.alertBody),
        });
      } catch (error) {
        runtime.logger.warn("session.attention_notification_failed", {
          sessionId,
          error: getErrorMessage(error),
        });
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
        throw new Error(`Session '${sessionId}' was not found.`);
      }
      return { ok: true, sessionId };
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
  return {
    ...laneService,
    getSummary: async (args?: unknown) => {
      const record = readObjectActionArg(args, "lane.getSummary");
      const laneId = requireNonEmptyString(record.laneId, "laneId");
      return runtime.laneService.getSummary(laneId, {
        includeStatus: record.includeStatus !== false,
      });
    },
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
          rebaseSuggestionService: runtime.rebaseSuggestionService ?? null,
          autoRebaseService: runtime.autoRebaseService ?? null,
          conflictService: runtime.conflictService ?? null,
          syncService: runtime.syncService ?? null,
          logger: runtime.logger,
        },
        lanes,
        {
          includeConflictStatus: args?.includeConflictStatus !== false,
          includeRebaseSuggestions: args?.includeRebaseSuggestions !== false,
          includeAutoRebaseStatus: args?.includeAutoRebaseStatus !== false,
        },
      );
    },
    listRebaseSuggestions: () => runtime.rebaseSuggestionService?.listSuggestions() ?? [],
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
    delete: async (args?: DeleteLaneArgs): Promise<void> => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const teardownEnv = await buildLaneEnvTeardown(runtime, laneId, { includeArchived: true });
      await runtime.laneService.delete({ ...(args ?? {}), laneId }, { teardownEnv });
      releaseLaneRuntimeResources(runtime, laneId);
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
    dismissRebaseSuggestion: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await runtime.rebaseSuggestionService?.dismiss({ laneId });
    },
    deferRebaseSuggestion: async (args?: { laneId?: string; minutes?: number }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(args?.minutes ?? 60)));
      await runtime.rebaseSuggestionService?.defer({ laneId, minutes });
    },
    listAutoRebaseStatuses: () =>
      runtime.autoRebaseService?.listStatuses() ?? [],
    dismissAutoRebaseStatus: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await runtime.autoRebaseService?.dismissStatus({ laneId });
    },
    initEnv: async (args?: { laneId?: string }): Promise<LaneEnvInitProgress> => {
      const laneEnvironmentService = requireService(runtime.laneEnvironmentService, "Lane environment service not available.");
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const context = await resolveLaneOverlayContextForRuntime(runtime, laneId);
      if (!context.envInitConfig) {
        const now = new Date().toISOString();
        return { laneId, steps: [], startedAt: now, completedAt: now, overallStatus: "completed" };
      }
      return laneEnvironmentService.initLaneEnvironment(context.lane, context.envInitConfig, context.overrides);
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
      const laneTemplateService = requireService(runtime.laneTemplateService, "Lane template service not available.");
      const laneEnvironmentService = requireService(runtime.laneEnvironmentService, "Lane environment service not available.");
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const templateId = requireNonEmptyString(args?.templateId, "templateId");
      const context = await resolveLaneOverlayContextForRuntime(runtime, laneId);
      const template = laneTemplateService.getTemplate(templateId);
      if (!template) throw new Error(`Template not found: ${templateId}`);
      const templateEnvInit = laneTemplateService.resolveTemplateAsEnvInit(template);
      const mergedOverrides = mergeLaneOverrides(context.overrides, {
        ...(template.envVars ? { env: template.envVars } : {}),
        ...(!context.overrides.portRange && template.portRange ? { portRange: template.portRange } : {}),
        envInit: templateEnvInit,
      });
      const mergedEnvInitConfig = mergeLaneEnvInitConfig(context.envInitConfig, templateEnvInit) ?? templateEnvInit;
      return laneEnvironmentService.initLaneEnvironment(context.lane, mergedEnvInitConfig, mergedOverrides);
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
  const buildOpenCodeAuthDeps = (): OpenCodeAuthDeps => ({
    projectRoot: runtime.projectRoot,
    projectConfig: runtime.projectConfigService.getEffective(),
    logger: runtime.logger,
  });
  return {
    getStatus: (args?: { force?: boolean; refreshOpenCodeInventory?: boolean }) =>
      buildAiSettingsStatus(aiIntegrationService, args),
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
    refreshModelsDev: async () => {
      try {
        await refreshModelsDevNow();
      } catch {
        // Surfaced via lastFetchedAt staleness; never throw from a refresh nudge.
      }
      return { lastFetchedAt: getModelsDevLastFetchedAt() };
    },
    getOpenCodeRuntimeDiagnostics: async () => {
      const { getOpenCodeRuntimeSnapshot } = await import("../opencode/openCodeRuntime");
      return getOpenCodeRuntimeSnapshot();
    },
    isOpenCodeInstalled: async () => {
      const { resolveOpenCodeBinary } = await import("../opencode/openCodeBinaryManager");
      const info = resolveOpenCodeBinary();
      return { installed: Boolean(info.path), source: info.source };
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
    updateConfig: (partial?: Partial<AiConfig>) => {
      const projectConfigService = requireService(runtime.projectConfigService, "Project config service not available.");
      const snapshot = projectConfigService.get();
      const currentAi = snapshot.shared?.ai ?? {};
      const merged = mergeAiConfig(currentAi, partial ?? {}) ?? {};
      projectConfigService.save({
        shared: { ...snapshot.shared, ai: merged },
        local: snapshot.local ?? {},
      });
      void runtime.agentChatService?.refreshScheduledWork();
    },
    listCursorCloudRepositories: () => aiIntegrationService.listCursorCloudRepositories(),
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
    cursorCloudFollowUp: (args?: { agentId?: string; prompt?: string; modelId?: string | null }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").cursorCloudFollowUp({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        prompt: requireNonEmptyString(args?.prompt, "prompt"),
        ...(args?.modelId !== undefined ? { modelId: args.modelId } : {}),
      }),
    openCursorCloudChat: (args?: {
      cloudAgentId?: string;
      laneId?: string;
      sessionId?: string;
      modelId?: string;
      reasoningEffort?: string | null;
      fastMode?: boolean | null;
    }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").openCursorCloudChat({
        cloudAgentId: requireNonEmptyString(args?.cloudAgentId, "cloudAgentId"),
        laneId: requireNonEmptyString(args?.laneId, "laneId"),
        ...(args?.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args?.modelId ? { modelId: args.modelId } : {}),
        ...(args?.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
        ...(args?.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
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
  };
}

const AI_SETTINGS_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "commit_messages",
  "pr_descriptions",
  "terminal_summaries",
  "orchestrator",
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

type GraphStateService = {
  get(): unknown;
  set(args: { state?: unknown }): { projectId: string; state: unknown };
};

function buildGraphStateDomainService(runtime: AdeRuntime): GraphStateService | null {
  if (!runtime.db) return null;
  return {
    // graph_state is strictly scoped to the current runtime project. The caller
    // cannot override `projectId`; the field is intentionally absent from the
    // args surface to prevent cross-project reads/writes via `run_ade_action`.
    get() {
      const projectId = runtime.projectId;
      return runtime.db.getJson(`graph_state:${projectId}`);
    },
    set(args) {
      const projectId = runtime.projectId;
      if (!args || !Object.prototype.hasOwnProperty.call(args, "state")) {
        throw new Error("Missing required 'state'. Pass an explicit null to clear.");
      }
      const state = args.state;
      if (state !== null && (typeof state !== "object" || Array.isArray(state))) {
        throw new Error("Expected 'state' to be a plain object or null.");
      }
      runtime.db.setJson(`graph_state:${projectId}`, state);
      return { projectId, state };
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
};

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

type PrAiRuntimeBridge = {
  getSession(args?: unknown): Promise<PrAiResolutionGetSessionResult>;
  start(args?: unknown): Promise<PrAiResolutionStartResult>;
  input(args?: unknown): Promise<void>;
  stop(args?: unknown): Promise<void>;
};

const prAiRuntimeBridges = new WeakMap<AdeRuntime, PrAiRuntimeBridge>();

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

function emitPrAiResolutionRuntimeEvent(runtime: AdeRuntime, payload: PrAiResolutionEventPayload): void {
  runtime.eventBuffer.push({
    timestamp: nowIso(),
    category: "runtime",
    payload: { type: "pr_ai_resolution_event", event: payload },
  });
}

function readSummaryPermissionMode(summary: unknown): PrAgentPermissionMode | null {
  const record = asActionRecord(summary);
  return typeof record.permissionMode === "string"
    ? record.permissionMode as PrAgentPermissionMode
    : null;
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

function getPrAiRuntimeBridge(runtime: AdeRuntime): PrAiRuntimeBridge {
  const existing = prAiRuntimeBridges.get(runtime);
  if (existing) return existing;

  const prAiSessions = new Map<string, PrAiRuntimeSession>();
  const prAiSessionsByContextKey = new Map<string, string>();

  const clearSession = (sessionId: string): void => {
    const session = prAiSessions.get(sessionId);
    if (!session) return;
    if (session.pollTimer) clearInterval(session.pollTimer);
    if (prAiSessionsByContextKey.get(session.contextKey) === sessionId) {
      prAiSessionsByContextKey.delete(session.contextKey);
    }
    prAiSessions.delete(sessionId);
  };

  const finalize = async (
    sessionId: string,
    opts: { forceStatus?: "cancelled" | "completed" | "failed"; message?: string } = {},
  ): Promise<void> => {
    const session = prAiSessions.get(sessionId);
    if (!session || session.finalizing) return;
    session.finalizing = true;
    try {
      const detail = runtime.sessionService.get(sessionId);
      const derivedExitCode = opts.forceStatus === "cancelled"
        ? 130
        : (detail?.exitCode ?? (detail?.status === "completed" ? 0 : 1));
      try {
        await runtime.conflictService.finalizeResolverSession({
          runId: session.runId,
          exitCode: derivedExitCode,
        });
      } catch (error) {
        runtime.logger.debug("ade_actions.prs_ai_resolution_finalize_failed", {
          sessionId,
          runId: session.runId,
          error: getErrorMessage(error),
        });
      }

      const status = opts.forceStatus
        ?? (detail?.status === "disposed"
          ? "cancelled"
          : derivedExitCode === 0
            ? "completed"
            : "failed");
      emitPrAiResolutionRuntimeEvent(runtime, {
        sessionId,
        status,
        message: opts.message ?? null,
        timestamp: nowIso(),
      });
    } finally {
      clearSession(sessionId);
    }
  };

  const bridge: PrAiRuntimeBridge = {
    async getSession(args?: unknown): Promise<PrAiResolutionGetSessionResult> {
      const context = (asActionRecord(args).context ?? {}) as PrAiResolutionContext;
      const contextKey = buildPrAiResolutionContextKey(context);
      const liveSessionId = prAiSessionsByContextKey.get(contextKey);
      const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
      const sessionSummaries = await agentChatService.listSessions();

      if (liveSessionId) {
        const liveSession = prAiSessions.get(liveSessionId);
        if (liveSession) {
          const summary = sessionSummaries.find((entry) => entry.sessionId === liveSessionId) ?? null;
          const summaryRecord = asActionRecord(summary);
          return buildPrAiSessionInfo({
            context: liveSession.context,
            contextKey,
            sessionId: liveSessionId,
            provider: liveSession.provider,
            model: typeof summaryRecord.model === "string" ? summaryRecord.model : liveSession.modelId,
            modelId: typeof summaryRecord.modelId === "string" ? summaryRecord.modelId : liveSession.modelId,
            reasoning: typeof summaryRecord.reasoningEffort === "string" ? summaryRecord.reasoningEffort : liveSession.reasoning,
            permissionMode: readSummaryPermissionMode(summary) ?? liveSession.permissionMode,
            status: "running",
          });
        }
        prAiSessionsByContextKey.delete(contextKey);
      }

      const persistedRun = runtime.conflictService
        .listExternalResolverRuns({ limit: 200 })
        .find((entry) => entry.resolverContextKey === contextKey && entry.sessionId);
      if (!persistedRun?.sessionId) return null;

      const summary = sessionSummaries.find((entry) => entry.sessionId === persistedRun.sessionId) ?? null;
      const summaryRecord = asActionRecord(summary);
      return buildPrAiSessionInfo({
        context,
        contextKey,
        sessionId: persistedRun.sessionId,
        provider: persistedRun.provider === "claude" ? "claude" : "codex",
        model: typeof summaryRecord.model === "string" ? summaryRecord.model : persistedRun.model ?? null,
        modelId: typeof summaryRecord.modelId === "string" ? summaryRecord.modelId : persistedRun.model ?? null,
        reasoning: typeof summaryRecord.reasoningEffort === "string" ? summaryRecord.reasoningEffort : persistedRun.reasoningEffort ?? null,
        permissionMode: readSummaryPermissionMode(summary) ?? persistedRun.permissionMode ?? null,
        status: mapExternalResolverStatusToPrAi(persistedRun.status),
      });
    },
    async start(args?: unknown): Promise<PrAiResolutionStartResult> {
      const startArgs = asActionRecord(args) as unknown as PrAiResolutionStartArgs;
      const context = (startArgs.context ?? {}) as PrAiResolutionContext;
      const model = typeof startArgs.model === "string" ? startArgs.model.trim() : "";
      const targetLaneId = typeof context.targetLaneId === "string" ? context.targetLaneId.trim() : "";
      const sourceLaneIds = collectPrAiSourceLaneIds(context);
      const permissionMode: PrAgentPermissionMode = startArgs.permissionMode ?? "default";
      const reasoning = typeof startArgs.reasoning === "string" && startArgs.reasoning.trim().length > 0
        ? startArgs.reasoning.trim()
        : null;
      const additionalInstructions = typeof startArgs.additionalInstructions === "string" && startArgs.additionalInstructions.trim().length > 0
        ? startArgs.additionalInstructions.trim()
        : null;
      let runId = "";

      if (!model) {
        const sessionId = randomUUID();
        const error = "Model is required to start AI resolution.";
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: error, timestamp: nowIso() });
        return { sessionId, provider: "codex", ptyId: null, status: "failed", error, context };
      }
      if (!targetLaneId) {
        const sessionId = randomUUID();
        const error = "Target lane is required to start AI resolution.";
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: error, timestamp: nowIso() });
        return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
      }
      if (sourceLaneIds.length === 0) {
        const sessionId = randomUUID();
        const error = "At least one source lane is required to start AI resolution.";
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: error, timestamp: nowIso() });
        return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
      }

      try {
        const provider = inferPrAiProvider(model);
        const modelDescriptor = getModelById(model);
        const prep = await runtime.conflictService.prepareResolverSession({
          provider,
          targetLaneId,
          sourceLaneIds,
          cwdLaneId: typeof context.integrationLaneId === "string" && context.integrationLaneId.trim().length > 0
            ? context.integrationLaneId.trim()
            : (typeof context.laneId === "string" && context.laneId.trim().length > 0 ? context.laneId.trim() : undefined),
          proposalId: typeof context.proposalId === "string" && context.proposalId.trim().length > 0
            ? context.proposalId.trim()
            : undefined,
          sourceTab: context.sourceTab,
          scenario: context.scenario ?? (sourceLaneIds.length > 1 ? "integration-merge" : "single-merge"),
          model,
          reasoningEffort: reasoning,
          permissionMode,
          additionalInstructions,
          originSurface: context.sourceTab === "integration" || context.sourceTab === "rebase" ? context.sourceTab : "manual",
        });
        runId = prep.runId;
        if (prep.status === "blocked") {
          const sessionId = randomUUID();
          const reason = prep.contextGaps.length
            ? prep.contextGaps.map((gap) => gap.message).join(", ")
            : "Resolver session blocked due to insufficient context.";
          emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: reason, timestamp: nowIso() });
          return { sessionId, provider, ptyId: null, status: "failed", error: reason, context };
        }

        const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
        const session = await agentChatService.createSession({
          laneId: prep.cwdLaneId,
          provider,
          model: modelDescriptor?.shortId ?? model,
          ...(modelDescriptor?.id ? { modelId: modelDescriptor.id } : {}),
          ...(reasoning ? { reasoningEffort: reasoning } : {}),
          permissionMode: mapPermissionModeForModelFamily(permissionMode, modelDescriptor?.family),
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
        const runtimeSession: PrAiRuntimeSession = {
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
        await runtime.conflictService.attachResolverSession({
          runId: prep.runId,
          ptyId: null,
          sessionId: session.id,
          command: [],
        });
        runtimeSession.pollTimer = setInterval(() => {
          const current = prAiSessions.get(runtimeSession.sessionId);
          if (!current || current.finalizing) return;
          const detail = runtime.sessionService.get(runtimeSession.sessionId);
          if (!detail || detail.status === "running") return;
          void finalize(runtimeSession.sessionId);
        }, 1_000);
        prAiSessions.set(runtimeSession.sessionId, runtimeSession);
        prAiSessionsByContextKey.set(contextKey, runtimeSession.sessionId);
        emitPrAiResolutionRuntimeEvent(runtime, {
          sessionId: runtimeSession.sessionId,
          status: "running",
          message: null,
          timestamp: nowIso(),
        });
        void agentChatService.sendMessage({
          sessionId: runtimeSession.sessionId,
          text: promptText,
          displayText: buildPrAiDisplayText(runtimeContext),
          ...(reasoning ? { reasoningEffort: reasoning } : {}),
        }).catch(async (error: unknown) => {
          runtime.logger.warn("ade_actions.prs_ai_resolution_send_failed", {
            sessionId: runtimeSession.sessionId,
            runId: prep.runId,
            error: getErrorMessage(error),
          });
          await finalize(runtimeSession.sessionId, { forceStatus: "failed", message: getErrorMessage(error) });
        });
        return {
          sessionId: runtimeSession.sessionId,
          provider,
          ptyId: null,
          status: "started",
          error: null,
          context: runtimeContext,
        };
      } catch (error) {
        if (runId) {
          try {
            await runtime.conflictService.finalizeResolverSession({ runId, exitCode: 1 });
          } catch {
            // Preserve the original error.
          }
        }
        const sessionId = randomUUID();
        const message = getErrorMessage(error);
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message, timestamp: nowIso() });
        return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error: message, context };
      }
    },
    async input(args?: unknown): Promise<void> {
      const inputArgs = asActionRecord(args) as unknown as PrAiResolutionInputArgs;
      const sessionId = typeof inputArgs.sessionId === "string" ? inputArgs.sessionId.trim() : "";
      const text = typeof inputArgs.text === "string" ? inputArgs.text : "";
      if (!sessionId || !text.length) return;
      if (!prAiSessions.has(sessionId)) throw new Error(`AI resolution session not found: ${sessionId}`);
      const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
      const sessionDetail = runtime.sessionService.get(sessionId);
      if (sessionDetail?.status === "running") {
        await agentChatService.steerUserMessage({ sessionId, text });
        return;
      }
      await agentChatService.sendMessage({ sessionId, text });
    },
    async stop(args?: unknown): Promise<void> {
      const stopArgs = asActionRecord(args) as unknown as PrAiResolutionStopArgs;
      const sessionId = typeof stopArgs.sessionId === "string" ? stopArgs.sessionId.trim() : "";
      if (!sessionId) return;
      if (!prAiSessions.has(sessionId)) return;
      const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
      await agentChatService.interrupt({ sessionId });
      await finalize(sessionId, { forceStatus: "cancelled", message: "AI resolution stopped by user." });
    },
  };

  prAiRuntimeBridges.set(runtime, bridge);
  return bridge;
}

function buildPrDomainService(runtime: AdeRuntime): OpaqueService | null {
  const prService = runtime.prService;
  if (!prService) return null;
  const prSummaryService = runtime.prSummaryService ?? null;

  return {
    ...(prService as unknown as OpaqueService),
    aiResolutionGetSession(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).getSession(args);
    },
    aiResolutionStart(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).start(args);
    },
    aiResolutionInput(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).input(args);
    },
    aiResolutionStop(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).stop(args);
    },
    ...(prSummaryService
      ? {
          getAiSummary(prId: unknown) {
            return prSummaryService.getSummary(readStringActionArg(prId, "prId"));
          },
          regenerateAiSummary(prId: unknown) {
            return prSummaryService.regenerateSummary(readStringActionArg(prId, "prId"));
          },
        }
      : {}),
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
      const [projects, users, states] = await Promise.all([
        tracker.listProjects().catch(() => []),
        tracker.listUsers().catch(() => []),
        tracker.listWorkflowStates().catch(() => []),
      ]);
      return { projects, users, states };
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
  };
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
      return loadExternalSessionDetail(normalizeExternalSessionDetailArgs(args ?? {}));
    },
    // `watchDetail`/`unwatchDetail` are deliberately absent: the watch pushes
    // updates on a per-sender Electron IPC channel this action domain cannot
    // reach, so the desktop bridge keeps them on local IPC. A no-op here would
    // have told a remote caller it was watching when nothing would ever arrive.
  } as OpaqueService;
}

function buildStorageDomainService(runtime: AdeRuntime): OpaqueService | null {
  const storageInsightsService = runtime.storageInsightsService;
  if (!storageInsightsService) return null;
  return {
    getSnapshot: (args?: { forceRefresh?: boolean }) => storageInsightsService.getSnapshot(args),
    compressNow: () => storageInsightsService.compressNow(),
    runMaintenanceNow: () => storageInsightsService.runMaintenanceNow(),
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
    lane: toService(buildLaneDomainService(runtime)),
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
    project_secret: toService(runtime.projectSecretService),
    linear_credentials: toService(runtime.linearCredentialService),
    linear_oauth: buildLinearOAuthDomainService(runtime),
    linear_issue_tracker: toService(buildLinearIssueTrackerDomainService(runtime)),
    github: buildGithubDomainService(runtime),
    feedback: toService(runtime.feedbackReporterService),
    usage: toService(runtime.usageTrackingService),
    analytics: toService(runtime.productAnalyticsService),
    storage: toService(buildStorageDomainService(runtime)),
    budget: toService(runtime.budgetCapService),
    update: toService(runtime.autoUpdateService),
    file: toService(buildFileDomainService(runtime)),
    pty: toService(runtime.ptyService),
    terminal: toService(buildTerminalDomainService(runtime)),
    layout: toService(buildLayoutDomainService(runtime)),
    tiling_tree: toService(buildTilingTreeDomainService(runtime)),
    graph_state: toService(buildGraphStateDomainService(runtime)),
    work_tools: toService(runtime.workToolsStateService),
    computer_use_artifacts: toService(buildComputerUseArtifactsDomainService(runtime)),
    ios_simulator: toService(runtime.iosSimulatorService),
    app_control: toService(runtime.appControlService),
    built_in_browser: toService(runtime.builtInBrowserService),
    automations: automationsEnabled ? toService(buildAutomationsDomainService(runtime)) : null,
    review: toService(runtime.reviewService),
    issue: toService(buildIssueDomainService(runtime)),
    orchestration: toService(buildOrchestrationDomainService(runtime)),
    search: toService(buildSearchDomainService(runtime)),
    "external-sessions": toService(buildExternalSessionsDomainService(runtime)),
  };
}
