/**
 * Shared visual vocabulary for every usage surface.
 *
 * The usage surfaces previously carried eight distinct font sizes below 13px
 * and three separate styling systems (Tailwind utilities, inline `COLORS`
 * objects, and hardcoded `rgba()` literals baked into a `CARD_STYLE` constant).
 * The literals were the reason the panels could not follow the app theme: they
 * encoded a dark background directly rather than reading the CSS variables that
 * `tailwind.config.cjs` already exposes as `bg` / `fg` / `card` / `border` /
 * `surface-raised`.
 *
 * Everything here resolves to those variables, so the same components render
 * correctly in light and dark without a second palette.
 */

/**
 * Five steps, and no more. Anything that does not fit one of these belongs to a
 * role that already exists — pick the nearest step rather than adding a sixth.
 *
 * The rule, not a preference: every HTML/JSX node uses `USAGE_TEXT` rather than
 * an inline `style={{ fontSize }}`, so sizing lives in the same system as
 * colour instead of reintroducing the inline-style/utility split this redesign
 * removed. Raw numbers exist only for SVG/canvas measurement — contexts with no
 * class attribute to hang a utility on — which is why `USAGE_TYPE` below
 * carries only the one step those contexts actually use.
 */
export const USAGE_TEXT = {
  hero: "text-[32px] leading-[1.05] tracking-[-0.02em]",
  title: "text-[18px] leading-tight",
  body: "text-[14px] leading-normal",
  detail: "text-[12px] leading-normal",
  micro: "text-[11px] leading-normal",
} as const;

export type UsageTypeStep = keyof typeof USAGE_TEXT;

/**
 * The steps that also need a raw number, for SVG `<text>` measurement.
 *
 * Only `micro` does: the daily chart's axis ticks and day labels. The other
 * four had numeric twins that nothing read, and a second source of truth for a
 * font size is exactly how the two drift apart.
 */
export const USAGE_TYPE = {
  /** Eyebrow labels, axis ticks, footnotes. Uppercase where it is a label. */
  micro: 11,
} as const satisfies Partial<Record<UsageTypeStep, number>>;

/** Eyebrow label above a value: micro, uppercase, muted. */
export const USAGE_EYEBROW_CLASS =
  "text-[11px] uppercase tracking-[0.08em] text-muted-fg";

/**
 * The hairline every usage surface draws.
 *
 * A card drawn with the full-strength `border` token is an *outline*: on the
 * light theme it is a hard grey rule around a pure-white box on a cream page,
 * which is what "rigid white borders, feels thin" was describing. Panels
 * elsewhere in ADE (the shell header, the Work panes, the popovers) all soften
 * their edge and let elevation carry the separation instead. Mixing the border
 * token toward transparent keeps the token — and the theme — while dropping the
 * edge back to a seam.
 */
export const USAGE_HAIRLINE_CLASS =
  "border-[color:color-mix(in_srgb,var(--color-border)_55%,transparent)]";

/** The same seam as a divider (`border-t`, `border-b`, `divide-*`). */
export const USAGE_DIVIDER_COLOR_CLASS =
  "border-[color:color-mix(in_srgb,var(--color-border)_45%,transparent)]";

/**
 * Card surface, expressed in theme tokens.
 *
 * Replaces the previous hardcoded gradient
 * (`linear-gradient(180deg, rgba(28,27,38,0.72) ...)`) which was dark-only, and
 * then the hairline-outline pass that followed it. `shadow-panel` is the only
 * elevation token the light theme re-declares, so it is the one that actually
 * lifts the card off the page in both themes rather than stamping a dark halo
 * under a white box.
 */
export const USAGE_CARD_CLASS =
  `rounded-xl border ${USAGE_HAIRLINE_CLASS} bg-surface-raised shadow-panel`;

/**
 * A panel's title strip.
 *
 * Tinted a step toward the recessed surface so the card reads as a panel with a
 * head and a body, not as a rectangle with a line across it.
 */
export const USAGE_PANEL_HEADER_CLASS =
  `border-b ${USAGE_DIVIDER_COLOR_CLASS} bg-[color:color-mix(in_srgb,var(--color-surface-recessed)_65%,transparent)]`;

