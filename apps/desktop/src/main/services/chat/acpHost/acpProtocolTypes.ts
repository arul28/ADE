/**
 * Agent Client Protocol (ACP) wire types, protocol version 1.
 *
 * These declarations mirror `@agentclientprotocol/sdk@1.4.0`
 * (`dist/schema/types.gen.d.ts`). Only the parts the ADE host uses are here.
 *
 * Why the types live in this repository and not in a dependency:
 *
 * 1. The published SDK is ESM only (`"type": "module"`), and it declares a
 *    `zod` peer dependency. The desktop main process bundles to CommonJS. A
 *    runtime import would add an ESM/CJS interop problem and a second zod copy
 *    for no gain, because the host does not use the SDK's `Connection` class.
 * 2. The host must control the transport. It needs a process-tree kill, a
 *    connection pool, a cancel that some dialects send as a notification, and
 *    tolerance for banner text on stdout. The SDK transport models none of
 *    these.
 * 3. The worktree `node_modules` is a symbolic link into the developer's live
 *    checkout. An install there writes to shared state that a running ADE brain
 *    uses. See AGENTS.md, "Ways to hurt yourself".
 *
 * Keep this file in step with the schema when the protocol changes. Compare it
 * against `schema/schema.json` in the published package.
 */

/** Wire values are plain JSON. */
export type AcpJsonValue =
  | null
  | boolean
  | number
  | string
  | AcpJsonValue[]
  | { [key: string]: AcpJsonValue };

export type AcpMeta = { [key: string]: unknown } | null;

export type AcpSessionId = string;
export type AcpToolCallId = string;
export type AcpMessageId = string;
export type AcpPermissionOptionId = string;

/** The protocol version this host speaks. Do not target the v2 draft. */
export const ACP_PROTOCOL_VERSION = 1;

// ── Method names ─────────────────────────────────────────────────────────────

export const ACP_METHOD = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionClose: "session/close",
  sessionList: "session/list",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  sessionSetConfigOption: "session/set_config_option",
  /** Agent to client. Notification. */
  sessionUpdate: "session/update",
  /** Agent to client. Request. */
  sessionRequestPermission: "session/request_permission",
  /** Agent to client. Requests, only when the client advertises `fs`. */
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
  /** Agent to client. Requests, only when the client advertises `terminal`. */
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
  terminalRelease: "terminal/release",
} as const;

export type AcpMethodName = (typeof ACP_METHOD)[keyof typeof ACP_METHOD];

// ── Content ──────────────────────────────────────────────────────────────────

export type AcpTextContentBlock = { type: "text"; text: string; _meta?: AcpMeta };
export type AcpImageContentBlock = {
  type: "image";
  data: string;
  mimeType: string;
  uri?: string | null;
  _meta?: AcpMeta;
};
export type AcpAudioContentBlock = {
  type: "audio";
  data: string;
  mimeType: string;
  _meta?: AcpMeta;
};
export type AcpResourceLinkContentBlock = {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  _meta?: AcpMeta;
};
export type AcpEmbeddedResourceContentBlock = {
  type: "resource";
  resource: { uri: string; mimeType?: string | null; text?: string; blob?: string };
  _meta?: AcpMeta;
};

export type AcpContentBlock =
  | AcpTextContentBlock
  | AcpImageContentBlock
  | AcpAudioContentBlock
  | AcpResourceLinkContentBlock
  | AcpEmbeddedResourceContentBlock;

// ── Tool calls ───────────────────────────────────────────────────────────────

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type AcpDiff = {
  path: string;
  oldText?: string | null;
  newText: string;
  _meta?: AcpMeta;
};

export type AcpToolCallContent =
  | { type: "content"; content: AcpContentBlock; _meta?: AcpMeta }
  | ({ type: "diff" } & AcpDiff)
  | { type: "terminal"; terminalId: string; _meta?: AcpMeta };

export type AcpToolCallLocation = { path: string; line?: number | null; _meta?: AcpMeta };

export type AcpToolCall = {
  toolCallId: AcpToolCallId;
  title: string;
  name?: string | null;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: AcpMeta;
};

export type AcpToolCallUpdate = {
  toolCallId: AcpToolCallId;
  kind?: AcpToolKind | null;
  status?: AcpToolCallStatus | null;
  title?: string | null;
  name?: string | null;
  content?: AcpToolCallContent[] | null;
  locations?: AcpToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: AcpMeta;
};

// ── Plan ─────────────────────────────────────────────────────────────────────

export type AcpPlanEntryStatus = "pending" | "in_progress" | "completed";
export type AcpPlanEntryPriority = "high" | "medium" | "low";

