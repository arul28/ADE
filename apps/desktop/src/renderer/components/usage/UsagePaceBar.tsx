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
  usagePressureColor,
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
 * Pace tones as theme variables with a literal fallback.
 *
 * These four are the only colours on these surfaces that are not a provider
 * brand token, and they carry meaning rather than identity, so they stay
 * semantic rather than borrowing the accent.
 */
const TONE_COLOR: Record<PaceVisual["tone"], string> = {
  calm: "var(--color-usage-ok, #34D399)",
  warm: "var(--color-usage-warn, #F5A623)",
  hot: "var(--color-usage-critical, #F87171)",
  cool: "var(--color-muted-fg)",
};

export function PacePill({ pace }: { pace: PaceVisual }) {
  const color = TONE_COLOR[pace.tone];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-[1px] font-medium leading-none",
        USAGE_TEXT.micro,
      )}
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {pace.label}
      {pace.arrow ? <span aria-hidden>{pace.arrow}</span> : null}
    </span>
  );
}

export function UsagePaceBar({
  window: quotaWindow,
  providerColor,
  nowMs,
  reducedMotion,
  showTrend = false,
}: {
  window: UsageWindow;
  providerColor: string;
  nowMs: number;
  reducedMotion: boolean;
  /** Adds the "trending to X% by reset" line beneath. Weekly/monthly only. */
  showTrend?: boolean;
}) {
  const percent = displayPercent(quotaWindow, nowMs);
  const fill = usagePressureColor(percent, providerColor);
  const pace = paceVisual(quotaWindow.pacing);
  const expected = quotaWindow.pacing?.expectedPercent;
  const showTick = typeof expected === "number" && expected > 1 && expected < 99;
  const trend = showTrend ? trendSentence(quotaWindow.pacing, nowMs) : null;

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
        {formatUsagePercent(percent)} used · {formatResetIn(quotaWindow.resetsAt, nowMs)}
      </div>

      {trend ? <div className={cn(USAGE_TEXT.micro, "text-muted-fg")}>{trend}</div> : null}
    </div>
  );
}
