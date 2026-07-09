import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
  AgentChatSubagentTranscriptMessage,
} from "./types/chat";

export type SubagentSnapshot = {
  id: string;
  name: string;
  kind: "subagent" | "teammate";
  status: "running" | "completed" | "failed" | "stopped";
  summary: string;
  parentToolUseId?: string | null;
  turnId?: string | null;
  label?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  background?: boolean;
  taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
  workflowName?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  tokens?: number;
  /** Tool invocations the subagent made (Codex/OpenCode report this). */
  toolUses?: number;
  /** USD cost when the runtime reports a per-subagent figure (OpenCode). */
  costUsd?: number;
  durationMs?: number;
  lastToolName?: string;
};

const SUBAGENT_TASK_TYPES = new Set<NonNullable<SubagentSnapshot["taskType"]>>([
  "subagent",
  "background",
  "local_workflow",
  "cron",
  "other",
]);

function normalizeSubagentTaskType(value: unknown): SubagentSnapshot["taskType"] | undefined {
  return typeof value === "string" && SUBAGENT_TASK_TYPES.has(value as NonNullable<SubagentSnapshot["taskType"]>)
    ? value as SubagentSnapshot["taskType"]
    : undefined;
}

export type ChatInfoPlanStep = {
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export type ChatInfoPlan = {
  current: number;
  total: number;
  steps: ChatInfoPlanStep[];
  live: boolean;
} | null;

export type SubagentPaneSection = "main" | "subagents" | "teammates" | "background";

export type SubagentPaneRow =
  | { kind: "main"; key: "main"; section: "main"; label: string }
  | { kind: "snapshot"; key: string; section: Exclude<SubagentPaneSection, "main">; snapshot: SubagentSnapshot };

export type SubagentPaneContent = {
  snapshots: SubagentSnapshot[];
};

// Vertical offset of the first selectable roster row in the rendered chat-info
// pane (header + status + plan + goal occupy the preceding lines). Used only by
// the mouse-click → row mapper.
const SUBAGENT_PANE_TABLE_START_LINE = 4;

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function subagentAgentKey(event: { agentId?: string | null; taskId?: string | null }): string | null {
  return textField(event.agentId) ?? textField(event.taskId);
}

export const SUBAGENT_PLACEHOLDER_SUMMARY = /^(status:\s|task updated$)/i;

export function preferSubagentSummary(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const current = textField(existing);
  const next = textField(incoming);
  if (!current) return next;
  if (!next) return current;

  const currentIsPlaceholder = SUBAGENT_PLACEHOLDER_SUMMARY.test(current);
  const nextIsPlaceholder = SUBAGENT_PLACEHOLDER_SUMMARY.test(next);
  if (currentIsPlaceholder !== nextIsPlaceholder) {
    return currentIsPlaceholder ? next : current;
  }
  if (currentIsPlaceholder) return next;
  return next.length >= current.length ? next : current;
}

type SubagentClassificationInput = {
  taskType?: string | null;
  agentType?: string | null;
  command?: string | null;
  description?: string | null;
};

export function isBackgroundShellCommand(input: SubagentClassificationInput): boolean {
  const taskType = textField(input.taskType);
  const agentType = textField(input.agentType);
  return taskType === "background" && (!agentType || agentType === "background");
}

export function isRealSubagent(input: SubagentClassificationInput): boolean {
  if (isBackgroundShellCommand(input)) return false;
  const taskType = textField(input.taskType);
  const agentType = textField(input.agentType);
  return Boolean(
    (agentType && agentType !== "background")
      || taskType === "subagent"
      || taskType === "local_workflow",
  );
}

type SubagentTimelineStatus = "running" | "completed" | "stopped" | "failed";
type SubagentTimelineTerminalStatus = Exclude<SubagentTimelineStatus, "running">;

export type SubagentTimelineRow =
  | {
      kind: "spawn";
      agentKey: string;
      description: string;
      agentType: string | null;
      background: boolean;
      status: SubagentTimelineStatus;
      statusLine: string | null;
      lastToolName: string | null;
      toolCount: number | null;
      startedAtEventIndex: number;
    }
  | {
      kind: "result";
      agentKey: string;
      status: SubagentTimelineTerminalStatus;
      summary: string | null;
      resultAtEventIndex: number;
    }
  | {
      kind: "background_chip";
      agentKey: string;
      label: string;
      status: SubagentTimelineTerminalStatus;
      settledAtEventIndex: number;
    };

type SubagentTimelineSpawnRow = Extract<SubagentTimelineRow, { kind: "spawn" }>;
type SubagentTimelineResultRow = Extract<SubagentTimelineRow, { kind: "result" }>;
type SubagentTimelineBackgroundRow = Extract<SubagentTimelineRow, { kind: "background_chip" }>;

type SubagentTimelineState = {
  agentKey: string;
  aliases: Set<string>;
  firstSeenEventIndex: number;
  firstLifecycleEventIndex: number | null;
  description: string | null;
  agentType: string | null;
  taskType: string | null;
  command: string | null;
  background: boolean;
  progressSummary: string | null;
  lastProgressEventIndex: number;
  lastResultEventIndex: number;
  lastSettledEventIndex: number;
  spawn: SubagentTimelineSpawnRow | null;
  result: SubagentTimelineResultRow | null;
  backgroundChip: SubagentTimelineBackgroundRow | null;
};

function longerText(existing: string | null, incoming: string | null): string | null {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return incoming.length > existing.length ? incoming : existing;
}

function preferredAgentType(existing: string | null, incoming: string | null): string | null {
  if (!incoming) return existing;
  if (!existing || (existing === "background" && incoming !== "background")) return incoming;
  return existing;
}

function removeTimelineRow(rows: SubagentTimelineRow[], row: SubagentTimelineRow | null): void {
  if (!row) return;
  const index = rows.indexOf(row);
  if (index >= 0) rows.splice(index, 1);
}

export function deriveSubagentTimelineRows(events: AgentChatEvent[]): SubagentTimelineRow[] {
  const rows: SubagentTimelineRow[] = [];
  const statesByAlias = new Map<string, SubagentTimelineState>();

  const setAgentKey = (state: SubagentTimelineState, agentKey: string): void => {
    state.agentKey = agentKey;
    if (state.spawn) state.spawn.agentKey = agentKey;
    if (state.result) state.result.agentKey = agentKey;
    if (state.backgroundChip) state.backgroundChip.agentKey = agentKey;
  };

  const mergeStates = (
    left: SubagentTimelineState,
    right: SubagentTimelineState,
  ): SubagentTimelineState => {
    if (left === right) return left;
    const primary = left.firstSeenEventIndex <= right.firstSeenEventIndex ? left : right;
    const secondary = primary === left ? right : left;
    primary.firstSeenEventIndex = Math.min(primary.firstSeenEventIndex, secondary.firstSeenEventIndex);
    if (secondary.firstLifecycleEventIndex != null) {
      primary.firstLifecycleEventIndex = primary.firstLifecycleEventIndex == null
        ? secondary.firstLifecycleEventIndex
        : Math.min(primary.firstLifecycleEventIndex, secondary.firstLifecycleEventIndex);
    }
    primary.description = longerText(primary.description, secondary.description);
    primary.agentType = preferredAgentType(primary.agentType, secondary.agentType);
    primary.taskType = primary.taskType ?? secondary.taskType;
    primary.command = longerText(primary.command, secondary.command);
    primary.background = primary.background || secondary.background;
    primary.progressSummary = preferSubagentSummary(primary.progressSummary, secondary.progressSummary);

    if (!primary.spawn && secondary.spawn) {
      primary.spawn = secondary.spawn;
    } else if (primary.spawn && secondary.spawn) {
      primary.spawn.description = longerText(primary.spawn.description, secondary.spawn.description) ?? "Subagent task";
      primary.spawn.agentType = preferredAgentType(primary.spawn.agentType, secondary.spawn.agentType);
      primary.spawn.background = primary.spawn.background || secondary.spawn.background;
      primary.spawn.startedAtEventIndex = Math.min(
        primary.spawn.startedAtEventIndex,
        secondary.spawn.startedAtEventIndex,
      );
      if (secondary.lastProgressEventIndex > primary.lastProgressEventIndex) {
        primary.spawn.lastToolName = secondary.spawn.lastToolName;
        primary.spawn.toolCount = secondary.spawn.toolCount;
      }
      removeTimelineRow(rows, secondary.spawn);
    }
    if (!primary.result && secondary.result) {
      primary.result = secondary.result;
    } else if (primary.result && secondary.result) {
      primary.result.summary = preferSubagentSummary(primary.result.summary, secondary.result.summary);
      primary.result.resultAtEventIndex = Math.min(
        primary.result.resultAtEventIndex,
        secondary.result.resultAtEventIndex,
      );
      if (secondary.lastResultEventIndex > primary.lastResultEventIndex) {
        primary.result.status = secondary.result.status;
      }
      removeTimelineRow(rows, secondary.result);
    }
    if (!primary.backgroundChip && secondary.backgroundChip) {
      primary.backgroundChip = secondary.backgroundChip;
    } else if (primary.backgroundChip && secondary.backgroundChip) {
      primary.backgroundChip.label = longerText(
        primary.backgroundChip.label,
        secondary.backgroundChip.label,
      ) ?? "Background command";
      primary.backgroundChip.settledAtEventIndex = Math.min(
        primary.backgroundChip.settledAtEventIndex,
        secondary.backgroundChip.settledAtEventIndex,
      );
      if (secondary.lastSettledEventIndex > primary.lastSettledEventIndex) {
        primary.backgroundChip.status = secondary.backgroundChip.status;
      }
      removeTimelineRow(rows, secondary.backgroundChip);
    }

    primary.lastProgressEventIndex = Math.max(primary.lastProgressEventIndex, secondary.lastProgressEventIndex);
    primary.lastResultEventIndex = Math.max(primary.lastResultEventIndex, secondary.lastResultEventIndex);
    primary.lastSettledEventIndex = Math.max(primary.lastSettledEventIndex, secondary.lastSettledEventIndex);
    for (const alias of secondary.aliases) {
      primary.aliases.add(alias);
      statesByAlias.set(alias, primary);
    }
    setAgentKey(primary, primary.agentKey);
    return primary;
  };

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const originalEvent = events[eventIndex]!;
    const event = normalizeSubagentLifecycleEvent(originalEvent);
    if (!event) continue;

    const taskId = textField(event.taskId);
    const agentId = textField(event.agentId);
    const initialKey = subagentAgentKey(event);
    if (!initialKey) continue;

    const taskState = taskId ? statesByAlias.get(taskId) : undefined;
    const agentState = agentId ? statesByAlias.get(agentId) : undefined;
    let state = taskState && agentState && taskState !== agentState
      ? mergeStates(taskState, agentState)
      : agentState ?? taskState;
    if (!state) {
      state = {
        agentKey: initialKey,
        aliases: new Set(),
        firstSeenEventIndex: eventIndex,
        firstLifecycleEventIndex: null,
        description: null,
        agentType: null,
        taskType: null,
        command: null,
        background: false,
        progressSummary: null,
        lastProgressEventIndex: -1,
        lastResultEventIndex: -1,
        lastSettledEventIndex: -1,
        spawn: null,
        result: null,
        backgroundChip: null,
      };
    }

    for (const alias of [taskId, agentId]) {
      if (!alias) continue;
      state.aliases.add(alias);
      statesByAlias.set(alias, state);
    }
    if (agentId) setAgentKey(state, agentId);

    const lifecycleRecord = event as NormalizedSubagentLifecycleEvent & {
      background?: unknown;
      description?: unknown;
    };
    const eventRecord = originalEvent as AgentChatEvent & { command?: unknown; description?: unknown };
    state.description = longerText(
      state.description,
      textField(lifecycleRecord.description ?? eventRecord.description),
    );
    state.agentType = preferredAgentType(state.agentType, textField(event.agentType));
    state.taskType = textField(event.taskType) ?? state.taskType;
    state.command = longerText(state.command, textField(eventRecord.command));
    state.background = state.background || lifecycleRecord.background === true;

    const backgroundShell = isBackgroundShellCommand(state);
    const realSubagent = isRealSubagent(state);
    if (backgroundShell) {
      removeTimelineRow(rows, state.spawn);
      removeTimelineRow(rows, state.result);
      state.spawn = null;
      state.result = null;
    }

    if (event.type === "subagent_started" || event.type === "subagent_progress") {
      state.firstLifecycleEventIndex ??= eventIndex;
      if (!realSubagent) continue;
      if (!state.spawn) {
        state.spawn = {
          kind: "spawn",
          agentKey: state.agentKey,
          description: state.description ?? "Subagent task",
          agentType: state.agentType,
          background: state.background,
          status: state.result?.status ?? "running",
          statusLine: state.description ?? null,
          lastToolName: null,
          toolCount: null,
          startedAtEventIndex: state.firstLifecycleEventIndex,
        };
        rows.push(state.spawn);
      } else {
        state.spawn.description = state.description ?? state.spawn.description;
        state.spawn.agentType = state.agentType ?? state.spawn.agentType;
        state.spawn.background = state.spawn.background || state.background;
      }

      if (event.type === "subagent_progress") {
        state.lastProgressEventIndex = eventIndex;
        state.spawn.status = "running";
        state.progressSummary = preferSubagentSummary(state.progressSummary, event.summary);
        const lastToolName = textField(event.lastToolName);
        if (lastToolName) state.spawn.lastToolName = lastToolName;
        if (typeof event.usage?.toolUses === "number") state.spawn.toolCount = event.usage.toolUses;
        const meaningfulSummary = state.progressSummary
          && !SUBAGENT_PLACEHOLDER_SUMMARY.test(state.progressSummary)
          ? state.progressSummary
          : null;
        state.spawn.statusLine = meaningfulSummary
          ?? state.spawn.lastToolName
          ?? state.spawn.description;
      } else if (!state.progressSummary) {
        state.spawn.statusLine = state.spawn.lastToolName ?? state.spawn.description;
      }
      continue;
    }

    const incomingSummary = preferSubagentSummary(event.summary, event.finalSummary);
    if (backgroundShell) {
      const label = state.command ?? state.description ?? "Background command";
      if (!state.backgroundChip) {
        state.backgroundChip = {
          kind: "background_chip",
          agentKey: state.agentKey,
          label,
          status: event.status,
          settledAtEventIndex: eventIndex,
        };
        rows.push(state.backgroundChip);
      } else {
        state.backgroundChip.label = longerText(state.backgroundChip.label, label) ?? "Background command";
        state.backgroundChip.status = event.status;
      }
      state.lastSettledEventIndex = eventIndex;
      continue;
    }
    if (!realSubagent) continue;

    if (!state.result) {
      state.result = {
        kind: "result",
        agentKey: state.agentKey,
        status: event.status,
        summary: incomingSummary,
        resultAtEventIndex: eventIndex,
      };
      rows.push(state.result);
    } else {
      state.result.summary = preferSubagentSummary(state.result.summary, incomingSummary);
      state.result.status = event.status;
    }
    state.lastResultEventIndex = eventIndex;
    if (state.spawn) state.spawn.status = event.status;
  }

  return rows;
}

