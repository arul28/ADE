import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { CLOUD_LANE_POWER_TEXT, cloudLanePowerOfState } from "./cloudLaneStatus";

const CLOUD_MACHINE_STATES: readonly CloudLaneMachine["state"][] = [
  "running",
  "asleep",
  "stopped",
  "starting",
  "stopping",
  "deleting",
  "error",
];

/**
 * A lane computer's state, as Manage lane says it: the chat header's words for
 * its mark, plus "Deleting", which the header never shows. The machine list
 * shows ADE Cloud as one machine (`AdeCloudMachineRow`), never a row per
 * lane's computer.
 */
export const CLOUD_MACHINE_STATE_TEXT = Object.fromEntries(
  CLOUD_MACHINE_STATES.map((state) => [
    state,
    state === "deleting" ? "Deleting" : CLOUD_LANE_POWER_TEXT[cloudLanePowerOfState(state)],
  ]),
) as Record<CloudLaneMachine["state"], string>;
