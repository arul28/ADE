import React from "react";
import type { LaneSummary } from "../../../shared/types";
import { revealLabel } from "../../lib/platform";

export function LaneContextMenu({
  laneContextMenu,
  lanesById,
  onClose,
  onManage,
  selectLane
}: {
  laneContextMenu: { laneId: string; x: number; y: number };
  lanesById: Map<string, LaneSummary>;
  onClose: () => void;
  onManage: (laneId: string) => void;
  selectLane: (id: string) => void;
}) {
  const ctxLane = lanesById.get(laneContextMenu.laneId) ?? null;
  return (
    <div
      className="fixed z-40 min-w-[190px] rounded bg-[--color-surface-overlay] border border-border/50 p-0.5 shadow-float"
      style={{ left: laneContextMenu.x, top: laneContextMenu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {ctxLane?.worktreePath ? (
        <>
          <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
            onClose();
            window.ade.app.revealPath(ctxLane.worktreePath).catch(() => {});
          }}>{revealLabel}</button>
          <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
            onClose();
            navigator.clipboard.writeText(ctxLane.worktreePath).catch(() => {});
          }}>Copy Path</button>
        </>
      ) : null}
      {ctxLane && ctxLane.laneType !== "primary" ? (
        <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
          const ctxLaneId = laneContextMenu.laneId;
          onClose();
          selectLane(ctxLaneId);
          onManage(ctxLaneId);
        }}>Manage Lane</button>
      ) : null}
    </div>
  );
}
