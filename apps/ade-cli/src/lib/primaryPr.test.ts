import { describe, expect, it } from "vitest";

import {
  pickPrimaryPrRecord,
  prRecordNumber,
  prRecordState,
  secondaryPrRecordLabels,
} from "./primaryPr";

describe("pickPrimaryPrRecord", () => {
  it("prefers open work over a lane's merged history", () => {
    // The regression this exists for: one lane now owns several PR rows, and
    // the merged one is frequently the first row the runtime returns.
    const merged = { githubPrNumber: 10, state: "merged", updatedAt: "2026-09-16T00:00:00Z" };
    const open = { githubPrNumber: 4, state: "open", updatedAt: "2026-09-01T00:00:00Z" };
    expect(pickPrimaryPrRecord([merged, open])).toBe(open);
  });

  it("prefers an open PR over a draft", () => {
    const draft = { githubPrNumber: 12, state: "draft" };
    const open = { githubPrNumber: 11, state: "open" };
    expect(pickPrimaryPrRecord([draft, open])).toBe(open);
  });

  it("breaks a tie on recency, then on PR number", () => {
    const older = { githubPrNumber: 9, state: "open", updatedAt: "2026-09-01T00:00:00Z" };
    const newer = { githubPrNumber: 2, state: "open", updatedAt: "2026-09-14T00:00:00Z" };
    expect(pickPrimaryPrRecord([older, newer])).toBe(newer);

    const low = { githubPrNumber: 3, state: "open" };
    const high = { githubPrNumber: 8, state: "open" };
    expect(pickPrimaryPrRecord([low, high])).toBe(high);
  });

  it("skips detached rows and answers null when nothing is left", () => {
    // A real `PrDetachedLane`, not `true`. A boolean stand-in passes under the
    // `!= null` guard while never exercising the shape the wire actually
    // sends — which is how the `=== true` bug survived review twice.
    const detached = {
      githubPrNumber: 7,
      state: "open",
      detached: { at: "2026-09-16T00:00:00.000Z", laneName: null, laneColor: null, chats: 0, artifacts: 0, checkpoints: 0 },
    };
    const live = { githubPrNumber: 1, state: "merged" };
    expect(pickPrimaryPrRecord([detached, live])).toBe(live);
    expect(pickPrimaryPrRecord([detached])).toBeNull();
    expect(pickPrimaryPrRecord([])).toBeNull();
  });

  it("treats an unknown state as open rather than demoting it", () => {
    const unknown = { githubPrNumber: 5, state: "queued" };
    const merged = { githubPrNumber: 6, state: "merged" };
    expect(pickPrimaryPrRecord([merged, unknown])).toBe(unknown);
    expect(prRecordState("queued")).toBe("open");
    expect(prRecordState(undefined)).toBe("open");
    expect(prRecordState("draft")).toBe("draft");
  });

  it("reads a PR number from any of the wire field names", () => {
    expect(prRecordNumber({ githubPrNumber: 3 })).toBe(3);
    expect(prRecordNumber({ number: 4 })).toBe(4);
    expect(prRecordNumber({ prNumber: 5 })).toBe(5);
    expect(prRecordNumber({ githubPrNumber: "6" })).toBe(0);
  });
});

describe("defensive reads of untrusted wire rows", () => {
  const DETACHED = { at: "2026-09-16T00:00:00.000Z", laneName: null, laneColor: null, chats: 0, artifacts: 0, checkpoints: 0 };

  it("treats a detached RECORD as detached, not just a boolean true", () => {
    // `detached` is `PrDetachedLane | null` on the wire. A `=== true` test
    // matched nothing, so a row whose lane no longer owns it won on recency.
    const live = { githubPrNumber: 10, state: "open", updatedAt: "2026-09-01T00:00:00.000Z" };
    const stale = { githubPrNumber: 11, state: "open", updatedAt: "2026-09-15T00:00:00.000Z", detached: DETACHED };
    expect(pickPrimaryPrRecord([stale, live])).toBe(live);
    expect(pickPrimaryPrRecord([stale])).toBeNull();
  });

  it("ranks a row with no readable number last instead of letting it win", () => {
    const unusable = { githubPrNumber: "12", state: "open", updatedAt: "2026-09-15T00:00:00.000Z" };
    const usable = { githubPrNumber: 9, state: "merged", updatedAt: "2026-09-01T00:00:00.000Z" };
    expect(pickPrimaryPrRecord([unusable, usable])).toBe(usable);
  });

  it("still answers a row when NO row has a readable number", () => {
    // Excluding them outright would answer null if the runtime renamed the
    // field on every row; an unusable row still beats showing nothing.
    const a = { state: "open", updatedAt: "2026-09-01T00:00:00.000Z" };
    expect(pickPrimaryPrRecord([a])).toBe(a);
  });

  it("reads all three number aliases, which is what the deeplink stamps", () => {
    expect(prRecordNumber({ number: 4 })).toBe(4);
    expect(prRecordNumber({ prNumber: 5 })).toBe(5);
    expect(prRecordNumber({ githubPrNumber: 3 })).toBe(3);
  });
});

describe("secondaryPrRecordLabels", () => {
  const DETACHED_RECORD = {
    at: "2026-09-16T00:00:00.000Z",
    laneName: "old-lane",
    laneColor: null,
    chats: 0,
    artifacts: 0,
    checkpoints: 0,
  };

  it("drops a detached RECORD, which a boolean test kept", () => {
    // The `/pr` pane's "Also on this lane" line used `detached !== true`.
    // `detached` is `PrDetachedLane | null`, so that test was true for EVERY
    // row and a PR whose lane is gone printed as current lane work.
    const primary = { githubPrNumber: 9, state: "open" };
    const detached = { githubPrNumber: 7, state: "merged", detached: DETACHED_RECORD };
    const alsoLive = { githubPrNumber: 8, state: "draft" };
    expect(secondaryPrRecordLabels([primary, detached, alsoLive], primary)).toEqual([
      "#8 draft",
    ]);
  });

  it("excludes the primary row and keeps every other live row in order", () => {
    const primary = { githubPrNumber: 4, state: "open" };
    const follow = { githubPrNumber: 5, state: "open" };
    const merged = { githubPrNumber: 3, state: "merged" };
    expect(secondaryPrRecordLabels([merged, primary, follow], primary)).toEqual([
      "#3 merged",
      "#5 open",
    ]);
  });

  it("prints ? for a row with no readable number and open for an unknown state", () => {
    const primary = { githubPrNumber: 4, state: "open" };
    const odd = { githubPrNumber: "12", state: "queued" };
    expect(secondaryPrRecordLabels([primary, odd], primary)).toEqual(["#? open"]);
  });

  it("answers an empty list when there is no primary and nothing live", () => {
    expect(secondaryPrRecordLabels([], null)).toEqual([]);
    expect(
      secondaryPrRecordLabels([{ githubPrNumber: 2, state: "open", detached: DETACHED_RECORD }], null),
    ).toEqual([]);
  });
});
