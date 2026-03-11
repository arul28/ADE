import { describe, expect, it } from "vitest";
import { deriveIntegrationPrLiveModel } from "./integrationPrModel";

describe("integrationPrModel", () => {
  it("treats committed integration PRs as integration-lane-vs-base for live actions", () => {
    expect(
      deriveIntegrationPrLiveModel({
        prLaneId: "lane-int",
        mergeContext: {
          prId: "pr-int",
          groupId: "group-int",
          groupType: "integration",
          sourceLaneIds: ["lane-a", "lane-b"],
          targetLaneId: "lane-main",
          integrationLaneId: "lane-int",
          members: [],
        },
      }),
    ).toEqual({
      isCommittedIntegration: true,
      provenanceLaneIds: ["lane-a", "lane-b"],
      liveSourceLaneIds: ["lane-int"],
      integrationLaneId: "lane-int",
      baseLaneId: "lane-main",
      liveScenario: "single-merge",
    });
  });

  it("falls back to source lanes when no committed integration lane exists yet", () => {
    expect(
      deriveIntegrationPrLiveModel({
        prLaneId: "lane-source",
        mergeContext: {
          prId: "pr-proposal",
          groupId: "group-proposal",
          groupType: "integration",
          sourceLaneIds: ["lane-a", "lane-b"],
          targetLaneId: "lane-main",
          integrationLaneId: null,
          members: [],
        },
      }),
    ).toEqual({
      isCommittedIntegration: false,
      provenanceLaneIds: ["lane-a", "lane-b"],
      liveSourceLaneIds: ["lane-a", "lane-b"],
      integrationLaneId: null,
      baseLaneId: "lane-main",
      liveScenario: "integration-merge",
    });
  });
});
