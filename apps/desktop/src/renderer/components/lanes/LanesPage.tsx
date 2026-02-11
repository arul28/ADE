import React, { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useDockLayout } from "../ui/DockLayoutState";
import { SplitPane, SplitPanePanel, SplitPaneSeparator } from "../ui/SplitPane";
import { LaneDetail } from "./LaneDetail";
import { LaneInspector } from "./LaneInspector";
import { LaneList } from "./LaneList";
import { useAppStore } from "../../state/appStore";

const FALLBACK_LAYOUT = { left: 28, center: 44, right: 28 } as const;

export function LanesPage() {
  const { layout, loaded, saveLayout } = useDockLayout("lanes.cockpit", FALLBACK_LAYOUT);
  const [params] = useSearchParams();
  const selectLane = useAppStore((s) => s.selectLane);
  const focusSession = useAppStore((s) => s.focusSession);

  useEffect(() => {
    const laneId = params.get("laneId");
    const sessionId = params.get("sessionId");
    if (laneId) selectLane(laneId);
    if (sessionId) focusSession(sessionId);
  }, [params, selectLane, focusSession]);

  if (!loaded) return null;

  return (
    <div className="h-full min-w-0 bg-bg">
      <SplitPane id="lanes.cockpit" defaultLayout={layout} onLayoutChanged={saveLayout}>
        <SplitPanePanel id="left" minSize="18%" defaultSize="28%" className="h-full flex flex-col min-w-0">
          <LaneList />
        </SplitPanePanel>

        {/* Physical Divider */}
        <SplitPaneSeparator className="w-px bg-border hover:bg-accent hover:w-1 transition-all z-10" />

        <SplitPanePanel id="center" minSize="30%" defaultSize="44%" className="h-full flex flex-col min-w-0 bg-bg">
          <LaneDetail />
        </SplitPanePanel>

        {/* Physical Divider */}
        <SplitPaneSeparator className="w-px bg-border hover:bg-accent hover:w-1 transition-all z-10" />

        <SplitPanePanel id="right" minSize="20%" defaultSize="28%" className="h-full flex flex-col min-w-0 bg-bg">
          <LaneInspector />
        </SplitPanePanel>
      </SplitPane>
    </div>
  );
}
