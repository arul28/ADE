import React from "react";
import { cn } from "./cn";

type Variant = "primary" | "outline" | "ghost";
type Size = "sm" | "md";

export function Button({
  variant = "outline",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";

  const sizes = size === "sm" ? "h-8 px-2.5 text-sm" : "h-9 px-3 text-sm";

  const variants: Record<Variant, string> = {
    primary: "bg-accent text-accent-fg hover:brightness-95 active:brightness-90 shadow-sm",
    outline:
      "bg-card/70 text-card-fg border border-border hover:bg-card/90 active:bg-card shadow-[0_1px_0_rgba(0,0,0,0.06)]",
    ghost: "bg-transparent text-fg hover:bg-muted/70 active:bg-muted/90"
  };

  return <button className={cn(base, sizes, variants[variant], className)} {...props} />;
}

