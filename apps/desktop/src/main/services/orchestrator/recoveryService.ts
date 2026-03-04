/**
 * recoveryService.ts
 *
 * Failure recovery: handleFailedAttemptRecovery, applyAiRetryDecisionForFailedAttempt,
 * runHealthSweep, recovery diagnosis logic, health sweep implementation.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
  AttemptRuntimeTracker,
} from "./orchestratorContext";
import {
  nowIso,
  digestSignalText,
  parseTerminalRuntimeState,
  ATTEMPT_RUNTIME_PERSIST_INTERVAL_MS,
} from "./orchestratorContext";
import { getErrorMessage } from "../shared/utils";
import type {
  OrchestratorExecutorKind,
  TerminalRuntimeState,
} from "../../../shared/types";

// ── Attempt Runtime Tracker Helpers ──────────────────────────────

export function ensureAttemptRuntimeTracker(
  ctx: OrchestratorContext,
  attemptId: string
): AttemptRuntimeTracker {
  const existing = ctx.attemptRuntimeTrackers.get(attemptId);
  if (existing) return existing;
  const next: AttemptRuntimeTracker = {
    lastPreviewDigest: null,
    digestSinceMs: Date.now(),
    repeatCount: 0,
    lastWaitingInterventionAtMs: 0,
    lastEventHeartbeatAtMs: 0,
    lastWaitingNotifiedAtMs: 0,
    lastQuestionThreadId: null,
    lastQuestionMessageId: null,
    lastPersistedAtMs: 0
  };
  ctx.attemptRuntimeTrackers.set(attemptId, next);
  return next;
}

/**
 * Update attempt stagnation tracker.
 */
export function updateAttemptStagnationTracker(
  ctx: OrchestratorContext,
  attemptId: string,
  preview: string | null
): { digest: string | null; stagnantMs: number } {
  const tracker = ensureAttemptRuntimeTracker(ctx, attemptId);
  const now = Date.now();
  const digest = digestSignalText(preview);
  if (!digest) {
    tracker.lastPreviewDigest = null;
    tracker.repeatCount = 0;
    tracker.digestSinceMs = now;
    return { digest: null, stagnantMs: 0 };
  }
  if (tracker.lastPreviewDigest !== digest) {
    tracker.lastPreviewDigest = digest;
    tracker.repeatCount = 1;
    tracker.digestSinceMs = now;
    return { digest, stagnantMs: 0 };
  }
  tracker.repeatCount += 1;
  return { digest, stagnantMs: Math.max(0, now - tracker.digestSinceMs) };
}

/**
 * Get recent session activity timestamp.
 */
export function getRecentSessionActivityAt(
  ctx: OrchestratorContext,
  sessionState: { sessionId?: string | null; at?: string }
): number {
  const sessionId = sessionState.sessionId;
  if (!sessionId) return 0;
  const signal = ctx.sessionRuntimeSignals.get(sessionId);
  return signal ? Date.parse(signal.at) : 0;
}

/**
 * Get recent attempt event activity timestamp.
 */
export function getRecentAttemptEventActivityAt(
  ctx: OrchestratorContext,
  attemptId: string
): number {
  const tracker = ctx.attemptRuntimeTrackers.get(attemptId);
  return tracker?.lastEventHeartbeatAtMs ?? 0;
}

// ── Session DB Query Functions ──────────────────────────────────

export type TrackedSessionState = {
  laneId: string | null;
  status: string;
  endedAt: string | null;
  exitCode: number | null;
  lastOutputAt: string | null;
  lastOutputPreview: string | null;
  transcriptPath: string | null;
};

export function getTrackedSessionState(
  ctx: OrchestratorContext,
  sessionId: string
): TrackedSessionState | null {
  const row = ctx.db.get<{
    lane_id: string | null;
    status: string | null;
    ended_at: string | null;
    exit_code: number | null;
    last_output_at: string | null;
    last_output_preview: string | null;
    transcript_path: string | null;
  }>(
    `
      select lane_id, status, ended_at, exit_code, last_output_at, last_output_preview, transcript_path
      from terminal_sessions
      where id = ?
      limit 1
    `,
    [sessionId]
  );
  if (!row) return null;
  return {
    laneId: row.lane_id ?? null,
    status: String(row.status ?? "").trim().toLowerCase(),
    endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
    exitCode: Number.isFinite(Number(row.exit_code)) ? Number(row.exit_code) : null,
    lastOutputAt: typeof row.last_output_at === "string" ? row.last_output_at : null,
    lastOutputPreview: typeof row.last_output_preview === "string" ? row.last_output_preview : null,
    transcriptPath: typeof row.transcript_path === "string" ? row.transcript_path : null
  };
}

