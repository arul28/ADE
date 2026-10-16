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

/** Matched against the error message (or event text). Added from real Sentry traffic, 2026-10-14 and 2026-10-16. */
export const EXPECTED_OUTCOME_PATTERNS: readonly RegExp[] = [
  // A lane or chat that was deleted, archived or moved while a view still held its id.
  /\bLane not found: /,
  /That chat does not exist on this machine/,
  /\bchat session '[^']+' was not found/i,
  // The project's runtime is still starting (or reconnecting) after a launch or switch.
  /unavailable until ADE is connected to the project runtime/,
  /Local runtime project is not available for this window/,
  // The brain restarting to apply an update, or a project mid-move or mid-switch: the window retries when it is back.
  /ADE is applying an update\. The background service is restarting/,
  /\bproject_moving: This project is being moved/,
  /Project is switching\. Wait for the current project to finish loading/,
  // Mac-only surfaces asked for before the runtime that owns them connected.
  /^(Mac Desktop is not available on this machine|iOS Simulator service is not available)\.$/,
  // A paired machine that is asleep, offline or stopped.
  /Can't reach .+ it may be asleep or ADE may be stopped there/,
  /Remote ADE service connection failed recently/,
  /Remote ADE service timed out waiting for method/,
  /Account Activity is reconnecting/,
  /is not sharing this project/,
  // The link to a paired machine dropping or lagging; the pool reconnects on its own.
  /Remote ADE service connection closed\b/,
  /Runtime RPC channel fell behind the sync connection/,
  /^Sync WebSocket is not open\.$/,
  /^IPC handler for 'ade\.remoteRuntime\.callAction' timed out after/,
  // No network, or a network that blocks the relays (undici names the cause, never the request).
  /^fetch failed$/,
  /push relay \w+ failed: (account owner changed|HTTP 5\d\d)/,
  // Git states the user is told about and resolves themselves.
  /\bDIRTY_WORKTREE:/,
  /nothing to commit, working tree clean/,
  /Lane worktree is missing\. Restore or recreate/,
  /GitHub auth missing\./,
  /This credential cannot access /,
  /Unable to detect GitHub repo from git remote/,
  /The base branch ".+" was not found\./,
  /\bfatal: invalid reference: /,
  /\bfatal: not a git repository\b/,
  /\bgit_untrusted_folder:/,
  /Refusing to register the user home directory or filesystem root/,
  /This chat already started — delete its lane/,
  // A screenshot or image attachment cleaned up while a chat still shows it.
  /\bPath does not exist: .+\.(png|jpe?g|gif|webp)$/i,
  // Answers to an agent driving a browser or a desktop: it fixes its call and retries.
  /Invalid element selector: /,
  /\b(MAC|WINDOWS)_DESKTOP_(NO_DISPLAY|NO_WINDOW|WINDOW_NOT_FOUND|HANDLE_EXPIRED|CONSENT_REQUIRED|OUT_PATH_OUTSIDE_ROOT|INPUT_LEASE_REQUIRED|PERMISSION_REQUIRED|UNSUPPORTED_PLATFORM):/,
  /is not on this lane's display/,
  /already has an active writer/,
  /^No matching element was found\.$/,
  /Timed out waiting for the App Control condition after/,
  /\bAPP_CONTROL_RECORDING_NOT_RUNNING:/,
  /^Artifact file not found: /,
  // Pointed at a debug port nothing listens on.
  /^connect ECONNREFUSED (127\.0\.0\.1|::1):\d+$/,
  // A PR, review thread or PR creation GitHub refuses; the agent is told why.
  /^PR not found: /,
  /\bdoes not belong to PR \d+/,
  /Failed to create pull request for .+: Validation Failed/,
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
