/**
 * Muse Session Protocol view events → ADE chat events.
 *
 * Pure: the caller owns the state object and decides what to do with the
 * events (emit, persist, settle a turn). Turn lifecycle (`turn/started`,
 * `turn/completed`), approvals, questions and session-level changes (model,
 * effort, name) are handled by the runtime, which needs session context the
 * mapper does not have; this module covers the item stream and the
 * per-turn telemetry that maps one-to-one.
 *
 * MSP rules this follows (tdd SS4):
 *  - An item's identity is `itemId` for its whole life; `revision` only grows.
 *  - `item/delta` appends to a field (`text` by default, `summary.N`,
 *    `output`); concatenated deltas equal the completed value unless the
 *    surface saturated (`truncated`).
 *  - `item/completed` may arrive for an item never seen started.
 *  - Unknown kinds render generically from `fallbackText`.
 */
import type { AgentChatEvent, AgentChatSubagentTranscriptMessage } from "../../../shared/types";
import type {
  Item,
  ItemDeltaParams,
  SessionContextUsageParams,
  SessionTodoListChangedParams,
  SessionTokenUsageParams,
  TokenUsage,
  TurnRetryScheduledParams,
} from "@muse-code/sdk/dist/src/msp.js";
import { liveContextUsageEvent } from "./liveContextUsageEvent";

type TodoEvent = Extract<AgentChatEvent, { type: "todo_update" }>;
type DoneUsage = NonNullable<Extract<AgentChatEvent, { type: "done" }>["usage"]>;

export type MuseItemKind = Item["kind"];

export type MuseEventMapperState = {
  /** Kind of every item seen this session (deltas carry only the id). */
  kindByItemId: Map<string, MuseItemKind>;
  /** Owning turn of every item seen (deltas carry no turn id). */
  turnByItemId: Map<string, string>;
  /** Text already streamed per item+field, so `item/completed` emits only what deltas did not. */
  streamedByItemField: Map<string, string>;
  /** Tool name per tool-call item, for its result. */
  toolByItemId: Map<string, string>;
  /** Items that already emitted their start event. */
  startedItemIds: Set<string>;
  /** Subagent items that already announced themselves. */
  announcedSubagents: Set<string>;
  /** Latest model completion usage this turn, for the `done` event. */
  turnUsage: TokenUsage | null;
  /** Model that served the latest completion. */
  servedModelId: string | null;
  /** Last context window size Muse reported. */
  contextWindow: number | null;
};

export function createMuseEventMapperState(): MuseEventMapperState {
  return {
    kindByItemId: new Map(),
    turnByItemId: new Map(),
    streamedByItemField: new Map(),
    toolByItemId: new Map(),
    startedItemIds: new Set(),
    announcedSubagents: new Set(),
    turnUsage: null,
    servedModelId: null,
    contextWindow: null,
  };
}

/** Clear the per-turn fields at a turn boundary; item identity maps survive (late completions). */
export function resetMuseTurnState(state: MuseEventMapperState): void {
  state.turnUsage = null;
}

export type MuseMapContext = {
  /** The turn ADE is running, used when an item carries none. */
  activeTurnId: string | null;
  cwd: string;
  modelLabel?: string | null;
};

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "exec_command",
  "exec_shell_command",
  "powershell",
  "run_shell",
  "shell_command",
]);
const EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "apply_patch",
  "create_file",
  "delete_file",
  "multi_edit",
  "str_replace",
]);
const READ_TOOLS = new Set(["read_file", "view_image", "list_dir", "file_glob_search", "glob", "grep"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

export function isMuseShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}

export function isMuseEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool);
}

export function parseMuseToolArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // MSP passes model-authored args verbatim, which may be almost-JSON.
    return { raw };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string") && value.length) {
      return (value as string[]).join(" ");
    }
  }
  return null;
}

export function museShellCommandText(args: unknown): string {
  const record = asRecord(args);
  return firstString(record, "command", "cmd", "script", "commandLine", "argv") ?? JSON.stringify(args ?? {});
}

