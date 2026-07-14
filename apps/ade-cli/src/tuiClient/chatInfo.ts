import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
} from "../../../desktop/src/shared/types/chat";
import { isBackgroundShellCommand, latestPlan } from "../../../desktop/src/shared/chatSubagents";
import { deriveBackgroundItems, mergeManagedScheduledWorkSnapshots } from "../../../desktop/src/shared/chatScheduledWork";
import { resolveSubagentCapability } from "../../../desktop/src/shared/subagentCapabilities";
import { deriveMissionSnapshot } from "../../../desktop/src/renderer/components/chat/chatMission";
import { deriveTodoItems } from "../../../desktop/src/renderer/components/chat/chatExecutionSummary";
import type {
  AdeCodeProvider,
  ChatInfoSnapshot,
  SubagentSnapshot,
} from "./types";
import type { TokenStats } from "./adeApi";

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function tokenStatsSummary(stats: TokenStats | null): string | null {
  if (!stats) return null;
  const parts: string[] = [];
  if (stats.inputTokens != null || stats.outputTokens != null) {
    const input = stats.inputTokens != null ? `+${compactNumber(stats.inputTokens)}` : "+0";
    const output = stats.outputTokens != null ? compactNumber(stats.outputTokens) : "0";
    parts.push(`${input}/${output}`);
  }
  if (stats.cacheReadTokens != null && stats.cacheReadTokens > 0) {
    parts.push(`(${compactNumber(stats.cacheReadTokens)}✶)`);
  }
  if (stats.costUsd != null) {
    parts.push(`$${stats.costUsd.toFixed(2)}`);
  }
  return parts.length ? parts.join(" ") : null;
}

function latestPlanEvent(events: AgentChatEventEnvelope[]): Extract<AgentChatEvent, { type: "plan" }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "plan") return event;
  }
  return null;
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function deriveChatInfoSnapshot(args: {
  events: AgentChatEventEnvelope[];
  activeSession: AgentChatSessionSummary | null;
  provider: AdeCodeProvider;
  modelLabel: string;
  laneLabel: string | null;
  snapshots: SubagentSnapshot[];
  tokenStats: TokenStats | null;
  goal: ChatInfoSnapshot["goal"];
  streaming: boolean;
  inspectedSubagentId?: string | null;
  pr?: ChatInfoSnapshot["pr"];
  /** Closed-but-resumable Claude terminal session (drives the resume row). */
  resumableTerminal?: boolean;
}): ChatInfoSnapshot {
  const provider = (args.activeSession?.provider ?? args.provider) as AdeCodeProvider;
  const planEvent = latestPlanEvent(args.events);
  const planEventRecord = planEvent as (Record<string, unknown> | null);
  return {
    provider,
    modelLabel: args.modelLabel,
    laneLabel: args.laneLabel,
    claudeTag: args.activeSession?.claudeTag ?? null,
    contextPercent: args.tokenStats?.percent ?? null,
    tokenSummary: tokenStatsSummary(args.tokenStats),
    goal: args.goal,
    plan: latestPlan(args.events),
    planExplanation: trimmedOrNull(planEventRecord?.explanation),
    planStreamingText: trimmedOrNull(planEventRecord?.streamingText),
    todos: deriveTodoItems(args.events),
    // Schedule kinds only — background command tasks render in their own block.
    scheduledWork: mergeManagedScheduledWorkSnapshots(args.events, args.activeSession?.scheduledWork)
      .filter((item) => item.kind !== "background_task"),
    nextWakeAt: args.activeSession?.nextWakeAt ?? null,
    backgroundWork: deriveBackgroundItems(args.events),
    pr: args.pr ?? null,
    // Merge subagents into one roster and drop historical command-as-subagent
    // snapshots (the shared predicate keys on taskType/description).
    snapshots: args.snapshots.filter((snapshot) => !isBackgroundShellCommand({
      taskType: snapshot.taskType,
      description: snapshot.name,
    })),
    inspectedSubagentId: args.inspectedSubagentId ?? null,
    streaming: args.streaming,
    // Single source of truth for takeover-vs-inline + which stat fields render.
    // Resolved from the session provider (runtimeKind isn't surfaced on the TUI
    // session summary, and the 4 shared runtimes map 1:1 from provider).
    capability: resolveSubagentCapability(provider),
    mission: deriveMissionSnapshot(args.events),
    resumableTerminal: args.resumableTerminal ?? false,
  };
}
