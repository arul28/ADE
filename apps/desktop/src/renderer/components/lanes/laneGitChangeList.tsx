import React, { useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { FileChange, LaneDiffMode } from "../../../shared/types";

/*
 * The Git pane's Files lists: the change tree folded into display rows, and
 * the virtualized list that renders them.
 */

export const MAX_RENDERED_CHANGE_ROWS_PER_SECTION = 300;
/** Files list rows are virtualized; the estimate stands in until each row is measured. */
const CHANGE_LIST_ROW_ESTIMATE_PX = 28;
/** The gaps the flex column put between rows and between the Staged and Unstaged sections. */
const CHANGE_LIST_ROW_GAP_PX = 2;
const CHANGE_LIST_SECTION_GAP_PX = 8;

type ChangeTreeNode = {
  name: string;
  path: string;
  dirs: Map<string, ChangeTreeNode>;
  files: FileChange[];
};

export type ChangeTreeStats = {
  files: number;
  additions: number;
  deletions: number;
};

function createChangeTreeNode(name: string, path: string): ChangeTreeNode {
  return { name, path, dirs: new Map(), files: [] };
}

export function buildChangeTree(files: FileChange[]): ChangeTreeNode {
  const root = createChangeTreeNode("", "");
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const nextPath = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = createChangeTreeNode(part, nextPath);
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

function getChangeTreeStats(node: ChangeTreeNode, statsByPath?: Map<string, ChangeTreeStats>): ChangeTreeStats {
  let files = node.files.length;
  let additions = node.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  let deletions = node.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  for (const child of node.dirs.values()) {
    const stats = getChangeTreeStats(child, statsByPath);
    files += stats.files;
    additions += stats.additions;
    deletions += stats.deletions;
  }
  const stats = { files, additions, deletions };
  if (node.path) statsByPath?.set(node.path, stats);
  return stats;
}

export function buildChangeTreeStatsByPath(files: FileChange[]): Map<string, ChangeTreeStats> {
  const statsByPath = new Map<string, ChangeTreeStats>();
  getChangeTreeStats(buildChangeTree(files), statsByPath);
  return statsByPath;
}

/**
 * One row of the Files list in display order. The tree is folded into rows so
 * the list can be virtualized: a collapsed folder's children never enter the
 * list, and only the rows in view mount.
 */
export type ChangeListRow =
  | { key: string; kind: "section"; label: string; count: number; gapAbove: boolean }
  | { key: string; kind: "folder"; mode: LaneDiffMode; name: string; depth: number; collapsed: boolean; stats: ChangeTreeStats }
  | { key: string; kind: "file"; mode: LaneDiffMode; file: FileChange; depth: number }
  | { key: string; kind: "notice"; section: ChangeSection; total: number; noun: string };

export function flattenChangeTreeRows(
  node: ChangeTreeNode,
  mode: LaneDiffMode,
  depth: number,
  collapsedFolders: ReadonlySet<string>,
  statsByPath: Map<string, ChangeTreeStats>,
  rows: ChangeListRow[],
): void {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

  for (const dir of dirs) {
    const key = `${mode}:${dir.path}`;
    const collapsed = collapsedFolders.has(key);
    const stats = statsByPath.get(dir.path) ?? getChangeTreeStats(dir);
    rows.push({ key, kind: "folder", mode, name: dir.name, depth, collapsed, stats });
    if (!collapsed) flattenChangeTreeRows(dir, mode, depth + 1, collapsedFolders, statsByPath, rows);
  }

  for (const file of files) {
    rows.push({ key: `${mode}:wrap:${file.path}`, kind: "file", mode, file, depth });
  }
}

/** Index of the next row after `from` that has a control Tab can stop on, or -1 at the end of the list. */
function nextChangeListRowWithControls(rows: ChangeListRow[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];
    // Section labels and branch file rows are plain text; folders, notices and uncommitted file rows hold buttons.
    if (row && (row.kind === "folder" || row.kind === "notice" || (row.kind === "file" && row.mode !== "branch"))) return index;
  }
  return -1;
}

export type ChangeSection = "staged" | "unstaged" | "branch";

/**
 * One section's file list. It is as tall as its rows up to the section's cap,
 * then scrolls on its own, so Uncommitted and Committed never push each other
 * or History off the pane. Rows are virtualized: a lane far from its base can
 * list thousands of files.
 */
export function ChangeList({
  rows,
  renderRow,
  testId,
}: {
  rows: ChangeListRow[];
  renderRow: (row: ChangeListRow) => React.ReactNode;
  testId: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The row that holds keyboard focus, as state: moving focus re-renders the window so the rows Tab can reach next are mounted.
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const focusedIndex = focusedRowKey == null ? -1 : rows.findIndex((row) => row.key === focusedRowKey);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: () => CHANGE_LIST_ROW_ESTIMATE_PX,
    overscan: 4,
    gap: CHANGE_LIST_ROW_GAP_PX,
    // Tab moves focus in the browser's own order and does not wait for a scroll to mount the next row, so the rows
    // it can land on are mounted here: the focused row (it keeps focus when it scrolls out of view) and the nearest
    // row with controls on each side. Rows in between hold no controls, so Tab never needs them.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex < 0) return indexes;
      const reachable = [
        focusedIndex,
        nextChangeListRowWithControls(rows, focusedIndex, 1),
        nextChangeListRowWithControls(rows, focusedIndex, -1),
      ].filter((index) => index >= 0 && !indexes.includes(index));
      return reachable.length === 0 ? indexes : [...indexes, ...reachable].sort((a, b) => a - b);
    },
  });

  return (
    <div
      ref={scrollRef}
      className="ade-git-list"
      data-testid={testId}
      // Focus landing in a row mounts its neighbours before the next Tab. Focus leaving the list releases them.
      onFocus={(event) => {
        const index = Number((event.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index);
        setFocusedRowKey(rows[index]?.key ?? null);
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocusedRowKey(null);
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={row.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                paddingTop: row.kind === "section" && row.gapAbove ? CHANGE_LIST_SECTION_GAP_PX - CHANGE_LIST_ROW_GAP_PX : undefined,
              }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
