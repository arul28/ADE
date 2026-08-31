import { Position, getBezierPath } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";
import { APP_FONT_STACK } from "../../lanes/laneDesignTokens";
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
  const edgeType = data?.edgeType;

  let color: string;
  if (edgeType === "plugin") {
    // The plugin's own accent when it has one, so its node and its line read as
    // one object. `blocks` overrides that with amber — the one thing a plugin
    // edge says that the reader must not miss under a brand colour — and amber
    // rather than red, the same ceiling `PluginBadgeTone` puts on every other
    // plugin surface: a plugin does not get to paint a lane as failed.
    color = data?.pluginEdgeKind === "blocks" ? "#F59E0B" : data?.pluginAccent || "#8B8B94";
  } else if (edgeType === "proposal") {
    color = data?.proposalConflict ? "#F59E0B" : "#22C55E";
  } else if (edgeType === "integration") {
    color = "#A78BFA";
  } else if (edgeType === "risk") {
    color = riskStrokeColor(data?.riskLevel);
  } else if (pr) {
    color = prOverlayColor(pr);
  } else if (edgeType === "stack") {
    color = "#38bdf8";
  } else {
    color = "#6b7280";
  }

  let width: number;
  // Thinner than every one of ADE's own lines, on purpose. A plugin's edge is an
  // annotation over the topology, not part of it, and the hierarchy has to be
  // visible before the colour is read.
  if (edgeType === "plugin") width = 1.4;
  else if (edgeType === "proposal") width = 2.2;
  else if (edgeType === "integration") width = 2.4;
  else if (pr && edgeType !== "risk") width = 2.6;
  else if (edgeType === "stack") width = 3;
  else width = 1.8;

  let dash: string | undefined;
  // Every plugin edge is dashed, whatever it asserts. Solid is how this canvas
  // says "git says so", and nothing a plugin publishes has earned that.
  if (edgeType === "plugin") dash = "3 3";
  else if (edgeType === "proposal") dash = "6 4";
  else if (edgeType === "risk") dash = "5 3";
  else if (edgeType === "integration") dash = "8 4";
  const effectiveWidth = (selected ? width + 1 : width) + (data?.highlight ? 0.5 : 0);
  const effectiveOpacity = data?.dimmed ? 0.16 : data?.highlight ? 1 : pr?.activityState === "stale" || data?.stale ? 0.38 : 0.92;
  const badgeColor = pr ? prOverlayColor(pr) : "#6b7280";
  const dotColor = pr ? prCiDotColor(pr) : "#6b7280";
  const badgeText = pr ? `PR #${pr.number}` : "";
  const badgeMeta = pr && pr.detailLoaded ? `${pr.reviewCount}r · ${pr.commentCount}c` : "";
  const badgeWidth = Math.max(74, (badgeText.length + badgeMeta.length) * 6 + 40);
  const badgeHeight = 18;
  const showIntegrationBadge = edgeType === "integration";
  const pluginEdgeLabel = edgeType === "plugin" ? data?.pluginEdgeLabel : undefined;
  return (
    <g>
      <path
        id={id}
        className={pr?.activityState === "active" ? "ade-edge-path ade-pr-edge-active" : "ade-edge-path"}
        d={path}
        markerEnd={markerEnd}
        fill="none"
        stroke={color}
        strokeWidth={effectiveWidth}
        strokeDasharray={dash}
        opacity={effectiveOpacity}
      />
      {showIntegrationBadge ? (
        <g transform={`translate(${labelX}, ${labelY})`}>
          <rect
            x={-22}
            y={-8}
            width={44}
            height={16}
            rx={8}
            fill="#A78BFA"
            fillOpacity={0.16}
            stroke="#A78BFA"
            strokeOpacity={0.7}
            strokeWidth={1}
          />
          <text
            x={0}
            y={3}
            textAnchor="middle"
            fontSize={9}
            fill="#E9D5FF"
            fontFamily={APP_FONT_STACK}
            style={{ letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            feeds
          </text>
        </g>
      ) : null}
      {pluginEdgeLabel ? (
        <text
          x={labelX}
          y={labelY + 3}
          textAnchor="middle"
          fontSize={9}
          fill={color}
          fontFamily={APP_FONT_STACK}
          opacity={effectiveOpacity}
          style={{ letterSpacing: "0.06em" }}
        >
          {pluginEdgeLabel}
        </text>
      ) : null}
      {pr ? (
        <g
          transform={`translate(${labelX}, ${labelY})`}
          className={pr.mergeInProgress || pr.activityState === "active" ? "ade-pr-badge-pulse" : undefined}
        >
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
            className={pr.pendingCheckCount > 0 ? "ade-pr-ci-pending" : undefined}
          />
          <text
            x={-badgeWidth / 2 + 18}
            y={3}
            fontSize={10}
            fill="var(--color-fg)"
            fontFamily={APP_FONT_STACK}
          >
            {badgeText}
          </text>
          <text
            x={badgeWidth / 2 - 8}
            y={3}
            textAnchor="end"
            fontSize={9}
            fill="var(--color-muted-fg)"
            fontFamily={APP_FONT_STACK}
          >
            {badgeMeta}
          </text>
        </g>
      ) : null}
    </g>
  );
}
