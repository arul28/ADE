export type FailedStepInterventionTarget = {
  missionStepId?: string | null;
  orchestratorStepId?: string | null;
  stepKey?: string | null;
  runId?: string | null;
};

function stableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Match open failed_step interventions across worker, terminal-sync, and manual
 * creation paths. `metadata.stepId` is not stable: worker interventions store
 * the orchestrator step id there, while terminal sync stores the mission step id.
 */
export function failedStepInterventionsMatch(
  existingMetadata: Record<string, unknown> | null | undefined,
  target: FailedStepInterventionTarget,
): boolean {
  if (!existingMetadata) return false;

  const existingStepId = stableString(existingMetadata.stepId);
  const existingOrchestratorStepId = stableString(existingMetadata.orchestratorStepId);
  const existingStepKey = stableString(existingMetadata.stepKey);
  const existingRunId = stableString(existingMetadata.runId);

  const missionStepId = stableString(target.missionStepId);
  const orchestratorStepId = stableString(target.orchestratorStepId);
  const stepKey = stableString(target.stepKey);
  const runId = stableString(target.runId);

  if (missionStepId && existingStepId === missionStepId) return true;

  if (orchestratorStepId) {
    if (existingStepId === orchestratorStepId) return true;
    if (existingOrchestratorStepId === orchestratorStepId) return true;
  }

  if (stepKey && existingStepKey === stepKey) {
    if (!runId || !existingRunId || runId === existingRunId) return true;
  }

  return false;
}
