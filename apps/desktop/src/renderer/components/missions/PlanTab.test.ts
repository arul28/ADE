import { describe, expect, it } from "vitest";
import { buildExecutableProgressLabel } from "./PlanTab";

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
});
