/**
 * Universal-search seam for the command palette: the debounced backend query
 * (`useUniversalSearch`), the pure highlight/icon/path helpers, and the entity
 * result rows. CommandPalette.tsx keeps the flat-index interleaving,
 * `activateResult`'s kind→navigate switch, and the render loop.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Camera,
  ChatCircle,
  Circle,
  FileText,
  GitCommit,
  GitPullRequest,
  Terminal,
} from "@phosphor-icons/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import type {
  SearchDocKind,
  SearchMatchRange,
  SearchResultItem,
} from "../../../shared/types/search";
import { parseDeeplink } from "../../../shared/deeplinks";
import { relativeTimeCompact } from "../../lib/format";
import { cn } from "../ui/cn";

// Debounce before hitting the universal search backend as the user types.
const SEARCH_DEBOUNCE_MS = 150;
// Rows rendered per entity section before a "Show N more" affordance appears.
export const ENTITY_SECTION_PREVIEW = 5;
// Batch of results requested per query; enough to fill several sections at once.
const SEARCH_QUERY_LIMIT = 60;

// Section order + labels for typed entity results, matching the task spec.
const ENTITY_KIND_ORDER: SearchDocKind[] = [
  "chat",
  "terminal",
  "pr",
  "lane",
  "commit",
  "branch",
  "file",
  "linear",
  "artifact",
];

const ENTITY_KIND_LABEL: Record<SearchDocKind, string> = {
  chat: "Chats",
  terminal: "Terminals",
  pr: "PRs",
  lane: "Lanes",
  commit: "Commits",
  branch: "Branches",
  file: "Files",
  linear: "Issues",
  artifact: "Artifacts",
};

function KindIcon({ kind }: { kind: SearchDocKind }) {
  const className = "shrink-0 text-[var(--color-muted-fg)]";
  switch (kind) {
    case "chat":
      return <ChatCircle size={15} weight="regular" className={className} />;
    case "terminal":
      return <Terminal size={15} weight="regular" className={className} />;
    case "pr":
      return <GitPullRequest size={15} weight="regular" className={className} />;
    case "lane":
      return <LaneIcon size={14} weight="bold" className={className} />;
    case "commit":
      return <GitCommit size={15} weight="regular" className={className} />;
    case "branch":
      return <BranchIcon size={14} weight="bold" className={className} />;
    case "file":
      return <FileText size={15} weight="regular" className={className} />;
    case "linear":
      return <Circle size={13} weight="bold" className={className} />;
    case "artifact":
      return <Camera size={15} weight="regular" className={className} />;
    default:
      return <Circle size={13} weight="bold" className={className} />;
  }
}

// Bold the first case-insensitive substring hit of the query inside a title.
export function highlightTitle(
  title: string,
  query: string,
): React.ReactNode {
  const needle = query.trim();
  if (!needle) return title;
  const idx = title.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return title;
  return (
    <>
      {title.slice(0, idx)}
      <span className="font-semibold text-[var(--color-fg)]">
        {title.slice(idx, idx + needle.length)}
      </span>
      {title.slice(idx + needle.length)}
    </>
  );
}

// Accent the backend-provided match offsets inside a snippet (no heavy box).
export function highlightRanges(
  snippet: string,
  ranges: SearchMatchRange[],
): React.ReactNode {
  if (!ranges || ranges.length === 0) return snippet;
  const sorted = ranges
    .filter((range) => range.end > range.start && range.start >= 0)
    .slice()
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return snippet;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((range, i) => {
    const start = Math.max(cursor, Math.min(range.start, snippet.length));
    const end = Math.max(start, Math.min(range.end, snippet.length));
    if (start > cursor) nodes.push(snippet.slice(cursor, start));
    if (end > start) {
      nodes.push(
        <span key={i} className="text-[var(--color-accent)]">
          {snippet.slice(start, end)}
        </span>,
      );
    }
    cursor = end;
  });
  if (cursor < snippet.length) nodes.push(snippet.slice(cursor));
  return nodes;
}

// Recover the repo-relative file path (+ optional line anchor) from a `file`
// result's deepLink (falling back to its doc id, which is `file:<path>` or
// `file:<path>:<line>`).
export function relativeFilePathForResult(
  item: SearchResultItem,
): { path: string; line: number | null } | null {
  const parsed = parseDeeplink(item.deepLink);
  if (parsed.ok && parsed.target.kind === "file") {
    return { path: parsed.target.path, line: parsed.target.line ?? null };
  }
  let rest = item.id.startsWith("file:") ? item.id.slice(5) : item.id;
  const lineMatch = rest.match(/:(\d+)$/);
  rest = rest.replace(/:\d+$/, "");
  return rest.length > 0
    ? { path: rest, line: lineMatch ? Number(lineMatch[1]) : null }
    : null;
}

export type EntitySection = {
  kind: SearchDocKind;
  label: string;
  rows: SearchResultItem[];
  total: number;
};

export type FlatEntity =
  | { type: "result"; item: SearchResultItem }
  | { type: "showMore"; kind: SearchDocKind; hiddenCount: number };

export const SearchResultRow = React.memo(function SearchResultRow({
  item,
  query,
  index,
  isSelected,
  onHover,
  onActivate,
}: {
  item: SearchResultItem;
  query: string;
  index: number;
  isSelected: boolean;
  onHover: (index: number) => void;
  onActivate: (item: SearchResultItem) => void;
}) {
  const time = relativeTimeCompact(item.updatedAt);
  const snippet = item.snippet?.trim() ? item.snippet : "";
  return (
    <li>
      <button
        type="button"
        data-cmd-item
        className={cn(
          "mx-2 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left transition-colors",
          isSelected
            ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]"
            : "border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-muted)]",
        )}
        onMouseEnter={() => onHover(index)}
        onClick={() => onActivate(item)}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <KindIcon kind={item.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-[var(--color-fg)]">
            {highlightTitle(item.title, query)}
          </div>
          {snippet ? (
            <div className="mt-0.5 truncate text-xs text-[var(--color-muted-fg)]">
              {highlightRanges(snippet, item.matchRanges)}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.laneName ? (
            <span className="max-w-[140px] truncate rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted-fg)]">
              {item.laneName}
            </span>
          ) : null}
          {time ? (
            <span className="text-[10px] tabular-nums text-[var(--color-muted-fg)]">
              {time}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  );
});

export function ShowMoreRow({
  kind,
  hiddenCount,
  index,
  isSelected,
  onHover,
  onToggle,
}: {
  kind: SearchDocKind;
  hiddenCount: number;
  index: number;
  isSelected: boolean;
  onHover: (index: number) => void;
  onToggle: (kind: SearchDocKind) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-cmd-item
        className={cn(
          "mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors",
          isSelected
            ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)] text-[var(--color-fg)]"
            : "border-transparent text-[var(--color-muted-fg)] hover:border-[var(--color-border)] hover:bg-[var(--color-muted)]",
        )}
        onMouseEnter={() => onHover(index)}
        onClick={() => onToggle(kind)}
      >
        Show {hiddenCount} more
      </button>
    </li>
  );
}

export type UseUniversalSearchResult = {
  loading: boolean;
  sections: EntitySection[];
  flatEntities: FlatEntity[];
  expandedKinds: Set<SearchDocKind>;
  toggleExpandKind: (kind: SearchDocKind) => void;
};

export type UseUniversalSearchOptions = {
  /**
   * Session ids already rendered by the palette's local "Recent threads" group.
   * A thread that matches on its title almost always matches on its content
   * too, so without this the same chat appears twice — once instantly from the
   * local index, once again a beat later under "Chats". Excluding them here
   * (rather than at the render site) keeps `flatEntities` the single source of
   * truth for the keyboard index.
   */
  excludeSessionIds?: ReadonlySet<string>;
};

