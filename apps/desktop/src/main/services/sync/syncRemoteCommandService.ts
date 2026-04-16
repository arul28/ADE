import type {
  AgentChatCreateArgs,
  AgentChatApproveArgs,
  AgentChatDisposeArgs,
  AgentChatFileRef,
  AgentChatGetSummaryArgs,
  AgentChatListArgs,
  AgentChatProvider,
  AgentChatRespondToInputArgs,
  AgentChatResumeArgs,
  AgentChatSendArgs,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatInterruptArgs,
  AgentChatUpdateSessionArgs,
  ApplyLaneTemplateArgs,
  ArchiveLaneArgs,
  AttachLaneArgs,
  ClosePrArgs,
  CreateChildLaneArgs,
  CreateLaneArgs,
  CreateLaneFromUnstagedArgs,
  CreatePrFromLaneArgs,
  DeleteLaneArgs,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GitBatchFileActionArgs,
  GitCherryPickArgs,
  GitCommitArgs,
  GitFileActionArgs,
  GitGenerateCommitMessageArgs,
  GitGetCommitMessageArgs,
  GitGetFileHistoryArgs,
  GitListBranchesArgs,
  GitListCommitFilesArgs,
  GitPushArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitSyncArgs,
  LandPrArgs,
  LaneEnvInitConfig,
  LaneEnvInitProgress,
  LaneDetailPayload,
  LaneListSnapshot,
  LaneOverlayOverrides,
  LaneStateSnapshotSummary,
  ListLanesArgs,
  ListSessionsArgs,
  RebasePushArgs,
  RebaseStartArgs,
  RenameLaneArgs,
  ReopenPrArgs,
  ReparentLaneArgs,
  RequestPrReviewersArgs,
  SyncCommandPayload,
  SyncRemoteCommandAction,
  SyncRemoteCommandDescriptor,
  SyncRemoteCommandPolicy,
  SyncRunQuickCommandArgs,
  UpdateSessionMetaArgs,
  TerminalToolType,
  UpdateLaneAppearanceArgs,
  WriteTextAtomicArgs,
} from "../../../shared/types";
import type { createAgentChatService } from "../chat/agentChatService";
import { matchLaneOverlayPolicies } from "../config/laneOverlayMatcher";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createDiffService } from "../diffs/diffService";
import type { createFileService } from "../files/fileService";
import type { createGitOperationsService } from "../git/gitOperationsService";
import type { createAutoRebaseService } from "../lanes/autoRebaseService";
import type { createLaneEnvironmentService } from "../lanes/laneEnvironmentService";
import type { createLaneService } from "../lanes/laneService";
import type { createLaneTemplateService } from "../lanes/laneTemplateService";
import type { createPortAllocationService } from "../lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../lanes/rebaseSuggestionService";
import type { Logger } from "../logging/logger";
import type { createPrService } from "../prs/prService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";

type SyncRemoteCommandServiceArgs = {
  laneService: ReturnType<typeof createLaneService>;
  prService: ReturnType<typeof createPrService>;
  ptyService: ReturnType<typeof createPtyService>;
  sessionService: ReturnType<typeof createSessionService>;
  fileService: ReturnType<typeof createFileService>;
  gitService?: ReturnType<typeof createGitOperationsService>;
  diffService?: ReturnType<typeof createDiffService>;
  conflictService?: ReturnType<typeof createConflictService>;
  agentChatService?: ReturnType<typeof createAgentChatService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  portAllocationService?: ReturnType<typeof createPortAllocationService> | null;
  laneEnvironmentService?: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService?: ReturnType<typeof createLaneTemplateService> | null;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
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

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asTrimmedString(entry)).filter((entry): entry is string => Boolean(entry));
}

function parseAgentChatFileRefs(value: unknown): AgentChatFileRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: AgentChatFileRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = asTrimmedString(entry.path);
    const type = entry.type === "image" ? "image" : entry.type === "file" ? "file" : null;
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
  };
}

