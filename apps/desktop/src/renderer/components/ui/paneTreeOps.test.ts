import { describe, expect, it } from "vitest";
import {
  collectLeafIds,
  detectDropEdge,
  flattenSingleChildSplits,
  isValidTree,
  reconcilePaneTree,
  removePaneFromTree,
  splitPaneAtEdge,
  swapPanes,
  type PaneLeaf,
  type PaneSplit,
} from "./paneTreeOps";

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

  it("returns the fallback tree when every expected pane id has been dropped", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "dead-a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "dead-b" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const reconciled = reconcilePaneTree(tree, ["session-a", "session-b"], FALLBACK_TREE);

    expect(reconciled).toEqual(FALLBACK_TREE);
  });

  it("leaves an unchanged valid tree structurally intact", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "session-a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "session-b" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const reconciled = reconcilePaneTree(tree, ["session-a", "session-b"], FALLBACK_TREE);

    expect(reconciled).toEqual(tree);
  });
});

describe("detectDropEdge", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;

  it("returns top when the pointer is inside the top 25% band", () => {
    expect(detectDropEdge(rect, 50, 10)).toBe("top");
  });

  it("returns bottom when the pointer is past the 75% vertical threshold", () => {
    expect(detectDropEdge(rect, 50, 90)).toBe("bottom");
  });

  it("returns left when the pointer is inside the left 25% band and not near a vertical edge", () => {
    expect(detectDropEdge(rect, 10, 50)).toBe("left");
  });

  it("returns right when the pointer is past the 75% horizontal threshold", () => {
    expect(detectDropEdge(rect, 90, 50)).toBe("right");
  });

  it("returns center when the pointer is well inside the central area", () => {
    expect(detectDropEdge(rect, 50, 50)).toBe("center");
  });

  it("prefers vertical edges over horizontal edges when both thresholds are met", () => {
    expect(detectDropEdge(rect, 10, 10)).toBe("top");
  });
});

describe("removePaneFromTree", () => {
  it("returns null when removing the only pane from a leaf", () => {
    const leaf: PaneLeaf = { type: "pane", id: "only" };
    expect(removePaneFromTree(leaf, "only")).toBeNull();
  });

  it("returns the leaf unchanged when the target id is not present", () => {
    const leaf: PaneLeaf = { type: "pane", id: "keep" };
    expect(removePaneFromTree(leaf, "missing")).toBe(leaf);
  });

  it("removes a pane from a split and flattens single-child results to a leaf", () => {
    const split: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "b" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const result = removePaneFromTree(split, "a");

    expect(result).toEqual({ type: "pane", id: "b" });
  });

  it("removes a pane from a nested split and preserves sibling structure", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "vertical",
      children: [
        {
          node: {
            type: "split",
            direction: "horizontal",
            children: [
              { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
              { node: { type: "pane", id: "b" }, defaultSize: 50, minSize: 5 },
            ],
          },
          defaultSize: 50,
          minSize: 5,
        },
        { node: { type: "pane", id: "c" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const result = removePaneFromTree(tree, "a");

    expect(result).not.toBeNull();
    expect(collectLeafIds(result!)).toEqual(["b", "c"]);
  });
});

describe("flattenSingleChildSplits", () => {
  it("returns a leaf untouched", () => {
    const leaf: PaneLeaf = { type: "pane", id: "x" };
    expect(flattenSingleChildSplits(leaf)).toBe(leaf);
  });

  it("collapses a split with a single child down to that child's node", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "only" }, defaultSize: 100, minSize: 5 },
      ],
    };

    expect(flattenSingleChildSplits(tree)).toEqual({ type: "pane", id: "only" });
  });

  it("collapses nested single-child splits recursively", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "vertical",
      children: [
        {
          node: {
            type: "split",
            direction: "horizontal",
            children: [
              { node: { type: "pane", id: "inner" }, defaultSize: 100, minSize: 5 },
            ],
          },
          defaultSize: 100,
          minSize: 5,
        },
      ],
    };

    expect(flattenSingleChildSplits(tree)).toEqual({ type: "pane", id: "inner" });
  });
});

describe("swapPanes", () => {
  it("swaps two leaf ids that both appear in the tree", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "b" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const swapped = swapPanes(tree, "a", "b");

    expect(collectLeafIds(swapped)).toEqual(["b", "a"]);
  });

  it("swaps ids across nested splits", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "vertical",
      children: [
        {
          node: {
            type: "split",
            direction: "horizontal",
            children: [
              { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
              { node: { type: "pane", id: "b" }, defaultSize: 50, minSize: 5 },
            ],
          },
          defaultSize: 50,
          minSize: 5,
        },
        { node: { type: "pane", id: "c" }, defaultSize: 50, minSize: 5 },
      ],
    };

    const swapped = swapPanes(tree, "a", "c");

    expect(collectLeafIds(swapped)).toEqual(["c", "b", "a"]);
  });

  it("returns the tree unchanged when neither id is present", () => {
    const tree: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "b" }, defaultSize: 50, minSize: 5 },
      ],
    };

    expect(swapPanes(tree, "x", "y")).toEqual(tree);
  });
});

describe("isValidTree", () => {
  const baseTree: PaneSplit = {
    type: "split",
    direction: "horizontal",
    children: [
      { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
      { node: { type: "pane", id: "b" }, defaultSize: 50, minSize: 5 },
    ],
  };

  it("accepts a tree whose leaves exactly match the expected ids", () => {
    expect(isValidTree(baseTree, ["a", "b"])).toBe(true);
  });

  it("rejects a tree with extra panes", () => {
    expect(isValidTree(baseTree, ["a"])).toBe(false);
  });

  it("rejects a tree with missing panes", () => {
    expect(isValidTree(baseTree, ["a", "b", "c"])).toBe(false);
  });

  it("rejects a tree with duplicate pane ids", () => {
    const duplicate: PaneSplit = {
      type: "split",
      direction: "horizontal",
      children: [
        { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
        { node: { type: "pane", id: "a" }, defaultSize: 50, minSize: 5 },
      ],
    };
    expect(isValidTree(duplicate, ["a", "b"])).toBe(false);
  });
});

describe("splitPaneAtEdge", () => {
  const baseTree: PaneSplit = {
    type: "split",
    direction: "horizontal",
    children: [
      { node: { type: "pane", id: "a" }, defaultSize: 33, minSize: 5 },
      { node: { type: "pane", id: "b" }, defaultSize: 33, minSize: 5 },
      { node: { type: "pane", id: "c" }, defaultSize: 34, minSize: 5 },
    ],
  };

  it("places the dragged pane before the target when dropping on the left edge", () => {
    const next = splitPaneAtEdge(baseTree, "c", "a", "left");

    const replaced = next.children.find((child) => child.node.type === "split");
    const nestedIds = replaced ? collectLeafIds(replaced.node) : [];
    expect(nestedIds).toEqual(["a", "c"]);
  });

  it("places the dragged pane after the target when dropping on the right edge", () => {
    const next = splitPaneAtEdge(baseTree, "b", "a", "right");

    const replaced = next.children.find(
      (child) => child.node.type === "split" && collectLeafIds(child.node).includes("a"),
    );
    const nestedIds = replaced ? collectLeafIds(replaced.node) : [];
    expect(nestedIds).toEqual(["b", "a"]);
  });

});
