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

const menuHeaderStyle: React.CSSProperties = {
  padding: "5px 14px 3px",
  fontSize: 9,
  fontFamily: MONO_FONT,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: COLORS.textDim,
};

function HoverButton({ style, children, onClick }: { style: React.CSSProperties; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      style={style}
      onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function LaneContextMenu({
  laneContextMenu,
  lanesById,
  visibleLaneIds,
  onClose,
  onAdoptAttached,
  onManage,
  selectLane,
  onRemoveFromSplit,
  onCloseOtherSplits,
  onSelectAll,
  onBatchManage,
}: {
  laneContextMenu: { laneId: string; x: number; y: number };
  lanesById: Map<string, LaneSummary>;
  visibleLaneIds: string[];
  onClose: () => void;
  onAdoptAttached: (laneId: string) => void;
  onManage: (laneId: string) => void;
  selectLane: (id: string) => void;
  onRemoveFromSplit: (laneId: string) => void;
  onCloseOtherSplits: (keepLaneId: string) => void;
  onSelectAll: () => void;
  onBatchManage: (laneIds: string[]) => void;
}) {
  const ctxLane = lanesById.get(laneContextMenu.laneId) ?? null;
  const isInSplit = visibleLaneIds.includes(laneContextMenu.laneId);
  const splitCount = visibleLaneIds.length;
  const isPrimary = ctxLane?.laneType === "primary";
  const deletableVisibleIds = visibleLaneIds.filter((id) => {
    const lane = lanesById.get(id);
    return lane && lane.laneType !== "primary";
  });

  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  React.useEffect(() => {
    menuRef.current?.focus();
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      style={{
        position: "fixed",
        zIndex: 40,
        minWidth: 200,
        maxHeight: "calc(100vh - 20px)",
        overflowY: "auto",
        background: COLORS.cardBgSolid,
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: `1px solid ${COLORS.outlineBorder}`,
        borderRadius: 12,
        padding: "4px 0",
        boxShadow: "0 8px 32px -8px rgba(0,0,0,0.5)",
        left: laneContextMenu.x,
        top: Math.min(laneContextMenu.y, window.innerHeight - 20),
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {ctxLane?.worktreePath ? (
        <>
          <HoverButton
            style={menuItemStyle}
            onClick={() => {
              onClose();
              window.ade.app.revealPath(ctxLane.worktreePath).catch(() => {});
            }}
          >
            {revealLabel}
          </HoverButton>
          <HoverButton
            style={menuItemStyle}
            onClick={() => {
              onClose();
              navigator.clipboard.writeText(ctxLane.worktreePath).catch(() => {});
            }}
          >
            Copy Path
          </HoverButton>
        </>
      ) : null}

      {ctxLane && !isPrimary ? (
        <>
          <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
          {ctxLane.laneType === "attached" ? (
            <HoverButton
              style={menuItemStyle}
              onClick={() => {
                const ctxLaneId = laneContextMenu.laneId;
                onClose();
                selectLane(ctxLaneId);
                onAdoptAttached(ctxLaneId);
              }}
            >
              Move To .ade/worktrees
            </HoverButton>
          ) : null}
          <HoverButton
            style={menuItemStyle}
            onClick={() => {
              const ctxLaneId = laneContextMenu.laneId;
              onClose();
              selectLane(ctxLaneId);
              onManage(ctxLaneId);
            }}
          >
            Manage Lane
          </HoverButton>
        </>
      ) : null}

      {/* ── Split / multi-tab actions ── */}
      {splitCount > 1 || !isInSplit ? (
        <>
          <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
          <div style={menuHeaderStyle}>
            {splitCount > 1 ? `${splitCount} tabs open` : "Tabs"}
          </div>
        </>
      ) : null}

      {!isInSplit ? (
        <HoverButton
          style={menuItemStyle}
          onClick={() => {
            onClose();
            selectLane(laneContextMenu.laneId);
          }}
        >
          Open in Split
        </HoverButton>
      ) : null}

      {isInSplit && splitCount > 1 && !isPrimary ? (
        <HoverButton
          style={menuItemStyle}
          onClick={() => {
            onClose();
            onRemoveFromSplit(laneContextMenu.laneId);
          }}
        >
          Remove from Split
        </HoverButton>
      ) : null}

      {isInSplit && splitCount > 1 ? (
        <HoverButton
          style={menuItemStyle}
          onClick={() => {
            onClose();
            onCloseOtherSplits(laneContextMenu.laneId);
          }}
        >
          Close Other Tabs
        </HoverButton>
      ) : null}

      <HoverButton
        style={menuItemStyle}
        onClick={() => {
          onClose();
          onSelectAll();
        }}
      >
        Select All Lanes
      </HoverButton>

      {deletableVisibleIds.length > 1 ? (
        <>
          <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
          <HoverButton
            style={menuItemStyle}
            onClick={() => {
              onClose();
              onBatchManage(deletableVisibleIds);
            }}
          >
            Manage {deletableVisibleIds.length} Open Lanes...
          </HoverButton>
        </>
      ) : null}
    </div>
  );
}
