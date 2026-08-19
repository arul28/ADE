/**
 * Lane story body — the Lanes tab content while the experiment is on.
 *
 * Routes between the List and Timeline views, owns the two data hooks, and
 * resolves the one piece of shared identity both views need (the signed-in
 * human's avatar). Everything heavier — the canvas, the scrubber — is reached
 * only from the Timeline.
 */

import React, { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { LaneSummary } from "../../../../shared/types";
import { accountAvatarImage, useAccountStatus } from "../../../lib/account";
import { buildPrsRouteSearch } from "../../prs/prsRouteState";
import type { LaneTabPrTag } from "../lanePageModel";
import { LaneStoryList } from "./LaneStoryList";
import { LaneStoryTimeline } from "./LaneStoryTimeline";
import { useLaneEventsSummary } from "./useLaneEvents";
import type { LaneStoryView } from "./laneStoryViewState";

export type LaneStoryBodyProps = {
  lanes: readonly LaneSummary[];
  lanePrTagsByLaneId: ReadonlyMap<string, LaneTabPrTag[]>;
  selectedLaneId: string | null;
  view: LaneStoryView;
  onViewChange: (next: LaneStoryView) => void;
  onSelectLane: (laneId: string) => void;
  /** False while the Lanes route is parked (mounted but not the visible tab). */
  active?: boolean;
  /** Renders the Lanes pane region's own Git Actions pane inside the Git ▾ sheet. */
  renderGitActions?: (laneId: string) => React.ReactNode;
};

export default function LaneStoryBody({
  lanes,
  lanePrTagsByLaneId,
  selectedLaneId,
  view,
  onViewChange,
  onSelectLane,
  renderGitActions,
  active = true,
}: LaneStoryBodyProps) {
  const navigate = useNavigate();
  const { status } = useAccountStatus();
  const humanAvatarUrl = useMemo(() => accountAvatarImage(status, null), [status]);

  const laneIds = useMemo(() => lanes.map((lane) => lane.id), [lanes]);
  // The List view is the only surface that needs every lane's digest; the
  // Timeline reads one lane in full, so don't fan summaries out behind it.
  const summaryLaneIds = view === "list" ? laneIds : EMPTY_LANE_IDS;
  const summaries = useLaneEventsSummary(summaryLaneIds, active);

  const selectedLane = useMemo(
    () => lanes.find((lane) => lane.id === selectedLaneId) ?? lanes[0] ?? null,
    [lanes, selectedLaneId],
  );
  const selectedPrs = useMemo(
    () => (selectedLane ? lanePrTagsByLaneId.get(selectedLane.id) ?? EMPTY_PRS : EMPTY_PRS),
    [lanePrTagsByLaneId, selectedLane],
  );

  const openPr = useCallback((pr: LaneTabPrTag) => {
    navigate(`/prs${buildPrsRouteSearch({
      activeTab: pr.source === "github" && !pr.linkedPrId ? "github" : "normal",
      selectedPrId: pr.linkedPrId ?? null,
      selectedPrNumber: pr.githubPrNumber,
      repoOwner: pr.repoOwner,
      repoName: pr.repoName,
      selectedRebaseItemId: null,
    })}`);
  }, [navigate]);

  const openLane = useCallback((laneId: string) => {
    onSelectLane(laneId);
    onViewChange("timeline");
  }, [onSelectLane, onViewChange]);

  if (view === "list") {
    return (
      <div className="flex-1 min-h-0 flex flex-col relative">
        <div className="ade-lane-story-bg" aria-hidden />
        <LaneStoryList
          lanes={lanes}
          summaries={summaries}
          lanePrTagsByLaneId={lanePrTagsByLaneId}
          selectedLaneId={selectedLaneId}
          humanAvatarUrl={humanAvatarUrl}
          onOpenLane={openLane}
          onOpenPr={openPr}
        />
      </div>
    );
  }

  return (
    <LaneStoryTimeline
      lane={selectedLane}
      prs={selectedPrs}
      humanAvatarUrl={humanAvatarUrl}
      renderGitActions={renderGitActions}
      onOpenPr={openPr}
      active={active}
    />
  );
}

const EMPTY_LANE_IDS: string[] = [];
const EMPTY_PRS: LaneTabPrTag[] = [];
