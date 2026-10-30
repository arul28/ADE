import { createContext, useContext } from "react";
import type { ProjectMachine } from "../../../state/projectMachines";

/**
 * The machines Settings already reads (`useProjectMachines` in the settings
 * page), handed to the pages that list them (General, Machines) so they do
 * not subscribe a second time, plus the one way to open a machine's page.
 */
export type SettingsMachinesValue = {
  machines: readonly ProjectMachine[];
  /** This computer's own name ("Arul's Mac Studio"), when sync knows it. */
  thisMachineName: string | null;
  /** Opens a page about one machine: its Machines page, or Providers on it. */
  openMachine: (machineId: string, tab?: "machines" | "agents") => void;
  /** Opens another Settings page, at a card when `anchor` is given. */
  openTab: (tab: string, anchor?: string) => void;
};

export const SettingsMachinesContext = createContext<SettingsMachinesValue>({
  machines: [],
  thisMachineName: null,
  openMachine: () => {},
  openTab: () => {},
});

export function useSettingsMachines(): SettingsMachinesValue {
  return useContext(SettingsMachinesContext);
}
