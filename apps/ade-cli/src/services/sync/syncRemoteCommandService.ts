import { randomUUID } from "node:crypto";
import type {
  AgentChatCreateArgs,
  AgentChatArchiveArgs,
  AgentChatApproveArgs,
  AgentChatCodexClearGoalArgs,
  AgentChatCodexGetGoalArgs,
  AgentChatCodexSetGoalArgs,
  AgentChatCodexSetGoalStatusArgs,
  AgentChatFileRef,
  AgentChatGetSummaryArgs,
  AgentChatListArgs,
  AgentChatModelCatalogArgs,
  AgentChatModelCatalogMode,
  AgentChatModelCatalogRefreshProvider,
  AgentChatProvider,
  AgentChatRespondToInputArgs,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatDispatchSteerArgs,
  AgentChatCancelDispatchedSteerArgs,
  AgentChatInterruptArgs,
  AgentChatUpdateSessionArgs,
  AgentStatus,
  AgentUpsertInput,
  AddPrCommentArgs,
  AiReviewSummaryArgs,
  ApplyLaneTemplateArgs,
  ArchiveLaneArgs,
  AttachLaneArgs,
  ClosePrArgs,
  CancelQueueAutomationArgs,
  CtoIdentity,
  CtoTriggerAgentWakeupArgs,
  CreateChildLaneArgs,
  CommitIntegrationArgs,
  CreateQueuePrsArgs,
  CreateLaneArgs,
  CreateLaneFromPrBranchArgs,
  CreateLaneFromUnstagedArgs,
  CreatePrFromLaneArgs,
  CreateIntegrationLaneForProposalArgs,
  ConvergenceRuntimeState,
  CleanupIntegrationWorkflowArgs,
  DeleteLaneArgs,
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
  GitStashPushArgs,
  GitStashRefArgs,
  GitSyncArgs,
  ImportBranchLaneArgs,
  LandPrArgs,
  LandQueueNextArgs,
  PauseQueueAutomationArgs,
  PipelineSettings,
  PrGithubCoords,
  PrConvergenceStatePatch,
  LaneEnvInitConfig,
  LaneEnvInitProgress,
  LaneDetailPayload,
  LaneListSnapshot,
  LaneOverlayOverrides,
  LaneStateSnapshotSummary,
  ListLanesArgs,
  ListIntegrationWorkflowsArgs,
  ListSessionsArgs,
  LinkPrToLaneArgs,
  RebasePushArgs,
  RebaseStartArgs,
  RenameLaneArgs,
  ReopenPrArgs,
  RecheckIntegrationStepArgs,
  ReactToPrCommentArgs,
  ReplyToPrReviewThreadArgs,
  ReparentLaneArgs,
  RequestPrReviewersArgs,
  ReorderQueuePrsArgs,
  ResumeQueueAutomationArgs,
  RerunPrChecksArgs,
  SetPrLabelsArgs,
  SetPrReviewThreadResolvedArgs,
  SimulateIntegrationArgs,
  StartIntegrationResolutionArgs,
  StartQueueAutomationArgs,
  SubmitPrReviewArgs,
  SyncCommandPayload,
  SyncRemoteCommandAction,
  SyncRemoteCommandDescriptor,
  SyncRemoteCommandPolicy,
  SyncSendToSessionArgs,
  SyncSendToSessionResult,
  SyncStartCliSessionArgs,
  SyncStartCliSessionResult,
  SyncRunQuickCommandArgs,
  UpdateSessionMetaArgs,
  UpdateIntegrationProposalArgs,
  TerminalToolType,
  UpdateLaneAppearanceArgs,
  UpdatePrBodyArgs,
  UpdatePrTitleArgs,
  WriteTextAtomicArgs,
} from "../../../../desktop/src/shared/types";
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
import { normalizePrCreationStrategy } from "../../../../desktop/src/shared/prStrategy";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { createCtoStateService } from "../../../../desktop/src/main/services/cto/ctoStateService";
import type { createFlowPolicyService } from "../../../../desktop/src/main/services/cto/flowPolicyService";
import type { createLinearCredentialService } from "../../../../desktop/src/main/services/cto/linearCredentialService";
import type { createLinearIngressService } from "../../../../desktop/src/main/services/cto/linearIngressService";
import type { createLinearIssueTracker } from "../../../../desktop/src/main/services/cto/linearIssueTracker";
import type { createLinearSyncService } from "../../../../desktop/src/main/services/cto/linearSyncService";
import type { createWorkerAgentService } from "../../../../desktop/src/main/services/cto/workerAgentService";
import type { createWorkerBudgetService } from "../../../../desktop/src/main/services/cto/workerBudgetService";
import type { createWorkerHeartbeatService } from "../../../../desktop/src/main/services/cto/workerHeartbeatService";
import type { createWorkerRevisionService } from "../../../../desktop/src/main/services/cto/workerRevisionService";
import { matchLaneOverlayPolicies } from "../../../../desktop/src/main/services/config/laneOverlayMatcher";
import type { createProjectConfigService } from "../../../../desktop/src/main/services/config/projectConfigService";
import type { createConflictService } from "../../../../desktop/src/main/services/conflicts/conflictService";
import type { createDiffService } from "../../../../desktop/src/main/services/diffs/diffService";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import type { createGitOperationsService } from "../../../../desktop/src/main/services/git/gitOperationsService";
import type { createAutoRebaseService } from "../../../../desktop/src/main/services/lanes/autoRebaseService";
import type { createLaneEnvironmentService } from "../../../../desktop/src/main/services/lanes/laneEnvironmentService";
import type { createLaneService } from "../../../../desktop/src/main/services/lanes/laneService";
import type { createLaneTemplateService } from "../../../../desktop/src/main/services/lanes/laneTemplateService";
import type { createPortAllocationService } from "../../../../desktop/src/main/services/lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../../../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { createProcessService } from "../../../../desktop/src/main/services/processes/processService";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { createPrService } from "../../../../desktop/src/main/services/prs/prService";
import type { createIssueInventoryService } from "../../../../desktop/src/main/services/prs/issueInventoryService";
import type { PathToMergeOrchestrator } from "../../../../desktop/src/main/services/prs/pathToMergeOrchestrator";
import type { createQueueLandingService } from "../../../../desktop/src/main/services/prs/queueLandingService";
import type { createPtyService } from "../../../../desktop/src/main/services/pty/ptyService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import { getSharedModelPickerStore, type ModelPickerStore } from "../modelPickerStore";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";

