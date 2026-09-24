import type { AgentChatCloudRunStatus, AgentChatEvent, AgentChatRuntime } from "../../../shared/types";
import { detectCompactionSignalText } from "../../../shared/contextCompaction";
import {
  CURSOR_SDK_COMPACTION_EVENT,
  CURSOR_SDK_PRECOMPACT_HOOK_MARK,
  CURSOR_SDK_TURN_TELEMETRY_KEY,
  classifyCursorSdkErrorText,
  type CursorSdkErrorKind,
} from "./cursorSdkProtocol";
import { presentChatFailure } from "../../../shared/chatErrorPresentation";
import { liveContextUsageEvent } from "./liveContextUsageEvent";

const CURSOR_WORKING_ACTIVITY_DETAIL = "Preparing response";

type SdkMessageRecord = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  const text = typeof value === "string" ? value : "";
  return text.length ? text : null;
}

function summarizeUnknown(value: unknown): string | null {
  const direct = readString(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (record) {
    const nested =
      readString(record.message)
      ?? readString(record.detail)
      ?? readString(record.error)
      ?? readString(record.reason)
      ?? readString(record.description);
    if (nested) return nested;
  }
  if (value == null) return null;
  return typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

function readStatusDetail(record: SdkMessageRecord): string | null {
  for (const value of [
    record.message,
    record.detail,
    record.error,
    record.reason,
    record.description,
    asRecord(record.data)?.message,
    asRecord(record.data)?.error,
  ]) {
    const text = summarizeUnknown(value)?.trim();
    if (text) return text;
  }
  return null;
}

function uniqueLines(lines: Array<string | null | undefined>, limit = 4): string | undefined {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line?.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out.length ? out.join("\n") : undefined;
}

/**
 * Cursor-specific card copy for the failures whose raw text is unreadable.
 * Every sentence here must pass the shared card's friendly-copy check, or it
 * would be replaced by the generic fallback body.
 */
const CURSOR_FAILURE_MESSAGES: Partial<Record<CursorSdkErrorKind, string>> = {
  rate_limit: "Cursor rate limited this request.",
  network: "Cursor's connection dropped mid-run.",
};

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.length) return "tool";
  return trimmed;
}

function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function extractCommand(args: unknown): string | null {
  const record = asRecord(args);
  return readString(record?.command) ?? readString(record?.cmd) ?? readString(record?.shellCommand);
}

function extractCwd(args: unknown, fallback: string): string {
  const record = asRecord(args);
  return readString(record?.cwd) ?? readString(record?.workingDirectory) ?? fallback;
}

function extractExitCode(result: unknown): number | null {
  const record = asRecord(result);
  return readNumber(record?.exitCode) ?? readNumber(record?.exit_code) ?? readNumber(record?.code);
}

type CursorTodoItem = {
  text: string;
  todoStatus: "pending" | "in_progress" | "completed";
  planStatus: "pending" | "in_progress" | "completed" | "failed";
};

/**
 * Cursor's published todo vocabulary, mapped to ADE's two.
 *
 * The four keys are the SDK's own enum, not guesses: 1.0.31 converts the proto
 * todo status to exactly `pending | inProgress | completed | cancelled`. Keyed
 * on those spellings so a grep for the wire value finds this table.
 *
 * Both targets sit on one row because they disagree for exactly one value: a
 * `todo_update` row has no failure state, so a cancelled step reads as pending
 * there while the plan step — which does have one — records it as failed. That
 * does NOT mean the model failed the step.
 */
const CURSOR_TODO_STATUS: Readonly<Record<string, Omit<CursorTodoItem, "text">>> = {
  pending: { todoStatus: "pending", planStatus: "pending" },
  inProgress: { todoStatus: "in_progress", planStatus: "in_progress" },
  completed: { todoStatus: "completed", planStatus: "completed" },
  cancelled: { todoStatus: "pending", planStatus: "failed" },
};

/**
 * Read the todo list out of an `updateTodos` call.
 *
 * The result is preferred over the arguments: the arguments are what the model
 * asked for, the result is what the tool recorded. The argument shape is
 * `{ todos: [...] }` and the result wraps the same list as
 * `{ status, value: { todos: [...] } }`, which is why the result is unwrapped
 * one level further.
 *
 * A status outside the published enum maps to `pending` rather than dropping
 * the row: an unrecognised status must never remove a step the model planned.
 */
