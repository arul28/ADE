import type { CSSProperties } from "react";
import type { ProcessRuntimeStatus } from "../../../shared/types";

export const COLORS = {
  pageBg: "#0C0B10",
  cardBg: "rgba(255,255,255,0.03)",
  cardBgSolid: "#1C1926",
  recessedBg: "rgba(255,255,255,0.03)",
  hoverBg: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.06)",
  outlineBorder: "rgba(255,255,255,0.08)",
  borderMuted: "rgba(255,255,255,0.04)",
  accent: "#A78BFA",
  accentSubtle: "rgba(167, 139, 250, 0.12)",
  accentBorder: "rgba(167, 139, 250, 0.20)",
  textPrimary: "#F0F0F2",
  textSecondary: "#A8A8B4",
  textMuted: "#908FA0",
  textDim: "#5E5A70",
  success: "#22C55E",
  danger: "#EF4444",
  warning: "#F59E0B",
  info: "#3B82F6",
  entryChat: "#8B5CF6",
  entryCli: "#F97316",
  entryShell: "#22C55E",
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
    background: `${color}10`,
    border: "1px solid transparent",
    borderRadius: 6,
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
    fontSize: 12,
    fontWeight: 500,
    fontFamily: SANS_FONT,
    color: COLORS.textSecondary,
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.06)",
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
    background: `${COLORS.danger}10`,
    border: "1px solid transparent",
    borderRadius: 8,
    cursor: "pointer",
    ...overrides,
  };
}

export function cardStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: "rgba(255,255,255,0.03)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 16,
    padding: 20,
    ...overrides,
  };
}

export function recessedStyle(overrides?: CSSProperties): CSSProperties {
  return {
    background: "rgba(255,255,255,0.01)",
    border: "1px solid rgba(255,255,255,0.04)",
    borderRadius: 12,
    padding: 12,
    ...overrides,
  };
}

export function processStatusColor(status: ProcessRuntimeStatus | undefined): string {
  switch (status) {
    case "running":
      return COLORS.success;
    case "starting":
    case "stopping":
      return COLORS.warning;
    case "degraded":
    case "crashed":
    case "exited":
      return COLORS.danger;
    default:
      return COLORS.textDim;
  }
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
