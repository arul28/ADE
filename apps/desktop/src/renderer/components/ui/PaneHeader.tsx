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
    <div className={cn("flex shrink-0 items-center justify-between px-3 py-1.5 min-h-[36px]", className)}>
      <div className="min-w-0 flex flex-col justify-center">
        <div className="flex items-baseline gap-2">
          <div className="truncate font-mono text-xs font-bold uppercase tracking-widest text-muted-fg select-none">
            {title}
          </div>
          {meta ? <div className="truncate font-mono text-[10px] text-muted-fg/60">{meta}</div> : null}
        </div>
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

