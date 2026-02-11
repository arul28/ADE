import React from "react";
import { cn } from "./cn";

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-card/70 px-2 py-0.5 text-[11px] leading-4 text-muted-fg",
        className
      )}
      {...props}
    />
  );
}

