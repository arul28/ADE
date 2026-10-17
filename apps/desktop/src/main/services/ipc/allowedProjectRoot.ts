import {
  escapesAllRootsWhenMissingAllowed,
  isLexicallyWithinRoot,
  isPathEscapeError,
  resolvePathWithinRoot,
} from "../shared/utils";

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
 * - a failure from a root that lexically contains the candidate is the real
 *   cause (for a folder that is gone, the resolver's own
 *   `Path does not exist: <path>`), unless the candidate would leave that root
 *   through a symlink and land outside every allowed project root. A missing
 *   name under an in-root symlink that points outside fails on that name before
 *   the containment rule runs, so such a failure is checked again with missing
 *   names allowed, and a landing spot outside every allowed project root counts
 *   as an escape. A landing spot inside another allowed root (a link into a
 *   second root) keeps the real cause. Otherwise it is rethrown.
 * - a non-containment failure from a root the candidate is not lexically inside
 *   says nothing about the candidate. The resolver reports a missing component
 *   before it checks containment, so for a folder outside every root that
 *   failure has to be ignored, or a probe for `/outside/<name>` would tell the
 *   renderer whether that folder exists.
 *
 * Every refusal also runs the landing check, whether the candidate exists or
 * not, and only after every root has refused. A present target and a missing one
 * therefore walk the same path components, so how long a rejection takes does
 * not reveal which one it was.
 *
 * Rejection behavior is unchanged: a root is accepted under exactly the same
 * conditions as before, so this narrows nothing and widens nothing. Only the
 * diagnosis and the work done to reach it change.
 */
export function resolveWithinAllowedProjectRoots(
  allowedRoots: readonly string[],
  candidate: string,
): string {
  const refusals: Array<{ root: string; error: unknown }> = [];
  for (const root of allowedRoots) {
    try {
      return resolvePathWithinRoot(root, candidate);
    } catch (error) {
      refusals.push({ root, error });
    }
  }
  let ownRootFailure: unknown = null;
  let sawEscape = false;
  for (const { root, error } of refusals) {
    // Run for every refusal, so a present and a missing target walk the same way.
    const landsOutside = escapesAllRootsWhenMissingAllowed(allowedRoots, root, candidate);
    if (isPathEscapeError(error)) {
      sawEscape = true;
    } else if (isLexicallyWithinRoot(root, candidate)) {
      if (landsOutside) {
        sawEscape = true;
      } else if (ownRootFailure === null) {
        ownRootFailure = error;
      }
    }
  }
  if (sawEscape || ownRootFailure === null) {
    throw new Error(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  }
  throw ownRootFailure;
}
