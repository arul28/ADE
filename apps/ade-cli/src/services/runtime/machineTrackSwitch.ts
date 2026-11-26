import type {
  RemoteRuntimeTrackSwitchResult,
  UpdateRequestedBy,
} from "../../../../desktop/src/shared/types/remoteRuntime";
import { updateTrackLabel, type UpdateTrack } from "../../../../desktop/src/shared/updateTrack";
import { isDesktopBridgeMethodMissing, type DesktopAppUpdateRouting } from "./desktopAppUpdateBridge";

export type MachineTrackSwitchDeps = {
  /**
   * Ask this machine's ADE app (opening it when the brain is the app's own and
   * it is closed) to switch tracks and install that track's newest build.
   */
  requestDesktopAppTrackSwitch: (
    track: UpdateTrack,
    requestedBy: UpdateRequestedBy | null,
  ) => Promise<DesktopAppUpdateRouting>;
};

/**
 * "Move this machine to Beta / Stable", asked from another machine
 * (`machine.switchUpdateTrack`).
 *
 * Only the ADE app can do it: it owns the update feed, runs the database
 * check that keeps an older build from opening newer data (the one its
 * Settings › About switch runs), and installs a build from the other track
 * even when that build is older. A machine with no app (a server running only
 * the brain) cannot install an older build, so it is refused with where to
 * switch instead. Never folded into "Update & restart", which stays on the
 * machine's own track.
 */
export async function runMachineTrackSwitch(
  deps: MachineTrackSwitchDeps,
  track: UpdateTrack,
  requestedBy: UpdateRequestedBy | null,
): Promise<RemoteRuntimeTrackSwitchResult> {
  const label = updateTrackLabel(track);
  const refused = (message: string, currentVersion: string | null = null): RemoteRuntimeTrackSwitchResult => ({
    ok: false,
    track,
    outcome: "refused",
    version: null,
    currentVersion,
    message,
  });
  let routing: DesktopAppUpdateRouting;
  try {
    routing = await deps.requestDesktopAppTrackSwitch(track, requestedBy);
  } catch (error) {
    return refused(`The ADE app on this machine didn't answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!routing.attached) {
    return refused(isDesktopBridgeMethodMissing(routing)
      ? `ADE on this machine is too old to switch tracks from another machine. Update it first, or switch to ${label} in Settings › About there.`
      : `No ADE app is open on this machine, so it can only move to ${label} there: open ADE and switch in Settings › About.`);
  }
  const answer = routing.result;
  switch (answer.outcome) {
    case "installing":
    case "downloading":
      return {
        ok: true,
        track,
        outcome: answer.outcome,
        version: answer.version,
        currentVersion: answer.currentVersion,
        message: answer.message || `Moving to ${label}.`,
      };
    case "already_current":
      return {
        ok: true,
        track,
        outcome: "saved",
        version: null,
        currentVersion: answer.currentVersion,
        message: answer.message || `Already on ${label}.`,
      };
    default:
      return refused(answer.message || `It didn't move to ${label}.`, answer.currentVersion);
  }
}
