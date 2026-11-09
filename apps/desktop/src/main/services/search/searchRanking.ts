import type { SearchMatchRange } from "../../../shared/types/search";
import type { ParsedSearchQuery } from "./searchQueryParser";

/**
 * Deterministic ranking, exactly specifiable:
 *   exact-title match > title prefix > title substring > FTS5 BM25 body match.
 * Ties break by updatedAt desc, then docId asc. No fuzzy scoring: the same
 * query over the same corpus always produces the same ordering.
 */

export const RANK_TIER_TITLE_EXACT = 5;
export const RANK_TIER_TITLE_WHOLE_WORD = 4;
export const RANK_TIER_TITLE_PREFIX = 3;
export const RANK_TIER_TITLE_SUBSTRING = 2;
export const RANK_TIER_BODY = 1;

export type RankableCandidate = {
  docId: string;
  /**
   * Title used for the ranking tiers. Session/PR/commit/branch docs carry
   * their real title here; message/chunk docs carry "" so they rank body-only
   * and a chat's every message does not inherit its session-title rank.
   */
  rankTitle: string;
  updatedAt: string;
  /** SQLite bm25() output: lower = more relevant. 0 for non-FTS candidates. */
  bm25: number;
};

/** Normalized query text used for the title tiers: terms + phrases joined. */
export function rankQueryText(parsed: ParsedSearchQuery): string {
  return [...parsed.terms, ...parsed.phrases].join(" ").trim().toLowerCase();
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Whether `query` occurs in `title` with no letter or digit touching either end. */
function containsWholeWord(title: string, query: string): boolean {
  let from = title.indexOf(query);
  while (from !== -1) {
    // Two code units are enough to hold the neighbor even when it is a surrogate pair.
    const before = Array.from(title.slice(Math.max(0, from - 2), from)).at(-1) ?? "";
    const after = Array.from(title.slice(from + query.length, from + query.length + 2))[0] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = title.indexOf(query, from + 1);
  }
  return false;
}

export function titleRankTier(title: string, normalizedQuery: string): number {
  if (!normalizedQuery) return RANK_TIER_BODY;
  const normalizedTitle = title.trim().toLowerCase();
  if (normalizedTitle === normalizedQuery) return RANK_TIER_TITLE_EXACT;
  if (containsWholeWord(normalizedTitle, normalizedQuery)) return RANK_TIER_TITLE_WHOLE_WORD;
  if (normalizedTitle.startsWith(normalizedQuery)) return RANK_TIER_TITLE_PREFIX;
  if (normalizedTitle.includes(normalizedQuery)) return RANK_TIER_TITLE_SUBSTRING;
  return RANK_TIER_BODY;
}

export function compareRanked(
  a: RankableCandidate & { tier: number },
  b: RankableCandidate & { tier: number }
): number {
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.tier === RANK_TIER_BODY && a.bm25 !== b.bm25) return a.bm25 - b.bm25;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
}

/**
 * The production ranking pass: tier every candidate by its rankTitle (empty
 * rankTitle = body tier), then apply the deterministic comparator. This is
 * the exact ordering `searchService.query` returns.
 */
export function rankCandidates<T extends RankableCandidate>(
  candidates: T[],
  parsed: ParsedSearchQuery
): Array<T & { tier: number }> {
  const normalizedQuery = rankQueryText(parsed);
  return candidates
    .map((candidate) => ({
      ...candidate,
      tier: candidate.rankTitle
        ? titleRankTier(candidate.rankTitle, normalizedQuery)
        : RANK_TIER_BODY
    }))
    .sort(compareRanked);
}

/**
 * Snippet marker chars used with the SQLite snippet() function so match
 * offsets survive into typed ranges. \u0001/\u0002 cannot appear in indexed
 * text because ingestion strips control characters.
 */
export const SNIPPET_MARK_START = "\u0001";
export const SNIPPET_MARK_END = "\u0002";

export function extractSnippetRanges(marked: string): { snippet: string; matchRanges: SearchMatchRange[] } {
  let snippet = "";
  const matchRanges: SearchMatchRange[] = [];
  let openStart = -1;
  for (const ch of marked) {
    if (ch === SNIPPET_MARK_START) {
      openStart = snippet.length;
      continue;
    }
    if (ch === SNIPPET_MARK_END) {
      if (openStart >= 0 && snippet.length > openStart) {
        matchRanges.push({ start: openStart, end: snippet.length });
      }
      openStart = -1;
      continue;
    }
    snippet += ch;
  }
  return { snippet, matchRanges };
}
