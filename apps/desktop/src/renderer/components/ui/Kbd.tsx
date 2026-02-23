import React from "react";
import { cn } from "./cn";

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-card/70 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-fg",
        className
      )}
      {...props}
    />
  );
}

