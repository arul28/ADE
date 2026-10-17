/**
 * Where the dollars went: two part-to-whole bars under the Usage hero, one by
 * token type and one by speed, read from the host's `AdeUsageCostSplit`.
 *
 * Colours follow the data-viz method: categorical hues in a fixed order
 * (validated light and dark — see `SPLIT_COLORS`), a neutral grey for the
 * "Other"/"Standard" remainder so the eye goes to the parts that carry
 * meaning, a 2px surface gap between segments, and a legend that always names
 * each segment with its dollars, so identity never rests on colour alone. The
 * light-theme aqua and yellow sit under 3:1 against white; the always-visible
 * dollar labels are the relief that requires.
 */
import React from "react";
import type { AdeUsageCostSplit } from "../../../shared/types";
import { formatSpend } from "../../lib/format";
import { costSplitTotal } from "../../../shared/usageCostSplit";
import "./usageSurfaces.css";

type Theme = "dark" | "light";

/**
 * Validated with the data-viz `validate_palette.js` against the light surface
 * (#ffffff) and the dark raised surface (#1E1B2E): the four type hues pass
 * every adjacent check in both modes; Fast/Ultrafast (orange/violet) pass all
 * checks in both.
 */
export const SPLIT_COLORS = {
  input: { light: "#2a78d6", dark: "#3987e5" },
  cacheRead: { light: "#eb6834", dark: "#d95926" },
  cacheWrite: { light: "#1baf7a", dark: "#199e70" },
  output: { light: "#eda100", dark: "#c98500" },
  neutral: { light: "#a3a19c", dark: "#5f5c6b" },
  fast: { light: "#eb6834", dark: "#d95926" },
  ultrafast: { light: "#4a3aa7", dark: "#9085e9" },
} as const;

type SplitSegment = { key: string; label: string; value: number; color: string };

function typeSegments(split: AdeUsageCostSplit, theme: Theme): SplitSegment[] {
  return [
    { key: "input", label: "Input", value: split.input, color: SPLIT_COLORS.input[theme] },
    { key: "cacheRead", label: "Cache read", value: split.cacheRead, color: SPLIT_COLORS.cacheRead[theme] },
    { key: "cacheWrite", label: "Cache write", value: split.cacheWrite, color: SPLIT_COLORS.cacheWrite[theme] },
    { key: "output", label: "Output", value: split.output, color: SPLIT_COLORS.output[theme] },
    { key: "other", label: "Other", value: split.other, color: SPLIT_COLORS.neutral[theme] },
  ];
}

function speedSegments(split: AdeUsageCostSplit, theme: Theme): SplitSegment[] {
  const premium = split.fastPremium + split.ultrafastPremium;
  return [
    { key: "standard", label: "Standard rate", value: Math.max(0, costSplitTotal(split) - premium), color: SPLIT_COLORS.neutral[theme] },
    { key: "fast", label: "Fast premium", value: split.fastPremium, color: SPLIT_COLORS.fast[theme] },
    { key: "ultrafast", label: "Ultrafast premium", value: split.ultrafastPremium, color: SPLIT_COLORS.ultrafast[theme] },
  ];
}

/**
 * One labelled part-to-whole bar: a thin segmented track, then a two-column
 * legend whose dollar values line up on the right. Hovering a segment or its
 * legend entry lifts both and shows the share.
 */
function SplitBar({ label, segments, ariaLabel }: { label: string; segments: SplitSegment[]; ariaLabel: string }) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  if (total <= 0) return null;
  const visible = segments.filter((segment) => segment.value > 0);
  return (
    <div className="usage-split" role="group" aria-label={ariaLabel}>
      <span className="kit-eyebrow">{label}</span>
      <div className="usage-split-bar" role="img" aria-label={visible.map((segment) => `${segment.label} ${formatSpend(segment.value)}`).join(", ")}>
        {visible.map((segment) => (
          <span
            key={segment.key}
            style={{
              flexGrow: segment.value,
              flexBasis: 0,
              background: segment.color,
              opacity: hovered && hovered !== segment.key ? 0.3 : 1,
            }}
            title={`${segment.label} · ${formatSpend(segment.value)} · ${Math.round((segment.value / total) * 100)}%`}
            onMouseEnter={() => setHovered(segment.key)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>
      <div className="usage-split-legend">
        {visible.map((segment) => (
          <span
            key={segment.key}
            className="usage-split-legend-item"
            style={hovered === segment.key ? { color: "var(--color-fg)" } : undefined}
            onMouseEnter={() => setHovered(segment.key)}
            onMouseLeave={() => setHovered(null)}
          >
            <i aria-hidden style={{ background: segment.color }} />
            {segment.label}
            <b>{formatSpend(segment.value)}</b>
            <em>{`${Math.round((segment.value / total) * 100)}%`}</em>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Both bars for one split. Nothing renders for a host that sent no split. */
export function CostSplitBars({ split, theme }: { split: AdeUsageCostSplit | null | undefined; theme: Theme }) {
  if (!split || costSplitTotal(split) <= 0) return null;
  const hasPremium = split.fastPremium + split.ultrafastPremium > 0;
  return (
    <div className="flex flex-col gap-4">
      <SplitBar label="By type" ariaLabel="Cost by token type" segments={typeSegments(split, theme)} />
      {hasPremium ? (
        <SplitBar label="By speed" ariaLabel="Cost by speed" segments={speedSegments(split, theme)} />
      ) : (
        <span className="usage-footnote">By speed · all at standard rates</span>
      )}
    </div>
  );
}
