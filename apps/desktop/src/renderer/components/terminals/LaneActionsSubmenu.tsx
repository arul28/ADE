import { useMemo } from "react";
import { useAppStore } from "../../state/appStore";
import { LaneMenuGroups, menuItemStyle } from "../lanes/LaneContextMenu";
import { buildLaneMenuGroups } from "../lanes/laneContextMenuItems";
import { COLORS } from "../lanes/laneDesignTokens";
import { MenuSubmenu } from "../ui/MenuSubmenu";
import { useLaneMenuActions } from "./useWorkLaneContextMenu";

/**
 * The lane menu, hosted as a submenu of a singleton lane's session menu.
 *
 * It renders `buildLaneMenuGroups` — the same definitions the lane divider's
 * own menu renders — rather than a transcription of them, and drives them with
 * `useLaneMenuActions`, the same wiring. Both halves are shared on purpose: the
 * previous design delegated to the real lane menu portal precisely so the two
 * could not disagree, and turning the row into a hover submenu must not buy
 * discoverability at the price of a second copy that silently falls behind.
 */
export function LaneActionsSubmenu({
  laneId,
  laneName,
  onClose,
  onManageLane,
  onFallbackOpen,
  triggerClassName,
  anchor,
}: {
  laneId: string;
  laneName: string;
  /** Closes the parent session menu. */
  onClose: () => void;
  /** Hands the lane off to the session menu's manage-dialog host. */
  onManageLane: (laneId: string) => void;
  /**
   * Escape hatch for a lane this renderer cannot resolve (a cross-machine row,
   * say): reopens the real lane menu at the session menu's anchor, exactly as
   * the pre-submenu row did.
   */
  onFallbackOpen: (position: { x: number; y: number }) => void;
  triggerClassName: string;
  anchor: { x: number; y: number };
}) {
  const lanes = useAppStore((s) => s.lanes);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const lanesById = useMemo(() => {
    const map = new Map<string, (typeof lanes)[number]>();
    for (const lane of lanes) map.set(lane.id, lane);
    return map;
  }, [lanes]);
  const lane = lanesById.get(laneId) ?? null;
  const actions = useLaneMenuActions({ close: onClose, onManageLane });

  const groups = useMemo(
    () => buildLaneMenuGroups({
      laneId,
      lane,
      lanesById,
      // The card's lane is the only one this menu can speak for, matching what
      // the Work sidebar passes its own lane menu.
      visibleLaneIds: [laneId],
      isRemoteProject,
      onClose,
      ...actions,
    }),
    [actions, isRemoteProject, lane, laneId, lanesById, onClose],
  );

  return (
    <MenuSubmenu
      data-testid="session-menu-lane-actions"
      label="Lane"
      hint={laneName}
      title={`Lane actions for ${laneName}`}
      className={triggerClassName}
      panelStyle={{ border: `1px solid ${COLORS.outlineBorder}`, padding: "4px 0" }}
      panelMinWidth={220}
    >
      {lane ? (
        <LaneMenuGroups groups={groups} />
      ) : (
        <button
          type="button"
          role="menuitem"
          style={menuItemStyle}
          onClick={() => { onClose(); onFallbackOpen(anchor); }}
        >
          Open lane menu…
        </button>
      )}
    </MenuSubmenu>
  );
}