function eventType(event: AgentChatEvent): string {
  return String((event as { type?: unknown }).type ?? "");
}

function eventSubagentIds(event: AgentChatEvent): string[] {
  const record = event as { taskId?: unknown; agentId?: unknown };
  const ids = [
    textField(record.taskId),
    textField(record.agentId),
  ].filter((value): value is string => value != null);
  return [...new Set(ids)];
}

function eventParentToolUseId(event: AgentChatEvent): string | null {
  return textField((event as { parentToolUseId?: unknown }).parentToolUseId)
    ?? textField((event as { parentAgentId?: unknown }).parentAgentId);
}

export type NormalizedSubagentLifecycleEvent = Extract<
  AgentChatEvent,
  { type: "subagent_started" | "subagent_progress" | "subagent_result" }
>;

export function normalizeSubagentLifecycleEvent(event: AgentChatEvent): NormalizedSubagentLifecycleEvent | null {
  if (
    event.type === "subagent_started"
    || event.type === "subagent_progress"
    || event.type === "subagent_result"
  ) {
    return event;
  }

  if (event.type === "subagent.started") {
    const agentId = textField(event.agentId);
    if (!agentId) return null;
    return {
      type: "subagent_started",
      taskId: agentId,
      agentId,
      parentToolUseId: textField(event.parentToolUseId),
      agentType: event.agentType,
      model: textField(event.model),
      reasoningEffort: textField(event.reasoningEffort),
      label: textField(event.label),
      description: textField(event.description) ?? "Subagent task",
      background: event.background,
      turnId: event.turnId,
    };
  }

  if (event.type === "subagent.progress") {
    const agentId = textField(event.agentId);
    if (!agentId) return null;
    return {
      type: "subagent_progress",
      taskId: agentId,
      agentId,
      parentToolUseId: textField(event.parentToolUseId),
      agentType: event.agentType,
      model: textField(event.model),
      reasoningEffort: textField(event.reasoningEffort),
      label: textField(event.label),
      summary: textField(event.text) ?? textField(event.lastToolName) ?? "Running",
      ...(typeof event.tokens === "number" ? { usage: { totalTokens: event.tokens } } : {}),
      lastToolName: event.lastToolName,
      turnId: event.turnId,
    };
  }

  if (event.type === "subagent.completed") {
    const agentId = textField(event.agentId);
    if (!agentId) return null;
    return {
      type: "subagent_result",
      taskId: agentId,
      agentId,
      parentToolUseId: textField(event.parentToolUseId),
      agentType: event.agentType,
      model: textField(event.model),
      reasoningEffort: textField(event.reasoningEffort),
      label: textField(event.label),
      status: event.status ?? "completed",
      summary: textField(event.summary) ?? "Completed",
      usage: event.usage,
      turnId: event.turnId,
    };
  }

  return null;
}

