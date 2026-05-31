import React, { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import type { FilesQuickOpenItem, FilesSearchTextMatch } from "../../../../shared/types";
import { COLORS } from "../../lanes/laneDesignTokens";
import { getFileIcon } from "../filePresentation";

const PANEL: React.CSSProperties = {
  background: COLORS.cardBgSolid,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 12,
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
};

function Backdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
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

type FileMatchGroup = { path: string; matches: FilesSearchTextMatch[] };

/** A flat, keyboard-navigable item: either open a file, or jump to a content line. */
type FlatItem = { kind: "file"; path: string } | { kind: "line"; path: string; line: number };

/**
 * Unified in-depth search (replaces the old separate Quick Open + Content Search).
 * Searches file names AND file contents, grouping content hits by file with line
 * previews, VSCode-style. Opening a content hit reveals the matched line.
 */
export function SearchOverlay({
  workspaceId,
  initialQuery = "",
  onClose,
  onOpen,
}: {
  workspaceId: string;
  initialQuery?: string;
  onClose: () => void;
  onOpen: (path: string, line?: number) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [files, setFiles] = useState<FilesQuickOpenItem[]>([]);
  const [contentGroups, setContentGroups] = useState<FileMatchGroup[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFiles([]);
      setContentGroups([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      Promise.all([
        window.ade.files.quickOpen({ workspaceId, query: q, limit: 30, includeIgnored: true }).catch(() => []),
        window.ade.files.searchText({ workspaceId, query: q, limit: 300, includeIgnored: true }).catch(() => []),
      ])
        .then(([fileItems, contentMatches]) => {
          if (cancelled) return;
          setFiles(fileItems);
          // Group content matches by file, preserving first-seen order.
          const order: string[] = [];
          const byPath = new Map<string, FilesSearchTextMatch[]>();
          for (const m of contentMatches) {
            if (!byPath.has(m.path)) {
              byPath.set(m.path, []);
              order.push(m.path);
            }
            byPath.get(m.path)!.push(m);
          }
          setContentGroups(order.map((path) => ({ path, matches: byPath.get(path)! })));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, workspaceId]);

  // Flatten the visible results for keyboard navigation.
  const flat = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = files.map((f) => ({ kind: "file", path: f.path }));
    for (const group of contentGroups) {
      if (collapsed.has(group.path)) continue;
      for (const m of group.matches) items.push({ kind: "line", path: group.path, line: m.line });
    }
    return items;
  }, [files, contentGroups, collapsed]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  const totalContent = contentGroups.reduce((n, g) => n + g.matches.length, 0);

  const openItem = (item: FlatItem | undefined) => {
    if (!item) return;
    if (item.kind === "file") onOpen(item.path);
    else onOpen(item.path, item.line);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openItem(flat[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const toggleGroup = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Running index that mirrors the flattened nav order so highlight + keyboard agree.
  let flatCursor = 0;

  return (
    <Backdrop onClose={onClose}>
      <div style={{ ...PANEL, width: 720, maxWidth: "92%" }} onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <MagnifyingGlass size={16} color={COLORS.accent} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files by name or content…"
            className="w-full bg-transparent text-sm outline-none"
            style={{ color: COLORS.textPrimary }}
          />
          <span className="shrink-0 text-xs tabular-nums" style={{ color: COLORS.textDim }}>
            {searching ? "…" : query.trim() ? `${files.length} files · ${totalContent} matches` : ""}
          </span>
        </div>

        <div className="max-h-[60vh] overflow-auto py-1">
          {!query.trim() ? (
            <div className="px-3 py-3 text-xs" style={{ color: COLORS.textDim }}>
              Search across the workspace by file name and contents.
            </div>
          ) : files.length === 0 && contentGroups.length === 0 ? (
            <div className="px-3 py-3 text-xs" style={{ color: COLORS.textDim }}>
              {searching ? "Searching…" : "No results"}
            </div>
          ) : (
            <>
              {files.length > 0 ? (
                <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wide" style={{ color: COLORS.textDim }}>
                  Files
                </div>
              ) : null}
              {files.map((f) => {
                const idx = flatCursor++;
                const name = f.path.split("/").pop() ?? f.path;
                const { icon: Icon, color } = getFileIcon(name);
                return (
                  <button
                    key={`file:${f.path}`}
                    type="button"
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => openItem({ kind: "file", path: f.path })}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
                    style={{ background: idx === active ? COLORS.accentSubtle : "transparent" }}
                  >
                    <Icon size={14} color={color} />
                    <span style={{ color: COLORS.textPrimary }}>{name}</span>
                    <span className="ml-auto truncate pl-3" style={{ color: COLORS.textDim }}>{f.path}</span>
                  </button>
                );
              })}

              {contentGroups.map((group) => {
                const isCollapsed = collapsed.has(group.path);
                const name = group.path.split("/").pop() ?? group.path;
                const { icon: Icon, color } = getFileIcon(name);
                return (
                  <div key={`grp:${group.path}`}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.path)}
                      className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs"
                      style={{ color: COLORS.textSecondary }}
                    >
                      {isCollapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
                      <Icon size={13} color={color} />
                      <span className="truncate" style={{ color: COLORS.textPrimary }}>{name}</span>
                      <span className="truncate pl-1 text-[10px]" style={{ color: COLORS.textDim }}>{group.path}</span>
                      <span className="ml-auto rounded px-1.5 text-[10px]" style={{ background: COLORS.recessedBg, color: COLORS.textDim }}>{group.matches.length}</span>
                    </button>
                    {isCollapsed
                      ? null
                      : group.matches.map((m, i) => {
                          const idx = flatCursor++;
                          return (
                            <button
                              key={`m:${group.path}:${m.line}:${m.column}:${i}`}
                              type="button"
                              onMouseEnter={() => setActive(idx)}
                              onClick={() => openItem({ kind: "line", path: group.path, line: m.line })}
                              className="flex w-full items-center gap-2 py-1 pl-8 pr-3 text-left text-[11px]"
                              style={{ background: idx === active ? COLORS.accentSubtle : "transparent" }}
                            >
                              <span className="shrink-0 tabular-nums" style={{ color: COLORS.textDim, minWidth: 28 }}>{m.line}</span>
                              <span className="truncate font-mono" style={{ color: COLORS.textMuted }}>{m.preview}</span>
                            </button>
                          );
                        })}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </Backdrop>
  );
}

export type PromptKind = "file" | "directory";

/** Inline name prompt for creating a file or folder (Electron blocks window.prompt). */
export function CreatePromptModal({
  kind,
  baseDir,
  onClose,
  onSubmit,
}: {
  kind: PromptKind;
  baseDir: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const error = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (/[\\/]/.test(trimmed) || trimmed === "." || trimmed === "..") return "Invalid name";
    return null;
  }, [name]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || error) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Backdrop onClose={onClose}>
      <div style={{ ...PANEL, width: 420, maxWidth: "90%" }}>
        <div className="px-3 py-2 text-xs" style={{ borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
          New {kind === "file" ? "file" : "folder"}{baseDir ? ` in ${baseDir}/` : " in workspace root"}
        </div>
        <div className="p-3">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={kind === "file" ? "name.ext" : "folder-name"}
            className="w-full rounded border bg-transparent px-2 py-1 text-sm outline-none"
            style={{ borderColor: error ? COLORS.danger : COLORS.outlineBorder, color: COLORS.textPrimary }}
          />
          {error ? <div className="mt-1 text-xs" style={{ color: COLORS.danger }}>{error}</div> : null}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1 text-xs" style={{ color: COLORS.textMuted }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim() || !!error}
              className="rounded px-3 py-1 text-xs disabled:opacity-40"
              style={{ background: COLORS.accent, color: "var(--color-accent-fg)" }}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </Backdrop>
  );
}
