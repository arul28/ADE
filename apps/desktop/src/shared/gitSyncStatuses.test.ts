import { describe, expect, it, vi } from "vitest";
import type { GitUpstreamSyncStatus } from "./types";
import { normalizeSyncStatusLaneIds, settleLaneSyncStatuses } from "./gitSyncStatuses";

describe("normalizeSyncStatusLaneIds", () => {
  it("trims, drops blanks, and dedupes", () => {
    expect(normalizeSyncStatusLaneIds({
      laneIds: [" lane-1 ", "", "lane-2", "lane-1", 3],
    } as { laneIds: unknown })).toEqual(["lane-1", "lane-2"]);
  });

  it("returns an empty list for missing args", () => {
    expect(normalizeSyncStatusLaneIds(undefined)).toEqual([]);
    expect(normalizeSyncStatusLaneIds({ laneIds: undefined })).toEqual([]);
  });
});

describe("settleLaneSyncStatuses", () => {
  it("keeps a null for a lane whose loader throws", async () => {
    const getOne = vi.fn(async (laneId: string): Promise<GitUpstreamSyncStatus> => {
      if (laneId === "missing") throw new Error("no worktree");
      return {
        hasUpstream: false,
        upstreamState: "none",
        upstreamRef: null,
        ahead: 0,
        behind: 0,
        diverged: false,
        recommendedAction: "none",
      };
    });
    await expect(settleLaneSyncStatuses(["ok", "missing"], getOne)).resolves.toEqual({
      ok: {
        hasUpstream: false,
        upstreamState: "none",
        upstreamRef: null,
        ahead: 0,
        behind: 0,
        diverged: false,
        recommendedAction: "none",
      },
      missing: null,
    });
  });
});
