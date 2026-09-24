import { describe, expect, it } from "vitest";
import {
  firstMeaningfulSummary,
  humanizeAgentIdentity,
  isEmptyDiffStatSummary,
  isPlaceholderSummary,
} from "./chatCardPrimitives";

describe("humanizeAgentIdentity", () => {
  // `/ROOT/SHIP_POLL_927` is Codex's internal agent path. Rendered raw (and
  // CSS-uppercased on top) it shouted a file path where a role belonged.
  it("turns an internal agent path into a role plus an issue reference", () => {
    expect(humanizeAgentIdentity("/ROOT/SHIP_POLL_927")).toEqual({
      label: "Ship poll",
      ref: "#927",
      raw: "/ROOT/SHIP_POLL_927",
    });
    expect(humanizeAgentIdentity("/root/review_fixer")?.raw).toBe("/root/review_fixer");
    expect(humanizeAgentIdentity("/root/review_fixer")?.label).toBe("Review fixer");
    expect(humanizeAgentIdentity("/root/review_fixer")?.ref).toBeNull();
  });

  it("renders no chip for the runtimes that never set an agent type", () => {
    // OpenCode / Droid send nothing at all.
    expect(humanizeAgentIdentity(null)).toBeNull();
    expect(humanizeAgentIdentity(undefined)).toBeNull();
    expect(humanizeAgentIdentity("   ")).toBeNull();
    // `background` is already its own chip on the spawn card.
    expect(humanizeAgentIdentity("background")).toBeNull();
    // A bare path root carries no role.
    expect(humanizeAgentIdentity("/root")).toBeNull();
  });

  it("passes an already-human agent type through as sentence case", () => {
    expect(humanizeAgentIdentity("Explore")?.label).toBe("Explore");
    expect(humanizeAgentIdentity("claude")?.label).toBe("Claude");
  });

  it("does not mistake a version-like tail for an issue number", () => {
    expect(humanizeAgentIdentity("worker_5")?.label).toBe("Worker 5");
    expect(humanizeAgentIdentity("worker_5")?.ref).toBeNull();
  });
});

describe("firstMeaningfulSummary", () => {
  it("rejects the runtime filler that used to be printed as a result", () => {
    expect(isPlaceholderSummary("Agent completed")).toBe(true);
    expect(isPlaceholderSummary("Agent received input")).toBe(true);
    expect(isPlaceholderSummary("Agent active.")).toBe(true);
    expect(isPlaceholderSummary("")).toBe(true);
  });

  it("returns the first candidate that actually says something", () => {
    expect(firstMeaningfulSummary("Agent completed", "Head ccce46c4b is stable."))
      .toBe("Head ccce46c4b is stable.");
    expect(firstMeaningfulSummary("Agent completed", null)).toBeNull();
  });

  it("treats an all-zero diff stat as saying nothing, and any non-zero count as a result", () => {
    expect(isEmptyDiffStatSummary("+0 −0 · 0 files")).toBe(true);
    expect(isEmptyDiffStatSummary("+0 -0 · 0 file")).toBe(true);
    expect(isEmptyDiffStatSummary("+0 −0")).toBe(true);
    expect(isEmptyDiffStatSummary("+10 −0 · 0 files")).toBe(false);
    expect(isEmptyDiffStatSummary("+0 −0 · 10 files")).toBe(false);
    expect(isEmptyDiffStatSummary("+1 −0 · 1 files")).toBe(false);
    expect(isEmptyDiffStatSummary("+0 −0 · 0 files and a note")).toBe(false);
    expect(firstMeaningfulSummary("+0 −0 · 0 files")).toBeNull();
    expect(firstMeaningfulSummary("+0 −0 · 0 files", "Found the bug.")).toBe("Found the bug.");
    expect(firstMeaningfulSummary("+4 −1 · 2 files")).toBe("+4 −1 · 2 files");
  });
});
