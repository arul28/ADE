import type { MissionIntervention, PhaseCard } from "../../../shared/types";

type InterventionLike = {
  status?: string | null;
  interventionType?: string | null;
  intervention_type?: string | null;
  metadata?: Record<string, unknown> | null;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlanningPhase(phase: PhaseCard | null | undefined): boolean {
  const phaseKey = normalize(phase?.phaseKey);
  const phaseName = normalize(phase?.name);
  return phaseKey === "planning" || phaseName === "planning";
}

function textRequiresPlanningQuestion(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(?:do not|don't|dont|no need to|without)\b.{0,60}\bask(?:s|ed|ing)?\b.{0,60}\b(?:clarification|question|questions|input)\b/.test(normalized)) {
    return false;
  }
  const asksQuestion = /\bask(?:s|ed|ing)?\b.{0,90}\b(blocking\s+)?(?:clarification|clarifying|question|questions|input)\b/.test(normalized);
  const beforeExecution = /\bbefore\b.{0,90}\b(?:planning|implementation|implementing|development|coding|execution)\b/.test(normalized);
  const blockingQuestion = /\b(?:blocking|required|must)\b.{0,90}\b(?:clarification|question|questions|input)\b/.test(normalized);
  const questionBeforeExecution = /\b(?:clarification|question|questions|input)\b.{0,90}\bbefore\b.{0,90}\b(?:planning|implementation|implementing|development|coding|execution)\b/.test(normalized);
  return (asksQuestion && beforeExecution) || blockingQuestion || questionBeforeExecution;
}

export function phaseRequiresPlanningQuestionBeforeExit(args: {
  phase: PhaseCard | null | undefined;
  missionPrompt?: string | null;
}): boolean {
  const { phase } = args;
  if (!isPlanningPhase(phase) || phase?.askQuestions?.enabled !== true) return false;
  if (phase.askQuestions?.requiredBeforeExit === true) return true;
  return textRequiresPlanningQuestion(`${phase.instructions ?? ""}\n${args.missionPrompt ?? ""}`);
}

export function isPlanningQuestionIntervention(
  intervention: InterventionLike | MissionIntervention,
  args: { runId?: string | null } = {},
): boolean {
  const interventionType = normalize(
    "interventionType" in intervention ? intervention.interventionType : intervention.intervention_type,
  );
  if (interventionType && interventionType !== "manual_input") return false;
  const metadata = intervention.metadata && typeof intervention.metadata === "object"
    ? intervention.metadata
    : null;
  const source = normalize(metadata?.source);
  const reasonCode = normalize(metadata?.reasonCode);
  if (
    source !== "ask_user"
    && source !== "request_user_input"
    && reasonCode !== "planner_natural_question"
    && reasonCode !== "planner_required_question_missing"
    && reasonCode !== "planner_chat_question"
  ) {
    return false;
  }
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  const interventionRunId = typeof metadata?.runId === "string" ? metadata.runId.trim() : "";
  if (runId && interventionRunId && interventionRunId !== runId) return false;
  const phase = normalize(metadata?.phase);
  const phaseKey = normalize(metadata?.phaseKey);
  const phaseName = normalize(metadata?.phaseName);
  const stepType = normalize(metadata?.stepType);
  const ownerKind = normalize(metadata?.questionOwnerKind);
  return reasonCode === "planner_natural_question"
    || reasonCode === "planner_required_question_missing"
    || reasonCode === "planner_chat_question"
    || phase === "planning"
    || phaseKey === "planning"
    || phaseName === "planning"
    || stepType === "planning"
    || ownerKind === "planner";
}

export function hasResolvedPlanningQuestionIntervention(
  interventions: Array<InterventionLike | MissionIntervention>,
  args: { runId?: string | null } = {},
): boolean {
  return interventions.some((entry) =>
    normalize(entry.status) === "resolved" && isPlanningQuestionIntervention(entry, args)
  );
}
