import { describe, expect, it } from "vitest";
import { getPrToastHeadline, getPrToastMeta, getPrToastSummary, getPrToastTone } from "./prToastPresentation";

const baseEvent = {
  type: "pr-notification" as const,
  polledAt: "2026-03-24T00:00:00.000Z",
  kind: "checks_failing" as const,
  laneId: "lane-1",
  prId: "pr-1",
  prNumber: 82,
  title: "Checks failing",
  prTitle: "Fix lanes tab",
  repoOwner: "ade-dev",
  repoName: "ade",
  baseBranch: "main",
  headBranch: "fix-lanes-tab",
  githubUrl: "https://github.com/ade-dev/ade/pull/82",
  message: "One or more required CI checks failed on this pull request.",
  state: "open" as const,
  checksStatus: "failing" as const,
  reviewStatus: "requested" as const,
};

describe("prToastPresentation", () => {
  it("uses the PR title as the toast headline", () => {
    expect(getPrToastHeadline(baseEvent)).toBe("Fix lanes tab");
  });

  it("returns informative summary text instead of duplicating the title", () => {
    expect(getPrToastSummary(baseEvent)).toBe("One or more required CI checks failed on this pull request.");
  });

  it("deduplicates repeated lane and branch labels in metadata", () => {
    expect(getPrToastMeta(baseEvent, "fix-lanes-tab")).toEqual(["fix-lanes-tab", "fix-lanes-tab -> main", "ade-dev/ade"]);
  });

  it("maps PR notification kinds to toast tones", () => {
    expect(getPrToastTone("checks_failing")).toBe("danger");
    expect(getPrToastTone("review_requested")).toBe("warning");
    expect(getPrToastTone("merge_ready")).toBe("success");
  });
});
