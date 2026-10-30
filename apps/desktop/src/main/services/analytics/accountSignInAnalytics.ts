import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";

export type AccountSignInSource = "browser" | "device_code";

type SignInOutcome = "started" | "completed" | "failed" | "cancelled";

type Attempt = {
  source: AccountSignInSource;
  /** Sign-in sessions of this attempt that have not finished. */
  open: Set<string>;
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
 * `oneAttempt` makes every session this tracker sees part of one attempt:
 * `ade login` starts a browser sign-in and a device sign-in side by side, and
 * whichever the person finishes signs the machine in. The attempt then ends
 * on the first success, or when its last open session fails or is cancelled.
 */
export function createAccountSignInAnalytics(options: {
  capture: (input: ProductAnalyticsCapture) => unknown;
  surface: ProductAnalyticsCapture["surface"];
  oneAttempt?: boolean;
}) {
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
    } catch {
      // Analytics never breaks a sign-in.
    }
  };

  const remember = (sessionId: string, attempt: Attempt): void => {
    attempt.open.add(sessionId);
    sessions.set(sessionId, attempt);
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  const end = (attempt: Attempt, outcome: Exclude<SignInOutcome, "started">): void => {
    if (attempt.ended) return;
    attempt.ended = true;
    record(outcome, attempt.source, outcome === "failed" ? attempt.errorKind ?? "other" : null);
  };

  /** One session of `attempt` is over; the attempt ends with its last one. */
  const close = (sessionId: string, attempt: Attempt): void => {
    attempt.open.delete(sessionId);
    sessions.delete(sessionId);
    if (attempt.open.size > 0) return;
    end(attempt, attempt.cancelled ? "cancelled" : "failed");
  };

  const openAttempt = (source: AccountSignInSource): Attempt => {
    if (options.oneAttempt && current && !current.ended) return current;
    const attempt: Attempt = { source, open: new Set(), ended: false, cancelled: false, errorKind: null };
    current = attempt;
    record("started", source);
    return attempt;
  };

  return {
    /** A sign-in session started; `sessionId` is what later polls name. */
    started(source: AccountSignInSource, sessionId: string | null | undefined): void {
      const attempt = openAttempt(source);
      const id = sessionId?.trim();
      if (id) remember(id, attempt);
    },

    /** A start that threw. Ends the attempt unless another of its sessions is still open. */
    startFailed(source: AccountSignInSource, error: unknown): void {
      const attempt = openAttempt(source);
      if (attempt.open.size > 0) return;
      attempt.errorKind = error instanceof Error ? error.message : String(error ?? "other");
      end(attempt, "failed");
    },

    /** A poll's answer. Only a terminal one counts. */
    polled(sessionId: string | null | undefined, status: unknown, message?: string | null): void {
      const id = sessionId?.trim();
      const attempt = id ? sessions.get(id) : undefined;
      if (!id || !attempt) return;
      if (status === "signed_in") {
        sessions.delete(id);
        attempt.open.delete(id);
        end(attempt, "completed");
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
