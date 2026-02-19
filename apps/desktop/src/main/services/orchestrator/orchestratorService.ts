import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
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
  OrchestratorJoinPolicy,
  OrchestratorRun,
  OrchestratorRunStatus,
  OrchestratorStep,
  OrchestratorStepStatus,
  PackExport,
  PtyCreateArgs,
  StartOrchestratorRunArgs,
  StartOrchestratorRunStepInput
} from "../../../shared/types";
import type { AdeDb, SqlValue } from "../state/kvDb";
import type { createPackService } from "../packs/packService";
import type { createPtyService } from "../pty/ptyService";

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
};

export type OrchestratorExecutorAdapter = {
  kind: OrchestratorExecutorKind;
  start: (args: OrchestratorExecutorStartArgs) => Promise<OrchestratorExecutorStartResult>;
};

const DEFAULT_CONTEXT_PROFILE_ID: OrchestratorContextProfileId = "orchestrator_deterministic_v1";
const DEFAULT_CLAIM_TTL_MS = 45_000;

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

function nowIso(): string {
  return new Date().toISOString();
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
  if (value === "claude" || value === "codex" || value === "gemini" || value === "shell" || value === "manual") return value;
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

function normalizeProfileId(value: string | null | undefined): OrchestratorContextProfileId {
  if (value === "orchestrator_narrative_opt_in_v1") return value;
  return DEFAULT_CONTEXT_PROFILE_ID;
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

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
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
  return {
    ...base,
    docsMode: args.stepPolicy.includeFullDocs ? "full_docs" : base.docsMode,
    maxDocBytes:
      typeof args.stepPolicy.docsMaxBytes === "number" && Number.isFinite(args.stepPolicy.docsMaxBytes) && args.stepPolicy.docsMaxBytes > 0
        ? Math.floor(args.stepPolicy.docsMaxBytes)
        : base.maxDocBytes
  };
}

export function createOrchestratorService({
  db,
  projectId,
  projectRoot,
  packService,
  ptyService,
  onEvent
}: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  packService: ReturnType<typeof createPackService>;
  ptyService?: ReturnType<typeof createPtyService>;
  onEvent?: (event: OrchestratorEvent) => void;
}) {
  const adapters = new Map<OrchestratorExecutorKind, OrchestratorExecutorAdapter>();

  const emit = (event: Omit<OrchestratorEvent, "at">) => {
    onEvent?.({
      ...event,
      at: nowIso()
    });
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
  };

  const expireClaims = () => {
    const now = nowIso();
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
          args.scopeValue,
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
    if (count > 0) emit({ type: "orchestrator-claim-updated", attemptId: args.attemptId, reason: "released" });
    return count;
  };

  const evaluateDependencyGate = (step: OrchestratorStep, statusesById: Map<string, OrchestratorStepStatus>) => {
    if (!step.dependencyStepIds.length) {
      return { satisfied: true, permanentlyBlocked: false };
    }
    const depStatuses = step.dependencyStepIds.map((id) => statusesById.get(id) ?? "pending");
    const successCount = depStatuses.filter((status) => status === "succeeded" || status === "skipped").length;
    const allTerminal = depStatuses.every((status) => TERMINAL_STEP_STATUSES.has(status));
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
    const statusesById = new Map<string, OrchestratorStepStatus>(steps.map((step) => [step.id, step.status] as const));
    const now = nowIso();

    for (const step of steps) {
      if (step.status === "running" || TERMINAL_STEP_STATUSES.has(step.status)) continue;
      const gate = evaluateDependencyGate(step, statusesById);
      const stepPolicy = resolveStepPolicy(step);
      const claimScoped = (stepPolicy.claimScopes ?? []).length > 0;
      let next: OrchestratorStepStatus = step.status;
      if (gate.satisfied) {
        if (step.status === "pending" || step.status === "blocked") next = "ready";
      } else if (gate.permanentlyBlocked) {
        next = "blocked";
      } else {
        next = "pending";
      }

      if (next === "ready" && claimScoped && step.status === "blocked") {
        // Claim conflicts can clear when claims expire/release.
        const conflicts = (stepPolicy.claimScopes ?? []).some((scope) => {
          const row = db.get<{ id: string }>(
            `
              select id
              from orchestrator_claims
              where project_id = ?
                and state = 'active'
                and scope_kind = ?
                and scope_value = ?
              limit 1
            `,
            [projectId, scope.scopeKind, scope.scopeValue]
          );
          return Boolean(row?.id);
        });
        if (conflicts) next = "blocked";
      }

      if (next !== step.status) {
        db.run(
          `
            update orchestrator_steps
            set status = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [next, now, step.id, runId, projectId]
        );
        statusesById.set(step.id, next);
        emit({ type: "orchestrator-step-updated", runId, stepId: step.id, reason: "readiness_recomputed" });
      }
    }
  };

  const deriveRunStatusFromSteps = (runId: string): OrchestratorRunStatus => {
    const steps = listStepRows(runId).map(toStep);
    if (!steps.length) return "succeeded";
    const statuses = steps.map((step) => step.status);
    if (statuses.every((status) => status === "succeeded" || status === "skipped")) return "succeeded";
    if (statuses.some((status) => status === "failed")) return "failed";
    if (statuses.some((status) => status === "running")) return "running";
    if (statuses.some((status) => status === "ready" || status === "pending")) return "running";
    if (statuses.some((status) => status === "blocked")) return "paused";
    if (statuses.every((status) => status === "canceled")) return "canceled";
    return "running";
  };

  const createContextSnapshotForAttempt = async (args: {
    run: OrchestratorRun;
    step: OrchestratorStep;
    attemptId: string;
    contextProfile: OrchestratorContextPolicyProfile;
  }): Promise<CreateSnapshotResult> => {
    const lanePackKey = args.step.laneId ? `lane:${args.step.laneId}` : null;
    const laneExport = args.step.laneId
      ? await packService.getLaneExport({
          laneId: args.step.laneId,
          level: args.contextProfile.laneExportLevel
        })
      : null;
    const projectExport = await packService.getProjectExport({
      level: args.contextProfile.projectExportLevel
    });

    const docsPaths = readDocPaths(projectRoot);
    let remainingBytes = args.contextProfile.maxDocBytes;
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

    const laneHead = lanePackKey ? packService.getHeadVersion({ packKey: lanePackKey }) : null;
    const projectHead = packService.getHeadVersion({ packKey: "project" });
    const existingCursor = (() => {
      if (!args.run.metadata) return null;
      const raw = args.run.metadata.runtimeCursor;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      return raw as Record<string, unknown>;
    })();
    const cursor: OrchestratorContextSnapshotCursor = {
      lanePackKey,
      lanePackVersionId: laneHead?.versionId ?? null,
      lanePackVersionNumber: laneHead?.versionNumber ?? null,
      projectPackKey: "project",
      projectPackVersionId: projectHead.versionId,
      projectPackVersionNumber: projectHead.versionNumber,
      packDeltaSince: typeof existingCursor?.packDeltaSince === "string" ? existingCursor.packDeltaSince : null,
      docs: docsRefs
    };

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

    listRuns(args: { status?: OrchestratorRunStatus; limit?: number } = {}): OrchestratorRun[] {
      const where: string[] = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.status) {
        where.push("status = ?");
        params.push(args.status);
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

      const byKey = new Map<string, string>();
      const stepRows = [...args.steps]
        .sort((a, b) => a.stepIndex - b.stepIndex || a.stepKey.localeCompare(b.stepKey))
        .map((input, index) => {
          const id = randomUUID();
          const stepKey = input.stepKey.trim();
          if (!stepKey) throw new Error("stepKey is required for every orchestrator step.");
          if (byKey.has(stepKey)) throw new Error(`Duplicate stepKey in run: ${stepKey}`);
          byKey.set(stepKey, id);
          return {
            id,
            input,
            createdAt,
            order: Number.isFinite(input.stepIndex) ? input.stepIndex : index
          };
        });

      for (const { id, input, createdAt: created } of stepRows) {
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
            input.stepKey.trim(),
            Number.isFinite(input.stepIndex) ? Math.floor(input.stepIndex) : 0,
            input.title.trim() || input.stepKey.trim(),
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
      }

      // Fill resolved dependency IDs after all step rows exist.
      for (const { id, input } of stepRows) {
        const depKeys = input.dependencyStepKeys ?? [];
        const depIds = depKeys
          .map((key) => byKey.get(key.trim()) ?? null)
          .filter((value): value is string => Boolean(value));
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

      const updated = getRunRow(args.runId);
      if (!updated) throw new Error(`Run not found after tick: ${args.runId}`);
      return toRun(updated);
    },

    heartbeatClaims(args: { attemptId: string; ownerId: string }): number {
      const now = nowIso();
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
        const ttlMsRaw = Number(policy.ttlMs ?? DEFAULT_CLAIM_TTL_MS);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : DEFAULT_CLAIM_TTL_MS;
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
        const claim = acquireClaim({
          runId: run.id,
          stepId: step.id,
          attemptId,
          ownerId: args.ownerId.trim() || "orchestrator",
          scopeKind: scope.scopeKind,
          scopeValue: scope.scopeValue,
          ttlMs: scope.ttlMs ?? DEFAULT_CLAIM_TTL_MS,
          policy: { ttlMs: scope.ttlMs ?? DEFAULT_CLAIM_TTL_MS }
        });
        if (!claim) {
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
              `Claim collision for ${scope.scopeKind}:${scope.scopeValue}`,
              JSON.stringify({ ownerId: args.ownerId, claimScope: scope }),
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
              scopeValue: scope.scopeValue,
              contextProfile: contextPolicy.id
            }
          });
          emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId, reason: "claim_blocked" });
          this.tick({ runId: run.id });
          const blockedRow = getAttemptRow(attemptId);
          if (!blockedRow) throw new Error("Failed to create blocked attempt.");
          return toAttempt(blockedRow);
        }
        acquiredClaims.push(claim);
      }

      const snapshot = await createContextSnapshotForAttempt({
        run,
        step,
        attemptId,
        contextProfile: contextPolicy
      });

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
            docsCount: snapshot.docsRefs.length
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

      const attemptRow = getAttemptRow(attemptId);
      if (!attemptRow) throw new Error("Attempt creation failed.");
      const attempt = toAttempt(attemptRow);

      const adapter = adapters.get(executorKind);
      if (adapter) {
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
            })
        });
        if (result.status === "accepted") {
          const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
          if (sessionId) {
            db.run(
              `
                update orchestrator_attempts
                set executor_session_id = ?,
                    metadata_json = ?,
                    updated_at = ?
                where id = ?
                  and project_id = ?
              `,
              [
                sessionId,
                JSON.stringify({
                  ...(attempt.metadata ?? {}),
                  ...(result.metadata ?? {})
                }),
                nowIso(),
                attempt.id,
                projectId
              ]
            );
            emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId: attempt.id, reason: "session_attached" });
          }
          return toAttempt(getAttemptRow(attempt.id) ?? attemptRow);
        }
        if (result.status === "completed") {
          return this.completeAttempt({
            attemptId: attempt.id,
            status: "succeeded",
            result: result.result
          });
        }
        return this.completeAttempt({
          attemptId: attempt.id,
          status: "failed",
          errorClass: result.errorClass ?? "executor_failure",
          errorMessage: result.errorMessage,
          metadata: result.metadata ?? null
        });
      }

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
      const status = args.status;
      const errorClass = status === "failed" ? args.errorClass ?? "executor_failure" : status === "canceled" ? "canceled" : "none";
      const defaultSummary =
        status === "succeeded"
          ? "Step completed."
          : status === "failed"
            ? args.errorMessage?.trim() || "Step attempt failed."
            : status === "blocked"
              ? args.errorMessage?.trim() || "Step attempt blocked."
              : "Step attempt canceled.";
      const envelope: OrchestratorAttemptResultEnvelope =
        args.result ??
        ({
          schema: "ade.orchestratorAttempt.v1",
          success: status === "succeeded",
          summary: defaultSummary,
          outputs: null,
          warnings: status === "failed" || status === "blocked" ? [defaultSummary] : [],
          sessionId: attemptRow.executor_session_id,
          trackedSession: true
        } satisfies OrchestratorAttemptResultEnvelope);

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
          args.errorMessage ?? null,
          Math.max(0, Math.floor(args.retryBackoffMs ?? 0)),
          JSON.stringify(envelope),
          JSON.stringify({
            ...(parseRecord(attemptRow.metadata_json) ?? {}),
            ...(args.metadata ?? {})
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
        db.run(
          `
            update orchestrator_steps
            set status = 'blocked',
                updated_at = ?,
                last_attempt_id = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [completedAt, args.attemptId, step.id, run.id, projectId]
        );
      } else {
        const retryable = RETRYABLE_ERROR_CLASSES.has(errorClass);
        const retryRemaining = step.retryCount < step.retryLimit;
        const shouldRetry = retryable && retryRemaining;
        if (shouldRetry) {
          db.run(
            `
              update orchestrator_steps
              set status = 'ready',
                  retry_count = retry_count + 1,
                  updated_at = ?,
                  last_attempt_id = ?
              where id = ?
                and run_id = ?
                and project_id = ?
            `,
            [completedAt, args.attemptId, step.id, run.id, projectId]
          );
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
          errorMessage: args.errorMessage ?? null,
          retryBackoffMs: Math.max(0, Math.floor(args.retryBackoffMs ?? 0)),
          result: envelope
        }
      });

      emit({ type: "orchestrator-attempt-updated", runId: run.id, stepId: step.id, attemptId: args.attemptId, reason: "completed" });
      emit({ type: "orchestrator-step-updated", runId: run.id, stepId: step.id, reason: "attempt_completed" });

      const updatedRun = this.tick({ runId: run.id });
      if (updatedRun.status === "failed") {
        db.run(
          `
            update orchestrator_runs
            set last_error = ?,
                updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [args.errorMessage ?? defaultSummary, nowIso(), run.id, projectId]
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
      }

      const resumed = this.tick({ runId: run.id });
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
    }
  };
}
