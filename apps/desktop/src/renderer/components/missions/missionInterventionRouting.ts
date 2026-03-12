import type { MissionIntervention } from "../../../shared/types";
import { isRecord } from "./missionHelpers";
import type { MissionsStore } from "./useMissionsStore";

type MissionInterventionRouterStore = Pick<
  MissionsStore,
  | "selectedMission"
  | "runGraph"
  | "setActiveInterventionId"
  | "setLogsFocusInterventionId"
  | "setChatJumpTarget"
  | "setSelectedStepId"
  | "setPlanSubview"
  | "setActiveTab"
>;

function resolveOpenIntervention(
  store: MissionInterventionRouterStore,
  interventionOrId: MissionIntervention | string,
): MissionIntervention | null {
  const interventions = store.selectedMission?.interventions ?? [];
  const intervention =
    typeof interventionOrId === "string"
      ? interventions.find((entry) => entry.id === interventionOrId) ?? null
      : interventionOrId;
  return intervention?.status === "open" ? intervention : null;
}

export function routeMissionIntervention(
  store: MissionInterventionRouterStore,
  interventionOrId: MissionIntervention | string,
): boolean {
  const intervention = resolveOpenIntervention(store, interventionOrId);
  if (!intervention) return false;

  if (intervention.interventionType === "manual_input") {
    store.setActiveInterventionId(intervention.id);
    return true;
  }

  const metadata = isRecord(intervention.metadata) ? intervention.metadata : {};
  const interventionRunId = typeof metadata.runId === "string" && metadata.runId.trim().length > 0
    ? metadata.runId.trim()
    : null;
  const interventionStepId = typeof metadata.stepId === "string" && metadata.stepId.trim().length > 0
    ? metadata.stepId.trim()
    : null;
  const interventionStepKey = typeof metadata.stepKey === "string" && metadata.stepKey.trim().length > 0
    ? metadata.stepKey.trim()
    : null;
  const interventionAttemptId = typeof metadata.attemptId === "string" && metadata.attemptId.trim().length > 0
    ? metadata.attemptId.trim()
    : null;
  const reasonCode = typeof metadata.reasonCode === "string" && metadata.reasonCode.trim().length > 0
    ? metadata.reasonCode.trim()
    : null;
  const currentRunId = store.runGraph?.run.id ?? null;
  const sameRun = interventionRunId ? interventionRunId === currentRunId : Boolean(currentRunId);
  const resolvedStepId =
    sameRun
    && interventionStepId
    && store.runGraph?.steps.some((step) => step.id === interventionStepId)
      ? interventionStepId
      : null;

  if (reasonCode === "coordinator_unavailable" || reasonCode === "coordinator_recovery_failed") {
    store.setLogsFocusInterventionId(null);
    store.setChatJumpTarget({ kind: "coordinator", runId: interventionRunId ?? currentRunId });
    store.setActiveTab("chat");
    return true;
  }

  if (intervention.interventionType === "failed_step") {
    if (resolvedStepId) {
      store.setSelectedStepId(resolvedStepId);
      store.setPlanSubview("board");
      store.setLogsFocusInterventionId(intervention.id);
      store.setActiveTab("plan");
      return true;
    }
    if (sameRun && (interventionAttemptId || interventionStepKey)) {
      store.setLogsFocusInterventionId(null);
      store.setChatJumpTarget({
        kind: "worker",
        runId: interventionRunId ?? currentRunId,
        stepId: null,
        stepKey: interventionStepKey,
        attemptId: interventionAttemptId,
      });
      store.setActiveTab("chat");
      return true;
    }
  }

  store.setLogsFocusInterventionId(intervention.id);
  store.setActiveTab("history");
  return true;
}
