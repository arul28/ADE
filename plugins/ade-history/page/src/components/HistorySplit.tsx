/**
 * Two titled panes, a drag handle, no tiling library.
 *
 * The compiled History used `PaneTilingLayout` / `react-resizable-panels`, a
 * renderer dependency with window-level listeners a guest must not inherit.
 * The clamps and the persistence are the compiled ones; the split is a flex
 * row. Width lives in `ui-state`, not `localStorage`.
 *
 * `PaneTilingLayout` drew a title bar above each pane, and the panes are
 * unreadable without one: the left pane changes between the commit graph and
 * the operation timeline, and the right pane between a commit and an event,
 * with nothing else on screen saying which. The bars are back, at the compiled
 * height.
 *
 * ## Why the drag handlers are built once
 *
 * The first version rebuilt `onDragEnd` on every render, because it closed over
 * `detailPx` to report the final width. The cleanup effect then depended on
 * that identity, so React ran the cleanup after the FIRST pointer move — which
 * removed the very listeners the drag was running on. A resize moved one pixel
 * and died.
 *
 * So the pair is created once, the live width rides on the drag record rather
 * than through a closure, and the callbacks the page passes are read off a ref
 * at call time. The cleanup effect then has nothing to depend on and runs at
 * unmount, which is the only time it should.
 */

import React from "react";

import { DETAIL_MAX_PX, DETAIL_MIN_PX } from "../host/uiState";

/** The compiled pane title bar height, in pixels. */
export const PANE_TITLE_PX = 24;

type HistorySplitProps = {
  detailPx: number;
  onDetailPx: (next: number) => void;
  onDetailPxCommit: (next: number) => void;
  timelineTitle: string;
  detailTitle: string;
  timeline: React.ReactNode;
  detail: React.ReactNode;
};

type DragRecord = { startX: number; startPx: number; currentPx: number };

function clampDetailPx(value: number): number {
  return Math.min(DETAIL_MAX_PX, Math.max(DETAIL_MIN_PX, value));
}

function PaneTitle({ title }: { title: string }): React.ReactElement {
  return (
    <div
      style={{ height: PANE_TITLE_PX }}
      data-ade-history-pane-title={title}
      className="flex shrink-0 items-center border-b border-white/[0.06] bg-white/[0.02] px-3"
    >
      <span className="truncate font-sans text-[10px] font-bold uppercase tracking-[1px] text-muted-fg">
        {title}
      </span>
    </div>
  );
}

export function HistorySplit({
  detailPx,
  onDetailPx,
  onDetailPxCommit,
  timelineTitle,
  detailTitle,
  timeline,
  detail,
}: HistorySplitProps): React.ReactElement {
  const dragRef = React.useRef<DragRecord | null>(null);

  // The page's callbacks, read at call time. A drag that ran against the
  // render's copy would report the width the pane had when the pointer went
  // down, which is the bug this file exists to not have.
  const latest = React.useRef({ onDetailPx, onDetailPxCommit });
  latest.current = { onDetailPx, onDetailPxCommit };

  const handlers = React.useRef<{
    move: (event: PointerEvent) => void;
    up: () => void;
  } | null>(null);
  if (!handlers.current) {
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampDetailPx(drag.startPx + (drag.startX - event.clientX));
      drag.currentPx = next;
      latest.current.onDetailPx(next);
    };
    const up = (): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // One write per drag, not one per pixel. See `HistoryPage`'s commit
      // handler: the live setter moves the pane, this one persists it.
      if (drag) latest.current.onDetailPxCommit(drag.currentPx);
    };
    handlers.current = { move, up };
  }
  const { move, up } = handlers.current;

  const onDragStart = React.useCallback(
    (event: React.PointerEvent) => {
      dragRef.current = {
        startX: event.clientX,
        startPx: clampDetailPx(detailPx),
        currentPx: clampDetailPx(detailPx),
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [detailPx, move, up],
  );

  React.useEffect(
    () => () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    },
    [move, up],
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <PaneTitle title={timelineTitle} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{timeline}</div>
      </div>
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
        <PaneTitle title={detailTitle} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{detail}</div>
      </div>
    </div>
  );
}
