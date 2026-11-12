import React from "react";
import type { LaneReclaimRisk, OpenProjectBinding } from "../../../../shared/types";
import { showToast } from "../../app/toast/toastStore";
import { ReclaimConfirmDialog } from "../storage/ReclaimConfirmDialog";
import { useStorageBytes } from "../storage/useStorageBytes";
import { captureLaneSetupAnalytics } from "../../../lib/laneSetupAnalytics";
import { requirePin } from "../../../state/repositoryScope";

const RECLAIM_TOAST_ID = "settings-lane-reclaim";

/**
 * Archive & reclaim one lane through the existing confirm: ADE reads the
 * lane's risk first (uncommitted files, unpushed commits, running work), the
 * dialog shows it and asks for a typed confirmation, and uncommitted files
 * need a separate acknowledgement. Every call goes to `pin`'s machine.
 *
 * Returns `open(laneId)` and the dialog to render. `alreadyArchived`: the
 * lanes are in the archive (Settings → Archive's Free up space), so the
 * result says what was freed rather than that the lane was archived.
 */
export function useLaneReclaim(
  pin: OpenProjectBinding | null,
  onDone: () => void,
  opts: { alreadyArchived?: boolean } = {},
) {
  const alreadyArchived = opts.alreadyArchived === true;
  const { bytes: storageBytes } = useStorageBytes();
  const [risk, setRisk] = React.useState<LaneReclaimRisk | null>(null);
  const [confirm, setConfirm] = React.useState("");
  const [discardDirty, setDiscardDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const open = React.useCallback(async (laneId: string) => {
    try {
      const next = await window.ade.lanes.getReclaimRisk({ laneId }, requirePin(pin));
      setConfirm("");
      setDiscardDirty(false);
      setRisk(next);
    } catch (err) {
      showToast({ id: RECLAIM_TOAST_ID, tone: "error", title: err instanceof Error ? err.message : "Could not review this lane" });
    }
  }, [pin]);

  const run = React.useCallback(async () => {
    if (!risk || confirm !== "RECLAIM" || (risk.dirty && !discardDirty)) return;
    setBusy(true);
    try {
      const result = await window.ade.lanes.archiveAndReclaim({
        laneId: risk.laneId,
        confirmation: "RECLAIM",
        ...(risk.dirty && discardDirty ? { forceDirty: true } : {}),
      }, requirePin(pin));
      showToast(result.keptForRetry
        ? {
            id: RECLAIM_TOAST_ID,
            tone: "info",
            title: alreadyArchived ? `Kept ${risk.laneName}'s folder for now` : `Archived ${risk.laneName}`,
            message: "Some files in its folder are still in use, so ADE kept the folder and will remove it on its own later.",
          }
        : {
            id: RECLAIM_TOAST_ID,
            tone: "success",
            title: alreadyArchived
              ? `Freed up ${storageBytes(result.reclaimedBytes)} from ${risk.laneName}`
              : `Archived ${risk.laneName}, freed ${storageBytes(result.reclaimedBytes)}`,
            message: "The branch and chats were kept. Restore it from the archive.",
          });
      if (alreadyArchived) captureLaneSetupAnalytics({ action: "space_freed", outcome: "completed" });
      setRisk(null);
      setConfirm("");
      setDiscardDirty(false);
      onDone();
    } catch (err) {
      if (alreadyArchived) captureLaneSetupAnalytics({ action: "space_freed", outcome: "failed" });
      showToast({ id: RECLAIM_TOAST_ID, tone: "error", title: err instanceof Error ? err.message : "Could not archive this lane" });
    } finally {
      setBusy(false);
    }
  }, [alreadyArchived, confirm, discardDirty, onDone, pin, risk, storageBytes]);

  const dialog = risk ? (
    <ReclaimConfirmDialog
      risk={risk}
      busy={busy}
      value={confirm}
      discardDirtyConfirmed={discardDirty}
      onChange={setConfirm}
      onDiscardDirtyChange={setDiscardDirty}
      onClose={() => {
        if (!busy) {
          setRisk(null);
          setDiscardDirty(false);
        }
      }}
      onConfirm={() => void run()}
    />
  ) : null;

  return { open, dialog };
}
