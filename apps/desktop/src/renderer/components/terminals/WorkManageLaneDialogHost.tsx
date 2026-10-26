import { memo, useCallback, useEffect, useState } from "react";

import type {
  DeleteLaneArgs,
  LaneSummary,
  OpenProjectBinding,
} from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { machineIdForBinding } from "../../../shared/machineIdentity";
import { createPendingLaneDeleteProgress } from "../../lib/laneDeleteProgress";
import { useAppStore } from "../../state/appStore";
import {
  confirmForeignLaneDeleted,
  requestCrossMachineLanesForMachine,
  waitForForeignLaneToLeave,
} from "../../state/crossMachineLanes";
import { isRemoteOutcomeUnknownError } from "../../../shared/runtimeErrors";
import { foreignLaneKey } from "../../state/laneMachineRouting";
import { showToast } from "../app/toast/toastStore";
import {
  EMPTY_LANE_DELETE_SELECTION,
  ManageLaneDialog,
  type LaneDeleteSelection,
} from "../lanes/ManageLaneDialog";

/**
 * How long a deleted lane on another machine keeps its deleting state while that
 * machine is re-read. The lane normally leaves the list within about a second;
 * this bound keeps a stalled or failed re-read from holding the state forever.
 */
const FOREIGN_LANE_DELETE_SETTLE_MS = 15_000;

export type WorkManageLaneDialogHostProps = {
  laneId: string | null;
  lane?: LaneSummary;
  runtimePin?: OpenProjectBinding;
  onClose: () => void;
};