export type AcpPlanEntry = {
  content: string;
  priority?: AcpPlanEntryPriority;
  status: AcpPlanEntryStatus;
  _meta?: AcpMeta;
};

export type AcpPlan = { entries: AcpPlanEntry[]; _meta?: AcpMeta };

// ── Session configuration ────────────────────────────────────────────────────

export type AcpSessionMode = {
  id: string;
  name: string;
  description?: string | null;
  _meta?: AcpMeta;
};

export type AcpSessionModeState = {
  currentModeId: string;
  availableModes: AcpSessionMode[];
  _meta?: AcpMeta;
};

export type AcpSessionConfigOption = {
  id: string;
  name: string;
  type?: "select" | "boolean";
  description?: string | null;
  category?: string | null;
  value?: unknown;
  options?: Array<{ id: string; name: string; description?: string | null }>;
  _meta?: AcpMeta;
};

/**
 * Copilot 1.0.82 (and possibly other agents) send `currentValue` instead of
 * `value`, and nested choices as `{ value, name }` instead of `{ id, name }`.
 * Canonicalize onto ADE's `value` / `options[].id` shape so a live snapshot
 * does not land as "no current mode".
 */
export function normalizeAcpConfigOption(raw: unknown): AcpSessionConfigOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.length) return null;
  if (typeof record.name !== "string" || !record.name.length) return null;

  const current = record.currentValue !== undefined ? record.currentValue : record.value;
  const nested = Array.isArray(record.options) ? record.options : [];
  const options = nested.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" && row.id.length
      ? row.id
      : typeof row.value === "string" && row.value.length
        ? row.value
        : "";
    if (!id) return [];
    const name = typeof row.name === "string" && row.name.length ? row.name : id;
    return [{
      id,
      name,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
    }];
  });

  return {
    id: record.id,
    name: record.name,
    ...(record.type === "select" || record.type === "boolean" ? { type: record.type } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.category === "string" ? { category: record.category } : {}),
    ...(current !== undefined ? { value: current } : {}),
    ...(options.length ? { options } : {}),
  };
}

export function normalizeAcpConfigOptions(raw: unknown): AcpSessionConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const option = normalizeAcpConfigOption(entry);
    return option ? [option] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const ACP_SESSION_UPDATE_NAMES: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "compaction_update",
  "compaction_summary_chunk",
]);

const ACP_CONTENT_BLOCK_NAMES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "audio",
  "resource_link",
  "resource",
]);

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const ACP_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

