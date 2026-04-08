/**
 * orchestratorQueries.ts
 *
 * Row types, SQL column constants, normalizer functions, and row-to-domain
 * mappers extracted from orchestratorService.ts. These are pure functions
 * that don't depend on factory closure state.
 */

import type {
  MissionStepHandoff,
  OrchestratorAttempt,
  OrchestratorAttemptResultEnvelope,
  OrchestratorAttemptStatus,
  OrchestratorClaim,
  OrchestratorClaimScope,
  OrchestratorClaimState,
  OrchestratorContextProfileId,
  OrchestratorContextPolicyProfile,
  OrchestratorContextSnapshot,
  OrchestratorContextSnapshotCursor,
  OrchestratorErrorClass,
  OrchestratorExecutorKind,
  OrchestratorGateReport,
  OrchestratorJoinPolicy,
  OrchestratorRun,
  OrchestratorRunStatus,
  OrchestratorRuntimeBusEvent,
  OrchestratorRuntimeEventType,
  OrchestratorStep,
  OrchestratorStepStatus,
  OrchestratorTimelineEvent,
  OrchestratorArtifact,
  OrchestratorArtifactKind,
} from "../../../shared/types";
import { parseJsonRecord, parseJsonArray } from "./orchestratorContext";

// ── Row Types ──────────────────────────────────────────────────────

