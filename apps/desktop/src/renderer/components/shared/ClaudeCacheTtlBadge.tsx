import { useEffect, useState } from "react";
import type { ClaudePromptCache } from "../../../shared/claudePromptCache";
import { cn } from "../ui/cn";
import { claudeCacheCountdown, formatClaudeCacheTtl } from "../../lib/claudeCacheTtl";
import { useTicker } from "../../lib/ticker";

export function ClaudeCacheTtlBadge({
  idleSinceAt,
  cache,
  className,
}: {
  idleSinceAt: string | null | undefined;
  /** The chat's prompt cache after its last turn; unknown shows nothing. */
  cache: ClaudePromptCache | null | undefined;
  className?: string;
}) {
  const ttl = cache?.ttl;
  const since = cache?.since;
  const [armed, setArmed] = useState(false);
  // Ticks on the renderer's shared one-second timer instead of one of its own,
  // so a column of countdowns costs a single timer rather than one per row.
  const nowMs = useTicker(1_000, armed);

  useEffect(() => {
    if (!idleSinceAt || !ttl) {
      setArmed(false);
      return undefined;
    }
    const { remainingMs: remainingAtMount, showInMs: showInAtMount } = claudeCacheCountdown(
      idleSinceAt,
      { ttl, since },
      Date.now(),
    );
    // Already expired at mount: publish the final state, install no timer.
    if (remainingAtMount <= 0) {
      setArmed(false);
      return undefined;
    }
    // A 1-hour cache shows nothing for most of the hour: arm when the window
    // opens instead of ticking through it.
    if (showInAtMount <= 0) {
      setArmed(true);
      return undefined;
    }
    setArmed(false);
    const timeoutId = window.setTimeout(() => setArmed(true), showInAtMount);
    return () => window.clearTimeout(timeoutId);
  }, [idleSinceAt, ttl, since]);

  const { remainingMs, showInMs } = claudeCacheCountdown(idleSinceAt, cache, nowMs);

  // Publish the final expired state, then drop the subscription while the
  // component stays mounted. An expired badge must not keep waking the renderer
  // once per second (offscreen cards / retained Work trees amplify this).
  useEffect(() => {
    if (armed && remainingMs <= 0) setArmed(false);
  }, [armed, remainingMs]);

  if (remainingMs <= 0 || showInMs > 0) return null;

  return (
    <span
      aria-label={`Claude cache expires in ${formatClaudeCacheTtl(remainingMs)}`}
      title="Time until Claude's cache expires"
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-amber-400/12 bg-amber-500/[0.06] px-1.5 py-0.5 font-mono text-[9px] leading-none tracking-[0.04em] text-amber-200/72",
        className,
      )}
    >
      {formatClaudeCacheTtl(remainingMs)}
    </span>
  );
}