export function workEventItemId(event: AgentChatEvent): string | null {
  if (event.type !== "tool_call" && event.type !== "tool_result" && event.type !== "command" && event.type !== "file_change") {
    return null;
  }
  return textField((event as { itemId?: unknown }).itemId);
}

export function workEventParentItemId(event: AgentChatEvent): string | null {
  if (event.type !== "tool_call" && event.type !== "tool_result") {
    return null;
  }
  return textField((event as { parentItemId?: unknown }).parentItemId);
}

export function planFromEvent(event: Extract<AgentChatEvent, { type: "plan" }>): ChatInfoPlan {
  const completed = event.steps.filter((step) => step.status === "completed").length;
  const inProgress = event.steps.findIndex((step) => step.status === "in_progress");
  const current = inProgress >= 0 ? inProgress + 1 : completed;
  return {
    current,
    total: event.steps.length,
    steps: event.steps.map((step) => ({ text: step.text, status: step.status })),
    live: event.steps.some((step) => step.status === "in_progress"),
  };
}

export function latestPlan(events: AgentChatEventEnvelope[]): ChatInfoPlan {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "plan") return planFromEvent(event);
  }
  return null;
}

function buildResolvedSubagentIdsByParent(events: AgentChatEventEnvelope[]): Map<string, Set<string>> {
  const idsByParent = new Map<string, Set<string>>();
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (!type.startsWith("subagent")) continue;
    const parent = textField(event.parentToolUseId) ?? textField(event.parentAgentId);
    if (!parent) continue;
    const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
    const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
    const id = agentId ?? taskId;
    if (!id || id === parent) continue;
    const ids = idsByParent.get(parent) ?? new Set<string>();
    ids.add(id);
    idsByParent.set(parent, ids);
  }
  return idsByParent;
}

