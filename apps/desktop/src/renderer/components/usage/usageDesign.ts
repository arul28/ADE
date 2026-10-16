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
 * removed. Raw numbers appear only inline for SVG/canvas measurement —
 * contexts with no class attribute to hang a utility on.
 */
export const USAGE_TEXT = {
  hero: "text-[32px] leading-[1.05] tracking-[-0.02em]",
  title: "text-[18px] leading-tight",
  body: "text-[14px] leading-normal",
  detail: "text-[12px] leading-normal",
  micro: "text-[11px] leading-normal",
} as const;



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
 * Floating surface: chart readouts, heatmap tooltips, popovers.
 *
 * Deliberately NOT `bg-surface-overlay`. That token is
 * `rgba(255, 255, 255, 0.92)` on the light theme — translucent by construction,
 * so the chart and the heatmap grid showed straight through the readouts that
 * used it. It is the same mistake that made the top-bar usage popover
 * see-through. Anything that floats over content uses this instead.
 *
 * `--ade-shell-surface` is the hook ADE's own popovers read; light themes set
 * it, dark leaves it unset, so on dark pages the fallback is what renders. The fallback here is the theme's
 * opaque raised token rather than the shell's hardcoded `#121019`, because
 * these readouts carry `text-fg` and a fixed dark plate would be dark-on-dark
 * text under the light theme.
 */
export const USAGE_OVERLAY_BG_CLASS =
  "bg-[color:var(--ade-shell-surface,var(--color-surface-raised))]";

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
 * Quota headroom bands, by percent LEFT. One rule for every quota meter — the
 * header rings and the popover/settings window bars — regardless of provider:
 * at or above `ok` is green, at or above `warn` is yellow, below is red.
 */
export const USAGE_HEADROOM_THRESHOLDS = {
  ok: 50,
  warn: 25,
} as const;

export type UsageHeadroomTone = "ok" | "warn" | "critical";

export function usageHeadroomTone(percentLeft: number): UsageHeadroomTone {
  if (percentLeft >= USAGE_HEADROOM_THRESHOLDS.ok) return "ok";
  if (percentLeft >= USAGE_HEADROOM_THRESHOLDS.warn) return "warn";
  return "critical";
}

/** The app theme's own status tokens (light and dark both declare them). */
export const USAGE_HEADROOM_COLOR: Record<UsageHeadroomTone, string> = {
  ok: "var(--color-success)",
  warn: "var(--color-warning)",
  critical: "var(--color-error)",
};

export function usageHeadroomColor(percentLeft: number): string {
  return USAGE_HEADROOM_COLOR[usageHeadroomTone(percentLeft)];
}

/**
 * The neutral-meter level for a quota, by percent LEFT: the kit meters and
 * gauges stay neutral until a window is nearly spent, then warn at 20% left
 * and go critical at 5%. Every `.kit-meter` / gauge / home ring reads this.
 */
export type UsageLeftLevel = "warn" | "crit";

export function usageLeftLevel(percentLeft: number): UsageLeftLevel | undefined {
  if (percentLeft <= 5) return "crit";
  if (percentLeft <= 20) return "warn";
  return undefined;
}

/** The theme colour for a `usageLeftLevel`, or `fallback` while the quota is healthy. */
export function usageLeftLevelColor(level: UsageLeftLevel | undefined, fallback: string): string {
  if (level === "crit") return "var(--kit-crit)";
  if (level === "warn") return "var(--kit-warn)";
  return fallback;
}

/**
 * Thresholds for spend meters (extra usage), by percent SPENT. Quota windows
 * use `usageHeadroomColor` instead.
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