type SyncRemoteCommandServiceArgs = {
  /**
   * Per-project cr-sqlite DB. Source of truth for the model-picker store
   * (favorites + recents) when no explicit `getModelPickerStore` accessor is
   * wired, so the sync host never falls back to an empty store in production.
   * Optional only so unit tests that never touch `modelPicker.*` can omit it;
   * production callers (bootstrap, syncHostService) always pass it.
   */
  db?: AdeDb;
  laneService: ReturnType<typeof createLaneService>;
  prService: ReturnType<typeof createPrService>;
  issueInventoryService?: ReturnType<typeof createIssueInventoryService> | null;
  /**
   * Optional Path-to-Merge orchestrator. When present, iOS callers can start
   * and stop the convergence loop via the `prs.pathToMerge.start` /
   * `prs.pathToMerge.stop` sync commands. Optional so older builds (without
   * the orchestrator wired) keep compiling and degrade gracefully on iOS.
   */
  pathToMergeOrchestrator?: PathToMergeOrchestrator | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  ptyService: ReturnType<typeof createPtyService>;
  sessionService: ReturnType<typeof createSessionService>;
  fileService: ReturnType<typeof createFileService>;
  gitService?: ReturnType<typeof createGitOperationsService>;
  diffService?: ReturnType<typeof createDiffService>;
  conflictService?: ReturnType<typeof createConflictService>;
  agentChatService?: ReturnType<typeof createAgentChatService>;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  workerRevisionService?: ReturnType<typeof createWorkerRevisionService> | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  /**
   * Resolvers for services created after createSyncService in main.ts.
   * Router handlers read them lazily so init order is not load-bearing.
   */
  getLinearIngressService?: () => ReturnType<typeof createLinearIngressService> | null;
  getLinearIssueTracker?: () => ReturnType<typeof createLinearIssueTracker> | null;
  getLinearSyncService?: () => ReturnType<typeof createLinearSyncService> | null;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  processService?: ReturnType<typeof createProcessService> | null;
  portAllocationService?: ReturnType<typeof createPortAllocationService> | null;
  laneEnvironmentService?: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService?: ReturnType<typeof createLaneTemplateService> | null;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
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
  logger: Logger;
};

type RegisteredRemoteCommand = {
  descriptor: SyncRemoteCommandDescriptor;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

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

function parseProcessLaneArgs(payload: Record<string, unknown>, action: string): { laneId: string } {
  return {
    laneId: requireString(payload.laneId, `${action} requires laneId.`),
  };
}

function parseProcessActionArgs(payload: Record<string, unknown>, action: string): { laneId: string; processId: string; runId?: string } {
  const parsed = {
    laneId: requireString(payload.laneId, `${action} requires laneId.`),
    processId: requireString(payload.processId, `${action} requires processId.`),
  };
  const runId = asTrimmedString(payload.runId);
  return runId ? { ...parsed, runId } : parsed;
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
    idleSinceAt: session.idleSinceAt ?? null,
    startedAt: session.createdAt,
    endedAt: null,
    lastActivityAt: session.lastActivityAt,
    lastOutputPreview: null,
    summary: null,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    ...(session.requestedCwd !== undefined ? { requestedCwd: session.requestedCwd } : {}),
  };
}

function parseListLanesArgs(value: Record<string, unknown>): ListLanesArgs {
  return {
    includeArchived: asOptionalBoolean(value.includeArchived),
    includeStatus: asOptionalBoolean(value.includeStatus),
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
    ...(asTrimmedString(value.runtimePlacement) ? { runtimePlacement: asTrimmedString(value.runtimePlacement)! as CreateLaneArgs["runtimePlacement"] } : {}),
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
    ...(asTrimmedString(value.runtimePlacement) ? { runtimePlacement: asTrimmedString(value.runtimePlacement)! as CreateChildLaneArgs["runtimePlacement"] } : {}),
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

function parseAttachLaneArgs(value: Record<string, unknown>): AttachLaneArgs {
  return {
    name: requireString(value.name, "lanes.attach requires name."),
    attachedPath: requireString(value.attachedPath, "lanes.attach requires attachedPath."),
    ...(asTrimmedString(value.description) ? { description: asTrimmedString(value.description)! } : {}),
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
  };
}

function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return t === "cursor" || t.endsWith("-chat");
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
    if (chat.awaitingInput) {
      return {
        ...session,
        runtimeState: "waiting-input" as const,
        chatIdleSinceAt: null,
        pendingInputItemId: chat.pendingInputItemId ?? null,
      };
    }
    if (chat.status === "active") return { ...session, runtimeState: "running" as const, chatIdleSinceAt: null };
    if (chat.status === "idle") return { ...session, runtimeState: "idle" as const, chatIdleSinceAt: chat.idleSinceAt ?? null };
    return session;
  });
}

