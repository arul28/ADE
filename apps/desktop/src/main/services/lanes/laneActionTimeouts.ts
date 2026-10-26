import { LANE_GIT_WRITE_ACTION_TIMEOUT_MS } from "../git/gitTimeouts";

/**
 * How long a caller waits for the lane actions that run long on the machine.
 * A leaf module with no Node dependencies, so the desktop's local and remote
 * transports and the hosted web client read the same bounds.
 */

/**
 * A lane's environment setup runs the template's installs and setup script one
 * after another, each allowed `LANE_ENV_COMMAND_TIMEOUT_MS` (20 min). On the
 * 30s default the caller reported a failure while a long install kept running
 * to success. 45 min covers a template with a slow install and a setup script;
 * the remote transport expires just before it, so its reason reaches the user.
 */
export const LANE_ENV_SETUP_TIMEOUT_MS = 45 * 60_000;
export const LANE_ENV_SETUP_REMOTE_TRANSPORT_TIMEOUT_MS = LANE_ENV_SETUP_TIMEOUT_MS - 30_000;

/**
 * Archive batches: one lane at its full git bound (LANE_GIT_WRITE_ACTION_TIMEOUT_MS)
 * plus the time the batch's other items had before this change.
 */
export const ARCHIVE_RESTORE_TIMEOUT_MS = LANE_GIT_WRITE_ACTION_TIMEOUT_MS + 10 * 60_000;
export const ARCHIVE_DELETE_TIMEOUT_MS = LANE_GIT_WRITE_ACTION_TIMEOUT_MS + 15 * 60_000;
/** Cancelling a new-lane launch waits out an in-flight checkout, then deletes the lane. */
export const CHAT_CANCEL_LAUNCH_TIMEOUT_MS = LANE_GIT_WRITE_ACTION_TIMEOUT_MS + 60_000;