function parseCreateChildLaneArgs(value: Record<string, unknown>): CreateChildLaneArgs {
  return {
    name: requireString(value.name, "lanes.createChild requires name."),
    parentLaneId: requireString(value.parentLaneId, "lanes.createChild requires parentLaneId."),
    ...(asTrimmedString(value.description) ? { description: asTrimmedString(value.description)! } : {}),
    ...(asTrimmedString(value.folder) ? { folder: asTrimmedString(value.folder)! } : {}),
  };
}

function parseCreateLaneFromUnstagedArgs(value: Record<string, unknown>): CreateLaneFromUnstagedArgs {
  return {
    name: requireString(value.name, "lanes.createFromUnstaged requires name."),
    sourceLaneId: requireString(value.sourceLaneId, "lanes.createFromUnstaged requires sourceLaneId."),
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
  return {
    laneId: requireString(value.laneId, "lanes.reparent requires laneId."),
    newParentLaneId: requireString(value.newParentLaneId, "lanes.reparent requires newParentLaneId."),
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

function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return (
    t === "codex-chat"
    || t === "claude-chat"
    || t === "opencode-chat"
    || t === "cursor"
    || t.endsWith("-chat")
  );
}

async function listRemoteWorkSessions(
  args: SyncRemoteCommandServiceArgs,
  filters: ListSessionsArgs,
) {
  let sessions = args.ptyService.enrichSessions(args.sessionService.list(filters));
  const laneId = typeof filters.laneId === "string" ? filters.laneId.trim() : "";
  let allChats: AgentChatSessionSummary[] = [];
  try {
    allChats = await args.agentChatService?.listSessions(laneId || undefined, { includeIdentity: true }) ?? [];
  } catch {
    allChats = [];
  }

  const identitySessionIds = new Set(
    allChats
      .filter((chat) => Boolean(chat.identityKey))
      .map((chat) => chat.sessionId),
  );
  if (identitySessionIds.size > 0) {
    sessions = sessions.filter((session) => !identitySessionIds.has(session.id));
  }

  const chats = allChats.filter((chat) => !chat.identityKey);
  if (chats.length === 0) return sessions;
  const chatSummaryBySessionId = new Map(chats.map((chat) => [chat.sessionId, chat] as const));
  return sessions.map((session) => {
    if (!isChatToolType(session.toolType)) return session;
    if (session.status !== "running") return session;
    const chat = chatSummaryBySessionId.get(session.id);
    if (!chat) return session;
    if (chat.awaitingInput) return { ...session, runtimeState: "waiting-input" as const, chatIdleSinceAt: null };
    if (chat.status === "active") return { ...session, runtimeState: "running" as const, chatIdleSinceAt: null };
    if (chat.status === "idle") return { ...session, runtimeState: "idle" as const, chatIdleSinceAt: chat.idleSinceAt ?? null };
    return session;
  });
}

function parseCloseSessionArgs(value: Record<string, unknown>): { sessionId: string } {
  return {
    sessionId: requireString(value.sessionId, "work.closeSession requires sessionId."),
  };
}

function parseAgentChatListArgs(value: Record<string, unknown>): AgentChatListArgs {
  return {
    ...(asTrimmedString(value.laneId) ? { laneId: asTrimmedString(value.laneId)! } : {}),
    includeAutomation: asOptionalBoolean(value.includeAutomation),
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
  if ("codexApprovalPolicy" in value) parsed.codexApprovalPolicy = value.codexApprovalPolicy == null ? undefined : asTrimmedString(value.codexApprovalPolicy) as AgentChatCreateArgs["codexApprovalPolicy"];
  if ("codexSandbox" in value) parsed.codexSandbox = value.codexSandbox == null ? undefined : asTrimmedString(value.codexSandbox) as AgentChatCreateArgs["codexSandbox"];
  if ("codexConfigSource" in value) parsed.codexConfigSource = value.codexConfigSource == null ? undefined : asTrimmedString(value.codexConfigSource) as AgentChatCreateArgs["codexConfigSource"];
  if ("opencodePermissionMode" in value) parsed.opencodePermissionMode = value.opencodePermissionMode == null ? undefined : asTrimmedString(value.opencodePermissionMode) as AgentChatCreateArgs["opencodePermissionMode"];
  if ("cursorModeId" in value) parsed.cursorModeId = value.cursorModeId == null ? null : asTrimmedString(value.cursorModeId) ?? null;
  if ("cursorConfigValues" in value) parsed.cursorConfigValues = parseCursorConfigValues(value.cursorConfigValues);
  if ("computerUse" in value) parsed.computerUse = value.computerUse == null ? null : value.computerUse as AgentChatCreateArgs["computerUse"];
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

function parseAgentChatInterruptArgs(value: Record<string, unknown>): AgentChatInterruptArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.interrupt requires sessionId."),
  };
}

function parseAgentChatResumeArgs(value: Record<string, unknown>): AgentChatResumeArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.resume requires sessionId."),
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
  if ("opencodePermissionMode" in value) parsed.opencodePermissionMode = value.opencodePermissionMode == null ? undefined : asTrimmedString(value.opencodePermissionMode) as AgentChatUpdateSessionArgs["opencodePermissionMode"];
  if ("cursorModeId" in value) parsed.cursorModeId = value.cursorModeId == null ? null : asTrimmedString(value.cursorModeId) ?? null;
  if ("cursorConfigValues" in value) {
    parsed.cursorConfigValues = parseCursorConfigValues(value.cursorConfigValues);
  }
  if ("computerUse" in value) parsed.computerUse = value.computerUse == null ? null : value.computerUse as AgentChatUpdateSessionArgs["computerUse"];
  if ("manuallyNamed" in value) parsed.manuallyNamed = value.manuallyNamed === true;
  return parsed;
}

function parseAgentChatDisposeArgs(value: Record<string, unknown>): AgentChatDisposeArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.dispose requires sessionId."),
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

function parseGitStashPushArgs(value: Record<string, unknown>): GitStashPushArgs {
  return {
    laneId: requireString(value.laneId, "git.stashPush requires laneId."),
    ...(asTrimmedString(value.message) ? { message: asTrimmedString(value.message)! } : {}),
    includeUntracked: asOptionalBoolean(value.includeUntracked),
  };
}

function parseGitStashRefArgs(value: Record<string, unknown>, action: string): GitStashRefArgs {
  return {
    laneId: requireString(value.laneId, `${action} requires laneId.`),
    stashRef: requireString(value.stashRef, `${action} requires stashRef.`),
  };
}

function parseGitSyncArgs(value: Record<string, unknown>): GitSyncArgs {
  return {
    laneId: requireString(value.laneId, "git.sync requires laneId."),
    ...(asTrimmedString(value.mode) ? { mode: value.mode as GitSyncArgs["mode"] } : {}),
    ...(asTrimmedString(value.baseRef) ? { baseRef: asTrimmedString(value.baseRef)! } : {}),
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

function parseGitCheckoutBranchArgs(value: Record<string, unknown>): { laneId: string; branchName: string } {
  return {
    laneId: requireString(value.laneId, "git.checkoutBranch requires laneId."),
    branchName: requireString(value.branchName, "git.checkoutBranch requires branchName."),
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

function requirePrId(value: Record<string, unknown>, action: string): string {
  return requireString(value.prId, `${action} requires prId.`);
}

function parseCreatePrArgs(value: Record<string, unknown>): CreatePrFromLaneArgs {
  const laneId = asTrimmedString(value.laneId);
  const title = asTrimmedString(value.title);
  const body = typeof value.body === "string" ? value.body : "";
  if (!laneId || !title) throw new Error("prs.createFromLane requires laneId and title.");
  return {
    laneId,
    title,
    body,
    draft: value.draft === true,
    ...(asTrimmedString(value.baseBranch) ? { baseBranch: asTrimmedString(value.baseBranch)! } : {}),
    ...(asStringArray(value.labels).length ? { labels: asStringArray(value.labels) } : {}),
    ...(asStringArray(value.reviewers).length ? { reviewers: asStringArray(value.reviewers) } : {}),
    ...(typeof value.allowDirtyWorktree === "boolean" ? { allowDirtyWorktree: value.allowDirtyWorktree } : {}),
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
  if (reviewers.length === 0) throw new Error("prs.requestReviewers requires at least one reviewer.");
  return { prId, reviewers };
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

async function resolveLaneOverlayContext(args: SyncRemoteCommandServiceArgs, laneId: string) {
  const projectConfigService = requireService(args.projectConfigService, "Project config service not available.");
  const lanes = await args.laneService.list({ includeStatus: false });
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

export function createSyncRemoteCommandService(args: SyncRemoteCommandServiceArgs) {
  const registry = new Map<SyncRemoteCommandAction, RegisteredRemoteCommand>();

  const register = (
    action: SyncRemoteCommandAction,
    policy: SyncRemoteCommandPolicy,
    handler: (payload: Record<string, unknown>) => Promise<unknown>,
  ) => {
    registry.set(action, {
      descriptor: { action, policy },
      handler,
    });
  };

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
  register("lanes.attach", { viewerAllowed: true, queueable: true }, async (payload) => args.laneService.attach(parseAttachLaneArgs(payload)));
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
  register("lanes.delete", { viewerAllowed: true, queueable: true }, async (payload) => {
    await args.laneService.delete(parseDeleteLaneArgs(payload));
    return { ok: true };
  });
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
    if (!args.rebaseSuggestionService) return { ok: true };
    await args.rebaseSuggestionService.dismiss({ laneId: requireString(payload.laneId, "lanes.dismissRebaseSuggestion requires laneId.") });
    return { ok: true };
  });
  register("lanes.deferRebaseSuggestion", { viewerAllowed: true, queueable: true }, async (payload) => {
    if (!args.rebaseSuggestionService) return { ok: true };
    await args.rebaseSuggestionService.defer({
      laneId: requireString(payload.laneId, "lanes.deferRebaseSuggestion requires laneId."),
      minutes: asOptionalNumber(payload.minutes) ?? 60,
    });
    return { ok: true };
  });
  register("lanes.listAutoRebaseStatuses", { viewerAllowed: true }, async () => args.autoRebaseService?.listStatuses() ?? []);
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
  register("work.closeSession", { viewerAllowed: true, queueable: true }, async (payload) => {
    const { sessionId } = parseCloseSessionArgs(payload);
    const session = args.sessionService.get(sessionId);
    if (session?.ptyId) {
      await args.ptyService.dispose({ ptyId: session.ptyId, sessionId });
    }
    return { ok: true };
  });

  register("chat.listSessions", { viewerAllowed: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatListArgs(payload);
    return agentChatService.listSessions(parsed.laneId, { includeAutomation: parsed.includeAutomation });
  });
  register("chat.getSummary", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getSessionSummary(parseAgentChatGetSummaryArgs(payload).sessionId));
  register("chat.getTranscript", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getChatTranscript(parseGetTranscriptArgs(payload)));
  register("chat.create", { viewerAllowed: true, queueable: true }, async (payload) => {
    const agentChatService = requireService(args.agentChatService, "Agent chat service not available.");
    const parsed = parseAgentChatCreateArgs(payload);
    return await agentChatService.createSession(await resolveChatCreateArgs(agentChatService, parsed));
  });
  register("chat.send", { viewerAllowed: true, queueable: true }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").sendMessage(parseAgentChatSendArgs(payload));
    return { ok: true };
  });
  register("chat.interrupt", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").interrupt(parseAgentChatInterruptArgs(payload));
    return { ok: true };
  });
  register("chat.steer", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").steer(parseAgentChatSteerArgs(payload));
    return { ok: true };
  });
  register("chat.cancelSteer", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").cancelSteer(parseAgentChatCancelSteerArgs(payload));
    return { ok: true };
  });
  register("chat.editSteer", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").editSteer(parseAgentChatEditSteerArgs(payload));
    return { ok: true };
  });
  register("chat.approve", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").approveToolUse(parseAgentChatApproveArgs(payload));
    return { ok: true };
  });
  register("chat.respondToInput", { viewerAllowed: true, queueable: false }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").respondToInput(parseAgentChatRespondToInputArgs(payload));
    return { ok: true };
  });
  register("chat.resume", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").resumeSession(parseAgentChatResumeArgs(payload)));
  register("chat.updateSession", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").updateSession(parseAgentChatUpdateSessionArgs(payload)));
  register("chat.dispose", { viewerAllowed: true, queueable: true }, async (payload) => {
    await requireService(args.agentChatService, "Agent chat service not available.").dispose(parseAgentChatDisposeArgs(payload));
    return { ok: true };
  });
  register("chat.models", { viewerAllowed: true }, async (payload) =>
    requireService(args.agentChatService, "Agent chat service not available.").getAvailableModels(parseChatModelsArgs(payload)));

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
  register("git.revertCommit", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").revertCommit(parseGitRevertArgs(payload)));
  register("git.cherryPickCommit", { viewerAllowed: true, queueable: true }, async (payload) =>
    requireService(args.gitService, "Git service not available.").cherryPickCommit(parseGitCherryPickArgs(payload)));
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
    requireService(args.gitService, "Git service not available.").pull(parseConflictLaneArgs(payload, "git.pull")));
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

  register("conflicts.getLaneStatus", { viewerAllowed: true }, async (payload) =>
    requireService(args.conflictService, "Conflict service not available.").getLaneStatus(parseConflictLaneArgs(payload, "conflicts.getLaneStatus")));
  register("conflicts.listOverlaps", { viewerAllowed: true }, async (payload) =>
    requireService(args.conflictService, "Conflict service not available.").listOverlaps(parseConflictLaneArgs(payload, "conflicts.listOverlaps")));
  register("conflicts.getBatchAssessment", { viewerAllowed: true }, async () =>
    requireService(args.conflictService, "Conflict service not available.").getBatchAssessment());

  register("prs.list", { viewerAllowed: true }, async () => args.prService.listAll());
  register("prs.refresh", { viewerAllowed: true }, async (payload) => {
    const prId = asTrimmedString(payload.prId);
    const prIds = asStringArray(payload.prIds);
    await args.prService.refresh(prId ? { prId } : prIds.length > 0 ? { prIds } : {});
    const prs = await args.prService.listAll();
    return {
      refreshedCount: prId ? 1 : prIds.length > 0 ? prIds.length : prs.length,
      prs,
      snapshots: args.prService.listSnapshots(),
    };
  });
  register("prs.getDetail", { viewerAllowed: true }, async (payload) => args.prService.getDetail(requirePrId(payload, "prs.getDetail")));
  register("prs.getStatus", { viewerAllowed: true }, async (payload) => args.prService.getStatus(requirePrId(payload, "prs.getStatus")));
  register("prs.getChecks", { viewerAllowed: true }, async (payload) => args.prService.getChecks(requirePrId(payload, "prs.getChecks")));
  register("prs.getReviews", { viewerAllowed: true }, async (payload) => args.prService.getReviews(requirePrId(payload, "prs.getReviews")));
  register("prs.getComments", { viewerAllowed: true }, async (payload) => args.prService.getComments(requirePrId(payload, "prs.getComments")));
  register("prs.getFiles", { viewerAllowed: true }, async (payload) => args.prService.getFiles(requirePrId(payload, "prs.getFiles")));
  register("prs.createFromLane", { viewerAllowed: true, queueable: true }, async (payload) => args.prService.createFromLane(parseCreatePrArgs(payload)));
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
  register("prs.getMobileSnapshot", { viewerAllowed: true }, async () => args.prService.getMobileSnapshot());

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

    async execute(payload: SyncCommandPayload): Promise<unknown> {
      const handler = registry.get(payload.action as SyncRemoteCommandAction);
      if (!handler) {
        throw new Error(`Unsupported remote command: ${payload.action}`);
      }
      const commandArgs = isRecord(payload.args) ? payload.args : {};
      args.logger.debug?.("sync.remote_command.execute", {
        action: payload.action,
        policy: handler.descriptor.policy,
      });
      return await handler.handler(commandArgs);
    },
  };
}

export type SyncRemoteCommandService = ReturnType<typeof createSyncRemoteCommandService>;
