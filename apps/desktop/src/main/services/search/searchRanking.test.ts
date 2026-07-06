import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./searchQueryParser";
import {
  RANK_TIER_BODY,
  RANK_TIER_TITLE_EXACT,
  RANK_TIER_TITLE_PREFIX,
  RANK_TIER_TITLE_SUBSTRING,
  extractSnippetRanges,
  rankCandidates,
  titleRankTier
} from "./searchRanking";

describe("titleRankTier", () => {
  it("orders exact > prefix > substring > body", () => {
    expect(titleRankTier("Fix login", "fix login")).toBe(RANK_TIER_TITLE_EXACT);
    expect(titleRankTier("Fix login flow", "fix login")).toBe(RANK_TIER_TITLE_PREFIX);
    expect(titleRankTier("Hotfix login flow", "fix login")).toBe(RANK_TIER_TITLE_SUBSTRING);
    expect(titleRankTier("Unrelated", "fix login")).toBe(RANK_TIER_BODY);
  });
});

describe("rankCandidates determinism", () => {
  const parsed = parseSearchQuery("search index");

  const corpus = [
    { docId: "d-body-good", title: "Terminal output", updatedAt: "2026-07-01T00:00:00.000Z", bm25: -3.5 },
    { docId: "d-exact", title: "Search index", updatedAt: "2026-01-01T00:00:00.000Z", bm25: -0.1 },
    { docId: "d-substr", title: "The search index rebuild", updatedAt: "2026-07-04T00:00:00.000Z", bm25: -0.2 },
    { docId: "d-prefix", title: "Search index rebuild", updatedAt: "2026-07-02T00:00:00.000Z", bm25: -0.2 },
    { docId: "d-body-weak", title: "Chat transcript", updatedAt: "2026-07-05T00:00:00.000Z", bm25: -1.0 }
  ];

  it("produces the exact expected ordering", () => {
    const ranked = rankCandidates(corpus, parsed);
    expect(ranked.map((r) => r.docId)).toEqual([
      "d-exact",
      "d-prefix",
      "d-substr",
      "d-body-good",
      "d-body-weak"
    ]);
  });

  it("is stable across input permutations", () => {
    const reversed = rankCandidates([...corpus].reverse(), parsed);
    const shuffled = rankCandidates(
      [corpus[2]!, corpus[4]!, corpus[0]!, corpus[3]!, corpus[1]!],
      parsed
    );
    const expected = rankCandidates(corpus, parsed).map((r) => r.docId);
    expect(reversed.map((r) => r.docId)).toEqual(expected);
    expect(shuffled.map((r) => r.docId)).toEqual(expected);
  });

  it("ties within a title tier break by updatedAt desc then docId asc", () => {
    const ranked = rankCandidates(
      [
        { docId: "b", title: "Search index a", updatedAt: "2026-07-01T00:00:00.000Z", bm25: 0 },
        { docId: "a", title: "Search index b", updatedAt: "2026-07-01T00:00:00.000Z", bm25: 0 },
        { docId: "c", title: "Search index c", updatedAt: "2026-07-03T00:00:00.000Z", bm25: 0 }
      ],
      parsed
    );
    expect(ranked.map((r) => r.docId)).toEqual(["c", "a", "b"]);
  });

  it("body ties break by bm25 (lower is better) before recency", () => {
    const ranked = rankCandidates(
      [
        { docId: "recent-weak", title: "x", updatedAt: "2026-07-05T00:00:00.000Z", bm25: -1 },
        { docId: "old-strong", title: "y", updatedAt: "2026-01-01T00:00:00.000Z", bm25: -2 }
      ],
      parsed
    );
    expect(ranked.map((r) => r.docId)).toEqual(["old-strong", "recent-weak"]);
  });
});

describe("extractSnippetRanges", () => {
  it("converts marker chars to typed ranges", () => {
    const { snippet, matchRanges } = extractSnippetRanges(
      "indexing terminal scrollback and chats"
    );
    expect(snippet).toBe("indexing terminal scrollback and chats");
    expect(matchRanges).toEqual([
      { start: 9, end: 17 },
      { start: 33, end: 38 }
    ]);
  });

  it("ignores unbalanced markers", () => {
    const { snippet, matchRanges } = extractSnippetRanges("no markers here");
    expect(snippet).toBe("no markers here");
    expect(matchRanges).toEqual([]);
  });
});
