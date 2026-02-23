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
    <div className={cn("flex shrink-0 items-center justify-between px-3 py-1.5 min-h-[32px] ade-panel-header", className)}>
      <div className="min-w-0 flex items-center gap-2">
        <div className="truncate font-mono text-xs font-medium tracking-widest uppercase text-muted-fg select-none">
          {title}
        </div>
        {meta ? <div className="truncate text-[11px] text-muted-fg/50 font-mono">{meta}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-1.5">{right}</div> : null}
    </div>
  );
}
