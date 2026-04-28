import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useDockLayout } from "../ui/DockLayoutState";
import { cn } from "../ui/cn";
import {
  GRID_GAP_PX,
  GRID_BASE_ROW_PX,
  GRID_MAX_ROW_SPAN,
  GRID_COLUMN_SUBDIVISIONS,
  computeDefaultRowSpan,
  computeMinimumColSpan,
  computeGridColumnCount,
  computeMinimumRowSpan,
  packGridItems,
  readPackedGridPlacement,
  readPackedGridSpan,
  reconcilePackedGridLayout,
  clampPackedGridSpan,
  type PackedGridPlacement,
  type PackedGridSpan,
  resizePackedGridItem,
} from "./packedSessionGridMath";

type ResizeDirection = "e" | "w";

type PackedSessionGridTile = {
  id: string;
  minWidth: number;
  minHeight: number;
  selected?: boolean;
  onSelect?: () => void;
  onHover?: () => void;
  header: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

type ResizeState = {
  tileId: string;
  direction: ResizeDirection;
  startX: number;
  startPlacementsById: Record<string, PackedGridPlacement>;
  currentPlacementsById: Record<string, PackedGridPlacement>;
  pointerId: number;
  pointerTarget: HTMLElement | null;
};

const RESIZE_HANDLES: Array<{ direction: ResizeDirection; style: CSSProperties }> = [
  { direction: "e", style: { right: -6, top: 4, bottom: 4, width: 16, cursor: "e-resize" } },
  { direction: "w", style: { left: -6, top: 4, bottom: 4, width: 16, cursor: "w-resize" } },
];

export function PackedSessionGrid({
  layoutId,
  tiles,
  className,
  onViewportMouseLeave,
}: {
  layoutId: string;
  tiles: PackedSessionGridTile[];
  className?: string;
  onViewportMouseLeave?: () => void;
}) {
  const { layout, loaded, saveLayout } = useDockLayout(layoutId, {});
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [resizingTileId, setResizingTileId] = useState<string | null>(null);
  const [draftSpansById, setDraftSpansById] = useState<Record<string, PackedGridSpan>>({});
  const [draftPlacementsById, setDraftPlacementsById] = useState<Record<string, { column: number; row: number }>>({});

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
        colSpan: GRID_COLUMN_SUBDIVISIONS,
        rowSpan: Math.max(minRowSpans[tile.id] ?? 1, defaultRowSpan),
      };
    }
    return next;
  }, [defaultRowSpan, minRowSpans, tiles]);

  const columnCount = useMemo(() => {
    const minTileWidth = tiles.reduce((largest, tile) => Math.max(largest, tile.minWidth), 0);
    return computeGridColumnCount({
      containerWidth: viewportSize.width,
      tileCount: tiles.length,
      minTileWidth,
    });
  }, [tiles, viewportSize.width]);

  const trackCount = useMemo(
    () => Math.max(GRID_COLUMN_SUBDIVISIONS, columnCount * GRID_COLUMN_SUBDIVISIONS),
    [columnCount],
  );

  const trackWidth = useMemo(() => {
    if (trackCount <= 0 || viewportSize.width <= 0) return 0;
    const availableWidth = viewportSize.width - GRID_GAP_PX * Math.max(0, trackCount - 1);
    return Math.max(0, availableWidth / trackCount);
  }, [trackCount, viewportSize.width]);

  const minColSpans = useMemo(() => {
    const next: Record<string, number> = {};
    for (const tile of tiles) {
      next[tile.id] = computeMinimumColSpan({
        minWidthPx: tile.minWidth,
        trackWidthPx: trackWidth,
      });
    }
    return next;
  }, [tiles, trackWidth]);

  const spansById = useMemo(() => {
    const next: Record<string, PackedGridSpan> = {};
    for (const tile of tiles) {
      const defaults = defaultSpansById[tile.id] ?? { colSpan: GRID_COLUMN_SUBDIVISIONS, rowSpan: defaultRowSpan };
      const persisted = readPackedGridSpan(layout, tile.id, defaults);
      const clamped = clampPackedGridSpan({
        span: persisted,
        columnCount: trackCount,
        minColSpan: minColSpans[tile.id] ?? 1,
        minRowSpan: defaults.rowSpan,
        maxRowSpan: GRID_MAX_ROW_SPAN,
      });
      // rowSpan is height-driven (viewport-fit); only colSpan persists.
      next[tile.id] = { colSpan: clamped.colSpan, rowSpan: defaults.rowSpan };
    }
    return next;
  }, [defaultRowSpan, defaultSpansById, layout, minColSpans, tiles, trackCount]);

  const effectiveSpansById = useMemo(() => {
    if (!Object.keys(draftSpansById).length) return spansById;
    const next = { ...spansById };
    for (const [tileId, span] of Object.entries(draftSpansById)) {
      next[tileId] = span;
    }
    return next;
  }, [draftSpansById, spansById]);

  const placementsById = useMemo(() => {
    const next: Record<string, { column: number; row: number }> = {};
    for (const tile of tiles) {
      const persisted = readPackedGridPlacement(layout, tile.id);
      if (persisted) {
        next[tile.id] = persisted;
      }
    }
    return next;
  }, [layout, tiles]);

  const effectivePlacementsById = useMemo(() => {
    if (!Object.keys(draftPlacementsById).length) return placementsById;
    return {
      ...placementsById,
      ...draftPlacementsById,
    };
  }, [draftPlacementsById, placementsById]);

  const packedItems = useMemo(() => {
    const next = tiles.map((tile) => ({
      id: tile.id,
      minRowSpan: minRowSpans[tile.id] ?? 1,
      span: effectiveSpansById[tile.id] ?? defaultSpansById[tile.id] ?? { colSpan: 1, rowSpan: 1 },
      placement: effectivePlacementsById[tile.id],
    }));
    if (!resizingTileId) return next;
    const activeIndex = next.findIndex((item) => item.id === resizingTileId);
    if (activeIndex <= 0) return next;
    const [active] = next.splice(activeIndex, 1);
    return [active, ...next];
  }, [defaultSpansById, effectivePlacementsById, effectiveSpansById, minRowSpans, resizingTileId, tiles]);

  const packed = useMemo(
    () => packGridItems(packedItems, trackCount),
    [packedItems, trackCount],
  );

  const placementById = useMemo(() => {
    const next = new Map<string, PackedGridPlacement>();
    for (const placement of packed.placements) {
      next.set(placement.id, placement);
    }
    return next;
  }, [packed.placements]);

  useEffect(() => {
    if (!loaded) return;
    const nextLayout = reconcilePackedGridLayout({
      layout,
      tileIds: tiles.map((tile) => tile.id),
      defaultSpansById,
      columnCount: trackCount,
    });
    const sameKeys = Object.keys(nextLayout).length === Object.keys(layout).length
      && Object.entries(nextLayout).every(([key, value]) => layout[key] === value);
    if (!sameKeys) {
      saveLayout(nextLayout);
    }
  }, [defaultSpansById, layout, loaded, saveLayout, tiles, trackCount]);

  const stopResize = useCallback((clearDraft = true) => {
    const state = resizeStateRef.current;
    if (state?.pointerTarget && state.pointerTarget.hasPointerCapture?.(state.pointerId)) {
      state.pointerTarget.releasePointerCapture(state.pointerId);
    }
    resizeStateRef.current = null;
    setResizingTileId(null);
    if (clearDraft) {
      setDraftSpansById({});
      setDraftPlacementsById({});
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    return () => {
      stopResize();
    };
  }, [stopResize]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const state = resizeStateRef.current;
      if (!state || trackWidth <= 0) return;
      const colUnit = trackWidth + GRID_GAP_PX;
      const deltaCols = Math.round((event.clientX - state.startX) / colUnit);
      const nextPlacementsById = resizePackedGridItem({
        placementsById: state.startPlacementsById,
        tileId: state.tileId,
        direction: state.direction,
        deltaCols,
        deltaRows: 0,
        columnCount: trackCount,
        minColSpans,
        minRowSpans,
        maxRowSpan: GRID_MAX_ROW_SPAN,
      });

      const sameLayout = Object.keys(nextPlacementsById).length === Object.keys(state.currentPlacementsById).length
        && Object.entries(nextPlacementsById).every(([tileId, nextPlacement]) => {
          const currentPlacement = state.currentPlacementsById[tileId];
          return currentPlacement
            && currentPlacement.column === nextPlacement.column
            && currentPlacement.row === nextPlacement.row
            && currentPlacement.colSpan === nextPlacement.colSpan
            && currentPlacement.rowSpan === nextPlacement.rowSpan;
        });
      if (sameLayout) return;

      const nextDraftSpansById: Record<string, { colSpan: number; rowSpan: number }> = {};
      const nextDraftPlacementsById: Record<string, { column: number; row: number }> = {};
      for (const [tileId, nextPlacement] of Object.entries(nextPlacementsById)) {
        nextDraftSpansById[tileId] = {
          colSpan: nextPlacement.colSpan,
          rowSpan: nextPlacement.rowSpan,
        };
        nextDraftPlacementsById[tileId] = {
          column: nextPlacement.column,
          row: nextPlacement.row,
        };
      }

      resizeStateRef.current = {
        ...state,
        currentPlacementsById: nextPlacementsById,
      };
      setDraftSpansById(nextDraftSpansById);
      setDraftPlacementsById(nextDraftPlacementsById);
    };

    const handlePointerUp = () => {
      const state = resizeStateRef.current;
      if (state) {
        const changedTileIds = Object.keys(state.currentPlacementsById).filter((tileId) => {
          const startPlacement = state.startPlacementsById[tileId];
          const currentPlacement = state.currentPlacementsById[tileId];
          return !startPlacement
            || startPlacement.column !== currentPlacement.column
            || startPlacement.row !== currentPlacement.row
            || startPlacement.colSpan !== currentPlacement.colSpan
            || startPlacement.rowSpan !== currentPlacement.rowSpan;
        });
        if (changedTileIds.length > 0) {
          saveLayout((prev) => {
            const next = { ...prev };
            for (const tileId of changedTileIds) {
              const currentPlacement = state.currentPlacementsById[tileId];
              next[`${tileId}:colStart`] = currentPlacement.column;
              next[`${tileId}:rowStart`] = currentPlacement.row;
              next[`${tileId}:colSpan`] = currentPlacement.colSpan;
              next[`${tileId}:rowSpan`] = currentPlacement.rowSpan;
              next[`${tileId}:col`] = currentPlacement.colSpan;
              next[`${tileId}:row`] = currentPlacement.rowSpan;
            }
            return next;
          });
        }
      }
      stopResize();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [minColSpans, minRowSpans, saveLayout, stopResize, trackCount, trackWidth]);

  const beginResize = useCallback((tileId: string, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = `${direction}-resize`;
    const startPlacementsById: Record<string, PackedGridPlacement> = {};
    for (const placement of packed.placements) {
      startPlacementsById[placement.id] = { ...placement };
    }
    resizeStateRef.current = {
      tileId,
      direction,
      startX: event.clientX,
      startPlacementsById,
      currentPlacementsById: startPlacementsById,
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
    };
    setResizingTileId(tileId);
    document.body.style.userSelect = "none";
  }, [packed.placements]);

  const hasPackedLayout = trackCount > 0 && packed.totalRows > 0;
  const packedGridMinHeight = hasPackedLayout
    ? (packed.totalRows * GRID_BASE_ROW_PX) + (Math.max(0, packed.totalRows - 1) * GRID_GAP_PX)
    : undefined;

  return (
    <div
      ref={viewportRef}
      className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2", className)}
      onMouseLeave={() => onViewportMouseLeave?.()}
    >
      <div
        className="grid h-full w-full min-h-0 min-w-0"
        style={{
          gridTemplateColumns: hasPackedLayout
            ? `repeat(${trackCount}, minmax(0, 1fr))`
            : "minmax(0, 1fr)",
          gridTemplateRows: hasPackedLayout
            ? `repeat(${packed.totalRows}, minmax(${GRID_BASE_ROW_PX}px, 1fr))`
            : "minmax(0, 1fr)",
          minHeight: packedGridMinHeight,
          gap: `${GRID_GAP_PX}px`,
        }}
      >
        {tiles.map((tile) => {
          const placement = placementById.get(tile.id);
          if (!placement) return null;
          const slotStart = Math.ceil(placement.column / GRID_COLUMN_SUBDIVISIONS);

          return (
            <section
              key={tile.id}
              data-grid-tile-id={tile.id}
              data-grid-slot-start={slotStart}
              data-grid-col-start={placement.column}
              data-grid-col-end={placement.column + placement.colSpan - 1}
              data-grid-col-span={placement.colSpan}
              data-grid-row-start={placement.row}
              data-grid-row-end={placement.row + placement.rowSpan - 1}
              data-grid-row-span={placement.rowSpan}
              className="group relative min-h-0 min-w-0"
              style={{
                gridColumn: `${placement.column} / span ${placement.colSpan}`,
                gridRow: `${placement.row} / span ${placement.rowSpan}`,
              }}
              onMouseDown={() => tile.onSelect?.()}
              onPointerEnter={() => {
                if (resizeStateRef.current) return;
                tile.onHover?.();
              }}
            >
              <div className={cn(
                "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl",
                tile.className,
              )}>
                {tile.header}
                <div className="min-h-0 flex-1 overflow-hidden">{tile.children}</div>
              </div>
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 rounded-xl border border-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] transition-opacity",
                  tile.selected || resizingTileId === tile.id ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              />
              {RESIZE_HANDLES.map((handle) => (
                <div
                  key={handle.direction}
                  data-grid-resize-handle={handle.direction}
                  className="pointer-events-none absolute z-10 rounded-md group-hover:pointer-events-auto"
                  style={{ ...handle.style, touchAction: "none" }}
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
