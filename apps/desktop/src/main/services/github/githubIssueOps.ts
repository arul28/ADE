import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  GitHubIssueCreateInput,
  GitHubIssueCreateResult,
  GitHubIssueTypeOption,
  GitHubIssueWriteAccess,
  GitHubRepoIssueSummary,
} from "../../../shared/types";
import {
  githubOperationCredentialCandidates,
  type GithubOperationCredentialCapability,
  type GithubOperationCredentialSource,
} from "../../../shared/githubOperationCredential";
import {
  GITHUB_ISSUE_LIST_QUERY,
  githubIssueListFromGraphql,
  githubIssueListVariables,
  type GitHubIssueListState,
} from "../../../shared/githubIssueList";
import type { GitHubIssue, GitHubIssueComment, GitHubIssueUpdate, GitHubMilestone } from "./githubService";
import { createAppIssueGrantReader, describeIssueWriteAccess } from "./githubIssueWriteAccess";
import {
  parseGitHubIssueTemplate,
  parseGitHubIssueTemplateConfig,
  type GitHubIssueTemplateSet,
} from "../../../shared/githubIssueTemplates";
import type { GitHubIssueLike } from "../../../shared/laneGitHubIssue";

/**
 * GitHub issue operations, shared by the desktop GitHub service and its
 * headless twin (the runtime and the CLI): reads for the viewer and the pane,
 * edits, comments, and creating issues. Each service supplies its own
 * transport (`apiRequest`, `apiRequestAllPages`, its credential inventory and
 * how it runs `gh`); everything above that is here, once.
 *
 * - A plain issue is one REST `POST /issues` under the `issue-write`
 *   capability, so it follows the same App → `gh` → PAT order as other issue
 *   edits.
 * - Pictures go through `gh issue create --attach`: GitHub has no public API
 *   for issue attachments, and `gh` uploads them as GitHub-hosted files (the
 *   path `ade proof publish` uses for PR comments). Labels, assignees,
 *   milestone and type are then set with one PATCH.
 * - A parent makes the new issue a sub-issue (`POST …/sub_issues`). If that
 *   step fails the issue still exists, so it comes back with a warning instead
 *   of an error.
 */

type ApiRequest = <T>(args: {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  capability?: "read" | "write" | "issue-write";
  repo?: { owner: string; name: string };
  token?: string;
}) => Promise<{ data: T }>;

/** One credential a service can try; the shape both services' inventories hold. */
type CredentialCandidate = {
  source: GithubOperationCredentialSource;
  token: string;
  capabilities: readonly GithubOperationCredentialCapability[];
};

type ApiRequestAllPages = <T>(args: {
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  maxPages?: number;
}) => Promise<T[]>;

/** Runs `gh` with the given args in `cwd`; resolves stdout. */
export type RunGh = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<string>;

type Logger = { warn(message: string, meta?: Record<string, unknown>): void };

const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
const MAX_TEMPLATE_FILES = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function decodeContent(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { content?: unknown; encoding?: unknown };
  if (typeof record.content !== "string") return null;
  return record.encoding === "base64" ? Buffer.from(record.content, "base64").toString("utf8") : record.content;
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404 || /\b404\b|not found/i.test(error instanceof Error ? error.message : "");
}

