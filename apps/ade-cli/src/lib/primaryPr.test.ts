import { describe, expect, it } from "vitest";

import { pickPrimaryPrRecord, prRecordNumber, prRecordState } from "./primaryPr";

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
    const detached = { githubPrNumber: 7, state: "open", detached: true };
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
