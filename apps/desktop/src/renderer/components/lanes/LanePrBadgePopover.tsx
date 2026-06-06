import React from "react";
import { GitPullRequest } from "@phosphor-icons/react";
import type { PrChecksStatus, PrReviewStatus } from "../../../shared/types";
import { COLORS, SANS_FONT, floatingPane, inlineBadge } from "./laneDesignTokens";
import type { LaneTabPrTag } from "./lanePageModel";
import {
  InlinePrBadge,
  formatCompactCount,
  getPrChecksBadge,
  getPrCiDotColor,
  getPrReviewDotColor,
  getPrReviewsBadge,
  getPrStateBadge,
} from "../prs/shared/prVisuals";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";

/** Caption beneath the state badge: "PR opened / merged / draft / closed". */
function prStateCaption(state: LaneTabPrTag["state"]): string {
  switch (state) {
    case "merged":
      return "PR merged";
    case "closed":
      return "PR closed";
    case "draft":
      return "PR draft";
    default:
      return "PR opened";
  }
}

function lanePrTagColor(state: LaneTabPrTag["state"]): string {
  if (state === "merged") return COLORS.success;
  if (state === "closed") return COLORS.danger;
  if (state === "draft") return COLORS.warning;
  return COLORS.accent;
}

function checksCaption(status: PrChecksStatus): string {
  switch (status) {
    case "passing":
      return "Checks passing";
    case "failing":
      return "Checks failing";
    case "pending":
      return "Checks running";
    default:
      return "No checks";
  }
}

function reviewsCaption(status: PrReviewStatus): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "requested":
      return "Review requested";
    default:
      return "No reviews";
  }
}

function StatusDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

export function LanePrBadgePopover({
  pr,
  onActivate,
}: {
  pr: LaneTabPrTag;
  /** Invoked when the badge itself is clicked (navigate to PR / open external). */
  onActivate: (event: React.MouseEvent) => void;
}) {
  const stateBadge = getPrStateBadge(pr.state);
  const hasChecks = pr.checksStatus != null;
  const hasReviews = pr.reviewStatus != null;
  const hasBranches = Boolean(pr.headBranch && pr.baseBranch);
  const hasDiff = pr.additions != null || pr.deletions != null;
  const labels = pr.labels ?? [];
  const conflicts = pr.mergeConflicts === true;
  const behind = typeof pr.behindBaseBy === "number" && pr.behindBaseBy > 0 ? pr.behindBaseBy : 0;

  // The `group` wrapper is scoped to ONLY the badge so hovering the popover
  // trigger never highlights or selects the surrounding lane row. Clicks are
  // swallowed here too (stopPropagation) so the row's onClick never fires.
  return (
    <span
      className="group relative inline-flex shrink-0"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="shrink-0"
        style={{
          ...inlineBadge(lanePrTagColor(pr.state), { fontSize: 9 }),
          gap: 4,
          cursor: "pointer",
          borderRadius: 6,
        }}
        title={`${formatPrBadgeLabel(pr)}: ${pr.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onActivate(event);
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <GitPullRequest size={10} weight="bold" />
        {formatPrBadgeLabel(pr)}
      </button>

      {/* Hover popover — pure-CSS group-hover, positioned below the badge. No JS
          positioning library, mirroring LinearIssueBadge's approach. */}
      <span className="pointer-events-none invisible absolute left-0 top-full z-[80] w-[280px] pt-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100">
        <span
          className="block overflow-hidden"
          style={{
            ...floatingPane(),
            fontFamily: SANS_FONT,
            color: COLORS.textSecondary,
          }}
        >
          {/* Header: state badge + #number + caption */}
          <span className="flex items-center gap-2 px-3 py-2.5">
            <InlinePrBadge
              label={stateBadge.label}
              color={stateBadge.color}
              bg={stateBadge.bg}
              border={stateBadge.border}
            />
            <span
              className="font-mono text-[11px] font-semibold"
              style={{ color: COLORS.textPrimary }}
            >
              #{pr.githubPrNumber}
            </span>
            <span className="ml-auto text-[10.5px]" style={{ color: COLORS.textMuted }}>
              {prStateCaption(pr.state)}
            </span>
          </span>

          {/* Title */}
          <span
            className="block px-3 pb-2 text-[12px] font-semibold leading-snug"
            style={{ color: COLORS.textPrimary }}
          >
            {pr.title}
          </span>

          {/* Status row: checks + reviews + behind/conflicts */}
          {hasChecks || hasReviews || conflicts || behind > 0 ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-2.5">
              {hasChecks ? (
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot color={getPrCiDotColor({ checksStatus: pr.checksStatus! })} />
                  {(() => {
                    const badge = getPrChecksBadge(pr.checksStatus!);
                    return (
                      <InlinePrBadge label={badge.label} color={badge.color} bg={badge.bg} border={badge.border} />
                    );
                  })()}
                  <span className="text-[10.5px]" style={{ color: COLORS.textMuted }}>
                    {checksCaption(pr.checksStatus!)}
                  </span>
                </span>
              ) : null}
              {hasReviews ? (
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot color={getPrReviewDotColor({ reviewStatus: pr.reviewStatus! })} />
                  {(() => {
                    const badge = getPrReviewsBadge(pr.reviewStatus!);
                    return (
                      <InlinePrBadge label={badge.label} color={badge.color} bg={badge.bg} border={badge.border} />
                    );
                  })()}
                  <span className="text-[10.5px]" style={{ color: COLORS.textMuted }}>
                    {reviewsCaption(pr.reviewStatus!)}
                  </span>
                </span>
              ) : null}
              {conflicts ? (
                <span className="inline-flex items-center gap-1.5 text-[10.5px]" style={{ color: COLORS.danger }}>
                  <StatusDot color={COLORS.danger} />
                  Merge conflicts
                </span>
              ) : null}
              {behind > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[10.5px]" style={{ color: COLORS.warning }}>
                  <StatusDot color={COLORS.warning} />
                  {behind} behind base
                </span>
              ) : null}
            </span>
          ) : null}

          {/* head -> base branches (mono) */}
          {hasBranches ? (
            <span className="block px-3 pb-2.5">
              <span
                className="flex items-center gap-1.5 truncate font-mono text-[10px]"
                style={{ color: COLORS.textSecondary }}
              >
                <span className="truncate" title={pr.headBranch ?? undefined}>{pr.headBranch}</span>
                <span style={{ color: COLORS.textMuted }}>→</span>
                <span className="truncate" title={pr.baseBranch ?? undefined}>{pr.baseBranch}</span>
              </span>
            </span>
          ) : null}

          {/* +adds / -dels diff */}
          {hasDiff ? (
            <span className="flex items-center gap-2 px-3 pb-2.5 text-[10.5px]">
              {pr.additions != null ? (
                <span className="font-mono font-semibold" style={{ color: COLORS.checkPass }}>
                  +{formatCompactCount(pr.additions)}
                </span>
              ) : null}
              {pr.deletions != null ? (
                <span className="font-mono font-semibold" style={{ color: COLORS.danger }}>
                  −{formatCompactCount(pr.deletions)}
                </span>
              ) : null}
            </span>
          ) : null}

          {/* Labels (up to 4) */}
          {labels.length > 0 ? (
            <span className="flex flex-wrap gap-1.5 px-3 pb-3">
              {labels.slice(0, 4).map((label) => (
                <span
                  key={label.name}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold"
                  style={{
                    color: `#${label.color}`,
                    background: `#${label.color}18`,
                    border: `1px solid #${label.color}35`,
                  }}
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `#${label.color}` }} />
                  {label.name}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </span>
    </span>
  );
}