export function museEditPath(args: unknown): string | null {
  return firstString(asRecord(args), "path", "file_path", "filePath", "target", "file");
}

function itemTurnId(item: Item, context: MuseMapContext, state: MuseEventMapperState): string | undefined {
  const turnId = typeof item.turnId === "string" && item.turnId
    ? item.turnId
    : state.turnByItemId.get(item.itemId) ?? context.activeTurnId ?? undefined;
  return turnId ?? undefined;
}

function terminalStatus(status: string): "completed" | "failed" | "interrupted" | "running" {
  if (status === "inProgress") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "interrupted") return "interrupted";
  return "failed";
}

function commandStatus(status: string): "running" | "completed" | "failed" {
  const mapped = terminalStatus(status);
  return mapped === "interrupted" ? "failed" : mapped;
}

/** Text a completed item holds beyond what its deltas already streamed. */
function unstreamedRemainder(state: MuseEventMapperState, itemId: string, field: string, full: string | undefined): string {
  if (!full) return "";
  const streamed = state.streamedByItemField.get(`${itemId}:${field}`) ?? "";
  if (!streamed) return full;
  if (full.startsWith(streamed)) return full.slice(streamed.length);
  // Saturated or rewritten surface: the deltas already showed what they could.
  return "";
}

function webSearchQuery(args: unknown): string {
  return firstString(asRecord(args), "query", "q", "url", "search") ?? "";
}

function subagentDescription(item: Item): string {
  return item.objective?.trim() || item.role?.trim() || item.fallbackText?.trim() || "Subagent";
}

function subagentResultStatus(status: string): "completed" | "failed" | "stopped" {
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "rejected" || status === "interrupted") return "stopped";
  return "failed";
}

function mapItemStarted(item: Item, context: MuseMapContext, state: MuseEventMapperState): AgentChatEvent[] {
  const turnId = itemTurnId(item, context, state);
  const itemId = item.itemId;
  switch (item.kind) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
      return [];
    case "toolCall": {
      const tool = item.tool ?? "tool";
      state.toolByItemId.set(itemId, tool);
      const args = parseMuseToolArgs(item.args);
      if (isMuseShellTool(tool)) {
        return [
          { type: "activity", activity: "running_command", detail: museShellCommandText(args), ...(turnId ? { turnId } : {}) },
          {
            type: "command",
            command: museShellCommandText(args),
            cwd: context.cwd,
            output: item.visibleOutput ?? "",
            itemId,
            ...(turnId ? { turnId } : {}),
            status: "running",
          },
        ];
      }
      if (WEB_TOOLS.has(tool) && tool === "web_search") {
        return [{ type: "web_search", query: webSearchQuery(args), itemId, ...(turnId ? { turnId } : {}), status: "running" }];
      }
      const activity = isMuseEditTool(tool)
        ? "editing_file" as const
        : READ_TOOLS.has(tool)
          ? "reading" as const
          : WEB_TOOLS.has(tool)
            ? "web_searching" as const
            : "tool_calling" as const;
      return [
        { type: "activity", activity, detail: museEditPath(args) ?? tool, ...(turnId ? { turnId } : {}) },
        { type: "tool_call", tool, args, itemId, ...(turnId ? { turnId } : {}) },
      ];
    }
    case "webSearch":
      return [{
        type: "web_search",
        query: item.fallbackText ?? "",
        itemId,
        ...(turnId ? { turnId } : {}),
        status: "running",
      }];
    case "userShell":
      return [{
        type: "command",
        command: item.commandText ?? "",
        cwd: context.cwd,
        output: item.visibleOutput ?? "",
        itemId,
        ...(turnId ? { turnId } : {}),
        status: "running",
        source: "userShell",
      }];
    case "subagent":
    case "workflow": {
      state.announcedSubagents.add(itemId);
      return [{
        type: "subagent_started",
        taskId: itemId,
        ...(item.subagentId ? { agentId: item.subagentId } : {}),
        provider: "muse",
        ...(item.childSessionId ? { providerSessionId: item.childSessionId } : {}),
        ...(item.role ? { agentType: item.role } : {}),
        description: subagentDescription(item),
        ...(typeof item.depth === "number" ? { spawnDepth: item.depth } : {}),
        taskType: item.kind === "workflow" ? "local_workflow" : "subagent",
        ...(item.kind === "workflow" && item.scriptId ? { workflowName: item.scriptId } : {}),
        background: item.background === true,
        ...(turnId ? { turnId } : {}),
      }];
    }
    case "compaction":
      return [{
        type: "context_compact",
        trigger: item.trigger === "manual" ? "manual" : "auto",
        provider: "muse",
        compactionId: itemId,
        state: "started",
        ...(typeof item.tokensBefore === "number" ? { preTokens: item.tokensBefore } : {}),
        ...(turnId ? { turnId } : {}),
      } as AgentChatEvent];
    case "reminderChild":
    case "hookRun":
    case "sideChat":
      // Muse's own background reminders, hooks and side chats: shown when they
      // settle (failures, blocks), never as noise while they run.
      return [];
    default:
      return item.fallbackText
        ? [{ type: "activity", activity: "working", detail: item.fallbackText, ...(turnId ? { turnId } : {}) }]
        : [];
  }
}