export type RunningAttemptForSession = {
  attemptId: string;
  runId: string;
  stepId: string;
  executorKind: OrchestratorExecutorKind;
  attemptMetadataJson: string | null;
  runMetadataJson: string | null;
};

// ── Hydration ───────────────────────────────────────────────────

/**
 * Hydrate persisted attempt runtime trackers and session signals from the DB on startup.
 */
export function hydratePersistedAttemptRuntimeState(
  ctx: OrchestratorContext
): void {
  const nowMs = Date.now();
  try {
    ctx.db.run(
      `
        delete from orchestrator_attempt_runtime
        where attempt_id in (
          select r.attempt_id
          from orchestrator_attempt_runtime r
          left join orchestrator_attempts a on a.id = r.attempt_id
          where a.id is null or a.status != 'running'
        )
      `
    );
  } catch (error) {
    ctx.logger.warn("ai_orchestrator.runtime_state_prune_failed", {
      error: getErrorMessage(error)
    });
  }

  const rows = ctx.db.all<{
    attempt_id: string;
    session_id: string | null;
    runtime_state: string | null;
    last_signal_at: string | null;
    last_output_preview: string | null;
    last_preview_digest: string | null;
    digest_since_ms: number | null;
    repeat_count: number | null;
    last_waiting_intervention_at_ms: number | null;
    last_event_heartbeat_at_ms: number | null;
    last_waiting_notified_at_ms: number | null;
  }>(
    `
      select
        r.attempt_id as attempt_id,
        r.session_id as session_id,
        r.runtime_state as runtime_state,
        r.last_signal_at as last_signal_at,
        r.last_output_preview as last_output_preview,
        r.last_preview_digest as last_preview_digest,
        r.digest_since_ms as digest_since_ms,
        r.repeat_count as repeat_count,
        r.last_waiting_intervention_at_ms as last_waiting_intervention_at_ms,
        r.last_event_heartbeat_at_ms as last_event_heartbeat_at_ms,
        r.last_waiting_notified_at_ms as last_waiting_notified_at_ms
      from orchestrator_attempt_runtime r
      join orchestrator_attempts a on a.id = r.attempt_id
      where a.status = 'running'
    `
  );
  if (!rows.length) return;

  for (const row of rows) {
    const attemptId = String(row.attempt_id ?? "").trim();
    if (!attemptId.length) continue;
    const tracker: AttemptRuntimeTracker = {
      lastPreviewDigest: typeof row.last_preview_digest === "string" ? row.last_preview_digest : null,
      digestSinceMs: Number.isFinite(Number(row.digest_since_ms))
        ? Math.max(0, Math.floor(Number(row.digest_since_ms)))
        : nowMs,
      repeatCount: Number.isFinite(Number(row.repeat_count))
        ? Math.max(0, Math.floor(Number(row.repeat_count)))
        : 0,
      lastWaitingInterventionAtMs: Number.isFinite(Number(row.last_waiting_intervention_at_ms))
        ? Math.max(0, Math.floor(Number(row.last_waiting_intervention_at_ms)))
        : 0,
      lastEventHeartbeatAtMs: Number.isFinite(Number(row.last_event_heartbeat_at_ms))
        ? Math.max(0, Math.floor(Number(row.last_event_heartbeat_at_ms)))
        : 0,
      lastWaitingNotifiedAtMs: Number.isFinite(Number(row.last_waiting_notified_at_ms))
        ? Math.max(0, Math.floor(Number(row.last_waiting_notified_at_ms)))
        : 0,
      lastQuestionThreadId: null,
      lastQuestionMessageId: null,
      lastPersistedAtMs: nowMs
    };
    ctx.attemptRuntimeTrackers.set(attemptId, tracker);

    const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
    const runtimeState = parseTerminalRuntimeState(row.runtime_state);
    const at = typeof row.last_signal_at === "string" && row.last_signal_at.trim().length ? row.last_signal_at : nowIso();
    if (!sessionId.length || !runtimeState) continue;
    const existing = ctx.sessionRuntimeSignals.get(sessionId);
    if (existing) {
      const existingMs = Date.parse(existing.at);
      const nextMs = Date.parse(at);
      if (Number.isFinite(existingMs) && Number.isFinite(nextMs) && existingMs > nextMs) {
        continue;
      }
    }
    ctx.sessionRuntimeSignals.set(sessionId, {
      laneId: null,
      sessionId,
      runtimeState,
      lastOutputPreview:
        typeof row.last_output_preview === "string" && row.last_output_preview.trim().length
          ? row.last_output_preview.trim()
          : null,
      at
    });
  }
}