/**
 * Owns the debounced `window.ade.search.query` call, its generation guard,
 * loading state, kind-grouped sections, and the expand-per-kind state. `query`
 * is the already-trimmed needle; `enabled` gates the fetch (false in project-*
 * modes or with no active project). Returns empty sections when disabled.
 */
export function useUniversalSearch(
  query: string,
  enabled: boolean,
  options: UseUniversalSearchOptions = {},
): UseUniversalSearchResult {
  const excludeSessionIds = options.excludeSessionIds;
  const [results, setResults] = useState<SearchResultItem[] | null>(null);
  const [totalByKind, setTotalByKind] = useState<
    Partial<Record<SearchDocKind, number>>
  >({});
  const [loading, setLoading] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<Set<SearchDocKind>>(
    () => new Set(),
  );
  // Monotonic generation guard so a slow search response can never overwrite the
  // results of a newer query.
  const requestRef = useRef(0);

  // Collapse every section whenever the query changes (including on close, when
  // the caller resets the query to ""), matching a fresh search.
  useEffect(() => {
    setExpandedKinds(new Set());
  }, [query]);

  // Debounced universal entity search. Generation-guarded so stale responses
  // never clobber newer ones, and previously-rendered results stay visible
  // while a fresh query is in flight (we only clear on an empty/disabled query).
  useEffect(() => {
    if (!enabled) {
      requestRef.current += 1;
      setResults(null);
      setTotalByKind({});
      setLoading(false);
      return;
    }
    const queryApi = window.ade.search?.query;
    if (!queryApi) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    const timeout = globalThis.setTimeout(() => {
      void Promise.resolve()
        .then(() => queryApi({ query, limit: SEARCH_QUERY_LIMIT }))
        .then((result) => {
          if (requestRef.current !== requestId) return;
          setResults(result.results);
          setTotalByKind(result.totalByKind);
          setLoading(false);
        })
        .catch(() => {
          if (requestRef.current !== requestId) return;
          // Keep the last results rather than blanking the surface on error.
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [enabled, query]);

  // Group results by kind (preserving backend order within each kind) into the
  // fixed section order, carrying the pre-limit total for the "show more" copy.
  const sections = useMemo<EntitySection[]>(() => {
    if (!results || results.length === 0) return [];
    const byKind = new Map<SearchDocKind, SearchResultItem[]>();
    // Count what the exclusion removed per kind so each section's "show N more"
    // total stays honest against the rows actually rendered.
    const excludedByKind = new Map<SearchDocKind, number>();
    for (const item of results) {
      if (
        excludeSessionIds &&
        item.sessionId &&
        excludeSessionIds.has(item.sessionId)
      ) {
        excludedByKind.set(item.kind, (excludedByKind.get(item.kind) ?? 0) + 1);
        continue;
      }
      const bucket = byKind.get(item.kind);
      if (bucket) bucket.push(item);
      else byKind.set(item.kind, [item]);
    }
    const next: EntitySection[] = [];
    for (const kind of ENTITY_KIND_ORDER) {
      const rows = byKind.get(kind);
      if (!rows || rows.length === 0) continue;
      const reportedTotal = totalByKind[kind] ?? rows.length;
      next.push({
        kind,
        label: ENTITY_KIND_LABEL[kind],
        rows,
        total: Math.max(rows.length, reportedTotal - (excludedByKind.get(kind) ?? 0)),
      });
    }
    return next;
  }, [excludeSessionIds, results, totalByKind]);

  // Flattened, keyboard-navigable sequence of entity rows + show-more rows,
  // continuing after the command items in the shared flat index.
  const flatEntities = useMemo<FlatEntity[]>(() => {
    const out: FlatEntity[] = [];
    for (const section of sections) {
      const expanded = expandedKinds.has(section.kind);
      const visible = expanded
        ? section.rows
        : section.rows.slice(0, ENTITY_SECTION_PREVIEW);
      for (const item of visible) out.push({ type: "result", item });
      if (!expanded && section.rows.length > ENTITY_SECTION_PREVIEW) {
        out.push({
          type: "showMore",
          kind: section.kind,
          // Expanding only reveals already-fetched rows, so never promise more
          // than the fetched page actually holds for this kind.
          hiddenCount: Math.min(
            section.total - ENTITY_SECTION_PREVIEW,
            section.rows.length - ENTITY_SECTION_PREVIEW,
          ),
        });
      }
    }
    return out;
  }, [sections, expandedKinds]);

  const toggleExpandKind = useCallback((kind: SearchDocKind) => {
    setExpandedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  return { loading, sections, flatEntities, expandedKinds, toggleExpandKind };
}
