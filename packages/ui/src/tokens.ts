/**
 * The kit's design tokens — a straight port of the desktop app's
 * `laneDesignTokens`, with one change: every colour resolves through an
 * `--ade-*` custom property that FALLS BACK to the desktop's own `--color-*`
 * variable.
 *
 *   var(--ade-bg, var(--color-bg))
 *
 * That single indirection is what lets the same module serve both hosts:
 *
 * - Inside the desktop app nothing defines `--ade-*`, so every token collapses
 *   to the exact `--color-*` reference the app has always used. The rendered
 *   value is identical, theme switching still works, and no stylesheet has to
 *   be injected.
 * - Inside a plugin webview there is no `index.css`, so the page calls
 *   `applyAdeTheme()` with the palette handed over by the host bridge. That
 *   sets `--ade-*` on `:root` and every token resolves against it.
 *
 * No Tailwind, no `useAppStore`, no Electron, no app routing.
 */

import type { CSSProperties } from "react";

/** Every custom property this package reads. Nothing else is themeable. */
export const ADE_TOKENS = [
  "--ade-bg",
  "--ade-fg",
  "--ade-surface",
  "--ade-card",
  "--ade-card-fg",
  "--ade-card-solid",
  "--ade-muted",
  "--ade-muted-fg",
  "--ade-secondary-fg",
  "--ade-border",
  "--ade-accent",
  "--ade-accent-fg",
  "--ade-accent-muted",
  "--ade-success",
  "--ade-warning",
  "--ade-error",
  "--ade-info",
  "--ade-check-pass",
  "--ade-pr-surface",
  "--ade-pr-thread-card",
  "--ade-pr-panel-card",
  "--ade-shadow-panel",
  "--ade-font-sans",
  "--ade-font-mono",
] as const;

export type AdeToken = (typeof ADE_TOKENS)[number];
export type AdeTheme = Record<AdeToken, string>;
export type AdeColorScheme = "light" | "dark";

/**
 * A token reference with the desktop variable as its fallback.
 *
 * Exported because the Linear icons and the stylesheet build the same kind of
 * reference, and one spelling of the rule is easier to keep honest than three.
 */
export function adeVar(token: AdeToken, desktopFallback: string): string {
  return `var(${token}, var(--${desktopFallback}))`;
}

export const SANS_FONT = adeVar("--ade-font-sans", "font-sans");
export const MONO_FONT = adeVar("--ade-font-mono", "font-mono");

const FG = adeVar("--ade-fg", "color-fg");
const BORDER = adeVar("--ade-border", "color-border");

/** Semantic palette. Same keys, same meanings, as the desktop's `COLORS`. */
export const COLORS = {
  pageBg: adeVar("--ade-bg", "color-bg"),
  cardBg: "rgba(255,255,255,0.03)",
  cardBgSolid: adeVar("--ade-card-solid", "color-card-solid"),
  recessedBg: "rgba(255,255,255,0.02)",
  hoverBg: `color-mix(in srgb, ${FG} 6%, transparent)`,
  border: BORDER,
  outlineBorder: `color-mix(in srgb, ${BORDER} 88%, ${FG} 12%)`,
  borderMuted: `color-mix(in srgb, ${BORDER} 55%, transparent)`,
  accent: adeVar("--ade-accent", "color-accent"),
  accentSubtle: adeVar("--ade-accent-muted", "color-accent-muted"),
  accentBorder: `color-mix(in srgb, ${adeVar("--ade-accent", "color-accent")} 24%, transparent)`,
  textPrimary: FG,
  textSecondary: adeVar("--ade-secondary-fg", "color-secondary-fg"),
  textMuted: adeVar("--ade-muted-fg", "color-muted-fg"),
  textDim: `color-mix(in srgb, ${adeVar("--ade-muted-fg", "color-muted-fg")} 88%, ${adeVar("--ade-bg", "color-bg")} 12%)`,
  success: adeVar("--ade-success", "color-success"),
  checkPass: adeVar("--ade-check-pass", "color-check-pass"),
  prSurface: adeVar("--ade-pr-surface", "pr-surface"),
  threadCard: adeVar("--ade-pr-thread-card", "pr-thread-card"),
  panelCard: adeVar("--ade-pr-panel-card", "pr-panel-card"),
  danger: adeVar("--ade-error", "color-error"),
  warning: adeVar("--ade-warning", "color-warning"),
  info: adeVar("--ade-info", "color-info"),
  entryChat: adeVar("--ade-accent", "color-accent"),
  entryCli: adeVar("--ade-warning", "color-warning"),
  entryShell: adeVar("--ade-success", "color-success"),
} as const;

/** A `tokens` map keyed by the bare token name, for `theme.get()` round-trips. */
export const tokens: Record<string, string> = Object.fromEntries(
  ADE_TOKENS.map((token) => [token, `var(${token})`]),
);

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const FONT_SIZES = {
  xs: 9,
  sm: 10,
  md: 11,
  base: 12,
  lg: 13,
  xl: 14,
} as const;

export const RADII = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
} as const;

export const APP_FONT_STACK = "\"Geist\", -apple-system, BlinkMacSystemFont, sans-serif";

export const LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
};

/** Uppercase mono heading used for the section bands inside settings panels. */
export const SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: 10,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textMuted,
  fontWeight: 700,
};

export function inlineBadge(color: string, overrides?: CSSProperties): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 8px",
    fontSize: 11,
    fontWeight: 500,
    fontFamily: SANS_FONT,
    color,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
    borderRadius: 6,
    ...overrides,
  };
}

