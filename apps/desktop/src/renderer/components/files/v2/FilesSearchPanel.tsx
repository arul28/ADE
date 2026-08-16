import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight, CheckSquare, MagnifyingGlass, Square, X } from "@phosphor-icons/react";
import type { FilesQuickOpenItem, FilesSearchTextMatch } from "../../../../shared/types";
import type { OpenProjectBinding } from "../../../../shared/types/core";
import { normalizePath } from "../../../lib/pathUtils";
import { COLORS, MONO_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { getFileIcon } from "../filePresentation";

/** File names come from an in-memory index, so they can land almost immediately. */
const NAME_DEBOUNCE_MS = 120;
/** Contents are read off disk; wait a little longer so typing does not thrash it. */
const CONTENT_DEBOUNCE_MS = 250;
const NAME_LIMIT = 30;
const CONTENT_LIMIT = 300;

export const SEARCH_PANEL_SURFACE: React.CSSProperties = {
  background: COLORS.cardBgSolid,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 12,
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
};

/** Shared dimmed backdrop for the centred Files modals. */
export function Backdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * "Include ignored files" preference
 * ------------------------------------------------------------------ */

/**
 * One key, not one per workspace.
 *
 * "Do I want ignored files in my results" is a preference about how the user
 * searches, not a property of a lane — and a per-workspace key wrote a new
 * localStorage entry for every lane ever searched, with nothing pruning them
 * when the lane was archived.
 */
const INCLUDE_IGNORED_KEY = "ade.files.search.includeIgnored";
let includeIgnoredCached: boolean | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getFilesSearchIncludeIgnored(): boolean {
  if (includeIgnoredCached != null) return includeIgnoredCached;
  includeIgnoredCached = (storage()?.getItem(INCLUDE_IGNORED_KEY) ?? null) === "1";
  return includeIgnoredCached;
}

export function setFilesSearchIncludeIgnored(value: boolean): void {
  includeIgnoredCached = value;
  try {
    storage()?.setItem(INCLUDE_IGNORED_KEY, value ? "1" : "0");
  } catch {
    // Best-effort: quota/private-mode failures must not break search.
  }
}

/** Test seam: drop the in-memory copy so a fresh mount re-reads storage. */
export function resetFilesSearchPreferencesForTests(): void {
  includeIgnoredCached = null;
}

/* ------------------------------------------------------------------ *
 * Search plumbing
 * ------------------------------------------------------------------ */

type FileMatchGroup = { path: string; matches: FilesSearchTextMatch[] };

/** A flat, keyboard-navigable item: either open a file, or jump to a content line. */
type FlatItem = { kind: "file"; path: string } | { kind: "line"; path: string; line: number };

type NameState = { key: string; items: FilesQuickOpenItem[] };
type ContentState = { key: string; groups: FileMatchGroup[] };

function baseName(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) || normalized : normalized;
}

function groupMatches(matches: FilesSearchTextMatch[]): FileMatchGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, FilesSearchTextMatch[]>();
  for (const match of matches) {
    let bucket = byPath.get(match.path);
    if (!bucket) {
      bucket = [];
      byPath.set(match.path, bucket);
      order.push(match.path);
    }
    bucket.push(match);
  }
  return order.map((path) => ({ path, matches: byPath.get(path) ?? [] }));
}

export type FilesSearchPanelProps = {
  workspaceId: string;
  /**
   * Machine that owns this workspace. Forwarded verbatim as the `pin` argument
   * on every window.ade.files.* call. Undefined/null = the machine this project
   * tab is bound to (today's behavior).
   */
  pin?: OpenProjectBinding | null;
  query: string;
  onQueryChange: (next: string) => void;
  /** Open a result. `line` is 1-based when the hit came from file contents. */
  onOpen: (path: string, line?: number) => void;
  /** User dismissed search (Escape, or cleared the query). */
  onDismiss: () => void;
  /** "sidebar" renders inside the explorer column; "overlay" renders the centered modal. */
  variant: "sidebar" | "overlay";
};

/**
 * The one Files search surface. Names and contents are two independent
 * requests: names land first (short debounce, in-memory index) and render
 * immediately; contents fill in behind them and never clear what is already
 * on screen.
 */
