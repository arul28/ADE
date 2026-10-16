import { isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";

/**
 * The message for a path that really is outside every allowed project root.
 *
 * Named rather than inlined so the resolver and its test agree on the contract
 * without repeating the string.
 */
export const ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE = "rootPath is outside known project roots.";

/**
 * Resolve a renderer-supplied path against the allowed project roots, accepting
 * it only when one of them contains it.
 *
 * The allowlist is a list of candidate roots, so the path has to be tried
 * against each one. What must NOT happen is collapsing every failure into
 * "outside known project roots": `resolvePathWithinRoot` throws
 * `PATH_ESCAPES_ROOT_MESSAGE` only for the containment rule, and separately
 * surfaces a missing folder, a dangling symlink, a permission error and a link
 * loop. A recent project whose folder is on a volume that is not mounted right
 * now then reads as a root the renderer was never allowed to name.
 *
 * So the verdict is decided by what the attempts actually said:
 * - any attempt failed the containment rule and none accepted the path: the
 *   path is outside every allowed project root, and the caller gets that
 *   message exactly as before. This is the security answer, and it is never
 *   softened into a missing-folder one.
 * - no attempt failed the containment rule (or there were no attempts to
 *   make): nothing rejected the path as outside; the filesystem did. The
 *   original failure is rethrown so the message names the real cause — for a
 *   folder that is gone that is the resolver's own `Path does not exist: <path>`.
 *
 * Rejection behavior is unchanged: a root is accepted under exactly the same
 * conditions as before, so this narrows nothing and widens nothing. Only the
 * diagnosis changes.
 */
export function resolveWithinAllowedProjectRoots(
  allowedRoots: readonly string[],
  candidate: string,
): string {
  let firstNonEscapeFailure: unknown = null;
  let sawEscape = false;
  for (const root of allowedRoots) {
    try {
      return resolvePathWithinRoot(root, candidate);
    } catch (error) {
      if (isPathEscapeError(error)) {
        sawEscape = true;
      } else if (firstNonEscapeFailure === null) {
        firstNonEscapeFailure = error;
      }
    }
  }
  if (sawEscape || firstNonEscapeFailure === null) {
    throw new Error(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  }
  throw firstNonEscapeFailure;
}
