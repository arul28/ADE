import React from "react";
import type { LaneSummary } from "../../../shared/types";
import { revealLabel } from "../../lib/platform";
import { COLORS, MONO_FONT } from "./laneDesignTokens";
import { LANE_COLOR_PALETTE, colorsInUse } from "./laneColorPalette";

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

function HoverButton({
  style,
  children,
  onClick,
  dataTour,
}: {
  style: React.CSSProperties;
  children: React.ReactNode;
  onClick: () => void;
  dataTour?: string;
}) {
  return (
    <button
      role="menuitem"
      data-tour={dataTour}
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
  onOpenRun,
  selectLane,
  onRemoveFromSplit,
  onCloseOtherSplits,
  onSelectAll,
  onBatchManage,
  onAppearanceChanged,
}: {
  laneContextMenu: { laneId: string; x: number; y: number };
  lanesById: Map<string, LaneSummary>;
  visibleLaneIds: string[];
  onClose: () => void;
  onAdoptAttached: (laneId: string) => void;
  onManage: (laneId: string) => void;
  onOpenRun: (laneId: string) => void;
  selectLane: (id: string) => void;
  onRemoveFromSplit: (laneId: string) => void;
  onCloseOtherSplits: (keepLaneId: string) => void;
  onSelectAll: () => void;
  onBatchManage: (laneIds: string[]) => void;
  onAppearanceChanged?: () => void | Promise<void>;
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
      className="ade-liquid-glass-menu"
      style={{
        position: "fixed",
        zIndex: 40,
        minWidth: 200,
        maxHeight: "calc(100vh - 20px)",
        overflowY: "auto",
        border: `1px solid ${COLORS.outlineBorder}`,
        padding: "4px 0",
        left: laneContextMenu.x,
        top: Math.min(laneContextMenu.y, window.innerHeight - 20),
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {ctxLane?.worktreePath ? (
        <>
          <HoverButton
            style={menuItemStyle}
            dataTour="lanes.manageLane"
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
          <HoverButton
            style={menuItemStyle}
            onClick={() => {
              const ctxLaneId = laneContextMenu.laneId;
              onClose();
              selectLane(ctxLaneId);
              onOpenRun(ctxLaneId);
            }}
          >
            Open in Run
          </HoverButton>
        </>
      ) : null}

      {ctxLane ? (
        <>
          <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
          <div style={menuHeaderStyle}>Color</div>
          <ColorSwatchRow ctxLane={ctxLane} lanesById={lanesById} onChanged={onAppearanceChanged} />
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

function ColorSwatchRow({
  ctxLane,
  lanesById,
  onChanged,
}: {
  ctxLane: LaneSummary;
  lanesById: Map<string, LaneSummary>;
  onChanged?: () => void | Promise<void>;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const used = React.useMemo(() => colorsInUse(Array.from(lanesById.values()), ctxLane.id), [lanesById, ctxLane.id]);
  const currentLower = ctxLane.color?.toLowerCase() ?? null;

  const apply = async (next: string | null) => {
    setError(null);
    setBusy(true);
    try {
      await window.ade.lanes.updateAppearance({ laneId: ctxLane.id, color: next });
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set color");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "4px 12px 8px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {LANE_COLOR_PALETTE.map((entry) => {
          const isSelected = currentLower === entry.hex.toLowerCase();
          const isTaken = !isSelected && used.has(entry.hex.toLowerCase());
          return (
            <button
              key={entry.hex}
              type="button"
              title={isTaken ? `${entry.name} — in use` : entry.name}
              disabled={isTaken || busy}
              aria-label={entry.name}
              aria-pressed={isSelected}
              onClick={() => apply(entry.hex)}
              style={{
                width: 18,
                height: 18,
                borderRadius: 9999,
                backgroundColor: entry.hex,
                opacity: isTaken ? 0.25 : 1,
                cursor: isTaken ? "not-allowed" : "pointer",
                outline: isSelected ? `2px solid ${COLORS.textPrimary}` : "none",
                outlineOffset: 1,
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
                border: "none",
                padding: 0,
              }}
            />
          );
        })}
        {currentLower ? (
          <button
            type="button"
            title="Clear color"
            aria-label="Clear color"
            onClick={() => apply(null)}
            style={{
              width: 18,
              height: 18,
              borderRadius: 9999,
              backgroundColor: "transparent",
              cursor: "pointer",
              border: "1px dashed rgba(255,255,255,0.35)",
              padding: 0,
              color: "rgba(255,255,255,0.55)",
              fontSize: 10,
              lineHeight: "16px",
            }}
          >
            ✕
          </button>
        ) : null}
      </div>
      {error ? (
        <div style={{ marginTop: 6, fontSize: 10, color: "#f87171", fontFamily: MONO_FONT }}>{error}</div>
      ) : null}
    </div>
  );
}
