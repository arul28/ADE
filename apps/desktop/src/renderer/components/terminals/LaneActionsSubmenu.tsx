import { useMemo } from "react";
import { GitBranch } from "@phosphor-icons/react";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { LaneMenuGlyph, buildLaneMenuGroups } from "../lanes/laneContextMenuItems";
import { LaneMenuGroups, menuItemStyle } from "../lanes/LaneContextMenu";
import { COLORS } from "../lanes/laneDesignTokens";
import { MenuSubmenu } from "../ui/MenuSubmenu";
import { useLaneMenuActions } from "./useWorkLaneContextMenu";
import { resolveOpenInTarget } from "../../../shared/editorTargets";
import { machineIdForBinding } from "../../../shared/machineIdentity";

/**
 * The lane menu, hosted as a submenu of a singleton lane's session menu.
 *
 * It renders `buildLaneMenuGroups` — the same definitions the lane divider's
 * own menu renders — rather than a transcription of them, and drives them with
 * `useLaneMenuActions`, the same wiring. Both halves are shared on purpose: the
 * previous design delegated to the real lane menu portal precisely so the two
 * could not disagree, and turning the row into a hover submenu must not buy
 * discoverability at the price of a second copy that silently falls behind.
 *
 * A foreign singleton passes its `lane` + `binding` in because that lane is
 * not in this renderer's store. The fallback button remains only for a lane
 * that still cannot be resolved at all.
 */
export function LaneActionsSubmenu({
  laneId,
  laneName,
  lane: laneProp = null,
  binding = null,
  machineId = null,
  onClose,
  onManageLane,
  onFallbackOpen,
  triggerClassName,
  anchor,
  onToggleWorkPin,
  workPinnedLaneIds,
  workPinLaneId,
}: {
  laneId: string;
  laneName: string;
  lane?: LaneSummary | null;
  binding?: OpenProjectBinding | null;
  machineId?: string | null;
  /** Closes the parent session menu. */
  onClose: () => void;
  /** Hands the lane off to the session menu's manage-dialog host. */
  onManageLane: (
    laneId: string,
    extras?: { lane?: LaneSummary; binding?: OpenProjectBinding | null },
  ) => void;
  /**
   * Escape hatch for a lane this renderer cannot resolve: reopens the real
   * lane menu at the session menu's anchor.
   */
  onFallbackOpen: (position: { x: number; y: number }) => void;
  triggerClassName: string;
  anchor: { x: number; y: number };
  onToggleWorkPin?: (laneId: string) => void;
  workPinnedLaneIds?: string[];
  workPinLaneId?: string;
}) {
  const lanes = useAppStore((s) => s.lanes);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const projectBinding = useAppStore((s) => s.projectBinding);
  const lanesById = useMemo(() => {
    const map = new Map<string, (typeof lanes)[number]>();
    for (const lane of lanes) map.set(lane.id, lane);
    return map;
  }, [lanes]);
  const lane = laneProp ?? lanesById.get(laneId) ?? null;
  const menuLanesById = useMemo(() => {
    if (!lane || lanesById.has(lane.id)) return lanesById;
    const map = new Map(lanesById);
    map.set(lane.id, lane);
    return map;
  }, [lane, lanesById]);
  const boundMachineId = machineIdForBinding(projectBinding);
  const startChatMachineId = machineId
    ?? (binding?.kind === "remote" ? binding.targetId : null);
  const isForeignLane = Boolean(
    startChatMachineId && startChatMachineId !== boundMachineId,
  );
  const actions = useLaneMenuActions({
    close: onClose,
    onManageLane: (id) => onManageLane(id, {
      ...(lane ? { lane } : {}),
      ...(binding ? { binding } : {}),
    }),
  });

  const groups = useMemo(() => {
    const openIn = resolveOpenInTarget({
      worktreePath: lane?.worktreePath,
      binding: binding ?? projectBinding,
    });
    return buildLaneMenuGroups({
      laneId,
      lane,
      lanesById: menuLanesById,
      visibleLaneIds: [laneId],
      isRemoteProject: isRemoteProject || binding?.kind === "remote",
      onClose,
      ...actions,
      onStartChatInLane: (id) => actions.onStartChatInLane(id, { machineId: startChatMachineId }),
      onToggleWorkPin,
      workPinnedLaneIds,
      workPinLaneId,
      ...(openIn ? { openIn } : {}),
      runtimePin: binding,
      omitTabActions: isForeignLane,
    });
  }, [
    actions,
    binding,
    isForeignLane,
    isRemoteProject,
    lane,
    laneId,
    menuLanesById,
    onClose,
    onToggleWorkPin,
    projectBinding,
    startChatMachineId,
    workPinLaneId,
    workPinnedLaneIds,
  ]);

  return (
    <MenuSubmenu
      data-testid="session-menu-lane-actions"
      role="menuitem"
      label="Lane"
      icon={<LaneMenuGlyph icon={GitBranch} />}
      hint={laneName}
      title={`Lane actions for ${laneName}`}
      className={triggerClassName}
      panelStyle={{ border: `1px solid ${COLORS.outlineBorder}`, padding: "4px 0" }}
      panelMinWidth={220}
    >
      {lane ? (
        <LaneMenuGroups groups={groups} onClose={onClose} />
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
