import React from "react";
import { cn } from "./cn";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";
/** "upper" is ADE's mono label style; "sentence" is for surfaces that match an
 * external product's sentence-case UI, such as the Linear pane. */
type Casing = "upper" | "sentence";

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; casing?: Casing }
>(function Button(
  {
    variant = "outline",
    size = "md",
    casing = "upper",
    className,
    style: styleProp,
    ...rest
  },
  ref
) {
  const base =
    "inline-flex items-center justify-center gap-2 transition-all duration-100 disabled:opacity-40 disabled:pointer-events-none";
  const casings: Record<Casing, string> = {
    upper: "font-mono text-[10px] font-bold uppercase tracking-[1px]",
    sentence: "rounded-md text-[12px] font-medium",
  };

  const sizes = size === "sm" ? "h-7 px-3" : "h-8 px-4";

  // Theme tokens, so every variant reads on light themes as well as dark.
  const variants: Record<Variant, string> = {
    primary:
      "bg-accent text-accent-fg hover:brightness-110",
    outline:
      "border border-border bg-transparent text-(color:--color-secondary-fg) hover:text-fg hover:border-accent/30",
    ghost:
      "bg-transparent text-muted-fg hover:text-fg hover:bg-muted",
    danger:
      "border border-error/20 bg-error/10 text-error hover:brightness-110",
  };

  return (
    <button
      ref={ref}
      className={cn(base, casings[casing], sizes, variants[variant], className)}
      style={styleProp}
      {...rest}
    />
  );
});
