import type {
  AgentChatEventEnvelope,
  TurnDiffSummary,
} from "../../../shared/types";
import {
  latestPlan,
  normalizeSubagentLifecycleEvent,
  type ChatInfoPlan,
  type NormalizedSubagentLifecycleEvent,
} from "../../../shared/chatSubagents";

export type { ChatInfoPlan, ChatInfoPlanStep } from "../../../shared/chatSubagents";
export {
  deriveScheduledWorkSnapshots,
  mergeManagedScheduledWorkSnapshots,
  type ChatScheduledWorkSnapshot,
} from "../../../shared/chatScheduledWork";

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
  label?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  parentToolUseId?: string | null;
  /** agentId of the subagent that spawned this one (nested trees); null at depth 1. */
  parentAgentId?: string | null;
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
    /** USD cost, when the runtime reports a per-subagent figure (OpenCode). */
    costUsd?: number;
  };
};

function compareIsoDesc(left: string, right: string): number {
  return Date.parse(right) - Date.parse(left);
}

/**
 * Visual nesting depth for a subagent row: the number of ancestors, reached via
 * `parentAgentId`, that are present in `snapshots` — capped at `cap` (default 3).
 * Depth 0 = top-level (no known parent). Pure; cycle-guarded.
 */
export function subagentTreeDepth(
  snapshot: ChatSubagentSnapshot,
  snapshots: ChatSubagentSnapshot[],
  cap = 3,
): number {
  const byAgentId = new Map<string, ChatSubagentSnapshot>();
  for (const candidate of snapshots) {
    if (candidate.agentId) byAgentId.set(candidate.agentId, candidate);
  }
  const seen = new Set<string>();
  let depth = 0;
  let current: ChatSubagentSnapshot | undefined = snapshot;
  while (current?.parentAgentId && depth < cap) {
    const id = current.agentId ?? current.taskId;
    if (seen.has(id)) break; // cycle guard
    seen.add(id);
    const parent = byAgentId.get(current.parentAgentId);
    if (!parent || parent === current) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

type ChatSubagentEvent = NormalizedSubagentLifecycleEvent;

function subagentIdentityKey(event: ChatSubagentEvent): string {
  return event.agentId ?? event.taskId;
}

function subagentParentKey(event: ChatSubagentEvent): string | null {
  return event.parentToolUseId ?? event.parentAgentId ?? null;
}

function buildResolvedSubagentKeysByParent(events: AgentChatEventEnvelope[]): Map<string, Set<string>> {
  const keysByParent = new Map<string, Set<string>>();
  for (const envelope of events) {
    const event = normalizeSubagentLifecycleEvent(envelope.event);
    if (!event) continue;
    const parentKey = subagentParentKey(event);
    if (!parentKey) continue;
    const key = subagentIdentityKey(event);
    if (key === parentKey) continue;
    const keys = keysByParent.get(parentKey) ?? new Set<string>();
    keys.add(key);
    keysByParent.set(parentKey, keys);
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
  const parentKey = subagentParentKey(event);
  const parentPlaceholder = parentKey ? snapshots.get(parentKey) : undefined;
  const parentResolvedKeys = parentKey ? resolvedKeysByParent.get(parentKey) : undefined;
  const canAdoptParentPlaceholder = Boolean(
    parentKey
      && parentPlaceholder
      && isParentPlaceholder(parentPlaceholder, parentKey)
      && parentResolvedKeys?.size === 1
      && parentResolvedKeys.has(key),
  );
  const taskAliasCandidate = key !== event.taskId ? snapshots.get(event.taskId) : undefined;
  const taskAliasIsParentPlaceholder = Boolean(
    taskAliasCandidate
      && parentKey
      && event.taskId === parentKey
      && isParentPlaceholder(taskAliasCandidate, parentKey),
  );
  const taskAlias = taskAliasCandidate && (!taskAliasIsParentPlaceholder || canAdoptParentPlaceholder)
    ? taskAliasCandidate
    : undefined;
  const adoptParentPlaceholder = !taskAlias && canAdoptParentPlaceholder ? parentPlaceholder : undefined;
  const adoptedPlaceholder = Boolean(adoptParentPlaceholder || (taskAlias && taskAliasIsParentPlaceholder));

  if (taskAlias && key !== event.taskId) snapshots.delete(event.taskId);
  if (adoptParentPlaceholder && parentKey) {
    snapshots.delete(parentKey);
  } else if (
    parentKey
    && parentPlaceholder
    && isParentPlaceholder(parentPlaceholder, parentKey)
    && parentResolvedKeys
    && parentResolvedKeys.size > 1
  ) {
    snapshots.delete(parentKey);
  }

  return {
    key,
    existing: direct ?? taskAlias ?? adoptParentPlaceholder,
    adoptedPlaceholder,
  };
}

export function deriveChatSubagentSnapshots(events: AgentChatEventEnvelope[]): ChatSubagentSnapshot[] {
  const snapshots = new Map<string, ChatSubagentSnapshot>();
  const resolvedKeysByParent = buildResolvedSubagentKeysByParent(events);

  for (const envelope of events) {
    const event = normalizeSubagentLifecycleEvent(envelope.event);
    if (!event) continue;
    if (event.type === "subagent_started") {
      const { key, existing } = resolveSubagentSnapshot(snapshots, event, resolvedKeysByParent);
      snapshots.set(key, {
        taskId: event.taskId,
        agentId: event.agentId ?? existing?.agentId,
        agentType: event.agentType ?? existing?.agentType,
        label: event.label?.trim() || existing?.label,
        model: event.model?.trim() || existing?.model,
        reasoningEffort: event.reasoningEffort?.trim() || existing?.reasoningEffort,
        parentToolUseId: subagentParentKey(event) ?? existing?.parentToolUseId ?? null,
        parentAgentId: event.parentAgentId ?? existing?.parentAgentId ?? null,
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
        label: event.label?.trim() || existing?.label,
        model: event.model?.trim() || existing?.model,
        reasoningEffort: event.reasoningEffort?.trim() || existing?.reasoningEffort,
        parentToolUseId: subagentParentKey(event) ?? existing?.parentToolUseId ?? null,
        parentAgentId: event.parentAgentId ?? existing?.parentAgentId ?? null,
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
        label: event.label?.trim() || existing?.label,
        model: event.model?.trim() || existing?.model,
        reasoningEffort: event.reasoningEffort?.trim() || existing?.reasoningEffort,
        parentToolUseId: subagentParentKey(event) ?? existing?.parentToolUseId ?? null,
        parentAgentId: event.parentAgentId ?? existing?.parentAgentId ?? null,
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

  // Stable order: newest-spawned subagent at the top, and it stays put. Sorting
  // on startedAt (fixed at spawn) — NOT updatedAt/status — keeps the list from
  // reshuffling every time a tool result streams in from any subagent.
  return [...snapshots.values()].sort((left, right) => compareIsoDesc(left.startedAt, right.startedAt));
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
    const event = normalizeSubagentLifecycleEvent(envelope.event);
    if (!event) continue;
    if (event.type === "subagent_started" && (event.taskId === taskId || event.agentId === taskId)) {
      entries.push({
        timestamp: envelope.timestamp,
        type: "started",
        summary: null,
        lastToolName: null,
        status: null,
      });
    } else if (event.type === "subagent_progress" && (event.taskId === taskId || event.agentId === taskId)) {
      entries.push({
        timestamp: envelope.timestamp,
        type: "progress",
        summary: event.summary?.trim() ?? null,
        lastToolName: event.lastToolName ?? null,
        status: null,
      });
    } else if (event.type === "subagent_result" && (event.taskId === taskId || event.agentId === taskId)) {
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
