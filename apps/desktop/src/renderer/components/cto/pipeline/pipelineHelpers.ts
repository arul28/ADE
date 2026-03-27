/**
 * Utilities for working with multi-stage workflow target chains.
 *
 * The backend represents multi-stage flows via recursive `downstreamTarget` nesting:
 *   target -> target.downstreamTarget -> target.downstreamTarget.downstreamTarget
 *
 * The pipeline builder shows these as a flat array of stages.
 * These helpers convert between the two representations.
 */

import type { LinearWorkflowTarget } from "../../../../shared/types/linearSync";

/** A single stage in the flat pipeline representation (no nesting). */
export type PipelineStage = Omit<LinearWorkflowTarget, "downstreamTarget">;

/**
 * Walk the downstreamTarget chain and return a flat array of stages.
 * Stage 0 is the primary target, stage 1 is its downstream, etc.
 */
export function flattenTargetChain(target: LinearWorkflowTarget): PipelineStage[] {
  const stages: PipelineStage[] = [];
  let current: LinearWorkflowTarget | null | undefined = target;
  while (current) {
    const { downstreamTarget: next, ...stage } = current;
    stages.push(stage);
    current = next as LinearWorkflowTarget | null | undefined;
  }
  return stages;
}

/**
 * Reconstruct a nested downstreamTarget chain from a flat array of stages.
 * The last stage has no downstreamTarget.
 */
export function rebuildTargetChain(stages: PipelineStage[]): LinearWorkflowTarget {
  if (stages.length === 0) {
    throw new Error("Cannot build target chain from empty array");
  }
  // Build from the end backwards
  let result: LinearWorkflowTarget = { ...stages[stages.length - 1] };
  for (let i = stages.length - 2; i >= 0; i--) {
    result = { ...stages[i], downstreamTarget: result };
  }
  return result;
}

/**
 * Return the total number of stages in the chain.
 */
export function countStages(target: LinearWorkflowTarget): number {
  let count = 0;
  let current: LinearWorkflowTarget | null | undefined = target;
  while (current) {
    count++;
    current = current.downstreamTarget;
  }
  return count;
}

/**
 * Get a single stage by index from the chain.
 */
export function getStageAt(target: LinearWorkflowTarget, index: number): PipelineStage | null {
  const stages = flattenTargetChain(target);
  return stages[index] ?? null;
}

/**
 * Insert a new stage at the given index.
 * Index 0 replaces the primary target and pushes everything down.
 * Index === stages.length appends at the end.
 */
export function insertStageAt(
  target: LinearWorkflowTarget,
  index: number,
  newStage: PipelineStage,
): LinearWorkflowTarget {
  const stages = flattenTargetChain(target);
  if (index < 0 || index > stages.length) {
    throw new Error(`Insert index ${index} out of range [0, ${stages.length}]`);
  }
  stages.splice(index, 0, newStage);
  return rebuildTargetChain(stages);
}

/**
 * Remove a stage at the given index.
 * Cannot remove the last remaining stage.
 */
export function removeStageAt(
  target: LinearWorkflowTarget,
  index: number,
): LinearWorkflowTarget {
  const stages = flattenTargetChain(target);
  if (stages.length <= 1) {
    throw new Error("Cannot remove the only stage");
  }
  if (index < 0 || index >= stages.length) {
    throw new Error(`Remove index ${index} out of range [0, ${stages.length - 1}]`);
  }
  stages.splice(index, 1);
  return rebuildTargetChain(stages);
}

/**
 * Update a specific stage in place via an updater function.
 */
export function updateStageAt(
  target: LinearWorkflowTarget,
  index: number,
  updater: (stage: PipelineStage) => PipelineStage,
): LinearWorkflowTarget {
  const stages = flattenTargetChain(target);
  if (index < 0 || index >= stages.length) {
    throw new Error(`Update index ${index} out of range [0, ${stages.length - 1}]`);
  }
  stages[index] = updater(stages[index]);
  return rebuildTargetChain(stages);
}

/**
 * Create a default stage for a given target type.
 */
export function createDefaultStage(
  type: LinearWorkflowTarget["type"],
): PipelineStage {
  switch (type) {
    case "employee_session":
      return {
        type,
        runMode: "assisted",
        sessionTemplate: "default",
        laneSelection: "fresh_issue_lane",
        sessionReuse: "fresh_session",
        prTiming: "none",
      };
    case "worker_run":
      return {
        type,
        runMode: "autopilot",
        workerSelector: { mode: "none" },
        laneSelection: "fresh_issue_lane",
        prTiming: "none",
      };
    case "mission":
      return {
        type,
        runMode: "autopilot",
        missionTemplate: "default",
      };
    case "pr_resolution":
      return {
        type,
        runMode: "autopilot",
        workerSelector: { mode: "none" },
        prStrategy: { kind: "per-lane", draft: true },
        laneSelection: "fresh_issue_lane",
        prTiming: "after_target_complete",
      };
    case "review_gate":
      return {
        type,
        runMode: "manual",
      };
  }
}
