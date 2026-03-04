import React from "react";
import type { LaneSummary } from "../../../shared/types";
import { revealLabel } from "../../lib/platform";
import { COLORS, MONO_FONT } from "./laneDesignTokens";

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "7px 14px",
  textAlign: "left",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  transition: "background 100ms",
};

export function LaneContextMenu({
  laneContextMenu,
  lanesById,
  onClose,
  onAdoptAttached,
  onManage,
  selectLane
}: {
  laneContextMenu: { laneId: string; x: number; y: number };
  lanesById: Map<string, LaneSummary>;
  onClose: () => void;
  onAdoptAttached: (laneId: string) => void;
  onManage: (laneId: string) => void;
  selectLane: (id: string) => void;
}) {
  const ctxLane = lanesById.get(laneContextMenu.laneId) ?? null;
  return (
    <div
      style={{
        position: "fixed",
        zIndex: 40,
        minWidth: 200,
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        padding: "4px 0",
        boxShadow: "0 8px 32px -8px rgba(0,0,0,0.5)",
        left: laneContextMenu.x,
        top: laneContextMenu.y,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {ctxLane?.worktreePath ? (
        <>
          <button
            style={menuItemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.border; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            onClick={() => {
              onClose();
              window.ade.app.revealPath(ctxLane.worktreePath).catch(() => {});
            }}
          >
            {revealLabel}
          </button>
          <button
            style={menuItemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.border; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            onClick={() => {
              onClose();
              navigator.clipboard.writeText(ctxLane.worktreePath).catch(() => {});
            }}
          >
            Copy Path
          </button>
        </>
      ) : null}
      {ctxLane && ctxLane.laneType !== "primary" ? (
        <>
          <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
          {ctxLane.laneType === "attached" ? (
            <button
              style={menuItemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.border; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              onClick={() => {
                const ctxLaneId = laneContextMenu.laneId;
                onClose();
                selectLane(ctxLaneId);
                onAdoptAttached(ctxLaneId);
              }}
            >
              Move To .ade/worktrees
            </button>
          ) : null}
          <button
            style={menuItemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.border; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            onClick={() => {
              const ctxLaneId = laneContextMenu.laneId;
              onClose();
              selectLane(ctxLaneId);
              onManage(ctxLaneId);
            }}
          >
            Manage Lane
          </button>
        </>
      ) : null}
    </div>
  );
}
