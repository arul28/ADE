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

/** The client hook that says how a send went; `statusCode` is absent when the transport failed. */
type SentryClient = {
  on?(
    hook: "afterSendEvent",
    callback: (event: { event_id?: string }, response: { statusCode?: number } | undefined) => void,
  ): (() => void) | void;
};

/** The part of a Sentry SDK this file uses; every SDK ADE loads has it. */
export type SentryApi = {
  withScope(callback: (scope: SentryScope) => void): unknown;
  /** Returns the event id. */
  captureException(error: unknown, hint?: { mechanism?: { type: string; handled: boolean } }): unknown;
  addBreadcrumb(breadcrumb: { category: string; message: string; level: SentryLevel; data?: Record<string, unknown> }): unknown;
  /** Absent in the renderer SDK, whose events leave through main. */
  flush?(timeoutMs?: number): PromiseLike<boolean>;
  /** User Feedback: main's "Send a report" note, and the web client's Report issue. */
  captureFeedback?(params: {
    message: string;
    source?: string;
    associatedEventId?: string;
    tags?: Record<string, string>;
  }): string;
  lastEventId?(): string | undefined;
  getClient?(): SentryClient | undefined;
  logger: {
    /** Optional: release-health lines only (`logBridge.ts`). */
    info?(message: string, attributes?: LogAttributes): unknown;
    warn(message: string, attributes?: LogAttributes): unknown;
    error(message: string, attributes?: LogAttributes): unknown;
  };
};

/** Longest User Feedback message ADE sends; Sentry keeps a few thousand characters. */
export const SENTRY_FEEDBACK_MAX_CHARS = 2_000;

/** How long `confirmSentryDelivery` waits for the transport before it answers no. */
const DELIVERY_TIMEOUT_MS = 10_000;

let sentry: SentryApi | null = null;
let resolveUserId: (() => string | null | undefined) | null = null;

/** Called once by the module that ran `Sentry.init` in this process. */
export function connectSentry(api: SentryApi): void {
  sentry = api;
}

export function isSentryActive(): boolean {
  return sentry !== null;
}

/**
 * Where events get their pseudonymous user: the same id PostHog sends as
 * `distinct_id` (the hashed ADE account once signed in, else the install's
 * random id), so one person can be followed across both. Read at send time,
 * so sign-in and sign-out need no wiring of their own. Null when the user has
 * product analytics off; the event then carries no user.
 *
 * Kept here rather than beside `beforeSend` (`eventFilter.ts`) so a caller
 * that sends User Feedback, which skips `beforeSend`, does not load the filter.
 */
export function setSentryUserResolver(resolver: (() => string | null | undefined) | null): void {
  resolveUserId = resolver;
}

let resolveMachineId: (() => string | null | undefined) | null = null;

/**
 * Where events get their `machine_id` tag (`machineTelemetryId.ts`): which
 * install on which computer sent it, the same value PostHog events and
 * diagnostic reports carry. The user is the person and spans every machine
 * they own; this tells those machines apart. Read at send time, so a probe
 * that finishes after start-up still tags every later event. Must not probe.
 */
export function setSentryMachineIdResolver(resolver: (() => string | null | undefined) | null): void {
  resolveMachineId = resolver;
}

export function resolveSentryMachineId(): string | null {
  try {
    const id = resolveMachineId?.() ?? null;
    return typeof id === "string" && /^[0-9a-f]{16}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The user `beforeSend` puts on an event; for events that skip it (User Feedback). */
export function resolveSentryUserId(): string | null {
  try {
    return resolveUserId?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Report a failure that has an error object. Non-errors are wrapped so they
 * keep a stack. Returns the event id, or null where Sentry is not running.
 */
export function captureError(error: unknown, context?: CaptureContext): string | null {
  const api = sentry;
  if (!api) return null;
  const value = error instanceof Error ? error : new Error(typeof error === "string" ? error : safeDescribe(error));
  let eventId: string | null = null;
  api.withScope((scope) => {
    for (const [key, tag] of Object.entries(context?.tags ?? {})) {
      if (tag !== undefined && tag !== null) scope.setTag(key, String(tag));
    }
    if (context?.extra) scope.setExtras(context.extra);
    if (context?.fingerprint?.length) scope.setFingerprint(context.fingerprint);
    if (context?.level) scope.setLevel(context.level);
    const id = api.captureException(value, { mechanism: { type: "ade", handled: context?.handled ?? true } });
    eventId = typeof id === "string" && id ? id : null;
  });
  return eventId;
}

/**
 * Whether an event this process captured actually left: true once the
 * transport answers 2xx for it. The desktop renderer's transport answers when
 * main has the event; the web client's, when Sentry does. False when a filter
 * dropped it (`beforeSend`, the budget), the send failed (offline, an ad
 * blocker, a rate limit), or no answer came in time. For copy that tells a
 * person ADE has their report, which must not be said on a guess.
 */
export function confirmSentryDelivery(eventId: string | null, timeoutMs = DELIVERY_TIMEOUT_MS): Promise<boolean> {
  const client = sentry?.getClient?.();
  if (!eventId || !client?.on) return Promise.resolve(false);
  const on = client.on.bind(client);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | void = undefined;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(delivered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // The send is always asynchronous, so subscribing after the capture
    // cannot miss its answer.
    unsubscribe = on("afterSendEvent", (event, response) => {
      if (event?.event_id !== eventId) return;
      const status = response?.statusCode;
      finish(typeof status === "number" && status >= 200 && status < 300);
    });
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
 * feedback id, or null where Sentry is not running or the SDK threw (reported
 * to `onError`).
 */
export function captureUserFeedback(args: {
  message: string;
  source: string;
  userId?: string | null;
  /** The event the note is about; the newest event this process reported when absent. */
  associatedEventId?: string | null;
  tags?: Record<string, string>;
  onError?: (error: unknown) => void;
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
        // The note opens beside its event in Sentry.
        associatedEventId: args.associatedEventId || api.lastEventId?.() || undefined,
        tags: args.tags,
      }) ?? null;
    });
  } catch (error) {
    args.onError?.(error);
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
