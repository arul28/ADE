import {
  collapseActivityPhaseRows,
  mergeReasoningTextFragments,
  type ActivityPhaseMergeMeta,
} from "../../../shared/chatActivityPhase";
import type { AgentChatEvent, AgentChatEventEnvelope, AgentChatSpawnKind, CodexWebSearchResult } from "../../../shared/types";
import {
  isBackgroundShellCommand,
  longerSubagentText,
  normalizeSubagentLifecycleEvent,
  preferSubagentSummary,
  preferredSubagentAgentType,
  subagentAgentKey,
  SUBAGENT_PLACEHOLDER_SUMMARY,
  type NormalizedSubagentLifecycleEvent,
} from "../../../shared/chatSubagents";
import { backgroundCommandLabel } from "../../../shared/chatScheduledWork";
import {
  contextCompactMergeKey,
  isContextCompactionChatEvent,
  mergeNormalizedContextCompact,
  normalizeContextCompactEvent,
  toContextCompactChatEvent,
} from "../../../shared/contextCompaction";

export type ChatWorkLogStatus = "running" | "completed" | "failed" | "interrupted";
export type ChatWorkLogEntryKind = "tool" | "command" | "file_change" | "web_search" | "hook";
export type ChatWorkLogEntryTone = "tool" | "info" | "error";

export type ChatLocalhostUrl = {
  url: string;
  href: string;
  host: string;
  port: number | null;
};

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
  mcp?: NonNullable<Extract<AgentChatEvent, { type: "tool_call" }>["mcp"]>;
  args?: unknown;
  result?: unknown;
  output?: string;
  localUrls?: ReadonlyArray<ChatLocalhostUrl>;
  cwd?: string;
  query?: string;
  action?: string;
  actions?: NonNullable<Extract<AgentChatEvent, { type: "web_search" }>["actions"]>;
  /** Structured web-search results (max 8), rendered as compact external links. */
  results?: NonNullable<Extract<AgentChatEvent, { type: "web_search" }>["results"]>;
  /** Result count before the producer capped `results` — drives the "+N more" line. */
  resultsTotal?: number;
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
  | Extract<AgentChatEvent, { type: "pending_input_resolved" }>
  // Token usage drives the chat-column-bottom token footer; inline transcript
  // rows would be duplicate noise.
  | Extract<AgentChatEvent, { type: "codex_token_usage" }>;

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

export type ChatActivityBundleItem = {
  key: string;
  timestamp: string;
  event: Extract<AgentChatEvent, {
    type:
      | "todo_update"
      | "scheduled_work_update";
  }>;
};

export type ChatActivityBundleEvent = {
  type: "activity_bundle";
  items: ChatActivityBundleItem[];
  turnId?: string | null;
};

type SubagentCardStatus = "running" | "completed" | "stopped" | "failed";
type SubagentCardTerminalStatus = Exclude<SubagentCardStatus, "running">;

/**
 * Anchor row for a real subagent, pushed once where the agent started and then
 * mutated IN PLACE (new object, same key) as progress/result events arrive.
 * Renders the two-row spawn card. Row key: `subagent-spawn:${agentKey}`.
 */
export type SubagentSpawnAnchorRenderEvent = {
  type: "subagent_spawn_anchor";
  agentKey: string;
  description: string;
  agentType: string | null;
  background: boolean;
  status: SubagentCardStatus;
  /** Last meaningful progress summary (placeholder summaries never displace a real one). */
  statusLine: string | null;
  lastToolName: string | null;
  toolCount: number | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * Spawned-ADE-chat navigation. Set only when the source lifecycle event carried
   * a `chat:<id>` taskId (a spawned peer/subagent chat, not a runtime-native
   * subagent). The whole card becomes a button that navigates to this session.
   */
  childSessionId: string | null;
  /** Cosmetic relationship + completion-report policy; null for runtime-native subagents. */
  spawnKind: AgentChatSpawnKind | null;
  /** Final result summary, surfaced on the card once the agent settles. */
  resultSummary: string | null;
  /** Best-effort parent label (parent's description/agentType); null/absent if unknown. */
  parentLabel?: string | null;
};

/**
 * Result card row, pushed at the chronological position where the agent ended
 * and mutated in place if a richer summary arrives later.
 * Row key: `subagent-result:${agentKey}`.
 */
export type SubagentResultCardRenderEvent = {
  type: "subagent_result_card";
  agentKey: string;
  /** Task title, carried so the stopped-group card can label each folded agent. */
  description: string | null;
  status: SubagentCardTerminalStatus;
  summaryPreview: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
  totalTokens: number | null;
  toolUseCount: number | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  parentLabel: string | null;
};

/** One folded agent inside a {@link SubagentStoppedGroupEvent}. */
export type SubagentStoppedGroupItem = {
  agentKey: string;
  title: string;
  /** Stable row key of this agent's spawn anchor (`subagent-spawn:${agentKey}`). */
  jumpToStartRowKey: string;
};

/**
 * A run of 2+ consecutive interrupt-stopped subagent result cards, folded into
 * one calm card so a mass interrupt (a dozen — or fifty — agents) renders as a
 * single line instead of a wall of identical "stopped" cards. Produced by the
 * second-layer grouping pass; never emitted by the first-layer collapse.
 * Row key: `subagent-stopped-group:${firstAgentKey}`.
 */
export type SubagentStoppedGroupEvent = {
  type: "subagent_stopped_group";
  count: number;
  items: SubagentStoppedGroupItem[];
};

/**
 * Compact finish chip for a backgrounded shell command (no spawn/result cards).
 * Row key: `background-chip:${agentKey}`.
 */
export type BackgroundFinishChipRenderEvent = {
  type: "background_finish_chip";
  agentKey: string;
  label: string;
  status: SubagentCardTerminalStatus;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string;
};

export type ScheduledWakeDividerRenderEvent = {
  type: "scheduled_wake_divider";
  scheduleId: string;
  kind: "wakeup" | "cron" | "loop";
  reason: string | null;
  firedAt: string;
  late: boolean;
  turnId?: string;
};

/**
 * Header row rendered above a synthetic `wake` turn ADE delivered when a spawned
 * `subagent` finished (`user_message.metadata.spawnCompletion`). Mirrors the
 * scheduled-wake divider treatment; carries the child session id so the row's
 * `[open ›]` affordance navigates to the finished child.
 * Row key: `spawn-wake:${childSessionId}:${turnId}`.
 */
export type SpawnWakeDividerRenderEvent = {
  type: "spawn_wake_divider";
  childSessionId: string;
  childTitle: string;
  spawnKind: AgentChatSpawnKind;
  status: "completed" | "failed" | "stopped";
  summary: string | null;
  turnId?: string;
};

