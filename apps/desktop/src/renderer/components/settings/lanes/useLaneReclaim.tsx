import React from "react";
import type { LaneReclaimRisk, OpenProjectBinding } from "../../../../shared/types";
import { showToast } from "../../app/toast/toastStore";
import { ReclaimConfirmDialog } from "../storage/ReclaimConfirmDialog";
import { formatBytes } from "../storage/storageView";

const RECLAIM_TOAST_ID = "settings-lane-reclaim";

/**
 * Archive & reclaim one lane through the existing confirm: ADE reads the
 * lane's risk first (uncommitted files, unpushed commits, running work), the
 * dialog shows it and asks for a typed confirmation, and uncommitted files
 * need a separate acknowledgement. Every call goes to `pin`'s machine.
 *
 * Returns `open(laneId)` and the dialog to render.
 */
export function useLaneReclaim(pin: OpenProjectBinding | null, onDone: () => void) {
  const [risk, setRisk] = React.useState<LaneReclaimRisk | null>(null);
  const [confirm, setConfirm] = React.useState("");
  const [discardDirty, setDiscardDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const open = React.useCallback(async (laneId: string) => {
    try {
      const next = await window.ade.lanes.getReclaimRisk({ laneId }, pin);
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
      }, pin);
      showToast({
        id: RECLAIM_TOAST_ID,
        tone: "success",
        title: `Archived ${risk.laneName}, freed ${formatBytes(result.reclaimedBytes)}`,
        message: "The branch and chats were kept. Restore it from the archive.",
      });
      setRisk(null);
      setConfirm("");
      setDiscardDirty(false);
      onDone();
    } catch (err) {
      showToast({ id: RECLAIM_TOAST_ID, tone: "error", title: err instanceof Error ? err.message : "Could not archive this lane" });
    } finally {
      setBusy(false);
    }
  }, [confirm, discardDirty, onDone, pin, risk]);

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
