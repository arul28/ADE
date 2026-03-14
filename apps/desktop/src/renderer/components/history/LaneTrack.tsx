import React from "react";

type LaneTrackProps = {
  x: number;
  y1: number;
  y2: number;
  color: string;
  dimmed: boolean;
  width?: number;
};

export function LaneTrack({ x, y1, y2, color, dimmed, width = 2.5 }: LaneTrackProps) {
  return (
    <g>
      {/* Glow layer — wider, very transparent for bold ambient color */}
      {!dimmed && (
        <line
          x1={x}
          y1={y1}
          x2={x}
          y2={y2}
          stroke={color}
          strokeWidth={8}
          opacity={0.06}
          strokeLinecap="square"
        />
      )}
      {/* Main track line */}
      <line
        x1={x}
        y1={y1}
        x2={x}
        y2={y2}
        stroke={color}
        strokeWidth={width}
        opacity={dimmed ? 0.08 : 0.55}
        strokeLinecap="square"
      />
    </g>
  );
}
