import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import type { WorkGridSet } from "../../state/appStore";
import { PaneTilingLayout, type PaneConfig } from "../ui/PaneTilingLayout";
import { detectDropEdge, type DropEdge } from "../ui/paneTreeOps";
import { buildWorkSessionTilingTree } from "./workSessionTiling";
import { GRID_SESSION_DND_MIME, MAX_WORK_GRID_TILES } from "../../lib/workGrid";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { primarySessionLabel } from "../../lib/sessions";

/** Half-surface overlay rectangle for a hovered drop edge (matches FloatingPane). */
function edgeOverlayStyle(edge: DropEdge): CSSProperties | null {
  switch (edge) {
    case "top": return { top: 0, left: 0, right: 0, height: "50%" };
    case "bottom": return { bottom: 0, left: 0, right: 0, height: "50%" };
    case "left": return { top: 0, left: 0, bottom: 0, width: "50%" };
    case "right": return { top: 0, right: 0, bottom: 0, width: "50%" };
    case "center": return null;
  }
}

/**
 * Wraps a single (non-grid) session surface and accepts a session card dropped
 * from the sidebar — creating a brand-new grid from the pair. Shows a live edge
 * preview (split left/right/top/bottom) while dragging over it.
 */
export function SingleSessionGridDropZone({
  targetSessionId,
  onDropSession,
  children,
}: {
  targetSessionId: string;
  onDropSession: (draggedSessionId: string, edge: DropEdge) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<DropEdge | null>(null);

  const isExternal = (e: React.DragEvent) => e.dataTransfer.types.includes(GRID_SESSION_DND_MIME);

  return (
    <div
      ref={ref}
      className="relative h-full min-h-0 w-full"
      onDragOver={(e) => {
        if (!isExternal(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        let next = detectDropEdge(rect, e.clientX, e.clientY);
        if (next === "center") next = "right";
        setEdge(next);
      }}
      onDragLeave={(e) => {
        if (ref.current && e.relatedTarget && ref.current.contains(e.relatedTarget as Node)) return;
        setEdge(null);
      }}
      onDrop={(e) => {
        if (!isExternal(e)) return;
        e.preventDefault();
        const payload = e.dataTransfer.getData(GRID_SESSION_DND_MIME).trim();
        const dropEdge = edge && edge !== "center" ? edge : "right";
        setEdge(null);
        if (payload && payload !== targetSessionId) onDropSession(payload, dropEdge);
      }}
    >
      {children}
      {edge && edge !== "center" ? (
        <div className="ade-drop-zone-overlay pointer-events-none absolute z-30" style={edgeOverlayStyle(edge) ?? undefined} />
      ) : null}
    </div>
  );
}

/**
 * Cursor-style work grid: renders the sessions of one grid set in a resizable
 * split layout (reusing PaneTilingLayout for drop-at-edge rearrange + free
 * resize + persistence). Each tile renders the session's own full surface —
 * the chat/CLI keeps its normal header (which doubles as the tile drag handle
 * via FloatingPane embedded chrome), so nothing about a session changes when it
 * joins a grid; it just shares the screen.
 *
 * Dragging a session card from the sidebar onto a tile splits at the hovered
 * edge and fires `onAddSessionToGrid`.
 */
export function WorkGridView({
  gridSet,
  sessions,
  lanes,
  activeItemId,
  renderSession,
  onAddSessionToGrid,
  onRemoveFromGrid,
  onFocusSession,
  className,
}: {
  gridSet: WorkGridSet;
  sessions: TerminalSessionSummary[];
  lanes: LaneSummary[];
  activeItemId: string | null;
  /** Renders the full session surface (chat or CLI) for a grid tile. */
  renderSession: (session: TerminalSessionSummary) => ReactNode;
  /** A session card was dropped onto `targetSessionId` at `edge`. */
  onAddSessionToGrid: (draggedSessionId: string, targetSessionId: string, edge: DropEdge) => void;
  /** A tile was dragged out of the grid (released outside any pane). */
  onRemoveFromGrid: (sessionId: string) => void;
  onFocusSession: (sessionId: string) => void;
  className?: string;
}) {
  const members = useMemo(
    () =>
      gridSet.sessionIds
        .map((id) => sessions.find((s) => s.id === id) ?? null)
        .filter((s): s is TerminalSessionSummary => s != null),
    [gridSet.sessionIds, sessions],
  );

  // Key the fallback tree on the stable resolved-id signature, NOT on the
  // `members`/`sessions` object identity. The session list refreshes every few
  // seconds with fresh objects; without this the `tree` prop changed identity
  // each poll and retriggered PaneTilingLayout's load effect — a visible flicker.
  const liveMemberKey = members.map((m) => m.id).join("|");
  const fallbackTree = useMemo(
    () => buildWorkSessionTilingTree(liveMemberKey ? liveMemberKey.split("|") : [], "auto"),
    [liveMemberKey],
  );

  const panes = useMemo(() => {
    const map: Record<string, PaneConfig> = {};
    for (const session of members) {
      const lane = lanes.find((entry) => entry.id === session.laneId) ?? null;
      const laneAccent = getLaneAccent(lane, 0);
      map[session.id] = {
        title: primarySessionLabel(session),
        laneAccentColor: laneAccent,
        // The session's own header is the tile header + drag handle.
        hideHeaderWhenExpanded: true,
        minimizable: false,
        onPaneMouseDown: () => onFocusSession(session.id),
        renderChildren: () => renderSession(session),
        children: null,
      };
    }
    return map;
  }, [members, lanes, renderSession, onFocusSession]);

  // Need at least two live members to be a grid; otherwise the parent dissolves
  // the set and we render nothing here.
  if (members.length < 2) return null;

  return (
    <PaneTilingLayout
      key={gridSet.id}
      layoutId={gridSet.layoutId}
      tree={fallbackTree}
      panes={panes}
      // A full grid stops advertising the drop target: every tile holds a live
      // session surface, so membership is the renderer's heap bound. Withholding
      // the mime is the honest affordance — no drop indicator appears.
      //
      // Gated on persisted membership, not the resolved tiles: the cap in
      // `addSessionBesideTarget` counts `sessionIds`, so measuring anything else
      // here would advertise a drop that then silently no-ops.
      acceptExternalDropMime={
        gridSet.sessionIds.length >= MAX_WORK_GRID_TILES ? undefined : GRID_SESSION_DND_MIME
      }
      onExternalDrop={onAddSessionToGrid}
      onLeafDraggedOut={onRemoveFromGrid}
      className={className}
    />
  );
}
