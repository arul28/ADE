import type { LaneLinearIssue, NormalizedLinearIssue } from "../../../shared/types";
import { normalizedLinearIssueToLaneIssue } from "../../../shared/laneLinearIssue";
import { formatRelativeTime } from "./branchPickerSearch";
import type { LaneBranchOption } from "./laneUtils";

export function linearPriorityLabel(issue: Pick<NormalizedLinearIssue | LaneLinearIssue, "priorityLabel" | "priority">): string {
  if (issue.priorityLabel === "none" || !issue.priorityLabel) return "No priority";
  return issue.priorityLabel[0]!.toUpperCase() + issue.priorityLabel.slice(1);
}

export function issueProjectLabel(issue: Pick<NormalizedLinearIssue | LaneLinearIssue, "projectName" | "projectSlug" | "teamKey">): string {
  return issue.projectName?.trim() || issue.projectSlug || issue.teamKey;
}

export function issueUpdatedLabel(issue: Pick<NormalizedLinearIssue | LaneLinearIssue, "updatedAt">): string {
  return formatRelativeTime(issue.updatedAt) || "Updated recently";
}

export function toLaneLinearIssue(issue: NormalizedLinearIssue): LaneLinearIssue {
  return normalizedLinearIssueToLaneIssue(issue);
}

export function branchExistsForLinearIssue(branchName: string, branches: LaneBranchOption[]): boolean {
  const normalized = branchName.trim().toLowerCase();
  if (!normalized) return false;
  return branches.some((branch) => {
    const candidate = branch.name.trim().toLowerCase();
    const withoutRemote = candidate.replace(/^[^/]+\//, "");
    return candidate === normalized || withoutRemote === normalized;
  });
}
