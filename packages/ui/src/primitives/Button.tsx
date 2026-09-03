import React from "react";
import { cn } from "./cn";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

/**
 * Every component in this file emits TWO class vocabularies on the same
 * element: the app's original Tailwind utilities, and a stable `ade-*` class
 * that the injected stylesheet implements.
 *
 * That is deliberate, and it is what makes one component serve two hosts with
 * one visual result:
 *
 * - In the desktop renderer Tailwind is present and the kit stylesheet is NOT
 *   injected, so the element resolves through exactly the utilities it always
 *   did. `cn` still merges a caller's `className` override the same way, which
 *   is load-bearing: call sites pass `h-6 px-2 text-[11px]` and must keep
 *   winning.
 * - In a plugin webview there is no Tailwind, so the `ade-*` rules from
 *   `injectAdeStyles()` do the drawing, reproducing the same declarations.
 *
 * Colours that the app set through an inline `style` object stay inline: those
 * are already host-independent.
 */
const BUTTON_BASE_TW =
  "inline-flex items-center justify-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all duration-100 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none";

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
  const base = BUTTON_BASE_TW;

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
      className={cn(
        base,
        sizes,
        variants[variant],
        `ade-btn ade-btn-${size} ade-btn-${variant}`,
        className
      )}
      style={{ ...variantStyles[variant], ...styleProp }}
      {...rest}
    />
  );
});
