import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  FolderOpen,
  FolderSimple,
} from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { cn } from "../ui/cn";

/**
 * A shared changed-file tree for diff surfaces.
 *
 * The flat accordion is fine for a handful of files and painful for a
 * multi-directory change. This component renders the same path list as a
 * navigable tree, used by the PR Files tab (and, via this shared module, any
 * other diff surface that wants it).
 *
 * Two invariants make it usable while an agent keeps editing:
 *  - Folders are open by default; only explicit collapses are stored.
 *  - When the file list changes, folder state is *pruned*, never reset, so a
 *    refresh keeps the folders the reader opened or closed. Expanding or
 *    collapsing folders is independent from expanding individual file diffs.
 */

export type DiffFileTreeStatus =
  | "added"
  | "removed"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export type DiffFileTreeEntry = {
  /** Repo-relative path. Backslashes are normalized to `/`. */
  path: string;
  status?: DiffFileTreeStatus | string | null;
  previousPath?: string | null;
  additions?: number;
  deletions?: number;
};

export type DiffFileTreeFolder = {
  kind: "folder";
  name: string;
  path: string;
  children: DiffFileTreeItem[];
};

export type DiffFileTreeLeaf = {
  kind: "file";
  name: string;
  path: string;
  entry: DiffFileTreeEntry;
};

export type DiffFileTreeItem = DiffFileTreeFolder | DiffFileTreeLeaf;

const STATUS_MARK: Record<string, string> = {
  added: "A",
  removed: "D",
  deleted: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
  changed: "M",
  unchanged: "M",
};

const STATUS_COLOR: Record<string, string> = {
  added: COLORS.success,
  removed: COLORS.danger,
  deleted: COLORS.danger,
  modified: COLORS.warning,
  changed: COLORS.warning,
  renamed: COLORS.info,
  copied: COLORS.info,
  unchanged: COLORS.textSecondary,
};

/** Single-letter git mark; unknown statuses read as a modification. */
export function diffFileTreeStatusMark(status: string | null | undefined): string {
  return (status && STATUS_MARK[status]) || "M";
}

function diffFileTreeStatusColor(status: string | null | undefined): string {
  return (status && STATUS_COLOR[status]) || COLORS.textSecondary;
}

export function normalizeDiffTreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function sortDiffTreeItems(items: DiffFileTreeItem[]): void {
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  for (const item of items) {
    if (item.kind === "folder") sortDiffTreeItems(item.children);
  }
}

/**
 * Build the folder hierarchy for a path list. Directories sort before files and
 * names sort with `numeric` so `file2` precedes `file10`.
 */