function mapItemCompleted(item: Item, context: MuseMapContext, state: MuseEventMapperState): AgentChatEvent[] {
  const turnId = itemTurnId(item, context, state);
  const itemId = item.itemId;
  switch (item.kind) {
    case "userMessage":
      return [];
    case "agentMessage": {
      const events: AgentChatEvent[] = [];
      const rest = unstreamedRemainder(state, itemId, "text", item.text);
      if (rest) events.push({ type: "text", text: rest, itemId, ...(turnId ? { turnId } : {}) });
      if (item.cutOff) {
        events.push({
          type: "system_notice",
          noticeKind: "provider_health",
          severity: "warning",
          message: "Muse's reply was cut off when the model stream ended early.",
          ...(turnId ? { turnId } : {}),
        });
      }
      return events;
    }
    case "reasoning": {
      const events: AgentChatEvent[] = [];
      (item.summary ?? []).forEach((part, index) => {
        const rest = unstreamedRemainder(state, itemId, `summary.${index}`, part);
        if (rest) events.push({ type: "reasoning", text: rest, itemId, summaryIndex: index, ...(turnId ? { turnId } : {}) });
      });
      if (!events.length && item.text) {
        const rest = unstreamedRemainder(state, itemId, "text", item.text);
        if (rest) events.push({ type: "reasoning", text: rest, itemId, ...(turnId ? { turnId } : {}) });
      }
      return events;
    }
    case "toolCall": {
      const tool = item.tool ?? state.toolByItemId.get(itemId) ?? "tool";
      const args = parseMuseToolArgs(item.args);
      const started = state.startedItemIds.has(itemId) ? [] : mapItemStarted(item, context, state)
        .filter((event) => event.type !== "activity");
      const status = terminalStatus(item.status);
      const output = item.visibleOutput ?? "";
      const failure = item.failureReason ? `${output ? `${output}\n` : ""}${item.failureReason}` : output;
      if (isMuseShellTool(tool)) {
        return [{
          type: "command",
          command: museShellCommandText(args),
          cwd: context.cwd,
          output: failure,
          itemId,
          ...(turnId ? { turnId } : {}),
          status: commandStatus(item.status),
          ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
        }];
      }
      if (tool === "web_search") {
        return [{
          type: "web_search",
          query: webSearchQuery(args),
          itemId,
          ...(turnId ? { turnId } : {}),
          status: commandStatus(item.status),
        }];
      }
      return [
        ...started,
        {
          type: "tool_result",
          tool,
          result: failure,
          itemId,
          ...(turnId ? { turnId } : {}),
          status: status === "running" ? "completed" : status,
          ...(item.toolReceipt ? { structured: item.toolReceipt } : {}),
          ...(item.patchSummary ? { toolResultMeta: { patchSummary: item.patchSummary } } : {}),
        },
      ];
    }
    case "webSearch":
      return [{
        type: "web_search",
        query: item.fallbackText ?? "",
        itemId,
        ...(turnId ? { turnId } : {}),
        status: commandStatus(item.status),
      }];
    case "userShell":
      return [{
        type: "command",
        command: item.commandText ?? "",
        cwd: context.cwd,
        output: item.visibleOutput ?? "",
        itemId,
        ...(turnId ? { turnId } : {}),
        status: commandStatus(item.status),
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
        source: "userShell",
      }];
    case "subagent":
    case "workflow": {
      const events: AgentChatEvent[] = [];
      if (!state.announcedSubagents.has(itemId)) events.push(...mapItemStarted(item, context, state));
      const summary = item.kind === "workflow"
        ? item.finalSummary ?? item.message ?? item.fallbackText ?? ""
        : item.result?.summary ?? item.result?.text ?? item.failureReason ?? item.fallbackText ?? "";
      const total = item.usage
        ? (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0)
        : undefined;
      events.push({
        type: "subagent_result",
        taskId: itemId,
        ...(item.subagentId ? { agentId: item.subagentId } : {}),
        provider: "muse",
        ...(item.role ? { agentType: item.role } : {}),
        status: subagentResultStatus(item.status),
        summary,
        ...(item.result?.text && item.result.text !== summary ? { finalSummary: item.result.text } : {}),
        ...(item.failureReason && item.status !== "completed" ? { stopReason: item.failureReason } : {}),
        taskType: item.kind === "workflow" ? "local_workflow" : "subagent",
        ...(item.kind === "workflow" && item.scriptId ? { workflowName: item.scriptId } : {}),
        ...(total !== undefined ? { totalTokens: total } : {}),
        ...(typeof item.depth === "number" ? { spawnDepth: item.depth } : {}),
        ...(turnId ? { turnId } : {}),
      });
      return events;
    }
    case "compaction": {
      const ok = item.status === "completed";
      return [{
        type: "context_compact",
        trigger: item.trigger === "manual" ? "manual" : "auto",
        provider: "muse",
        compactionId: itemId,
        state: ok ? "completed" : "failed",
        ...(typeof item.tokensBefore === "number" ? { preTokens: item.tokensBefore } : {}),
        ...(typeof item.tokensAfter === "number" ? { postTokens: item.tokensAfter } : {}),
        ...(typeof item.tokensBefore === "number" && typeof item.tokensAfter === "number"
          ? { tokensRemoved: Math.max(0, item.tokensBefore - item.tokensAfter) }
          : {}),
        ...(!ok ? { failReason: "provider_error", ...(item.reason ? { failDetail: item.reason } : {}) } : {}),
        ...(turnId ? { turnId } : {}),
      } as AgentChatEvent];
    }
    case "hookRun": {
      if (item.runStatus !== "blocked" && item.status === "completed") return [];
      return [{
        type: "system_notice",
        noticeKind: "hook",
        severity: item.runStatus === "blocked" ? "warning" : "error",
        message: `Muse hook ${item.label ?? item.event ?? item.hookKey ?? ""} ${item.runStatus === "blocked" ? "blocked this step" : "failed"}`.replace(/\s+/g, " ").trim(),
        ...(item.reason ? { detail: item.reason } : {}),
        ...(turnId ? { turnId } : {}),
      }];
    }
    case "reminderChild":
      // Muse's own background checks (skill, goal, verify reminders). Their
      // outcome reaches the transcript through the turn itself; a check that
      // could not run is Muse housekeeping, not something the user acts on.
    case "sideChat":
      return [];
    default:
      return item.fallbackText
        ? [{ type: "system_notice", noticeKind: "info", severity: "info", message: item.fallbackText, ...(turnId ? { turnId } : {}) }]
        : [];
  }
}

