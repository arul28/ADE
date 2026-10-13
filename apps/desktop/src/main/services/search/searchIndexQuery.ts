import type {
  SearchDocKind,
  SearchMatchRange,
  SearchQueryArgs,
  SearchResultItem
} from "../../../shared/types/search";
import { SEARCH_DOC_KINDS, isSearchDocKind } from "../../../shared/types/search";
import { openSearchIndexDbReadOnly } from "./searchIndexDb";
import {
  buildFtsMatchExpression,
  parseSearchQuery,
  type ParsedSearchQuery
} from "./searchQueryParser";
import {
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  extractSnippetRanges,
  rankCandidates
} from "./searchRanking";

/**
 * The read side of the search index: one SQL owner for the FTS candidate
 * query, shared by the live service (its own read-write handle) and by
 * `querySearchIndexReadOnly`, which answers for a project whose runtime is not
 * loaded by reading its index file directly.
 */

export const FTS_KINDS: readonly SearchDocKind[] = ["chat", "terminal", "pr", "commit", "branch"];

const FTS_CANDIDATE_LIMIT = 400;
const MATCH_ALL_LIMIT = 200;

/** Runs one read against an open index; the caller owns the handle. */
export type SearchIndexAll = <T>(sql: string, params?: Array<string | number | null>) => T[];

export type DocRow = {
  doc_id: string;
  kind: string;
  lane_id: string | null;
  lane_name: string | null;
  session_id: string | null;
  title: string;
  rank_title: string | null;
  snippet_source: string | null;
  deep_link: string;
  updated_at: string;
};

export type SearchCandidate = {
  docId: string;
  kind: SearchDocKind;
  title: string;
  rankTitle: string;
  laneId: string | null;
  laneName: string | null;
  sessionId: string | null;
  deepLink: string;
  updatedAt: string;
  bm25: number;
  snippet: string;
  matchRanges: SearchMatchRange[];
};

export const effectiveSearchKinds = (args: SearchQueryArgs, parsed: ParsedSearchQuery): SearchDocKind[] => {
  const suppliedKinds = args.kinds ?? [];
  const fromArgs = suppliedKinds.filter(isSearchDocKind);
  // A supplied kinds array whose entries are all invalid (e.g. ["termnal"])
  // must not silently broaden into the default all-kind set — mirror the
  // inline `kind:bogus` reject in query() and match nothing instead.
  if (suppliedKinds.length > 0 && fromArgs.length === 0) return [];
  const fromQuery = parsed.kinds;
  if (fromArgs.length > 0 && fromQuery.length > 0) {
    const intersection = fromArgs.filter((kind) => fromQuery.includes(kind));
    return intersection.length > 0 ? intersection : [];
  }
  if (fromArgs.length > 0) return fromArgs;
  if (fromQuery.length > 0) return fromQuery;
  // Linear delegation is opt-in: it can hit the network, so the default
  // kind set excludes it.
  return SEARCH_DOC_KINDS.filter((kind) => kind !== "linear");
};

const docRowToCandidate = (row: DocRow, bm25: number, marked: string | null): SearchCandidate => {
  const fromMarked = marked ? extractSnippetRanges(marked) : null;
  const snippet = fromMarked?.snippet?.trim()
    ? fromMarked.snippet
    : (row.snippet_source ?? "").slice(0, 240);
  return {
    docId: row.doc_id,
    kind: row.kind as SearchDocKind,
    title: row.title,
    rankTitle: row.rank_title ?? "",
    laneId: row.lane_id,
    laneName: row.lane_name,
    sessionId: row.session_id,
    deepLink: row.deep_link,
    updatedAt: row.updated_at,
    bm25,
    snippet,
    matchRanges: fromMarked?.snippet?.trim() ? fromMarked.matchRanges : []
  };
};

