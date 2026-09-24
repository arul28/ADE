import { describe, expect, it } from "vitest";
import { orderBrowserTabsByLane } from "./browserTabGroups";

describe("orderBrowserTabsByLane", () => {
  const tab = (id: string, groupLaneId: string | null, ownerLaneId: string | null = null) => ({
    id,
    groupLaneId,
    ownerLaneId,
  });

  it("keeps each lane's tabs in the order they were opened", () => {
    const ordered = orderBrowserTabsByLane([
      tab("a", "lane-a"),
      tab("b", "lane-b"),
      tab("c", "lane-a"),
      tab("d", null),
      tab("e", "lane-b"),
    ], "lane-b");

    expect(ordered.map((entry) => entry.id)).toEqual(["b", "e", "a", "c", "d"]);
  });

  it("puts the lane you are in first and falls back to the agent owner", () => {
    const ordered = orderBrowserTabsByLane([
      tab("loose", null),
      tab("owned", null, "lane-a"),
      tab("here", "lane-b"),
    ], "lane-b");

    expect(ordered.map((entry) => entry.id)).toEqual(["here", "owned", "loose"]);
  });
});
