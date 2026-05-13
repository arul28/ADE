import path from "node:path";
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

export type WorkTool = {
  itemId: string;
  tool: string;
  arg: string;
  status: WorkToolStatus;
  durationMs?: number;
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
  | { kind: "work-block"; id: string; turnId: string | null; tools: WorkTool[]; live: boolean; durationMs?: number }
  | { kind: "memory"; id: string; turnId: string | null; live: boolean; hitCount?: number; text?: string }
  | { kind: "compaction"; id: string; turnId: string | null; trigger: "manual" | "auto"; live: boolean; preTokens?: number }
  | { kind: "queued-steer"; id: string; turnId: string | null; steerId: string; text: string }
  | { kind: "plan"; id: string; turnId: string | null; steps: PlanStep[]; current: number; total: number; live: boolean }
  | { kind: "turn-footer"; id: string; turnId: string; durationMs?: number; tokens?: number; cost?: number }
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

function diffStats(diff: string): string {
  const lines = diff.split(/\r?\n/);
  let adds = 0;
  let dels = 0;
  for (const line of lines) {
    if (/^\+[^+]/.test(line)) adds += 1;
    else if (/^-[^-]/.test(line)) dels += 1;
  }
  return `+${adds} −${dels}`;
}

function appendTool(block: Extract<AggregatedBlock, { kind: "work-block" }>, event: AgentChatEvent, envelope: AgentChatEventEnvelope): void {
  if (event.type === "tool_call") {
    block.tools.push({
      itemId: event.itemId,
      tool: event.tool,
      arg: singleArg(event.args),
      status: "running",
    });
    return;
  }
  if (event.type === "tool_result") {
    const existing = block.tools.find((tool) => tool.itemId === event.itemId);
    const status: WorkToolStatus = event.status === "failed" ? "failed" : event.status === "running" ? "running" : "ok";
    if (existing) {
      existing.status = status;
      return;
    }
    block.tools.push({
      itemId: event.itemId,
      tool: event.tool,
      arg: singleArg(event.result),
      status,
    });
    return;
  }
  if (event.type === "command") {
    const failed = event.status === "failed" || (event.exitCode ?? 0) !== 0;
    const status: WorkToolStatus = event.status === "running" ? "running" : failed ? "failed" : "ok";
    const existing = block.tools.find((tool) => tool.itemId === event.itemId);
    if (existing) {
      existing.status = status;
      if (typeof event.durationMs === "number") existing.durationMs = event.durationMs;
      existing.arg = event.command;
      return;
    }
    block.tools.push({
      itemId: event.itemId,
      tool: "bash",
      arg: event.command,
      status,
      durationMs: event.durationMs ?? undefined,
    });
    return;
  }
  if (event.type === "file_change") {
    const status: WorkToolStatus = event.status === "failed" ? "failed" : event.status === "running" ? "running" : "ok";
    const stats = diffStats(event.diff);
    const arg = `${path.basename(event.path)} ${stats}`;
    const existing = block.tools.find((tool) => tool.itemId === event.itemId);
    if (existing) {
      existing.status = status;
      existing.arg = arg;
      return;
    }
    block.tools.push({ itemId: event.itemId, tool: "edit", arg, status });
    return;
  }
  // Unknown — ignore.
  void envelope;
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

const AGGREGATED_TYPES = new Set<AgentChatEvent["type"]>([
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
  const turnStart = new Map<string, number>();
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
    if (turnId && !turnStart.has(turnId)) turnStart.set(turnId, entry.timestamp);

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
      const last = blocks[blocks.length - 1];
      let workBlock: Extract<AggregatedBlock, { kind: "work-block" }>;
      if (last && last.kind === "work-block" && last.turnId === turnId) {
        workBlock = last;
      } else {
        workBlock = { kind: "work-block", id, turnId, tools: [], live: true };
        blocks.push(workBlock);
      }
      appendTool(workBlock, event, envelope);
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
      // Activity rows are low-signal transcript metadata; keep the main chat quiet.
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
      const startMs = turnId ? turnStart.get(turnId) : undefined;
      const durationMs = startMs !== undefined ? entry.timestamp - startMs : undefined;
      if (event.turnStatus !== "started") {
        for (const block of blocks) {
          const blockTurn = (block as { turnId?: string | null }).turnId ?? null;
          if (blockTurn !== turnId) continue;
          if (block.kind === "work-block" || block.kind === "plan" || block.kind === "compaction") {
            block.live = false;
            if (durationMs !== undefined && block.kind === "work-block") {
              block.durationMs = block.durationMs ?? durationMs;
            }
          }
        }
      }
      if (event.turnStatus === "failed" || event.turnStatus === "interrupted") {
        passthrough(id, "error");
      }
      continue;
    }
    if (event.type === "done") {
      const startMs = turnId ? turnStart.get(turnId) : undefined;
      const durationMs = startMs !== undefined ? entry.timestamp - startMs : undefined;
      for (const block of blocks) {
        const blockTurn = (block as { turnId?: string | null }).turnId ?? null;
        if (blockTurn !== turnId) continue;
        if (block.kind === "work-block" || block.kind === "plan" || block.kind === "compaction") {
          block.live = false;
          if (durationMs !== undefined && block.kind === "work-block") {
            block.durationMs = block.durationMs ?? durationMs;
          }
        }
      }
      continue;
    }
    if (AGGREGATED_TYPES.has(event.type)) {
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

  // Mark assistant-text blocks that follow a heavy work block for top spacing.
  for (let index = 1; index < blocks.length; index += 1) {
    const current = blocks[index]!;
    if (current.kind !== "assistant-text") continue;
    const prev = blocks[index - 1]!;
    if (prev.kind === "work-block") {
      current.precededByHeavy = true;
    }
  }

  if (args.maxBlocks && blocks.length > args.maxBlocks) {
    return blocks.slice(-args.maxBlocks);
  }
  return blocks;
}
