/**
 * A `needs:` dependency edge in the CI DAG.
 *
 * Orthogonal (smooth-step) routing, like GitHub's own Actions graph — a bezier
 * fan between two columns of equal-width cards reads as spaghetti, while right
 * angles read as a pipeline.
 *
 * State is carried by the DASH PATTERN as well as by colour: a dependency that
 * has not been satisfied yet is drawn dashed, a satisfied one solid, and only a
 * genuinely running downstream job animates. A moving line into a queued or
 * finished job would be a lie about what the machine is doing.
 *
 * Only loaded inside the lazily-imported canvas chunk — see `PrChecksTab`.
 */

import { memo } from "react";
import { BaseEdge, Position, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";

import { COLORS } from "../../lanes/laneDesignTokens";
import { tint } from "./prChecksVisuals";

export type ChecksGraphEdgeData = {
  onCriticalPath: boolean;
  live: boolean;
  pending: boolean;
};

export type ChecksGraphFlowEdge = Edge<ChecksGraphEdgeData, "checksDep">;

export const PrChecksGraphEdge = memo(function PrChecksGraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<ChecksGraphFlowEdge>) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: sourcePosition ?? Position.Right,
    targetPosition: targetPosition ?? Position.Left,
    borderRadius: 10,
  });

  const live = data?.live ?? false;
  const pending = data?.pending ?? false;
  const critical = data?.onCriticalPath ?? false;

  const stroke = live
    ? COLORS.warning
    : critical
      ? tint(COLORS.accent, 70)
      : tint(COLORS.border, 95);

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke,
        strokeWidth: critical || live ? 1.6 : 1.1,
        // Dashed = this dependency has not delivered anything downstream yet.
        // The flow animation itself comes from React Flow's own `animated` flag,
        // which the canvas sets only for live edges and only when the user has
        // not asked for reduced motion.
        strokeDasharray: live ? "5 4" : pending ? "3 4" : undefined,
      }}
    />
  );
});

export default PrChecksGraphEdge;
