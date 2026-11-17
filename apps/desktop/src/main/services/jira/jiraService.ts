import { markdownToJiraAdf } from "../../../shared/jiraAdf";
import { createJiraError, parseJiraError } from "../../../shared/jiraErrors";
import type {
  JiraComment,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraCreateField,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraCreateMeta,
  JiraIssueDetail,
  JiraListIssuesArgs,
  JiraPriority,
  JiraProject,
  JiraTransition,
  JiraUpdateIssueArgs,
  JiraUser,
} from "../../../shared/types/jira";
import {
  buildJiraIssueJql,
  JIRA_LIST_FIELDS,
  mapJiraComment as mapComment,
  mapJiraIssueDetail,
  mapJiraIssueSummary as mapIssueSummary,
  mapJiraIssueType as mapIssueType,
  mapJiraPriority as mapPriority,
  mapJiraProject as mapProject,
  mapJiraStatus as mapStatus,
  mapJiraUser as mapUser,
} from "../../../shared/jiraIssueMapping";
import { createJiraClient, normalizeJiraSiteUrl, type JiraClient } from "./jiraClient";

export { buildJiraIssueJql, quoteJiraJqlValue } from "../../../shared/jiraIssueMapping";
import type { JiraCredentialService } from "./jiraCredentialService";

type RecordValue = Record<string, unknown>;
type JiraServiceClient = Pick<JiraClient, "get" | "post" | "put" | "delete">;

const PROJECT_TTL_MS = 60_000;
const CREATE_META_TTL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 50;
const SUPPORTED_CREATE_FIELDS = new Set(["summary", "description", "labels", "assignee", "priority", "parent", "duedate"]);

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

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return search.toString();
}

/** How long a failed connection check stands before the next status read asks Jira again. */
const CONNECTION_RECHECK_MS = 5 * 60_000;

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

function issueKeyArg(key: string): string {
  const value = key.trim();
  if (!value) throw createJiraError("invalid", "A Jira issue key is required.");
  return encodePath(value);
}

function permissionGranted(result: unknown, key: string): boolean {
  return record(record(result).permissions)[key] ? record(record(record(result).permissions)[key]).havePermission === true : false;
}

