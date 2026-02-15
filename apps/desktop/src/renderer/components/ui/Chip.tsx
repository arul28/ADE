import React from "react";
import { cn } from "./cn";

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-muted/50 px-2.5 py-1 text-[11px] leading-4 text-muted-fg/80",
        className
      )}
      {...props}
    />
  );
}