function parseSendToSessionArgs(value: Record<string, unknown>): SyncSendToSessionArgs {
  const text = requireString(value.text, "work.sendToSession requires text.");
  return {
    sessionId: requireString(value.sessionId, "work.sendToSession requires sessionId."),
    text,
    cols: asOptionalNumber(value.cols),
    rows: asOptionalNumber(value.rows),
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
  return {
    sessionId: requireString(value.sessionId, "chat.steer requires sessionId."),
    text: requireString(value.text, "chat.steer requires text."),
    ...(attachments?.length ? { attachments } : {}),
  };
}

function parseAgentChatCancelSteerArgs(value: Record<string, unknown>): AgentChatCancelSteerArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.cancelSteer requires sessionId."),
    steerId: requireString(value.steerId, "chat.cancelSteer requires steerId."),
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
  return {
    sessionId: requireString(value.sessionId, "chat.interrupt requires sessionId."),
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
} {
  return {
    sessionId: requireString(value.sessionId, "chat.getTranscript requires sessionId."),
    limit: asOptionalNumber(value.limit),
    maxChars: asOptionalNumber(value.maxChars),
  };
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

function parseChatModelsArgs(value: Record<string, unknown>): { provider: AgentChatProvider; activateRuntime?: boolean } {
  return {
    provider: (asTrimmedString(value.provider) ?? "codex") as AgentChatProvider,
    ...(value.activateRuntime === true ? { activateRuntime: true } : {}),
  };
}

function parseChatModelCatalogArgs(value: Record<string, unknown>): AgentChatModelCatalogArgs {
  const mode = asTrimmedString(value.mode) as AgentChatModelCatalogMode | null;
  const refreshProvider = asTrimmedString(value.refreshProvider) as AgentChatModelCatalogRefreshProvider | null;
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

function parseCreateQueuePrsArgs(value: Record<string, unknown>): CreateQueuePrsArgs {
  const laneIds = requireStringArray(value.laneIds, "prs.createQueue requires laneIds.");
  const targetBranch = requireString(value.targetBranch, "prs.createQueue requires targetBranch.");
  const titles = asStringRecord(value.titles);
  return {
    laneIds,
    targetBranch,
    ...(titles ? { titles } : {}),
    ...(typeof value.draft === "boolean" ? { draft: value.draft } : {}),
    ...(typeof value.autoRebase === "boolean" ? { autoRebase: value.autoRebase } : {}),
    ...(typeof value.ciGating === "boolean" ? { ciGating: value.ciGating } : {}),
    ...(asTrimmedString(value.queueName) ? { queueName: asTrimmedString(value.queueName)! } : {}),
    ...(typeof value.allowDirtyWorktree === "boolean" ? { allowDirtyWorktree: value.allowDirtyWorktree } : {}),
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
  return { prId, method };
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
  const checkRunIds = (() => {
    if (value.checkRunIds == null) return undefined;
    if (!Array.isArray(value.checkRunIds)) {
      throw new Error("prs.rerunChecks requires checkRunIds to be an array of numbers when provided.");
    }
    return value.checkRunIds.map((entry) => {
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
        throw new Error("prs.rerunChecks requires checkRunIds to be an array of numbers when provided.");
      }
      return entry;
    });
  })();
  return {
    prId: requirePrId(value, "prs.rerunChecks"),
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

function parseLandQueueNextArgs(value: Record<string, unknown>): LandQueueNextArgs {
  const method = asTrimmedString(value.method) as LandQueueNextArgs["method"];
  if (!method || !["merge", "squash", "rebase"].includes(method)) {
    throw new Error("prs.landQueueNext requires method to be merge, squash, or rebase.");
  }
  return {
    groupId: requireString(value.groupId, "prs.landQueueNext requires groupId."),
    method,
    ...(typeof value.archiveLane === "boolean" ? { archiveLane: value.archiveLane } : {}),
    ...(typeof value.autoResolve === "boolean" ? { autoResolve: value.autoResolve } : {}),
    ...(asConfidenceThreshold(value.confidenceThreshold) != null ? { confidenceThreshold: asConfidenceThreshold(value.confidenceThreshold)! } : {}),
  };
}

function parseStartQueueAutomationArgs(value: Record<string, unknown>): StartQueueAutomationArgs {
  const method = asTrimmedString(value.method);
  if (!method || !["merge", "squash", "rebase"].includes(method)) {
    throw new Error("prs.startQueueAutomation requires method to be merge, squash, or rebase.");
  }
  const pipeline = isRecord(value.pipeline) ? (value.pipeline as StartQueueAutomationArgs["pipeline"]) : undefined;
  const resolverProvider = asTrimmedString(value.resolverProvider);
  const resolverModel = asTrimmedString(value.resolverModel);
  const reasoningEffort = asTrimmedString(value.reasoningEffort);
  const permissionMode = asTrimmedString(value.permissionMode);
  const confidenceThreshold = asConfidenceThreshold(value.confidenceThreshold);
  const originLabel = asTrimmedString(value.originLabel);
  return {
    groupId: requireString(value.groupId, "prs.startQueueAutomation requires groupId."),
    method: method as StartQueueAutomationArgs["method"],
    ...(typeof value.archiveLane === "boolean" ? { archiveLane: value.archiveLane } : {}),
    ...(typeof value.ciGating === "boolean" ? { ciGating: value.ciGating } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(typeof value.autoResolve === "boolean" ? { autoResolve: value.autoResolve } : {}),
    ...(resolverProvider ? { resolverProvider: resolverProvider as StartQueueAutomationArgs["resolverProvider"] } : {}),
    ...(resolverModel ? { resolverModel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(permissionMode ? { permissionMode: permissionMode as StartQueueAutomationArgs["permissionMode"] } : {}),
    ...(confidenceThreshold != null ? { confidenceThreshold } : {}),
    ...(originLabel ? { originLabel } : {}),
  };
}

function parseReorderQueuePrsArgs(value: Record<string, unknown>): ReorderQueuePrsArgs {
  return {
    groupId: requireString(value.groupId, "prs.reorderQueue requires groupId."),
    prIds: requireStringArray(value.prIds, "prs.reorderQueue requires prIds."),
  };
}

function parsePauseQueueAutomationArgs(value: Record<string, unknown>): PauseQueueAutomationArgs {
  return {
    queueId: requireString(value.queueId, "prs.pauseQueueAutomation requires queueId."),
  };
}

function parseResumeQueueAutomationArgs(value: Record<string, unknown>): ResumeQueueAutomationArgs {
  const method = asTrimmedString(value.method);
  if (method && !["merge", "squash", "rebase"].includes(method)) {
    throw new Error("prs.resumeQueueAutomation requires method to be merge, squash, or rebase when provided.");
  }
  return {
    queueId: requireString(value.queueId, "prs.resumeQueueAutomation requires queueId."),
    ...(method ? { method: method as ResumeQueueAutomationArgs["method"] } : {}),
    ...(typeof value.archiveLane === "boolean" ? { archiveLane: value.archiveLane } : {}),
    ...(typeof value.autoResolve === "boolean" ? { autoResolve: value.autoResolve } : {}),
    ...(typeof value.ciGating === "boolean" ? { ciGating: value.ciGating } : {}),
    ...(asConfidenceThreshold(value.confidenceThreshold) != null ? { confidenceThreshold: asConfidenceThreshold(value.confidenceThreshold)! } : {}),
    ...(asTrimmedString(value.originLabel) ? { originLabel: asTrimmedString(value.originLabel)! } : {}),
  };
}

function parseCancelQueueAutomationArgs(value: Record<string, unknown>): CancelQueueAutomationArgs {
  return {
    queueId: requireString(value.queueId, "prs.cancelQueueAutomation requires queueId."),
  };
}

function parseIssueInventoryPrArgs(value: Record<string, unknown>, action: string): { prId: string } {
  return {
    prId: requirePrId(value, action),
  };
}

function parseIssueInventoryItemsArgs(value: Record<string, unknown>, action: string): { prId: string; itemIds: string[] } {
  return {
    prId: requirePrId(value, action),
    itemIds: requireStringArray(value.itemIds, `${action} requires itemIds.`),
  };
}

function parseIssueInventoryDismissArgs(value: Record<string, unknown>): { prId: string; itemIds: string[]; reason: string } {
  return {
    ...parseIssueInventoryItemsArgs(value, "prs.issueInventory.markDismissed"),
    reason: typeof value.reason === "string" ? value.reason : "",
  };
}

function parsePipelineSettingsPatch(value: Record<string, unknown>): { prId: string; settings: Partial<PipelineSettings> } {
  const settings = isRecord(value.settings) ? value.settings : value;
  const patch: Partial<PipelineSettings> = {};
  if (typeof settings.autoMerge === "boolean") patch.autoMerge = settings.autoMerge;
  const mergeMethod = asTrimmedString(settings.mergeMethod);
  if (mergeMethod && ["merge", "squash", "rebase", "repo_default"].includes(mergeMethod)) {
    patch.mergeMethod = mergeMethod as PipelineSettings["mergeMethod"];
  }
  const maxRounds = asOptionalNumber(settings.maxRounds);
  if (maxRounds != null && maxRounds >= 1) patch.maxRounds = Math.floor(maxRounds);
  const onRebaseNeeded = asTrimmedString(settings.onRebaseNeeded);
  if (onRebaseNeeded === "pause" || onRebaseNeeded === "auto_rebase") {
    patch.onRebaseNeeded = onRebaseNeeded;
  }
  const conflictStrategy = asTrimmedString(settings.conflictStrategy);
  if (conflictStrategy && ["pause", "rebase", "merge", "auto"].includes(conflictStrategy)) {
    patch.conflictStrategy = conflictStrategy as PipelineSettings["conflictStrategy"];
  }
  const forceFinalizeMode = asTrimmedString(settings.forceFinalizeMode);
  if (forceFinalizeMode && ["off", "conditional", "unconditional"].includes(forceFinalizeMode)) {
    patch.forceFinalizeMode = forceFinalizeMode as PipelineSettings["forceFinalizeMode"];
  }
  if (typeof settings.forceFinalizeRequireNoCiFailures === "boolean") {
    patch.forceFinalizeRequireNoCiFailures = settings.forceFinalizeRequireNoCiFailures;
  }
  if (typeof settings.earlyMergeOnGreen === "boolean") {
    patch.earlyMergeOnGreen = settings.earlyMergeOnGreen;
  }
  const atCapPolicy = asTrimmedString(settings.atCapPolicy);
  if (atCapPolicy && ["stop", "wait_for_ci", "ci_retry_once", "ci_retry_loop", "force_merge"].includes(atCapPolicy)) {
    patch.atCapPolicy = atCapPolicy as PipelineSettings["atCapPolicy"];
  }
  const atCapWaitMinutes = asOptionalNumber(settings.atCapWaitMinutes);
  if (atCapWaitMinutes != null && atCapWaitMinutes >= 1) patch.atCapWaitMinutes = Math.floor(atCapWaitMinutes);
  const atCapCiRetryMax = asOptionalNumber(settings.atCapCiRetryMax);
  if (atCapCiRetryMax != null && atCapCiRetryMax >= 1) patch.atCapCiRetryMax = Math.floor(atCapCiRetryMax);
  if (typeof settings.forceMergeRequiresConfirmation === "boolean") {
    patch.forceMergeRequiresConfirmation = settings.forceMergeRequiresConfirmation;
  }
  if (isRecord(settings.autoAgentSettings)) {
    const autoAgentSettings: Partial<PipelineSettings["autoAgentSettings"]> = {};
    const provider = settings.autoAgentSettings.provider;
    if (provider === null || provider === "claude" || provider === "codex") autoAgentSettings.provider = provider;
    for (const key of ["model", "reasoningEffort"] as const) {
      const value = settings.autoAgentSettings[key];
      if (value === null || typeof value === "string") autoAgentSettings[key] = value;
    }
    const permissionMode = settings.autoAgentSettings.permissionMode;
    if (
      permissionMode === null ||
      permissionMode === "read_only" ||
      permissionMode === "guarded_edit" ||
      permissionMode === "full_edit" ||
      permissionMode === "default" ||
      permissionMode === "plan" ||
      permissionMode === "edit" ||
      permissionMode === "full-auto" ||
      permissionMode === "config-toml"
    ) {
      autoAgentSettings.permissionMode = permissionMode;
    }
    const confidenceThreshold = asOptionalNumber(settings.autoAgentSettings.confidenceThreshold);
    if (settings.autoAgentSettings.confidenceThreshold === null || (confidenceThreshold != null && confidenceThreshold >= 0 && confidenceThreshold <= 1)) {
      autoAgentSettings.confidenceThreshold = settings.autoAgentSettings.confidenceThreshold === null ? null : confidenceThreshold;
    }
    if (Object.keys(autoAgentSettings).length > 0) patch.autoAgentSettings = autoAgentSettings as PipelineSettings["autoAgentSettings"];
  }
  return {
    prId: requirePrId(value, "prs.pipelineSettings.save"),
    settings: patch,
  };
}

function parseConvergenceStatePatch(value: Record<string, unknown>): { prId: string; state: PrConvergenceStatePatch } {
  const raw = isRecord(value.state) ? value.state : value;
  const patch: PrConvergenceStatePatch = {};
  const statuses = new Set(["idle", "launching", "running", "polling", "paused", "converged", "merged", "failed", "cancelled", "stopped"]);
  const pollerStatuses = new Set(["idle", "scheduled", "polling", "waiting_for_checks", "waiting_for_comments", "paused", "stopped"]);
  if (typeof raw.autoConvergeEnabled === "boolean") patch.autoConvergeEnabled = raw.autoConvergeEnabled;
  const status = asTrimmedString(raw.status);
  if (status && statuses.has(status)) patch.status = status as ConvergenceRuntimeState["status"];
  const pollerStatus = asTrimmedString(raw.pollerStatus);
  if (pollerStatus && pollerStatuses.has(pollerStatus)) patch.pollerStatus = pollerStatus as ConvergenceRuntimeState["pollerStatus"];
  const currentRound = asOptionalNumber(raw.currentRound);
  if (currentRound != null && currentRound >= 0) patch.currentRound = Math.floor(currentRound);
  if (typeof raw.forceFinalizeUsed === "boolean") patch.forceFinalizeUsed = raw.forceFinalizeUsed;
  const ciRetryAttemptsUsed = asOptionalNumber(raw.ciRetryAttemptsUsed);
  if (ciRetryAttemptsUsed != null && ciRetryAttemptsUsed >= 0) patch.ciRetryAttemptsUsed = Math.floor(ciRetryAttemptsUsed);
  const pauseRepeatCount = asOptionalNumber(raw.pauseRepeatCount);
  if (pauseRepeatCount != null && pauseRepeatCount >= 0) patch.pauseRepeatCount = Math.floor(pauseRepeatCount);
  for (const key of [
    "activeSessionId",
    "activeLaneId",
    "activeHref",
    "pauseReason",
    "errorMessage",
    "waitForCiStartedAt",
    "lastDispatchHeadSha",
    "lastPauseReasonHash",
    "lastStartedAt",
    "lastPolledAt",
    "lastPausedAt",
    "lastStoppedAt",
  ] as const) {
    const next = raw[key];
    if (next === null || typeof next === "string") {
      (patch as Record<string, unknown>)[key] = next;
    }
  }
  return {
    prId: requirePrId(value, "prs.convergenceState.save"),
    state: patch,
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
    ...(base.processIds || next.processIds ? { processIds: [...(next.processIds ?? base.processIds ?? [])] } : {}),
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

async function resolveChatCreateArgs(
  service: ReturnType<typeof createAgentChatService>,
  payload: AgentChatCreateArgs,
): Promise<AgentChatCreateArgs> {
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
  lastOutputPreview: string | null | undefined;
  runtimeState?: string | null;
}): "running" | "awaiting-input" | "ended" {
  if (argsIn.status === "running") {
    if (argsIn.runtimeState === "waiting-input") return "awaiting-input";
    const preview = argsIn.lastOutputPreview ?? "";
    if (/\b(?:waiting|awaiting)\b.{0,28}\b(?:input|confirmation|response|prompt)\b/i.test(preview)) {
      return "awaiting-input";
    }
    if (/\((?:y\/n|yes\/no)\)/i.test(preview) || /\[(?:y\/n|yes\/no)\]/i.test(preview)) {
      return "awaiting-input";
    }
    return "running";
  }
  return "ended";
}

function summarizeLaneRuntime(
  laneId: string,
  sessions: Array<{
    laneId: string;
    status: string;
    lastOutputPreview: string | null;
    runtimeState?: string | null;
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
  const bucket = runningCount > 0
    ? "running"
    : awaitingInputCount > 0
      ? "awaiting-input"
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
): Promise<LaneListSnapshot[]> {
  const [sessions, rebaseSuggestions, autoRebaseStatuses, stateSnapshots, batchAssessment] = await Promise.all([
    Promise.resolve(args.sessionService.list({ limit: 500 })),
    Promise.resolve(args.rebaseSuggestionService?.listSuggestions() ?? []),
    Promise.resolve(args.autoRebaseService?.listStatuses() ?? []),
    Promise.resolve(args.laneService.listStateSnapshots()),
    args.conflictService?.getBatchAssessment({ lanes }).catch(() => null) ?? Promise.resolve(null),
  ]);

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
    adoptableAttached: lane.laneType === "attached" && lane.archivedAt == null,
  }));
}

async function buildLaneDetailPayload(args: SyncRemoteCommandServiceArgs, laneId: string): Promise<LaneDetailPayload> {
  const lane = (await args.laneService.list({ includeArchived: true, includeStatus: true })).find((entry) => entry.id === laneId) ?? null;
  if (!lane) throw new Error(`Lane not found: ${laneId}`);

  const [
    stackChain,
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
    args.laneService.getStackChain(laneId),
    args.laneService.getChildren(laneId),
    Promise.resolve(args.sessionService.list({ laneId, limit: 200 })),
    args.agentChatService?.listSessions(laneId, { includeAutomation: true }) ?? Promise.resolve([]),
    Promise.resolve(args.rebaseSuggestionService?.listSuggestions() ?? []),
    Promise.resolve(args.autoRebaseService?.listStatuses() ?? []),
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
    runtime: summarizeLaneRuntime(laneId, sessions),
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

type RemoteCommandRegistrar = (
  action: SyncRemoteCommandAction,
  policy: SyncRemoteCommandPolicy,
  handler: (payload: Record<string, unknown>) => Promise<unknown>,
  scope?: SyncRemoteCommandDescriptor["scope"],
) => void;

type RemoteCommandRegistrationDeps = {
  args: SyncRemoteCommandServiceArgs;
  register: RemoteCommandRegistrar;
};

function registerLaneRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("lanes.list", { viewerAllowed: true }, async (payload) => args.laneService.list(parseListLanesArgs(payload)));
  register("lanes.refreshSnapshots", { viewerAllowed: true }, async (payload) => {
    const refreshed = await args.laneService.refreshSnapshots(parseListLanesArgs(payload));
    return {
      ...refreshed,
      snapshots: await buildLaneListSnapshots(args, refreshed.lanes),
    };
  });
  register("lanes.getDetail", { viewerAllowed: true }, async (payload) =>
    buildLaneDetailPayload(args, requireString(payload.laneId, "lanes.getDetail requires laneId.")));
  register("lanes.create", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.create(parseCreateLaneArgs(payload)));
  register("lanes.createChild", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.createChild(parseCreateChildLaneArgs(payload)));
  register("lanes.createFromUnstaged", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.laneService.createFromUnstaged(parseCreateLaneFromUnstagedArgs(payload)));
  register("lanes.importBranch", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.laneService.importBranch(parseImportBranchArgs(payload)));
  register("lanes.previewBranchSwitch", { viewerAllowed: true }, async (payload) =>
    args.laneService.previewBranchSwitch(parseGitCheckoutBranchArgs(payload)));
  register("lanes.attach", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.attach(parseAttachLaneArgs(payload)));
  register("lanes.listUnregisteredWorktrees", { viewerAllowed: true }, async () => args.laneService.listUnregisteredWorktrees());
  register("lanes.adoptAttached", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.laneService.adoptAttached({ laneId: requireString(payload.laneId, "lanes.adoptAttached requires laneId.") }));
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
  register("lanes.unarchive", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.laneService.unarchive(parseArchiveLaneArgs(payload, "lanes.unarchive"));
    return { ok: true };
  });
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
  register("work.listSessions", { viewerAllowed: true }, async (payload) => listRemoteWorkSessions(args, parseListSessionsArgs(payload)));
  register("work.updateSessionMeta", { viewerAllowed: true, queueable: true }, async (payload) => {
    args.sessionService.updateMeta(parseUpdateSessionMetaArgs(payload));
    return { ok: true };
  });
  register("work.runQuickCommand", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseQuickCommandArgs(payload);
    return await args.ptyService.create({
      laneId: parsed.laneId,
      title: parsed.title,
      ...(parsed.toolType === "shell" || !parsed.startupCommand ? {} : { startupCommand: parsed.startupCommand }),
      tracked: parsed.tracked ?? true,
      cols: parsed.cols ?? 120,
      rows: parsed.rows ?? 36,
      toolType: (parsed.toolType ?? "run-shell") as TerminalToolType,
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
        initialPrompt: parsed.initialInput,
        laneWorktreePath: resolveLaneWorktreePathForSync(args, parsed.laneId),
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
  register("work.sendToSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const parsed = parseSendToSessionArgs(payload);
    const result = await args.ptyService.sendToSession({
      sessionId: parsed.sessionId,
      text: parsed.text,
      ...(parsed.cols != null ? { cols: parsed.cols } : {}),
      ...(parsed.rows != null ? { rows: parsed.rows } : {}),
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

function registerProcessRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("processes.listDefinitions", { viewerAllowed: true }, async () =>
    requireService(args.processService, "Process service not available.").listDefinitions());
  register("processes.listRuntime", { viewerAllowed: true }, async (payload) =>
    requireService(args.processService, "Process service not available.").listRuntime(
      parseProcessLaneArgs(payload, "processes.listRuntime").laneId,
    ));
  register("processes.start", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.processService, "Process service not available.").start(
      parseProcessActionArgs(payload, "processes.start"),
    ));
  register("processes.stop", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.processService, "Process service not available.").stop(
      parseProcessActionArgs(payload, "processes.stop"),
    ));
  register("processes.kill", { viewerAllowed: true, queueable: false }, async (payload) =>
    requireService(args.processService, "Process service not available.").kill(
      parseProcessActionArgs(payload, "processes.kill"),
    ));
}

function registerChatRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
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
  register("chat.getTranscript", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getChatTranscript(parseGetTranscriptArgs(payload)));
  register("chat.create", { viewerAllowed: true, queueable: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatCreateArgs(payload);
    const session = await agentChatService.createSession(await resolveChatCreateArgs(agentChatService, parsed));
    return summarizeChatSessionForRemote(agentChatService, session);
  });
  register("chat.send", { viewerAllowed: true, queueable: true }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").sendMessage(
      parseAgentChatSendArgs(payload),
      { awaitDispatch: false },
    );
    return { ok: true };
  });
  register("chat.interrupt", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").interrupt(parseAgentChatInterruptArgs(payload));
    return { ok: true };
  });
  register("chat.steer", { viewerAllowed: true, queueable: false }, async (payload) => {
    const result = await requireService(args.agentChatService, "Agent chat service not available.").steer(parseAgentChatSteerArgs(payload));
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
  register("cto.getRoster", { viewerAllowed: true }, async () => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const workerAgentService = requireService(args.workerAgentService, "Worker agent service not available.");
    const sessions = await agentChatService.listSessions(undefined, { includeIdentity: true });
    const activityTimestamp = (value: string | null | undefined): number => {
      if (!value) return 0;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const sortedByRecency = [...sessions].sort(
      (a, b) => activityTimestamp(b.lastActivityAt) - activityTimestamp(a.lastActivityAt),
    );
    const ctoSummary = sortedByRecency.find((entry) => entry.identityKey === "cto") ?? null;
    const agents = workerAgentService.listAgents();
    const knownAgentIds = new Set(agents.map((agent) => agent.id));
    const liveWorkers = agents.map((agent) => {
      const sessionSummary = sortedByRecency.find(
        (entry) => entry.identityKey === `agent:${agent.id}`,
      ) ?? null;
      return {
        agentId: agent.id,
        name: agent.name,
        avatarSeed: agent.slug || null,
        status: agent.status as string,
        sessionSummary,
      };
    });
    // Include agent:<id> sessions whose identity is no longer in the roster
    // so mobile users can still see / resume orphan chats. These are marked
    // with a synthetic "orphaned" status and no avatar seed.
    const orphanPrefix = "agent:";
    const orphanWorkers: typeof liveWorkers = [];
    const seenOrphanIds = new Set<string>();
    for (const entry of sortedByRecency) {
      const key = entry.identityKey ?? "";
      if (!key.startsWith(orphanPrefix)) continue;
      const agentId = key.slice(orphanPrefix.length);
      if (!agentId.length) continue;
      if (knownAgentIds.has(agentId)) continue;
      if (seenOrphanIds.has(agentId)) continue;
      seenOrphanIds.add(agentId);
      orphanWorkers.push({
        agentId,
        name: agentId,
        avatarSeed: null,
        status: "orphaned",
        sessionSummary: entry,
      });
    }
    liveWorkers.sort((a, b) => a.name.localeCompare(b.name));
    orphanWorkers.sort((a, b) => a.name.localeCompare(b.name));
    const workers = [...liveWorkers, ...orphanWorkers];
    return { cto: ctoSummary, workers };
  });
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
  register("cto.ensureAgentSession", { viewerAllowed: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const workerAgentService = requireService(args.workerAgentService, "Worker agent service not available.");
    const agentId = requireString(payload.agentId, "cto.ensureAgentSession requires agentId.");
    // Reject unknown agentIds before we spin up an identity-bound session —
    // otherwise clients could spawn orphan `agent:<id>` sessions for agents
    // that don't exist.
    const agent = typeof workerAgentService.getAgent === "function"
      ? workerAgentService.getAgent(agentId)
      : workerAgentService.listAgents().find((entry) => entry.id === agentId) ?? null;
    if (!agent) {
      throw new Error(`cto.ensureAgentSession: unknown agentId '${agentId}'`);
    }
    const laneId = await resolvePrimaryLaneIdOnlyForSync(args);
    if (!laneId) throw new Error("No primary lane is available to host the agent chat session.");
    const modelId = asTrimmedString(payload.modelId);
    const reasoningEffort = asTrimmedString(payload.reasoningEffort);
    const session = await agentChatService.ensureIdentitySession({
      identityKey: `agent:${agentId}`,
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
  register("cto.listAgents", { viewerAllowed: true }, async (payload) => {
    const workerAgentService = requireService(args.workerAgentService, "Worker agent service not available.");
    const includeDeleted = asOptionalBoolean(payload.includeDeleted);
    return workerAgentService.listAgents(includeDeleted === undefined ? {} : { includeDeleted });
  });
  register("cto.getBudgetSnapshot", { viewerAllowed: true }, async (payload) => {
    const workerBudgetService = requireService(args.workerBudgetService, "Worker budget service not available.");
    const monthKey = asTrimmedString(payload.monthKey);
    return workerBudgetService.getBudgetSnapshot(monthKey ? { monthKey } : {});
  });
  register("cto.listAgentRuns", { viewerAllowed: true }, async (payload) => {
    const workerHeartbeatService = requireService(args.workerHeartbeatService, "Worker heartbeat service not available.");
    const agentId = requireString(payload.agentId, "cto.listAgentRuns requires agentId.");
    const limit = asOptionalNumber(payload.limit);
    return workerHeartbeatService.listRuns({ agentId, ...(typeof limit === "number" ? { limit } : {}) });
  });
  register("cto.listAgentSessionLogs", { viewerAllowed: true }, async (payload) => {
    const workerHeartbeatService = requireService(args.workerHeartbeatService, "Worker heartbeat service not available.");
    const agentId = requireString(payload.agentId, "cto.listAgentSessionLogs requires agentId.");
    const limit = asOptionalNumber(payload.limit);
    return workerHeartbeatService.listAgentSessionLogs(agentId, limit ?? 40);
  });
  register("cto.listAgentRevisions", { viewerAllowed: true }, async (payload) => {
    const workerRevisionService = requireService(args.workerRevisionService, "Worker revision service not available.");
    const agentId = requireString(payload.agentId, "cto.listAgentRevisions requires agentId.");
    const limit = asOptionalNumber(payload.limit);
    return workerRevisionService.listAgentRevisions(agentId, limit ?? 20);
  });
  register("cto.getFlowPolicy", { viewerAllowed: true }, async () => {
    const flowPolicyService = requireService(args.flowPolicyService, "Flow policy service not available.");
    return flowPolicyService.getPolicy();
  });
  register("cto.getLinearConnectionStatus", { viewerAllowed: true }, async () => {
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
        message: tokenStored ? "Linear tracker service unavailable." : "Linear token not configured.",
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
      message: status.message,
    };
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
  register("cto.getLinearSyncDashboard", { viewerAllowed: true }, async () => {
    const linearSyncService = requireService(args.getLinearSyncService?.() ?? null, "Linear sync service not available.");
    return linearSyncService.getDashboard();
  });
  register("cto.runLinearSyncNow", { viewerAllowed: true, queueable: true }, async () => {
    const linearSyncService = requireService(args.getLinearSyncService?.() ?? null, "Linear sync service not available.");
    return linearSyncService.runSyncNow();
  });
  register("cto.listLinearSyncQueue", { viewerAllowed: true }, async () => {
    const linearSyncService = requireService(args.getLinearSyncService?.() ?? null, "Linear sync service not available.");
    return linearSyncService.listQueue({ limit: 300 });
  });
  register("cto.listLinearIngressEvents", { viewerAllowed: true }, async (payload) => {
    const linearIngressService = requireService(args.getLinearIngressService?.() ?? null, "Linear ingress service not available.");
    const limit = asOptionalNumber(payload.limit);
    return linearIngressService.listRecentEvents(limit ?? 20);
  });
  register("cto.updateIdentity", { viewerAllowed: true, queueable: true }, async (payload) => {
    const ctoStateService = requireService(args.ctoStateService, "CTO state service not available.");
    const patch = isRecord(payload.patch) ? (payload.patch as Partial<CtoIdentity>) : {};
    return ctoStateService.updateIdentity(patch);
  });
  register("cto.saveAgent", { viewerAllowed: true, queueable: true }, async (payload) => {
    const workerRevisionService = requireService(args.workerRevisionService, "Worker revision service not available.");
    if (!isRecord(payload.agent)) {
      throw new Error("cto.saveAgent requires agent object.");
    }
    const saved = workerRevisionService.saveAgent(payload.agent as AgentUpsertInput, "user");
    (args.workerHeartbeatService as { syncFromConfig?: () => void } | null | undefined)?.syncFromConfig?.();
    return saved;
  });
  register("cto.removeAgent", { viewerAllowed: true, queueable: true }, async (payload) => {
    const workerAgentService = requireService(args.workerAgentService, "Worker agent service not available.");
    const agentId = requireString(payload.agentId, "cto.removeAgent requires agentId.");
    workerAgentService.removeAgent(agentId);
    (args.workerHeartbeatService as { syncFromConfig?: () => void } | null | undefined)?.syncFromConfig?.();
    return {};
  });
  register("cto.setAgentStatus", { viewerAllowed: true, queueable: true }, async (payload) => {
    const workerAgentService = requireService(args.workerAgentService, "Worker agent service not available.");
    const agentId = requireString(payload.agentId, "cto.setAgentStatus requires agentId.");
    const status = requireString(payload.status, "cto.setAgentStatus requires status.") as AgentStatus;
    workerAgentService.setAgentStatus(agentId, status);
    return {};
  });
  register("cto.triggerAgentWakeup", { viewerAllowed: true, queueable: true }, async (payload) => {
    const workerHeartbeatService = requireService(args.workerHeartbeatService, "Worker heartbeat service not available.");
    const agentId = requireString(payload.agentId, "cto.triggerAgentWakeup requires agentId.");
    const reason = asTrimmedString(payload.reason);
    const context = isRecord(payload.context) ? payload.context : undefined;
    return workerHeartbeatService.triggerWakeup({
      agentId,
      ...(reason ? { reason: reason as CtoTriggerAgentWakeupArgs["reason"] } : {}),
      ...(context ? { context } : {}),
    });
  });
  register("cto.rollbackAgentRevision", { viewerAllowed: true, queueable: true }, async (payload) => {
    const workerRevisionService = requireService(args.workerRevisionService, "Worker revision service not available.");
    const agentId = requireString(payload.agentId, "cto.rollbackAgentRevision requires agentId.");
    const revisionId = requireString(payload.revisionId, "cto.rollbackAgentRevision requires revisionId.");
    await workerRevisionService.rollbackAgentRevision(agentId, revisionId, "user");
    return {};
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
  register("git.listBranches", { viewerAllowed: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").listBranches(parseGitListBranchesArgs(payload)));
  register("git.checkoutBranch", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").checkoutBranch(parseGitCheckoutBranchArgs(payload)));
}

function registerConflictRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("conflicts.getLaneStatus", { viewerAllowed: true }, async (payload) =>
    requireService(args.conflictService, "Conflict service not available.").getLaneStatus(parseConflictLaneArgs(payload, "conflicts.getLaneStatus")));
  register("conflicts.listOverlaps", { viewerAllowed: true }, async (payload) =>
    requireService(args.conflictService, "Conflict service not available.").listOverlaps(parseConflictLaneArgs(payload, "conflicts.listOverlaps")));
  register("conflicts.getBatchAssessment", { viewerAllowed: true }, async () =>
    requireService(args.conflictService, "Conflict service not available.").getBatchAssessment());
}

function registerPrAndDeeplinkRemoteCommands({ args, register }: RemoteCommandRegistrationDeps): void {
  register("prs.list", { viewerAllowed: true }, async () => args.prService.listAll());
  register("prs.refresh", { viewerAllowed: true }, async (payload) => {
    const prId = asTrimmedString(payload.prId);
    const prIds = asStringArray(payload.prIds);
    let refreshArgs: { prId?: string; prIds?: string[] } = {};
    if (prId) refreshArgs = { prId };
    else if (prIds.length > 0) refreshArgs = { prIds };
    await args.prService.refresh(refreshArgs);
    const prs = await args.prService.listAll();
    let refreshedCount = prs.length;
    if (prId) refreshedCount = 1;
    else if (prIds.length > 0) refreshedCount = prIds.length;
    return {
      refreshedCount,
      prs,
      snapshots: args.prService.listSnapshots(),
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
  register("prs.getDetail", { viewerAllowed: true }, async (payload) => args.prService.getDetail(requirePrId(payload, "prs.getDetail")));
  register("prs.getStatus", { viewerAllowed: true }, async (payload) => args.prService.getStatus(requirePrId(payload, "prs.getStatus")));
  register("prs.getChecks", { viewerAllowed: true }, async (payload) => args.prService.getChecks(requirePrId(payload, "prs.getChecks")));
  register("prs.getReviews", { viewerAllowed: true }, async (payload) => args.prService.getReviews(requirePrId(payload, "prs.getReviews")));
  register("prs.getComments", { viewerAllowed: true }, async (payload) => args.prService.getComments(requirePrId(payload, "prs.getComments")));
  register("prs.getFiles", { viewerAllowed: true }, async (payload) => args.prService.getFiles(requirePrId(payload, "prs.getFiles")));
  register("prs.getGitHubSnapshot", { viewerAllowed: true }, async (payload) =>
    args.prService.getGithubSnapshot({
      force: payload.force === true,
      includeExternalClosed: payload.includeExternalClosed === true,
    }));
  register("prs.getReviewThreads", { viewerAllowed: true }, async (payload) => args.prService.getReviewThreads(requirePrId(payload, "prs.getReviewThreads")));
  register("prs.getActionRuns", { viewerAllowed: true }, async (payload) => args.prService.getActionRuns(requirePrId(payload, "prs.getActionRuns")));
  register("prs.getActivity", { viewerAllowed: true }, async (payload) => args.prService.getActivity(requirePrId(payload, "prs.getActivity")));
  register("prs.getDeployments", { viewerAllowed: true }, async (payload) => args.prService.getDeployments(requirePrId(payload, "prs.getDeployments")));
  // Coordinate-based PR reads for PRs that are not mapped to an ADE lane (no DB
  // row). The preload sends these `*ByGithub` runtime actions before falling
  // back to IPC, so the socket runtime must register them alongside the
  // row-based reads. Args are GitHub coordinates: { repoOwner, repoName, githubPrNumber }.
  register("prs.getDetailByGithub", { viewerAllowed: true }, async (payload) => args.prService.getDetailByGithub(requirePrGithubCoords(payload, "prs.getDetailByGithub")));
  register("prs.getFilesByGithub", { viewerAllowed: true }, async (payload) => args.prService.getFilesByGithub(requirePrGithubCoords(payload, "prs.getFilesByGithub")));
  register("prs.getCommitsByGithub", { viewerAllowed: true }, async (payload) => args.prService.getCommitsByGithub(requirePrGithubCoords(payload, "prs.getCommitsByGithub")));
  register("prs.getActionRunsByGithub", { viewerAllowed: true }, async (payload) => args.prService.getActionRunsByGithub(requirePrGithubCoords(payload, "prs.getActionRunsByGithub")));
  register("prs.getActivityByGithub", { viewerAllowed: true }, async (payload) => args.prService.getActivityByGithub(requirePrGithubCoords(payload, "prs.getActivityByGithub")));
  register("prs.getChecksByGithub", { viewerAllowed: true }, async (payload) => args.prService.getChecksByGithub(requirePrGithubCoords(payload, "prs.getChecksByGithub")));
  register("prs.getReviewsByGithub", { viewerAllowed: true }, async (payload) => args.prService.getReviewsByGithub(requirePrGithubCoords(payload, "prs.getReviewsByGithub")));
  register("prs.getCommentsByGithub", { viewerAllowed: true }, async (payload) => args.prService.getCommentsByGithub(requirePrGithubCoords(payload, "prs.getCommentsByGithub")));
  register("prs.getReviewThreadsByGithub", { viewerAllowed: true }, async (payload) => args.prService.getReviewThreadsByGithub(requirePrGithubCoords(payload, "prs.getReviewThreadsByGithub")));
  register("prs.createFromLane", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.createFromLane(parseCreatePrArgs(payload)));
  register("prs.createQueue", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.createQueuePrs(parseCreateQueuePrsArgs(payload)));
  register("prs.linkToLane", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.linkToLane(parseLinkPrToLaneArgs(payload)));
  register("prs.preflightCreateLaneFromPrBranch", { viewerAllowed: true }, async (payload) => args.prService.preflightCreateLaneFromPrBranch(parseCreateLaneFromPrBranchArgs(payload)));
  register("prs.createLaneFromPrBranch", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.createLaneFromPrBranch(parseCreateLaneFromPrBranchArgs(payload)));
  register("prs.draftDescription", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.draftDescription(parseDraftPrDescriptionArgs(payload)));
  register("prs.land", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.land(parseLandPrArgs(payload)));
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
  register("prs.listIntegrationWorkflows", { viewerAllowed: true }, async (payload) =>
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
  register("prs.recheckIntegrationStep", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.recheckIntegrationStep(parseRecheckIntegrationStepArgs(payload)));
  register("prs.landQueueNext", { viewerAllowed: true, queueable: true }, async (payload) =>
    args.prService.landQueueNext(parseLandQueueNextArgs(payload)));
  register("prs.startQueueAutomation", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.queueLandingService) throw new Error("Queue automation is not available.");
    return args.queueLandingService.startQueue(parseStartQueueAutomationArgs(payload));
  });
  register("prs.pauseQueueAutomation", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.queueLandingService) throw new Error("Queue automation is not available.");
    return args.queueLandingService.pauseQueue(parsePauseQueueAutomationArgs(payload).queueId);
  });
  register("prs.resumeQueueAutomation", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.queueLandingService) throw new Error("Queue automation is not available.");
    return args.queueLandingService.resumeQueue(parseResumeQueueAutomationArgs(payload));
  });
  register("prs.cancelQueueAutomation", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.queueLandingService) throw new Error("Queue automation is not available.");
    return args.queueLandingService.cancelQueue(parseCancelQueueAutomationArgs(payload).queueId);
  });
  register("prs.reorderQueue", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.prService.reorderQueuePrs(parseReorderQueuePrsArgs(payload));
    return { ok: true };
  });
  register("prs.issueInventory.sync", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    const { prId } = parseIssueInventoryPrArgs(payload, "prs.issueInventory.sync");
    const [checks, reviewThreads, comments] = await Promise.all([
      args.prService.getChecks(prId),
      args.prService.getReviewThreads(prId),
      args.prService.getComments(prId).catch(() => []),
    ]);
    return args.issueInventoryService.syncFromPrData(prId, checks, reviewThreads, comments);
  });
  register("prs.issueInventory.get", { viewerAllowed: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    return args.issueInventoryService.getInventory(parseIssueInventoryPrArgs(payload, "prs.issueInventory.get").prId);
  });
  register("prs.issueInventory.getNew", { viewerAllowed: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    return args.issueInventoryService.getNewItems(parseIssueInventoryPrArgs(payload, "prs.issueInventory.getNew").prId);
  });
  register("prs.issueInventory.markFixed", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    const parsed = parseIssueInventoryItemsArgs(payload, "prs.issueInventory.markFixed");
    args.issueInventoryService.markFixed(parsed.prId, parsed.itemIds);
    return { ok: true };
  });
  register("prs.issueInventory.markDismissed", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    const parsed = parseIssueInventoryDismissArgs(payload);
    args.issueInventoryService.markDismissed(parsed.prId, parsed.itemIds, parsed.reason);
    return { ok: true };
  });
  register("prs.issueInventory.markEscalated", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    const parsed = parseIssueInventoryItemsArgs(payload, "prs.issueInventory.markEscalated");
    args.issueInventoryService.markEscalated(parsed.prId, parsed.itemIds);
    return { ok: true };
  });
  register("prs.issueInventory.getConvergence", { viewerAllowed: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    return args.issueInventoryService.getConvergenceStatus(parseIssueInventoryPrArgs(payload, "prs.issueInventory.getConvergence").prId);
  });
  register("prs.issueInventory.reset", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    args.issueInventoryService.resetInventory(parseIssueInventoryPrArgs(payload, "prs.issueInventory.reset").prId);
    return { ok: true };
  });
  register("prs.convergenceState.get", { viewerAllowed: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    return args.issueInventoryService.getConvergenceRuntime(parseIssueInventoryPrArgs(payload, "prs.convergenceState.get").prId);
  });
  register("prs.convergenceState.save", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    const parsed = parseConvergenceStatePatch(payload);
    return args.issueInventoryService.saveConvergenceRuntime(parsed.prId, parsed.state);
  });
  register("prs.convergenceState.delete", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    args.issueInventoryService.resetConvergenceRuntime(parseIssueInventoryPrArgs(payload, "prs.convergenceState.delete").prId);
    return { ok: true };
  });
  register("prs.pipelineSettings.get", { viewerAllowed: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    return args.issueInventoryService.getPipelineSettings(parseIssueInventoryPrArgs(payload, "prs.pipelineSettings.get").prId);
  });
  register("prs.pipelineSettings.save", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    const parsed = parsePipelineSettingsPatch(payload);
    args.issueInventoryService.savePipelineSettings(parsed.prId, parsed.settings);
    return { ok: true };
  });
  register("prs.pipelineSettings.delete", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.issueInventoryService) throw new Error("Issue inventory is not available.");
    args.issueInventoryService.deletePipelineSettings(parseIssueInventoryPrArgs(payload, "prs.pipelineSettings.delete").prId);
    return { ok: true };
  });
  register("prs.pathToMerge.start", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.pathToMergeOrchestrator) {
      throw new Error("Path to Merge orchestrator is not available in this build.");
    }
    const { prId } = parseIssueInventoryPrArgs(payload, "prs.pathToMerge.start");
    const modelId = typeof payload?.modelId === "string" ? payload.modelId : null;
    const reasoning = typeof payload?.reasoning === "string" ? payload.reasoning : null;
    const additionalInstructions = typeof payload?.additionalInstructions === "string"
      ? payload.additionalInstructions
      : null;
    const rawScope = payload?.scope;
    const scope = rawScope === "checks" || rawScope === "comments" || rawScope === "both"
      ? rawScope
      : undefined;
    return args.pathToMergeOrchestrator.startPathToMerge({
      prId,
      modelId,
      reasoning,
      scope,
      additionalInstructions,
    });
  });
  register("prs.pathToMerge.stop", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.pathToMergeOrchestrator) {
      throw new Error("Path to Merge orchestrator is not available in this build.");
    }
    const { prId } = parseIssueInventoryPrArgs(payload, "prs.pathToMerge.stop");
    const reason = typeof payload?.reason === "string" ? payload.reason : null;
    return args.pathToMergeOrchestrator.stopPathToMerge({ prId, reason });
  });
  register("prs.getMobileSnapshot", { viewerAllowed: true }, async () => args.prService.getMobileSnapshot());
}

