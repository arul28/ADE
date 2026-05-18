import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
} from "../../../desktop/src/shared/types/chat";
import type {
  AdeCodeProvider,
  ChatInfoPlan,
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

function planFromEvent(event: Extract<AgentChatEvent, { type: "plan" }>): ChatInfoPlan {
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

function latestPlan(events: AgentChatEventEnvelope[]): ChatInfoPlan {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "plan") return planFromEvent(event);
  }
  return null;
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
}): ChatInfoSnapshot {
  return {
    provider: (args.activeSession?.provider ?? args.provider) as AdeCodeProvider,
    modelLabel: args.modelLabel,
    laneLabel: args.laneLabel,
    contextPercent: args.tokenStats?.percent ?? null,
    tokenSummary: tokenStatsSummary(args.tokenStats),
    goal: args.goal,
    plan: latestPlan(args.events),
    snapshots: args.snapshots,
    inspectedSubagentId: args.inspectedSubagentId ?? null,
    streaming: args.streaming,
  };
}
