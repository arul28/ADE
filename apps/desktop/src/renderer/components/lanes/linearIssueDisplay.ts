import type { LaneLinearIssue, NormalizedLinearIssue } from "../../../shared/types";
import { linearIssueBranchName } from "../../../shared/linearIssueBranch";
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
  const branchName = linearIssueBranchName(issue);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    projectId: issue.projectId,
    projectSlug: issue.projectSlug,
    projectName: issue.projectName ?? null,
    teamId: issue.teamId,
    teamKey: issue.teamKey,
    teamName: issue.teamName ?? null,
    stateId: issue.stateId,
    stateName: issue.stateName,
    stateType: issue.stateType,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    labels: issue.labels,
    assigneeId: issue.assigneeId,
    assigneeName: issue.assigneeName,
    creatorId: issue.creatorId ?? null,
    creatorName: issue.creatorName ?? null,
    dueDate: issue.dueDate ?? null,
    estimate: issue.estimate ?? null,
    branchName,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
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
