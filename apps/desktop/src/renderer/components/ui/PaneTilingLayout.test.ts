import { describe, expect, it } from "vitest";
import { resolvePaneTreeForLayout, savedSizeFor, type PaneSplit } from "./PaneTilingLayout";

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

describe("savedSizeFor", () => {
  const key = "work:tiling:v3";

  it("restores a saved percentage when the split still has the shape it was saved at", () => {
    const layout = { [`${key}:0:size`]: 62, [`${key}:1:size`]: 38, [`${key}:arity`]: 2 };
    expect(savedSizeFor(layout, key, 0, 2)).toBe(62);
    expect(savedSizeFor(layout, key, 1, 2)).toBe(38);
  });

  it("discards sizes when the split's child count changed, rather than applying them to the wrong panels", () => {
    // Position-keyed sizes from a 3-way split would land on entirely different
    // panels in a 2-way split — how a pane ends up a sliver.
    const layout = { [`${key}:0:size`]: 18, [`${key}:1:size`]: 62, [`${key}:2:size`]: 20, [`${key}:arity`]: 3 };
    expect(savedSizeFor(layout, key, 0, 2)).toBeUndefined();
    expect(savedSizeFor(layout, key, 1, 2)).toBeUndefined();
  });

  it("floors an extreme sliver, and does NOT rescue a merely-small pane", () => {
    // The floor is a backstop against unusable values, not a layout policy: a
    // legitimately narrow side pane must survive. Note the limit this documents
    // — the 18% slot that rendered a 155-column session at ~20 columns sits
    // ABOVE this floor, so the arity guard above is what catches that class.
    expect(savedSizeFor({ [`${key}:0:size`]: 3, [`${key}:arity`]: 2 }, key, 0, 2)).toBe(10);
    expect(savedSizeFor({ [`${key}:0:size`]: 18, [`${key}:arity`]: 2 }, key, 0, 2)).toBe(18);
  });

  it("rejects corrupt values and passes through legacy layouts with no arity stamp", () => {
    expect(savedSizeFor({ [`${key}:0:size`]: Number.NaN }, key, 0, 2)).toBeUndefined();
    expect(savedSizeFor({ [`${key}:0:size`]: 0 }, key, 0, 2)).toBeUndefined();
    expect(savedSizeFor({ [`${key}:0:size`]: 100 }, key, 0, 2)).toBeUndefined();
    expect(savedSizeFor({ [`${key}:0:size`]: 55 }, key, 0, 2)).toBe(55);
  });
});
