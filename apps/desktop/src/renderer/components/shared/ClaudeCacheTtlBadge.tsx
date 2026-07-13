import { useEffect, useState } from "react";
import { cn } from "../ui/cn";
import {
  buildClaudeCacheTtlTitle,
  formatClaudeCacheTtl,
  getClaudeCacheTtlRemainingMs,
} from "../../lib/claudeCacheTtl";

export function ClaudeCacheTtlBadge({
  idleSinceAt,
  className,
}: {
  idleSinceAt: string | null | undefined;
  className?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!idleSinceAt) return;
    const now = Date.now();
    setNowMs(now);
    // Already expired at mount: publish the final state, install no interval.
    if (getClaudeCacheTtlRemainingMs(idleSinceAt, now) <= 0) return;
    const intervalId = window.setInterval(() => {
      const tickNow = Date.now();
      setNowMs(tickNow);
      // Publish the final expired state, then stop the one-second interval while
      // the component stays mounted. An expired badge must not keep waking the
      // renderer once per second (offscreen cards / retained Work trees amplify
      // this). Cleanup below still fires on prop change and unmount.
      if (getClaudeCacheTtlRemainingMs(idleSinceAt, tickNow) <= 0) {
        window.clearInterval(intervalId);
      }
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [idleSinceAt]);

  const remainingMs = getClaudeCacheTtlRemainingMs(idleSinceAt, nowMs);
  if (remainingMs <= 0) return null;

  return (
    <span
      aria-label={`Claude cache expires in ${formatClaudeCacheTtl(remainingMs)}`}
      title={buildClaudeCacheTtlTitle(remainingMs)}
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-amber-400/12 bg-amber-500/[0.06] px-1.5 py-0.5 font-mono text-[9px] leading-none tracking-[0.04em] text-amber-200/72",
        className,
      )}
    >
      {formatClaudeCacheTtl(remainingMs)}
    </span>
  );
}
