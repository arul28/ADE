import { describe, expect, it } from "vitest";
import type { GitHubPrListItem } from "../../../../shared/types/prs";
import {
  buildPrListRows,
  formatPrListGroupDiff,
  prListGroupLabel,
  prListGroupTimestamp,
  prListHeaderIndices,
} from "./prListGrouping";

// Wednesday 2026-07-29T12:00:00Z — mid-week, so "this week" has days either side.
const NOW = new Date("2026-07-29T12:00:00.000Z").getTime();

function makeItem(overrides: Partial<GitHubPrListItem> = {}): GitHubPrListItem {
  return {
    id: "pr-1",
    scope: "repo",
    repoOwner: "arul",
    repoName: "ADE",
    githubPrNumber: 977,
    githubUrl: "https://github.com/arul/ADE/pull/977",
    title: "Automatic Lane Naming",
    state: "merged",
    isDraft: false,
    baseBranch: "main",
    headBranch: "ade/auto-naming",
    author: "arul",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    linkedPrId: null,
    linkedGroupId: null,
    linkedLaneId: null,
    linkedLaneName: null,
    adeKind: null,
    workflowDisplayState: null,
    cleanupState: null,
    labels: [],
    isBot: false,
    commentCount: 0,
    ...overrides,
  };
}

describe("prListGroupTimestamp", () => {
  it("files a merged PR under when it shipped, not when it was last touched", () => {
    const item = makeItem({
      mergedAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:00.000Z",
    });
    expect(prListGroupTimestamp(item)).toBe(new Date("2026-07-22T10:00:00.000Z").getTime());
  });

  it("falls back to updatedAt when a row has no merge timestamp", () => {
    const item = makeItem({ mergedAt: null, updatedAt: "2026-07-29T10:00:00.000Z" });
    expect(prListGroupTimestamp(item)).toBe(new Date("2026-07-29T10:00:00.000Z").getTime());
  });

  it("survives an unparseable timestamp rather than producing NaN", () => {
    const item = makeItem({ mergedAt: "not-a-date", updatedAt: "", createdAt: "" });
    expect(prListGroupTimestamp(item)).toBe(0);
  });
});

describe("prListGroupLabel", () => {
  const label = (iso: string) => prListGroupLabel(new Date(iso).getTime(), NOW).label;

  it("names the periods people actually use", () => {
    expect(label("2026-07-29T09:00:00.000Z")).toBe("Today");
    expect(label("2026-07-28T09:00:00.000Z")).toBe("Yesterday");
    // Monday of the current week — same week, but not today or yesterday.
    expect(label("2026-07-27T09:00:00.000Z")).toBe("This week");
    expect(label("2026-07-22T09:00:00.000Z")).toBe("Last week");
  });

  it("uses an explicit week range for older weeks in the same year", () => {
    const result = prListGroupLabel(new Date("2026-07-15T09:00:00.000Z").getTime(), NOW);
    expect(result.label).toMatch(/–/);
    expect(result.id).toMatch(/^week-/);
  });

  it("falls back to month and year for a previous year", () => {
    const result = prListGroupLabel(new Date("2025-11-15T09:00:00.000Z").getTime(), NOW);
    expect(result.id).toBe("month-2025-11");
    expect(result.label).toMatch(/2025/);
  });

  it("labels an undated row rather than inventing a period", () => {
    expect(prListGroupLabel(0, NOW)).toEqual({ id: "unknown", label: "Undated" });
  });
});

describe("buildPrListRows", () => {
  it("returns bare item rows when grouping is off", () => {
    const rows = buildPrListRows([makeItem(), makeItem({ id: "pr-2" })], { grouped: false });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "item")).toBe(true);
  });

  it("inserts one header per period and preserves the caller's order", () => {
    const rows = buildPrListRows(
      [
        makeItem({ id: "a", mergedAt: "2026-07-29T10:00:00.000Z" }),
        makeItem({ id: "b", mergedAt: "2026-07-29T09:00:00.000Z" }),
        makeItem({ id: "c", mergedAt: "2026-07-22T09:00:00.000Z" }),
      ],
      { grouped: true, now: NOW },
    );

    expect(rows.map((row) => (row.kind === "header" ? `#${row.label}` : row.item.id))).toEqual([
      "#Today",
      "a",
      "b",
      "#Last week",
      "c",
    ]);
  });

  it("aggregates counts and diff totals per period", () => {
    const rows = buildPrListRows(
      [
        makeItem({ id: "a", mergedAt: "2026-07-29T10:00:00.000Z", additions: 400, deletions: 80 }),
        makeItem({ id: "b", mergedAt: "2026-07-29T09:00:00.000Z", additions: 100, deletions: 20 }),
      ],
      { grouped: true, now: NOW },
    );

    const header = rows[0];
    expect(header.kind).toBe("header");
    if (header.kind !== "header") return;
    expect(header.count).toBe(2);
    expect(header.additions).toBe(500);
    expect(header.deletions).toBe(100);
  });

  it("treats missing diff stats as zero so detached rows still group", () => {
    const rows = buildPrListRows(
      [makeItem({ id: "a", mergedAt: "2026-07-29T10:00:00.000Z", additions: null, deletions: null })],
      { grouped: true, now: NOW },
    );
    const header = rows[0];
    if (header.kind !== "header") throw new Error("expected a header");
    expect(header.additions).toBe(0);
    expect(header.count).toBe(1);
  });
});

describe("prListHeaderIndices", () => {
  it("reports where the headers sit so the active one can be pinned", () => {
    const rows = buildPrListRows(
      [
        makeItem({ id: "a", mergedAt: "2026-07-29T10:00:00.000Z" }),
        makeItem({ id: "c", mergedAt: "2026-07-22T09:00:00.000Z" }),
      ],
      { grouped: true, now: NOW },
    );
    expect(prListHeaderIndices(rows)).toEqual([0, 2]);
  });
});

describe("formatPrListGroupDiff", () => {
  it("abbreviates large totals and omits empty ones", () => {
    expect(formatPrListGroupDiff(412, 88)).toBe("+412 −88");
    expect(formatPrListGroupDiff(1234, 380)).toBe("+1.2k −380");
    expect(formatPrListGroupDiff(12345, 10500)).toBe("+12k −11k");
    expect(formatPrListGroupDiff(0, 0)).toBeNull();
  });
});
