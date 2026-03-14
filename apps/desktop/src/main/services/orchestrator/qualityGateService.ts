/**
 * qualityGateService.ts
 *
 * Quality evaluation: evaluateQualityGateForStep, handleQualityGateFailure,
 * quality gate helpers.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import {
  GATE_PHASE_STEP_TYPES,
  QUALITY_GATE_MAX_OUTPUT_CHARS,
} from "./orchestratorContext";

/**
 * Check whether a step type should trigger quality gate evaluation.
 */
export function isGatePhaseStepType(stepType: string): boolean {
  return GATE_PHASE_STEP_TYPES.has(stepType.toLowerCase());
}

/**
 * Clip output for quality gate context.
 */
export function clipForQualityGate(output: string): string {
  if (output.length <= QUALITY_GATE_MAX_OUTPUT_CHARS) return output;
  return output.slice(0, QUALITY_GATE_MAX_OUTPUT_CHARS - 15) + "... (truncated)";
}
