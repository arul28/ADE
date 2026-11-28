import { RUNNING_REQUEST_NOT_RUNNING_REASON } from "./runningRequests";
import { BRAND } from "./brand";
import { PRODUCT_NAME_PATTERN } from "./brandNames";

export const LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE =
  `This local release build output cannot start the ${BRAND.NAME} brain directly. Install the channel app into /Applications and relaunch ${BRAND.NAME}.`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The tail of a connect failure ADE stopped retrying until the person fixes it
 * (sign in, pair again, trust a changed SSH key): `RemoteConnectBackoffError`
 * with no retry time, or a connection held for the person's action.
 */
export const REMOTE_CONNECT_STOPPED_NOTICE =
  `${BRAND.NAME} won't retry on its own. Fix this, then press Try again.`;
/** The same tail as written before the rename; a remote brain mid-update may still send it. */
const LEGACY_REMOTE_CONNECT_STOPPED_NOTICE =
  `${BRAND.FORMER_NAME} won't retry on its own. Fix this, then press Try again.`;

/** The link is down and stays down until the person acts; waiting will not bring it back. */
export function isRemoteConnectStoppedError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes(REMOTE_CONNECT_STOPPED_NOTICE) || message.includes(LEGACY_REMOTE_CONNECT_STOPPED_NOTICE);
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
  `${BRAND.NAME} is applying an update. The background service is restarting.`;

export function isRuntimeUpdateInProgressError(error: unknown): boolean {
  return errorMessage(error).includes(LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE);
}

export function isProjectRegistrationRequiredError(error: unknown): boolean {
  return /Register a project first/i.test(errorMessage(error));
}

export function isSyncServiceUnavailableError(error: unknown): boolean {
  return /Sync service is not available|Register a project first/i.test(errorMessage(error));
}

/**
 * The runtime RPC client's name for the far end in its fixed wrappers:
 * "Remote DAEX service …", or "Remote ADE service …" from a build before the
 * rename (`runtimeRpcClient.ts`, the connection pools and
 * `pairedRuntimeErrors.ts` write them). This file owns the matchers for that
 * family; build any other shape from this fragment.
 */
export const REMOTE_SERVICE_PATTERN = `Remote ${PRODUCT_NAME_PATTERN} service`;

const REMOTE_SERVICE_TIMEOUT = new RegExp(`${REMOTE_SERVICE_PATTERN} timed out waiting for method`, "i");
const REMOTE_SERVICE_CONNECTION_DROPPED = new RegExp(`${REMOTE_SERVICE_PATTERN} connection (?:closed|failed)`, "i");
const REMOTE_SERVICE_CONNECTION_LOST = new RegExp(
  `remote (?:runtime|${PRODUCT_NAME_PATTERN} service) connection (?:(?:was )?interrupted|closed|failed)`,
  "i",
);
const REMOTE_SERVICE_METHOD_FAILURE = new RegExp(String.raw`^${REMOTE_SERVICE_PATTERN} method \S+ failed[\s(:]`, "i");

/** The transport stopped waiting for a method's answer: "Remote DAEX service timed out waiting for method …". */
export function isRemoteServiceTimeout(text: string): boolean {
  return REMOTE_SERVICE_TIMEOUT.test(text);
}

/** The RPC client's own words for its socket going away: "Remote DAEX service connection closed / failed …". */
export function isRemoteServiceConnectionDropped(text: string): boolean {
  return REMOTE_SERVICE_CONNECTION_DROPPED.test(text);
}

/**
 * Any lost link to the far end: the RPC client's "connection closed / failed",
 * or a remote runtime's "connection was interrupted".
 */
export function isRemoteServiceConnectionLost(text: string): boolean {
  return REMOTE_SERVICE_CONNECTION_LOST.test(text);
}

/**
 * The far end's own JSON-RPC reply, at the start of the text: "Remote DAEX
 * service method m failed (code n): …". The socket answered, so whatever went
 * wrong is the brain's, not the transport's.
 */
export function isRemoteServiceMethodFailure(text: string): boolean {
  return REMOTE_SERVICE_METHOD_FAILURE.test(text);
}

const REMOTE_OUTCOME_UNCONFIRMED = new RegExp(
  String.raw`before ${PRODUCT_NAME_PATTERN} could confirm the action result|Timed out waiting for remote command result`,
  "i",
);

export function isRemoteRuntimeConnectionError(error: unknown): boolean {
  const message = errorMessage(error);
  return isRemoteServiceConnectionLost(message)
    || /stream closed|channel closed|connection lost|socket closed|ECONNRESET|ECONNABORTED|EPIPE|ENOTCONN/i.test(message);
}

/**
 * True when a call to another machine lost its answer: the connection dropped
 * or ADE stopped waiting. The action may still have run there.
 */
export function isRemoteOutcomeUnknownError(error: unknown): boolean {
  // The sync link's own wait (web client, CLI peer) ran out with no answer.
  return REMOTE_OUTCOME_UNCONFIRMED.test(errorMessage(error))
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
  const message = errorMessage(error);
  return /IPC handler for .+ timed out after \d+ms/i.test(message) || isRemoteServiceTimeout(message);
}

/**
 * A call timed out, and the work may still be going on over there: every
 * timeout except the one where the brain said it was no longer running it
 * (`shared/runningRequests.ts`).
 */
export function mayStillBeRunning(error: unknown): boolean {
  return isRuntimeTransportTimeoutError(error) && !errorMessage(error).includes(RUNNING_REQUEST_NOT_RUNNING_REASON);
}