export type RunRow = {
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

export type StepRow = {
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

export type AttemptRow = {
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

export type ClaimRow = {
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

export type ContextSnapshotRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  attempt_id: string | null;
  snapshot_type: string;
  context_profile: string;
  cursor_json: string;
  created_at: string;
};

export type HandoffRow = {
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

export type TimelineRow = {
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

export type RuntimeEventRow = {
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

export type GateReportRow = {
  id: string;
  generated_at: string;
  report_json: string;
};

export type ArtifactRow = {
  id: string;
  project_id: string;
  mission_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  artifact_key: string;
  kind: string;
  value: string;
  metadata_json: string;
  declared: number;
  created_at: string;
};

// ── Constants ──────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_PROFILE_ID = "orchestrator_deterministic_v1";

export const DEFAULT_CONTEXT_POLICY: OrchestratorContextPolicyProfile = {
  id: DEFAULT_CONTEXT_PROFILE_ID,
  docsMode: "digest_refs",
  laneExportLevel: "standard",
  projectExportLevel: "lite",
  maxDocBytes: 120_000,
};

export const TERMINAL_RUN_STATUSES = new Set<OrchestratorRunStatus>(["succeeded", "failed", "canceled"]);
export const RETRYABLE_ERROR_CLASSES = new Set<OrchestratorErrorClass>([
  "transient",
  "startup_failure",
  "executor_failure",
  "interrupted",
  "claim_conflict",
  "resume_recovered"
]);
export const MAX_TIMELINE_LIMIT = 1_000;

export const GATE_THRESHOLDS = {
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

// ── Normalizer Functions ───────────────────────────────────────────

export function normalizeIsoTimestamp(value: unknown, fallbackIso: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.length) return fallbackIso;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return fallbackIso;
  return new Date(ms).toISOString();
}

export function normalizeRunStatus(value: string): OrchestratorRunStatus {
  if (
    value === "queued" ||
    value === "bootstrapping" ||
    value === "active" ||
    value === "paused" ||
    value === "completing" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  return "queued";
}

export function normalizeStepStatus(value: string): OrchestratorStepStatus {
  if (
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "blocked" ||
    value === "skipped" ||
    value === "superseded" ||
    value === "canceled"
  ) {
    return value;
  }
  return "pending";
}

export function normalizeAttemptStatus(value: string): OrchestratorAttemptStatus {
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

export function normalizeExecutorKind(value: string): OrchestratorExecutorKind {
  if (value === "unified") {
    return "opencode";
  }
  if (
    value === "claude"
    || value === "codex"
    || value === "cursor"
    || value === "opencode"
    || value === "shell"
    || value === "manual"
  ) {
    return value;
  }
  return "manual";
}

export function normalizeErrorClass(value: string): OrchestratorErrorClass {
  if (
    value === "none" ||
    value === "transient" ||
    value === "deterministic" ||
    value === "policy" ||
    value === "claim_conflict" ||
    value === "startup_failure" ||
    value === "executor_failure" ||
    value === "interrupted" ||
    value === "configuration_error" ||
    value === "canceled" ||
    value === "resume_recovered" ||
    value === "planner_contract_violation" ||
    value === "soft_success_blocking_failure"
  ) {
    return value;
  }
  return "none";
}

export function normalizeJoinPolicy(value: string): OrchestratorJoinPolicy {
  if (value === "all_success" || value === "any_success" || value === "quorum" || value === "advisory") return value;
  return "all_success";
}

export function normalizeClaimScope(value: string): OrchestratorClaimScope {
  if (value === "lane" || value === "file" || value === "env" || value === "task") return value;
  return "lane";
}

export function normalizeClaimState(value: string): OrchestratorClaimState {
  if (value === "active" || value === "released" || value === "expired") return value;
  return "active";
}

export function normalizeRuntimeEventType(value: string): OrchestratorRuntimeEventType {
  if (
    value === "progress" ||
    value === "heartbeat" ||
    value === "question" ||
    value === "blocked" ||
    value === "done" ||
    value === "retry_scheduled" ||
    value === "retry_exhausted" ||
    value === "planning_artifact_missing" ||
    value === "claim_conflict" ||
    value === "session_ended" ||
    value === "intervention_opened" ||
    value === "intervention_resolved" ||
    value === "coordinator_steering" ||
    value === "coordinator_broadcast" ||
    value === "coordinator_skip" ||
    value === "coordinator_add_step" ||
    value === "coordinator_pause" ||
    value === "coordinator_parallelize" ||
    value === "coordinator_consolidate" ||
    value === "coordinator_shutdown" ||
    value === "step_dependencies_updated" ||
    value === "step_metadata_updated" ||
    value === "fan_out_dispatched" ||
    value === "fan_out_complete" ||
    value === "worker_status_report" ||
    value === "worker_result_report" ||
    value === "worker_message" ||
    value === "plan_revised" ||
    value === "lane_transfer" ||
    value === "validation_report" ||
    value === "validation_contract_unfulfilled" ||
    value === "validation_self_check_reminder" ||
    value === "validation_auto_spawned" ||
    value === "validation_gate_blocked" ||
    value === "reflection_added" ||
    value === "retrospective_generated" ||
    value === "tool_profiles_updated"
  ) {
    return value;
  }
  return "progress";
}

export function normalizeProfileId(value: string | null | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : DEFAULT_CONTEXT_PROFILE_ID;
}

export function normalizeTerminalSessionStatus(value: unknown): "running" | "completed" | "failed" | "disposed" | "unknown" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "running" || normalized === "completed" || normalized === "failed" || normalized === "disposed") {
    return normalized;
  }
  return "unknown";
}

// ── Parse Helpers ──────────────────────────────────────────────────

export function parseArray(raw: string | null): string[] {
  return parseJsonArray(raw)
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

export function isExecutionPolicyRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return "planning" in rec && "implementation" in rec;
}

export function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asIntInRange(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

export function asNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

export function asPositiveNumberOrNull(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

// ── Row-to-Domain Mappers ──────────────────────────────────────────

export function toRun(row: RunRow): OrchestratorRun {
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
    metadata: parseJsonRecord(row.metadata_json)
  };
}

export function toStep(row: StepRow): OrchestratorStep {
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
    metadata: parseJsonRecord(row.metadata_json)
  };
}

function parseResultEnvelope(json: string | null): OrchestratorAttemptResultEnvelope | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as OrchestratorAttemptResultEnvelope;
  } catch {
    return null;
  }
}

export function toAttempt(row: AttemptRow): OrchestratorAttempt {
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
    resultEnvelope: parseResultEnvelope(row.result_envelope_json),
    metadata: parseJsonRecord(row.metadata_json)
  };
}

export function toClaim(row: ClaimRow): OrchestratorClaim {
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
    policy: parseJsonRecord(row.policy_json),
    metadata: parseJsonRecord(row.metadata_json)
  };
}

function normalizeSnapshotType(value: string): "run" | "step" | "attempt" {
  if (value === "step") return "step";
  if (value === "attempt") return "attempt";
  return "run";
}

const DEFAULT_CURSOR: OrchestratorContextSnapshotCursor = {
  lanePackKey: null,
  lanePackVersionId: null,
  lanePackVersionNumber: null,
  projectPackKey: "project",
  projectPackVersionId: null,
  projectPackVersionNumber: null,
  packDeltaSince: null,
  docs: []
};

function parseCursorJson(json: string): OrchestratorContextSnapshotCursor {
  try {
    return JSON.parse(json) as OrchestratorContextSnapshotCursor;
  } catch {
    return { ...DEFAULT_CURSOR };
  }
}

export function toContextSnapshot(row: ContextSnapshotRow): OrchestratorContextSnapshot {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    snapshotType: normalizeSnapshotType(row.snapshot_type),
    contextProfile: normalizeProfileId(row.context_profile),
    cursor: parseCursorJson(row.cursor_json),
    createdAt: row.created_at
  };
}

export function toHandoff(row: HandoffRow): MissionStepHandoff {
  return {
    id: row.id,
    missionId: row.mission_id,
    missionStepId: row.mission_step_id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    handoffType: row.handoff_type,
    producer: row.producer,
    payload: parseJsonRecord(row.payload_json) ?? {},
    createdAt: row.created_at
  };
}

export function toArtifact(row: ArtifactRow): OrchestratorArtifact {
  const kind = row.kind as OrchestratorArtifactKind;
  const validKinds: OrchestratorArtifactKind[] = ["file", "branch", "pr", "test_report", "checkpoint", "custom"];
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    artifactKey: row.artifact_key,
    kind: validKinds.includes(kind) ? kind : "custom",
    value: row.value,
    metadata: parseJsonRecord(row.metadata_json) ?? {},
    declared: row.declared === 1,
    createdAt: row.created_at
  };
}

