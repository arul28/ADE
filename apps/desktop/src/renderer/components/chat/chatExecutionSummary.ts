import type { AgentChatEventEnvelope } from "../../../shared/types";

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
