/**
 * Bound for a git command that writes a whole tree (checkout, `worktree add`,
 * `worktree remove`). Git cannot undo one it was stopped in: a killed checkout
 * leaves files from both branches and an index that matches neither. The bound
 * only has to catch a git that never returns; a large repo, Git LFS or a slow
 * disk can take minutes.
 *
 * A leaf module, so the timeout policies that wait on these commands can read
 * the bounds without importing the git runner.
 */
export const GIT_TREE_WRITE_TIMEOUT_MS = 15 * 60_000;

/** Bound for a fetch. A busy or distant remote can take minutes on a large repo. */
export const GIT_REMOTE_FETCH_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a caller waits for a lane action that runs these commands: creating
 * a lane fetches its base and then writes the tree, and a delete may remove a
 * tree twice. A caller that gives up sooner reports a failure while git is
 * still writing, and a retry then finds a half-made lane.
 */
export const LANE_GIT_WRITE_ACTION_TIMEOUT_MS = GIT_REMOTE_FETCH_TIMEOUT_MS + GIT_TREE_WRITE_TIMEOUT_MS + 2 * 60_000;