export function createJiraService(args: {
  credentials: JiraCredentialService;
  fetchImpl?: typeof fetch;
  client?: JiraServiceClient;
  now?: () => number;
}) {
  const client = args.client ?? createJiraClient({ getCredentials: () => args.credentials.getCredentials(), fetchImpl: args.fetchImpl });
  const now = args.now ?? Date.now;
  let account: JiraUser | null = null;
  let lastError: JiraConnectionStatus["error"] = null;
  let checkedAt: string | null = null;
  let connectionProbe: Promise<void> | null = null;
  const projectCache = new Map<string, { expiresAt: number; value: JiraProject[] }>();
  const createMetaCache = new Map<string, { expiresAt: number; value: JiraCreateMeta }>();

  const status = (connected: boolean, creds = args.credentials.getCredentials()): JiraConnectionStatus => ({
    connected,
    siteUrl: creds?.siteUrl ?? null,
    email: creds?.email ?? null,
    account,
    error: lastError,
    checkedAt,
    credentialStorage: args.credentials.storage(),
  });

  // Bumped whenever the saved credentials change, so a request or status probe
  // that started under the old ones cannot write its outcome over the new ones.
  let credentialGeneration = 0;

  async function run<T>(callback: () => Promise<T>): Promise<T> {
    const generation = credentialGeneration;
    try {
      const result = await callback();
      if (generation !== credentialGeneration) return result;
      lastError = null;
      checkedAt = new Date(now()).toISOString();
      return result;
    } catch (error) {
      if (generation !== credentialGeneration) throw error;
      // Only a refused credential says the connection is broken; a missing
      // issue, bad JQL or a rate limit is about that one request.
      const parsed = parseJiraError(error);
      if (parsed?.reason === "unauthenticated") {
        lastError = { reason: parsed.reason, message: parsed.message };
        checkedAt = new Date(now()).toISOString();
      }
      throw error;
    }
  }

  async function permission(key: string, name: string): Promise<boolean> {
    const result = await client.get<unknown>(`rest/api/3/mypermissions?${query({ issueKey: key, permissions: name })}`);
    return permissionGranted(result, name);
  }

  async function requirePermission(key: string, name: string): Promise<void> {
    if (!(await permission(key, name))) throw createJiraError("forbidden", `Your Jira account does not have ${name.replace(/_/g, " ").toLowerCase()} permission for ${key}.`);
  }

  async function getConnectionStatus(): Promise<JiraConnectionStatus> {
    const creds = args.credentials.getCredentials();
    if (!creds) return status(false, null);
    const staleFailure = lastError !== null && checkedAt !== null
      && now() - Date.parse(checkedAt) > CONNECTION_RECHECK_MS;
    if (checkedAt === null || (!account && !lastError) || staleFailure) {
      if (!connectionProbe) {
        const generation = credentialGeneration;
        const probe: Promise<void> = (async () => {
          let nextAccount: JiraUser | null = null;
          let nextError: JiraConnectionStatus["error"] = null;
          try {
            nextAccount = mapUser(await client.get<unknown>("rest/api/3/myself"));
            if (!nextAccount) nextError = { reason: "failed", message: "Jira did not return an account." };
          } catch (error) {
            const parsed = parseJiraError(error);
            nextError = parsed ? { reason: parsed.reason, message: parsed.message } : { reason: "failed", message: asError(error).message };
          }
          if (generation !== credentialGeneration) return;
          account = nextAccount;
          lastError = nextError;
          checkedAt = new Date(now()).toISOString();
        })().finally(() => { if (connectionProbe === probe) connectionProbe = null; });
        connectionProbe = probe;
      }
      await connectionProbe;
    }
    return status(!lastError, creds);
  }

  async function connect(input: JiraConnectArgs): Promise<JiraConnectionStatus> {
    const credentials: JiraConnectArgs = {
      siteUrl: normalizeJiraSiteUrl(input.siteUrl),
      email: input.email.trim(),
      apiToken: input.apiToken.trim(),
    };
    if (!credentials.email || !credentials.apiToken) throw createJiraError("invalid", "Enter your Atlassian account email and API token.");
    // Candidate credentials are isolated from the saved connection diagnostics:
    // `run` records auth failures against whichever connection status is live.
    const myself = await client.get<unknown>("rest/api/3/myself", credentials);
    const candidateAccount = mapUser(myself);
    if (!candidateAccount) throw createJiraError("failed", "Jira did not return an account for these credentials.");
    args.credentials.setCredentials(credentials);
    credentialGeneration += 1;
    connectionProbe = null;
    account = candidateAccount;
    checkedAt = new Date(now()).toISOString();
    lastError = null;
    projectCache.clear();
    createMetaCache.clear();
    return status(true, credentials);
  }

  function disconnect(): JiraConnectionStatus {
    args.credentials.clearCredentials();
    credentialGeneration += 1;
    connectionProbe = null;
    account = null;
    lastError = null;
    checkedAt = new Date(now()).toISOString();
    projectCache.clear();
    createMetaCache.clear();
    return status(false, null);
  }

  async function listProjects(input: { query?: string } = {}): Promise<JiraProject[]> {
    return run(async () => {
      const search = input.query?.trim() ?? "";
      const cached = projectCache.get(search);
      if (cached && cached.expiresAt > now()) return cached.value;
      const projects: JiraProject[] = [];
      let startAt = 0;
      while (true) {
        const page = await client.get<unknown>(`rest/api/3/project/search?${query({ startAt, maxResults: 100, ...(search ? { query: search } : {}) })}`);
        const object = record(page);
        const values = array(object.values);
        projects.push(...values.map(mapProject));
        startAt += values.length;
        if (object.isLast === true || values.length === 0 || (typeof object.total === "number" && startAt >= object.total)) break;
      }
      projectCache.set(search, { expiresAt: now() + PROJECT_TTL_MS, value: projects });
      return projects;
    });
  }

  async function listIssues(input: JiraListIssuesArgs = {}) {
    return run(async () => {
      const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? DEFAULT_PAGE_SIZE)));
      const page = await client.post<unknown>("rest/api/3/search/jql", {
        jql: buildJiraIssueJql(input),
        maxResults: limit,
        fields: JIRA_LIST_FIELDS,
        ...(input.cursor ? { nextPageToken: input.cursor } : {}),
      });
      const response = record(page);
      const siteUrl = normalizeJiraSiteUrl(args.credentials.getCredentials()?.siteUrl ?? "");
      const issues = array(response.issues).map((issue) => mapIssueSummary(issue, siteUrl));
      return { issues, nextCursor: nullableString(response.nextPageToken) };
    });
  }

  async function getIssue(input: { key: string }): Promise<JiraIssueDetail> {
    return run(async () => {
      const key = input.key.trim();
      const issue = await client.get<unknown>(`rest/api/3/issue/${issueKeyArg(key)}?${query({
        fields: "summary,description,status,issuetype,priority,assignee,reporter,labels,parent,project,created,updated,duedate,subtasks,comment",
      })}`);
      const permissionNames = "EDIT_ISSUES,ADD_COMMENTS,TRANSITION_ISSUES,ASSIGN_ISSUES";
      const permissions = await client.get<unknown>(`rest/api/3/mypermissions?${query({ issueKey: key, permissions: permissionNames })}`);
      const siteUrl = normalizeJiraSiteUrl(args.credentials.getCredentials()?.siteUrl ?? "");
      return mapJiraIssueDetail(issue, siteUrl, {
        edit: permissionGranted(permissions, "EDIT_ISSUES"),
        comment: permissionGranted(permissions, "ADD_COMMENTS"),
        transition: permissionGranted(permissions, "TRANSITION_ISSUES"),
        assign: permissionGranted(permissions, "ASSIGN_ISSUES"),
      });
    });
  }

  async function listComments(input: { key: string; cursor: string | null }) {
    return run(async () => {
      const startAt = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
      const page = await client.get<unknown>(`rest/api/3/issue/${issueKeyArg(input.key)}/comment?${query({ startAt, maxResults: DEFAULT_PAGE_SIZE })}`);
      const response = record(page);
      const comments = array(response.comments).map(mapComment);
      const next = startAt + comments.length;
      const total = typeof response.total === "number" ? response.total : next;
      return { comments, nextCursor: next < total ? String(next) : null };
    });
  }

  async function addComment(input: { key: string; body: string }): Promise<JiraComment> {
    return run(async () => {
      const key = input.key.trim();
      await requirePermission(key, "ADD_COMMENTS");
      const comment = await client.post<unknown>(`rest/api/3/issue/${issueKeyArg(key)}/comment`, { body: markdownToJiraAdf(input.body) });
      return mapComment(comment);
    });
  }

  async function updateIssue(input: JiraUpdateIssueArgs): Promise<void> {
    return run(async () => {
      const key = input.key.trim();
      await requirePermission(key, "EDIT_ISSUES");
      const fields: Record<string, unknown> = {};
      if (input.title !== undefined) fields.summary = input.title;
      if (input.description !== undefined) fields.description = markdownToJiraAdf(input.description);
      if (input.labels !== undefined) fields.labels = input.labels;
      if (input.priorityId !== undefined) fields.priority = { id: input.priorityId };
      if (input.dueDate !== undefined) fields.duedate = input.dueDate;
      if (input.assigneeAccountId !== undefined) {
        await requirePermission(key, "ASSIGN_ISSUES");
        fields.assignee = input.assigneeAccountId ? { accountId: input.assigneeAccountId } : null;
      }
      await client.put<void>(`rest/api/3/issue/${issueKeyArg(key)}`, { fields });
    });
  }

  async function listTransitions(input: { key: string }): Promise<JiraTransition[]> {
    return run(async () => {
      const response = record(await client.get<unknown>(`rest/api/3/issue/${issueKeyArg(input.key)}/transitions?expand=transitions.fields`));
      return array(response.transitions).map((value) => {
        const transition = record(value);
        return { id: string(transition.id), name: string(transition.name), to: mapStatus(transition.to) };
      });
    });
  }

  async function transitionIssue(input: { key: string; transitionId: string }): Promise<void> {
    return run(async () => {
      const key = input.key.trim();
      await requirePermission(key, "TRANSITION_ISSUES");
      await client.post<void>(`rest/api/3/issue/${issueKeyArg(key)}/transitions`, { transition: { id: input.transitionId } });
    });
  }

  async function listAssignableUsers(input: { projectKey?: string; key?: string; query?: string } = {}): Promise<JiraUser[]> {
    return run(async () => {
      const response = await client.get<unknown>(`rest/api/3/user/assignable/search?${query({
        ...(input.key ? { issueKey: input.key } : {}),
        ...(!input.key && input.projectKey ? { projectKey: input.projectKey } : {}),
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        maxResults: 50,
      })}`);
      return array(response).map(mapUser).filter((user): user is JiraUser => user !== null);
    });
  }

  async function listLabels(input: { query?: string } = {}): Promise<string[]> {
    return run(async () => {
      const response = record(await client.get<unknown>(`rest/api/3/label?${query({ query: input.query?.trim() || undefined, maxResults: 100 })}`));
      const values = Array.isArray(response.values) ? response.values : Array.isArray(response.labels) ? response.labels : [];
      return values.map((value) => typeof value === "string" ? value : string(record(value).name)).filter(Boolean);
    });
  }

  async function getCreateMeta(input: { projectKey: string }): Promise<JiraCreateMeta> {
    return run(async () => {
      const projectKey = input.projectKey.trim().toUpperCase();
      const cached = createMetaCache.get(projectKey);
      if (cached && cached.expiresAt > now()) return cached.value;
      const issueTypePage = record(await client.get<unknown>(`rest/api/3/issue/createmeta/${encodePath(projectKey)}/issuetypes?${query({ maxResults: 100 })}`));
      const types = array(issueTypePage.issueTypes ?? issueTypePage.values);
      const issueTypes = await Promise.all(types.map(async (value) => {
        const type = mapIssueType(value);
        const details = record(await client.get<unknown>(`rest/api/3/issue/createmeta/${encodePath(projectKey)}/issuetypes/${encodePath(type.id)}`));
        const rawFields = record(details.fields ?? record(details.issueType).fields);
        const fields: JiraCreateField[] = Object.entries(rawFields).map(([id, raw]) => {
          const field = record(raw);
          return {
            id,
            name: string(field.name, id),
            required: field.required === true,
            supported: SUPPORTED_CREATE_FIELDS.has(id),
          };
        });
        return { ...type, fields };
      }));
      const prioritiesResponse = await client.get<unknown>("rest/api/3/priority");
      const meta: JiraCreateMeta = {
        projectKey,
        issueTypes,
        priorities: array(prioritiesResponse).map(mapPriority).filter((priority): priority is JiraPriority => priority !== null),
      };
      createMetaCache.set(projectKey, { expiresAt: now() + CREATE_META_TTL_MS, value: meta });
      return meta;
    });
  }

  async function createIssue(input: JiraCreateIssueArgs): Promise<JiraCreateIssueResult> {
    return run(async () => {
      const meta = await getCreateMeta({ projectKey: input.projectKey });
      const issueType = meta.issueTypes.find((type) => type.id === input.issueTypeId);
      if (!issueType) throw createJiraError("invalid", `Issue type '${input.issueTypeId}' is not available in ${meta.projectKey}.`);
      const unsupportedRequired = issueType.fields.filter((field) => field.required && !field.supported);
      if (unsupportedRequired.length) {
        throw createJiraError("invalid", `Jira requires ${unsupportedRequired.map((field) => field.name).join(", ")}, which ADE cannot set. Choose another issue type or update the Jira create screen.`);
      }
      const values: Record<string, unknown> = {
        project: { key: meta.projectKey },
        issuetype: { id: issueType.id },
        summary: input.title,
      };
      if (input.description !== undefined) values.description = markdownToJiraAdf(input.description);
      if (input.labels !== undefined) values.labels = input.labels;
      if (input.assigneeAccountId) values.assignee = { accountId: input.assigneeAccountId };
      if (input.priorityId) values.priority = { id: input.priorityId };
      if (input.parentKey) values.parent = { key: input.parentKey };
      if (input.dueDate) values.duedate = input.dueDate;
      for (const field of issueType.fields.filter((candidate) => candidate.required && candidate.supported)) {
        if (field.id === "description" && input.description === undefined) throw createJiraError("invalid", `Jira requires ${field.name}; provide a description before creating this issue.`);
        if (field.id === "assignee" && !input.assigneeAccountId) throw createJiraError("invalid", `Jira requires ${field.name}; choose an assignee before creating this issue.`);
        if (field.id === "priority" && !input.priorityId) throw createJiraError("invalid", `Jira requires ${field.name}; choose a priority before creating this issue.`);
        if (field.id === "parent" && !input.parentKey) throw createJiraError("invalid", `Jira requires ${field.name}; choose a parent issue before creating this issue.`);
        if (field.id === "duedate" && !input.dueDate) throw createJiraError("invalid", `Jira requires ${field.name}; choose a due date before creating this issue.`);
      }
      const created = record(await client.post<unknown>("rest/api/3/issue", { fields: values }));
      if (!created.key || !created.id) throw createJiraError("failed", "Jira created the issue but did not return its key.");
      return {
        id: string(created.id),
        key: string(created.key),
        url: `${normalizeJiraSiteUrl(args.credentials.getCredentials()?.siteUrl ?? "")}/browse/${encodeURIComponent(string(created.key))}`,
      };
    });
  }

  return {
    getConnectionStatus,
    connect,
    disconnect,
    listProjects,
    listIssues,
    getIssue,
    listComments,
    addComment,
    updateIssue,
    listTransitions,
    transitionIssue,
    listAssignableUsers,
    listLabels,
    getCreateMeta,
    createIssue,
  };
}
