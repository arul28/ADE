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
      style={{ background: "#0C0A10", borderBottom: "1px solid #1E1B26" }}
    >
      <div className="min-w-0 flex items-center gap-2">
        <div className="truncate font-mono text-[10px] font-bold tracking-[1px] uppercase text-[#71717A] select-none">
          {title}
        </div>
        {meta ? <div className="truncate text-[9px] text-[#52525B] font-mono">{meta}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-1.5">{right}</div> : null}
    </div>
  );
}
