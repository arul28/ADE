import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
} from "../../../desktop/src/shared/types/chat";
import { readRecord, summarizeInlineText } from "../../../desktop/src/renderer/components/chat/chatTranscriptRows";
import { replaceInternalToolNames } from "../../../desktop/src/renderer/components/chat/toolPresentation";
import type { LocalNotice } from "./types";
import {
  chatEventLineId,
  parseAssistantMarkdown,
  renderChatLines,
  type RenderedChatLine,
} from "./format";
import { workEventItemId, workEventParentItemId } from "./workEventIds";
import { appendStreamingText, shouldMergeAssistantText } from "./assistantTextIdentity";

export type WorkToolStatus = "running" | "ok" | "failed";

export type ToolCallEntry = {
  itemId: string;
  tool: string;
  arg: string;
  status: WorkToolStatus;
  durationMs?: number;
};

export type FileChangeEntry = {
  itemId: string;
  path: string;
  kind: string;
  status: WorkToolStatus;
  additions: number;
  deletions: number;
  deleted?: boolean;
};

export type RuntimeActivityEntry = {
  id: string;
  label: string;
  detail?: string;
  status: WorkToolStatus | "info";
};

export type PlanStep = {
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export type PendingSteer = {
  steerId: string;
  text: string;
};

export type AggregatedBlock =
  | { kind: "user-bubble"; id: string; line: RenderedChatLine }
  | { kind: "assistant-text"; id: string; line: RenderedChatLine; precededByHeavy?: boolean }
  | { kind: "reasoning"; id: string; turnId: string | null; text: string; live: boolean }
  | { kind: "tool-calls-group"; id: string; turnId: string | null; entries: ToolCallEntry[]; live: boolean; durationMs?: number }
  | { kind: "files-changed-group"; id: string; turnId: string | null; entries: FileChangeEntry[]; live: boolean; durationMs?: number }
  | { kind: "runtime-activity"; id: string; turnId: string | null; entries: RuntimeActivityEntry[]; live: boolean }
  | { kind: "compaction"; id: string; turnId: string | null; trigger: "manual" | "auto"; live: boolean; preTokens?: number }
  | { kind: "queued-steer"; id: string; turnId: string | null; steerId: string; text: string }
  | { kind: "plan"; id: string; turnId: string | null; steps: PlanStep[]; current: number; total: number; live: boolean }
  | { kind: "approval"; id: string; line: RenderedChatLine }
  | { kind: "error"; id: string; line: RenderedChatLine }
  | { kind: "notice"; id: string; line: RenderedChatLine };

function turnIdOf(event: AgentChatEvent): string | null {
  return (event as { turnId?: string }).turnId ?? null;
}

type AssistantTextEvent = Extract<AgentChatEvent, { type: "text" }>;

// Identity logic now lives in the shared assistantTextIdentity module so the
// buffer-level delta coalescer (app.tsx) and the render-line coalescer
// (format.ts) decide message membership identically.
const shouldMergeAssistantTextEvents = shouldMergeAssistantText;

function safeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function validDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function workItemKey(turnId: string | null, itemId: string): string {
  return `${turnId ?? ""}:${itemId}`;
}

// ── Desktop-parity tool line derivation ─────────────────────────────────────
// The desktop work log renders each tool call as `glyph slug target` (see
// ChatWorkLogBlock's ToolCallRow + entryArgText). Mirror that here so the TUI
// transcript reads identically for Codex / Cursor / OpenCode / Droid chats.

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

/** Desktop's workLogEntryKindSlug, applied to a tool name. */
function toolSlug(toolName: string): string {
  let raw = toolName.trim();
  if (!raw) return "tool";
  if (raw.includes(".")) raw = raw.split(".").pop() ?? raw;
  if (raw.includes("__")) raw = raw.split("__").pop() ?? raw;
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();
  if (snake === "exec_command") return "shell";
  return snake;
}

// Mirrors the getTarget extractors in desktop chatToolAppearance: nearly every
// tool's "target" is the first non-empty of a fixed key list.
const TOOL_TARGET_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "pattern",
  "command",
  "cmd",
  "query",
  "url",
  "question",
  "name",
  "workerId",
  "to",
  "role",
  "ref",
  // Subagent-style tools (Task / spawn_agent / delegate_*) carry their task
  // text here; only consulted when none of the precise keys above match.
  "description",
  "task",
  "message",
] as const;