export const queryFtsCandidates = (
  all: SearchIndexAll,
  parsed: ParsedSearchQuery,
  kinds: SearchDocKind[],
  laneId: string | null,
  sessionId: string | null,
  scopeChatSessionId: string | null,
  excludeSessionContent: boolean
): { candidates: SearchCandidate[]; totals: Partial<Record<SearchDocKind, number>> } => {
  const ftsKinds = kinds.filter((kind) => FTS_KINDS.includes(kind));
  if (ftsKinds.length === 0) return { candidates: [], totals: {} };

  const kindPlaceholders = ftsKinds.map(() => "?").join(", ");
  const filters: string[] = [`d.kind IN (${kindPlaceholders})`];
  const filterParams: Array<string | number> = [...ftsKinds];
  if (laneId) {
    filters.push("d.lane_id = ?");
    filterParams.push(laneId);
  }
  if (sessionId) {
    filters.push("(d.session_id = ? OR d.owner_session_id = ?)");
    filterParams.push(sessionId, sessionId);
  }
  if (excludeSessionContent) {
    // Internal callers may explicitly request a metadata-only view.
    filters.push("d.kind NOT IN ('chat', 'terminal')");
  } else if (scopeChatSessionId) {
    // Internal callers may deliberately request a one-session view. Public
    // ADE RPC/search routes strip this optional filter so bound agents and
    // unbound shells receive the same project-backed chat results. Terminals
    // owned by the selected chat match via owner_session_id.
    filters.push(
      "(d.kind NOT IN ('chat', 'terminal') OR d.session_id = ? OR d.owner_session_id = ?)"
    );
    filterParams.push(scopeChatSessionId, scopeChatSessionId);
  }
  if (parsed.sinceIso) {
    filters.push("d.updated_at >= ?");
    filterParams.push(parsed.sinceIso);
  }

  const matchExpr = buildFtsMatchExpression(parsed);
  if (!matchExpr) {
    const rows = all<DocRow>(
      `SELECT d.doc_id, d.kind, d.lane_id, d.lane_name, d.session_id, d.title, d.rank_title,
              d.snippet_source, d.deep_link, d.updated_at
       FROM docs d
       WHERE ${filters.join(" AND ")}
       ORDER BY d.updated_at DESC, d.doc_id ASC
       LIMIT ${MATCH_ALL_LIMIT}`,
      filterParams
    );
    const totals: Partial<Record<SearchDocKind, number>> = {};
    const totalRows = all<{ kind: string; n: number }>(
      `SELECT d.kind, COUNT(*) AS n FROM docs d WHERE ${filters.join(" AND ")} GROUP BY d.kind`,
      filterParams
    );
    for (const row of totalRows) totals[row.kind as SearchDocKind] = row.n;
    return { candidates: rows.map((row) => docRowToCandidate(row, 0, null)), totals };
  }

  const candidateSql = `SELECT d.doc_id, d.kind, d.lane_id, d.lane_name, d.session_id, d.title, d.rank_title,
            d.snippet_source, d.deep_link, d.updated_at,
            bm25(docs_fts) AS score,
            snippet(docs_fts, 1, '${SNIPPET_MARK_START}', '${SNIPPET_MARK_END}', '…', 14) AS marked
     FROM docs_fts
     JOIN docs d ON d.id = docs_fts.rowid
     WHERE docs_fts MATCH ? AND ${filters.join(" AND ")}
     ORDER BY score ASC, d.updated_at DESC, d.doc_id ASC
     LIMIT ${FTS_CANDIDATE_LIMIT}`;
  const rows = all<DocRow & { score: number; marked: string }>(candidateSql, [
    matchExpr,
    ...filterParams
  ]);
  // The candidate window above is capped in bm25 order, so on very
  // high-frequency terms a strong TITLE match could fall outside it and
  // never reach the title-tier promotion. Union in a title-scoped candidate
  // set so the specified ranking (exact title > prefix > substring > body)
  // holds regardless of body-match volume.
  if (rows.length === FTS_CANDIDATE_LIMIT) {
    const titleExpr = buildFtsMatchExpression(parsed, { column: "rank_title" });
    if (titleExpr) {
      const seenDocIds = new Set(rows.map((row) => row.doc_id));
      for (const row of all<DocRow & { score: number; marked: string }>(candidateSql, [
        titleExpr,
        ...filterParams
      ])) {
        if (!seenDocIds.has(row.doc_id)) rows.push(row);
      }
    }
  }
  const totals: Partial<Record<SearchDocKind, number>> = {};
  const totalRows = all<{ kind: string; n: number }>(
    `SELECT d.kind, COUNT(*) AS n
     FROM docs_fts
     JOIN docs d ON d.id = docs_fts.rowid
     WHERE docs_fts MATCH ? AND ${filters.join(" AND ")}
     GROUP BY d.kind`,
    [matchExpr, ...filterParams]
  );
  for (const row of totalRows) totals[row.kind as SearchDocKind] = row.n;
  // The title-union above can surface docs the body-match COUNT didn't
  // include; keep totals >= visible candidates per kind so "show more"
  // affordances never under-count.
  const candidateCountByKind = new Map<string, number>();
  for (const row of rows) {
    candidateCountByKind.set(row.kind, (candidateCountByKind.get(row.kind) ?? 0) + 1);
  }
  for (const [kind, count] of candidateCountByKind) {
    const key = kind as SearchDocKind;
    totals[key] = Math.max(totals[key] ?? 0, count);
  }
  return { candidates: rows.map((row) => docRowToCandidate(row, row.score, row.marked)), totals };
};