export function buildDiffFileTree(files: readonly DiffFileTreeEntry[]): DiffFileTreeFolder {
  const root: DiffFileTreeFolder = { kind: "folder", name: "", path: "", children: [] };
  const folders = new Map<string, DiffFileTreeFolder>([["", root]]);
  for (const entry of files) {
    const normalized = normalizeDiffTreePath(entry.path);
    if (!normalized) continue;
    const segments = normalized.split("/");
    let parent = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const folderPath = parent.path ? `${parent.path}/${segments[i]}` : segments[i];
      let folder = folders.get(folderPath);
      if (!folder) {
        folder = { kind: "folder", name: segments[i], path: folderPath, children: [] };
        folders.set(folderPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({
      kind: "file",
      name: segments[segments.length - 1],
      path: entry.path,
      entry,
    });
  }
  sortDiffTreeItems(root.children);
  return root;
}

/** Every folder path in the tree, excluding the synthetic root. */
export function collectDiffTreeFolderPaths(root: DiffFileTreeFolder): string[] {
  const paths: string[] = [];
  const walk = (item: DiffFileTreeItem): void => {
    if (item.kind !== "folder") return;
    if (item.path) paths.push(item.path);
    for (const child of item.children) walk(child);
  };
  walk(root);
  return paths;
}

/**
 * Drop collapse entries for folders that no longer exist, keeping the rest.
 * Returns the same set when nothing changed so React can skip a re-render.
 */
export function pruneCollapsedFolders(
  collapsed: ReadonlySet<string>,
  validPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  if (collapsed.size === 0) return collapsed;
  let changed = false;
  const next = new Set<string>();
  for (const path of collapsed) {
    if (validPaths.has(path)) next.add(path);
    else changed = true;
  }
  return changed ? next : collapsed;
}

/** Ancestor folder paths for a file, nearest first. */
export function diffTreeAncestorFolders(path: string): string[] {
  const normalized = normalizeDiffTreePath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return [];
  const ancestors: string[] = [];
  let cursor = normalized.slice(0, index);
  while (cursor) {
    ancestors.push(cursor);
    const slash = cursor.lastIndexOf("/");
    cursor = slash >= 0 ? cursor.slice(0, slash) : "";
  }
  return ancestors;
}

export type DiffFileTreeProps = {
  files: readonly DiffFileTreeEntry[];
  /** Highlighted file; its folders are force-opened. */
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
  className?: string;
  emptyLabel?: string;
};

export function DiffFileTree({
  files,
  selectedPath = null,
  onSelectFile,
  className,
  emptyLabel = "No files changed",
}: DiffFileTreeProps) {
  const tree = useMemo(() => buildDiffFileTree(files), [files]);
  const folderPaths = useMemo(() => collectDiffTreeFolderPaths(tree), [tree]);
  const validFolders = useMemo(() => new Set(folderPaths), [folderPaths]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());

  // Batch-prune folders that disappeared instead of resetting the whole set.
  useEffect(() => {
    setCollapsed((prev) => pruneCollapsedFolders(prev, validFolders));
  }, [validFolders]);

  // A selected file reveals itself: clear the collapse on each ancestor.
  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = diffTreeAncestorFolders(selectedPath);
    if (ancestors.length === 0) return;
    setCollapsed((prev) => {
      if (!ancestors.some((ancestor) => prev.has(ancestor))) return prev;
      const next = new Set(prev);
      for (const ancestor of ancestors) next.delete(ancestor);
      return next;
    });
  }, [selectedPath]);

  const toggleFolder = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAllFolders = useCallback(() => setCollapsed(new Set<string>()), []);
  const collapseAllFolders = useCallback(() => setCollapsed(new Set(folderPaths)), [folderPaths]);

  const isEmpty = tree.children.length === 0;

  // Visible rows in render order. Keyboard navigation walks this list, and
  // `aria-level` on each row carries the hierarchy a nested group would.
  const flatItems = useMemo(() => {
    const out: FlatDiffTreeRow[] = [];
    const walk = (items: DiffFileTreeItem[], depth: number, parentPath: string | null): void => {
      for (const item of items) {
        if (item.kind === "folder") {
          const expanded = !collapsed.has(item.path);
          out.push({ kind: "folder", path: item.path, name: item.name, depth, parentPath, expanded });
          if (expanded) walk(item.children, depth + 1, item.path);
        } else {
          out.push({ kind: "file", path: item.path, name: item.name, depth, parentPath, entry: item.entry });
        }
      }
    };
    walk(tree.children, 0, null);
    return out;
  }, [tree, collapsed]);

  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const activePath = focusedPath && flatItems.some((item) => item.path === focusedPath)
    ? focusedPath
    : flatItems[0]?.path ?? null;

  useEffect(() => {
    if (focusedPath && !flatItems.some((item) => item.path === focusedPath)) setFocusedPath(null);
  }, [flatItems, focusedPath]);

  const focusItem = useCallback((path: string) => {
    setFocusedPath(path);
    requestAnimationFrame(() => itemRefs.current.get(path)?.focus());
  }, []);

  const moveFocus = useCallback((delta: number) => {
    const index = flatItems.findIndex((item) => item.path === activePath);
    const nextIndex = Math.min(flatItems.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
    const next = flatItems[nextIndex];
    if (next) focusItem(next.path);
  }, [activePath, flatItems, focusItem]);

  // Arrow keys move focus between visible rows; Left/Right open and close
  // folders, matching the interaction the tree roles advertise. Enter and Space
  // are the focused button's own activation, so they need no handling here.
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    const index = flatItems.findIndex((item) => item.path === activePath);
    const current = index >= 0 ? flatItems[index] : null;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (current?.kind === "folder") {
          if (!current.expanded) {
            setCollapsed((prev) => {
              const next = new Set(prev);
              next.delete(current.path);
              return next;
            });
          } else {
            moveFocus(1);
          }
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (current?.kind === "folder" && current.expanded) {
          setCollapsed((prev) => new Set(prev).add(current.path));
        } else if (current?.parentPath) {
          focusItem(current.parentPath);
        }
        break;
      case "Home":
        event.preventDefault();
        if (flatItems[0]) focusItem(flatItems[0].path);
        break;
      case "End":
        event.preventDefault();
        if (flatItems.length) focusItem(flatItems[flatItems.length - 1].path);
        break;
      default:
        break;
    }
  }, [activePath, flatItems, focusItem, moveFocus]);

  const setItemRef = (path: string, node: HTMLButtonElement | null): void => {
    if (node) itemRefs.current.set(path, node);
    else itemRefs.current.delete(path);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
          padding: "4px 6px", borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <span style={{ ...LABEL_STYLE_LOCAL, marginRight: "auto" }}>
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        <TreeButton label="Expand all" disabled={isEmpty || folderPaths.length === 0} onClick={expandAllFolders} />
        <TreeButton label="Collapse all" disabled={isEmpty || folderPaths.length === 0} onClick={collapseAllFolders} />
      </div>
      <div
        role="tree"
        aria-label="Changed files"
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-auto"
        style={{ padding: "2px 0" }}
      >
        {isEmpty ? (
          <div style={{ padding: "10px 12px", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>{emptyLabel}</div>
        ) : flatItems.map((item) => {
          const indent = 8 + item.depth * 12;
          const focused = item.path === activePath;
          if (item.kind === "folder") {
            return (
              <button
                key={`folder:${item.path}`}
                ref={(node) => setItemRef(item.path, node)}
                type="button"
                role="treeitem"
                aria-level={item.depth + 1}
                aria-expanded={item.expanded}
                tabIndex={focused ? 0 : -1}
                data-testid="diff-file-tree-folder"
                data-path={item.path}
                onFocus={() => setFocusedPath(item.path)}
                onClick={() => toggleFolder(item.path)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%",
                  padding: `4px 8px 4px ${indent}px`, border: "none", background: "transparent",
                  cursor: "pointer", textAlign: "left", color: COLORS.textSecondary,
                  fontFamily: SANS_FONT, fontSize: 11.5,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                {item.expanded ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
                {item.expanded
                  ? <FolderOpen size={13} style={{ color: COLORS.textMuted }} />
                  : <FolderSimple size={13} style={{ color: COLORS.textMuted }} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </button>
            );
          }
          const status = item.entry?.status ?? null;
          const selected = selectedPath === item.path;
          return (
            <button
              key={`file:${item.path}`}
              ref={(node) => setItemRef(item.path, node)}
              type="button"
              role="treeitem"
              aria-level={item.depth + 1}
              aria-selected={selected}
              tabIndex={focused ? 0 : -1}
              data-testid="diff-file-tree-file"
              data-path={item.path}
              title={item.entry?.previousPath ? `${item.entry.previousPath} → ${item.path}` : item.path}
              onFocus={() => setFocusedPath(item.path)}
              onClick={() => onSelectFile?.(item.path)}
              style={{
                display: "flex", alignItems: "center", gap: 6, width: "100%",
                padding: `4px 8px 4px ${indent}px`, border: "none",
                background: selected ? `color-mix(in srgb, ${COLORS.accent} 14%, transparent)` : "transparent",
                cursor: "pointer", textAlign: "left",
              }}
              onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = COLORS.hoverBg; }}
              onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
            >
              <span
                aria-hidden
                style={{
                  fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 700, lineHeight: "14px",
                  color: diffFileTreeStatusColor(status),
                  background: `color-mix(in srgb, ${diffFileTreeStatusColor(status)} 10%, transparent)`,
                  borderRadius: 3, width: 14, textAlign: "center", flexShrink: 0,
                }}
              >
                {diffFileTreeStatusMark(status)}
              </span>
              <span
                style={{
                  fontFamily: MONO_FONT, fontSize: 11,
                  color: selected ? COLORS.textPrimary : COLORS.textSecondary,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
                }}
              >
                {item.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type FlatDiffTreeRow = {
  kind: "folder" | "file";
  path: string;
  name: string;
  depth: number;
  parentPath: string | null;
  /** Folders only. */
  expanded?: boolean;
  entry?: DiffFileTreeEntry;
};

const LABEL_STYLE_LOCAL: React.CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 10,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: COLORS.textMuted,
};

function TreeButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: "none", background: "transparent", cursor: disabled ? "default" : "pointer",
        color: disabled ? COLORS.textDim : COLORS.textSecondary,
        fontFamily: SANS_FONT, fontSize: 10.5, padding: "1px 3px", whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = COLORS.textPrimary; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = disabled ? COLORS.textDim : COLORS.textSecondary; }}
    >
      {label}
    </button>
  );
}