export function toTimelineEvent(row: TimelineRow): OrchestratorTimelineEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    claimId: row.claim_id,
    eventType: row.event_type,
    reason: row.reason,
    detail: parseJsonRecord(row.detail_json),
    createdAt: row.created_at
  };
}

export function toRuntimeEvent(row: RuntimeEventRow): OrchestratorRuntimeBusEvent {
  const payload = parseJsonRecord(row.payload_json);
  const threadId = typeof payload?.threadId === "string" ? payload.threadId.trim() : "";
  const messageId = typeof payload?.messageId === "string" ? payload.messageId.trim() : "";
  const replyToRaw = typeof payload?.replyTo === "string" ? payload.replyTo.trim() : "";
  const questionLink =
    threadId.length > 0 && messageId.length > 0
      ? {
          threadId,
          messageId,
          replyTo: replyToRaw.length > 0 ? replyToRaw : null
        }
      : null;
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    eventType: normalizeRuntimeEventType(row.event_type),
    eventKey: row.event_key,
    occurredAt: row.occurred_at,
    payload,
    questionLink,
    createdAt: row.created_at
  };
}

export function toGateReport(row: GateReportRow): OrchestratorGateReport | null {
  try {
    const parsed = JSON.parse(row.report_json) as OrchestratorGateReport;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeEnvelope(
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

// ── Graph Validation ───────────────────────────────────────────────

export type StepGraphValidationStep = {
  stepKey: string;
  dependencyStepKeys: string[];
  joinPolicy: OrchestratorJoinPolicy;
  quorumCount: number | null;
};

export function normalizeDependencyStepKeys(dependencyStepKeys: string[] | undefined): string[] {
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

export function validateStepGraphIntegrity(args: {
  context: "startRun" | "addSteps" | "updateStepDependencies" | "consolidateSteps";
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

// ── Miscellaneous Helpers ──────────────────────────────────────────

export function branchNameFromRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed.length) return "";
  return trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
}

export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 14))}\n...<truncated>`;
}

// ── Blocking Warning Classification ────────────────────────────────

/**
 * Classify warnings from a succeeded attempt to detect blocking failures
 * that should override the success status.
 */
export type BlockingWarningClassification = {
  hasBlockingFailure: boolean;
  category: 'sandbox_block' | 'permission_denied' | 'tool_failure' | 'missing_auth' | 'worker_no_output' | 'planner_contract_violation' | null;
  detail: string | null;
};

const BLOCKING_WARNING_PATTERNS: Array<{ pattern: RegExp; category: BlockingWarningClassification['category'] }> = [
  { pattern: /PLANNER CONTRACT VIOLATION/i, category: 'planner_contract_violation' },
  { pattern: /SANDBOX BLOCKED/i, category: 'sandbox_block' },
  { pattern: /sandbox.?block/i, category: 'sandbox_block' },
  { pattern: /File path outside sandbox/i, category: 'sandbox_block' },
  { pattern: /PreToolUse:\w+ hook error/i, category: 'tool_failure' },
  { pattern: /permission denied/i, category: 'permission_denied' },
  { pattern: /EPERM|EACCES/i, category: 'permission_denied' },
  { pattern: /validation failed for tool/i, category: 'tool_failure' },
  { pattern: /zod validation.*tool/i, category: 'tool_failure' },
  { pattern: /tool .+ failed/i, category: 'tool_failure' },
  { pattern: /tool startup fail/i, category: 'tool_failure' },
  { pattern: /needs-auth/i, category: 'missing_auth' },
  { pattern: /authentication required/i, category: 'missing_auth' },
  { pattern: /unauthorized/i, category: 'missing_auth' },
];

// External MCP auth warnings that should NOT be treated as blocking
const EXTERNAL_MCP_NOISE_PATTERNS: RegExp[] = [
  /claude\.ai\s+\S+:needs-auth/i,
  /claude\.ai\s+Gmail/i,
  /claude\.ai\s+Google Calendar/i,
  /claude\.ai\s+Google Drive/i,
  /claude\.ai\s+Slack/i,
];

export function classifyBlockingWarnings(args: {
  warnings: string[];
  summary: string | null;
}): BlockingWarningClassification {
  const { warnings, summary } = args;

  // Combine all text to scan
  const textsToScan = [...warnings];
  if (summary) textsToScan.push(summary);

  for (const text of textsToScan) {
    // Skip external MCP noise
    const isExternalNoise = EXTERNAL_MCP_NOISE_PATTERNS.some(p => p.test(text));
    if (isExternalNoise) continue;

    for (const { pattern, category } of BLOCKING_WARNING_PATTERNS) {
      if (pattern.test(text)) {
        return {
          hasBlockingFailure: true,
          category,
          detail: text.slice(0, 500),
        };
      }
    }
  }

  return { hasBlockingFailure: false, category: null, detail: null };
}
