import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useDockLayout } from "../ui/DockLayoutState";
import { cn } from "../ui/cn";
import {
  GRID_GAP_PX,
  GRID_MAX_ROW_SPAN,
  clampPackedGridSpan,
  computeDefaultRowSpan,
  computeGridColumnCount,
  computeMinimumRowSpan,
  computePackedGridRowHeight,
  computePackedSpanPixels,
  packGridItems,
  readPackedGridSpan,
  reconcilePackedGridLayout,
  type PackedGridPlacement,
  type PackedGridSpan,
} from "./packedSessionGridMath";

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type PackedSessionGridTile = {
  id: string;
  minWidth: number;
  minHeight: number;
  selected?: boolean;
  onSelect?: () => void;
  header: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

type ResizeState = {
  tileId: string;
  direction: ResizeDirection;
  startX: number;
  startY: number;
  startSpan: PackedGridSpan;
};

const RESIZE_HANDLES: Array<{ direction: ResizeDirection; style: CSSProperties }> = [
  { direction: "n", style: { top: -4, left: 10, right: 10, height: 8, cursor: "n-resize" } },
  { direction: "s", style: { bottom: -4, left: 10, right: 10, height: 8, cursor: "s-resize" } },
  { direction: "e", style: { right: -4, top: 10, bottom: 10, width: 8, cursor: "e-resize" } },
  { direction: "w", style: { left: -4, top: 10, bottom: 10, width: 8, cursor: "w-resize" } },
  { direction: "ne", style: { right: -5, top: -5, width: 12, height: 12, cursor: "ne-resize" } },
  { direction: "nw", style: { left: -5, top: -5, width: 12, height: 12, cursor: "nw-resize" } },
  { direction: "se", style: { right: -5, bottom: -5, width: 12, height: 12, cursor: "se-resize" } },
  { direction: "sw", style: { left: -5, bottom: -5, width: 12, height: 12, cursor: "sw-resize" } },
];

function hasHorizontalResize(direction: ResizeDirection): boolean {
  return direction.includes("e") || direction.includes("w");
}

function hasVerticalResize(direction: ResizeDirection): boolean {
  return direction.includes("n") || direction.includes("s");
}

export function PackedSessionGrid({
  layoutId,
  tiles,
  className,
}: {
  layoutId: string;
  tiles: PackedSessionGridTile[];
  className?: string;
}) {
  const { layout, loaded, saveLayout } = useDockLayout(layoutId, {});
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [resizingTileId, setResizingTileId] = useState<string | null>(null);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewportSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const minRowSpans = useMemo(() => {
    const next: Record<string, number> = {};
    for (const tile of tiles) {
      next[tile.id] = computeMinimumRowSpan(tile.minHeight);
    }
    return next;
  }, [tiles]);

  const defaultRowSpan = useMemo(
    () => computeDefaultRowSpan(Object.values(minRowSpans)),
    [minRowSpans],
  );

  const defaultSpansById = useMemo(() => {
    const next: Record<string, PackedGridSpan> = {};
    for (const tile of tiles) {
      next[tile.id] = {
        colSpan: 1,
        rowSpan: Math.max(minRowSpans[tile.id] ?? 1, defaultRowSpan),
      };
    }
    return next;
  }, [defaultRowSpan, minRowSpans, tiles]);

  useEffect(() => {
    if (!loaded) return;
    const nextLayout = reconcilePackedGridLayout({
      layout,
      tileIds: tiles.map((tile) => tile.id),
      defaultSpansById,
    });
    const sameKeys = Object.keys(nextLayout).length === Object.keys(layout).length
      && Object.entries(nextLayout).every(([key, value]) => layout[key] === value);
    if (!sameKeys) {
      saveLayout(nextLayout);
    }
  }, [defaultSpansById, layout, loaded, saveLayout, tiles]);

  const columnCount = useMemo(() => {
    const minTileWidth = tiles.reduce((largest, tile) => Math.max(largest, tile.minWidth), 0);
    return computeGridColumnCount({
      containerWidth: viewportSize.width,
      tileCount: tiles.length,
      minTileWidth,
    });
  }, [tiles, viewportSize.width]);

  const spansById = useMemo(() => {
    const next: Record<string, PackedGridSpan> = {};
    for (const tile of tiles) {
      next[tile.id] = clampPackedGridSpan({
        span: readPackedGridSpan(layout, tile.id, defaultSpansById[tile.id] ?? { colSpan: 1, rowSpan: 1 }),
        columnCount,
        minRowSpan: minRowSpans[tile.id] ?? 1,
        maxRowSpan: GRID_MAX_ROW_SPAN,
      });
    }
    return next;
  }, [columnCount, defaultSpansById, layout, minRowSpans, tiles]);

  const packedItems = useMemo(() => {
    return tiles.map((tile) => ({
      id: tile.id,
      minRowSpan: minRowSpans[tile.id] ?? 1,
      span: spansById[tile.id] ?? defaultSpansById[tile.id] ?? { colSpan: 1, rowSpan: 1 },
    }));
  }, [defaultSpansById, minRowSpans, spansById, tiles]);

  const packed = useMemo(
    () => packGridItems(packedItems, columnCount),
    [columnCount, packedItems],
  );

  const rowHeight = useMemo(
    () =>
      computePackedGridRowHeight({
        containerHeight: viewportSize.height,
        totalRows: packed.totalRows,
      }),
    [packed.totalRows, viewportSize.height],
  );

  const columnWidth = useMemo(() => {
    if (columnCount <= 0 || viewportSize.width <= 0) return 0;
    const availableWidth = viewportSize.width - GRID_GAP_PX * Math.max(0, columnCount - 1);
    return Math.max(0, availableWidth / columnCount);
  }, [columnCount, viewportSize.width]);

  const placementById = useMemo(() => {
    const next = new Map<string, PackedGridPlacement>();
    for (const placement of packed.placements) {
      next.set(placement.id, placement);
    }
    return next;
  }, [packed.placements]);

  const contentHeight = useMemo(
    () => computePackedSpanPixels(packed.totalRows, rowHeight),
    [packed.totalRows, rowHeight],
  );

  const stopResize = useCallback(() => {
    resizeStateRef.current = null;
    setResizingTileId(null);
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const state = resizeStateRef.current;
      if (!state || columnWidth <= 0 || rowHeight <= 0) return;
      const colUnit = columnWidth + GRID_GAP_PX;
      const rowUnit = rowHeight + GRID_GAP_PX;

      let nextColSpan = state.startSpan.colSpan;
      let nextRowSpan = state.startSpan.rowSpan;

      if (hasHorizontalResize(state.direction)) {
        const rawDelta = (event.clientX - state.startX) / colUnit;
        const normalizedDelta = state.direction.includes("w") ? -rawDelta : rawDelta;
        nextColSpan = state.startSpan.colSpan + Math.round(normalizedDelta);
      }

      if (hasVerticalResize(state.direction)) {
        const rawDelta = (event.clientY - state.startY) / rowUnit;
        const normalizedDelta = state.direction.includes("n") ? -rawDelta : rawDelta;
        nextRowSpan = state.startSpan.rowSpan + Math.round(normalizedDelta);
      }

      const clamped = clampPackedGridSpan({
        span: { colSpan: nextColSpan, rowSpan: nextRowSpan },
        columnCount,
        minRowSpan: minRowSpans[state.tileId] ?? 1,
        maxRowSpan: GRID_MAX_ROW_SPAN,
      });

      saveLayout((prev) => {
        const next = {
          ...prev,
          [`${state.tileId}:col`]: clamped.colSpan,
          [`${state.tileId}:row`]: clamped.rowSpan,
        };
        return next;
      });
    };

    const handlePointerUp = () => {
      stopResize();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [columnCount, columnWidth, minRowSpans, rowHeight, saveLayout, stopResize]);

  const beginResize = useCallback((tileId: string, direction: ResizeDirection, event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      tileId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startSpan: spansById[tileId] ?? { colSpan: 1, rowSpan: 1 },
    };
    setResizingTileId(tileId);
    document.body.style.userSelect = "none";
  }, [spansById]);

  return (
    <div ref={viewportRef} className={cn("min-h-0 flex-1 overflow-auto p-2", className)}>
      <div
        className="relative min-h-full"
        style={{ height: `${Math.max(contentHeight, viewportSize.height)}px` }}
      >
        {tiles.map((tile) => {
          const placement = placementById.get(tile.id);
          if (!placement) return null;

          const left = (placement.column - 1) * (columnWidth + GRID_GAP_PX);
          const top = (placement.row - 1) * (rowHeight + GRID_GAP_PX);
          const width = computePackedSpanPixels(placement.colSpan, columnWidth);
          const height = computePackedSpanPixels(placement.rowSpan, rowHeight);

          return (
            <section
              key={tile.id}
              data-grid-tile-id={tile.id}
              data-grid-col-start={placement.column}
              data-grid-col-span={placement.colSpan}
              data-grid-row-start={placement.row}
              data-grid-row-span={placement.rowSpan}
              className={cn(
                "group absolute flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md",
                tile.className,
              )}
              style={{
                left,
                top,
                width,
                height,
              }}
              onMouseDown={() => tile.onSelect?.()}
            >
              {tile.header}
              <div className="min-h-0 flex-1 overflow-hidden">{tile.children}</div>
              {RESIZE_HANDLES.map((handle) => (
                <div
                  key={handle.direction}
                  data-grid-resize-handle={handle.direction}
                  className={cn(
                    "absolute z-10 opacity-0 transition-opacity group-hover:opacity-100",
                    resizingTileId === tile.id ? "opacity-100" : "",
                  )}
                  style={handle.style}
                  onPointerDown={(event) => beginResize(tile.id, handle.direction, event)}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
