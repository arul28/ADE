/**
 * The one way shared and service code reports to Sentry.
 *
 * This file imports no SDK. Each process that starts Sentry (Electron main,
 * the renderer, the brain, the web client) hands its SDK to `connectSentry`
 * right after `init`; until then, and in every process that never starts
 * Sentry, each call here is a cheap no-op. So callers never check first, and
 * a bundle that only reports (the renderer's entry chunk) carries no
 * Sentry code.
 *
 * What may go in: error objects, messages, ids, names, counts, durations,
 * paths. What may not: prompt or transcript text, model output, file
 * contents, terminal output (see `docs/logging.md`, "Error tracking").
 * `scrub.ts` removes secrets on the way out regardless.
 */

export type CaptureContext = {
  /** Low-cardinality labels to search and group by: provider, channel, action. */
  tags?: Record<string, string | number | boolean | null | undefined>;
  /** Extra detail shown on the event. Scrubbed before sending. */
  extra?: Record<string, unknown>;
  /** Overrides Sentry's grouping; one fingerprint is one issue and one budget. */
  fingerprint?: string[];
  level?: "fatal" | "error" | "warning" | "info";
  /** True when ADE caught the error and carried on. */
  handled?: boolean;
};

type SentryLevel = NonNullable<CaptureContext["level"]>;

type SentryScope = {
  setTag(key: string, value: string): unknown;
  setExtras(extras: Record<string, unknown>): unknown;
  setFingerprint(fingerprint: string[]): unknown;
  setLevel(level: SentryLevel): unknown;
  setUser?(user: { id: string } | null): unknown;
};

type LogAttributes = Record<string, unknown>;

/** The part of a Sentry SDK this file uses; every SDK ADE loads has it. */
export type SentryApi = {
  withScope(callback: (scope: SentryScope) => void): unknown;
  captureException(error: unknown, hint?: { mechanism?: { type: string; handled: boolean } }): unknown;
  addBreadcrumb(breadcrumb: { category: string; message: string; level: SentryLevel; data?: Record<string, unknown> }): unknown;
  /** Absent in the renderer SDK, whose events leave through main. */
  flush?(timeoutMs?: number): PromiseLike<boolean>;
  /** User Feedback; used from main only (`main/sentry/userFeedback.ts`). */
  captureFeedback?(params: {
    message: string;
    source?: string;
    associatedEventId?: string;
    tags?: Record<string, string>;
  }): string;
  lastEventId?(): string | undefined;
  logger: {
    /** Optional: release-health lines only (`logBridge.ts`). */
    info?(message: string, attributes?: LogAttributes): unknown;
    warn(message: string, attributes?: LogAttributes): unknown;
    error(message: string, attributes?: LogAttributes): unknown;
  };
};

let sentry: SentryApi | null = null;

/** Called once by the module that ran `Sentry.init` in this process. */
export function connectSentry(api: SentryApi): void {
  sentry = api;
}

export function isSentryActive(): boolean {
  return sentry !== null;
}

/** Report a failure that has an error object. Non-errors are wrapped so they keep a stack. */
export function captureError(error: unknown, context?: CaptureContext): void {
  const api = sentry;
  if (!api) return;
  const value = error instanceof Error ? error : new Error(typeof error === "string" ? error : safeDescribe(error));
  api.withScope((scope) => {
    for (const [key, tag] of Object.entries(context?.tags ?? {})) {
      if (tag !== undefined && tag !== null) scope.setTag(key, String(tag));
    }
    if (context?.extra) scope.setExtras(context.extra);
    if (context?.fingerprint?.length) scope.setFingerprint(context.fingerprint);
    if (context?.level) scope.setLevel(context.level);
    api.captureException(value, { mechanism: { type: "ade", handled: context?.handled ?? true } });
  });
}

/**
 * A failure ADE detected without an error object: a provider went unhealthy, a
 * probe came back empty, a logger.error line. Sent as an `AdeProblem` so the
 * issue is titled by the message and keeps the stack of the code that noticed.
 */
class AdeProblem extends Error {
  override name = "AdeProblem";
}

export function captureProblem(message: string, context?: CaptureContext): void {
  if (!sentry) return;
  captureError(new AdeProblem(message), { level: "error", ...context });
}

/** Context for the next error: what the user or the app just did. */
export function addSentryBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: "info" | "warning" | "error" = "info",
): void {
  sentry?.addBreadcrumb({ category, message, data, level });
}

/** A line for Sentry Logs (searchable, never an issue). */
export function sendSentryLog(level: "info" | "warn" | "error", message: string, attributes: LogAttributes): void {
  try {
    sentry?.logger[level]?.(message, attributes);
  } catch {
    // Logging must never throw into the caller.
  }
}

/**
 * Send User Feedback: words a person chose to send. Feedback skips
 * `beforeSend`, so the caller scrubs `message` and names the user. Returns the
 * feedback id, or null where Sentry is not running.
 */
export function captureUserFeedback(args: {
  message: string;
  source: string;
  userId?: string | null;
  tags?: Record<string, string>;
}): string | null {
  const api = sentry;
  if (!api?.captureFeedback) return null;
  let feedbackId: string | null = null;
  try {
    api.withScope((scope) => {
      if (args.userId) scope.setUser?.({ id: args.userId });
      feedbackId = api.captureFeedback?.({
        message: args.message,
        source: args.source,
        // The newest event this process reported, so the note opens beside it.
        associatedEventId: api.lastEventId?.() || undefined,
        tags: args.tags,
      }) ?? null;
    });
  } catch {
    return null;
  }
  return feedbackId;
}

export async function flushSentry(timeoutMs = 2_000): Promise<boolean> {
  if (!sentry?.flush) return true;
  try {
    return await sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}

function safeDescribe(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, 500);
  } catch {
    return String(value);
  }
}
