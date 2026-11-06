import { sanitizeBranchName } from "./laneBranchName";
import type { LaneLinearIssue, NormalizedLinearIssue } from "./types";

type BranchIssueInput = Pick<LaneLinearIssue | NormalizedLinearIssue, "identifier" | "title">;

/**
 * A Linear issue plus the workspace-generated branch name. `branchName` is
 * optional so callers keep compiling before/after the field lands on the
 * normalized types.
 */
export type LinearIssueBranchSource = {
  identifier: string;
  title: string;
  branchName?: string | null;
};

export function linearIssueLaneName(issue: BranchIssueInput): string {
  return `${issue.identifier.trim()} ${issue.title.trim()}`.trim();
}

/**
 * The branch to create for an issue. Prefer Linear's own `branchName` when the
 * workspace returned one — it follows the workspace's `gitBranchFormat` and is
 * the name Linear's GitHub integration matches. Fall back to the
 * identifier/title slug when it is missing. Sanitized either way, so the result
 * is always a valid git ref.
 */
export function resolveLinearIssueBranchName(issue: LinearIssueBranchSource): string {
  const branchName = issue.branchName?.trim();
  if (branchName) return sanitizeLinearIssueBranchName(branchName);
  return linearIssueBranchName(issue);
}

export function linearIssueBranchName(issue: BranchIssueInput): string {
  const identifier = issue.identifier.trim().toLowerCase();
  const titleSlug = issue.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  const branch = [identifier, titleSlug].filter(Boolean).join("-");
  return sanitizeLinearIssueBranchName(branch || identifier || "linear-issue");
}

/**
 * A Linear (or Jira, GitHub) branch name made into one git and every OS
 * accept: the lane branch rules, Windows-safe and capped in length.
 */
export function sanitizeLinearIssueBranchName(input: string): string {
  return sanitizeBranchName(input) || "linear-issue";
}
