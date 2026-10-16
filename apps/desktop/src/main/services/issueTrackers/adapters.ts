import type { GitHubIssue, GitHubIssueComment, GithubService } from "../github/githubService";
import type { IssueTracker } from "../cto/issueTracker";
import type { createJiraService } from "../jira/jiraService";
import type { IssueRef } from "../../../shared/issueRefs";
import type { JiraIssueDetail, JiraIssueSummary } from "../../../shared/types/jira";
import type {
  IssueCommentsPage,
  IssueDetail,
  IssuePage,
  IssueState,
  IssueSummary,
  IssueTrackerAdapter,
} from "../../../shared/types/issueTrackers";
import { IssueTrackerError, withIssueTrackerError } from "./issueTrackerError";

type JiraService = ReturnType<typeof createJiraService>;

type LinearIssue = Awaited<ReturnType<IssueTracker["fetchIssueById"]>> & {};

function summary(
  kind: IssueSummary["kind"],
  issue: {
    id: string;
    title: string;
    state: IssueState | null;
    url: string | null;
    labels: string[];
    assignees: string[];
    createdAt: string | null;
    updatedAt: string | null;
  },
  reference: IssueRef,
): IssueSummary {
  return { kind, ...issue, reference };
}

function linearSummary(issue: NonNullable<LinearIssue>, reference?: IssueRef): IssueSummary {
  const ref: IssueRef = reference ?? { provider: "linear", identifier: issue.identifier, url: issue.url };
  return summary("linear", {
    id: issue.id,
    title: issue.title,
    state: { id: issue.stateId, name: issue.stateName, type: issue.stateType },
    url: issue.url,
    labels: issue.labels ?? [],
    assignees: issue.assigneeName ? [issue.assigneeName] : [],
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }, ref);
}

function githubLabels(issue: { labels?: Array<string | { name?: string }> }): string[] {
  return (issue.labels ?? []).flatMap((label) => {
    if (typeof label === "string") return [label];
    return typeof label.name === "string" ? [label.name] : [];
  });
}

function githubAssignees(issue: { assignees?: Array<{ login?: string }> }): string[] {
  return (issue.assignees ?? []).flatMap((assignee) => typeof assignee.login === "string" ? [assignee.login] : []);
}

function githubSummary(issue: GitHubIssue, reference: Extract<IssueRef, { provider: "github" }>): IssueSummary {
  return summary("github", {
    id: String(issue.id ?? `${reference.owner}/${reference.repo}#${issue.number}`),
    title: issue.title,
    state: { id: issue.state, name: issue.state, type: issue.state === "closed" ? "completed" : "open" },
    url: issue.html_url ?? reference.url ?? null,
    labels: githubLabels(issue),
    assignees: githubAssignees(issue),
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
  }, reference);
}

function jiraSummary(issue: JiraIssueSummary, reference?: IssueRef): IssueSummary {
  const ref: IssueRef = reference ?? {
    provider: "jira",
    siteUrl: new URL(issue.url).origin,
    key: issue.key,
    url: issue.url,
  };
  return summary("jira", {
    id: issue.id,
    title: issue.title,
    state: { id: issue.status.id, name: issue.status.name, type: issue.status.category },
    url: issue.url,
    labels: issue.labels,
    assignees: issue.assignee ? [issue.assignee.displayName] : [],
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }, ref);
}

function linearIssueDetail(issue: NonNullable<LinearIssue>, comments: Awaited<ReturnType<IssueTracker["fetchIssueComments"]>>): IssueDetail {
  const base = linearSummary(issue);
  return {
    ...base,
    body: issue.description ?? "",
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: comment.userDisplayName || comment.userName || null,
      createdAt: comment.createdAt,
      updatedAt: comment.createdAt,
    })),
    commentsCursor: null,
  };
}

