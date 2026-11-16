/**
 * GitHub's JSON to the small shapes the direct client answers with
 * (`directClient.ts`). Each mapper returns null for a row it can't read.
 */

import type {
  GithubDirectBranch,
  GithubDirectCheckRun,
  GithubDirectComment,
  GithubDirectContentEntry,
  GithubDirectIssue,
  GithubDirectIssueDetail,
  GithubDirectPull,
  GithubDirectPullDetail,
  GithubDirectRepository,
  GithubDirectReview,
  GithubDirectUser,
} from "../types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const bool = (value: unknown): boolean => value === true;

function user(value: unknown): GithubDirectUser {
  if (!isRecord(value) || typeof value.login !== "string") return null;
  return { login: value.login, avatarUrl: str(value.avatar_url) };
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((label) => (isRecord(label) ? str(label.name) : str(label))).filter((name): name is string => Boolean(name));
}

export function mapRepository(value: unknown): GithubDirectRepository | null {
  if (!isRecord(value)) return null;
  const owner = isRecord(value.owner) ? str(value.owner.login) : null;
  const name = str(value.name);
  if (!owner || !name) return null;
  const permissions = isRecord(value.permissions)
    ? { pull: bool(value.permissions.pull), push: bool(value.permissions.push), admin: bool(value.permissions.admin) }
    : null;
  return {
    owner,
    name,
    fullName: str(value.full_name) ?? `${owner}/${name}`,
    private: bool(value.private),
    defaultBranch: str(value.default_branch),
    pushedAt: str(value.pushed_at),
    htmlUrl: str(value.html_url),
    permissions,
  };
}

export function mapBranch(value: unknown): GithubDirectBranch | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  if (!name) return null;
  return { name, sha: (isRecord(value.commit) ? str(value.commit.sha) : null) ?? "", protected: bool(value.protected) };
}

export function mapContentEntry(value: unknown): GithubDirectContentEntry | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  const path = str(value.path);
  const type = str(value.type);
  if (!name || !path || (type !== "file" && type !== "dir" && type !== "symlink" && type !== "submodule")) return null;
  return { name, path, kind: type, size: num(value.size) ?? 0, htmlUrl: str(value.html_url) };
}

export function mapPull(value: unknown): GithubDirectPull | null {
  if (!isRecord(value)) return null;
  const number = num(value.number);
  if (number == null) return null;
  const head = isRecord(value.head) ? value.head : {};
  const base = isRecord(value.base) ? value.base : {};
  const headRepo = isRecord(head.repo) ? head.repo : null;
  return {
    number,
    title: str(value.title) ?? "",
    state: value.state === "closed" ? "closed" : "open",
    draft: bool(value.draft),
    merged: bool(value.merged) || Boolean(str(value.merged_at)),
    user: user(value.user),
    headRef: str(head.ref) ?? "",
    headSha: str(head.sha) ?? "",
    headRepoFullName: headRepo ? str(headRepo.full_name) : null,
    baseRef: str(base.ref) ?? "",
    labels: labels(value.labels),
    createdAt: str(value.created_at),
    updatedAt: str(value.updated_at),
    mergedAt: str(value.merged_at),
    closedAt: str(value.closed_at),
    htmlUrl: str(value.html_url),
  };
}

export function mapPullDetail(value: unknown): GithubDirectPullDetail | null {
  const pull = mapPull(value);
  if (!pull || !isRecord(value)) return null;
  const reviewers = Array.isArray(value.requested_reviewers) ? value.requested_reviewers : [];
  return {
    ...pull,
    body: str(value.body) ?? "",
    mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
    mergeableState: str(value.mergeable_state),
    additions: num(value.additions),
    deletions: num(value.deletions),
    changedFiles: num(value.changed_files),
    commits: num(value.commits),
    comments: num(value.comments),
    reviewComments: num(value.review_comments),
    requestedReviewers: reviewers.map((reviewer) => user(reviewer)?.login ?? null).filter((login): login is string => Boolean(login)),
  };
}

export function mapCheckRun(value: unknown): GithubDirectCheckRun | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  if (!name) return null;
  return {
    name,
    status: str(value.status) ?? "unknown",
    conclusion: str(value.conclusion),
    appName: isRecord(value.app) ? str(value.app.name) : null,
    htmlUrl: str(value.html_url),
    startedAt: str(value.started_at),
    completedAt: str(value.completed_at),
  };
}

export function mapReview(value: unknown): GithubDirectReview | null {
  if (!isRecord(value)) return null;
  const id = num(value.id);
  if (id == null) return null;
  return { id, user: user(value.user), state: str(value.state) ?? "", body: str(value.body) ?? "", submittedAt: str(value.submitted_at) };
}

export function mapComment(kind: "issue" | "review") {
  return (value: unknown): GithubDirectComment | null => {
    if (!isRecord(value)) return null;
    const id = num(value.id);
    if (id == null) return null;
    return {
      id,
      kind,
      user: user(value.user),
      body: str(value.body) ?? "",
      createdAt: str(value.created_at),
      updatedAt: str(value.updated_at),
      path: kind === "review" ? str(value.path) : null,
      line: kind === "review" ? num(value.line) ?? num(value.original_line) : null,
      htmlUrl: str(value.html_url),
    };
  };
}

export function mapIssue(value: unknown): GithubDirectIssue | null {
  if (!isRecord(value) || value.pull_request !== undefined) return null; // The issues list also returns PRs.
  const number = num(value.number);
  if (number == null) return null;
  return {
    number,
    title: str(value.title) ?? "",
    state: value.state === "closed" ? "closed" : "open",
    user: user(value.user),
    labels: labels(value.labels),
    comments: num(value.comments) ?? 0,
    createdAt: str(value.created_at),
    updatedAt: str(value.updated_at),
    htmlUrl: str(value.html_url),
  };
}

export function mapIssueDetail(value: unknown): GithubDirectIssueDetail | null {
  const issue = mapIssue(value);
  if (!issue || !isRecord(value)) return null;
  const assignees = Array.isArray(value.assignees) ? value.assignees : [];
  return {
    ...issue,
    body: str(value.body) ?? "",
    assignees: assignees.map((assignee) => user(assignee)?.login ?? null).filter((login): login is string => Boolean(login)),
    milestone: isRecord(value.milestone) ? str(value.milestone.title) : null,
    closedAt: str(value.closed_at),
  };
}

export const listOf = <T>(map: (value: unknown) => T | null) => (body: unknown): T[] =>
  (Array.isArray(body) ? body : []).map(map).filter((item): item is T => item !== null);
