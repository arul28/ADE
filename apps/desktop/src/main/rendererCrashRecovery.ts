/**
 * Recovery policy for a dead renderer process.
 *
 * A lost renderer used to be terminal: the window stayed white while the agents
 * behind it kept running, and only a manual restart brought the UI back.
 * Reloading recovers it — renderer state is rehydrated from the main process, so
 * a reload costs a repaint, not data.
 *
 * The budget exists because the failure this guards against and the failure it
 * could cause are the same shape: a renderer that dies *during boot* would
 * reload-loop forever. After the budget is spent the window stays down, which is
 * at least visible and reportable.
 */

/** Electron's `RenderProcessGoneDetails["reason"]` values. */
export type RenderProcessGoneReason =
  | "clean-exit"
  | "abnormal-exit"
  | "killed"
  | "crashed"
  | "oom"
  | "launch-failed"
  | "integrity-failure"
  | (string & {});

export const RENDERER_RECOVERY_DELAY_MS = 500;
export const RENDERER_RECOVERY_WINDOW_MS = 60_000;
export const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;

export type RendererRecoveryDecision =
  | { recover: true; attempt: number }
  | { recover: false; cause: "clean-exit" | "budget-exhausted"; attempts: number };

/**
 * `clean-exit` is an orderly teardown (app quit, window close). Every other
 * reason — including `killed`, which is what an external `kill` of the renderer
 * process produces — is a renderer we lost and should get back.
 */
export function isRecoverableRenderProcessGone(reason: RenderProcessGoneReason): boolean {
  return reason !== "clean-exit";
}

export function createRendererCrashRecoveryBudget(options: {
  maxAttempts?: number;
  windowMs?: number;
} = {}) {
  const maxAttempts = options.maxAttempts ?? RENDERER_RECOVERY_MAX_ATTEMPTS;
  const windowMs = options.windowMs ?? RENDERER_RECOVERY_WINDOW_MS;
  /** Timestamps of recovery attempts inside the rolling window. */
  const attempts: number[] = [];

  return {
    /**
     * Records and authorizes one recovery attempt. `now` is injected so the
     * rolling window is testable and monotonic with the caller's clock.
     */
    requestAttempt(reason: RenderProcessGoneReason, now: number): RendererRecoveryDecision {
      if (!isRecoverableRenderProcessGone(reason)) {
        return { recover: false, cause: "clean-exit", attempts: attempts.length };
      }
      while (attempts.length > 0 && now - attempts[0] > windowMs) attempts.shift();
      if (attempts.length >= maxAttempts) {
        return { recover: false, cause: "budget-exhausted", attempts: attempts.length };
      }
      attempts.push(now);
      return { recover: true, attempt: attempts.length };
    },
  };
}

export type RendererCrashRecoveryBudget = ReturnType<typeof createRendererCrashRecoveryBudget>;

/**
 * The reason values a lost renderer can report, minus `clean-exit` — which is
 * not a loss and never reaches analytics.
 *
 * Exported because the analytics property allowlist is built from it. Two
 * hand-maintained copies of an enum drift, and the drift is silent here: a value
 * this normalizer emits but the allowlist rejects ships an event stripped of its
 * only payload.
 */
export const RENDERER_GONE_ANALYTICS_REASONS = [
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
] as const;

/** The bucket a future Electron string normalizes into. */
export const RENDERER_GONE_UNKNOWN_REASON = "unknown";

const KNOWN_RENDER_PROCESS_GONE_REASONS: ReadonlySet<string> = new Set<string>([
  "clean-exit",
  ...RENDERER_GONE_ANALYTICS_REASONS,
]);

export function coarseRenderProcessGoneReason(reason: RenderProcessGoneReason): string {
  return KNOWN_RENDER_PROCESS_GONE_REASONS.has(reason) ? reason : RENDERER_GONE_UNKNOWN_REASON;
}