function cursorTodoItems(args: unknown, result: unknown): CursorTodoItem[] {
  const resultValue = asRecord(asRecord(result)?.value);
  const source = Array.isArray(resultValue?.todos) ? resultValue.todos : asRecord(args)?.todos;
  if (!Array.isArray(source)) return [];
  const items: CursorTodoItem[] = [];
  for (const entry of source) {
    const record = asRecord(entry);
    const text = readString(record?.content) ?? readString(record?.text);
    if (!text) continue;
    // `Object.hasOwn`, not a bare index: `status` is model-controlled, and
    // "constructor" or "toString" would otherwise return an inherited value that
    // is truthy, skip the default, and spread no status at all.
    const raw = readString(record?.status) ?? "";
    const mapped = Object.hasOwn(CURSOR_TODO_STATUS, raw) ? CURSOR_TODO_STATUS[raw] : CURSOR_TODO_STATUS.pending;
    items.push({ text, ...mapped });
  }
  return items;
}

function cursorMcpSource(args: unknown): {
  source: NonNullable<Extract<AgentChatEvent, { type: "tool_call" }>["mcp"]>;
  args: unknown;
} | null {
  const record = asRecord(args);
  const server = readString(record?.providerIdentifier);
  const tool = readString(record?.toolName);
  if (!server && !tool) return null;
  return {
    source: { server: server ?? "cursor-mcp", tool: tool ?? "tool" },
    args: record?.args ?? {},
  };
}

function cursorMcpResultFailed(result: unknown): boolean {
  const record = asRecord(result);
  if (readString(record?.status)?.toLowerCase() === "error") return true;
  const value = asRecord(record?.value);
  return value?.isError === true;
}

function cursorGeneratedImagePath(result: unknown): string | null {
  const record = asRecord(result);
  return readString(asRecord(record?.value)?.filePath)
    ?? readString(record?.filePath)
    ?? null;
}

