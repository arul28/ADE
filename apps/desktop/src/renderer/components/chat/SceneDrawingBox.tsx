import { CircleNotch } from "@phosphor-icons/react";

import { COLORS } from "../lanes/laneDesignTokens";

/**
 * The box a scene occupies before it can run: while the agent is drafting it
 * with `ade scene preview` (`ScenePreviewThumb`), and while its fence is still
 * arriving in the reply (`SceneFrame`). One look for both, so the reader sees
 * the same "a view is being drawn here" from the first check until the live
 * scene replaces it: a light sweep over the box and one small working line.
 */
export function SceneDrawingBox({
  height,
  testId,
  status,
}: {
  height: number;
  testId: string;
  status: string;
}) {
  return (
    <div className="my-3 w-screen max-w-full" data-testid={testId} data-scene-status={status}>
      <div
        className="ade-scene-drawing-sweep flex items-end rounded-md px-3 py-2"
        style={{ height, background: COLORS.recessedBg }}
      >
        <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textMuted }}>
          <CircleNotch size={10} weight="bold" className="motion-safe:animate-spin" style={{ color: COLORS.accent }} />
          <span className="ade-thinking-shimmer">Agent is drawing a scene</span>
        </span>
      </div>
    </div>
  );
}
