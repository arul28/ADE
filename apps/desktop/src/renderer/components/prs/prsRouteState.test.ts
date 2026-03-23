import { describe, expect, it } from "vitest";
import { buildPrsRouteSearch, parsePrsRouteState } from "./prsRouteState";

describe("prsRouteState", () => {
  it("parses route state from search params and falls back to hash params when needed", () => {
    expect(
      parsePrsRouteState({
        search: "?tab=normal&prId=pr-123&laneId=lane-search",
        hash: "#/prs?tab=workflows&workflow=queue&queueGroupId=group-hash",
      }),
    ).toEqual({
      tab: "normal",
      workflowTab: "queue",
      laneId: "lane-search",
      prId: "pr-123",
      queueGroupId: "group-hash",
    });
  });

  it("reads route state from hash query strings when search params are absent", () => {
    expect(
      parsePrsRouteState({
        search: "",
        hash: "#/prs?tab=workflows&workflow=rebase&laneId=lane-456&prId=pr-789&queueGroupId=group-1",
      }),
    ).toEqual({
      tab: "workflows",
      workflowTab: "rebase",
      laneId: "lane-456",
      prId: "pr-789",
      queueGroupId: "group-1",
    });
  });

  it("builds normal and workflow route searches with the expected ids", () => {
    expect(
      buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: "pr-123",
        selectedQueueGroupId: "group-ignored",
        selectedRebaseItemId: "lane-ignored",
      }),
    ).toBe("?tab=normal&prId=pr-123");

    expect(
      buildPrsRouteSearch({
        activeTab: "queue",
        selectedPrId: "pr-123",
        selectedQueueGroupId: "group-456",
        selectedRebaseItemId: "lane-ignored",
      }),
    ).toBe("?tab=workflows&workflow=queue&queueGroupId=group-456");

    expect(
      buildPrsRouteSearch({
        activeTab: "rebase",
        selectedPrId: "pr-123",
        selectedQueueGroupId: "group-ignored",
        selectedRebaseItemId: "lane-456",
      }),
    ).toBe("?tab=workflows&workflow=rebase&laneId=lane-456");
  });
});
