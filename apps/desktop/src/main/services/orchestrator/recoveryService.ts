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
  SessionRuntimeSignal,
  MissionRuntimeProfile,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  classifyFailureTier,
  HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT,
  STALE_ATTEMPT_GRACE_MS,
  ACTIVE_ATTEMPT_STATUSES,
} from "./orchestratorContext";
import type {
  OrchestratorRunGraph,
  RecoveryDiagnosis,
  RecoveryDiagnosisTier,
  RecoveryLoopPolicy,
  RecoveryLoopIteration,
  RecoveryLoopState,
} from "../../../shared/types";
import {
  DEFAULT_RECOVERY_LOOP_POLICY,
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
    digestSinceMs: 0,
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
  const { digestSignalText } = require("./orchestratorContext");
  const digest = digestSignalText(preview);

  if (digest !== tracker.lastPreviewDigest) {
    tracker.lastPreviewDigest = digest;
    tracker.digestSinceMs = Date.now();
    tracker.repeatCount = 0;
    return { digest, stagnantMs: 0 };
  }

  tracker.repeatCount++;
  const stagnantMs = Date.now() - tracker.digestSinceMs;
  return { digest, stagnantMs };
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
