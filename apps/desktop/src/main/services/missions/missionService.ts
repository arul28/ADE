import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
  ClonePhaseProfileArgs,
  CreateMissionArgs,
  DeletePhaseProfileArgs,
  GetPlannerAttemptArgs,
  ImportPhaseProfileArgs,
  ListPlannerRunsArgs,
  ListPhaseProfilesArgs,
  MissionConcurrencyCheckResult,
  MissionConcurrencyConfig,
  MissionDashboardSnapshot,
  MissionExecutionPolicy,
  MissionLaneClaimCheckResult,
  MissionPhaseConfiguration,
  MissionPhaseOverride,
  MissionPlannerAttempt,
  MissionPlannerRun,
  ListMissionsArgs,
  MissionArtifact,
  MissionArtifactType,
  MissionDetail,
  MissionEvent,
  MissionExecutionMode,
  MissionIntervention,
  MissionInterventionStatus,
  MissionInterventionType,
  MissionPriority,
  MissionsEventPayload,
  MissionStatus,
  MissionStep,
  MissionStepStatus,
  MissionSummary,
  ThinkingLevel,
  PhaseCard,
  PhaseProfile,
  SavePhaseProfileArgs,
  ExportPhaseProfileArgs,
  ExportPhaseProfileResult,
  PlannerPlan,
  PlannerClarifyingQuestion,
  PlannerClarifyingAnswer,
  ResolveMissionInterventionArgs,
  DeleteMissionArgs,
  UpdateMissionArgs,
  UpdateMissionStepArgs
} from "../../../shared/types";
import { DEFAULT_EXECUTION_POLICY } from "../orchestrator/executionPolicy";
import type { AdeDb } from "../state/kvDb";
import { buildDeterministicMissionPlan } from "./missionPlanner";
import type { MissionPlanStepDraft } from "./missionPlanningService";
import {
  applyPhaseCardsToPlanSteps,
  createBuiltInPhaseCards,
  createBuiltInPhaseProfiles,
  normalizeProfileInput,
  validatePhaseSequence,
  groupMissionStepsByPhase,
} from "./phaseEngine";
import { isRecord, nowIso, safeJsonParse } from "../shared/utils";

const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(["completed", "partially_completed", "failed", "canceled"]);

const ACTIVE_MISSION_STATUSES = new Set<MissionStatus>(["in_progress", "planning", "plan_review", "intervention_required"]);

const DEFAULT_CONCURRENCY_CONFIG: MissionConcurrencyConfig = {
  maxConcurrentMissions: 3,
  laneExclusivity: true
};

const PRIORITY_ORDER: Record<MissionPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
};

const MISSION_TRANSITIONS: Record<MissionStatus, Set<MissionStatus>> = {
  queued: new Set(["queued", "planning", "in_progress", "canceled"]),
  planning: new Set(["planning", "plan_review", "in_progress", "intervention_required", "failed", "canceled", "queued"]),
  plan_review: new Set(["plan_review", "in_progress", "queued", "failed", "canceled", "intervention_required"]),
  in_progress: new Set(["in_progress", "intervention_required", "completed", "partially_completed", "failed", "canceled", "plan_review"]),
  intervention_required: new Set(["intervention_required", "in_progress", "failed", "canceled", "plan_review"]),
  completed: new Set(["completed", "queued"]),
  partially_completed: new Set(["partially_completed", "queued"]),
  failed: new Set(["failed", "queued", "planning", "in_progress", "canceled"]),
  canceled: new Set(["canceled", "queued", "planning", "in_progress"])
};

const STEP_TRANSITIONS: Record<MissionStepStatus, Set<MissionStepStatus>> = {
  pending: new Set(["pending", "running", "skipped", "blocked", "canceled"]),
  running: new Set(["running", "succeeded", "failed", "blocked", "canceled"]),
  blocked: new Set(["blocked", "running", "failed", "canceled", "skipped"]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed", "running", "canceled"]),
  skipped: new Set(["skipped"]),
  canceled: new Set(["canceled"])
};

const PLANNER_CLARIFY_SOURCE = "planner_clarifying_question";

type PlannerClarifyingInterventionMetadata = {
  source: typeof PLANNER_CLARIFY_SOURCE;
  questionIndex: number;
  question: string;
  context?: string;
  defaultAssumption?: string;
  impact?: string;
};

type MissionRow = {
  id: string;
  title: string;
  prompt: string;
  lane_id: string | null;
  lane_name: string | null;
  status: string;
  priority: string;
  execution_mode: string;
  target_machine_id: string | null;
  outcome_summary: string | null;
  last_error: string | null;
  artifact_count: number;
  open_interventions: number;
  total_steps: number;
  completed_steps: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type MissionStepRow = {
  id: string;
  mission_id: string;
  step_index: number;
  title: string;
  detail: string | null;
  kind: string;
  lane_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata_json: string | null;
};

type MissionEventRow = {
  id: string;
  mission_id: string;
  event_type: string;
  actor: string;
  summary: string;
  payload_json: string | null;
  created_at: string;
};

type MissionArtifactRow = {
  id: string;
  mission_id: string;
  artifact_type: string;
  title: string;
  description: string | null;
  uri: string | null;
  lane_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
};

type MissionInterventionRow = {
  id: string;
  mission_id: string;
  intervention_type: string;
  status: string;
  title: string;
  body: string;
  requested_action: string | null;
  resolution_note: string | null;
  lane_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  metadata_json: string | null;
};

type PhaseProfileRow = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  phases_json: string;
  is_built_in: number;
  is_default: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type PhaseCardRow = {
  id: string;
  project_id: string;
  phase_key: string;
  name: string;
  description: string;
  instructions: string;
  model_json: string;
  budget_json: string | null;
  ordering_constraints_json: string | null;
  ask_questions_json: string | null;
  validation_gate_json: string | null;
  is_built_in: number;
  is_custom: number;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type MissionPhaseOverrideRow = {
  id: string;
  mission_id: string;
  profile_id: string | null;
  phases_json: string;
  created_at: string;
  updated_at: string;
};

type CreateMissionInternalArgs = CreateMissionArgs & {
  plannedSteps?: MissionPlanStepDraft[];
  plannerRun?: MissionPlannerRun | null;
  plannerPlan?: PlannerPlan | null;
};

function safeParseRecord(raw: string | null): Record<string, unknown> | null {
  const parsed = safeJsonParse(raw, null);
  return isRecord(parsed) ? parsed : null;
}

function safeParseArray(raw: string | null): unknown[] {
  const parsed = safeJsonParse(raw, null);
  return Array.isArray(parsed) ? parsed : [];
}

function coerceNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function coerceBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function normalizePlannerClarifyingQuestion(value: unknown): PlannerClarifyingQuestion | null {
  if (!isRecord(value)) return null;
  const question = String(value.question ?? "").trim();
  if (!question.length) return null;
  const context = String(value.context ?? "").trim();
  const defaultAssumption = String(value.defaultAssumption ?? "").trim();
  const impact = String(value.impact ?? "").trim();
  return {
    question,
    ...(context.length ? { context: context.slice(0, 800) } : {}),
    ...(defaultAssumption.length ? { defaultAssumption: defaultAssumption.slice(0, 800) } : {}),
    ...(impact.length ? { impact: impact.slice(0, 800) } : {})
  };
}

function normalizePlannerClarifyingQuestions(value: unknown): PlannerClarifyingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizePlannerClarifyingQuestion(entry))
    .filter((entry): entry is PlannerClarifyingQuestion => entry != null)
    .slice(0, 10);
}

function normalizePlannerClarifyingAnswer(value: unknown): PlannerClarifyingAnswer | null {
  if (!isRecord(value)) return null;
  const question = String(value.question ?? "").trim();
  const answer = String(value.answer ?? "").trim();
  if (!question.length || !answer.length) return null;
  const questionIndexRaw = Number(value.questionIndex);
  const source = value.source === "default_assumption" ? "default_assumption" : "user";
  const answeredAtRaw = String(value.answeredAt ?? "").trim();
  const context = String(value.context ?? "").trim();
  const defaultAssumption = String(value.defaultAssumption ?? "").trim();
  const impact = String(value.impact ?? "").trim();
  return {
    questionIndex: Number.isFinite(questionIndexRaw) ? Math.max(0, Math.floor(questionIndexRaw)) : 0,
    question,
    answer,
    source,
    answeredAt: answeredAtRaw.length ? answeredAtRaw : nowIso(),
    ...(context.length ? { context: context.slice(0, 800) } : {}),
    ...(defaultAssumption.length ? { defaultAssumption: defaultAssumption.slice(0, 800) } : {}),
    ...(impact.length ? { impact: impact.slice(0, 800) } : {})
  };
}

function normalizePlannerClarifyingAnswers(value: unknown): PlannerClarifyingAnswer[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizePlannerClarifyingAnswer(entry))
    .filter((entry): entry is PlannerClarifyingAnswer => entry != null)
    .slice(0, 20);
}

function isPlannerClarifyingInterventionMetadata(
  metadata: Record<string, unknown> | null
): metadata is PlannerClarifyingInterventionMetadata {
  if (!metadata) return false;
  return metadata.source === PLANNER_CLARIFY_SOURCE && Number.isFinite(Number(metadata.questionIndex));
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "none"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "max";
}

function toModelConfig(value: unknown): PhaseCard["model"] {
  const record = isRecord(value) ? value : {};
  const provider = record.provider === "claude" || record.provider === "codex" ? record.provider : "claude";
  const modelId = typeof record.modelId === "string" && record.modelId.trim().length > 0
    ? record.modelId.trim()
    : provider === "claude"
      ? "claude-sonnet-4-6"
      : "gpt-5.3-codex";
  const thinkingLevel = isThinkingLevel(record.thinkingLevel) ? record.thinkingLevel : undefined;
  return {
    provider,
    modelId,
    ...(thinkingLevel ? { thinkingLevel } : {})
  };
}

function toPhaseCard(value: unknown, fallbackPosition = 0): PhaseCard | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id.trim() : randomUUID();
  const phaseKey = typeof value.phaseKey === "string" && value.phaseKey.trim().length > 0
    ? value.phaseKey.trim()
    : "";
  const name = typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : phaseKey;
  if (!phaseKey.length || !name.length) return null;
  const description = typeof value.description === "string" ? value.description : "";
  const instructions = typeof value.instructions === "string" ? value.instructions : "";
  const position = Number.isFinite(Number(value.position)) ? Math.max(0, Math.floor(Number(value.position))) : fallbackPosition;
  const budget = isRecord(value.budget) ? value.budget : {};
  const orderingConstraints = isRecord(value.orderingConstraints) ? value.orderingConstraints : {};
  const askQuestions = isRecord(value.askQuestions) ? value.askQuestions : {};
  const validationGate = isRecord(value.validationGate) ? value.validationGate : {};
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : nowIso();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : nowIso();
  const tier = validationGate.tier === "none"
    || validationGate.tier === "self"
    || validationGate.tier === "spot-check"
    || validationGate.tier === "dedicated"
    ? validationGate.tier
    : "self";
  return {
    id,
    phaseKey,
    name,
    description,
    instructions,
    model: toModelConfig(value.model),
    budget: {
      maxTokens: coerceNumber(budget.maxTokens),
      maxTimeMs: coerceNumber(budget.maxTimeMs),
      maxSteps: coerceNumber(budget.maxSteps),
    },
    orderingConstraints: {
      mustBeFirst: coerceBoolean(orderingConstraints.mustBeFirst),
      mustBeLast: coerceBoolean(orderingConstraints.mustBeLast),
      mustFollow: Array.isArray(orderingConstraints.mustFollow)
        ? orderingConstraints.mustFollow.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        : [],
      mustPrecede: Array.isArray(orderingConstraints.mustPrecede)
        ? orderingConstraints.mustPrecede.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        : [],
      canLoop: coerceBoolean(orderingConstraints.canLoop),
      loopTarget: typeof orderingConstraints.loopTarget === "string" && orderingConstraints.loopTarget.trim().length > 0
        ? orderingConstraints.loopTarget.trim()
        : null
    },
    askQuestions: {
      enabled: coerceBoolean(askQuestions.enabled),
      mode: askQuestions.mode === "always" || askQuestions.mode === "auto_if_uncertain" || askQuestions.mode === "never"
        ? askQuestions.mode
        : "auto_if_uncertain",
      maxQuestions: coerceNumber(askQuestions.maxQuestions),
    },
    validationGate: {
      tier,
      required: coerceBoolean(validationGate.required, tier !== "none"),
      criteria: typeof validationGate.criteria === "string" ? validationGate.criteria : undefined,
    },
    isBuiltIn: coerceBoolean(value.isBuiltIn),
    isCustom: coerceBoolean(value.isCustom, true),
    position,
    createdAt,
    updatedAt,
  };
}