/**
 * Floating surface: chart readouts, heatmap tooltips, popovers.
 *
 * Deliberately NOT `bg-surface-overlay`. That token is
 * `rgba(255, 255, 255, 0.92)` on the light theme — translucent by construction,
 * so the chart and the heatmap grid showed straight through the readouts that
 * used it. It is the same mistake that made the top-bar usage popover
 * see-through. Anything that floats over content uses this instead.
 *
 * Deliberately NOT `--shell-surface` either, which is what the top-bar popovers
 * read: that token still carries the shell's historic dark plate on both
 * schemes, and these readouts are drawn in `text-fg`, so it would be
 * dark-on-dark under the light theme. The theme's raised token is the one that
 * is opaque in both.
 */
export const USAGE_OVERLAY_BG_CLASS =
  "bg-[color:var(--color-surface-raised)]";

export const USAGE_OVERLAY_CLASS =
  "rounded-lg border border-[color:color-mix(in_srgb,var(--color-border)_80%,var(--color-fg)_10%)]"
  + ` ${USAGE_OVERLAY_BG_CLASS} text-fg shadow-float`;

/**
 * Track behind a progress or share bar.
 *
 * The track must be visible at 0%. `bg-muted` is `#1E1B28` against a
 * `#1E1B2E` card — a one-step difference nobody can see — so a window with no
 * usage yet rendered as a blank gap and read as "failed to load" rather than
 * "zero". A wash of the foreground colour is legible on both themes and needs
 * no second palette.
 */
export const USAGE_BAR_TRACK_CLASS =
  "overflow-hidden rounded-full bg-[color:color-mix(in_srgb,var(--color-fg)_14%,transparent)]"
  + " contrast-more:bg-[color:color-mix(in_srgb,var(--color-fg)_28%,transparent)]";

/**
 * Selection, borrowed rather than invented.
 *
 * `settings/primitives/SettingsControls.tsx` already signals a chosen option
 * with an accent-tinted fill inside an accent-tinted border, on a recessed
 * track. That is the vocabulary the rest of Settings uses, so the usage
 * controls speak it too — the previous `bg-muted` active state was a two-step
 * lightness change on a dark theme and read as nothing at all.
 */
export const USAGE_SEGMENT_TRACK_CLASS =
  "inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-recessed p-0.5";

export const USAGE_SEGMENT_ITEM_CLASS =
  "rounded-md border border-transparent px-2.5 py-1 transition-[background-color,color,border-color] duration-150 motion-reduce:transition-none";

export const USAGE_SEGMENT_ITEM_ACTIVE_CLASS =
  "border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_16%,transparent)] font-semibold text-fg";

export const USAGE_SEGMENT_ITEM_IDLE_CLASS =
  "font-medium text-muted-fg hover:bg-muted hover:text-fg";

/**
 * A bordered control that is not a segment: Refresh, Retry, Reconnect.
 * Same resting surface as the segmented track so a toolbar reads as one row.
 */
export const USAGE_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-recessed font-medium text-muted-fg transition-[background-color,color,border-color] duration-150 hover:bg-muted hover:text-fg disabled:opacity-50 motion-reduce:transition-none";

/** Hoverable row or cell: a surface that acknowledges the cursor. */
export const USAGE_HOVER_ROW_CLASS =
  "transition-[background-color,opacity] duration-150 motion-reduce:transition-none";

/**
 * Live figures update while the panel is on screen. Without a fixed advance,
 * every refresh reflows the row and its neighbours shuffle sideways.
 */
export const USAGE_NUMERIC_CLASS = "tabular-nums";

/**
 * How many provider series the daily chart draws before merging the remainder.
 *
 * ADE tracks far more providers than the two the chart was modelled on. Beyond
 * roughly four the layered fills stop being separable by colour, so the tail is
 * combined into a single neutral "Other" band rather than drawn as a dozen
 * indistinguishable slivers.
 */
export const USAGE_CHART_MAX_SERIES = 4;

/** Label for the merged tail series. */
export const USAGE_CHART_OTHER_LABEL = "Other";

/** Neutral colour for the merged tail, distinct from any brand token. */
export const USAGE_CHART_OTHER_COLOR = "var(--color-muted-fg)";

/**
 * Thresholds shared by the pace bars and the header chip, so "nearly dry" means
 * the same thing in the top bar as it does on the page.
 */
export const USAGE_PRESSURE = {
  warn: 70,
  critical: 90,
} as const;

/** Bar fill for a percentage, falling back to the provider's own colour. */
export function usagePressureColor(percent: number, providerColor: string): string {
  if (percent > USAGE_PRESSURE.critical) return "var(--color-usage-critical, #F87171)";
  if (percent > USAGE_PRESSURE.warn) return "var(--color-usage-warn, #F5A623)";
  return providerColor;
}
