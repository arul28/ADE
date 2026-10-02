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

/** Turn a GitHub merge error into a message a user can act on. */
export function formatMergeError(rawMsg: string, expectedHeadSha?: string | null): string {
  if (rawMsg.includes("Resource not accessible by personal access token")) {
    return "GitHub auth lacks permission to merge PRs. For gh auth or classic PATs, enable the repo scope. For fine-grained PATs, enable Contents: write and Pull requests: write.";
  }
  if (rawMsg.includes("405") || rawMsg.includes("Method Not Allowed")) {
    return "PR cannot be merged — branch protection rules may require status checks or reviews to pass first.";
  }
  // A 409 from the merge API with an explicit `sha` we supplied means the
  // head advanced since the merge dialog was opened (`Head branch was
  // modified`). Distinguish it from a generic conflict.
  if (expectedHeadSha && (rawMsg.includes("409") || /head branch was modified/i.test(rawMsg))) {
    return "PR head changed since you opened the merge dialog — refresh and retry.";
  }
  if (rawMsg.includes("409") || rawMsg.includes("Conflict")) {
    return "PR has merge conflicts. Rebase or resolve conflicts before merging.";
  }
  return rawMsg;
}

export function shouldAttemptAdminMergeForRestError(
  error: string,
  opts: { allowForceMerge?: boolean; ignoreReview?: boolean } = {},
): boolean {
  if (!looksLikeBranchPolicyBlock(error)) return false;
  if (opts.allowForceMerge) return true;
  return !opts.ignoreReview;
}
