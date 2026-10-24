/**
 * ADE's structured logger, mirrored into Sentry.
 *
 * `createFileLogger` (main and brain) hands every line here. Most of ADE's
 * failure signal is in its logs: about 1,500 `logger.warn` and 40
 * `logger.error` call sites, many of them in code that catches an error and
 * carries on. So:
 *   - warn and error lines become Sentry Logs (searchable, not issues) and a
 *     breadcrumb on the next error;
 *   - error lines also become an issue, grouped by the log event name, or by
 *     the error when the line carries one.
 * Info and debug stay on disk only; they are too many for the quota and add
 * little to a report.
 */
import { expectedErrorKind } from "../expectedError";
import { addSentryBreadcrumb, captureError, captureProblem, isSentryActive, sendSentryLog } from "./capture";
import { createEventLimiter } from "./guardrails";
import { scrubRecord } from "./scrub";

type Level = "debug" | "info" | "warn" | "error";

/** Log events already reported through their own Sentry path: never mirrored. */
const SKIPPED_EVENTS = new Set<string>([
  "process.uncaught_exception",
  "process.unhandled_rejection",
]);

/**
 * Error lines kept as Sentry Logs and breadcrumbs but never turned into an
 * issue. `window.console` is every renderer `console.error`, all under one
 * event name: the renderer SDK already reports the real errors behind them
 * with their stacks, and a library's console noise is not a bug in ADE.
 */
const LOG_ONLY_EVENTS = new Set<string>([
  "window.console",
]);

/**
 * Sentry Logs budget per process. Some warnings repeat every second while a
 * condition lasts (a slow or unavailable runtime action, a retrying poll);
 * a few per event name per hour say everything, and 5 GB a month for the
 * whole organization does not survive one machine logging each repeat.
 * Breadcrumbs are local to the next event and stay unlimited.
 */
const logLimiter = createEventLimiter({ perFingerprintPerHour: 20, totalPerHour: 400 });

const ERROR_KEYS = ["err", "error", "cause", "exception"] as const;

function errorFromMeta(meta: Record<string, unknown> | undefined): unknown {
  if (!meta) return undefined;
  for (const key of ERROR_KEYS) {
    const value = meta[key];
    if (value instanceof Error) return value;
  }
  return undefined;
}

export function forwardLogToSentry(level: Level, event: string, meta?: Record<string, unknown>): void {
  if (level !== "warn" && level !== "error") return;
  if (!isSentryActive()) return;
  if (SKIPPED_EVENTS.has(event)) return;
  const attributes = scrubRecord(meta) ?? {};
  if (logLimiter.admit(event)) sendSentryLog(level, event, attributes);
  addSentryBreadcrumb("log", event, attributes, level === "warn" ? "warning" : "error");
  if (level !== "error" || LOG_ONLY_EVENTS.has(event)) return;
  const error = errorFromMeta(meta);
  // An error line about an answer (a folder that is not a repository, a path
  // the user picked): the line and the Sentry Log above are the record of it.
  if (expectedErrorKind(error)) return;
  const context = { tags: { "log.event": event }, extra: attributes };
  // An Error groups by its own stack and type. A message has no stack of its
  // own (the stack would be this bridge's), so it groups by the event name.
  if (error) captureError(error, context);
  else captureProblem(event, { ...context, fingerprint: ["log", event] });
}
