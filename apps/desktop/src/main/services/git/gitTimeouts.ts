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

/**
 * How long a checkout or `worktree add` may print no progress before ADE stops
 * it. A slow tree write that still moves runs up to GIT_TREE_WRITE_TIMEOUT_MS;
 * a stuck one stops here instead of holding the lane queue. Git prints a line
 * as files finish, so only one file that takes longer than this (a large Git
 * LFS download, say) or a silent hook reaches the limit.
 */
export const GIT_TREE_WRITE_IDLE_TIMEOUT_MS = 2 * 60_000;

/**
 * Makes a checkout or `worktree add` print progress to ADE's pipe from the first
 * file, so GIT_TREE_WRITE_IDLE_TIMEOUT_MS sees it work. A checkout also needs
 * `--progress`; `worktree add` prints it on its own.
 */
export const GIT_TREE_WRITE_PROGRESS_ENV = { GIT_PROGRESS_DELAY: "0" } as const;

/**
 * Bound for a fetch. A busy or distant remote can take minutes on a large repo.
 * The lane Fetch button keeps its own shorter budget (GIT_FETCH_TIMEOUT_MS in
 * shared/defaultRemoteLaneBase.ts), because new-lane creation waits on it.
 */
export const GIT_REMOTE_FETCH_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a caller waits for a lane action that runs these commands. It covers
 * the most git work one of them does: three fetches and two tree writes. A lane
 * from a PR branch fetches twice to check the branch and once more to import
 * it, writes the tree, and removes it again if a later step fails; a delete may
 * remove a tree twice. A caller that gives up sooner reports a failure while
 * git is still writing, and a retry then finds a half-made lane.
 */
export const LANE_GIT_WRITE_ACTION_TIMEOUT_MS = 3 * GIT_REMOTE_FETCH_TIMEOUT_MS + 2 * GIT_TREE_WRITE_TIMEOUT_MS + 2 * 60_000;
