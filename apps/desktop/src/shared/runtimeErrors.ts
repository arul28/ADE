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

export function isRuntimeTransportTimeoutError(error: unknown): boolean {
  return /IPC handler for .+ timed out after \d+ms|Remote ADE service timed out waiting for method/i.test(
    errorMessage(error),
  );
}
