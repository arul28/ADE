import React from "react";

type LaneTrackProps = {
  x: number;
  y1: number;
  y2: number;
  color: string;
  dimmed: boolean;
  width?: number;
};

export function LaneTrack({ x, y1, y2, color, dimmed, width = 1.5 }: LaneTrackProps) {
  return (
    <line
      x1={x}
      y1={y1}
      x2={x}
      y2={y2}
      stroke={color}
      strokeWidth={width}
      opacity={dimmed ? 0.12 : 0.35}
      strokeLinecap="square"
    />
  );
}
