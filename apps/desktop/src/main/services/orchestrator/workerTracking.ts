/**
 * workerTracking.ts
 *
 * Worker state management: getWorkerStates, getWorkerDigest, listWorkerDigests,
 * getContextCheckpoint, listLaneDecisions, worker state update functions.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
  AttemptRuntimeTracker,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  toOptionalString,
  clampLimit,
  MAX_THREAD_PAGE_SIZE,
} from "./orchestratorContext";
import type {
  OrchestratorWorkerState,
  OrchestratorWorkerStatus,
  OrchestratorWorkerDigest,
  OrchestratorContextCheckpoint,
  OrchestratorLaneDecision,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  ListOrchestratorWorkerDigestsArgs,
  GetOrchestratorWorkerDigestArgs,
  GetOrchestratorContextCheckpointArgs,
  ListOrchestratorLaneDecisionsArgs,
} from "../../../shared/types";

// ── Worker State Functions ───────────────────────────────────────

export function getWorkerStates(
  ctx: OrchestratorContext,
  args: { runId: string }
): OrchestratorWorkerState[] {
  const result: OrchestratorWorkerState[] = [];
  for (const state of ctx.workerStates.values()) {
    if (state.runId === args.runId) result.push(state);
  }
  return result;
}

export function upsertWorkerState(
  ctx: OrchestratorContext,
  attemptId: string,
  update: {
    stepId: string;
    runId: string;
    sessionId?: string | null;
    executorKind: OrchestratorExecutorKind;
    state: OrchestratorWorkerStatus;
    outcomeTags?: string[];
    completedAt?: string | null;
  }
): void {
  const now = nowIso();
  const existing = ctx.workerStates.get(attemptId);
  if (existing) {
    existing.state = update.state;
    existing.lastHeartbeatAt = now;
    if (update.sessionId !== undefined) existing.sessionId = update.sessionId;
    if (update.outcomeTags) existing.outcomeTags = update.outcomeTags;
    if (update.completedAt !== undefined) existing.completedAt = update.completedAt;
  } else {
    ctx.workerStates.set(attemptId, {
      attemptId,
      stepId: update.stepId,
      runId: update.runId,
      sessionId: update.sessionId ?? null,
      executorKind: update.executorKind,
      state: update.state,
      lastHeartbeatAt: now,
      spawnedAt: now,
      completedAt: update.completedAt ?? null,
      outcomeTags: update.outcomeTags ?? []
    });
  }
}

/**
 * Parse a worker digest row from the database.
 */
export function parseWorkerDigestRow(row: {
  id: string;
  mission_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  lane_id: string | null;
  session_id: string | null;
  step_key: string | null;
  status: string;
  summary: string;
  files_changed_json: string | null;
  tests_run_json: string | null;
  warnings_json: string | null;
  tokens_json: string | null;
  cost_usd: number | null;
  suggested_next_actions_json: string | null;
  created_at: string;
}): OrchestratorWorkerDigest {
  const filesChanged: string[] = (() => {
    try { return JSON.parse(row.files_changed_json ?? "[]"); } catch { return []; }
  })();
  const testsRun = (() => {
    try {
      const parsed = JSON.parse(row.tests_run_json ?? "{}");
      return {
        passed: Number(parsed.passed ?? 0),
        failed: Number(parsed.failed ?? 0),
        skipped: Number(parsed.skipped ?? 0),
        ...(parsed.summary ? { summary: String(parsed.summary) } : {})
      };
    } catch {
      return { passed: 0, failed: 0, skipped: 0 };
    }
  })();
  const warnings: string[] = (() => {
    try { return JSON.parse(row.warnings_json ?? "[]"); } catch { return []; }
  })();
  const tokens = (() => {
    try { return JSON.parse(row.tokens_json ?? "null"); } catch { return null; }
  })();
  const suggestedNextActions: string[] = (() => {
    try { return JSON.parse(row.suggested_next_actions_json ?? "[]"); } catch { return []; }
  })();

  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    stepId: row.step_id,
    stepKey: row.step_key,
    attemptId: row.attempt_id,
    laneId: row.lane_id ?? null,
    sessionId: row.session_id ?? null,
    status: row.status as OrchestratorWorkerDigest["status"],
    summary: row.summary,
    filesChanged,
    testsRun,
    warnings,
    tokens,
    costUsd: row.cost_usd ?? null,
    suggestedNextActions,
    createdAt: row.created_at
  };
}

