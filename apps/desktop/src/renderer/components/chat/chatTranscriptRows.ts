import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";

export type ChatWorkLogStatus = "running" | "completed" | "failed" | "interrupted";
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
  | Extract<AgentChatEvent, { type: "reasoning" }>
  | Extract<AgentChatEvent, { type: "pending_input_resolved" }>;

type ChatTranscriptVisibleEvent = Exclude<AgentChatEvent, HiddenTranscriptEvent>;

type RenderReasoningEvent = Extract<AgentChatEvent, { type: "reasoning" }> & {
  startTimestamp?: string;
};

type WorkLogRenderEvent = {
  type: "work_log_entry";
  entry: ChatWorkLogEntry;
  collapseKey?: string;
};

export type ChatWorkLogGroupEvent = {
  type: "work_log_group";
  entries: ChatWorkLogEntry[];
  summary?: string;
  toolUseIds?: string[];
  turnId?: string | null;
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
  event: ChatTranscriptRenderEvent | ChatWorkLogGroupEvent;
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

function isGenericToolIdentifier(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return !normalized.length || normalized === "other" || normalized === "tool";
}

function readToolTitle(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return title.length ? title : null;
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

function buildTextRenderKey(event: Extract<AgentChatEvent, { type: "text" }>, envelope: AgentChatEventEnvelope, sequence: number): string {
  const messageId = event.messageId?.trim();
  if (messageId) {
    return `${envelope.sessionId}:text:${messageId}:${sequence}`;
  }
  return buildRenderKey(envelope, sequence);
}

function getTextIdentity(event: Extract<AgentChatEvent, { type: "text" }>): string | null {
  const messageId = event.messageId?.trim();
  return messageId?.length ? messageId : null;
}

function turnAndItemMatch(
  a: { turnId?: string; itemId?: string },
  b: { turnId?: string; itemId?: string },
): boolean {
  const aTurnId = a.turnId ?? null;
  const bTurnId = b.turnId ?? null;
  if (!aTurnId || !bTurnId || aTurnId !== bTurnId) return false;
  const aItemId = a.itemId ?? null;
  const bItemId = b.itemId ?? null;
  return !aItemId || !bItemId || aItemId === bItemId;
}

function shouldMergeTextRows(
  previous: Extract<AgentChatEvent, { type: "text" }>,
  next: Extract<AgentChatEvent, { type: "text" }>,
): boolean {
  const previousIdentity = getTextIdentity(previous);
  const nextIdentity = getTextIdentity(next);

  if (previousIdentity || nextIdentity) {
    if (previousIdentity && nextIdentity) {
      return previousIdentity === nextIdentity;
    }
    return turnAndItemMatch(previous, next);
  }

  if (turnAndItemMatch(previous, next)) return true;

  return !previous.turnId && !next.turnId && !previous.itemId && !next.itemId;
}

function shouldMergePlanTextRows(
  previous: Extract<AgentChatEvent, { type: "plan_text" }>,
  next: Extract<AgentChatEvent, { type: "plan_text" }>,
): boolean {
  return turnAndItemMatch(previous, next)
    || (!previous.turnId && !next.turnId && !previous.itemId && !next.itemId);
}

function buildCollapseKey(
  prefix: string,
  event: { turnId?: string; itemId?: string; logicalItemId?: string },
  suffix?: string,
): string {
  const parts = [prefix];
  if (event.turnId) parts.push(event.turnId);
  const stableItemId = event.logicalItemId ?? event.itemId;
  if (stableItemId) parts.push(stableItemId);
  if (suffix) parts.push(suffix);
  return parts.join("::");
}

function buildWorkLogEntryId(
  collapseKey: string | undefined,
  event: { itemId?: string; logicalItemId?: string },
): string {
  return collapseKey ?? event.logicalItemId ?? event.itemId ?? "work-log-entry";
}

function deriveTone(status: ChatWorkLogStatus, normalTone: ChatWorkLogEntryTone): ChatWorkLogEntryTone {
  return status === "failed" ? "error" : normalTone;
}

function buildToolWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>,
  timestamp: string,
): WorkLogRenderEvent {
  const status = event.type === "tool_call" ? "running" : (event.status ?? "completed");
  const titleFallback = readToolTitle(event.type === "tool_call" ? event.args : event.result);
  const resolvedToolName = isGenericToolIdentifier(event.tool) && titleFallback ? titleFallback : event.tool;
  const collapseKey = buildCollapseKey("tool", event);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: {
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: resolvedToolName,
      tone: deriveTone(status, "tool"),
      status,
      entryKind: "tool",
      toolName: resolvedToolName,
      ...(titleFallback && titleFallback !== resolvedToolName ? { detail: titleFallback } : {}),
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
  const collapseKey = buildCollapseKey("command", event, event.command);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: {
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: "Shell",
      command: event.command,
      output: event.output,
      cwd: event.cwd,
      tone: deriveTone(event.status, "info"),
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
  const collapseKey = buildCollapseKey("file", event);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: {
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: event.path,
      changedFiles: [{
        path: event.path,
        kind: event.kind,
        additions: stats.additions,
        deletions: stats.deletions,
        diff: event.diff,
      }],
      tone: deriveTone(event.status ?? "completed", "info"),
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
  const collapseKey = buildCollapseKey("web-search", event, event.query);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: {
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: "Web search",
      detail: event.action,
      query: event.query,
      action: event.action,
      tone: deriveTone(event.status, "info"),
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
  const toolName = isGenericToolIdentifier(next.toolName) && !isGenericToolIdentifier(previous.toolName)
    ? previous.toolName
    : (next.toolName ?? previous.toolName);
  const label = isGenericToolIdentifier(next.label) && !isGenericToolIdentifier(previous.label)
    ? previous.label
    : (next.label || previous.label);

  return {
    ...previous,
    ...next,
    createdAt: previous.createdAt,
    label,
    tone: next.status === "failed" ? "error" : next.tone ?? previous.tone,
    ...(toolName ? { toolName } : {}),
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

  if (event.type === "step_boundary" || event.type === "activity" || event.type === "pending_input_resolved") {
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

    // Deduplicate consecutive identical status events (e.g. multiple "interrupted")
    const previous = rows[rows.length - 1];
    if (
      previous?.event.type === "status"
      && previous.event.turnStatus === event.turnStatus
      && (previous.event.turnId ?? null) === (event.turnId ?? null)
      && (previous.event.message ?? "") === (event.message ?? "")
    ) {
      return;
    }
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

  if (event.type === "subagent_started" || event.type === "subagent_progress" || event.type === "subagent_result") {
    return;
  }

  if (event.type === "text") {
    if (!event.text.trim().length) return;
    const previous = rows[rows.length - 1];
    if (previous?.event.type === "text" && shouldMergeTextRows(previous.event, event)) {
      const nextTurn = event.turnId ?? null;
      const nextItem = event.itemId ?? null;
      rows[rows.length - 1] = {
        ...previous,
        timestamp: envelope.timestamp,
        event: {
          ...previous.event,
          text: `${previous.event.text}${event.text}`,
          ...(nextTurn && !previous.event.turnId ? { turnId: nextTurn } : {}),
          ...(nextItem && !previous.event.itemId ? { itemId: nextItem } : {}),
          ...(event.messageId && !previous.event.messageId ? { messageId: event.messageId } : {}),
        },
      };
      return;
    }
  }

  if (event.type === "plan_text") {
    if (!event.text.trim().length) return;
    const previous = rows[rows.length - 1];
    if (previous?.event.type === "plan_text" && shouldMergePlanTextRows(previous.event, event)) {
      rows[rows.length - 1] = {
        ...previous,
        timestamp: envelope.timestamp,
        event: {
          ...previous.event,
          text: mergeStreamingText(previous.event.text, event.text),
          ...(event.turnId && !previous.event.turnId ? { turnId: event.turnId } : {}),
          ...(event.itemId && !previous.event.itemId ? { itemId: event.itemId } : {}),
        },
      };
      return;
    }
  }

  if (event.type === "system_notice") {
    const previous = rows[rows.length - 1];
    if (
      previous?.event.type === "system_notice"
      && previous.event.noticeKind === event.noticeKind
      && previous.event.message.trim() === event.message.trim()
      && JSON.stringify(previous.event.detail ?? null) === JSON.stringify(event.detail ?? null)
      && (previous.event.turnId ?? null) === (event.turnId ?? null)
    ) {
      return;
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

  if (event.type === "plan") {
    const nextTurn = event.turnId ?? null;
    if (nextTurn !== null) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const candidate = rows[index];
        if (
          candidate?.event.type === "plan_text"
          && (candidate.event.turnId ?? null) === nextTurn
        ) {
          rows.splice(index, 1);
        }
      }

      const matchIndex = [...rows]
        .reverse()
        .findIndex((candidate) =>
          candidate.event.type === "plan"
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
    key: event.type === "text" ? buildTextRenderKey(event, envelope, sequence) : buildRenderKey(envelope, sequence),
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

  const absorbToolSummary = (
    toolSummary: Extract<AgentChatEvent, { type: "tool_use_summary" }>,
  ): boolean => {
    const summary = toolSummary.summary.trim();
    const toolUseIds = toolSummary.toolUseIds.filter((id) => id.trim().length > 0);
    const candidate = grouped[grouped.length - 1];
    if (!candidate || candidate.event.type !== "work_log_group") return false;

    const candidateEvent = candidate.event;
    const candidateTurnId = candidateEvent.turnId ?? candidateEvent.entries[0]?.turnId ?? null;
    if (toolSummary.turnId && candidateTurnId && candidateTurnId !== toolSummary.turnId) return false;

    if (toolUseIds.length > 0) {
      const candidateToolIds = new Set(
        candidateEvent.entries
          .filter((entry) => entry.entryKind === "tool" && typeof entry.itemId === "string" && entry.itemId.trim().length > 0)
          .map((entry) => entry.itemId!.trim()),
      );
      const hasMatch = toolUseIds.some((toolUseId) => candidateToolIds.has(toolUseId));
      if (!hasMatch) return false;
    }

    grouped[grouped.length - 1] = {
      ...candidate,
      event: {
        ...candidateEvent,
        ...(summary.length > 0 ? { summary } : {}),
        ...(toolUseIds.length > 0
          ? {
              toolUseIds: [
                ...(candidateEvent.toolUseIds ?? []),
                ...toolUseIds.filter((toolUseId) => !(candidateEvent.toolUseIds ?? []).includes(toolUseId)),
              ],
            }
          : {}),
        turnId: candidateTurnId ?? toolSummary.turnId ?? null,
      },
    };
    return true;
  };

  while (index < rows.length) {
    const row = rows[index]!;
    if (row.event.type === "tool_use_summary") {
      const prevRow = index > 0 ? rows[index - 1] : null;
      const prevIsWorkLog = prevRow?.event.type === "work_log_entry";
      if (prevIsWorkLog && absorbToolSummary(row.event)) {
        index += 1;
        continue;
      }
    }

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
          turnId: entries[0]?.turnId ?? null,
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