const ACP_PERMISSION_KINDS: ReadonlySet<string> = new Set([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

/** Accept only JSON-RPC ids that can identify a pending request. */
export function normalizeAcpRpcId(raw: unknown): AcpRpcId | undefined {
  if (typeof raw === "string") return raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Normalize an error object before it crosses into the typed RPC layer. */
export function normalizeAcpRpcError(raw: unknown): AcpRpcErrorPayload | null {
  if (!isRecord(raw) || typeof raw.code !== "number" || !Number.isFinite(raw.code) || typeof raw.message !== "string") {
    return null;
  }
  return {
    code: raw.code,
    message: raw.message,
    ...(Object.prototype.hasOwnProperty.call(raw, "data") ? { data: raw.data } : {}),
  };
}

/** Keep the JSON parser's object check at the transport boundary. */
export function normalizeAcpRpcFrame(raw: unknown): Record<string, unknown> | null {
  return isRecord(raw) ? raw : null;
}

function isAcpContentBlock(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.type !== "string" || !ACP_CONTENT_BLOCK_NAMES.has(raw.type)) return false;
  switch (raw.type) {
    case "text":
      return typeof raw.text === "string";
    case "image":
    case "audio":
      return typeof raw.data === "string" && typeof raw.mimeType === "string";
    case "resource_link":
      return typeof raw.uri === "string" && typeof raw.name === "string";
    case "resource":
      return isRecord(raw.resource) && typeof raw.resource.uri === "string";
    default:
      return false;
  }
}

function isAcpToolCallUpdate(raw: unknown): raw is AcpToolCallUpdate {
  if (!isRecord(raw) || typeof raw.toolCallId !== "string" || !raw.toolCallId.length) return false;
  if (raw.kind != null && (typeof raw.kind !== "string" || !ACP_TOOL_KINDS.has(raw.kind))) return false;
  if (raw.status != null && (typeof raw.status !== "string" || !ACP_TOOL_STATUSES.has(raw.status))) return false;
  if (raw.title != null && typeof raw.title !== "string") return false;
  if (raw.name != null && typeof raw.name !== "string") return false;
  return raw.content == null || (Array.isArray(raw.content) && raw.content.every(isRecord));
}

function isAcpSessionUpdate(raw: unknown): raw is AcpSessionUpdate {
  if (!isRecord(raw) || typeof raw.sessionUpdate !== "string" || !ACP_SESSION_UPDATE_NAMES.has(raw.sessionUpdate)) {
    return false;
  }
  switch (raw.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return isAcpContentBlock(raw.content);
    case "tool_call":
      return typeof raw.toolCallId === "string" && typeof raw.title === "string";
    case "tool_call_update":
      return isAcpToolCallUpdate(raw);
    case "plan":
    case "plan_update":
      return Array.isArray(raw.entries);
    case "available_commands_update":
      return Array.isArray(raw.availableCommands);
    case "current_mode_update":
      return typeof raw.currentModeId === "string";
    case "config_option_update":
      return Array.isArray(raw.configOptions);
    case "session_info_update":
      return (raw.title == null || typeof raw.title === "string")
        && (raw.updatedAt == null || typeof raw.updatedAt === "string");
    case "usage_update":
      return typeof raw.used === "number" && typeof raw.size === "number";
    case "plan_removed":
    case "compaction_update":
    case "compaction_summary_chunk":
      return true;
    default:
      return false;
  }
}

/** Normalize a session/update notification before dispatching it to a handler. */
export function normalizeAcpSessionNotification(raw: unknown): AcpSessionNotification | null {
  if (!isRecord(raw) || typeof raw.sessionId !== "string" || !raw.sessionId.length || !isAcpSessionUpdate(raw.update)) {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    update: raw.update,
    ...(Object.prototype.hasOwnProperty.call(raw, "_meta") ? { _meta: raw._meta as AcpMeta } : {}),
  };
}

/** Normalize session/request_permission before creating an ADE pending card. */
export function normalizeAcpPermissionRequest(raw: unknown): AcpRequestPermissionRequest | null {
  if (!isRecord(raw) || typeof raw.sessionId !== "string" || !raw.sessionId.length || !isAcpToolCallUpdate(raw.toolCall)) {
    return null;
  }
  if (!Array.isArray(raw.options)) return null;
  const options = raw.options.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.optionId !== "string" || !entry.optionId.length || typeof entry.name !== "string") {
      return [];
    }
    if (entry.kind != null && (typeof entry.kind !== "string" || !ACP_PERMISSION_KINDS.has(entry.kind))) return [];
    return [{
      optionId: entry.optionId,
      name: entry.name,
      ...(entry.kind != null ? { kind: entry.kind as AcpPermissionOptionKind } : {}),
    }];
  });
  if (options.length !== raw.options.length) return null;
  return {
    sessionId: raw.sessionId,
    toolCall: raw.toolCall,
    options,
    ...(Object.prototype.hasOwnProperty.call(raw, "_meta") ? { _meta: raw._meta as AcpMeta } : {}),
  };
}

export type AcpAvailableCommand = {
  name: string;
  description: string;
  input?: { hint: string } | null;
  _meta?: AcpMeta;
};

// ── Usage ────────────────────────────────────────────────────────────────────

/** `session/update` variant `usage_update`. Reports context window occupancy. */
export type AcpUsageUpdate = {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
  _meta?: AcpMeta;
};

/** `session/prompt` result field. Reports token counts for the turn. */
export type AcpPromptUsage = {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  _meta?: AcpMeta;
};

// ── session/update ───────────────────────────────────────────────────────────

export type AcpContentChunk = {
  content: AcpContentBlock;
  messageId?: AcpMessageId | null;
  _meta?: AcpMeta;
};

export type AcpSessionUpdate =
  | ({ sessionUpdate: "user_message_chunk" } & AcpContentChunk)
  | ({ sessionUpdate: "agent_message_chunk" } & AcpContentChunk)
  | ({ sessionUpdate: "agent_thought_chunk" } & AcpContentChunk)
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCallUpdate)
  | ({ sessionUpdate: "plan" } & AcpPlan)
  | ({ sessionUpdate: "plan_update" } & AcpPlan)
  | { sessionUpdate: "plan_removed"; _meta?: AcpMeta }
  | { sessionUpdate: "available_commands_update"; availableCommands: AcpAvailableCommand[]; _meta?: AcpMeta }
  | { sessionUpdate: "current_mode_update"; currentModeId: string; _meta?: AcpMeta }
  | { sessionUpdate: "config_option_update"; configOptions: AcpSessionConfigOption[]; _meta?: AcpMeta }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null; _meta?: AcpMeta }
  | ({ sessionUpdate: "usage_update" } & AcpUsageUpdate)
  | { sessionUpdate: "compaction_update"; _meta?: AcpMeta }
  | { sessionUpdate: "compaction_summary_chunk"; _meta?: AcpMeta };

