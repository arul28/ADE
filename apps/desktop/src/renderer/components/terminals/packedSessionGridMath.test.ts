import { describe, expect, it } from "vitest";
import {
  GRID_GAP_PX,
  computeDefaultRowSpan,
  computeGridColumnCount,
  computeMinimumRowSpan,
  computePackedGridRowHeight,
  computePackedSpanPixels,
  packGridItems,
  reconcilePackedGridLayout,
  resizePackedGridItem,
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

  it("prefers a balanced 3x2 layout over a sparse 4x2 layout for six wide chat tiles", () => {
    expect(
      computeGridColumnCount({
        containerWidth: 2200,
        tileCount: 6,
        minTileWidth: 440,
      }),
    ).toBe(3);
  });

  it("uses three columns for five wide chat tiles when that minimizes rows and empty space", () => {
    expect(
      computeGridColumnCount({
        containerWidth: 2200,
        tileCount: 5,
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

  it("honors explicit placements before packing fallback tiles", () => {
    const packed = packGridItems([
      { id: "fixed", minRowSpan: 1, span: { colSpan: 2, rowSpan: 1 }, placement: { column: 2, row: 1 } },
      { id: "fallback", minRowSpan: 1, span: { colSpan: 1, rowSpan: 1 } },
    ], 4);

    expect(packed.placements[0]).toEqual({
      id: "fixed",
      column: 2,
      row: 1,
      colSpan: 2,
      rowSpan: 1,
    });
    expect(packed.placements[1]).toEqual({
      id: "fallback",
      column: 1,
      row: 1,
      colSpan: 1,
      rowSpan: 1,
    });
  });

  it("preserves absent-tile layout entries and seeds missing tiles with defaults", () => {
    const reconciled = reconcilePackedGridLayout({
      layout: {
        "keep:col": 2,
        "keep:row": 3,
        "absent:col": 4,
        "absent:row": 4,
      },
      tileIds: ["keep", "new"],
      defaultSpansById: {
        keep: { colSpan: 1, rowSpan: 2 },
        new: { colSpan: 1, rowSpan: 3 },
      },
      columnCount: 4,
    });

    expect(reconciled).toEqual({
      "absent:col": 4,
      "absent:row": 4,
      "keep:col": 2,
      "keep:colSpan": 2,
      "keep:row": 3,
      "keep:rowSpan": 3,
      "keep:colStart": 1,
      "keep:rowStart": 1,
      "new:col": 1,
      "new:colSpan": 1,
      "new:row": 3,
      "new:rowSpan": 3,
      "new:colStart": 3,
      "new:rowStart": 1,
    });
  });

  it("preserves active placement keys when they already exist", () => {
    const reconciled = reconcilePackedGridLayout({
      layout: {
        "keep:colStart": 5,
        "keep:rowStart": 6,
        "keep:colSpan": 2,
        "keep:rowSpan": 3,
      },
      tileIds: ["keep"],
      defaultSpansById: {
        keep: { colSpan: 1, rowSpan: 2 },
      },
      columnCount: 12,
    });

    expect(reconciled).toEqual({
      "keep:col": 2,
      "keep:colSpan": 2,
      "keep:colStart": 5,
      "keep:row": 3,
      "keep:rowSpan": 3,
      "keep:rowStart": 6,
    });
  });

  it("moves the neighboring pane when expanding east", () => {
    const next = resizePackedGridItem({
      placementsById: {
        a: { id: "a", column: 1, row: 1, colSpan: 12, rowSpan: 2 },
        b: { id: "b", column: 13, row: 1, colSpan: 12, rowSpan: 2 },
      },
      tileId: "a",
      direction: "e",
      deltaCols: 2,
      deltaRows: 0,
      columnCount: 24,
      minColSpans: { a: 4, b: 4 },
      minRowSpans: { a: 1, b: 1 },
    });

    expect(next.a).toEqual({ id: "a", column: 1, row: 1, colSpan: 14, rowSpan: 2 });
    expect(next.b).toEqual({ id: "b", column: 15, row: 1, colSpan: 10, rowSpan: 2 });
  });

  it("keeps the east edge anchored when expanding west", () => {
    const next = resizePackedGridItem({
      placementsById: {
        left: { id: "left", column: 1, row: 1, colSpan: 12, rowSpan: 2 },
        right: { id: "right", column: 13, row: 1, colSpan: 12, rowSpan: 2 },
      },
      tileId: "right",
      direction: "w",
      deltaCols: -2,
      deltaRows: 0,
      columnCount: 24,
      minColSpans: { left: 4, right: 4 },
      minRowSpans: { left: 1, right: 1 },
    });

    expect(next.left).toEqual({ id: "left", column: 1, row: 1, colSpan: 10, rowSpan: 2 });
    expect(next.right).toEqual({ id: "right", column: 11, row: 1, colSpan: 14, rowSpan: 2 });
  });

  describe("computePackedGridRowHeight", () => {
    it("returns 0 when the container has no usable height", () => {
      expect(computePackedGridRowHeight({ containerHeight: 0, totalRows: 3 })).toBe(0);
      expect(computePackedGridRowHeight({ containerHeight: -10, totalRows: 3 })).toBe(0);
    });

    it("returns 0 when totalRows is zero or negative", () => {
      expect(computePackedGridRowHeight({ containerHeight: 800, totalRows: 0 })).toBe(0);
      expect(computePackedGridRowHeight({ containerHeight: 800, totalRows: -2 })).toBe(0);
    });

    it("returns 0 for non-finite container heights", () => {
      expect(computePackedGridRowHeight({ containerHeight: Number.NaN, totalRows: 3 })).toBe(0);
      expect(
        computePackedGridRowHeight({ containerHeight: Number.POSITIVE_INFINITY, totalRows: 3 }),
      ).toBe(0);
    });

    it("uses the full height for a single row (no gap to subtract)", () => {
      expect(computePackedGridRowHeight({ containerHeight: 400, totalRows: 1 })).toBe(400);
    });

    it("subtracts inter-row gaps before dividing by totalRows", () => {
      const containerHeight = 400;
      const totalRows = 4;
      const expected = (containerHeight - GRID_GAP_PX * (totalRows - 1)) / totalRows;
      expect(computePackedGridRowHeight({ containerHeight, totalRows })).toBeCloseTo(expected);
    });

    it("accepts a custom gap override", () => {
      const result = computePackedGridRowHeight({
        containerHeight: 300,
        totalRows: 3,
        gapPx: 20,
      });
      expect(result).toBeCloseTo((300 - 20 * 2) / 3);
    });

    it("clamps the available height to 0 rather than returning a negative value", () => {
      const result = computePackedGridRowHeight({
        containerHeight: 10,
        totalRows: 5,
        gapPx: 50,
      });
      expect(result).toBe(0);
    });
  });

  describe("computePackedSpanPixels", () => {
    it("returns a single unit for a span of 1 with no extra gaps", () => {
      expect(computePackedSpanPixels(1, 100)).toBe(100);
    });

    it("adds (span - 1) gaps between the units the span crosses", () => {
      expect(computePackedSpanPixels(3, 100)).toBe(3 * 100 + 2 * GRID_GAP_PX);
    });

    it("respects a custom gap override", () => {
      expect(computePackedSpanPixels(4, 50, 10)).toBe(4 * 50 + 3 * 10);
    });

    it("clamps the gap count to zero for span values of 0 or less", () => {
      expect(computePackedSpanPixels(0, 100)).toBe(0);
      expect(computePackedSpanPixels(-2, 100)).toBe(-2 * 100);
    });
  });
});
