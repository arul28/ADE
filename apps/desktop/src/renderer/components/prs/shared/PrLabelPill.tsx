import React from "react";
import { SANS_FONT } from "../../lanes/laneDesignTokens";

/** Readable text on a GitHub label colour (hex without `#`). */
export function labelTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1a1a2e" : "#f0f0f0";
}

/**
 * A GitHub label as GitHub draws it: a pill in the label's own colour. The
 * PR rows, the filter picker and the filter chips all use this one shape, so
 * a label looks the same wherever it is picked or shown.
 */
export function PrLabelPill({
  name,
  color,
  children,
  style,
}: {
  name: string;
  /** Hex without `#`; a label with no colour gets a neutral pill. */
  color: string | null | undefined;
  /** Trailing content inside the pill (a remove button). */
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const hasColor = Boolean(color && /^[0-9a-f]{3,8}$/i.test(color));
  return (
    <span
      title={name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        minWidth: 0,
        maxWidth: "100%",
        padding: "1px 8px",
        fontSize: 10,
        fontWeight: 600,
        fontFamily: SANS_FONT,
        color: hasColor ? labelTextColor(color!) : "var(--kit-text-2)",
        background: hasColor ? `#${color}` : "color-mix(in srgb, var(--color-fg) 9%, transparent)",
        borderRadius: 10,
        lineHeight: "16px",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      {children}
    </span>
  );
}