export function FilesSearchPanel({
  workspaceId,
  pin,
  query,
  onQueryChange,
  onOpen,
  onDismiss,
  variant,
}: FilesSearchPanelProps) {
  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;

  const [includeIgnored, setIncludeIgnored] = useState(() => getFilesSearchIncludeIgnored());
  const [names, setNames] = useState<NameState>({ key: "", items: [] });
  const [contents, setContents] = useState<ContentState>({ key: "", groups: [] });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLElement | null>(null);
  // `pin` is an object prop; reading it through a ref keeps the request effects
  // from re-firing when the caller hands us a new-but-equivalent binding.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin ? `${pin.kind}:${pin.key}` : "";

  // Identity of the answer we want on screen. Results carrying a different key
  // are stale, which is also how "still searching" is derived.
  const searchKey = hasQuery ? JSON.stringify([workspaceId, includeIgnored, trimmed]) : "";

  useEffect(() => {
    if (!searchKey) {
      setNames({ key: "", items: [] });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      window.ade.files
        .quickOpen({ workspaceId, query: trimmed, limit: NAME_LIMIT, includeIgnored }, pinRef.current)
        .then((items) => {
          if (!cancelled) setNames({ key: searchKey, items });
        })
        .catch(() => {
          if (!cancelled) setNames({ key: searchKey, items: [] });
        });
    }, NAME_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `searchKey` already encodes workspaceId / includeIgnored / trimmed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, pinKey]);

  useEffect(() => {
    if (!searchKey) {
      setContents({ key: "", groups: [] });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      window.ade.files
        .searchText({ workspaceId, query: trimmed, limit: CONTENT_LIMIT, includeIgnored }, pinRef.current)
        .then((matches) => {
          if (!cancelled) setContents({ key: searchKey, groups: groupMatches(matches) });
        })
        .catch(() => {
          if (!cancelled) setContents({ key: searchKey, groups: [] });
        });
    }, CONTENT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, pinKey]);

  useEffect(() => {
    setCollapsed(new Set());
    setActive(0);
  }, [searchKey]);

  // Results whose key no longer matches are left on screen (no flicker) but do
  // not count as an answer to the current query.
  const nameItems = names.items;
  const contentGroups = contents.groups;
  const namesPending = hasQuery && names.key !== searchKey;
  const contentsPending = hasQuery && contents.key !== searchKey;

  const flat = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = nameItems.map((item) => ({ kind: "file", path: item.path }));
    for (const group of contentGroups) {
      if (collapsed.has(group.path)) continue;
      for (const match of group.matches) items.push({ kind: "line", path: group.path, line: match.line });
    }
    return items;
  }, [nameItems, contentGroups, collapsed]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const dismiss = useCallback(() => {
    onQueryChange("");
    onDismiss();
  }, [onQueryChange, onDismiss]);

  const openItem = useCallback(
    (item: FlatItem | undefined) => {
      if (!item) return;
      if (item.kind === "file") onOpen(item.path);
      else onOpen(item.path, item.line);
      // The modal is a one-shot pick; the sidebar keeps results so several hits
      // can be opened in a row.
      if (variant === "overlay") onDismiss();
    },
    [onOpen, onDismiss, variant],
  );

  // The sidebar's search field lives in the explorer header, outside this
  // component, so keyboard handling is read from a ref-backed snapshot instead
  // of re-subscribing a listener on every keystroke.
  const latest = useRef({ flat, active, openItem, dismiss });
  latest.current = { flat, active, openItem, dismiss };

  const handleKey = useCallback((key: string): boolean => {
    const { flat: rows, active: index, openItem: open, dismiss: close } = latest.current;
    if (key === "ArrowDown") {
      setActive((current) => Math.min(rows.length - 1, current + 1));
      return true;
    }
    if (key === "ArrowUp") {
      setActive((current) => Math.max(0, current - 1));
      return true;
    }
    if (key === "Enter") {
      open(rows[index]);
      return true;
    }
    if (key === "Escape") {
      close();
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (variant !== "sidebar" || !hasQuery) return;
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const fromPanel = target != null && panelRef.current?.contains(target) === true;
      const fromField = target?.dataset?.filesSearchField === "1";
      if (!fromPanel && !fromField) return;
      if (handleKey(event.key)) event.preventDefault();
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [variant, hasQuery, handleKey]);

  useEffect(() => {
    if (variant !== "overlay") return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [variant]);

  const toggleIgnored = () => {
    const next = !includeIgnored;
    setFilesSearchIncludeIgnored(next);
    setIncludeIgnored(next);
  };

  const toggleGroup = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const contentCount = contentGroups.reduce((total, group) => total + group.matches.length, 0);
  // Progress is reported by the results body ("Searching…" / "No matches"), so
  // the toolbar only ever carries counts.
  const summary = hasQuery && (nameItems.length > 0 || contentCount > 0)
    ? `${nameItems.length} files · ${contentCount} in text`
    : "";

  // Running index mirroring the flattened nav order so highlight + keyboard agree.
  let flatCursor = 0;

  const toolbar = (
    <div
      className="flex shrink-0 items-center gap-2 px-2.5 py-1.5"
      style={{ borderBottom: `1px solid ${COLORS.border}` }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={includeIgnored}
        aria-label="Include ignored files"
        onClick={toggleIgnored}
        style={{
          ...outlineButton({ height: 22, padding: "0 7px", fontSize: 10, gap: 5 }),
          color: includeIgnored ? COLORS.accent : COLORS.textMuted,
          borderColor: includeIgnored ? COLORS.accentBorder : COLORS.outlineBorder,
        }}
      >
        {includeIgnored ? <CheckSquare size={12} weight="fill" /> : <Square size={12} />}
        Include ignored files
      </button>
      <span className="ml-auto shrink-0 truncate text-[10px] tabular-nums" style={{ color: COLORS.textDim }}>
        {summary}
      </span>
      {variant === "sidebar" ? (
        <button
          type="button"
          aria-label="Close search"
          title="Back to files"
          onClick={dismiss}
          style={{
            display: "inline-flex",
            width: 20,
            height: 20,
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            color: COLORS.textMuted,
            cursor: "pointer",
          }}
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );

  const results = !hasQuery ? (
    <div className="px-3 py-3 text-xs" style={{ color: COLORS.textDim }}>
      Search this workspace by file name and by what is inside the files.
    </div>
  ) : nameItems.length === 0 && contentGroups.length === 0 ? (
    <div className="px-3 py-3 text-xs" style={{ color: COLORS.textDim }}>
      {namesPending || contentsPending ? "Searching…" : "No matches"}
    </div>
  ) : (
    <>
      {nameItems.length > 0 ? (
        <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wide" style={{ color: COLORS.textDim }}>
          Files
        </div>
      ) : null}
      {nameItems.map((item) => {
        const index = flatCursor++;
        const name = baseName(item.path);
        const { icon: Icon, color } = getFileIcon(name);
        const isActive = index === active;
        return (
          <button
            key={`file:${item.path}`}
            ref={isActive ? (node) => { activeRowRef.current = node; } : undefined}
            type="button"
            onMouseEnter={() => setActive(index)}
            onClick={() => openItem({ kind: "file", path: item.path })}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
            style={{ background: isActive ? COLORS.accentSubtle : "transparent" }}
          >
            <Icon size={14} color={color} />
            <span className="shrink-0" style={{ color: COLORS.textPrimary }}>{name}</span>
            <span className="ml-auto truncate pl-3" style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10 }}>
              {item.path}
            </span>
          </button>
        );
      })}

      {contentGroups.map((group) => {
        const isCollapsed = collapsed.has(group.path);
        const name = baseName(group.path);
        const { icon: Icon, color } = getFileIcon(name);
        return (
          <div key={`grp:${group.path}`}>
            <button
              type="button"
              onClick={() => toggleGroup(group.path)}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs"
              style={{ color: COLORS.textSecondary }}
            >
              {isCollapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
              <Icon size={13} color={color} />
              <span className="truncate" style={{ color: COLORS.textPrimary }}>{name}</span>
              <span className="truncate pl-1 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                {group.path}
              </span>
              <span
                className="ml-auto rounded px-1.5 text-[10px]"
                style={{ background: COLORS.recessedBg, color: COLORS.textDim }}
              >
                {group.matches.length}
              </span>
            </button>
            {isCollapsed
              ? null
              : group.matches.map((match, i) => {
                const index = flatCursor++;
                const isActive = index === active;
                return (
                  <button
                    key={`m:${group.path}:${match.line}:${match.column}:${i}`}
                    ref={isActive ? (node) => { activeRowRef.current = node; } : undefined}
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => openItem({ kind: "line", path: group.path, line: match.line })}
                    className="flex w-full items-center gap-2 py-1 pl-8 pr-3 text-left text-[11px]"
                    style={{ background: isActive ? COLORS.accentSubtle : "transparent" }}
                  >
                    <span className="shrink-0 tabular-nums" style={{ color: COLORS.textDim, minWidth: 28 }}>
                      {match.line}
                    </span>
                    <span className="truncate" style={{ color: COLORS.textMuted }}>{match.preview}</span>
                  </button>
                );
              })}
          </div>
        );
      })}

      {contentsPending ? (
        <div className="px-3 py-2 text-[11px]" style={{ color: COLORS.textDim }}>
          Searching inside files…
        </div>
      ) : null}
    </>
  );

  if (variant === "sidebar") {
    // Keys are handled by the document listener above (the search field lives in
    // the explorer header, outside this subtree), so there is no onKeyDown here.
    return (
      <div ref={panelRef} className="flex h-full min-h-0 flex-col" data-testid="files-search-panel">
        {toolbar}
        <div className="min-h-0 flex-1 overflow-auto py-1">{results}</div>
      </div>
    );
  }

  return (
    <Backdrop onClose={onDismiss}>
      <div
        ref={panelRef}
        data-testid="files-search-panel"
        style={{ ...SEARCH_PANEL_SURFACE, width: 720, maxWidth: "92%" }}
        onKeyDown={(event) => {
          if (handleKey(event.key)) event.preventDefault();
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <MagnifyingGlass size={16} color={COLORS.accent} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search files by name or text…"
            aria-label="Search files"
            data-files-search-field="1"
            className="w-full bg-transparent text-sm outline-none"
            style={{ color: COLORS.textPrimary }}
          />
        </div>
        {toolbar}
        <div className="max-h-[60vh] overflow-auto py-1">{results}</div>
      </div>
    </Backdrop>
  );
}
