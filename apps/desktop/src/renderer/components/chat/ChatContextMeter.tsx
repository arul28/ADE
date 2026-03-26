import React, { useMemo } from "react";
import type { AgentChatEventEnvelope } from "../../../shared/types";

type SessionTokenUsage = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  turnCount: number;
};

export function deriveSessionTokenUsage(events: AgentChatEventEnvelope[]): SessionTokenUsage {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCostUsd = 0;
  let turnCount = 0;

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type !== "done") continue;
    turnCount++;
    if (event.usage) {
      totalInputTokens += event.usage.inputTokens ?? 0;
      totalOutputTokens += event.usage.outputTokens ?? 0;
      totalCacheReadTokens += event.usage.cacheReadTokens ?? 0;
      totalCacheCreationTokens += event.usage.cacheCreationTokens ?? 0;
    }
    if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
      totalCostUsd += event.costUsd;
    }
  }

  return { totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, totalCostUsd, turnCount };
}

function formatTokenCount(value: number): string {
  if (value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export const ChatContextMeter = React.memo(function ChatContextMeter({
  events,
  contextWindow,
}: {
  events: AgentChatEventEnvelope[];
  contextWindow?: number;
}) {
  const usage = useMemo(() => deriveSessionTokenUsage(events), [events]);

  if (usage.turnCount === 0) return null;

  const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
  const fillPercent = contextWindow && contextWindow > 0
    ? Math.min(100, Math.round((usage.totalInputTokens / contextWindow) * 100))
    : null;

  const costStr = usage.totalCostUsd > 0
    ? usage.totalCostUsd < 0.01
      ? "<$0.01"
      : `$${usage.totalCostUsd.toFixed(2)}`
    : null;

  return (
    <div className="flex items-center gap-2 px-3 py-1 font-sans text-[10px] text-fg/28">
      <span>{formatTokenCount(totalTokens)} tokens</span>
      {usage.totalCacheReadTokens > 0 ? (
        <span className="text-fg/18">({formatTokenCount(usage.totalCacheReadTokens)} cached)</span>
      ) : null}
      {costStr ? <span>{costStr}</span> : null}
      {fillPercent !== null ? (
        <div className="flex items-center gap-1.5">
          <div className="h-1 w-16 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                fillPercent > 80 ? "bg-amber-400/60" : fillPercent > 50 ? "bg-sky-400/40" : "bg-emerald-400/30"
              }`}
              style={{ width: `${fillPercent}%` }}
            />
          </div>
          <span className="text-[9px] text-fg/20">{fillPercent}%</span>
        </div>
      ) : null}
      <span className="text-fg/18">{usage.turnCount} turn{usage.turnCount !== 1 ? "s" : ""}</span>
    </div>
  );
});
