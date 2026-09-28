import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import {
  createLaneMachineRouter,
  foreignLaneKey,
  machineBlockedReason,
  machineChipFor,
  shouldShowMachineChips,
  useAllMachineLanes,
  type MachineChipModel,
  type MachineLane,
} from "../../state/laneMachineRouting";

/**
 * A lane on another machine is selected in page state, never in the store's
 * `selectedLaneId`: other tabs read that id as a lane on the tab's machine, and
 * a foreign row key (or a foreign lane id that happens to exist here too) must
 * not leak into them. Kept per project across remounts of the route.
 */
const foreignSelectionByProject = new Map<string, string | null>();
const machineFilterByProject = new Map<string, string>();

/** Where one row's lane lives: its real id on its machine, and the pin to use. */
export type LaneTarget =
  | { ok: true; laneId: string; pin: OpenProjectBinding | null; machineId: string | null; name: string }
  | { ok: false; reason: string };

export type ForeignLaneModel = {
  /** Row key (`machineId:laneId`) → the machine's lane. */
  rowByKey: ReadonlyMap<string, MachineLane>;
  /** Foreign lanes as page rows: `id` is the row key, parents point at row keys. */
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
 * key (`machineId:laneId`) and whose parent points at the same machine's row.
 * A row key is never a lane id on any machine, so a code path that forgets to
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
  const allMachineLanes = useAllMachineLanes(active);
  const allMachineLanesRef = useRef(allMachineLanes);
  allMachineLanesRef.current = allMachineLanes;

  const foreignLanes = useMemo<ForeignLaneModel>(() => {
    const rowByKey = new Map<string, MachineLane>();
    const viewLanes: LaneSummary[] = [];
    const realLanesByMachineId = new Map<string, LaneSummary[]>();
    for (const row of allMachineLanes.lanes) {
      if (row.isActiveBinding) continue;
      rowByKey.set(row.key, row);
      const machineLanes = realLanesByMachineId.get(row.machineId);
      if (machineLanes) machineLanes.push(row.lane);
      else realLanesByMachineId.set(row.machineId, [row.lane]);
    }
    for (const row of rowByKey.values()) {
      const parentKey = row.lane.parentLaneId ? foreignLaneKey(row.machineId, row.lane.parentLaneId) : null;
      const parentRow = parentKey ? rowByKey.get(parentKey) ?? null : null;
      viewLanes.push({
        ...row.lane,
        id: row.key,
        // Children of that machine's Primary are top-level rows, like here.
        parentLaneId: parentRow && parentRow.lane.laneType !== "primary" ? parentRow.key : null,
      });
    }
    return { rowByKey, viewLanes, realLanesByMachineId };
  }, [allMachineLanes]);
  const foreignRowByKey = foreignLanes.rowByKey;
  const foreignRowByKeyRef = useRef(foreignRowByKey);
  foreignRowByKeyRef.current = foreignRowByKey;
  const activeMachine = allMachineLanes.machines[0] ?? null;
  const activeMachineId = activeMachine?.machineId ?? null;

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
      if (route.kind !== "pinned" && route.kind !== "bound") {
        return { ok: false, reason: `${foreignRow.machineName} is unavailable` };
      }
      const blocked = machineBlockedReason(route.machine);
      if (blocked) return { ok: false, reason: blocked };
      return { ok: true, laneId: foreignRow.lane.id, pin: route.pin, machineId: foreignRow.machineId, name: foreignRow.lane.name };
    }
    const local = allMachineLanesRef.current.lanesByKey.get(key) ?? null;
    const route = router.route(key, allMachineLanesRef.current.machines[0]?.machineId ?? null);
    if (route.kind !== "bound" || !local?.isActiveBinding) {
      return { ok: false, reason: "That lane is no longer listed." };
    }
    return { ok: true, laneId: key, pin: null, machineId: null, name: local.lane.name };
  }, []);
  const multiMachine = shouldShowMachineChips(allMachineLanes.machines.length);

  /* ---- Selection ---- */

  const [foreignSelectedKey, setForeignSelectedKeyState] = useState<string | null>(
    () => (projectStateKey ? foreignSelectionByProject.get(projectStateKey) ?? null : null),
  );
  const setForeignSelectedKey = useCallback((key: string | null) => {
    if (projectStateKey) foreignSelectionByProject.set(projectStateKey, key);
    setForeignSelectedKeyState(key);
  }, [projectStateKey]);
  useEffect(() => {
    setForeignSelectedKeyState(projectStateKey ? foreignSelectionByProject.get(projectStateKey) ?? null : null);
  }, [projectStateKey]);
  // The page's selection: a foreign row when one is picked and still listed,
  // otherwise the store's lane on the tab's machine.
  const selectedLaneId = foreignSelectedKey && foreignRowByKey.has(foreignSelectedKey)
    ? foreignSelectedKey
    : storeSelectedLaneId;
  /** Select a row key: foreign rows stay in page state, local ids go to the store. */
  const selectLane = useCallback((key: string | null) => {
    if (key && foreignRowByKeyRef.current.has(key)) {
      setForeignSelectedKey(key);
      return;
    }
    setForeignSelectedKey(null);
    storeSelectLane(key);
  }, [setForeignSelectedKey, storeSelectLane]);
  /** Drop a foreign selection (the lane is gone from its machine). */
  const clearForeignSelection = useCallback((key: string) => {
    if (foreignSelectionByProject.get(projectStateKey ?? "") === key || foreignSelectedKey === key) {
      setForeignSelectedKey(null);
    }
  }, [foreignSelectedKey, projectStateKey, setForeignSelectedKey]);

  /* ---- Machine filter ---- */

  const [machineFilter, setMachineFilterState] = useState<string>(
    () => (projectStateKey ? machineFilterByProject.get(projectStateKey) ?? "all" : "all"),
  );
  const setMachineFilter = useCallback((next: string) => {
    if (projectStateKey) machineFilterByProject.set(projectStateKey, next);
    setMachineFilterState(next);
  }, [projectStateKey]);
  // A machine that left the union cannot stay the filter.
  const effectiveMachineFilter = machineFilter !== "all" && multiMachine && allMachineLanes.machinesById.has(machineFilter)
    ? machineFilter
    : "all";
  const machineIdForKey = useCallback(
    (key: string) => foreignRowByKey.get(key)?.machineId ?? activeMachineId,
    [activeMachineId, foreignRowByKey],
  );

  /* ---- Rows ---- */

  const allViewLanes = useMemo(
    () => (foreignLanes.viewLanes.length === 0 ? localLanes : [...localLanes, ...foreignLanes.viewLanes]),
    [foreignLanes.viewLanes, localLanes],
  );
  // The machine filter chips narrow the list; selection and colors still see
  // every machine's lanes.
  const visibleLanes = useMemo(() => {
    if (effectiveMachineFilter === "all") return allViewLanes;
    return allViewLanes.filter((lane) => machineIdForKey(lane.id) === effectiveMachineFilter);
  }, [allViewLanes, effectiveMachineFilter, machineIdForKey]);

  /* ---- Chips ---- */

  /** One filter chip per machine, with its lane count. */
  const machineFilterChips = useMemo(() => {
    const byMachineId = new Map<string, MachineChipModel & { laneCount: number }>();
    for (const machine of allMachineLanes.machines) {
      byMachineId.set(machine.machineId, { ...machineChipFor(machine), laneCount: 0 });
    }
    for (const lane of allViewLanes) {
      const machineId = machineIdForKey(lane.id);
      const chip = machineId ? byMachineId.get(machineId) : undefined;
      if (chip) chip.laneCount += 1;
    }
    return byMachineId;
  }, [allMachineLanes.machines, allViewLanes, machineIdForKey]);
  // One machine, or the list filtered down to one: every row would carry the
  // same chip, so none do (the active filter chip already names the machine).
  const machineChipByLaneId = useMemo(() => {
    if (!multiMachine || effectiveMachineFilter !== "all") return undefined;
    const map = new Map<string, MachineChipModel>();
    for (const lane of allViewLanes) {
      const machineId = machineIdForKey(lane.id);
      const chip = machineId ? machineFilterChips.get(machineId) : undefined;
      if (chip) map.set(lane.id, chip);
    }
    return map;
  }, [allViewLanes, effectiveMachineFilter, machineFilterChips, machineIdForKey, multiMachine]);
  /** Why a row on an unreachable machine can't be acted on, by row key. */
  const disabledReasonByLaneId = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of foreignRowByKey.values()) {
      const reason = machineBlockedReason(row);
      if (reason) map.set(row.key, reason);
    }
    return map;
  }, [foreignRowByKey]);
  const foreignLaneIdSet = useMemo(() => new Set(foreignRowByKey.keys()), [foreignRowByKey]);

  return {
    allMachineLanes,
    foreignLanes,
    foreignRowByKey,
    foreignRowByKeyRef,
    activeMachineId,
    resolveLaneTarget,
    multiMachine,
    selectedLaneId,
    selectLane,
    clearForeignSelection,
    effectiveMachineFilter,
    setMachineFilter,
    machineIdForKey,
    allViewLanes,
    visibleLanes,
    machineFilterChips,
    machineChipByLaneId,
    disabledReasonByLaneId,
    foreignLaneIdSet,
  };
}
