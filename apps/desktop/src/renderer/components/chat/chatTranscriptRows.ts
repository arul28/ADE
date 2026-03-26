import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";

export type ChatWorkLogStatus = "running" | "completed" | "failed";
export type ChatWorkLogEntryKind = "tool" | "command" | "file_change" | "web_search";
export type ChatWorkLogEntryTone = "tool" | "info" | "error";

export type ChatWorkLogFileChange = {
  path: string;
  kind: Extract<AgentChatEvent, { type: "file_change" }>["kind"];
  additions: number;
  deletions: number;
  diff: string;
};

export type ChatWorkLogEntry = {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<ChatWorkLogFileChange>;
  tone: ChatWorkLogEntryTone;
  status: ChatWorkLogStatus;
  entryKind: ChatWorkLogEntryKind;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  output?: string;
  cwd?: string;
  query?: string;
  action?: string;
  itemId?: string;
  turnId?: string;
  parentItemId?: string;
};

type HiddenTranscriptEvent =
  | Extract<AgentChatEvent, { type: "activity" }>
  | Extract<AgentChatEvent, { type: "step_boundary" }>
  | Extract<AgentChatEvent, { type: "tool_call" }>
  | Extract<AgentChatEvent, { type: "tool_result" }>
  | Extract<AgentChatEvent, { type: "command" }>
  | Extract<AgentChatEvent, { type: "file_change" }>
  | Extract<AgentChatEvent, { type: "web_search" }>
  | Extract<AgentChatEvent, { type: "reasoning" }>;

type ChatTranscriptVisibleEvent = Exclude<AgentChatEvent, HiddenTranscriptEvent>;

type RenderReasoningEvent = Extract<AgentChatEvent, { type: "reasoning" }> & {
  startTimestamp?: string;
};

type WorkLogRenderEvent = {
  type: "work_log_entry";
  entry: ChatWorkLogEntry;
  collapseKey?: string;
};

export type ChatTranscriptRenderEvent =
  | ChatTranscriptVisibleEvent
  | RenderReasoningEvent
  | WorkLogRenderEvent;

export type ChatTranscriptRenderEnvelope = {
  key: string;
  timestamp: string;
  event: ChatTranscriptRenderEvent;
};

export type ChatTranscriptGroupedEnvelope = {
  key: string;
  timestamp: string;
  event:
    | ChatTranscriptRenderEvent
    | {
        type: "work_log_group";
        entries: ChatWorkLogEntry[];
      };
};

export function summarizeInlineText(value: string, maxChars = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text.length) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function mergeStreamingText(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (incoming.startsWith(existing)) return incoming;
  return `${existing}${incoming}`;
}

export function eventHasPayload(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

export function summarizeDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (!line.length) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildRenderKey(envelope: AgentChatEventEnvelope, sequence: number): string {
  return `${envelope.sessionId}:${sequence}:${envelope.timestamp}`;
}

function buildToolCollapseKey(event: Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>): string | undefined {
  const parts = ["tool"];
  if (event.turnId) parts.push(event.turnId);
  if (event.itemId) parts.push(event.itemId);
  parts.push(event.tool);
  return parts.join("::");
}

function buildCommandCollapseKey(event: Extract<AgentChatEvent, { type: "command" }>): string | undefined {
  const parts = ["command"];
  if (event.turnId) parts.push(event.turnId);
  if (event.itemId) parts.push(event.itemId);
  parts.push(event.command);
  return parts.join("::");
}

function buildFileCollapseKey(event: Extract<AgentChatEvent, { type: "file_change" }>): string | undefined {
  const parts = ["file"];
  if (event.turnId) parts.push(event.turnId);
  if (event.itemId) parts.push(event.itemId);
  return parts.join("::");
}

function buildWebSearchCollapseKey(event: Extract<AgentChatEvent, { type: "web_search" }>): string | undefined {
  const parts = ["web-search"];
  if (event.turnId) parts.push(event.turnId);
  if (event.itemId) parts.push(event.itemId);
  parts.push(event.query);
  return parts.join("::");
}

function deriveToolTone(status: ChatWorkLogStatus): ChatWorkLogEntryTone {
  return status === "failed" ? "error" : "tool";
}

function deriveInfoTone(status: ChatWorkLogStatus): ChatWorkLogEntryTone {
  return status === "failed" ? "error" : "info";
}

function buildToolWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>,
  timestamp: string,
): WorkLogRenderEvent {
  const status = event.type === "tool_call" ? "running" : (event.status ?? "completed");
  return {
    type: "work_log_entry",
    collapseKey: buildToolCollapseKey(event),
    entry: {
      id: event.itemId,
      createdAt: timestamp,
      label: event.tool,
      tone: deriveToolTone(status),
      status,
      entryKind: "tool",
      toolName: event.tool,
      ...(event.type === "tool_call" ? { args: event.args } : {}),
      ...(event.type === "tool_result" ? { result: event.result } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
    },
  };
}

function buildCommandWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "command" }>,
  timestamp: string,
): WorkLogRenderEvent {
  return {
    type: "work_log_entry",
    collapseKey: buildCommandCollapseKey(event),
    entry: {
      id: event.itemId,
      createdAt: timestamp,
      label: "Shell",
      command: event.command,
      output: event.output,
      cwd: event.cwd,
      tone: deriveInfoTone(event.status),
      status: event.status,
      entryKind: "command",
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    },
  };
}

function buildFileWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "file_change" }>,
  timestamp: string,
): WorkLogRenderEvent {
  const stats = summarizeDiffStats(event.diff);
  return {
    type: "work_log_entry",
    collapseKey: buildFileCollapseKey(event),
    entry: {
      id: event.itemId,
      createdAt: timestamp,
      label: event.path,
      changedFiles: [{
        path: event.path,
        kind: event.kind,
        additions: stats.additions,
        deletions: stats.deletions,
        diff: event.diff,
      }],
      tone: deriveInfoTone(event.status ?? "completed"),
      status: event.status ?? "completed",
      entryKind: "file_change",
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    },
  };
}

function buildWebSearchWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "web_search" }>,
  timestamp: string,
): WorkLogRenderEvent {
  return {
    type: "work_log_entry",
    collapseKey: buildWebSearchCollapseKey(event),
    entry: {
      id: event.itemId,
      createdAt: timestamp,
      label: "Web search",
      detail: event.action,
      query: event.query,
      action: event.action,
      tone: deriveInfoTone(event.status),
      status: event.status,
      entryKind: "web_search",
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    },
  };
}

function mergeFileChanges(
  previous: ReadonlyArray<ChatWorkLogFileChange> | undefined,
  next: ReadonlyArray<ChatWorkLogFileChange> | undefined,
): ChatWorkLogFileChange[] {
  const merged = new Map<string, ChatWorkLogFileChange>();

  const ingest = (change: ChatWorkLogFileChange) => {
    const existing = merged.get(change.path);
    if (!existing) {
      merged.set(change.path, change);
      return;
    }
    const diff = mergeStreamingText(existing.diff, change.diff);
    const stats = summarizeDiffStats(diff);
    merged.set(change.path, {
      ...existing,
      ...change,
      additions: stats.additions,
      deletions: stats.deletions,
      diff,
    });
  };

  for (const change of previous ?? []) ingest(change);
  for (const change of next ?? []) ingest(change);

  const fileChanges = [...merged.values()];
  const knownFiles = fileChanges.filter((change) => change.path !== "(pending file)");
  if (knownFiles.length > 0) {
    return knownFiles;
  }
  return fileChanges;
}

