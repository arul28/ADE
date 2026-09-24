import type {
  AgentChatEvent,
  AgentChatMissionFeature,
  AgentChatMissionProgressEntry,
} from "../../../shared/types";
import { detectCompactionSignalText } from "../../../shared/contextCompaction";
import { contextPercentage, liveContextUsageEvent } from "./liveContextUsageEvent";
import { droidWebToolSourceRefs, isWebFetchToolName, isWebSearchToolName } from "./chatSourceAdapters";
import {
  isDroidCompactingState,
  normalizeDroidSdkContextStats,
  normalizeDroidSdkTokenUsage,
  type DroidSdkContextStats,
  type DroidSdkTokenUsage,
} from "./droidSdkProtocol";

type SdkRecord = Record<string, unknown>;

export type DroidSdkEventMapperState = {
  assistantDeltaItemIds: Set<string>;
  thinkingDeltaItemIds: Set<string>;
  imageItemIds: Set<string>;
  toolNamesByUseId: Map<string, string>;
  latestUsage: DroidSdkTokenUsage | null;
  compactionActive?: boolean;
  /** Context size when the open compaction started (the worker's tagged sample). */
  compactionPreTokens?: number;
  /**
   * `message.modelId` of the turn's latest assistant message: the concrete
   * model that answered, which a router slot (`routerId: "auto"`) picks.
   */
  servedModelId?: string;
  /** Inputs of web tools (WebSearch/FetchUrl) by tool-use id, read when their result lands. */
  webToolInputsByUseId?: Map<string, unknown>;
};

export function createDroidSdkEventMapperState(): DroidSdkEventMapperState {
  return {
    assistantDeltaItemIds: new Set(),
    thinkingDeltaItemIds: new Set(),
    imageItemIds: new Set(),
    toolNamesByUseId: new Map(),
    latestUsage: null,
  };
}

function asRecord(value: unknown): SdkRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SdkRecord : null;
}

function readString(value: unknown): string | null {
  const text = typeof value === "string" ? value : "";
  return text.length ? text : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The single item-id scheme shared by streamed text/thinking deltas and the
 * completed `assistant` message. It must stay identical in both paths or the
 * completed message re-emits text the deltas already streamed.
 */
function droidTextItemId(messageId: string, kind: "text" | "thinking", blockIndex: number): string {
  return `${messageId}:${kind}:${blockIndex}`;
}

function itemIdFor(record: SdkRecord, kind: "text" | "thinking"): string {
  const messageId = readString(record.messageId) ?? `droid-${kind}`;
  const blockIndex = readNumber(record.blockIndex) ?? 0;
  return droidTextItemId(messageId, kind, blockIndex);
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractCommand(args: unknown): string | null {
  const record = asRecord(args);
  return readString(record?.command)
    ?? readString(record?.fullCommand)
    ?? readString(record?.cmd)
    ?? readString(record?.shellCommand);
}

function extractCwd(args: unknown, fallback: string): string {
  const record = asRecord(args);
  return readString(record?.cwd) ?? readString(record?.workingDirectory) ?? fallback;
}

function toolResultStatus(event: SdkRecord): "completed" | "failed" {
  return event.isError === true ? "failed" : "completed";
}

function extractTextBlocks(content: unknown): Array<{ text: string; kind: "text" | "thinking"; index: number }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ text: string; kind: "text" | "thinking"; index: number }> = [];
  for (const [index, block] of content.entries()) {
    const record = asRecord(block);
    if (!record) continue;
    const type = readString(record.type);
    const text = readString(record.text);
    if (!text) continue;
    out.push({
      text,
      kind: type === "thinking" ? "thinking" : "text",
      index,
    });
  }
  return out;
}

function extractImageBlocks(content: unknown): Array<{ data: string; mediaType: string; id?: string; index: number }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ data: string; mediaType: string; id?: string; index: number }> = [];
  for (const [index, block] of content.entries()) {
    const record = asRecord(block);
    if (record?.type !== "image") continue;
    const source = asRecord(record.source);
    const data = readString(source?.data);
    const mediaType = readString(source?.mediaType);
    if (!data || !mediaType?.toLowerCase().startsWith("image/")) continue;
    out.push({
      data,
      mediaType,
      index,
      ...(readString(record.id) ? { id: readString(record.id)! } : {}),
    });
  }
  return out;
}

