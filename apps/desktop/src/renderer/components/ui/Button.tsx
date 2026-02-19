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
    "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none hover:scale-[1.02] active:scale-[0.97] transition-[color,background-color,border-color,box-shadow,transform] ease-out";

  const sizes = size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-4 text-sm";

  const variants: Record<Variant, string> = {
    primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-panel ring-1 ring-inset ring-white/10",
    outline:
      "bg-card/60 text-card-fg shadow-panel hover:shadow-card-hover hover:bg-card/80 active:bg-card",
    ghost: "bg-transparent text-fg hover:bg-muted/50 active:bg-muted/70"
  };

  return (
    <button
      ref={ref}
      className={cn(base, sizes, variants[variant], variant === "primary" && "ade-btn-shimmer", className)}
      {...props}
    />
  );
});
