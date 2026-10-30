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
 * little to a report. The exception is `RELEASE_HEALTH_EVENTS`: a few info
 * lines, each once per launch or per update step, that show a build ran and
 * updated cleanly. The beta gate reads them (`scripts/release-tools/beta-gate.mjs`).
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
 * Info lines sent as Sentry Logs (never issues or breadcrumbs). Each fires at
 * most a few times per launch, so a release's logs say how many machines ran
 * it and whether its updates, track switches and restart resumes went through.
 */
const RELEASE_HEALTH_EVENTS = new Set<string>([
  "app.started",
  "brain.started",
  "autoUpdate.update_downloaded",
  "autoUpdate.track_switch_started",
  "autoUpdate.quit_and_install",
  "db.snapshot_written",
  "agent_chat.restart_resume_armed",
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

/**
 * Budget for diagnostic signals: a notice a person saw, a status that
 * contradicts itself, a reconnect that keeps failing. They answer "is this
 * happening, and to whom", which the first few copies say; a machine that sits
 * offline all day must not log all day. Each signal (event name) has its own
 * budget per process, so a burst of error banners cannot crowd out a reconnect
 * signal: 2 per key an hour, 6 a day, and 10 an hour / 30 a day for the event
 * as a whole. Sent as Sentry Logs, never as issues, so they cannot touch the
 * error quota.
 */
const SIGNAL_BUDGET = { perFingerprintPerHour: 2, totalPerHour: 10, perFingerprintPerDay: 6, totalPerDay: 30 } as const;
const MAX_SIGNAL_EVENTS = 50;
const signalLimiters = new Map<string, ReturnType<typeof createEventLimiter>>();

function signalLimiter(event: string): ReturnType<typeof createEventLimiter> | null {
  const existing = signalLimiters.get(event);
  if (existing) return existing;
  // Event names are fixed strings in code; a runaway set of them is a bug, not a reason to send more.
  if (signalLimiters.size >= MAX_SIGNAL_EVENTS) return null;
  const created = createEventLimiter(SIGNAL_BUDGET);
  signalLimiters.set(event, created);
  return created;
}

/**
 * A warn-level signal on the tight budget above. `key` narrows it within the
 * event (one notice surface, one provider) so one noisy source cannot use up
 * another's; it defaults to the event name.
 */
export function forwardSignalToSentry(event: string, meta?: Record<string, unknown>, key: string = event): void {
  if (!isSentryActive()) return;
  const attributes = scrubRecord(meta) ?? {};
  if (signalLimiter(event)?.admit(key)) sendSentryLog("warn", event, attributes);
  addSentryBreadcrumb("log", event, attributes, "warning");
}

export function forwardLogToSentry(level: Level, event: string, meta?: Record<string, unknown>): void {
  if (level === "info" && RELEASE_HEALTH_EVENTS.has(event)) {
    if (isSentryActive() && logLimiter.admit(event)) sendSentryLog("info", event, scrubRecord(meta) ?? {});
    return;
  }
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
