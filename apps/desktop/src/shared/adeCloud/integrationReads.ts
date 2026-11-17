/**
 * Linear and Jira reads of a project tab bound to ADE Cloud: the account
 * server runs them with the project's account-held sign-in
 * (`POST /cloud/integrations/*`), so the issue panes work with no computer on.
 *
 * - The request uses the runtime vocabulary of the panes (`linear_issue_tracker`
 *   and `jira` actions), so the panes call what they call today.
 * - The server passes Linear's and Jira's own data back. The shared mappers
 *   (`linearIssueNormalize.ts`, `jiraIssueMapping.ts`) turn it into the
 *   shapes the desktop's own Linear and Jira clients answer.
 * - Reads only. A write (an edit, a comment, a state change) is not handled:
 *   it needs a computer, and the caller refuses it with its sentence.
 * - A refusal comes back as an expected error with the server's sentence
 *   (`linear_needs_renewal`, `linear_renewing`, `rate_limited`, ...). An older
 *   server without the routes answers 404 (a null result): the read is not
 *   handled, so the caller keeps today's behavior.
 */

import { markExpected } from "../expectedError";
import { JIRA_LIST_FIELDS, buildJiraIssueJql, mapJiraComment, mapJiraIssueDetail, mapJiraIssueSummary } from "../jiraIssueMapping";
import {
  buildLinearIssueBaseFilter,
  mapLinearQuickViewProject,
  mapLinearQuickViewTeam,
  toNormalizedIssue,
} from "../linearIssueNormalize";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearCustomView,
  CtoLinearIssueComment,
  CtoLinearProject,
  CtoLinearQuickView,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  LinearCatalogState,
  LinearConnectionStatus,
  NormalizedLinearIssue,
} from "../types";
import type { JiraConnectionStatus, JiraIssueDetail, JiraIssuePage, JiraListIssuesArgs } from "../types/jira";
import type { CloudLinearOp } from "../../../../account-directory/src/cloud/contract";
import type { AdeCloudAccountCallFn } from "./accountCalls";

type Request = { domain: string; action: string; args?: unknown; arg?: unknown };

/**
 * The web client's command names for these reads, in the runtime vocabulary
 * `answer` takes (the web Linear calls are `cto.*`, as `misc.ts` sends them).
 */
export const ADE_CLOUD_INTEGRATION_WEB_COMMANDS: Readonly<Record<string, { domain: string; action: string }>> = {
  "cto.getLinearConnectionStatus": { domain: "linear_issue_tracker", action: "getConnectionStatus" },
  "cto.getLinearQuickView": { domain: "linear_issue_tracker", action: "getQuickView" },
  "cto.getLinearProjects": { domain: "linear_issue_tracker", action: "listProjects" },
  "cto.getLinearIssuePickerData": { domain: "linear_issue_tracker", action: "getIssuePickerData" },
  "cto.searchLinearIssues": { domain: "linear_issue_tracker", action: "searchIssues" },
  "cto.getLinearIssue": { domain: "linear_issue_tracker", action: "fetchIssueById" },
  "cto.getLinearIssueComments": { domain: "linear_issue_tracker", action: "fetchIssueComments" },
  "cto.getLinearCustomViews": { domain: "linear_issue_tracker", action: "listCustomViews" },
  "jira.getConnectionStatus": { domain: "jira", action: "getConnectionStatus" },
  "jira.listIssues": { domain: "jira", action: "listIssues" },
  "jira.getIssue": { domain: "jira", action: "getIssue" },
  "jira.listComments": { domain: "jira", action: "listComments" },
};
type Answer = { handled: true; result: unknown } | { handled: false };
type Data = Record<string, unknown>;

/** A Linear or Jira read the account server could not complete, with its sentence. */
export type AdeCloudIntegrationError = Error & { code: string; status: number };

/** Codes that mean "not connected" for a connection status, not a failure. */
const LINEAR_NOT_CONNECTED = new Set(["linear_not_connected", "linear_needs_renewal", "linear_renewing"]);
const JIRA_NOT_CONNECTED = new Set(["jira_not_connected", "jira_site_unsupported"]);

