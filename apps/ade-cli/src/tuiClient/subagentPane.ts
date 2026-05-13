import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
} from "../../../desktop/src/shared/types/chat";
import type { RightPaneContent, SubagentSnapshot } from "./types";
import { workEventItemId, workEventParentItemId } from "./workEventIds";

export type SubagentPaneSection = "main" | "subagents" | "teammates" | "background" | "recent";

export type SubagentPaneRow =
  | { kind: "main"; key: "main"; section: "main"; label: string }
  | { kind: "snapshot"; key: string; section: Exclude<SubagentPaneSection, "main">; snapshot: SubagentSnapshot };

const SUBAGENT_PANE_TABLE_START_LINE = 4;

export function buildSubagentPaneRows(content: Extract<RightPaneContent, { kind: "subagents" }>): SubagentPaneRow[] {
  const runningSubagents = content.snapshots.filter((snap) => (
    snap.kind === "subagent"
    && snap.background !== true
    && snap.status === "running"
  ));
  const teammates = content.snapshots.filter((snap) => snap.kind === "teammate");
  const background = content.snapshots.filter((snap) => snap.kind === "subagent" && snap.background === true);
  const recent = content.snapshots.filter((snap) => (
    snap.kind === "subagent"
    && snap.background !== true
    && snap.status !== "running"
  ));

  return [
    { kind: "main", key: "main", section: "main", label: "main" },
    ...runningSubagents.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "subagents" as const, snapshot })),
    ...teammates.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "teammates" as const, snapshot })),
    ...background.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "background" as const, snapshot })),
    ...recent.map((snapshot) => ({ kind: "snapshot" as const, key: snapshot.id, section: "recent" as const, snapshot })),
  ];
}

export function selectedSubagentSnapshot(
  content: Extract<RightPaneContent, { kind: "subagents" }>,
  selectedIndex: number,
): SubagentSnapshot | null {
  const row = buildSubagentPaneRows(content)[selectedIndex] ?? null;
  return row?.kind === "snapshot" ? row.snapshot : null;
}

export function clampSubagentSelection(
  content: Extract<RightPaneContent, { kind: "subagents" }>,
  selectedIndex: number,
): number {
  const rowCount = buildSubagentPaneRows(content).length;
  if (rowCount <= 0) return 0;
  if (!Number.isFinite(selectedIndex)) return 0;
  return Math.max(0, Math.min(Math.floor(selectedIndex), rowCount - 1));
}

export function subagentPaneSelectableLineOffsets(
  content: Extract<RightPaneContent, { kind: "subagents" }>,
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
    if (row.kind === "main" || row.snapshot.lastToolName || row.snapshot.summary) {
      line += 1;
    }
  }

  return offsets;
}

export function subagentIndexForPaneLine(
  content: Extract<RightPaneContent, { kind: "subagents" }>,
  line: number,
): number | null {
  if (!Number.isFinite(line)) return null;
  const offsets = subagentPaneSelectableLineOffsets(content);
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

function isLifecycleEventForSnapshot(event: AgentChatEvent, snapshot: SubagentSnapshot): boolean {
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
  if (eventSubagentIds(event).includes(snapshot.id)) return true;
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
    return `Subagent started: ${textField(record.description) ?? snapshot.name}`;
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
      `Viewing ${args.snapshot.kind === "teammate" ? "teammate" : args.snapshot.background ? "background agent" : "subagent"}: ${args.snapshot.name}\nLeave the agents pane to return to the main chat.`,
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
