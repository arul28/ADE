import { resolveWithinAllowedRoots } from "../shared/utils";

/**
 * The message for a path that really is outside every allowed directory.
 *
 * Kept as one constant because the renderer's Sentry filter and its error copy
 * both key off it.
 */
export const PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE = "Path is outside allowed directories.";

/**
 * Resolve a renderer-supplied path against the allowed directories, accepting
 * it only when one of them contains it. Refusals follow `resolveWithinAllowedRoots`:
 * anything that really lands outside every directory gets this one message, with
 * the same filesystem calls and the same text whether the target exists, is missing or dangles.
 */
export function resolveWithinAllowedDirs(
  allowedDirs: readonly string[],
  candidate: string,
): string {
  return resolveWithinAllowedRoots(allowedDirs, candidate, PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
}
