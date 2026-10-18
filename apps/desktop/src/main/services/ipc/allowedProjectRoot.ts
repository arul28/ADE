import { resolveWithinAllowedRoots } from "../shared/utils";

/**
 * The message for a path that really is outside every allowed project root.
 *
 * Named rather than inlined so the resolver and its test agree on the contract
 * without repeating the string.
 */
export const ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE = "rootPath is outside known project roots.";

/**
 * Resolve a renderer-supplied path against the allowed project roots, accepting
 * it only when one of them contains it. Refusals follow `resolveWithinAllowedRoots`:
 * anything that really lands outside every root gets this one message, with the
 * same filesystem calls and the same text whether the target exists, is missing or dangles.
 */
export function resolveWithinAllowedProjectRoots(
  allowedRoots: readonly string[],
  candidate: string,
): string {
  return resolveWithinAllowedRoots(allowedRoots, candidate, ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
}
