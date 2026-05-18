import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
} from "../../../desktop/src/shared/types/chat";
import type { LocalNotice } from "./types";
import {
  chatEventLineId,
  renderChatLines,
  type RenderedChatLine,
} from "./format";
import { workEventItemId, workEventParentItemId } from "./workEventIds";

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
  | { kind: "tool-calls-group"; id: string; turnId: string | null; entries: ToolCallEntry[]; live: boolean; durationMs?: number }
  | { kind: "files-changed-group"; id: string; turnId: string | null; entries: FileChangeEntry[]; live: boolean; durationMs?: number }
  | { kind: "runtime-activity"; id: string; turnId: string | null; entries: RuntimeActivityEntry[]; live: boolean }
  | { kind: "memory"; id: string; turnId: string | null; live: boolean; hitCount?: number; text?: string }
  | { kind: "compaction"; id: string; turnId: string | null; trigger: "manual" | "auto"; live: boolean; preTokens?: number }
  | { kind: "queued-steer"; id: string; turnId: string | null; steerId: string; text: string }
  | { kind: "plan"; id: string; turnId: string | null; steps: PlanStep[]; current: number; total: number; live: boolean }
  | { kind: "approval"; id: string; line: RenderedChatLine }
  | { kind: "error"; id: string; line: RenderedChatLine }
  | { kind: "notice"; id: string; line: RenderedChatLine };

function turnIdOf(event: AgentChatEvent): string | null {
  return (event as { turnId?: string }).turnId ?? null;
}

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

