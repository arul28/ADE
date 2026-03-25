import React from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { PrChecksStatus, PrReviewStatus, PrState } from "../../../../shared/types";
import { COLORS, SANS_FONT, inlineBadge } from "../../lanes/laneDesignTokens";

export type PrActivityState = "active" | "idle" | "stale";

type PrBadgeSpec = {
  label: string;
  color: string;
  bg: string;
  border: string;
};

function colorBadge(color: string) {
  return { color, bg: `${color}18`, border: `${color}30` };
}

export function getPrStateBadge(state: PrState): PrBadgeSpec {
  if (state === "draft") return { label: "DRAFT", ...colorBadge(COLORS.accent) };
  if (state === "open") return { label: "OPEN", ...colorBadge(COLORS.info) };
  if (state === "merged") return { label: "MERGED", ...colorBadge(COLORS.success) };
  return { label: "CLOSED", ...colorBadge(COLORS.textSecondary) };
}

export function getPrChecksBadge(status: PrChecksStatus): PrBadgeSpec {
  if (status === "passing") return { label: "CI", ...colorBadge(COLORS.success) };
  if (status === "failing") return { label: "CI", ...colorBadge(COLORS.danger) };
  if (status === "pending") return { label: "CI", ...colorBadge(COLORS.warning) };
  return { label: "CI", ...colorBadge(COLORS.textMuted) };
}

export function getPrReviewsBadge(status: PrReviewStatus): PrBadgeSpec {
  if (status === "approved") return { label: "APPROVED", ...colorBadge(COLORS.success) };
  if (status === "changes_requested") return { label: "CHANGES", ...colorBadge(COLORS.danger) };
  if (status === "requested") return { label: "REVIEW", ...colorBadge(COLORS.warning) };
  return { label: "NONE", ...colorBadge(COLORS.textMuted) };
}

export function getPrEdgeColor(args: {
  state: PrState;
  checksStatus: PrChecksStatus;
  reviewStatus: PrReviewStatus;
  ciRunning?: boolean;
}): string {
  if (args.state === "merged") return COLORS.success;
  if (args.state === "draft") return COLORS.accent;
  if (args.reviewStatus === "changes_requested") return COLORS.danger;
  if (args.ciRunning || args.checksStatus === "pending") return COLORS.info;
  if (args.reviewStatus === "requested" || args.reviewStatus === "none") return COLORS.warning;
  if (args.checksStatus === "failing") return COLORS.danger;
  if (args.checksStatus === "passing" || args.reviewStatus === "approved") return COLORS.success;
  return COLORS.textMuted;
}

export function getPrCiDotColor(args: {
  checksStatus: PrChecksStatus;
  ciRunning?: boolean;
}): string {
  if (args.ciRunning || args.checksStatus === "pending") return COLORS.info;
  if (args.checksStatus === "failing") return COLORS.danger;
  if (args.checksStatus === "passing") return COLORS.success;
  return COLORS.textMuted;
}

export function getPrReviewDotColor(args: { reviewStatus: PrReviewStatus }): string {
  if (args.reviewStatus === "changes_requested") return COLORS.danger;
  if (args.reviewStatus === "approved") return COLORS.success;
  if (args.reviewStatus === "requested") return COLORS.warning;
  return COLORS.textMuted;
}

export function formatCompactCount(value: number): string {
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

export function derivePrActivityState(args: {
  state: PrState;
  reviewStatus: PrReviewStatus;
  lastActivityAt: string | null;
  pendingCheckCount?: number;
}): PrActivityState {
  if (args.state === "merged" || args.state === "closed") return "idle";
  if ((args.pendingCheckCount ?? 0) > 0 || args.reviewStatus === "requested") return "active";
  const lastActivityTs = args.lastActivityAt ? Date.parse(args.lastActivityAt) : Number.NaN;
  if (Number.isFinite(lastActivityTs) && Date.now() - lastActivityTs > 5 * 24 * 60 * 60 * 1000) return "stale";
  return "idle";
}

export function InlinePrBadge(props: { label: string; color: string; bg: string; border: string }) {
  const { label, color, bg, border } = props;
  return <span style={inlineBadge(color, { background: bg, border: `1px solid ${border}` })}>{label}</span>;
}

export function PrCiRunningIndicator(props: {
  showLabel?: boolean;
  label?: string;
  color?: string;
  size?: number;
  title?: string;
}) {
  const {
    showLabel = false,
    label = "running",
    color = COLORS.warning,
    size = 10,
    title = "CI checks are still running",
  } = props;

  if (!showLabel) {
    return (
      <span
        aria-label="CI running"
        title={title}
        style={{ display: "inline-flex", alignItems: "center", color }}
      >
        <CircleNotch size={size} className="animate-spin" />
      </span>
    );
  }

  return (
    <span
      aria-label="CI running"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        borderRadius: 999,
        border: `1px solid ${color}26`,
        background: `${color}12`,
        color,
        fontFamily: SANS_FONT,
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      <CircleNotch size={size} className="animate-spin" />
      <span>{label}</span>
    </span>
  );
}