function extractTextContent(message: unknown): string[] {
  const record = asRecord(message);
  const content = asRecord(record?.message)?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const blockRecord = asRecord(block);
    if (blockRecord?.type === "text") {
      const text = readString(blockRecord.text);
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Mapping state the service owns across events, as it owns Pi's: the meta is
 * rebuilt per event, so this is what pairs a "compacting" status on one event
 * with the status that ends it on a later one.
 */
export type CursorSdkEventMapperState = {
  /** The turn whose text-signalled compaction is open, or null. */
  textCompactionTurnId: string | null;
};

export function createCursorSdkEventMapperState(): CursorSdkEventMapperState {
  return { textCompactionTurnId: null };
}

export type CursorSdkEventMapperMeta = {
  turnId: string;
  cwd: string;
  runtime?: AgentChatRuntime;
  runId?: string;
  /** The service's per-runtime state, so a text-signalled compaction can close. */
  state: CursorSdkEventMapperState;
};

function compactionEventsFromSignal(
  meta: CursorSdkEventMapperMeta,
  signal: string | null,
  turnId: string,
): AgentChatEvent[] {
  if (!signal) return [];
  const compacting = detectCompactionSignalText(signal);
  const active = Boolean(turnId) && meta.state.textCompactionTurnId === turnId;
  if (compacting === active) return [];
  meta.state.textCompactionTurnId = compacting ? turnId : null;
  return [{
    type: "context_compact",
    trigger: "auto",
    state: compacting ? "started" : "completed",
    turnId,
    compactionId: turnId,
    provider: "cursor",
  }];
}

/**
 * A compaction the worker saw through Cursor's `preCompact` hook. The first
 * compaction in a turn shares the text fallback's id (the turn id), so the two
 * paths merge into one divider if both fire.
 */
function compactionEventsFromHook(record: SdkMessageRecord, turnId: string): AgentChatEvent[] {
  const phase = readString(record.phase);
  if (phase !== "started" && phase !== "completed" && phase !== "failed") return [];
  const seq = readNumber(record.seq) ?? 1;
  const compactionId = seq > 1 ? `${turnId}:compact-${seq}` : turnId;
  const trigger = record.trigger === "manual" ? "manual" : "auto";
  const contextTokens = readNumber(record.contextTokens);
  const preTokens = contextTokens != null && contextTokens > 0 ? contextTokens : null;
  const durationMs = phase === "started" ? null : readNumber(record.durationMs);
  const compact: Extract<AgentChatEvent, { type: "context_compact" }> = {
    type: "context_compact",
    trigger,
    state: phase,
    turnId,
    compactionId,
    provider: "cursor",
    detection: "provider",
    ...(preTokens != null ? { preTokens } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(phase === "failed" ? { failReason: "interrupted" as const } : {}),
  };
  if (phase !== "started") return [compact];
  const windowSize = readNumber(record.contextWindowSize);
  if (preTokens == null || windowSize == null || windowSize <= 0) return [compact];
  // The occupancy Cursor measured when it decided to compact: a real context
  // figure, which the per-turn `usage` totals are not.
  return [
    liveContextUsageEvent({
      used: preTokens,
      max: windowSize,
      turnId,
      model: readString(record.model),
      state: "measured",
    }),
    compact,
  ];
}

function tagRuntime<T>(event: T, runtime?: AgentChatRuntime): T {
  if (!runtime || runtime === "local") return event;
  return { ...event, runtime } as T;
}

function normalizeCloudStatus(raw: string | null): AgentChatCloudRunStatus | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  switch (lower) {
    case "creating":
    case "running":
    case "finished":
    case "error":
    case "cancelled":
    case "expired":
      return lower;
    default:
      return null;
  }
}

export function mapCursorSdkMessageToChatEvents(
  message: unknown,
  meta: CursorSdkEventMapperMeta,
): AgentChatEvent[] {
  const record = asRecord(message) as SdkMessageRecord | null;
  if (!record) return [];
  const type = readString(record.type);
  const turnId = meta.turnId;
  const runtime = meta.runtime ?? "local";

  switch (type) {
    case "assistant":
      return extractTextContent(record).map((text) =>
        tagRuntime({ type: "text" as const, text, turnId }, runtime),
      );
    case "thinking": {
      const text = readString(record.text);
      if (!text) return [];
      return [tagRuntime({
        type: "reasoning" as const,
        text,
        turnId,
        itemId: readString(record.run_id) ?? undefined,
      }, runtime)];
    }
    case "tool_call": {
      const callId = readString(record.call_id) ?? readString(record.id) ?? `cursor-sdk-tool-${Date.now()}`;
      const tool = normalizeToolName(readString(record.name) ?? "tool");
      const status = readString(record.status) ?? "running";
      const args = record.args;
      const result = record.result;
      const out: AgentChatEvent[] = [];
      const lowerTool = tool.toLowerCase();
      if (lowerTool === "mcp") {
        const mcp = cursorMcpSource(args);
        if (mcp) {
          const label = `${mcp.source.server}:${mcp.source.tool}`;
          if (status === "running") {
            return [tagRuntime({
              type: "tool_call" as const,
              tool: label,
              args: mcp.args,
              mcp: mcp.source,
              itemId: callId,
              turnId,
            }, runtime)];
          }
          const failed = status === "error" || cursorMcpResultFailed(result);
          return [tagRuntime({
            type: "tool_result" as const,
            tool: label,
            result,
            mcp: mcp.source,
            itemId: callId,
            turnId,
            status: failed ? "failed" : "completed",
          }, runtime)];
        }
      }
      if (lowerTool === "updatetodos" || lowerTool === "update_todos") {
        // Cursor's own plan tool. It streams one event per item added, each
        // carrying the whole list so far, then repeats the final list with a
        // terminal status. Only the terminal event is mapped: emitting the
        // partials would redraw the plan card once per item, and the last two
        // events observed on the wire carry identical lists.
        //
        // The raw tool row is suppressed on purpose. The plan card IS the
        // rendering of this call, and showing both puts the same list on screen
        // twice.
        if (status === "running") return [];
        // A failed call is a failure, not a plan. `result.value.todos` is absent
        // on an error, so the `args` fallback would otherwise render the list
        // the model ASKED for as though the tool had recorded it — and drop the
        // failure row entirely.
        if (status === "error") {
          return [tagRuntime({
            type: "tool_result" as const,
            tool,
            result,
            itemId: callId,
            turnId,
            status: "failed" as const,
          }, runtime)];
        }
        const todos = cursorTodoItems(args, result);
        if (!todos.length) return [];
        return [
          tagRuntime({
            type: "todo_update" as const,
            items: todos.map((todo, index) => ({
              // Stable across calls, like `normalizeClaudeTodoItems`. A per-call
              // prefix would make every item look new to the transcript's todo
              // diff, so each plan update would redraw the whole list.
              id: `todo-${index}`,
              description: todo.text,
              status: todo.todoStatus,
            })),
            turnId,
          }, runtime),
          tagRuntime({
            type: "plan" as const,
            steps: todos.map((todo) => ({ text: todo.text, status: todo.planStatus })),
            turnId,
          }, runtime),
        ];
      }
      if (lowerTool === "generateimage" || lowerTool === "generate_image") {
        const input = asRecord(args);
        const prompt = readString(input?.description) ?? "Generated image";
        const failed = status === "error" || readString(asRecord(result)?.status)?.toLowerCase() === "error";
        const savedPath = cursorGeneratedImagePath(result);
        return [tagRuntime({
          type: "codex_image_generation" as const,
          itemId: callId,
          turnId,
          prompt,
          ...(savedPath ? { result: savedPath, savedPath } : {}),
          status: status === "running" ? "running" : failed ? "failed" : "completed",
        }, runtime)];
      }
      if (lowerTool === "task") {
        const taskArgs = asRecord(args);
        const taskResult = asRecord(result);
        const taskValue = asRecord(taskResult?.value);
        const subagentType = asRecord(taskArgs?.subagentType);
        const description = readString(taskArgs?.description) ?? "Cursor subagent";
        const agentType = readString(subagentType?.name) ?? readString(subagentType?.kind);
        const model = readString(taskArgs?.model);
        const agentId = readString(taskValue?.agentId) ?? readString(taskArgs?.agentId);
        const resultStatus = readString(taskResult?.status);
        const failed = status === "error" || resultStatus === "error";
        const summary = failed
          ? summarizeUnknown(taskResult?.error) ?? `${description} failed`
          : readString(taskValue?.resultSuffix)
            ?? (taskValue?.isBackground === true
              ? "Background subagent launched; Cursor does not expose a detached child event stream."
              : `${description} completed`);

        if (status === "running") {
          return [
            tagRuntime({
              type: "activity" as const,
              activity: "spawning_agent" as const,
              detail: description,
              turnId,
            }, runtime),
            tagRuntime({ type: "tool_call" as const, tool, args, itemId: callId, turnId }, runtime),
            tagRuntime({
              type: "subagent_started" as const,
              taskId: callId,
              ...(agentId ? { agentId } : {}),
              ...(agentType ? { agentType, label: agentType } : {}),
              ...(model ? { model } : {}),
              parentToolUseId: callId,
              description,
              turnId,
            }, runtime),
          ];
        }

        const durationMs = readNumber(taskValue?.durationMs);
        return [
          tagRuntime({
            type: "tool_result" as const,
            tool,
            result,
            itemId: callId,
            turnId,
            status: failed ? "failed" : "completed",
          }, runtime),
          tagRuntime({
            type: "subagent_result" as const,
            taskId: callId,
            ...(agentId ? { agentId } : {}),
            ...(agentType ? { agentType, label: agentType } : {}),
            ...(model ? { model } : {}),
            parentToolUseId: callId,
            status: failed ? "failed" : "completed",
            summary,
            finalSummary: summary,
            ...(durationMs != null ? { usage: { durationMs } } : {}),
            turnId,
          }, runtime),
        ];
      }
      const command = lowerTool === "shell" || lowerTool === "bash" || lowerTool === "terminal"
        ? extractCommand(args)
        : null;
      if (command) {
        out.push(tagRuntime({
          type: "command" as const,
          command,
          cwd: extractCwd(args, meta.cwd),
          output: status === "running" ? "" : summarizeResult(result),
          itemId: callId,
          turnId,
          status: status === "error" ? "failed" : status === "completed" ? "completed" : "running",
          ...(status !== "running" ? { exitCode: extractExitCode(result) } : {}),
        }, runtime));
        return out;
      }

      if (status === "running") {
        out.push(tagRuntime({ type: "tool_call" as const, tool, args, itemId: callId, turnId }, runtime));
      } else {
        out.push(tagRuntime({
          type: "tool_result" as const,
          tool,
          result,
          itemId: callId,
          turnId,
          status: status === "error" ? "failed" : "completed",
        }, runtime));
      }
      return out;
    }
    case "task": {
      const text = readString(record.text);
      return text ? [tagRuntime({
          type: "activity" as const,
          activity: "working" as const,
          detail: text,
          turnId,
        }, runtime)] : [];
    }
    case "status": {
      const statusText = readString(record.status);
      const detail = readStatusDetail(record);
      // Text matching is only the fallback for runs the `preCompact` hook did
      // not report on; the worker marks status events once it has.
      const compactionSignal = record[CURSOR_SDK_PRECOMPACT_HOOK_MARK] === true
        ? null
        : [statusText, detail].filter(Boolean).join(" · ");
      const compactionEvents = compactionEventsFromSignal(meta, compactionSignal, turnId);
      if (runtime === "cloud") {
        const cloudStatus = normalizeCloudStatus(statusText);
        if (!cloudStatus) {
          if (statusText) {
            return [tagRuntime({
              type: "activity" as const,
              activity: "working" as const,
              detail: detail ?? `Cursor Cloud: ${statusText}`,
              turnId,
            }, runtime)];
          }
          return [];
        }
        const runId = meta.runId ?? readString(record.run_id) ?? "";
        const gitBranch = readString(record.gitBranch ?? asRecord(record.git)?.branch);
        const prUrl = readString(record.prUrl ?? asRecord(record.git)?.prUrl);
        const cloudEvent: Extract<AgentChatEvent, { type: "cloud_status" }> = {
          type: "cloud_status",
          turnId,
          runId,
          status: cloudStatus,
          ...(detail ? { detail } : {}),
          ...(gitBranch ? { gitBranch } : {}),
          ...(prUrl ? { prUrl } : {}),
        };
        return [...compactionEvents, cloudEvent];
      }
      if (statusText === "RUNNING") {
        return [
          ...compactionEvents,
          tagRuntime({
          type: "activity" as const,
          activity: "working" as const,
          detail: detail ?? CURSOR_WORKING_ACTIVITY_DETAIL,
          turnId,
        }, runtime),
        ];
      }
      if (statusText === "CREATING") {
        return [
          ...compactionEvents,
          tagRuntime({
          type: "activity" as const,
          activity: "working" as const,
          detail: detail ?? CURSOR_WORKING_ACTIVITY_DETAIL,
          turnId,
        }, runtime),
        ];
      }
      if (statusText === "ERROR") {
        // The streamed ERROR status often carries no reason; the worker injects
        // the run result/store detail after the run settles.
        const errorCode = readString(record.adeErrorCode);
        const errorDetail = asRecord(record.adeErrorDetail);
        const detailMessage = readString(errorDetail?.message);
        const detailCode = readString(errorDetail?.code);
        const detailName = readString(errorDetail?.name);
        const requestId = readString(errorDetail?.requestId);
        const kind = classifyCursorSdkErrorText(errorCode, detail, detailMessage, detailCode, detailName);
        const presented = presentChatFailure({
          kind,
          message: CURSOR_FAILURE_MESSAGES[kind] ?? detail,
          detail: detailMessage ?? detail,
          errorCode,
          provider: "Cursor",
        });
        const message = presented.body;
        const eventDetail = uniqueLines([
          presented.technicalDetail,
          errorCode
            && !message.includes(errorCode)
            && !(detailMessage?.includes(errorCode) ?? false)
            ? errorCode
            : null,
          requestId ? `Cursor request ID: ${requestId}` : null,
        ]);
        const category: "rate_limit" | "network" | "busy" | "auth" | "unknown" =
          kind === "rate_limit" || kind === "network" || kind === "busy" || kind === "auth"
            ? kind
            : "unknown";
        return [
          ...compactionEvents,
          {
            type: "error" as const,
            message,
            turnId,
            ...(eventDetail ? { detail: eventDetail } : {}),
            errorInfo: { category, presentation: presented },
          },
        ];
      }
      return compactionEvents;
    }
    case "request": {
      const requestId = readString(record.request_id) ?? `cursor-sdk-request-${Date.now()}`;
      return [{
        type: "approval_request",
        itemId: requestId,
        kind: "tool_call",
        description: "Cursor SDK emitted a request event.",
        turnId,
        detail: record,
      }];
    }
    case "usage": {
      const tokens = mapTurnEndedTokensToEvent(record, {
        turnId,
        runtime,
        ...(readString(record.run_id) ? { itemId: readString(record.run_id) ?? undefined } : {}),
      });
      return tokens ? [tokens] : [];
    }
    // ADE emits its own `user_message` row on every send path, local and cloud,
    // so a `user` event off the stream is always a second copy of something
    // already in the transcript. A steered message echoed back by `Run.steer()`
    // is one instance of that, not the reason.
    //
    // Stated as a case rather than left to the default so a later reader cannot
    // "fix" the silence by adding a mapping.
    case "user":
      return [];
    case CURSOR_SDK_COMPACTION_EVENT:
      return compactionEventsFromHook(record, turnId);
    default:
      return [];
  }
}

export type CursorSdkRunResultMeta = {
  turnId: string;
  model: string;
  modelId?: string;
  runtime?: AgentChatRuntime;
};

/**
 * The one reader for a Cursor usage record, used by both the run result and a
 * turn-ended report: every spelling the SDK and the wire use for each count.
 */
function readCursorUsageCounts(usage: SdkMessageRecord | null): {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
} {
  return {
    inputTokens: readNumber(
      usage?.inputTokens ?? usage?.input_tokens ?? usage?.totalInputTokens ?? usage?.total_input_tokens,
    ),
    outputTokens: readNumber(
      usage?.outputTokens ?? usage?.output_tokens ?? usage?.totalOutputTokens ?? usage?.total_output_tokens,
    ),
    cacheReadTokens: readNumber(usage?.cacheReadTokens ?? usage?.cache_read_tokens),
    cacheWriteTokens: readNumber(
      usage?.cacheWriteTokens ?? usage?.cache_write_tokens ?? usage?.cacheCreationTokens ?? usage?.cache_creation_tokens,
    ),
    reasoningTokens: readNumber(usage?.reasoningTokens ?? usage?.reasoning_tokens),
  };
}

export function mapCursorSdkRunResultToDoneEvent(
  result: unknown,
  meta: CursorSdkRunResultMeta,
): Extract<AgentChatEvent, { type: "done" }> {
  const record = asRecord(result);
  const status = readString(record?.status);
  const doneStatus =
    status === "cancelled" ? "interrupted"
      : status === "error" ? "failed"
      : "completed";
  // `RunResult.usage` is the SDK's sum over every turn-ended report in the run.
  const counts = readCursorUsageCounts(asRecord(record?.usage));
  const usage = {
    ...(counts.inputTokens != null ? { inputTokens: counts.inputTokens } : {}),
    ...(counts.outputTokens != null ? { outputTokens: counts.outputTokens } : {}),
    ...(counts.cacheReadTokens != null ? { cacheReadTokens: counts.cacheReadTokens } : {}),
    ...(counts.cacheWriteTokens != null ? { cacheCreationTokens: counts.cacheWriteTokens } : {}),
    ...(counts.reasoningTokens != null ? { reasoningTokens: counts.reasoningTokens } : {}),
  };
  const telemetry = asRecord(record?.[CURSOR_SDK_TURN_TELEMETRY_KEY]);
  const email = readString(telemetry?.accountEmail);
  const servedModel = readString(telemetry?.servedModel);
  return {
    type: "done",
    turnId: meta.turnId,
    status: doneStatus,
    model: meta.model,
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(meta.runtime && meta.runtime !== "local" ? { runtime: meta.runtime } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(servedModel ? { servedModel } : {}),
    // Every Cursor run, local or cloud, bills the signed-in Cursor plan.
    account: { provider: "cursor", kind: "subscription", ...(email ? { email } : {}) },
  };
}

export type CursorSdkTurnEndedTokensMeta = {
  turnId: string;
  itemId?: string;
  runtime?: AgentChatRuntime;
  contextWindow?: number;
};

export function mapTurnEndedTokensToEvent(
  update: unknown,
  meta: CursorSdkTurnEndedTokensMeta,
): Extract<AgentChatEvent, { type: "tokens" }> | null {
  const record = asRecord(update);
  const usage = asRecord(record?.usage) ?? record;
  if (!usage) return null;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = readCursorUsageCounts(usage);
  if (inputTokens == null && outputTokens == null && cacheReadTokens == null && cacheWriteTokens == null) {
    return null;
  }
  return {
    type: "tokens",
    turnId: meta.turnId,
    ...(meta.itemId ? { itemId: meta.itemId } : {}),
    ...(meta.runtime && meta.runtime !== "local" ? { runtime: meta.runtime } : {}),
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens != null ? { cacheWriteTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
    ...(meta.contextWindow != null ? { contextWindow: meta.contextWindow } : {}),
  };
}
