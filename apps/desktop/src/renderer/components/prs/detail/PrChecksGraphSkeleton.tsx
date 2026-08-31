/**
 * The CI graph's placeholder, in the shape the graph will occupy.
 *
 * This exists to fix a specific, visible defect: opening the CI tab used to
 * render a flat list of every job built from the checks already in memory, then
 * — two to three seconds later, when the async workflow-graph call landed —
 * throw that layout away and snap into a DAG. The user watched a layout that
 * was always going to be replaced.
 *
 * The rule this encodes: never render a layout you are about to replace. While
 * the real graph is resolving we show ghost cards in roughly its footprint, so
 * the graph's arrival is a fill, not a relayout. The flat list is still the
 * honest FINAL state when there is genuinely no dependency graph — but it is
 * then presented as an answer, not as a transition.
 *
 * Deliberately free of `@xyflow/react`, because it is also the Suspense
 * fallback while that chunk downloads.
 */

import { memo } from "react";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import {
  CHECKS_COLUMN_GAP,
  CHECKS_NODE_BASE_HEIGHT,
  CHECKS_NODE_WIDTH,
  CHECKS_ROW_GAP,
  checksCanvasHeight,
  checksSkeletonShape,
} from "./prChecksGraphLayout";

export type PrChecksGraphSkeletonProps = {
  /** Checks already known locally — only used to size the placeholder. */
  jobCount: number;
  /** Screen-reader and tooltip copy for what is being waited on. */
  label?: string;
};

export const PrChecksGraphSkeleton = memo(function PrChecksGraphSkeleton({
  jobCount,
  label = "Charting the pipeline…",
}: PrChecksGraphSkeletonProps) {
  const columns = checksSkeletonShape(jobCount);
  const tallest = Math.max(...columns);
  const height = checksCanvasHeight(
    tallest * CHECKS_NODE_BASE_HEIGHT + Math.max(0, tallest - 1) * CHECKS_ROW_GAP,
  );

  return (
    <div
      data-testid="pr-checks-graph-skeleton"
      role="status"
      aria-live="polite"
      aria-label={label}
      className="relative flex w-full items-center justify-center overflow-hidden"
      style={{
        height,
        borderRadius: RADII.md,
        border: `1px solid ${COLORS.borderMuted}`,
        background: COLORS.recessedBg,
      }}
    >
      <div className="flex items-center" style={{ gap: CHECKS_COLUMN_GAP }}>
        {columns.map((count, columnIndex) => (
          <div
            key={columnIndex}
            className="relative flex flex-col"
            style={{ gap: CHECKS_ROW_GAP }}
          >
            {Array.from({ length: count }, (_, rowIndex) => (
              <div
                key={rowIndex}
                className="motion-safe:animate-pulse"
                style={{
                  width: CHECKS_NODE_WIDTH,
                  height: CHECKS_NODE_BASE_HEIGHT,
                  borderRadius: RADII.md,
                  background: COLORS.cardBg,
                  border: `1px dashed ${COLORS.borderMuted}`,
                  // Staggered so the column reads as a pipeline filling in
                  // rather than one block flashing.
                  animationDelay: `${(columnIndex * 3 + rowIndex) * 90}ms`,
                }}
              />
            ))}
            {columnIndex < columns.length - 1 ? (
              <span
                aria-hidden
                className="absolute top-1/2 h-px"
                style={{
                  left: "100%",
                  width: CHECKS_COLUMN_GAP,
                  background: COLORS.borderMuted,
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
      <span
        className="absolute bottom-2 left-3 text-[10.5px]"
        style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
      >
        {label}
      </span>
    </div>
  );
});

export default PrChecksGraphSkeleton;
