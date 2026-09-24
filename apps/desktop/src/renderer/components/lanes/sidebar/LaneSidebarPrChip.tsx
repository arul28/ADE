import React from "react";
import { GitMerge, GitPullRequest } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, floatingPane } from "../laneDesignTokens";
import type { LaneTabPrTag } from "../lanePageModel";
import { LanePrHoverCard } from "../LanePrHoverCard";
import { getPrCiDotColor, getPrReviewDotColor } from "../../prs/shared/prVisuals";
import {
  lanePrAttention,
  lanePrAttentionColor,
  lanePrStateLabel,
  pickPrimaryPr,
} from "../../../lib/lanePrBadge";

const PR_CHIP_COLORS = {
  open: "#34d399",
  draft: "color-mix(in srgb, var(--color-muted-fg) 85%, transparent)",
  merged: "#a78bfa",
  failing: "#f87171",
  closed: "color-mix(in srgb, var(--color-muted-fg) 70%, transparent)",
} as const;

/** Chip color: red when the PR is in trouble, otherwise its state. */
export function lanePrChipColor(pr: LaneTabPrTag): string {
  if ((pr.state === "open" || pr.state === "draft") && lanePrAttention(pr) === "danger") return PR_CHIP_COLORS.failing;
  switch (pr.state) {
    case "open": return PR_CHIP_COLORS.open;
    case "draft": return PR_CHIP_COLORS.draft;
    case "merged": return PR_CHIP_COLORS.merged;
    default: return PR_CHIP_COLORS.closed;
  }
}

function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: color }}
    />
  );
}

/**
 * PR pill for a lane row: "#1292", or "#1292 +2" when the lane has several
 * PRs. The glyph is tinted by the primary PR: open green, draft grey, merged
 * violet, red when checks fail, review asks for changes, or it conflicts. Hovering lists
 * every PR; clicking one opens it.
 */
export const LaneSidebarPrChip = React.memo(function LaneSidebarPrChip({
  prs,
  onOpenPr,
}: {
  prs: LaneTabPrTag[];
  onOpenPr: (pr: LaneTabPrTag) => void;
}) {
  const primary = pickPrimaryPr(prs) ?? prs[0] ?? null;
  if (!primary) return null;
  const extra = prs.length - 1;
  const chipColor = lanePrChipColor(primary);
  const ChipIcon = primary.state === "merged" ? GitMerge : GitPullRequest;

  return (
    <LanePrHoverCard
      className="inline-flex min-w-0 shrink-0 items-center"
      label={prs.length > 1 ? `Pull requests (${prs.length})` : `Pull request #${primary.githubPrNumber}`}
      width={300}
      content={(
        <div className="block overflow-hidden py-1" style={{ ...floatingPane(), fontFamily: SANS_FONT }}>
          {prs.map((pr) => (
            <button
              key={pr.id}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.05]"
              onClick={(event) => {
                event.stopPropagation();
                onOpenPr(pr);
              }}
              title={pr.title}
            >
              <Dot color={lanePrAttentionColor(lanePrAttention(pr))} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textPrimary }}>
                  <span className="font-mono font-semibold">#{pr.githubPrNumber}</span>
                  <span style={{ color: COLORS.textMuted }}>{lanePrStateLabel(pr.state)}</span>
                  {pr.laneRole === "previous" ? <span className="text-[10px]" style={{ color: COLORS.textDim }}>earlier branch</span> : null}
                </span>
                <span className="block truncate text-[11px]" style={{ color: COLORS.textMuted }}>
                  {pr.title || "Untitled pull request"}
                </span>
              </span>
              {pr.checksStatus || pr.reviewStatus ? (
                <span
                  className="flex shrink-0 items-center gap-1"
                  title={`Checks ${pr.checksStatus ?? "unknown"} · review ${pr.reviewStatus ?? "unknown"}`}
                >
                  <Dot size={5} color={getPrCiDotColor({ checksStatus: pr.checksStatus ?? "none" })} />
                  <Dot size={5} color={getPrReviewDotColor({ reviewStatus: pr.reviewStatus ?? "none" })} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    >
      <button
        type="button"
        data-testid="lane-sidebar-pr-chip"
        data-state={primary.state}
        data-tone={chipColor === PR_CHIP_COLORS.failing ? "danger" : primary.state}
        // Quiet on purpose: only the glyph carries the state color, the number
        // stays muted, the same weight as the Work list's PR badge.
        className="inline-flex h-4 shrink-0 items-center gap-[3px] rounded-full border border-fg/10 px-1.5 text-[10px] font-medium leading-none text-muted-fg/80 tabular-nums transition-colors hover:bg-fg/[0.06] hover:text-fg"
        aria-label={prs.length > 1 ? `${prs.length} pull requests` : `Pull request #${primary.githubPrNumber}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpenPr(primary);
        }}
      >
        <ChipIcon size={10} weight="bold" className="shrink-0" style={{ color: chipColor }} data-testid="lane-sidebar-pr-chip-glyph" />
        <span>#{primary.githubPrNumber}</span>
        {extra > 0 ? <span className="opacity-60">+{extra}</span> : null}
      </button>
    </LanePrHoverCard>
  );
});
