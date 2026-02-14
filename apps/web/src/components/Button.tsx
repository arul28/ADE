import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

export function buttonClassName(variant: Variant = "primary", size: Size = "md") {
  return cn(
    "focus-ring inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all",
    "duration-200 [transition-timing-function:var(--ease-out)]",
    "disabled:pointer-events-none disabled:opacity-60",
    variant === "primary" &&
      "bg-accent text-accent-fg shadow-glass-sm hover:-translate-y-0.5 hover:shadow-glass-md active:translate-y-0",
    variant === "secondary" &&
      "border border-border bg-card/70 text-fg hover:-translate-y-0.5 hover:bg-card hover:shadow-glass-sm active:translate-y-0",
    variant === "ghost" && "text-fg hover:bg-muted/70",
    size === "sm" && "h-9 px-3 text-sm",
    size === "md" && "h-11 px-4 text-sm",
    size === "lg" && "h-12 px-5 text-base"
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button className={cn(buttonClassName(variant, size), className)} {...props} />;
}

