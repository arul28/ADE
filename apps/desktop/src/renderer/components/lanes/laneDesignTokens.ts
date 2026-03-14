import type { CSSProperties } from "react";
import type { ProcessRuntimeStatus } from "../../../shared/types";

export const COLORS = {
  pageBg: "#09080C",
  cardBg: "rgba(255,255,255,0.03)",
  cardBgSolid: "#181423",
  recessedBg: "rgba(255,255,255,0.02)",
  hoverBg: "rgba(255,255,255,0.06)",
  border: "rgba(255,255,255,0.06)",
  outlineBorder: "rgba(255,255,255,0.08)",
  borderMuted: "rgba(255,255,255,0.04)",
  accent: "#A78BFA",
  accentSubtle: "rgba(167, 139, 250, 0.08)",
  accentBorder: "rgba(167, 139, 250, 0.20)",
  textPrimary: "#FAFAFA",
  textSecondary: "#A1A1AA",
  textMuted: "#8B8B9A",
  textDim: "#5A5670",
  success: "#22C55E",
  danger: "#EF4444",
  warning: "#F59E0B",
  info: "#3B82F6",
} as const;

export const MONO_FONT = "JetBrains Mono, monospace";
export const SANS_FONT = "Geist, -apple-system, BlinkMacSystemFont, sans-serif";

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