function isParentSubagentPlaceholder(snapshot: SubagentSnapshot | undefined, parentToolUseId: string): snapshot is SubagentSnapshot {
  return Boolean(
    snapshot
      && snapshot.id === parentToolUseId
      && snapshot.parentToolUseId === parentToolUseId,
  );
}

export function subagentSnapshotsFromEvents(events: AgentChatEventEnvelope[]): SubagentSnapshot[] {
  const snapshots = new Map<string, SubagentSnapshot>();
  const terminalTurnIds = new Set<string>();
  const resolvedIdsByParent = buildResolvedSubagentIdsByParent(events);

  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const turnId = typeof event.turnId === "string" ? event.turnId : null;
    if (!turnId) continue;
    const isDone = event.type === "done";
    const isTerminalStatus = event.type === "status" && event.turnStatus !== "started";
    if (isDone || isTerminalStatus) terminalTurnIds.add(turnId);
  }

  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "teammate.idle") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      if (!teammateName) continue;
      const id = `teammate:${teamName}:${teammateName}`;
      const existing = snapshots.get(id);
      snapshots.set(id, {
        id,
        name: teamName ? `${teamName}/${teammateName}` : teammateName,
        kind: "teammate",
        status: "running",
        summary: existing?.summary ?? "idle",
        turnId: typeof event.turnId === "string" ? event.turnId : existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        tokens: existing?.tokens,
      durationMs: existing?.durationMs,
      lastToolName: existing?.lastToolName,
      label: existing?.label,
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
    });
      continue;
    }

    if (type === "task.completed") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      const subject = typeof event.subject === "string" ? event.subject : "";
      if (!teammateName) continue;
      const id = `teammate:${teamName}:${teammateName}`;
      const existing = snapshots.get(id);
      snapshots.set(id, {
        id,
        name: existing?.name ?? (teamName ? `${teamName}/${teammateName}` : teammateName),
        kind: "teammate",
        status: "completed",
        summary: subject || existing?.summary || "",
        turnId: typeof event.turnId === "string" ? event.turnId : existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        endedAt: envelope.timestamp,
        tokens: existing?.tokens,
      durationMs: existing?.durationMs,
      lastToolName: existing?.lastToolName,
      label: existing?.label,
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
    });
      continue;
    }

    if (!type.startsWith("subagent")) continue;
    const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
    const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
    const id = agentId ?? taskId;
    if (!id) continue;
    const incomingParentToolUseId = textField(event.parentToolUseId) ?? textField(event.parentAgentId);
    const parentPlaceholder = incomingParentToolUseId ? snapshots.get(incomingParentToolUseId) : undefined;
    const parentResolvedIds = incomingParentToolUseId ? resolvedIdsByParent.get(incomingParentToolUseId) : undefined;
    const parentIsPlaceholder = Boolean(
      incomingParentToolUseId
        && isParentSubagentPlaceholder(parentPlaceholder, incomingParentToolUseId),
    );
    const canAdoptParentPlaceholder = parentIsPlaceholder
      && parentResolvedIds?.size === 1
      && parentResolvedIds.has(id);
    const taskAlias = taskId && taskId !== id ? snapshots.get(taskId) : undefined;
    const existing = snapshots.get(id) ?? taskAlias ?? (canAdoptParentPlaceholder ? parentPlaceholder : undefined);
    if (taskId && id !== taskId) snapshots.delete(taskId);
    if (
      incomingParentToolUseId
      && parentIsPlaceholder
      && (canAdoptParentPlaceholder || (parentResolvedIds && parentResolvedIds.size > 1))
    ) {
      snapshots.delete(incomingParentToolUseId);
    }
    const agentType = typeof event.agentType === "string" ? event.agentType : "subagent";
    const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : {};
    const parentToolUseId = incomingParentToolUseId ?? existing?.parentToolUseId ?? null;
    const startedAt = existing?.startedAt ?? envelope.timestamp;
    const endedAt = type === "subagent_result" || type === "subagent.completed" ? envelope.timestamp : existing?.endedAt;
    const parsedDurationMs = endedAt && startedAt ? Date.parse(endedAt) - Date.parse(startedAt) : Number.NaN;
    const fallbackDurationMs = Number.isFinite(parsedDurationMs) ? Math.max(0, parsedDurationMs) : existing?.durationMs;
    const summaryFromEvent = [event.summary, event.finalSummary, event.text, event.description]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const summary = summaryFromEvent ?? existing?.summary ?? "";
    const incomingTaskType = normalizeSubagentTaskType(event.taskType);
    const existingTaskType = normalizeSubagentTaskType(existing?.taskType);
    const incomingWorkflowName = typeof event.workflowName === "string" && event.workflowName.trim().length
      ? event.workflowName.trim()
      : undefined;
    const base: SubagentSnapshot = {
      id,
      name: typeof event.description === "string" ? event.description : existing?.name ?? agentType,
      kind: "subagent",
      status: existing?.status ?? "running",
      summary,
      parentToolUseId,
      turnId: typeof event.turnId === "string" ? event.turnId : existing?.turnId ?? null,
      label: typeof event.label === "string" ? event.label : existing?.label ?? null,
      model: typeof event.model === "string" ? event.model : existing?.model ?? null,
      reasoningEffort: typeof event.reasoningEffort === "string" ? event.reasoningEffort : existing?.reasoningEffort ?? null,
      background: event.background === true || existing?.background === true,
      ...(incomingTaskType || existingTaskType
        ? { taskType: incomingTaskType ?? existingTaskType }
        : {}),
      ...(incomingWorkflowName || existing?.workflowName
        ? { workflowName: incomingWorkflowName ?? existing?.workflowName }
        : {}),
      startedAt,
      endedAt,
      tokens: typeof usage.totalTokens === "number" ? usage.totalTokens : typeof event.tokens === "number" ? event.tokens : existing?.tokens,
      toolUses: typeof usage.toolUses === "number" ? usage.toolUses : existing?.toolUses,
      costUsd: typeof usage.costUsd === "number" ? usage.costUsd : existing?.costUsd,
      durationMs: typeof usage.durationMs === "number" ? usage.durationMs : fallbackDurationMs,
      lastToolName: typeof event.lastToolName === "string" ? event.lastToolName : existing?.lastToolName,
    };
    if (type === "subagent_result" || type === "subagent.completed") {
      const status = event.status === "failed" || event.status === "stopped" || event.status === "completed" ? event.status : "completed";
      snapshots.set(id, { ...base, status });
    } else {
      snapshots.set(id, { ...base, status: "running" });
    }
  }

  for (const [key, snapshot] of snapshots) {
    if (
      snapshot.kind === "subagent"
      && snapshot.status === "running"
      && snapshot.background !== true
      && snapshot.turnId
      && terminalTurnIds.has(snapshot.turnId)
    ) {
      const terminalSummary = "Parent turn ended before ADE received a final subagent status";
      snapshots.set(key, {
        ...snapshot,
        status: "stopped",
        summary: snapshot.summary && snapshot.summary !== snapshot.name ? snapshot.summary : terminalSummary,
      });
    }
  }

  return [...snapshots.values()];
}

