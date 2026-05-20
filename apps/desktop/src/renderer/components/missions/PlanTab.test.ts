import { describe, expect, it } from "vitest";
import { buildExecutableProgressLabel, getVisiblePlanSteps, shouldCompactPlanStepLists } from "./PlanTab";

describe("buildExecutableProgressLabel", () => {
  it("does not count canceled work as complete", () => {
    expect(buildExecutableProgressLabel([{ status: "canceled" }])).toBe(
      "0/1 registered executable steps succeeded · 1 canceled",
    );
  });

  it("keeps the compact complete label for succeeded work", () => {
    expect(buildExecutableProgressLabel([{ status: "succeeded" }, { status: "succeeded" }])).toBe(
      "2/2 registered executable steps complete",
    );
  });

  it("compacts duplicate step lists for large plans until expanded", () => {
    const steps = Array.from({ length: 12 }, (_, index) => index + 1);

    expect(shouldCompactPlanStepLists(80)).toBe(false);
    expect(shouldCompactPlanStepLists(81)).toBe(true);
    expect(getVisiblePlanSteps(steps, true, false, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(getVisiblePlanSteps(steps, true, true, 5)).toEqual(steps);
    expect(getVisiblePlanSteps(steps, false, false, 5)).toEqual(steps);
  });
});
