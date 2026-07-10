/**
 * Named constants and small readers for the lane-cleanup automation surface
 * (the `lane.merged` trigger and `delete-lane` action). These map directly onto
 * the shared automation types.
 */

import type { AutomationAction, AutomationTrigger } from "../../../shared/types";

export const LANE_MERGED_TRIGGER_TYPE = "lane.merged" as const;
export const DELETE_LANE_ACTION_TYPE = "delete-lane" as const;

export type LaneDeleteOptions = NonNullable<AutomationAction["laneDeleteOptions"]>;

export function isDeleteLaneAction(action: Pick<AutomationAction, "type">): boolean {
  return action.type === DELETE_LANE_ACTION_TYPE;
}

export function isLaneMergedTrigger(trigger: Pick<AutomationTrigger, "type">): boolean {
  return trigger.type === LANE_MERGED_TRIGGER_TYPE;
}

export function readAlwaysRun(action: Pick<AutomationAction, "alwaysRun">): boolean {
  return action.alwaysRun === true;
}

export function readAfterMinutes(action: Pick<AutomationAction, "afterMinutes">): number | undefined {
  return Number.isFinite(action.afterMinutes) ? action.afterMinutes : undefined;
}

export function readLaneDeleteOptions(action: Pick<AutomationAction, "laneDeleteOptions">): LaneDeleteOptions {
  return action.laneDeleteOptions ?? {};
}

export function makeDeleteLaneAction(options: {
  laneDeleteOptions?: LaneDeleteOptions;
  afterMinutes?: number;
  alwaysRun?: boolean;
}): AutomationAction {
  return {
    type: DELETE_LANE_ACTION_TYPE,
    ...(options.laneDeleteOptions ? { laneDeleteOptions: options.laneDeleteOptions } : {}),
    ...(Number.isFinite(options.afterMinutes) ? { afterMinutes: options.afterMinutes } : {}),
    ...(options.alwaysRun ? { alwaysRun: true } : {}),
  };
}