export function listWorkerDigests(
  ctx: OrchestratorContext,
  digestArgs: ListOrchestratorWorkerDigestsArgs
): OrchestratorWorkerDigest[] {
  const runId = toOptionalString(digestArgs.runId);
  const missionId = toOptionalString(digestArgs.missionId);
  const limit = clampLimit(digestArgs.limit, 50, MAX_THREAD_PAGE_SIZE);

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (runId) {
    clauses.push("wd.run_id = ?");
    params.push(runId);
  }
  if (missionId) {
    clauses.push("wd.run_id IN (SELECT id FROM orchestrator_runs WHERE mission_id = ?)");
    params.push(missionId);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);

  const rows = ctx.db.all(
    `SELECT * FROM orchestrator_worker_digests wd ${whereClause} ORDER BY wd.created_at DESC LIMIT ?`,
    params
  ) as Array<any>;

  return rows.map((row) => parseWorkerDigestRow(row));
}

export function getWorkerDigest(
  ctx: OrchestratorContext,
  digestArgs: GetOrchestratorWorkerDigestArgs
): OrchestratorWorkerDigest | null {
  const digestId = toOptionalString(digestArgs.digestId);
  if (!digestId) return null;

  const row = ctx.db.get(
    `SELECT * FROM orchestrator_worker_digests WHERE id = ? LIMIT 1`,
    [digestId]
  ) as any;

  return row ? parseWorkerDigestRow(row) : null;
}

export function getContextCheckpoint(
  ctx: OrchestratorContext,
  checkpointArgs: GetOrchestratorContextCheckpointArgs
): OrchestratorContextCheckpoint | null {
  const missionId = toOptionalString(checkpointArgs.missionId);
  if (!missionId) return null;

  const checkpointId = toOptionalString(checkpointArgs.checkpointId);

  const row = ctx.db.get(
    checkpointId
      ? `SELECT * FROM orchestrator_context_checkpoints WHERE id = ? AND mission_id = ? LIMIT 1`
      : `SELECT * FROM orchestrator_context_checkpoints WHERE mission_id = ? ORDER BY created_at DESC LIMIT 1`,
    checkpointId ? [checkpointId, missionId] : [missionId]
  ) as any;

  if (!row) return null;

  const sourceData = (() => {
    try {
      const meta = JSON.parse(row.metadata_json ?? "{}");
      return {
        digestCount: Number(meta.digestCount ?? 0),
        chatMessageCount: Number(meta.chatMessageCount ?? 0),
        compressedMessageCount: Number(meta.compressedMessageCount ?? 0)
      };
    } catch {
      return { digestCount: 0, chatMessageCount: 0, compressedMessageCount: 0 };
    }
  })();

  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id ?? null,
    trigger: (row.checkpoint_type ?? row.trigger ?? "manual") as OrchestratorContextCheckpoint["trigger"],
    summary: row.content ?? row.summary ?? "",
    source: sourceData,
    createdAt: row.created_at
  };
}

export function listLaneDecisions(
  ctx: OrchestratorContext,
  laneArgs: ListOrchestratorLaneDecisionsArgs
): OrchestratorLaneDecision[] {
  const missionId = toOptionalString(laneArgs.missionId);
  const runId = toOptionalString(laneArgs.runId);
  const limit = clampLimit(laneArgs.limit, 50, MAX_THREAD_PAGE_SIZE);

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (missionId) {
    clauses.push("ld.mission_id = ?");
    params.push(missionId);
  }
  if (runId) {
    clauses.push("ld.run_id = ?");
    params.push(runId);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);

  const rows = ctx.db.all(
    `SELECT * FROM orchestrator_lane_decisions ld ${whereClause} ORDER BY ld.created_at DESC LIMIT ?`,
    params
  ) as Array<any>;

  return rows.map((row) => {
    const metadata = (() => {
      try { return JSON.parse(row.metadata_json ?? "null"); } catch { return null; }
    })();
    const ruleHits: string[] = (() => {
      try { return JSON.parse(row.rule_hits_json ?? "[]"); } catch { return []; }
    })();
    return {
      id: row.id,
      missionId: row.mission_id,
      runId: row.run_id ?? null,
      stepId: row.step_id ?? null,
      stepKey: row.step_key ?? null,
      laneId: row.lane_id ?? null,
      decisionType: (row.decision_type ?? "proposal") as OrchestratorLaneDecision["decisionType"],
      validatorOutcome: (row.validator_outcome ?? "pass") as OrchestratorLaneDecision["validatorOutcome"],
      ruleHits,
      rationale: row.rationale ?? row.reasoning ?? "",
      metadata,
      createdAt: row.created_at
    };
  });
}
