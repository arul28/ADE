/**
 * The one way shared and service code reports to Sentry.
 *
 * Calls go to whichever SDK the process started (Electron main, the renderer,
 * the brain, a forked worker, the web client) through `@sentry/core`'s global
 * client. In a process where Sentry never started, every call is a cheap
 * no-op, so code here never checks first. Nothing in this file initializes
 * an SDK.
 *
 * What may go in: error objects, messages, ids, names, counts, durations,
 * paths. What may not: prompt or transcript text, model output, file
 * contents, terminal output (see `docs/logging.md`, "Error tracking").
 * `scrub.ts` removes secrets on the way out regardless.
 */
import * as Sentry from "@sentry/core";

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

export function isSentryActive(): boolean {
  return Sentry.getClient() !== undefined;
}

function applyContext(scope: Sentry.Scope, context: CaptureContext | undefined): void {
  if (!context) return;
  for (const [key, value] of Object.entries(context.tags ?? {})) {
    if (value !== undefined && value !== null) scope.setTag(key, String(value));
  }
  if (context.extra) scope.setExtras(context.extra);
  if (context.fingerprint?.length) scope.setFingerprint(context.fingerprint);
  if (context.level) scope.setLevel(context.level);
}

/** Report a failure that has an error object. Non-errors are wrapped so they keep a stack. */
export function captureError(error: unknown, context?: CaptureContext): void {
  if (!isSentryActive()) return;
  const value = error instanceof Error ? error : new Error(typeof error === "string" ? error : safeDescribe(error));
  Sentry.withScope((scope) => {
    applyContext(scope, context);
    Sentry.captureException(value, {
      mechanism: { type: "ade", handled: context?.handled ?? true },
    });
  });
}

/**
 * A failure ADE detected without an error object: a provider went unhealthy, a
 * probe came back empty, a logger.error line. Sent as an `AdeProblem` so the
 * issue is titled by the message and keeps the stack of the code that noticed.
 */
export class AdeProblem extends Error {
  override name = "AdeProblem";
}

export function captureProblem(message: string, context?: CaptureContext): void {
  if (!isSentryActive()) return;
  captureError(new AdeProblem(message), { level: "error", ...context });
}

/** Context for the next error: what the user or the app just did. */
export function addSentryBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: "info" | "warning" | "error" = "info",
): void {
  if (!isSentryActive()) return;
  Sentry.addBreadcrumb({ category, message, data, level });
}

export function setSentryTags(tags: Record<string, string | number | boolean | null | undefined>): void {
  if (!isSentryActive()) return;
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && value !== null) Sentry.setTag(key, String(value));
  }
}

/** The pseudonymous user: the ADE account id when signed in, else the install's anonymous id. */
export function setSentryUser(id: string | null | undefined): void {
  if (!isSentryActive()) return;
  Sentry.setUser(id ? { id } : null);
}

export async function flushSentry(timeoutMs = 2_000): Promise<boolean> {
  if (!isSentryActive()) return true;
  try {
    return await Sentry.flush(timeoutMs);
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
