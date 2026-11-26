import React from "react";
import { cn } from "./cn";

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 font-sans text-[10px] font-medium text-muted-fg",
        className
      )}
      style={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)" }}
      {...props}
    />
  );
}
