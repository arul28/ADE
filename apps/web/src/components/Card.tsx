import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

type Tone = "soft" | "solid" | "tint";

export function Card({
  tone = "soft",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-[22px] border shadow-glass-sm",
        tone === "soft" && "border-border/70 bg-card/60",
        tone === "solid" && "border-border/80 bg-card/80",
        tone === "tint" && "border-accent/20 bg-[rgba(27,118,255,0.06)]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