function contextUsageEvent(stats: DroidSdkContextStats, turnId: string): AgentChatEvent {
  const used = Math.max(0, stats.used);
  const remaining = Math.max(0, stats.remaining);
  const maxTokens = Math.max(0, stats.limit);
  // Droid labels estimated occupancy, but it is still a provider-owned live
  // sample rather than an ADE heuristic, so the shared event state is measured.
  return {
    ...liveContextUsageEvent({
      used,
      max: maxTokens,
      rawMaxTokens: maxTokens,
      turnId,
      state: "measured",
      categories: [
        { name: "Used", tokens: used, percentage: contextPercentage(used, maxTokens), kind: "used" },
        { name: "Free", tokens: remaining, percentage: contextPercentage(remaining, maxTokens), kind: "free" },
      ],
    }),
    capturedAt: stats.updatedAt,
  };
}

type DroidDoneUsage = NonNullable<Extract<AgentChatEvent, { type: "done" }>["usage"]>;

function doneUsageFrom(usage: DroidSdkTokenUsage | null): DroidDoneUsage | null {
  if (!usage) return null;
  return {
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens != null ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens != null ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
    ...(usage.thinkingTokens != null ? { reasoningTokens: usage.thinkingTokens } : {}),
  };
}

/** Closes the open compaction: the one place a Droid `completed` marker is built. */
function closeDroidCompaction(state: DroidSdkEventMapperState, turnId: string): AgentChatEvent {
  const preTokens = state.compactionPreTokens;
  state.compactionActive = false;
  delete state.compactionPreTokens;
  return {
    type: "context_compact",
    trigger: "auto",
    state: "completed",
    turnId,
    compactionId: turnId,
    provider: "droid",
    detection: "provider",
    ...(preTokens != null ? { preTokens } : {}),
  };
}

const DROID_CUSTOM_MODEL_PREFIX = /^custom:/u;

function comparableDroidModelId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(DROID_CUSTOM_MODEL_PREFIX, "");
}

// Map a Droid SDK MissionFeature[] payload to ADE's mission feature snapshots.
function readMissionFeatures(value: unknown): AgentChatMissionFeature[] {
  if (!Array.isArray(value)) return [];
  const out: AgentChatMissionFeature[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = readString(record.id);
    if (!id) continue;
    const description = readString(record.description) ?? readString(record.title) ?? "";
    const status = readString(record.status) ?? "pending";
    const skillName = readString(record.skillName);
    const milestone = readString(record.milestone);
    const currentWorkerSessionId = readString(record.currentWorkerSessionId);
    const completedWorkerSessionId = readString(record.completedWorkerSessionId);
    const workerSessionIds = Array.isArray(record.workerSessionIds)
      ? record.workerSessionIds.filter((v): v is string => typeof v === "string" && v.length > 0)
      : undefined;
    out.push({
      id,
      description,
      status,
      ...(skillName ? { skillName } : {}),
      ...(milestone ? { milestone } : {}),
      ...(currentWorkerSessionId ? { currentWorkerSessionId } : {}),
      ...(completedWorkerSessionId ? { completedWorkerSessionId } : {}),
      ...(workerSessionIds && workerSessionIds.length ? { workerSessionIds } : {}),
    });
  }
  return out;
}

