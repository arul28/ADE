import React from "react";

type ConnectorLineProps = {
  d: string;
  color: string;
  dashed: boolean;
  dimmed: boolean;
  width?: number;
};

export function ConnectorLine({ d, color, dashed, dimmed, width = 1.5 }: ConnectorLineProps) {
  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeDasharray={dashed ? "4 3" : "none"}
      opacity={dimmed ? 0.15 : 0.6}
      strokeLinecap="square"
    />
  );
}
