import type { CSSProperties } from "react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";

export const panelStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

export const machineRowStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "12px 14px",
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(255,255,255,0.02)",
};

export const inlineDetailStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  marginTop: -4,
  padding: 12,
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(0,0,0,0.16)",
};

export const helperTextStyle: CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.45,
};

export const inlineErrorTextStyle: CSSProperties = {
  color: COLORS.danger,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.45,
};

export const inlineSuccessTextStyle: CSSProperties = {
  color: COLORS.success,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.45,
};

export const sectionHeaderStyle: CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: "0.08em",
};

export const nameStyle: CSSProperties = {
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 13,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const subTextStyle: CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: MONO_FONT,
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
