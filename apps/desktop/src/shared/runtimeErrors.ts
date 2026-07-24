export const LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE =
  "This local release build output cannot start the ADE brain directly. Install the channel app into /Applications and relaunch ADE.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isLocalReleaseBuildOutputError(error: unknown): boolean {
  return errorMessage(error).includes(LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE);
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