function mergeWorkLogEntries(previous: ChatWorkLogEntry, next: ChatWorkLogEntry): ChatWorkLogEntry {
  const mergedOutput = (() => {
    if (typeof previous.output !== "string" && typeof next.output !== "string") return undefined;
    return mergeStreamingText(previous.output ?? "", next.output ?? "");
  })();

  const changedFiles = mergeFileChanges(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const result = eventHasPayload(next.result) ? next.result : previous.result;

  return {
    ...previous,
    ...next,
    createdAt: previous.createdAt,
    label: next.label || previous.label,
    tone: next.status === "failed" ? "error" : next.tone ?? previous.tone,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(mergedOutput ? { output: mergedOutput } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

function findMatchingWorkLogEntryIndex(
  rows: ChatTranscriptRenderEnvelope[],
  collapseKey: string | undefined,
): number {
  if (!collapseKey) return -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = rows[index];
    if (!candidate || candidate.event.type !== "work_log_entry") continue;
    if (candidate.event.collapseKey === collapseKey) return index;
  }
  return -1;
}

function appendWorkLogRow(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  sequence: number,
  nextEvent: WorkLogRenderEvent,
): void {
  const matchIndex = findMatchingWorkLogEntryIndex(rows, nextEvent.collapseKey);
  if (matchIndex >= 0) {
    const existing = rows[matchIndex];
    if (existing?.event.type === "work_log_entry") {
      rows[matchIndex] = {
        ...existing,
        timestamp: envelope.timestamp,
        event: {
          ...existing.event,
          entry: mergeWorkLogEntries(existing.event.entry, nextEvent.entry),
        },
      };
      return;
    }
  }

  rows.push({
    key: buildRenderKey(envelope, sequence),
    timestamp: envelope.timestamp,
    event: nextEvent,
  });
}

export function appendCollapsedChatTranscriptEvent(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  sequence: number,
): void {
  const { event } = envelope;

  if (event.type === "step_boundary" || event.type === "activity") {
    return;
  }

  if (event.type === "status") {
    const normalizedMessage = summarizeInlineText(event.message ?? "", 120).toLowerCase();
    const keepStatus =
      event.turnStatus === "failed"
      || event.turnStatus === "interrupted"
      || (normalizedMessage.length > 0
        && normalizedMessage !== event.turnStatus.toLowerCase()
        && normalizedMessage !== "started"
        && normalizedMessage !== "completed");
    if (!keepStatus) return;
  }

  if (event.type === "system_notice" && event.noticeKind === "info" && event.message.trim().toLowerCase() === "session ready") {
    return;
  }

  if (event.type === "delegation_state") {
    const normalizedMessage = summarizeInlineText(event.message ?? "", 140);
    const keepDelegation =
      normalizedMessage.length > 0
      || event.contract.status === "blocked"
      || event.contract.status === "launch_failed"
      || event.contract.status === "failed";
    if (!keepDelegation) return;
  }

  if (event.type === "reasoning") {
    const nextTurn = event.turnId ?? null;
    const nextItemId = event.itemId ?? null;
    const nextSummaryIndex = event.summaryIndex ?? null;
    let matchIndex = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index];
      if (!candidate || candidate.event.type !== "reasoning") break;
      const sameReasoningBlock = nextItemId !== null
        ? (candidate.event.itemId ?? null) === nextItemId
          && (candidate.event.summaryIndex ?? null) === nextSummaryIndex
        : nextTurn !== null
          && (candidate.event.turnId ?? null) === nextTurn
          && (candidate.event.itemId ?? null) === null;
      if (sameReasoningBlock) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex >= 0) {
      const existing = rows[matchIndex];
      if (existing?.event.type === "reasoning") {
        rows[matchIndex] = {
          ...existing,
          timestamp: envelope.timestamp,
          event: {
            ...existing.event,
            text: `${existing.event.text}${event.text}`,
            startTimestamp: existing.event.startTimestamp ?? existing.timestamp,
          },
        };
        return;
      }
    }
  }

  if (event.type === "text") {
    const nextTurn = event.turnId ?? null;
    const nextItem = event.itemId ?? null;
    if (nextTurn || nextItem) {
      let matchIndex = -1;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const candidate = rows[index];
        if (!candidate) continue;
        if (candidate.event.type === "work_log_entry") break;
        if (
          candidate.event.type === "text"
          && (candidate.event.turnId ?? null) === nextTurn
          && (candidate.event.itemId ?? null) === nextItem
        ) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex >= 0) {
        const existing = rows[matchIndex];
        if (existing?.event.type === "text") {
          rows[matchIndex] = {
            ...existing,
            timestamp: envelope.timestamp,
            event: {
              ...existing.event,
              text: `${existing.event.text}${event.text}`,
            },
          };
          return;
        }
      }
    }
  }

  if (event.type === "todo_update") {
    const nextTurn = event.turnId ?? null;
    if (nextTurn !== null) {
      const matchIndex = [...rows]
        .reverse()
        .findIndex((candidate) =>
          candidate.event.type === "todo_update"
          && (candidate.event.turnId ?? null) === nextTurn,
        );
      if (matchIndex >= 0) {
        const actualIndex = rows.length - 1 - matchIndex;
        rows[actualIndex] = {
          ...rows[actualIndex]!,
          timestamp: envelope.timestamp,
          event,
        };
        return;
      }
    }
    rows.push({
      key: buildRenderKey(envelope, sequence),
      timestamp: envelope.timestamp,
      event,
    });
    return;
  }

  if (event.type === "subagent_progress") {
    const matchIndex = [...rows]
      .reverse()
      .findIndex((candidate) =>
        candidate.event.type === "subagent_progress"
        && candidate.event.taskId === event.taskId
        && (candidate.event.turnId ?? null) === (event.turnId ?? null),
      );
    if (matchIndex >= 0) {
      const actualIndex = rows.length - 1 - matchIndex;
      rows[actualIndex] = {
        ...rows[actualIndex]!,
        timestamp: envelope.timestamp,
        event,
      };
      return;
    }
  }

  if (event.type === "tool_call" || event.type === "tool_result") {
    appendWorkLogRow(rows, envelope, sequence, buildToolWorkLogEvent(event, envelope.timestamp));
    return;
  }

  if (event.type === "command") {
    appendWorkLogRow(rows, envelope, sequence, buildCommandWorkLogEvent(event, envelope.timestamp));
    return;
  }

  if (event.type === "file_change") {
    appendWorkLogRow(rows, envelope, sequence, buildFileWorkLogEvent(event, envelope.timestamp));
    return;
  }

  if (event.type === "web_search") {
    appendWorkLogRow(rows, envelope, sequence, buildWebSearchWorkLogEvent(event, envelope.timestamp));
    return;
  }

  rows.push({
    key: buildRenderKey(envelope, sequence),
    timestamp: envelope.timestamp,
    event,
  });
}

