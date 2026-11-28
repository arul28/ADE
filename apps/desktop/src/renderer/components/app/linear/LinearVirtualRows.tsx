import React, { useCallback, useEffect, useMemo, type RefObject } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
  CONTEXT_ROW_HEIGHT,
  GROUP_HEADER_HEIGHT,
  ISSUE_ROW_HEIGHT,
  SUBGROUP_HEADER_HEIGHT,
} from "../LinearIssueBrowserRows";
import type { LinearListRow } from "./linearListModel";

function rowHeight(row: LinearListRow | undefined): number {
  if (!row) return ISSUE_ROW_HEIGHT;
  if (row.kind === "group") return row.depth === 0 ? GROUP_HEADER_HEIGHT : SUBGROUP_HEADER_HEIGHT;
  if (row.kind === "context") return CONTEXT_ROW_HEIGHT;
  return ISSUE_ROW_HEIGHT;
}

export type LinearVirtualList = {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** The top-level group header pinned at the top of the scroll area. */
  activeHeaderIndex: number | null;
  /** Index of the last row rendered, -1 when none (for infinite scroll). */
  lastRenderedIndex: number;
};

/**
 * The virtualizer for the issue list: rows of three heights, and the current
 * top-level group header kept rendered (and sticky) while its rows scroll.
 */
export function useLinearVirtualList(
  rows: LinearListRow[],
  headerIndices: number[],
  scrollRef: RefObject<HTMLDivElement | null>,
): LinearVirtualList {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rowHeight(rows[index]),
    getItemKey: (index) => rows[index]?.key ?? index,
    // A starting viewport so the first paint (and jsdom) renders rows before
    // the scroll element is measured.
    initialRect: { width: 0, height: 720 },
    overscan: 12,
    rangeExtractor: useCallback(
      (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        let pinned: number | null = null;
        for (const index of headerIndices) {
          if (index > range.startIndex) break;
          pinned = index;
        }
        const start = Math.max(0, range.startIndex - range.overscan);
        const end = Math.min(range.count - 1, range.endIndex + range.overscan);
        const indices = new Set<number>();
        if (pinned != null) indices.add(pinned);
        for (let index = start; index <= end; index += 1) indices.add(index);
        return [...indices].sort((a, b) => a - b);
      },
      [headerIndices],
    ),
  });
  // Row kinds have different heights; re-measure when the rows change shape.
  useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);
  const startIndex = virtualizer.range?.startIndex ?? 0;
  const activeHeaderIndex = useMemo(() => {
    let active: number | null = null;
    for (const index of headerIndices) {
      if (index > startIndex) break;
      active = index;
    }
    return active;
  }, [headerIndices, startIndex]);
  const items = virtualizer.getVirtualItems();
  const lastRenderedIndex = items.length > 0 ? items[items.length - 1]!.index : -1;
  return { virtualizer, activeHeaderIndex, lastRenderedIndex };
}

/** The positioned rows; the browser draws each row's content. */
export function LinearVirtualRows({
  list,
  rows,
  renderRow,
}: {
  list: LinearVirtualList;
  rows: LinearListRow[];
  renderRow: (row: LinearListRow, index: number) => React.ReactNode;
}) {
  const { virtualizer, activeHeaderIndex } = list;
  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        const pinned = row.kind === "group" && virtualRow.index === activeHeaderIndex;
        return (
          <div
            key={row.key}
            role="listitem"
            data-index={virtualRow.index}
            style={{
              position: pinned ? "sticky" : "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: virtualRow.size,
              zIndex: pinned ? 2 : undefined,
              ...(pinned ? {} : { transform: `translateY(${virtualRow.start}px)` }),
            }}
          >
            {renderRow(row, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