export function subagentActivitySummaryFromEvents(events: AgentChatEventEnvelope[]): { totalCount: number; runningCount: number } {
  const snapshots = new Map<string, Pick<SubagentSnapshot, "status" | "kind" | "background" | "turnId">>();
  const terminalTurnIds = new Set<string>();

  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    const turnId = typeof event.turnId === "string" ? event.turnId : null;
    if (turnId && (type === "done" || (type === "status" && event.turnStatus !== "started"))) {
      terminalTurnIds.add(turnId);
    }

    if (type === "teammate.idle") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      if (!teammateName) continue;
      snapshots.set(`teammate:${teamName}:${teammateName}`, {
        kind: "teammate",
        status: "running",
        turnId,
      });
      continue;
    }

    if (type === "task.completed") {
      const teamName = typeof event.teamName === "string" ? event.teamName : "";
      const teammateName = typeof event.teammateName === "string" ? event.teammateName : "";
      if (!teammateName) continue;
      snapshots.set(`teammate:${teamName}:${teammateName}`, {
        kind: "teammate",
        status: "completed",
        turnId,
      });
      continue;
    }

    if (!type.startsWith("subagent")) continue;
    const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
    const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
    const id = agentId ?? taskId;
    if (!id) continue;
    if (taskId && id !== taskId) snapshots.delete(taskId);
    const status = type === "subagent_result" || type === "subagent.completed"
      ? event.status === "failed" || event.status === "stopped" || event.status === "completed"
        ? event.status
        : "completed"
      : "running";
    snapshots.set(id, {
      kind: "subagent",
      status,
      background: event.background === true,
      turnId,
    });
  }

  let runningCount = 0;
  for (const [id, snapshot] of snapshots) {
    let status = snapshot.status;
    if (
      snapshot.kind === "subagent"
      && status === "running"
      && snapshot.background !== true
      && snapshot.turnId
      && terminalTurnIds.has(snapshot.turnId)
    ) {
      status = "stopped";
      snapshots.set(id, { ...snapshot, status });
    }
    if (status === "running") runningCount += 1;
  }
  return { totalCount: snapshots.size, runningCount };
}

