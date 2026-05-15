import type { AgentChatEventEnvelope, TurnDiffSummary } from "../../../shared/types";

export type ChatSubagentSnapshot = {
  taskId: string;
  agentId?: string;
  agentType?: string;
  parentToolUseId?: string | null;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  turnId?: string;
  startedAt: string;
  updatedAt: string;
  summary: string | null;
  finalSummary?: string | null;
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

function findSnapshotByParent(
  snapshots: Map<string, ChatSubagentSnapshot>,
  parentToolUseId: string | null | undefined,
): [string, ChatSubagentSnapshot] | null {
  if (!parentToolUseId) return null;
  const direct = snapshots.get(parentToolUseId);
  if (direct) return [parentToolUseId, direct];
  for (const entry of snapshots.entries()) {
    const [, snapshot] = entry;
    if (snapshot.parentToolUseId === parentToolUseId) return entry;
  }
  return null;
}

export function deriveChatSubagentSnapshots(events: AgentChatEventEnvelope[]): ChatSubagentSnapshot[] {
  const snapshots = new Map<string, ChatSubagentSnapshot>();
  const terminalTurnIds = new Set<string>();

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "done") {
      terminalTurnIds.add(event.turnId);
    } else if (event.type === "status" && event.turnStatus !== "started" && event.turnId) {
      terminalTurnIds.add(event.turnId);
    }
  }

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "subagent_started") {
      const key = event.agentId ?? event.taskId;
      const parentMatch = findSnapshotByParent(snapshots, event.parentToolUseId);
      const existing = snapshots.get(key) ?? snapshots.get(event.taskId) ?? parentMatch?.[1];
      if (key !== event.taskId) snapshots.delete(event.taskId);
      if (parentMatch && parentMatch[0] !== key) snapshots.delete(parentMatch[0]);
      snapshots.set(key, {
        taskId: event.taskId,
        agentId: event.agentId ?? existing?.agentId,
        agentType: event.agentType ?? existing?.agentType,
        parentToolUseId: event.parentToolUseId ?? existing?.parentToolUseId ?? null,
        description: event.description.trim() || existing?.description || "Subagent task",
        status: "running",
        turnId: event.turnId ?? existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        summary: existing?.summary ?? null,
        finalSummary: existing?.finalSummary ?? null,
        lastToolName: existing?.lastToolName,
        background: event.background ?? existing?.background ?? false,
        usage: existing?.usage,
      });
      continue;
    }

    if (event.type === "subagent_progress") {
      const key = event.agentId ?? event.taskId;
      const parentMatch = findSnapshotByParent(snapshots, event.parentToolUseId);
      const existing = snapshots.get(key) ?? snapshots.get(event.taskId) ?? parentMatch?.[1];
      if (key !== event.taskId) snapshots.delete(event.taskId);
      if (parentMatch && parentMatch[0] !== key) snapshots.delete(parentMatch[0]);
      snapshots.set(key, {
        // Preserve the stable merged identity. Overwriting taskId with the
        // current event's taskId for a parent-based match would split the
        // agent's history in `deriveSubagentTimeline`, which keys off
        // `snapshot.taskId`.
        taskId: existing?.taskId ?? event.taskId,
        agentId: event.agentId ?? existing?.agentId,
        agentType: event.agentType ?? existing?.agentType,
        parentToolUseId: event.parentToolUseId ?? existing?.parentToolUseId ?? null,
        description: event.description?.trim() || existing?.description || "Subagent task",
        status: "running",
        turnId: event.turnId ?? existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        summary: event.summary?.trim() || existing?.summary || null,
        finalSummary: existing?.finalSummary ?? null,
        lastToolName: event.lastToolName ?? existing?.lastToolName,
        background: existing?.background ?? false,
        usage: event.usage ? { ...(existing?.usage ?? {}), ...event.usage } : existing?.usage,
      });
      continue;
    }

    if (event.type === "subagent_result") {
      const key = event.agentId ?? event.taskId;
      const parentMatch = findSnapshotByParent(snapshots, event.parentToolUseId);
      const existing = snapshots.get(key) ?? snapshots.get(event.taskId) ?? parentMatch?.[1];
      if (key !== event.taskId) snapshots.delete(event.taskId);
      if (parentMatch && parentMatch[0] !== key) snapshots.delete(parentMatch[0]);
      snapshots.set(key, {
        // Preserve the merged taskId (see subagent_progress branch above).
        taskId: existing?.taskId ?? event.taskId,
        agentId: event.agentId ?? existing?.agentId,
        agentType: event.agentType ?? existing?.agentType,
        parentToolUseId: event.parentToolUseId ?? existing?.parentToolUseId ?? null,
        description: existing?.description ?? "Subagent task",
        status: event.status,
        turnId: event.turnId ?? existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        summary: event.summary?.trim() || existing?.summary || null,
        finalSummary: event.finalSummary?.trim() || event.summary?.trim() || existing?.finalSummary || null,
        lastToolName: existing?.lastToolName,
        background: existing?.background ?? false,
        usage: event.usage ? { ...(existing?.usage ?? {}), ...event.usage } : existing?.usage,
      });
    }
  }

  for (const [key, snapshot] of snapshots) {
    if (
      snapshot.status === "running"
      && snapshot.background !== true
      && snapshot.turnId
      && terminalTurnIds.has(snapshot.turnId)
    ) {
      snapshots.set(key, {
        ...snapshot,
        status: "stopped",
        summary: snapshot.summary ?? "Parent turn ended before ADE received a final subagent status",
        finalSummary: snapshot.finalSummary ?? "Parent turn ended before ADE received a final subagent status",
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

export type TodoItemSnapshot = {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
};

/**
 * Returns the latest todo_update snapshot from the event stream.
 * Each todo_update replaces the full list, so we just take the last one.
 */
export function deriveTodoItems(events: AgentChatEventEnvelope[]): TodoItemSnapshot[] {
  let latest: TodoItemSnapshot[] = [];
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "todo_update") {
      latest = event.items.map((item) => ({
        id: item.id,
        description: item.description,
        status: item.status,
      }));
    }
  }
  return latest;
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
