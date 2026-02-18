import React from "react";
import { useSearchParams } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { ConflictsProvider, useConflictsState, useConflictsDispatch } from "./state/ConflictsContext";
import { MergeOneLaneTab } from "./tabs/MergeOneLaneTab";
import { MergeMultipleLanesTab } from "./tabs/MergeMultipleLanesTab";
import type { ActiveTab } from "./state/types";

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "merge-one", label: "Merge One Lane" },
  { id: "merge-multiple", label: "Merge Multiple Lanes" },
];

function ConflictsPageInner() {
  const lanes = useAppStore((s) => s.lanes);
  const [searchParams] = useSearchParams();
  const { activeTab } = useConflictsState();
  const dispatch = useConflictsDispatch();
  const appliedDeepLinkRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const paramsKey = searchParams.toString();
    if (!paramsKey || lanes.length === 0) return;
    if (appliedDeepLinkRef.current === paramsKey) return;

    const laneIds = new Set(lanes.map((lane) => lane.id));
    const tabParam = searchParams.get("tab");
    const sourceParam = (searchParams.get("laneAId") ?? searchParams.get("sourceLaneId") ?? "").trim();
    const targetParam = (searchParams.get("laneBId") ?? searchParams.get("targetLaneId") ?? "").trim();

    if (tabParam === "merge-one" || tabParam === "merge-multiple") {
      dispatch({ type: "SET_ACTIVE_TAB", tab: tabParam });
    }

    const sourceLaneId = sourceParam && laneIds.has(sourceParam) ? sourceParam : null;
    const targetLaneId = targetParam && laneIds.has(targetParam) ? targetParam : null;

    if (sourceLaneId) {
      dispatch({ type: "SET_ACTIVE_TAB", tab: "merge-one" });
      dispatch({ type: "SET_LANE_LIST_VIEW", view: "by-lane" });
      dispatch({ type: "SET_VIEW_MODE", mode: "summary" });
      dispatch({ type: "SET_SELECTED_LANE", laneId: sourceLaneId });
      dispatch({ type: "SET_PROPOSAL_PEER_LANE_ID", laneId: targetLaneId });
      if (targetLaneId && targetLaneId !== sourceLaneId) {
        dispatch({ type: "SET_SELECTED_PAIR", pair: { laneAId: sourceLaneId, laneBId: targetLaneId } });
      } else {
        dispatch({ type: "SET_SELECTED_PAIR", pair: null });
      }
    }

    appliedDeepLinkRef.current = paramsKey;
  }, [searchParams, lanes, dispatch]);

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border/50 bg-card/30 px-3 py-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => dispatch({ type: "SET_ACTIVE_TAB", tab: tab.id })}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === tab.id
                ? "bg-accent/15 text-accent"
                : "text-muted-fg hover:text-fg hover:bg-muted/30"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active tab content */}
      <div className="min-h-0 flex-1">
        {activeTab === "merge-one" ? <MergeOneLaneTab /> : <MergeMultipleLanesTab />}
      </div>
    </div>
  );
}

export function ConflictsPage() {
  return (
    <ConflictsProvider>
      <ConflictsPageInner />
    </ConflictsProvider>
  );
}
