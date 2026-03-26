export type RecoveryState = {
  /** Number of recovery attempts for this session. */
  attempts: number;
  /** Last recovery attempt timestamp. */
  lastAttemptAt: number;
  /** Whether recovery is currently in progress. */
  recovering: boolean;
  /** The error that triggered recovery. */
  lastError: string | null;
};

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_BASE_MS = 2000;
const RECOVERY_COOLDOWN_MS = 30_000;

export function createRecoveryState(): RecoveryState {
  return {
    attempts: 0,
    lastAttemptAt: 0,
    recovering: false,
    lastError: null,
  };
}

export function canAttemptRecovery(state: RecoveryState): boolean {
  if (state.recovering) return false;
  if (state.attempts >= MAX_RECOVERY_ATTEMPTS) return false;
  const elapsed = Date.now() - state.lastAttemptAt;
  // After MAX_RECOVERY_ATTEMPTS, require a cooldown before resetting
  if (state.attempts >= MAX_RECOVERY_ATTEMPTS && elapsed < RECOVERY_COOLDOWN_MS) return false;
  return true;
}

export function getRecoveryBackoffMs(state: RecoveryState): number {
  return RECOVERY_BACKOFF_BASE_MS * Math.pow(2, Math.min(state.attempts, 4));
}

export function markRecoveryAttempt(state: RecoveryState, error: string): RecoveryState {
  return {
    ...state,
    attempts: state.attempts + 1,
    lastAttemptAt: Date.now(),
    recovering: true,
    lastError: error,
  };
}

export function markRecoveryComplete(state: RecoveryState): RecoveryState {
  return {
    ...state,
    recovering: false,
  };
}

export function markRecoverySuccess(state: RecoveryState): RecoveryState {
  return {
    ...state,
    attempts: 0,
    recovering: false,
    lastError: null,
  };
}

export function resetRecoveryState(state: RecoveryState): RecoveryState {
  if (state.attempts === 0 && !state.recovering) return state;
  return createRecoveryState();
}

/**
 * Determines if an error is recoverable (transient) vs terminal.
 * Terminal errors should not trigger recovery attempts.
 */
export function isRecoverableError(error: string | Error): boolean {
  const message = typeof error === "string" ? error : error.message;
  const lower = message.toLowerCase();

  // Terminal errors - don't retry
  if (lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("api key")) return false;
  if (lower.includes("billing") || lower.includes("quota exceeded") || lower.includes("rate limit")) return false;
  if (lower.includes("permission denied") || lower.includes("access denied")) return false;
  if (lower.includes("not found") && (lower.includes("model") || lower.includes("command"))) return false;

  // Recoverable errors - process crashes, network issues, timeouts
  if (lower.includes("econnreset") || lower.includes("econnrefused") || lower.includes("epipe")) return true;
  if (lower.includes("spawn") || lower.includes("sigterm") || lower.includes("sigkill")) return true;
  if (lower.includes("process exited") || lower.includes("child process")) return true;
  if (lower.includes("timeout") || lower.includes("timed out")) return true;
  if (lower.includes("stream") && (lower.includes("closed") || lower.includes("ended") || lower.includes("destroyed"))) return true;
  if (lower.includes("unexpected end") || lower.includes("connection closed")) return true;

  // Default: recoverable (optimistic)
  return true;
}

/**
 * Emits a system notice event for recovery status.
 */
export function createRecoveryNoticeEvent(args: {
  attempt: number;
  maxAttempts: number;
  error: string;
  status: "attempting" | "succeeded" | "failed";
}) {
  const message = args.status === "attempting"
    ? `Reconnecting to agent (attempt ${args.attempt}/${args.maxAttempts})...`
    : args.status === "succeeded"
      ? "Successfully reconnected to agent."
      : `Failed to reconnect after ${args.maxAttempts} attempts: ${args.error}`;

  return {
    type: "system_notice" as const,
    noticeKind: "provider_health" as const,
    message,
    detail: args.status === "failed" ? args.error : undefined,
  };
}
