import { describe, expect, it } from "vitest";
import { resolvePaneTreeForLayout, type PaneSplit } from "./PaneTilingLayout";

const fallbackTree: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "lane-stack" } },
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          { node: { type: "pane", id: "lane-work" } },
          { node: { type: "pane", id: "lane-diff" } },
        ],
      },
    },
  ],
};

const savedTree: PaneSplit = {
  type: "split",
  direction: "vertical",
  children: [
    { node: { type: "pane", id: "lane-work" } },
    {
      node: {
        type: "split",
        direction: "horizontal",
        children: [
          { node: { type: "pane", id: "lane-stack" } },
          { node: { type: "pane", id: "lane-diff" } },
        ],
      },
    },
  ],
};

describe("resolvePaneTreeForLayout", () => {
  it("falls back to the new default tree when the next layout has no saved tree", () => {
    expect(resolvePaneTreeForLayout({
      savedTree: null,
      fallbackTree,
      expectedPaneIds: ["lane-stack", "lane-work", "lane-diff"],
    })).toEqual(fallbackTree);
  });

  it("keeps a saved tree when it still matches the current pane ids", () => {
    expect(resolvePaneTreeForLayout({
      savedTree,
      fallbackTree,
      expectedPaneIds: ["lane-stack", "lane-work", "lane-diff"],
    })).toEqual(savedTree);
  });
});