function mapDelta(params: ItemDeltaParams, context: MuseMapContext, state: MuseEventMapperState): AgentChatEvent[] {
  const itemId = params.itemId;
  const field = params.field ?? "text";
  const kind = state.kindByItemId.get(itemId);
  const key = `${itemId}:${field}`;
  state.streamedByItemField.set(key, `${state.streamedByItemField.get(key) ?? ""}${params.delta}`);
  const turnId = state.turnByItemId.get(itemId) ?? context.activeTurnId ?? undefined;
  if (!params.delta) return [];
  if (kind === "agentMessage" && field === "text") {
    return [{ type: "text", text: params.delta, itemId, ...(turnId ? { turnId } : {}) }];
  }
  if (kind === "reasoning") {
    const match = /^summary\.(\d+)$/.exec(field);
    return [{
      type: "reasoning",
      text: params.delta,
      itemId,
      ...(match ? { summaryIndex: Number(match[1]) } : {}),
      ...(turnId ? { turnId } : {}),
    }];
  }
  if ((kind === "toolCall" || kind === "userShell") && field === "output") {
    const tool = state.toolByItemId.get(itemId) ?? "";
    if (kind === "userShell" || isMuseShellTool(tool)) {
      return [{
        type: "command",
        command: "",
        cwd: context.cwd,
        output: state.streamedByItemField.get(key) ?? params.delta,
        itemId,
        ...(turnId ? { turnId } : {}),
        status: "running",
        ...(kind === "userShell" ? { source: "userShell" as const } : {}),
      }];
    }
  }
  if ((kind === "subagent" || kind === "workflow") && params.delta.trim()) {
    return [{
      type: "subagent_progress",
      taskId: itemId,
      provider: "muse",
      summary: params.delta,
      ...(turnId ? { turnId } : {}),
    }];
  }
  return [];
}

