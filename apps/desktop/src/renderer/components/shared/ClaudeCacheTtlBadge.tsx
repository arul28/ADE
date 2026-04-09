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
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
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
