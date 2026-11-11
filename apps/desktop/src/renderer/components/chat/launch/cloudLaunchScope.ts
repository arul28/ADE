import type { LaneSummary, OpenProjectBinding } from "../../../../shared/types";
import type { CursorCloudLaunchGit } from "../../../lib/cursorCloudUtils";

/**
 * Where a Cursor or Devin Cloud launch runs: the chat's machine, through its
 * own (shared) sign-in. `pin` is null when that machine is the tab's own, which
 * keeps the unpinned route; every git, lane and launch call of the launch
 * takes it, so the whole flow stays on one machine.
 */
export function cloudLaunchScope(
  launchBinding: OpenProjectBinding | null,
  projectBinding: OpenProjectBinding | null,
): { pin: OpenProjectBinding | null; git: CursorCloudLaunchGit } {
  const pin = !launchBinding || launchBinding.key === projectBinding?.key ? null : launchBinding;
  return {
    pin,
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
  pin: OpenProjectBinding | null,
  machineLanes: readonly LaneSummary[] | null | undefined,
  tabLanes: readonly LaneSummary[],
): LaneSummary | null {
  return (pin ? machineLanes ?? [] : tabLanes).find((lane) => lane.id === laneId) ?? null;
}