export function buildSubagentPaneRows(content: SubagentPaneContent): SubagentPaneRow[] {
  const foregroundSubagents = content.snapshots.filter((snap) => (
    snap.kind === "subagent"
    && snap.background !== true
  ));
  const runningWeight = (snap: SubagentSnapshot): number => (snap.status === "running" ? 0 : 1);
  const sortedForegroundSubagents = [...foregroundSubagents].sort(
    (left, right) => runningWeight(left) - runningWeight(right),
  );
  const teammates = content.snapshots.filter((snap) => snap.kind === "teammate");
  const background = content.snapshots.filter((snap) => snap.kind === "subagent" && snap.background === true);

  return [
    { kind: "main", key: "main", section: "main", label: "main" },
    ...sortedForegroundSubagents.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "subagents" as const, snapshot })),
    ...teammates.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "teammates" as const, snapshot })),
    ...background.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "background" as const, snapshot })),
  ];
}

export function selectedSubagentSnapshot(
  content: SubagentPaneContent,
  selectedIndex: number,
): SubagentSnapshot | null {
  const row = buildSubagentPaneRows(content)[selectedIndex] ?? null;
  return row?.kind === "snapshot" ? row.snapshot : null;
}

export function subagentPaneSelectableLineOffsets(
  content: SubagentPaneContent,
  selectedIndex = 0,
): number[] {
  const rows = buildSubagentPaneRows(content);
  const offsets: number[] = [];
  let line = SUBAGENT_PANE_TABLE_START_LINE;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const previous = rows[index - 1];
    const showSection = row.section !== "main" && previous?.section !== row.section;
    if (showSection) line += 2;
    offsets.push(line);
    line += 1;
    const selectedSnapshotHasDetail = row.kind === "snapshot"
      && index === selectedIndex
      && (row.snapshot.lastToolName || row.snapshot.summary);
    if (row.kind === "main" || selectedSnapshotHasDetail) {
      line += 1;
    }
  }

  return offsets;
}

