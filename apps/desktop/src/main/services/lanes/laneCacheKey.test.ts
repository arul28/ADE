import { describe, expect, it } from "vitest";
import { serializeLaneCacheKeyFields } from "./laneCacheKey";

describe("serializeLaneCacheKeyFields", () => {
  it("preserves the exact ordered field projection used by lane caches", () => {
    const fields = serializeLaneCacheKeyFields({
      id: "lane-1",
      parentLaneId: "lane-parent",
      branchRef: "refs/heads/feature/work",
      baseRef: "main",
      worktreePath: "/repo/.ade/worktrees/lane-1",
      archivedAt: "2026-07-22T12:00:00.000Z",
    });

    expect(Object.keys(fields)).toEqual([
      "id",
      "parentLaneId",
      "branchRef",
      "baseRef",
      "worktreePath",
      "archivedAt",
    ]);
    expect(JSON.stringify(fields)).toBe(
      "{\"id\":\"lane-1\",\"parentLaneId\":\"lane-parent\",\"branchRef\":\"refs/heads/feature/work\",\"baseRef\":\"main\",\"worktreePath\":\"/repo/.ade/worktrees/lane-1\",\"archivedAt\":\"2026-07-22T12:00:00.000Z\"}",
    );
  });
});
