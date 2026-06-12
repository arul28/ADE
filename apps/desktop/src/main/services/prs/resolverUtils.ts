import type { AgentChatPermissionMode, PrAgentPermissionMode } from "../../../shared/types";

/**
 * Map ADE's permission mode to the agent chat permission mode.
 */
export function mapPermissionMode(mode: PrAgentPermissionMode | undefined): AgentChatPermissionMode {
  if (mode === "full_edit") return "full-auto";
  if (mode === "read_only") return "plan";
  if (mode === "guarded_edit") return "edit";
  if (
    mode === "default" ||
    mode === "plan" ||
    mode === "edit" ||
    mode === "full-auto" ||
    mode === "config-toml"
  ) {
    return mode;
  }
  return "edit";
}

export function mapPermissionModeForModelFamily(
  mode: PrAgentPermissionMode | undefined,
  family: string | undefined,
): AgentChatPermissionMode {
  if (family === "openai" && mode === "guarded_edit") return "default";
  return mapPermissionMode(mode);
}

// ---------------------------------------------------------------------------
// Admin-merge gate detection — shared by the manual merge path (`prService`).
// A branch-protection / base-branch-policy block on an otherwise-ready PR is
// the only thing `gh pr merge --admin` is allowed to bypass.
// ---------------------------------------------------------------------------

function looksLikeBranchPolicyBlock(error: string): boolean {
  return /base branch policy|branch protection|protected branch|required status|required check|required review|review is required|review required|code owner|codeowner/i.test(error);
}

export function shouldAttemptAdminMergeForRestError(
  error: string,
  opts: { allowForceMerge?: boolean; ignoreReview?: boolean } = {},
): boolean {
  if (!looksLikeBranchPolicyBlock(error)) return false;
  if (opts.allowForceMerge) return true;
  return !opts.ignoreReview;
}