function githubIssueDetail(issue: GitHubIssue, reference: Extract<IssueRef, { provider: "github" }>, comments: GitHubIssueComment[]): IssueDetail {
  const base = githubSummary(issue, reference);
  return {
    ...base,
    body: issue.body ?? "",
    comments: comments.map((comment) => ({
      id: String(comment.id),
      body: comment.body,
      author: comment.user?.login ?? null,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url ?? null,
    })),
    commentsCursor: null,
  };
}

function jiraIssueDetail(issue: JiraIssueDetail, reference?: IssueRef): IssueDetail {
  return {
    ...jiraSummary(issue, reference),
    body: issue.description,
    comments: issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: comment.author?.displayName ?? null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    commentsCursor: issue.commentsCursor,
  };
}

function parseOffset(cursor?: string | null): number {
  const offset = Number.parseInt(cursor ?? "0", 10);
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

export function createLinearIssueTrackerAdapter(tracker: IssueTracker): IssueTrackerAdapter {
  return {
    kind: "linear",
    capabilities: { create: true, comment: true, edit: true, labels: true, assignees: true, states: true, templates: true },
    async getViewer() {
      return await withIssueTrackerError("linear", "getViewer", async () => {
        const status = await tracker.getConnectionStatus();
        return { id: status.viewerId, name: status.viewerName };
      });
    },
    async listIssues(args) {
      return await withIssueTrackerError("linear", "listIssues", async () => {
        const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 25)));
        const stateTypes = args.state === "open"
          ? ["backlog", "unstarted", "started"]
          : args.state === "closed" || args.state === "done"
            ? ["completed", "canceled"]
            : undefined;
        const result = await tracker.searchIssues({
          teamKey: args.scope || undefined,
          query: args.query || undefined,
          stateTypes,
          first: limit,
          after: args.cursor ?? undefined,
        });
        return {
          issues: result.issues.map((issue) => linearSummary(issue)),
          nextCursor: result.pageInfo.hasNextPage ? result.pageInfo.endCursor : null,
        };
      });
    },
    async getIssue(reference) {
      const ref = reference as Extract<IssueRef, { provider: "linear" }>;
      return await withIssueTrackerError("linear", "getIssue", async () => {
        const issue = await tracker.fetchIssueById(ref.identifier);
        if (!issue) throw new IssueTrackerError("linear", "getIssue", "not-found", `Linear issue ${ref.identifier} was not found.`);
        const comments = await tracker.fetchIssueComments(issue.id);
        return linearIssueDetail(issue, comments);
      });
    },
    async getComments(reference, cursor) {
      const ref = reference as Extract<IssueRef, { provider: "linear" }>;
      if (cursor) throw new IssueTrackerError("linear", "getComments", "invalid", "Linear comments do not use a page cursor.");
      return await withIssueTrackerError("linear", "getComments", async () => {
        const issue = await tracker.fetchIssueById(ref.identifier);
        if (!issue) throw new IssueTrackerError("linear", "getComments", "not-found", `Linear issue ${ref.identifier} was not found.`);
        return { comments: (await tracker.fetchIssueComments(issue.id)).map((comment) => ({
          id: comment.id,
          body: comment.body,
          author: comment.userDisplayName || comment.userName || null,
          createdAt: comment.createdAt,
          updatedAt: comment.createdAt,
        })), nextCursor: null } satisfies IssueCommentsPage;
      });
    },
    async comment(reference, body) {
      const ref = reference as Extract<IssueRef, { provider: "linear" }>;
      await withIssueTrackerError("linear", "comment", async () => {
        const issue = await tracker.fetchIssueById(ref.identifier);
        if (!issue) throw new IssueTrackerError("linear", "comment", "not-found", `Linear issue ${ref.identifier} was not found.`);
        await tracker.createComment(issue.id, body);
      });
    },
    async update(reference, patch) {
      const ref = reference as Extract<IssueRef, { provider: "linear" }>;
      await withIssueTrackerError("linear", "update", async () => {
        const issue = await tracker.fetchIssueById(ref.identifier);
        if (!issue) throw new IssueTrackerError("linear", "update", "not-found", `Linear issue ${ref.identifier} was not found.`);
        if (patch.labels !== undefined) {
          const available = await tracker.listLabels(issue.teamKey);
          const byName = new Map(available.map((label) => [label.name.toLocaleLowerCase(), label.id]));
          const requested = patch.labels.map((label) => byName.get(label.toLocaleLowerCase()));
          if (requested.some((id) => !id)) throw new IssueTrackerError("linear", "update", "invalid", "One or more Linear labels were not found in the issue's team.");
          const current = issue.labelColors?.flatMap((label) => label.id ? [label.id] : []) ?? [];
          const wanted = requested as string[];
          await tracker.updateIssue(issue.id, {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.body !== undefined ? { description: patch.body } : {}),
            addedLabelIds: wanted.filter((id) => !current.includes(id)),
            removedLabelIds: current.filter((id) => !wanted.includes(id)),
          });
        } else if (patch.title !== undefined || patch.body !== undefined) {
          await tracker.updateIssue(issue.id, {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.body !== undefined ? { description: patch.body } : {}),
          });
        }
        if (patch.assignees !== undefined) {
          if (patch.assignees.length > 1) throw new IssueTrackerError("linear", "update", "invalid", "Linear issues have one assignee; pass one user id or an empty list.");
          await tracker.updateIssueAssignee(issue.id, patch.assignees[0] ?? null);
        }
      });
    },
    async setState(reference, state) {
      const ref = reference as Extract<IssueRef, { provider: "linear" }>;
      await withIssueTrackerError("linear", "setState", async () => {
        const issue = await tracker.fetchIssueById(ref.identifier);
        if (!issue) throw new IssueTrackerError("linear", "setState", "not-found", `Linear issue ${ref.identifier} was not found.`);
        const states = await tracker.listWorkflowStates(issue.teamKey);
        const matches = states.filter((entry) => entry.id === state || entry.name.toLocaleLowerCase() === state.toLocaleLowerCase());
        if (matches.length !== 1) throw new IssueTrackerError("linear", "setState", "invalid", matches.length ? `State '${state}' is ambiguous.` : `State '${state}' is not available for ${issue.teamKey}.`);
        await tracker.updateIssueState(issue.id, matches[0]!.id);
      });
    },
    async create(args) {
      return await withIssueTrackerError("linear", "create", async () => {
        const teamKey = args.scope.trim().toUpperCase();
        if (!teamKey) throw new IssueTrackerError("linear", "create", "invalid", "A Linear team key is required.");
        const labels = args.labels?.length ? await tracker.listLabels(teamKey) : [];
        const labelIds = (args.labels ?? []).map((name) => labels.find((label) => label.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.id);
        if (labelIds.some((id) => !id)) throw new IssueTrackerError("linear", "create", "invalid", "One or more Linear labels were not found in the team.");
        if ((args.assignees?.length ?? 0) > 1) throw new IssueTrackerError("linear", "create", "invalid", "Linear issues have one assignee; pass one user id.");
        const issue = await tracker.createIssue({
          teamKey,
          title: args.title,
          description: args.body,
          labelIds: labelIds as string[],
          assigneeId: args.assignees?.[0] ?? null,
          templateId: args.template,
        });
        const comments = await tracker.fetchIssueComments(issue.id);
        return linearIssueDetail(issue, comments);
      });
    },
    async listStates(args) {
      return await withIssueTrackerError("linear", "listStates", async () => {
        return (await tracker.listWorkflowStates(args.scope || undefined)).map((state) => ({
          id: state.id, name: state.name, type: state.type,
        }));
      });
    },
  };
}

