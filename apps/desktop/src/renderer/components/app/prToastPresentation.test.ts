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

describe("getPrToastTone", () => {
  it("maps checks_failing to danger", () => {
    expect(getPrToastTone("checks_failing")).toBe("danger");
  });

  it("maps changes_requested to danger", () => {
    expect(getPrToastTone("changes_requested")).toBe("danger");
  });

  it("maps review_requested to warning", () => {
    expect(getPrToastTone("review_requested")).toBe("warning");
  });

  it("maps merge_ready to success", () => {
    expect(getPrToastTone("merge_ready")).toBe("success");
  });

  it("returns info for unknown kinds", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getPrToastTone("some_future_kind" as any)).toBe("info");
  });
});

describe("getPrToastHeadline", () => {
  it("uses the PR title as the toast headline", () => {
    expect(getPrToastHeadline(baseEvent)).toBe("Fix lanes tab");
  });

  it("falls back to title when prTitle is null", () => {
    const event = { ...baseEvent, prTitle: null as unknown as string };
    expect(getPrToastHeadline(event)).toBe("Checks failing");
  });

  it("falls back to title when prTitle is empty", () => {
    const event = { ...baseEvent, prTitle: "" };
    expect(getPrToastHeadline(event)).toBe("Checks failing");
  });

  it("falls back to title when prTitle is whitespace-only", () => {
    const event = { ...baseEvent, prTitle: "   " };
    expect(getPrToastHeadline(event)).toBe("Checks failing");
  });

  it("falls back to generic text when both prTitle and title are empty", () => {
    const event = { ...baseEvent, prTitle: "", title: "" };
    expect(getPrToastHeadline(event)).toBe("Pull request #82");
  });

  it("falls back to generic text when both prTitle and title are null", () => {
    const event = { ...baseEvent, prTitle: null as unknown as string, title: null as unknown as string };
    expect(getPrToastHeadline(event)).toBe("Pull request #82");
  });
});

describe("getPrToastSummary", () => {
  it("returns informative summary text", () => {
    expect(getPrToastSummary(baseEvent)).toBe("One or more required CI checks failed on this pull request.");
  });

  it("falls back to default text when message is empty", () => {
    const event = { ...baseEvent, message: "" };
    expect(getPrToastSummary(event)).toBe("Pull request status changed.");
  });

  it("falls back to default text when message is whitespace-only", () => {
    const event = { ...baseEvent, message: "   " };
    expect(getPrToastSummary(event)).toBe("Pull request status changed.");
  });

  it("falls back to default text when message is null", () => {
    const event = { ...baseEvent, message: null as unknown as string };
    expect(getPrToastSummary(event)).toBe("Pull request status changed.");
  });
});

describe("getPrToastMeta", () => {
  it("returns lane name, branch label, and repo label", () => {
    expect(getPrToastMeta(baseEvent, "fix-lanes-tab")).toEqual([
      "fix-lanes-tab",
      "fix-lanes-tab -> main",
      "ade-dev/ade",
    ]);
  });

  it("omits lane name when it is null", () => {
    const meta = getPrToastMeta(baseEvent, null);
    expect(meta).toEqual(["fix-lanes-tab -> main", "ade-dev/ade"]);
  });

  it("omits lane name when it is empty", () => {
    const meta = getPrToastMeta(baseEvent, "");
    expect(meta).toEqual(["fix-lanes-tab -> main", "ade-dev/ade"]);
  });

  it("omits branch label when both headBranch and baseBranch are missing", () => {
    const event = { ...baseEvent, headBranch: null as unknown as string, baseBranch: null as unknown as string };
    const meta = getPrToastMeta(event, "my-lane");
    expect(meta).toEqual(["my-lane", "ade-dev/ade"]);
  });

  it("shows only headBranch when baseBranch is missing", () => {
    const event = { ...baseEvent, baseBranch: null as unknown as string };
    const meta = getPrToastMeta(event, "my-lane");
    expect(meta).toContain("fix-lanes-tab");
    expect(meta.some((item) => item.includes("->"))).toBe(false);
  });

  it("shows only baseBranch when headBranch is missing", () => {
    const event = { ...baseEvent, headBranch: null as unknown as string };
    const meta = getPrToastMeta(event, "my-lane");
    expect(meta).toContain("main");
  });

  it("omits repo label when repoOwner and repoName are missing", () => {
    const event = { ...baseEvent, repoOwner: null as unknown as string, repoName: null as unknown as string };
    const meta = getPrToastMeta(event, "my-lane");
    expect(meta.some((item) => item.includes("/"))).toBe(false);
  });

  it("deduplicates identical items", () => {
    // If lane name equals branch label, Set dedup should prevent double entry
    const event = { ...baseEvent, headBranch: "my-lane", baseBranch: null as unknown as string };
    const meta = getPrToastMeta(event, "my-lane");
    const unique = [...new Set(meta)];
    expect(meta).toEqual(unique);
  });

  it("returns empty array when all fields are empty", () => {
    const event = {
      ...baseEvent,
      repoOwner: null as unknown as string,
      repoName: null as unknown as string,
      headBranch: null as unknown as string,
      baseBranch: null as unknown as string,
    };
    const meta = getPrToastMeta(event, null);
    expect(meta).toEqual([]);
  });
});
