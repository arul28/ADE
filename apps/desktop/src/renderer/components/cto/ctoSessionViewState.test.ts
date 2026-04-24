import { describe, expect, it } from "vitest";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";

describe("resolveCtoPrimaryLaneId", () => {
  it("prefers the primary lane even when another lane is selected elsewhere in the app", () => {
    expect(resolveCtoPrimaryLaneId([
      { id: "lane-feature", laneType: "worktree" },
      { id: "lane-primary", laneType: "primary" },
    ])).toBe("lane-primary");
  });

  it("falls back to the first lane when a primary lane has not been materialized yet", () => {
    expect(resolveCtoPrimaryLaneId([
      { id: "lane-feature", laneType: "worktree" },
      { id: "lane-bugfix", laneType: "worktree" },
    ])).toBe("lane-feature");
  });

  it("returns null when no lanes are available", () => {
    expect(resolveCtoPrimaryLaneId([])).toBeNull();
  });
});
