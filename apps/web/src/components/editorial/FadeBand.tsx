import { cn } from "../../lib/cn";

/**
 * 40vh gradient band for dark↔cream transitions.
 * Pure CSS — no JS, no motion. The band sits between a dark section above
 * and a cream section below (or vice versa).
 */
export function FadeBand({
  direction,
  className,
}: {
  direction: "to-cream" | "to-dark";
  className?: string;
}) {
  const bg =
    direction === "to-cream"
      ? "linear-gradient(to bottom, var(--color-bg), var(--color-paper))"
      : "linear-gradient(to bottom, var(--color-paper), var(--color-bg))";
  return (
    <div
      aria-hidden
      className={cn("h-[7vh] min-h-[48px] w-full", className)}
      style={{ background: bg }}
    />
  );
}