function toolTargetText(args: unknown): string | null {
  const record = readRecord(args);
  if (!record) return null;
  for (const key of TOOL_TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function toolArgPreview(toolName: string, args: unknown): string {
  const target = toolTargetText(args);
  if (target) return replaceInternalToolNames(summarizeInlineText(target, 140));
  const title = readToolTitle(args);
  if (title && title !== toolName) return replaceInternalToolNames(summarizeInlineText(title, 140));
  return "";
}

function diffStats(diff: string): { additions: number; deletions: number } {
  const lines = diff.split(/\r?\n/);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (/^\+[^+]/.test(line)) additions += 1;
    else if (/^-[^-]/.test(line)) deletions += 1;
  }
  return { additions, deletions };
}

// Cross-group tool entry resolution (desktop appendWorkLogRow parity): a
// tool's lifecycle events collapse into ONE entry keyed by turn+item no matter
// how many assistant-text blocks interleave between the call and its result.
// `get` resolves the existing entry wherever it lives (possibly in an earlier
// tool-calls-group of the same turn); `add` appends a brand-new entry to the
// current trailing group. Without this, Claude's interleaved streams left
// every call stuck "running" and re-added its result as a duplicate "ok" row.
type ToolEntryRegistry = {
  get(itemId: string): ToolCallEntry | undefined;
  add(entry: ToolCallEntry): void;
};

function appendToolCallEvent(
  registry: ToolEntryRegistry,
  event: Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>,
  durationMs?: number,
): void {
  // Desktop parity: generic identifiers ("tool" / "other") fall back to the
  // title carried in the payload (readToolTitle in chatTranscriptRows).
  const payload = event.type === "tool_call" ? event.args : event.result;
  const titleFallback = readToolTitle(payload);
  const resolvedToolName = isGenericToolIdentifier(event.tool) && titleFallback ? titleFallback : event.tool;
  if (event.type === "tool_call") {
    const existing = registry.get(event.itemId);
    if (existing) {
      if (isGenericToolIdentifier(existing.tool) && !isGenericToolIdentifier(resolvedToolName)) {
        existing.tool = toolSlug(resolvedToolName);
      }
      if (!existing.arg) existing.arg = toolArgPreview(resolvedToolName, event.args);
      return;
    }
    registry.add({
      itemId: event.itemId,
      tool: toolSlug(resolvedToolName),
      arg: toolArgPreview(resolvedToolName, event.args),
      status: "running",
    });
    return;
  }
  const existing = registry.get(event.itemId);
  const status: WorkToolStatus = event.status === "failed" ? "failed" : event.status === "running" ? "running" : "ok";
  if (existing) {
    existing.status = status;
    if (isGenericToolIdentifier(existing.tool) && !isGenericToolIdentifier(resolvedToolName)) {
      existing.tool = toolSlug(resolvedToolName);
    }
    if (durationMs !== undefined) existing.durationMs = durationMs;
    return;
  }
  registry.add({
    itemId: event.itemId,
    tool: toolSlug(resolvedToolName),
    arg: toolArgPreview(resolvedToolName, payload),
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
}

function appendWebSearchEvent(
  registry: ToolEntryRegistry,
  event: Extract<AgentChatEvent, { type: "web_search" }>,
): void {
  // Desktop groups web_search lifecycle events with the other tool calls
  // (buildWebSearchWorkLogEvent): label "search", target = query.
  const itemId = (event as { itemId?: string }).itemId ?? `web-search:${event.query}`;
  const status: WorkToolStatus = event.status === "failed" ? "failed" : event.status === "running" ? "running" : "ok";
  const arg = summarizeInlineText(event.query ?? "", 140);
  const existing = registry.get(itemId);
  if (existing) {
    existing.status = status;
    if (arg) existing.arg = arg;
    return;
  }
  registry.add({ itemId, tool: "search", arg, status });
}

function appendFileChangeEvent(
  block: Extract<AggregatedBlock, { kind: "files-changed-group" }>,
  event: Extract<AgentChatEvent, { type: "file_change" }>,
): void {
  const status: WorkToolStatus = event.status === "failed" ? "failed" : event.status === "running" ? "running" : "ok";
  const { additions, deletions } = diffStats(event.diff);
  const deleted = event.kind === "delete" || (additions === 0 && deletions === 0 && event.diff.length === 0);
  const existing = block.entries.find((entry) => entry.itemId === event.itemId);
  if (existing) {
    existing.status = status;
    existing.path = event.path;
    existing.kind = event.kind;
    existing.additions = additions;
    existing.deletions = deletions;
    if (deleted) existing.deleted = true;
    return;
  }
  const entry: FileChangeEntry = {
    itemId: event.itemId,
    path: event.path,
    kind: event.kind,
    status,
    additions,
    deletions,
  };
  if (deleted) entry.deleted = true;
  block.entries.push(entry);
}

// Most shell commands arrive wrapped in a launcher (`/bin/zsh -lc "actual"`,
// `bash -c 'actual'`, `sh -c "actual"`). Strip it so the user sees the actual
// command in the tool list — the launcher prefix is pure noise in every entry.
function stripShellLauncher(command: string): string {
  const match = /^(?:\/[\w./-]+\/)?(?:zsh|bash|sh)\s+-[\w]*c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  if (match && typeof match[2] === "string") return match[2];
  return command;
}

function appendCommandAsTool(
  registry: ToolEntryRegistry,
  event: Extract<AgentChatEvent, { type: "command" }>,
  derivedDurationMs?: number,
): void {
  const failed = event.status === "failed" || (event.exitCode ?? 0) !== 0;
  const status: WorkToolStatus = event.status === "running" ? "running" : failed ? "failed" : "ok";
  const durationMs = validDurationMs(event.durationMs) ?? validDurationMs(derivedDurationMs);
  const cleanCommand = summarizeInlineText(stripShellLauncher(event.command), 140);
  const existing = registry.get(event.itemId);
  if (existing) {
    existing.status = status;
    existing.arg = cleanCommand;
    if (durationMs !== undefined) existing.durationMs = durationMs;
    return;
  }
  registry.add({
    itemId: event.itemId,
    tool: "shell",
    arg: cleanCommand,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
}

// Reasoning rows render a ≤96-char preview; keep enough head text for that
// (and a margin for whitespace collapsing) without retaining whole streams.
const REASONING_TEXT_CAP = 2_000;

function isExpandedFailureEvent(event: AgentChatEvent): boolean {
  if (event.type === "tool_result") return event.status === "failed";
  if (event.type === "file_change") return event.status === "failed";
  if (event.type === "command") return event.status === "failed" || (event.exitCode ?? 0) !== 0;
  return false;
}

function findLastBlock<K extends AggregatedBlock["kind"]>(
  blocks: AggregatedBlock[],
  kind: K,
  turnId: string | null,
): Extract<AggregatedBlock, { kind: K }> | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const candidate = blocks[index]!;
    if (candidate.kind !== kind) continue;
    const candidateTurn = (candidate as { turnId?: string | null }).turnId ?? null;
    if (candidateTurn !== turnId) continue;
    return candidate as Extract<AggregatedBlock, { kind: K }>;
  }
  return null;
}

function findCompactionBlockForCompletion(
  blocks: AggregatedBlock[],
  turnId: string | null,
): Extract<AggregatedBlock, { kind: "compaction" }> | null {
  const exact = findLastBlock(blocks, "compaction", turnId);
  if (exact) return exact;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const candidate = blocks[index]!;
    if (candidate.kind === "compaction" && candidate.live) return candidate;
  }
  return null;
}

function isLiveTurnBlock(
  block: AggregatedBlock,
): block is Extract<AggregatedBlock, { kind: "tool-calls-group" | "files-changed-group" | "runtime-activity" | "plan" | "compaction" | "reasoning" }> {
  return block.kind === "tool-calls-group"
    || block.kind === "files-changed-group"
    || block.kind === "runtime-activity"
    || block.kind === "plan"
    || block.kind === "compaction"
    || block.kind === "reasoning";
}

function finishTurnBlocks(blocks: AggregatedBlock[], turnId: string | null): void {
  for (const block of blocks) {
    const blockTurn = (block as { turnId?: string | null }).turnId ?? null;
    if (blockTurn === turnId && isLiveTurnBlock(block)) {
      block.live = false;
    }
  }
}

// Event types that have already contributed to aggregate-level blocks or are
// intentionally hidden. Keep unmatched system_notice events visible.
const SILENCED_EVENT_TYPES = new Set<AgentChatEvent["type"]>([
  "tool_call",
  "tool_result",
  "command",
  "file_change",
  "web_search",
  "reasoning",
  "plan",
  "done",
  "user_message",
  "text",
  "approval_request",
  "error",
  "tokens",
  "codex_token_usage",
  "codex_goal_updated",
  "codex_goal_cleared",
  "pending_input_resolved",
  // Droid AGI mission lifecycle drives the Missions section in the chat-info
  // pane (see chatMission), not the transcript — keep it out of the timeline.
  "mission_state",
  "mission_features",
  "mission_progress",
]);

function isSubagentTimelineEvent(event: AgentChatEvent): boolean {
  const type = String((event as { type?: unknown }).type ?? "");
  return type === "subagent_started"
    || type === "subagent_progress"
    || type === "subagent_result"
    || type === "subagent.started"
    || type === "subagent.progress"
    || type === "subagent.completed"
    || type === "teammate.idle"
    || type === "task.completed";
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compactActivityDetail(value: unknown, max = 70): string | undefined {
  const text = stringField(value);
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

// Activity events that mirror the real tool/command/file events the transcript
// already renders. Suppress them in the TUI so the same fragment doesn't appear
// twice (once as Runtime, once as Tool calls). Matches desktop suppression.
// "spawning_agent" is covered by the subagent roster (chat-info pane), exactly
// like the subagent lifecycle events the timeline also drops.
const suppressedRuntimeActivities = new Set([
  "thinking",
  "working",
  "tool_calling",
  "searching",
  "reading",
  "running_command",
  "editing_file",
  "web_searching",
  "spawning_agent",
]);

function runtimeActivityFromEvent(id: string, event: AgentChatEvent): RuntimeActivityEntry | null {
  if (event.type === "activity") {
    const activity = event.activity;
    if (suppressedRuntimeActivities.has(activity)) return null;
    return {
      id,
      label: activity.replace(/_/g, " "),
      detail: compactActivityDetail(event.detail),
      status: "running",
    };
  }
  return null;
}

function appendRuntimeActivityBlock(
  blocks: AggregatedBlock[],
  id: string,
  turnId: string | null,
  entry: RuntimeActivityEntry,
): void {
  const last = blocks[blocks.length - 1];
  let block: Extract<AggregatedBlock, { kind: "runtime-activity" }>;
  if (last && last.kind === "runtime-activity" && last.turnId === turnId) {
    block = last;
  } else {
    block = { kind: "runtime-activity", id, turnId, entries: [], live: true };
    blocks.push(block);
  }
  const previous = block.entries[block.entries.length - 1];
  if (previous && previous.label === entry.label && previous.detail === entry.detail && previous.status === entry.status) {
    return;
  }
  block.entries.push(entry);
  if (block.entries.length > 8) block.entries.splice(0, block.entries.length - 8);
}

function subagentParentItemId(event: AgentChatEvent): string | null {
  if (!isSubagentTimelineEvent(event)) return null;
  return stringField((event as { parentToolUseId?: unknown }).parentToolUseId);
}

function isSubagentChildWorkEvent(
  event: AgentChatEvent,
  subagentParentItemIds: ReadonlySet<string>,
  subagentChildItemIds: ReadonlySet<string>,
): boolean {
  const parentItemId = workEventParentItemId(event);
  if (parentItemId && subagentParentItemIds.has(parentItemId)) return true;
  const itemId = workEventItemId(event);
  return itemId != null && subagentChildItemIds.has(itemId);
}

type SteerLifecycleNotice = Extract<AgentChatEvent, { type: "system_notice" }> & {
  steerId: string;
  message: string;
};

function isSteerLifecycleNotice(event: AgentChatEvent): event is SteerLifecycleNotice {
  const message = event.type === "system_notice" ? event.message.trim().toLowerCase() : "";
  return event.type === "system_notice"
    && Boolean(event.steerId)
    && (
      message === "message queued"
      || message === "delivering queued message"
      || message === "queued message cancelled"
    );
}

export function derivePendingSteers(events: AgentChatEventEnvelope[]): PendingSteer[] {
  const steerMap = new Map<string, PendingSteer>();
  const resolvedSteerIds = new Set<string>();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "user_message" && event.steerId) {
      if (event.deliveryState === "queued") {
        if (!resolvedSteerIds.has(event.steerId)) {
          steerMap.set(event.steerId, { steerId: event.steerId, text: event.displayText ?? event.text });
        }
      } else {
        steerMap.delete(event.steerId);
        resolvedSteerIds.add(event.steerId);
      }
      continue;
    }
    if (isSteerLifecycleNotice(event) && event.message.trim().toLowerCase() !== "message queued") {
      steerMap.delete(event.steerId);
      resolvedSteerIds.add(event.steerId);
    }
  }
  return Array.from(steerMap.values());
}

export function aggregateChatBlocks(args: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  maxBlocks?: number;
}): AggregatedBlock[] {
  const lines = renderChatLines({
    events: args.events,
    notices: args.notices,
    activeSession: args.activeSession,
    expandedLineIds: args.expandedLineIds,
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const linesById = new Map<string, RenderedChatLine>();
  for (const line of lines) linesById.set(line.id, line);

  const blocks: AggregatedBlock[] = [];
  const pendingSteerIds = new Set(derivePendingSteers(args.events).map((steer) => steer.steerId));
  const subagentParentItemIds = new Set<string>();
  for (const envelope of args.events) {
    const parentItemId = subagentParentItemId(envelope.event);
    if (parentItemId) subagentParentItemIds.add(parentItemId);
  }
  const subagentChildItemIds = new Set<string>();
  if (subagentParentItemIds.size > 0) {
    for (const envelope of args.events) {
      const parentItemId = workEventParentItemId(envelope.event);
      const itemId = workEventItemId(envelope.event);
      if (parentItemId && itemId && subagentParentItemIds.has(parentItemId)) {
        subagentChildItemIds.add(itemId);
      }
    }
  }

  type TimelineEntry =
    | { kind: "event"; timestamp: number; index: number; envelope: AgentChatEventEnvelope }
    | { kind: "notice"; timestamp: number; index: number; notice: LocalNotice };

  const timeline: TimelineEntry[] = [
    ...args.events.map((envelope, index): TimelineEntry => ({
      kind: "event",
      timestamp: safeMs(envelope.timestamp),
      index,
      envelope,
    })),
    ...args.notices.map((notice, index): TimelineEntry => ({
      kind: "notice",
      timestamp: safeMs(notice.timestamp),
      index,
      notice,
    })),
  ].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.kind !== b.kind) return a.kind === "event" ? -1 : 1;
    return a.index - b.index;
  });

  const passthrough = (id: string, kind: "user-bubble" | "assistant-text" | "approval" | "error" | "notice"): void => {
    const line = linesById.get(id);
    if (!line) return;
    blocks.push({ kind, id, line } as AggregatedBlock);
  };
  const workItemStartedAt = new Map<string, number>();
  // turnId:itemId → live entry reference, so a tool's later lifecycle events
  // resolve the SAME entry even when assistant text split the visual groups.
  const toolEntryByItemKey = new Map<string, ToolCallEntry>();
  const assistantTextEventsByBlockId = new Map<string, AssistantTextEvent>();
  const reasoningItemIdByBlockId = new Map<string, string>();

  for (const entry of timeline) {
    if (entry.kind === "notice") {
      const line = linesById.get(entry.notice.id);
      if (!line) continue;
      blocks.push({
        kind: line.tone === "error" ? "error" : "notice",
        id: entry.notice.id,
        line,
      });
      continue;
    }
    const { envelope, index } = entry;
    const event = envelope.event;
    const id = chatEventLineId(envelope, index);
    const turnId = turnIdOf(event);

    // Subagent lifecycle (started/progress/result, teammate idle, task done)
    // never reaches the transcript — the subagent roster in the chat-info pane
    // is its surface, matching the desktop transcript which hides these too.
    if (isSubagentTimelineEvent(event)) {
      continue;
    }

    if (event.type === "user_message") {
      if (event.steerId && event.deliveryState === "queued") {
        if (pendingSteerIds.has(event.steerId)) {
          blocks.push({
            kind: "queued-steer",
            id,
            turnId,
            steerId: event.steerId,
            text: event.displayText ?? event.text,
          });
        }
        continue;
      }
      passthrough(id, "user-bubble");
      continue;
    }
    if (event.type === "text") {
      if (event.text.length === 0) continue;
      const line = linesById.get(id);
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "assistant-text") {
        const previousTextEvent = assistantTextEventsByBlockId.get(previous.id);
        if (previousTextEvent && shouldMergeAssistantTextEvents(previousTextEvent, event)) {
          // Only the FIRST delta of a streamed message owns a rendered line —
          // renderChatLines' coalesceLines already fused the rest into it. A
          // line-less delta's text is therefore ALREADY in previous.line.body;
          // appending it again duplicated the tail (garbled Claude history
          // replays, where deltas land un-coalesced). Just keep the identity
          // fresh so later deltas continue matching this block.
          if (!line) {
            assistantTextEventsByBlockId.set(previous.id, {
              ...previousTextEvent,
              turnId: previousTextEvent.turnId ?? event.turnId,
              itemId: previousTextEvent.itemId ?? event.itemId,
              messageId: previousTextEvent.messageId ?? event.messageId,
            });
            continue;
          }
          // Overlap-aware: providers re-emit cumulative/tail fragments of the
          // same message, which plain concat rendered as a duplicated tail.
          const mergedText = appendStreamingText(previous.line.body, event.text);
          previous.line = {
            ...previous.line,
            body: mergedText,
            blocks: parseAssistantMarkdown(mergedText),
          };
          assistantTextEventsByBlockId.set(previous.id, {
            ...previousTextEvent,
            text: mergedText,
            turnId: previousTextEvent.turnId ?? event.turnId,
            itemId: previousTextEvent.itemId ?? event.itemId,
            messageId: previousTextEvent.messageId ?? event.messageId,
          });
          continue;
        }
      }
      if (!line) continue;
      blocks.push({ kind: "assistant-text", id, line });
      assistantTextEventsByBlockId.set(id, event);
      continue;
    }
    if (event.type === "reasoning") {
      // Desktop parity: reasoning surfaces as a collapsed "Thinking…/Thought"
      // row (MinimalThought) instead of being dropped. Merge consecutive
      // fragments for the same turn so streamed deltas stay one row. Only a
      // short head preview ever renders, so cap the stored text — long Codex
      // reasoning streams would otherwise grow the block without bound.
      if (!event.text || event.text.length === 0) continue;
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "reasoning" && previous.turnId === turnId) {
        if (previous.text.length < REASONING_TEXT_CAP) {
          const previousItemId = reasoningItemIdByBlockId.get(previous.id) ?? null;
          const nextItemId = (event as { itemId?: string }).itemId ?? null;
          const merged = previousItemId && nextItemId && previousItemId !== nextItemId
            ? `${previous.text}\n\n${event.text}`
            : appendStreamingText(previous.text, event.text);
          previous.text = merged.slice(0, REASONING_TEXT_CAP);
        }
        previous.live = true;
        const nextItemId = (event as { itemId?: string }).itemId ?? null;
        if (nextItemId) reasoningItemIdByBlockId.set(previous.id, nextItemId);
        continue;
      }
      blocks.push({ kind: "reasoning", id, turnId, text: event.text.slice(0, REASONING_TEXT_CAP), live: true });
      const itemId = (event as { itemId?: string }).itemId ?? null;
      if (itemId) reasoningItemIdByBlockId.set(id, itemId);
      continue;
    }
    if (
      event.type === "tool_call"
      || event.type === "tool_result"
      || event.type === "command"
      || event.type === "file_change"
      || event.type === "web_search"
    ) {
      if (isSubagentChildWorkEvent(event, subagentParentItemIds, subagentChildItemIds)) {
        continue;
      }
      if (event.type === "tool_call" || event.type === "tool_result" || event.type === "command" || event.type === "web_search") {
        // Lazily appends to the trailing tool group (creating one only when a
        // genuinely new entry arrives); lookups resolve across ALL groups of
        // the turn so a result never duplicates its call's row.
        const registry: ToolEntryRegistry = {
          get: (itemId) => toolEntryByItemKey.get(workItemKey(turnId, itemId)),
          add: (newEntry) => {
            const last = blocks[blocks.length - 1];
            let group: Extract<AggregatedBlock, { kind: "tool-calls-group" }>;
            if (last && last.kind === "tool-calls-group" && last.turnId === turnId) {
              group = last;
            } else {
              group = { kind: "tool-calls-group", id, turnId, entries: [], live: true };
              blocks.push(group);
            }
            group.entries.push(newEntry);
            toolEntryByItemKey.set(workItemKey(turnId, newEntry.itemId), newEntry);
          },
        };
        if (event.type === "web_search") {
          appendWebSearchEvent(registry, event);
        } else if (event.type === "command") {
          const key = workItemKey(turnId, event.itemId);
          const startedAt = workItemStartedAt.get(key);
          const derivedDurationMs = event.status === "running" || startedAt === undefined
            ? undefined
            : entry.timestamp - startedAt;
          if (!workItemStartedAt.has(key)) workItemStartedAt.set(key, entry.timestamp);
          appendCommandAsTool(registry, event, derivedDurationMs);
        } else {
          const key = workItemKey(turnId, event.itemId);
          if (event.type === "tool_call" && !workItemStartedAt.has(key)) {
            workItemStartedAt.set(key, entry.timestamp);
          }
          const startedAt = workItemStartedAt.get(key);
          const derivedDurationMs = event.type === "tool_result" && event.status !== "running" && startedAt !== undefined
            ? entry.timestamp - startedAt
            : undefined;
          appendToolCallEvent(registry, event, validDurationMs(derivedDurationMs));
        }
      } else if (event.type === "file_change") {
        const last = blocks[blocks.length - 1];
        let group: Extract<AggregatedBlock, { kind: "files-changed-group" }>;
        if (last && last.kind === "files-changed-group" && last.turnId === turnId) {
          group = last;
        } else {
          group = { kind: "files-changed-group", id, turnId, entries: [], live: true };
          blocks.push(group);
        }
        appendFileChangeEvent(group, event);
      }
      if ((args.expandedLineIds?.has(id) ?? false) && isExpandedFailureEvent(event)) {
        passthrough(id, "error");
      }
      continue;
    }
    if (event.type === "plan") {
      const completed = event.steps.filter((step) => step.status === "completed").length;
      const inProgress = event.steps.findIndex((step) => step.status === "in_progress");
      const current = inProgress >= 0 ? inProgress + 1 : completed;
      const total = event.steps.length;
      const stepData: PlanStep[] = event.steps.map((step) => ({ text: step.text, status: step.status }));
      const existing = findLastBlock(blocks, "plan", turnId);
      if (existing) {
        existing.steps = stepData;
        existing.current = current;
        existing.total = total;
        existing.live = true;
        continue;
      }
      blocks.push({
        kind: "plan",
        id,
        turnId,
        steps: stepData,
        current,
        total,
        live: true,
      });
      continue;
    }
    if (event.type === "context_compact") {
      // Runtimes that expose a begin signal send state:"started" then "completed";
      // flip the existing block live→done on completion instead of stacking a second
      // block. Legacy/completion-only sources omit state and render as done.
      const existing = event.state === "completed" ? findCompactionBlockForCompletion(blocks, turnId) : null;
      if (existing && event.state === "completed") {
        existing.live = false;
        existing.trigger = event.trigger;
        if (event.preTokens !== undefined) existing.preTokens = event.preTokens;
        continue;
      }
      blocks.push({
        kind: "compaction",
        id,
        turnId,
        trigger: event.trigger,
        live: event.state === "started",
        preTokens: event.preTokens,
      });
      continue;
    }
    if (event.type === "codex_context_compaction") {
      const existing = event.state === "completed" ? findCompactionBlockForCompletion(blocks, turnId) : null;
      if (existing && event.state === "completed") {
        existing.live = false;
        existing.trigger = event.trigger;
        continue;
      }
      blocks.push({
        kind: "compaction",
        id,
        turnId,
        trigger: event.trigger,
        live: event.state === "started",
      });
      continue;
    }
    if (isSteerLifecycleNotice(event)) {
      continue;
    }
    if (event.type === "activity") {
      const activity = runtimeActivityFromEvent(id, event);
      if (activity) appendRuntimeActivityBlock(blocks, id, turnId, activity);
      continue;
    }
    if (event.type === "approval_request") {
      passthrough(id, "approval");
      continue;
    }
    if (event.type === "error") {
      passthrough(id, "error");
      continue;
    }
    if (event.type === "status") {
      if (event.turnStatus !== "started") {
        finishTurnBlocks(blocks, turnId);
      }
      if (event.turnStatus === "failed" || event.turnStatus === "interrupted") {
        passthrough(id, "error");
      }
      continue;
    }
    if (event.type === "done") {
      finishTurnBlocks(blocks, turnId);
      continue;
    }
    if (SILENCED_EVENT_TYPES.has(event.type)) {
      // Already handled above or intentionally skipped (tokens, codex_*).
      continue;
    }
    // Everything else (todo_update, cloud_*, etc.) becomes a notice.
    const line = linesById.get(id);
    if (!line) continue;
    blocks.push({
      kind: line.tone === "error" ? "error" : line.tone === "approval" ? "approval" : "notice",
      id,
      line,
    });
  }

  // Mark assistant-text blocks that follow a heavy group block for top spacing.
  for (let index = 1; index < blocks.length; index += 1) {
    const current = blocks[index]!;
    if (current.kind !== "assistant-text") continue;
    const prev = blocks[index - 1]!;
    if (prev.kind === "tool-calls-group" || prev.kind === "files-changed-group") {
      current.precededByHeavy = true;
    }
  }

  if (args.maxBlocks && blocks.length > args.maxBlocks) {
    return blocks.slice(-args.maxBlocks);
  }
  return blocks;
}
