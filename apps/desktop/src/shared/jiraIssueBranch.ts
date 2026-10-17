import type { LaneJiraIssue } from "./types/jira";
import { sanitizeLinearIssueBranchName } from "./linearIssueBranch";

type JiraIssueBranchInput = Pick<LaneJiraIssue, "key" | "title">;

export function jiraIssueLaneName(issue: JiraIssueBranchInput): string {
  return (issue.key.trim().toUpperCase() + " " + issue.title.trim()).trim();
}

/** proj-123-short-title, sanitized with the same Git ref rules as Linear. */
export function jiraIssueBranchName(issue: JiraIssueBranchInput): string {
  const key = issue.key.trim().toLowerCase();
  const titleSlug = issue.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return sanitizeLinearIssueBranchName([key, titleSlug].filter(Boolean).join("-") || key || "jira-issue");
}
