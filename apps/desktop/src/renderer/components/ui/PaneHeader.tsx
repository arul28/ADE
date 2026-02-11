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
    <div className={cn("flex items-center justify-between border-b border-border px-3 py-2", className)}>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{title}</div>
        {meta ? <div className="truncate text-xs text-muted-fg">{meta}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

