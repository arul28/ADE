import type {
  AgentChatEvent,
  AgentChatMissionFeature,
  AgentChatMissionProgressEntry,
} from "../../../shared/types";
import { detectCompactionSignalText } from "../../../shared/contextCompaction";

type SdkRecord = Record<string, unknown>;

export type DroidSdkEventMapperState = {
  assistantDeltaItemIds: Set<string>;
  thinkingDeltaItemIds: Set<string>;
  toolNamesByUseId: Map<string, string>;
  latestUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } | null;
  compactionActive?: boolean;
};

export function createDroidSdkEventMapperState(): DroidSdkEventMapperState {
  return {
    assistantDeltaItemIds: new Set(),
    thinkingDeltaItemIds: new Set(),
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

function itemIdFor(record: SdkRecord, kind: "text" | "thinking"): string {
  const messageId = readString(record.messageId) ?? `droid-${kind}`;
  const blockIndex = readNumber(record.blockIndex) ?? 0;
  return `${messageId}:${kind}:${blockIndex}`;
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

function extractTextBlocks(content: unknown): Array<{ text: string; kind: "text" | "thinking"; id?: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ text: string; kind: "text" | "thinking"; id?: string }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    const type = readString(record.type);
    const text = readString(record.text);
    if (!text) continue;
    out.push({
      text,
      kind: type === "thinking" ? "thinking" : "text",
      ...(readString(record.id) ? { id: readString(record.id)! } : {}),
    });
  }
  return out;
}

function usageFrom(record: SdkRecord | null): DroidSdkEventMapperState["latestUsage"] {
  if (!record) return null;
  const inputTokens = readNumber(record.inputTokens);
  const outputTokens = readNumber(record.outputTokens);
  const cacheReadTokens = readNumber(record.cacheReadTokens);
  const cacheCreationTokens = readNumber(record.cacheCreationTokens);
  const usage = {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens != null ? { cacheCreationTokens } : {}),
  };
  return Object.keys(usage).length ? usage : null;
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
    case "create_message": {
      const role = readString(record.role);
      if (role !== "assistant") return [];
      return extractTextBlocks(record.content).flatMap((block, index): AgentChatEvent[] => {
        const messageId = readString(record.messageId) ?? `droid-${block.kind === "thinking" ? "thinking" : "text"}`;
        const itemId = block.id ?? `${messageId}:${block.kind}:${index}`;
        if (block.kind === "thinking") {
          if (meta.state.thinkingDeltaItemIds.has(itemId)) return [];
          return [{ type: "reasoning", text: block.text, itemId, turnId }];
        }
        if (meta.state.assistantDeltaItemIds.has(itemId)) return [];
        return [{ type: "text", text: block.text, itemId, turnId }];
      });
    }
    case "tool_use": {
      const toolUseId = readString(record.toolUseId) ?? `droid-tool-${Date.now()}`;
      const tool = readString(record.toolName) ?? "tool";
      meta.state.toolNamesByUseId.set(toolUseId, tool);
      const command = extractCommand(record.toolInput);
      if (command) {
        return [{
          type: "command",
          command,
          cwd: extractCwd(record.toolInput, meta.cwd),
          output: "",
          itemId: toolUseId,
          turnId,
          status: "running",
        }];
      }
      return [{ type: "tool_call", tool, args: record.toolInput ?? {}, itemId: toolUseId, turnId }];
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
      return [{
        type: "tool_result",
        tool,
        result: record.content,
        itemId: toolUseId,
        turnId,
        status: toolResultStatus(record),
      }];
    }
    case "working_state_changed": {
      const state = readString(record.state);
      if (!state || state.toLowerCase() === "idle") {
        if (meta.state.compactionActive) {
          meta.state.compactionActive = false;
          return [{
            type: "context_compact",
            trigger: "auto",
            state: "completed",
            turnId,
            compactionId: turnId,
            provider: "droid",
          }];
        }
        return [];
      }
      const out: AgentChatEvent[] = [];
      if (detectCompactionSignalText(state) && !meta.state.compactionActive) {
        meta.state.compactionActive = true;
        out.push({
          type: "context_compact",
          trigger: "auto",
          state: "started",
          turnId,
          compactionId: turnId,
          provider: "droid",
        });
      } else if (!detectCompactionSignalText(state) && meta.state.compactionActive) {
        meta.state.compactionActive = false;
        out.push({
          type: "context_compact",
          trigger: "auto",
          state: "completed",
          turnId,
          compactionId: turnId,
          provider: "droid",
        });
      }
      out.push({
        type: "activity",
        activity: "working",
        detail: `Droid ${state}`,
        turnId,
      });
      return out;
    }
    case "token_usage_update": {
      const usage = usageFrom(record);
      meta.state.latestUsage = usage;
      if (!usage) return [];
      return [{
        type: "tokens",
        turnId,
        ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.cacheReadTokens != null ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheCreationTokens != null ? { cacheWriteTokens: usage.cacheCreationTokens } : {}),
      }];
    }
    case "mission_worker_started": {
      // AGI orchestrator spawned a worker sub-session — surface it as a subagent.
      const workerSessionId = readString(record.workerSessionId);
      if (!workerSessionId) return [];
      return [{
        type: "subagent_started",
        taskId: workerSessionId,
        parentToolUseId: null,
        description: `Worker ${workerSessionId.slice(-6)}`,
        turnId,
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
      return [{
        type: "subagent_result",
        taskId: workerSessionId,
        parentToolUseId: null,
        status: ok ? "completed" : "failed",
        summary,
        finalSummary: summary,
        turnId,
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
    case "mission_heartbeat":
    case "session_title_updated":
    case "settings_updated":
    case "permission_resolved":
    case "turn_complete":
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
    state: DroidSdkEventMapperState;
    interrupted?: boolean;
  },
): Extract<AgentChatEvent, { type: "done" }> {
  const record = asRecord(result);
  const tokenUsage = asRecord(record?.tokenUsage) ?? meta.state.latestUsage;
  const usage = usageFrom(tokenUsage);
  return {
    type: "done",
    turnId: meta.turnId,
    status: meta.interrupted ? "interrupted" : record?.success === false ? "failed" : "completed",
    model: meta.model,
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(usage ? { usage } : {}),
  };
}
