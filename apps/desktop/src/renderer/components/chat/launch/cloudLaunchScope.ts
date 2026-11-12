import type { LaneSummary, OpenProjectBinding } from "../../../../shared/types";
import type { CursorCloudLaunchGit } from "../../../lib/cursorCloudUtils";

/**
 * Where a Cursor or Devin Cloud launch runs: the chat's machine, through its
 * own (shared) sign-in. `pin` names that machine's copy, the tab's own
 * included; `isActiveBinding` says whether it is the tab's. Every git, lane
 * and launch call of the launch takes the pin, so the whole flow stays on one
 * machine.
 */
export function cloudLaunchScope(
  launchBinding: OpenProjectBinding | null,
  projectBinding: OpenProjectBinding | null,
): { pin: OpenProjectBinding | null; isActiveBinding: boolean; git: CursorCloudLaunchGit } {
  const pin = launchBinding ?? projectBinding ?? null;
  const isActiveBinding = !pin || pin.key === projectBinding?.key;
  return {
    pin,
    isActiveBinding,
    git: {
      getSyncStatus: (args) => window.ade.git.getSyncStatus(args, pin),
      push: (args) => window.ade.git.push(args, pin),
    },
  };
}

/**
 * A lane on the launch's machine: another machine's lane is in that machine's
 * list (`machineLanes`), not the tab's.
 */
export function laneOnLaunchMachine(
  laneId: string,
  isActiveBinding: boolean,
  machineLanes: readonly LaneSummary[] | null | undefined,
  tabLanes: readonly LaneSummary[],
): LaneSummary | null {
  return (isActiveBinding ? tabLanes : machineLanes ?? []).find((lane) => lane.id === laneId) ?? null;
}
