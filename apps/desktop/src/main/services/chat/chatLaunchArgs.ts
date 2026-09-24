import type {
  AgentChatCreateArgs,
  AgentChatFileRef,
  AgentChatSendArgs,
  AgentChatUpdateSessionArgs,
  ChatLaunchArgs,
  ChatLaunchChatArgs,
  ChatLaunchCompleteClientArgs,
  ChatLaunchIdArgs,
  ChatLaunchLaneConfig,
  ChatLaunchQueueMessageArgs,
  LaneLinearIssue,
} from "../../../shared/types";
import { isRecord } from "../shared/utils";

/**
 * The one parser for untrusted chat-launch input. Both entry points — the
 * desktop action domain (`chat.startLaunch` … in adeActions/registry.ts) and
 * the sync host's phone commands (syncRemoteCommandService.ts) — turn their raw
 * payloads into typed args here, so a launch is validated the same way
 * whichever client started it. The `chat.create` / `chat.send` field parsers
 * live here too because the launch builds on them; the sync host reuses them
 * for its direct chat commands.
 */

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requireString(value: unknown, message: string): string {
  const parsed = asTrimmedString(value);
  if (!parsed) throw new Error(message);
  return parsed;
}

function requireRecord(value: unknown, actionName: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${actionName} expects an object payload.`);
  return value;
}

export function parseAgentChatFileRefs(value: unknown): AgentChatFileRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: AgentChatFileRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (entry.type === "image-url") {
      // Pasted image links: the chat service fetches them itself.
      const url = asTrimmedString(entry.url);
      if (!url || !/^https?:\/\//i.test(url)) continue;
      attachments.push({ path: asTrimmedString(entry.path) ?? url, type: "image-url", url });
      continue;
    }
    const path = asTrimmedString(entry.path);
    let type: "image" | "file" | null = null;
    if (entry.type === "image") type = "image";
    else if (entry.type === "file") type = "file";
    if (!path || !type) continue;
    attachments.push({ path, type });
  }
  return attachments;
}

export function parseCursorConfigValues(
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

/** Every `chat.create` field except the lane (which a new-lane launch assigns itself). */
export function parseAgentChatCreateFields(value: Record<string, unknown>): Omit<AgentChatCreateArgs, "laneId"> {
  const parsed: Omit<AgentChatCreateArgs, "laneId"> = {
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
  if ("piProfileId" in value) parsed.piProfileId = value.piProfileId == null ? null : asTrimmedString(value.piProfileId) ?? null;
  if ("piProviderId" in value) parsed.piProviderId = value.piProviderId == null ? null : asTrimmedString(value.piProviderId) ?? null;
  if ("piModelId" in value) parsed.piModelId = value.piModelId == null ? null : asTrimmedString(value.piModelId) ?? null;
  if ("piSessionId" in value) parsed.piSessionId = value.piSessionId == null ? null : asTrimmedString(value.piSessionId) ?? null;
  if ("piSessionFile" in value) parsed.piSessionFile = value.piSessionFile == null ? null : asTrimmedString(value.piSessionFile) ?? null;
  if ("droidPermissionMode" in value) parsed.droidPermissionMode = value.droidPermissionMode == null ? undefined : (asTrimmedString(value.droidPermissionMode) ?? undefined) as AgentChatCreateArgs["droidPermissionMode"];
  if ("cursorModeId" in value) parsed.cursorModeId = value.cursorModeId == null ? null : asTrimmedString(value.cursorModeId) ?? null;
  if ("cursorConfigValues" in value) parsed.cursorConfigValues = parseCursorConfigValues(value.cursorConfigValues);
  if ("requestedCwd" in value) parsed.requestedCwd = value.requestedCwd == null ? undefined : requireString(value.requestedCwd, "chat.create requires a non-empty requestedCwd when provided.");

  return parsed;
}

/** Every `chat.send` field except the session; `text` is only type-checked here. */
function parseAgentChatMessageFields(value: Record<string, unknown>): Omit<AgentChatSendArgs, "sessionId" | "text"> {
  const attachments = parseAgentChatFileRefs(value.attachments);
  return {
    ...(asTrimmedString(value.displayText) ? { displayText: asTrimmedString(value.displayText)! } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(asTrimmedString(value.reasoningEffort) ? { reasoningEffort: asTrimmedString(value.reasoningEffort)! } : {}),
    ...(asTrimmedString(value.executionMode) ? { executionMode: asTrimmedString(value.executionMode)! as AgentChatSendArgs["executionMode"] } : {}),
    ...(asTrimmedString(value.interactionMode) ? { interactionMode: asTrimmedString(value.interactionMode)! as AgentChatSendArgs["interactionMode"] } : {}),
  };
}

export function parseAgentChatSendArgs(value: Record<string, unknown>): AgentChatSendArgs {
  return {
    sessionId: requireString(value.sessionId, "chat.send requires sessionId."),
    text: requireString(value.text, "chat.send requires text."),
    ...parseAgentChatMessageFields(value),
  };
}

/**
 * A launch's chat: the `chat.create` fields plus the harness selection the
 * desktop composer names by id (the brain resolves it against its own preset
 * and key stores), and the opening message. Unlike `chat.send`, the opening
 * message may have empty text when it carries only context (a visual-context
 * launch), and it keeps its context attachments and cursor runtime.
 */
function parseChatLaunchChat(value: unknown): ChatLaunchChatArgs {
  const rawChat = isRecord(value) ? value : null;
  if (!rawChat || !isRecord(rawChat.create) || !isRecord(rawChat.message)) {
    throw new Error("chat.startLaunch requires chat.create and chat.message.");
  }
  const rawCreate = rawChat.create;
  const rawMessage = rawChat.message;
  requireString(rawCreate.provider, "chat.startLaunch requires chat.create.provider.");
  if (typeof rawMessage.text !== "string") throw new Error("chat.startLaunch requires chat.message.text.");
  // An empty model is fine: the launch service auto-picks one (same as chat.create).
  const create: ChatLaunchChatArgs["create"] = {
    ...parseAgentChatCreateFields(rawCreate),
    ...(asTrimmedString(rawCreate.presetId) ? { presetId: asTrimmedString(rawCreate.presetId)! } : {}),
    ...(asTrimmedString(rawCreate.credentialId) ? { credentialId: asTrimmedString(rawCreate.credentialId)! } : {}),
    ...(asTrimmedString(rawCreate.instanceId) ? { instanceId: asTrimmedString(rawCreate.instanceId)! } : {}),
  };
  const runtime = rawMessage.runtime === "local" || rawMessage.runtime === "cloud" ? rawMessage.runtime : null;
  const message: ChatLaunchChatArgs["message"] = {
    text: rawMessage.text,
    ...parseAgentChatMessageFields(rawMessage),
    ...(Array.isArray(rawMessage.contextAttachments)
      ? { contextAttachments: rawMessage.contextAttachments.filter(isRecord) as unknown as NonNullable<AgentChatSendArgs["contextAttachments"]> }
      : {}),
    ...(runtime ? { runtime } : {}),
  };
  return { create, message };
}

/**
 * The optional lane recipe a client may attach to a new-lane launch. Unknown
 * modes are dropped (a launch that only carried the mode is a default root
 * lane); every other field is optional and trimmed.
 */
export function parseChatLaunchLaneConfig(value: unknown): ChatLaunchLaneConfig | undefined {
  if (!isRecord(value)) return undefined;
  const mode = value.mode === "child" ? "child" : value.mode === "import" ? "import" : value.mode === "root" ? "root" : null;
  if (!mode) return undefined;
  const linearIssue = isRecord(value.linearIssue) && asTrimmedString(value.linearIssue.id)
    ? value.linearIssue as unknown as LaneLinearIssue
    : null;
  return {
    mode,
    ...(asTrimmedString(value.parentLaneId) ? { parentLaneId: asTrimmedString(value.parentLaneId)! } : {}),
    ...(asTrimmedString(value.branchRef) ? { branchRef: asTrimmedString(value.branchRef)! } : {}),
    ...(asTrimmedString(value.templateId) ? { templateId: asTrimmedString(value.templateId)! } : {}),
    ...(asTrimmedString(value.color) ? { color: asTrimmedString(value.color)! } : {}),
    ...(linearIssue ? { linearIssue } : {}),
  };
}

/**
 * `chat.startLaunch`. The lane and session ids are the launch's to assign; the
 * launch service normalizes and checks the reserved ids and auto-picks an
 * empty model, shared by every entry point.
 */
export function parseChatLaunchArgs(value: unknown): ChatLaunchArgs {
  const record = requireRecord(value, "chat.startLaunch");
  const launchId = requireString(record.launchId, "chat.startLaunch requires launchId.");
  const kind = record.kind === "cli" ? "cli" : "chat";
  const attachments = parseAgentChatFileRefs(record.attachments);
  const chat = kind === "chat" ? parseChatLaunchChat(record.chat) : undefined;
  const laneConfig = parseChatLaunchLaneConfig(record.laneConfig);
  return {
    kind,
    mode: record.mode === "background" ? "background" : "foreground",
    launchId,
    ...(asTrimmedString(record.laneId) ? { laneId: asTrimmedString(record.laneId) } : {}),
    ...(asTrimmedString(record.laneName) ? { laneName: asTrimmedString(record.laneName) } : {}),
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    ...(asTrimmedString(record.displayPrompt) ? { displayPrompt: asTrimmedString(record.displayPrompt) } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(asTrimmedString(record.baseBranch) ? { baseBranch: asTrimmedString(record.baseBranch) } : {}),
    ...(laneConfig ? { laneConfig } : {}),
    ...(asTrimmedString(record.modelId) ? { modelId: asTrimmedString(record.modelId) } : {}),
    ...(asTrimmedString(record.provider) ? { provider: asTrimmedString(record.provider) } : {}),
    ...(asTrimmedString(record.title) ? { title: asTrimmedString(record.title) } : {}),
    ...(asTrimmedString(record.originClientId) ? { originClientId: asTrimmedString(record.originClientId) } : {}),
    ...(chat ? { chat } : {}),
  };
}

/** `chat.getLaunch` / `cancelLaunch` / `retryLaunch` / `startLaunchNow`. */
export function parseChatLaunchIdArgs(value: unknown, actionName: string): ChatLaunchIdArgs {
  const record = requireRecord(value, actionName);
  return { launchId: requireString(record.launchId, `${actionName} requires launchId.`) };
}

export function parseChatLaunchQueueMessageArgs(value: unknown): ChatLaunchQueueMessageArgs {
  const record = requireRecord(value, "chat.queueLaunchMessage");
  const attachments = parseAgentChatFileRefs(record.attachments);
  return {
    launchId: requireString(record.launchId, "chat.queueLaunchMessage requires launchId."),
    text: typeof record.text === "string" ? record.text : "",
    ...(asTrimmedString(record.displayText) ? { displayText: asTrimmedString(record.displayText)! } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

export function parseChatLaunchCompleteClientArgs(value: unknown): ChatLaunchCompleteClientArgs {
  const record = requireRecord(value, "chat.completeLaunchClient");
  return {
    launchId: requireString(record.launchId, "chat.completeLaunchClient requires launchId."),
    ...(asTrimmedString(record.sessionId) ? { sessionId: asTrimmedString(record.sessionId)! } : {}),
    ...(asTrimmedString(record.error) ? { error: asTrimmedString(record.error)! } : {}),
  };
}
