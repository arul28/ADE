import React from "react";
import { useDockLayout } from "../ui/DockLayoutState";
import { SplitPane, SplitPanePanel, SplitPaneSeparator } from "../ui/SplitPane";
import { LaneDetail } from "./LaneDetail";
import { LaneInspector } from "./LaneInspector";
import { LaneList } from "./LaneList";

const FALLBACK_LAYOUT = { left: 28, center: 44, right: 28 } as const;

export function LanesPage() {
  const { layout, loaded, saveLayout } = useDockLayout("lanes.cockpit", FALLBACK_LAYOUT);

  return (
    <div className="h-full min-w-0">
      {!loaded ? (
        <div className="h-full rounded-lg border border-border bg-card/60 p-4 text-sm text-muted-fg backdrop-blur">
          Loading layout…
        </div>
      ) : (
        <SplitPane id="lanes.cockpit" defaultLayout={layout} onLayoutChanged={saveLayout}>
          <SplitPanePanel id="left" minSize="18%" defaultSize="28%">
            <LaneList />
          </SplitPanePanel>
          <SplitPaneSeparator className="w-2 cursor-col-resize" />
          <SplitPanePanel id="center" minSize="30%" defaultSize="44%">
            <LaneDetail />
          </SplitPanePanel>
          <SplitPaneSeparator className="w-2 cursor-col-resize" />
          <SplitPanePanel id="right" minSize="20%" defaultSize="28%">
            <LaneInspector />
          </SplitPanePanel>
        </SplitPane>
      )}
    </div>
  );
}

