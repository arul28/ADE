import { memo, useCallback, useEffect, useState } from "react";

import type { DeleteLaneArgs } from "../../../shared/types";
import { createPendingLaneDeleteProgress } from "../../lib/laneDeleteProgress";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import {
  EMPTY_LANE_DELETE_SELECTION,
  ManageLaneDialog,
  type LaneDeleteSelection,
} from "../lanes/ManageLaneDialog";
import { AdoptAttachedLaneConfirmDialog } from "../lanes/AdoptAttachedLaneConfirmDialog";

export type WorkManageLaneDialogHostProps = {
  laneId: string | null;
  onClose: () => void;
};

export const WorkManageLaneDialogHost = memo(function WorkManageLaneDialogHost({
  laneId,
  onClose,
}: WorkManageLaneDialogHostProps) {
  const lanes = useAppStore((state) => state.lanes);
  const laneSnapshots = useAppStore((state) => state.laneSnapshots);
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const selectLane = useAppStore((state) => state.selectLane);
  const setDeleteProgressByLaneId = useAppStore((state) => state.setLaneDeleteProgressByLaneId);
  const lane = lanes.find((candidate) => candidate.id === laneId) ?? null;
  const chatSessionCount = laneId
    ? laneSnapshots.find((snapshot) => snapshot.lane.id === laneId)?.runtime.sessionCount
    : undefined;

  const [deleteSelection, setDeleteSelection] = useState<LaneDeleteSelection>(EMPTY_LANE_DELETE_SELECTION);
  const [deleteForce, setDeleteForce] = useState(true);
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | "adopt" | null>(null);
  const [adoptConfirmOpen, setAdoptConfirmOpen] = useState(false);

  useEffect(() => {
    if (laneId && !lane) onClose();
  }, [lane, laneId, onClose]);

  useEffect(() => {
    if (!laneId) {
      setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
      setDeleteForce(true);
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionError(null);
      setLaneActionKind(null);
      setAdoptConfirmOpen(false);
    }
  }, [laneId]);

  const runLaneAction = useCallback(async (
    fn: () => Promise<void>,
    status: string,
    kind: "archive" | "adopt",
  ) => {
    setLaneActionBusy(true);
    setLaneActionKind(kind);
    setLaneActionStatus(status);
    setLaneActionError(null);
    try {
      await fn();
      await refreshLanes({ includeStatus: false });
      onClose();
    } catch (error) {
      setLaneActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionKind(null);
    }
  }, [onClose, refreshLanes]);

  const handleAdopt = useCallback(() => {
    if (!lane || lane.laneType !== "attached") return;
    setLaneActionError(null);
    setAdoptConfirmOpen(true);
  }, [lane]);

  const confirmAdopt = useCallback(() => {
    if (!lane || lane.laneType !== "attached") return;
    void runLaneAction(async () => {
      const adopted = await window.ade.lanes.adoptAttached({ laneId: lane.id });
      selectLane(adopted.id);
    }, "Moving lane…", "adopt");
  }, [lane, runLaneAction, selectLane]);

  const handleArchive = useCallback(() => {
    if (!lane || lane.laneType === "primary") return;
    void runLaneAction(async () => {
      await window.ade.lanes.archive({ laneId: lane.id });
    }, "Archiving lane…", "archive");
  }, [lane, runLaneAction]);

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
    const pending = createPendingLaneDeleteProgress(lane.id);
    setDeleteProgressByLaneId((current) => ({ ...current, [lane.id]: pending }));
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
    onClose();

    void window.ade.lanes.delete(args).catch((error) => {
      setDeleteProgressByLaneId((current) => {
        if (current[lane.id]?.startedAt !== pending.startedAt) return current;
        const next = { ...current };
        delete next[lane.id];
        return next;
      });
      showToast({
        title: `Could not delete ${lane.name}`,
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
        durationMs: 0,
      });
    });
  }, [deleteForce, deleteSelection, lane, onClose, setDeleteProgressByLaneId]);

  if (!laneId || !lane) return null;

  return (
    <>
      <ManageLaneDialog
        open
        onOpenChange={(open) => { if (!open && !adoptConfirmOpen) onClose(); }}
        managedLane={lane}
        allLanes={lanes}
        deleteSelection={deleteSelection}
        setDeleteSelection={setDeleteSelection}
        deleteForce={deleteForce}
        setDeleteForce={setDeleteForce}
        chatSessionCount={chatSessionCount}
        laneActionBusy={laneActionBusy}
        laneActionStatus={laneActionStatus}
        laneActionError={laneActionError}
        laneActionKind={laneActionKind}
        onAdoptAttached={handleAdopt}
        onArchive={handleArchive}
        onDelete={handleDelete}
        onAppearanceChanged={() => refreshLanes({ includeStatus: false })}
        onStackReorganized={() => refreshLanes()}
      />
      <AdoptAttachedLaneConfirmDialog
        open={adoptConfirmOpen}
        lane={lane}
        busy={laneActionBusy}
        error={laneActionError}
        onCancel={() => {
          setAdoptConfirmOpen(false);
          setLaneActionError(null);
        }}
        onConfirm={confirmAdopt}
      />
    </>
  );
});
