import React from "react";
import type { LaneSummary } from "../../../shared/types";
import { getLaneAccent } from "./laneColorPalette";

type Props = {
  lane?: Pick<LaneSummary, "color"> | null;
  color?: string | null;
  fallbackIndex?: number;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  ringed?: boolean;
};

export function LaneAccentDot({ lane, color, fallbackIndex = 0, size = 8, className, style, ringed = true }: Props) {
  const resolved = color ?? getLaneAccent(lane, fallbackIndex);
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 9999,
        background: resolved,
        boxShadow: ringed ? "inset 0 0 0 1px rgba(255,255,255,0.12)" : undefined,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