export function createSyncRemoteCommandService(args: SyncRemoteCommandServiceArgs) {
  const registry = new Map<SyncRemoteCommandAction, RegisteredRemoteCommand>();

  const register = (
    action: SyncRemoteCommandAction,
    policy: SyncRemoteCommandPolicy,
    handler: (payload: Record<string, unknown>) => Promise<unknown>,
    scope: SyncRemoteCommandDescriptor["scope"] = "project",
  ) => {
    registry.set(action, {
      descriptor: { action, scope, policy },
      handler,
    });
  };

  registerLaneRemoteCommands({ args, register });
  registerWorkRemoteCommands({ args, register });
  registerProcessRemoteCommands({ args, register });
  registerChatRemoteCommands({ args, register });
  registerModelPickerRemoteCommands({ args, register });
  registerCtoRemoteCommands({ args, register });
  registerGitAndFileRemoteCommands({ args, register });
  registerConflictRemoteCommands({ args, register });
  registerPrAndDeeplinkRemoteCommands({ args, register });
  return {
    getSupportedActions(): SyncRemoteCommandAction[] {
      return [...registry.keys()];
    },

    getDescriptors(): SyncRemoteCommandDescriptor[] {
      return [...registry.values()].map((entry) => entry.descriptor);
    },

    getPolicy(action: string): SyncRemoteCommandPolicy | null {
      return registry.get(action as SyncRemoteCommandAction)?.descriptor.policy ?? null;
    },

    getDescriptor(action: string): SyncRemoteCommandDescriptor | null {
      return registry.get(action as SyncRemoteCommandAction)?.descriptor ?? null;
    },

    async execute(payload: SyncCommandPayload): Promise<unknown> {
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
      return await handler.handler(commandArgs);
    },
  };
}

export type SyncRemoteCommandService = ReturnType<typeof createSyncRemoteCommandService>;
