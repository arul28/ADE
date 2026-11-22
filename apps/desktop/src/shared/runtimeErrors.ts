export const LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE =
  "This local release build output cannot start the ADE brain directly. Install the channel app into /Applications and relaunch ADE.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isLocalReleaseBuildOutputError(error: unknown): boolean {
  return errorMessage(error).includes(LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE);
}

/**
 * Told to callers whose connect attempt was refused while an update replaces
 * the background service. Shared so the renderer can recognise it: the failed
 * project open it causes belongs to the update notice, not the project banner.
 */
export const LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE =
  "ADE is applying an update. The background service is restarting.";

export function isRuntimeUpdateInProgressError(error: unknown): boolean {
  return errorMessage(error).includes(LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE);
}

export function isProjectRegistrationRequiredError(error: unknown): boolean {
  return /Register a project first/i.test(errorMessage(error));
}

export function isSyncServiceUnavailableError(error: unknown): boolean {
  return /Sync service is not available|Register a project first/i.test(errorMessage(error));
}

export function isRemoteRuntimeConnectionError(error: unknown): boolean {
  return /remote (?:runtime|ADE service) connection (?:(?:was )?interrupted|closed|failed)|stream closed|channel closed|connection lost|socket closed|ECONNRESET|ECONNABORTED|EPIPE|ENOTCONN/i.test(
    errorMessage(error),
  );
}

/**
 * True when a call to another machine lost its answer: the connection dropped
 * or ADE stopped waiting. The action may still have run there.
 */
export function isRemoteOutcomeUnknownError(error: unknown): boolean {
  // The sync link's own wait (web client, CLI peer) ran out with no answer.
  return /before ADE could confirm the action result|Timed out waiting for remote command result/i.test(errorMessage(error))
    || isRemoteRuntimeConnectionError(error)
    || isRuntimeTransportTimeoutError(error);
}

/**
 * True when ADE refused the call before dialing, because a connect to that
 * machine failed a moment ago: nothing went out, so the call did not run
 * there. A send can hand its text back at once instead of waiting to see
 * whether it arrived.
 */
export function isRemoteCallNotSentError(error: unknown): boolean {
  return /connection failed recently/i.test(errorMessage(error));
}

/**
 * True when the other machine is away: its link dropped, it is not connected,
 * or ADE can't reach it (asleep, restarting). The call did not reach it, or
 * its answer was lost.
 */
export function isRemoteMachineAwayError(error: unknown): boolean {
  return isRemoteOutcomeUnknownError(error)
    || /Can't reach .+ it may be asleep|Remote target is not connected/i.test(errorMessage(error));
}

export function isRuntimeTransportTimeoutError(error: unknown): boolean {
  return /IPC handler for .+ timed out after \d+ms|Remote ADE service timed out waiting for method/i.test(
    errorMessage(error),
  );
}
