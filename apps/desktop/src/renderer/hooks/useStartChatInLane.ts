import { useCallback } from "react";
import type { WorkProjectViewState } from "../state/appStore";
import { chatDraftMachineId, startChatDraftPatch } from "../lib/workDraft";

type WorkViewStateUpdater = (
  projectRoot: string,
  next: WorkProjectViewState | ((prev: WorkProjectViewState) => WorkProjectViewState),
) => void;

export type StartChatInLaneOptions = {
  /** Owning machine id. Omitted/bound-machine values stay on this tab's lanes. */
  machineId?: string | null;
};

export function useStartChatInLane({
  projectStateKey,
  setWorkViewState,
  selectLane,
  navigate,
  boundMachineId,
}: {
  projectStateKey: string | null;
  setWorkViewState: WorkViewStateUpdater;
  selectLane: (laneId: string) => void;
  navigate: (path: string) => void | Promise<void>;
  boundMachineId: string;
}) {
  return useCallback(
    (laneId: string, options?: StartChatInLaneOptions) => {
      if (!projectStateKey) return;
      const draftMachineId = chatDraftMachineId(options?.machineId, boundMachineId);
      setWorkViewState(projectStateKey, (prev) => ({
        ...prev,
        ...startChatDraftPatch(laneId, draftMachineId),
      }));
      // A foreign lane id is not in this tab's lane list; selecting it would
      // steal the local selection without making the draft find that lane.
      if (!draftMachineId) selectLane(laneId);
      void navigate("/work");
    },
    [boundMachineId, navigate, projectStateKey, selectLane, setWorkViewState],
  );
}
