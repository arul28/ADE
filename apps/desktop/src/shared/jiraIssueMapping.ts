/**
 * Jira issue mapping and JQL, shared by the desktop's Jira service and the
 * ADE Cloud reads (the account server passes Jira's own issue objects back).
 * Pure: no Node and no DOM.
 */

import { jiraAdfToMarkdown } from "./jiraAdf";
import type {
  JiraComment,
  JiraIssueDetail,
  JiraIssueListState,
  JiraIssueSummary,
  JiraIssueType,
  JiraListIssuesArgs,
  JiraPriority,
  JiraProject,
  JiraStatus,
  JiraUser,
} from "./types/jira";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The fields an issue list asks Jira for. */
export const JIRA_LIST_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter", "labels", "parent", "project", "created", "updated"];

export function quoteJiraJqlValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildJiraIssueJql(args: JiraListIssuesArgs): string {
  if (args.jql?.trim()) return args.jql.trim();
  const clauses: string[] = [];
  const projectKeys = [...new Set((args.projectKeys ?? []).map((key) => key.trim()).filter(Boolean))];
  if (projectKeys.length === 1) clauses.push(`project = ${quoteJiraJqlValue(projectKeys[0]!)}`);
  else if (projectKeys.length > 1) clauses.push(`project in (${projectKeys.map(quoteJiraJqlValue).join(", ")})`);
  const state: JiraIssueListState = args.state ?? "open";
  if (state === "open") clauses.push("statusCategory != Done");
  else if (state === "done") clauses.push("statusCategory = Done");
  if (args.assignee === "me") clauses.push("assignee = currentUser()");
  if (args.query?.trim()) clauses.push(`text ~ ${quoteJiraJqlValue(args.query.trim())}`);
  return `${clauses.length ? clauses.join(" AND ") : "ORDER BY updated DESC"}${clauses.length ? " ORDER BY updated DESC" : ""}`;
}

export function mapJiraUser(value: unknown): JiraUser | null {
  if (!value || typeof value !== "object") return null;
  const user = record(value);
  const accountId = string(user.accountId);
  if (!accountId) return null;
  const avatarUrls = record(user.avatarUrls);
  return {
    accountId,
    displayName: string(user.displayName, string(user.name, "Unknown user")),
    avatarUrl: nullableString(avatarUrls["48x48"] ?? avatarUrls["32x32"] ?? avatarUrls["24x24"]),
    ...(typeof user.emailAddress === "string" ? { emailAddress: user.emailAddress } : {}),
  };
}

export function mapJiraStatus(value: unknown): JiraStatus {
  const status = record(value);
  const category = record(status.statusCategory);
  const rawCategory = string(category.key, string(category.name)).toLowerCase();
  const mapped = rawCategory.includes("done") ? "done" : rawCategory.includes("progress") || rawCategory === "indeterminate"
    ? "indeterminate"
    : "new";
  return { id: string(status.id), name: string(status.name, "Unknown"), category: mapped };
}

export function mapJiraIssueType(value: unknown): JiraIssueType {
  const issueType = record(value);
  return {
    id: string(issueType.id),
    name: string(issueType.name, "Issue"),
    iconUrl: nullableString(issueType.iconUrl),
    subtask: issueType.subtask === true,
  };
}

export function mapJiraPriority(value: unknown): JiraPriority | null {
  if (!value || typeof value !== "object") return null;
  const priority = record(value);
  return { id: string(priority.id), name: string(priority.name, ""), iconUrl: nullableString(priority.iconUrl) };
}

export function mapJiraIssueSummary(value: unknown, siteUrl: string): JiraIssueSummary {
  const issue = record(value);
  const fields = record(issue.fields);
  const project = record(fields.project);
  const key = string(issue.key);
  return {
    id: string(issue.id, key),
    key,
    projectKey: string(project.key, key.split("-")[0] ?? ""),
    title: string(fields.summary, "Untitled issue"),
    status: mapJiraStatus(fields.status),
    issueType: mapJiraIssueType(fields.issuetype),
    priority: mapJiraPriority(fields.priority),
    assignee: mapJiraUser(fields.assignee),
    reporter: mapJiraUser(fields.reporter),
    labels: array(fields.labels).filter((entry): entry is string => typeof entry === "string"),
    parentKey: nullableString(record(fields.parent).key),
    url: string(issue.self).startsWith("http") ? `${siteUrl}/browse/${encodeURIComponent(key)}` : `${siteUrl}/browse/${encodeURIComponent(key)}`,
    createdAt: string(fields.created),
    updatedAt: string(fields.updated),
  };
}

export function mapJiraComment(value: unknown): JiraComment {
  const comment = record(value);
  return {
    id: string(comment.id),
    author: mapJiraUser(comment.author),
    body: jiraAdfToMarkdown(comment.body),
    createdAt: string(comment.created),
    updatedAt: string(comment.updated, string(comment.created)),
  };
}

export function mapJiraProject(value: unknown): JiraProject {
  const project = record(value);
  const avatarUrls = record(project.avatarUrls);
  return {
    id: string(project.id),
    key: string(project.key),
    name: string(project.name, string(project.key)),
    avatarUrl: nullableString(avatarUrls["48x48"] ?? avatarUrls["32x32"]),
  };
}

/**
 * An issue's detail from Jira's own issue object (with its `comment` field).
 * `permissions` comes from a separate Jira read; a read-only caller passes
 * every permission as false.
 */
export function mapJiraIssueDetail(issue: unknown, siteUrl: string, permissions: JiraIssueDetail["permissions"]): JiraIssueDetail {
  const fields = record(record(issue).fields);
  const commentField = record(fields.comment);
  const comments = array(commentField.comments).map(mapJiraComment);
  return {
    ...mapJiraIssueSummary(issue, siteUrl),
    description: jiraAdfToMarkdown(fields.description),
    dueDate: nullableString(fields.duedate),
    subtasks: array(fields.subtasks).map((subtask) => mapJiraIssueSummary(subtask, siteUrl)),
    comments,
    commentsCursor: typeof commentField.total === "number" && commentField.total > comments.length ? String(comments.length) : null,
    totalComments: typeof commentField.total === "number" ? commentField.total : comments.length,
    permissions,
  };
}
