import { useMemo } from "react";
import { useMachinePlacementPreferences } from "../../state/machinePlacement";
import { useMachineStatsMap, type MachineStatsRequest } from "../../state/machineStats";
import { useThisComputerColorKey } from "../settings/machines/machineFacts";
import {
  canCreateLaneOnMachine,
  laneMachineStatsPin,
  THIS_MACHINE_ID,
  type LaneMachineOption,
} from "./laneMachines";

/**
 * Machine options with what "Least loaded" weighs: each machine's stats, read
 * through its own pin while the picker is open, and its placement preference
 * from the account. Stats are read only when there is a choice to make (two
 * or more machines can host the repo); one machine needs no balancing.
 */
export function useMachinePlacement(options: readonly LaneMachineOption[], active: boolean): LaneMachineOption[] {
  const thisKey = useThisComputerColorKey();
  const { preferenceOf } = useMachinePlacementPreferences(active);
  const requests = useMemo<MachineStatsRequest[]>(() => {
    const hosts = options.filter(canCreateLaneOnMachine);
    if (hosts.length < 2) return [];
    return hosts.flatMap((option) => {
      const pin = laneMachineStatsPin(option);
      return pin === "unreachable" ? [] : [{ id: option.id, pin }];
    });
  }, [options]);
  const { stats } = useMachineStatsMap(requests, active);
  return useMemo(() => options.map((option) => {
    const machineKey = option.machineKey ?? (option.id === THIS_MACHINE_ID ? thisKey : null);
    return {
      ...option,
      machineKey,
      stats: stats.get(option.id),
      preference: preferenceOf(machineKey),
    };
  }), [options, preferenceOf, stats, thisKey]);
}