export const WorkManageLaneDialogHost = memo(function WorkManageLaneDialogHost({
  laneId,
  lane: pinnedLane,
  runtimePin,
  onClose,
}: WorkManageLaneDialogHostProps) {
  const lanes = useAppStore((state) => state.lanes);
  const laneSnapshots = useAppStore((state) => state.laneSnapshots);
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const setDeleteProgressByLaneId = useAppStore((state) => state.setLaneDeleteProgressByLaneId);
  const [pinnedLanes, setPinnedLanes] = useState<LaneSummary[]>(() => pinnedLane ? [pinnedLane] : []);
  const [pinnedLanesLoaded, setPinnedLanesLoaded] = useState(false);
  const allLanes = runtimePin ? pinnedLanes : lanes;
  const lane = allLanes.find((candidate) => candidate.id === laneId)
    ?? (runtimePin && !pinnedLanesLoaded && pinnedLane?.id === laneId ? pinnedLane : null);
  const chatSessionCount = !runtimePin && laneId
    ? laneSnapshots.find((snapshot) => snapshot.lane.id === laneId)?.runtime.sessionCount
    : undefined;

  const [deleteSelection, setDeleteSelection] = useState<LaneDeleteSelection>(EMPTY_LANE_DELETE_SELECTION);
  const [deleteForce, setDeleteForce] = useState(false);
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | null>(null);

  const refreshManagedLanes = useCallback(async (options?: { includeStatus?: boolean }) => {
    if (!runtimePin) {
      await refreshLanes(options);
      return;
    }
    const next = await window.ade.lanes.list(
      { includeStatus: options?.includeStatus ?? true },
      runtimePin,
    );
    setPinnedLanes(next);
    setPinnedLanesLoaded(true);
  }, [refreshLanes, runtimePin]);

  useEffect(() => {
    if (!runtimePin) {
      setPinnedLanes([]);
      setPinnedLanesLoaded(false);
      return;
    }
    setPinnedLanes(pinnedLane ? [pinnedLane] : []);
    setPinnedLanesLoaded(false);
    void refreshManagedLanes({ includeStatus: true }).catch((error) => {
      setLaneActionError(error instanceof Error ? error.message : String(error));
    });
  }, [pinnedLane, refreshManagedLanes, runtimePin]);

  useEffect(() => {
    if (laneId && !lane && (!runtimePin || pinnedLanesLoaded)) onClose();
  }, [lane, laneId, onClose, pinnedLanesLoaded, runtimePin]);

  useEffect(() => {
    if (!laneId) {
      setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
      setDeleteForce(false);
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionError(null);
      setLaneActionKind(null);
    }
  }, [laneId]);

  const runLaneAction = useCallback(async (
    fn: () => Promise<void>,
    status: string,
  ): Promise<boolean> => {
    setLaneActionBusy(true);
    setLaneActionKind("archive");
    setLaneActionStatus(status);
    setLaneActionError(null);
    try {
      await fn();
      await refreshManagedLanes({ includeStatus: false });
      onClose();
      return true;
    } catch (error) {
      setLaneActionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionKind(null);
    }
  }, [onClose, refreshManagedLanes]);

  const handleArchive = useCallback(async (): Promise<boolean> => {
    if (!lane || lane.laneType === "primary") return false;
    return await runLaneAction(async () => {
      if (runtimePin) {
        await window.ade.lanes.archive({ laneId: lane.id }, runtimePin);
      } else {
        await window.ade.lanes.archive({ laneId: lane.id });
      }
    }, "Archiving lane…");
  }, [lane, runLaneAction, runtimePin]);

  const handleDelete = useCallback(() => {
    if (!lane || lane.laneType === "primary") return;
    if (!deleteSelection.worktree && !deleteSelection.localBranch && !deleteSelection.remoteBranch) return;

    const args: DeleteLaneArgs = {
      laneId: lane.id,
      force: deleteForce,
      deleteBranch: deleteSelection.localBranch,
      ...(deleteSelection.remoteBranch
        ? { deleteRemoteBranch: true, remoteName: "origin" }
        : {}),
    };
    // A lane on another machine is keyed the way the Work sidebar names it, so its
    // card and open chat find the entry. A bare id would belong to this machine's lane.
    const machineId = runtimePin ? machineIdForBinding(runtimePin) : null;
    const progressKey = machineId ? foreignLaneKey(machineId, lane.id) : lane.id;
    const pending = createPendingLaneDeleteProgress(progressKey);
    setDeleteProgressByLaneId((current) => ({ ...current, [progressKey]: pending }));
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
    onClose();

    const clearPending = () => {
      setDeleteProgressByLaneId((current) => {
        if (current[progressKey]?.startedAt !== pending.startedAt) return current;
        const next = { ...current };
        delete next[progressKey];
        return next;
      });
    };
    const deletion = runtimePin
      ? window.ade.lanes.delete(args, runtimePin)
      : window.ade.lanes.delete(args);
    void deletion.then(
      () => {
        // A local delete ends on `lanes.delete.event`, which useWorkLaneDeleteProgress
        // reads and clears once its own refresh settles. Another machine has no such
        // feed on this tab, so its entry stays until a re-read of that machine no
        // longer lists the lane, or until the bound runs out.
        if (!machineId) return;
        requestCrossMachineLanesForMachine(machineId);
        return waitForForeignLaneToLeave(machineId, lane.id, FOREIGN_LANE_DELETE_SETTLE_MS)
          .then(clearPending);
      },
      async (error: unknown) => {
        // The answer was lost, not the delete: keep the row "deleting" while
        // that machine is checked, and a lane that left was deleted after all.
        if (machineId && isRemoteOutcomeUnknownError(error) && await confirmForeignLaneDeleted(machineId, lane.id)) {
          clearPending();
          return;
        }
        clearPending();
        showToast({
          title: `Could not delete ${lane.name}`,
          message: stripElectronErrorWrapper(error instanceof Error ? error.message : String(error)),
          tone: "error",
          durationMs: 0,
        });
        // Re-read the machine so the sidebar shows what a failed delete left behind.
        if (machineId) requestCrossMachineLanesForMachine(machineId);
      },
    );
  }, [deleteForce, deleteSelection, lane, onClose, runtimePin, setDeleteProgressByLaneId]);

  if (!laneId || !lane) return null;

  return (
    <ManageLaneDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      managedLane={lane}
      allLanes={allLanes}
      runtimePin={runtimePin}
      deleteSelection={deleteSelection}
      setDeleteSelection={setDeleteSelection}
      deleteForce={deleteForce}
      setDeleteForce={setDeleteForce}
      chatSessionCount={chatSessionCount}
      laneActionBusy={laneActionBusy}
      laneActionStatus={laneActionStatus}
      laneActionError={laneActionError}
      laneActionKind={laneActionKind}
      onArchive={handleArchive}
      onDelete={handleDelete}
      onAppearanceChanged={() => refreshManagedLanes({ includeStatus: false })}
      onStackReorganized={() => refreshManagedLanes()}
    />
  );
});
