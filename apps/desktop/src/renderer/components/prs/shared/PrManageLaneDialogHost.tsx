import { memo, useCallback, useState } from "react";

import type { DeleteLaneArgs, LaneSummary } from "../../../../shared/types";
import { ManageLaneDialog } from "../../lanes/ManageLaneDialog";
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

  const [deleteMode, setDeleteMode] = useState<"worktree" | "local_branch" | "remote_branch">("worktree");
  const [deleteRemoteName, setDeleteRemoteName] = useState("origin");
  const [deleteForce, setDeleteForce] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | "adopt" | null>(null);

  const deletePhrase = lane ? `delete ${lane.name}` : "";

  const runLaneAction = useCallback(async (
    fn: () => Promise<void>,
    status: string,
    kind: "delete" | "archive" | "adopt",
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
    if (deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()) return;

    const args: DeleteLaneArgs = { laneId: lane.id, force: deleteForce };
    if (deleteMode === "worktree") {
      args.deleteBranch = false;
    } else {
      args.deleteBranch = true;
      if (deleteMode === "remote_branch") {
        args.deleteRemoteBranch = true;
        args.remoteName = deleteRemoteName.trim() || "origin";
      }
    }

    await runLaneAction(async () => {
      await window.ade.lanes.delete(args);
    }, "Deleting lane…", "delete");
    setDeleteConfirmText("");
  }, [deleteConfirmText, deleteForce, deleteMode, deletePhrase, deleteRemoteName, lane, runLaneAction]);

  if (!open || !lane) return null;

  return (
    <ManageLaneDialog
      open={open}
      onOpenChange={onOpenChange}
      managedLane={lane}
      allLanes={lanes}
      deleteMode={deleteMode}
      setDeleteMode={setDeleteMode}
      deleteRemoteName={deleteRemoteName}
      setDeleteRemoteName={setDeleteRemoteName}
      deleteForce={deleteForce}
      setDeleteForce={setDeleteForce}
      deleteConfirmText={deleteConfirmText}
      setDeleteConfirmText={setDeleteConfirmText}
      deletePhrase={deletePhrase}
      laneActionBusy={laneActionBusy}
      laneActionStatus={laneActionStatus}
      laneActionError={laneActionError}
      laneActionKind={laneActionKind}
      onAdoptAttached={() => {}}
      onArchive={() => { void handleArchive(); }}
      onDelete={() => { void handleDelete(); }}
      onAppearanceChanged={() => { void refreshLanes({ includeStatus: false }); }}
      onStackReorganized={() => { void refreshLanes(); }}
    />
  );
});

export default PrManageLaneDialogHost;
