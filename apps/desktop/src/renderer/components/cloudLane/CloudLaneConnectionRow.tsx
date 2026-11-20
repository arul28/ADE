import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { CLOUD_LANE_POWER_TEXT, cloudLanePowerOfState } from "./cloudLaneStatus";

/**
 * A lane computer's state, as Manage lane says it: the chat header's words for
 * its mark, plus "Deleting", which the header never shows. The machine list
 * shows ADE Cloud as one machine (`AdeCloudMachineRow`), never a row per
 * lane's computer.
 */
export const CLOUD_MACHINE_STATE_TEXT = {
  running: CLOUD_LANE_POWER_TEXT[cloudLanePowerOfState("running")],
  asleep: CLOUD_LANE_POWER_TEXT[cloudLanePowerOfState("asleep")],
  stopped: CLOUD_LANE_POWER_TEXT[cloudLanePowerOfState("stopped")],
  starting: CLOUD_LANE_POWER_TEXT[cloudLanePowerOfState("starting")],
  stopping: CLOUD_LANE_POWER_TEXT[cloudLanePowerOfState("stopping")],
  deleting: "Deleting",
  error: CLOUD_LANE_POWER_TEXT[cloudLanePowerOfState("error")],
} satisfies Record<CloudLaneMachine["state"], string>;
