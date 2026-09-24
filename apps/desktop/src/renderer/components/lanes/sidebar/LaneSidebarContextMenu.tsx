import React from "react";
import { createPortal } from "react-dom";
import type { LaneSummary } from "../../../../shared/types";
import { resolveOpenInTarget } from "../../../../shared/editorTargets";
import { useClampedFixedPosition } from "../../../hooks/useClampedFixedPosition";
import { useAppStore } from "../../../state/appStore";
import { LaneMenuGroups } from "../LaneContextMenu";
import { buildLaneMenuGroups, type LaneMenuArgs } from "../laneContextMenuItems";
import { COLORS } from "../laneDesignTokens";

const noop = () => {};

/**
 * Right-click menu for a sidebar row. Same groups as every other lane menu,
 * minus the split/tab entries the Lanes tab no longer has. When the clicked
 * lane is part of a multi-selection, "Manage N lanes" acts on all of them.
 */
export function LaneSidebarContextMenu({
  menu,
  lanesById,
  selectedLaneIds,
  onClose,
  onManage,
  onBatchManage,
  selectLane,
  onAppearanceChanged,
  onStartChatInLane,
}: {
  menu: { laneId: string; x: number; y: number };
  lanesById: Map<string, LaneSummary>;
  /** Lanes the batch entry acts on (the multi-selection, or empty). */
  selectedLaneIds: string[];
  onClose: () => void;
  onManage: (laneId: string) => void;
  onBatchManage: (laneIds: string[]) => void;
  selectLane: (laneId: string) => void;
  onAppearanceChanged: () => void | Promise<void>;
  onStartChatInLane: (laneId: string) => void;
}) {
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const projectBinding = useAppStore((s) => s.projectBinding);
  const lane = lanesById.get(menu.laneId) ?? null;
  const { ref: menuRef, position } = useClampedFixedPosition(
    { x: menu.x, y: menu.y },
    `${menu.laneId}:${lane?.id ?? ""}`,
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const onPointerDown = () => onClose();
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  React.useEffect(() => {
    menuRef.current?.focus();
  }, [menuRef]);

  const openIn = resolveOpenInTarget({ worktreePath: lane?.worktreePath, binding: projectBinding });
  const args: LaneMenuArgs = {
    laneId: menu.laneId,
    lane,
    lanesById,
    visibleLaneIds: selectedLaneIds.includes(menu.laneId) ? selectedLaneIds : [],
    isRemoteProject,
    onClose,
    onManage,
    selectLane,
    onRemoveFromSplit: noop,
    onCloseOtherSplits: noop,
    onSelectAll: noop,
    onBatchManage,
    onAppearanceChanged,
    onStartChatInLane,
    omitTabActions: true,
    ...(openIn ? { openIn } : {}),
  };

  // Portaled to the body so no scrolling or transformed parent can clip or
  // offset the menu.
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      data-testid="lane-sidebar-context-menu"
      className="ade-liquid-glass-menu"
      style={{
        position: "fixed",
        zIndex: 40,
        minWidth: 200,
        maxHeight: "calc(100vh - 20px)",
        overflowY: "auto",
        border: `1px solid ${COLORS.outlineBorder}`,
        padding: "4px 0",
        left: position?.left ?? menu.x,
        top: position?.top ?? menu.y,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <LaneMenuGroups groups={buildLaneMenuGroups(args)} onClose={onClose} />
    </div>,
    document.body,
  );
}
