import type { CSSProperties } from "react";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

/** Per-integration brand accents — keeps the page multi-colored, never two-tone. */
export const BRAND = {
  claude: "#D97757",
  codex: "#34D399",
  cursor: "#60A5FA",
  droid: "#A78BFA",
  opencode: "#FBBF24",
  github: "#3FB950",
  linear: "#5E6AD2",
} as const;

const CARD_BG = "color-mix(in srgb, var(--color-surface) 90%, var(--color-bg) 10%)";

export const CARD_BASE: CSSProperties = {
  background: CARD_BG,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  padding: 18,
};

/** Card with a subtle wash + border in a brand color — no left-border accent stripe. */
export function brandCard(brand: string, overrides?: CSSProperties): CSSProperties {
  return {
    ...CARD_BASE,
    background: `color-mix(in srgb, ${brand} 9%, ${CARD_BG})`,
    border: `1px solid color-mix(in srgb, ${brand} 32%, var(--color-border))`,
    ...overrides,
  };
}

export const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: COLORS.textSecondary,
};

export function statusDot(color: string, size = 8): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: size,
    background: color,
    boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
    flexShrink: 0,
  };
}

/** Rounded brand glyph holder for non-avatar marks (GitHub, Linear). */
export function logoTile(brand: string, size = 36): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: 10,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: `color-mix(in srgb, ${brand} 22%, transparent)`,
    border: `1px solid color-mix(in srgb, ${brand} 40%, transparent)`,
    color: `color-mix(in srgb, ${brand} 55%, var(--color-fg))`,
    flexShrink: 0,
  };
}

export const META_TEXT: CSSProperties = {
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.5,
};
