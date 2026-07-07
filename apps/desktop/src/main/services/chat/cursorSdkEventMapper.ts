import type { AgentChatCloudRunStatus, AgentChatEvent, AgentChatRuntime } from "../../../shared/types";
import { detectCompactionSignalText } from "../../../shared/contextCompaction";
import { isCursorSdkTransportErrorText } from "./cursorSdkProtocol";

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

export type CursorSdkEventMapperMeta = {
  turnId: string;
  cwd: string;
  taskStatusMap: Map<string, string>;
  runtime?: AgentChatRuntime;
  runId?: string;
  compactionActive?: boolean;
};

function compactionEventsFromSignal(
  meta: CursorSdkEventMapperMeta,
  signal: string | null,
  turnId: string,
): AgentChatEvent[] {
  if (!signal) return [];
  const compacting = detectCompactionSignalText(signal);
  if (!compacting && !meta.compactionActive) return [];
  if (compacting && !meta.compactionActive) {
    meta.compactionActive = true;
    return [{
      type: "context_compact",
      trigger: "auto",
      state: "started",
      turnId,
      compactionId: turnId,
      provider: "cursor",
    }];
  }
  if (!compacting && meta.compactionActive) {
    meta.compactionActive = false;
    return [{
      type: "context_compact",
      trigger: "auto",
      state: "completed",
      turnId,
      compactionId: turnId,
      provider: "cursor",
    }];
  }
  return [];
}

function tagRuntime<T>(event: T, runtime?: AgentChatRuntime): T {
  if (!runtime || runtime === "local") return event;
  return { ...event, runtime } as T;
}

function isCursorTaskTerminalStatus(status: string): boolean {
  const lower = status.toLowerCase();
  return lower === "completed"
    || lower === "failed"
    || lower === "stopped"
    || lower === "cancelled"
    || lower === "error";
}

function cursorTaskResultStatus(status: string): "completed" | "failed" | "stopped" {
  const lower = status.toLowerCase();
  if (lower === "completed") return "completed";
  if (lower === "stopped" || lower === "cancelled") return "stopped";
  return "failed";
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
      const runId = readString(record.run_id);
      const agentId = readString(record.agent_id);
      const status = readString(record.status);
      const out: AgentChatEvent[] = [];

      const makeResultEvent = (terminalStatus: string): AgentChatEvent => {
        const resultStatus = cursorTaskResultStatus(terminalStatus);
        return tagRuntime({
          type: "subagent_result" as const,
          taskId: runId!,
          ...(agentId ? { agentId } : {}),
          parentToolUseId: null,
          status: resultStatus,
          summary: text ?? `subagent ${resultStatus}`,
          turnId,
        }, runtime);
      };

      if (runId) {
        const prevStatus = meta.taskStatusMap.get(runId) ?? null;
        if (prevStatus === null) {
          if (status && isCursorTaskTerminalStatus(status)) {
            out.push(makeResultEvent(status));
          } else {
            meta.taskStatusMap.set(runId, status ?? "started");
            out.push(tagRuntime({
              type: "subagent_started" as const,
              taskId: runId,
              ...(agentId ? { agentId } : {}),
              parentToolUseId: null,
              description: text ?? "subagent",
              turnId,
            }, runtime));
          }
        } else if (status && status !== prevStatus) {
          meta.taskStatusMap.set(runId, status);
          if (isCursorTaskTerminalStatus(status)) {
            out.push(makeResultEvent(status));
            meta.taskStatusMap.delete(runId);
          } else if (text) {
            // Cursor exposes no child transcript, so live `task` text is the only
            // interior signal we get — surface it as progress for the subagent
            // drawer (the panel never takes over a Cursor subagent).
            out.push(tagRuntime({
              type: "subagent_progress" as const,
              taskId: runId,
              ...(agentId ? { agentId } : {}),
              parentToolUseId: null,
              summary: text,
              turnId,
            }, runtime));
          }
        }
      }
      if (text) {
        out.push(tagRuntime({
          type: "activity" as const,
          activity: "spawning_agent" as const,
          detail: text,
          turnId,
        }, runtime));
      }
      return out;
    }
    case "status": {
      const statusText = readString(record.status);
      const detail = readStatusDetail(record);
      const compactionSignal = [statusText, detail].filter(Boolean).join(" · ");
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
        // The streamed ERROR status carries no reason; the worker injects the
        // run store's real errorCode as `adeErrorCode` after the run settles.
        const errorCode = readString(record.adeErrorCode);
        const message = errorCode
          ? `Cursor run failed: ${errorCode}`
          : detail ?? "Cursor SDK run failed.";
        const transport = isCursorSdkTransportErrorText(errorCode ?? detail);
        return [
          ...compactionEvents,
          {
          type: "error" as const,
          message,
          turnId,
          ...(transport ? { errorInfo: { category: "network" as const } } : {}),
        }];
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
  const usageRecord = asRecord(record?.usage);
  const usage = usageRecord
    ? {
        ...(readNumber(usageRecord.inputTokens ?? usageRecord.input_tokens) != null
          ? { inputTokens: readNumber(usageRecord.inputTokens ?? usageRecord.input_tokens) ?? undefined }
          : {}),
        ...(readNumber(usageRecord.outputTokens ?? usageRecord.output_tokens) != null
          ? { outputTokens: readNumber(usageRecord.outputTokens ?? usageRecord.output_tokens) ?? undefined }
          : {}),
        ...(readNumber(usageRecord.cacheReadTokens ?? usageRecord.cache_read_tokens) != null
          ? { cacheReadTokens: readNumber(usageRecord.cacheReadTokens ?? usageRecord.cache_read_tokens) ?? undefined }
          : {}),
        ...(readNumber(usageRecord.cacheCreationTokens ?? usageRecord.cache_creation_tokens) != null
          ? { cacheCreationTokens: readNumber(usageRecord.cacheCreationTokens ?? usageRecord.cache_creation_tokens) ?? undefined }
          : {}),
      }
    : undefined;
  return {
    type: "done",
    turnId: meta.turnId,
    status: doneStatus,
    model: meta.model,
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(meta.runtime && meta.runtime !== "local" ? { runtime: meta.runtime } : {}),
    ...(usage && Object.keys(usage).length ? { usage } : {}),
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
  const inputTokens = readNumber(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = readNumber(usage.outputTokens ?? usage.output_tokens);
  const cacheReadTokens = readNumber(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const cacheWriteTokens = readNumber(
    usage.cacheWriteTokens
      ?? usage.cache_write_tokens
      ?? usage.cacheCreationTokens
      ?? usage.cache_creation_tokens,
  );
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
    ...(meta.contextWindow != null ? { contextWindow: meta.contextWindow } : {}),
  };
}
