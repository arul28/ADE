import { describe, expect, it } from "vitest";
import { parsePrsRouteState } from "../prsRouteState";
import { buildTimelineVisibleEventSearch } from "./PrDetailTimelineRails";

describe("buildTimelineVisibleEventSearch", () => {
  it("preserves the selected detail tab when replacing the visible event", () => {
    const current = parsePrsRouteState({
      search: "?tab=normal&prId=pr-1&eventId=comment-old&detailTab=overview",
    });

    expect(buildTimelineVisibleEventSearch({
      current,
      prId: "pr-1",
      eventId: "comment-new",
    })).toBe("?tab=normal&prId=pr-1&eventId=comment-new&detailTab=overview");
  });
});