export type ChatTranscriptRenderEvent =
  | ChatTranscriptVisibleEvent
  | RenderReasoningEvent
  | WorkLogRenderEvent
  | SubagentSpawnAnchorRenderEvent
  | SubagentResultCardRenderEvent
  | BackgroundFinishChipRenderEvent
  | ScheduledWakeDividerRenderEvent
  | SpawnWakeDividerRenderEvent;

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
    | ChatWorkLogGroupEvent
    | ChatActivityBundleEvent
    | SubagentStoppedGroupEvent;
};

type PlanTranscriptEvent = Extract<AgentChatEvent, { type: "plan" }>;
type TodoUpdateTranscriptEvent = Extract<AgentChatEvent, { type: "todo_update" }>;

/**
 * Live per-subagent state threaded through the collapse pass. `rowIndex` lets an
 * appended progress/result event index back into the rows array and mutate the
 * anchor in place. Subagent lifecycle handling never splices rows; transcript
 * retractions repair every stored position after removing a text row.
 */
type SubagentAnchorState = {
  agentKey: string;
  /**
   * Stable identity used for row keys. Fixed at creation from the first agentKey
   * seen and NEVER changed on rebind — the virtualizer's measuredHeights and
   * sticky-bottom depend on it. The displayed `agentKey` may migrate taskId →
   * agentId, but the render keys stay put.
   */
  renderKeyBase: string;
  /** Index of the spawn-anchor row (null for background-shell commands). */
  rowIndex: number | null;
  /** Index of the result-card row once the agent ends (null until then). */
  resultRowIndex: number | null;
  /** Index of the background finish-chip row (null unless a background shell). */
  chipRowIndex: number | null;
  description: string | null;
  agentType: string | null;
  taskType: string | null;
  command: string | null;
  background: boolean;
  startedAt: string;
  endedAt: string | null;
  progressSummary: string | null;
  statusLine: string | null;
  lastToolName: string | null;
  toolCount: number | null;
  status: SubagentCardStatus;
  resultSummary: string | null;
  error: string | null;
  /** Child session id for a spawned ADE chat (`chat:<id>` taskId); null otherwise. */
  childSessionId: string | null;
  /** Spawn-kind carried on the `subagent_started` event; null for runtime-native subagents. */
  spawnKind: AgentChatSpawnKind | null;
  /** Result-only usage/worktree metadata surfaced on the result card. */
  totalTokens: number | null;
  toolUseCount: number | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  /** Parent agent id carried on any lifecycle event; resolves the parent label. */
  parentAgentId: string | null;
};

type CollapseTranscriptContext = {
  latestTodoItemsByTurn: Map<string, TodoUpdateTranscriptEvent["items"]>;
  /** Subagent lifecycle state keyed by agentKey (agentId ?? taskId). */
  subagentAnchors: Map<string, SubagentAnchorState>;
  /** Semantic provider failures already rendered for a specific turn. */
  errorKeysByTurn: Set<string>;
};

export function createCollapseTranscriptContext(): CollapseTranscriptContext {
  return { latestTodoItemsByTurn: new Map(), subagentAnchors: new Map(), errorKeysByTurn: new Set() };
}

function todoSnapshotKey(turnId: string | null): string {
  return turnId ?? "__global__";
}

function changedTodoItems(
  previous: TodoUpdateTranscriptEvent["items"] | undefined,
  next: TodoUpdateTranscriptEvent["items"],
): TodoUpdateTranscriptEvent["items"] {
  if (!previous) return next;
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return next.filter((item) => {
    const before = previousById.get(item.id);
    return !before
      || before.description !== item.description
      || before.status !== item.status;
  });
}

function mergePlanTranscriptEvent(previous: PlanTranscriptEvent, incoming: PlanTranscriptEvent): PlanTranscriptEvent {
  const hasIncomingSteps = incoming.steps.length > 0;
  const nextState = incoming.state ?? (hasIncomingSteps ? "updated" : previous.state);
  const preserveStreamingText = nextState === "delta" && !hasIncomingSteps && incoming.streamingText == null;
  return {
    ...previous,
    ...incoming,
    turnId: incoming.turnId ?? previous.turnId,
    itemId: incoming.itemId ?? previous.itemId,
    state: nextState,
    steps: hasIncomingSteps ? incoming.steps : previous.steps,
    explanation: incoming.explanation ?? previous.explanation,
    streamingText: preserveStreamingText ? previous.streamingText : incoming.streamingText,
  };
}

export function summarizeInlineText(value: string, maxChars = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text.length) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function isLowValueHookNotice(event: Extract<AgentChatEvent, { type: "system_notice" }>): boolean {
  if (event.noticeKind !== "hook") return false;
  const message = event.message.trim();
  return /^hook:\s+.+\s+started$/i.test(message)
    || message.toLowerCase() === "trimmed large tool output before sending it back to claude.";
}

function summarizePreToolUseHookError(event: Extract<AgentChatEvent, { type: "system_notice" }>): string | null {
  if (event.noticeKind !== "hook") return null;
  const message = event.message.replace(/\s+/g, " ").trim();
  const match = message.match(/^hook:\s*(PreToolUse:[^\n]+?\s+error)$/i);
  return match?.[1]?.trim() ?? null;
}

const LOCALHOST_URL_PATTERN =
  /https?:\/\/(?<host>localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(?<port>\d{1,5}))?(?<suffix>[^\s<>"']*)?/giu;

function stripTrailingUrlPunctuation(value: string): string {
  let next = value;
  while (/[.,)\]}]$/u.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

function normalizeLocalhostHref(url: string, host: string): string {
  if (host === "localhost") return url;
  return url.replace(`://${host}`, "://localhost");
}

export function extractLocalhostUrlsFromText(text: string): ChatLocalhostUrl[] {
  const urls: ChatLocalhostUrl[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(LOCALHOST_URL_PATTERN)) {
    const host = match.groups?.host;
    const portText = match.groups?.port;
    if (!host) continue;
    const port = portText ? Number.parseInt(portText, 10) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) continue;

    const url = stripTrailingUrlPunctuation(match[0]);
    const href = normalizeLocalhostHref(url, host);
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push({ url, href, host, port });
  }

  return urls;
}

function collectTextValues(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || out.length >= 80 || value == null) return out;
  if (typeof value === "string") {
    if (value.trim().length) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTextValues(entry, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectTextValues(entry, depth + 1, out);
    }
  }
  return out;
}

function appendLocalhostUrls(
  target: ChatLocalhostUrl[],
  seen: Set<string>,
  text: string | undefined,
): void {
  if (!text) return;
  for (const url of extractLocalhostUrlsFromText(text)) {
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    target.push(url);
  }
}

