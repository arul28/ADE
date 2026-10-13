/**
 * Failures that are an answer, not a bug, and so never become a Sentry issue:
 * a peer on an older version that does not know an action, and an action the
 * caller is not allowed or not able to call. One list, so the IPC capture in
 * main and the action endpoint in the brain cannot disagree.
 *
 * A handler's own validation error ("Lane not found") is not on it: those are
 * reported, on purpose, and muted in Sentry when they prove to be noise.
 */
import {
  ACTION_NOT_CALLABLE_CODE,
  ACTION_NOT_EXPOSED_CODE,
  isUnsupportedAdeActionError,
  parseCodedErrorMessage,
} from "../codedError";

export function isExpectedFailure(error: unknown): boolean {
  if (isUnsupportedAdeActionError(error)) return true;
  const code = parseCodedErrorMessage(error).code;
  return code === ACTION_NOT_CALLABLE_CODE || code === ACTION_NOT_EXPOSED_CODE;
}
