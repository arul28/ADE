import { navigateToAppTarget } from "../../lib/openExternal";

/** Opens the ADE Cloud plans card in Settings. Account level, so no machine. */
export function openCloudPlanSettings(): void {
  navigateToAppTarget({ kind: "settings", entryId: "integrations.ade-cloud", machineId: null });
}
