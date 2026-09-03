/**
 * Label helpers for a Linear issue.
 *
 * These take structural types rather than the desktop app's `NormalizedLinearIssue`
 * / `LaneLinearIssue`: a plugin page reads the same fields out of the replicated
 * `plugin_*` tables and must not have to import the app's shared types to format
 * a row.
 *
 * `toLaneLinearIssue` is deliberately NOT here. It converts between two of the
 * app's own wire shapes and pulls in the issue-ref and branch-name modules with
 * it, none of which a page has any use for; it stays in the desktop module.
 */

export type LinearIssuePriorityFields = {
  priorityLabel?: string | null;
  priority?: number;
};

export type LinearIssueProjectFields = {
  projectName?: string | null;
  projectSlug: string;
  teamKey: string;
};

export type LinearIssueUpdatedFields = {
  updatedAt: string;
};

export type LinearBranchOption = {
  name: string;
};

/**
 * Relative time, ported from the desktop's `branchPickerSearch` so the kit has
 * no dependency on the renderer. The two are pinned to the same outputs by
 * `test/linearIssueDisplay.test.ts`; change one and change the other.
 */
export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMs = now - ts;
  if (diffMs < 0) return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

export function linearPriorityLabel(issue: LinearIssuePriorityFields): string {
  if (issue.priorityLabel === "none" || !issue.priorityLabel) return "No priority";
  return issue.priorityLabel[0]!.toUpperCase() + issue.priorityLabel.slice(1);
}

export function issueProjectLabel(issue: LinearIssueProjectFields): string {
  return issue.projectName?.trim() || issue.projectSlug || issue.teamKey;
}

export function issueUpdatedLabel(issue: LinearIssueUpdatedFields): string {
  return formatRelativeTime(issue.updatedAt) || "Updated recently";
}

export function branchExistsForLinearIssue(
  branchName: string,
  branches: readonly LinearBranchOption[],
): boolean {
  const normalized = branchName.trim().toLowerCase();
  if (!normalized) return false;
  return branches.some((branch) => {
    const candidate = branch.name.trim().toLowerCase();
    const withoutRemote = candidate.replace(/^[^/]+\//, "");
    return candidate === normalized || withoutRemote === normalized;
  });
}
