import React from "react";
import { cn } from "./cn";

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[1px] text-muted-fg",
        className
      )}
      style={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)" }}
      {...props}
    />
  );
}
