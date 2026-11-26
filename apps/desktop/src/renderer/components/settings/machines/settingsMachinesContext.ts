import { createContext, useContext } from "react";
import { distinctMachineNames } from "../../../../shared/machineIdentity";
import type { ProjectMachine } from "../../../state/projectMachines";

/**
 * Each machine's name in Settings: This computer by its device name when sync
 * knows it, every other machine by its own, and two that share a name told
 * apart (`distinctMachineNames`). Keyed by machine id.
 */
export function settingsMachineNames(
  machines: readonly ProjectMachine[],
  thisMachineName: string | null,
): Map<string, string> {
  return distinctMachineNames(machines.map((machine) => ({
    id: machine.machineId,
    name: machine.isThisMachine ? (thisMachineName ?? machine.machineName) : machine.machineName,
    isThisMachine: machine.isThisMachine,
    hostname: machine.hostname,
    deviceId: machine.deviceId,
  })));
}

/**
 * The machines Settings already reads (`useProjectMachines` in the settings
 * page), handed to the pages that list them (General, Machines) so they do
 * not subscribe a second time, plus the one way to open a machine's page.
 */
export type SettingsMachinesValue = {
  machines: readonly ProjectMachine[];
  /** This computer's own name ("Arul's Mac Studio"), when sync knows it. */
  thisMachineName: string | null;
  /** What each machine is called in a list (`settingsMachineNames`), by machine id. */
  machineNames: ReadonlyMap<string, string>;
  /** Opens a page about one machine: its Machines page, or Providers on it. */
  openMachine: (machineId: string, tab?: "machines" | "agents" | "android" | "apple") => void;
  /** Opens another Settings page, at a card when `anchor` is given. */
  openTab: (tab: string, anchor?: string) => void;
};

export const SettingsMachinesContext = createContext<SettingsMachinesValue>({
  machines: [],
  thisMachineName: null,
  machineNames: new Map(),
  openMachine: () => {},
  openTab: () => {},
});

export function useSettingsMachines(): SettingsMachinesValue {
  return useContext(SettingsMachinesContext);
}
