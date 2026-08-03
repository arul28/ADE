import { memo, useCallback, useState } from "react";

import type { DeleteLaneArgs, LaneSummary } from "../../../../shared/types";
import {
  ManageLaneDialog,
  EMPTY_LANE_DELETE_SELECTION,
  type LaneDeleteSelection,
} from "../../lanes/ManageLaneDialog";
import { useAppStore } from "../../../state/appStore";

export type PrManageLaneDialogHostProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: LaneSummary | null;
};

export const PrManageLaneDialogHost = memo(function PrManageLaneDialogHost({
  open,
  onOpenChange,
  lane,
}: PrManageLaneDialogHostProps) {
  const lanes = useAppStore((state) => state.lanes ?? []);
  const refreshLanes = useAppStore((state) => state.refreshLanes);

  const [deleteSelection, setDeleteSelection] = useState<LaneDeleteSelection>(EMPTY_LANE_DELETE_SELECTION);
  const [deleteForce, setDeleteForce] = useState(true);
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | null>(null);

  const runLaneAction = useCallback(async (
    fn: () => Promise<void>,
    status: string,
    kind: "delete" | "archive",
  ) => {
    setLaneActionBusy(true);
    setLaneActionKind(kind);
    setLaneActionStatus(status);
    setLaneActionError(null);
    try {
      await fn();
      await refreshLanes({ includeStatus: false });
      onOpenChange(false);
    } catch (err) {
      setLaneActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionKind(null);
    }
  }, [onOpenChange, refreshLanes]);

  const handleArchive = useCallback(async () => {
    if (!lane || lane.laneType === "primary") return;
    await runLaneAction(async () => {
      await window.ade.lanes.archive({ laneId: lane.id });
    }, "Archiving lane…", "archive");
  }, [lane, runLaneAction]);

  const handleDelete = useCallback(async () => {
    if (!lane || lane.laneType === "primary") return;
    if (!deleteSelection.worktree && !deleteSelection.localBranch && !deleteSelection.remoteBranch) return;

    const args: DeleteLaneArgs = { laneId: lane.id, force: deleteForce };
    args.deleteBranch = deleteSelection.localBranch;
    if (deleteSelection.remoteBranch) {
      args.deleteRemoteBranch = true;
      args.remoteName = "origin";
    }

    await runLaneAction(async () => {
      await window.ade.lanes.delete(args);
    }, "Deleting lane…", "delete");
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
  }, [deleteForce, deleteSelection, lane, runLaneAction]);

  if (!open || !lane) return null;

  return (
    <ManageLaneDialog
      open={open}
      onOpenChange={onOpenChange}
      managedLane={lane}
      allLanes={lanes}
      deleteSelection={deleteSelection}
      setDeleteSelection={setDeleteSelection}
      deleteForce={deleteForce}
      setDeleteForce={setDeleteForce}
      laneActionBusy={laneActionBusy}
      laneActionStatus={laneActionStatus}
      laneActionError={laneActionError}
      laneActionKind={laneActionKind}
      onArchive={() => { void handleArchive(); }}
      onDelete={() => { void handleDelete(); }}
      onAppearanceChanged={() => { void refreshLanes({ includeStatus: false }); }}
      onStackReorganized={() => { void refreshLanes(); }}
    />
  );
});

export default PrManageLaneDialogHost;
