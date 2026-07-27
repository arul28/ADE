import type { CSSProperties } from "react";

/** Semantic palette — resolves against `[data-theme]` / `:root` in `index.css`. */
export const COLORS = {
  pageBg: "var(--color-bg)",
  cardBg: "rgba(255,255,255,0.03)",
  cardBgSolid: "#181423",
  recessedBg: "rgba(255,255,255,0.02)",
  hoverBg: "color-mix(in srgb, var(--color-fg) 6%, transparent)",
  border: "var(--color-border)",
  outlineBorder: "color-mix(in srgb, var(--color-border) 88%, var(--color-fg) 12%)",
  borderMuted: "color-mix(in srgb, var(--color-border) 55%, transparent)",
  accent: "var(--color-accent)",
  accentSubtle: "var(--color-accent-muted)",
  accentBorder: "color-mix(in srgb, var(--color-accent) 24%, transparent)",
  textPrimary: "var(--color-fg)",
  textSecondary: "var(--color-secondary-fg)",
  textMuted: "var(--color-muted-fg)",
  textDim: "color-mix(in srgb, var(--color-muted-fg) 88%, var(--color-bg) 12%)",
  success: "var(--color-success)",
  checkPass: "var(--color-check-pass)",
  prSurface: "var(--pr-surface)",
  threadCard: "var(--pr-thread-card)",
  panelCard: "var(--pr-panel-card)",
  danger: "var(--color-error)",
  warning: "var(--color-warning)",
  info: "var(--color-info)",
  entryChat: "var(--color-accent)",
  entryCli: "var(--color-warning)",
  entryShell: "var(--color-success)",
} as const;

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
export const SANS_FONT = "var(--font-sans)";
export const MONO_FONT = "var(--font-mono)";

export const LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
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
 * Fills, borders, and text for elements that should reflect a lane’s chosen
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
      background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
      border: "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
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
      text: `color-mix(in srgb, ${c} 52%, var(--color-muted-fg))`,
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
    background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 85%, transparent)",
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
    color: "var(--color-bg)",
    background: "var(--color-fg)",
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
    background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
    border: "1px solid transparent",
    borderRadius: 8,
    cursor: "pointer",
    ...overrides,
  };
}

export function cardStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: "1px solid color-mix(in srgb, var(--color-border) 88%, transparent)",
    borderRadius: 16,
    padding: 20,
    ...overrides,
  };
}

export function recessedStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: "color-mix(in srgb, var(--color-muted) 92%, var(--color-bg) 8%)",
    border: "1px solid color-mix(in srgb, var(--color-border) 75%, transparent)",
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
    background: "var(--pr-panel-card)",
    border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
    borderRadius: RADII.lg,
    boxShadow: "var(--shadow-panel)",
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