/** The server has no integration routes (an older server): keep today's behavior. */
class NoRoute extends Error {}

function isRecord(value: unknown): value is Data {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nodes(value: unknown): Data[] {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes.filter(isRecord) : [];
}

function refusal(code: string, status: number, message: string): AdeCloudIntegrationError {
  return markExpected(Object.assign(new Error(message), { code, status }), "user");
}

function normalizedIssues(value: unknown): NormalizedLinearIssue[] {
  return nodes(value).map(toNormalizedIssue).filter((issue): issue is NormalizedLinearIssue => issue != null);
}

function pageInfo(value: unknown): CtoSearchLinearIssuesResult["pageInfo"] {
  const info = isRecord(value) && isRecord(value.pageInfo) ? value.pageInfo : {};
  return { hasNextPage: info.hasNextPage === true, endCursor: str(info.endCursor) };
}

/** "VER-404" or "#404": an identifier search also matches on the issue number (as the desktop client does). */
function identifierFilter(term: string): Data | null {
  const keyed = term.match(/^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/);
  const bare = term.match(/^#?(\d+)$/);
  const numberText = keyed ? keyed[2]! : bare ? bare[1]! : null;
  if (!numberText) return null;
  const parsed = Number.parseInt(numberText, 10);
  if (!Number.isFinite(parsed)) return null;
  return { number: { eq: parsed }, ...(keyed ? { team: { key: { eqIgnoreCase: keyed[1]! } } } : {}) };
}

function andFilters(...parts: Array<Data | null | undefined>): Data | null {
  const kept = parts.filter((part): part is Data => part != null && Object.keys(part).length > 0);
  if (kept.length === 0) return null;
  return kept.length === 1 ? kept[0]! : { and: kept };
}

export function createAdeCloudIntegrationReads(accountCall: () => AdeCloudAccountCallFn | null) {
  const linear = async (origin: string, op: CloudLinearOp, vars?: Data): Promise<{ data: Data; authMode: "manual" | "oauth" }> => {
    const call = accountCall();
    if (!call) throw new NoRoute();
    const answer = await call({ call: "linearQuery", origin, op, ...(vars ? { vars } : {}) });
    if (!answer.ok) throw refusal(answer.code, answer.status, answer.message);
    if (!answer.result) throw new NoRoute();
    return { data: isRecord(answer.result.data) ? answer.result.data : {}, authMode: answer.result.authMode };
  };

  const jiraSearch = async (origin: string, input: { jql: string; maxResults?: number; nextPageToken?: string | null; fields?: string[] }) => {
    const call = accountCall();
    if (!call) throw new NoRoute();
    const answer = await call({ call: "jiraSearch", origin, ...input });
    if (!answer.ok) throw refusal(answer.code, answer.status, answer.message);
    if (!answer.result) throw new NoRoute();
    return answer.result;
  };

  const jiraIssue = async (origin: string, key: string) => {
    const call = accountCall();
    if (!call) throw new NoRoute();
    const answer = await call({ call: "jiraIssue", origin, key });
    if (!answer.ok) throw refusal(answer.code, answer.status, answer.message);
    // Null: Jira has no such issue, or this sign-in can't see it. (An older
    // server has no search either, so the connection read above already
    // left the pane as it is today.)
    if (!answer.result) throw refusal("not_found", 404, `Jira has no issue ${key}, or your Jira sign-in can't see it.`);
    return answer.result;
  };

  // ---- Linear ----

  const linearStatus = async (origin: string): Promise<LinearConnectionStatus> => {
    const checkedAt = new Date().toISOString();
    try {
      const { data, authMode } = await linear(origin, "identity");
      const viewer = isRecord(data.viewer) ? data.viewer : {};
      const organization = isRecord(data.organization) ? data.organization : null;
      return {
        tokenStored: true,
        connected: true,
        viewerId: str(viewer.id),
        viewerName: str(viewer.displayName) ?? str(viewer.name),
        organizationId: organization ? str(organization.id) : null,
        organizationName: organization ? str(organization.name) : null,
        organizationUrlKey: organization ? str(organization.urlKey) : null,
        organizationLogoUrl: organization ? str(organization.logoUrl) : null,
        checkedAt,
        message: null,
        authMode,
        // A sign-in starts on a computer, not from a tab with no computer.
        oauthAvailable: false,
      };
    } catch (error) {
      const code = (error as Partial<AdeCloudIntegrationError>).code;
      if (!code || !LINEAR_NOT_CONNECTED.has(code)) throw error;
      return {
        tokenStored: code !== "linear_not_connected",
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt,
        message: (error as Error).message,
        oauthAvailable: false,
      };
    }
  };

  const linearSearch = async (origin: string, input: CtoSearchLinearIssuesArgs): Promise<CtoSearchLinearIssuesResult> => {
    const first = typeof input.first === "number" && input.first >= 1 ? Math.min(50, Math.floor(input.first)) : 25;
    const after = str(input.after);
    const includeArchived = input.includeArchived === true;
    let viewFilter: Data | null = null;
    const viewId = str(input.customViewId);
    if (viewId) {
      const view = nodes((await linear(origin, "customViews")).data.customViews).find((node) => node.id === viewId);
      if (!view || !isRecord(view.filterData)) throw refusal("invalid", 400, "This Linear view has no issue filter ADE can apply.");
      viewFilter = view.filterData;
    }
    const filter = andFilters(viewFilter, buildLinearIssueBaseFilter(input));
    const term = str(input.query);
    if (!term) {
      const { data } = await linear(origin, "issues", { first, after, includeArchived, filter });
      return { issues: normalizedIssues(data.issues), pageInfo: pageInfo(data.issues) };
    }
    const exact = after ? null : identifierFilter(term);
    const [search, matches] = await Promise.all([
      linear(origin, "searchIssues", { term, first, after, includeArchived, filter }),
      exact
        ? linear(origin, "issues", { first: 5, includeArchived, filter: andFilters(filter, exact) }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const found = normalizedIssues(search.data.searchIssues);
    const extra = matches ? normalizedIssues(matches.data.issues).filter((issue) => !found.some((entry) => entry.id === issue.id)) : [];
    const totalCount = isRecord(search.data.searchIssues) && typeof search.data.searchIssues.totalCount === "number"
      ? search.data.searchIssues.totalCount
      : null;
    return { issues: [...extra, ...found], pageInfo: pageInfo(search.data.searchIssues), totalCount };
  };

  const linearProjects = async (origin: string) =>
    nodes((await linear(origin, "projects")).data.projects).map(mapLinearQuickViewProject).filter((project) => project.id && project.slug);

  const linearTeams = async (origin: string) => nodes((await linear(origin, "teams")).data.teams);

  const linearQuickView = async (origin: string): Promise<CtoLinearQuickView> => {
    const connection = await linearStatus(origin);
    if (!connection.connected) {
      return {
        connection,
        organization: null,
        viewer: null,
        projects: [],
        teams: [],
        assignedIssues: [],
        recentIssues: [],
        fetchedAt: new Date().toISOString(),
        sdk: { packageName: "@linear/sdk", surfaces: [] },
      };
    }
    const [identity, projects, teams, recent, assigned] = await Promise.all([
      linear(origin, "identity"),
      linearProjects(origin).catch(() => []),
      linearTeams(origin).catch(() => [] as Data[]),
      linearSearch(origin, { first: 12 }).catch(() => null),
      linearSearch(origin, { first: 12, assignedToViewer: true }).catch(() => null),
    ]);
    const viewer = isRecord(identity.data.viewer) ? identity.data.viewer : {};
    const organization = isRecord(identity.data.organization) ? identity.data.organization : null;
    return {
      connection,
      organization: organization ? {
        id: String(organization.id ?? ""),
        name: String(organization.name ?? "Linear"),
        urlKey: str(organization.urlKey),
        logoUrl: str(organization.logoUrl),
        gitBranchFormat: null,
        createdIssueCount: null,
        roadmapEnabled: null,
        customersEnabled: null,
        releasesEnabled: null,
      } : null,
      viewer: {
        id: String(viewer.id ?? ""),
        name: String(viewer.name ?? viewer.displayName ?? "Linear user"),
        displayName: String(viewer.displayName ?? viewer.name ?? "Linear user"),
        email: str(viewer.email),
        avatarUrl: str(viewer.avatarUrl),
        admin: null,
        guest: null,
        url: null,
      },
      projects,
      teams: teams.map(mapLinearQuickViewTeam).filter((team) => team.id && team.key).slice(0, 8),
      assignedIssues: assigned?.issues ?? [],
      recentIssues: recent?.issues ?? [],
      fetchedAt: new Date().toISOString(),
      sdk: { packageName: "@linear/sdk", surfaces: ["viewer", "organization", "projects", "teams", "assignedIssues", "issues"] },
    };
  };

  const linearPickerData = async (origin: string): Promise<CtoGetLinearIssuePickerDataResult> => {
    const [projects, teams] = await Promise.all([linearProjects(origin), linearTeams(origin)]);
    const states: LinearCatalogState[] = [];
    for (const team of teams) {
      const teamId = str(team.id);
      const teamKey = str(team.key);
      if (!teamId || !teamKey) continue;
      for (const state of nodes(team.states)) {
        const id = str(state.id);
        const name = str(state.name);
        const type = str(state.type);
        if (id && name && type) states.push({ id, name, type, teamId, teamKey });
      }
    }
    const rows: CtoLinearProject[] = projects.map(({ id, name, slug, teamName, teamKey, icon, color }) => ({ id, name, slug, teamName, teamKey, icon, color }));
    // Linear's users list is not one of the account's fixed reads: the picker shows no people.
    return { projects: rows, users: [], states };
  };

  const linearCustomViews = async (origin: string): Promise<CtoLinearCustomView[]> =>
    nodes((await linear(origin, "customViews")).data.customViews)
      .filter((node) => node.modelName === "Issue" && isRecord(node.filterData) && Object.keys(node.filterData).length > 0)
      .flatMap((node) => {
        const id = str(node.id);
        const name = str(node.name);
        if (!id || !name) return [];
        return [{
          id,
          name,
          description: str(node.description),
          icon: str(node.icon),
          color: str(node.color),
          teamKey: isRecord(node.team) ? str(node.team.key) : null,
          shared: node.shared === true,
        }];
      });

  const linearIssue = async (origin: string, id: string): Promise<NormalizedLinearIssue | null> => {
    const { data } = await linear(origin, "issue", { id });
    return isRecord(data.issue) ? toNormalizedIssue(data.issue) : null;
  };

  const linearComments = async (origin: string, issueId: string): Promise<CtoLinearIssueComment[]> => {
    const { data } = await linear(origin, "comments", { issueId, first: 50 });
    const issue = isRecord(data.issue) ? data.issue : {};
    return nodes(issue.comments).flatMap((node) => {
      const id = str(node.id);
      if (!id) return [];
      const user = isRecord(node.user) ? node.user : {};
      return [{
        id,
        body: typeof node.body === "string" ? node.body : "",
        createdAt: str(node.createdAt) ?? "",
        userName: str(user.name) ?? "Linear user",
        userDisplayName: str(user.displayName) ?? str(user.name) ?? "Linear user",
        userAvatarUrl: str(user.avatarUrl),
      }];
    });
  };

  // ---- Jira ----

  const jiraStatus = async (origin: string): Promise<JiraConnectionStatus> => {
    const checkedAt = new Date().toISOString();
    try {
      // One small search: it proves the project's Jira sign-in works and names the site.
      const page = await jiraSearch(origin, { jql: "ORDER BY updated DESC", maxResults: 1, fields: ["summary"] });
      return { connected: true, siteUrl: page.siteUrl, email: null, account: null, error: null, checkedAt };
    } catch (error) {
      const code = (error as Partial<AdeCloudIntegrationError>).code;
      if (!code || !JIRA_NOT_CONNECTED.has(code)) throw error;
      return {
        connected: false,
        siteUrl: null,
        email: null,
        account: null,
        error: code === "jira_site_unsupported" ? { reason: "invalid", message: (error as Error).message } : null,
        checkedAt,
      };
    }
  };

  const jiraList = async (origin: string, input: JiraListIssuesArgs): Promise<JiraIssuePage> => {
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const page = await jiraSearch(origin, {
      jql: buildJiraIssueJql(input),
      maxResults: limit,
      fields: JIRA_LIST_FIELDS,
      nextPageToken: input.cursor ?? null,
    });
    return { issues: page.issues.map((issue) => mapJiraIssueSummary(issue, page.siteUrl)), nextCursor: page.nextPageToken };
  };

  // Read-only: a tab with no computer edits nothing, so every permission is off.
  const READ_ONLY = { edit: false, comment: false, transition: false, assign: false };

  const jiraDetail = async (origin: string, key: string): Promise<JiraIssueDetail> => {
    const found = await jiraIssue(origin, key);
    // The issue read holds every comment this tab can show: no "more" to offer (older ones open on Jira).
    return { ...mapJiraIssueDetail(found.issue, found.siteUrl, READ_ONLY), commentsCursor: null };
  };

  const jiraComments = async (origin: string, key: string, cursor: string | null) => {
    const found = await jiraIssue(origin, key);
    const fields = isRecord(found.issue.fields) ? found.issue.fields : {};
    const field = isRecord(fields.comment) ? fields.comment : {};
    const all = (Array.isArray(field.comments) ? field.comments : []).map(mapJiraComment);
    const start = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
    // The issue read holds the comments Jira sends with an issue; older ones open on Jira.
    return { comments: all.slice(start), nextCursor: null };
  };

  const record = (value: unknown): Data => (isRecord(value) ? value : {});

  /** The answer to one read, or `handled: false` for an action that is not a Linear or Jira read. */
  const answer = async (scope: { origin: string | null }, request: Request): Promise<Answer> => {
    const origin = scope.origin?.trim();
    if (!origin) return { handled: false };
    const args = record(request.args);
    const run = async (read: () => Promise<unknown>): Promise<Answer> => {
      try {
        return { handled: true, result: await read() };
      } catch (error) {
        if (error instanceof NoRoute) return { handled: false };
        throw error;
      }
    };
    const key = `${request.domain}.${request.action}`;
    switch (key) {
      case "linear_issue_tracker.getConnectionStatus":
        return run(() => linearStatus(origin));
      case "linear_issue_tracker.getQuickView":
        return run(() => linearQuickView(origin));
      case "linear_issue_tracker.searchIssues":
        return run(() => linearSearch(origin, args as CtoSearchLinearIssuesArgs));
      case "linear_issue_tracker.listProjects":
        return run(() => linearProjects(origin));
      case "linear_issue_tracker.getIssuePickerData":
        return run(() => linearPickerData(origin));
      case "linear_issue_tracker.listCustomViews":
        return run(() => linearCustomViews(origin));
      case "linear_issue_tracker.fetchIssueById": {
        // The desktop sends the id as `arg`; the web sends the IPC args (`{ issueId }`).
        const id = str(request.arg) ?? str(args.issueId);
        return id ? run(() => linearIssue(origin, id)) : { handled: false };
      }
      case "linear_issue_tracker.fetchIssueComments": {
        const id = str(request.arg) ?? str(args.issueId);
        return id ? run(() => linearComments(origin, id)) : { handled: false };
      }
      case "jira.getConnectionStatus":
        return run(() => jiraStatus(origin));
      case "jira.listIssues":
        return run(() => jiraList(origin, args as JiraListIssuesArgs));
      case "jira.getIssue": {
        const issueKey = str(args.key);
        return issueKey ? run(() => jiraDetail(origin, issueKey)) : { handled: false };
      }
      case "jira.listComments": {
        const issueKey = str(args.key);
        return issueKey ? run(() => jiraComments(origin, issueKey, str(args.cursor))) : { handled: false };
      }
      default:
        return { handled: false };
    }
  };

  return { answer };
}

export type AdeCloudIntegrationReads = ReturnType<typeof createAdeCloudIntegrationReads>;
