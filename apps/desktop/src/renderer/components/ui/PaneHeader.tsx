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
    <div className={cn("flex shrink-0 items-center justify-between px-4 py-2 min-h-[44px] ade-panel-header", className)}>
      <div className="min-w-0 flex flex-col justify-center">
        <div className="flex items-baseline gap-2">
          <div className="truncate text-[13px] font-semibold text-fg/80 select-none">
            {title}
          </div>
          {meta ? <div className="truncate text-xs text-muted-fg/60">{meta}</div> : null}
        </div>
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}