function todoStatus(status: string): TodoEvent["items"][number]["status"] {
  if (status === "completed" || status === "cancelled") return "completed";
  if (status === "inProgress") return "in_progress";
  return "pending";
}

export function mapMuseTodoList(params: SessionTodoListChangedParams, turnId: string | null): TodoEvent {
  return {
    type: "todo_update",
    items: params.items.map((todo, index) => ({
      id: `muse-todo-${index}`,
      description: todo.text,
      status: todoStatus(todo.status),
      ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
      ...(todo.status === "cancelled" ? { cancelled: true as const } : {}),
    })),
    ...(turnId ? { turnId } : {}),
  };
}

export function museUsageToDoneUsage(usage: TokenUsage | null | undefined, contextWindow?: number | null): DoneUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? usage.cachedTokens ?? null,
    cacheCreationTokens: usage.cacheWriteTokens ?? null,
    reasoningTokens: usage.reasoningTokens,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/**
 * Map one view notification. Returns the ADE events it produces; methods the
 * runtime owns (turn lifecycle, approvals, questions, session settings) map to
 * nothing here.
 */
export function mapMuseNotification(
  method: string,
  params: Record<string, unknown>,
  context: MuseMapContext,
  state: MuseEventMapperState,
): AgentChatEvent[] {
  switch (method) {
    case "item/started":
    case "item/updated": {
      const item = params.item as Item | undefined;
      if (!item?.itemId) return [];
      state.kindByItemId.set(item.itemId, item.kind);
      if (typeof item.turnId === "string" && item.turnId) state.turnByItemId.set(item.itemId, item.turnId);
      if (item.kind === "toolCall" && item.tool) state.toolByItemId.set(item.itemId, item.tool);
      if (method === "item/updated" || state.startedItemIds.has(item.itemId)) {
        if ((item.kind === "subagent" || item.kind === "workflow") && item.statusLine) {
          return [{
            type: "subagent_progress",
            taskId: item.itemId,
            provider: "muse",
            summary: item.statusLine,
            ...(item.turnId ? { turnId: item.turnId } : {}),
          }];
        }
        return [];
      }
      state.startedItemIds.add(item.itemId);
      return mapItemStarted(item, context, state);
    }
    case "item/delta":
      return mapDelta(params as unknown as ItemDeltaParams, context, state);
    case "item/completed": {
      const item = params.item as Item | undefined;
      if (!item?.itemId) return [];
      state.kindByItemId.set(item.itemId, item.kind);
      if (typeof item.turnId === "string" && item.turnId) state.turnByItemId.set(item.itemId, item.turnId);
      const events = mapItemCompleted(item, context, state);
      state.startedItemIds.add(item.itemId);
      return events;
    }
    case "session/tokenUsage": {
      const usage = params as unknown as SessionTokenUsageParams;
      state.turnUsage = usage.usage;
      if (usage.modelId) state.servedModelId = usage.modelId;
      return [{
        type: "tokens",
        turnId: usage.turnId,
        inputTokens: usage.usage.inputTokens,
        outputTokens: usage.usage.outputTokens,
        ...(usage.usage.cacheReadTokens ?? usage.usage.cachedTokens
          ? { cacheReadTokens: usage.usage.cacheReadTokens ?? usage.usage.cachedTokens }
          : {}),
        ...(usage.usage.cacheWriteTokens ? { cacheWriteTokens: usage.usage.cacheWriteTokens } : {}),
        ...(usage.usage.reasoningTokens ? { reasoningTokens: usage.usage.reasoningTokens } : {}),
        ...(state.contextWindow ? { contextWindow: state.contextWindow } : {}),
      }];
    }
    case "session/contextUsage": {
      const usage = params as unknown as SessionContextUsageParams;
      if (!usage.windowTokens) return [];
      state.contextWindow = usage.windowTokens;
      return [liveContextUsageEvent({
        used: usage.usedTokens,
        max: usage.windowTokens,
        turnId: context.activeTurnId,
        model: context.modelLabel ?? null,
      })];
    }
    case "session/todoListChanged":
      return [mapMuseTodoList(params as unknown as SessionTodoListChangedParams, context.activeTurnId)];
    case "turn/retryScheduled": {
      const retry = params as unknown as TurnRetryScheduledParams;
      return [{
        type: "activity",
        activity: "thinking",
        detail: `Retrying (${retry.nextAttempt}/${retry.maxAttempts}): ${retry.reason}`,
        providerRetry: true,
        turnId: retry.turnId,
      }];
    }
    default:
      return [];
  }
}


