/**
 * How long a folder removal may take. A leaf module with no Node dependencies,
 * so the desktop's transports and the hosted web client wait the same time.
 */

/** A removal still running after this long is stopped (see removeTreeOffProcess). */
export const REMOVE_TREE_TIMEOUT_MS = 30 * 60_000;

/**
 * Files › Delete waits for the removal to finish, plus a minute for its result
 * to arrive. Deleting a `node_modules` folder takes minutes on a Windows brain,
 * and on a shorter budget the Files tab reported a failure while the removal
 * kept going.
 */
export const FILE_DELETE_TIMEOUT_MS = REMOVE_TREE_TIMEOUT_MS + 60_000;
