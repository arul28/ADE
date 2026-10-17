import type { IssueTrackerErrorReason, IssueTrackerKind } from "../../../shared/types/issueTrackers";
import { parseJiraError } from "../../../shared/jiraErrors";

export class IssueTrackerError extends Error {
  readonly name = "IssueTrackerError";

  constructor(
    readonly tracker: IssueTrackerKind,
    readonly operation: string,
    readonly reason: IssueTrackerErrorReason,
    detail: string,
    readonly retryAt?: string,
    options?: { cause?: unknown },
  ) {
    super(`[issues:${reason}] ${detail}`, options);
  }
}

export function normalizeIssueTrackerError(
  tracker: IssueTrackerKind,
  operation: string,
  error: unknown,
): IssueTrackerError {
  if (error instanceof IssueTrackerError) return error;
  const jira = parseJiraError(error);
  if (jira) {
    return new IssueTrackerError(
      tracker,
      operation,
      jira.reason,
      jira.message,
      jira.retryAt,
      { cause: error },
    );
  }

  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof value.status === "number"
    ? value.status
    : typeof value.statusCode === "number"
      ? value.statusCode
      : null;
  const message = error instanceof Error ? error.message : String(error ?? "Unknown tracker error.");
  const reason: IssueTrackerErrorReason = status === 401
    ? "unauthenticated"
    : status === 403
      ? "forbidden"
      : status === 404 || /\bnot found\b/i.test(message)
        ? "not-found"
        : status === 429 || /rate limit/i.test(message)
          ? "rate-limited"
          : /not connected|no usable .*credential|auth missing|not authenticated/i.test(message)
            ? "not-connected"
            : /invalid|required|must be/i.test(message)
              ? "invalid"
              : "failed";
  const retryAt = typeof value.retryAt === "string"
    ? value.retryAt
    : typeof value.retryAt === "number" && Number.isFinite(value.retryAt)
      ? new Date(value.retryAt).toISOString()
      : undefined;
  return new IssueTrackerError(tracker, operation, reason, message, retryAt, { cause: error });
}

export async function withIssueTrackerError<T>(
  tracker: IssueTrackerKind,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw normalizeIssueTrackerError(tracker, operation, error);
  }
}