export type AcpSessionNotification = {
  sessionId: AcpSessionId;
  update: AcpSessionUpdate;
  _meta?: AcpMeta;
};

// ── Permissions ──────────────────────────────────────────────────────────────

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export type AcpPermissionOption = {
  optionId: AcpPermissionOptionId;
  name: string;
  /** Optional on the wire in practice. Grok has shipped options with no kind. */
  kind?: AcpPermissionOptionKind;
  _meta?: AcpMeta;
};

export type AcpRequestPermissionRequest = {
  sessionId: AcpSessionId;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
  _meta?: AcpMeta;
};

export type AcpRequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: AcpPermissionOptionId; _meta?: AcpMeta };

export type AcpRequestPermissionResponse = {
  outcome: AcpRequestPermissionOutcome;
  _meta?: AcpMeta;
};

// ── Lifecycle ────────────────────────────────────────────────────────────────

export type AcpImplementation = { name: string; title?: string | null; version: string };

export type AcpFileSystemCapabilities = {
  readTextFile?: boolean;
  writeTextFile?: boolean;
};

export type AcpClientCapabilities = {
  fs?: AcpFileSystemCapabilities;
  terminal?: boolean;
  session?: { compaction?: unknown; configOptions?: unknown } | null;
  _meta?: AcpMeta;
};

export type AcpPromptCapabilities = {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
};

export type AcpSessionCapabilities = {
  list?: unknown;
  delete?: unknown;
  fork?: unknown;
  resume?: unknown;
  close?: unknown;
  additionalDirectories?: unknown;
};

export type AcpMcpCapabilities = { http?: boolean; sse?: boolean; acp?: boolean };

export type AcpAgentCapabilities = {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
  mcpCapabilities?: AcpMcpCapabilities;
  sessionCapabilities?: AcpSessionCapabilities;
  _meta?: AcpMeta;
};

export type AcpAuthMethod = {
  id: string;
  name: string;
  description?: string | null;
  type?: "terminal";
  args?: string[];
  env?: Record<string, string>;
};

export type AcpInitializeRequest = {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: AcpImplementation | null;
  _meta?: AcpMeta;
};

export type AcpInitializeResponse = {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: AcpAuthMethod[];
  agentInfo?: AcpImplementation | null;
  _meta?: AcpMeta;
};

export type AcpEnvVariable = { name: string; value: string };

export type AcpMcpServer =
  | { type?: undefined; name: string; command: string; args: string[]; env: AcpEnvVariable[] }
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> };

export type AcpNewSessionRequest = {
  cwd: string;
  mcpServers: AcpMcpServer[];
  additionalDirectories?: string[];
  _meta?: AcpMeta;
};

export type AcpNewSessionResponse = {
  sessionId: AcpSessionId;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
  _meta?: AcpMeta;
};

export type AcpLoadSessionRequest = {
  sessionId: AcpSessionId;
  cwd: string;
  mcpServers: AcpMcpServer[];
  additionalDirectories?: string[];
  _meta?: AcpMeta;
};

export type AcpLoadSessionResponse = {
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
  _meta?: AcpMeta;
};

export type AcpPromptRequest = {
  sessionId: AcpSessionId;
  prompt: AcpContentBlock[];
  _meta?: AcpMeta;
};

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type AcpPromptResponse = {
  stopReason: AcpStopReason;
  usage?: AcpPromptUsage | null;
  _meta?: AcpMeta;
};

export type AcpCancelNotification = { sessionId: AcpSessionId; _meta?: AcpMeta };

// ── JSON-RPC envelopes ───────────────────────────────────────────────────────

export type AcpRpcId = number | string;

export type AcpRpcRequestFrame = {
  jsonrpc: "2.0";
  id: AcpRpcId;
  method: string;
  params?: unknown;
};

export type AcpRpcNotificationFrame = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type AcpRpcErrorPayload = { code: number; message: string; data?: unknown };

export type AcpRpcResponseFrame = {
  jsonrpc: "2.0";
  id: AcpRpcId;
  result?: unknown;
  error?: AcpRpcErrorPayload;
};

export type AcpRpcFrame = AcpRpcRequestFrame | AcpRpcNotificationFrame | AcpRpcResponseFrame;

/** JSON-RPC "method not found". A dialect probe reads this as "not supported". */
export const ACP_RPC_METHOD_NOT_FOUND = -32601;
/** JSON-RPC "invalid request". Some agents answer an unknown notification with it. */
export const ACP_RPC_INVALID_REQUEST = -32600;
