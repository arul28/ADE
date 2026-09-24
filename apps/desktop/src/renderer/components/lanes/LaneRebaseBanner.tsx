import type { ReactNode } from "react";
import { GitBranch } from "@phosphor-icons/react";
import type {
  AutoRebaseLaneStatus,
  LaneSummary,
  RebaseSuggestion,
  RebaseSuggestionDisplay,
} from "../../../shared/types";
import { DEFAULT_LANE_BANNER_BUDGET, DEFAULT_REBASE_SUGGESTIONS } from "../../../shared/types/config";
import { Banner, NoticeBadge, NoticeChip, type BannerModel } from "../ui/notice";

/**
 * Rebase and auto-rebase notices above the lane list.
 *
 * This used to render two independent full-width strips unconditionally, each
 * listing up to three lanes — on a busy stack that permanently ate ~200px above
 * the thing you came here to look at, with no setting to turn it down.
 *
 * `display` now decides how loud it gets:
 *   banner — the strips, as before
 *   badge  — a single quiet summary line
 *   off    — nothing (and the scan itself is skipped upstream)
 *
 * `bannerBudget` caps how many strips may stack at once; anything over budget
 * degrades to the summary line rather than being dropped silently.
 */
export function LaneRebaseBanner({
  visibleRebaseSuggestions,
  visibleAutoRebaseNeedsAttention,
  lanesById,
  rebaseSuggestionError,
  onViewRebaseDetails,
  onDismissRebase,
  onDismissAutoRebase,
  display = DEFAULT_REBASE_SUGGESTIONS,
  bannerBudget = DEFAULT_LANE_BANNER_BUDGET,
}: {
  visibleRebaseSuggestions: RebaseSuggestion[];
  visibleAutoRebaseNeedsAttention: AutoRebaseLaneStatus[];
  lanesById: Map<string, LaneSummary>;
  rebaseSuggestionError: string | null;
  onViewRebaseDetails: (laneId?: string | null) => void;
  onDismissRebase: (laneId: string) => void;
  onDismissAutoRebase: (laneId: string) => void;
  display?: RebaseSuggestionDisplay;
  bannerBudget?: number;
}) {
  const hasSuggestions = visibleRebaseSuggestions.length > 0;
  const hasAutoRebase = visibleAutoRebaseNeedsAttention.length > 0;

  // Auto-rebase failures are a broken state, not a suggestion — they stay
  // visible even when suggestions are turned off. Only the "you could rebase"
  // nudge is suppressible.
  const showSuggestionBanner = display === "banner" && hasSuggestions;
  const showAutoRebaseBanner = hasAutoRebase;

  const requestedBanners = (showSuggestionBanner ? 1 : 0) + (showAutoRebaseBanner ? 1 : 0);
  const overBudget = requestedBanners > Math.max(0, bannerBudget);

  const errorBanner: BannerModel | null = rebaseSuggestionError
    ? { id: "lane-rebase-error", tone: "error", title: rebaseSuggestionError }
    : null;

  // Over budget, or in badge mode: collapse to one line instead of stacking.
  if (overBudget || (display === "badge" && hasSuggestions) || (display === "off" && hasAutoRebase)) {
    return (
      <BannerStack
        models={[
          rebaseSummaryModel({
            suggestionCount: display === "off" ? 0 : visibleRebaseSuggestions.length,
            attentionCount: visibleAutoRebaseNeedsAttention.length,
            onViewRebaseDetails,
          }),
          errorBanner,
        ]}
      />
    );
  }

  const models: Array<BannerModel | null> = [];

  if (showSuggestionBanner) {
    for (const s of visibleRebaseSuggestions.slice(0, 3)) {
      const lane = lanesById.get(s.laneId) ?? null;
      if (!lane) continue;
      models.push({
        id: `rebase:${s.laneId}`,
        tone: "warning",
        icon: <GitBranch size={13} weight="bold" />,
        title: "Rebase suggested",
        detail: `Rebase this lane onto ${s.baseLabel?.trim() || "parent branch"} to pick up new commits.`,
        extra: (
          <LaneMeta name={lane.name}>
            {s.hasPr ? <NoticeBadge tone="info">PR</NoticeBadge> : null}
            <NoticeBadge tone="warning">{s.behindCount} behind</NoticeBadge>
          </LaneMeta>
        ),
        actions: [
          {
            label: "View in Rebase/Merge tab",
            title: "Open the Rebase/Merge tab for this lane.",
            onClick: () => onViewRebaseDetails(s.laneId),
          },
          {
            label: "Dismiss",
            title: "Dismiss this rebase suggestion",
            onClick: () => onDismissRebase(s.laneId),
          },
        ],
      });
    }
    if (visibleRebaseSuggestions.length > 3) {
      models.push({
        id: "rebase:more",
        tone: "neutral",
        title: `+ ${visibleRebaseSuggestions.length - 3} more suggestions.`,
      });
    }
  }

  models.push(errorBanner);

  if (showAutoRebaseBanner) {
    for (const status of visibleAutoRebaseNeedsAttention.slice(0, 3)) {
      const lane = lanesById.get(status.laneId) ?? null;
      if (!lane) continue;
      const failed = status.state === "rebaseConflict" || status.state === "rebaseFailed";
      models.push({
        id: `auto-rebase:${status.laneId}`,
        tone: failed ? "error" : "warning",
        icon: <GitBranch size={13} weight="bold" />,
        title: "Auto-rebase needs attention",
        detail: status.message ?? "Manual rebase and publish may be required for this lane.",
        extra: (
          <LaneMeta name={lane.name}>
            {status.state === "rebaseConflict" ? (
              <NoticeBadge tone="error">Conflict</NoticeBadge>
            ) : status.state === "rebaseFailed" ? (
              <NoticeBadge tone="error">Failed</NoticeBadge>
            ) : (
              <NoticeBadge tone="warning">Pending</NoticeBadge>
            )}
          </LaneMeta>
        ),
        actions: [
          {
            label: "View in Rebase/Merge tab",
            title: "Open the Rebase/Merge tab for this lane.",
            onClick: () => onViewRebaseDetails(status.laneId),
          },
          {
            label: "Dismiss",
            title: "Hide this alert until the parent or base changes again.",
            onClick: () => onDismissAutoRebase(status.laneId),
          },
        ],
      });
    }
    if (visibleAutoRebaseNeedsAttention.length > 3) {
      models.push({
        id: "auto-rebase:more",
        tone: "neutral",
        title: `+ ${visibleAutoRebaseNeedsAttention.length - 3} more lanes.`,
      });
    }
  }

  return <BannerStack models={models} />;
}

