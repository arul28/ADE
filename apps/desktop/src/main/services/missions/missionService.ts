import { randomUUID } from "node:crypto";
import type {
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
  CreateMissionArgs,
  GetPlannerAttemptArgs,
  ListPlannerRunsArgs,
  MissionConcurrencyCheckResult,
  MissionConcurrencyConfig,
  MissionExecutionPolicy,
  MissionExecutorPolicy,
  MissionLaneClaimCheckResult,
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
  MissionDepthTier,
  MissionPriority,
  MissionsEventPayload,
  MissionStatus,
  MissionStep,
  MissionStepStatus,
  MissionSummary,
  PlannerPlan,
  ResolveMissionInterventionArgs,
  DeleteMissionArgs,
  UpdateMissionArgs,
  UpdateMissionStepArgs
} from "../../../shared/types";
import { depthTierToPolicy, DEFAULT_EXECUTION_POLICY } from "../orchestrator/executionPolicy";
import type { AdeDb } from "../state/kvDb";
import { buildDeterministicMissionPlan } from "./missionPlanner";
import type { MissionPlanStepDraft } from "./missionPlanningService";

const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(["completed", "failed", "canceled"]);

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
  in_progress: new Set(["in_progress", "intervention_required", "completed", "failed", "canceled", "plan_review"]),
  intervention_required: new Set(["intervention_required", "in_progress", "failed", "canceled", "plan_review"]),
  completed: new Set(["completed", "queued"]),
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

type CreateMissionInternalArgs = CreateMissionArgs & {
  plannedSteps?: MissionPlanStepDraft[];
  plannerRun?: MissionPlannerRun | null;
  plannerPlan?: PlannerPlan | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeParseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMissionStatus(value: string): MissionStatus {
  if (
    value === "queued" ||
    value === "planning" ||
    value === "plan_review" ||
    value === "in_progress" ||
    value === "intervention_required" ||
    value === "completed" ||
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
    integration: { ...base.integration, ...partial.integration },
    merge: { ...base.merge, ...partial.merge },
    completion: { ...base.completion, ...partial.completion }
  };
}

function normalizeMissionExecutorPolicy(value: unknown): MissionExecutorPolicy {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "codex" || raw === "claude" || raw === "both") return raw;
  return "both";
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
  onEvent,
  concurrencyConfig
}: {
  db: AdeDb;
  projectId: string;
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
             else 7
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
        interventions
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
      const executorPolicy = normalizeMissionExecutorPolicy(args.executorPolicy);
      const allowPlanningQuestions = args.allowPlanningQuestions === true;
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
      const missionDepthRaw = typeof args.missionDepth === "string" ? args.missionDepth.trim() : "";
      const missionDepth: MissionDepthTier | null =
        missionDepthRaw === "light" || missionDepthRaw === "standard" || missionDepthRaw === "deep"
          ? missionDepthRaw
          : null;

      // Resolve execution policy: explicit > converted from depth > null
      const executionPolicyArg = args.executionPolicy && typeof args.executionPolicy === "object"
        ? (args.executionPolicy as Partial<MissionExecutionPolicy>)
        : null;
      const resolvedExecutionPolicy: MissionExecutionPolicy | null = executionPolicyArg
        ? mergeWithDefaults(executionPolicyArg)
        : missionDepth
          ? depthTierToPolicy(missionDepth)
          : null;

      const legacyPlan = buildDeterministicMissionPlan({
        prompt,
        laneId
      });
      const stepsToPersist: MissionPlanStepDraft[] =
        Array.isArray(args.plannedSteps) && args.plannedSteps.length
          ? [...args.plannedSteps].sort((a, b) => a.index - b.index || a.title.localeCompare(b.title))
          : legacyPlan.steps.map((step) => ({
              index: step.index,
              title: step.title,
              detail: step.detail,
              kind: step.kind,
              metadata: step.metadata
            }));

      const id = randomUUID();
      const createdAt = nowIso();
      const missionMetadata = {
        source: "manual",
        version: 2,
        launch: {
          autostart,
          runMode: launchMode,
          autopilotExecutor,
          executorPolicy,
          allowPlanningQuestions,
          ...(launchModel ? { orchestratorModel: launchModel } : {}),
          ...(launchThinkingBudgets ? { thinkingBudgets: launchThinkingBudgets } : {}),
          ...(args.modelConfig && typeof args.modelConfig === "object" ? { intelligenceConfig: args.modelConfig.intelligenceConfig } : {}),
          ...(args.allowParallelSubagents != null ? { allowParallelSubagents: args.allowParallelSubagents } : {}),
          ...(args.allowAgentTeams != null ? { allowAgentTeams: args.allowAgentTeams } : {})
        },
        ...(missionDepth ? { missionDepth } : {}),
        ...(resolvedExecutionPolicy ? { executionPolicy: resolvedExecutionPolicy } : {}),
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
          executorPolicy
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
        intervention.interventionType === "approval_required";
      if (!keepPlanReview) {
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
