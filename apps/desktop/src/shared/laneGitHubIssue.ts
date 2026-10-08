import type { GitHubIssueCreateInput, LaneGitHubIssue } from "./types";

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

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      const record = readRecord(entry);
      return record ? readString(record.name) ?? readString(record.login) : null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

export function githubIssueId(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export function githubIssueIdentifier(issue: Pick<LaneGitHubIssue, "owner" | "repo" | "number">): string {
  return `${issue.owner}/${issue.repo}#${issue.number}`;
}

export function parseLaneGitHubIssueValue(value: unknown): LaneGitHubIssue | null {
  const issue = readRecord(value);
  if (!issue) return null;
  const number = readNumber(issue.number);
  const owner = readString(issue.owner);
  const repo = readString(issue.repo);
  const title = readString(issue.title);
  const url = readString(issue.url);
  const state = readString(issue.state);
  const createdAt = readString(issue.createdAt);
  const updatedAt = readString(issue.updatedAt);
  if (
    number == null
    || number <= 0
    || !Number.isInteger(number)
    || !owner
    || !repo
    || !title
    || !url
    || (state !== "open" && state !== "closed")
    || !createdAt
    || !updatedAt
  ) {
    return null;
  }
  return {
    id: readString(issue.id) ?? githubIssueId(owner, repo, number),
    number,
    owner,
    repo,
    title,
    body: readNullableString(issue.body),
    url,
    state,
    stateReason: readNullableString(issue.stateReason),
    labels: readStringArray(issue.labels),
    assignees: readStringArray(issue.assignees),
    authorLogin: readNullableString(issue.authorLogin),
    createdAt,
    updatedAt,
  };
}

export function parseLaneGitHubIssueJson(raw: string | null): LaneGitHubIssue | null {
  if (!raw) return null;
  try {
    return parseLaneGitHubIssueValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export type GitHubIssueLike = {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  state_reason?: string | null;
  labels?: Array<string | { name?: string; color?: string | null }>;
  assignees?: Array<{ login?: string; avatar_url?: string | null }>;
  user?: { login?: string; avatar_url?: string | null } | null;
  milestone?: { title?: string | null } | null;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: unknown;
};

/** The fields an issue edit may change (GitHub's PATCH body). */
export type GitHubIssuePatch = {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "duplicate" | "reopened" | null;
  labels?: string[];
  assignees?: string[];
  /** Milestone number, or null to clear it. */
  milestone?: number | null;
  /** Issue type name (organization repositories), or null to clear it. */
  type?: string | null;
};

const ISSUE_STATE_REASONS = new Set(["completed", "not_planned", "duplicate", "reopened"]);

/** Accept only the fields and shapes GitHub's issue PATCH takes; drop the rest. */
export function parseGitHubIssueUpdate(value: unknown): GitHubIssuePatch {
  const record = readRecord(value) ?? {};
  const patch: GitHubIssuePatch = {};
  if (typeof record.title === "string" && record.title.trim()) patch.title = record.title;
  if (typeof record.body === "string") patch.body = record.body;
  if (record.state === "open" || record.state === "closed") patch.state = record.state;
  if (record.state_reason === null || (typeof record.state_reason === "string" && ISSUE_STATE_REASONS.has(record.state_reason))) {
    patch.state_reason = record.state_reason as GitHubIssuePatch["state_reason"];
  }
  if (Array.isArray(record.labels)) patch.labels = record.labels.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(record.assignees)) patch.assignees = record.assignees.filter((entry): entry is string => typeof entry === "string");
  if (record.milestone === null || (typeof record.milestone === "number" && Number.isInteger(record.milestone))) {
    patch.milestone = record.milestone as number | null;
  }
  if (record.type === null || (typeof record.type === "string" && record.type.trim())) {
    patch.type = record.type === null ? null : String(record.type).trim();
  }
  return patch;
}

/** Keep only well-formed create fields; pictures stay base64 and bounded by count. */
export function parseGitHubIssueCreateInput(value: unknown): GitHubIssueCreateInput {
  const record = readRecord(value) ?? {};
  const title = typeof record.title === "string" ? record.title : "";
  const strings = (entry: unknown) => (Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []);
  const attachments = (Array.isArray(record.attachments) ? record.attachments : [])
    .map(readRecord)
    .filter((entry): entry is Record<string, unknown> => entry != null)
    .filter((entry) => typeof entry.filename === "string" && typeof entry.dataBase64 === "string")
    .slice(0, 20)
    .map((entry) => ({
      filename: String(entry.filename),
      contentType: typeof entry.contentType === "string" ? entry.contentType : "application/octet-stream",
      dataBase64: String(entry.dataBase64),
    }));
  return {
    title,
    ...(typeof record.body === "string" ? { body: record.body } : {}),
    labels: strings(record.labels),
    assignees: strings(record.assignees),
    ...(typeof record.milestone === "number" && Number.isInteger(record.milestone) ? { milestone: record.milestone } : {}),
    ...(typeof record.type === "string" && record.type.trim() ? { type: record.type.trim() } : {}),
    ...(typeof record.parentNumber === "number" && Number.isInteger(record.parentNumber) && record.parentNumber > 0
      ? { parentNumber: record.parentNumber }
      : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** One issue comment as GitHub's REST API returns it (the fields ADE reads). */
export type GitHubIssueCommentLike = {
  id?: number;
  body?: string | null;
  html_url?: string;
  user?: { login?: string; avatar_url?: string | null } | null;
  created_at?: string;
  updated_at?: string;
};

export function githubIssueToLaneIssue(
  owner: string,
  repo: string,
  issue: GitHubIssueLike,
): LaneGitHubIssue | null {
  if (issue.pull_request != null) return null;
  const number = issue.number;
  const title = readString(issue.title);
  const url = readString(issue.html_url);
  const state = issue.state === "closed" ? "closed" : issue.state === "open" ? "open" : null;
  const createdAt = readString(issue.created_at);
  const updatedAt = readString(issue.updated_at);
  if (number == null || number <= 0 || !Number.isInteger(number) || !title || !url || !state || !createdAt || !updatedAt) {
    return null;
  }
  const ownerName = owner.trim();
  const repoName = repo.trim();
  if (!ownerName || !repoName) return null;
  return {
    id: githubIssueId(ownerName, repoName, number),
    number,
    owner: ownerName,
    repo: repoName,
    title,
    body: issue.body ?? null,
    url,
    state,
    stateReason: issue.state_reason ?? null,
    labels: readStringArray(issue.labels),
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.login?.trim())
      .filter((login): login is string => Boolean(login)),
    authorLogin: issue.user?.login?.trim() || null,
    createdAt,
    updatedAt,
  };
}

export function cloneLaneGitHubIssue(issue: LaneGitHubIssue): LaneGitHubIssue {
  return {
    ...issue,
    labels: [...issue.labels],
    assignees: [...issue.assignees],
  };
}