export function collapseChatTranscriptEvents(events: AgentChatEventEnvelope[]): ChatTranscriptRenderEnvelope[] {
  const rows: ChatTranscriptRenderEnvelope[] = [];
  for (let index = 0; index < events.length; index += 1) {
    appendCollapsedChatTranscriptEvent(rows, events[index]!, index);
  }
  return rows;
}

export function collapseChatTranscriptEventsIncremental(
  events: AgentChatEventEnvelope[],
  previousEvents: AgentChatEventEnvelope[],
  previousRows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptRenderEnvelope[] {
  if (!previousEvents.length || events.length < previousEvents.length) {
    return collapseChatTranscriptEvents(events);
  }

  if (events[previousEvents.length - 1] !== previousEvents[previousEvents.length - 1]) {
    return collapseChatTranscriptEvents(events);
  }

  const rows = previousRows.slice();
  for (let index = previousEvents.length; index < events.length; index += 1) {
    appendCollapsedChatTranscriptEvent(rows, events[index]!, index);
  }
  return rows;
}

export function groupConsecutiveWorkLogRows(
  rows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  const grouped: ChatTranscriptGroupedEnvelope[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index]!;
    if (row.event.type === "work_log_entry") {
      const entries: ChatWorkLogEntry[] = [];
      let cursor = index;
      while (cursor < rows.length && rows[cursor]!.event.type === "work_log_entry") {
        entries.push((rows[cursor]!.event as WorkLogRenderEvent).entry);
        cursor += 1;
      }
      grouped.push({
        key: `work-log:${row.key}`,
        timestamp: rows[cursor - 1]!.timestamp,
        event: {
          type: "work_log_group",
          entries,
        },
      });
      index = cursor;
      continue;
    }

    grouped.push(row);
    index += 1;
  }

  return grouped;
}

export type TurnDividerDataEntry = {
  turnId: string;
  startTimestamp: string;
  endTimestamp?: string;
  model?: string;
  modelId?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  status?: "completed" | "interrupted" | "failed";
};

export function deriveTurnDividerData(events: AgentChatEventEnvelope[]): Map<string, TurnDividerDataEntry> {
  const turns = new Map<string, TurnDividerDataEntry>();

  for (const envelope of events) {
    const event = envelope.event;
    const turnId = ("turnId" in event && typeof event.turnId === "string") ? event.turnId.trim() : "";
    if (!turnId) continue;

    if (!turns.has(turnId)) {
      turns.set(turnId, {
        turnId,
        startTimestamp: envelope.timestamp,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      });
    }
    const entry = turns.get(turnId)!;

    if (event.type === "file_change" && event.status !== "running") {
      entry.filesChanged++;
      const stats = summarizeDiffStats(event.diff);
      entry.insertions += stats.additions;
      entry.deletions += stats.deletions;
    }

    if (event.type === "done") {
      entry.endTimestamp = envelope.timestamp;
      entry.status = event.status;
      entry.model = event.model;
      entry.modelId = event.modelId;
      if (event.usage) {
        entry.inputTokens = event.usage.inputTokens ?? undefined;
        entry.outputTokens = event.usage.outputTokens ?? undefined;
        entry.cacheReadTokens = event.usage.cacheReadTokens ?? undefined;
      }
      if (event.costUsd != null) entry.costUsd = event.costUsd;
    }
  }

  return turns;
}
