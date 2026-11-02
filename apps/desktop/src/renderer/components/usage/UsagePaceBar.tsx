/**
 * The quota pace bar: one window's fill, its pacing, and when it resets.
 *
 * Lives beside `UsageLimitsBand` rather than inside it because the pace tones
 * and the grow-on-mount behaviour are a self-contained piece of vocabulary —
 * the band is about which providers and windows to show, this is about how one
 * of them reads.
 */
import { useEffect, useState } from "react";
import type { UsageWindow } from "../../../shared/types";
import { cn } from "../ui/cn";
import {
  USAGE_BAR_TRACK_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_TEXT,
  usageHeadroomColor,
} from "./usageDesign";
import {
  type PaceVisual,
  displayPercent,
  formatResetIn,
  formatUsagePercent,
  headroomTitle,
  paceVisual,
  trendSentence,
  windowLabel,
} from "./usageWindowFormat";


/**
 * The pace, said in words with a status dot: "Room to spare", "On pace",
 * "Using it fast", "Runs out early". Quiet sans text rather than a tinted mono
 * pill, which shouted the same weight as a warning on every healthy account.
 */
export function PacePill({ pace }: { pace: PaceVisual }) {
  return (
    <span className="usage-pace" data-tone={pace.tone} title={pace.detail}>
      <span className="kit-dot" data-state={PACE_DOT[pace.tone]} aria-hidden />
      {pace.label}
    </span>
  );
}

const PACE_DOT: Record<PaceVisual["tone"], "ok" | "warn" | "crit" | undefined> = {
  cool: "ok",
  calm: undefined,
  warm: "warn",
  hot: "crit",
};

export function UsagePaceBar({
  window: quotaWindow,
  nowMs,
  reducedMotion,
  showTrend = false,
}: {
  window: UsageWindow;
  nowMs: number;
  reducedMotion: boolean;
  /** Adds the "trending to X% by reset" line beneath. Weekly/monthly only. */
  showTrend?: boolean;
}) {
  const percent = displayPercent(quotaWindow, nowMs);
  const fill = usageHeadroomColor(100 - percent);
  const pace = paceVisual(quotaWindow.pacing);
  const expected = quotaWindow.pacing?.expectedPercent;
  const showTick = typeof expected === "number" && expected > 1 && expected < 99;
  const trend = showTrend ? trendSentence(quotaWindow.pacing, nowMs) : null;
  const resetLabel = formatResetIn(quotaWindow.resetsAt, nowMs);

  // Grow from zero on mount so the bar reads as a measurement arriving rather
  // than a static block. Skipped entirely under reduced motion.
  const [grown, setGrown] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) {
      setGrown(true);
      return;
    }
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={cn(USAGE_TEXT.detail, "font-medium text-fg")}>
          {windowLabel(quotaWindow)}
        </span>
        {pace ? <PacePill pace={pace} /> : null}
      </div>

      <div
        className={cn("relative h-2.5 w-full", USAGE_BAR_TRACK_CLASS)}
        role="progressbar"
        aria-label={`${windowLabel(quotaWindow)}: ${formatUsagePercent(percent)} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        title={headroomTitle(quotaWindow, nowMs)}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${grown ? percent : 0}%`,
            background: fill,
            transition: reducedMotion ? undefined : "width 700ms cubic-bezier(0.22,1,0.36,1)",
          }}
        />
        {showTick ? (
          <span
            className="absolute top-[-1px] bottom-[-1px] w-px bg-fg/60"
            style={{ left: `${expected}%` }}
            aria-hidden
            title={`Expected ~${Math.round(expected ?? 0)}% by now`}
          />
        ) : null}
      </div>

      <div className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "text-muted-fg")}>
        {formatUsagePercent(percent)} used{resetLabel ? ` · ${resetLabel}` : ""}
      </div>

      {trend ? <div className={cn(USAGE_TEXT.micro, "text-muted-fg")}>{trend}</div> : null}
    </div>
  );
}
