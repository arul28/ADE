import { memo, useCallback, useMemo, useState } from "react";
import { usePrRuntimePin } from "../state/prMachines";

import type { DeleteLaneArgs, LaneSummary } from "../../../../shared/types";
import {
  ManageLaneDialog,
  EMPTY_LANE_DELETE_SELECTION,
  type LaneActionError,
  type LaneDeleteSelection,
} from "../../lanes/ManageLaneDialog";
import { extractError } from "../../../lib/format";
import { useAppStore } from "../../../state/appStore";
import { requestCrossMachineLanesForMachine, useLanesForPin } from "../../../state/crossMachineLanes";
import { machineIdForBinding } from "../../../../shared/machineIdentity";
import { useCloudLaneDelete } from "../../cloudLane/deleteCloudLane";
import { requirePin } from "../../../state/repositoryScope";

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
  // The lane lives where the PR's runtime pin says; archive/delete run there.
  const runtimePin = usePrRuntimePin();
  // A pinned lane is resolved (parent, stack, children) against its own
  // machine's lanes only; the tab machine may hold a same-id lane.
  const ownerLanes = useLanesForPin(runtimePin);
  const dialogLanes = ownerLanes ?? lanes;
  const refreshOwnerLanes = useCallback(() => {
    if (runtimePin) requestCrossMachineLanesForMachine(machineIdForBinding(runtimePin));
    else void refreshLanes({ includeStatus: false });
  }, [refreshLanes, runtimePin]);

  const [deleteSelection, setDeleteSelection] = useState<LaneDeleteSelection>(EMPTY_LANE_DELETE_SELECTION);
  const [deleteForce, setDeleteForce] = useState(false);
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<LaneActionError | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | null>(null);

  const runLaneAction = useCallback(async (
    fn: () => Promise<void>,
    status: string,
    kind: "delete" | "archive",
  ): Promise<boolean> => {
    setLaneActionBusy(true);
    setLaneActionKind(kind);
    setLaneActionStatus(status);
    setLaneActionError(null);
    try {
      await fn();
      // Another machine's lane list lives in the union, not this tab's store.
      if (runtimePin) requestCrossMachineLanesForMachine(machineIdForBinding(runtimePin));
      else await refreshLanes({ includeStatus: false });
      onOpenChange(false);
      return true;
    } catch (err) {
      setLaneActionError({ message: extractError(err), kind: "failure" });
      return false;
    } finally {
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionKind(null);
    }
  }, [onOpenChange, refreshLanes, runtimePin]);

  const handleArchive = useCallback(async () => {
    if (!lane || lane.laneType === "primary") return false;
    return await runLaneAction(async () => {
      await window.ade.lanes.archive({ laneId: lane.id }, requirePin(runtimePin));
    }, "Archiving lane…", "archive");
  }, [lane, runLaneAction, runtimePin]);

  // A lane on its own ADE Cloud computer gets the cloud delete.
  const cloud = useCloudLaneDelete();
  const handleDelete = useCallback(async () => {
    if (!lane || lane.laneType === "primary") return;

    // An ADE Cloud lane goes with its computer: one account-level delete, warned only when work isn't on GitHub.
    if (cloud.deleteIfCloudLane({ pin: runtimePin, laneId: lane.id, laneName: lane.name, machineId: null, onDeleted: refreshOwnerLanes })) {
      setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
      onOpenChange(false);
      return;
    }
    // A local lane deletes only what was picked.
    if (!deleteSelection.worktree && !deleteSelection.localBranch && !deleteSelection.remoteBranch) return;
    const args: DeleteLaneArgs = { laneId: lane.id, force: deleteForce };
    args.deleteBranch = deleteSelection.localBranch;
    if (deleteSelection.remoteBranch) {
      args.deleteRemoteBranch = true;
      args.remoteName = "origin";
    }

    await runLaneAction(async () => {
      await window.ade.lanes.delete(args, requirePin(runtimePin));
    }, "Deleting lane…", "delete");
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
  }, [cloud, deleteForce, deleteSelection, lane, onOpenChange, refreshOwnerLanes, runLaneAction, runtimePin]);

  // A lane on its own ADE Cloud computer gets the cloud delete: nothing to pick, no Force gate.
  const cloudLaneIds = useMemo(
    () => (lane && cloud.isCloudLane(runtimePin, lane.id) ? new Set([lane.id]) : null),
    [cloud, lane, runtimePin],
  );

  if (!open || !lane) return null;

  return (
    <ManageLaneDialog
      open={open}
      onOpenChange={onOpenChange}
      managedLane={lane}
      allLanes={dialogLanes}
      runtimePin={runtimePin}
      cloudLaneIds={cloudLaneIds}
      deleteSelection={deleteSelection}
      setDeleteSelection={setDeleteSelection}
      deleteForce={deleteForce}
      setDeleteForce={setDeleteForce}
      laneActionBusy={laneActionBusy}
      laneActionStatus={laneActionStatus}
      laneActionError={laneActionError}
      laneActionKind={laneActionKind}
      onArchive={handleArchive}
      onDelete={() => { void handleDelete(); }}
      onAppearanceChanged={refreshOwnerLanes}
    />
  );
});

export default PrManageLaneDialogHost;
