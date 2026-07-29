import { memo, useCallback, useEffect, useState } from "react";

import type {
  DeleteLaneArgs,
  LaneSummary,
  OpenProjectBinding,
} from "../../../shared/types";
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
  const selectLane = useAppStore((state) => state.selectLane);
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
  const [deleteForce, setDeleteForce] = useState(true);
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | "adopt" | null>(null);
  const [adoptConfirmOpen, setAdoptConfirmOpen] = useState(false);

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
      await refreshManagedLanes({ includeStatus: false });
      onClose();
    } catch (error) {
      setLaneActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionKind(null);
    }
  }, [onClose, refreshManagedLanes]);

  const handleAdopt = useCallback(() => {
    if (!lane || lane.laneType !== "attached") return;
    setLaneActionError(null);
    setAdoptConfirmOpen(true);
  }, [lane]);

  const confirmAdopt = useCallback(() => {
    if (!lane || lane.laneType !== "attached") return;
    void runLaneAction(async () => {
      const adopted = runtimePin
        ? await window.ade.lanes.adoptAttached({ laneId: lane.id }, runtimePin)
        : await window.ade.lanes.adoptAttached({ laneId: lane.id });
      if (!runtimePin) selectLane(adopted.id);
    }, "Moving lane…", "adopt");
  }, [lane, runLaneAction, runtimePin, selectLane]);

  const handleArchive = useCallback(() => {
    if (!lane || lane.laneType === "primary") return;
    void runLaneAction(async () => {
      if (runtimePin) {
        await window.ade.lanes.archive({ laneId: lane.id }, runtimePin);
      } else {
        await window.ade.lanes.archive({ laneId: lane.id });
      }
    }, "Archiving lane…", "archive");
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
    const pending = createPendingLaneDeleteProgress(lane.id);
    if (!runtimePin) {
      setDeleteProgressByLaneId((current) => ({ ...current, [lane.id]: pending }));
    }
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
    onClose();

    const deletion = runtimePin
      ? window.ade.lanes.delete(args, runtimePin)
      : window.ade.lanes.delete(args);
    void deletion.catch((error) => {
      if (runtimePin) {
        showToast({
          title: `Could not delete ${lane.name}`,
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
          durationMs: 0,
        });
        return;
      }
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
  }, [deleteForce, deleteSelection, lane, onClose, runtimePin, setDeleteProgressByLaneId]);

  if (!laneId || !lane) return null;

  return (
    <>
      <ManageLaneDialog
        open
        onOpenChange={(open) => { if (!open && !adoptConfirmOpen) onClose(); }}
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
        onAdoptAttached={handleAdopt}
        onArchive={handleArchive}
        onDelete={handleDelete}
        onAppearanceChanged={() => refreshManagedLanes({ includeStatus: false })}
        onStackReorganized={() => refreshManagedLanes()}
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
