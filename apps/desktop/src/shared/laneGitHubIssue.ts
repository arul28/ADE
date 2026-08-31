import type { LaneGitHubIssue } from "./types";
import { ISSUE_REF_KEY, parseIssueRefValue } from "./issueRef";

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
  // Carry the provider-neutral ref across the parse, for the same reason
  // `parseLaneLinearIssueValue` does. See `shared/issueRef.ts`.
  const issueRef = parseIssueRefValue(issue[ISSUE_REF_KEY]);
  return {
    ...(issueRef ? { [ISSUE_REF_KEY]: issueRef } : {}),
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
  labels?: Array<string | { name?: string }>;
  assignees?: Array<{ login?: string }>;
  user?: { login?: string } | null;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
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
