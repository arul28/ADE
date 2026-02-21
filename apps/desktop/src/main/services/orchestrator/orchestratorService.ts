import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ConflictProposal,
  ConflictProposalPreview,
  ExternalConflictResolverProvider,
  MissionStepHandoff,
  OrchestratorAttempt,
  OrchestratorAttemptResultEnvelope,
  OrchestratorAttemptStatus,
  OrchestratorClaim,
  OrchestratorClaimScope,
  OrchestratorClaimState,
  OrchestratorContextPolicyProfile,
  OrchestratorContextProfileId,
  OrchestratorContextSnapshot,
  OrchestratorContextSnapshotCursor,
  OrchestratorDocsRef,
  OrchestratorErrorClass,
  OrchestratorExecutorKind,
  OrchestratorGateEntry,
  OrchestratorGateReport,
  OrchestratorGateStatus,
  OrchestratorJoinPolicy,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorRunStatus,
  OrchestratorStep,
  OrchestratorStepStatus,
  OrchestratorRuntimeBusEvent,
  OrchestratorRuntimeEventType,
  OrchestratorTimelineEvent,
  PackDeltaDigestV1,
  PackExport,
  PrepareResolverSessionArgs,
  PtyCreateArgs,
  StartOrchestratorRunArgs,
  StartOrchestratorRunStepInput
} from "../../../shared/types";
import type { AdeDb, SqlValue } from "../state/kvDb";
import type { createPackService } from "../packs/packService";
import type { createPtyService } from "../pty/ptyService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createProjectConfigService } from "../config/projectConfigService";

type RunRow = {
  id: string;
  mission_id: string;
  project_id: string;
  status: string;
  context_profile: string;
  scheduler_state: string;
  runtime_cursor_json: string | null;
  last_error: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type StepRow = {
  id: string;
  run_id: string;
  mission_step_id: string | null;
  step_key: string;
  step_index: number;
  title: string;
  lane_id: string | null;
  status: string;
  join_policy: string;
  quorum_count: number | null;
  dependency_step_ids_json: string;
  retry_limit: number;
  retry_count: number;
  last_attempt_id: string | null;
  policy_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type AttemptRow = {
  id: string;
  run_id: string;
  step_id: string;
  attempt_number: number;
  status: string;
  executor_kind: string;
  executor_session_id: string | null;
  tracked_session_enforced: number;
  context_profile: string;
  context_snapshot_id: string | null;
  error_class: string;
  error_message: string | null;
  retry_backoff_ms: number;
  result_envelope_json: string | null;
  metadata_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type ClaimRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  attempt_id: string | null;
  owner_id: string;
  scope_kind: string;
  scope_value: string;
  state: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  policy_json: string | null;
  metadata_json: string | null;
};

type ContextSnapshotRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  attempt_id: string | null;
  snapshot_type: string;
  context_profile: string;
  cursor_json: string;
  created_at: string;
};

type HandoffRow = {
  id: string;
  mission_id: string;
  mission_step_id: string | null;
  run_id: string | null;
  step_id: string | null;
  attempt_id: string | null;
  handoff_type: string;
  producer: string;
  payload_json: string;
  created_at: string;
};

type TimelineRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  attempt_id: string | null;
  claim_id: string | null;
  event_type: string;
  reason: string;
  detail_json: string | null;
  created_at: string;
};

type RuntimeEventRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  attempt_id: string | null;
  session_id: string | null;
  event_type: string;
  event_key: string;
  occurred_at: string;
  payload_json: string | null;
  created_at: string;
};

type GateReportRow = {
  id: string;
  generated_at: string;
  report_json: string;
};

type StepPolicy = {
  includeNarrative?: boolean;
  includeFullDocs?: boolean;
  docsMaxBytes?: number;
  claimScopes?: Array<{
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
    ttlMs?: number;
  }>;
};

type CreateSnapshotResult = {
  snapshotId: string;
  cursor: OrchestratorContextSnapshotCursor;
  laneExport: PackExport | null;
  projectExport: PackExport;
  docsRefs: OrchestratorDocsRef[];
  fullDocs: Array<{ path: string; content: string; truncated: boolean }>;
};

type ResolvedOrchestratorRuntimeConfig = {
  requirePlanReview: boolean;
  maxParallelWorkers: number;
  defaultMergePolicy: "sequential" | "batch-at-end" | "per-step";
  defaultConflictHandoff: "auto-resolve" | "ask-user" | "orchestrator-decides";
  workerHeartbeatIntervalMs: number;
  workerHeartbeatTimeoutMs: number;
  workerIdleTimeoutMs: number;
  stepTimeoutDefaultMs: number;
  maxRetriesPerStep: number;
  contextPressureThreshold: number;
  progressiveLoading: boolean;
  maxTotalTokenBudget: number | null;
  maxPerStepTokenBudget: number | null;
  fileReservationGuardMode: "off" | "warn" | "block";
};

export type OrchestratorEvent = {
  type:
    | "orchestrator-run-updated"
    | "orchestrator-step-updated"
    | "orchestrator-attempt-updated"
    | "orchestrator-claim-updated";
  runId?: string;
  stepId?: string;
  attemptId?: string;
  claimId?: string;
  at: string;
  reason: string;
};

export type OrchestratorExecutorStartResult =
  | {
      status: "accepted";
      sessionId?: string | null;
      metadata?: Record<string, unknown> | null;
    }
  | {
      status: "completed";
      result: OrchestratorAttemptResultEnvelope;
      metadata?: Record<string, unknown> | null;
    }
  | {
      status: "failed";
      errorClass?: OrchestratorErrorClass;
      errorMessage: string;
      metadata?: Record<string, unknown> | null;
    };

export type OrchestratorExecutorStartArgs = {
  run: OrchestratorRun;
  step: OrchestratorStep;
  attempt: OrchestratorAttempt;
  contextProfile: OrchestratorContextPolicyProfile;
  laneExport: PackExport | null;
  projectExport: PackExport;
  docsRefs: OrchestratorDocsRef[];
  fullDocs: Array<{ path: string; content: string; truncated: boolean }>;
  createTrackedSession: (args: Omit<PtyCreateArgs, "tracked"> & { tracked?: boolean }) => Promise<{ ptyId: string; sessionId: string }>;
  permissionConfig?: {
    claude?: {
      permissionMode?: string;
      dangerouslySkipPermissions?: boolean;
      allowedTools?: string[];
      settingsSources?: string[];
      sandbox?: boolean;
    };
    codex?: {
      sandboxPermissions?: string;
      approvalMode?: string;
      writablePaths?: string[];
      commandAllowlist?: string[];
      configPath?: string;
    };
  };
};

export type OrchestratorExecutorAdapter = {
  kind: OrchestratorExecutorKind;
  start: (args: OrchestratorExecutorStartArgs) => Promise<OrchestratorExecutorStartResult>;
};

const DEFAULT_CONTEXT_PROFILE_ID: OrchestratorContextProfileId = "orchestrator_deterministic_v1";

const CONTEXT_PROFILES: Record<OrchestratorContextProfileId, OrchestratorContextPolicyProfile> = {
  orchestrator_deterministic_v1: {
    id: "orchestrator_deterministic_v1",
    includeNarrative: false,
    docsMode: "digest_refs",
    laneExportLevel: "standard",
    projectExportLevel: "lite",
    maxDocBytes: 120_000
  },
  orchestrator_narrative_opt_in_v1: {
    id: "orchestrator_narrative_opt_in_v1",
    includeNarrative: true,
    docsMode: "digest_refs",
    laneExportLevel: "deep",
    projectExportLevel: "standard",
    maxDocBytes: 200_000
  }
};

const TERMINAL_STEP_STATUSES = new Set<OrchestratorStepStatus>(["succeeded", "failed", "skipped", "canceled"]);
const TERMINAL_RUN_STATUSES = new Set<OrchestratorRunStatus>(["succeeded", "failed", "canceled"]);
const RETRYABLE_ERROR_CLASSES = new Set<OrchestratorErrorClass>([
  "transient",
  "executor_failure",
  "claim_conflict",
  "resume_recovered"
]);
const DEFAULT_RETRY_BACKOFF_MS = 5_000;
const MAX_TIMELINE_LIMIT = 1_000;
const GATE_THRESHOLDS = {
  maxTrackedPipelineLatencyMs: 300_000,
  minContextCompletenessRate: 0.98,
  minFreshnessByTypeRate: 0.9,
  maxBlockedInsufficientContextRate: 0.05,
  freshnessMaxAgeByPackTypeMs: {
    project: 24 * 60 * 60 * 1_000,
    lane: 6 * 60 * 60 * 1_000,
    feature: 48 * 60 * 60 * 1_000,
    conflict: 2 * 60 * 60 * 1_000,
    plan: 72 * 60 * 60 * 1_000,
    mission: 24 * 60 * 60 * 1_000
  } as Record<string, number>
} as const;

const DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG: ResolvedOrchestratorRuntimeConfig = {
  requirePlanReview: false,
  maxParallelWorkers: 4,
  defaultMergePolicy: "sequential",
  defaultConflictHandoff: "auto-resolve",
  workerHeartbeatIntervalMs: 30_000,
  workerHeartbeatTimeoutMs: 90_000,
  workerIdleTimeoutMs: 300_000,
  stepTimeoutDefaultMs: 300_000,
  maxRetriesPerStep: 2,
  contextPressureThreshold: 0.8,
  progressiveLoading: true,
  maxTotalTokenBudget: null,
  maxPerStepTokenBudget: null,
  fileReservationGuardMode: "warn"
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIsoTimestamp(value: unknown, fallbackIso: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.length) return fallbackIso;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return fallbackIso;
  return new Date(ms).toISOString();
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asIntInRange(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function asNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function asPositiveNumberOrNull(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

function normalizeRunStatus(value: string): OrchestratorRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "paused" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  return "queued";
}

function normalizeStepStatus(value: string): OrchestratorStepStatus {
  if (
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "blocked" ||
    value === "skipped" ||
    value === "canceled"
  ) {
    return value;
  }
  return "pending";
}

function normalizeAttemptStatus(value: string): OrchestratorAttemptStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "blocked" ||
    value === "canceled"
  ) {
    return value;
  }
  return "queued";
}

function normalizeExecutorKind(value: string): OrchestratorExecutorKind {
  if (value === "claude" || value === "codex" || value === "shell" || value === "manual") return value;
  return "manual";
}

function normalizeErrorClass(value: string): OrchestratorErrorClass {
  if (
    value === "none" ||
    value === "transient" ||
    value === "deterministic" ||
    value === "policy" ||
    value === "claim_conflict" ||
    value === "executor_failure" ||
    value === "canceled" ||
    value === "resume_recovered"
  ) {
    return value;
  }
  return "none";
}

function normalizeJoinPolicy(value: string): OrchestratorJoinPolicy {
  if (value === "all_success" || value === "any_success" || value === "quorum") return value;
  return "all_success";
}

function normalizeClaimScope(value: string): OrchestratorClaimScope {
  if (value === "lane" || value === "file" || value === "env") return value;
  return "lane";
}

function normalizeClaimState(value: string): OrchestratorClaimState {
  if (value === "active" || value === "released" || value === "expired") return value;
  return "active";
}

function normalizeRuntimeEventType(value: string): OrchestratorRuntimeEventType {
  if (
    value === "progress" ||
    value === "heartbeat" ||
    value === "question" ||
    value === "blocked" ||
    value === "done" ||
    value === "retry_scheduled" ||
    value === "retry_exhausted" ||
    value === "claim_conflict" ||
    value === "session_ended" ||
    value === "intervention_opened" ||
    value === "intervention_resolved"
  ) {
    return value;
  }
  return "progress";
}

function normalizeProfileId(value: string | null | undefined): OrchestratorContextProfileId {
  if (value === "orchestrator_narrative_opt_in_v1") return value;
  return DEFAULT_CONTEXT_PROFILE_ID;
}

function normalizeTerminalSessionStatus(value: unknown): "running" | "completed" | "failed" | "disposed" | "unknown" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "running" || normalized === "completed" || normalized === "failed" || normalized === "disposed") {
    return normalized;
  }
  return "unknown";
}

type StepGraphValidationStep = {
  stepKey: string;
  dependencyStepKeys: string[];
  joinPolicy: OrchestratorJoinPolicy;
  quorumCount: number | null;
};

function normalizeDependencyStepKeys(dependencyStepKeys: string[] | undefined): string[] {
  if (!Array.isArray(dependencyStepKeys)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of dependencyStepKeys) {
    const key = String(raw ?? "").trim();
    if (!key.length) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function validateStepGraphIntegrity(args: {
  context: "startRun" | "addSteps";
  steps: StepGraphValidationStep[];
}): void {
  const byKey = new Map<string, StepGraphValidationStep>();
  for (const step of args.steps) {
    const stepKey = step.stepKey.trim();
    if (!stepKey.length) {
      throw new Error(`Encountered empty stepKey while validating ${args.context} graph.`);
    }
    if (byKey.has(stepKey)) {
      throw new Error(`Duplicate stepKey in ${args.context} graph: ${stepKey}`);
    }
    byKey.set(stepKey, {
      ...step,
      stepKey,
      dependencyStepKeys: normalizeDependencyStepKeys(step.dependencyStepKeys)
    });
  }

  for (const step of byKey.values()) {
    for (const dependencyKey of step.dependencyStepKeys) {
      if (!byKey.has(dependencyKey)) {
        throw new Error(`Unknown dependency stepKey '${dependencyKey}' referenced by step '${step.stepKey}'.`);
      }
      if (dependencyKey === step.stepKey) {
        throw new Error(`Step '${step.stepKey}' cannot depend on itself.`);
      }
    }

    if (step.joinPolicy === "any_success" && step.dependencyStepKeys.length === 0) {
      throw new Error(`Step '${step.stepKey}' uses joinPolicy=any_success without dependencies.`);
    }
    if (step.joinPolicy === "quorum") {
      if (step.dependencyStepKeys.length === 0) {
        throw new Error(`Step '${step.stepKey}' uses joinPolicy=quorum without dependencies.`);
      }
      if (step.quorumCount != null) {
        const quorum = Number(step.quorumCount);
        if (!Number.isFinite(quorum) || quorum <= 0 || Math.floor(quorum) > step.dependencyStepKeys.length) {
          throw new Error(
            `Step '${step.stepKey}' has quorumCount=${String(step.quorumCount)} outside valid range 1..${step.dependencyStepKeys.length}.`
          );
        }
      }
    }
  }

  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const step of byKey.values()) {
    indegree.set(step.stepKey, 0);
    adjacency.set(step.stepKey, []);
  }
  for (const step of byKey.values()) {
    for (const dependencyKey of step.dependencyStepKeys) {
      adjacency.get(dependencyKey)?.push(step.stepKey);
      indegree.set(step.stepKey, (indegree.get(step.stepKey) ?? 0) + 1);
    }
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([stepKey]) => stepKey);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    for (const dependentKey of adjacency.get(current) ?? []) {
      const nextDegree = (indegree.get(dependentKey) ?? 0) - 1;
      indegree.set(dependentKey, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependentKey);
      }
    }
  }

  if (visited !== byKey.size) {
    throw new Error(`Dependency cycle detected in ${args.context} step graph.`);
  }
}

function toRun(row: RunRow): OrchestratorRun {
  return {
    id: row.id,
    missionId: row.mission_id,
    projectId: row.project_id,
    status: normalizeRunStatus(row.status),
    contextProfile: normalizeProfileId(row.context_profile),
    schedulerState: row.scheduler_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    metadata: parseRecord(row.metadata_json)
  };
}

function toStep(row: StepRow): OrchestratorStep {
  return {
    id: row.id,
    runId: row.run_id,
    missionStepId: row.mission_step_id,
    stepKey: row.step_key,
    stepIndex: Number(row.step_index ?? 0),
    title: row.title,
    laneId: row.lane_id,
    status: normalizeStepStatus(row.status),
    joinPolicy: normalizeJoinPolicy(row.join_policy),
    quorumCount: row.quorum_count != null ? Number(row.quorum_count) : null,
    dependencyStepIds: parseArray(row.dependency_step_ids_json),
    retryLimit: Number(row.retry_limit ?? 0),
    retryCount: Number(row.retry_count ?? 0),
    lastAttemptId: row.last_attempt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    metadata: parseRecord(row.metadata_json)
  };
}

function toAttempt(row: AttemptRow): OrchestratorAttempt {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptNumber: Number(row.attempt_number ?? 1),
    status: normalizeAttemptStatus(row.status),
    executorKind: normalizeExecutorKind(row.executor_kind),
    executorSessionId: row.executor_session_id,
    trackedSessionEnforced: row.tracked_session_enforced === 1,
    contextProfile: normalizeProfileId(row.context_profile),
    contextSnapshotId: row.context_snapshot_id,
    errorClass: normalizeErrorClass(row.error_class),
    errorMessage: row.error_message,
    retryBackoffMs: Number(row.retry_backoff_ms ?? 0),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resultEnvelope: row.result_envelope_json
      ? ((() => {
          try {
            return JSON.parse(row.result_envelope_json) as OrchestratorAttemptResultEnvelope;
          } catch {
            return null;
          }
        })())
      : null,
    metadata: parseRecord(row.metadata_json)
  };
}

function toClaim(row: ClaimRow): OrchestratorClaim {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    ownerId: row.owner_id,
    scopeKind: normalizeClaimScope(row.scope_kind),
    scopeValue: row.scope_value,
    state: normalizeClaimState(row.state),
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    policy: parseRecord(row.policy_json),
    metadata: parseRecord(row.metadata_json)
  };
}

function toContextSnapshot(row: ContextSnapshotRow): OrchestratorContextSnapshot {
  const cursor = (() => {
    try {
      return JSON.parse(row.cursor_json) as OrchestratorContextSnapshotCursor;
    } catch {
      return {
        lanePackKey: null,
        lanePackVersionId: null,
        lanePackVersionNumber: null,
        projectPackKey: "project",
        projectPackVersionId: null,
        projectPackVersionNumber: null,
        packDeltaSince: null,
        docs: []
      } satisfies OrchestratorContextSnapshotCursor;
    }
  })();
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    snapshotType: row.snapshot_type === "step" ? "step" : row.snapshot_type === "attempt" ? "attempt" : "run",
    contextProfile: normalizeProfileId(row.context_profile),
    cursor,
    createdAt: row.created_at
  };
}

function toHandoff(row: HandoffRow): MissionStepHandoff {
  return {
    id: row.id,
    missionId: row.mission_id,
    missionStepId: row.mission_step_id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    handoffType: row.handoff_type,
    producer: row.producer,
    payload: parseRecord(row.payload_json) ?? {},
    createdAt: row.created_at
  };
}

function toTimelineEvent(row: TimelineRow): OrchestratorTimelineEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    claimId: row.claim_id,
    eventType: row.event_type,
    reason: row.reason,
    detail: parseRecord(row.detail_json),
    createdAt: row.created_at
  };
}

function toRuntimeEvent(row: RuntimeEventRow): OrchestratorRuntimeBusEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    eventType: normalizeRuntimeEventType(row.event_type),
    eventKey: row.event_key,
    occurredAt: row.occurred_at,
    payload: parseRecord(row.payload_json),
    createdAt: row.created_at
  };
}

