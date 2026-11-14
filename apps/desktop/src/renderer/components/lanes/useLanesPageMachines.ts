import { useCallback, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { useRootAppStore } from "../../state/appStore";
import { useTabCopyPin } from "../../state/repositoryScope";
import {
  createLaneMachineRouter,
  machineBlockedReason,
  machineChipFor,
  shouldShowMachineChips,
  useAllMachineLanes,
  type MachineChipModel,
  type MachineLane,
} from "../../state/laneMachineRouting";
import { SAVED_CHATS_MACHINE_PREFIX } from "../../../shared/cloudSavedChats";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { useMachineLabelForMachine } from "../cloudLane/useMachineLabelForMachine";
import { wakeRestingCloudMachine } from "../../lib/cloudMachineWake";
import { machineIsCloudResting } from "../../state/cloudRestingRows";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";

/**
 * A lane on another machine is selected here, never in the store's
 * `selectedLaneId`: other tabs read that id as a lane on the tab's machine, and
 * a foreign row key (or a foreign lane id that happens to exist here too) must
 * not leak into them. Kept per project across remounts of the route, and
 * shared with History, which shows the lane the Lanes list has selected.
 */
const useForeignLaneSelectionStore = create<{ byProject: Record<string, string | null> }>(() => ({ byProject: {} }));

/** The foreign row key (`machineId:laneId`) the Lanes list has selected, or null. */
export function useForeignLaneSelection(projectStateKey: string | null): string | null {
  return useForeignLaneSelectionStore((state) => state.byProject[projectStateKey ?? ""] ?? null);
}

export function readForeignLaneSelection(projectStateKey: string | null): string | null {
  return useForeignLaneSelectionStore.getState().byProject[projectStateKey ?? ""] ?? null;
}

export function setForeignLaneSelection(projectStateKey: string | null, key: string | null): void {
  const projectKey = projectStateKey ?? "";
  if (readForeignLaneSelection(projectStateKey) === key) return;
  useForeignLaneSelectionStore.setState((state) => ({ byProject: { ...state.byProject, [projectKey]: key } }));
}

/** Where one row's lane lives: its real id on its machine, and the pin to use. */
export type LaneTarget =
  /**
   * `pin` addresses the lane's copy, the tab's own included. `machineId` is
   * null for the tab's own machine: only another machine's rows carry one.
   */
  | { ok: true; laneId: string; pin: OpenProjectBinding; machineId: string | null; name: string }
  | { ok: false; reason: string };

export type ForeignLaneModel = {
  /** Row key (`machineId:laneId`) → the machine's lane. */
  rowByKey: ReadonlyMap<string, MachineLane>;
  /** Foreign lanes as page rows: `id` is the row key. */
  viewLanes: LaneSummary[];
  /** Each other machine's own lane records, real ids. */
  realLanesByMachineId: ReadonlyMap<string, LaneSummary[]>;
};

/**
 * The Lanes tab's view of every machine: one flat list of rows across
 * machines, the page's selection (which may be a lane on another machine),
 * the machine filter chips, and the one resolver every lane action goes
 * through (`resolveLaneTarget`).
 *
 * Foreign lanes enter the page's lane model as copies whose `id` is the row
 * key (`machineId:laneId`). A row key is never a lane id on any machine, so a code path that forgets to
 * route one fails as "lane not found" instead of hitting a same-id lane on the
 * tab's machine. Every real call for a foreign row goes through
 * `resolveLaneTarget` → the lane's real id + its machine's pin.
 */
export function useLanesPageMachines({
  active,
  projectStateKey,
  localLanes,
  storeSelectedLaneId,
  storeSelectLane,
}: {
  active: boolean;
  projectStateKey: string | null;
  /** The tab machine's lanes, deduped by id. */
  localLanes: LaneSummary[];
  storeSelectedLaneId: string | null;
  storeSelectLane: (laneId: string | null) => void;
}) {
  // Mounting this while the tab is visible keeps the shared cross-machine union
  // refreshing (ref-counted, no new loop).
  // `buildAllMachineLanes` leaves out the computers that are gone from the account.
  const allMachineLanes = useAllMachineLanes(active);
  const allMachineLanesRef = useRef(allMachineLanes);
  allMachineLanesRef.current = allMachineLanes;
  // ADE Cloud computers the account no longer has (`computerGone`, decided by
  // the account's computer list): their lanes live only as saved chats, listed
  // once in the "deleted computers" place (`CloudLanesOnDeletedComputers`),
  // never among the live lanes or as a machine chip.
  const crossMachineEntries = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const goneMachineKey = useMemo(
    () => Object.values(crossMachineEntries ?? {}).filter((entry) => entry.computerGone === true).map((entry) => entry.machineId).sort().join("\u0000"),
    [crossMachineEntries],
  );
  const goneMachineIds = useMemo(() => new Set(goneMachineKey ? goneMachineKey.split("\u0000") : []), [goneMachineKey]);
  // ADE Cloud computers that are only asleep: their lanes are listed as normal
  // rows, and opening one wakes the computer. Any other machine that is
  // offline after its short reconnect window is not listed at all.
  const { computers: cloudLaneComputers } = useAdeCloudLaneComputers();
  const restingMachineKey = useMemo(
    () => Object.values(crossMachineEntries ?? {})
      .filter((entry) => machineIsCloudResting(entry, cloudLaneComputers))
      .map((entry) => entry.machineId).sort().join("\u0000"),
    [cloudLaneComputers, crossMachineEntries],
  );
  const restingMachineIds = useMemo(() => new Set(restingMachineKey ? restingMachineKey.split("\u0000") : []), [restingMachineKey]);

  const foreignLanes = useMemo<ForeignLaneModel>(() => {
    const rowByKey = new Map<string, MachineLane>();
    const viewLanes: LaneSummary[] = [];
    const realLanesByMachineId = new Map<string, LaneSummary[]>();
    for (const row of allMachineLanes.lanes) {
      if (row.isActiveBinding) continue;
      if (goneMachineIds.has(row.machineId)) continue;
      if (!row.online && !restingMachineIds.has(row.machineId)) continue;
      rowByKey.set(row.key, row);
      const machineLanes = realLanesByMachineId.get(row.machineId);
      if (machineLanes) machineLanes.push(row.lane);
      else realLanesByMachineId.set(row.machineId, [row.lane]);
    }
    for (const row of rowByKey.values()) {
      viewLanes.push({ ...row.lane, id: row.key });
    }
    return { rowByKey, viewLanes, realLanesByMachineId };
  }, [allMachineLanes, goneMachineIds, restingMachineIds]);
  const foreignRowByKey = foreignLanes.rowByKey;
  const foreignRowByKeyRef = useRef(foreignRowByKey);
  foreignRowByKeyRef.current = foreignRowByKey;
  const activeMachine = allMachineLanes.machines[0] ?? null;
  const activeMachineId = activeMachine?.machineId ?? null;
  /**
   * The pin of the tab's own lanes (the rows from the tab's copy): that
   * machine's address from the router. Null while the copy is offline or no
   * project is open; then nothing is sent for those rows.
   */
  // The union carries no slice for the tab's own machine, so its `online`
  // stays true after that machine drops. The tab's copy pin follows the
  // connection, and is null while that machine is offline.
  const tabCopyPin = useTabCopyPin();
  const tabLanePin = activeMachine?.routable && activeMachine.online && tabCopyPin != null ? activeMachine.pin : null;

  // The shared router over the same union the list renders. Every action on a
  // row resolves through it, so a lane on another machine is only ever sent
  // pinned to the machine that reports it.
  const laneRouter = useMemo(() => createLaneMachineRouter(allMachineLanes), [allMachineLanes]);
  const laneRouterRef = useRef(laneRouter);
  laneRouterRef.current = laneRouter;
  /**
   * Resolve a row key for an action. A foreign row routes to its own machine
   * (refused while offline/unavailable); a local key must be a lane the tab's
   * machine actually lists. Anything else is refused rather than sent unpinned.
   */
  const resolveLaneTarget = useCallback((key: string): LaneTarget => {
    const router = laneRouterRef.current;
    const foreignRow = foreignRowByKeyRef.current.get(key);
    if (foreignRow) {
      const route = router.route(foreignRow.lane.id, foreignRow.machineId);
      if (route.kind !== "pinned") {
        return { ok: false, reason: `${foreignRow.machineName} is unavailable` };
      }
      const blocked = machineBlockedReason(route.machine);
      if (blocked) return { ok: false, reason: blocked };
      return { ok: true, laneId: foreignRow.lane.id, pin: route.pin, machineId: foreignRow.machineId, name: foreignRow.lane.name };
    }
    const local = allMachineLanesRef.current.lanesByKey.get(key) ?? null;
    const route = router.route(key, allMachineLanesRef.current.machines[0]?.machineId ?? null);
    if (route.kind !== "pinned" || !route.machine.isActiveBinding || !local?.isActiveBinding) {
      return { ok: false, reason: "That lane is no longer listed." };
    }
    return { ok: true, laneId: key, pin: route.pin, machineId: null, name: local.lane.name };
  }, []);
  // The tab's own machine has no union slice, so `online` stays true after it
  // drops; its copy pin is null then, and the filter chip shows it offline.
  const tabMachineOffline = activeMachine?.binding?.kind === "remote" && tabCopyPin == null;
  // The machines whose lanes are listed: the tab's own, the online ones, and
  // ADE Cloud computers that are only asleep.
  const liveMachines = useMemo(() => {
    const live = allMachineLanes.machines.filter((machine) => !goneMachineIds.has(machine.machineId)
      && (machine.isActiveBinding || machine.online || restingMachineIds.has(machine.machineId)));
    if (!tabMachineOffline) return live;
    return live.map((machine) => (machine.isActiveBinding ? { ...machine, online: false } : machine));
  }, [allMachineLanes.machines, goneMachineIds, restingMachineIds, tabMachineOffline]);
  const multiMachine = shouldShowMachineChips(liveMachines.length);

  /* ---- Selection ---- */

  const foreignSelectedKey = useForeignLaneSelection(projectStateKey);
  const setForeignSelectedKey = useCallback((key: string | null) => {
    setForeignLaneSelection(projectStateKey, key);
  }, [projectStateKey]);
  // A resting ADE Cloud lane is listed under its saved-chats id until its
  // computer connects, then under the connection's id. The lane the person
  // opened stays selected across that move (lane ids are unique per lane).
  const movedForeignKey = useMemo(() => {
    if (!foreignSelectedKey?.startsWith(SAVED_CHATS_MACHINE_PREFIX) || foreignRowByKey.has(foreignSelectedKey)) return null;
    const laneId = foreignSelectedKey.slice(foreignSelectedKey.lastIndexOf(":") + 1);
    const matches = [...foreignRowByKey].filter(([, row]) => row.lane.id === laneId);
    return matches.length === 1 ? matches[0]![0] : null;
  }, [foreignRowByKey, foreignSelectedKey]);
  useEffect(() => {
    if (movedForeignKey) setForeignSelectedKey(movedForeignKey);
  }, [movedForeignKey, setForeignSelectedKey]);
  // The page's selection: a foreign row when one is picked and still listed,
  // otherwise the store's lane on the tab's machine.
  const selectedLaneId = foreignSelectedKey && foreignRowByKey.has(foreignSelectedKey)
    ? foreignSelectedKey
    : movedForeignKey ?? storeSelectedLaneId;
  /**
   * Select a row key: foreign rows stay in page state, local ids go to the
   * store. Opening a lane of an ADE Cloud computer that is asleep or not
   * connected here reaches that computer by its key, which wakes it.
   */
  const selectLane = useCallback((key: string | null) => {
    const foreignRow = key ? foreignRowByKeyRef.current.get(key) : undefined;
    if (key && foreignRow) {
      setForeignSelectedKey(key);
      if (!foreignRow.online) wakeRestingCloudMachine(foreignRow);
      return;
    }
    setForeignSelectedKey(null);
    storeSelectLane(key);
  }, [setForeignSelectedKey, storeSelectLane]);
  /** Drop a foreign selection (the lane is gone from its machine). */
  const clearForeignSelection = useCallback((key: string) => {
    if (foreignSelectedKey === key) {
      setForeignSelectedKey(null);
    }
  }, [foreignSelectedKey, setForeignSelectedKey]);

  const machineIdForKey = useCallback(
    (key: string) => foreignRowByKey.get(key)?.machineId ?? activeMachineId,
    [activeMachineId, foreignRowByKey],
  );

  /* ---- Rows ---- */

  const allViewLanes = useMemo(
    () => (foreignLanes.viewLanes.length === 0 ? localLanes : [...localLanes, ...foreignLanes.viewLanes]),
    [foreignLanes.viewLanes, localLanes],
  );
  /* ---- Machines ---- */

  // The machine of each row, for its hover card. Rows show no machine; the
  // hover card names it while the project has lanes on more than one machine.
  // An ADE Cloud lane's computer reads "Cloud · <lane>".
  const cloudMachineLabel = useMachineLabelForMachine();
  const machineByLaneId = useMemo(() => {
    if (!multiMachine) return undefined;
    const byMachineId = new Map<string, MachineChipModel>();
    for (const machine of liveMachines) {
      const chip = machineChipFor(machine);
      byMachineId.set(machine.machineId, {
        ...chip,
        // An asleep ADE Cloud computer is not offline: opening wakes it.
        online: chip.online || restingMachineIds.has(chip.machineId),
        machineName: chip.isThisMachine
          ? THIS_MACHINE_NAME
          : cloudMachineLabel({ machineId: chip.machineId, name: chip.machineName }),
      });
    }
    const map = new Map<string, MachineChipModel>();
    for (const lane of allViewLanes) {
      const machineId = machineIdForKey(lane.id);
      const machine = machineId ? byMachineId.get(machineId) : undefined;
      if (machine) map.set(lane.id, machine);
    }
    return map.size > 0 ? map : undefined;
  }, [allViewLanes, cloudMachineLabel, liveMachines, machineIdForKey, multiMachine, restingMachineIds]);
  /** Why a row on an unreachable machine can't be acted on, by row key. */
  const disabledReasonByLaneId = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of foreignRowByKey.values()) {
      // An asleep ADE Cloud computer's lane opens normally; opening wakes it.
      if (restingMachineIds.has(row.machineId)) continue;
      const reason = machineBlockedReason(row);
      if (reason) map.set(row.key, reason);
    }
    return map;
  }, [foreignRowByKey, restingMachineIds]);
  const foreignLaneIdSet = useMemo(() => new Set(foreignRowByKey.keys()), [foreignRowByKey]);

  return {
    allMachineLanes,
    tabLanePin,
    foreignLanes,
    foreignRowByKey,
    foreignRowByKeyRef,
    activeMachineId,
    resolveLaneTarget,
    multiMachine,
    selectedLaneId,
    selectLane,
    clearForeignSelection,
    machineIdForKey,
    allViewLanes,
    machineByLaneId,
    disabledReasonByLaneId,
    foreignLaneIdSet,
    restingMachineIds,
  };
}
