import { parseGitHubIssueRef } from "../../../desktop/src/shared/githubMagicWords";
import {
  githubIssueId,
  githubIssueToLaneIssue,
  type GitHubIssueLike,
} from "../../../desktop/src/shared/laneGitHubIssue";
import {
  normalizedLinearIssueToLaneIssue,
  parseLaneLinearIssueValue,
} from "../../../desktop/src/shared/laneLinearIssue";
import { jiraIssueToLaneIssue } from "../../../desktop/src/shared/laneJiraIssue";
import type { NormalizedLinearIssue } from "../../../desktop/src/shared/types";
import type { JiraIssueDetail } from "../../../desktop/src/shared/types/jira";
import { ACTIVE_SESSION_PLACEHOLDER } from "./linearCommands";

const LINEAR_ISSUE_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export type IssueToolRequest =
  | {
      kind: "usage";
      title: string;
      body: string;
    }
  | {
      kind: "linearAttach";
      title: string;
      identifier: string;
      sessionId: string;
    }
  | {
      kind: "githubAttach";
      title: string;
      ref: { owner?: string; repo?: string; number: number };
      sessionId: string;
    }
  | {
      kind: "list";
      title: string;
      sessionId: string;
    }
  | {
      kind: "detach";
      title: string;
      token: string;
      sessionId: string;
    };

export type IssueCommandConn = {
  action: (domain: string, action: string, args?: Record<string, unknown>) => Promise<unknown>;
  actionList: (domain: string, action: string, args: unknown[]) => Promise<unknown>;
};

