import React, { useCallback, useState } from "react";
import { CreateMissionDialog, type CreateDraft, type CreateMissionDefaults } from "./CreateMissionDialog";
import { closeMissionCreateDialog, resetMissionCreateDialog, useMissionCreateDialogStore } from "./missionCreateDialogStore";

type MissionCreateDialogHostProps = {
  lanes: Array<{ id: string; name: string }>;
  defaultLaneId?: string | null;
  missionDefaults?: CreateMissionDefaults | null;
  onLaunch: (draft: CreateDraft) => Promise<void>;
};

export const MissionCreateDialogHost = React.memo(function MissionCreateDialogHost({
  lanes,
  defaultLaneId,
  missionDefaults,
  onLaunch,
}: MissionCreateDialogHostProps) {
  const open = useMissionCreateDialogStore((state) => state.open);
  const resetVersion = useMissionCreateDialogStore((state) => state.resetVersion);
  const [busy, setBusy] = useState(false);

  const handleClose = useCallback(() => {
    if (busy) return;
    closeMissionCreateDialog();
  }, [busy]);

  const handleLaunch = useCallback(async (draft: CreateDraft) => {
    setBusy(true);
    try {
      await onLaunch(draft);
      resetMissionCreateDialog();
    } finally {
      setBusy(false);
    }
  }, [onLaunch]);

  if (!open && !busy) {
    return null;
  }

  return (
    <CreateMissionDialog
      open={open}
      onClose={handleClose}
      onLaunch={handleLaunch}
      busy={busy}
      lanes={lanes}
      defaultLaneId={defaultLaneId}
      missionDefaults={missionDefaults}
      resetVersion={resetVersion}
    />
  );
});
