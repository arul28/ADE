import React from "react";
import type { NodeShape } from "./eventTaxonomy";

type EventNodeProps = {
  x: number;
  y: number;
  shape: NodeShape;
  color: string;
  selected: boolean;
  running: boolean;
  size?: number;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

export function EventNode({ x, y, shape, color, selected, running, size = 6, onClick, onMouseEnter, onMouseLeave }: EventNodeProps) {
  const fill = selected ? color : `${color}40`;
  const stroke = color;
  const strokeWidth = selected ? 2 : 1.5;
  const s = size;

  const commonProps = {
    onClick,
    onMouseEnter,
    onMouseLeave,
    style: { cursor: onClick ? "pointer" : "default" },
  };

  const wrapRunning = (node: React.ReactElement) => {
    if (!running) return node;
    return (
      <g className="ade-timeline-node-pulse">
        {node}
        <circle cx={x} cy={y} r={s + 4} fill="none" stroke={color} strokeWidth={1} opacity={0.3} />
      </g>
    );
  };

  let element: React.ReactElement;

  switch (shape) {
    case "circle":
      element = (
        <circle cx={x} cy={y} r={s} fill={fill} stroke={stroke} strokeWidth={strokeWidth} {...commonProps} />
      );
      break;
    case "diamond":
      element = (
        <rect
          x={x - s} y={y - s} width={s * 2} height={s * 2}
          fill={fill} stroke={stroke} strokeWidth={strokeWidth}
          transform={`rotate(45 ${x} ${y})`}
          {...commonProps}
        />
      );
      break;
    case "square":
      element = (
        <rect
          x={x - s} y={y - s} width={s * 2} height={s * 2}
          fill={fill} stroke={stroke} strokeWidth={strokeWidth}
          {...commonProps}
        />
      );
      break;
    case "triangle":
      element = (
        <polygon
          points={`${x},${y - s} ${x + s},${y + s} ${x - s},${y + s}`}
          fill={fill} stroke={stroke} strokeWidth={strokeWidth}
          {...commonProps}
        />
      );
      break;
    case "pill": {
      const pw = s * 2.5;
      const ph = s * 1.2;
      element = (
        <rect
          x={x - pw / 2} y={y - ph / 2} width={pw} height={ph} rx={ph / 2}
          fill={fill} stroke={stroke} strokeWidth={strokeWidth}
          {...commonProps}
        />
      );
      break;
    }
    case "star": {
      const outer = s;
      const inner = s * 0.4;
      const points: string[] = [];
      for (let i = 0; i < 5; i++) {
        const outerAngle = (Math.PI / 2) + (i * 2 * Math.PI / 5);
        const innerAngle = outerAngle + Math.PI / 5;
        points.push(`${x + outer * Math.cos(outerAngle)},${y - outer * Math.sin(outerAngle)}`);
        points.push(`${x + inner * Math.cos(innerAngle)},${y - inner * Math.sin(innerAngle)}`);
      }
      element = (
        <polygon
          points={points.join(" ")}
          fill={fill} stroke={stroke} strokeWidth={strokeWidth}
          {...commonProps}
        />
      );
      break;
    }
    case "bookmark": {
      const bw = s * 1.2;
      const bh = s * 1.6;
      const d = `M${x - bw} ${y - bh} L${x - bw} ${y + bh} L${x} ${y + bh * 0.5} L${x + bw} ${y + bh} L${x + bw} ${y - bh} Z`;
      element = (
        <path d={d} fill={fill} stroke={stroke} strokeWidth={strokeWidth} {...commonProps} />
      );
      break;
    }
    case "dot":
    default:
      element = (
        <circle cx={x} cy={y} r={s * 0.6} fill={fill} stroke={stroke} strokeWidth={strokeWidth} {...commonProps} />
      );
      break;
  }

  if (selected) {
    return (
      <g>
        <circle cx={x} cy={y} r={s + 6} fill={`${color}15`} stroke="none" />
        {wrapRunning(element)}
      </g>
    );
  }

  return wrapRunning(element);
}
