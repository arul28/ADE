import { describe, expect, it } from "vitest";
import {
  firstMeaningfulSummary,
  formatScheduledRunAt,
  humanizeAgentIdentity,
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
  });

  it("keeps the raw value for the tooltip so nothing is lost", () => {
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
});

describe("formatScheduledRunAt", () => {
  const now = Date.parse("2026-07-28T12:13:18.016Z");

  it("formats a schedule as a relative distance plus a local clock", () => {
    const formatted = formatScheduledRunAt("2026-07-28T12:17:18.016Z", now);
    expect(formatted).toContain("runs in 4m");
    // Never the raw ISO string.
    expect(formatted).not.toContain("2026-07-28T");
  });

  it("handles hours, days and the past", () => {
    expect(formatScheduledRunAt("2026-07-28T14:43:18.016Z", now)).toContain("runs in 2h 30m");
    expect(formatScheduledRunAt("2026-07-30T12:13:18.016Z", now)).toContain("runs in 2d");
    expect(formatScheduledRunAt("2026-07-28T12:08:18.016Z", now)).toContain("ran 5m ago");
  });

  it("returns null rather than echoing an unparseable value", () => {
    expect(formatScheduledRunAt(null)).toBeNull();
    expect(formatScheduledRunAt("")).toBeNull();
    expect(formatScheduledRunAt("not-a-date")).toBeNull();
  });
});
