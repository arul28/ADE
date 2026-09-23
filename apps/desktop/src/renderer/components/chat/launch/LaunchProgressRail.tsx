import React from "react";
import type { ChatLaunchStage } from "../../../../shared/types";
import { cn } from "../../ui/cn";

/**
 * The segmented launch progress rail: one segment per stage, shared by the
 * in-thread setup card and the Launches slide-out rows.
 *
 * Compositor-only by construction. A segment's fill is a full-width bar scaled
 * with `transform: scaleX()` from the left edge (checkout's real percent, or
 * 0/1 for everything else), and the running segment's sheen is a small bar
 * translated across with a CSS keyframe (`ade-launch-rail-sheen` in
 * index.css). Nothing animates width, left or background-position, and no
 * JavaScript runs per frame; `prefers-reduced-motion` stops the sheen.
 *
 * Memoized on the stage array: the store keeps unchanged stage objects (and
 * the array) across snapshots, so the rail re-renders only when a stage it
 * draws actually moved.
 */

function fillScale(stage: ChatLaunchStage): number {
  switch (stage.status) {
    case "done":
    case "warning":
    case "failed":
    case "skipped":
      return 1;
    case "running":
      return stage.percent != null ? Math.max(0.04, Math.min(1, stage.percent / 100)) : 0;
    default:
      return 0;
  }
}

const FILL_TONE: Record<ChatLaunchStage["status"], string> = {
  done: "bg-emerald-400/70",
  warning: "bg-amber-300/70",
  failed: "bg-amber-400/80",
  skipped: "bg-white/[0.14]",
  running: "bg-violet-400/80",
  pending: "bg-transparent",
};

const TRACK_TONE: Record<ChatLaunchStage["status"], string> = {
  done: "bg-emerald-400/20",
  warning: "bg-amber-300/20",
  failed: "bg-amber-400/20",
  skipped: "bg-white/[0.06]",
  running: "bg-violet-400/[0.16]",
  pending: "bg-white/[0.07]",
};

export const LaunchProgressRail = React.memo(function LaunchProgressRail({
  stages,
  className,
}: {
  stages: readonly ChatLaunchStage[];
  className?: string;
}) {
  return (
    <div className={cn("flex w-full gap-[3px]", className)} aria-hidden data-testid="launch-rail">
      {stages.map((stage) => (
        <span
          key={stage.id}
          data-stage-status={stage.status}
          className={cn(
            "relative h-[3px] min-w-0 flex-1 overflow-hidden rounded-full transition-colors duration-300",
            TRACK_TONE[stage.status],
          )}
        >
          <span
            className={cn(
              "absolute inset-0 origin-left rounded-full transition-[transform,background-color] duration-300 ease-out",
              FILL_TONE[stage.status],
            )}
            style={{ transform: `scaleX(${fillScale(stage)})` }}
          />
          {stage.status === "running" ? <span className="ade-launch-rail-sheen" data-launch-rail-sheen /> : null}
        </span>
      ))}
    </div>
  );
});
