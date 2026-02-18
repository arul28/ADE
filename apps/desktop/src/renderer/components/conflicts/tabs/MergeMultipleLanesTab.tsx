import React from "react";
import { Layers, GitMerge, Sparkles } from "lucide-react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { LaneListPane } from "../panes/LaneListPane";
import { MultiMergePreviewPane } from "../panes/MultiMergePreviewPane";
import { ConflictResolutionPane } from "../panes/ConflictResolutionPane";

const MERGE_MULTI_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "lanes" }, defaultSize: 22, minSize: 12 },
    { node: { type: "pane", id: "multi-merge" }, defaultSize: 48, minSize: 25 },
    { node: { type: "pane", id: "resolution" }, defaultSize: 30, minSize: 15 },
  ],
};

export function MergeMultipleLanesTab() {
  const paneConfigs: Record<string, PaneConfig> = React.useMemo(
    () => ({
      lanes: {
        title: "Lanes",
        icon: Layers,
        children: <LaneListPane />,
      },
      "multi-merge": {
        title: "Multi-Lane Merge",
        icon: GitMerge,
        bodyClassName: "overflow-hidden",
        children: <MultiMergePreviewPane />,
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
      layoutId="conflicts-merge-multi"
      tree={MERGE_MULTI_TILING_TREE}
      panes={paneConfigs}
      className="h-full"
    />
  );
}
