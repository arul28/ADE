import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

type Variant = "neutral" | "accent" | "outline";
type Size = "sm" | "md";

export function Badge({
  variant = "neutral",
  size = "md",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant; size?: Size; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 font-semibold",
        size === "sm" ? "text-[11px]" : "text-xs",
        variant === "neutral" && "border-border/70 bg-card/60 text-muted-fg",
        variant === "accent" && "border-accent/30 bg-[rgba(27,118,255,0.10)] text-fg",
        variant === "outline" && "border-border/70 bg-transparent text-muted-fg",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

