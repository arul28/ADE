import React from "react";
import { cn } from "./cn";

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center rounded-md border border-border/70 bg-card/70 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-fg shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_0_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.06)]",
        className
      )}
      {...props}
    />
  );
}

