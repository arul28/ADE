import type { CSSProperties } from "react";

export const COLORS = {
  pageBg: "#0F0D14",
  cardBg: "#13101A",
  recessedBg: "#0C0A10",
  hoverBg: "#1A1720",
  border: "#1E1B26",
  outlineBorder: "#27272A",
  borderMuted: "#52525B",
  accent: "#A78BFA",
  accentSubtle: "#A78BFA18",
  accentBorder: "#A78BFA30",
  textPrimary: "#FAFAFA",
  textSecondary: "#A1A1AA",
  textMuted: "#71717A",
  textDim: "#52525B",
  success: "#22C55E",
  danger: "#EF4444",
  warning: "#F59E0B",
  info: "#3B82F6",
} as const;

export const MONO_FONT = "JetBrains Mono, monospace";
export const SANS_FONT = "'Space Grotesk', sans-serif";

export const LABEL_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

export function inlineBadge(color: string, overrides?: CSSProperties): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 700,
    fontFamily: MONO_FONT,
    textTransform: "uppercase",
    letterSpacing: "1px",
    color,
    background: `${color}18`,
    border: `1px solid ${color}30`,
    borderRadius: 0,
    ...overrides,
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
    fontSize: 11,
    fontWeight: 700,
    fontFamily: MONO_FONT,
    textTransform: "uppercase",
    letterSpacing: "1px",
    color: COLORS.textSecondary,
    background: "transparent",
    border: `1px solid ${COLORS.outlineBorder}`,
    borderRadius: 0,
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
    padding: "0 12px",
    fontSize: 11,
    fontWeight: 700,
    fontFamily: MONO_FONT,
    textTransform: "uppercase",
    letterSpacing: "1px",
    color: COLORS.pageBg,
    background: COLORS.accent,
    border: `1px solid ${COLORS.accent}`,
    borderRadius: 0,
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
    padding: "0 12px",
    fontSize: 11,
    fontWeight: 700,
    fontFamily: MONO_FONT,
    textTransform: "uppercase",
    letterSpacing: "1px",
    color: COLORS.danger,
    background: `${COLORS.danger}18`,
    border: `1px solid ${COLORS.danger}30`,
    borderRadius: 0,
    cursor: "pointer",
    ...overrides,
  };
}

export function cardStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: COLORS.cardBg,
    border: `1px solid ${COLORS.border}`,
    padding: 20,
    ...overrides,
  };
}

export function recessedStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: COLORS.recessedBg,
    padding: 12,
    ...overrides,
  };
}

export function conflictDotColor(status: string | undefined): string {
  switch (status) {
    case "conflict-active":
      return COLORS.danger;
    case "conflict-predicted":
      return COLORS.warning;
    case "behind-base":
      return COLORS.warning;
    case "merge-ready":
      return COLORS.success;
    default:
      return COLORS.textMuted;
  }
}

export function stateColor(state: string): string {
  switch (state) {
    case "active":
    case "running":
      return COLORS.success;
    case "error":
    case "failed":
      return COLORS.danger;
    case "pending":
    case "queued":
      return COLORS.warning;
    default:
      return COLORS.textMuted;
  }
}