/** Inline banners stacked above the lane list, spaced by their own margins. */
function BannerStack({ models }: { models: Array<BannerModel | null> }) {
  const visible = models.filter((model): model is BannerModel => model != null);
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((model, index) => (
        <Banner
          key={model.id}
          layout="inline"
          model={model}
          style={{ margin: index === visible.length - 1 ? "6px 8px" : "6px 8px 0", flexShrink: 0 }}
        />
      ))}
    </>
  );
}

/** The lane a rebase notice is about, plus its state badges. */
function LaneMeta({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <NoticeChip>{name}</NoticeChip>
      {children}
    </span>
  );
}

/**
 * The quiet form: one line, no per-lane cards, no dismiss buttons. Used in
 * badge mode and whenever the banner budget is exceeded, so a busy stack
 * costs one row instead of two full strips.
 */
function rebaseSummaryModel({
  suggestionCount,
  attentionCount,
  onViewRebaseDetails,
}: {
  suggestionCount: number;
  attentionCount: number;
  onViewRebaseDetails: (laneId?: string | null) => void;
}): BannerModel | null {
  if (suggestionCount === 0 && attentionCount === 0) return null;

  const parts: string[] = [];
  if (attentionCount > 0) {
    parts.push(`${attentionCount} lane${attentionCount === 1 ? "" : "s"} need${attentionCount === 1 ? "s" : ""} attention`);
  }
  if (suggestionCount > 0) {
    parts.push(`${suggestionCount} behind`);
  }

  // Anything needing attention is a failure state; a plain "behind" count is not.
  return {
    id: "lane-rebase-summary",
    tone: attentionCount > 0 ? "warning" : "neutral",
    icon: <GitBranch size={13} weight="bold" />,
    title: parts.join(" · "),
    actions: [{ label: "Review", variant: "secondary", onClick: () => onViewRebaseDetails(null) }],
  };
}