function singleArg(value: unknown, max = 60): string {
  const text = (() => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
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

function appendToolCallEvent(
  block: Extract<AggregatedBlock, { kind: "tool-calls-group" }>,
  event: Extract<AgentChatEvent, { type: "tool_call" | "tool_result" }>,
  durationMs?: number,
): void {
  if (event.type === "tool_call") {
    block.entries.push({
      itemId: event.itemId,
      tool: event.tool,
      arg: singleArg(event.args),
      status: "running",
    });
    return;
  }
  const existing = block.entries.find((entry) => entry.itemId === event.itemId);
  const status: WorkToolStatus = event.status === "failed" ? "failed" : event.status === "running" ? "running" : "ok";
  if (existing) {
    existing.status = status;
    if (durationMs !== undefined) existing.durationMs = durationMs;
    return;
  }
  block.entries.push({
    itemId: event.itemId,
    tool: event.tool,
    arg: singleArg(event.result),
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
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
  block: Extract<AggregatedBlock, { kind: "tool-calls-group" }>,
  event: Extract<AgentChatEvent, { type: "command" }>,
  derivedDurationMs?: number,
): void {
  const failed = event.status === "failed" || (event.exitCode ?? 0) !== 0;
  const status: WorkToolStatus = event.status === "running" ? "running" : failed ? "failed" : "ok";
  const durationMs = validDurationMs(event.durationMs) ?? validDurationMs(derivedDurationMs);
  const cleanCommand = stripShellLauncher(event.command);
  const existing = block.entries.find((entry) => entry.itemId === event.itemId);
  if (existing) {
    existing.status = status;
    existing.arg = cleanCommand;
    if (durationMs !== undefined) existing.durationMs = durationMs;
    return;
  }
  block.entries.push({
    itemId: event.itemId,
    tool: "shell",
    arg: cleanCommand,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
}

function isExpandedFailureEvent(event: AgentChatEvent): boolean {
  if (event.type === "tool_result") return event.status === "failed";
  if (event.type === "file_change") return event.status === "failed";
  if (event.type === "command") return event.status === "failed" || (event.exitCode ?? 0) !== 0;
  return false;
}

function parseMemoryHits(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /(\d+)\s*hits?/i.exec(text);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) ? value : undefined;
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

function isLiveTurnBlock(
  block: AggregatedBlock,
): block is Extract<AggregatedBlock, { kind: "tool-calls-group" | "files-changed-group" | "runtime-activity" | "plan" | "compaction" }> {
  return block.kind === "tool-calls-group"
    || block.kind === "files-changed-group"
    || block.kind === "runtime-activity"
    || block.kind === "plan"
    || block.kind === "compaction";
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

function runtimeStatus(value: unknown): RuntimeActivityEntry["status"] {
  if (value === "failed" || value === "interrupted") return "failed";
  if (value === "completed" || value === "ok" || value === "complete") return "ok";
  if (value === "running" || value === "started" || value === "active") return "running";
  return "info";
}

function runtimeActivityFromEvent(id: string, event: AgentChatEvent): RuntimeActivityEntry | null {
  if (event.type === "activity") {
    const activity = event.activity;
    const detail = compactActivityDetail(event.detail);
    if (activity === "thinking" || activity === "working") return null;
    return {
      id,
      label: activity.replace(/_/g, " "),
      detail,
      status: "running",
    };
  }
  if (event.type === "subagent_started" || event.type === "subagent.started") {
    return {
      id,
      label: "subagent started",
      status: "running",
    };
  }
  if (event.type === "subagent_progress" || event.type === "subagent.progress") {
    return {
      id,
      label: "subagent progress",
      status: "running",
    };
  }
  if (event.type === "subagent_result" || event.type === "subagent.completed") {
    return {
      id,
      label: "subagent finished",
      status: runtimeStatus((event as { status?: unknown }).status ?? "completed"),
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

    if (isSubagentTimelineEvent(event)) {
      const activity = runtimeActivityFromEvent(id, event);
      if (activity) appendRuntimeActivityBlock(blocks, id, turnId, activity);
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
      passthrough(id, "assistant-text");
      continue;
    }
    if (event.type === "reasoning") {
      continue;
    }
    if (event.type === "tool_call" || event.type === "tool_result" || event.type === "command" || event.type === "file_change") {
      if (isSubagentChildWorkEvent(event, subagentParentItemIds, subagentChildItemIds)) {
        continue;
      }
      if (event.type === "tool_call" || event.type === "tool_result" || event.type === "command") {
        const last = blocks[blocks.length - 1];
        let group: Extract<AggregatedBlock, { kind: "tool-calls-group" }>;
        if (last && last.kind === "tool-calls-group" && last.turnId === turnId) {
          group = last;
        } else {
          group = { kind: "tool-calls-group", id, turnId, entries: [], live: true };
          blocks.push(group);
        }
        if (event.type === "command") {
          const key = workItemKey(turnId, event.itemId);
          const startedAt = workItemStartedAt.get(key);
          const derivedDurationMs = event.status === "running" || startedAt === undefined
            ? undefined
            : entry.timestamp - startedAt;
          if (!workItemStartedAt.has(key)) workItemStartedAt.set(key, entry.timestamp);
          appendCommandAsTool(group, event, derivedDurationMs);
        } else {
          const key = workItemKey(turnId, event.itemId);
          if (event.type === "tool_call" && !workItemStartedAt.has(key)) {
            workItemStartedAt.set(key, entry.timestamp);
          }
          const startedAt = workItemStartedAt.get(key);
          const derivedDurationMs = event.type === "tool_result" && event.status !== "running" && startedAt !== undefined
            ? entry.timestamp - startedAt
            : undefined;
          appendToolCallEvent(group, event, validDurationMs(derivedDurationMs));
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
    if (event.type === "system_notice" && (event as { noticeKind?: string }).noticeKind === "memory") {
      const message = (event as { message?: string }).message ?? "";
      const hitCount = parseMemoryHits(message);
      const existing = findLastBlock(blocks, "memory", turnId);
      if (existing) {
        existing.hitCount = hitCount ?? existing.hitCount;
        existing.text = message || existing.text;
        existing.live = false;
        continue;
      }
      blocks.push({
        kind: "memory",
        id,
        turnId,
        live: false,
        hitCount,
        text: message,
      });
      continue;
    }
    if (event.type === "context_compact") {
      blocks.push({
        kind: "compaction",
        id,
        turnId,
        trigger: event.trigger,
        live: false,
        preTokens: event.preTokens,
      });
      continue;
    }
    if (event.type === "codex_context_compaction") {
      const existing = findLastBlock(blocks, "compaction", turnId);
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
