/* ── Shared CTO form + surface class patterns (app-aligned) ── */

/* Accent palette. Re-exported by the automations design tokens. */
export const ACCENT = {
  purple: "var(--color-accent)",
  blue: "#60A5FA",
  green: "#22C55E",
  pink: "#FB7185",
  amber: "#FBBF24",
} as const;

export const textareaCls =
  "w-full rounded-md border border-white/[0.08] bg-[rgba(12,10,22,0.6)] p-3 text-xs font-sans text-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] placeholder:text-muted-fg/40 hover:border-accent/20 focus:border-accent/40 focus:shadow-[0_0_0_2px_var(--color-accent-muted)] focus:outline-none resize-vertical transition-all duration-150";

export const cardCls =
  "rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] p-5 shadow-card backdrop-blur-[20px] transition-all duration-200 hover:shadow-card-hover hover:border-white/[0.10]";

export const recessedPanelCls =
  "rounded-lg border border-white/[0.05] bg-[rgba(12,10,22,0.6)] shadow-inset backdrop-blur-[20px]";

export const shellBodyCls =
  "flex h-full w-full overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(167,139,250,0.08),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(96,165,250,0.06),transparent_28%),linear-gradient(180deg,#0C0B10_0%,#0A0910_48%,#080810_100%)] text-fg font-sans";
