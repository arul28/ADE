import { useEffect, useState } from "react";
import type { ClaudePromptCacheTtl } from "../../../shared/claudePromptCache";
import { cn } from "../ui/cn";
import {
  CLAUDE_CACHE_TTL_TITLE,
  formatClaudeCacheTtl,
  getClaudeCacheTtlRemainingMs,
  getClaudeCacheTtlShowDelayMs,
} from "../../lib/claudeCacheTtl";

export function ClaudeCacheTtlBadge({
  idleSinceAt,
  cacheTtl,
  className,
}: {
  idleSinceAt: string | null | undefined;
  /** The lifetime Claude last wrote this chat's cache with; unknown shows nothing. */
  cacheTtl: ClaudePromptCacheTtl | null | undefined;
  className?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!idleSinceAt || !cacheTtl) return;
    const now = Date.now();
    setNowMs(now);
    // Already expired at mount: publish the final state, install no timer.
    if (getClaudeCacheTtlRemainingMs(idleSinceAt, cacheTtl, now) <= 0) return;
    let intervalId: number | null = null;
    const startTicking = () => {
      setNowMs(Date.now());
      intervalId = window.setInterval(() => {
        const tickNow = Date.now();
        setNowMs(tickNow);
        // Publish the final expired state, then stop the one-second interval while
        // the component stays mounted. An expired badge must not keep waking the
        // renderer once per second (offscreen cards / retained Work trees amplify
        // this). Cleanup below still fires on prop change and unmount.
        if (intervalId != null && getClaudeCacheTtlRemainingMs(idleSinceAt, cacheTtl, tickNow) <= 0) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
      }, 1000);
    };
    // A 1-hour cache shows nothing for most of the hour: one timeout, no ticks.
    const showDelayMs = getClaudeCacheTtlShowDelayMs(idleSinceAt, cacheTtl, now);
    const timeoutId = showDelayMs > 0 ? window.setTimeout(startTicking, showDelayMs) : null;
    if (timeoutId == null) startTicking();
    return () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (intervalId != null) window.clearInterval(intervalId);
    };
  }, [idleSinceAt, cacheTtl]);

  if (!cacheTtl) return null;
  const remainingMs = getClaudeCacheTtlRemainingMs(idleSinceAt, cacheTtl, nowMs);
  if (remainingMs <= 0 || getClaudeCacheTtlShowDelayMs(idleSinceAt, cacheTtl, nowMs) > 0) return null;

  return (
    <span
      aria-label={`Claude cache expires in ${formatClaudeCacheTtl(remainingMs)}`}
      title={CLAUDE_CACHE_TTL_TITLE}
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-amber-400/12 bg-amber-500/[0.06] px-1.5 py-0.5 font-mono text-[9px] leading-none tracking-[0.04em] text-amber-200/72",
        className,
      )}
    >
      {formatClaudeCacheTtl(remainingMs)}
    </span>
  );
}
