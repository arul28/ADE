import { describe, expect, it } from "vitest";
import {
  canRenderMultiChatGrid,
  computeTileRects,
  focusedSessionIdForMultiView,
  resolveOpenChatSessionIds,
} from "../multiChatLayout";

describe("resolveOpenChatSessionIds", () => {
  const multiView = {
    tiles: [
      { sessionId: "tile-a", laneId: "lane-1" },
      { sessionId: "tile-b", laneId: "lane-1" },
    ],
    focusedIndex: 0,
  };

  it("streams tile sessions when the grid is visible", () => {
    expect(resolveOpenChatSessionIds({
      gridViewActive: true,
      multiView,
      activeSessionId: "other-chat",
    })).toEqual(new Set(["tile-a", "tile-b"]));
  });

  it("streams only the active chat when a resumable grid is hidden", () => {
    expect(resolveOpenChatSessionIds({
      gridViewActive: false,
      multiView,
      activeSessionId: "solo-chat",
    })).toEqual(new Set(["solo-chat"]));
  });

  it("streams the active chat when no grid exists", () => {
    expect(resolveOpenChatSessionIds({
      gridViewActive: false,
      multiView: null,
      activeSessionId: "solo-chat",
    })).toEqual(new Set(["solo-chat"]));
  });
});

describe("multi chat layout", () => {
  it("computes the locked 1-6 tile patterns inside the available area", () => {
    for (const count of [1, 2, 3, 4, 5, 6] as const) {
      const rects = computeTileRects(count, 120, 30);
      expect(rects).toHaveLength(count);
      for (const rect of rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(120);
        expect(rect.y + rect.h).toBeLessThanOrEqual(30);
      }
    }
  });

  it("uses two top and three bottom cells for the five-tile layout", () => {
    const rects = computeTileRects(5, 120, 30);
    expect(rects.map((rect) => [rect.x, rect.y, rect.w, rect.h])).toEqual([
      [0, 0, 60, 15],
      [60, 0, 60, 15],
      [0, 15, 40, 15],
      [40, 15, 40, 15],
      [80, 15, 40, 15],
    ]);
  });

  it("fills the full pane with no dead margin when dimensions don't divide evenly", () => {
    // 100 / 3 cols and 31 / 2 rows do not divide evenly — the old floor math
    // left a dead column/row. Every grid row must now span the full width, and
    // every column must span the full height.
    for (const count of [2, 3, 4, 5, 6] as const) {
      const rects = computeTileRects(count, 100, 31);
      // Rightmost edge across each pattern row reaches the full width.
      const byRow = new Map<number, typeof rects>();
      for (const rect of rects) {
        const bucket = byRow.get(rect.y) ?? [];
        bucket.push(rect);
        byRow.set(rect.y, bucket);
      }
      for (const row of byRow.values()) {
        const rightmost = Math.max(...row.map((r) => r.x + r.w));
        expect(rightmost).toBe(100);
        // No gaps/overlaps within a row: sorted edges are contiguous.
        const sorted = [...row].sort((a, b) => a.x - b.x);
        for (let i = 1; i < sorted.length; i += 1) {
          expect(sorted[i]!.x).toBe(sorted[i - 1]!.x + sorted[i - 1]!.w);
        }
      }
      // Bottom edge reaches the full height.
      expect(Math.max(...rects.map((r) => r.y + r.h))).toBe(31);
    }
  });

  it("flags layouts that are too narrow or too short for readable tiles", () => {
    expect(canRenderMultiChatGrid(6, 120, 24)).toBe(true);
    expect(canRenderMultiChatGrid(6, 80, 24)).toBe(false);
    expect(canRenderMultiChatGrid(4, 120, 12)).toBe(false);
  });

  it("resolves the focused session id safely", () => {
    expect(focusedSessionIdForMultiView(null)).toBeNull();
    expect(focusedSessionIdForMultiView({
      focusedIndex: 1,
      tiles: [
        { sessionId: "a", laneId: "l1" },
        { sessionId: "b", laneId: "l2" },
      ],
    })).toBe("b");
  });
});
