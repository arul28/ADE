import React from "react";
import { cn } from "./cn";

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]",
        className
      )}
      style={{ background: "#1A1720", border: "1px solid #1E1B26" }}
      {...props}
    />
  );
}
