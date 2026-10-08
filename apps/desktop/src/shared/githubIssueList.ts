import type { GitHubIssueLike } from "./laneGitHubIssue";

/**
 * A repository's issues, newest activity first, for the GitHub Issues pane.
 *
 * Read through GraphQL's `issues` connection rather than REST `/issues`,
 * because REST mixes pull requests into the same list: on a busy repository the
 * page cap fills with closed pull requests and the pane would show no closed
 * issues at all. One page of up to 100 costs one GraphQL point. Single issues
 * and their comments stay on REST, where ETags make repeat reads free.
 *
 * Both GitHub services (desktop and the headless runtime) share this query and
 * the mapping back to the REST shape the renderer already reads.
 */

export type GitHubIssueListState = "open" | "closed" | "all";

/** The list state a caller asked for; anything unknown is "open". */
export function parseGitHubIssueListState(value: unknown): GitHubIssueListState {
  return value === "closed" || value === "all" ? value : "open";
}

export const GITHUB_ISSUE_LIST_PAGE_SIZE = 100;

export const GITHUB_ISSUE_LIST_QUERY = `query RepoIssueList($owner: String!, $name: String!, $states: [IssueState!], $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        body
        url
        state
        stateReason
        createdAt
        updatedAt
        closedAt
        author { login avatarUrl }
        assignees(first: 10) { nodes { login avatarUrl } }
        labels(first: 20) { nodes { name color } }
        milestone { title }
        comments { totalCount }
      }
    }
  }
}`;

export function githubIssueListVariables(owner: string, name: string, state: GitHubIssueListState) {
  return {
    owner,
    name,
    states: state === "open" ? ["OPEN"] : state === "closed" ? ["CLOSED"] : null,
    first: GITHUB_ISSUE_LIST_PAGE_SIZE,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nodes(value: unknown): Record<string, unknown>[] {
  const list = record(value)?.nodes;
  return Array.isArray(list) ? list.map(record).filter((entry): entry is Record<string, unknown> => entry != null) : [];
}

function login(value: unknown): { login?: string; avatar_url?: string | null } | null {
  const entry = record(value);
  const name = text(entry?.login);
  return name ? { login: name, avatar_url: text(entry?.avatarUrl) ?? null } : null;
}

/** Map the GraphQL answer onto the REST issue shape (`GitHubIssueLike`). */
export function githubIssueListFromGraphql(data: unknown): GitHubIssueLike[] {
  const issues = record(record(data)?.repository)?.issues;
  return nodes(issues).map((node): GitHubIssueLike => {
    const stateReason = text(node.stateReason);
    return {
      number: typeof node.number === "number" ? node.number : undefined,
      title: text(node.title),
      body: text(node.body) ?? null,
      html_url: text(node.url),
      state: text(node.state)?.toLowerCase(),
      state_reason: stateReason ? stateReason.toLowerCase() : null,
      created_at: text(node.createdAt),
      updated_at: text(node.updatedAt),
      closed_at: text(node.closedAt) ?? null,
      user: login(node.author),
      assignees: nodes(node.assignees).map(login).filter((entry): entry is { login: string; avatar_url: string | null } => entry != null),
      labels: nodes(node.labels).map((label) => ({ name: text(label.name), color: text(label.color) ?? null })),
      milestone: record(node.milestone) ? { title: text(record(node.milestone)?.title) ?? null } : null,
      comments: typeof record(node.comments)?.totalCount === "number" ? record(node.comments)!.totalCount as number : 0,
    };
  });
}
