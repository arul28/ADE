import { describe, expect, it } from "vitest";
import type { WorkGridSet } from "../state/appStore";
import {
  MAX_WORK_GRID_TILES,
  addSessionBesideTarget,
  findGridSetForSession,
  removeSessionFromGrids,
} from "./workGrid";

/**
 * Grid membership is a renderer-heap bound, not a preference: every tile renders
 * a full live session surface (`terminalVisible`), so an uncapped set multiplies
 * whole chat panes against a ~4 GB renderer heap.
 */
function gridSetOf(sessionIds: string[]): WorkGridSet {
  return { id: "grid-1", layoutId: "layout-1", sessionIds };
}

describe("work grid membership cap", () => {
  it("refuses to grow a set that already holds the maximum tiles", () => {
    const full = Array.from({ length: MAX_WORK_GRID_TILES }, (_, i) => `chat-${i}`);
    const gridSets = [gridSetOf(full)];

    const result = addSessionBesideTarget(gridSets, {
      sessionId: "chat-overflow",
      targetSessionId: full[0],
      projectKey: "proj",
    });

    expect(result.gridSets[0].sessionIds).toEqual(full);
    expect(findGridSetForSession(result.gridSets, "chat-overflow")).toBeNull();
  });

  it("leaves the rejected session where it was instead of orphaning it", () => {
    const full = Array.from({ length: MAX_WORK_GRID_TILES }, (_, i) => `chat-${i}`);
    const other: WorkGridSet = { id: "grid-2", layoutId: "layout-2", sessionIds: ["a", "b"] };

    const result = addSessionBesideTarget([gridSetOf(full), other], {
      sessionId: "a",
      targetSessionId: full[0],
      projectKey: "proj",
    });

    // A refused move must not detach the session from the grid it already had.
    expect(findGridSetForSession(result.gridSets, "a")?.id).toBe("grid-2");
    expect(result.gridSets.find((set) => set.id === "grid-2")?.sessionIds).toEqual(["a", "b"]);
  });

  it("still accepts a member one below the cap", () => {
    const nearlyFull = Array.from({ length: MAX_WORK_GRID_TILES - 1 }, (_, i) => `chat-${i}`);

    const result = addSessionBesideTarget([gridSetOf(nearlyFull)], {
      sessionId: "chat-last",
      targetSessionId: nearlyFull[0],
      projectKey: "proj",
    });

    expect(result.gridSets[0].sessionIds).toHaveLength(MAX_WORK_GRID_TILES);
    expect(result.gridSets[0].sessionIds).toContain("chat-last");
  });

  it("keeps pairing two single sessions into a new set", () => {
    const result = addSessionBesideTarget([], {
      sessionId: "chat-b",
      targetSessionId: "chat-a",
      projectKey: "proj",
    });

    expect(result.gridSets).toHaveLength(1);
    expect(result.gridSets[0].sessionIds).toEqual(["chat-a", "chat-b"]);
  });

  it("frees a slot when a member leaves a full set", () => {
    const full = Array.from({ length: MAX_WORK_GRID_TILES }, (_, i) => `chat-${i}`);

    const afterRemoval = removeSessionFromGrids([gridSetOf(full)], "chat-0");
    const result = addSessionBesideTarget(afterRemoval, {
      sessionId: "chat-new",
      targetSessionId: "chat-1",
      projectKey: "proj",
    });

    expect(result.gridSets[0].sessionIds).toContain("chat-new");
    expect(result.gridSets[0].sessionIds).toHaveLength(MAX_WORK_GRID_TILES);
  });
});
