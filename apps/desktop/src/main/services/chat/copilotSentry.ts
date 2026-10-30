/**
 * Copilot failures in Sentry.
 *
 * Every Copilot failure is already a log line, and warn lines reach Sentry as
 * Logs. This file decides which of them are also issues: the ones that may be
 * ADE's fault (a request Copilot rejected, a worker that died, a command or
 * setting the runtime refused). Each is tagged `provider: copilot` with its
 * kind and model, and grouped per kind and cause, so one bug is one issue.
 *
 * The rest (a lost conversation, a model list that would not load) stay
 * Sentry Logs through their warn lines: they say how often something happens,
 * and nobody can fix them in ADE.
 */
import { addSentryBreadcrumb, captureError, captureProblem } from "../../../shared/sentry/capture";
import { isExpectedOutcome } from "../../../shared/sentry/expectedFailure";

export type CopilotProblemKind =
  /** A `session.error` Copilot sent that is not sign-in, rate limit, quota or an outage. */
  | "session_error"
  /** A turn that failed before or while talking to Copilot (open, send, a command). */
  | "turn_failed"
  /** The SDK worker exited under a live chat. */
  | "worker_exited"
  /** The runtime would not list its slash commands. */
  | "commands_list_failed"
  /** A slash command typed mid-turn failed to run. */
  | "command_failed"
  /** Copilot refused a model or permission-level change. */
  | "setting_failed"
  /** A permission, question or plan handler threw; Copilot got the refusing fallback. */
  | "handler_failed";

/**
 * A message's cause with the parts that change per request (ids, numbers,
 * quoted values) taken out, so one failure is one issue however often it
 * happens.
 */
function copilotFailureCause(message: string): string {
  return message
    .split("\n")[0]!
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<value>")
    .replace(/\b[0-9a-f]{8,}(?:-[0-9a-f]{4,})*\b/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .trim()
    .slice(0, 160);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

export function reportCopilotProblem(kind: CopilotProblemKind, args: {
  error?: unknown;
  /** Groups an issue that has no error object (a worker exit). */
  message?: string;
  model?: string | null;
  /** Narrows the grouping (an error type and code); defaults to the message's cause. */
  groupBy?: readonly string[];
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
}): void {
  // Not signed in, an offline network: answers the user acts on, which the log
  // line already records. A runtime that is not downloaded yet is the pinned
  // tool installer's to report.
  if (args.error !== undefined && isExpectedOutcome(args.error)) return;
  if (args.error instanceof Error && args.error.name === "PinnedToolNotReadyError") return;
  const message = args.message ?? messageOf(args.error);
  const context = {
    tags: { provider: "copilot", "copilot.kind": kind, "copilot.model": args.model ?? null, ...args.tags },
    extra: args.extra,
    fingerprint: ["copilot", kind, ...(args.groupBy ?? [copilotFailureCause(message)])],
  };
  // Without an error object the title is the kind alone: a provider's message
  // may quote the request, so it stays in the extra (scrubbed of secrets).
  if (args.error instanceof Error) captureError(args.error, context);
  else captureProblem(`Copilot ${kind.replace(/_/g, " ")}`, context);
}


/** What the next Copilot issue in this process says came before it. */
export function copilotBreadcrumb(message: string, data?: Record<string, unknown>): void {
  addSentryBreadcrumb("copilot", message, data);
}
