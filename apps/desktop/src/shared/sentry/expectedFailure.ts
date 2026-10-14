/**
 * Failures that are an answer, not a bug, and so never become a Sentry issue:
 * a peer on an older version that does not know an action, an action the
 * caller is not allowed or not able to call, and the outcomes below. One list,
 * so the IPC capture in main, the action endpoint in the brain and every
 * process's `beforeSend` cannot disagree.
 *
 * A handler's own validation error is reported by default; it joins
 * `EXPECTED_OUTCOME_PATTERNS` once Sentry shows it is a state the user can be
 * in rather than a defect. Callers keep these as budgeted Sentry Logs, so a
 * misroute that suddenly answers "not found" everywhere is still searchable.
 */
import {
  ACTION_NOT_CALLABLE_CODE,
  ACTION_NOT_EXPOSED_CODE,
  isUnsupportedAdeActionError,
  parseCodedErrorMessage,
} from "../codedError";

/** Matched against the error message (or event text). Added from real Sentry traffic, 2026-10-14. */
export const EXPECTED_OUTCOME_PATTERNS: readonly RegExp[] = [
  // A lane or chat that was deleted, archived or moved while a view still held its id.
  /\bLane not found: /,
  /That chat does not exist on this machine/,
  /\bchat session '[^']+' was not found/i,
  // The project's runtime is still starting (or reconnecting) after a launch or switch.
  /unavailable until ADE is connected to the project runtime/,
  // A paired machine that is asleep, offline or stopped.
  /Can't reach .+ it may be asleep or ADE may be stopped there/,
  /Remote ADE service connection failed recently/,
  /is not sharing this project/,
  // Git states the user is told about and resolves themselves.
  /\bDIRTY_WORKTREE:/,
  /nothing to commit, working tree clean/,
  // An agent filing the same proof twice; the caller is told which one it matches.
  /\bPROOF_DUPLICATE:/,
  // A provider login that lost access; the user re-signs in.
  /signed in but reports no available models/,
  // GitHub's own outage, not ADE's.
  /GitHub API request failed \(HTTP 5\d\d\)/,
];

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

export function isExpectedOutcomeText(text: string): boolean {
  return Boolean(text) && EXPECTED_OUTCOME_PATTERNS.some((pattern) => pattern.test(text));
}

/** An answer the caller gets, worth a Sentry Log but not an issue. */
export function isExpectedOutcome(error: unknown): boolean {
  return isExpectedOutcomeText(failureText(error));
}

export function isExpectedFailure(error: unknown): boolean {
  if (isUnsupportedAdeActionError(error)) return true;
  const code = parseCodedErrorMessage(error).code;
  return code === ACTION_NOT_CALLABLE_CODE || code === ACTION_NOT_EXPOSED_CODE;
}
