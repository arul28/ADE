/**
 * Jira Cloud: the contract between the brain's Jira service, the runtime
 * action domain `jira`, the renderer (`window.ade.jira`) and the CLI.
 *
 * Jira is a standalone tracker, like Linear: one credential per machine (the
 * brain's), stored in the machine credential store, and no repository. Text
 * crosses this boundary as markdown; the service converts to and from Jira's
 * Atlassian Document Format (`shared/jiraAdf.ts`). Statuses are never set
 * directly: a status change runs one of the transitions the issue's workflow
 * offers (`listTransitions`, `transitionIssue`).
 */

/** Why a Jira call failed, so every surface can say what fixes it. */
export type JiraErrorReason =
  | "not-connected"
  | "unauthenticated"
  | "forbidden"
  | "rate-limited"
  | "not-found"
  | "invalid"
  | "failed";

export type JiraConnectionStatus = {
  connected: boolean;
  /** `https://acme.atlassian.net` (or a loopback URL for the dev fake). */
  siteUrl: string | null;
  email: string | null;
  account: JiraUser | null;
  /** Set when a stored credential no longer works. */
  error: { reason: JiraErrorReason; message: string } | null;
  checkedAt: string | null;
};

export type JiraConnectArgs = {
  siteUrl: string;
  email: string;
  apiToken: string;
};

export type JiraUser = {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
  emailAddress?: string | null;
};

export type JiraProject = {
  id: string;
  key: string;
  name: string;
  avatarUrl: string | null;
};

/** Jira's own three status categories; colour and "done" come from these. */
export type JiraStatusCategory = "new" | "indeterminate" | "done";

export type JiraStatus = {
  id: string;
  name: string;
  category: JiraStatusCategory;
};

export type JiraIssueType = {
  id: string;
  name: string;
  iconUrl: string | null;
  subtask: boolean;
};

export type JiraPriority = {
  id: string;
  name: string;
  iconUrl: string | null;
};

export type JiraIssueSummary = {
  id: string;
  /** `PROJ-123`. */
  key: string;
  projectKey: string;
  title: string;
  status: JiraStatus;
  issueType: JiraIssueType;
  priority: JiraPriority | null;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  labels: string[];
  parentKey: string | null;
  /** Browser URL: `<site>/browse/PROJ-123`. */
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type JiraComment = {
  id: string;
  author: JiraUser | null;
  /** Markdown converted from ADF. */
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type JiraIssueDetail = JiraIssueSummary & {
  /** Markdown converted from ADF. */
  description: string;
  dueDate: string | null;
  subtasks: JiraIssueSummary[];
  comments: JiraComment[];
  /** Where older comments carry on; null once all are loaded. */
  commentsCursor: string | null;
  totalComments: number;
  permissions: { edit: boolean; comment: boolean; transition: boolean; assign: boolean };
};

export type JiraTransition = {
  id: string;
  name: string;
  to: JiraStatus;
};

export type JiraIssueListState = "open" | "done" | "all";

export type JiraListIssuesArgs = {
  /** Project keys to read. Empty = the bound project, else every project the account sees. */
  projectKeys?: string[];
  state?: JiraIssueListState;
  /** `me` = assigned to the signed-in account. */
  assignee?: "me" | "any";
  /** Free text, matched with JQL `text ~`. */
  query?: string;
  /** Raw JQL; when set it replaces the filters above. */
  jql?: string;
  limit?: number;
  cursor?: string | null;
};

export type JiraIssuePage = {
  issues: JiraIssueSummary[];
  nextCursor: string | null;
};

export type JiraUpdateIssueArgs = {
  key: string;
  title?: string;
  description?: string;
  labels?: string[];
  /** null unassigns. */
  assigneeAccountId?: string | null;
  priorityId?: string;
  dueDate?: string | null;
};

export type JiraCreateField = {
  /** `summary`, `description`, `customfield_10011`, … */
  id: string;
  name: string;
  required: boolean;
  /** True when ADE can fill it (summary, description, labels, assignee, priority, parent, duedate). */
  supported: boolean;
};

export type JiraCreateMeta = {
  projectKey: string;
  issueTypes: Array<JiraIssueType & { fields: JiraCreateField[] }>;
  priorities: JiraPriority[];
};

export type JiraCreateIssueArgs = {
  projectKey: string;
  issueTypeId: string;
  title: string;
  description?: string;
  labels?: string[];
  assigneeAccountId?: string | null;
  priorityId?: string | null;
  parentKey?: string | null;
  dueDate?: string | null;
};

export type JiraCreateIssueResult = {
  id: string;
  key: string;
  url: string;
};

/** The snapshot a lane or chat keeps of a linked Jira issue. */
export type LaneJiraIssue = {
  id: string;
  key: string;
  projectKey: string;
  siteUrl: string;
  title: string;
  description?: string | null;
  url: string;
  statusName: string;
  statusCategory: JiraStatusCategory;
  issueTypeName: string;
  priorityName: string | null;
  labels: string[];
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
};