/**
 * Fills, borders, and text for elements that should reflect a lane's chosen
 * color (from the Lanes tab) with a consistent shaded treatment.
 */
export function laneSurfaceTint(
  color: string | null | undefined,
  strength: "soft" | "default" | "pastel" = "default",
  alpha?: number,
): {
  background: string;
  border: string;
  borderLeftAccent: string;
  text: string | null;
} {
  if (color == null || String(color).trim() === "") {
    return {
      background: `color-mix(in srgb, ${FG} 4%, transparent)`,
      border: `1px solid color-mix(in srgb, ${BORDER} 72%, transparent)`,
      borderLeftAccent: "2px solid transparent",
      text: null,
    };
  }
  const c = String(color).trim();
  if (strength === "pastel") {
    return {
      background: `color-mix(in srgb, ${c} 8%, rgba(255, 255, 255, 0.035))`,
      border: `1px solid color-mix(in srgb, ${c} 14%, rgba(255, 255, 255, 0.05))`,
      borderLeftAccent: `2px solid color-mix(in srgb, ${c} 40%, transparent)`,
      text: `color-mix(in srgb, ${c} 52%, ${COLORS.textMuted})`,
    };
  }
  const p = alpha != null && Number.isFinite(alpha)
    ? Math.max(0, Math.min(100, Math.round(alpha * 100)))
    : strength === "soft" ? 10 : 16;
  return {
    background: `color-mix(in srgb, ${c} ${p}%, rgba(10, 10, 12, 0.65))`,
    border: `1px solid color-mix(in srgb, ${c} 28%, rgba(255, 255, 255, 0.06))`,
    borderLeftAccent: `2px solid ${c}`,
    text: c,
  };
}

/**
 * The vertical rail drawn beside an expanded lane group's indented rows.
 *
 * It is deliberately a TINT, not a stripe: at ~25% the lane accent is enough to
 * say which group the rows belong to while staying quieter than the lane name it
 * hangs under. A lane with no accent falls back to the same neutral hairline
 * every other divider uses.
 */
export function laneRailTint(color: string | null | undefined, percent = 25): string {
  const c = typeof color === "string" ? color.trim() : "";
  if (!c) return "rgba(255,255,255,0.07)";
  // Every lane colour ADE assigns is a hex literal, and resolving it to `rgba`
  // here rather than leaning on `color-mix` keeps the value a real colour any
  // engine can parse — jsdom included, so the rail is assertable in tests.
  const rgb = hexToRgb(c);
  if (rgb) return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${percent / 100})`;
  return `color-mix(in srgb, ${c} ${percent}%, transparent)`;
}

function hexToRgb(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const digits = match[1]!;
  const full = digits.length === 3
    ? digits.split("").map((d) => `${d}${d}`).join("")
    : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function outlineButton(overrides?: CSSProperties): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 32,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    fontFamily: SANS_FONT,
    color: COLORS.textSecondary,
    background: `color-mix(in srgb, ${FG} 4%, transparent)`,
    border: `1px solid color-mix(in srgb, ${BORDER} 85%, transparent)`,
    borderRadius: 8,
    cursor: "pointer",
    ...overrides,
  };
}

export function primaryButton(overrides?: CSSProperties): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 32,
    padding: "0 14px",
    fontSize: 12,
    fontWeight: 500,
    fontFamily: SANS_FONT,
    color: COLORS.pageBg,
    background: FG,
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    ...overrides,
  };
}

export function dangerButton(overrides?: CSSProperties): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 32,
    padding: "0 14px",
    fontSize: 12,
    fontWeight: 500,
    fontFamily: SANS_FONT,
    color: COLORS.danger,
    background: `color-mix(in srgb, ${COLORS.danger} 10%, transparent)`,
    border: "1px solid transparent",
    borderRadius: 8,
    cursor: "pointer",
    ...overrides,
  };
}

export function cardStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: `color-mix(in srgb, ${adeVar("--ade-card", "color-card")} 90%, ${COLORS.pageBg} 10%)`,
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: `1px solid color-mix(in srgb, ${BORDER} 88%, transparent)`,
    borderRadius: 16,
    padding: 20,
    ...overrides,
  };
}

export function recessedStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: `color-mix(in srgb, ${adeVar("--ade-muted", "color-muted")} 92%, ${COLORS.pageBg} 8%)`,
    border: `1px solid color-mix(in srgb, ${BORDER} 75%, transparent)`,
    borderRadius: 12,
    padding: 12,
    ...overrides,
  };
}

/**
 * Neutral elevated surface for floating side-rail panes (Linear-style): a hair
 * lighter than the page background — NOT tinted purple — with a hairline border
 * and a soft drop shadow so the pane reads as floating. Theme-aware.
 */
export function floatingPane(overrides?: CSSProperties): CSSProperties {
  return {
    background: COLORS.panelCard,
    border: `1px solid color-mix(in srgb, ${BORDER} 70%, transparent)`,
    borderRadius: RADII.lg,
    boxShadow: adeVar("--ade-shadow-panel", "shadow-panel"),
    ...overrides,
  };
}

export function healthColor(status: string): string {
  switch (status) {
    case "healthy":
      return COLORS.success;
    case "degraded":
      return COLORS.warning;
    case "unhealthy":
      return COLORS.danger;
    case "unknown":
    default:
      return COLORS.textDim;
  }
}

export function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}
