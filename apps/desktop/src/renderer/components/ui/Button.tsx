import React from "react";
import { cn } from "./cn";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function Button(
  {
    variant = "outline",
    size = "md",
    className,
    style: styleProp,
    ...rest
  },
  ref
) {
  const base =
    "inline-flex items-center justify-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all duration-100 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none";

  const sizes = size === "sm" ? "h-7 px-3" : "h-8 px-4";

  const variants: Record<Variant, string> = {
    primary:
      "text-[#0F0D14] hover:brightness-110",
    outline:
      "text-[#A1A1AA] hover:text-[#FAFAFA] hover:border-[#A78BFA50]",
    ghost:
      "text-[#71717A] hover:text-[#FAFAFA] hover:bg-[#1A1720]",
    danger:
      "text-[#EF4444] hover:brightness-110",
  };

  const variantStyles: Record<Variant, React.CSSProperties> = {
    primary: { background: "#A78BFA" },
    outline: { background: "transparent", border: "1px solid #27272A" },
    ghost: { background: "transparent" },
    danger: { background: "#EF444418", border: "1px solid #EF444430" },
  };

  return (
    <button
      ref={ref}
      className={cn(base, sizes, variants[variant], className)}
      style={{ ...variantStyles[variant], ...styleProp }}
      {...rest}
    />
  );
});