export type SearchIndexReadOnlyResult = {
  results: SearchResultItem[];
  totalByKind: Partial<Record<SearchDocKind, number>>;
  /** More ranked hits exist than `limit` returned. */
  truncated: boolean;
};

/**
 * Answer a query from a project's index file, without that project's runtime.
 *
 * A search across projects used to load every registered project (database,
 * services, watchers) to ask each one's search service, and one `ade search`
 * on a machine with dozens of projects stalled the brain past its watchdog.
 * The index is a plain SQLite file, so the indexed kinds are read from it
 * directly. Kinds a runtime resolves live (lanes, files, artifacts, Linear)
 * are not in the file and are not answered here.
 *
 * Returns null when the project has no usable index (see
 * `openSearchIndexDbReadOnly`) or the read fails.
 */
export function querySearchIndexReadOnly(args: {
  cacheDir: string;
  query: string;
  kinds?: SearchQueryArgs["kinds"];
  laneId?: string | null;
  limit: number;
  now?: Date;
}): SearchIndexReadOnlyResult | null {
  const index = openSearchIndexDbReadOnly(args.cacheDir);
  if (!index) return null;
  try {
    const parsed = parseSearchQuery(args.query ?? "", { now: args.now ?? new Date() });
    if (parsed.invalidFilters.length > 0) return { results: [], totalByKind: {}, truncated: false };
    const kinds = effectiveSearchKinds({ query: args.query, kinds: args.kinds }, parsed);
    const all: SearchIndexAll = <T,>(sql: string, params: Array<string | number | null> = []) =>
      index.db.prepare(sql).all(...params) as T[];
    // No lane service to resolve a name against: the filter is the id as
    // given, which is also what the live service falls back to.
    const laneId = args.laneId?.trim() || parsed.lane || null;
    const { candidates, totals } = queryFtsCandidates(all, parsed, kinds, laneId, parsed.sessionId, null, false);
    const ranked = rankCandidates(candidates, parsed);
    const limit = Math.max(1, Math.floor(args.limit));
    return {
      results: ranked.slice(0, limit).map((candidate) => ({
        kind: candidate.kind,
        id: candidate.docId,
        title: candidate.title,
        snippet: candidate.snippet,
        matchRanges: candidate.matchRanges,
        laneId: candidate.laneId,
        laneName: candidate.laneName,
        sessionId: candidate.sessionId,
        deepLink: candidate.deepLink,
        updatedAt: candidate.updatedAt
      })),
      totalByKind: totals,
      truncated: ranked.length > limit
    };
  } catch {
    return null;
  } finally {
    index.close();
  }
}
