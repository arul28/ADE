import { describe, expect, it } from "vitest";
import {
  deriveGithubSnapshotLaneLink,
  deriveGithubSnapshotMergeFacts,
  normalizeCount,
  type PullRequestRowMetadata,
} from "./prRowMetadata";

const LANE_ID = "lane-42";

function makePrRowMetadata(
  overrides: Partial<PullRequestRowMetadata> = {},
): PullRequestRowMetadata {
  return {
    lane_id: LANE_ID,
    merged_at: null,
    additions: null,
    deletions: null,
    ...overrides,
  };
}

describe("PR row metadata mappers", () => {
  it("accepts only non-negative integer count values", () => {
    expect(normalizeCount(0)).toBe(0);
    expect(normalizeCount(12)).toBe(12);
    expect(normalizeCount("")).toBeNull();
    expect(normalizeCount(false)).toBeNull();
    expect(normalizeCount(1.5)).toBeNull();
  });

  it("separates a live lane mapping from frozen detached-lane provenance", () => {
    const laneById = new Map([[LANE_ID, { name: "my-feature" }]]);

    expect(deriveGithubSnapshotLaneLink(makePrRowMetadata(), laneById)).toEqual({
      linkedLaneId: LANE_ID,
      linkedLaneName: "my-feature",
      detached: null,
    });

    expect(deriveGithubSnapshotLaneLink(makePrRowMetadata({
      detached_at: "2026-07-30T00:00:00Z",
      detached_lane_name: "retired-lane",
      detached_lane_color: "#4ADE80",
      detached_provenance: JSON.stringify({ chats: 3, artifacts: 2, checkpoints: 5 }),
    }), laneById)).toEqual({
      linkedLaneId: null,
      linkedLaneName: null,
      detached: {
        at: "2026-07-30T00:00:00Z",
        laneName: "retired-lane",
        laneColor: "#4ADE80",
        chats: 3,
        artifacts: 2,
        checkpoints: 5,
      },
    });
  });

  it("normalizes persisted merge facts for a GitHub list row", () => {
    expect(deriveGithubSnapshotMergeFacts(makePrRowMetadata({
      merged_at: "2026-07-29T00:00:00Z",
      merged_by_login: " octocat ",
      merged_by_avatar_url: "https://example.com/octocat.png",
      merge_method: "squash",
      additions: 12,
      deletions: 4,
      commit_count: 3,
      changed_files: 2,
    }))).toEqual({
      mergedAt: "2026-07-29T00:00:00Z",
      mergedBy: { login: "octocat", avatarUrl: "https://example.com/octocat.png" },
      mergeMethod: "squash",
      additions: 12,
      deletions: 4,
      commitCount: 3,
      changedFiles: 2,
    });

    expect(deriveGithubSnapshotMergeFacts(makePrRowMetadata({
      merge_method: "unsupported",
      additions: -1,
      commit_count: Number.NaN,
    }))).toMatchObject({
      mergeMethod: null,
      additions: null,
      commitCount: null,
    });
  });
});