// Flatten a Droid SDK ProgressLogEntry[] into readable progress rows. Entries
// are a discriminated union; we extract the common, useful fields generically.
function readMissionProgress(value: unknown): AgentChatMissionProgressEntry[] {
  if (!Array.isArray(value)) return [];
  const out: AgentChatMissionProgressEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const type = readString(record.type) ?? readString(record.entryType) ?? "entry";
    const text = readString(record.message) ?? readString(record.text) ?? readString(record.summary);
    const workerSessionId = readString(record.workerSessionId);
    const featureId = readString(record.featureId);
    const timestamp = readString(record.timestamp) ?? readString(record.createdAt);
    out.push({
      type,
      ...(text ? { text } : {}),
      ...(workerSessionId ? { workerSessionId } : {}),
      ...(featureId ? { featureId } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  }
  return out;
}

type DroidTodoItem = Extract<AgentChatEvent, { type: "todo_update" }>["items"][number];

const DROID_TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/**
 * One line of Droid's text checklist: `1. [in_progress] Write the migration`,
 * `- [x] Done thing`, `[ ] Open thing`, or a bare/numbered line (pending).
 */
function parseDroidTodoLine(line: string, index: number): DroidTodoItem {
  const id = String(index + 1);
  const status = line.match(/^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[(completed|in_progress|pending)\]\s*(.*)$/);
  if (status) return { id, status: status[1] as DroidTodoItem["status"], description: status[2]!.trim() || "(no description)" };
  const checked = line.match(/^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[[xX]\]\s*(.*)$/);
  if (checked) return { id, status: "completed", description: checked[1]!.trim() || "(no description)" };
  const unchecked = line.match(/^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[\s*\]\s*(.*)$/);
  if (unchecked) return { id, status: "pending", description: unchecked[1]!.trim() || "(no description)" };
  const bare = line.match(/^\d+[.)]\s+(.+)$/)?.[1] ?? line.match(/^[-*]\s+(.+)$/)?.[1] ?? line;
  return { id, status: "pending", description: bare.trim() };
}

function parseDroidTodoText(text: string): DroidTodoItem[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseDroidTodoLine);
}

/**
 * The list a Droid `TodoWrite` call writes.
 *
 * `@factory/droid-sdk` 0.9.1 declares the input as `{ todos: string }` (a text
 * checklist) and its own `todoState.parseTodos` also accepts a JSON array of
 * `{ id?, content, status, priority? }` or of strings. That parser is not
 * exported, so this mirrors it: same line grammar, same `index + 1` ids, and
 * objects with a status outside `pending | in_progress | completed` dropped.
 */
export function droidTodoItemsFromToolInput(input: unknown): DroidTodoItem[] {
  const todos = asRecord(input)?.todos;
  let source: unknown = todos;
  if (typeof todos === "string") {
    const trimmed = todos.trim();
    if (!trimmed.startsWith("[")) return parseDroidTodoText(trimmed);
    try {
      source = JSON.parse(trimmed);
    } catch {
      return parseDroidTodoText(trimmed);
    }
  }
  if (!Array.isArray(source)) return [];
  if (source.length > 0 && typeof source[0] === "string") {
    return parseDroidTodoText(source.filter((line): line is string => typeof line === "string").join("\n"));
  }
  const items: DroidTodoItem[] = [];
  source.forEach((entry, index) => {
    const record = asRecord(entry);
    const content = typeof record?.content === "string" ? record.content : null;
    const status = typeof record?.status === "string" ? record.status : "";
    if (content === null || !DROID_TODO_STATUSES.has(status)) return;
    items.push({
      id: readString(record?.id) ?? String(index + 1),
      description: content,
      status: status as DroidTodoItem["status"],
    });
  });
  return items;
}

