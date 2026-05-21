import { useEffect, useMemo } from "react";
import type { LaneLinearIssue } from "../../../shared/types";
import { EmptyState } from "../ui/EmptyState";
import { SANS_FONT } from "./laneDesignTokens";
import { WorkViewArea } from "../terminals/WorkViewArea";
import { dispatchWorkSurfaceRevealed } from "../terminals/workSurfaceVisibility";
import { useLaneWorkSessions } from "./useLaneWorkSessions";

export function LaneWorkPane({
  laneId,
  initialLinearIssueContext = null,
  onInitialLinearIssueContextConsumed,
}: {
  laneId: string | null;
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
    const hasVisibleTerminalSurface =
      work.viewMode === "grid"
        ? work.visibleSessions.length > 0
        : Boolean(work.activeItemId);
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
  }, [laneId, work.activeItemId, work.viewMode, visibleSessionIdsKey]);

  if (!laneId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <EmptyState title="No lane selected" description="Select a lane to view active work." />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-bg)", fontFamily: SANS_FONT }}>
      <div className="min-h-0 flex-1" data-tour="work.viewArea">
        <WorkViewArea
          gridLayoutId={work.gridLayoutId}
          lanes={laneList}
          sessions={work.sessions}
          visibleSessions={work.visibleSessions}
          activeItemId={work.activeItemId}
          viewMode={work.viewMode}
          draftKind={work.draftKind}
          draftLaneId={laneId}
          setViewMode={work.setViewMode}
          onSelectItem={work.setActiveItemId}
          onCloseItem={work.closeTab}
          onOpenChatSession={work.handleOpenChatSession}
          onLaunchPtySession={work.launchPtySession}
          onShowDraftKind={work.showDraftKind}
          closingPtyIds={work.closingPtyIds}
          initialLinearIssueContext={initialLinearIssueContext}
          onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
        />
      </div>
    </div>
  );
}
