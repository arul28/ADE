import { useCallback, useEffect, useRef } from "react";
import type { LaneSummary } from "../../../shared/types";
import type { MachineLane } from "../../state/laneMachineRouting";
import { foreignLaneKey } from "../../state/laneMachineRouting";
import { useAppStore, useAppStoreApi } from "../../state/appStore";
import {
  readForeignLaneSelection,
  setForeignLaneSelection,
  useForeignLaneSelection,
} from "../lanes/useLanesPageMachines";

/**
 * Keep History's focused lane and the lane list held beside it (the Lanes or
 * Work sidebar) on one selection. The list's selection is the store's lane on
 * this machine, or the Lanes list's row key (`machineId:laneId`) for a lane on
 * another machine. `sidebarLaneRef` is the selection the two last agreed on, so
 * each side only reacts to a change the other did not make.
 */
export function useHistoryLaneSync({
  active,
  projectStateKey,
  focusLaneId,
  focusLaneMachineId,
  setFocusLane,
  onLanePicked,
  lanes,
  lanesByKey,
}: {
  active: boolean;
  projectStateKey: string | null;
  focusLaneId: string | null;
  focusLaneMachineId: string | null;
  setFocusLane: (laneId: string | null, machineId: string | null) => void;
  /** A lane switch closes a full-page diff of the previous lane's commit. */
  onLanePicked: () => void;
  /** This machine's lanes. */
  lanes: LaneSummary[];
  /** Every machine's lane rows, keyed by row key. */
  lanesByKey: ReadonlyMap<string, MachineLane>;
}): void {
  const appStoreApi = useAppStoreApi();
  const selectLane = useAppStore((s) => s.selectLane);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const foreignListKey = useForeignLaneSelection(projectStateKey);
  const readListSelection = useCallback(
    () => readForeignLaneSelection(projectStateKey) ?? appStoreApi.getState().selectedLaneId,
    [appStoreApi, projectStateKey],
  );
  const sidebarLaneRef = useRef<string | null>(null);
  if (sidebarLaneRef.current === null) {
    sidebarLaneRef.current = foreignListKey ?? selectedLaneId ?? "";
  }

  // History's lane → the list's highlight.
  useEffect(() => {
    if (!active || !focusLaneId) return;
    if (focusLaneMachineId) {
      const key = foreignLaneKey(focusLaneMachineId, focusLaneId);
      sidebarLaneRef.current = key;
      setForeignLaneSelection(projectStateKey, key);
      return;
    }
    sidebarLaneRef.current = focusLaneId;
    setForeignLaneSelection(projectStateKey, null);
    if (appStoreApi.getState().selectedLaneId !== focusLaneId) selectLane(focusLaneId);
  }, [active, appStoreApi, focusLaneId, focusLaneMachineId, projectStateKey, selectLane]);

  // A lane picked in the list → History shows it (and the URL follows).
  useEffect(() => {
    if (!active) return;
    // Read live: the effect above may have just moved the selection to the
    // lane a URL focused, and this render's value is the one it replaced.
    const picked = readListSelection();
    if ((picked ?? "") === sidebarLaneRef.current) return;
    if (!picked) {
      sidebarLaneRef.current = "";
      return;
    }
    let target: { laneId: string; machineId: string | null } | null = null;
    if (lanes.some((lane) => lane.id === picked)) {
      target = { laneId: picked, machineId: null };
    } else {
      const row = lanesByKey.get(picked);
      if (row) target = { laneId: row.lane.id, machineId: row.isActiveBinding ? null : row.machineId };
    }
    // Not listed yet (another machine still reporting): retried when it is.
    if (!target) return;
    sidebarLaneRef.current = picked;
    if (target.laneId !== focusLaneId || target.machineId !== focusLaneMachineId) {
      setFocusLane(target.laneId, target.machineId);
      onLanePicked();
    }
  }, [
    active,
    focusLaneId,
    focusLaneMachineId,
    foreignListKey,
    lanes,
    lanesByKey,
    onLanePicked,
    readListSelection,
    selectedLaneId,
    setFocusLane,
  ]);
}
