import { describe, expect, it } from "vitest";
import type { RebaseNeed } from "../../../../shared/types";
import { rebaseNeedItemKey } from "../shared/rebaseNeedUtils";

function makeNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: "lane-1",
    laneName: "Feature Lane",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 3,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: null,
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

describe("RebaseTab grouping helpers", () => {
  it("keeps lane-base and PR-target items distinct", () => {
    expect(makeNeed({ kind: "lane_base" }).kind).toBe("lane_base");
    expect(makeNeed({ kind: "pr_target", prId: "pr-1" }).kind).toBe("pr_target");
  });

  it("uses a stable key that distinguishes item kind", () => {
    const laneBase = makeNeed({ kind: "lane_base", prId: null, baseBranch: "main" });
    const prTarget = makeNeed({ kind: "pr_target", prId: "pr-1", baseBranch: "main" });
    expect(rebaseNeedItemKey(laneBase)).not.toBe(rebaseNeedItemKey(prTarget));
  });
});
