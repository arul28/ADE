/**
 * teamRuntimeState.ts
 *
 * Team runtime state management: register/update/query team members,
 * initialize/update/get team runtime state.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
} from "./orchestratorContext";
import {
  nowIso,
  parseJsonArray,
  parseJsonRecord,
} from "./orchestratorContext";
import type {
  OrchestratorTeamMember,
  OrchestratorTeamRuntimeState,
} from "../../../shared/types";

// ── Team Member Functions ────────────────────────────────────────

export function registerTeamMember(ctx: OrchestratorContext, member: OrchestratorTeamMember): void {
  ctx.db.run(
    `insert into orchestrator_team_members(
      id, run_id, mission_id, provider, model, role, session_id, status,
      claimed_task_ids_json, metadata_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      member.id, member.runId, member.missionId, member.provider, member.model,
      member.role, member.sessionId, member.status,
      JSON.stringify(member.claimedTaskIds), member.metadata ? JSON.stringify(member.metadata) : null,
      member.createdAt, member.updatedAt
    ]
  );
}

export function updateTeamMemberStatus(
  ctx: OrchestratorContext,
  memberId: string,
  updates: {
    status?: OrchestratorTeamMember["status"];
    sessionId?: string | null;
    claimedTaskIds?: string[];
  }
): void {
  const now = nowIso();
  if (updates.status) {
    ctx.db.run(
      `update orchestrator_team_members set status = ?, updated_at = ? where id = ?`,
      [updates.status, now, memberId]
    );
  }
  if (updates.sessionId !== undefined) {
    ctx.db.run(
      `update orchestrator_team_members set session_id = ?, updated_at = ? where id = ?`,
      [updates.sessionId, now, memberId]
    );
  }
  if (updates.claimedTaskIds) {
    ctx.db.run(
      `update orchestrator_team_members set claimed_task_ids_json = ?, updated_at = ? where id = ?`,
      [JSON.stringify(updates.claimedTaskIds), now, memberId]
    );
  }
}

export function getTeamMembersForRun(ctx: OrchestratorContext, runId: string): OrchestratorTeamMember[] {
  const rows = ctx.db.all<{
    id: string; run_id: string; mission_id: string; provider: string; model: string;
    role: string; session_id: string | null; status: string;
    claimed_task_ids_json: string; metadata_json: string | null;
    created_at: string; updated_at: string;
  }>(
    `select * from orchestrator_team_members where run_id = ? order by created_at asc`,
    [runId]
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    missionId: row.mission_id,
    provider: row.provider,
    model: row.model,
    role: row.role as OrchestratorTeamMember["role"],
    sessionId: row.session_id,
    status: row.status as OrchestratorTeamMember["status"],
    claimedTaskIds: parseJsonArray(row.claimed_task_ids_json) as string[],
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// ── Team Runtime State Functions ─────────────────────────────────

export function initTeamRuntimeState(
  ctx: OrchestratorContext,
  runId: string,
  coordinatorSessionId: string | null
): void {
  const now = nowIso();
  ctx.db.run(
    `insert into orchestrator_run_state(
      run_id, phase, completion_requested, completion_validated,
      last_validation_error, coordinator_session_id, teammate_ids_json,
      created_at, updated_at
    ) values (?, 'bootstrapping', 0, 0, null, ?, '[]', ?, ?)
    on conflict(run_id) do update set
      phase = 'bootstrapping',
      completion_requested = 0,
      completion_validated = 0,
      coordinator_session_id = excluded.coordinator_session_id,
      updated_at = excluded.updated_at`,
    [runId, coordinatorSessionId, now, now]
  );
  ctx.teamRuntimeStates.set(runId, {
    runId,
    phase: "bootstrapping",
    completionRequested: false,
    completionValidated: false,
    lastValidationError: null,
    coordinatorSessionId: coordinatorSessionId,
    teammateIds: [],
    createdAt: now,
    updatedAt: now,
  });
}

export function updateTeamRuntimePhase(
  ctx: OrchestratorContext,
  runId: string,
  phase: OrchestratorTeamRuntimeState["phase"],
  extra?: {
    coordinatorSessionId?: string | null;
    teammateIds?: string[];
    completionRequested?: boolean;
    completionValidated?: boolean;
    lastValidationError?: string | null;
  }
): void {
  const now = nowIso();
  const state = ctx.teamRuntimeStates.get(runId);
  if (state) {
    state.phase = phase;
    state.updatedAt = now;
    if (extra?.coordinatorSessionId !== undefined) state.coordinatorSessionId = extra.coordinatorSessionId;
    if (extra?.teammateIds) state.teammateIds = extra.teammateIds;
    if (extra?.completionRequested !== undefined) state.completionRequested = extra.completionRequested;
    if (extra?.completionValidated !== undefined) state.completionValidated = extra.completionValidated;
    if (extra?.lastValidationError !== undefined) state.lastValidationError = extra.lastValidationError;
  }
  ctx.db.run(
    `update orchestrator_run_state set phase = ?, updated_at = ? where run_id = ?`,
    [phase, now, runId]
  );
  if (extra?.coordinatorSessionId !== undefined) {
    ctx.db.run(
      `update orchestrator_run_state set coordinator_session_id = ? where run_id = ?`,
      [extra.coordinatorSessionId, runId]
    );
  }
  if (extra?.teammateIds) {
    ctx.db.run(
      `update orchestrator_run_state set teammate_ids_json = ? where run_id = ?`,
      [JSON.stringify(extra.teammateIds), runId]
    );
  }
  if (extra?.completionRequested !== undefined) {
    ctx.db.run(
      `update orchestrator_run_state set completion_requested = ? where run_id = ?`,
      [extra.completionRequested ? 1 : 0, runId]
    );
  }
  if (extra?.completionValidated !== undefined) {
    ctx.db.run(
      `update orchestrator_run_state set completion_validated = ? where run_id = ?`,
      [extra.completionValidated ? 1 : 0, runId]
    );
  }
  if (extra?.lastValidationError !== undefined) {
    ctx.db.run(
      `update orchestrator_run_state set last_validation_error = ? where run_id = ?`,
      [extra.lastValidationError, runId]
    );
  }
}

export function getTeamRuntimeStateForRun(
  ctx: OrchestratorContext,
  runId: string
): OrchestratorTeamRuntimeState | null {
  const cached = ctx.teamRuntimeStates.get(runId);
  if (cached) return cached;
  const row = ctx.db.get<{
    run_id: string; phase: string; completion_requested: number; completion_validated: number;
    last_validation_error: string | null; coordinator_session_id: string | null;
    teammate_ids_json: string; created_at: string; updated_at: string;
  }>(
    `select * from orchestrator_run_state where run_id = ? limit 1`,
    [runId]
  );
  if (!row) return null;
  const runtimeState: OrchestratorTeamRuntimeState = {
    runId: row.run_id,
    phase: row.phase as OrchestratorTeamRuntimeState["phase"],
    completionRequested: row.completion_requested === 1,
    completionValidated: row.completion_validated === 1,
    lastValidationError: row.last_validation_error,
    coordinatorSessionId: row.coordinator_session_id,
    teammateIds: parseJsonArray(row.teammate_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  ctx.teamRuntimeStates.set(runId, runtimeState);
  return runtimeState;
}
