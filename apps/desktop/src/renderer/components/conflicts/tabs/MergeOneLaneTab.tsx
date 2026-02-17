import React from "react";
import { Layers, AlertTriangle, Sparkles } from "lucide-react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { LaneListPane } from "../panes/LaneListPane";
import { ConflictDetailPane } from "../panes/ConflictDetailPane";
import { ConflictResolutionPane } from "../panes/ConflictResolutionPane";

const MERGE_ONE_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "lanes" }, defaultSize: 22, minSize: 12 },
    { node: { type: "pane", id: "conflict-detail" }, defaultSize: 48, minSize: 25 },
    { node: { type: "pane", id: "resolution" }, defaultSize: 30, minSize: 15 },
  ],
};

export function MergeOneLaneTab() {
  const paneConfigs: Record<string, PaneConfig> = React.useMemo(
    () => ({
      lanes: {
        title: "Lanes",
        icon: Layers,
        children: <LaneListPane />,
      },
      "conflict-detail": {
        title: "Conflict Detail",
        icon: AlertTriangle,
        bodyClassName: "overflow-hidden",
        children: <ConflictDetailPane />,
      },
      resolution: {
        title: "Resolution",
        icon: Sparkles,
        children: <ConflictResolutionPane />,
      },
    }),
    []
  );

  return (
    <PaneTilingLayout
      layoutId="conflicts-merge-one"
      tree={MERGE_ONE_TILING_TREE}
      panes={paneConfigs}
      className="h-full"
    />
  );
}
