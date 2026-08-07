import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { GitPullRequest } from "@phosphor-icons/react";
import type { LaneLinearIssue, LaneSummary, PrSummary } from "../../../shared/types";
import { EmptyState } from "../ui/EmptyState";
import { SANS_FONT } from "./laneDesignTokens";
import { WorkViewArea } from "../terminals/WorkViewArea";
import { dispatchWorkSurfaceRevealed } from "../terminals/workSurfaceVisibility";
import { useLaneWorkSessions } from "./useLaneWorkSessions";
import { buildPrsRouteSearch } from "../prs/prsRouteState";
import { lanePrStateColor, lanePrStateLabel } from "../../lib/lanePrBadge";
import { getPrCiDotColor, getPrReviewDotColor } from "../prs/shared/prVisuals";
import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";

function LanePullRequestsSection({ lane, prs }: { lane: LaneSummary | null; prs: PrSummary[] }) {
  const navigate = useNavigate();
  if (!lane || prs.length === 0) return null;
  const laneBranch = branchNameFromLaneRef(lane.branchRef);
  return (
    <section className="flex-none border-b border-white/[0.07] bg-white/[0.015] px-3 py-2" aria-label={`Pull requests (${prs.length})`}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-fg/55">
        <GitPullRequest size={12} weight="bold" />
        Pull requests ({prs.length})
      </div>
      <div className="max-h-[132px] space-y-0.5 overflow-y-auto pr-1">
        {prs.map((pr) => {
          const active = branchNameFromLaneRef(pr.headBranch) === laneBranch;
          const stateColor = lanePrStateColor(pr.state);
          const ciColor = getPrCiDotColor({ checksStatus: pr.checksStatus });
          const reviewColor = getPrReviewDotColor({ reviewStatus: pr.reviewStatus });
          return (
            <button
              key={pr.id}
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
              onClick={() => navigate(`/prs${buildPrsRouteSearch({
                activeTab: "normal",
                selectedPrId: pr.id,
                selectedPrNumber: pr.githubPrNumber,
                repoOwner: pr.repoOwner,
                repoName: pr.repoName,
                selectedLaneId: pr.laneId,
                selectedRebaseItemId: null,
              })}`)}
              title={pr.title || `Pull request #${pr.githubPrNumber}`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: stateColor }} />
              <span className="shrink-0 font-mono text-[10px] font-semibold text-fg/80">#{pr.githubPrNumber}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-fg/70">{pr.title || "Untitled pull request"}</span>
              <span className="shrink-0 text-[9px]" style={{ color: active ? "#60a5fa" : "rgba(255,255,255,0.38)" }}>
                {active ? "active" : "previous"}
              </span>
              <span className="flex shrink-0 items-center gap-1" aria-label={`CI ${pr.checksStatus}; review ${pr.reviewStatus}`}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: ciColor }} />
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: reviewColor }} />
              </span>
              <span className="sr-only">{lanePrStateLabel(pr.state)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function LaneWorkPane({
  laneId,
  lanePrs = [],
  initialLinearIssueContext = null,
  onInitialLinearIssueContextConsumed,
}: {
  laneId: string | null;
  lanePrs?: PrSummary[];
  initialLinearIssueContext?: LaneLinearIssue | null;
  onInitialLinearIssueContextConsumed?: () => void;
}) {
  const work = useLaneWorkSessions(laneId);
  const laneList = work.lane ? [work.lane] : [];
  const visibleSessionIdsKey = useMemo(
    () => work.visibleSessions.map((session) => session.id).join("\0"),
    [work.visibleSessions],
  );

  useEffect(() => {
    if (!laneId) return;
    const hasVisibleTerminalSurface = Boolean(work.activeItemId);
    if (!hasVisibleTerminalSurface) return;

    const raf = window.requestAnimationFrame(() => {
      dispatchWorkSurfaceRevealed();
    });
    const settleTimer = window.setTimeout(() => {
      dispatchWorkSurfaceRevealed();
    }, 140);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
    };
  }, [laneId, work.activeItemId, visibleSessionIdsKey]);

  if (!laneId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <EmptyState title="No lane selected" description="Select a lane to view active work." />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-bg)", fontFamily: SANS_FONT }}>
      <LanePullRequestsSection lane={work.lane} prs={lanePrs} />
      <div className="min-h-0 flex-1" data-tour="work.viewArea">
        <WorkViewArea
          lanes={laneList}
          sessions={work.sessions}
          visibleSessions={work.visibleSessions}
          activeItemId={work.activeItemId}
          draftKind={work.draftKind}
          orchestratorEnabled={work.orchestratorEnabled}
          draftLaneId={laneId}
          onSelectItem={work.setActiveItemId}
          onCloseItem={work.closeTab}
          onOpenChatSession={work.handleOpenChatSession}
          onLaunchPtySession={work.launchPtySession}
          onContinueCliSession={work.continueCliSession}
          onShowDraftKind={work.showDraftKind}
          onStopRunningSession={(session) => {
            if (!session.ptyId) return;
            void work.closePtySession(session.ptyId).catch((error) => {
              console.warn("[LaneWorkPane] Failed to stop running session", error);
            });
          }}
          suppressDraftLaunchNavigation
          closingPtyIds={work.closingPtyIds}
          initialLinearIssueContext={initialLinearIssueContext}
          onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
        />
      </div>
    </div>
  );
}
