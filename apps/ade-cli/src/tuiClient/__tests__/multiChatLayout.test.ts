import { describe, expect, it } from "vitest";
import { canRenderMultiChatGrid, computeTileRects, focusedSessionIdForMultiView } from "../multiChatLayout";

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
