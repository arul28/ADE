/**
 * Design tokens for the Automations UI.
 *
 * These resolve to the app's semantic, theme-aware tokens (the same vocabulary
 * the PRs and Lanes tabs use) rather than the old bespoke blue palette. Density
 * is compact — Linear-grade rows and forms, not a settings page.
 */

export const inputCls =
  "h-8 w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 text-xs text-fg outline-none transition-colors placeholder:text-muted-fg/55 hover:border-white/[0.14] focus:border-accent/45 focus:ring-1 focus:ring-accent/20";

export const selectCls = `${inputCls} cursor-pointer appearance-none pr-7`;

export const textareaCls =
  "w-full resize-y rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-xs leading-relaxed text-fg outline-none transition-colors placeholder:text-muted-fg/55 hover:border-white/[0.14] focus:border-accent/45 focus:ring-1 focus:ring-accent/20";

export const labelCls =
  "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-fg/70";

/** A raised section card — the builder's primary surface. */
export const sectionCls =
  "rounded-xl border border-white/[0.07] bg-white/[0.03] shadow-card";

/** A padded card variant for standalone panels. */
export const cardCls =
  "rounded-xl border border-white/[0.07] bg-white/[0.03] p-4 shadow-card";

/** A recessed inner surface (filters, previews, nested rows). */
export const recessedCls =
  "rounded-lg border border-white/[0.06] bg-black/[0.14]";
