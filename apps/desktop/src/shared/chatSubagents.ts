import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
} from "./types/chat";

export type SubagentSnapshot = {
  id: string;
  name: string;
  kind: "subagent" | "teammate";
  status: "running" | "completed" | "failed" | "stopped";
  summary: string;
  parentToolUseId?: string | null;
  turnId?: string | null;
  background?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
  tokens?: number;
  durationMs?: number;
  lastToolName?: string;
};

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
  return textField((event as { parentToolUseId?: unknown }).parentToolUseId);
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
    const parent = typeof event.parentToolUseId === "string" && event.parentToolUseId.trim()
      ? event.parentToolUseId.trim()
      : null;
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
      });
      continue;
    }

    if (!type.startsWith("subagent")) continue;
    const taskId = typeof event.taskId === "string" && event.taskId.trim() ? event.taskId.trim() : null;
    const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
    const id = agentId ?? taskId;
    if (!id) continue;
    const incomingParentToolUseId = typeof event.parentToolUseId === "string" && event.parentToolUseId.trim()
      ? event.parentToolUseId.trim()
      : null;
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
    const base: SubagentSnapshot = {
      id,
      name: typeof event.description === "string" ? event.description : existing?.name ?? agentType,
      kind: "subagent",
      status: existing?.status ?? "running",
      summary,
      parentToolUseId,
      turnId: typeof event.turnId === "string" ? event.turnId : existing?.turnId ?? null,
      background: event.background === true || existing?.background === true,
      startedAt,
      endedAt,
      tokens: typeof usage.totalTokens === "number" ? usage.totalTokens : typeof event.tokens === "number" ? event.tokens : existing?.tokens,
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
): AgentChatEventEnvelope {
  return {
    sessionId,
    timestamp,
    sequence,
    event: {
      type: "text",
      text,
      ...(turnId ? { turnId } : {}),
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

  const transcript: AgentChatEventEnvelope[] = [
    syntheticTextEvent(
      sessionId,
      args.snapshot.startedAt ?? args.events[0]?.timestamp ?? new Date(0).toISOString(),
      -2,
      args.snapshot.turnId,
      `Viewing ${args.snapshot.kind === "teammate" ? "teammate" : args.snapshot.background ? "background agent" : "agent"} transcript. Select Main chat in Chat Info to return.\nTask: ${args.snapshot.name}`,
    ),
  ];

  for (const envelope of args.events) {
    const event = envelope.event;
    if (isLifecycleEventForSnapshot(event, args.snapshot)) {
      const text = lifecycleText(event, args.snapshot);
      if (text) {
        transcript.push(syntheticTextEvent(sessionId, envelope.timestamp, envelope.sequence ?? 0, args.snapshot.turnId, text));
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
    ));
  }

  return transcript;
}