export function createGithubIssueTrackerAdapter(github: GithubService): IssueTrackerAdapter {
  const resolveRepo = async (scope: string | undefined) => {
    if (scope?.trim()) {
      const match = /^([^/]+)\/([^/]+)$/.exec(scope.trim());
      if (!match) throw new IssueTrackerError("github", "resolve", "invalid", "GitHub scope must be owner/repository.");
      return { owner: match[1]!, name: match[2]! };
    }
    const repo = await github.detectRepo();
    if (!repo) throw new IssueTrackerError("github", "resolve", "not-connected", "No GitHub repository is configured for this project.");
    return repo;
  };

  return {
    kind: "github",
    capabilities: { create: true, comment: true, edit: true, labels: true, assignees: true, states: true, templates: false },
    async getViewer() {
      return await withIssueTrackerError("github", "getViewer", async () => {
        const status = await github.getStatus();
        return { id: status.userLogin, name: status.userLogin };
      });
    },
    async listIssues(args) {
      return await withIssueTrackerError("github", "listIssues", async () => {
        const repo = await resolveRepo(args.scope);
        const state = args.state === "closed" || args.state === "done" ? "closed" : args.state === "open" ? "open" : "all";
        const all = await github.listRepoIssueList(repo.owner, repo.name, state);
        const query = args.query?.trim().toLocaleLowerCase();
        const filtered = query
          ? all.filter((issue) => `${issue.title ?? ""}\n${issue.body ?? ""}`.toLocaleLowerCase().includes(query))
          : all;
        const offset = parseOffset(args.cursor);
        const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 25)));
        const selected = filtered.slice(offset, offset + limit);
        return {
          issues: selected.flatMap((issue) => {
            const number = Number(issue.number);
            if (!Number.isSafeInteger(number) || number <= 0) return [];
            const ref: Extract<IssueRef, { provider: "github" }> = { provider: "github", owner: repo.owner, repo: repo.name, number, url: issue.html_url ?? null };
            return [summary("github", {
              id: `${repo.owner}/${repo.name}#${number}`,
              title: issue.title ?? "",
              state: issue.state ? { id: issue.state, name: issue.state, type: issue.state === "closed" ? "completed" : "open" } : null,
              url: issue.html_url ?? null,
              labels: githubLabels(issue),
              assignees: githubAssignees(issue),
              createdAt: issue.created_at ?? null,
              updatedAt: issue.updated_at ?? null,
            }, ref)];
          }),
          nextCursor: offset + selected.length < filtered.length ? String(offset + selected.length) : null,
        } satisfies IssuePage;
      });
    },
    async getIssue(reference) {
      const ref = reference as Extract<IssueRef, { provider: "github" }>;
      return await withIssueTrackerError("github", "getIssue", async () => {
        const issue = await github.getIssue(ref.owner, ref.repo, ref.number);
        if (!issue) throw new IssueTrackerError("github", "getIssue", "not-found", `GitHub issue ${ref.owner}/${ref.repo}#${ref.number} was not found.`);
        const comments = await github.listIssueComments(ref.owner, ref.repo, ref.number);
        return githubIssueDetail(issue, ref, comments);
      });
    },
    async getComments(reference, cursor) {
      const ref = reference as Extract<IssueRef, { provider: "github" }>;
      if (cursor) throw new IssueTrackerError("github", "getComments", "invalid", "GitHub comments do not use a page cursor.");
      return await withIssueTrackerError("github", "getComments", async () => ({
        comments: (await github.listIssueComments(ref.owner, ref.repo, ref.number)).map((comment) => ({
          id: String(comment.id), body: comment.body, author: comment.user?.login ?? null,
          createdAt: comment.created_at, updatedAt: comment.updated_at, url: comment.html_url ?? null,
        })),
        nextCursor: null,
      }));
    },
    async comment(reference, body) {
      const ref = reference as Extract<IssueRef, { provider: "github" }>;
      await withIssueTrackerError("github", "comment", async () => {
        await github.commentOnIssue(ref.owner, ref.repo, ref.number, body);
      });
    },
    async update(reference, patch) {
      const ref = reference as Extract<IssueRef, { provider: "github" }>;
      await withIssueTrackerError("github", "update", async () => {
        await github.updateIssue(ref.owner, ref.repo, ref.number, {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
          ...(patch.assignees !== undefined ? { assignees: patch.assignees } : {}),
        });
      });
    },
    async setState(reference, state) {
      const ref = reference as Extract<IssueRef, { provider: "github" }>;
      await withIssueTrackerError("github", "setState", async () => {
        const normalized = state.trim().toLocaleLowerCase();
        if (normalized === "open" || normalized === "reopen") {
          await github.reopenIssue(ref.owner, ref.repo, ref.number);
        } else if (normalized === "closed" || normalized === "close" || normalized === "done" || normalized === "completed") {
          await github.closeIssue(ref.owner, ref.repo, ref.number, "completed");
        } else {
          throw new IssueTrackerError("github", "setState", "invalid", "GitHub state must be open or closed.");
        }
      });
    },
    async create(args) {
      return await withIssueTrackerError("github", "create", async () => {
        const repo = await resolveRepo(args.scope);
        const created = await github.createIssue(repo.owner, repo.name, {
          title: args.title,
          body: args.body,
          labels: args.labels,
          assignees: args.assignees,
        });
        const number = Number(created.issue.number);
        if (!Number.isSafeInteger(number) || number <= 0) throw new IssueTrackerError("github", "create", "failed", "GitHub created the issue but returned no issue number.");
        const ref: Extract<IssueRef, { provider: "github" }> = {
          provider: "github", owner: repo.owner, repo: repo.name, number, url: created.issue.html_url ?? null,
        };
        const issue = await github.getIssue(repo.owner, repo.name, number);
        return issue ? githubIssueDetail(issue, ref, []) : githubIssueDetail({
          number, title: created.issue.title ?? args.title, body: created.issue.body ?? args.body ?? "",
          state: created.issue.state === "closed" ? "closed" : "open",
          created_at: created.issue.created_at ?? new Date().toISOString(),
          updated_at: created.issue.updated_at ?? new Date().toISOString(),
          html_url: created.issue.html_url ?? "",
          labels: (created.issue.labels ?? []).flatMap((label) => typeof label === "string"
            ? [label]
            : label.name ? [label.name] : []),
          assignees: created.issue.assignees?.map((assignee) => ({ login: assignee.login ?? "" })) ?? [],
        }, ref, []);
      });
    },
    async listStates() {
      return [
        { id: "open", name: "Open", type: "open" },
        { id: "closed", name: "Closed", type: "completed" },
      ];
    },
  };
}