function toPhaseCards(raw: unknown[]): PhaseCard[] {
  return raw
    .map((entry, index) => toPhaseCard(entry, index))
    .filter((entry): entry is PhaseCard => entry != null)
    .sort((a, b) => a.position - b.position)
    .map((phase, index) => ({ ...phase, position: index }));
}

function normalizePhaseCards(phases: PhaseCard[]): PhaseCard[] {
  return phases
    .map((phase, index) => ({ ...phase, position: index }))
    .sort((a, b) => a.position - b.position)
    .map((phase, index) => ({ ...phase, position: index }));
}

function toPhaseProfile(row: PhaseProfileRow): PhaseProfile {
  const phases = toPhaseCards(safeParseArray(row.phases_json));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    phases,
    isBuiltIn: Number(row.is_built_in) === 1,
    isDefault: Number(row.is_default) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMissionPhaseOverride(row: MissionPhaseOverrideRow): MissionPhaseOverride {
  return {
    id: row.id,
    missionId: row.mission_id,
    profileId: row.profile_id,
    phases: toPhaseCards(safeParseArray(row.phases_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sanitizeFilePart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
  const cleaned = normalized.replace(/^-+/, "").replace(/-+$/, "");
  return cleaned.length ? cleaned : "phase-profile";
}

export function normalizeMissionStatus(value: string): MissionStatus {
  if (
    value === "queued" ||
    value === "planning" ||
    value === "plan_review" ||
    value === "in_progress" ||
    value === "intervention_required" ||
    value === "completed" ||
    value === "partially_completed" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  return "queued";
}

function normalizeMissionPriority(value: string): MissionPriority {
  if (value === "urgent" || value === "high" || value === "normal" || value === "low") return value;
  return "normal";
}

function normalizeExecutionMode(value: string): MissionExecutionMode {
  if (value === "local" || value === "relay") return value;
  return "local";
}

function normalizeStepStatus(value: string): MissionStepStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped" ||
    value === "blocked" ||
    value === "canceled"
  ) {
    return value;
  }
  return "pending";
}

function normalizeArtifactType(value: string): MissionArtifactType {
  if (value === "summary" || value === "pr" || value === "link" || value === "note" || value === "patch") return value;
  return "note";
}

function normalizeInterventionType(value: string): MissionInterventionType {
  if (value === "approval_required" || value === "manual_input" || value === "conflict" || value === "policy_block" || value === "failed_step") {
    return value;
  }
  return "manual_input";
}

function normalizeInterventionStatus(value: string): MissionInterventionStatus {
  if (value === "open" || value === "resolved" || value === "dismissed") return value;
  return "open";
}

function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizePrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine.length) return "Mission";
  if (oneLine.length <= 88) return oneLine;
  return `${oneLine.slice(0, 85)}...`;
}

function deriveMissionTitle(prompt: string, explicit?: string): string {
  const cleanedExplicit = (explicit ?? "").trim();
  if (cleanedExplicit.length) return cleanedExplicit.slice(0, 140);
  const firstSentence = normalizePrompt(prompt).split(/(?<=[.!?])\s+/)[0] ?? "";
  const compact = firstSentence.trim() || summarizePrompt(prompt);
  return compact.slice(0, 140);
}

function sanitizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function coerceNullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function truncateForMetadata(value: string | null, maxChars = 120_000): string | null {
  if (!value) return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...<truncated>`;
}

function mergeWithDefaults(partial: Partial<MissionExecutionPolicy>): MissionExecutionPolicy {
  const base = DEFAULT_EXECUTION_POLICY;
  return {
    planning: { ...base.planning, ...partial.planning },
    implementation: { ...base.implementation, ...partial.implementation },
    testing: { ...base.testing, ...partial.testing },
    validation: { ...base.validation, ...partial.validation },
    codeReview: { ...base.codeReview, ...partial.codeReview },
    testReview: { ...base.testReview, ...partial.testReview },
    prReview: { ...(base.prReview ?? { mode: "off" as const }), ...partial.prReview },
    merge: { ...base.merge, ...partial.merge },
    completion: { ...base.completion, ...partial.completion }
  };
}


function toPlannerAttempt(value: unknown): MissionPlannerAttempt | null {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? "").trim();
  const engine = String(value.engine ?? "").trim();
  const status = String(value.status ?? "").trim();
  if (!id.length || !engine.length || (status !== "succeeded" && status !== "failed")) return null;
  return {
    id,
    engine: engine as MissionPlannerAttempt["engine"],
    status: status as MissionPlannerAttempt["status"],
    reasonCode: typeof value.reasonCode === "string" ? (value.reasonCode as MissionPlannerAttempt["reasonCode"]) : null,
    detail: typeof value.detail === "string" ? value.detail : null,
    commandPreview: typeof value.commandPreview === "string" ? value.commandPreview : null,
    rawResponse: typeof value.rawResponse === "string" ? value.rawResponse : null,
    validationErrors: Array.isArray(value.validationErrors)
      ? value.validationErrors.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso()
  };
}

function toPlannerRunFromEvent(row: MissionEventRow): MissionPlannerRun | null {
  if (row.event_type !== "mission_plan_generated") return null;
  const payload = safeParseRecord(row.payload_json);
  if (!payload) return null;
  const runId = String(payload.plannerRunId ?? "").trim();
  if (!runId.length) return null;
  const attemptsRaw = Array.isArray(payload.attempts) ? payload.attempts : [];
  const attempts = attemptsRaw.map((entry) => toPlannerAttempt(entry)).filter((entry): entry is MissionPlannerAttempt => entry != null);
  const validationErrors = Array.isArray(payload.validationErrors)
    ? payload.validationErrors.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
    : [];
  const rawResolvedEngine = String(payload.resolvedEngine ?? "").trim();
  const resolvedEngine: MissionPlannerRun["resolvedEngine"] =
    rawResolvedEngine === "claude_cli" || rawResolvedEngine === "codex_cli"
      ? rawResolvedEngine
      : null;
  return {
    id: runId,
    missionId: row.mission_id,
    requestedEngine: String(payload.requestedEngine ?? "auto") as MissionPlannerRun["requestedEngine"],
    resolvedEngine,
    status: resolvedEngine != null && payload.degraded !== true ? "succeeded" : "skipped",
    degraded: payload.degraded === true,
    reasonCode: typeof payload.reasonCode === "string" ? (payload.reasonCode as MissionPlannerRun["reasonCode"]) : null,
    reasonDetail: typeof payload.reasonDetail === "string" ? payload.reasonDetail : null,
    planHash: typeof payload.planHash === "string" && payload.planHash.length > 0 ? payload.planHash : "",
    normalizedPlanHash:
      typeof payload.normalizedPlanHash === "string" && payload.normalizedPlanHash.length > 0 ? payload.normalizedPlanHash : "",
    commandPreview: typeof payload.commandPreview === "string" ? payload.commandPreview : null,
    rawResponse: typeof payload.rawResponse === "string" ? payload.rawResponse : null,
    createdAt: row.created_at,
    durationMs: Number.isFinite(Number(payload.durationMs)) ? Math.floor(Number(payload.durationMs)) : 0,
    validationErrors,
    attempts
  };
}

function toMissionSummary(row: MissionRow): MissionSummary {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    laneId: row.lane_id,
    laneName: row.lane_name,
    status: normalizeMissionStatus(row.status),
    priority: normalizeMissionPriority(row.priority),
    executionMode: normalizeExecutionMode(row.execution_mode),
    targetMachineId: row.target_machine_id,
    outcomeSummary: row.outcome_summary,
    lastError: row.last_error,
    artifactCount: Number(row.artifact_count ?? 0),
    openInterventions: Number(row.open_interventions ?? 0),
    totalSteps: Number(row.total_steps ?? 0),
    completedSteps: Number(row.completed_steps ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function toMissionStep(row: MissionStepRow): MissionStep {
  return {
    id: row.id,
    missionId: row.mission_id,
    index: Number(row.step_index ?? 0),
    title: row.title,
    detail: row.detail,
    kind: row.kind,
    laneId: row.lane_id,
    status: normalizeStepStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    metadata: safeParseRecord(row.metadata_json)
  };
}

function toMissionEvent(row: MissionEventRow): MissionEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    eventType: row.event_type,
    actor: row.actor,
    summary: row.summary,
    payload: safeParseRecord(row.payload_json),
    createdAt: row.created_at
  };
}

function toMissionArtifact(row: MissionArtifactRow): MissionArtifact {
  return {
    id: row.id,
    missionId: row.mission_id,
    artifactType: normalizeArtifactType(row.artifact_type),
    title: row.title,
    description: row.description,
    uri: row.uri,
    laneId: row.lane_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: safeParseRecord(row.metadata_json)
  };
}

function toMissionIntervention(row: MissionInterventionRow): MissionIntervention {
  return {
    id: row.id,
    missionId: row.mission_id,
    interventionType: normalizeInterventionType(row.intervention_type),
    status: normalizeInterventionStatus(row.status),
    title: row.title,
    body: row.body,
    requestedAction: row.requested_action,
    resolutionNote: row.resolution_note,
    laneId: row.lane_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    metadata: safeParseRecord(row.metadata_json)
  };
}

function hasTransition(
  graph: Record<MissionStatus, Set<MissionStatus>>,
  from: MissionStatus,
  to: MissionStatus
): boolean {
  return graph[from]?.has(to) ?? false;
}

export function isValidMissionTransition(from: MissionStatus, to: MissionStatus): boolean {
  return hasTransition(MISSION_TRANSITIONS, from, to);
}

export function isValidMissionStepTransition(from: MissionStepStatus, to: MissionStepStatus): boolean {
  return STEP_TRANSITIONS[from]?.has(to) ?? false;
}

export function createMissionService({
  db,
  projectId,
  projectRoot,
  onEvent,
  concurrencyConfig
}: {
  db: AdeDb;
  projectId: string;
  projectRoot?: string;
  onEvent?: (payload: MissionsEventPayload) => void;
  concurrencyConfig?: Partial<MissionConcurrencyConfig>;
}) {
  let activeConcurrencyConfig: MissionConcurrencyConfig = {
    ...DEFAULT_CONCURRENCY_CONFIG,
    ...concurrencyConfig
  };

  // Late-bound reference to the service object for use in internal helpers.
  // Assigned after the return object is created. Uses a minimal interface
  // to avoid circular type dependency.
  let serviceRef: { processQueue(): string[] } | null = null;

  const emit = (payload: Omit<MissionsEventPayload, "type" | "at">) => {
    try {
      onEvent?.({
        type: "missions-updated",
        at: nowIso(),
        ...payload
      });
    } catch {
      // Ignore broadcast failures.
    }
  };

  const assertLaneExists = (laneId: string | null | undefined) => {
    if (!laneId) return;
    const hit = db.get<{ id: string }>(
      "select id from lanes where id = ? and project_id = ? and status != 'archived' limit 1",
      [laneId, projectId]
    );
    if (!hit?.id) {
      throw new Error(`Lane not found or archived: ${laneId}`);
    }
  };

  const baseMissionSelect = `
    select
      m.id as id,
      m.title as title,
      m.prompt as prompt,
      m.lane_id as lane_id,
      l.name as lane_name,
      m.status as status,
      m.priority as priority,
      m.execution_mode as execution_mode,
      m.target_machine_id as target_machine_id,
      m.outcome_summary as outcome_summary,
      m.last_error as last_error,
      (
        select count(*)
        from mission_artifacts ma
        where ma.project_id = m.project_id and ma.mission_id = m.id
      ) as artifact_count,
      (
        select count(*)
        from mission_interventions mi
        where mi.project_id = m.project_id and mi.mission_id = m.id and mi.status = 'open'
      ) as open_interventions,
      (
        select count(*)
        from mission_steps ms
        where ms.project_id = m.project_id and ms.mission_id = m.id
      ) as total_steps,
      (
        select count(*)
        from mission_steps ms
        where ms.project_id = m.project_id and ms.mission_id = m.id and ms.status in ('succeeded', 'skipped')
      ) as completed_steps,
      m.created_at as created_at,
      m.updated_at as updated_at,
      m.started_at as started_at,
      m.completed_at as completed_at
    from missions m
    left join lanes l on l.id = m.lane_id
    where m.project_id = ?
  `;

  const getMissionRow = (missionId: string): MissionRow | null => {
    return db.get<MissionRow>(
      `${baseMissionSelect}
       and m.id = ?
       limit 1`,
      [projectId, missionId]
    );
  };

  const recordEvent = (args: {
    missionId: string;
    eventType: string;
    actor: string;
    summary: string;
    payload?: Record<string, unknown> | null;
  }): MissionEvent => {
    const id = randomUUID();
    const createdAt = nowIso();
    db.run(
      `
        insert into mission_events(
          id,
          mission_id,
          project_id,
          event_type,
          actor,
          summary,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        args.missionId,
        projectId,
        args.eventType,
        args.actor,
        args.summary,
        args.payload ? JSON.stringify(args.payload) : null,
        createdAt
      ]
    );
    return {
      id,
      missionId: args.missionId,
      eventType: args.eventType,
      actor: args.actor,
      summary: args.summary,
      payload: args.payload ?? null,
      createdAt
    };
  };

  const upsertMissionStatus = (args: {
    missionId: string;
    nextStatus: MissionStatus;
    updatedAt?: string;
    summary?: string;
    payload?: Record<string, unknown>;
    actor?: string;
  }) => {
    const row = db.get<{
      status: string;
      started_at: string | null;
      completed_at: string | null;
    }>(
      "select status, started_at, completed_at from missions where id = ? and project_id = ? limit 1",
      [args.missionId, projectId]
    );
    if (!row) throw new Error(`Mission not found: ${args.missionId}`);

    const previous = normalizeMissionStatus(row.status);
    const next = args.nextStatus;
    if (!isValidMissionTransition(previous, next)) {
      throw new Error(`Invalid mission transition: ${previous} -> ${next}`);
    }

    const updatedAt = args.updatedAt ?? nowIso();
    let startedAt = row.started_at;
    let completedAt = row.completed_at;

    if (next === "planning" || next === "plan_review" || next === "in_progress") {
      if (!startedAt) startedAt = updatedAt;
      completedAt = null;
    } else if (next === "queued") {
      startedAt = null;
      completedAt = null;
    } else if (TERMINAL_MISSION_STATUSES.has(next)) {
      completedAt = updatedAt;
      if (!startedAt) startedAt = updatedAt;
    }

    db.run(
      `
        update missions
        set status = ?,
            started_at = ?,
            completed_at = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [next, startedAt, completedAt, updatedAt, args.missionId, projectId]
    );

    if (next === "plan_review") {
      try {
        ensurePlanReviewClarifyingQuestionInterventions(args.missionId);
      } catch {
        // Best-effort intervention hydration. Status transition should still succeed.
      }
    }

    if (previous !== next) {
      recordEvent({
        missionId: args.missionId,
        eventType: "mission_status_changed",
        actor: args.actor ?? "user",
        summary: args.summary ?? `Mission status changed to ${next}.`,
        payload: {
          from: previous,
          to: next,
          ...(args.payload ?? {})
        }
      });

      // When a mission reaches a terminal status, process the queue to
      // start the next eligible queued mission.
      if (TERMINAL_MISSION_STATUSES.has(next) && serviceRef) {
        try {
          serviceRef.processQueue();
        } catch {
          // Ignore queue processing failures — they should not break
          // the status transition that already succeeded.
        }
      }
    }
  };

  const insertArtifact = (args: {
    missionId: string;
    artifactType: MissionArtifactType;
    title: string;
    description?: string | null;
    uri?: string | null;
    laneId?: string | null;
    createdBy: string;
    metadata?: Record<string, unknown> | null;
  }): MissionArtifact => {
    assertLaneExists(args.laneId ?? null);

    const id = randomUUID();
    const createdAt = nowIso();
    const title = args.title.trim();
    if (!title.length) throw new Error("Artifact title is required");

    const description = sanitizeOptionalText(args.description ?? null);
    const uri = coerceNullableString(args.uri);

    db.run(
      `
        insert into mission_artifacts(
          id,
          mission_id,
          project_id,
          artifact_type,
          title,
          description,
          uri,
          lane_id,
          metadata_json,
          created_at,
          updated_at,
          created_by
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        args.missionId,
        projectId,
        args.artifactType,
        title,
        description,
        uri,
        args.laneId ?? null,
        args.metadata ? JSON.stringify(args.metadata) : null,
        createdAt,
        createdAt,
        args.createdBy
      ]
    );

    return {
      id,
      missionId: args.missionId,
      artifactType: args.artifactType,
      title,
      description,
      uri,
      laneId: args.laneId ?? null,
      createdBy: args.createdBy,
      createdAt,
      updatedAt: createdAt,
      metadata: args.metadata ?? null
    };
  };

  const insertIntervention = (args: {
    missionId: string;
    interventionType: MissionInterventionType;
    title: string;
    body: string;
    requestedAction?: string | null;
    laneId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): MissionIntervention => {
    assertLaneExists(args.laneId ?? null);

    const id = randomUUID();
    const createdAt = nowIso();
    const title = args.title.trim();
    const body = args.body.trim();
    if (!title.length) throw new Error("Intervention title is required");
    if (!body.length) throw new Error("Intervention body is required");

    db.run(
      `
        insert into mission_interventions(
          id,
          mission_id,
          project_id,
          intervention_type,
          status,
          title,
          body,
          requested_action,
          resolution_note,
          lane_id,
          metadata_json,
          created_at,
          updated_at,
          resolved_at
        ) values (?, ?, ?, ?, 'open', ?, ?, ?, null, ?, ?, ?, ?, null)
      `,
      [
        id,
        args.missionId,
        projectId,
        args.interventionType,
        title,
        body,
        sanitizeOptionalText(args.requestedAction ?? null),
        args.laneId ?? null,
        args.metadata ? JSON.stringify(args.metadata) : null,
        createdAt,
        createdAt
      ]
    );

    return {
      id,
      missionId: args.missionId,
      interventionType: args.interventionType,
      status: "open",
      title,
      body,
      requestedAction: sanitizeOptionalText(args.requestedAction ?? null),
      resolutionNote: null,
      laneId: args.laneId ?? null,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      metadata: args.metadata ?? null
    };
  };

  const parsePlannerPlanFromMissionMetadata = (missionId: string): {
    metadata: Record<string, unknown>;
    plannerPlan: Record<string, unknown>;
  } | null => {
    const row = db.get<{ metadata_json: string | null }>(
      "select metadata_json from missions where id = ? and project_id = ? limit 1",
      [missionId, projectId]
    );
    const metadata = safeParseRecord(row?.metadata_json ?? null);
    if (!metadata) return null;
    const plannerPlan = isRecord(metadata.plannerPlan) ? metadata.plannerPlan : null;
    if (!plannerPlan) return null;
    return { metadata, plannerPlan };
  };

  const propagatePlannerClarifyingAnswersToSteps = (args: {
    missionId: string;
    questions: PlannerClarifyingQuestion[];
    answers: PlannerClarifyingAnswer[];
    updatedAt: string;
  }) => {
    const stepRows = db.all<{ id: string; metadata_json: string | null }>(
      `
        select id, metadata_json
        from mission_steps
        where mission_id = ?
          and project_id = ?
      `,
      [args.missionId, projectId]
    );
    for (const row of stepRows) {
      const metadata = safeParseRecord(row.metadata_json) ?? {};
      metadata.plannerClarifyingQuestions = args.questions;
      metadata.plannerClarifyingAnswers = args.answers;
      db.run(
        `
          update mission_steps
          set metadata_json = ?,
              updated_at = ?
          where id = ?
            and mission_id = ?
            and project_id = ?
        `,
        [JSON.stringify(metadata), args.updatedAt, row.id, args.missionId, projectId]
      );
    }
  };

  const persistPlannerClarifyingAnswer = (args: {
    missionId: string;
    questionIndex: number;
    note: string | null;
    status: Exclude<MissionInterventionStatus, "open">;
    fallbackQuestion?: string;
    fallbackContext?: string;
    fallbackDefaultAssumption?: string;
    fallbackImpact?: string;
  }) => {
    const parsed = parsePlannerPlanFromMissionMetadata(args.missionId);
    if (!parsed) return;

    const questions = normalizePlannerClarifyingQuestions(parsed.plannerPlan.clarifyingQuestions);
    const existingAnswers = normalizePlannerClarifyingAnswers(parsed.plannerPlan.clarifyingAnswers);
    const question = questions[args.questionIndex] ?? {
      question: args.fallbackQuestion ?? `Clarifying question ${args.questionIndex + 1}`,
      ...(args.fallbackContext ? { context: args.fallbackContext } : {}),
      ...(args.fallbackDefaultAssumption ? { defaultAssumption: args.fallbackDefaultAssumption } : {}),
      ...(args.fallbackImpact ? { impact: args.fallbackImpact } : {})
    };

    const noteValue = String(args.note ?? "").trim();
    const defaultAssumption = question.defaultAssumption ?? args.fallbackDefaultAssumption ?? "Proceed with conservative assumptions.";
    const useUserAnswer = args.status === "resolved" && noteValue.length > 0;
    const answer: PlannerClarifyingAnswer = {
      questionIndex: Math.max(0, args.questionIndex),
      question: question.question,
      answer: useUserAnswer ? noteValue : defaultAssumption,
      source: useUserAnswer ? "user" : "default_assumption",
      answeredAt: nowIso(),
      ...(question.context ? { context: question.context } : {}),
      ...(defaultAssumption ? { defaultAssumption } : {}),
      ...(question.impact ? { impact: question.impact } : {})
    };

    const mergedAnswers = [
      ...existingAnswers.filter((entry) => entry.questionIndex !== answer.questionIndex),
      answer
    ].sort((a, b) => a.questionIndex - b.questionIndex || a.question.localeCompare(b.question));

    parsed.plannerPlan.clarifyingQuestions = questions;
    parsed.plannerPlan.clarifyingAnswers = mergedAnswers;
    parsed.metadata.plannerPlan = parsed.plannerPlan;

    const updatedAt = nowIso();
    db.run(
      `
        update missions
        set metadata_json = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [JSON.stringify(parsed.metadata), updatedAt, args.missionId, projectId]
    );

    propagatePlannerClarifyingAnswersToSteps({
      missionId: args.missionId,
      questions,
      answers: mergedAnswers,
      updatedAt
    });
  };

  const ensurePlanReviewClarifyingQuestionInterventions = (missionId: string) => {
    const parsed = parsePlannerPlanFromMissionMetadata(missionId);
    if (!parsed) return;
    const questions = normalizePlannerClarifyingQuestions(parsed.plannerPlan.clarifyingQuestions);
    if (!questions.length) return;

    const existingRows = db.all<{ metadata_json: string | null; status: string }>(
      `
        select metadata_json, status
        from mission_interventions
        where mission_id = ?
          and project_id = ?
          and intervention_type = 'manual_input'
      `,
      [missionId, projectId]
    );

    const seenQuestionIndexes = new Set<number>();
    for (const row of existingRows) {
      const metadata = safeParseRecord(row.metadata_json);
      if (!isPlannerClarifyingInterventionMetadata(metadata)) continue;
      seenQuestionIndexes.add(Math.max(0, Math.floor(Number(metadata.questionIndex))));
    }

    const createdInterventions: string[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      if (seenQuestionIndexes.has(index)) continue;
      const question = questions[index]!;
      const bodyParts = [
        question.question,
        question.context ? `Context: ${question.context}` : null,
        question.impact ? `Impact: ${question.impact}` : null,
        question.defaultAssumption ? `Default assumption if unanswered: ${question.defaultAssumption}` : null,
      ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
      const intervention = insertIntervention({
        missionId,
        interventionType: "manual_input",
        title: `Planning clarification ${index + 1}/${questions.length}`,
        body: bodyParts.join("\n\n"),
        requestedAction: "Provide guidance or dismiss to accept the default assumption.",
        metadata: {
          source: PLANNER_CLARIFY_SOURCE,
          questionIndex: index,
          question: question.question,
          ...(question.context ? { context: question.context } : {}),
          ...(question.defaultAssumption ? { defaultAssumption: question.defaultAssumption } : {}),
          ...(question.impact ? { impact: question.impact } : {})
        }
      });
      createdInterventions.push(intervention.id);
    }

    if (!createdInterventions.length) return;

    recordEvent({
      missionId,
      eventType: "mission_intervention_added",
      actor: "system",
      summary: `Planner requested ${createdInterventions.length} clarification question${createdInterventions.length === 1 ? "" : "s"}.`,
      payload: {
        interventionIds: createdInterventions,
        source: PLANNER_CLARIFY_SOURCE
      }
    });
  };

  const profilesDir = projectRoot ? path.join(projectRoot, ".ade", "profiles") : null;
  let phaseStorageSeeded = false;

  const listPhaseProfileRows = (includeArchived = false): PhaseProfileRow[] =>
    db.all<PhaseProfileRow>(
      `
        select
          id,
          project_id,
          name,
          description,
          phases_json,
          is_built_in,
          is_default,
          created_at,
          updated_at,
          archived_at
        from phase_profiles
        where project_id = ?
          ${includeArchived ? "" : "and archived_at is null"}
        order by is_default desc, is_built_in desc, updated_at desc, name asc
      `,
      [projectId]
    );

  const getPhaseProfileRow = (profileId: string): PhaseProfileRow | null =>
    db.get<PhaseProfileRow>(
      `
        select
          id,
          project_id,
          name,
          description,
          phases_json,
          is_built_in,
          is_default,
          created_at,
          updated_at,
          archived_at
        from phase_profiles
        where project_id = ?
          and id = ?
        limit 1
      `,
      [projectId, profileId]
    );

  const getDefaultPhaseProfileRow = (): PhaseProfileRow | null =>
    db.get<PhaseProfileRow>(
      `
        select
          id,
          project_id,
          name,
          description,
          phases_json,
          is_built_in,
          is_default,
          created_at,
          updated_at,
          archived_at
        from phase_profiles
        where project_id = ?
          and archived_at is null
          and is_default = 1
        order by updated_at desc
        limit 1
      `,
      [projectId]
    );

  const upsertPhaseCardRow = (card: PhaseCard) => {
    const existing = db.get<{ id: string }>(
      `
        select id
        from phase_cards
        where project_id = ?
          and phase_key = ?
        limit 1
      `,
      [projectId, card.phaseKey]
    );
    if (existing?.id) {
      db.run(
        `
          update phase_cards
          set id = ?,
              name = ?,
              description = ?,
              instructions = ?,
              model_json = ?,
              budget_json = ?,
              ordering_constraints_json = ?,
              ask_questions_json = ?,
              validation_gate_json = ?,
              is_built_in = ?,
              is_custom = ?,
              position = ?,
              archived_at = null,
              updated_at = ?
          where project_id = ?
            and phase_key = ?
        `,
        [
          card.id,
          card.name,
          card.description,
          card.instructions,
          JSON.stringify(card.model),
          JSON.stringify(card.budget ?? {}),
          JSON.stringify(card.orderingConstraints ?? {}),
          JSON.stringify(card.askQuestions ?? {}),
          JSON.stringify(card.validationGate ?? {}),
          card.isBuiltIn ? 1 : 0,
          card.isCustom ? 1 : 0,
          card.position,
          nowIso(),
          projectId,
          card.phaseKey
        ]
      );
      return;
    }
    db.run(
      `
        insert into phase_cards(
          id,
          project_id,
          phase_key,
          name,
          description,
          instructions,
          model_json,
          budget_json,
          ordering_constraints_json,
          ask_questions_json,
          validation_gate_json,
          is_built_in,
          is_custom,
          position,
          archived_at,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)
      `,
      [
        card.id,
        projectId,
        card.phaseKey,
        card.name,
        card.description,
        card.instructions,
        JSON.stringify(card.model),
        JSON.stringify(card.budget ?? {}),
        JSON.stringify(card.orderingConstraints ?? {}),
        JSON.stringify(card.askQuestions ?? {}),
        JSON.stringify(card.validationGate ?? {}),
        card.isBuiltIn ? 1 : 0,
        card.isCustom ? 1 : 0,
        card.position,
        card.createdAt,
        card.updatedAt
      ]
    );
  };

  const ensurePhaseStorageSeeded = () => {
    if (phaseStorageSeeded) return;

    const cardCount = db.get<{ count: number }>(
      `
        select count(*) as count
        from phase_cards
        where project_id = ?
          and archived_at is null
      `,
      [projectId]
    )?.count ?? 0;
    if (cardCount === 0) {
      const builtInCards = createBuiltInPhaseCards(nowIso());
      for (const card of builtInCards) {
        upsertPhaseCardRow(card);
      }
    }

    const profileCount = db.get<{ count: number }>(
      `
        select count(*) as count
        from phase_profiles
        where project_id = ?
          and archived_at is null
      `,
      [projectId]
    )?.count ?? 0;

    if (profileCount === 0) {
      const cards = db
        .all<PhaseCardRow>(
          `
            select
              id,
              project_id,
              phase_key,
              name,
              description,
              instructions,
              model_json,
              budget_json,
              ordering_constraints_json,
              ask_questions_json,
              validation_gate_json,
              is_built_in,
              is_custom,
              position,
              archived_at,
              created_at,
              updated_at
            from phase_cards
            where project_id = ?
              and archived_at is null
            order by position asc
          `,
          [projectId]
        )
        .map((row) =>
          toPhaseCard(
            {
              id: row.id,
              phaseKey: row.phase_key,
              name: row.name,
              description: row.description,
              instructions: row.instructions,
              model: safeParseRecord(row.model_json),
              budget: safeParseRecord(row.budget_json),
              orderingConstraints: safeParseRecord(row.ordering_constraints_json),
              askQuestions: safeParseRecord(row.ask_questions_json),
              validationGate: safeParseRecord(row.validation_gate_json),
              isBuiltIn: Number(row.is_built_in) === 1,
              isCustom: Number(row.is_custom) === 1,
              position: row.position,
              createdAt: row.created_at,
              updatedAt: row.updated_at
            },
            row.position
          )
        )
        .filter((entry): entry is PhaseCard => entry != null);

      const builtInProfiles = createBuiltInPhaseProfiles(
        cards.length > 0 ? cards : createBuiltInPhaseCards(nowIso()),
        nowIso()
      );
      for (const profile of builtInProfiles) {
        db.run(
          `
            insert into phase_profiles(
              id,
              project_id,
              name,
              description,
              phases_json,
              is_built_in,
              is_default,
              archived_at,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)
          `,
          [
            profile.id,
            projectId,
            profile.name,
            profile.description,
            JSON.stringify(normalizePhaseCards(profile.phases)),
            1,
            profile.isDefault ? 1 : 0,
            profile.createdAt,
            profile.updatedAt
          ]
        );
      }
    }

    const existingDefault = getDefaultPhaseProfileRow();
    if (!existingDefault) {
      const builtInDefault = db.get<{ id: string }>(
        `
          select id
          from phase_profiles
          where project_id = ?
            and archived_at is null
          order by
            case when id = 'builtin:default' then 0 else 1 end,
            is_built_in desc,
            created_at asc
          limit 1
        `,
        [projectId]
      );
      if (builtInDefault?.id) {
        db.run("update phase_profiles set is_default = 0 where project_id = ?", [projectId]);
        db.run(
          "update phase_profiles set is_default = 1, updated_at = ? where project_id = ? and id = ?",
          [nowIso(), projectId, builtInDefault.id]
        );
      }
    }

    phaseStorageSeeded = true;
  };

  const getMissionPhaseOverrideRow = (missionId: string): MissionPhaseOverrideRow | null =>
    db.get<MissionPhaseOverrideRow>(
      `
        select
          id,
          mission_id,
          profile_id,
          phases_json,
          created_at,
          updated_at
        from mission_phase_overrides
        where project_id = ?
          and mission_id = ?
        limit 1
      `,
      [projectId, missionId]
    );

  const upsertMissionPhaseOverride = (args: {
    missionId: string;
    profileId: string | null;
    phases: PhaseCard[];
  }): MissionPhaseOverride => {
    const existing = getMissionPhaseOverrideRow(args.missionId);
    const now = nowIso();
    const phases = normalizePhaseCards(args.phases);
    if (existing) {
      db.run(
        `
          update mission_phase_overrides
          set profile_id = ?,
              phases_json = ?,
              updated_at = ?
          where project_id = ?
            and mission_id = ?
        `,
        [args.profileId, JSON.stringify(phases), now, projectId, args.missionId]
      );
      const next = getMissionPhaseOverrideRow(args.missionId);
      if (!next) throw new Error("Failed to update mission phase override.");
      return toMissionPhaseOverride(next);
    }

    const id = randomUUID();
    db.run(
      `
        insert into mission_phase_overrides(
          id,
          mission_id,
          project_id,
          profile_id,
          phases_json,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      [id, args.missionId, projectId, args.profileId, JSON.stringify(phases), now, now]
    );
    const created = getMissionPhaseOverrideRow(args.missionId);
    if (!created) {
      throw new Error("Failed to create mission phase override.");
    }
    return toMissionPhaseOverride(created);
  };

  const resolveMissionPhaseConfiguration = (missionId: string): MissionPhaseConfiguration | null => {
    const mission = getMissionRow(missionId);
    if (!mission) return null;
    ensurePhaseStorageSeeded();
    const overrideRow = getMissionPhaseOverrideRow(missionId);
    const override = overrideRow ? toMissionPhaseOverride(overrideRow) : null;
    const selectedProfileRow = override?.profileId ? getPhaseProfileRow(override.profileId) : null;
    const defaultProfileRow = selectedProfileRow ? null : getDefaultPhaseProfileRow();
    const profile = selectedProfileRow
      ? toPhaseProfile(selectedProfileRow)
      : defaultProfileRow
        ? toPhaseProfile(defaultProfileRow)
        : null;
    const selectedPhases = normalizePhaseCards(
      override?.phases?.length
        ? override.phases
        : profile?.phases?.length
          ? profile.phases
          : createBuiltInPhaseCards(nowIso())
    );
    return {
      profile,
      override,
      selectedPhases
    };
  };

  const ensureUniqueProfileName = (name: string, excludeProfileId?: string): string => {
    const base = name.trim() || "Custom Profile";
    const existingNames = new Set(
      listPhaseProfileRows(true)
        .filter((row) => row.id !== excludeProfileId)
        .map((row) => row.name.trim().toLowerCase())
    );
    if (!existingNames.has(base.toLowerCase())) return base;
    let idx = 2;
    while (existingNames.has(`${base} (${idx})`.toLowerCase())) {
      idx += 1;
    }
    return `${base} (${idx})`;
  };

  const estimateMissionCostUsd = (missionId: string): number | null => {
    const rows = db.all<{ metadata_json: string | null; result_envelope_json: string | null }>(
      `
        select metadata_json, result_envelope_json
        from orchestrator_attempts
        where project_id = ?
          and run_id in (
            select id
            from orchestrator_runs
            where project_id = ?
              and mission_id = ?
          )
      `,
      [projectId, projectId, missionId]
    );
    let total = 0;
    let seenAny = false;
    for (const row of rows) {
      const metadata = safeParseRecord(row.metadata_json);
      const envelope = safeParseRecord(row.result_envelope_json);
      const candidateValues = [
        metadata?.costUsd,
        metadata?.estimatedCostUsd,
        isRecord(metadata?.usage) ? (metadata.usage as Record<string, unknown>).costUsd : undefined,
        envelope?.costUsd,
        envelope?.estimatedCostUsd,
        isRecord(envelope?.usage) ? (envelope.usage as Record<string, unknown>).costUsd : undefined
      ];
      for (const candidate of candidateValues) {
        const numeric = coerceNumber(candidate);
        if (numeric == null) continue;
        total += Math.max(0, numeric);
        seenAny = true;
        break;
      }
    }
    return seenAny ? Number(total.toFixed(4)) : null;
  };

  const mapMissionQuickAction = (status: MissionStatus): "view" | "rerun" | "retry" | "resume" => {
    if (status === "completed") return "rerun";
    if (status === "failed") return "retry";
    if (status === "partially_completed") return "resume";
    return "view";
  };

  const service = {
    list(args: ListMissionsArgs = {}): MissionSummary[] {
      const where: string[] = [];
      const params: Array<string | number> = [projectId];

      const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
      if (laneId.length) {
        where.push("m.lane_id = ?");
        params.push(laneId);
      }

      if (args.status === "active") {
        where.push("m.status in ('queued', 'planning', 'plan_review', 'in_progress', 'intervention_required')");
      } else if (args.status) {
        where.push("m.status = ?");
        params.push(args.status);
      }

      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 120))) : 120;

      const rows = db.all<MissionRow>(
        `${baseMissionSelect}
         ${where.length ? `and ${where.join(" and ")}` : ""}
         order by
           case m.status
             when 'intervention_required' then 0
             when 'in_progress' then 1
             when 'plan_review' then 2
             when 'planning' then 3
             when 'queued' then 4
             when 'failed' then 5
             when 'completed' then 6
             when 'partially_completed' then 7
             else 8
           end,
           m.updated_at desc,
           m.created_at desc
         limit ?`,
        [...params, limit]
      );

      return rows.map(toMissionSummary);
    },

    get(missionId: string): MissionDetail | null {
      const id = missionId.trim();
      if (!id.length) return null;

      const row = getMissionRow(id);
      if (!row) return null;

      const steps = db
        .all<MissionStepRow>(
          `
            select
              id,
              mission_id,
              step_index,
              title,
              detail,
              kind,
              lane_id,
              status,
              created_at,
              updated_at,
              started_at,
              completed_at,
              metadata_json
            from mission_steps
            where project_id = ?
              and mission_id = ?
            order by step_index asc
          `,
          [projectId, id]
        )
        .map(toMissionStep);

      const events = db
        .all<MissionEventRow>(
          `
            select
              id,
              mission_id,
              event_type,
              actor,
              summary,
              payload_json,
              created_at
            from mission_events
            where project_id = ?
              and mission_id = ?
            order by created_at desc
            limit 500
          `,
          [projectId, id]
        )
        .map(toMissionEvent);

      const artifacts = db
        .all<MissionArtifactRow>(
          `
            select
              id,
              mission_id,
              artifact_type,
              title,
              description,
              uri,
              lane_id,
              created_by,
              created_at,
              updated_at,
              metadata_json
            from mission_artifacts
            where project_id = ?
              and mission_id = ?
            order by created_at desc
          `,
          [projectId, id]
        )
        .map(toMissionArtifact);

      const interventions = db
        .all<MissionInterventionRow>(
          `
            select
              id,
              mission_id,
              intervention_type,
              status,
              title,
              body,
              requested_action,
              resolution_note,
              lane_id,
              created_at,
              updated_at,
              resolved_at,
              metadata_json
            from mission_interventions
            where project_id = ?
              and mission_id = ?
            order by
              case status when 'open' then 0 when 'resolved' then 1 else 2 end,
              created_at desc
          `,
          [projectId, id]
        )
        .map(toMissionIntervention);

      return {
        ...toMissionSummary(row),
        steps,
        events,
        artifacts,
        interventions,
        phaseConfiguration: resolveMissionPhaseConfiguration(id)
      };
    },

    listPlannerRuns(args: ListPlannerRunsArgs = {}): MissionPlannerRun[] {
      const where: string[] = ["project_id = ?", "event_type = 'mission_plan_generated'"];
      const params: Array<string | number | null> = [projectId];
      const missionId = String(args.missionId ?? "").trim();
      if (missionId.length > 0) {
        where.push("mission_id = ?");
        params.push(missionId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(250, Math.floor(args.limit ?? 50))) : 50;
      const rows = db.all<MissionEventRow>(
        `
          select id, mission_id, event_type, actor, summary, payload_json, created_at
          from mission_events
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map((row) => toPlannerRunFromEvent(row)).filter((entry): entry is MissionPlannerRun => entry != null);
    },

    getPlannerAttempt(args: GetPlannerAttemptArgs): MissionPlannerAttempt | null {
      const plannerRunId = String(args.plannerRunId ?? "").trim();
      const attemptId = String(args.attemptId ?? "").trim();
      if (!plannerRunId.length || !attemptId.length) return null;
      const runs = this.listPlannerRuns({ limit: 250 });
      const run = runs.find((entry) => entry.id === plannerRunId);
      if (!run) return null;
      return run.attempts.find((entry) => entry.id === attemptId) ?? null;
    },

    listPhaseProfiles(args: ListPhaseProfilesArgs = {}): PhaseProfile[] {
      ensurePhaseStorageSeeded();
      return listPhaseProfileRows(args.includeArchived === true).map(toPhaseProfile);
    },

    savePhaseProfile(args: SavePhaseProfileArgs): PhaseProfile {
      ensurePhaseStorageSeeded();
      if (!args.profile || typeof args.profile !== "object") {
        throw new Error("Profile payload is required.");
      }

      const now = nowIso();
      const normalized = normalizeProfileInput(args.profile, now);
      const validationErrors = validatePhaseSequence(normalized.phases);
      if (validationErrors.length > 0) {
        throw new Error(`Invalid phase profile: ${validationErrors.join(" ")}`);
      }

      for (const card of normalized.phases) {
        upsertPhaseCardRow(card);
      }

      const candidateId = String(args.profile.id ?? "").trim();
      const existing = candidateId ? getPhaseProfileRow(candidateId) : null;
      const profileId = (existing?.id ?? candidateId) || randomUUID();
      const builtIn = existing ? Number(existing.is_built_in) === 1 : false;
      const createdAt = existing?.created_at ?? now;
      const isDefault = args.profile.isDefault === true || (existing ? Number(existing.is_default) === 1 : false);
      const profileName = ensureUniqueProfileName(normalized.name, existing?.id);

      if (existing) {
        db.run(
          `
            update phase_profiles
            set name = ?,
                description = ?,
                phases_json = ?,
                is_default = ?,
                archived_at = null,
                updated_at = ?
            where project_id = ?
              and id = ?
          `,
          [
            profileName,
            normalized.description,
            JSON.stringify(normalizePhaseCards(normalized.phases)),
            isDefault ? 1 : 0,
            now,
            projectId,
            profileId
          ]
        );
      } else {
        db.run(
          `
            insert into phase_profiles(
              id,
              project_id,
              name,
              description,
              phases_json,
              is_built_in,
              is_default,
              archived_at,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)
          `,
          [
            profileId,
            projectId,
            profileName,
            normalized.description,
            JSON.stringify(normalizePhaseCards(normalized.phases)),
            builtIn ? 1 : 0,
            isDefault ? 1 : 0,
            createdAt,
            now
          ]
        );
      }

      if (isDefault) {
        db.run(
          `
            update phase_profiles
            set is_default = 0
            where project_id = ?
              and id != ?
          `,
          [projectId, profileId]
        );
      }

      const row = getPhaseProfileRow(profileId);
      if (!row) throw new Error("Failed to save phase profile.");

      return toPhaseProfile(row);
    },

    deletePhaseProfile(args: DeletePhaseProfileArgs): void {
      ensurePhaseStorageSeeded();
      const profileId = String(args.profileId ?? "").trim();
      if (!profileId.length) throw new Error("profileId is required.");
      const row = getPhaseProfileRow(profileId);
      if (!row) throw new Error(`Phase profile not found: ${profileId}`);
      if (Number(row.is_built_in) === 1) {
        throw new Error("Built-in profiles cannot be deleted.");
      }

      const now = nowIso();
      db.run(
        `
          update phase_profiles
          set archived_at = ?,
              is_default = 0,
              updated_at = ?
          where project_id = ?
            and id = ?
        `,
        [now, now, projectId, profileId]
      );
      db.run(
        `
          update mission_phase_overrides
          set profile_id = null,
              updated_at = ?
          where project_id = ?
            and profile_id = ?
        `,
        [now, projectId, profileId]
      );

      const stillDefault = getDefaultPhaseProfileRow();
      if (!stillDefault) {
        const fallback = listPhaseProfileRows(false)[0];
        if (fallback) {
          db.run(
            `
              update phase_profiles
              set is_default = 1,
                  updated_at = ?
              where project_id = ?
                and id = ?
            `,
            [nowIso(), projectId, fallback.id]
          );
        }
      }
    },

    clonePhaseProfile(args: ClonePhaseProfileArgs): PhaseProfile {
      ensurePhaseStorageSeeded();
      const profileId = String(args.profileId ?? "").trim();
      if (!profileId.length) throw new Error("profileId is required.");
      const source = getPhaseProfileRow(profileId);
      if (!source || source.archived_at) {
        throw new Error(`Phase profile not found: ${profileId}`);
      }

      const sourceProfile = toPhaseProfile(source);
      const clonedName = ensureUniqueProfileName(args.name?.trim() || `${sourceProfile.name} (Copy)`);
      return this.savePhaseProfile({
        profile: {
          name: clonedName,
          description: sourceProfile.description,
          phases: sourceProfile.phases.map((phase, index) => ({
            ...phase,
            id: `${phase.id}:clone:${randomUUID()}`,
            isBuiltIn: false,
            isCustom: true,
            position: index,
            createdAt: nowIso(),
            updatedAt: nowIso()
          })),
          isDefault: false
        }
      });
    },

    exportPhaseProfile(args: ExportPhaseProfileArgs): ExportPhaseProfileResult {
      ensurePhaseStorageSeeded();
      const profileId = String(args.profileId ?? "").trim();
      if (!profileId.length) throw new Error("profileId is required.");
      const row = getPhaseProfileRow(profileId);
      if (!row || row.archived_at) throw new Error(`Phase profile not found: ${profileId}`);
      const profile = toPhaseProfile(row);

      let savedPath: string | null = null;
      if (profilesDir) {
        fs.mkdirSync(profilesDir, { recursive: true });
        const base = sanitizeFilePart(profile.name);
        const timestamp = nowIso().replace(/[:.]/g, "-");
        const filePath = path.join(profilesDir, `${base}-${timestamp}.json`);
        const payload = {
          schema: "ade.phase-profile.v1",
          exportedAt: nowIso(),
          profile
        };
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        savedPath = filePath;
      }

      return { profile, savedPath };
    },

    importPhaseProfile(args: ImportPhaseProfileArgs): PhaseProfile {
      ensurePhaseStorageSeeded();
      const filePath = String(args.filePath ?? "").trim();
      if (!filePath.length) throw new Error("filePath is required.");
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const payload = isRecord(parsed) && isRecord(parsed.profile) ? parsed.profile : parsed;
      if (!isRecord(payload)) {
        throw new Error("Invalid phase profile JSON payload.");
      }

      const phases = toPhaseCards(Array.isArray(payload.phases) ? payload.phases : []);
      if (!phases.length) {
        throw new Error("Imported phase profile has no phases.");
      }

      const imported = this.savePhaseProfile({
        profile: {
          name: ensureUniqueProfileName(String(payload.name ?? "Imported Profile")),
          description: typeof payload.description === "string" ? payload.description : "",
          phases: phases.map((phase, index) => ({
            ...phase,
            id: `${phase.id}:import:${randomUUID()}`,
            isBuiltIn: false,
            isCustom: true,
            position: index,
            createdAt: nowIso(),
            updatedAt: nowIso()
          })),
          isDefault: args.setAsDefault === true
        }
      });
      return imported;
    },

    getPhaseConfiguration(missionId: string): MissionPhaseConfiguration | null {
      const trimmed = missionId.trim();
      if (!trimmed.length) return null;
      return resolveMissionPhaseConfiguration(trimmed);
    },

    getDashboard(): MissionDashboardSnapshot {
      ensurePhaseStorageSeeded();
      const activeMissions = this.list({ status: "active", limit: 50 });
      const active = activeMissions.map((mission) => {
        const detail = this.get(mission.id);
        const phaseGroups = groupMissionStepsByPhase(detail?.steps ?? []);
        const currentPhase = phaseGroups.find((group) => group.completed < group.total) ?? phaseGroups[phaseGroups.length - 1] ?? null;
        const phaseProgress = currentPhase
          ? {
              completed: currentPhase.completed,
              total: currentPhase.total,
              pct: currentPhase.total > 0 ? Math.round((currentPhase.completed / currentPhase.total) * 100) : 0
            }
          : { completed: 0, total: 0, pct: 0 };

        const activeWorkers = db.get<{ count: number }>(
          `
            select count(distinct oa.id) as count
            from orchestrator_attempts oa
            where oa.project_id = ?
              and oa.status = 'running'
              and oa.run_id in (
                select id
                from orchestrator_runs
                where project_id = ?
                  and mission_id = ?
              )
          `,
          [projectId, projectId, mission.id]
        )?.count ?? 0;

        const startedAtMs = mission.startedAt ? Date.parse(mission.startedAt) : NaN;
        const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
        const remainingSteps = Math.max(0, mission.totalSteps - mission.completedSteps);
        const estimatedRemainingMs =
          mission.totalSteps > 0 && mission.completedSteps > 0
            ? Math.round((elapsedMs / mission.completedSteps) * remainingSteps)
            : null;

        return {
          mission,
          phaseName: currentPhase?.name ?? null,
          phaseProgress,
          activeWorkers,
          elapsedMs,
          estimatedRemainingMs
        };
      });

      const recentRows = db.all<MissionRow>(
        `${baseMissionSelect}
         and m.status in ('completed', 'partially_completed', 'failed', 'canceled')
         order by coalesce(m.completed_at, m.updated_at) desc
         limit 12`,
        [projectId]
      );
      const recent = recentRows.map((row) => {
        const mission = toMissionSummary(row);
        const started = mission.startedAt ? Date.parse(mission.startedAt) : NaN;
        const completed = mission.completedAt ? Date.parse(mission.completedAt) : NaN;
        const durationMs =
          Number.isFinite(started) && Number.isFinite(completed)
            ? Math.max(0, completed - started)
            : 0;
        return {
          mission,
          durationMs,
          costEstimateUsd: estimateMissionCostUsd(mission.id),
          action: mapMissionQuickAction(mission.status)
        };
      });

      const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const weeklyRows = db.all<MissionRow>(
        `${baseMissionSelect}
         and m.created_at >= ?
         order by m.created_at desc`,
        [projectId, weekStart]
      );
      const weeklyMissions = weeklyRows.map(toMissionSummary);
      const terminal = weeklyMissions.filter((mission) => TERMINAL_MISSION_STATUSES.has(mission.status));
      const successCount = terminal.filter((mission) => mission.status === "completed" || mission.status === "partially_completed").length;
      const durationValues = terminal
        .map((mission) => {
          const started = mission.startedAt ? Date.parse(mission.startedAt) : NaN;
          const completed = mission.completedAt ? Date.parse(mission.completedAt) : NaN;
          if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
          return Math.max(0, completed - started);
        })
        .filter((value): value is number => value != null);
      const avgDurationMs =
        durationValues.length > 0
          ? Math.round(durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length)
          : 0;
      const totalCostUsd = Number(
        weeklyMissions
          .map((mission) => estimateMissionCostUsd(mission.id) ?? 0)
          .reduce((sum, value) => sum + value, 0)
          .toFixed(4)
      );

      return {
        active,
        recent,
        weekly: {
          missions: weeklyMissions.length,
          successRate: terminal.length > 0 ? Number((successCount / terminal.length).toFixed(4)) : 0,
          avgDurationMs,
          totalCostUsd
        }
      };
    },

    logEvent(args: {
      missionId: string;
      eventType: string;
      actor?: string;
      summary: string;
      payload?: Record<string, unknown> | null;
    }): MissionEvent {
      const missionId = String(args.missionId ?? "").trim();
      if (!missionId.length) throw new Error("missionId is required.");
      if (!getMissionRow(missionId)) throw new Error(`Mission not found: ${missionId}`);
      const event = recordEvent({
        missionId,
        eventType: args.eventType,
        actor: args.actor ?? "system",
        summary: args.summary,
        payload: args.payload ?? null
      });
      db.run(
        "update missions set updated_at = ? where id = ? and project_id = ?",
        [nowIso(), missionId, projectId]
      );
      emit({ missionId, reason: "event-logged" });
      return event;
    },

    create(args: CreateMissionInternalArgs): MissionDetail {
      const prompt = normalizePrompt(args.prompt ?? "");
      if (!prompt.length) {
        throw new Error("Mission prompt is required.");
      }

      const title = deriveMissionTitle(prompt, args.title);
      const laneId = coerceNullableString(args.laneId);
      assertLaneExists(laneId);
      const priority = args.priority ?? "normal";
      const executionMode = args.executionMode ?? "local";
      const targetMachineId = coerceNullableString(args.targetMachineId);
      const plannerRun = args.plannerRun ?? null;
      const plannerPlan = args.plannerPlan ?? null;
      const launchMode = args.launchMode === "manual" ? "manual" : "autopilot";
      const autostart = args.autostart !== false;
      const autopilotExecutor = args.autopilotExecutor ?? "codex";
      const allowPlanningQuestions = args.allowPlanningQuestions !== false;
      const launchModelRaw = typeof args.orchestratorModel === "string" ? args.orchestratorModel.trim().toLowerCase() : "";
      const launchModel =
        launchModelRaw === "opus" || launchModelRaw === "sonnet" || launchModelRaw === "haiku"
          ? launchModelRaw
          : null;
      const launchThinkingBudgets = (() => {
        if (!isRecord(args.thinkingBudgets)) return null;
        const out: Record<string, number> = {};
        for (const [key, value] of Object.entries(args.thinkingBudgets)) {
          const normalizedKey = String(key).trim();
          const numeric = Number(value);
          if (!normalizedKey.length || !Number.isFinite(numeric) || numeric < 0) continue;
          out[normalizedKey] = Math.floor(numeric);
        }
        return Object.keys(out).length > 0 ? out : null;
      })();
      // Resolve execution policy from args
      const executionPolicyArg = args.executionPolicy && typeof args.executionPolicy === "object"
        ? (args.executionPolicy as Partial<MissionExecutionPolicy>)
        : null;
      const resolvedExecutionPolicy: MissionExecutionPolicy | null = executionPolicyArg
        ? mergeWithDefaults(executionPolicyArg)
        : null;

      ensurePhaseStorageSeeded();
      const requestedProfileId = coerceNullableString(args.phaseProfileId);
      const selectedProfileRow = requestedProfileId
        ? getPhaseProfileRow(requestedProfileId)
        : getDefaultPhaseProfileRow();
      if (requestedProfileId && !selectedProfileRow) {
        throw new Error(`Phase profile not found: ${requestedProfileId}`);
      }
      const selectedProfile = selectedProfileRow ? toPhaseProfile(selectedProfileRow) : null;
      const overridePhasesRaw =
        Array.isArray(args.phaseOverride) && args.phaseOverride.length > 0
          ? toPhaseCards(args.phaseOverride)
          : [];
      const hasExplicitOverride = Array.isArray(args.phaseOverride) && args.phaseOverride.length > 0;
      if (hasExplicitOverride && overridePhasesRaw.length === 0) {
        throw new Error("Invalid mission phase override payload.");
      }
      const selectedPhases = normalizePhaseCards(
        overridePhasesRaw.length > 0
          ? overridePhasesRaw
          : selectedProfile?.phases?.length
            ? selectedProfile.phases
            : createBuiltInPhaseCards(nowIso())
      );
      const phaseErrors = validatePhaseSequence(selectedPhases);
      if (phaseErrors.length > 0) {
        throw new Error(`Invalid mission phase sequence: ${phaseErrors.join(" ")}`);
      }

      const legacyPlan = buildDeterministicMissionPlan({
        prompt,
        laneId
      });
      const plannerClarifyingQuestions = plannerPlan
        ? normalizePlannerClarifyingQuestions(plannerPlan.clarifyingQuestions)
        : [];
      const plannerClarifyingAnswers = plannerPlan
        ? normalizePlannerClarifyingAnswers(plannerPlan.clarifyingAnswers)
        : [];
      const rawStepsToPersist: MissionPlanStepDraft[] =
        Array.isArray(args.plannedSteps) && args.plannedSteps.length
          ? [...args.plannedSteps].sort((a, b) => a.index - b.index || a.title.localeCompare(b.title))
          : legacyPlan.steps.map((step) => ({
              index: step.index,
              title: step.title,
              detail: step.detail,
              kind: step.kind,
              metadata: step.metadata
            }));
      const stepsToPersist = applyPhaseCardsToPlanSteps(
        rawStepsToPersist.map((step) => ({
          ...step,
          metadata: {
            ...(isRecord(step.metadata) ? step.metadata : {}),
            ...(plannerClarifyingQuestions.length ? { plannerClarifyingQuestions } : {}),
            ...(plannerClarifyingAnswers.length ? { plannerClarifyingAnswers } : {})
          }
        })),
        selectedPhases
      );

      const id = randomUUID();
      const createdAt = nowIso();
      const missionMetadata = {
        source: "manual",
        version: 2,
        launch: {
          autostart,
          runMode: launchMode,
          autopilotExecutor,
          allowPlanningQuestions,
          ...(launchModel ? { orchestratorModel: launchModel } : {}),
          ...(launchThinkingBudgets ? { thinkingBudgets: launchThinkingBudgets } : {}),
          ...(args.modelConfig ? { modelConfig: args.modelConfig } : {}),
          ...(args.modelConfig && typeof args.modelConfig === "object" ? { intelligenceConfig: args.modelConfig.intelligenceConfig } : {}),
          ...(args.teamRuntime ? { teamRuntime: args.teamRuntime } : {}),
          phaseProfileId: selectedProfile?.id ?? null,
          hasPhaseOverride: hasExplicitOverride
        },
        ...(resolvedExecutionPolicy ? { executionPolicy: resolvedExecutionPolicy } : {}),
        phaseConfiguration: {
          profileId: selectedProfile?.id ?? null,
          phaseKeys: selectedPhases.map((phase) => phase.phaseKey),
          phaseCount: selectedPhases.length,
          phases: selectedPhases
        },
        planner: plannerRun
          ? {
              id: plannerRun.id,
              requestedEngine: plannerRun.requestedEngine,
              resolvedEngine: plannerRun.resolvedEngine,
              status: plannerRun.status,
              degraded: plannerRun.degraded,
              reasonCode: plannerRun.reasonCode,
              reasonDetail: plannerRun.reasonDetail,
              planHash: plannerRun.planHash,
              normalizedPlanHash: plannerRun.normalizedPlanHash,
              commandPreview: plannerRun.commandPreview,
              rawResponse: truncateForMetadata(plannerRun.rawResponse, 200_000),
              durationMs: plannerRun.durationMs,
              validationErrors: plannerRun.validationErrors,
              attempts: plannerRun.attempts.map((attempt) => ({
                id: attempt.id,
                engine: attempt.engine,
                status: attempt.status,
                reasonCode: attempt.reasonCode,
                detail: attempt.detail,
                commandPreview: attempt.commandPreview,
                rawResponse: truncateForMetadata(attempt.rawResponse, 50_000),
                validationErrors: attempt.validationErrors,
                createdAt: attempt.createdAt
              }))
            }
          : {
              id: null,
              requestedEngine: args.plannerEngine ?? "auto",
              resolvedEngine: null,
              status: "skipped",
              degraded: false,
              reasonCode: "planner_unavailable",
              reasonDetail: "Planner run was not provided.",
              planHash: null,
              normalizedPlanHash: null,
              commandPreview: null,
              rawResponse: null,
              durationMs: null,
              validationErrors: [],
              attempts: []
            },
        plannerPlan: plannerPlan
          ? {
              schemaVersion: plannerPlan.schemaVersion,
              clarifyingQuestions: plannerClarifyingQuestions,
              clarifyingAnswers: plannerClarifyingAnswers,
              missionSummary: plannerPlan.missionSummary,
              assumptions: plannerPlan.assumptions,
              risks: plannerPlan.risks,
              stepCount: plannerPlan.steps.length,
              handoffPolicy: plannerPlan.handoffPolicy
            }
          : null
      };

      db.run(
        `
          insert into missions(
            id,
            project_id,
            lane_id,
            title,
            prompt,
            status,
            priority,
            execution_mode,
            target_machine_id,
            outcome_summary,
            last_error,
            metadata_json,
            created_at,
            updated_at,
            started_at,
            completed_at
          ) values (?, ?, ?, ?, ?, 'queued', ?, ?, ?, null, null, ?, ?, ?, null, null)
        `,
          [
            id,
            projectId,
            laneId,
            title,
          prompt,
            priority,
            executionMode,
            targetMachineId,
          JSON.stringify(missionMetadata),
            createdAt,
            createdAt
          ]
      );

      stepsToPersist.forEach((step, index) => {
        const stepId = randomUUID();
        db.run(
          `
            insert into mission_steps(
              id,
              mission_id,
              project_id,
              step_index,
              title,
              detail,
              kind,
              lane_id,
              status,
              metadata_json,
              created_at,
              updated_at,
              started_at,
              completed_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, null, null)
          `,
          [
            stepId,
            id,
            projectId,
            index,
            step.title,
            step.detail,
            step.kind,
            laneId,
            JSON.stringify(step.metadata),
            createdAt,
            createdAt
          ]
        );
      });

      upsertMissionPhaseOverride({
        missionId: id,
        profileId: selectedProfile?.id ?? null,
        phases: selectedPhases
      });

      recordEvent({
        missionId: id,
        eventType: "mission_created",
        actor: "user",
        summary: "Mission created from plain-English prompt.",
        payload: {
          title,
          laneId,
          priority,
          executionMode,
          targetMachineId,
          preview: summarizePrompt(prompt),
          plannerVersion: plannerRun ? "ade.missionPlanner.v2" : legacyPlan.plannerVersion,
          plannerStrategy: plannerPlan?.missionSummary.strategy ?? legacyPlan.strategy,
          plannerStepCount: stepsToPersist.length,
          plannerKeywords: legacyPlan.keywords,
          plannerEngineRequested: plannerRun?.requestedEngine ?? args.plannerEngine ?? "auto",
          plannerEngineResolved: plannerRun?.resolvedEngine ?? null,
          plannerDegraded: plannerRun?.degraded ?? false,
          phaseProfileId: selectedProfile?.id ?? null,
          phaseKeys: selectedPhases.map((phase) => phase.phaseKey)
        }
      });

      recordEvent({
        missionId: id,
        eventType: "mission_phase_configured",
        actor: "system",
        summary: `Phase configuration loaded (${selectedPhases.length} phases).`,
        payload: {
          profileId: selectedProfile?.id ?? null,
          phaseKeys: selectedPhases.map((phase) => phase.phaseKey),
          hasOverride: hasExplicitOverride
        }
      });

      if (plannerRun) {
        recordEvent({
          missionId: id,
          eventType: "mission_plan_generated",
          actor: "system",
          summary: `Planner completed with ${plannerRun.resolvedEngine ?? "unknown"}.`,
          payload: {
            plannerRunId: plannerRun.id,
            requestedEngine: plannerRun.requestedEngine,
            resolvedEngine: plannerRun.resolvedEngine,
            status: plannerRun.status,
            degraded: plannerRun.degraded,
            reasonCode: plannerRun.reasonCode,
            reasonDetail: plannerRun.reasonDetail,
            planHash: plannerRun.planHash,
            normalizedPlanHash: plannerRun.normalizedPlanHash,
            commandPreview: plannerRun.commandPreview,
            rawResponse: truncateForMetadata(plannerRun.rawResponse, 8_000),
            durationMs: plannerRun.durationMs,
            validationErrors: plannerRun.validationErrors,
            attempts: plannerRun.attempts.map((attempt) => ({
              id: attempt.id,
              engine: attempt.engine,
              status: attempt.status,
              reasonCode: attempt.reasonCode,
              detail: attempt.detail,
              createdAt: attempt.createdAt
            }))
          }
        });
      }

      emit({ missionId: id, reason: "created" });
      const detail = this.get(id);
      if (!detail) throw new Error("Mission creation failed");
      return detail;
    },

    update(args: UpdateMissionArgs): MissionDetail {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("Mission id is required.");

      const existing = db.get<{
        id: string;
        title: string;
        prompt: string;
        lane_id: string | null;
        status: string;
        priority: string;
        execution_mode: string;
        target_machine_id: string | null;
        outcome_summary: string | null;
        last_error: string | null;
      }>(
        `
          select
            id,
            title,
            prompt,
            lane_id,
            status,
            priority,
            execution_mode,
            target_machine_id,
            outcome_summary,
            last_error
          from missions
          where id = ?
            and project_id = ?
          limit 1
        `,
        [missionId, projectId]
      );

      if (!existing) {
        throw new Error(`Mission not found: ${missionId}`);
      }

      const nextLaneId = args.laneId !== undefined ? coerceNullableString(args.laneId) : existing.lane_id;
      assertLaneExists(nextLaneId);

      const nextPrompt = args.prompt !== undefined ? normalizePrompt(args.prompt) : existing.prompt;
      if (!nextPrompt.length) throw new Error("Mission prompt cannot be empty.");
      const nextTitle = args.title !== undefined ? deriveMissionTitle(nextPrompt, args.title) : existing.title;

      const nextPriority = args.priority ?? normalizeMissionPriority(existing.priority);
      const nextExecutionMode = args.executionMode ?? normalizeExecutionMode(existing.execution_mode);
      const nextTargetMachineId =
        args.targetMachineId !== undefined ? coerceNullableString(args.targetMachineId) : existing.target_machine_id;
      const nextOutcomeSummary =
        args.outcomeSummary !== undefined ? sanitizeOptionalText(args.outcomeSummary) : existing.outcome_summary;
      const nextLastError = args.lastError !== undefined ? sanitizeOptionalText(args.lastError) : existing.last_error;

      const updatedAt = nowIso();

      if (args.status) {
        upsertMissionStatus({
          missionId,
          nextStatus: args.status,
          updatedAt,
          summary: `Mission status changed to ${args.status}.`
        });
      }

      db.run(
        `
          update missions
          set title = ?,
              prompt = ?,
              lane_id = ?,
              priority = ?,
              execution_mode = ?,
              target_machine_id = ?,
              outcome_summary = ?,
              last_error = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [
          nextTitle,
          nextPrompt,
          nextLaneId,
          nextPriority,
          nextExecutionMode,
          nextTargetMachineId,
          nextOutcomeSummary,
          nextLastError,
          updatedAt,
          missionId,
          projectId
        ]
      );

      const changedFields: string[] = [];
      if (nextTitle !== existing.title) changedFields.push("title");
      if (nextPrompt !== existing.prompt) changedFields.push("prompt");
      if (nextLaneId !== existing.lane_id) changedFields.push("laneId");
      if (nextPriority !== existing.priority) changedFields.push("priority");
      if (nextExecutionMode !== existing.execution_mode) changedFields.push("executionMode");
      if (nextTargetMachineId !== existing.target_machine_id) changedFields.push("targetMachineId");
      if (nextOutcomeSummary !== existing.outcome_summary) changedFields.push("outcomeSummary");
      if (nextLastError !== existing.last_error) changedFields.push("lastError");
      if (changedFields.length) {
        recordEvent({
          missionId,
          eventType: "mission_updated",
          actor: "user",
          summary: `Mission updated (${changedFields.join(", ")}).`,
          payload: { changedFields }
        });
      }

      if (nextOutcomeSummary && args.outcomeSummary !== undefined) {
        const hasSummaryArtifact = db.get<{ id: string }>(
          `
            select id
            from mission_artifacts
            where project_id = ?
              and mission_id = ?
              and artifact_type = 'summary'
            order by created_at desc
            limit 1
          `,
          [projectId, missionId]
        );

        if (!hasSummaryArtifact?.id) {
          const summaryArtifact = insertArtifact({
            missionId,
            artifactType: "summary",
            title: "Mission outcome summary",
            description: nextOutcomeSummary,
            createdBy: "system"
          });
          recordEvent({
            missionId,
            eventType: "mission_artifact_added",
            actor: "system",
            summary: "Outcome summary artifact recorded.",
            payload: {
              artifactId: summaryArtifact.id,
              artifactType: summaryArtifact.artifactType
            }
          });
        }
      }

      emit({ missionId, reason: "updated" });
      const detail = this.get(missionId);
      if (!detail) throw new Error("Mission update failed");
      return detail;
    },

    delete(args: DeleteMissionArgs): void {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("missionId is required.");
      if (!getMissionRow(missionId)) throw new Error(`Mission not found: ${missionId}`);

      const runRows = db.all<{ id: string }>(
        `
          select id
          from orchestrator_runs
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      const runIds = runRows.map((row) => row.id);
      const runPlaceholders = runIds.map(() => "?").join(", ");

      // Delete dependents in FK-safe order because mission/orchestrator tables do not use cascade deletes.
      db.run(
        `
          delete from mission_step_handoffs
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );

      if (runIds.length) {
        db.run(
          `
            update orchestrator_attempts
            set context_snapshot_id = null
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_attempt_runtime
            where attempt_id in (
              select id
              from orchestrator_attempts
              where project_id = ?
                and run_id in (${runPlaceholders})
            )
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_runtime_events
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_timeline_events
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_claims
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_chat_messages
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_worker_digests
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_lane_decisions
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_context_checkpoints
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_worker_checkpoints
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_metrics_samples
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_context_snapshots
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_chat_threads
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_attempts
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_steps
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        // Delete team runtime tables (FK → orchestrator_runs)
        db.run(
          `delete from orchestrator_team_members where run_id in (${runPlaceholders})`,
          [...runIds]
        );
        db.run(
          `delete from orchestrator_run_state where run_id in (${runPlaceholders})`,
          [...runIds]
        );
      }

      db.run(
        `
          delete from mission_metrics_config
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_chat_messages
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_chat_threads
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_worker_digests
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_lane_decisions
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_context_checkpoints
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_worker_checkpoints
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_metrics_samples
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );

      // Delete team runtime tables (FK → orchestrator_runs) before deleting runs
      db.run(
        `delete from orchestrator_team_members where mission_id = ?`,
        [missionId]
      );
      db.run(
        `delete from orchestrator_run_state where run_id in (
          select id from orchestrator_runs where project_id = ? and mission_id = ?
        )`,
        [projectId, missionId]
      );

      db.run(
        `
          delete from orchestrator_runs
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_interventions
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_artifacts
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_events
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_steps
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_phase_overrides
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from missions
          where project_id = ?
            and id = ?
        `,
        [projectId, missionId]
      );

      emit({ missionId, reason: "deleted" });
    },

    updateStep(args: UpdateMissionStepArgs): MissionStep {
      const missionId = args.missionId.trim();
      const stepId = args.stepId.trim();
      if (!missionId.length || !stepId.length) throw new Error("missionId and stepId are required.");

      const step = db.get<MissionStepRow>(
        `
          select
            id,
            mission_id,
            step_index,
            title,
            detail,
            kind,
            lane_id,
            status,
            created_at,
            updated_at,
            started_at,
            completed_at,
            metadata_json
          from mission_steps
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [stepId, missionId, projectId]
      );

      if (!step) {
        throw new Error(`Mission step not found: ${stepId}`);
      }

      const previous = normalizeStepStatus(step.status);
      const next = args.status;
      if (!isValidMissionStepTransition(previous, next)) {
        throw new Error(`Invalid mission step transition: ${previous} -> ${next}`);
      }

      const updatedAt = nowIso();
      let startedAt = step.started_at;
      let completedAt = step.completed_at;

      if (next === "running") {
        if (!startedAt) startedAt = updatedAt;
        completedAt = null;
      }

      if (next === "pending") {
        startedAt = null;
        completedAt = null;
      }

      if (next === "succeeded" || next === "failed" || next === "skipped" || next === "canceled") {
        if (!startedAt) startedAt = updatedAt;
        completedAt = updatedAt;
      }

      if (next === "blocked") {
        completedAt = null;
      }

      db.run(
        `
          update mission_steps
          set status = ?,
              started_at = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
            and mission_id = ?
            and project_id = ?
        `,
        [next, startedAt, completedAt, updatedAt, stepId, missionId, projectId]
      );

      const note = sanitizeOptionalText(args.note ?? null);
      recordEvent({
        missionId,
        eventType: "mission_step_updated",
        actor: "user",
        summary: `Step ${Number(step.step_index) + 1} set to ${next}.`,
        payload: {
          stepId,
          stepIndex: Number(step.step_index),
          stepTitle: step.title,
          from: previous,
          to: next,
          ...(note ? { note } : {})
        }
      });

      if (next === "failed") {
        const intervention = insertIntervention({
          missionId,
          interventionType: "failed_step",
          title: `Step failed: ${step.title}`,
          body: note ?? "A mission step was marked as failed and needs attention.",
          requestedAction: "Review the failure and decide whether to continue, retry, or cancel."
        });

        db.run(
          `
            update missions
            set last_error = ?,
                updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [note ?? step.title, updatedAt, missionId, projectId]
        );

        upsertMissionStatus({
          missionId,
          nextStatus: "intervention_required",
          updatedAt,
          summary: "Mission paused for intervention after step failure.",
          payload: {
            interventionId: intervention.id,
            stepId
          }
        });
      }

      emit({ missionId, reason: "step-updated" });

      const nextStep = db.get<MissionStepRow>(
        `
          select
            id,
            mission_id,
            step_index,
            title,
            detail,
            kind,
            lane_id,
            status,
            created_at,
            updated_at,
            started_at,
            completed_at,
            metadata_json
          from mission_steps
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [stepId, missionId, projectId]
      );

      if (!nextStep) throw new Error("Mission step update failed");
      return toMissionStep(nextStep);
    },

    addArtifact(args: AddMissionArtifactArgs): MissionArtifact {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("missionId is required.");
      if (!getMissionRow(missionId)) throw new Error(`Mission not found: ${missionId}`);

      const artifact = insertArtifact({
        missionId,
        artifactType: args.artifactType,
        title: args.title,
        description: args.description,
        uri: args.uri,
        laneId: args.laneId,
        metadata: args.metadata,
        createdBy: "user"
      });

      recordEvent({
        missionId,
        eventType: "mission_artifact_added",
        actor: "user",
        summary: `Artifact added: ${artifact.title}`,
        payload: {
          artifactId: artifact.id,
          artifactType: artifact.artifactType,
          uri: artifact.uri
        }
      });

      db.run(
        "update missions set updated_at = ? where id = ? and project_id = ?",
        [nowIso(), missionId, projectId]
      );
      emit({ missionId, reason: "artifact-added" });
      return artifact;
    },

    addIntervention(args: AddMissionInterventionArgs): MissionIntervention {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("missionId is required.");
      const missionRow = getMissionRow(missionId);
      if (!missionRow) throw new Error(`Mission not found: ${missionId}`);
      const missionStatus = normalizeMissionStatus(missionRow.status);

      const intervention = insertIntervention({
        missionId,
        interventionType: args.interventionType,
        title: args.title,
        body: args.body,
        requestedAction: args.requestedAction,
        laneId: args.laneId,
        metadata: args.metadata
      });

      recordEvent({
        missionId,
        eventType: "mission_intervention_added",
        actor: "user",
        summary: `Intervention added: ${intervention.title}`,
        payload: {
          interventionId: intervention.id,
          interventionType: intervention.interventionType
        }
      });

      const keepPlanReview =
        missionStatus === "plan_review" &&
        intervention.status === "open" &&
        (
          intervention.interventionType === "approval_required"
          || (
            intervention.interventionType === "manual_input"
            && isPlannerClarifyingInterventionMetadata(isRecord(intervention.metadata) ? intervention.metadata : null)
          )
        );
      const shouldPauseMission = args.pauseMission !== false;
      if (!keepPlanReview && shouldPauseMission) {
        upsertMissionStatus({
          missionId,
          nextStatus: "intervention_required",
          summary: "Mission moved to intervention required."
        });
      }

      db.run(
        "update missions set updated_at = ? where id = ? and project_id = ?",
        [nowIso(), missionId, projectId]
      );
      emit({ missionId, reason: "intervention-added" });
      return intervention;
    },

    resolveIntervention(args: ResolveMissionInterventionArgs): MissionIntervention {
      const missionId = args.missionId.trim();
      const interventionId = args.interventionId.trim();
      if (!missionId.length || !interventionId.length) {
        throw new Error("missionId and interventionId are required.");
      }

      const row = db.get<MissionInterventionRow>(
        `
          select
            id,
            mission_id,
            intervention_type,
            status,
            title,
            body,
            requested_action,
            resolution_note,
            lane_id,
            created_at,
            updated_at,
            resolved_at,
            metadata_json
          from mission_interventions
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [interventionId, missionId, projectId]
      );

      if (!row) {
        throw new Error(`Intervention not found: ${interventionId}`);
      }

      const targetStatus = args.status;
      const note = sanitizeOptionalText(args.note ?? null);
      const resolvedAt = nowIso();

      db.run(
        `
          update mission_interventions
          set status = ?,
              resolution_note = ?,
              resolved_at = ?,
              updated_at = ?
          where id = ?
            and mission_id = ?
            and project_id = ?
        `,
        [targetStatus, note, resolvedAt, resolvedAt, interventionId, missionId, projectId]
      );

      recordEvent({
        missionId,
        eventType: "mission_intervention_resolved",
        actor: "user",
        summary: `Intervention ${targetStatus}: ${row.title}`,
        payload: {
          interventionId,
          status: targetStatus,
          ...(note ? { note } : {})
        }
      });

      const interventionMetadata = safeParseRecord(row.metadata_json);
      if (
        row.intervention_type === "manual_input"
        && isPlannerClarifyingInterventionMetadata(interventionMetadata)
      ) {
        persistPlannerClarifyingAnswer({
          missionId,
          questionIndex: Math.max(0, Math.floor(Number(interventionMetadata.questionIndex))),
          note,
          status: targetStatus,
          fallbackQuestion: typeof interventionMetadata.question === "string" ? interventionMetadata.question : undefined,
          fallbackContext: typeof interventionMetadata.context === "string" ? interventionMetadata.context : undefined,
          fallbackDefaultAssumption:
            typeof interventionMetadata.defaultAssumption === "string" ? interventionMetadata.defaultAssumption : undefined,
          fallbackImpact: typeof interventionMetadata.impact === "string" ? interventionMetadata.impact : undefined
        });
      }

      const openCount = db.get<{ count: number }>(
        `
          select count(*) as count
          from mission_interventions
          where project_id = ?
            and mission_id = ?
            and status = 'open'
        `,
        [projectId, missionId]
      );

      if ((openCount?.count ?? 0) === 0) {
        const mission = db.get<{ status: string }>(
          "select status from missions where id = ? and project_id = ? limit 1",
          [missionId, projectId]
        );
        if (mission && normalizeMissionStatus(mission.status) === "intervention_required") {
          upsertMissionStatus({
            missionId,
            nextStatus: "in_progress",
            summary: "All interventions resolved. Mission resumed."
          });
        }
      }

      db.run(
        "update missions set updated_at = ? where id = ? and project_id = ?",
        [resolvedAt, missionId, projectId]
      );
      emit({ missionId, reason: "intervention-resolved" });

      const updated = db.get<MissionInterventionRow>(
        `
          select
            id,
            mission_id,
            intervention_type,
            status,
            title,
            body,
            requested_action,
            resolution_note,
            lane_id,
            created_at,
            updated_at,
            resolved_at,
            metadata_json
          from mission_interventions
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [interventionId, missionId, projectId]
      );
      if (!updated) throw new Error("Intervention update failed");
      return toMissionIntervention(updated);
    },

    // ── Concurrency Guard ────────────────────────────────────────
    canStartMission(missionId: string): MissionConcurrencyCheckResult {
      const activeMissions = this.list({ status: "active" })
        .filter(m => ACTIVE_MISSION_STATUSES.has(m.status) && m.id !== missionId);
      const maxConcurrent = activeConcurrencyConfig.maxConcurrentMissions;
      if (activeMissions.length >= maxConcurrent) {
        const queuedMissions = this.list({})
          .filter(m => m.status === "queued")
          .sort((a, b) =>
            (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
            || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        const queuePosition = queuedMissions.findIndex(m => m.id === missionId);
        return {
          allowed: false,
          reason: `${activeMissions.length} missions already active (max: ${maxConcurrent})`,
          queuePosition: queuePosition >= 0 ? queuePosition + 1 : undefined
        };
      }
      return { allowed: true };
    },

    isLaneClaimed(laneId: string, excludeMissionId?: string): MissionLaneClaimCheckResult {
      if (!activeConcurrencyConfig.laneExclusivity) return { claimed: false };
      if (!laneId) return { claimed: false };
      const activeMissions = this.list({ status: "active" })
        .filter(m => ACTIVE_MISSION_STATUSES.has(m.status) && m.id !== excludeMissionId);
      for (const mission of activeMissions) {
        if (mission.laneId === laneId) return { claimed: true, byMissionId: mission.id };
        const detail = this.get(mission.id);
        if (detail) {
          const hasRunningStepOnLane = detail.steps.some(
            s => s.laneId === laneId && s.status === "running"
          );
          if (hasRunningStepOnLane) return { claimed: true, byMissionId: mission.id };
        }
      }
      return { claimed: false };
    },

    processQueue(): string[] {
      const started: string[] = [];
      const queuedMissions = this.list({})
        .filter(m => m.status === "queued")
        .sort((a, b) =>
          (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
          || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      for (const mission of queuedMissions) {
        const detail = this.get(mission.id);
        const metadata = detail
          ? safeParseRecord(
              db.get<{ metadata_json: string | null }>(
                "select metadata_json from missions where id = ? and project_id = ? limit 1",
                [mission.id, projectId]
              )?.metadata_json ?? null
            )
          : null;
        const launch = metadata && isRecord(metadata.launch) ? metadata.launch : null;
        if (launch && launch.autostart === false) continue;
        const check = this.canStartMission(mission.id);
        if (!check.allowed) break;
        if (activeConcurrencyConfig.laneExclusivity && mission.laneId) {
          const laneClaim = this.isLaneClaimed(mission.laneId, mission.id);
          if (laneClaim.claimed) continue;
        }
        recordEvent({
          missionId: mission.id,
          eventType: "mission_ready_to_start",
          actor: "system",
          summary: "Mission eligible to start after concurrency slot opened.",
          payload: { queuePosition: 1 }
        });
        emit({ missionId: mission.id, reason: "ready_to_start" });
        started.push(mission.id);
      }
      return started;
    },

    getConcurrencyConfig(): MissionConcurrencyConfig {
      return { ...activeConcurrencyConfig };
    },

    setConcurrencyConfig(config: Partial<MissionConcurrencyConfig>): MissionConcurrencyConfig {
      if (config.maxConcurrentMissions !== undefined) {
        activeConcurrencyConfig.maxConcurrentMissions = Math.max(1, Math.floor(config.maxConcurrentMissions));
      }
      if (config.laneExclusivity !== undefined) {
        activeConcurrencyConfig.laneExclusivity = config.laneExclusivity;
      }
      return { ...activeConcurrencyConfig };
    }
  };

  serviceRef = service;
  return service;
}
