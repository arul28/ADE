import type { AgentChatEventEnvelope, TurnDiffSummary } from "../../../shared/types";

export type ChatSubagentSnapshot = {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  updatedAt: string;
  summary: string | null;
  lastToolName?: string;
  background?: boolean;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
};

function compareIsoDesc(left: string, right: string): number {
  return Date.parse(right) - Date.parse(left);
}

export function deriveChatSubagentSnapshots(events: AgentChatEventEnvelope[]): ChatSubagentSnapshot[] {
  const snapshots = new Map<string, ChatSubagentSnapshot>();

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "subagent_started") {
      const existing = snapshots.get(event.taskId);
      snapshots.set(event.taskId, {
        taskId: event.taskId,
        description: event.description.trim() || existing?.description || "Subagent task",
        status: "running",
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        summary: existing?.summary ?? null,
        lastToolName: existing?.lastToolName,
        background: event.background ?? existing?.background ?? false,
        usage: existing?.usage,
      });
      continue;
    }

    if (event.type === "subagent_progress") {
      const existing = snapshots.get(event.taskId);
      snapshots.set(event.taskId, {
        taskId: event.taskId,
        description: event.description?.trim() || existing?.description || "Subagent task",
        status: "running",
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        summary: event.summary?.trim() || existing?.summary || null,
        lastToolName: event.lastToolName ?? existing?.lastToolName,
        usage: event.usage ? { ...(existing?.usage ?? {}), ...event.usage } : existing?.usage,
      });
      continue;
    }

    if (event.type === "subagent_result") {
      const existing = snapshots.get(event.taskId);
      snapshots.set(event.taskId, {
        taskId: event.taskId,
        description: existing?.description ?? "Subagent task",
        status: event.status,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        summary: event.summary?.trim() || existing?.summary || null,
        lastToolName: existing?.lastToolName,
        usage: event.usage ? { ...(existing?.usage ?? {}), ...event.usage } : existing?.usage,
      });
    }
  }

  return [...snapshots.values()].sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (right.status === "running" && left.status !== "running") return 1;
    return compareIsoDesc(left.updatedAt, right.updatedAt);
  });
}

export function deriveTurnDiffSummaries(events: AgentChatEventEnvelope[]): TurnDiffSummary[] {
  const summaries: TurnDiffSummary[] = [];
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "turn_diff_summary") {
      summaries.push({
        turnId: event.turnId,
        beforeSha: event.beforeSha,
        afterSha: event.afterSha,
        files: event.files,
        totalAdditions: event.totalAdditions,
        totalDeletions: event.totalDeletions,
      });
    }
  }
  return summaries;
}

export type SubagentTimelineEntry = {
  timestamp: string;
  type: "started" | "progress" | "result";
  summary: string | null;
  lastToolName: string | null;
  status: string | null;
};

export function deriveSubagentTimeline(
  events: AgentChatEventEnvelope[],
  taskId: string,
): SubagentTimelineEntry[] {
  const entries: SubagentTimelineEntry[] = [];
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "subagent_started" && event.taskId === taskId) {
      entries.push({
        timestamp: envelope.timestamp,
        type: "started",
        summary: null,
        lastToolName: null,
        status: null,
      });
    } else if (event.type === "subagent_progress" && event.taskId === taskId) {
      entries.push({
        timestamp: envelope.timestamp,
        type: "progress",
        summary: event.summary?.trim() ?? null,
        lastToolName: event.lastToolName ?? null,
        status: null,
      });
    } else if (event.type === "subagent_result" && event.taskId === taskId) {
      entries.push({
        timestamp: envelope.timestamp,
        type: "result",
        summary: event.summary?.trim() ?? null,
        lastToolName: null,
        status: event.status,
      });
    }
  }
  return entries;
}
