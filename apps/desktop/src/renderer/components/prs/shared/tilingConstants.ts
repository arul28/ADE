import type { PaneSplit } from "../../ui/PaneTilingLayout";

/** Standard list/detail split layout used by all PR tab views. */
export const PR_TAB_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 30 },
  ],
};
