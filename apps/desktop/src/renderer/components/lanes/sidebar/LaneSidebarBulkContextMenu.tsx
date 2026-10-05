import { Archive, ArrowsClockwise, Copy, Gear, GitBranch, Trash, X } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../../shared/types";
import { showToast } from "../../app/toast/toastStore";
import { LaneMenuGroups } from "../LaneContextMenu";
import type { LaneMenuEntry, LaneMenuGroup } from "../laneContextMenuItems";
import type { LaneGroupBulkAction } from "./laneSidebarModel";
import { PointMenu } from "./PointMenu";

/**
 * Right-click menu for a multi-selection in the Lanes sidebar. It acts on every
 * selected lane, local or on another machine; the batch dialogs split the
 * selection per machine. The counts are the lanes the actions will touch:
 * the primary lane, unreachable machines and lanes being deleted are left out.
 */
export function LaneSidebarBulkContextMenu({
  point,
  laneIds,
  actionableLaneIds,
  lanesById,
  onClose,
  onManage,
  onBulkAction,
  onClearSelection,
}: {
  point: { x: number; y: number };
  /** Selected row keys, in selection order. */
  laneIds: string[];
  /** The selection filtered to what Manage/Rebase/Archive/Delete act on. */
  actionableLaneIds: string[];
  lanesById: Map<string, LaneSummary>;
  onClose: () => void;
  onManage: (laneIds: string[]) => void;
  onBulkAction: (action: LaneGroupBulkAction, laneIds: string[]) => void;
  onClearSelection: () => void;
}) {
  const lanes = laneIds.flatMap((id) => {
    const lane = lanesById.get(id);
    return lane ? [{ id, lane }] : [];
  });
  const count = actionableLaneIds.length;
  const act = (run: () => void) => () => { onClose(); run(); };
  const copy = (text: string, what: string) => () => {
    onClose();
    void navigator.clipboard.writeText(text).catch(() => {
      showToast({ title: `Could not copy ${what}`, tone: "error" });
    });
  };

  const manageEntries: LaneMenuEntry[] = count
    ? [
        { kind: "action", key: "manage", label: `Manage ${count} lane${count === 1 ? "" : "s"}…`, icon: Gear, onSelect: act(() => onManage(actionableLaneIds)) },
        { kind: "action", key: "rebase", label: `Rebase ${count}`, icon: ArrowsClockwise, onSelect: act(() => onBulkAction("rebase", actionableLaneIds)) },
        { kind: "action", key: "archive", label: `Archive ${count}…`, icon: Archive, onSelect: act(() => onBulkAction("archive", actionableLaneIds)) },
        { kind: "action", key: "delete", label: `Delete ${count}…`, icon: Trash, onSelect: act(() => onBulkAction("delete", actionableLaneIds)) },
      ]
    : [];
  const selectionEntries: LaneMenuEntry[] = [
    { kind: "action", key: "copy-names", label: "Copy lane names", icon: Copy, onSelect: copy(lanes.map(({ lane }) => lane.name).join("\n"), "lane names") },
    { kind: "action", key: "copy-branches", label: "Copy branches", icon: GitBranch, onSelect: copy(lanes.map(({ lane }) => lane.branchRef).join("\n"), "branches") },
    { kind: "action", key: "clear", label: "Clear selection", icon: X, onSelect: act(onClearSelection) },
  ];
  // The header heads whichever group comes first.
  const header = `${lanes.length} lanes selected`;
  const groups: LaneMenuGroup[] = manageEntries.length
    ? [{ key: "manage", label: header, entries: manageEntries }, { key: "selection", entries: selectionEntries }]
    : [{ key: "selection", label: header, entries: selectionEntries }];

  return (
    <PointMenu
      point={point}
      remeasureKey={laneIds.join(",")}
      testId="lane-sidebar-bulk-context-menu"
      minWidth={200}
      maxHeight="calc(100vh - 20px)"
      onClose={onClose}
    >
      <LaneMenuGroups groups={groups} onClose={onClose} />
    </PointMenu>
  );
}