function usage(title = "Issue", body = "Usage: /issue <attach|list|detach> [PROJ-123|owner/repo#42|#42]"): IssueToolRequest {
  return { kind: "usage", title, body };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildIssueToolRequest(input: string): IssueToolRequest {
  const trimmed = input.trim();
  const [group, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const token = rest[0] ?? "";
  if (!group || group === "help") return usage();

  if (group === "attach") {
    if (!token) {
      return usage("Issue attach", "Usage: /issue attach <PROJ-123|owner/repo#42|#42>");
    }
    if (LINEAR_ISSUE_ID_RE.test(token)) {
      return {
        kind: "linearAttach",
        title: "Issue attach",
        identifier: token,
        sessionId: ACTIVE_SESSION_PLACEHOLDER,
      };
    }
    const ref = parseGitHubIssueRef(token);
    if (!ref) {
      return usage("Issue attach", "Usage: /issue attach <PROJ-123|owner/repo#42|#42>");
    }
    return {
      kind: "githubAttach",
      title: "Issue attach",
      ref,
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    };
  }

  if (group === "list") {
    return {
      kind: "list",
      title: "Attached issues",
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    };
  }

  if (group === "detach") {
    if (!token) {
      return usage("Issue detach", "Usage: /issue detach <PROJ-123|owner/repo#42|#42>");
    }
    return {
      kind: "detach",
      title: "Issue detach",
      token,
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    };
  }

  return usage();
}

async function resolveGitHubRepo(
  conn: IssueCommandConn,
  ref: { owner?: string; repo?: string },
): Promise<{ owner: string; name: string } | null> {
  let owner = ref.owner;
  let name = ref.repo;
  if (!owner || !name) {
    const detected = await conn.action("github", "detectRepo", {}) as { owner?: string; name?: string } | null;
    owner = owner ?? detected?.owner;
    name = name ?? detected?.name;
  }
  if (!owner || !name) return null;
  return { owner, name };
}

export async function executeIssueToolRequest(
  input: string,
  ctx: {
    sessionId: string | null;
    conn: IssueCommandConn;
    setDetails: (title: string, body: string) => void;
    notifySuccess: (message: string) => void;
    render: (value: unknown, depth?: number) => string;
  },
): Promise<void> {
  const request = buildIssueToolRequest(input);
  if (request.kind === "usage") {
    ctx.setDetails(request.title, request.body);
    return;
  }

  const resolveSessionId = (value: string): string | null => (
    value === ACTIVE_SESSION_PLACEHOLDER ? ctx.sessionId : value
  );
  const missingSession = "No active chat session. Pass --session <id>.";

  if (request.kind === "linearAttach") {
    const chatSessionId = resolveSessionId(request.sessionId);
    if (!chatSessionId) {
      ctx.setDetails(request.title, missingSession);
      return;
    }

    // A key-shaped reference can belong to Linear or Jira. Ask the shared
    // resolver first so a Jira project bound to this project wins over the
    // TUI's historical Linear-only interpretation.
    const resolution = await ctx.conn.action("issues", "resolve", {
      reference: request.identifier,
    }).catch(() => null);
    const resolutionRecord = record(resolution);
    const issueReference = record(resolutionRecord.reference);
    if (resolutionRecord.kind === "jira" || issueReference.provider === "jira") {
      const key = stringValue(issueReference.key) ?? request.identifier;
      const siteUrl = stringValue(issueReference.siteUrl);
      if (!siteUrl) {
        ctx.setDetails(request.title, `Could not resolve the Jira site for ${key}.`);
        return;
      }
      ctx.setDetails(request.title, "Loading Jira issue...");
      const raw = await ctx.conn.action("jira", "getIssue", { key });
      const issue = jiraIssueToLaneIssue(raw as JiraIssueDetail, siteUrl);
      if (!issue) {
        ctx.setDetails(request.title, `${key} is not an attachable Jira issue.`);
        return;
      }
      const result = await ctx.conn.action("lane", "attachJiraIssueToSession", {
        chatSessionId,
        issues: [issue],
      });
      ctx.setDetails(request.title, ctx.render(result, 24));
      ctx.notifySuccess(`Attached ${issue.key}.`);
      return;
    }

    ctx.setDetails(request.title, "Loading Linear issue...");
    const raw = await ctx.conn.actionList("linear_issue_tracker", "fetchIssueById", [request.identifier]);
    if (!raw) {
      ctx.setDetails(request.title, `Could not load Linear issue ${request.identifier}.`);
      return;
    }
    const issue = parseLaneLinearIssueValue(normalizedLinearIssueToLaneIssue(raw as NormalizedLinearIssue));
    if (!issue) {
      ctx.setDetails(request.title, `${request.identifier} is not an attachable Linear issue.`);
      return;
    }
    const result = await ctx.conn.action("lane", "attachLinearIssueToSession", {
      chatSessionId,
      issues: [issue],
    });
    ctx.setDetails(request.title, ctx.render(result, 24));
    ctx.notifySuccess(`Attached ${issue.identifier}.`);
    return;
  }

  if (request.kind === "githubAttach") {
    const chatSessionId = resolveSessionId(request.sessionId);
    if (!chatSessionId) {
      ctx.setDetails(request.title, missingSession);
      return;
    }
    ctx.setDetails(request.title, "Loading GitHub issue...");
    const repo = await resolveGitHubRepo(ctx.conn, request.ref);
    if (!repo) {
      ctx.setDetails(request.title, "Could not detect the current GitHub repository.");
      return;
    }
    const raw = await ctx.conn.action("github", "getIssue", {
      owner: repo.owner,
      name: repo.name,
      number: request.ref.number,
    });
    const issue = githubIssueToLaneIssue(repo.owner, repo.name, raw as GitHubIssueLike);
    if (!issue) {
      ctx.setDetails(request.title, `${repo.owner}/${repo.name}#${request.ref.number} is not an attachable GitHub issue.`);
      return;
    }
    const result = await ctx.conn.action("lane", "attachGitHubIssueToSession", {
      chatSessionId,
      issues: [issue],
    });
    ctx.setDetails(request.title, ctx.render(result, 24));
    ctx.notifySuccess(`Attached ${githubIssueId(repo.owner, repo.name, issue.number)}.`);
    return;
  }

  if (request.kind === "list") {
    const chatSessionId = resolveSessionId(request.sessionId);
    if (!chatSessionId) {
      ctx.setDetails(request.title, missingSession);
      return;
    }
    ctx.setDetails(request.title, "Loading attached issues...");
    const [linear, github, jira] = await Promise.all([
      ctx.conn.action("lane", "listLinearIssuesForSession", { chatSessionId }),
      ctx.conn.action("lane", "listGitHubIssuesForSession", { chatSessionId }),
      ctx.conn.action("lane", "listJiraIssuesForSession", { chatSessionId }),
    ]);
    ctx.setDetails(request.title, [
      "Linear", ctx.render(linear, 24),
      "", "GitHub", ctx.render(github, 24),
      "", "Jira", ctx.render(jira, 24),
    ].join("\n"));
    return;
  }

  const chatSessionId = resolveSessionId(request.sessionId);
  if (!chatSessionId) {
    ctx.setDetails(request.title, missingSession);
    return;
  }
  const githubRef = parseGitHubIssueRef(request.token);
  if (githubRef) {
    const repo = await resolveGitHubRepo(ctx.conn, githubRef);
    if (!repo) {
      ctx.setDetails(request.title, "Could not detect the current GitHub repository.");
      return;
    }
    const issueId = githubIssueId(repo.owner, repo.name, githubRef.number);
    const result = await ctx.conn.action("lane", "detachGitHubIssueFromSession", { chatSessionId, issueId });
    ctx.setDetails(request.title, ctx.render(result, 24));
    ctx.notifySuccess(`Detached ${issueId}.`);
    return;
  }

  const resolution = await ctx.conn.action("issues", "resolve", {
    reference: request.token,
  }).catch(() => null);
  const resolutionRecord = record(resolution);
  const issueReference = record(resolutionRecord.reference);
  if (resolutionRecord.kind === "jira" || issueReference.provider === "jira") {
    const issueId = stringValue(issueReference.key) ?? request.token;
    const result = await ctx.conn.action("lane", "detachJiraIssueFromSession", {
      chatSessionId,
      issueId,
    });
    ctx.setDetails(request.title, ctx.render(result, 24));
    ctx.notifySuccess(`Detached ${issueId}.`);
    return;
  }

  const result = await ctx.conn.action("lane", "detachLinearIssueFromSession", {
    chatSessionId,
    issueId: request.token,
  });
  ctx.setDetails(request.title, ctx.render(result, 24));
  ctx.notifySuccess(`Detached ${request.token}.`);
}
