import type { JiraErrorReason } from "./types/jira";

const JIRA_ERROR_REASONS: readonly JiraErrorReason[] = [
  "not-connected",
  "unauthenticated",
  "forbidden",
  "rate-limited",
  "not-found",
  "invalid",
  "failed",
];

export type ParsedJiraError = {
  reason: JiraErrorReason;
  message: string;
  retryAt?: string;
};

/** Creates an error that keeps its Jira reason across the runtime boundary. */
export function createJiraError(
  reason: JiraErrorReason,
  message: string,
  options: { retryAt?: string; cause?: unknown } = {},
): Error & { reason: JiraErrorReason; retryAt?: string } {
  const error = new Error(`[jira:${reason}] ${message}`, { cause: options.cause }) as Error & {
    reason: JiraErrorReason;
    retryAt?: string;
  };
  error.reason = reason;
  if (options.retryAt) error.retryAt = options.retryAt;
  return error;
}

/** Reads a tagged Jira error from an Error or a serialized error message. */
export function parseJiraError(error: unknown): ParsedJiraError | null {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "";
  const match = /^\[jira:([a-z-]+)\]\s*(.*)$/s.exec(message);
  if (!match || !JIRA_ERROR_REASONS.includes(match[1] as JiraErrorReason)) return null;
  const retryAt = typeof error === "object" && error !== null && "retryAt" in error
    && typeof error.retryAt === "string"
    ? error.retryAt
    : undefined;
  return {
    reason: match[1] as JiraErrorReason,
    message: match[2] ?? "",
    ...(retryAt ? { retryAt } : {}),
  };
}
