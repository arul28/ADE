import type { CodexThreadTokenUsage } from "../../../../shared/types";

type CodexTokenInlineProps = {
  usage: CodexThreadTokenUsage;
};

function formatTokens(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function CodexTokenInline({ usage }: CodexTokenInlineProps) {
  const total = usage.total;
  const last = usage.last;
  const contextWindow = usage.modelContextWindow ?? null;
  const lastInputTokens = last?.inputTokens ?? null;
  const lastOutputTokens = last?.outputTokens ?? null;
  const usedTokens = lastInputTokens != null || lastOutputTokens != null
    ? (lastInputTokens ?? 0) + (lastOutputTokens ?? 0)
    : (total?.totalTokens ?? null);
  const hasContextWindow = typeof contextWindow === "number" && contextWindow > 0;
  const ratio = hasContextWindow && typeof usedTokens === "number" && usedTokens > 0
    ? Math.max(0, Math.min(1, usedTokens / contextWindow))
    : 0;
  const cachedPortion = last?.cacheReadTokens ?? total?.cacheReadTokens ?? null;
  const cacheRatio = hasContextWindow && typeof cachedPortion === "number" && cachedPortion > 0
    ? Math.max(0, Math.min(ratio, cachedPortion / contextWindow))
    : 0;

  const lastIn = formatTokens(lastInputTokens);
  const lastOut = formatTokens(lastOutputTokens);
  const lastCache = formatTokens(last?.cacheReadTokens);
  const showLastTurn = Boolean(lastIn || lastOut || lastCache);

  if (!hasContextWindow && !showLastTurn) return null;

  return (
    <div
      className="pointer-events-none flex min-w-0 items-center gap-x-2 gap-y-0 overflow-hidden text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45"
      aria-label="Codex token usage"
    >
      {hasContextWindow ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="tabular-nums font-medium text-fg/70">
            {Math.round(ratio * 100)}%
          </span>
          <span className="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-white/[0.06]">
            <span
              className="absolute inset-y-0 left-0 bg-sky-400/70"
              style={{ width: `${(ratio * 100).toFixed(1)}%` }}
              aria-hidden
            />
            {cacheRatio > 0 ? (
              <span
                className="absolute inset-y-0 left-0 bg-violet-400/55"
                style={{ width: `${(cacheRatio * 100).toFixed(1)}%` }}
                aria-hidden
                title="Cached input"
              />
            ) : null}
          </span>
        </span>
      ) : null}

      {showLastTurn ? (
        <span className="flex min-w-0 shrink items-center gap-1 truncate tabular-nums text-fg/40">
          {lastIn ? <span>+{lastIn} in</span> : null}
          {lastOut ? (
            <>
              {lastIn ? <span aria-hidden className="text-fg/20">·</span> : null}
              <span>{lastOut} out</span>
            </>
          ) : null}
          {lastCache ? (
            <>
              {(lastIn || lastOut) ? <span aria-hidden className="text-fg/20">·</span> : null}
              <span className="text-violet-200/60" title="Cached input tokens">
                {lastCache} <span aria-hidden>{"✶"}</span>
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export default CodexTokenInline;
