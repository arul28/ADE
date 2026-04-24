import { describe, expect, it } from "vitest";
import { buildReviewSearch, readReviewRunId } from "./reviewRouteState";

describe("reviewRouteState", () => {
  it("omits whitespace-only run ids from the search string", () => {
    expect(buildReviewSearch("   ")).toBe("");
  });

  it("round-trips a trimmed run id", () => {
    const search = buildReviewSearch("  run-123  ");
    expect(search).toBe("?runId=run-123");
    expect(readReviewRunId(search)).toBe("run-123");
  });
});
