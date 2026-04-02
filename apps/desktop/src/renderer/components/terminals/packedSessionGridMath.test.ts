import { describe, expect, it } from "vitest";
import {
  computeDefaultRowSpan,
  computeGridColumnCount,
  computeMinimumRowSpan,
  packGridItems,
  reconcilePackedGridLayout,
} from "./packedSessionGridMath";

describe("packedSessionGridMath", () => {
  it("chooses evenly distributed columns when the container is wide enough", () => {
    expect(
      computeGridColumnCount({
        containerWidth: 1500,
        tileCount: 3,
        minTileWidth: 440,
      }),
    ).toBe(3);
  });

  it("packs three equal tiles across the first row on a wide surface", () => {
    const defaultRowSpan = computeDefaultRowSpan([
      computeMinimumRowSpan(220),
      computeMinimumRowSpan(220),
      computeMinimumRowSpan(220),
    ]);

    const packed = packGridItems([
      { id: "a", minRowSpan: 2, span: { colSpan: 1, rowSpan: defaultRowSpan } },
      { id: "b", minRowSpan: 2, span: { colSpan: 1, rowSpan: defaultRowSpan } },
      { id: "c", minRowSpan: 2, span: { colSpan: 1, rowSpan: defaultRowSpan } },
    ], 3);

    expect(packed.placements).toEqual([
      { id: "a", column: 1, row: 1, colSpan: 1, rowSpan: 2 },
      { id: "b", column: 2, row: 1, colSpan: 1, rowSpan: 2 },
      { id: "c", column: 3, row: 1, colSpan: 1, rowSpan: 2 },
    ]);
    expect(packed.totalRows).toBe(2);
  });

  it("drops stale layout entries and seeds missing tiles with defaults", () => {
    const reconciled = reconcilePackedGridLayout({
      layout: {
        "keep:col": 2,
        "keep:row": 3,
        "stale:col": 4,
        "stale:row": 4,
      },
      tileIds: ["keep", "new"],
      defaultSpansById: {
        keep: { colSpan: 1, rowSpan: 2 },
        new: { colSpan: 1, rowSpan: 3 },
      },
    });

    expect(reconciled).toEqual({
      "keep:col": 2,
      "keep:row": 3,
      "new:col": 1,
      "new:row": 3,
    });
  });
});
