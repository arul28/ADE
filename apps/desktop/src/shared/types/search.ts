/**
 * Universal search types shared between the main-process search service, the
 * ADE action bridge (`search.*` domain), the desktop command palette, the
 * `ade search` CLI, and the TUI search palette.
 */

export const SEARCH_DOC_KINDS = [
  "lane",
  "chat",
  "terminal",
  "pr",
  "commit",
  "branch",
  "file",
  "linear",
  "artifact"
] as const;

export type SearchDocKind = (typeof SEARCH_DOC_KINDS)[number];

export function isSearchDocKind(value: unknown): value is SearchDocKind {
  return typeof value === "string" && (SEARCH_DOC_KINDS as readonly string[]).includes(value);
}

/** Half-open [start, end) character range inside `snippet`. */
export type SearchMatchRange = {
  start: number;
  end: number;
};

export type SearchResultItem = {
  kind: SearchDocKind;
  /** Stable document id, e.g. `chat:<sessionId>:<eventId>` or `pr:<number>`. */
  id: string;
  title: string;
  snippet: string;
  /** Match offsets inside `snippet` (may be empty when only the title matched). */
  matchRanges: SearchMatchRange[];
  laneId: string | null;
  laneName: string | null;
  /** Owning `terminal_sessions` row for chat/terminal results. */
  sessionId: string | null;
  /**
   * In-app navigation target, e.g. `ade://work/session/<id>?offset=123` or
   * `ade://prs/<number>`. Clients map this onto their own navigation.
   */
  deepLink: string;
  /** ISO timestamp used for the deterministic recency tie-break. */
  updatedAt: string;
  /** Present when the machine router combines chat hits across projects. */
  projectId?: string;
  projectName?: string;
  projectRoot?: string;
};

export type SearchQueryArgs = {
  query: string;
  kinds?: SearchDocKind[];
  laneId?: string;
  limit?: number;
  /** Opaque pagination cursor returned by a previous query. */
  cursor?: string;
  /** Legacy internal filter retained for direct search-service consumers.
   * Public ADE RPC callers cannot set it; the machine router searches
   * project-backed chats across every registered project. */
  callerScope?: { chatSessionId?: string | null; excludeSessionContent?: boolean };
};

export type SearchQueryResult = {
  results: SearchResultItem[];
  /** Total matched docs per kind (pre-limit), for "show more" affordances. */
  totalByKind: Partial<Record<SearchDocKind, number>>;
  nextCursor: string | null;
  /** Registered project scopes consulted for machine-wide chat discovery. */
  projectsSearched?: number;
  projectsUnavailable?: string[];
  /** True when one or more project result sets exceeded the router's bounded page cap. */
  resultsTruncated?: boolean;
};

export type SearchIndexStatus = {
  ready: boolean;
  schemaVersion: number;
  docCount: number;
  docCountByKind: Partial<Record<SearchDocKind, number>>;
  /** Sources still queued for (re)indexing. */
  pendingSources: number;
  backfillComplete: boolean;
  lastUpdatedAt: string | null;
  indexPath: string;
};

export type SearchRebuildResult = {
  started: boolean;
};
