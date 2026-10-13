/**
 * Client-side quota protection for Sentry.
 *
 * The Developer plan has 5,000 errors a month for the whole organization and
 * no server-side rate limits, so one broken provider or a crash loop on a
 * single machine could spend the month in an afternoon. Every process keeps
 * its own budget: a few events per fingerprint per hour, and a hard total per
 * hour. The first events of a problem go through, which is what matters for
 * finding it; the thousandth copy adds nothing. Once the hourly total is
 * spent, a new problem in the same hour is dropped too: the total is the
 * guarantee, and it is sized so that takes a dozen different failures.
 */

export type SentryBudget = {
  perFingerprintPerHour: number;
  totalPerHour: number;
};

export const DEFAULT_SENTRY_BUDGET: SentryBudget = {
  perFingerprintPerHour: 5,
  totalPerHour: 60,
};

/**
 * Crashes get their own, looser budget so the ordinary one can never starve
 * them, and so a process that survives its uncaught exceptions (or throws many
 * while it shuts down) still cannot spend the quota.
 */
export const FATAL_SENTRY_BUDGET: SentryBudget = {
  perFingerprintPerHour: 10,
  totalPerHour: 30,
};

const HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_FINGERPRINTS = 500;

export type EventLimiter = {
  /** True when the event may be sent; records it against the budget. */
  admit: (fingerprint: string, nowMs?: number) => boolean;
};

export function createEventLimiter(budget: SentryBudget = DEFAULT_SENTRY_BUDGET): EventLimiter {
  let windowStart = 0;
  let total = 0;
  const perFingerprint = new Map<string, number>();
  return {
    admit(fingerprint, nowMs = Date.now()) {
      if (nowMs - windowStart >= HOUR_MS) {
        windowStart = nowMs;
        total = 0;
        perFingerprint.clear();
      }
      if (total >= budget.totalPerHour) return false;
      const seen = perFingerprint.get(fingerprint) ?? 0;
      if (seen >= budget.perFingerprintPerHour) return false;
      if (!perFingerprint.has(fingerprint) && perFingerprint.size >= MAX_TRACKED_FINGERPRINTS) return false;
      perFingerprint.set(fingerprint, seen + 1);
      total += 1;
      return true;
    },
  };
}

/** Errors that are expected outcomes, not bugs. Matched against the exception value or message. */
const IGNORED_ERROR_PATTERNS: readonly RegExp[] = [
  /ResizeObserver loop/i,
  /\bERR_ABORTED\b|\(-3\) loading/,
  /^AbortError\b|The operation was aborted|This operation was aborted|Request aborted/i,
  /\bEPIPE\b|ERR_STREAM_DESTROYED|write after end/i,
  /Non-Error promise rejection captured with value: undefined/,
  // The renderer's copy of a failed IPC call. Main already reported it, with
  // the channel and the real stack (`main/sentry/ipcCapture.ts`).
  // A call to a channel with no handler never reached main, so it stays.
  /^(?:Error: )?Error invoking remote method '[^']+': (?!(?:Error: )?No handler registered)/,
  // Sync turned off (or no project registered yet) is a state, not a failure;
  // presence and other sync calls answer with this on every lane change.
  /Sync service is not available/,
];

type FingerprintSource = {
  fingerprint?: string[];
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string; stacktrace?: { frames?: Array<{ filename?: string; function?: string; lineno?: number }> } }> };
  tags?: Record<string, unknown>;
};

/**
 * The key the limiter counts against: the explicit fingerprint when the call
 * site set one, else the error type plus its top in-app frame, else the
 * message. Close enough to Sentry's own grouping that one issue maps to one
 * budget.
 */
export function eventBudgetKey(event: FingerprintSource): string {
  if (event.fingerprint?.length) return event.fingerprint.join("|");
  const exception = event.exception?.values?.[event.exception.values.length - 1];
  if (exception) {
    const frames = exception.stacktrace?.frames ?? [];
    const top = frames[frames.length - 1];
    const where = top ? `${top.filename ?? ""}:${top.function ?? ""}:${top.lineno ?? ""}` : (exception.value ?? "").slice(0, 120);
    return `${exception.type ?? "Error"}|${where}`;
  }
  return `message|${(event.message ?? "").slice(0, 160)}`;
}

export function isIgnoredEvent(event: FingerprintSource): boolean {
  const texts = [
    event.message ?? "",
    ...(event.exception?.values ?? []).map((value) => `${value.type ?? ""}: ${value.value ?? ""}`),
  ];
  return texts.some((text) => text && IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(text)));
}
