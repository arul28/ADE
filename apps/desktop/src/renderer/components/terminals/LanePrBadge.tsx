import React from "react";
import type { PrSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import {
  lanePrAggregateAttention,
  lanePrAttention,
  lanePrAttentionColor,
  lanePrStateColor,
  lanePrStateLabel,
  pickPrimaryPr,
} from "../../lib/lanePrBadge";
import { GitHubStackBadge } from "../prs/shared/GitHubStackBadge";
import { getPrCiDotColor, getPrReviewDotColor } from "../prs/shared/prVisuals";
import { LanePrHoverCard } from "../lanes/LanePrHoverCard";

function StatusDot({ color, title }: { color: string; title?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: color }}
      title={title}
      aria-hidden
    />
  );
}

function prTitle(pr: PrSummary): string {
  return `Pull request #${pr.githubPrNumber} · ${lanePrStateLabel(pr.state)}${pr.title ? ` · ${pr.title}` : ""}`;
}

function checksStatusLabel(status: PrSummary["checksStatus"]): string {
  switch (status) {
    case "passing": return "CI passing";
    case "failing": return "CI failing";
    case "pending": return "CI running";
    case "not_run": return "CI not run";
    default: return "CI unavailable";
  }
}

function reviewStatusLabel(status: PrSummary["reviewStatus"]): string {
  switch (status) {
    case "approved": return "Review approved";
    case "changes_requested": return "Review changes requested";
    case "requested": return "Review requested";
    default: return "Review unavailable";
  }
}

/**
 * Compact lane PR cluster. The one-PR branch intentionally keeps the existing
 * chip shape; the multi-PR branch adds only a counter and a hover list, so a
 * lane that has never needed history still reads exactly as before.
 */
export function LanePrBadge({
  pr,
  prs = [pr],
  onOpen,
  onOpenList,
}: {
  pr: PrSummary;
  prs?: PrSummary[];
  onOpen: (pr: PrSummary) => void;
  /** Opens the PRs tab with this lane selected. Used by the `+N` counter. */
  onOpenList?: () => void;
}) {
  const allPrs = prs.length > 0 ? prs : [pr];
  const primaryPr = pickPrimaryPr(allPrs) ?? pr;
  const stackDescription = primaryPr.stack
    ? `, position ${primaryPr.stack.position} of ${primaryPr.stack.size} in GitHub Stack #${primaryPr.stack.number}`
    : "";
  const open = (event: React.SyntheticEvent, target: PrSummary = primaryPr) => {
    event.stopPropagation();
    onOpen(target);
  };

  if (allPrs.length === 1) {
    const color = lanePrStateColor(primaryPr.state);
    const label = lanePrStateLabel(primaryPr.state);
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open(event);
          }
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/70 transition-colors hover:bg-white/[0.09]"
        title={`${prTitle(primaryPr)}${stackDescription}`}
        aria-label={`Pull request #${primaryPr.githubPrNumber}, ${label}${stackDescription}`}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="tabular-nums">#{primaryPr.githubPrNumber}</span>
        <GitHubStackBadge stack={primaryPr.stack} compact bare />
        <span style={{ color }}>{label}</span>
      </span>
    );
  }

  const aggregate = lanePrAggregateAttention(allPrs);
  const aggregateColor = lanePrAttentionColor(aggregate);
  const canOpenList = typeof onOpenList === "function";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      title={`${allPrs.length} pull requests on this lane`}
    >
      <LanePrHoverCard
        className="inline-flex shrink-0 items-center gap-1"
        label={`Pull requests · ${allPrs.length}`}
        width={260}
        content={(
          <div className="overflow-hidden rounded-lg border border-white/[0.10] bg-[#17171b] p-1.5 shadow-2xl shadow-black/30">
          <span className="block px-2 pb-1.5 pt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-fg/45">
            Pull requests · {allPrs.length}
          </span>
          {allPrs.map((candidate) => {
            const attention = lanePrAttention(candidate);
            return (
              <span
                key={candidate.id}
                role="button"
                tabIndex={0}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                onClick={(event) => open(event, candidate)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open(event, candidate);
                  }
                }}
                title={prTitle(candidate)}
              >
                <StatusDot color={lanePrAttentionColor(attention)} title={`${attention} attention`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[10px] font-semibold text-fg/80">
                    <span className="tabular-nums">#{candidate.githubPrNumber}</span>
                    <span style={{ color: lanePrStateColor(candidate.state) }}>{lanePrStateLabel(candidate.state)}</span>
                  </span>
                  <span className="block truncate text-[9px] text-muted-fg/55">{candidate.title || "Untitled pull request"}</span>
                </span>
                <span
                  className="flex shrink-0 items-center gap-1"
                  role="img"
                  aria-label={`${checksStatusLabel(candidate.checksStatus)}; ${reviewStatusLabel(candidate.reviewStatus)}`}
                >
                  <StatusDot
                    color={getPrCiDotColor({ checksStatus: candidate.checksStatus })}
                    title={`CI: ${candidate.checksStatus}`}
                  />
                  <StatusDot
                    color={getPrReviewDotColor({ reviewStatus: candidate.reviewStatus })}
                    title={`Review: ${candidate.reviewStatus}`}
                  />
                </span>
              </span>
            );
          })}
          </div>
        )}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => open(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open(event);
            }
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/70 transition-colors hover:bg-white/[0.09]"
          aria-label={`${prTitle(primaryPr)}; ${allPrs.length - 1} other pull requests on this lane`}
        >
          <StatusDot color={aggregateColor} title={`${aggregate} attention`} />
          <span className="tabular-nums">#{primaryPr.githubPrNumber}</span>
          <GitHubStackBadge stack={primaryPr.stack} compact bare />
          <span style={{ color: lanePrStateColor(primaryPr.state) }}>{lanePrStateLabel(primaryPr.state)}</span>
        </span>
        <span
          {...(canOpenList ? { role: "button", tabIndex: 0 } : {})}
          className={cn(
            "inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-px text-[9px] font-semibold tabular-nums text-muted-fg/60",
            canOpenList
              ? "cursor-pointer transition-colors hover:border-white/[0.15] hover:text-fg/85"
              : "cursor-default",
          )}
          aria-label={canOpenList ? `Open ${allPrs.length} pull requests for this lane` : `Hover to inspect ${allPrs.length} pull requests for this lane`}
          title={canOpenList ? `Show all ${allPrs.length} pull requests for this lane` : "Hover to inspect all pull requests; PRs live on another machine"}
          onClick={(event) => {
            if (!onOpenList) return;
            event.stopPropagation();
            onOpenList();
          }}
          onKeyDown={(event) => {
            if (!onOpenList) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onOpenList();
            }
          }}
        >
          +{allPrs.length - 1}
        </span>
      </LanePrHoverCard>
    </span>
  );
}
