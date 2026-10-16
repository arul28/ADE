import { isLexicallyWithinRoot, isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";

/**
 * The message for a path that really is outside every allowed directory.
 *
 * Kept as one constant because the renderer's Sentry filter and its error copy
 * both key off it.
 */
export const PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE = "Path is outside allowed directories.";

/**
 * Resolve a renderer-supplied path against the allowed directories, accepting
 * it only when one of them contains it.
 *
 * The allowlist is a list of candidate roots, so a path has to be tried
 * against each one. What must NOT happen is collapsing every failure into
 * "outside the allowlist": `resolvePathWithinRoot` throws
 * `PATH_ESCAPES_ROOT_MESSAGE` only for the containment rule, and separately
 * surfaces a missing file, a dangling symlink, a permission error and a link
 * loop. A path the user can see is simply gone then reads as a path they are
 * not allowed to name, and they are told to fix the wrong thing.
 *
 * So the verdict is decided by what the attempts actually said:
 * - any attempt failed the containment rule and none accepted the path: the
 *   path is outside every allowed directory, and the caller gets that message
 *   exactly as before. This is the security answer, and it is never softened
 *   into a "missing file" one.
 * - a failure from a root that lexically contains the candidate is the real
 *   cause (for a missing file, the resolver's own `Path does not exist: <path>`).
 *   It is rethrown only then.
 * - a non-containment failure from a root the candidate is not lexically inside
 *   says nothing about the candidate. The resolver reports a missing component
 *   before it checks containment, so for a path outside every root that failure
 *   has to be ignored, or a probe for `/outside/<name>` would tell the renderer
 *   whether that file exists.
 *
 * Rejection behavior is unchanged: a path is accepted under exactly the same
 * conditions as before, so this narrows nothing and widens nothing. Only the
 * diagnosis changes.
 */
export function resolveWithinAllowedDirs(
  allowedDirs: readonly string[],
  candidate: string,
): string {
  let ownRootFailure: unknown = null;
  let sawEscape = false;
  for (const dir of allowedDirs) {
    try {
      return resolvePathWithinRoot(dir, candidate);
    } catch (error) {
      if (isPathEscapeError(error)) {
        sawEscape = true;
      } else if (ownRootFailure === null && isLexicallyWithinRoot(dir, candidate)) {
        ownRootFailure = error;
      }
    }
  }
  if (sawEscape || ownRootFailure === null) {
    throw new Error(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  }
  throw ownRootFailure;
}
