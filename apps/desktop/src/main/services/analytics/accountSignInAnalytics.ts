import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";

export type AccountSignInSource = "browser" | "device_code";

type SignInOutcome = "started" | "completed" | "failed" | "cancelled";

type Attempt = {
  source: AccountSignInSource;
  /** Sign-in sessions of this attempt that have not finished, with the method each one uses. */
  open: Map<string, AccountSignInSource>;
  ended: boolean;
  cancelled: boolean;
  errorKind: string | null;
};

/** Sessions remembered at once; an abandoned one is forgotten oldest first. */
const MAX_TRACKED_SESSIONS = 32;

/**
 * The ADE account sign-in funnel, on `ade_feature_used` rather than an event
 * of its own: `feature: "account_sign_in"`, `action: "sign_in"`, `outcome`
 * `started`, then exactly one of `completed`, `failed` (with a coarse
 * `error_kind`) or `cancelled`, and `source` `browser` or `device_code`.
 *
 * Fired once per attempt, never per poll: a poll only counts when it is the
 * one that ends its session. It runs while the person is still anonymous; the
 * `$identify` that follows a completed sign-in merges that id into the account.
 *
 * {@link createSharedAttemptSignInAnalytics} makes every session part of one attempt:
 * `ade login` starts a browser sign-in and a device sign-in side by side, and
 * whichever the person finishes signs the machine in. The attempt then ends
 * on the first success, or when its last open session fails or is cancelled.
 */
type AccountSignInAnalyticsOptions = {
  capture: (input: ProductAnalyticsCapture) => unknown;
  surface: ProductAnalyticsCapture["surface"];
  /** Told when a capture throws; sign-in carries on regardless. */
  onCaptureError?: (error: unknown) => void;
};

/** One attempt per sign-in session: the desktop's browser and device flows. */
export function createAccountSignInAnalytics(options: AccountSignInAnalyticsOptions) {
  return createTracker(options, false);
}

/** Every session is one attempt: `ade login` runs a browser and a device sign-in side by side. */
export function createSharedAttemptSignInAnalytics(options: AccountSignInAnalyticsOptions) {
  return createTracker(options, true);
}

function createTracker(options: AccountSignInAnalyticsOptions, oneAttempt: boolean) {
  const sessions = new Map<string, Attempt>();
  let current: Attempt | null = null;

  const record = (outcome: SignInOutcome, source: AccountSignInSource, errorKind?: string | null): void => {
    try {
      options.capture({
        event: "ade_feature_used",
        surface: options.surface,
        properties: {
          feature: "account_sign_in",
          action: "sign_in",
          outcome,
          source,
          // Coarsened to a fixed bucket by the analytics policy; the text never leaves.
          ...(errorKind ? { error_kind: errorKind } : {}),
        },
        projectId: null,
      });
    } catch (error) {
      // Analytics never breaks a sign-in.
      options.onCaptureError?.(error);
    }
  };

  const remember = (sessionId: string, attempt: Attempt, source: AccountSignInSource): void => {
    attempt.open.set(sessionId, source);
    sessions.set(sessionId, attempt);
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  /** `source` is the method of the session that ended the attempt, so `ade login` finished on a phone counts as `device_code`. */
  const end = (attempt: Attempt, outcome: Exclude<SignInOutcome, "started">, source: AccountSignInSource): void => {
    if (attempt.ended) return;
    attempt.ended = true;
    record(outcome, source, outcome === "failed" ? attempt.errorKind ?? "other" : null);
  };

  /** One session of `attempt` is over; the attempt ends with its last one. */
  const close = (sessionId: string, attempt: Attempt): void => {
    const source = attempt.open.get(sessionId) ?? attempt.source;
    attempt.open.delete(sessionId);
    sessions.delete(sessionId);
    if (attempt.open.size > 0) return;
    end(attempt, attempt.cancelled ? "cancelled" : "failed", source);
  };

  const openAttempt = (source: AccountSignInSource): Attempt => {
    if (oneAttempt && current && !current.ended) return current;
    const attempt: Attempt = { source, open: new Map(), ended: false, cancelled: false, errorKind: null };
    current = attempt;
    record("started", source);
    return attempt;
  };

  return {
    /** A sign-in session started; `sessionId` is what later polls name. */
    started(source: AccountSignInSource, sessionId: string | null | undefined): void {
      const attempt = openAttempt(source);
      const id = sessionId?.trim();
      if (id) remember(id, attempt, source);
    },

    /** A start that threw. Ends the attempt unless another of its sessions is still open. */
    startFailed(source: AccountSignInSource, error: unknown): void {
      const attempt = openAttempt(source);
      if (attempt.open.size > 0) return;
      attempt.errorKind = error instanceof Error ? error.message : String(error ?? "other");
      end(attempt, "failed", source);
    },

    /** A poll's answer. Only a terminal one counts. */
    polled(sessionId: string | null | undefined, status: unknown, message?: string | null): void {
      const id = sessionId?.trim();
      const attempt = id ? sessions.get(id) : undefined;
      if (!id || !attempt) return;
      if (status === "signed_in") {
        const source = attempt.open.get(id) ?? attempt.source;
        sessions.delete(id);
        attempt.open.delete(id);
        end(attempt, "completed", source);
        return;
      }
      if (status !== "expired" && status !== "error") return;
      attempt.errorKind = status === "expired" ? "expired" : message || "other";
      close(id, attempt);
    },

    cancelled(sessionId: string | null | undefined): void {
      const id = sessionId?.trim();
      const attempt = id ? sessions.get(id) : undefined;
      if (!id || !attempt) return;
      attempt.cancelled = true;
      close(id, attempt);
    },
  };
}

export type AccountSignInAnalytics = ReturnType<typeof createAccountSignInAnalytics>;
