import React from "react";
import { cn } from "../ui/cn";

export type TurnDividerData = {
  turnId: string;
  timestamp: string;
  endTimestamp?: string;
  model?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  status?: "completed" | "interrupted" | "failed";
};

function formatDuration(startIso: string, endIso?: string): string | null {
  if (!endIso) return null;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function formatTokens(count: number | undefined | null): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(Math.round(count));
}

function formatCost(usd: number | undefined | null): string | null {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export const ChatTurnDivider = React.memo(function ChatTurnDivider({
  data,
}: {
  data: TurnDividerData;
}) {
  const duration = formatDuration(data.timestamp, data.endTimestamp);
  const inputTok = formatTokens(data.inputTokens);
  const outputTok = formatTokens(data.outputTokens);
  const cacheTok = formatTokens(data.cacheReadTokens);
  const cost = formatCost(data.costUsd);
  const hasStats = duration || data.filesChanged || inputTok || outputTok || cost;

  const statusDotColor = data.status === "failed"
    ? "bg-red-400/50"
    : data.status === "interrupted"
      ? "bg-amber-400/50"
      : "bg-emerald-400/30";

  if (!hasStats) return null;

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-white/[0.04]" />
      <div className="flex items-center gap-2 font-sans text-[10px] text-fg/32">
        <span className={cn("inline-flex h-1.5 w-1.5 rounded-full", statusDotColor)} />
        {duration ? <span>{duration}</span> : null}
        {data.filesChanged ? (
          <span>
            {data.filesChanged} file{data.filesChanged !== 1 ? "s" : ""}
            {data.insertions ? <span className="text-emerald-400/50"> +{data.insertions}</span> : null}
            {data.deletions ? <span className="text-red-400/50"> -{data.deletions}</span> : null}
          </span>
        ) : null}
        {inputTok || outputTok ? (
          <span className="text-fg/22">
            {inputTok ? `${inputTok} in` : ""}
            {inputTok && outputTok ? " / " : ""}
            {outputTok ? `${outputTok} out` : ""}
            {cacheTok ? ` (${cacheTok} cached)` : ""}
          </span>
        ) : null}
        {cost ? <span className="text-fg/22">{cost}</span> : null}
      </div>
      <div className="h-px flex-1 bg-white/[0.04]" />
    </div>
  );
});
