import React from "react";
import type { LaneSummary } from "../../../shared/types";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { useAppStore } from "../../state/appStore";
import { MenuSubmenu } from "../ui/MenuSubmenu";
import { COLORS, MONO_FONT } from "./laneDesignTokens";
import {
  buildLaneMenuGroups,
  laneMenuHeaderStyle,
  type LaneMenuArgs,
  type LaneMenuGroup,
} from "./laneContextMenuItems";

export const menuItemStyle: React.CSSProperties = {
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

/** Same row, laid out for a trailing chevron instead of a plain label. */
const submenuTriggerStyle: React.CSSProperties = {
  ...menuItemStyle,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

export function HoverButton({
  style,
  children,
  onClick,
  dataTour,
  disabled = false,
}: {
  style: React.CSSProperties;
  children: React.ReactNode;
  onClick: () => void;
  dataTour?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      data-tour={dataTour}
      disabled={disabled}
      style={{
        ...style,
        ...(disabled ? { cursor: "not-allowed", opacity: 0.4 } : {}),
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Renders one grouped block of the lane menu. Shared by the lane divider's menu
 * and by the "Lane ▸" submenu on a singleton lane's session card, so both read
 * the same groups out of `buildLaneMenuGroups`.
 */
export function LaneMenuGroups({ groups }: { groups: LaneMenuGroup[] }) {
  return (
    <>
      {groups.map((group, index) => (
        <React.Fragment key={group.key}>
          {index > 0 ? (
            <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
          ) : null}
          {group.submenu ? (
            <MenuSubmenu
              role="menuitem"
              label={group.label ?? ""}
              style={submenuTriggerStyle}
              hoverBackground={COLORS.hoverBg}
              panelStyle={{ border: `1px solid ${COLORS.outlineBorder}`, padding: "4px 0" }}
              panelMinWidth={220}
            >
              {group.entries.map((entry) => (
                entry.kind === "custom"
                  ? <React.Fragment key={entry.key}>{entry.node}</React.Fragment>
                  : (
                    <HoverButton
                      key={entry.key}
                      style={menuItemStyle}
                      dataTour={entry.dataTour}
                      onClick={entry.onSelect}
                    >
                      {entry.label}
                    </HoverButton>
                  )
              ))}
            </MenuSubmenu>
          ) : (
            <>
              {group.label ? <div style={laneMenuHeaderStyle}>{group.label}</div> : null}
              {group.entries.map((entry) => (
                entry.kind === "custom"
                  ? <React.Fragment key={entry.key}>{entry.node}</React.Fragment>
                  : (
                    <HoverButton
                      key={entry.key}
                      style={menuItemStyle}
                      dataTour={entry.dataTour}
                      onClick={entry.onSelect}
                    >
                      {entry.label}
                    </HoverButton>
                  )
              ))}
            </>
          )}
        </React.Fragment>
      ))}
    </>
  );
}

export function LaneContextMenu({
  laneContextMenu,
  lanesById,
  visibleLaneIds,
  onClose,
  onManage,
  selectLane,
  onRemoveFromSplit,
  onCloseOtherSplits,
  onSelectAll,
  onBatchManage,
  onAppearanceChanged,
  onStartChatInLane,
  onToggleWorkPin,
  workPinnedLaneIds,
}: {
  laneContextMenu: { laneId: string; x: number; y: number };
  lanesById: Map<string, LaneSummary>;
  visibleLaneIds: string[];
  onClose: () => void;
  onManage: (laneId: string) => void;
  selectLane: (id: string) => void;
  onRemoveFromSplit: (laneId: string) => void;
  onCloseOtherSplits: (keepLaneId: string) => void;
  onSelectAll: () => void;
  onBatchManage: (laneIds: string[]) => void;
  onAppearanceChanged?: () => void | Promise<void>;
  onStartChatInLane?: (laneId: string) => void;
  /** Work-sidebar pin (separate from the Lanes tab's own pins). */
  onToggleWorkPin?: (laneId: string) => void;
  workPinnedLaneIds?: string[];
}) {
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const ctxLane = lanesById.get(laneContextMenu.laneId) ?? null;

  const { ref: menuRef, position: menuPosition } = useClampedFixedPosition(
    { x: laneContextMenu.x, y: laneContextMenu.y },
    `${laneContextMenu.laneId}:${ctxLane?.id ?? ""}`,
  );

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

  const args: LaneMenuArgs = {
    laneId: laneContextMenu.laneId,
    lane: ctxLane,
    lanesById,
    visibleLaneIds,
    isRemoteProject,
    onClose,
    onManage,
    selectLane,
    onRemoveFromSplit,
    onCloseOtherSplits,
    onSelectAll,
    onBatchManage,
    ...(onAppearanceChanged ? { onAppearanceChanged } : {}),
    ...(onStartChatInLane ? { onStartChatInLane } : {}),
    ...(onToggleWorkPin ? { onToggleWorkPin } : {}),
    ...(workPinnedLaneIds ? { workPinnedLaneIds } : {}),
  };

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
        left: menuPosition?.left ?? laneContextMenu.x,
        top: menuPosition?.top ?? laneContextMenu.y,
        visibility: menuPosition ? "visible" : "hidden",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <LaneMenuGroups groups={buildLaneMenuGroups(args)} />
    </div>
  );
}
