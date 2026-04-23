import { describe, expect, it } from "vitest";
import { collectLeafIds, reconcilePaneTree, splitPaneAtEdge, type PaneSplit } from "./paneTreeOps";

const FALLBACK_TREE: PaneSplit = {
  type: "split",
  direction: "vertical",
  children: [
    { node: { type: "pane", id: "session-a" }, defaultSize: 50, minSize: 5 },
    { node: { type: "pane", id: "session-b" }, defaultSize: 50, minSize: 5 },
  ],
};

describe("reconcilePaneTree", () => {
  it("falls back when the persisted tree contains duplicate pane ids", () => {
    const duplicateTree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "session-a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "session-a" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const reconciled = reconcilePaneTree(duplicateTree, ["session-a", "session-b"], FALLBACK_TREE);

    expect(reconciled).toEqual(FALLBACK_TREE);
  });

  it("preserves valid panes and inserts missing panes by splitting an existing leaf", () => {
    const persistedTree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "session-a" }, defaultSize: 100, minSize: 5 },
      ],
    };

    const reconciled = reconcilePaneTree(persistedTree, ["session-a", "session-b"], FALLBACK_TREE);

    expect(collectLeafIds(reconciled)).toEqual(["session-a", "session-b"]);
    expect(reconciled.direction).toBe("horizontal");
    expect(reconciled.children).toHaveLength(2);
  });

  it("keeps the root structure stable when adding a pane to a nested layout", () => {
    const persistedTree: PaneSplit = {
      type: "split",
      direction: "vertical",
      children: [
        {
          node: {
            type: "split",
            direction: "horizontal",
            children: [
              { node: { type: "pane", id: "session-a" }, defaultSize: 50, minSize: 5 },
              { node: { type: "pane", id: "session-b" }, defaultSize: 50, minSize: 5 },
            ],
          },
          defaultSize: 60,
          minSize: 5,
        },
        { node: { type: "pane", id: "session-c" }, defaultSize: 40, minSize: 5 },
      ],
    };

    const fallback: PaneSplit = {
      type: "split",
      direction: "vertical",
      children: [
        {
          node: {
            type: "split",
            direction: "horizontal",
            children: [
              { node: { type: "pane", id: "session-a" }, defaultSize: 50, minSize: 5 },
              { node: { type: "pane", id: "session-b" }, defaultSize: 50, minSize: 5 },
            ],
          },
          defaultSize: 50,
          minSize: 5,
        },
        {
          node: {
            type: "split",
            direction: "horizontal",
            children: [
              { node: { type: "pane", id: "session-c" }, defaultSize: 50, minSize: 5 },
              { node: { type: "pane", id: "session-d" }, defaultSize: 50, minSize: 5 },
            ],
          },
          defaultSize: 50,
          minSize: 5,
        },
      ],
    };

    const reconciled = reconcilePaneTree(
      persistedTree,
      ["session-a", "session-b", "session-c", "session-d"],
      fallback,
    );

    expect(collectLeafIds(reconciled)).toEqual(["session-a", "session-b", "session-c", "session-d"]);
    expect(reconciled.direction).toBe("vertical");
    expect(reconciled.children).toHaveLength(2);
  });

  it("re-splits a two-pane layout when dropping one pane on the other's edge", () => {
    const twoPaneTree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "session-a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "session-b" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const next = splitPaneAtEdge(twoPaneTree, "session-b", "session-a", "top");

    expect(next.direction).toBe("vertical");
    expect(collectLeafIds(next)).toEqual(["session-a", "session-b"]);
  });
});