export function createJiraIssueTrackerAdapter(jira: JiraService): IssueTrackerAdapter {
  return {
    kind: "jira",
    capabilities: { create: true, comment: true, edit: true, labels: true, assignees: true, states: true, templates: false },
    async getViewer() {
      return await withIssueTrackerError("jira", "getViewer", async () => {
        const status = await jira.getConnectionStatus();
        return { id: status.account?.accountId ?? null, name: status.account?.displayName ?? null };
      });
    },
    async listIssues(args) {
      return await withIssueTrackerError("jira", "listIssues", async () => {
        const state = args.state === "closed" || args.state === "done" ? "done" : args.state === "all" ? "all" : "open";
        const projectKeys = args.scope ? [args.scope.toUpperCase()] : [];
        const page = await jira.listIssues({
          projectKeys,
          state,
          query: args.query,
          limit: args.limit,
          cursor: args.cursor,
        });
        return { issues: page.issues.map((issue) => jiraSummary(issue)), nextCursor: page.nextCursor };
      });
    },
    async getIssue(reference) {
      const ref = reference as Extract<IssueRef, { provider: "jira" }>;
      return await withIssueTrackerError("jira", "getIssue", async () => jiraIssueDetail(await jira.getIssue({ key: ref.key }), ref));
    },
    async getComments(reference, cursor) {
      const ref = reference as Extract<IssueRef, { provider: "jira" }>;
      return await withIssueTrackerError("jira", "getComments", async () => {
        const page = await jira.listComments({ key: ref.key, cursor: cursor ?? null });
        return {
          comments: page.comments.map((comment) => ({
            id: comment.id, body: comment.body, author: comment.author?.displayName ?? null,
            createdAt: comment.createdAt, updatedAt: comment.updatedAt,
          })),
          nextCursor: page.nextCursor,
        };
      });
    },
    async comment(reference, body) {
      const ref = reference as Extract<IssueRef, { provider: "jira" }>;
      await withIssueTrackerError("jira", "comment", async () => { await jira.addComment({ key: ref.key, body }); });
    },
    async update(reference, patch) {
      const ref = reference as Extract<IssueRef, { provider: "jira" }>;
      await withIssueTrackerError("jira", "update", async () => {
        const current = patch.assignees === undefined ? null : await jira.getIssue({ key: ref.key });
        const assigneeName = patch.assignees?.[0];
        let assigneeAccountId: string | null | undefined;
        if (patch.assignees !== undefined) {
          if (patch.assignees.length > 1) throw new IssueTrackerError("jira", "update", "invalid", "Pass one Jira account id, or an empty list to unassign.");
          if (!assigneeName) assigneeAccountId = null;
          else if (current?.assignee?.accountId === assigneeName) assigneeAccountId = assigneeName;
          else {
            const matches = await jira.listAssignableUsers({ key: ref.key, query: assigneeName });
            const exact = matches.filter((user) => user.accountId === assigneeName || user.displayName.toLocaleLowerCase() === assigneeName.toLocaleLowerCase());
            if (exact.length !== 1) throw new IssueTrackerError("jira", "update", "invalid", `Jira assignee '${assigneeName}' did not resolve to one account.`);
            assigneeAccountId = exact[0]!.accountId;
          }
        }
        await jira.updateIssue({
          key: ref.key,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { description: patch.body } : {}),
          ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
          ...(assigneeAccountId !== undefined ? { assigneeAccountId } : {}),
        });
      });
    },
    async setState(reference, state) {
      const ref = reference as Extract<IssueRef, { provider: "jira" }>;
      await withIssueTrackerError("jira", "setState", async () => {
        const transitions = await jira.listTransitions({ key: ref.key });
        const matches = transitions.filter((transition) =>
          transition.id === state
          || transition.name.toLocaleLowerCase() === state.toLocaleLowerCase()
          || transition.to.name.toLocaleLowerCase() === state.toLocaleLowerCase(),
        );
        if (matches.length !== 1) throw new IssueTrackerError("jira", "setState", "invalid", matches.length ? `State '${state}' is ambiguous.` : `No Jira transition reaches '${state}'.`);
        await jira.transitionIssue({ key: ref.key, transitionId: matches[0]!.id });
      });
    },
    async create(args) {
      return await withIssueTrackerError("jira", "create", async () => {
        const projectKey = args.scope.trim().toUpperCase();
        if (!projectKey) throw new IssueTrackerError("jira", "create", "invalid", "A Jira project key is required.");
        const meta = await jira.getCreateMeta({ projectKey });
        const typeQuery = args.issueType?.trim() ?? "";
        const issueTypes = meta.issueTypes.filter((type) => !typeQuery || type.id === typeQuery || type.name.toLocaleLowerCase() === typeQuery.toLocaleLowerCase());
        if (issueTypes.length !== 1) throw new IssueTrackerError("jira", "create", "invalid", issueTypes.length ? `Jira issue type '${typeQuery}' is ambiguous.` : `Choose an issue type with --type; project ${projectKey} has ${meta.issueTypes.length} available types.`);
        const created = await jira.createIssue({
          projectKey, issueTypeId: issueTypes[0]!.id, title: args.title,
          description: args.body, labels: args.labels,
          assigneeAccountId: args.assignees?.[0],
        });
        return jiraIssueDetail(await jira.getIssue({ key: created.key }));
      });
    },
    async listStates(args) {
      if (!args.reference || args.reference.provider !== "jira") {
        throw new IssueTrackerError("jira", "listStates", "invalid", "Jira workflow states require an issue reference.");
      }
      const ref = args.reference as Extract<IssueRef, { provider: "jira" }>;
      return await withIssueTrackerError("jira", "listStates", async () => (await jira.listTransitions({ key: ref.key })).map((transition) => ({
        id: transition.to.id, name: transition.to.name, type: transition.to.category,
      })));
    },
  };
}
