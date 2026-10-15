import type { JiraIssueDetail, JiraIssueSummary, JiraStatusCategory, LaneJiraIssue } from "./types/jira";

const STATUS_CATEGORIES = new Set<JiraStatusCategory>(["new", "indeterminate", "done"]);

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readNullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function normalizeSiteUrl(value: unknown): string | null {
  const siteUrl = readString(value);
  return siteUrl?.replace(/\/+$/, "") || null;
}

export function parseLaneJiraIssueValue(value: unknown): LaneJiraIssue | null {
  const issue = readRecord(value);
  if (!issue) return null;
  const id = readString(issue.id);
  const key = readString(issue.key)?.toUpperCase() ?? null;
  const projectKey = readString(issue.projectKey)?.toUpperCase() ?? null;
  const siteUrl = normalizeSiteUrl(issue.siteUrl);
  const title = readString(issue.title);
  const url = readString(issue.url);
  const statusName = readString(issue.statusName);
  const statusCategory = readString(issue.statusCategory);
  const issueTypeName = readString(issue.issueTypeName);
  const createdAt = readString(issue.createdAt);
  const updatedAt = readString(issue.updatedAt);
  if (
    !id || !key || !projectKey || !siteUrl || !title || !url || !statusName
    || !STATUS_CATEGORIES.has(statusCategory as JiraStatusCategory)
    || !issueTypeName || !createdAt || !updatedAt
  ) {
    return null;
  }
  return {
    id,
    key,
    projectKey,
    siteUrl,
    title,
    description: readNullableString(issue.description),
    url,
    statusName,
    statusCategory: statusCategory as JiraStatusCategory,
    issueTypeName,
    priorityName: readString(issue.priorityName),
    labels: readStringArray(issue.labels),
    assigneeName: readString(issue.assigneeName),
    createdAt,
    updatedAt,
  };
}

export function parseLaneJiraIssueJson(raw: string | null): LaneJiraIssue | null {
  if (!raw) return null;
  try {
    return parseLaneJiraIssueValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function jiraIssueToLaneIssue(
  issue: JiraIssueSummary | JiraIssueDetail,
  siteUrl: string,
): LaneJiraIssue | null {
  return parseLaneJiraIssueValue({
    id: issue.id,
    key: issue.key,
    projectKey: issue.projectKey,
    siteUrl,
    title: issue.title,
    description: "description" in issue ? issue.description : null,
    url: issue.url,
    statusName: issue.status.name,
    statusCategory: issue.status.category,
    issueTypeName: issue.issueType.name,
    priorityName: issue.priority?.name ?? null,
    labels: issue.labels,
    assigneeName: issue.assignee?.displayName ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  });
}

export function cloneLaneJiraIssue(issue: LaneJiraIssue): LaneJiraIssue {
  return { ...issue, labels: [...issue.labels] };
}
