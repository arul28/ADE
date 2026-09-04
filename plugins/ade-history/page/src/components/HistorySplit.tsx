/**
 * Two panes, a drag handle, no tiling library.
 *
 * The compiled History used `PaneTilingLayout` / `react-resizable-panels`, a
 * renderer dependency with window-level listeners a guest must not inherit.
 * The clamps and the persistence are the compiled ones; the split is a flex
 * row. Width lives in `ui-state`, not `localStorage`.
 */

import React from "react";

import { DETAIL_MAX_PX, DETAIL_MIN_PX } from "../host/uiState";

type HistorySplitProps = {
  detailPx: number;
  onDetailPx: (next: number) => void;
  onDetailPxCommit: (next: number) => void;
  timeline: React.ReactNode;
  detail: React.ReactNode;
};

export function HistorySplit({
  detailPx,
  onDetailPx,
  onDetailPxCommit,
  timeline,
  detail,
}: HistorySplitProps): React.ReactElement {
  const dragRef = React.useRef<{ startX: number; startPx: number } | null>(null);

  const onDragMove = React.useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      DETAIL_MAX_PX,
      Math.max(DETAIL_MIN_PX, drag.startPx + (drag.startX - event.clientX)),
    );
    onDetailPx(next);
  }, [onDetailPx]);

  const onDragEnd = React.useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    if (drag) onDetailPxCommit(detailPx);
  }, [detailPx, onDetailPxCommit, onDragMove]);

  const onDragStart = React.useCallback(
    (event: React.PointerEvent) => {
      dragRef.current = { startX: event.clientX, startPx: detailPx };
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragEnd);
    },
    [detailPx, onDragEnd, onDragMove],
  );

  React.useEffect(
    () => () => {
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
    },
    [onDragEnd, onDragMove],
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{timeline}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the history detail pane"
        onPointerDown={onDragStart}
        className="w-1 shrink-0 cursor-col-resize bg-[var(--color-border)]/40 hover:bg-accent/40"
      />
      <div
        style={{ width: detailPx }}
        className="flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden"
      >
        {detail}
      </div>
    </div>
  );
}