/**
 * A Muse child session's items (a subagent's own session, read with
 * `session/read` or paged with `view/page`) as subagent transcript rows. Each
 * row carries the ADE event the live stream would have produced, so the
 * takeover view renders a child exactly like the parent.
 */
export function mapMuseItemsToTranscript(
  sessionId: string,
  items: readonly Item[],
  cwd: string,
): AgentChatSubagentTranscriptMessage[] {
  const state = createMuseEventMapperState();
  const rows: AgentChatSubagentTranscriptMessage[] = [];
  for (const item of items) {
    if (!item?.itemId) continue;
    const timestamp = typeof item.recordedAt === "string" ? item.recordedAt : null;
    if (item.kind === "userMessage") {
      if (item.retracted) continue;
      const text = item.displayText ?? item.text ?? "";
      if (!text.trim()) continue;
      rows.push({
        type: "user",
        uuid: item.itemId,
        sessionId,
        parentToolUseId: null,
        message: { type: "user_message", text, messageId: item.itemId },
        text,
        ...(timestamp ? { timestamp } : {}),
      });
      continue;
    }
    const events = mapMuseNotification("item/completed", { item }, {
      activeTurnId: typeof item.turnId === "string" ? item.turnId : null,
      cwd,
    }, state);
    events.forEach((event, index) => {
      const text = event.type === "text" || event.type === "reasoning" ? event.text : undefined;
      rows.push({
        type: event.type === "system_notice" ? "system" : "assistant",
        uuid: `${item.itemId}:${index}`,
        sessionId,
        parentToolUseId: null,
        message: event,
        ...(text ? { text } : {}),
        ...(timestamp ? { timestamp } : {}),
      });
    });
  }
  return rows;
}
