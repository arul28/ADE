import React from "react";
import type { LaneSummary } from "../../../shared/types";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { ContextMenuSurface } from "../ui/ContextMenu";
import { useAppStore } from "../../state/appStore";
import { useTabCopyPin } from "../../state/repositoryScope";
import { MenuSubmenu } from "../ui/MenuSubmenu";
import { COLORS, SANS_FONT } from "./laneDesignTokens";
import {
  buildLaneMenuGroups,
  LaneMenuGlyph,
  laneMenuHeaderStyle,
  type LaneMenuArgs,
  type LaneMenuEntry,
  type LaneMenuGroup,
} from "./laneContextMenuItems";
import { OpenInSubmenu } from "../ui/OpenInSubmenu";
import { resolveOpenInTarget } from "../../../shared/editorTargets";
import { useLaneShareMenu } from "../laneShare/useLaneShareMenu";

export const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 12px",
  textAlign: "left",
  fontSize: 12,
  fontFamily: SANS_FONT,
  whiteSpace: "nowrap",
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
function LaneMenuEntryView({
  entry,
  onClose,
}: {
  entry: LaneMenuEntry;
  onClose: () => void;
}) {
  switch (entry.kind) {
    case "custom":
      return <>{entry.node}</>;
    case "open-in":
      return (
        <OpenInSubmenu
          rootPath={entry.rootPath}
          remote={entry.remote}
          pin={entry.pin ?? null}
          onClose={onClose}
          style={submenuTriggerStyle}
          hoverBackground={COLORS.hoverBg}
        />
      );
    case "action":
      return (
        <HoverButton
          style={menuItemStyle}
          dataTour={entry.dataTour}
          onClick={entry.onSelect}
        >
          {entry.icon ? <LaneMenuGlyph icon={entry.icon} /> : null}
          {entry.label}
        </HoverButton>
      );
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

export function LaneMenuGroups({
  groups,
  onClose,
}: {
  groups: LaneMenuGroup[];
  onClose: () => void;
}) {
  return (
    <>
      {groups.map((group, index) => (
        <React.Fragment key={group.key}>
          {index > 0 && !group.joinPrevious ? (
            <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
          ) : null}
          {group.submenu ? (
            <MenuSubmenu
              role="menuitem"
              label={group.label ?? ""}
              icon={group.icon ? <LaneMenuGlyph icon={group.icon} /> : undefined}
              style={submenuTriggerStyle}
              hoverBackground={COLORS.hoverBg}
              panelStyle={{ border: `1px solid ${COLORS.outlineBorder}`, padding: "4px 0" }}
              panelMinWidth={220}
            >
              {group.entries.map((entry) => (
                <LaneMenuEntryView key={entry.key} entry={entry} onClose={onClose} />
              ))}
            </MenuSubmenu>
          ) : (
            <>
              {group.label ? <div style={laneMenuHeaderStyle}>{group.label}</div> : null}
              {group.entries.map((entry) => (
                <LaneMenuEntryView key={entry.key} entry={entry} onClose={onClose} />
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
  onOpenHistory,
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
  /** History's commit graph on the lane. */
  onOpenHistory?: (laneId: string) => void;
  workPinnedLaneIds?: string[];
}) {
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  // This menu lists the lanes of the tab's copy, so their machine is that copy.
  const lanePin = useTabCopyPin();
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

  // Keyboard users start on the first item, once the panel is placed (a
  // hidden panel cannot take focus).
  const menuPlaced = menuPosition != null;
  React.useEffect(() => {
    if (!menuPlaced) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]), button:not([disabled])')?.focus();
  }, [menuPlaced, menuRef]);

  const openInTarget = lanePin ? resolveOpenInTarget({ worktreePath: ctxLane?.worktreePath, binding: lanePin }) : null;
  const openIn = openInTarget ? { ...openInTarget, pin: lanePin } : null;
  const share = useLaneShareMenu({ laneId: ctxLane?.id ?? null, laneName: ctxLane?.name ?? null, pin: lanePin });
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
    ...(onOpenHistory ? { onOpenHistory } : {}),
    ...(workPinnedLaneIds ? { workPinnedLaneIds } : {}),
    ...(openIn ? { openIn } : {}),
    share,
  };

  return (
    <ContextMenuSurface
      menuRef={menuRef}
      role="menu"
      label={ctxLane ? `${ctxLane.name} actions` : "Lane actions"}
      left={menuPosition?.left ?? laneContextMenu.x}
      top={menuPosition?.top ?? laneContextMenu.y}
      positioned={menuPosition != null}
      onClose={onClose}
      className="min-w-[200px] max-h-[calc(100vh-20px)] overflow-y-auto"
    >
      <LaneMenuGroups groups={buildLaneMenuGroups(args)} onClose={onClose} />
    </ContextMenuSurface>
  );
}
