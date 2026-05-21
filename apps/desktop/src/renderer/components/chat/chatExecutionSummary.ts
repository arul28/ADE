import type { AgentChatEventEnvelope, TurnDiffSummary } from "../../../shared/types";
import { latestPlan, type ChatInfoPlan } from "../../../shared/chatSubagents";

export type { ChatInfoPlan, ChatInfoPlanStep } from "../../../shared/chatSubagents";

/**
 * Latest plan snapshot derived from the event stream. Returns null when the
 * provider has not emitted a plan event for this chat.
 */
export function derivePlan(events: AgentChatEventEnvelope[]): ChatInfoPlan {
  return latestPlan(events);
}

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
  taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
  workflowName?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
};

function compareIsoDesc(left: string, right: string): number {
  return Date.parse(right) - Date.parse(left);
}

type ChatSubagentEvent = Extract<
  AgentChatEventEnvelope["event"],
  { type: "subagent_started" | "subagent_progress" | "subagent_result" }
>;

function isSubagentEvent(event: AgentChatEventEnvelope["event"]): event is ChatSubagentEvent {
  return event.type === "subagent_started" || event.type === "subagent_progress" || event.type === "subagent_result";
}

function subagentIdentityKey(event: ChatSubagentEvent): string {
  return event.agentId ?? event.taskId;
}

function buildResolvedSubagentKeysByParent(events: AgentChatEventEnvelope[]): Map<string, Set<string>> {
  const keysByParent = new Map<string, Set<string>>();
  for (const envelope of events) {
    const event = envelope.event;
    if (!isSubagentEvent(event) || !event.parentToolUseId) continue;
    const key = subagentIdentityKey(event);
    if (key === event.parentToolUseId) continue;
    const keys = keysByParent.get(event.parentToolUseId) ?? new Set<string>();
    keys.add(key);
    keysByParent.set(event.parentToolUseId, keys);
  }
  return keysByParent;
}

function isParentPlaceholder(snapshot: ChatSubagentSnapshot, parentToolUseId: string): boolean {
  return !snapshot.agentId && snapshot.taskId === parentToolUseId && snapshot.parentToolUseId === parentToolUseId;
}

function resolveSubagentSnapshot(
  snapshots: Map<string, ChatSubagentSnapshot>,
  event: ChatSubagentEvent,
  resolvedKeysByParent: Map<string, Set<string>>,
): { key: string; existing: ChatSubagentSnapshot | undefined; adoptedPlaceholder: boolean } {
  const key = subagentIdentityKey(event);
  const direct = snapshots.get(key);
  const parentPlaceholder = event.parentToolUseId ? snapshots.get(event.parentToolUseId) : undefined;
  const parentResolvedKeys = event.parentToolUseId ? resolvedKeysByParent.get(event.parentToolUseId) : undefined;
  const canAdoptParentPlaceholder = Boolean(
    event.parentToolUseId
      && parentPlaceholder
      && isParentPlaceholder(parentPlaceholder, event.parentToolUseId)
      && parentResolvedKeys?.size === 1
      && parentResolvedKeys.has(key),
  );
  const taskAliasCandidate = key !== event.taskId ? snapshots.get(event.taskId) : undefined;
  const taskAliasIsParentPlaceholder = Boolean(
    taskAliasCandidate
      && event.parentToolUseId
      && event.taskId === event.parentToolUseId
      && isParentPlaceholder(taskAliasCandidate, event.parentToolUseId),
  );
  const taskAlias = taskAliasCandidate && (!taskAliasIsParentPlaceholder || canAdoptParentPlaceholder)
    ? taskAliasCandidate
    : undefined;
  const adoptParentPlaceholder = !taskAlias && canAdoptParentPlaceholder ? parentPlaceholder : undefined;
  const adoptedPlaceholder = Boolean(adoptParentPlaceholder || (taskAlias && taskAliasIsParentPlaceholder));

  if (taskAlias && key !== event.taskId) snapshots.delete(event.taskId);
  if (adoptParentPlaceholder && event.parentToolUseId) {
    snapshots.delete(event.parentToolUseId);
  } else if (
    event.parentToolUseId
    && parentPlaceholder
    && isParentPlaceholder(parentPlaceholder, event.parentToolUseId)
    && parentResolvedKeys
    && parentResolvedKeys.size > 1
  ) {
    snapshots.delete(event.parentToolUseId);
  }

  return {
    key,
    existing: direct ?? taskAlias ?? adoptParentPlaceholder,
    adoptedPlaceholder,
  };
}

export function deriveChatSubagentSnapshots(events: AgentChatEventEnvelope[]): ChatSubagentSnapshot[] {
  const snapshots = new Map<string, ChatSubagentSnapshot>();
  const terminalTurnIds = new Set<string>();
  const resolvedKeysByParent = buildResolvedSubagentKeysByParent(events);

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
      const { key, existing } = resolveSubagentSnapshot(snapshots, event, resolvedKeysByParent);
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
        taskType: event.taskType ?? existing?.taskType,
        workflowName: event.workflowName ?? existing?.workflowName,
        usage: existing?.usage,
      });
      continue;
    }

    if (event.type === "subagent_progress") {
      const { key, existing, adoptedPlaceholder } = resolveSubagentSnapshot(snapshots, event, resolvedKeysByParent);
      snapshots.set(key, {
        taskId: adoptedPlaceholder ? event.taskId : existing?.taskId ?? event.taskId,
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
        taskType: event.taskType ?? existing?.taskType,
        workflowName: event.workflowName ?? existing?.workflowName,
        usage: event.usage ? { ...(existing?.usage ?? {}), ...event.usage } : existing?.usage,
      });
      continue;
    }

    if (event.type === "subagent_result") {
      const { key, existing, adoptedPlaceholder } = resolveSubagentSnapshot(snapshots, event, resolvedKeysByParent);
      snapshots.set(key, {
        taskId: adoptedPlaceholder ? event.taskId : existing?.taskId ?? event.taskId,
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
        taskType: event.taskType ?? existing?.taskType,
        workflowName: event.workflowName ?? existing?.workflowName,
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