export function mapDroidSdkMessageToChatEvents(
  message: unknown,
  meta: {
    turnId: string;
    cwd: string;
    state: DroidSdkEventMapperState;
  },
): AgentChatEvent[] {
  const record = asRecord(message);
  if (!record) return [];
  const type = readString(record.type);
  const turnId = meta.turnId;

  switch (type) {
    case "assistant_text_delta": {
      const text = readString(record.text);
      if (!text) return [];
      const itemId = itemIdFor(record, "text");
      meta.state.assistantDeltaItemIds.add(itemId);
      return [{ type: "text", text, itemId, turnId }];
    }
    case "thinking_text_delta": {
      const text = readString(record.text);
      if (!text) return [];
      const itemId = itemIdFor(record, "thinking");
      meta.state.thinkingDeltaItemIds.add(itemId);
      return [{ type: "reasoning", text, itemId, turnId }];
    }
    case "assistant": {
      // 0.9.x emits a complete `assistant` message (with `message.content`
      // blocks) where 0.2 emitted `create_message`; `includePartialMessages`
      // yields the text/thinking deltas that this dedupes against.
      const message = asRecord(record.message);
      const role = readString(message?.role) ?? readString(record.role);
      if (role && role !== "assistant") return [];
      const messageId = readString(message?.id) ?? readString(record.messageId) ?? "droid-message";
      const servedModelId = readString(message?.modelId)?.trim();
      if (servedModelId) meta.state.servedModelId = servedModelId;
      const content = message?.content ?? record.content;
      // Key text/thinking by the same `<messageId>:<kind>:<blockIndex>` scheme the
      // deltas use (via the content-block index), so a completed message never
      // re-emits text the deltas already streamed. The block's own `id` is
      // deliberately ignored here — it does not match the delta key, and using it
      // duplicated every streamed assistant message.
      const textEvents = extractTextBlocks(content).flatMap((block): AgentChatEvent[] => {
        const itemId = droidTextItemId(messageId, block.kind, block.index);
        if (block.kind === "thinking") {
          if (meta.state.thinkingDeltaItemIds.has(itemId)) return [];
          return [{ type: "reasoning", text: block.text, itemId, turnId }];
        }
        if (meta.state.assistantDeltaItemIds.has(itemId)) return [];
        return [{ type: "text", text: block.text, itemId, turnId }];
      });
      const imageEvents = extractImageBlocks(content).flatMap((block): AgentChatEvent[] => {
        const itemId = block.id ?? `${messageId}:image:${block.index}`;
        if (meta.state.imageItemIds.has(itemId)) return [];
        meta.state.imageItemIds.add(itemId);
        return [{
          type: "codex_image_generation",
          itemId,
          turnId,
          prompt: "Droid image output",
          result: `data:${block.mediaType};base64,${block.data}`,
          status: "completed",
        }];
      });
      return [...textEvents, ...imageEvents];
    }
    case "tool_call": {
      // 0.9.x renamed the complete tool-use event from `tool_use` to
      // `tool_call` and carries `name`/`input` instead of `toolName`/`toolInput`.
      const toolUseId = readString(record.toolUseId) ?? `droid-tool-${Date.now()}`;
      const tool = readString(record.name) ?? readString(record.toolName) ?? "tool";
      const input = record.input ?? record.toolInput;
      meta.state.toolNamesByUseId.set(toolUseId, tool);
      if (isWebSearchToolName(tool) || isWebFetchToolName(tool)) {
        (meta.state.webToolInputsByUseId ??= new Map()).set(toolUseId, input);
      }
      const command = extractCommand(input);
      if (command) {
        return [{
          type: "command",
          command,
          cwd: extractCwd(input, meta.cwd),
          output: "",
          itemId: toolUseId,
          turnId,
          status: "running",
        }];
      }
      const toolCall: AgentChatEvent = { type: "tool_call", tool, args: input ?? {}, itemId: toolUseId, turnId };
      if (tool === "TodoWrite") {
        // Droid's todo tool feeds the chat task list, as Claude's does. The tool
        // row stays, like Claude's TodoWrite row.
        const items = droidTodoItemsFromToolInput(input);
        if (items.length) return [toolCall, { type: "todo_update", items, turnId }];
      }
      return [toolCall];
    }
    case "tool_progress": {
      const toolUseId = readString(record.toolUseId) ?? `droid-tool-${Date.now()}`;
      const tool = readString(record.toolName) ?? meta.state.toolNamesByUseId.get(toolUseId) ?? "tool";
      const content = readString(record.content) ?? summarize(record.update);
      return [{
        type: "tool_result",
        tool,
        result: content,
        itemId: `${toolUseId}:progress`,
        logicalItemId: toolUseId,
        turnId,
        status: "running",
      }];
    }
    case "tool_result": {
      const toolUseId = readString(record.toolUseId) ?? `droid-tool-${Date.now()}`;
      const tool = readString(record.toolName) ?? meta.state.toolNamesByUseId.get(toolUseId) ?? "tool";
      const status = toolResultStatus(record);
      const webInput = meta.state.webToolInputsByUseId?.get(toolUseId);
      meta.state.webToolInputsByUseId?.delete(toolUseId);
      const sources = status === "completed" && (isWebSearchToolName(tool) || isWebFetchToolName(tool))
        ? droidWebToolSourceRefs(tool, webInput, record.content)
        : [];
      return [{
        type: "tool_result",
        tool,
        result: record.content,
        ...(sources.length ? { sources } : {}),
        itemId: toolUseId,
        turnId,
        status,
      }];
    }
    case "working_state_changed": {
      const state = readString(record.state);
      const compacting = isDroidCompactingState(state);
      const out: AgentChatEvent[] = [];
      if (compacting && !meta.state.compactionActive) {
        meta.state.compactionActive = true;
        out.push({
          type: "context_compact",
          trigger: "auto",
          state: "started",
          turnId,
          compactionId: turnId,
          provider: "droid",
          detection: "provider",
        });
      } else if (!compacting && meta.state.compactionActive) {
        out.push(closeDroidCompaction(meta.state, turnId));
      }
      if (!state || state.toLowerCase() === "idle") return out;
      out.push({
        type: "activity",
        activity: "working",
        detail: `Droid ${state}`,
        turnId,
      });
      return out;
    }
    case "context_stats": {
      // The worker's background `droid.get_context_stats` samples. They can
      // land after `done` (the turn id is already cleared) or after the next
      // turn started, so each keeps the turn id the worker stamped on it.
      const stats = normalizeDroidSdkContextStats(record.contextStats);
      if (!stats) return [];
      const sampleTurnId = readString(record.turnId);
      if (record.phase === "compaction_start") {
        // The size being compacted. It rides on the completed marker; showing
        // it on the meter would move the meter off "compacting". A stale one
        // belongs to an earlier turn's compaction, so it never seeds this one.
        const current = !sampleTurnId || sampleTurnId === turnId;
        if (current && meta.state.compactionActive && meta.state.compactionPreTokens == null) {
          meta.state.compactionPreTokens = stats.used;
        }
        return [];
      }
      return [contextUsageEvent(stats, sampleTurnId ?? turnId)];
    }
    case "token_usage_update": {
      const usage = normalizeDroidSdkTokenUsage(record);
      if (usage) meta.state.latestUsage = usage;
      if (!usage) return [];
      return [{
        type: "tokens",
        turnId,
        ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.cacheReadTokens != null ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheCreationTokens != null ? { cacheWriteTokens: usage.cacheCreationTokens } : {}),
        ...(usage.thinkingTokens != null ? { reasoningTokens: usage.thinkingTokens } : {}),
      }];
    }
    case "mission_worker_started": {
      // AGI orchestrator spawned a worker sub-session — surface it as a subagent.
      const workerSessionId = readString(record.workerSessionId);
      if (!workerSessionId) return [];
      const model = readString(record.model) ?? readString(record.modelId);
      return [{
        type: "subagent_started",
        taskId: workerSessionId,
        parentToolUseId: null,
        description: `Worker ${workerSessionId.slice(-6)}`,
        turnId,
        ...(model ? { model } : {}),
      }];
    }
    case "mission_worker_completed": {
      const workerSessionId = readString(record.workerSessionId);
      if (!workerSessionId) return [];
      const exitCode = readNumber(record.exitCode);
      const ok = exitCode === 0 || exitCode == null;
      // Droid exposes no inline worker transcript, so the exit code is the most
      // useful terminal signal — carry it in the summary for the subagent drawer.
      const summary = exitCode == null ? "Worker finished" : `Worker exited (code ${exitCode})`;
      const workerUsage = normalizeDroidSdkTokenUsage(record.tokenUsage ?? record.usage);
      return [{
        type: "subagent_result",
        taskId: workerSessionId,
        parentToolUseId: null,
        status: ok ? "completed" : "failed",
        summary,
        finalSummary: summary,
        turnId,
        ...(workerUsage ? {
          usage: {
            ...(workerUsage.inputTokens != null ? { inputTokens: workerUsage.inputTokens } : {}),
            ...(workerUsage.outputTokens != null ? { outputTokens: workerUsage.outputTokens } : {}),
            ...(workerUsage.cacheReadTokens != null ? { cacheReadTokens: workerUsage.cacheReadTokens } : {}),
            ...(workerUsage.cacheCreationTokens != null ? { cacheWriteTokens: workerUsage.cacheCreationTokens } : {}),
            ...(workerUsage.thinkingTokens != null ? { reasoningTokens: workerUsage.thinkingTokens } : {}),
            usageConfidence: "derived" as const,
          },
        } : {}),
      }];
    }
    case "mission_state_changed": {
      const state = readString(record.state);
      if (!state) return [];
      return [{ type: "mission_state", state, turnId }];
    }
    case "mission_features_changed": {
      return [{ type: "mission_features", features: readMissionFeatures(record.features), turnId }];
    }
    case "mission_progress_entry": {
      return [{ type: "mission_progress", entries: readMissionProgress(record.progressLog), turnId }];
    }
    // Message-level/partial events that carry no transcript mapping. `result`
    // is 0.9.x's terminal event (0.2's `turn_complete`); the turn's done event
    // is built from the send result, not from this stream event.
    case "mission_heartbeat":
    case "session_title_updated":
    case "settings_updated":
    case "permission_resolved":
    case "assistant_text_complete":
    case "thinking_text_complete":
    case "assistant_message_retracted":
    case "tool_call_delta":
    case "session_working_directory_changed":
    case "hook":
    case "result":
    case "mcp_status_changed":
    case "mcp_auth_required":
    case "mcp_auth_completed":
      return [];
    case "error":
      return [{
        type: "error",
        message: readString(record.message) ?? "Droid SDK reported an error.",
        turnId,
      }];
    default:
      return [];
  }
}

