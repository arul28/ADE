import type { LaneSummary, OpenProjectBinding } from "../../../../shared/types";
import { resolveOpenInTarget } from "../../../../shared/editorTargets";
import { useAppStore } from "../../../state/appStore";
import { LaneMenuGroups } from "../LaneContextMenu";
import { buildLaneMenuGroups, type LaneMenuArgs } from "../laneContextMenuItems";
import { PointMenu } from "./PointMenu";

const noop = () => {};

/**
 * Right-click menu for a sidebar row. Same groups as every other lane menu,
 * minus the split/tab entries the Lanes tab no longer has. A row inside a
 * multi-selection opens `LaneSidebarBulkContextMenu` instead, so this menu
 * always acts on its one lane.
 */
export function LaneSidebarContextMenu({
  menu,
  lanesById,
  onClose,
  onManage,
  selectLane,
  onAppearanceChanged,
  onStartChatInLane,
  onOpenHistory,
  runtimePin = null,
}: {
  menu: { laneId: string; x: number; y: number };
  lanesById: Map<string, LaneSummary>;
  onClose: () => void;
  onManage: (laneId: string) => void;
  selectLane: (laneId: string) => void;
  onAppearanceChanged: () => void | Promise<void>;
  onStartChatInLane: (laneId: string) => void;
  onOpenHistory?: (laneId: string) => void;
  /**
   * The lane's machine when it is not the tab's. `menu.laneId` and `lanesById`
   * are then that machine's own ids, and every write the menu makes is pinned
   * there. Reveal is not offered: it resolves the lane on the tab's machine.
   */
  runtimePin?: OpenProjectBinding | null;
}) {
  const boundIsRemote = useAppStore((s) => s.projectBinding?.kind === "remote");
  const projectBinding = useAppStore((s) => s.projectBinding);
  const isRemoteProject = runtimePin ? true : boundIsRemote;
  const lane = lanesById.get(menu.laneId) ?? null;
  const openIn = resolveOpenInTarget({ worktreePath: lane?.worktreePath, binding: runtimePin ?? projectBinding });
  const args: LaneMenuArgs = {
    laneId: menu.laneId,
    lane,
    lanesById,
    visibleLaneIds: [],
    isRemoteProject,
    runtimePin,
    onClose,
    onManage,
    selectLane,
    onRemoveFromSplit: noop,
    onCloseOtherSplits: noop,
    onSelectAll: noop,
    onBatchManage: noop,
    onAppearanceChanged,
    onStartChatInLane,
    ...(onOpenHistory ? { onOpenHistory } : {}),
    omitTabActions: true,
    ...(openIn ? { openIn } : {}),
  };

  return (
    <PointMenu
      point={{ x: menu.x, y: menu.y }}
      remeasureKey={`${menu.laneId}:${lane?.id ?? ""}`}
      testId="lane-sidebar-context-menu"
      minWidth={200}
      maxHeight="calc(100vh - 20px)"
      onClose={onClose}
    >
      <LaneMenuGroups groups={buildLaneMenuGroups(args)} onClose={onClose} />
    </PointMenu>
  );
}
