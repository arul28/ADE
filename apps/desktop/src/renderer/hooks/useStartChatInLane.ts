import { useCallback } from "react";
import type { WorkProjectViewState } from "../state/appStore";
import { startChatDraftPatch } from "../lib/workDraft";

type WorkViewStateUpdater = (
  projectRoot: string,
  next: WorkProjectViewState | ((prev: WorkProjectViewState) => WorkProjectViewState),
) => void;

export function useStartChatInLane({
  projectStateKey,
  setWorkViewState,
  selectLane,
  navigate,
}: {
  projectStateKey: string | null;
  setWorkViewState: WorkViewStateUpdater;
  selectLane: (laneId: string) => void;
  navigate: (path: string) => void | Promise<void>;
}) {
  return useCallback(
    (laneId: string) => {
      if (!projectStateKey) return;
      setWorkViewState(projectStateKey, (prev) => ({
        ...prev,
        ...startChatDraftPatch(laneId),
      }));
      selectLane(laneId);
      void navigate("/work");
    },
    [navigate, projectStateKey, selectLane, setWorkViewState],
  );
}
