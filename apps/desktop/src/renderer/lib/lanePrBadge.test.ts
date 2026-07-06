import { describe, expect, it } from "vitest";
import type { PrState } from "../../shared/types";
import { pickPrimaryPr, primaryPrStateRank } from "./lanePrBadge";

type TestPr = { id: string; state: PrState; updatedAt: string; githubPrNumber: number };

function pr(id: string, state: PrState, updatedAt: string, githubPrNumber: number): TestPr {
  return { id, state, updatedAt, githubPrNumber };
}

describe("primaryPrStateRank", () => {
  it("ranks open < draft < merged < closed", () => {
    expect(primaryPrStateRank("open")).toBeLessThan(primaryPrStateRank("draft"));
    expect(primaryPrStateRank("draft")).toBeLessThan(primaryPrStateRank("merged"));
    expect(primaryPrStateRank("merged")).toBeLessThan(primaryPrStateRank("closed"));
  });
});

describe("pickPrimaryPr", () => {
  const cases: Array<{ name: string; prs: TestPr[]; expected: string | null }> = [
    {
      name: "empty list -> null",
      prs: [],
      expected: null,
    },
    {
      name: "open beats draft",
      prs: [pr("draft", "draft", "2026-07-06T00:00:00Z", 5), pr("open", "open", "2026-07-01T00:00:00Z", 1)],
      expected: "open",
    },
    {
      name: "draft beats merged and closed",
      prs: [
        pr("closed", "closed", "2026-07-06T00:00:00Z", 9),
        pr("merged", "merged", "2026-07-05T00:00:00Z", 8),
        pr("draft", "draft", "2026-07-01T00:00:00Z", 2),
      ],
      expected: "draft",
    },
    {
      name: "newest open wins among opens",
      prs: [
        pr("old", "open", "2026-07-01T00:00:00Z", 3),
        pr("new", "open", "2026-07-06T00:00:00Z", 1),
      ],
      expected: "new",
    },
    {
      name: "highest number breaks a same-timestamp tie",
      prs: [
        pr("lo", "open", "2026-07-06T00:00:00Z", 4),
        pr("hi", "open", "2026-07-06T00:00:00Z", 7),
      ],
      expected: "hi",
    },
    {
      name: "falls back to a terminal PR when nothing is open/draft",
      prs: [
        pr("closed", "closed", "2026-07-01T00:00:00Z", 1),
        pr("merged", "merged", "2026-07-02T00:00:00Z", 2),
      ],
      expected: "merged",
    },
  ];

  for (const { name, prs, expected } of cases) {
    it(name, () => {
      expect(pickPrimaryPr(prs)?.id ?? null).toBe(expected);
    });
  }
});
