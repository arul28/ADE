/**
 * The webhook surfaces' look, in the shared surface vocabulary: neutral
 * planes mixed from the theme's fg/bg, colour reserved for status, mono
 * uppercase eyebrows, mono status tags. The values mirror the surface kit
 * (`.kit-eyebrow`, `.kit-tag`, `.ade-modern-rows`, `.ade-ap-choice`) so these
 * panels sit beside Settings and the usage panel as one system.
 */

import { cn } from "../ui/cn";

export type SurfaceTone = "neutral" | "ok" | "warn" | "crit" | "info";

/** Mono, uppercase, wide-tracked: section labels and metadata. */
export const eyebrowCls = "font-mono text-[10px] font-medium uppercase leading-[14px] tracking-[0.22em] text-muted-fg";

/** A grouped panel: rows inside share one edge. */
export const panelCls =
  "overflow-hidden rounded-[var(--radius-lg)] border border-[color-mix(in_srgb,var(--color-fg)_8%,transparent)] bg-[color-mix(in_srgb,var(--color-fg)_2.5%,transparent)]";

/** Divider between rows of a panel. */
export const ruleCls = "border-[color-mix(in_srgb,var(--color-fg)_7%,transparent)]";

/** Row hover, as on every list row in the kit. */
export const rowHoverCls = "transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg)_5.5%,transparent)]";

const TAG_TONES: Record<SurfaceTone, string> = {
  neutral: "bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)] text-[color-mix(in_srgb,var(--color-fg)_70%,var(--color-muted-fg))]",
  ok: "bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-[var(--color-success)]",
  warn: "bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[var(--color-warning)]",
  crit: "bg-[color-mix(in_srgb,var(--color-error)_14%,transparent)] text-[var(--color-error)]",
  info: "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]",
};

/** Small mono tag for status words ("Ran", "Skipped", "Public"). */
export function tagCls(tone: SurfaceTone): string {
  return cn("inline-flex h-[18px] shrink-0 items-center rounded-[4px] px-1.5 font-mono text-[10px] tracking-[0.06em]", TAG_TONES[tone]);
}

const DOT_TONES: Record<SurfaceTone, string> = {
  neutral: "bg-[color-mix(in_srgb,var(--color-muted-fg)_60%,transparent)]",
  ok: "bg-[var(--color-success)]",
  warn: "bg-[var(--color-warning)]",
  crit: "bg-[var(--color-error)]",
  info: "bg-[var(--color-accent)]",
};

export function dotCls(tone: SurfaceTone): string {
  return cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_TONES[tone]);
}

/** A choice card / chip: neutral edge, the active one lifted by a stronger edge, never a tint. */
export function choiceCls(active: boolean): string {
  return cn(
    "rounded-[var(--radius-lg)] border text-fg transition-colors",
    active
      ? "border-[color-mix(in_srgb,var(--color-fg)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-fg)_4.5%,transparent)]"
      : "border-[color-mix(in_srgb,var(--color-fg)_9%,transparent)] bg-[color-mix(in_srgb,var(--color-fg)_2.5%,transparent)] hover:border-[color-mix(in_srgb,var(--color-fg)_18%,transparent)]",
  );
}

/** Text tones for one-line status copy next to a control. */
export const toneTextCls: Record<SurfaceTone, string> = {
  neutral: "text-muted-fg",
  ok: "text-[var(--color-success)]",
  warn: "text-[var(--color-warning)]",
  crit: "text-[var(--color-error)]",
  info: "text-[var(--color-accent)]",
};