function toGateReport(row: GateReportRow): OrchestratorGateReport | null {
  try {
    const parsed = JSON.parse(row.report_json) as OrchestratorGateReport;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeEnvelope(
  envelope: Partial<OrchestratorAttemptResultEnvelope> & { summary: string; success: boolean }
): OrchestratorAttemptResultEnvelope {
  const warnings = Array.isArray(envelope.warnings) ? envelope.warnings.map((entry) => String(entry)) : [];
  const outputs =
    envelope.outputs && typeof envelope.outputs === "object" && !Array.isArray(envelope.outputs)
      ? (envelope.outputs as Record<string, unknown>)
      : null;
  return {
    schema: "ade.orchestratorAttempt.v1",
    success: envelope.success,
    summary: String(envelope.summary ?? "").trim() || (envelope.success ? "Step completed." : "Step failed."),
    outputs,
    warnings,
    sessionId: typeof envelope.sessionId === "string" ? envelope.sessionId : null,
    trackedSession: envelope.trackedSession !== false
  };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 14))}\n...<truncated>`;
}

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeRepoRelativePath(projectRoot: string, rawPath: string): string | null {
  let value = String(rawPath ?? "").trim();
  if (!value.length) return null;
  if (path.isAbsolute(value)) {
    value = path.relative(projectRoot, value);
  }
  value = value.replace(/\\/g, "/");
  value = path.posix.normalize(value);
  while (value.startsWith("./")) value = value.slice(2);
  if (!value.length || value === ".") return null;
  if (value.startsWith("../")) return null;
  return value;
}

function extractFileClaimPattern(scopeValue: string): string {
  let value = String(scopeValue ?? "").trim();
  if (value.startsWith("pattern:")) value = value.slice("pattern:".length);
  if (value.startsWith("glob:")) value = value.slice("glob:".length);
  return value.trim();
}

function normalizeFileClaimScopeValue(projectRoot: string, scopeValue: string): string | null {
  let pattern = extractFileClaimPattern(scopeValue);
  if (!pattern.length) return null;
  pattern = pattern.replace(/\\/g, "/");
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  if (pattern.endsWith("/")) {
    pattern = `${pattern}**`;
  }
  const normalized = normalizeRepoRelativePath(projectRoot, pattern);
  if (!normalized) return null;
  return `glob:${normalized}`;
}

function staticGlobPrefix(globPattern: string): string {
  const wildcardIndex = globPattern.search(/[*?[\]]/);
  if (wildcardIndex < 0) return globPattern;
  return globPattern.slice(0, wildcardIndex);
}

function globToRegExp(globPattern: string): RegExp {
  const escaped = globPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "__ADE_GLOB_STAR__")
    .replace(/\?/g, "__ADE_GLOB_Q__")
    .replace(/__ADE_GLOB_STAR____ADE_GLOB_STAR__/g, ".*")
    .replace(/__ADE_GLOB_STAR__/g, "[^/]*")
    .replace(/__ADE_GLOB_Q__/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function doesFileClaimMatchPath(scopeValue: string, repoPath: string): boolean {
  const pattern = extractFileClaimPattern(scopeValue);
  if (!pattern.length) return false;
  try {
    return globToRegExp(pattern).test(repoPath);
  } catch {
    return false;
  }
}

function doFileClaimsOverlap(leftScopeValue: string, rightScopeValue: string): boolean {
  const left = extractFileClaimPattern(leftScopeValue);
  const right = extractFileClaimPattern(rightScopeValue);
  if (!left.length || !right.length) return false;
  if (left === right) return true;

  const leftWildcard = /[*?[\]]/.test(left);
  const rightWildcard = /[*?[\]]/.test(right);
  if (!leftWildcard && !rightWildcard) return left === right;
  if (!leftWildcard) return doesFileClaimMatchPath(rightScopeValue, left);
  if (!rightWildcard) return doesFileClaimMatchPath(leftScopeValue, right);

  const leftPrefix = staticGlobPrefix(left);
  const rightPrefix = staticGlobPrefix(right);
  if (leftPrefix.length > 0 && rightPrefix.length > 0) {
    if (leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix)) return true;
    const leftRoot = leftPrefix.split("/")[0] ?? "";
    const rightRoot = rightPrefix.split("/")[0] ?? "";
    if (leftRoot.length > 0 && leftRoot === rightRoot) return true;
    return false;
  }

  return true;
}

function readDocPaths(projectRoot: string): string[] {
  const out: string[] = [];
  const canonical = path.join(projectRoot, "docs", "PRD.md");
  if (fs.existsSync(canonical)) out.push(canonical);

  const architectureRoot = path.join(projectRoot, "docs", "architecture");
  const walk = (root: string) => {
    if (!fs.existsSync(root)) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(root, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      out.push(abs);
    }
  };
  walk(architectureRoot);
  return out.sort((a, b) => a.localeCompare(b));
}

function resolveStepPolicy(step: OrchestratorStep): StepPolicy {
  const metadata = step.metadata ?? {};
  const rawPolicy = metadata.policy;
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return {};
  const record = rawPolicy as Record<string, unknown>;
  const claimScopes = Array.isArray(record.claimScopes)
    ? record.claimScopes
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const obj = entry as Record<string, unknown>;
          const scopeKind = normalizeClaimScope(String(obj.scopeKind ?? "lane"));
          const scopeValue = String(obj.scopeValue ?? "").trim();
          if (!scopeValue) return null;
          const ttlRaw = Number(obj.ttlMs ?? NaN);
          const normalized: { scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number } = {
            scopeKind,
            scopeValue
          };
          if (Number.isFinite(ttlRaw) && ttlRaw > 0) {
            normalized.ttlMs = Math.floor(ttlRaw);
          }
          return normalized;
        })
        .filter((entry): entry is { scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number } => entry != null)
    : undefined;
  return {
    includeNarrative: record.includeNarrative === true,
    includeFullDocs: record.includeFullDocs === true,
    docsMaxBytes: Number.isFinite(Number(record.docsMaxBytes)) ? Number(record.docsMaxBytes) : undefined,
    claimScopes
  };
}

function resolveContextPolicy(args: {
  runProfileId: OrchestratorContextProfileId;
  stepPolicy: StepPolicy;
}): OrchestratorContextPolicyProfile {
  const base = CONTEXT_PROFILES[args.runProfileId] ?? CONTEXT_PROFILES[DEFAULT_CONTEXT_PROFILE_ID];
  const includeNarrative = args.stepPolicy.includeNarrative === true ? true : base.includeNarrative;
  return {
    ...base,
    includeNarrative,
    laneExportLevel: includeNarrative ? "deep" : base.laneExportLevel,
    docsMode: args.stepPolicy.includeFullDocs ? "full_docs" : base.docsMode,
    maxDocBytes:
      typeof args.stepPolicy.docsMaxBytes === "number" && Number.isFinite(args.stepPolicy.docsMaxBytes) && args.stepPolicy.docsMaxBytes > 0
        ? Math.floor(args.stepPolicy.docsMaxBytes)
        : base.maxDocBytes
  };
}

type AutopilotConfig = {
  enabled: boolean;
  executorKind: OrchestratorExecutorKind;
  ownerId: string;
  parallelismCap: number;
};

function parseAutopilotConfig(metadata: Record<string, unknown> | null | undefined): AutopilotConfig {
  const fallback: AutopilotConfig = {
    enabled: false,
    executorKind: "manual",
    ownerId: "orchestrator-autopilot",
    parallelismCap: DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG.maxParallelWorkers
  };
  if (!metadata) return fallback;
  const raw = metadata.autopilot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  const executorKind = normalizeExecutorKind(String(record.executorKind ?? "manual"));
  const enabled = record.enabled === true && executorKind !== "manual";
  const ownerId = String(record.ownerId ?? "").trim() || "orchestrator-autopilot";
  const parallelismCap = asIntInRange(
    record.parallelismCap,
    DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG.maxParallelWorkers,
    1,
    32
  );
  return {
    enabled,
    executorKind,
    ownerId,
    parallelismCap
  };
}

function parseNumericDependencyIndices(metadata: Record<string, unknown>): number[] {
  const candidates = metadata.dependencyIndices;
  if (!Array.isArray(candidates)) return [];
  const out: number[] = [];
  for (const entry of candidates) {
    const value = Number(entry);
    if (!Number.isFinite(value)) continue;
    out.push(Math.floor(value));
  }
  return out;
}

function parseStepPolicyFromMetadata(metadata: Record<string, unknown>): StartOrchestratorRunStepInput["policy"] | undefined {
  const raw = metadata.policy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const includeNarrative = record.includeNarrative === true;
  const includeFullDocs = record.includeFullDocs === true;
  const docsMaxBytes = Number(record.docsMaxBytes);
  const claimScopes = Array.isArray(record.claimScopes)
    ? record.claimScopes
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const scope = entry as Record<string, unknown>;
          const scopeValue = String(scope.scopeValue ?? "").trim();
          if (!scopeValue.length) return null;
          const ttlMs = Number(scope.ttlMs);
          const normalized: { scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number } = {
            scopeKind: normalizeClaimScope(String(scope.scopeKind ?? "lane")),
            scopeValue
          };
          if (Number.isFinite(ttlMs) && ttlMs > 0) {
            normalized.ttlMs = Math.floor(ttlMs);
          }
          return normalized;
        })
        .filter(
          (entry): entry is { scopeKind: OrchestratorClaimScope; scopeValue: string; ttlMs?: number } => entry != null
        )
    : undefined;

  return {
    includeNarrative,
    includeFullDocs,
    docsMaxBytes: Number.isFinite(docsMaxBytes) && docsMaxBytes > 0 ? Math.floor(docsMaxBytes) : undefined,
    claimScopes
  };
}

function parseStepPriority(step: OrchestratorStep): number {
  const raw = step.metadata?.priority;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "urgent") return 1;
    if (normalized === "high") return 2;
    if (normalized === "normal") return 3;
    if (normalized === "low") return 4;
    const asNumber = Number(normalized);
    if (Number.isFinite(asNumber)) return Math.floor(asNumber);
  }
  return 50;
}

function buildStepDepthMap(steps: OrchestratorStep[]): Map<string, number> {
  const byId = new Map<string, OrchestratorStep>();
  for (const step of steps) byId.set(step.id, step);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (stepId: string): number => {
    const cached = memo.get(stepId);
    if (typeof cached === "number") return cached;
    if (visiting.has(stepId)) return 0;
    visiting.add(stepId);
    const step = byId.get(stepId);
    if (!step || step.dependencyStepIds.length === 0) {
      memo.set(stepId, 0);
      visiting.delete(stepId);
      return 0;
    }
    let maxDepth = 0;
    for (const depId of step.dependencyStepIds) {
      const depDepth = visit(depId);
      maxDepth = Math.max(maxDepth, depDepth + 1);
    }
    memo.set(stepId, maxDepth);
    visiting.delete(stepId);
    return maxDepth;
  };
  for (const step of steps) visit(step.id);
  return memo;
}

function stableStepOrderComparator(args: { depthById: Map<string, number>; hashByStepId: Map<string, string> }) {
  return (a: OrchestratorStep, b: OrchestratorStep) => {
    const depthDiff = (args.depthById.get(a.id) ?? 0) - (args.depthById.get(b.id) ?? 0);
    if (depthDiff !== 0) return depthDiff;

    const priorityDiff = parseStepPriority(a) - parseStepPriority(b);
    if (priorityDiff !== 0) return priorityDiff;

    const planOrderDiff = a.stepIndex - b.stepIndex;
    if (planOrderDiff !== 0) return planOrderDiff;

    const hashA = args.hashByStepId.get(a.id) ?? "";
    const hashB = args.hashByStepId.get(b.id) ?? "";
    if (hashA !== hashB) return hashA.localeCompare(hashB);

    return a.stepKey.localeCompare(b.stepKey);
  };
}

export function createOrchestratorService({
  db,
  projectId,
  projectRoot,
  packService,
  conflictService,
  ptyService,
  projectConfigService,
  onEvent
}: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  packService: ReturnType<typeof createPackService>;
  conflictService?: ReturnType<typeof createConflictService>;
  ptyService?: ReturnType<typeof createPtyService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService> | null;
  onEvent?: (event: OrchestratorEvent) => void;
}) {
  const adapters = new Map<OrchestratorExecutorKind, OrchestratorExecutorAdapter>();
  const autopilotRunLocks = new Set<string>();
  const getRuntimeConfig = (): ResolvedOrchestratorRuntimeConfig => {
    const snapshot = projectConfigService?.get();
    const ai = asRecord(snapshot?.effective?.ai);
    const orchestrator = asRecord(ai?.orchestrator);
    if (!orchestrator) return DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG;
    const out: ResolvedOrchestratorRuntimeConfig = { ...DEFAULT_ORCHESTRATOR_RUNTIME_CONFIG };
    out.requirePlanReview = asBool(orchestrator.requirePlanReview, asBool(orchestrator.require_plan_review, out.requirePlanReview));
    out.maxParallelWorkers = asIntInRange(
      orchestrator.maxParallelWorkers ?? orchestrator.max_parallel_workers,
      out.maxParallelWorkers,
      1,
      16
    );
    const mergePolicy = String(orchestrator.defaultMergePolicy ?? orchestrator.default_merge_policy ?? "").trim();
    if (mergePolicy === "sequential" || mergePolicy === "batch-at-end" || mergePolicy === "per-step") {
      out.defaultMergePolicy = mergePolicy;
    }
    const conflictHandoff = String(orchestrator.defaultConflictHandoff ?? orchestrator.default_conflict_handoff ?? "").trim();
    if (conflictHandoff === "auto-resolve" || conflictHandoff === "ask-user" || conflictHandoff === "orchestrator-decides") {
      out.defaultConflictHandoff = conflictHandoff;
    }
    out.workerHeartbeatIntervalMs = asIntInRange(
      orchestrator.workerHeartbeatIntervalMs ?? orchestrator.worker_heartbeat_interval_ms,
      out.workerHeartbeatIntervalMs,
      1_000,
      600_000
    );
    out.workerHeartbeatTimeoutMs = asIntInRange(
      orchestrator.workerHeartbeatTimeoutMs ?? orchestrator.worker_heartbeat_timeout_ms,
      out.workerHeartbeatTimeoutMs,
      1_000,
      900_000
    );
    out.workerIdleTimeoutMs = asIntInRange(
      orchestrator.workerIdleTimeoutMs ?? orchestrator.worker_idle_timeout_ms,
      out.workerIdleTimeoutMs,
      1_000,
      3_600_000
    );
    out.stepTimeoutDefaultMs = asIntInRange(
      orchestrator.stepTimeoutDefaultMs ?? orchestrator.step_timeout_default_ms,
      out.stepTimeoutDefaultMs,
      1_000,
      3_600_000
    );
    out.maxRetriesPerStep = asIntInRange(
      orchestrator.maxRetriesPerStep ?? orchestrator.max_retries_per_step,
      out.maxRetriesPerStep,
      0,
      8
    );
    out.contextPressureThreshold = asNumberInRange(
      orchestrator.contextPressureThreshold ?? orchestrator.context_pressure_threshold,
      out.contextPressureThreshold,
      0.1,
      0.99
    );
    out.progressiveLoading = asBool(orchestrator.progressiveLoading, asBool(orchestrator.progressive_loading, out.progressiveLoading));
    out.maxTotalTokenBudget = asPositiveNumberOrNull(orchestrator.maxTotalTokenBudget ?? orchestrator.max_total_token_budget);
    out.maxPerStepTokenBudget = asPositiveNumberOrNull(orchestrator.maxPerStepTokenBudget ?? orchestrator.max_per_step_token_budget);
    const reservationGuardMode = String(
      orchestrator.fileReservationGuardMode
      ?? orchestrator.file_reservation_guard_mode
      ?? out.fileReservationGuardMode
    ).trim();
    if (reservationGuardMode === "off" || reservationGuardMode === "warn" || reservationGuardMode === "block") {
      out.fileReservationGuardMode = reservationGuardMode;
    }
    return out;
  };

  const emit = (event: Omit<OrchestratorEvent, "at">) => {
    onEvent?.({
      ...event,
      at: nowIso()
    });
  };

  const appendTimelineEvent = (args: {
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    claimId?: string | null;
    eventType: string;
    reason: string;
    detail?: Record<string, unknown> | null;
  }): OrchestratorTimelineEvent => {
    const id = randomUUID();
    const createdAt = nowIso();
    db.run(
      `
        insert into orchestrator_timeline_events(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          claim_id,
          event_type,
          reason,
          detail_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        projectId,
        args.runId,
        args.stepId ?? null,
        args.attemptId ?? null,
        args.claimId ?? null,
        args.eventType,
        args.reason,
        args.detail ? JSON.stringify(args.detail) : null,
        createdAt
      ]
    );
    return {
      id,
      runId: args.runId,
      stepId: args.stepId ?? null,
      attemptId: args.attemptId ?? null,
      claimId: args.claimId ?? null,
      eventType: args.eventType,
      reason: args.reason,
      detail: args.detail ?? null,
      createdAt
    };
  };

  const persistRuntimeEvent = (args: {
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    sessionId?: string | null;
    eventType: OrchestratorRuntimeEventType;
    eventKey?: string | null;
    occurredAt?: string | null;
    payload?: Record<string, unknown> | null;
  }): OrchestratorRuntimeBusEvent => {
    const createdAt = nowIso();
    const occurredAt = normalizeIsoTimestamp(args.occurredAt, createdAt);
    const baseKey = `${args.runId}:${args.stepId ?? "none"}:${args.attemptId ?? "none"}:${args.sessionId ?? "none"}:${args.eventType}:${occurredAt}`;
    const eventKey = String(args.eventKey ?? baseKey).trim() || baseKey;
    const eventId = randomUUID();
    db.run(
      `
        insert or ignore into orchestrator_runtime_events(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          session_id,
          event_type,
          event_key,
          occurred_at,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        eventId,
        projectId,
        args.runId,
        args.stepId ?? null,
        args.attemptId ?? null,
        args.sessionId ?? null,
        args.eventType,
        eventKey,
        occurredAt,
        args.payload ? JSON.stringify(args.payload) : null,
        createdAt
      ]
    );
    const row = db.get<RuntimeEventRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          session_id,
          event_type,
          event_key,
          occurred_at,
          payload_json,
          created_at
        from orchestrator_runtime_events
        where project_id = ?
          and event_key = ?
        limit 1
      `,
      [projectId, eventKey]
    );
    if (!row) {
      throw new Error(`Failed to persist runtime event: ${args.eventType}`);
    }
    return toRuntimeEvent(row);
  };

  const listTimelineRows = (args: { runId: string; limit?: number }): TimelineRow[] => {
    const limitRaw = Number(args.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(limitRaw))) : 200;
    return db.all<TimelineRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          claim_id,
          event_type,
          reason,
          detail_json,
          created_at
        from orchestrator_timeline_events
        where project_id = ?
          and run_id = ?
        order by created_at desc
        limit ?
      `,
      [projectId, args.runId, limit]
    );
  };

  const listRuntimeEventRows = (args: {
    runId?: string;
    attemptId?: string;
    sessionId?: string;
    eventTypes?: OrchestratorRuntimeEventType[];
    since?: string | null;
    limit?: number;
  }): RuntimeEventRow[] => {
    const where: string[] = ["project_id = ?"];
    const params: SqlValue[] = [projectId];
    if (args.runId) {
      where.push("run_id = ?");
      params.push(args.runId);
    }
    if (args.attemptId) {
      where.push("attempt_id = ?");
      params.push(args.attemptId);
    }
    if (args.sessionId) {
      where.push("session_id = ?");
      params.push(args.sessionId);
    }
    if (args.eventTypes && args.eventTypes.length > 0) {
      const normalizedTypes = [...new Set(args.eventTypes.map((entry) => normalizeRuntimeEventType(String(entry))))];
      const placeholders = normalizedTypes.map(() => "?").join(", ");
      where.push(`event_type in (${placeholders})`);
      params.push(...normalizedTypes);
    }
    if (args.since && String(args.since).trim().length > 0) {
      where.push("occurred_at >= ?");
      params.push(normalizeIsoTimestamp(args.since, nowIso()));
    }
    const limitRaw = Number(args.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5_000, Math.floor(limitRaw))) : 200;
    return db.all<RuntimeEventRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          session_id,
          event_type,
          event_key,
          occurred_at,
          payload_json,
          created_at
        from orchestrator_runtime_events
        where ${where.join(" and ")}
        order by occurred_at desc, created_at desc
        limit ?
      `,
      [...params, limit]
    );
  };

  const getRunRow = (runId: string): RunRow | null =>
    db.get<RunRow>(
      `
        select
          id,
          mission_id,
          project_id,
          status,
          context_profile,
          scheduler_state,
          runtime_cursor_json,
          last_error,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        from orchestrator_runs
        where id = ?
          and project_id = ?
        limit 1
      `,
      [runId, projectId]
    );

  const getStepRow = (stepId: string): StepRow | null =>
    db.get<StepRow>(
      `
        select
          id,
          run_id,
          mission_step_id,
          step_key,
          step_index,
          title,
          lane_id,
          status,
          join_policy,
          quorum_count,
          dependency_step_ids_json,
          retry_limit,
          retry_count,
          last_attempt_id,
          policy_json,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        from orchestrator_steps
        where id = ?
          and project_id = ?
        limit 1
      `,
      [stepId, projectId]
    );

  const listStepRows = (runId: string): StepRow[] =>
    db.all<StepRow>(
      `
        select
          id,
          run_id,
          mission_step_id,
          step_key,
          step_index,
          title,
          lane_id,
          status,
          join_policy,
          quorum_count,
          dependency_step_ids_json,
          retry_limit,
          retry_count,
          last_attempt_id,
          policy_json,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        from orchestrator_steps
        where run_id = ?
          and project_id = ?
        order by step_index asc, created_at asc
      `,
      [runId, projectId]
    );

  const getAttemptRow = (attemptId: string): AttemptRow | null =>
    db.get<AttemptRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_number,
          status,
          executor_kind,
          executor_session_id,
          tracked_session_enforced,
          context_profile,
          context_snapshot_id,
          error_class,
          error_message,
          retry_backoff_ms,
          result_envelope_json,
          metadata_json,
          created_at,
          started_at,
          completed_at
        from orchestrator_attempts
        where id = ?
          and project_id = ?
        limit 1
      `,
      [attemptId, projectId]
    );

  const listAttemptRows = (runId: string): AttemptRow[] =>
    db.all<AttemptRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_number,
          status,
          executor_kind,
          executor_session_id,
          tracked_session_enforced,
          context_profile,
          context_snapshot_id,
          error_class,
          error_message,
          retry_backoff_ms,
          result_envelope_json,
          metadata_json,
          created_at,
          started_at,
          completed_at
        from orchestrator_attempts
        where run_id = ?
          and project_id = ?
        order by created_at desc
      `,
      [runId, projectId]
    );

  const insertHandoff = (args: {
    missionId: string;
    missionStepId: string | null;
    runId: string | null;
    stepId: string | null;
    attemptId: string | null;
    handoffType: string;
    producer: string;
    payload: Record<string, unknown>;
  }) => {
    const id = randomUUID();
    const createdAt = nowIso();
    db.run(
      `
        insert into mission_step_handoffs(
          id,
          project_id,
          mission_id,
          mission_step_id,
          run_id,
          step_id,
          attempt_id,
          handoff_type,
          producer,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        projectId,
        args.missionId,
        args.missionStepId,
        args.runId,
        args.stepId,
        args.attemptId,
        args.handoffType,
        args.producer,
        JSON.stringify(args.payload),
        createdAt
      ]
    );
  };

  const updateRunStatus = (runId: string, status: OrchestratorRunStatus, patch: Record<string, SqlValue> = {}) => {
    const existing = getRunRow(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const updatedAt = nowIso();
    const startedAt = status === "running" && !existing.started_at ? updatedAt : existing.started_at;
    const completedAt = TERMINAL_RUN_STATUSES.has(status) ? updatedAt : null;
    db.run(
      `
        update orchestrator_runs
        set status = ?,
            scheduler_state = ?,
            runtime_cursor_json = ?,
            last_error = ?,
            metadata_json = ?,
            started_at = ?,
            completed_at = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [
        status,
        patch.scheduler_state ?? existing.scheduler_state,
        patch.runtime_cursor_json ?? existing.runtime_cursor_json,
        patch.last_error ?? existing.last_error,
        patch.metadata_json ?? existing.metadata_json,
        startedAt,
        completedAt,
        updatedAt,
        runId,
        projectId
      ]
    );
    emit({ type: "orchestrator-run-updated", runId, reason: "status_updated" });
    appendTimelineEvent({
      runId,
      eventType: "run_status_changed",
      reason: "status_updated",
      detail: {
        from: normalizeRunStatus(existing.status),
        to: status,
        schedulerState: patch.scheduler_state ?? existing.scheduler_state
      }
    });
  };

  const expireClaims = () => {
    const now = nowIso();
    const expiring = db.all<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and state = 'active'
          and expires_at <= ?
      `,
      [projectId, now]
    );
    db.run(
      `
        update orchestrator_claims
        set state = 'expired',
            released_at = ?
        where project_id = ?
          and state = 'active'
          and expires_at <= ?
      `,
      [now, projectId, now]
    );
    for (const row of expiring) {
      appendTimelineEvent({
        runId: row.run_id,
        stepId: row.step_id,
        attemptId: row.attempt_id,
        claimId: row.id,
        eventType: "claim_expired",
        reason: "lease_expired",
        detail: {
          ownerId: row.owner_id,
          scopeKind: row.scope_kind,
          scopeValue: row.scope_value,
          expiresAt: row.expires_at
        }
      });
      emit({ type: "orchestrator-claim-updated", runId: row.run_id, claimId: row.id, reason: "expired" });
    }
  };

  const acquireClaim = (args: {
    runId: string;
    stepId: string | null;
    attemptId: string | null;
    ownerId: string;
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
    ttlMs: number;
    policy: Record<string, unknown>;
  }): OrchestratorClaim | null => {
    expireClaims();
    const normalizedScopeValue = normalizeClaimScopeValue({
      scopeKind: args.scopeKind,
      scopeValue: args.scopeValue
    });
    if (!normalizedScopeValue) return null;
    const conflict = findActiveClaimConflict({
      scopeKind: args.scopeKind,
      scopeValue: normalizedScopeValue,
      ignoreAttemptId: args.attemptId
    });
    if (conflict) return null;
    const id = randomUUID();
    const acquiredAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1_000, Math.floor(args.ttlMs))).toISOString();
    try {
      db.run(
        `
          insert into orchestrator_claims(
            id,
            project_id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, null, ?, ?)
        `,
        [
          id,
          projectId,
          args.runId,
          args.stepId,
            args.attemptId,
            args.ownerId,
            args.scopeKind,
            normalizedScopeValue,
            acquiredAt,
            acquiredAt,
            expiresAt,
          JSON.stringify(args.policy),
          JSON.stringify({})
        ]
      );
      const row = db.get<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where id = ?
            and project_id = ?
          limit 1
        `,
        [id, projectId]
      );
      if (!row) return null;
      const claim = toClaim(row);
      emit({ type: "orchestrator-claim-updated", runId: args.runId, claimId: claim.id, reason: "acquired" });
      appendTimelineEvent({
        runId: args.runId,
        stepId: args.stepId,
        attemptId: args.attemptId,
        claimId: claim.id,
        eventType: "claim_acquired",
        reason: "claim_acquired",
        detail: {
          ownerId: claim.ownerId,
          scopeKind: claim.scopeKind,
          scopeValue: claim.scopeValue,
          expiresAt: claim.expiresAt
        }
      });
      return claim;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("constraint")) return null;
      throw error;
    }
  };

  const releaseClaimsForAttempt = (args: {
    attemptId: string;
    state?: Exclude<OrchestratorClaimState, "active">;
  }): number => {
    const nextState = args.state ?? "released";
    const releasedAt = nowIso();
    const releasable = db.all<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and attempt_id = ?
          and state = 'active'
      `,
      [projectId, args.attemptId]
    );
    db.run(
      `
        update orchestrator_claims
        set state = ?,
            released_at = ?
        where project_id = ?
          and attempt_id = ?
          and state = 'active'
      `,
      [nextState, releasedAt, projectId, args.attemptId]
    );
    const countRow = db.get<{ count: number }>(
      `
        select count(*) as count
        from orchestrator_claims
        where project_id = ?
          and attempt_id = ?
          and state = ?
      `,
      [projectId, args.attemptId, nextState]
    );
    const count = Number(countRow?.count ?? 0);
    if (count > 0) {
      emit({ type: "orchestrator-claim-updated", attemptId: args.attemptId, reason: "released" });
      for (const claim of releasable) {
        appendTimelineEvent({
          runId: claim.run_id,
          stepId: claim.step_id,
          attemptId: claim.attempt_id,
          claimId: claim.id,
          eventType: nextState === "expired" ? "claim_expired" : "claim_released",
          reason: nextState === "expired" ? "released_as_expired" : "released",
          detail: {
            ownerId: claim.owner_id,
            scopeKind: claim.scope_kind,
            scopeValue: claim.scope_value,
            releasedAt,
            state: nextState
          }
        });
      }
    }
    return count;
  };

  const normalizeClaimScopeValue = (args: {
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
  }): string | null => {
    const raw = String(args.scopeValue ?? "").trim();
    if (!raw.length) return null;
    if (args.scopeKind !== "file") return raw;
    return normalizeFileClaimScopeValue(projectRoot, raw);
  };

  const findActiveClaimConflict = (args: {
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
    ignoreAttemptId?: string | null;
  }): { conflict: ClaimRow; reason: string } | null => {
    const ignoreAttemptId = String(args.ignoreAttemptId ?? "").trim();
    if (args.scopeKind === "file") {
      const activeFileClaims = db.all<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where project_id = ?
            and state = 'active'
            and scope_kind = 'file'
        `,
        [projectId]
      );
      for (const claim of activeFileClaims) {
        if (ignoreAttemptId.length > 0 && claim.attempt_id === ignoreAttemptId) continue;
        if (!doFileClaimsOverlap(args.scopeValue, claim.scope_value)) continue;
        return {
          conflict: claim,
          reason: `overlapping_file_scope:${args.scopeValue}<->${claim.scope_value}`
        };
      }
      return null;
    }

    const row = db.get<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and state = 'active'
          and scope_kind = ?
          and scope_value = ?
          ${ignoreAttemptId.length > 0 ? "and coalesce(attempt_id, '') != ?" : ""}
        limit 1
      `,
      ignoreAttemptId.length > 0
        ? [projectId, args.scopeKind, args.scopeValue, ignoreAttemptId]
        : [projectId, args.scopeKind, args.scopeValue]
    );
    if (!row) return null;
    return {
      conflict: row,
      reason: "exact_scope_collision"
    };
  };

  const collectTouchedRepoPaths = (args: {
    result?: Partial<OrchestratorAttemptResultEnvelope> | null;
    metadata?: Record<string, unknown> | null;
  }): { touchedPaths: string[]; rawPaths: string[] } => {
    const rawPaths: string[] = [];
    const touched = new Set<string>();
    const pushPath = (value: unknown) => {
      if (typeof value !== "string") return;
      const raw = value.trim();
      if (!raw.length) return;
      rawPaths.push(raw);
      const normalized = normalizeRepoRelativePath(projectRoot, raw);
      if (!normalized) return;
      touched.add(normalized);
    };
    const parsePathArray = (value: unknown) => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (typeof entry === "string") {
          const renameSplit = entry.split(/\s*->\s*/);
          if (renameSplit.length === 2) {
            pushPath(renameSplit[0]);
            pushPath(renameSplit[1]);
          } else {
            pushPath(entry);
          }
          continue;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        pushPath(record.path);
        pushPath(record.file);
        pushPath(record.from);
        pushPath(record.to);
        pushPath(record.oldPath);
        pushPath(record.newPath);
      }
    };

    const outputs =
      args.result?.outputs && typeof args.result.outputs === "object" && !Array.isArray(args.result.outputs)
        ? (args.result.outputs as Record<string, unknown>)
        : {};
    parsePathArray(outputs.modifiedFiles ?? outputs.modified_files ?? outputs.filesModified ?? outputs.files_modified);
    parsePathArray(outputs.changedFiles ?? outputs.changed_files);
    parsePathArray(outputs.renamedFiles ?? outputs.renamed_files);
    parsePathArray(args.metadata?.changedFiles ?? args.metadata?.changed_files);
    parsePathArray(args.metadata?.modifiedFiles ?? args.metadata?.modified_files);
    parsePathArray(args.metadata?.renamedFiles ?? args.metadata?.renamed_files);
    return {
      touchedPaths: [...touched].sort((a, b) => a.localeCompare(b)),
      rawPaths
    };
  };

  const evaluateFileReservationViolations = (args: {
    step: OrchestratorStep;
    result?: Partial<OrchestratorAttemptResultEnvelope> | null;
    metadata?: Record<string, unknown> | null;
  }): {
    normalizedScopes: string[];
    touchedPaths: string[];
    violations: string[];
    rawPaths: string[];
  } => {
    const stepPolicy = resolveStepPolicy(args.step);
    const fileScopes = (stepPolicy.claimScopes ?? [])
      .filter((scope) => scope.scopeKind === "file")
      .map((scope) => normalizeClaimScopeValue({ scopeKind: "file", scopeValue: scope.scopeValue }))
      .filter((scope): scope is string => Boolean(scope));
    if (!fileScopes.length) {
      return {
        normalizedScopes: [],
        touchedPaths: [],
        violations: [],
        rawPaths: []
      };
    }
    const touched = collectTouchedRepoPaths({
      result: args.result,
      metadata: args.metadata
    });
    const violations = touched.touchedPaths.filter((repoPath) => {
      for (const scope of fileScopes) {
        if (doesFileClaimMatchPath(scope, repoPath)) return false;
      }
      return true;
    });
    return {
      normalizedScopes: fileScopes,
      touchedPaths: touched.touchedPaths,
      violations,
      rawPaths: touched.rawPaths
    };
  };

  const isPermanentlyBlockedStep = (step: OrchestratorStep): boolean => {
    if (step.status !== "blocked") return false;
    if (step.metadata?.blockedSticky === true) return true;
    return step.metadata?.blockedErrorClass === "policy";
  };

  const isTerminalForDependencyGate = (step: OrchestratorStep | null): boolean => {
    if (!step) return false;
    if (TERMINAL_STEP_STATUSES.has(step.status)) return true;
    return isPermanentlyBlockedStep(step);
  };

  const evaluateDependencyGate = (step: OrchestratorStep, stepsById: Map<string, OrchestratorStep>) => {
    if (!step.dependencyStepIds.length) {
      return { satisfied: true, permanentlyBlocked: false };
    }
    const depSteps = step.dependencyStepIds.map((id) => stepsById.get(id) ?? null);
    const depStatuses = depSteps.map((dep) => dep?.status ?? "pending");
    const successCount = depStatuses.filter((status) => status === "succeeded" || status === "skipped").length;
    const allTerminal = depSteps.every((dep) => isTerminalForDependencyGate(dep));
    if (step.joinPolicy === "any_success") {
      if (successCount >= 1) return { satisfied: true, permanentlyBlocked: false };
      return { satisfied: false, permanentlyBlocked: allTerminal };
    }
    if (step.joinPolicy === "quorum") {
      const required = step.quorumCount && step.quorumCount > 0 ? step.quorumCount : Math.max(1, Math.ceil(depStatuses.length / 2));
      if (successCount >= required) return { satisfied: true, permanentlyBlocked: false };
      return { satisfied: false, permanentlyBlocked: allTerminal };
    }
    // all_success
    const allSucceeded = depStatuses.every((status) => status === "succeeded" || status === "skipped");
    if (allSucceeded) return { satisfied: true, permanentlyBlocked: false };
    return { satisfied: false, permanentlyBlocked: allTerminal };
  };

  const refreshStepReadiness = (runId: string) => {
    const rows = listStepRows(runId);
    if (!rows.length) return;
    const steps = rows.map(toStep);
    const stepsById = new Map<string, OrchestratorStep>(steps.map((step) => [step.id, step] as const));
    const statusesById = new Map<string, OrchestratorStepStatus>(steps.map((step) => [step.id, step.status] as const));
    const now = nowIso();

    for (const step of steps) {
      if (step.status === "running" || TERMINAL_STEP_STATUSES.has(step.status)) continue;
      const gate = evaluateDependencyGate(step, stepsById);
      const stepPolicy = resolveStepPolicy(step);
      const claimScoped = (stepPolicy.claimScopes ?? []).length > 0;
      const nextRetryAtRaw = typeof step.metadata?.nextRetryAt === "string" ? step.metadata.nextRetryAt : null;
      const nextRetryAtMs = nextRetryAtRaw ? Date.parse(nextRetryAtRaw) : NaN;
      const retryDeferred = Number.isFinite(nextRetryAtMs) && nextRetryAtMs > Date.now();
      const stickyBlocked = step.status === "blocked" && step.metadata?.blockedSticky === true;
      let next: OrchestratorStepStatus = step.status;
      if (gate.satisfied) {
        if (stickyBlocked) {
          next = "blocked";
        } else if (retryDeferred) {
          next = "pending";
        } else if (step.status === "pending" || step.status === "blocked") {
          next = "ready";
        }
      } else if (gate.permanentlyBlocked) {
        next = "blocked";
      } else {
        next = "pending";
      }

      if (next === "ready" && claimScoped && step.status === "blocked") {
        // Claim conflicts can clear when claims expire/release.
        const conflicts = (stepPolicy.claimScopes ?? []).some((scope) => {
          const normalizedScopeValue = normalizeClaimScopeValue({
            scopeKind: scope.scopeKind,
            scopeValue: scope.scopeValue
          });
          if (!normalizedScopeValue) return true;
          return Boolean(
            findActiveClaimConflict({
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue
            })
          );
        });
        if (conflicts) next = "blocked";
      }

      if (next !== step.status) {
        const nextMetadata = (() => {
          if (!step.metadata || !("nextRetryAt" in step.metadata)) return step.metadata;
          if (next !== "ready") return step.metadata;
          const clone = { ...step.metadata };
          delete clone.nextRetryAt;
          return clone;
        })();
        db.run(
          `
            update orchestrator_steps
            set status = ?,
                metadata_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [next, JSON.stringify(nextMetadata ?? null), now, step.id, runId, projectId]
        );
        stepsById.set(step.id, {
          ...step,
          status: next,
          metadata: nextMetadata ?? null,
          updatedAt: now
        });
        statusesById.set(step.id, next);
        emit({ type: "orchestrator-step-updated", runId, stepId: step.id, reason: "readiness_recomputed" });
        appendTimelineEvent({
          runId,
          stepId: step.id,
          eventType: "step_status_changed",
          reason: "readiness_recomputed",
          detail: {
            from: step.status,
            to: next,
            joinPolicy: step.joinPolicy,
            dependencies: step.dependencyStepIds
          }
        });
      }
    }
  };

  const deriveRunStatusFromSteps = (runId: string): OrchestratorRunStatus => {
    const steps = listStepRows(runId).map(toStep);
    if (!steps.length) return "succeeded";
    const statuses = steps.map((step) => step.status);
    const allTerminal = statuses.every((status) => TERMINAL_STEP_STATUSES.has(status));
    if (allTerminal && statuses.every((status) => status === "succeeded" || status === "skipped")) return "succeeded";
    if (allTerminal && statuses.every((status) => status === "canceled")) return "canceled";
    if (allTerminal && statuses.some((status) => status === "failed")) return "failed";
    if (allTerminal && statuses.some((status) => status === "blocked")) return "paused";
    if (statuses.some((status) => status === "running")) return "running";
    if (statuses.some((status) => status === "ready" || status === "pending")) return "running";
    if (statuses.some((status) => status === "blocked")) return "paused";
    return "running";
  };

  const createContextSnapshotForAttempt = async (args: {
    run: OrchestratorRun;
    step: OrchestratorStep;
    attemptId: string;
    contextProfile: OrchestratorContextPolicyProfile;
  }): Promise<CreateSnapshotResult> => {
    const runtimeConfig = getRuntimeConfig();
    const existingCursor = (() => {
      if (!args.run.metadata) return null;
      const raw = args.run.metadata.runtimeCursor;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      return raw as Record<string, unknown>;
    })();
    const previousPackDeltaSince = typeof existingCursor?.packDeltaSince === "string" ? existingCursor.packDeltaSince : null;
    const stepType = (() => {
      const fromMetadata = typeof args.step.metadata?.stepType === "string" ? args.step.metadata.stepType : null;
      if (fromMetadata && fromMetadata.trim().length) return fromMetadata.trim();
      const missionStepKind = db.get<{ kind: string | null }>(
        `
          select kind
          from mission_steps
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [args.step.missionStepId ?? "", args.run.missionId, projectId]
      );
      return typeof missionStepKind?.kind === "string" && missionStepKind.kind.trim().length ? missionStepKind.kind.trim() : "manual";
    })();
    const laneExportLevel =
      (stepType === "integration" || stepType === "merge") && args.contextProfile.includeNarrative
        ? "deep"
        : args.contextProfile.laneExportLevel;
    const projectExportLevel = stepType === "analysis" ? "standard" : args.contextProfile.projectExportLevel;
    const lanePackKey = args.step.laneId ? `lane:${args.step.laneId}` : null;
    const laneExport = await (async (): Promise<PackExport | null> => {
      if (!args.step.laneId) return null;
      const laneId = args.step.laneId;
      try {
        return await packService.getLaneExport({
          laneId,
          level: laneExportLevel
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Lane pack is empty")) {
          throw error;
        }
        await packService.refreshLanePack({
          laneId,
          reason: "orchestrator_context_bootstrap"
        });
        appendTimelineEvent({
          runId: args.run.id,
          stepId: args.step.id,
          attemptId: args.attemptId,
          eventType: "context_pack_bootstrap",
          reason: "lane_pack_refreshed",
          detail: {
            laneId
          }
        });
        return await packService.getLaneExport({
          laneId,
          level: laneExportLevel
        });
      }
    })();
    const projectExport = await packService.getProjectExport({
      level: projectExportLevel
    });

    const docsPaths = readDocPaths(projectRoot);
    let remainingBytes = args.contextProfile.maxDocBytes;
    let docsConsumedBytes = 0;
    let docsTruncatedCount = 0;
    const docsRefs: OrchestratorDocsRef[] = [];
    const fullDocs: Array<{ path: string; content: string; truncated: boolean }> = [];

    for (const abs of docsPaths) {
      const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      const digest = sha256(buf);
      const bytes = buf.length;
      if (args.contextProfile.docsMode === "full_docs") {
        const used = Math.min(Math.max(0, remainingBytes), bytes);
        const chunk = buf.subarray(0, used).toString("utf8");
        const truncated = used < bytes;
        docsConsumedBytes += used;
        if (truncated) docsTruncatedCount += 1;
        docsRefs.push({
          path: rel,
          sha256: digest,
          bytes,
          truncated,
          mode: "full_body"
        });
        fullDocs.push({
          path: rel,
          content: chunk,
          truncated
        });
        remainingBytes = Math.max(0, remainingBytes - used);
      } else {
        docsConsumedBytes += Math.min(64, bytes); // digest refs use only metadata bytes in prompt budget.
        docsRefs.push({
          path: rel,
          sha256: digest,
          bytes,
          truncated: false,
          mode: "digest_ref"
        });
      }
      if (remainingBytes <= 0 && args.contextProfile.docsMode === "full_docs") break;
    }

    const packDeltaDigest = await (async (): Promise<PackDeltaDigestV1 | null> => {
      if (!lanePackKey || !previousPackDeltaSince) return null;
      try {
        return await packService.getDeltaDigest({
          packKey: lanePackKey,
          sinceTimestamp: previousPackDeltaSince,
          minimumImportance: "medium",
          limit: 60
        });
      } catch {
        return null;
      }
    })();

    const missionStepIds = new Set<string>();
    if (args.step.missionStepId) missionStepIds.add(args.step.missionStepId);
    if (args.step.dependencyStepIds.length) {
      const placeholders = args.step.dependencyStepIds.map(() => "?").join(", ");
      const rows = db.all<{ mission_step_id: string | null }>(
        `
          select mission_step_id
          from orchestrator_steps
          where project_id = ?
            and run_id = ?
            and id in (${placeholders})
        `,
        [projectId, args.run.id, ...args.step.dependencyStepIds]
      );
      for (const row of rows) {
        if (row.mission_step_id) missionStepIds.add(row.mission_step_id);
      }
    }
    const missionHandoffLimit = runtimeConfig.progressiveLoading ? 12 : 30;
    const missionHandoffs = (() => {
      const ids = [...missionStepIds];
      if (!ids.length) return [] as Array<{ id: string; handoff_type: string; created_at: string }>;
      const placeholders = ids.map(() => "?").join(", ");
      return db.all<{ id: string; handoff_type: string; created_at: string }>(
        `
          select id, handoff_type, created_at
          from mission_step_handoffs
          where project_id = ?
            and mission_id = ?
            and mission_step_id in (${placeholders})
          order by created_at desc
          limit 60
        `,
        [projectId, args.run.missionId, ...ids]
      );
    })();
    const missionHandoffIds = missionHandoffs.slice(0, missionHandoffLimit).map((row) => row.id);
    const missionHandoffDigest = (() => {
      if (missionHandoffs.length <= missionHandoffLimit) return null;
      const summarized = missionHandoffs.slice(missionHandoffLimit);
      const byType = summarized.reduce<Record<string, number>>((acc, row) => {
        const key = String(row.handoff_type ?? "unknown").trim() || "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      return {
        summarizedCount: summarized.length,
        byType,
        oldestCreatedAt: summarized[summarized.length - 1]?.created_at ?? null,
        newestCreatedAt: summarized[0]?.created_at ?? null
      };
    })();

    const measureBytes = (value: unknown): number => {
      try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
      } catch {
        return 0;
      }
    };

    const runSteps = listStepRows(args.run.id).map(toStep);
    const frontier = {
      pending: runSteps.filter((step) => step.status === "pending").length,
      ready: runSteps.filter((step) => step.status === "ready").length,
      running: runSteps.filter((step) => step.status === "running").length,
      blocked: runSteps.filter((step) => step.status === "blocked").length,
      terminal: runSteps.filter((step) => TERMINAL_STEP_STATUSES.has(step.status)).length
    };
    const openQuestions = Number(
      db.get<{ count: number }>(
        `
          select count(*) as count
          from mission_interventions
          where project_id = ?
            and mission_id = ?
            and status = 'open'
            and intervention_type = 'manual_input'
        `,
        [projectId, args.run.missionId]
      )?.count ?? 0
    );
    const activeClaimsForRun = db.all<ClaimRow>(
      `
        select
          id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        from orchestrator_claims
        where project_id = ?
          and run_id = ?
          and state = 'active'
      `,
      [projectId, args.run.id]
    );
    const activeFileClaims = activeClaimsForRun.filter((claim) => claim.scope_kind === "file");
    let activeClaimConflicts = 0;
    for (let i = 0; i < activeFileClaims.length; i += 1) {
      for (let j = i + 1; j < activeFileClaims.length; j += 1) {
        if (doFileClaimsOverlap(activeFileClaims[i]!.scope_value, activeFileClaims[j]!.scope_value)) {
          activeClaimConflicts += 1;
        }
      }
    }
    const gateState = (() => {
      const latest = db.get<{ report_json: string | null }>(
        `
          select report_json
          from orchestrator_gate_reports
          where project_id = ?
          order by generated_at desc
          limit 1
        `,
        [projectId]
      );
      const report = parseRecord(latest?.report_json ?? null);
      const status = typeof report?.overallStatus === "string" ? report.overallStatus : "unknown";
      if (status === "pass" || status === "warn" || status === "fail") return status;
      return "unknown";
    })();
    const recentDecisions = db.all<{ event_type: string; reason: string }>(
      `
        select event_type, reason
        from orchestrator_timeline_events
        where project_id = ?
          and run_id = ?
          and event_type in ('attempt_retry_scheduled', 'attempt_completed', 'attempt_blocked', 'step_status_changed', 'run_status_changed', 'scheduler_tick')
        order by created_at desc
        limit 12
      `,
      [projectId, args.run.id]
    ).map((row) => `${row.event_type}:${row.reason}`);

    const laneStatusMap = runSteps
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map((step) => ({
        laneId: step.laneId,
        stepKey: step.stepKey,
        status: step.status
      }));

    const CONTROL_PACK_V2_BUDGET_BYTES = 8_192;
    const EXECUTION_PACK_V2_BUDGET_BYTES = 16_384;
    const DEEP_PACK_V2_BUDGET_BYTES = 4_096;

    let controlPackV2: NonNullable<OrchestratorContextSnapshotCursor["controlPackV2"]> = {
      budgetBytes: CONTROL_PACK_V2_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      frontier,
      openQuestions,
      activeClaims: activeClaimsForRun.length,
      activeClaimConflicts,
      gateState,
      recentDecisions,
      laneStatusMap
    };
    controlPackV2.consumedBytes = measureBytes(controlPackV2);
    if (controlPackV2.consumedBytes > CONTROL_PACK_V2_BUDGET_BYTES) {
      controlPackV2 = {
        ...controlPackV2,
        truncated: true,
        recentDecisions: controlPackV2.recentDecisions.slice(0, 8),
        laneStatusMap: controlPackV2.laneStatusMap.slice(0, 16)
      };
      controlPackV2.consumedBytes = measureBytes(controlPackV2);
    }
    if (controlPackV2.consumedBytes > CONTROL_PACK_V2_BUDGET_BYTES) {
      controlPackV2 = {
        ...controlPackV2,
        recentDecisions: controlPackV2.recentDecisions.slice(0, 4),
        laneStatusMap: controlPackV2.laneStatusMap.slice(0, 8)
      };
      controlPackV2.consumedBytes = measureBytes(controlPackV2);
    }

    const executionDependencies = args.step.dependencyStepIds
      .map((depId) => runSteps.find((step) => step.id === depId))
      .filter((dep): dep is OrchestratorStep => Boolean(dep))
      .map((dep) => ({ stepId: dep.id, status: dep.status }));
    let executionPackV2: NonNullable<OrchestratorContextSnapshotCursor["executionPackV2"]> = {
      budgetBytes: EXECUTION_PACK_V2_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      stepKey: args.step.stepKey,
      stepTitle: args.step.title,
      dependencies: executionDependencies,
      handoffIds: missionHandoffIds,
      handoffDigest: missionHandoffDigest
    };
    executionPackV2.consumedBytes = measureBytes(executionPackV2);
    if (executionPackV2.consumedBytes > EXECUTION_PACK_V2_BUDGET_BYTES) {
      executionPackV2 = {
        ...executionPackV2,
        truncated: true,
        dependencies: executionPackV2.dependencies.slice(0, 12),
        handoffIds: executionPackV2.handoffIds.slice(0, 10)
      };
      executionPackV2.consumedBytes = measureBytes(executionPackV2);
    }

    let deepPackV2: NonNullable<OrchestratorContextSnapshotCursor["deepPackV2"]> = {
      budgetBytes: DEEP_PACK_V2_BUDGET_BYTES,
      consumedBytes: 0,
      truncated: false,
      docsMode: args.contextProfile.docsMode === "full_docs" ? "full_body" : "digest_ref",
      docsCount: docsRefs.length,
      fullDocsIncluded: fullDocs.length,
      docsRefsOnly: Math.max(0, docsRefs.length - fullDocs.length)
    };
    deepPackV2.consumedBytes = measureBytes(deepPackV2);
    if (deepPackV2.consumedBytes > DEEP_PACK_V2_BUDGET_BYTES) {
      deepPackV2 = {
        ...deepPackV2,
        truncated: true
      };
      deepPackV2.consumedBytes = measureBytes(deepPackV2);
    }

    const laneHead = lanePackKey ? packService.getHeadVersion({ packKey: lanePackKey }) : null;
    const projectHead = packService.getHeadVersion({ packKey: "project" });
    const cursor: OrchestratorContextSnapshotCursor = {
      lanePackKey,
      lanePackVersionId: laneHead?.versionId ?? null,
      lanePackVersionNumber: laneHead?.versionNumber ?? null,
      projectPackKey: "project",
      projectPackVersionId: projectHead.versionId,
      projectPackVersionNumber: projectHead.versionNumber,
      packDeltaSince: previousPackDeltaSince,
	      docs: docsRefs,
	      packDeltaDigest,
	      missionHandoffIds,
	      missionHandoffDigest,
	      controlPackV2,
	      executionPackV2,
	      deepPackV2,
	      contextSources: [
	        "control_pack_v2",
	        "execution_pack_v2",
	        "deep_pack_v2",
	        `pack:project:${projectExport.level}`,
	        ...(lanePackKey ? [`pack:${lanePackKey}:${laneExport?.level ?? laneExportLevel}`] : []),
        ...(packDeltaDigest ? ["delta_digest"] : []),
        ...(missionHandoffIds.length ? ["mission_handoffs"] : []),
        ...(missionHandoffDigest ? ["mission_handoff_digest"] : []),
        `docs:${args.contextProfile.docsMode}`
      ],
      docsMode: args.contextProfile.docsMode === "full_docs" ? "full_body" : "digest_ref",
      docsBudgetBytes: args.contextProfile.maxDocBytes,
      docsConsumedBytes,
      docsTruncatedCount
    };

    const contextPressure =
      (cursor.docsConsumedBytes ?? 0)
        / Math.max(1, cursor.docsBudgetBytes ?? args.contextProfile.maxDocBytes ?? 120_000);
    if (contextPressure >= runtimeConfig.contextPressureThreshold) {
      appendTimelineEvent({
        runId: args.run.id,
        stepId: args.step.id,
        attemptId: args.attemptId,
        eventType: "context_pressure_warning",
        reason: "context_threshold_reached",
        detail: {
          pressure: contextPressure,
          threshold: runtimeConfig.contextPressureThreshold,
          docsConsumedBytes: cursor.docsConsumedBytes ?? 0,
          docsBudgetBytes: cursor.docsBudgetBytes ?? 0,
          handoffIds: missionHandoffIds.length,
          summarizedHandoffs: missionHandoffDigest?.summarizedCount ?? 0
        }
      });
    }
    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attemptId,
      eventType: "context_pack_v2_metrics",
      reason:
        controlPackV2.truncated || executionPackV2.truncated || deepPackV2.truncated
          ? "pack_v2_truncated"
          : "pack_v2_within_budget",
      detail: {
        control: {
          consumedBytes: controlPackV2.consumedBytes,
          budgetBytes: controlPackV2.budgetBytes,
          truncated: controlPackV2.truncated
        },
        execution: {
          consumedBytes: executionPackV2.consumedBytes,
          budgetBytes: executionPackV2.budgetBytes,
          truncated: executionPackV2.truncated
        },
        deep: {
          consumedBytes: deepPackV2.consumedBytes,
          budgetBytes: deepPackV2.budgetBytes,
          truncated: deepPackV2.truncated
        }
      }
    });

    const snapshotId = randomUUID();
    const createdAt = nowIso();
    db.run(
      `
        insert into orchestrator_context_snapshots(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          snapshot_type,
          context_profile,
          cursor_json,
          created_at
        ) values (?, ?, ?, ?, ?, 'attempt', ?, ?, ?)
      `,
      [
        snapshotId,
        projectId,
        args.run.id,
        args.step.id,
        args.attemptId,
        args.contextProfile.id,
        JSON.stringify(cursor),
        createdAt
      ]
    );
    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attemptId,
      eventType: "context_snapshot_created",
      reason: "attempt_context_resolved",
      detail: {
        snapshotId,
        docsMode: cursor.docsMode,
        docsCount: docsRefs.length,
        docsTruncatedCount,
        stepType,
        hasDeltaDigest: Boolean(packDeltaDigest),
        handoffCount: missionHandoffIds.length
      }
    });

    const runtimeCursorPayload = {
      runtimeCursor: {
        ...cursor,
        packDeltaSince: createdAt
      }
    };
    const currentMetadata = args.run.metadata ?? {};
    db.run(
      `
        update orchestrator_runs
        set runtime_cursor_json = ?,
            metadata_json = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [
        JSON.stringify(runtimeCursorPayload.runtimeCursor),
        JSON.stringify({
          ...currentMetadata,
          ...runtimeCursorPayload
        }),
        createdAt,
        args.run.id,
        projectId
      ]
    );

    return {
      snapshotId,
      cursor,
      laneExport,
      projectExport,
      docsRefs,
      fullDocs
    };
  };

  const tryRunConflictResolverChain = async (args: {
    run: OrchestratorRun;
    step: OrchestratorStep;
    attempt: OrchestratorAttempt;
  }): Promise<
    | {
        status: "succeeded" | "blocked" | "failed";
        result?: OrchestratorAttemptResultEnvelope;
        errorClass?: OrchestratorErrorClass;
        errorMessage?: string;
        metadata?: Record<string, unknown> | null;
      }
    | null
  > => {
    const metadata = args.step.metadata ?? {};
    const integrationConfig =
      metadata.integration && typeof metadata.integration === "object" && !Array.isArray(metadata.integration)
        ? (metadata.integration as Record<string, unknown>)
        : metadata;
    const isMergeFlowStep =
      integrationConfig.integrationFlow === true
      || integrationConfig.requiresConflictResolver === true
      || integrationConfig.stepType === "merge";
    if (!isMergeFlowStep) return null;

    const targetLaneId =
      typeof integrationConfig.targetLaneId === "string" && integrationConfig.targetLaneId.trim().length
        ? integrationConfig.targetLaneId.trim()
        : "";
    const sourceLaneIds = Array.isArray(integrationConfig.sourceLaneIds)
      ? integrationConfig.sourceLaneIds.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
    if (!targetLaneId || sourceLaneIds.length === 0) {
      return {
        status: "blocked",
        errorClass: "policy",
        errorMessage: "Integration step is missing targetLaneId/sourceLaneIds metadata.",
        metadata: {
          integrationConfigInvalid: true
        }
      };
    }
    if (!conflictService) {
      return {
        status: "blocked",
        errorClass: "policy",
        errorMessage: "Conflict service is unavailable for integration step execution."
      };
    }

    const externalProvider: ExternalConflictResolverProvider =
      integrationConfig.externalProvider === "claude" ? "claude" : "codex";
    const scenario: PrepareResolverSessionArgs["scenario"] =
      sourceLaneIds.length > 1
        ? "integration-merge"
        : (integrationConfig.scenario as PrepareResolverSessionArgs["scenario"] | undefined) ?? "single-merge";
    const integrationLaneName =
      typeof integrationConfig.integrationLaneName === "string" ? integrationConfig.integrationLaneName : undefined;
    const allowSubscriptionFallback = integrationConfig.allowSubscriptionFallback === true || integrationConfig.allowLegacyFallback === true;

    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attempt.id,
      eventType: "integration_chain_started",
      reason: "external_cli_first",
      detail: {
        targetLaneId,
        sourceLaneIds,
        externalProvider,
        scenario,
        allowSubscriptionFallback
      }
    });

    const prepared = await conflictService.prepareResolverSession({
      provider: externalProvider,
      targetLaneId,
      sourceLaneIds,
      integrationLaneName,
      scenario
    });
    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attempt.id,
      eventType: "integration_chain_stage",
      reason: "external_cli_prepare_completed",
      detail: {
        status: prepared.status,
        runId: prepared.runId,
        integrationLaneId: prepared.integrationLaneId,
        contextGaps: prepared.contextGaps
      }
    });

    if (prepared.status === "ready") {
      return {
        status: "blocked",
        errorClass: "policy",
        errorMessage: "External resolver session prepared. Operator action required to run CLI resolver.",
        result: normalizeEnvelope({
          success: false,
          summary: "External CLI resolver is prepared and awaiting operator execution.",
          outputs: {
            resolverRunId: prepared.runId,
            promptFilePath: prepared.promptFilePath,
            cwdWorktreePath: prepared.cwdWorktreePath,
            cwdLaneId: prepared.cwdLaneId,
            integrationLaneId: prepared.integrationLaneId
          },
          warnings: prepared.warnings,
          trackedSession: true
        }),
        metadata: {
          integrationStage: "external_cli_ready",
          externalProvider,
          resolverRunId: prepared.runId
        }
      };
    }

    if (allowSubscriptionFallback && sourceLaneIds.length === 1) {
      try {
        const preview: ConflictProposalPreview = await conflictService.prepareProposal({
          laneId: sourceLaneIds[0]!,
          peerLaneId: targetLaneId
        });
        const proposal: ConflictProposal = await conflictService.requestProposal({
          laneId: sourceLaneIds[0]!,
          peerLaneId: targetLaneId,
          contextDigest: preview.contextDigest
        });
        appendTimelineEvent({
          runId: args.run.id,
          stepId: args.step.id,
          attemptId: args.attempt.id,
          eventType: "integration_chain_stage",
          reason: "subscription_fallback_completed",
          detail: {
            proposalId: proposal.id,
            source: proposal.source
          }
        });
        return {
          status: "succeeded",
          result: normalizeEnvelope({
            success: true,
            summary: "Subscription fallback generated a deterministic conflict proposal.",
            outputs: {
              proposalId: proposal.id,
              confidence: proposal.confidence,
              source: proposal.source
            },
            warnings: [],
            trackedSession: true
          }),
          metadata: {
            integrationStage: "subscription_fallback",
            proposalId: proposal.id,
            proposalSource: proposal.source
          }
        };
      } catch (error) {
        appendTimelineEvent({
          runId: args.run.id,
          stepId: args.step.id,
          attemptId: args.attempt.id,
          eventType: "integration_chain_stage",
          reason: "subscription_fallback_failed",
          detail: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }

    appendTimelineEvent({
      runId: args.run.id,
      stepId: args.step.id,
      attemptId: args.attempt.id,
      eventType: "integration_chain_stage",
      reason: "manual_intervention_required",
      detail: {
        targetLaneId,
        sourceLaneIds
      }
    });
    return {
      status: "blocked",
      errorClass: "policy",
      errorMessage: "Integration resolver chain reached intervention stage.",
      metadata: {
        integrationStage: "intervention_required",
        targetLaneId,
        sourceLaneIds
      }
    };
  };

  const defaultAdapterFor = (kind: OrchestratorExecutorKind): OrchestratorExecutorAdapter | null => {
    if (kind !== "claude" && kind !== "codex") return null;
    return {
      kind,
      start: async (args) => {
        if (!args.step.laneId) {
          return {
            status: "failed",
            errorClass: "policy",
            errorMessage: "Executor scaffolds require step.laneId to create tracked sessions."
          };
        }
        const title = `[orchestrator:${kind}] ${args.step.title}`;
        try {
          const contextDir = path.join(projectRoot, ".ade", "orchestrator", "contexts", args.run.id);
          fs.mkdirSync(contextDir, { recursive: true });
          const contextFilePath = path.join(contextDir, `${args.attempt.id}.json`);
          const contextManifest = {
            schema: "ade.orchestratorWorkerContext.v1",
            mission: {
              missionId: args.run.missionId,
              runId: args.run.id,
              stepId: args.step.id,
              attemptId: args.attempt.id,
              stepKey: args.step.stepKey,
              title: args.step.title,
              joinPolicy: args.step.joinPolicy,
              dependencyStepIds: args.step.dependencyStepIds
            },
            contextProfile: args.contextProfile.id,
            packs: {
              lane: args.laneExport
                ? {
                    packKey: args.laneExport.packKey,
                    level: args.laneExport.level,
                    approxTokens: args.laneExport.approxTokens,
                    contentPreview: clipText(args.laneExport.content, 3_000)
                  }
                : null,
              project: {
                packKey: args.projectExport.packKey,
                level: args.projectExport.level,
                approxTokens: args.projectExport.approxTokens,
                contentPreview: clipText(args.projectExport.content, 2_000)
              }
            },
            docs: args.docsRefs.slice(0, 24),
            fullDocsPreview: args.fullDocs.slice(0, 3).map((entry) => ({
              path: entry.path,
              truncated: entry.truncated,
              contentPreview: clipText(entry.content, 1_200)
            })),
            generatedAt: nowIso()
          };
          fs.writeFileSync(contextFilePath, `${JSON.stringify(contextManifest, null, 2)}\n`, "utf8");

          const requiresPlanApproval =
            args.step.metadata?.requiresPlanApproval === true || args.step.metadata?.coordinationPattern === "plan_then_implement";
          const promptParts = [
            `You are an ADE mission worker for step "${args.step.title}".`,
            requiresPlanApproval
              ? "Work in planning mode only. Do not mutate files. Return a concise implementation plan and risk notes."
              : "Implement the step with focused, minimal edits and run the relevant validation commands.",
            `Load full context from: ${contextFilePath}`,
            "Keep output concise and structured for orchestrator ingestion."
          ];
          const prompt = promptParts.join("\n");

          const commandParts: string[] = [kind];
          const model = typeof args.step.metadata?.model === "string" ? args.step.metadata.model.trim() : "";
          if (model) {
            commandParts.push("--model", shellEscapeArg(model));
          }
          if (kind === "codex") {
            commandParts.push("--sandbox", requiresPlanApproval ? "read-only" : "workspace-write");
          } else {
            commandParts.push("--permission-mode", requiresPlanApproval ? "plan" : "acceptEdits");
          }
          commandParts.push(shellEscapeArg(prompt));
          const startupCommand = commandParts.join(" ");

          const session = await args.createTrackedSession({
            laneId: args.step.laneId,
            cols: 120,
            rows: 36,
            title,
            toolType: `${kind}-orchestrated`,
            startupCommand
          });
          return {
            status: "accepted",
            sessionId: session.sessionId,
            metadata: {
              adapterKind: kind,
              adapterState: "worker_spawned",
              contextFilePath,
              contextDigest: sha256(JSON.stringify(contextManifest)),
              planMode: requiresPlanApproval,
              startupCommandPreview: startupCommand.slice(0, 320),
              localFirst: true
            }
          };
        } catch (error) {
          return {
            status: "failed",
            errorClass: "executor_failure",
            errorMessage: error instanceof Error ? error.message : String(error),
            metadata: {
              adapterKind: kind,
              adapterState: "scaffold_start_failed"
            }
          };
        }
      }
    };
  };

  return {
    getContextProfile(profileId: OrchestratorContextProfileId): OrchestratorContextPolicyProfile {
      return CONTEXT_PROFILES[profileId] ?? CONTEXT_PROFILES[DEFAULT_CONTEXT_PROFILE_ID];
    },

    listContextProfiles(): OrchestratorContextPolicyProfile[] {
      return [CONTEXT_PROFILES.orchestrator_deterministic_v1, CONTEXT_PROFILES.orchestrator_narrative_opt_in_v1];
    },

    registerExecutorAdapter(adapter: OrchestratorExecutorAdapter) {
      adapters.set(adapter.kind, adapter);
    },

    unregisterExecutorAdapter(kind: OrchestratorExecutorKind) {
      adapters.delete(kind);
    },

    async createOrchestratedSession(
      args: Omit<PtyCreateArgs, "tracked"> & { tracked?: boolean }
    ): Promise<{ ptyId: string; sessionId: string }> {
      if (!ptyService) throw new Error("PTY service unavailable for orchestrator execution.");
      if (args.tracked === false) {
        throw new Error("Orchestrated execution requires tracked=true sessions.");
      }
      return ptyService.create({
        ...args,
        tracked: true
      });
    },

    listRuns(args: { status?: OrchestratorRunStatus; missionId?: string; limit?: number } = {}): OrchestratorRun[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.status) {
        where.push("status = ?");
        params.push(args.status);
      }
      if (args.missionId) {
        where.push("mission_id = ?");
        params.push(args.missionId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 100))) : 100;
      const rows = db.all<RunRow>(
        `
          select
            id,
            mission_id,
            project_id,
            status,
            context_profile,
            scheduler_state,
            runtime_cursor_json,
            last_error,
            metadata_json,
            created_at,
            updated_at,
            started_at,
            completed_at
          from orchestrator_runs
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toRun);
    },

    listSteps(runId: string): OrchestratorStep[] {
      return listStepRows(runId).map(toStep);
    },

    listAttempts(args: { runId?: string; limit?: number } = {}): OrchestratorAttempt[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<AttemptRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          from orchestrator_attempts
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toAttempt);
    },

    listClaims(args: { runId?: string; state?: OrchestratorClaimState; limit?: number } = {}): OrchestratorClaim[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      if (args.state) {
        where.push("state = ?");
        params.push(args.state);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where ${where.join(" and ")}
          order by acquired_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toClaim);
    },

    listContextSnapshots(args: { runId?: string; limit?: number } = {}): OrchestratorContextSnapshot[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<ContextSnapshotRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            snapshot_type,
            context_profile,
            cursor_json,
            created_at
          from orchestrator_context_snapshots
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toContextSnapshot);
    },

    listHandoffs(args: { missionId?: string; runId?: string; limit?: number } = {}): MissionStepHandoff[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.missionId) {
        where.push("mission_id = ?");
        params.push(args.missionId);
      }
      if (args.runId) {
        where.push("run_id = ?");
        params.push(args.runId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 200))) : 200;
      const rows = db.all<HandoffRow>(
        `
          select
            id,
            mission_id,
            mission_step_id,
            run_id,
            step_id,
            attempt_id,
            handoff_type,
            producer,
            payload_json,
            created_at
          from mission_step_handoffs
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map(toHandoff);
    },

    listTimeline(args: { runId: string; limit?: number }): OrchestratorTimelineEvent[] {
      return listTimelineRows(args).map(toTimelineEvent);
    },

    appendRuntimeEvent(args: {
      runId: string;
      stepId?: string | null;
      attemptId?: string | null;
      sessionId?: string | null;
      eventType: OrchestratorRuntimeEventType;
      eventKey?: string | null;
      occurredAt?: string | null;
      payload?: Record<string, unknown> | null;
    }): OrchestratorRuntimeBusEvent {
      return persistRuntimeEvent(args);
    },

    listRuntimeEvents(args: {
      runId?: string;
      attemptId?: string;
      sessionId?: string;
      eventTypes?: OrchestratorRuntimeEventType[];
      since?: string | null;
      limit?: number;
    } = {}): OrchestratorRuntimeBusEvent[] {
      return listRuntimeEventRows(args).map(toRuntimeEvent);
    },

    getRunGraph(args: { runId: string; timelineLimit?: number }): OrchestratorRunGraph {
      const runRow = getRunRow(args.runId);
      if (!runRow) throw new Error(`Run not found: ${args.runId}`);
      return {
        run: toRun(runRow),
        steps: listStepRows(args.runId).map(toStep),
        attempts: listAttemptRows(args.runId).map(toAttempt),
        claims: this.listClaims({ runId: args.runId, limit: 1_000 }),
        contextSnapshots: this.listContextSnapshots({ runId: args.runId, limit: 1_000 }),
        handoffs: this.listHandoffs({ runId: args.runId, limit: 1_000 }),
        timeline: this.listTimeline({ runId: args.runId, limit: args.timelineLimit ?? 300 }),
        runtimeEvents: this.listRuntimeEvents({ runId: args.runId, limit: 1_000 })
      };
    },

    startRunFromMission(args: {
      missionId: string;
      runId?: string;
      contextProfile?: OrchestratorContextProfileId;
      schedulerState?: string;
      metadata?: Record<string, unknown> | null;
      runMode?: "autopilot" | "manual";
      autopilotOwnerId?: string;
      defaultExecutorKind?: OrchestratorExecutorKind;
      defaultRetryLimit?: number;
    }): { run: OrchestratorRun; steps: OrchestratorStep[] } {
      const missionId = String(args.missionId ?? "").trim();
      if (!missionId) throw new Error("missionId is required.");
      const mission = db.get<{ id: string; prompt: string | null; lane_id: string | null; metadata_json: string | null }>(
        `
          select id, prompt, lane_id, metadata_json
          from missions
          where id = ?
            and project_id = ?
          limit 1
        `,
        [missionId, projectId]
      );
      if (!mission?.id) throw new Error(`Mission not found: ${missionId}`);
      const runtimeConfig = getRuntimeConfig();
      const missionSteps = db.all<{
        id: string;
        step_index: number;
        title: string;
        detail: string | null;
        kind: string;
        lane_id: string | null;
        metadata_json: string | null;
      }>(
        `
          select id, step_index, title, detail, kind, lane_id, metadata_json
          from mission_steps
          where mission_id = ?
            and project_id = ?
          order by step_index asc, created_at asc
        `,
        [missionId, projectId]
      );
      const requestedRunMode = args.runMode === "manual" ? "manual" : "autopilot";
      const requestedExecutor = normalizeExecutorKind(String(args.defaultExecutorKind ?? "codex"));
      const fallbackExecutor = requestedRunMode === "manual" ? "manual" : requestedExecutor === "manual" ? "codex" : requestedExecutor;
      const autopilotEnabled = requestedRunMode === "autopilot" && fallbackExecutor !== "manual";
      const autopilotOwnerId = String(args.autopilotOwnerId ?? "").trim() || "orchestrator-autopilot";
      const missionMetadata = parseRecord(mission.metadata_json) ?? {};
      const plannerSummary = asRecord(asRecord(missionMetadata.plannerPlan)?.missionSummary);
      const plannerParallelismRaw = Number(
        args.metadata?.plannerParallelismCap ?? plannerSummary?.parallelismCap ?? Number.NaN
      );
      const plannerParallelismCap =
        Number.isFinite(plannerParallelismRaw) && plannerParallelismRaw > 0 ? Math.floor(plannerParallelismRaw) : null;
      const autopilotParallelismCap = Math.max(
        1,
        Math.min(runtimeConfig.maxParallelWorkers, plannerParallelismCap ?? runtimeConfig.maxParallelWorkers)
      );

      const descriptors = missionSteps.map((row, index) => {
        const metadata = parseRecord(row.metadata_json) ?? {};
        const stepIndex = Number.isFinite(Number(row.step_index)) ? Number(row.step_index) : index;
        const explicitKey = typeof metadata.stepKey === "string" ? metadata.stepKey.trim() : "";
        const stepKey = explicitKey.length ? explicitKey : `mission_step_${stepIndex}_${index}`;
        return {
          row,
          index,
          metadata,
          stepIndex,
          stepKey
        };
      });

      const stepKeysByIndex = new Map<number, string[]>();
      for (const descriptor of descriptors) {
        const bucket = stepKeysByIndex.get(descriptor.stepIndex) ?? [];
        bucket.push(descriptor.stepKey);
        stepKeysByIndex.set(descriptor.stepIndex, bucket);
      }
      const descriptorByStepKey = new Map(descriptors.map((descriptor) => [descriptor.stepKey, descriptor] as const));

      const resolveDependencyKeys = (descriptor: (typeof descriptors)[number]): string[] => {
        const hasExplicitDependencies =
          Array.isArray(descriptor.metadata.dependencyStepKeys)
          || Array.isArray(descriptor.metadata.dependencyIndices);
        const explicitKeys = Array.isArray(descriptor.metadata.dependencyStepKeys)
          ? descriptor.metadata.dependencyStepKeys
              .map((entry) => String(entry ?? "").trim())
              .filter((entry) => entry.length > 0)
          : [];
        const indexedKeys = parseNumericDependencyIndices(descriptor.metadata).flatMap((depIndex) => stepKeysByIndex.get(depIndex) ?? []);
        const joined = [...explicitKeys, ...indexedKeys];
        const deduped = [...new Set(joined.filter((key) => key !== descriptor.stepKey))];
        if (deduped.length) return deduped;
        if (hasExplicitDependencies) return [];
        if (descriptor.index > 0) {
          return [descriptors[descriptor.index - 1]!.stepKey];
        }
        return [];
      };

      const normalized: StartOrchestratorRunStepInput[] = descriptors.map((descriptor) => {
        const { row, metadata } = descriptor;
        const explicitExecutor =
          typeof metadata.executorKind === "string" ? normalizeExecutorKind(metadata.executorKind) : fallbackExecutor;
        const retryLimitRaw = Number(metadata.retryLimit);
        const configuredRetryLimit = Number(args.defaultRetryLimit ?? runtimeConfig.maxRetriesPerStep);
        const retryLimit = Number.isFinite(retryLimitRaw)
          ? Math.max(0, Math.floor(retryLimitRaw))
          : Math.max(0, Math.floor(configuredRetryLimit));
        const joinPolicy =
          typeof metadata.joinPolicy === "string" ? normalizeJoinPolicy(String(metadata.joinPolicy)) : "all_success";
        const quorumRaw = Number(metadata.quorumCount);
        const quorumCount = Number.isFinite(quorumRaw) && quorumRaw > 0 ? Math.floor(quorumRaw) : undefined;
        const dependencyStepKeys = resolveDependencyKeys(descriptor);
        const stepType = String(metadata.stepType ?? row.kind ?? "").trim() || "manual";
        const integrationHints = (() => {
          if (stepType !== "integration" && stepType !== "merge") {
            return {
              targetLaneId: null as string | null,
              sourceLaneIds: [] as string[]
            };
          }
          const existingTarget = typeof metadata.targetLaneId === "string" ? metadata.targetLaneId.trim() : "";
          const targetLaneId =
            existingTarget.length > 0
              ? existingTarget
              : typeof row.lane_id === "string" && row.lane_id.trim().length > 0
                ? row.lane_id.trim()
                : typeof mission.lane_id === "string" && mission.lane_id.trim().length > 0
                  ? mission.lane_id.trim()
                  : null;
          const explicitSourceLaneIds = Array.isArray(metadata.sourceLaneIds)
            ? metadata.sourceLaneIds
                .map((entry) => String(entry ?? "").trim())
                .filter((entry) => entry.length > 0)
            : [];
          if (explicitSourceLaneIds.length > 0) {
            return {
              targetLaneId,
              sourceLaneIds: [...new Set(explicitSourceLaneIds.filter((entry) => entry !== targetLaneId))]
            };
          }
          const derivedSourceLaneIds = dependencyStepKeys
            .map((depKey) => {
              const depDescriptor = descriptorByStepKey.get(depKey);
              const depLaneId = depDescriptor?.row?.lane_id;
              return typeof depLaneId === "string" ? depLaneId.trim() : "";
            })
            .filter((laneId) => laneId.length > 0 && laneId !== targetLaneId);
          return {
            targetLaneId,
            sourceLaneIds: [...new Set(derivedSourceLaneIds)]
          };
        })();
        const inferredPattern =
          joinPolicy === "any_success"
            ? "speculative_parallel"
            : dependencyStepKeys.length > 1
              ? "fan_in_merge"
              : stepType === "analysis"
                ? "plan_then_implement"
                : stepType === "review"
                  ? "review_and_revise"
                  : dependencyStepKeys.length === 0 && requestedRunMode === "autopilot"
                    ? "parallel_fan_out"
                    : "sequential_chain";
        const stepInstructions =
          typeof metadata.instructions === "string" && metadata.instructions.trim().length
            ? metadata.instructions.trim()
            : typeof row.detail === "string" && row.detail.trim().length
              ? row.detail.trim()
              : "";
        const requiresPlanApproval =
          metadata.requiresPlanApproval === true
          || inferredPattern === "plan_then_implement"
          || stepType === "analysis";
        const mergedMetadata: Record<string, unknown> = {
          ...metadata,
          instructions: stepInstructions,
          stepType,
          requiresPlanApproval,
          coordinationPattern: metadata.coordinationPattern ?? inferredPattern
        };
        if (
          (stepType === "integration" || stepType === "merge")
          && integrationHints.targetLaneId
          && typeof mergedMetadata.targetLaneId !== "string"
        ) {
          mergedMetadata.targetLaneId = integrationHints.targetLaneId;
        }
        if (
          (stepType === "integration" || stepType === "merge")
          && integrationHints.sourceLaneIds.length > 0
          && !Array.isArray(mergedMetadata.sourceLaneIds)
        ) {
          mergedMetadata.sourceLaneIds = integrationHints.sourceLaneIds;
        }
        return {
          missionStepId: row.id,
          stepKey: descriptor.stepKey,
          title: row.title,
          stepIndex: descriptor.stepIndex,
          laneId: row.lane_id,
          dependencyStepKeys,
          joinPolicy,
          quorumCount,
          retryLimit,
          executorKind: explicitExecutor,
          policy: parseStepPolicyFromMetadata(metadata),
          metadata: mergedMetadata
        };
      });

      if (!normalized.length) {
        normalized.push({
          stepKey: "mission_step_0_0",
          title: "Execute mission objective",
          stepIndex: 0,
          laneId: null,
          retryLimit: Math.max(0, Math.floor(args.defaultRetryLimit ?? runtimeConfig.maxRetriesPerStep)),
          executorKind: fallbackExecutor,
          metadata: {
            stepType: "manual",
            missionPrompt: mission.prompt ?? "",
            requiresPlanApproval: false,
            coordinationPattern: "sequential_chain"
          }
        });
      }

      const plannerMetadata = descriptors
        .map((descriptor) => descriptor.metadata?.planner)
        .find((planner) => planner && typeof planner === "object" && !Array.isArray(planner)) as Record<string, unknown> | undefined;

      const coordinationPatterns = normalized.reduce<Record<string, number>>((acc, stepInput) => {
        const key =
          stepInput.metadata && typeof stepInput.metadata.coordinationPattern === "string"
            ? stepInput.metadata.coordinationPattern
            : "sequential_chain";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});

      const started = this.startRun({
        missionId,
        runId: args.runId,
        contextProfile: args.contextProfile,
        schedulerState: args.schedulerState,
        metadata: {
          ...(args.metadata ?? {}),
          missionGoal: mission.prompt ?? "",
          missionPrompt: mission.prompt ?? "",
          runMode: requestedRunMode,
          planner: {
            source: "mission_steps",
            stepCount: normalized.length,
            strategy: typeof plannerMetadata?.strategy === "string" ? plannerMetadata.strategy : null,
            version: typeof plannerMetadata?.version === "string" ? plannerMetadata.version : null,
            parallelismCap: autopilotParallelismCap
          },
          coordination: {
            patterns: coordinationPatterns
          },
	          orchestratorConfig: {
	            maxParallelWorkers: runtimeConfig.maxParallelWorkers,
	            contextPressureThreshold: runtimeConfig.contextPressureThreshold,
	            progressiveLoading: runtimeConfig.progressiveLoading,
	            fileReservationGuardMode: runtimeConfig.fileReservationGuardMode
	          },
          autopilot: {
            enabled: autopilotEnabled,
            executorKind: autopilotEnabled ? fallbackExecutor : "manual",
            ownerId: autopilotOwnerId,
            parallelismCap: autopilotParallelismCap
          }
        },
        steps: normalized
      });

      if (autopilotEnabled) {
        void this
          .startReadyAutopilotAttempts({
            runId: started.run.id,
            reason: "run_started"
          })
          .catch(() => {});
      }

      return started;
    },

    async startReadyAutopilotAttempts(args: { runId: string; reason?: string }): Promise<number> {
      const runId = String(args.runId ?? "").trim();
      if (!runId.length) return 0;
      if (autopilotRunLocks.has(runId)) return 0;

      autopilotRunLocks.add(runId);
      try {
        const runRow = getRunRow(runId);
        if (!runRow) return 0;
        const run = toRun(runRow);
        if (TERMINAL_RUN_STATUSES.has(run.status)) return 0;

        const autopilot = parseAutopilotConfig(run.metadata);
        if (!autopilot.enabled) return 0;
        const parallelismCap = Math.max(1, autopilot.parallelismCap);

        let startedAttempts = 0;
        let loops = 0;
        while (loops < 12) {
          loops += 1;
          this.tick({ runId });
          let runningAttemptCount = listAttemptRows(runId)
            .map(toAttempt)
            .filter((attempt) => attempt.status === "running").length;
          if (runningAttemptCount >= parallelismCap) break;

          const runSteps = listStepRows(runId).map(toStep);
          const depthById = buildStepDepthMap(runSteps);
          const hashByStepId = new Map<string, string>();
          for (const step of runSteps) {
            hashByStepId.set(step.id, createHash("sha256").update(step.stepKey).digest("hex"));
          }
          const readySteps = listStepRows(runId)
            .map(toStep)
            .filter((step) => step.status === "ready")
            .sort(stableStepOrderComparator({ depthById, hashByStepId }));
          if (!readySteps.length) break;

          let startedInLoop = 0;
          for (const step of readySteps) {
            if (runningAttemptCount >= parallelismCap) break;
            const fresh = getStepRow(step.id);
            if (!fresh) continue;
            if (toStep(fresh).status !== "ready") continue;
            try {
              await this.startAttempt({
                runId,
                stepId: step.id,
                ownerId: autopilot.ownerId,
                executorKind: autopilot.executorKind
              });
              startedAttempts += 1;
              startedInLoop += 1;
              runningAttemptCount += 1;
            } catch (error) {
              appendTimelineEvent({
                runId,
                stepId: step.id,
                eventType: "autopilot_attempt_start_failed",
                reason: "autopilot_start_failed",
                detail: {
                  message: error instanceof Error ? error.message : String(error)
                }
              });
            }
          }
          if (startedInLoop === 0) break;
        }

        if (startedAttempts > 0) {
          appendTimelineEvent({
            runId,
            eventType: "autopilot_advance",
            reason: args.reason ?? "autopilot_advance",
            detail: {
              startedAttempts,
              executorKind: autopilot.executorKind,
              parallelismCap
            }
          });
        }

        this.tick({ runId });
        return startedAttempts;
      } finally {
        autopilotRunLocks.delete(runId);
      }
    },

    async onTrackedSessionEnded(args: { sessionId: string; laneId?: string | null; exitCode: number | null }): Promise<number> {
      const sessionId = String(args.sessionId ?? "").trim();
      if (!sessionId.length) return 0;
      const sessionRow = db.get<{ status: string | null; exit_code: number | null }>(
        `
          select status, exit_code
          from terminal_sessions
          where id = ?
          limit 1
        `,
        [sessionId]
      );
      const sessionStatus = normalizeTerminalSessionStatus(sessionRow?.status);
      const resolvedExitCode = (() => {
        const fromArgs = Number(args.exitCode);
        if (Number.isFinite(fromArgs)) return Math.floor(fromArgs);
        const fromRow = Number(sessionRow?.exit_code);
        if (Number.isFinite(fromRow)) return Math.floor(fromRow);
        return null;
      })();
      const runningAttempts = db.all<AttemptRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          from orchestrator_attempts
          where project_id = ?
            and executor_session_id = ?
            and status = 'running'
          order by created_at asc
        `,
        [projectId, sessionId]
      );
      if (!runningAttempts.length) return 0;

      const completion = (() => {
        if (resolvedExitCode != null) {
          if (resolvedExitCode === 0) {
            return {
              status: "succeeded" as const,
              errorClass: null,
              errorMessage: null
            };
          }
          return {
            status: "failed" as const,
            errorClass: "executor_failure" as const,
            errorMessage: `Tracked session exited with code ${resolvedExitCode}.`
          };
        }
        if (sessionStatus === "completed") {
          return {
            status: "succeeded" as const,
            errorClass: null,
            errorMessage: null
          };
        }
        if (sessionStatus === "disposed") {
          return {
            status: "canceled" as const,
            errorClass: "canceled" as const,
            errorMessage: "Tracked session was disposed before completion."
          };
        }
        return {
          status: "failed" as const,
          errorClass: "executor_failure" as const,
          errorMessage:
            sessionStatus === "failed"
              ? "Tracked session reported failed status."
              : "Tracked session ended unexpectedly without an exit code."
        };
      })();

      const touchedRunIds = new Set<string>();
      for (const attempt of runningAttempts) {
        touchedRunIds.add(attempt.run_id);
        persistRuntimeEvent({
          runId: attempt.run_id,
          stepId: attempt.step_id,
          attemptId: attempt.id,
          sessionId,
          eventType: "session_ended",
          eventKey: `session_ended:${attempt.id}:${sessionId}:${sessionStatus}:${resolvedExitCode ?? "none"}`,
          payload: {
            sessionStatus,
            exitCode: resolvedExitCode
          }
        });
        this.completeAttempt({
          attemptId: attempt.id,
          status: completion.status,
          ...(completion.errorClass
            ? {
                errorClass: completion.errorClass,
                errorMessage: completion.errorMessage
              }
            : {}),
          metadata: {
            reconciledFromTrackedSession: true,
            trackedSessionId: sessionId,
            laneId: args.laneId ?? null,
            exitCode: resolvedExitCode,
            sessionStatus
          }
        });
      }

      for (const runId of touchedRunIds) {
        await this.startReadyAutopilotAttempts({
          runId,
          reason: "session_ended"
        });
      }

      return runningAttempts.length;
    },

    evaluateGateReport(): OrchestratorGateReport {
      const now = Date.now();
      const gateEntries: OrchestratorGateEntry[] = [];
      const notes: string[] = [];

      const pipelineRows = db.all<{
        session_id: string;
        lane_id: string;
        ended_at: string | null;
        delta_at: string | null;
        checkpoint_at: string | null;
        lane_pack_at: string | null;
      }>(
        `
          select
            s.id as session_id,
            s.lane_id as lane_id,
            s.ended_at as ended_at,
            (
              select d.computed_at
              from session_deltas d
              where d.project_id = ?
                and d.session_id = s.id
              order by d.computed_at desc
              limit 1
            ) as delta_at,
            (
              select c.created_at
              from checkpoints c
              where c.project_id = ?
                and c.session_id = s.id
              order by c.created_at desc
              limit 1
            ) as checkpoint_at,
            (
              select p.deterministic_updated_at
              from packs_index p
              where p.project_id = ?
                and p.pack_key = ('lane:' || s.lane_id)
              limit 1
            ) as lane_pack_at
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          where l.project_id = ?
            and s.tracked = 1
            and s.ended_at is not null
          order by s.ended_at desc
          limit 400
        `,
        [projectId, projectId, projectId, projectId]
      );
      const pipelineSamples = pipelineRows
        .map((row) => {
          const endedAt = row.ended_at ? Date.parse(row.ended_at) : NaN;
          const packAt = row.lane_pack_at ? Date.parse(row.lane_pack_at) : NaN;
          if (!Number.isFinite(endedAt) || !Number.isFinite(packAt)) return null;
          return Math.max(0, packAt - endedAt);
        })
        .filter((value): value is number => Number.isFinite(value));
      const pipelineWithin = pipelineSamples.filter((value) => value <= GATE_THRESHOLDS.maxTrackedPipelineLatencyMs).length;
      const pipelineRate = pipelineSamples.length > 0 ? pipelineWithin / pipelineSamples.length : 0;
      const averagePipelineLatency =
        pipelineSamples.length > 0 ? Math.round(pipelineSamples.reduce((sum, value) => sum + value, 0) / pipelineSamples.length) : 0;
      gateEntries.push({
        key: "session_delta_checkpoint_pack_latency",
        label: "Tracked session -> delta -> checkpoint -> lane pack latency",
        status:
          pipelineSamples.length === 0
            ? "warn"
            : averagePipelineLatency <= GATE_THRESHOLDS.maxTrackedPipelineLatencyMs
              ? "pass"
              : "fail",
        measuredValue: averagePipelineLatency,
        threshold: GATE_THRESHOLDS.maxTrackedPipelineLatencyMs,
        comparator: "<=",
        samples: pipelineSamples.length,
        reasons:
          pipelineSamples.length === 0
            ? ["No tracked session pipeline samples were available."]
            : averagePipelineLatency <= GATE_THRESHOLDS.maxTrackedPipelineLatencyMs
              ? []
              : [`Average latency ${averagePipelineLatency}ms exceeded threshold (${GATE_THRESHOLDS.maxTrackedPipelineLatencyMs}ms).`],
        metadata: {
          withinBudgetRate: pipelineSamples.length > 0 ? pipelineRate : 0
        }
      });

      const packRows = db.all<{ pack_type: string; deterministic_updated_at: string | null }>(
        `
          select pack_type, deterministic_updated_at
          from packs_index
          where project_id = ?
        `,
        [projectId]
      );
      const freshCount = packRows.filter((row) => {
        const updatedAt = row.deterministic_updated_at ? Date.parse(row.deterministic_updated_at) : NaN;
        if (!Number.isFinite(updatedAt)) return false;
        const maxAge = GATE_THRESHOLDS.freshnessMaxAgeByPackTypeMs[row.pack_type] ?? GATE_THRESHOLDS.freshnessMaxAgeByPackTypeMs.project;
        return now - updatedAt <= maxAge;
      }).length;
      const freshnessRate = packRows.length > 0 ? freshCount / packRows.length : 0;
      gateEntries.push({
        key: "pack_freshness_by_type",
        label: "Pack freshness by type",
        status:
          packRows.length === 0
            ? "warn"
            : freshnessRate >= GATE_THRESHOLDS.minFreshnessByTypeRate
              ? "pass"
              : "fail",
        measuredValue: Number(freshnessRate.toFixed(4)),
        threshold: GATE_THRESHOLDS.minFreshnessByTypeRate,
        comparator: ">=",
        samples: packRows.length,
        reasons:
          packRows.length === 0
            ? ["No packs indexed yet."]
            : freshnessRate >= GATE_THRESHOLDS.minFreshnessByTypeRate
              ? []
              : [`Fresh packs ${freshCount}/${packRows.length} fell below threshold.`],
        metadata: {
          freshCount,
          total: packRows.length
        }
      });

      const attemptRows = db.all<{ context_snapshot_id: string | null; cursor_json: string | null; status: string }>(
        `
          select
            a.context_snapshot_id,
            a.status,
            s.cursor_json
          from orchestrator_attempts a
          left join orchestrator_context_snapshots s on s.id = a.context_snapshot_id
          where a.project_id = ?
            and a.status in ('running', 'succeeded', 'failed', 'blocked', 'canceled')
        `,
        [projectId]
      );
      const completeCount = attemptRows.filter((row) => {
        if (!row.context_snapshot_id || !row.cursor_json) return false;
        try {
          const cursor = JSON.parse(row.cursor_json) as OrchestratorContextSnapshotCursor;
          return Boolean(cursor.projectPackVersionId) && Array.isArray(cursor.docs) && cursor.docs.length > 0;
        } catch {
          return false;
        }
      }).length;
      const completenessRate = attemptRows.length > 0 ? completeCount / attemptRows.length : 0;
      gateEntries.push({
        key: "context_completeness_rate",
        label: "Context completeness rate for orchestrated steps",
        status:
          attemptRows.length === 0
            ? "warn"
            : completenessRate >= GATE_THRESHOLDS.minContextCompletenessRate
              ? "pass"
              : "fail",
        measuredValue: Number(completenessRate.toFixed(4)),
        threshold: GATE_THRESHOLDS.minContextCompletenessRate,
        comparator: ">=",
        samples: attemptRows.length,
        reasons:
          attemptRows.length === 0
            ? ["No orchestrator attempts exist yet."]
            : completenessRate >= GATE_THRESHOLDS.minContextCompletenessRate
              ? []
              : [`Only ${completeCount}/${attemptRows.length} attempts had context snapshots.`]
      });

      const runCount = Number(
        db.get<{ count: number }>("select count(*) as count from orchestrator_runs where project_id = ?", [projectId])?.count ?? 0
      );
      const insufficientRows = db.all<{
        run_id: string;
        error_message: string | null;
        metadata_json: string | null;
      }>(
        `
          select run_id, error_message, metadata_json
          from orchestrator_attempts
          where project_id = ?
            and status = 'blocked'
            and (
              error_message like '%insufficient%'
              or metadata_json like '%insufficient_context%'
              or metadata_json like '%insufficientContext%'
            )
        `,
        [projectId]
      );
      const blockedRunIds = new Set<string>();
      const reasonCodes = new Set<string>();
      for (const row of insufficientRows) {
        if (row.run_id) blockedRunIds.add(row.run_id);
        const metadata = parseRecord(row.metadata_json);
        const rawCodes = Array.isArray(metadata?.reasonCodes)
          ? (metadata?.reasonCodes as unknown[])
          : Array.isArray(metadata?.insufficientReasons)
            ? (metadata?.insufficientReasons as unknown[])
            : [];
        for (const code of rawCodes) reasonCodes.add(String(code));
        if (typeof row.error_message === "string" && row.error_message.trim().length) {
          reasonCodes.add(row.error_message.trim());
        }
      }
      const blockedRate = runCount > 0 ? blockedRunIds.size / runCount : 0;
      gateEntries.push({
        key: "blocked_run_rate_insufficient_context",
        label: "Blocked-run rate due to insufficient context",
        status: runCount === 0 ? "warn" : blockedRate <= GATE_THRESHOLDS.maxBlockedInsufficientContextRate ? "pass" : "fail",
        measuredValue: Number(blockedRate.toFixed(4)),
        threshold: GATE_THRESHOLDS.maxBlockedInsufficientContextRate,
        comparator: "<=",
        samples: runCount,
        reasons:
          runCount === 0
            ? ["No orchestrator runs exist yet."]
            : blockedRate <= GATE_THRESHOLDS.maxBlockedInsufficientContextRate
              ? []
              : [`Blocked runs ${blockedRunIds.size}/${runCount} exceeded threshold.`],
        metadata: {
          reasonCodes: [...reasonCodes]
        }
      });

      const overallStatus: OrchestratorGateStatus = gateEntries.some((entry) => entry.status === "fail")
        ? "fail"
        : gateEntries.some((entry) => entry.status === "warn")
          ? "warn"
          : "pass";
      if (overallStatus !== "pass") {
        notes.push("Phase 1.5 quality gates are not fully passing.");
      }

      const report: OrchestratorGateReport = {
        id: randomUUID(),
        generatedAt: nowIso(),
        generatedBy: "deterministic_kernel",
        overallStatus,
        gates: gateEntries,
        notes
      };
      db.run(
        `
          insert into orchestrator_gate_reports(
            id,
            project_id,
            generated_at,
            report_json
          ) values (?, ?, ?, ?)
        `,
        [report.id, projectId, report.generatedAt, JSON.stringify(report)]
      );
      return report;
    },

    getLatestGateReport(args: { refresh?: boolean } = {}): OrchestratorGateReport {
      if (args.refresh === true) {
        return this.evaluateGateReport();
      }
      const latest = db.get<GateReportRow>(
        `
          select id, generated_at, report_json
          from orchestrator_gate_reports
          where project_id = ?
          order by generated_at desc
          limit 1
        `,
        [projectId]
      );
      const parsed = latest ? toGateReport(latest) : null;
      if (parsed) return parsed;
      return this.evaluateGateReport();
    },

    startRun(args: StartOrchestratorRunArgs): { run: OrchestratorRun; steps: OrchestratorStep[] } {
      const missionId = String(args.missionId ?? "").trim();
      if (!missionId) throw new Error("missionId is required.");
      const mission = db.get<{ id: string }>(
        `
          select id
          from missions
          where id = ?
            and project_id = ?
          limit 1
        `,
        [missionId, projectId]
      );
      if (!mission?.id) throw new Error(`Mission not found: ${missionId}`);

      const runId = String(args.runId ?? "").trim() || randomUUID();
      const profileId = normalizeProfileId(args.contextProfile);
      const createdAt = nowIso();
      const schedulerState = String(args.schedulerState ?? "initialized").trim() || "initialized";
      const metadata = args.metadata ?? {};

      const byKey = new Map<string, string>();
      const dependencyStepKeysByStepKey = new Map<string, string[]>();
      const stepRows = [...args.steps]
        .sort((a, b) => a.stepIndex - b.stepIndex || a.stepKey.localeCompare(b.stepKey))
        .map((input, index) => {
          const id = randomUUID();
          const stepKey = input.stepKey.trim();
          if (!stepKey) throw new Error("stepKey is required for every orchestrator step.");
          if (byKey.has(stepKey)) throw new Error(`Duplicate stepKey in run: ${stepKey}`);
          byKey.set(stepKey, id);
          const dependencyStepKeys = normalizeDependencyStepKeys(input.dependencyStepKeys);
          dependencyStepKeysByStepKey.set(stepKey, dependencyStepKeys);
          return {
            id,
            input,
            createdAt,
            order: Number.isFinite(input.stepIndex) ? input.stepIndex : index,
            stepKey,
            dependencyStepKeys
          };
        });

      validateStepGraphIntegrity({
        context: "startRun",
        steps: stepRows.map(({ stepKey, dependencyStepKeys, input }) => ({
          stepKey,
          dependencyStepKeys,
          joinPolicy: normalizeJoinPolicy(String(input.joinPolicy ?? "all_success")),
          quorumCount: input.quorumCount != null ? Math.floor(Number(input.quorumCount)) : null
        }))
      });

      db.run(
        `
          insert into orchestrator_runs(
            id,
            project_id,
            mission_id,
            status,
            context_profile,
            scheduler_state,
            runtime_cursor_json,
            last_error,
            metadata_json,
            created_at,
            updated_at,
            started_at,
            completed_at
          ) values (?, ?, ?, 'queued', ?, ?, null, null, ?, ?, ?, null, null)
        `,
        [runId, projectId, missionId, profileId, schedulerState, JSON.stringify(metadata), createdAt, createdAt]
      );
      appendTimelineEvent({
        runId,
        eventType: "run_created",
        reason: "start_run",
        detail: {
          missionId,
          contextProfile: profileId,
          schedulerState
        }
      });

      for (const { id, input, createdAt: created, stepKey } of stepRows) {
        const policy: Record<string, unknown> = {
          includeNarrative: input.policy?.includeNarrative === true,
          includeFullDocs: input.policy?.includeFullDocs === true,
          ...(typeof input.policy?.docsMaxBytes === "number" ? { docsMaxBytes: Math.floor(input.policy.docsMaxBytes) } : {}),
          claimScopes: Array.isArray(input.policy?.claimScopes)
            ? input.policy?.claimScopes?.map((scope) => ({
                scopeKind: scope.scopeKind,
                scopeValue: scope.scopeValue,
                ...(typeof scope.ttlMs === "number" ? { ttlMs: Math.floor(scope.ttlMs) } : {})
              }))
            : []
        };
        const metadataJson = JSON.stringify({
          ...(input.metadata ?? {}),
          ...(input.executorKind ? { executorKind: input.executorKind } : {}),
          policy
        });
        db.run(
          `
            insert into orchestrator_steps(
              id,
              run_id,
              project_id,
              mission_step_id,
              step_key,
              step_index,
              title,
              lane_id,
              status,
              join_policy,
              quorum_count,
              dependency_step_ids_json,
              retry_limit,
              retry_count,
              last_attempt_id,
              policy_json,
              metadata_json,
              created_at,
              updated_at,
              started_at,
              completed_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '[]', ?, 0, null, ?, ?, ?, ?, null, null)
          `,
          [
            id,
            runId,
            projectId,
            input.missionStepId ?? null,
            stepKey,
            Number.isFinite(input.stepIndex) ? Math.floor(input.stepIndex) : 0,
            input.title.trim() || stepKey,
            input.laneId ?? null,
            input.joinPolicy ?? "all_success",
            input.quorumCount ?? null,
            Math.max(0, Math.floor(input.retryLimit ?? 0)),
            JSON.stringify(policy),
            metadataJson,
            created,
            created
          ]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_registered",
          reason: "start_run",
          detail: {
            stepKey,
            stepIndex: Number.isFinite(input.stepIndex) ? Math.floor(input.stepIndex) : 0,
            joinPolicy: input.joinPolicy ?? "all_success",
            retryLimit: Math.max(0, Math.floor(input.retryLimit ?? 0))
          }
        });
      }

      // Fill resolved dependency IDs after all step rows exist.
      for (const { id, stepKey } of stepRows) {
        const depKeys = dependencyStepKeysByStepKey.get(stepKey) ?? [];
        const depIds = depKeys.map((key) => {
          const depId = byKey.get(key);
          if (!depId) {
            throw new Error(`Unknown dependency stepKey '${key}' referenced by step '${stepKey}'.`);
          }
          return depId;
        });
        db.run(
          `
            update orchestrator_steps
            set dependency_step_ids_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [JSON.stringify(depIds), createdAt, id, runId, projectId]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_dependencies_resolved",
          reason: "start_run",
          detail: {
            dependencyStepIds: depIds
          }
        });
      }

      // Best effort mission pack refresh for durable mission-level context snapshot.
      try {
        if (typeof (packService as any).refreshMissionPack === "function") {
          void (packService as any).refreshMissionPack({
            missionId,
            reason: "orchestrator_run_started",
            runId
          });
        }
      } catch {
        // do not fail run creation on mission pack refresh failure
      }

      const run = toRun(
        getRunRow(runId) ??
          ({
            id: runId,
            mission_id: missionId,
            project_id: projectId,
            status: "queued",
            context_profile: profileId,
            scheduler_state: schedulerState,
            runtime_cursor_json: null,
            last_error: null,
            metadata_json: JSON.stringify(metadata),
            created_at: createdAt,
            updated_at: createdAt,
            started_at: null,
            completed_at: null
          } satisfies RunRow)
      );

      this.tick({ runId });

      return {
        run,
        steps: listStepRows(runId).map(toStep)
      };
    },

    tick(args: { runId: string }): OrchestratorRun {
      const run = getRunRow(args.runId);
      if (!run) throw new Error(`Run not found: ${args.runId}`);
      const runStatus = normalizeRunStatus(run.status);
      if (TERMINAL_RUN_STATUSES.has(runStatus)) return toRun(run);
      // Paused runs (e.g. budget exceeded) should not auto-resume via tick
      if (runStatus === "paused") return toRun(run);

      expireClaims();
      refreshStepReadiness(args.runId);

      const next = deriveRunStatusFromSteps(args.runId);
      const current = normalizeRunStatus(run.status);
      if (next !== current) {
        updateRunStatus(args.runId, next);
      } else if (current === "queued") {
        updateRunStatus(args.runId, "running");
      } else {
        db.run(
          `
            update orchestrator_runs
            set updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [nowIso(), args.runId, projectId]
        );
      }
      appendTimelineEvent({
        runId: args.runId,
        eventType: "scheduler_tick",
        reason: "tick",
        detail: {
          fromStatus: current,
          derivedStatus: next
        }
      });

      const updated = getRunRow(args.runId);
      if (!updated) throw new Error(`Run not found after tick: ${args.runId}`);
      return toRun(updated);
    },

    heartbeatClaims(args: { attemptId: string; ownerId: string }): number {
      const now = nowIso();
      const runtimeConfig = getRuntimeConfig();
      const activeClaims = db.all<ClaimRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_id,
            owner_id,
            scope_kind,
            scope_value,
            state,
            acquired_at,
            heartbeat_at,
            expires_at,
            released_at,
            policy_json,
            metadata_json
          from orchestrator_claims
          where project_id = ?
            and attempt_id = ?
            and owner_id = ?
            and state = 'active'
        `,
        [projectId, args.attemptId, args.ownerId]
      );
      for (const claim of activeClaims) {
        const policy = parseRecord(claim.policy_json) ?? {};
        const ttlMsRaw = Number(policy.ttlMs ?? runtimeConfig.workerHeartbeatTimeoutMs);
        const ttlMs =
          Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : runtimeConfig.workerHeartbeatTimeoutMs;
        db.run(
          `
            update orchestrator_claims
            set heartbeat_at = ?,
                expires_at = ?
            where id = ?
              and project_id = ?
            and state = 'active'
          `,
          [now, new Date(Date.now() + ttlMs).toISOString(), claim.id, projectId]
        );
        appendTimelineEvent({
          runId: claim.run_id,
          stepId: claim.step_id,
          attemptId: claim.attempt_id,
          claimId: claim.id,
          eventType: "claim_heartbeat",
          reason: "heartbeat",
          detail: {
            ownerId: claim.owner_id,
            ttlMs
          }
        });
      }
      if (activeClaims.length) {
        emit({ type: "orchestrator-claim-updated", attemptId: args.attemptId, reason: "heartbeat" });
      }
      return activeClaims.length;
    },

    async startAttempt(args: {
      runId: string;
      stepId: string;
      ownerId: string;
      executorKind?: OrchestratorExecutorKind;
    }): Promise<OrchestratorAttempt> {
      const runtimeConfig = getRuntimeConfig();
      const runRow = getRunRow(args.runId);
      if (!runRow) throw new Error(`Run not found: ${args.runId}`);
      const stepRow = getStepRow(args.stepId);
      if (!stepRow || stepRow.run_id !== args.runId) throw new Error(`Step not found in run: ${args.stepId}`);

      const run = toRun(runRow);
      const step = toStep(stepRow);
      if (step.status !== "ready") {
        throw new Error(`Step is not ready: ${step.id} (${step.status})`);
      }

      const attemptNumRow = db.get<{ max_attempt: number }>(
        `
          select max(attempt_number) as max_attempt
          from orchestrator_attempts
          where project_id = ?
            and step_id = ?
        `,
        [projectId, step.id]
      );
      const attemptNumber = Number(attemptNumRow?.max_attempt ?? 0) + 1;
      const attemptId = randomUUID();
      const createdAt = nowIso();
      const executorKind = args.executorKind ?? normalizeExecutorKind(String(step.metadata?.executorKind ?? "manual"));
      const stepPolicy = resolveStepPolicy(step);
      const contextPolicy = resolveContextPolicy({ runProfileId: run.contextProfile, stepPolicy });

      // Claims are acquired before attempt state transitions so collisions are deterministic.
      const acquiredClaims: OrchestratorClaim[] = [];
      for (const scope of stepPolicy.claimScopes ?? []) {
        const normalizedScopeValue = normalizeClaimScopeValue({
          scopeKind: scope.scopeKind,
          scopeValue: scope.scopeValue
        });
        const failClaimStart = (failure: {
          errorMessage: string;
          detail: Record<string, unknown>;
          reason: string;
        }): OrchestratorAttempt => {
          releaseClaimsForAttempt({ attemptId, state: "released" });
          db.run(
            `
              insert into orchestrator_attempts(
                id,
                run_id,
                step_id,
                project_id,
                attempt_number,
                status,
                executor_kind,
                executor_session_id,
                tracked_session_enforced,
                context_profile,
                context_snapshot_id,
                error_class,
                error_message,
                retry_backoff_ms,
                result_envelope_json,
                metadata_json,
                created_at,
                started_at,
                completed_at
              ) values (?, ?, ?, ?, ?, 'blocked', ?, null, 1, ?, null, 'claim_conflict', ?, 0, null, ?, ?, ?, ?)
            `,
            [
              attemptId,
              run.id,
              step.id,
              projectId,
              attemptNumber,
              executorKind,
              contextPolicy.id,
              failure.errorMessage,
              JSON.stringify({
                ownerId: args.ownerId,
                claimScope: {
                  scopeKind: scope.scopeKind,
                  scopeValue: normalizedScopeValue ?? scope.scopeValue,
                  ttlMs: scope.ttlMs
                },
                workerState: "disposed",
                claimConflict: failure.detail
              }),
              createdAt,
              createdAt,
              createdAt
            ]
          );
          db.run(
            `
              update orchestrator_steps
              set status = 'blocked',
                  last_attempt_id = ?,
                  updated_at = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
            [attemptId, createdAt, step.id, run.id, projectId]
          );
          insertHandoff({
            missionId: run.missionId,
            missionStepId: step.missionStepId,
            runId: run.id,
            stepId: step.id,
            attemptId,
            handoffType: "attempt_blocked",
            producer: "orchestrator",
            payload: {
              reason: "claim_conflict",
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue ?? scope.scopeValue,
              contextProfile: contextPolicy.id,
              ...failure.detail
            }
          });
          emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId, reason: "claim_blocked" });
          appendTimelineEvent({
            runId: run.id,
            stepId: step.id,
            attemptId,
            eventType: "attempt_blocked",
            reason: failure.reason,
            detail: {
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue ?? scope.scopeValue,
              ...failure.detail
            }
          });
          persistRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId,
            eventType: "claim_conflict",
            eventKey: `claim_conflict:${attemptId}:${scope.scopeKind}:${normalizedScopeValue ?? scope.scopeValue}`,
            occurredAt: createdAt,
            payload: {
              reason: failure.reason,
              scopeKind: scope.scopeKind,
              scopeValue: normalizedScopeValue ?? scope.scopeValue,
              ...failure.detail
            }
          });
          this.tick({ runId: run.id });
          const blockedRow = getAttemptRow(attemptId);
          if (!blockedRow) throw new Error("Failed to create blocked attempt.");
          return toAttempt(blockedRow);
        };

        if (!normalizedScopeValue) {
          return failClaimStart({
            errorMessage: `Invalid file reservation scope: ${scope.scopeValue}`,
            reason: "claim_scope_invalid",
            detail: {
              invalidScopeValue: scope.scopeValue
            }
          });
        }
        const existingConflict = findActiveClaimConflict({
          scopeKind: scope.scopeKind,
          scopeValue: normalizedScopeValue,
          ignoreAttemptId: attemptId
        });
        if (existingConflict) {
          return failClaimStart({
            errorMessage: `Claim collision for ${scope.scopeKind}:${normalizedScopeValue}`,
            reason: "claim_conflict",
            detail: {
              conflictingClaimId: existingConflict.conflict.id,
              conflictingRunId: existingConflict.conflict.run_id,
              conflictingStepId: existingConflict.conflict.step_id,
              conflictingAttemptId: existingConflict.conflict.attempt_id,
              conflictingScopeValue: existingConflict.conflict.scope_value,
              conflictReason: existingConflict.reason
            }
          });
        }
        const ttlMs = scope.ttlMs ?? runtimeConfig.workerHeartbeatTimeoutMs;
        const claim = acquireClaim({
          runId: run.id,
          stepId: step.id,
          attemptId,
          ownerId: args.ownerId.trim() || "orchestrator",
          scopeKind: scope.scopeKind,
          scopeValue: normalizedScopeValue,
          ttlMs,
          policy: { ttlMs }
        });
        if (!claim) {
          const postConflict = findActiveClaimConflict({
            scopeKind: scope.scopeKind,
            scopeValue: normalizedScopeValue,
            ignoreAttemptId: attemptId
          });
          return failClaimStart({
            errorMessage: `Claim collision for ${scope.scopeKind}:${normalizedScopeValue}`,
            reason: "claim_conflict",
            detail: postConflict
              ? {
                  conflictingClaimId: postConflict.conflict.id,
                  conflictingRunId: postConflict.conflict.run_id,
                  conflictingStepId: postConflict.conflict.step_id,
                  conflictingAttemptId: postConflict.conflict.attempt_id,
                  conflictingScopeValue: postConflict.conflict.scope_value,
                  conflictReason: postConflict.reason
                }
              : {}
          });
        }
        acquiredClaims.push(claim);
      }

      const snapshot = await createContextSnapshotForAttempt({
        run,
        step,
        attemptId,
        contextProfile: contextPolicy
      });

      // Budget guard: check total token budget before dispatching
      const tokensConsumed = Number(run.metadata?.tokensConsumed ?? 0);
      if (runtimeConfig.maxTotalTokenBudget != null && tokensConsumed >= runtimeConfig.maxTotalTokenBudget) {
        releaseClaimsForAttempt({ attemptId, state: "released" });
        updateRunStatus(run.id, "paused", {
          last_error: `Total token budget exceeded: ${tokensConsumed} >= ${runtimeConfig.maxTotalTokenBudget}`
        });
        appendTimelineEvent({
          runId: run.id,
          stepId: step.id,
          attemptId,
          eventType: "budget_exceeded",
          reason: "total_budget_limit",
          detail: {
            tokensConsumed,
            maxTotalTokenBudget: runtimeConfig.maxTotalTokenBudget
          }
        });
        throw new Error(`Total token budget exceeded: ${tokensConsumed} >= ${runtimeConfig.maxTotalTokenBudget}`);
      }

      db.run(
        `
          insert into orchestrator_attempts(
            id,
            run_id,
            step_id,
            project_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          ) values (?, ?, ?, ?, ?, 'running', ?, null, 1, ?, ?, 'none', null, 0, null, ?, ?, ?, null)
        `,
        [
          attemptId,
          run.id,
          step.id,
          projectId,
          attemptNumber,
          executorKind,
          contextPolicy.id,
          snapshot.snapshotId,
          JSON.stringify({
            ownerId: args.ownerId,
            docsMode: contextPolicy.docsMode,
            docsCount: snapshot.docsRefs.length,
            workerState: "initializing",
            workerStartedAt: createdAt
          }),
          createdAt,
          createdAt
        ]
      );

      db.run(
        `
          update orchestrator_steps
          set status = 'running',
              last_attempt_id = ?,
              updated_at = ?,
              started_at = coalesce(started_at, ?)
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [attemptId, createdAt, createdAt, step.id, run.id, projectId]
      );

      insertHandoff({
        missionId: run.missionId,
        missionStepId: step.missionStepId,
        runId: run.id,
        stepId: step.id,
        attemptId,
        handoffType: "attempt_started",
        producer: "orchestrator",
        payload: {
          contextProfile: contextPolicy.id,
          contextSnapshotId: snapshot.snapshotId,
          docsMode: contextPolicy.docsMode,
          docsRefs: snapshot.docsRefs,
          laneExportLevel: snapshot.laneExport?.level ?? null,
          projectExportLevel: snapshot.projectExport.level,
          claims: acquiredClaims.map((claim) => ({
            id: claim.id,
            scopeKind: claim.scopeKind,
            scopeValue: claim.scopeValue,
            expiresAt: claim.expiresAt
          }))
        }
      });

      emit({ type: "orchestrator-step-updated", runId: run.id, stepId: step.id, reason: "attempt_started" });
      emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId, reason: "started" });
      appendTimelineEvent({
        runId: run.id,
        stepId: step.id,
        attemptId,
        eventType: "attempt_started",
        reason: "attempt_started",
        detail: {
          executorKind,
          contextProfile: contextPolicy.id,
          contextSnapshotId: snapshot.snapshotId,
          workerState: "initializing"
        }
      });

      const attemptRow = getAttemptRow(attemptId);
      if (!attemptRow) throw new Error("Attempt creation failed.");
      const attempt = toAttempt(attemptRow);
      const completeAndAdvance = async (completeArgs: {
        attemptId: string;
        status: Extract<OrchestratorAttemptStatus, "succeeded" | "failed" | "blocked" | "canceled">;
        result?: OrchestratorAttemptResultEnvelope;
        errorClass?: OrchestratorErrorClass;
        errorMessage?: string;
        metadata?: Record<string, unknown> | null;
      }): Promise<OrchestratorAttempt> => {
        const completedAttempt = this.completeAttempt(completeArgs);
        await this.startReadyAutopilotAttempts({
          runId: run.id,
          reason: "attempt_completed_inline"
        });
        return completedAttempt;
      };

      const integrationResult = await tryRunConflictResolverChain({
        run,
        step,
        attempt
      });
      if (integrationResult) {
        return completeAndAdvance({
          attemptId: attempt.id,
          status: integrationResult.status,
          result: integrationResult.result,
          errorClass: integrationResult.errorClass,
          errorMessage: integrationResult.errorMessage,
          metadata: integrationResult.metadata ?? null
        });
      }

      const adapter = adapters.get(executorKind) ?? defaultAdapterFor(executorKind);
      if (adapter) {
        // Read permission config from project config for worker adapters
        const permissionConfig = (() => {
          const snapshot = projectConfigService?.get();
          const ai = asRecord(snapshot?.effective?.ai);
          const permissions = asRecord(ai?.permissions);
          if (!permissions) return undefined;
          const claudePerms = asRecord(permissions.claude);
          const codexPerms = asRecord(permissions.codex);
          if (!claudePerms && !codexPerms) return undefined;
          const config: NonNullable<OrchestratorExecutorStartArgs["permissionConfig"]> = {};
          if (claudePerms) {
            config.claude = {
              permissionMode: typeof claudePerms.permissionMode === "string" ? claudePerms.permissionMode : undefined,
              dangerouslySkipPermissions: typeof claudePerms.dangerouslySkipPermissions === "boolean" ? claudePerms.dangerouslySkipPermissions : undefined,
              allowedTools: Array.isArray(claudePerms.allowedTools) ? claudePerms.allowedTools.filter((v): v is string => typeof v === "string") : undefined,
              settingsSources: Array.isArray(claudePerms.settingsSources) ? claudePerms.settingsSources.filter((v): v is string => typeof v === "string") : undefined,
              sandbox: typeof claudePerms.sandbox === "boolean" ? claudePerms.sandbox : undefined,
            };
          }
          if (codexPerms) {
            config.codex = {
              sandboxPermissions: typeof codexPerms.sandboxPermissions === "string" ? codexPerms.sandboxPermissions : undefined,
              approvalMode: typeof codexPerms.approvalMode === "string" ? codexPerms.approvalMode : undefined,
              writablePaths: Array.isArray(codexPerms.writablePaths) ? codexPerms.writablePaths.filter((v): v is string => typeof v === "string") : undefined,
              commandAllowlist: Array.isArray(codexPerms.commandAllowlist) ? codexPerms.commandAllowlist.filter((v): v is string => typeof v === "string") : undefined,
              configPath: typeof codexPerms.configPath === "string" ? codexPerms.configPath : undefined,
            };
          }
          return config;
        })();

        const result = await adapter.start({
          run,
          step,
          attempt,
          contextProfile: contextPolicy,
          laneExport: snapshot.laneExport,
          projectExport: snapshot.projectExport,
          docsRefs: snapshot.docsRefs,
          fullDocs: snapshot.fullDocs,
          createTrackedSession: (sessionArgs) =>
            this.createOrchestratedSession({
              ...sessionArgs,
              tracked: true
            }),
          permissionConfig
        });
        if (result.status === "accepted") {
          const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
          if (sessionId) {
            const sessionRow = db.get<{ transcript_path: string | null }>(
              `
                select transcript_path
                from terminal_sessions
                where id = ?
                limit 1
              `,
              [sessionId]
            );
            db.run(
              `
                update orchestrator_attempts
                set executor_session_id = ?,
                    metadata_json = ?
                where id = ?
                  and project_id = ?
              `,
              [
                sessionId,
                JSON.stringify({
                  ...(attempt.metadata ?? {}),
                  ...(result.metadata ?? {}),
                  transcriptPath: sessionRow?.transcript_path ?? null,
                  workerState: "working",
                  workerSessionAttachedAt: nowIso()
                }),
                attempt.id,
                projectId
              ]
            );
            emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId: attempt.id, reason: "session_attached" });
            appendTimelineEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              eventType: "executor_session_attached",
              reason: "adapter_accepted",
              detail: {
                executorKind,
                sessionId,
                transcriptPath: sessionRow?.transcript_path ?? null,
                workerState: "working"
              }
            });
          }
          return toAttempt(getAttemptRow(attempt.id) ?? attemptRow);
        }
        if (result.status === "completed") {
          return completeAndAdvance({
            attemptId: attempt.id,
            status: "succeeded",
            result: result.result
          });
        }
        return completeAndAdvance({
          attemptId: attempt.id,
          status: "failed",
          errorClass: result.errorClass ?? "executor_failure",
          errorMessage: result.errorMessage,
          metadata: result.metadata ?? null
        });
      }

      appendTimelineEvent({
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id,
        eventType: "executor_adapter_missing",
        reason: "manual_wait",
        detail: {
          executorKind
        }
      });
      this.tick({ runId: run.id });
      return attempt;
    },

    completeAttempt(args: {
      attemptId: string;
      status: Extract<OrchestratorAttemptStatus, "succeeded" | "failed" | "blocked" | "canceled">;
      result?: OrchestratorAttemptResultEnvelope;
      errorClass?: OrchestratorErrorClass;
      errorMessage?: string | null;
      retryBackoffMs?: number;
      metadata?: Record<string, unknown> | null;
    }): OrchestratorAttempt {
      const attemptRow = getAttemptRow(args.attemptId);
      if (!attemptRow) throw new Error(`Attempt not found: ${args.attemptId}`);
      const stepRow = getStepRow(attemptRow.step_id);
      if (!stepRow) throw new Error(`Step not found for attempt: ${args.attemptId}`);
      const runRow = getRunRow(attemptRow.run_id);
      if (!runRow) throw new Error(`Run not found for attempt: ${args.attemptId}`);
	      const step = toStep(stepRow);
	      const run = toRun(runRow);

	      const completedAt = nowIso();
	      const runtimeConfig = getRuntimeConfig();
	      let status = args.status;
	      const fileReservationCheck =
	        status === "succeeded"
	          ? evaluateFileReservationViolations({
	              step,
	              result: args.result ?? null,
	              metadata: args.metadata ?? null
	            })
	          : null;
	      const fileReservationMessage = (() => {
	        if (!fileReservationCheck || fileReservationCheck.violations.length === 0) return null;
	        const preview = fileReservationCheck.violations.slice(0, 4).join(", ");
	        const suffix = fileReservationCheck.violations.length > 4 ? ` (+${fileReservationCheck.violations.length - 4} more)` : "";
	        return `File reservation violation: modified files outside claimed scope (${preview}${suffix}).`;
	      })();
	      const reservationGuardMode = runtimeConfig.fileReservationGuardMode;
	      const reservationBlocks = status === "succeeded" && Boolean(fileReservationMessage) && reservationGuardMode === "block";
	      const reservationWarns = status === "succeeded" && Boolean(fileReservationMessage) && reservationGuardMode === "warn";
	      if (reservationBlocks) {
	        status = "blocked";
	      }
	      const effectiveErrorMessage = reservationBlocks
	        ? fileReservationMessage
	        : args.errorMessage ?? null;
	      const errorClass =
	        status === "failed"
	          ? args.errorClass ?? "executor_failure"
	          : status === "blocked"
	            ? args.errorClass ?? (reservationBlocks ? "policy" : "policy")
	            : status === "canceled"
	              ? "canceled"
	              : "none";
	      const retryable = status === "failed" ? RETRYABLE_ERROR_CLASSES.has(errorClass) : false;
	      const retryRemaining = status === "failed" ? step.retryCount < step.retryLimit : false;
	      const shouldRetry = status === "failed" ? retryable && retryRemaining : false;
	      const computedBackoff =
	        shouldRetry
	          ? Math.max(
              0,
              Math.floor(
                args.retryBackoffMs
                  ?? Math.min(10 * 60_000, DEFAULT_RETRY_BACKOFF_MS * Math.pow(2, Math.max(0, step.retryCount)))
              )
	            )
	          : Math.max(0, Math.floor(args.retryBackoffMs ?? 0));
	      const defaultSummary =
	        status === "succeeded"
	          ? "Step completed."
	          : status === "failed"
	            ? effectiveErrorMessage?.trim() || "Step attempt failed."
	            : status === "blocked"
	              ? effectiveErrorMessage?.trim() || "Step attempt blocked."
	              : "Step attempt canceled.";
	      const envelope: OrchestratorAttemptResultEnvelope = normalizeEnvelope(
	        args.result ?? {
	          success: status === "succeeded",
          summary: defaultSummary,
          outputs: null,
          warnings: status === "failed" || status === "blocked" ? [defaultSummary] : [],
          sessionId: attemptRow.executor_session_id,
	          trackedSession: true
	        }
	      );
	      if (reservationWarns && fileReservationMessage && !envelope.warnings.includes(fileReservationMessage)) {
	        envelope.warnings.push(fileReservationMessage);
	      }
	      const workerState = status === "succeeded" ? "idle" : "disposed";

      db.run(
        `
          update orchestrator_attempts
          set status = ?,
              error_class = ?,
              error_message = ?,
              retry_backoff_ms = ?,
              result_envelope_json = ?,
              metadata_json = ?,
              completed_at = ?,
              started_at = coalesce(started_at, ?)
          where id = ?
            and project_id = ?
        `,
	        [
	          status,
	          errorClass,
	          effectiveErrorMessage,
	          computedBackoff,
	          JSON.stringify(envelope),
	          JSON.stringify({
	            ...(parseRecord(attemptRow.metadata_json) ?? {}),
	            ...(args.metadata ?? {}),
	            ...(fileReservationCheck
	              ? {
	                  fileReservationGuardMode: reservationGuardMode,
	                  fileReservationScopes: fileReservationCheck.normalizedScopes,
	                  fileReservationTouchedPaths: fileReservationCheck.touchedPaths,
	                  fileReservationViolations: fileReservationCheck.violations
	                }
	              : {}),
	            workerState,
	            workerCompletedAt: completedAt
	          }),
          completedAt,
          completedAt,
          args.attemptId,
          projectId
        ]
      );

      releaseClaimsForAttempt({
        attemptId: args.attemptId,
        state: status === "failed" ? "released" : "released"
      });

      if (status === "succeeded") {
        db.run(
          `
            update orchestrator_steps
            set status = 'succeeded',
                updated_at = ?,
                completed_at = ?,
                last_attempt_id = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [completedAt, completedAt, args.attemptId, step.id, run.id, projectId]
        );
      } else if (status === "canceled") {
        db.run(
          `
            update orchestrator_steps
            set status = 'canceled',
                updated_at = ?,
                completed_at = ?,
                last_attempt_id = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [completedAt, completedAt, args.attemptId, step.id, run.id, projectId]
        );
      } else if (status === "blocked") {
        const blockedMetadata = {
          ...(step.metadata ?? {}),
          blockedAt: completedAt,
	          blockedByAttemptId: args.attemptId,
	          blockedErrorClass: errorClass,
	          blockedErrorMessage: effectiveErrorMessage ?? defaultSummary,
	          blockedSticky: errorClass === "policy"
	        };
        db.run(
          `
            update orchestrator_steps
            set status = 'blocked',
                metadata_json = ?,
                updated_at = ?,
                last_attempt_id = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
        [JSON.stringify(blockedMetadata), completedAt, args.attemptId, step.id, run.id, projectId]
      );
      } else {
        if (shouldRetry) {
          const nextRetryAt = new Date(Date.now() + computedBackoff).toISOString();
          db.run(
            `
              update orchestrator_steps
              set status = 'pending',
                  retry_count = retry_count + 1,
                  metadata_json = ?,
                  updated_at = ?,
                  last_attempt_id = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
            [
              JSON.stringify({
                ...(step.metadata ?? {}),
                nextRetryAt,
                lastRetryBackoffMs: computedBackoff
              }),
              completedAt,
              args.attemptId,
              step.id,
              run.id,
              projectId
            ]
          );
	      appendTimelineEvent({
	        runId: run.id,
	        stepId: step.id,
	        attemptId: args.attemptId,
            eventType: "attempt_retry_scheduled",
            reason: "retryable_failure",
            detail: {
              retryBackoffMs: computedBackoff,
              nextRetryAt,
              retryCount: step.retryCount + 1,
              retryLimit: step.retryLimit
            }
          });
          persistRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: args.attemptId,
            sessionId: attemptRow.executor_session_id,
            eventType: "retry_scheduled",
            eventKey: `retry_scheduled:${args.attemptId}:${step.retryCount + 1}:${nextRetryAt}`,
            occurredAt: completedAt,
            payload: {
              retryBackoffMs: computedBackoff,
              nextRetryAt,
              retryCount: step.retryCount + 1,
              retryLimit: step.retryLimit,
              errorClass
            }
          });
        } else {
          db.run(
            `
              update orchestrator_steps
              set status = 'failed',
                  updated_at = ?,
                  completed_at = ?,
                  last_attempt_id = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
	          [completedAt, completedAt, args.attemptId, step.id, run.id, projectId]
        );
          persistRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: args.attemptId,
            sessionId: attemptRow.executor_session_id,
            eventType: "retry_exhausted",
            eventKey: `retry_exhausted:${args.attemptId}:${step.retryCount}:${step.retryLimit}`,
            occurredAt: completedAt,
            payload: {
	              retryCount: step.retryCount,
	              retryLimit: step.retryLimit,
	              errorClass,
	              errorMessage: effectiveErrorMessage ?? defaultSummary
	            }
	          });
	        }
      }

      insertHandoff({
        missionId: run.missionId,
        missionStepId: step.missionStepId,
        runId: run.id,
        stepId: step.id,
        attemptId: args.attemptId,
        handoffType:
          status === "succeeded"
            ? "attempt_succeeded"
            : status === "failed"
              ? "attempt_failed"
              : status === "blocked"
                ? "attempt_blocked"
                : "attempt_canceled",
        producer: "orchestrator",
        payload: {
          contextProfile: normalizeProfileId(attemptRow.context_profile),
	          status,
	          errorClass,
	          errorMessage: effectiveErrorMessage,
	          retryBackoffMs: computedBackoff,
	          result: envelope
	        }
      });

      emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId: args.attemptId, reason: "completed" });
      emit({ type: "orchestrator-step-updated", runId: run.id, stepId: step.id, reason: "attempt_completed" });
      appendTimelineEvent({
        runId: run.id,
        stepId: step.id,
        attemptId: args.attemptId,
        eventType: "attempt_completed",
        reason: status,
        detail: {
          status,
          errorClass,
          retryBackoffMs: computedBackoff,
	          shouldRetry
	        }
	      });
	      if (fileReservationMessage && fileReservationCheck) {
	        appendTimelineEvent({
	          runId: run.id,
	          stepId: step.id,
	          attemptId: args.attemptId,
	          eventType: "file_reservation_guard",
	          reason: reservationBlocks ? "block" : reservationWarns ? "warn" : "off",
	          detail: {
	            guardMode: reservationGuardMode,
	            normalizedScopes: fileReservationCheck.normalizedScopes,
	            touchedPaths: fileReservationCheck.touchedPaths,
	            violations: fileReservationCheck.violations,
	            rawPaths: fileReservationCheck.rawPaths
	          }
	        });
	      }
	      if (status === "succeeded") {
	        persistRuntimeEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: args.attemptId,
          sessionId: attemptRow.executor_session_id,
          eventType: "done",
          eventKey: `done:${args.attemptId}:${completedAt}`,
          occurredAt: completedAt,
          payload: {
            summary: envelope.summary
          }
        });
      } else if (status === "blocked") {
        persistRuntimeEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: args.attemptId,
          sessionId: attemptRow.executor_session_id,
          eventType: "blocked",
          eventKey: `blocked:${args.attemptId}:${errorClass}:${completedAt}`,
          occurredAt: completedAt,
	          payload: {
	            errorClass,
	            errorMessage: effectiveErrorMessage ?? defaultSummary
	          }
	        });
	      }

      // Budget accumulation: if attempt metadata includes tokensConsumed, accumulate into run
      const attemptTokens = Number(args.metadata?.tokensConsumed ?? 0);
      if (attemptTokens > 0) {
        const currentRunRow = getRunRow(run.id);
        const currentRunMeta = currentRunRow ? (parseRecord(currentRunRow.metadata_json) ?? {}) : (run.metadata ?? {});
        const currentTotal = Number(currentRunMeta.tokensConsumed ?? 0);
        const newTotal = currentTotal + attemptTokens;
        const updatedMeta = { ...currentRunMeta, tokensConsumed: newTotal };
        db.run(
          `
            update orchestrator_runs
            set metadata_json = ?,
                updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [JSON.stringify(updatedMeta), nowIso(), run.id, projectId]
        );
        appendTimelineEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: args.attemptId,
          eventType: "budget_updated",
          reason: "attempt_budget_accumulated",
          detail: {
            attemptTokens,
            totalTokensConsumed: newTotal
          }
        });
        // Check if total exceeds limit; if so, pause the run
        const runtimeConfig = getRuntimeConfig();
        if (runtimeConfig.maxTotalTokenBudget != null && newTotal >= runtimeConfig.maxTotalTokenBudget) {
          updateRunStatus(run.id, "paused", {
            last_error: `Total token budget exceeded: ${newTotal} >= ${runtimeConfig.maxTotalTokenBudget}`,
            metadata_json: JSON.stringify(updatedMeta)
          });
          appendTimelineEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: args.attemptId,
            eventType: "budget_exceeded",
            reason: "total_budget_limit",
            detail: {
              tokensConsumed: newTotal,
              maxTotalTokenBudget: runtimeConfig.maxTotalTokenBudget
            }
          });
        }
      }

      const updatedRun = this.tick({ runId: run.id });
      if (updatedRun.status === "succeeded" || updatedRun.status === "failed" || updatedRun.status === "canceled") {
        const latestAttempt = getAttemptRow(args.attemptId);
        const latestMetadata =
          (latestAttempt ? toAttempt(latestAttempt).metadata : null) ?? parseRecord(attemptRow.metadata_json) ?? {};
        db.run(
          `
            update orchestrator_attempts
            set metadata_json = ?
            where id = ?
              and project_id = ?
          `,
          [
            JSON.stringify({
              ...latestMetadata,
              workerState: "disposed",
              workerDisposedAt: nowIso()
            }),
            args.attemptId,
            projectId
          ]
        );
      }
	      if (updatedRun.status === "failed") {
	        db.run(
	          `
	            update orchestrator_runs
	            set last_error = ?,
	                updated_at = ?
	            where id = ?
	              and project_id = ?
	          `,
	          [effectiveErrorMessage ?? defaultSummary, nowIso(), run.id, projectId]
	        );
	      }
      const updatedAttemptRow = getAttemptRow(args.attemptId);
      if (!updatedAttemptRow) throw new Error("Attempt not found after completion update.");
      return toAttempt(updatedAttemptRow);
    },

    resumeRun(args: { runId: string }): OrchestratorRun {
      const runRow = getRunRow(args.runId);
      if (!runRow) throw new Error(`Run not found: ${args.runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return run;

      // Recover in-flight attempts as restart-failures so scheduler can retry deterministically.
      const runningAttempts = db.all<AttemptRow>(
        `
          select
            id,
            run_id,
            step_id,
            attempt_number,
            status,
            executor_kind,
            executor_session_id,
            tracked_session_enforced,
            context_profile,
            context_snapshot_id,
            error_class,
            error_message,
            retry_backoff_ms,
            result_envelope_json,
            metadata_json,
            created_at,
            started_at,
            completed_at
          from orchestrator_attempts
          where project_id = ?
            and run_id = ?
            and status = 'running'
          order by created_at asc
        `,
        [projectId, run.id]
      );

      for (const attemptRow of runningAttempts) {
        const step = getStepRow(attemptRow.step_id);
        if (!step) continue;
        releaseClaimsForAttempt({ attemptId: attemptRow.id, state: "expired" });
        const completedAt = nowIso();
        db.run(
          `
            update orchestrator_attempts
            set status = 'failed',
                error_class = 'resume_recovered',
                error_message = ?,
                result_envelope_json = ?,
                completed_at = ?,
                started_at = coalesce(started_at, ?)
            where id = ?
              and project_id = ?
          `,
          [
            "Attempt was running during restart; recovered into deterministic retry path.",
            JSON.stringify({
              schema: "ade.orchestratorAttempt.v1",
              success: false,
              summary: "Recovered after process restart.",
              outputs: null,
              warnings: ["resume_recovered"],
              sessionId: attemptRow.executor_session_id,
              trackedSession: true
            } satisfies OrchestratorAttemptResultEnvelope),
            completedAt,
            completedAt,
            attemptRow.id,
            projectId
          ]
        );
        db.run(
          `
            update orchestrator_steps
            set status = case
              when retry_count < retry_limit then 'ready'
              else 'failed'
            end,
            retry_count = case
              when retry_count < retry_limit then retry_count + 1
              else retry_count
            end,
            updated_at = ?,
            completed_at = case
              when retry_count < retry_limit then completed_at
              else ?
            end
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [completedAt, completedAt, step.id, run.id, projectId]
        );
        insertHandoff({
          missionId: run.missionId,
          missionStepId: step.mission_step_id,
          runId: run.id,
          stepId: step.id,
          attemptId: attemptRow.id,
          handoffType: "attempt_recovered_after_restart",
          producer: "orchestrator",
          payload: {
            errorClass: "resume_recovered",
            message: "Attempt converted to deterministic recovery path.",
            contextProfile: normalizeProfileId(attemptRow.context_profile)
          }
        });
        appendTimelineEvent({
          runId: run.id,
          stepId: step.id,
          attemptId: attemptRow.id,
          eventType: "attempt_recovered_after_restart",
          reason: "resume_recovered",
          detail: {
            retryLimit: step.retry_limit,
            retryCount: step.retry_count
          }
        });
      }

      const resumed = this.tick({ runId: run.id });
      const autopilot = parseAutopilotConfig(resumed.metadata);
      if (autopilot.enabled) {
        void this
          .startReadyAutopilotAttempts({
            runId: run.id,
            reason: "resume_run"
          })
          .catch(() => {});
      }
      appendTimelineEvent({
        runId: run.id,
        eventType: "run_resumed",
        reason: "resume_run",
        detail: {
          recoveredAttempts: runningAttempts.length,
          status: resumed.status
        }
      });
      return resumed;
    },

    cancelRun(args: { runId: string; reason?: string }) {
      const run = getRunRow(args.runId);
      if (!run) throw new Error(`Run not found: ${args.runId}`);
      const now = nowIso();
      db.run(
        `
          update orchestrator_attempts
          set status = 'canceled',
              error_class = 'canceled',
              error_message = ?,
              completed_at = coalesce(completed_at, ?)
          where run_id = ?
            and project_id = ?
            and status in ('queued', 'running', 'blocked')
        `,
        [args.reason ?? "Run canceled.", now, args.runId, projectId]
      );
      db.run(
        `
          update orchestrator_steps
          set status = case
            when status in ('succeeded', 'failed', 'skipped', 'canceled') then status
            else 'canceled'
          end,
          updated_at = ?,
          completed_at = case
            when status in ('succeeded', 'failed', 'skipped', 'canceled') then completed_at
            else ?
          end
          where run_id = ?
            and project_id = ?
        `,
        [now, now, args.runId, projectId]
      );
      db.run(
        `
          update orchestrator_claims
          set state = 'released',
              released_at = ?
          where run_id = ?
            and project_id = ?
            and state = 'active'
        `,
        [now, args.runId, projectId]
      );
      updateRunStatus(args.runId, "canceled", {
        last_error: args.reason ?? null
      });
      appendTimelineEvent({
        runId: args.runId,
        eventType: "run_canceled",
        reason: "cancel_run",
        detail: {
          reason: args.reason ?? null
        }
      });
    },

    addSteps(args: {
      runId: string;
      steps: StartOrchestratorRunStepInput[];
    }): OrchestratorStep[] {
      const runId = String(args.runId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot add steps to a terminal run (status: ${run.status}).`);
      }
      if (!args.steps.length) return [];

      // Get existing steps to compute next step_index and resolve dependency keys
      const existingStepRows = listStepRows(runId);
      const existingSteps = existingStepRows.map(toStep);
      const existingKeyToId = new Map<string, string>();
      for (const step of existingSteps) {
        existingKeyToId.set(step.stepKey, step.id);
      }
      const existingKeyById = new Map<string, string>();
      for (const step of existingSteps) {
        existingKeyById.set(step.id, step.stepKey);
      }
      const maxExistingIndex = existingSteps.reduce((max, step) => Math.max(max, step.stepIndex), -1);

      const createdAt = nowIso();
      const newKeyToId = new Map<string, string>();
      const dependencyStepKeysByNewStepKey = new Map<string, string[]>();
      const sorted = [...args.steps].sort(
        (a, b) => a.stepIndex - b.stepIndex || a.stepKey.localeCompare(b.stepKey)
      );
      const stepEntries = sorted.map((input, index) => {
        const id = randomUUID();
        const stepKey = input.stepKey.trim();
        if (!stepKey) throw new Error("stepKey is required for every orchestrator step.");
        if (existingKeyToId.has(stepKey) || newKeyToId.has(stepKey)) {
          throw new Error(`Duplicate stepKey: ${stepKey}`);
        }
        newKeyToId.set(stepKey, id);
        const dependencyStepKeys = normalizeDependencyStepKeys(input.dependencyStepKeys);
        dependencyStepKeysByNewStepKey.set(stepKey, dependencyStepKeys);
        return {
          id,
          input,
          stepIndex: Number.isFinite(input.stepIndex) ? input.stepIndex : maxExistingIndex + 1 + index,
          stepKey,
          dependencyStepKeys
        };
      });

      const existingGraphSteps: StepGraphValidationStep[] = existingSteps.map((step) => ({
        stepKey: step.stepKey,
        dependencyStepKeys: step.dependencyStepIds
          .map((depId) => existingKeyById.get(depId) ?? "")
          .filter((depKey): depKey is string => depKey.length > 0),
        joinPolicy: step.joinPolicy,
        quorumCount: step.quorumCount
      }));
      const newGraphSteps: StepGraphValidationStep[] = stepEntries.map(({ stepKey, dependencyStepKeys, input }) => ({
        stepKey,
        dependencyStepKeys,
        joinPolicy: normalizeJoinPolicy(String(input.joinPolicy ?? "all_success")),
        quorumCount: input.quorumCount != null ? Math.floor(Number(input.quorumCount)) : null
      }));
      validateStepGraphIntegrity({
        context: "addSteps",
        steps: [...existingGraphSteps, ...newGraphSteps]
      });

      // Insert step rows
      for (const { id, input, stepIndex, stepKey } of stepEntries) {
        const policy: Record<string, unknown> = {
          includeNarrative: input.policy?.includeNarrative === true,
          includeFullDocs: input.policy?.includeFullDocs === true,
          ...(typeof input.policy?.docsMaxBytes === "number" ? { docsMaxBytes: Math.floor(input.policy.docsMaxBytes) } : {}),
          claimScopes: Array.isArray(input.policy?.claimScopes)
            ? input.policy?.claimScopes?.map((scope) => ({
                scopeKind: scope.scopeKind,
                scopeValue: scope.scopeValue,
                ...(typeof scope.ttlMs === "number" ? { ttlMs: Math.floor(scope.ttlMs) } : {})
              }))
            : []
        };
        const metadataJson = JSON.stringify({
          ...(input.metadata ?? {}),
          ...(input.executorKind ? { executorKind: input.executorKind } : {}),
          policy
        });
        db.run(
          `
            insert into orchestrator_steps(
              id,
              run_id,
              project_id,
              mission_step_id,
              step_key,
              step_index,
              title,
              lane_id,
              status,
              join_policy,
              quorum_count,
              dependency_step_ids_json,
              retry_limit,
              retry_count,
              last_attempt_id,
              policy_json,
              metadata_json,
              created_at,
              updated_at,
              started_at,
              completed_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '[]', ?, 0, null, ?, ?, ?, ?, null, null)
          `,
          [
            id,
            runId,
            projectId,
            input.missionStepId ?? null,
            stepKey,
            stepIndex,
            input.title.trim() || stepKey,
            input.laneId ?? null,
            input.joinPolicy ?? "all_success",
            input.quorumCount ?? null,
            Math.max(0, Math.floor(input.retryLimit ?? 0)),
            JSON.stringify(policy),
            metadataJson,
            createdAt,
            createdAt
          ]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_registered",
          reason: "add_steps",
          detail: {
            stepKey,
            stepIndex,
            joinPolicy: input.joinPolicy ?? "all_success",
            retryLimit: Math.max(0, Math.floor(input.retryLimit ?? 0))
          }
        });
      }

      // Resolve dependency IDs from keys (can reference both existing and new steps)
      const combinedKeyToId = new Map([...existingKeyToId, ...newKeyToId]);
      for (const { id, stepKey } of stepEntries) {
        const depKeys = dependencyStepKeysByNewStepKey.get(stepKey) ?? [];
        const depIds = depKeys.map((key) => {
          const depId = combinedKeyToId.get(key);
          if (!depId) {
            throw new Error(`Unknown dependency stepKey '${key}' referenced by step '${stepKey}'.`);
          }
          return depId;
        });
        db.run(
          `
            update orchestrator_steps
            set dependency_step_ids_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [JSON.stringify(depIds), createdAt, id, runId, projectId]
        );
        appendTimelineEvent({
          runId,
          stepId: id,
          eventType: "step_dependencies_resolved",
          reason: "add_steps",
          detail: { dependencyStepIds: depIds }
        });
      }

      // Re-evaluate readiness and emit
      refreshStepReadiness(runId);
      emit({ type: "orchestrator-run-updated", runId, reason: "steps_added" });

      return stepEntries.map(({ id }) => {
        const row = getStepRow(id);
        if (!row) throw new Error(`Step not found after insertion: ${id}`);
        return toStep(row);
      });
    },

    skipStep(args: {
      runId: string;
      stepId: string;
      reason?: string;
    }): OrchestratorStep {
      const runId = String(args.runId ?? "").trim();
      const stepId = String(args.stepId ?? "").trim();
      if (!runId) throw new Error("runId is required.");
      if (!stepId) throw new Error("stepId is required.");

      const runRow = getRunRow(runId);
      if (!runRow) throw new Error(`Run not found: ${runId}`);
      const run = toRun(runRow);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new Error(`Cannot skip step in a terminal run (status: ${run.status}).`);
      }

      const stepRow = getStepRow(stepId);
      if (!stepRow || stepRow.run_id !== runId) throw new Error(`Step not found in run: ${stepId}`);
      const step = toStep(stepRow);
      if (TERMINAL_STEP_STATUSES.has(step.status)) {
        throw new Error(`Step is already terminal (status: ${step.status}).`);
      }

      const now = nowIso();
      const reason = args.reason?.trim() || "Manually skipped.";
      db.run(
        `
          update orchestrator_steps
          set status = 'skipped',
              updated_at = ?,
              completed_at = ?
          where id = ?
            and run_id = ?
            and project_id = ?
        `,
        [now, now, stepId, runId, projectId]
      );

      appendTimelineEvent({
        runId,
        stepId,
        eventType: "step_skipped",
        reason: "skip_step",
        detail: { reason }
      });
      emit({ type: "orchestrator-step-updated", runId, stepId, reason: "skipped" });

      // Re-evaluate downstream steps that may now be unblocked
      refreshStepReadiness(runId);

      // Re-derive run status
      const nextRunStatus = deriveRunStatusFromSteps(runId);
      const currentRunStatus = normalizeRunStatus(runRow.status);
      if (nextRunStatus !== currentRunStatus) {
        updateRunStatus(runId, nextRunStatus);
      }

      const updatedRow = getStepRow(stepId);
      if (!updatedRow) throw new Error(`Step not found after skip: ${stepId}`);
      return toStep(updatedRow);
    }
  };
}
