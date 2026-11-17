import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";

/**
 * A lane computer's state, as Manage lane says it. The machine list shows
 * ADE Cloud as one machine (`AdeCloudMachineRow`), never a row per lane's
 * computer.
 */
export const CLOUD_MACHINE_STATE_TEXT: Record<CloudLaneMachine["state"], string> = {
  running: "Awake",
  asleep: "Asleep",
  stopped: "Asleep",
  starting: "Waking",
  stopping: "Going to sleep",
  deleting: "Deleting",
  error: "Needs a look",
};
