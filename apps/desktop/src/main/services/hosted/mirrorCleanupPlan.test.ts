import { describe, expect, it } from "vitest";
import { planMirrorCleanup } from "../../../../../../infra/packages/core/src/mirrorCleanup";

describe("planMirrorCleanup", () => {
  it("deletes only stale orphaned digests and keeps reachable blobs", () => {
    const nowMs = Date.parse("2026-02-16T00:00:00.000Z");
    const reachable = new Set<string>(["1".repeat(64)]);
    const plan = planMirrorCleanup({
      projectId: "proj-1",
      reachableDigests: reachable,
      blobObjects: [
        {
          key: `proj-1/${"1".repeat(64)}`,
          size: 100,
          lastModified: "2026-02-15T00:00:00.000Z"
        },
        {
          key: `proj-1/${"2".repeat(64)}`,
          size: 200,
          lastModified: "2026-02-10T00:00:00.000Z"
        },
        {
          key: "proj-1/not-a-digest",
          size: 50,
          lastModified: "2026-02-10T00:00:00.000Z"
        }
      ],
      nowMs,
      staleGraceMs: 60_000,
      maxDelete: 10,
      maxBytesScanned: 10_000
    });

    expect(plan.reachableBlobCount).toBe(1);
    expect(plan.orphanCandidates.map((entry) => entry.key)).toEqual([`proj-1/${"2".repeat(64)}`]);
    expect(plan.deletionBatch.map((entry) => entry.key)).toEqual([`proj-1/${"2".repeat(64)}`]);
    expect(plan.reclaimedBytes).toBe(200);
  });

  it("respects deletion caps and scan byte caps", () => {
    const nowMs = Date.parse("2026-02-16T00:00:00.000Z");
    const plan = planMirrorCleanup({
      projectId: "proj-2",
      reachableDigests: [],
      blobObjects: [
        {
          key: `proj-2/${"a".repeat(64)}`,
          size: 400,
          lastModified: "2026-02-10T00:00:00.000Z"
        },
        {
          key: `proj-2/${"b".repeat(64)}`,
          size: 400,
          lastModified: "2026-02-10T00:00:01.000Z"
        },
        {
          key: `proj-2/${"c".repeat(64)}`,
          size: 400,
          lastModified: "2026-02-10T00:00:02.000Z"
        }
      ],
      nowMs,
      staleGraceMs: 0,
      maxDelete: 1,
      maxBytesScanned: 900
    });

    expect(plan.orphanCandidates.length).toBe(2);
    expect(plan.deletionBatch.length).toBe(1);
    expect(plan.warnings).toContain("max_bytes_scanned_reached");
    expect(plan.warnings).toContain("max_delete_cap_reached");
  });
});
