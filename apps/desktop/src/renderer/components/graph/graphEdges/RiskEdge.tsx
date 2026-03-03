import React from "react";
import { Edge, EdgeProps, Position, getBezierPath } from "@xyflow/react";
import { riskStrokeColor, prOverlayColor, prCiDotColor } from "../graphHelpers";
import type { GraphEdgeData } from "../graphTypes";

export function RiskEdge(props: EdgeProps<Edge<GraphEdgeData>>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, selected } = props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: sourcePosition ?? Position.Bottom,
    targetPosition: targetPosition ?? Position.Top
  });
  const pr = data?.pr;
  const color =
    data?.edgeType === "proposal"
      ? data.proposalConflict
        ? "#F59E0B"
        : "#22C55E"
      : data?.edgeType === "integration"
      ? "#A78BFA"
      : data?.edgeType === "risk"
        ? riskStrokeColor(data.riskLevel)
        : pr
          ? prOverlayColor(pr)
          : data?.edgeType === "stack"
            ? "#38bdf8"
            : "#6b7280";
  const width = data?.edgeType === "proposal" ? 2.2 : data?.edgeType === "integration" ? 2.4 : pr && data?.edgeType !== "risk" ? 2.6 : data?.edgeType === "stack" ? 3 : 1.8;
  const dash = data?.edgeType === "proposal" ? "6 4" : data?.edgeType === "risk" ? "5 3" : data?.edgeType === "integration" ? "8 4" : undefined;
  const effectiveWidth = (selected ? width + 1 : width) + (data?.highlight ? 0.5 : 0);
  const effectiveOpacity = data?.dimmed ? 0.16 : data?.highlight ? 1 : data?.stale ? 0.55 : 0.9;
  const badgeColor = pr ? prOverlayColor(pr) : "#6b7280";
  const dotColor = pr ? prCiDotColor(pr) : "#6b7280";
  const badgeText = pr ? `PR #${pr.number}` : "";
  const badgeWidth = Math.max(64, badgeText.length * 6 + 26);
  const badgeHeight = 18;
  return (
    <g>
      <path
        id={id}
        className="ade-edge-path"
        d={path}
        markerEnd={markerEnd}
        fill="none"
        stroke={color}
        strokeWidth={effectiveWidth}
        strokeDasharray={dash}
        opacity={effectiveOpacity}
      />
      {pr ? (
        <g transform={`translate(${labelX}, ${labelY})`} className={pr.mergeInProgress ? "ade-pr-badge-pulse" : undefined}>
          <rect
            x={-badgeWidth / 2}
            y={-badgeHeight / 2}
            width={badgeWidth}
            height={badgeHeight}
            rx={8}
            fill={badgeColor}
            fillOpacity={0.18}
            stroke={badgeColor}
            strokeOpacity={0.75}
            strokeWidth={1}
          />
          <circle
            cx={-badgeWidth / 2 + 10}
            cy={0}
            r={3}
            fill={dotColor}
            className={pr.checksStatus === "pending" ? "ade-pr-ci-pending" : undefined}
          />
          <text
            x={-badgeWidth / 2 + 18}
            y={3}
            fontSize={10}
            fill="var(--color-fg)"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace"
          >
            {badgeText}
          </text>
        </g>
      ) : null}
    </g>
  );
}
