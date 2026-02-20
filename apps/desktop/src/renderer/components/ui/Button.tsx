import React from "react";
import { cn } from "./cn";

type Variant = "primary" | "outline" | "ghost";
type Size = "sm" | "md";

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function Button(
  {
    variant = "outline",
    size = "md",
    className,
    ...props
  },
  ref
) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded font-medium text-[12px] transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none";

  const sizes = size === "sm" ? "h-7 px-2.5" : "h-8 px-3";

  const variants: Record<Variant, string> = {
    primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95",
    outline:
      "border border-border/60 text-fg hover:bg-muted/40 active:bg-muted/60",
    ghost: "text-muted-fg hover:text-fg hover:bg-muted/30 active:bg-muted/50"
  };

  return (
    <button
      ref={ref}
      className={cn(base, sizes, variants[variant], variant === "primary" && "ade-btn-shimmer", className)}
      {...props}
    />
  );
});
