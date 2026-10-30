/**
 * Copilot failures in Sentry.
 *
 * Every Copilot failure is already a log line, and warn lines reach Sentry as
 * Logs. This file decides which of them are also issues: the ones that may be
 * ADE's fault (a request Copilot rejected, a worker that died, a command or
 * setting the runtime refused). Each is tagged `provider: copilot` with its
 * kind and model, and grouped per kind and cause, so one bug is one issue.
 *
 * Signals (a lost conversation, a model list that would not load) go on the
 * tight signal budget as Logs: they say how often something happens, and
 * nobody can fix them in ADE.
 */
import { addSentryBreadcrumb, captureError, captureProblem } from "../../../shared/sentry/capture";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";

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

export type CopilotSignalKind =
  | "session_missing"
  | "model_catalog_failed"
  | "auto_switch_prompt_failed"
  | "mcp_auth_lookup_failed"
  | "callback_failed";

/**
 * A message's cause with the parts that change per request (ids, numbers,
 * quoted values) taken out, so one failure is one issue however often it
 * happens.
 */
export function copilotFailureCause(message: string): string {
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
  /** Used when there is no error object (a `session.error` event). */
  message?: string;
  model?: string | null;
  /** Narrows the grouping (an error type and code); defaults to the message's cause. */
  groupBy?: readonly string[];
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
}): void {
  const message = args.message ?? messageOf(args.error);
  const context = {
    tags: { provider: "copilot", "copilot.kind": kind, "copilot.model": args.model ?? null, ...args.tags },
    extra: args.extra,
    fingerprint: ["copilot", kind, ...(args.groupBy ?? [copilotFailureCause(message)])],
  };
  if (args.error instanceof Error) captureError(args.error, context);
  else captureProblem(`Copilot ${kind.replace(/_/g, " ")}${message ? `: ${copilotFailureCause(message)}` : ""}`, context);
}

export function reportCopilotSignal(kind: CopilotSignalKind, meta?: Record<string, unknown>): void {
  forwardSignalToSentry(`agent_chat.copilot_${kind}`, { provider: "copilot", ...meta }, kind);
}

/** What the next Copilot issue in this process says came before it. */
export function copilotBreadcrumb(message: string, data?: Record<string, unknown>): void {
  addSentryBreadcrumb("copilot", message, data);
}