export function mapDroidSdkRunResultToDoneEvent(
  result: unknown,
  meta: {
    turnId: string;
    model: string;
    modelId?: string;
    requestedModel?: string;
    state: DroidSdkEventMapperState;
    interrupted?: boolean;
  },
): Extract<AgentChatEvent, { type: "done" }> {
  // The provider can omit a matching `tool_result` after cancellation or a
  // failed turn. Those inputs are only needed to build Sources for this run.
  // Clear them at the terminal edge so an interrupted long-lived chat cannot
  // retain one entry per abandoned web call forever.
  meta.state.webToolInputsByUseId?.clear();
  const record = asRecord(result);
  const tokenUsage = normalizeDroidSdkTokenUsage(record?.tokenUsage) ?? meta.state.latestUsage;
  // Context occupancy is not on `done`: the worker posts it as a trailing
  // `context_stats` event so the run result never waits on the read.
  const usage = doneUsageFrom(tokenUsage);
  // The assistant message names the model that answered. The run result's
  // `modelId` is the session setting read back, so it only says what was asked.
  const servedModelRaw = meta.state.servedModelId ?? readString(record?.modelId) ?? readString(record?.servedModel);
  const requestedModelRaw = (meta.requestedModel ?? meta.model).trim();
  const requestedModel = comparableDroidModelId(requestedModelRaw);
  const servedModel = servedModelRaw
    && requestedModel
    && comparableDroidModelId(servedModelRaw) !== requestedModel
    ? servedModelRaw
    : undefined;
  return {
    type: "done",
    turnId: meta.turnId,
    status: meta.interrupted ? "interrupted" : record?.success === false ? "failed" : "completed",
    model: meta.model,
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(usage ? { usage } : {}),
    ...(servedModel ? { servedModel } : {}),
    // A `custom:` model is one the user brought their own key for; every other
    // model bills the Factory plan.
    account: { provider: "droid", kind: DROID_CUSTOM_MODEL_PREFIX.test(requestedModelRaw) ? "api_key" : "subscription" },
  };
}