export function deriveLocalhostUrlsForWorkLogEntry(entry: ChatWorkLogEntry): ChatLocalhostUrl[] {
  const urls: ChatLocalhostUrl[] = [];
  const seen = new Set<string>();
  appendLocalhostUrls(urls, seen, entry.command);
  appendLocalhostUrls(urls, seen, entry.output);
  appendLocalhostUrls(urls, seen, entry.detail);
  appendLocalhostUrls(urls, seen, entry.label);
  for (const value of collectTextValues(entry.args)) appendLocalhostUrls(urls, seen, value);
  for (const value of collectTextValues(entry.result)) appendLocalhostUrls(urls, seen, value);
  return urls;
}

function withLocalhostUrls(entry: ChatWorkLogEntry): ChatWorkLogEntry {
  const localUrls = deriveLocalhostUrlsForWorkLogEntry(entry);
  const { localUrls: _previousLocalUrls, ...rest } = entry;
  return localUrls.length > 0 ? { ...rest, localUrls } : rest;
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
  if (
    diff.includes("[ADE] Large file diff was shortened for stored chat history.")
    && diff.includes("bytes omitted from stored chat history.")
  ) {
    return { additions: 0, deletions: 0 };
  }

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

export function buildRenderKey(envelope: AgentChatEventEnvelope, sequence: number): string {
  return `${envelope.sessionId}:${sequence}:${envelope.timestamp}`;
}

export function buildTextRenderKey(event: Extract<AgentChatEvent, { type: "text" }>, envelope: AgentChatEventEnvelope, sequence: number): string {
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
  const connectorLabel = event.mcp?.appContext?.appName ?? event.mcp?.pluginId ?? event.mcp?.server;
  const connectorAction = event.mcp?.appContext?.actionName ?? event.mcp?.tool;
  const collapseKey = buildCollapseKey("tool", event);
  return {
    type: "work_log_entry",
    collapseKey,
    entry: withLocalhostUrls({
      id: buildWorkLogEntryId(collapseKey, event),
      createdAt: timestamp,
      label: connectorLabel ?? resolvedToolName,
      tone: deriveTone(status, "tool"),
      status,
      entryKind: "tool",
      toolName: resolvedToolName,
      ...(event.mcp ? { mcp: event.mcp } : {}),
      ...(connectorAction
        ? { detail: connectorAction }
        : titleFallback && titleFallback !== resolvedToolName ? { detail: titleFallback } : {}),
      ...(event.type === "tool_call" ? { args: event.args } : {}),
      ...(event.type === "tool_result" ? { result: event.result } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
    }),
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
    entry: withLocalhostUrls({
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
    }),
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

export type WebSearchResultDisplay = {
  /** Openable http(s) URL, or null when the result carries no usable link. */
  href: string | null;
  /** Title, falling back to the domain, then the raw URL. */
  title: string;
  /** Host (www-stripped) shown subtly next to the title when it differs from it. */
  domain: string | null;
};

/**
 * Normalize a structured web-search result into the fields the transcript rows
 * render: an openable href, a primary title (title → domain → url), and the
 * domain to show subtly beside the title. Pure so both renderers stay in step.
 */
export function deriveWebSearchResultDisplay(result: CodexWebSearchResult): WebSearchResultDisplay {
  const url = result.url?.trim() ?? "";
  let domain: string | null = null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        domain = parsed.hostname.replace(/^www\./i, "");
      }
    } catch {
      // Non-URL text falls through to the raw-string fallback below.
    }
  }
  const title = result.title?.trim() || domain || url || "Result";
  return {
    href: url.length ? url : null,
    title,
    domain: domain && domain !== title ? domain : null,
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
      ...(event.actions?.length ? { actions: event.actions } : {}),
      ...(event.results?.length ? { results: event.results } : {}),
      ...(typeof event.resultsTotal === "number" ? { resultsTotal: event.resultsTotal } : {}),
      tone: deriveTone(event.status, "info"),
      status: event.status,
      entryKind: "web_search",
      ...(event.itemId ? { itemId: event.itemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    },
  };
}

function buildHookErrorWorkLogEvent(
  event: Extract<AgentChatEvent, { type: "system_notice" }>,
  timestamp: string,
  sequence: number,
  summary: string,
): WorkLogRenderEvent {
  const detail = eventHasPayload(event.detail) ? formatStructuredValue(event.detail) : undefined;
  return {
    type: "work_log_entry",
    entry: withLocalhostUrls({
      id: ["hook-error", event.turnId ?? "no-turn", sequence, summary].join("::"),
      createdAt: timestamp,
      label: "Hook",
      detail: summary,
      ...(detail ? { output: detail } : {}),
      tone: "error",
      status: "failed",
      entryKind: "hook",
      ...(event.turnId ? { turnId: event.turnId } : {}),
    }),
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

  return withLocalhostUrls({
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
  });
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

// ── Subagent lifecycle rows ────────────────────────────────────────────────
// A real subagent renders as exactly TWO rows: a spawn anchor (mutated in place
// as progress arrives) and a result card at the settle position. Background
// shell commands render NO cards — only a single compact finish chip. Keys are
// identity-derived and stable so the virtualizer's measuredHeights survive
// mutation and rebind (load-bearing for sticky-bottom).

function subagentText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function meaningfulProgressSummary(summary: string | null): string | null {
  return summary && !SUBAGENT_PLACEHOLDER_SUMMARY.test(summary) ? summary : null;
}

function subagentSpawnKey(agentKey: string): string {
  return `subagent-spawn:${agentKey}`;
}

function subagentResultKey(agentKey: string): string {
  return `subagent-result:${agentKey}`;
}

function backgroundChipKey(agentKey: string): string {
  return `background-chip:${agentKey}`;
}

type SubagentRowPosition = "rowIndex" | "resultRowIndex" | "chipRowIndex";

function resolveSubagentRowPosition(
  rows: ChatTranscriptRenderEnvelope[],
  state: SubagentAnchorState,
  position: SubagentRowPosition,
  expectedKey: string,
): number | null {
  const storedIndex = state[position];
  if (storedIndex != null && rows[storedIndex]?.key === expectedKey) return storedIndex;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.key !== expectedKey) continue;
    state[position] = index;
    return index;
  }

  state[position] = null;
  return null;
}

function repairSubagentRowPositionsAfterSplice(
  context: CollapseTranscriptContext,
  removedIndex: number,
): void {
  for (const state of new Set(context.subagentAnchors.values())) {
    for (const position of ["rowIndex", "resultRowIndex", "chipRowIndex"] as const) {
      const storedIndex = state[position];
      if (storedIndex === removedIndex) state[position] = null;
      else if (storedIndex != null && storedIndex > removedIndex) state[position] = storedIndex - 1;
    }
  }
}

function durationMsBetween(startedAt: string | null, endedAt: string): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function backgroundExitCode(event: NormalizedSubagentLifecycleEvent): number | null {
  const value = (event as { exitCode?: unknown }).exitCode;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Best-effort parent label from the anchors map — the parent's description or
// agentType. Null when the parent isn't (yet) in the map; renders nothing.
function resolveParentLabel(
  state: SubagentAnchorState,
  anchors: Map<string, SubagentAnchorState>,
): string | null {
  if (!state.parentAgentId) return null;
  const parent = anchors.get(state.parentAgentId);
  const label = parent?.description?.trim() || parent?.agentType?.trim() || null;
  return label;
}

function spawnAnchorEvent(
  state: SubagentAnchorState,
  anchors?: Map<string, SubagentAnchorState>,
): SubagentSpawnAnchorRenderEvent {
  // agentKey mirrors the stable renderKeyBase so the jump affordances derive the
  // same row keys the collapse pass assigned (see subagentSpawnKey/subagentResultKey).
  return {
    type: "subagent_spawn_anchor",
    agentKey: state.renderKeyBase,
    description: state.description ?? "Subagent task",
    agentType: state.agentType,
    background: state.background,
    status: state.status,
    statusLine: state.statusLine,
    lastToolName: state.lastToolName,
    toolCount: state.toolCount,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    childSessionId: state.childSessionId,
    spawnKind: state.spawnKind,
    resultSummary: state.resultSummary,
    parentLabel: anchors ? resolveParentLabel(state, anchors) : null,
  };
}

// The single-line live status (statusLine) always prefers the last MEANINGFUL
// progress summary; "Task updated"/"Status: …" placeholders never displace a
// real one — falling back to lastToolName, then the description.
function computeStatusLine(state: SubagentAnchorState): string | null {
  return meaningfulProgressSummary(state.progressSummary)
    ?? state.lastToolName
    ?? state.description;
}

function enrichSubagentStateFromEvent(
  state: SubagentAnchorState,
  event: NormalizedSubagentLifecycleEvent,
): void {
  const record = event as NormalizedSubagentLifecycleEvent & {
    background?: unknown;
    description?: unknown;
    command?: unknown;
    spawnKind?: unknown;
  };
  state.description = longerSubagentText(state.description, subagentText(record.description));
  state.agentType = preferredSubagentAgentType(state.agentType, subagentText(event.agentType));
  state.taskType = subagentText(event.taskType) ?? state.taskType;
  state.command = longerSubagentText(state.command, subagentText(record.command));
  if (record.background === true) state.background = true;
  // A spawned ADE chat carries a `chat:<id>` taskId; the child session id (for
  // navigation) is the agentId, equivalently taskId.slice("chat:".length).
  const taskId = subagentText(event.taskId);
  if (taskId && taskId.startsWith("chat:") && !state.childSessionId) {
    state.childSessionId = subagentText(event.agentId) ?? (taskId.slice("chat:".length) || null);
  }
  if (typeof record.spawnKind === "string" && (record.spawnKind === "subagent" || record.spawnKind === "peer" || record.spawnKind === "none")) {
    state.spawnKind = record.spawnKind;
  }
  const parentAgentId = subagentText((event as { parentAgentId?: unknown }).parentAgentId);
  if (parentAgentId) state.parentAgentId = parentAgentId;
}

function classificationInput(state: SubagentAnchorState) {
  return {
    taskType: state.taskType,
    agentType: state.agentType,
    command: state.command,
    description: state.description,
  };
}

/**
 * Handle one of the three subagent lifecycle events. Returns true if the event
 * was consumed (caller should stop). Mutates rows and context in place.
 *
 * INVARIANT: this never SPLICES rows — only pushes at the tail or replaces an
 * existing row by its stored index. Every replacement verifies the stable key
 * and repairs a stale position before mutating.
 */
function handleSubagentLifecycleEvent(
  rows: ChatTranscriptRenderEnvelope[],
  event: NormalizedSubagentLifecycleEvent,
  timestamp: string,
  context: CollapseTranscriptContext,
): boolean {
  const anchors = context.subagentAnchors;
  const agentKey = subagentAgentKey(event);
  if (!agentKey) return true;

  const taskId = subagentText(event.taskId);
  const agentId = subagentText(event.agentId);

  // Rebind: an anchor created under a taskId, then a later event carries agentId
  // for the same task. Move the map key but KEEP the original renderKey + rows.
  let state = anchors.get(agentKey)
    ?? (agentId && taskId ? anchors.get(taskId) : undefined);
  if (state && state.agentKey !== agentKey) {
    anchors.delete(state.agentKey);
    state.agentKey = agentKey;
    anchors.set(agentKey, state);
  }
  // Keep the taskId alias pointing at the same state so a taskId-only later event
  // still resolves after rebind.
  if (state && taskId) anchors.set(taskId, state);

  if (!state) {
    state = {
      agentKey,
      renderKeyBase: agentKey,
      rowIndex: null,
      resultRowIndex: null,
      chipRowIndex: null,
      description: null,
      agentType: null,
      taskType: null,
      command: null,
      background: false,
      startedAt: timestamp,
      endedAt: null,
      progressSummary: null,
      statusLine: null,
      lastToolName: null,
      toolCount: null,
      status: "running",
      resultSummary: null,
      error: null,
      childSessionId: null,
      spawnKind: null,
      totalTokens: null,
      toolUseCount: null,
      worktreeBranch: null,
      worktreePath: null,
      parentAgentId: null,
    };
    anchors.set(agentKey, state);
    if (taskId) anchors.set(taskId, state);
  }

  enrichSubagentStateFromEvent(state, event);
  const backgroundShell = isBackgroundShellCommand(classificationInput(state));

  if (event.type === "subagent_started" || event.type === "subagent_progress") {
    if (backgroundShell) return true; // background shell → chip only, no cards
    if (state.rowIndex == null) {
      // First lifecycle → push the spawn anchor and record its index.
      state.status = "running";
      state.statusLine = computeStatusLine(state);
      state.rowIndex = rows.length;
      rows.push({
        key: subagentSpawnKey(state.renderKeyBase),
        timestamp,
        event: spawnAnchorEvent(state, anchors),
      });
    }

    if (event.type === "subagent_progress") {
      state.progressSummary = preferSubagentSummary(state.progressSummary, event.summary);
      const lastToolName = subagentText(event.lastToolName);
      if (lastToolName) state.lastToolName = lastToolName;
      if (typeof event.usage?.toolUses === "number") state.toolCount = event.usage.toolUses;
      if (state.status === "running") state.status = "running";
    }
    state.statusLine = computeStatusLine(state);

    // Mutate the anchor row IN PLACE — a NEW object with the SAME key.
    if (state.rowIndex != null) {
      const expectedKey = subagentSpawnKey(state.renderKeyBase);
      const rowIndex = resolveSubagentRowPosition(rows, state, "rowIndex", expectedKey);
      if (rowIndex != null) {
        rows[rowIndex] = {
          key: expectedKey,
          timestamp,
          event: spawnAnchorEvent(state, anchors),
        };
      }
    }
    return true;
  }

  // subagent_result
  const incomingSummary = preferSubagentSummary(event.summary, event.finalSummary);
  const terminalStatus = event.status;

  if (backgroundShell) {
    const label = backgroundCommandLabel(state.command ?? state.description ?? "")
      || state.command
      || state.description
      || "Background command";
    state.endedAt = timestamp;
    const chipEvent: BackgroundFinishChipRenderEvent = {
      type: "background_finish_chip",
      agentKey: state.renderKeyBase,
      label,
      status: terminalStatus,
      exitCode: backgroundExitCode(event),
      durationMs: durationMsBetween(state.startedAt, timestamp),
      startedAt: state.startedAt,
      endedAt: timestamp,
    };
    if (state.chipRowIndex == null) {
      state.chipRowIndex = rows.length;
      rows.push({ key: backgroundChipKey(state.renderKeyBase), timestamp, event: chipEvent });
    } else {
      const expectedKey = backgroundChipKey(state.renderKeyBase);
      const rowIndex = resolveSubagentRowPosition(rows, state, "chipRowIndex", expectedKey);
      if (rowIndex != null) rows[rowIndex] = { key: expectedKey, timestamp, event: chipEvent };
    }
    return true;
  }

  // Real subagent terminal: flip the anchor + push/mutate the result card.
  state.status = terminalStatus;
  if (event.type === "subagent_result") {
    if (typeof event.totalTokens === "number") state.totalTokens = event.totalTokens;
    if (typeof event.toolUseCount === "number") state.toolUseCount = event.toolUseCount;
    const wb = subagentText(event.worktreeBranch);
    if (wb) state.worktreeBranch = wb;
    const wp = subagentText(event.worktreePath);
    if (wp) state.worktreePath = wp;
  }
  state.endedAt = timestamp;
  state.resultSummary = preferSubagentSummary(state.resultSummary, incomingSummary);
  if (terminalStatus === "failed") {
    state.error = state.resultSummary ?? state.error;
  }

  // Flip the anchor terminal (freezes the live line) if it exists.
  if (state.rowIndex != null) {
    const expectedKey = subagentSpawnKey(state.renderKeyBase);
    const rowIndex = resolveSubagentRowPosition(rows, state, "rowIndex", expectedKey);
    if (rowIndex != null) rows[rowIndex] = { key: expectedKey, timestamp, event: spawnAnchorEvent(state, anchors) };
  }

  const resultEvent: SubagentResultCardRenderEvent = {
    type: "subagent_result_card",
    agentKey: state.renderKeyBase,
    description: state.description,
    status: terminalStatus,
    summaryPreview: state.resultSummary,
    error: terminalStatus === "failed" ? state.error : null,
    startedAt: state.startedAt,
    endedAt: timestamp,
    durationMs: durationMsBetween(state.startedAt, timestamp),
    totalTokens: state.totalTokens,
    toolUseCount: state.toolUseCount,
    worktreeBranch: state.worktreeBranch,
    worktreePath: state.worktreePath,
    parentLabel: resolveParentLabel(state, anchors),
  };
  if (state.resultRowIndex == null) {
    state.resultRowIndex = rows.length;
    rows.push({ key: subagentResultKey(state.renderKeyBase), timestamp, event: resultEvent });
  } else {
    const expectedKey = subagentResultKey(state.renderKeyBase);
    const rowIndex = resolveSubagentRowPosition(rows, state, "resultRowIndex", expectedKey);
    if (rowIndex != null) rows[rowIndex] = { key: expectedKey, timestamp, event: resultEvent };
  }
  return true;
}

export function appendCollapsedChatTranscriptEvent(
  rows: ChatTranscriptRenderEnvelope[],
  envelope: AgentChatEventEnvelope,
  sequence: number,
  context?: CollapseTranscriptContext,
): void {
  const { event } = envelope;

  if (event.type === "user_message") {
    const wake = event.metadata?.scheduledWake;
    if (
      wake
      && typeof wake.scheduleId === "string"
      && (wake.kind === "wakeup" || wake.kind === "cron" || wake.kind === "loop")
      && typeof wake.firedAt === "string"
    ) {
      rows.push({
        key: `scheduled-wake:${wake.scheduleId}:${event.turnId ?? sequence}`,
        timestamp: envelope.timestamp,
        event: {
          type: "scheduled_wake_divider",
          scheduleId: wake.scheduleId,
          kind: wake.kind,
          reason: typeof wake.reason === "string" && wake.reason.trim().length ? wake.reason.trim() : null,
          firedAt: wake.firedAt,
          late: wake.late === true,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    }
    // A spawned `subagent` that finished delivers a `wake` turn carrying a
    // `spawnCompletion` metadata payload — render a distinct "ADE woke this chat"
    // header above the synthetic turn. Read the typed slot; keep runtime guards
    // since transcript payloads arrive off the wire.
    const completion = event.metadata?.spawnCompletion;
    if (completion) {
      const childSessionId = completion.childSessionId?.trim() ?? "";
      const spawnKind = completion.spawnKind === "subagent" || completion.spawnKind === "peer" || completion.spawnKind === "none"
        ? completion.spawnKind
        : null;
      const status = completion.status === "completed" || completion.status === "failed" || completion.status === "stopped"
        ? completion.status
        : null;
      if (childSessionId && spawnKind && status) {
        rows.push({
          key: `spawn-wake:${childSessionId}:${event.turnId ?? sequence}`,
          timestamp: envelope.timestamp,
          event: {
            type: "spawn_wake_divider",
            childSessionId,
            childTitle: completion.childTitle?.trim() || "spawned chat",
            spawnKind,
            status,
            summary: completion.summary?.trim() || null,
            ...(event.turnId ? { turnId: event.turnId } : {}),
          },
        });
      }
    }
  }

  if (event.type === "step_boundary" || event.type === "activity" || event.type === "pending_input_resolved") {
    return;
  }

  // Codex token usage drives the chat-bottom token footer; inline transcript
  // rows would be duplicate noise.
  if (event.type === "codex_token_usage") {
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

  if (event.type === "error" && event.turnId?.trim()) {
    const semanticKey = JSON.stringify([
      event.turnId.trim(),
      event.message.trim(),
      event.detail?.trim() ?? null,
      event.errorInfo ?? null,
    ]);
    if (context?.errorKeysByTurn.has(semanticKey)) return;
    context?.errorKeysByTurn.add(semanticKey);
  }

  if (event.type === "system_notice") {
    if (event.noticeKind === "info" && event.message.trim().toLowerCase() === "session ready") {
      return;
    }
    if (isLowValueHookNotice(event)) {
      return;
    }
    const preToolUseHookError = summarizePreToolUseHookError(event);
    if (preToolUseHookError) {
      appendWorkLogRow(
        rows,
        envelope,
        sequence,
        buildHookErrorWorkLogEvent(event, envelope.timestamp, sequence, preToolUseHookError),
      );
      return;
    }
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

  if (event.type === "transcript_retraction") {
    const retractedIds = new Set(event.messageIds.map((messageId) => messageId.trim()).filter(Boolean));
    if (!retractedIds.size) return;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.event.type === "text" && row.event.messageId && retractedIds.has(row.event.messageId)) {
        rows.splice(index, 1);
        if (context) repairSubagentRowPositionsAfterSplice(context, index);
      }
    }
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
    const snapshotKey = todoSnapshotKey(nextTurn);
    const displayItems = changedTodoItems(context?.latestTodoItemsByTurn.get(snapshotKey), event.items);
    context?.latestTodoItemsByTurn.set(snapshotKey, event.items);
    if (!displayItems.length) return;
    rows.push({
      key: buildRenderKey(envelope, sequence),
      timestamp: envelope.timestamp,
      event: displayItems.length === event.items.length ? event : { ...event, items: displayItems },
    });
    return;
  }

  if (event.type === "plan") {
    const nextTurn = event.turnId ?? null;
    if (nextTurn !== null) {
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
          event: mergePlanTranscriptEvent(rows[actualIndex]!.event as PlanTranscriptEvent, event),
        };
        return;
      }
    }
  }

  // `background_task` scheduled work is owned by the actions pane — never render
  // an in-thread row for it. Other scheduled kinds keep their current behavior.
  if (event.type === "scheduled_work_update" && event.kind === "background_task") {
    return;
  }

  // Subagent lifecycle → two-row spawn/result cards (or a single finish chip for
  // background shell commands). Normalize canonical dotted events first, then
  // fold every lifecycle event into the anchor state (handled BEFORE the generic
  // passthrough so no raw subagent_* row ever reaches the activity bundler).
  if (event.type === "codex_image_generation" || event.type === "codex_image_view") {
    const matchIndex = [...rows]
      .reverse()
      .findIndex((candidate) =>
        candidate.event.type === event.type
        && candidate.event.itemId === event.itemId
        && (candidate.event.turnId ?? null) === (event.turnId ?? null),
      );
    if (matchIndex >= 0) {
      const actualIndex = rows.length - 1 - matchIndex;
      const previous = rows[actualIndex]!;
      if (event.type === "codex_image_generation" && previous.event.type === "codex_image_generation") {
        rows[actualIndex] = {
          ...previous,
          timestamp: envelope.timestamp,
          event: {
            ...previous.event,
            ...event,
            prompt: event.prompt ?? previous.event.prompt,
            revisedPrompt: event.revisedPrompt ?? previous.event.revisedPrompt,
            result: event.result ?? previous.event.result,
            savedPath: event.savedPath ?? previous.event.savedPath,
          },
        };
        return;
      }
      if (event.type === "codex_image_view" && previous.event.type === "codex_image_view") {
        rows[actualIndex] = {
          ...previous,
          timestamp: envelope.timestamp,
          event: {
            ...previous.event,
            ...event,
            path: event.path ?? previous.event.path,
            url: event.url ?? previous.event.url,
            title: event.title ?? previous.event.title,
          },
        };
        return;
      }
    }
  }
  const normalizedSubagentEvent = normalizeSubagentLifecycleEvent(event);
  if (normalizedSubagentEvent) {
    const activeContext = context ?? createCollapseTranscriptContext();
    handleSubagentLifecycleEvent(rows, normalizedSubagentEvent, envelope.timestamp, activeContext);
    return;
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

  if (isContextCompactionChatEvent(event)) {
    const incoming = normalizeContextCompactEvent(event);
    if (!incoming) return;
    const mergeKey = contextCompactMergeKey(incoming);
    const matchIndex = [...rows]
      .reverse()
      .findIndex((candidate) => {
        const candidateEvent = candidate.event;
        if (!isContextCompactionChatEvent(candidateEvent as AgentChatEvent)) return false;
        const existing = normalizeContextCompactEvent(candidateEvent as AgentChatEvent);
        if (!existing) return false;
        if (contextCompactMergeKey(existing) !== mergeKey) return false;
        return existing.state === "started" || incoming.state === "completed";
      });
    if (matchIndex >= 0) {
      const actualIndex = rows.length - 1 - matchIndex;
      const previous = normalizeContextCompactEvent(rows[actualIndex]!.event as AgentChatEvent);
      if (previous) {
        rows[actualIndex] = {
          ...rows[actualIndex]!,
          timestamp: envelope.timestamp,
          event: toContextCompactChatEvent(mergeNormalizedContextCompact(previous, incoming)),
        };
        return;
      }
    }
    rows.push({
      key: `context-compact:${mergeKey}:${sequence}`,
      timestamp: envelope.timestamp,
      event: toContextCompactChatEvent(incoming),
    });
    return;
  }

  rows.push({
    key: event.type === "text" ? buildTextRenderKey(event, envelope, sequence) : buildRenderKey(envelope, sequence),
    timestamp: envelope.timestamp,
    event,
  });
}

/**
 * Result of a collapse pass. The context is opaque to callers except that the
 * incremental path caches it so appended progress/result events can index back
 * into stored row positions (see {@link collapseChatTranscriptEventsIncrementalWithContext}).
 */
export type CollapseTranscriptResult = {
  rows: ChatTranscriptRenderEnvelope[];
  context: CollapseTranscriptContext;
};

export function collapseChatTranscriptEventsWithContext(
  events: AgentChatEventEnvelope[],
): CollapseTranscriptResult {
  const rows: ChatTranscriptRenderEnvelope[] = [];
  const context = createCollapseTranscriptContext();
  for (let index = 0; index < events.length; index += 1) {
    appendCollapsedChatTranscriptEvent(rows, events[index]!, index, context);
  }
  return { rows, context };
}

export function collapseChatTranscriptEvents(events: AgentChatEventEnvelope[]): ChatTranscriptRenderEnvelope[] {
  return collapseChatTranscriptEventsWithContext(events).rows;
}

/**
 * Incremental collapse that carries its {@link CollapseTranscriptContext} so
 * appended progress/result events index back into `previousRows.slice()` and
 * mutate the subagent anchor row by its stored `rowIndex`. Falls back to a fresh
 * full recompute on divergence/shrink/todo (those rebuild the context). Retraction
 * splices repair the carried positions. The full-recompute path MUST produce identical output
 * to the incremental path (guarded by a parity test).
 */
export function collapseChatTranscriptEventsIncrementalWithContext(
  events: AgentChatEventEnvelope[],
  previousEvents: AgentChatEventEnvelope[],
  previousRows: ChatTranscriptRenderEnvelope[],
  previousContext: CollapseTranscriptContext | null,
): CollapseTranscriptResult {
  if (!previousEvents.length || events.length < previousEvents.length || !previousContext) {
    return collapseChatTranscriptEventsWithContext(events);
  }

  if (events[previousEvents.length - 1] !== previousEvents[previousEvents.length - 1]) {
    return collapseChatTranscriptEventsWithContext(events);
  }

  if (events.slice(previousEvents.length).some((envelope) => envelope.event.type === "todo_update")) {
    return collapseChatTranscriptEventsWithContext(events);
  }

  const rows = previousRows.slice();
  for (let index = previousEvents.length; index < events.length; index += 1) {
    appendCollapsedChatTranscriptEvent(rows, events[index]!, index, previousContext);
  }
  return { rows, context: previousContext };
}

export function collapseChatTranscriptEventsIncremental(
  events: AgentChatEventEnvelope[],
  previousEvents: AgentChatEventEnvelope[],
  previousRows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptRenderEnvelope[] {
  // Legacy signature (no carried context): recompute a context from the previous
  // events so appended subagent lifecycle rows still resolve their anchors.
  const previousContext = previousEvents.length
    ? collapseChatTranscriptEventsWithContext(previousEvents).context
    : null;
  return collapseChatTranscriptEventsIncrementalWithContext(
    events,
    previousEvents,
    previousRows,
    previousContext,
  ).rows;
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

    if (isActivityBundleSourceEvent(row.event)) {
      const items: ChatActivityBundleItem[] = [];
      const baseTurnId = activityBundleTurnId(row.event);
      let cursor = index;
      while (cursor < rows.length) {
        const candidate = rows[cursor]!;
        if (!isActivityBundleSourceEvent(candidate.event)) break;
        const candidateEvent = candidate.event;
        const candidateTurnId = activityBundleTurnId(candidateEvent);
        if (items.length > 0 && (!baseTurnId || !candidateTurnId || baseTurnId !== candidateTurnId)) break;
        items.push({
          key: candidate.key,
          timestamp: candidate.timestamp,
          event: candidateEvent,
        });
        cursor += 1;
      }
      grouped.push({
        key: `activity:${row.key}`,
        timestamp: rows[cursor - 1]!.timestamp,
        event: {
          type: "activity_bundle",
          items,
          turnId: baseTurnId,
        },
      });
      index = cursor;
      continue;
    }

    // Group consecutive reasoning events into a single merged reasoning event
    if (row.event.type === "reasoning") {
      let mergedText = (row.event as any).text ?? "";
      let mergedStartTimestamp = (row.event as any).startTimestamp ?? row.timestamp;
      let cursor = index + 1;
      while (cursor < rows.length && rows[cursor]!.event.type === "reasoning") {
        const nextReasoning = rows[cursor]!.event as any;
        const sameBlock =
          (nextReasoning.turnId ?? null) === ((row.event as any).turnId ?? null)
          && (nextReasoning.itemId ?? null) === ((row.event as any).itemId ?? null)
          && (nextReasoning.summaryIndex ?? null) === ((row.event as any).summaryIndex ?? null);
        if (!sameBlock) break;
        mergedText += "\n\n---\n\n" + (nextReasoning.text ?? "");
        cursor += 1;
      }
      if (cursor > index + 1) {
        // Multiple consecutive reasoning events — merge them
        const lastRow = rows[cursor - 1]!;
        grouped.push({
          key: `reasoning-group:${row.key}`,
          timestamp: lastRow.timestamp,
          event: {
            ...row.event,
            text: mergedText,
            startTimestamp: mergedStartTimestamp,
          } as any,
        });
        index = cursor;
        continue;
      }
    }

    // Deduplicate consecutive status events with the same turnStatus
    if (row.event.type === "status") {
      const prev = grouped[grouped.length - 1];
      if (
        prev
        && prev.event.type === "status"
        && (prev.event as any).turnStatus === (row.event as any).turnStatus
        && ((prev.event as any).turnId ?? null) === ((row.event as any).turnId ?? null)
        && ((prev.event as any).message ?? "") === ((row.event as any).message ?? "")
      ) {
        // Keep the later one (replace the previous)
        grouped[grouped.length - 1] = row;
        index += 1;
        continue;
      }
    }

    grouped.push(row);
    index += 1;
  }

  return consolidateInterruptedTerminus(grouped);
}

function isActivityBundleSourceEvent(event: ChatTranscriptRenderEvent): event is ChatActivityBundleItem["event"] {
  // Subagent lifecycle events now render as dedicated spawn/result/chip rows and
  // never reach here. `background_task` scheduled work is dropped in the collapse
  // pass (the actions pane owns it); other scheduled kinds keep bundling.
  return event.type === "todo_update"
    || (event.type === "scheduled_work_update" && event.kind !== "background_task");
}

function activityBundleTurnId(event: ChatActivityBundleItem["event"]): string | null {
  return "turnId" in event ? event.turnId ?? null : null;
}

function classifyActivityPhaseRow(
  row: ChatTranscriptGroupedEnvelope,
): { kind: "reasoning" | "work"; turnId: string | null } | null {
  if (row.event.type === "reasoning") {
    return { kind: "reasoning", turnId: (row.event as RenderReasoningEvent).turnId ?? null };
  }
  if (row.event.type === "work_log_group") {
    return { kind: "work", turnId: row.event.turnId ?? row.event.entries[0]?.turnId ?? null };
  }
  return null;
}

function mergeActivityPhaseRows(
  phase: readonly ChatTranscriptGroupedEnvelope[],
  meta: ActivityPhaseMergeMeta,
): ChatTranscriptGroupedEnvelope[] {
  const reasoningRows = phase.filter((row) => row.event.type === "reasoning");
  const workRows = phase.filter((row) => row.event.type === "work_log_group");
  const merged: ChatTranscriptGroupedEnvelope[] = [];

  const pushReasoning = () => {
    if (reasoningRows.length === 0) return;
    if (reasoningRows.length === 1) {
      merged.push(reasoningRows[0]!);
      return;
    }
    const first = reasoningRows[0]!;
    const last = reasoningRows[reasoningRows.length - 1]!;
    const mergedText = mergeReasoningTextFragments(
      reasoningRows.map((row) => (row.event as RenderReasoningEvent).text ?? ""),
    );
    merged.push({
      key: `activity-phase-reasoning:${first.key}`,
      timestamp: last.timestamp,
      event: {
        ...(first.event as RenderReasoningEvent),
        text: mergedText,
        startTimestamp: (first.event as RenderReasoningEvent).startTimestamp ?? first.timestamp,
      },
    });
  };

  const pushWork = () => {
    if (workRows.length === 0) return;
    if (workRows.length === 1) {
      merged.push(workRows[0]!);
      return;
    }
    const first = workRows[0]!;
    const last = workRows[workRows.length - 1]!;
    const entries = workRows.flatMap((row) => (row.event.type === "work_log_group" ? row.event.entries : []));
    const summary = [...workRows]
      .reverse()
      .map((row) => (row.event.type === "work_log_group" ? row.event.summary?.trim() : ""))
      .find((value) => value && value.length > 0);
    const toolUseIds = [...new Set(workRows.flatMap((row) => (
      row.event.type === "work_log_group" ? row.event.toolUseIds ?? [] : []
    )))];
    merged.push({
      key: `activity-phase-work:${first.key}`,
      timestamp: last.timestamp,
      event: {
        type: "work_log_group",
        entries,
        turnId: first.event.type === "work_log_group"
          ? first.event.turnId ?? first.event.entries[0]?.turnId ?? null
          : null,
        ...(summary ? { summary } : {}),
        ...(toolUseIds.length > 0 ? { toolUseIds } : {}),
      },
    });
  };

  if (meta.workFirst) {
    pushWork();
    pushReasoning();
  } else {
    pushReasoning();
    pushWork();
  }
  return merged;
}

export function collapseGroupedActivityPhaseRows(
  rows: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  return collapseActivityPhaseRows(rows, classifyActivityPhaseRow, mergeActivityPhaseRows);
}

export function groupChatTranscriptRows(
  rows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  return groupStoppedSubagentResultCards(
    collapseGroupedActivityPhaseRows(groupConsecutiveWorkLogRows(rows)),
  );
}

// A `stopped` terminal status is only ever emitted when the user interrupts a
// turn (see stopActiveClaudeSubagents — it settles every live subagent with
// status "stopped" + summary "Interrupted"). So a stopped result card is always
// an interrupt casualty carrying no summary the user needs to read individually.
function isInterruptStoppedResultCard(
  event: ChatTranscriptGroupedEnvelope["event"],
): event is SubagentResultCardRenderEvent {
  return event.type === "subagent_result_card" && event.status === "stopped";
}

// Fold a run of 2+ consecutive interrupt-stopped result cards into one compact
// `subagent_stopped_group` card. Completed/failed cards (which carry real
// summaries) and a lone stopped card stay individual. The group key is derived
// from the first agent so it stays stable across the virtualizer's re-renders.
function groupStoppedSubagentResultCards(
  rows: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  const result: ChatTranscriptGroupedEnvelope[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (!isInterruptStoppedResultCard(row.event)) {
      result.push(row);
      index += 1;
      continue;
    }

    let end = index;
    while (end < rows.length && isInterruptStoppedResultCard(rows[end]!.event)) end += 1;
    const run = rows.slice(index, end);
    index = end;

    if (run.length < 2) {
      // A single lone stopped result stays a normal result card (no group of one).
      result.push(run[0]!);
      continue;
    }

    const items: SubagentStoppedGroupItem[] = run.map((entry) => {
      const event = entry.event as SubagentResultCardRenderEvent;
      return {
        agentKey: event.agentKey,
        title: event.description?.trim() || "Subagent task",
        jumpToStartRowKey: subagentSpawnKey(event.agentKey),
      };
    });
    const firstAgentKey = (run[0]!.event as SubagentResultCardRenderEvent).agentKey;
    const lastInRun = run[run.length - 1]!;
    result.push({
      key: `subagent-stopped-group:${firstAgentKey}`,
      timestamp: lastInRun.timestamp,
      event: { type: "subagent_stopped_group", count: run.length, items },
    });
  }
  return result;
}

// Collapse consecutive interrupted/failed status + done rows (parent turn + N subagents)
// into a single done row. Cancellation in chats with subagents otherwise produces a stack of
// near-duplicate INTERRUPTED + USAGE rows; this folds them into one summary line.
function consolidateInterruptedTerminus(
  rows: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  const isTerminus = (env: ChatTranscriptGroupedEnvelope): boolean => {
    const e = env.event;
    if (e.type === "status" && (e.turnStatus === "interrupted" || e.turnStatus === "failed")) {
      return true;
    }
    if (e.type === "done" && (e.status === "interrupted" || e.status === "failed")) {
      return true;
    }
    return false;
  };

  const result: ChatTranscriptGroupedEnvelope[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (!isTerminus(row)) {
      result.push(row);
      index += 1;
      continue;
    }

    let end = index;
    while (end < rows.length && isTerminus(rows[end]!)) end += 1;
    const cluster = rows.slice(index, end);
    index = end;

    const doneEvents = cluster
      .map((entry) => entry.event)
      .filter((event): event is Extract<AgentChatEvent, { type: "done" }> => event.type === "done");

    // Only consolidate clusters that include at least one done event — that's the noisy
    // cancellation pattern. Pure-status clusters keep their existing behavior so legitimately
    // distinct signals (e.g. failed + interrupted) remain visible.
    if (doneEvents.length === 0 || cluster.length === 1) {
      for (const entry of cluster) result.push(entry);
      continue;
    }

    const sumOptional = (...values: Array<number | null | undefined>): number | undefined => {
      let total = 0;
      let any = false;
      for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value)) {
          total += value;
          any = true;
        }
      }
      return any ? total : undefined;
    };

    const base = doneEvents.reduce((best, candidate) => {
      const bestTokens = (best.usage?.inputTokens ?? 0) + (best.usage?.outputTokens ?? 0);
      const candidateTokens = (candidate.usage?.inputTokens ?? 0) + (candidate.usage?.outputTokens ?? 0);
      return candidateTokens > bestTokens ? candidate : best;
    }, doneEvents[0]!);

    const inputTokens = sumOptional(...doneEvents.map((event) => event.usage?.inputTokens ?? null));
    const outputTokens = sumOptional(...doneEvents.map((event) => event.usage?.outputTokens ?? null));
    const cacheReadTokens = sumOptional(...doneEvents.map((event) => event.usage?.cacheReadTokens ?? null));
    const cacheCreationTokens = sumOptional(...doneEvents.map((event) => event.usage?.cacheCreationTokens ?? null));
    const costUsd = sumOptional(...doneEvents.map((event) => event.costUsd ?? null));
    const status = doneEvents.some((event) => event.status === "failed") ? "failed" : "interrupted";
    const subagentStoppedCount = doneEvents.length - 1;

    const lastInCluster = cluster[cluster.length - 1]!;
    result.push({
      key: `terminus:${lastInCluster.key}`,
      timestamp: lastInCluster.timestamp,
      event: {
        ...base,
        status,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        },
        costUsd,
        subagentStoppedCount: subagentStoppedCount > 0 ? subagentStoppedCount : undefined,
      },
    });
  }

  return result;
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