export function listRunningAttemptsForSession(
  ctx: OrchestratorContext,
  sessionId: string
): RunningAttemptForSession[] {
  const rows = ctx.db.all<{
    attempt_id: string;
    run_id: string;
    step_id: string;
    executor_kind: string | null;
    attempt_metadata_json: string | null;
    run_metadata_json: string | null;
  }>(
    `
      select
        a.id as attempt_id,
        a.run_id as run_id,
        a.step_id as step_id,
        a.executor_kind as executor_kind,
        a.metadata_json as attempt_metadata_json,
        r.metadata_json as run_metadata_json
      from orchestrator_attempts a
      join orchestrator_runs r on r.id = a.run_id
      where a.status = 'running'
        and a.executor_session_id = ?
      order by a.created_at asc
    `,
    [sessionId]
  );
  return rows
    .map((row) => {
      const executorKindRaw = String(row.executor_kind ?? "").trim();
      const executorKind: OrchestratorExecutorKind =
        executorKindRaw === "claude" || executorKindRaw === "codex" || executorKindRaw === "shell" || executorKindRaw === "manual"
          ? executorKindRaw
          : "manual";
      return {
        attemptId: row.attempt_id,
        runId: row.run_id,
        stepId: row.step_id,
        executorKind,
        attemptMetadataJson: row.attempt_metadata_json ?? null,
        runMetadataJson: row.run_metadata_json ?? null
      };
    })
    .filter((row) => row.attemptId.length > 0 && row.runId.length > 0 && row.stepId.length > 0);
}

// ── Runtime State Persistence ───────────────────────────────────

export function deletePersistedAttemptRuntimeState(
  ctx: OrchestratorContext,
  attemptId: string
): void {
  try {
    ctx.db.run(`delete from orchestrator_attempt_runtime where attempt_id = ?`, [attemptId]);
  } catch (error) {
    ctx.logger.warn("ai_orchestrator.runtime_state_delete_failed", {
      attemptId,
      error: getErrorMessage(error)
    });
  }
}

export function persistAttemptRuntimeState(
  ctx: OrchestratorContext,
  args: {
    attemptId: string;
    sessionId: string | null;
    runtimeState: TerminalRuntimeState | null;
    lastSignalAt: string | null;
    lastOutputPreview: string | null;
    force?: boolean;
  }
): void {
  const attemptId = String(args.attemptId ?? "").trim();
  if (!attemptId.length) return;
  const tracker = ensureAttemptRuntimeTracker(ctx, attemptId);
  const nowMs = Date.now();
  if (!args.force && nowMs - tracker.lastPersistedAtMs < ATTEMPT_RUNTIME_PERSIST_INTERVAL_MS) return;
  const updatedAt = nowIso();
  try {
    ctx.db.run(
      `
        insert into orchestrator_attempt_runtime(
          attempt_id,
          session_id,
          runtime_state,
          last_signal_at,
          last_output_preview,
          last_preview_digest,
          digest_since_ms,
          repeat_count,
          last_waiting_intervention_at_ms,
          last_event_heartbeat_at_ms,
          last_waiting_notified_at_ms,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(attempt_id) do update set
          session_id = excluded.session_id,
          runtime_state = excluded.runtime_state,
          last_signal_at = excluded.last_signal_at,
          last_output_preview = excluded.last_output_preview,
          last_preview_digest = excluded.last_preview_digest,
          digest_since_ms = excluded.digest_since_ms,
          repeat_count = excluded.repeat_count,
          last_waiting_intervention_at_ms = excluded.last_waiting_intervention_at_ms,
          last_event_heartbeat_at_ms = excluded.last_event_heartbeat_at_ms,
          last_waiting_notified_at_ms = excluded.last_waiting_notified_at_ms,
          updated_at = excluded.updated_at
      `,
      [
        attemptId,
        args.sessionId,
        args.runtimeState,
        args.lastSignalAt,
        args.lastOutputPreview,
        tracker.lastPreviewDigest,
        Math.max(0, Math.floor(tracker.digestSinceMs)),
        Math.max(0, Math.floor(tracker.repeatCount)),
        Math.max(0, Math.floor(tracker.lastWaitingInterventionAtMs)),
        Math.max(0, Math.floor(tracker.lastEventHeartbeatAtMs)),
        Math.max(0, Math.floor(tracker.lastWaitingNotifiedAtMs)),
        updatedAt
      ]
    );
    tracker.lastPersistedAtMs = nowMs;
  } catch (error) {
    ctx.logger.warn("ai_orchestrator.runtime_state_persist_failed", {
      attemptId,
      error: getErrorMessage(error)
    });
  }
}
