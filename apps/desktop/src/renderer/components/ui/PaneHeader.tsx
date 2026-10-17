import React from "react";
import { cn } from "./cn";

export function PaneHeader({
  title,
  meta,
  right,
  className
}: {
  title: string;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex shrink-0 items-center justify-between px-4 min-h-[36px]", className)}
      style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}
    >
      <div className="min-w-0 flex items-center gap-2">
        <div className="truncate font-mono text-[10px] font-bold tracking-[1px] uppercase text-muted-fg select-none">
          {title}
        </div>
        {meta ? <div className="truncate text-[9px] text-muted-fg/75 font-mono">{meta}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-1.5">{right}</div> : null}
    </div>
  );
}