export function subagentIndexForPaneLine(
  content: SubagentPaneContent,
  line: number,
  selectedIndex = 0,
): number | null {
  if (!Number.isFinite(line)) return null;
  const offsets = subagentPaneSelectableLineOffsets(content, selectedIndex);
  if (!offsets.length) return null;
  const first = offsets[0]!;
  const last = offsets[offsets.length - 1]!;
  if (line < first - 1 || line > last + 1) return null;

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < offsets.length; index += 1) {
    const distance = Math.abs(line - offsets[index]!);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

export function isLifecycleEventForSnapshot(event: AgentChatEvent, snapshot: SubagentSnapshot): boolean {
  const type = eventType(event);
  if (snapshot.kind === "teammate") {
    if (type === "teammate.idle" || type === "task.completed") {
      const record = event as { teamName?: unknown; teammateName?: unknown };
      const teamName = textField(record.teamName) ?? "";
      const teammateName = textField(record.teammateName) ?? "";
      return snapshot.id === `teammate:${teamName}:${teammateName}`;
    }
    return false;
  }
  if (
    type !== "subagent_started"
    && type !== "subagent_progress"
    && type !== "subagent_result"
    && type !== "subagent.started"
    && type !== "subagent.progress"
    && type !== "subagent.completed"
  ) {
    return false;
  }
  const explicitIds = eventSubagentIds(event);
  if (explicitIds.length > 0) return explicitIds.includes(snapshot.id);
  const parentToolUseId = eventParentToolUseId(event);
  return Boolean(snapshot.parentToolUseId && parentToolUseId === snapshot.parentToolUseId);
}

function lifecycleText(event: AgentChatEvent, snapshot: SubagentSnapshot): string | null {
  const type = eventType(event);
  const record = event as {
    description?: unknown;
    summary?: unknown;
    finalSummary?: unknown;
    text?: unknown;
    subject?: unknown;
    status?: unknown;
  };
  if (type === "subagent_started" || type === "subagent.started") {
    return "Started.";
  }
  if (type === "subagent_progress" || type === "subagent.progress") {
    return textField(record.summary) ?? textField(record.text) ?? null;
  }
  if (type === "subagent_result" || type === "subagent.completed") {
    const status = textField(record.status) ?? snapshot.status;
    const summary = textField(record.finalSummary) ?? textField(record.summary) ?? snapshot.summary;
    return `${status}: ${summary || snapshot.name}`;
  }
  if (type === "teammate.idle") {
    return `Teammate idle: ${snapshot.name}`;
  }
  if (type === "task.completed") {
    return `completed: ${textField(record.subject) ?? snapshot.summary ?? snapshot.name}`;
  }
  return null;
}

function syntheticTextEvent(
  sessionId: string,
  timestamp: string,
  sequence: number,
  turnId: string | null | undefined,
  text: string,
  // Distinct per synthetic line. Without it, every synthetic transcript line
  // shares the snapshot turnId and no itemId, so the render-line coalescer fuses
  // them into one separator-less blob ("…Task: XStarted.", message runs jammed
  // together). A unique itemId keeps each line its own rendered paragraph.
  itemId?: string,
): AgentChatEventEnvelope {
  return {
    sessionId,
    timestamp,
    sequence,
    event: {
      type: "text",
      text,
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
    },
  };
}

export function buildSubagentTranscriptEvents(args: {
  events: AgentChatEventEnvelope[];
  activeSession: AgentChatSessionSummary | null;
  snapshot: SubagentSnapshot;
}): AgentChatEventEnvelope[] {
  const sessionId = args.activeSession?.sessionId ?? args.events[0]?.sessionId ?? "subagent";
  const parentToolUseId = textField(args.snapshot.parentToolUseId);
  const childItemIds = new Set<string>();

  if (parentToolUseId) {
    for (const envelope of args.events) {
      const event = envelope.event;
      const parentItemId = workEventParentItemId(event);
      const itemId = workEventItemId(event);
      if (parentItemId === parentToolUseId && itemId) {
        childItemIds.add(itemId);
      }
    }
  }

  let lineSeq = 0;
  const transcript: AgentChatEventEnvelope[] = [
    syntheticTextEvent(
      sessionId,
      args.snapshot.startedAt ?? args.events[0]?.timestamp ?? new Date(0).toISOString(),
      -2,
      args.snapshot.turnId,
      `Viewing ${args.snapshot.kind === "teammate" ? "teammate" : args.snapshot.background ? "background agent" : "agent"} transcript. Select Main chat in Chat Info to return.\nTask: ${args.snapshot.name}`,
      `subagent-line:${lineSeq++}`,
    ),
  ];

  for (const envelope of args.events) {
    const event = envelope.event;
    if (isLifecycleEventForSnapshot(event, args.snapshot)) {
      const text = lifecycleText(event, args.snapshot);
      if (text) {
        transcript.push(syntheticTextEvent(sessionId, envelope.timestamp, envelope.sequence ?? 0, args.snapshot.turnId, text, `subagent-line:${lineSeq++}`));
      }
      continue;
    }
    const parentItemId = workEventParentItemId(event);
    const itemId = workEventItemId(event);
    if (parentToolUseId && (parentItemId === parentToolUseId || (itemId != null && childItemIds.has(itemId)))) {
      transcript.push(envelope);
    }
  }

  if (transcript.length === 1) {
    transcript.push(syntheticTextEvent(
      sessionId,
      args.snapshot.endedAt ?? args.events.at(-1)?.timestamp ?? new Date(0).toISOString(),
      -1,
      args.snapshot.turnId,
      args.snapshot.summary || "No detailed transcript rows were recorded for this agent.",
      `subagent-line:${lineSeq++}`,
    ));
  }

  return transcript;
}

function transcriptRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transcriptEventField(event: AgentChatEvent, key: "itemId" | "messageId" | "turnId"): string | null {
  return textField((event as Record<string, unknown>)[key]);
}

// Stable per-source-message identity so the streamed chunks of one assistant
// message (Codex persists each delta as its own transcript row) carry the SAME
// messageId and the transcript coalescers fuse them back into one paragraph,
// instead of rendering one block (≈ one word) per chunk.
function stableTranscriptMessageId(
  event: AgentChatEvent,
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): string {
  const turnId = transcriptEventField(event, "turnId") ?? "no-turn";
  const itemId = transcriptEventField(event, "itemId")
    ?? transcriptEventField(event, "messageId")
    ?? message.uuid
    ?? String(index);
  return `subagent:${message.sessionId}:${turnId}:${itemId}:${event.type}`;
}

function normalizeTranscriptEvent(
  event: AgentChatEvent,
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): AgentChatEvent {
  if (event.type === "text" || event.type === "user_message") {
    return { ...event, messageId: event.messageId ?? stableTranscriptMessageId(event, message, index) };
  }
  // A Codex fileChange thread item fans out into one event per file, all
  // sharing the item's id; the transcript group dedupes by itemId, so suffix
  // the path to keep each file its own row (stable across refetches).
  if (event.type === "file_change") {
    return { ...event, itemId: `${event.itemId}:${event.path}` };
  }
  return event;
}

function claudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const record = transcriptRecord(block);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .filter((value) => value.length > 0)
      .join("\n");
  }
  return "";
}

/**
 * Expand an Anthropic/Claude message ({ role, content[, type:"message"] }) into
 * real transcript events — each content block (text / thinking / tool_use /
 * tool_result) becomes the matching chat event so tool calls render through the
 * same tool-line formatting as the main transcript (desktop parity:
 * expandClaudeTranscriptMessage in AgentChatPane).
 */
