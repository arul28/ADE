/**
 * `@ade-dev/ui/lanes` — the lane picker and the lane identity helpers it draws
 * with. Pulls `@phosphor-icons/react`, which is why it is its own entry point
 * and not part of the barrel.
 */

export {
  AUTO_CREATE_LANE_OPTION_ID,
  LaneCombobox,
  autoCreateLaneOptionId,
  computeLanePopoverPlacement,
  isAutoCreateLaneOptionId,
  laneMatchesSearch,
  machineIdFromAutoCreateLaneOptionId,
  machineLaneFromOptionId,
  machineLaneOptionId,
} from "./LaneCombobox";
export type {
  LaneComboboxLane,
  LaneComboboxMachine,
  LanePopoverPlacement,
} from "./LaneCombobox";

export { LaneLogoMark, branchNameFromLaneRef, laneDisplayColor } from "./laneIdentity";