export function createGithubIssueOps(deps: {
  apiRequest: ApiRequest;
  apiRequestAllPages: ApiRequestAllPages;
  /** The service's credential candidates, every capability. */
  readCredentialCandidates: () => Promise<readonly CredentialCandidate[]>;
  runGh: RunGh | null;
  logger: Logger;
}) {
  const { apiRequest, apiRequestAllPages, readCredentialCandidates, runGh, logger } = deps;
  const repoPath = (owner: string, name: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  // The ADE App's issues permission on an owner, read from the user's
  // installations (one request, cached). The service's `apiRequest` uses it
  // too, to skip an App that cannot write issues.
  const readAppIssueGrant = createAppIssueGrantReader(async (appToken) => {
    const { data } = await apiRequest<unknown>({
      method: "GET",
      path: "/user/installations",
      query: { per_page: 100 },
      token: appToken,
      capability: "read",
    });
    return data;
  });

  const getIssueWriteAccess = async (owner: string, name: string, options: { force?: boolean } = {}): Promise<GitHubIssueWriteAccess> => {
    return await describeIssueWriteAccess({
      owner,
      name,
      candidates: githubOperationCredentialCandidates(await readCredentialCandidates(), "issue-write"),
      readGrant: readAppIssueGrant,
      force: options.force === true,
    });
  };

  /**
   * One PATCH for any mix of an issue's title, body, state, labels, assignees
   * and milestone. Issue-only (`issue-write`): pull requests keep their own
   * write path even though GitHub serves both from `/issues`.
   */
  const updateIssue = async (owner: string, name: string, number: number, patch: GitHubIssueUpdate): Promise<GitHubIssue | null> => {
    const { data } = await apiRequest<GitHubIssue>({
      method: "PATCH",
      path: `${repoPath(owner, name)}/issues/${number}`,
      body: patch,
      capability: "issue-write",
      repo: { owner, name },
    });
    return data ?? null;
  };

  const commentOnIssue = async (owner: string, name: string, number: number, body: string): Promise<GitHubIssueComment | null> => {
    const { data } = await apiRequest<GitHubIssueComment>({
      method: "POST",
      path: `${repoPath(owner, name)}/issues/${number}/comments`,
      body: { body },
      capability: "issue-write",
      repo: { owner, name },
    });
    return data ?? null;
  };

  const listRepoMilestones = async (owner: string, name: string): Promise<GitHubMilestone[]> => {
    const data = await apiRequestAllPages<GitHubMilestone>({
      path: `${repoPath(owner, name)}/milestones`,
      query: { state: "open", per_page: 100 },
      maxPages: 2,
    });
    return Array.isArray(data) ? data : [];
  };

  // A read-only GraphQL query against one repository. Errors in the body are
  // GitHub's answer, not a transport failure, so they are raised as such.
  const graphqlRepoRead = async <T>(owner: string, name: string, query: string, variables: Record<string, unknown>): Promise<T> => {
    const { data } = await apiRequest<{ data?: T; errors?: Array<{ message?: unknown }> }>({
      method: "POST",
      path: "/graphql",
      capability: "read",
      repo: { owner, name },
      body: { query, variables },
    });
    const errors = Array.isArray(data?.errors)
      ? data.errors.map((entry) => (typeof entry?.message === "string" ? entry.message : "")).filter(Boolean)
      : [];
    if (errors.length > 0) throw new Error(errors.join("; "));
    if (data?.data == null) throw new Error(`GitHub did not return ${owner}/${name}.`);
    return data.data;
  };

  const getRepoIssueSummary = async (owner: string, name: string): Promise<GitHubRepoIssueSummary> => {
    const data = await graphqlRepoRead<{
      repository?: { hasIssuesEnabled?: unknown; issues?: { totalCount?: unknown } | null } | null;
    }>(
      owner,
      name,
      "query RepoIssueSummary($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { hasIssuesEnabled issues(states: OPEN) { totalCount } } }",
      { owner, name },
    );
    const repository = data.repository;
    if (!repository) throw new Error(`GitHub did not return ${owner}/${name}.`);
    const totalCount = repository.issues?.totalCount;
    return {
      owner,
      name,
      hasIssuesEnabled: repository.hasIssuesEnabled === true,
      openCount: typeof totalCount === "number" && Number.isFinite(totalCount) ? totalCount : 0,
      checkedAt: new Date().toISOString(),
    };
  };

  const listRepoIssueList = async (owner: string, name: string, state: GitHubIssueListState): Promise<GitHubIssueLike[]> => {
    const data = await graphqlRepoRead<unknown>(owner, name, GITHUB_ISSUE_LIST_QUERY, githubIssueListVariables(owner, name, state));
    return githubIssueListFromGraphql(data);
  };

  const listIssueTemplates = async (owner: string, name: string): Promise<GitHubIssueTemplateSet> => {
    let entries: Array<{ name?: string; path?: string; type?: string }> = [];
    try {
      const { data } = await apiRequest<unknown>({
        method: "GET",
        path: `${repoPath(owner, name)}/contents/${encodePath(TEMPLATE_DIR)}`,
        repo: { owner, name },
      });
      entries = Array.isArray(data) ? data as typeof entries : [];
    } catch (error) {
      if (isNotFound(error)) return { templates: [], blankIssuesEnabled: true };
      throw error;
    }
    const files = entries
      .filter((entry) => entry.type === "file" && typeof entry.name === "string" && /\.(md|ya?ml)$/i.test(entry.name))
      .slice(0, MAX_TEMPLATE_FILES);
    const read = async (file: { name?: string; path?: string }) => {
      const { data } = await apiRequest<unknown>({
        method: "GET",
        path: `${repoPath(owner, name)}/contents/${encodePath(file.path ?? `${TEMPLATE_DIR}/${file.name}`)}`,
        repo: { owner, name },
      });
      return decodeContent(data);
    };
    let blankIssuesEnabled = true;
    const templates = [];
    for (const file of files) {
      const source = await read(file).catch(() => null);
      if (source == null) continue;
      const fileName = file.name!;
      if (/^config\.ya?ml$/i.test(fileName)) {
        blankIssuesEnabled = parseGitHubIssueTemplateConfig(source).blankIssuesEnabled;
        continue;
      }
      const template = parseGitHubIssueTemplate(fileName, source);
      if (template) templates.push(template);
    }
    return { templates, blankIssuesEnabled };
  };

  /** An organization's issue types; a user account has none. */
  const listIssueTypes = async (owner: string): Promise<GitHubIssueTypeOption[]> => {
    try {
      const { data } = await apiRequest<unknown>({ method: "GET", path: `/orgs/${encodeURIComponent(owner)}/issue-types` });
      return (Array.isArray(data) ? data : [])
        .map((entry) => entry as { id?: unknown; name?: unknown; description?: unknown; color?: unknown; is_enabled?: unknown })
        .filter((entry) => typeof entry.name === "string" && entry.is_enabled !== false)
        .map((entry) => ({
          id: typeof entry.id === "number" ? entry.id : null,
          name: String(entry.name),
          description: typeof entry.description === "string" ? entry.description : null,
          color: typeof entry.color === "string" ? entry.color : null,
        }));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  };

  const createWithAttachments = async (owner: string, name: string, input: GitHubIssueCreateInput): Promise<number> => {
    if (!runGh) {
      throw new Error("Pictures in a GitHub issue need GitHub CLI (gh 2.99 or later). Install it, or remove the pictures.");
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-issue-"));
    try {
      const attachArgs: string[] = [];
      for (const [index, attachment] of (input.attachments ?? []).entries()) {
        const bytes = Buffer.from(attachment.dataBase64, "base64");
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${attachment.filename} is over GitHub's 10 MB limit for pictures.`);
        const safe = `${index + 1}-${attachment.filename.replace(/[^\w.-]+/g, "_").slice(0, 80) || "image.png"}`;
        fs.writeFileSync(path.join(dir, safe), bytes);
        attachArgs.push("--attach", `./${safe}`);
      }
      fs.writeFileSync(path.join(dir, "body.md"), input.body ?? "");
      const stdout = await runGh(
        ["issue", "create", "--repo", `${owner}/${name}`, "--title", input.title, "--body-file", "body.md", ...attachArgs],
        { cwd: dir, timeoutMs: 120_000 },
      );
      const match = /\/issues\/(\d+)/.exec(stdout);
      if (!match) throw new Error("GitHub CLI created the issue but did not print its URL.");
      return Number(match[1]);
    } finally {
      // Windows can still hold a picture open just after `gh` exits; a failed
      // cleanup must not hide the real result.
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        logger.warn("github.issue_attach_cleanup_failed", { dir, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const createIssue = async (owner: string, name: string, input: GitHubIssueCreateInput): Promise<GitHubIssueCreateResult> => {
    const title = input.title.trim();
    if (!title) throw new Error("A GitHub issue needs a title.");
    const fields: Record<string, unknown> = {};
    if (input.labels?.length) fields.labels = input.labels;
    if (input.assignees?.length) fields.assignees = input.assignees;
    if (typeof input.milestone === "number") fields.milestone = input.milestone;
    if (input.type?.trim()) fields.type = input.type.trim();
    const warnings: string[] = [];

    let issue: GitHubIssueLike & { id?: number };
    if (input.attachments?.length) {
      const number = await createWithAttachments(owner, name, { ...input, title });
      if (Object.keys(fields).length > 0) {
        await apiRequest<unknown>({
          method: "PATCH",
          path: `${repoPath(owner, name)}/issues/${number}`,
          body: fields,
          capability: "issue-write",
          repo: { owner, name },
        }).catch((error: unknown) => {
          warnings.push(`Labels, assignees, milestone or type were not set: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      const { data } = await apiRequest<GitHubIssueLike & { id?: number }>({
        method: "GET",
        path: `${repoPath(owner, name)}/issues/${number}`,
        repo: { owner, name },
      });
      issue = data;
    } else {
      const { data } = await apiRequest<GitHubIssueLike & { id?: number }>({
        method: "POST",
        path: `${repoPath(owner, name)}/issues`,
        body: { title, body: input.body ?? "", ...fields },
        capability: "issue-write",
        repo: { owner, name },
      });
      issue = data;
    }

    if (typeof input.parentNumber === "number" && typeof issue.id === "number") {
      try {
        await apiRequest<unknown>({
          method: "POST",
          path: `${repoPath(owner, name)}/issues/${input.parentNumber}/sub_issues`,
          body: { sub_issue_id: issue.id },
          capability: "issue-write",
          repo: { owner, name },
        });
      } catch (error) {
        logger.warn("github.sub_issue_link_failed", {
          owner,
          name,
          parent: input.parentNumber,
          child: issue.number,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push(`Created, but not linked under #${input.parentNumber}.`);
      }
    }
    return { issue, warnings };
  };

  /** Put an existing issue under another one as a sub-issue. */
  const linkSubIssue = async (owner: string, name: string, parentNumber: number, childNumber: number): Promise<void> => {
    const { data } = await apiRequest<{ id?: number }>({
      method: "GET",
      path: `${repoPath(owner, name)}/issues/${childNumber}`,
      repo: { owner, name },
    });
    if (typeof data?.id !== "number") throw new Error(`GitHub did not return #${childNumber}.`);
    await apiRequest<unknown>({
      method: "POST",
      path: `${repoPath(owner, name)}/issues/${parentNumber}/sub_issues`,
      body: { sub_issue_id: data.id },
      capability: "issue-write",
      repo: { owner, name },
    });
  };

  return {
    readAppIssueGrant,
    getIssueWriteAccess,
    updateIssue,
    commentOnIssue,
    listRepoMilestones,
    getRepoIssueSummary,
    listRepoIssueList,
    createIssue,
    listIssueTemplates,
    listIssueTypes,
    linkSubIssue,
  };
}
