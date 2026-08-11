import React from "react";

import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { EmptyLine, TONE_COLOR } from "./vocabularyPrimitives";
import type { VocabChartNode } from "../../../shared/plugins/vocabulary";

const CHART_VIEWBOX_WIDTH = 600;
const CHART_VIEWBOX_HEIGHT = 120;

/**
 * A deliberately small hand-rolled SVG chart, in the house style of
 * `usage/UsageDailyChart.tsx` — no charting dependency, one `<svg>`, geometry
 * computed in a memo.
 *
 * The plot stretches with `preserveAspectRatio="none"` and every stroke carries
 * `vector-effect="non-scaling-stroke"`, so a wide panel does not smear the
 * lines. Nothing textual lives inside the SVG for the same reason: labels are
 * HTML around it, where they stay the size they were asked to be.
 */
export function VocabChart({ node }: { node: VocabChartNode }) {
  const geometry = React.useMemo(() => {
    const points = node.series.flatMap((series) => series.points);
    const max = points.reduce((highest, point) => Math.max(highest, point.y), 0);
    const longest = node.series.reduce((count, series) => Math.max(count, series.points.length), 0);
    return { max: max > 0 ? max : 1, longest };
  }, [node.series]);

  const hasPoints = geometry.longest > 0;
  if (!hasPoints) return <EmptyLine text={node.emptyText ?? "No data yet."} />;

  const xAt = (index: number) =>
    geometry.longest <= 1
      ? CHART_VIEWBOX_WIDTH / 2
      : (index / (geometry.longest - 1)) * CHART_VIEWBOX_WIDTH;
  const yAt = (value: number) =>
    CHART_VIEWBOX_HEIGHT - (Math.max(0, value) / geometry.max) * CHART_VIEWBOX_HEIGHT;

  const first = node.series[0]?.points[0];
  const last = node.series[0]?.points[geometry.longest - 1];

  return (
    <figure style={{ margin: 0, display: "grid", gap: 8, minWidth: 0 }}>
      {node.title || node.series.length > 1 ? (
        <figcaption
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textMuted,
          }}
        >
          {node.title ? <span style={{ color: COLORS.textSecondary }}>{node.title}</span> : null}
          {node.series.length > 1
            ? node.series.map((series) => (
                <span key={series.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 2,
                      borderRadius: 1,
                      background: TONE_COLOR[series.tone ?? "accent"],
                    }}
                  />
                  {series.label ?? series.id}
                </span>
              ))
            : null}
        </figcaption>
      ) : null}

      <svg
        role="img"
        aria-label={node.title ?? `${node.kind} chart`}
        width="100%"
        height={CHART_VIEWBOX_HEIGHT}
        viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible" }}
      >
        <line
          x1={0}
          x2={CHART_VIEWBOX_WIDTH}
          y1={CHART_VIEWBOX_HEIGHT}
          y2={CHART_VIEWBOX_HEIGHT}
          stroke={COLORS.borderMuted}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {node.series.map((series) => {
          const color = TONE_COLOR[series.tone ?? "accent"];
          if (node.kind === "bar") {
            const slot = CHART_VIEWBOX_WIDTH / Math.max(1, geometry.longest);
            const width = Math.max(1, slot * 0.55);
            return (
              <g key={series.id}>
                {series.points.map((point, index) => {
                  const y = yAt(point.y);
                  return (
                    <rect
                      key={index}
                      x={xAt(index) - width / 2}
                      y={y}
                      width={width}
                      height={Math.max(0, CHART_VIEWBOX_HEIGHT - y)}
                      fill={color}
                      fillOpacity={0.55}
                    />
                  );
                })}
              </g>
            );
          }
          const path = series.points
            .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index)},${yAt(point.y)}`)
            .join(" ");
          return (
            <path
              key={series.id}
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: SANS_FONT,
          fontSize: 10.5,
          color: COLORS.textDim,
        }}
      >
        <span>{first ? String(first.x) : ""}</span>
        <span>peak {geometry.max.toLocaleString()}</span>
        <span>{last ? String(last.x) : ""}</span>
      </div>
    </figure>
  );
}
