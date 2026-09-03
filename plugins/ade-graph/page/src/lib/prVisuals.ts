/**
 * The PR colour rules the canvas reads, and only those.
 *
 * Ported from `components/prs/shared/prVisuals.tsx` — the five functions the
 * graph actually calls, byte-for-byte, with `COLORS` coming from `@ade-dev/ui`
 * instead of the app's `laneDesignTokens`. The kit's `COLORS` IS that table:
 * both resolve to the same `--ade-*` / `--color-*` custom properties, so a PR
 * edge in the page is the exact colour the compiled edge was.
 *
 * The rest of that module — the badge components, the running indicator, the
 * activity chips — stayed behind. They are PR-tab furniture; the graph draws its
 * own compact card.
 */

import { COLORS } from "@ade-dev/ui";

import type { PrChecksStatus, PrReviewStatus, PrState } from "./types";
import type { PrActivityState } from "./graphTypes";

export type PrBadgeSpec = { label: string; color: string; bg: string; border: string };

function colorBadge(color: string) {
  return { color, bg: `${color}18`, border: `${color}30` };
}

export function getPrChecksBadge(status: PrChecksStatus): PrBadgeSpec {
  if (status === "passing") return { label: "CI", ...colorBadge(COLORS.success) };
  if (status === "failing") return { label: "CI", ...colorBadge(COLORS.danger) };
  if (status === "pending") return { label: "CI", ...colorBadge(COLORS.warning) };
  // ADE-135: `not_run` and `none` both land here. Absence is not failure —
  // nothing verified the commit, so it reads muted rather than borrowing the
  // danger colour.
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
  // ADE-135: an approved PR whose commit nothing verified must not wear the
  // success edge — the approval is real, the verification is not.
  if (args.checksStatus === "not_run") return COLORS.textMuted;
  if (args.checksStatus === "passing" || args.reviewStatus === "approved") return COLORS.success;
  return COLORS.textMuted;
}

export function getPrCiDotColor(args: { checksStatus: PrChecksStatus; ciRunning?: boolean }): string {
  if (args.ciRunning || args.checksStatus === "pending") return COLORS.info;
  if (args.checksStatus === "failing") return COLORS.danger;
  if (args.checksStatus === "passing") return COLORS.success;
  // `not_run`/`none`: nothing verified the commit, so it stays muted.
  return COLORS.textMuted;
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
  if (Number.isFinite(lastActivityTs) && Date.now() - lastActivityTs > 5 * 24 * 60 * 60 * 1000) {
    return "stale";
  }
  return "idle";
}

/** The sentence a `not_run` rollup carries. Verbatim from `shared/prChecksRollup`. */
export const NO_CI_REASON = "No CI has run on this commit.";