function expandClaudeTranscriptMessage(
  record: Record<string, unknown>,
  message: AgentChatSubagentTranscriptMessage,
): AgentChatEvent[] {
  const role = typeof record.role === "string" ? record.role : message.type;
  const content = record.content;
  const out: AgentChatEvent[] = [];
  const pushText = (value: string, id: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    out.push(role === "user"
      ? { type: "user_message", text: trimmed, messageId: id }
      : { type: "text", text: trimmed, messageId: id });
  };

  if (typeof content === "string") {
    pushText(content, message.uuid);
  } else if (Array.isArray(content)) {
    content.forEach((block, blockIndex) => {
      const b = transcriptRecord(block);
      if (!b) return;
      const blockType = typeof b.type === "string" ? b.type : "";
      const id = `${message.uuid}:${blockIndex}`;
      if (blockType === "text" && typeof b.text === "string") {
        pushText(b.text, id);
      } else if (blockType === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0) {
        out.push({ type: "reasoning", text: b.thinking, itemId: id });
      } else if (blockType === "tool_use") {
        out.push({
          type: "tool_call",
          tool: typeof b.name === "string" && b.name.length > 0 ? b.name : "tool",
          args: b.input ?? {},
          itemId: typeof b.id === "string" && b.id.length > 0 ? b.id : id,
        });
      } else if (blockType === "tool_result") {
        out.push({
          type: "tool_result",
          tool: "",
          result: claudeToolResultText(b.content),
          itemId: typeof b.tool_use_id === "string" && b.tool_use_id.length > 0 ? b.tool_use_id : id,
          status: b.is_error === true ? "failed" : "completed",
        });
      }
    });
  }

  // Nothing structured extracted but the SDK still gave us flat text.
  if (out.length === 0 && typeof message.text === "string" && message.text.trim().length > 0) {
    pushText(message.text, message.uuid);
  }
  return out;
}

// `/bin/zsh -lc "…"`, `bash -c '…'`, `sh -c …` — system rows that are really
// shell invocations become command events so they render as tool lines (the
// transcript renderer strips the launcher wrapper itself).
const SHELL_LAUNCHER_PATTERN = /^(?:\/[\w./-]+\/)?(?:zsh|bash|sh)\s+-[\w]*c\s+/;

function eventsFromTranscriptMessage(
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): AgentChatEvent[] {
  const record = transcriptRecord(message.message);
  // Anthropic/Claude message shape — expand its content blocks. This MUST come
  // before the generic passthrough: Anthropic messages carry type:"message",
  // which would otherwise be mistaken for an already-formed chat event.
  if (record && (record.type === "message" || record.role === "assistant" || record.role === "user")) {
    const expanded = expandClaudeTranscriptMessage(record, message)
      .map((event, subIndex) => normalizeTranscriptEvent(event, message, index + subIndex));
    if (expanded.length > 0) return expanded;
  }
  // Runtime already handed us a formed chat event (Codex thread items / the
  // captured live-event path) — pass it through so commands, file changes, and
  // tool calls render through the normal typed pipeline.
  if (typeof record?.type === "string" && record.type.trim().length > 0 && record.type !== "message") {
    return [normalizeTranscriptEvent(record as unknown as AgentChatEvent, message, index)];
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) return [];
  if (message.type === "user") {
    return [{ type: "user_message", text, messageId: message.uuid }];
  }
  if (message.type === "system") {
    if (SHELL_LAUNCHER_PATTERN.test(text)) {
      return [{
        type: "command",
        command: text,
        cwd: "",
        output: "",
        itemId: `subagent-cmd:${message.uuid}`,
        status: "completed",
      }];
    }
    return [{ type: "text", text: `system › ${text}`, messageId: message.uuid }];
  }
  return [{ type: "text", text, messageId: message.uuid }];
}

/**
 * Convert a REAL daemon-backed subagent transcript (Codex app-server threads /
 * OpenCode child-session messages / Claude SDK subagent messages) into display
 * envelopes for the takeover view. Used when a `canViewFullTranscript` subagent
 * is inspected; falls back to {@link buildSubagentTranscriptEvents} when the
 * daemon returns null. Formed chat events embedded in `message` pass through
 * (so tool calls / commands / file changes render as typed tool lines), Claude
 * message content blocks expand to their event equivalents, and flat text gets
 * a stable per-message messageId so streamed chunks merge back into paragraphs.
 */
export function subagentTranscriptMessagesToEvents(args: {
  messages: AgentChatSubagentTranscriptMessage[];
  snapshot: SubagentSnapshot;
  sessionId: string;
}): AgentChatEventEnvelope[] {
  const { messages, snapshot, sessionId } = args;
  const startTs = snapshot.startedAt ?? new Date(0).toISOString();
  let lineSeq = 0;
  const transcript: AgentChatEventEnvelope[] = [
    syntheticTextEvent(
      sessionId,
      startTs,
      lineSeq++,
      snapshot.turnId,
      `Viewing ${snapshot.kind === "teammate" ? "teammate" : snapshot.background ? "background agent" : "agent"} transcript. Select Main chat in Chat Info to return.\nTask: ${snapshot.name}`,
      `subagent-line:0`,
    ),
  ];
  messages.forEach((message, index) => {
    for (const event of eventsFromTranscriptMessage(message, index)) {
      transcript.push({ sessionId, timestamp: startTs, sequence: lineSeq++, event });
    }
  });
  if (transcript.length === 1) {
    transcript.push(syntheticTextEvent(
      sessionId,
      snapshot.endedAt ?? startTs,
      lineSeq,
      snapshot.turnId,
      snapshot.summary || "No transcript rows were returned for this agent.",
      `subagent-line:${lineSeq}`,
    ));
  }
  return transcript;
}
