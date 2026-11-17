import { accountRepoScopeKey } from "../../../desktop/src/shared/accountSettingsScope";
import type { CloudWaitUntil } from "./analytics";
import { renewLinearGrant, type LinearRenewalEnv } from "./linearRenewal";
import {
  CLOUD_INTEGRATION_REQUESTS_PER_MINUTE,
  CLOUD_LINEAR_OPS,
  CLOUD_LINEAR_RENEWING_MESSAGE,
  type CloudJiraIssueResult,
  type CloudJiraSearchResult,
  type CloudLinearOp,
  type CloudLinearQueryResult,
} from "./contract";
import { readVaultItem, readVaultScope, relayFetch, type RelayEnv, type VaultRecord } from "./accountVault";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { logCloud } from "./store";

/**
 * Linear and Jira for a client with no computer
 * (`POST /cloud/integrations/linear/query`, `.../jira/search`,
 * `.../jira/issue`). The connection is the project's vault item every
 * computer already uses (scope `repo:<origin>`, kind `integration`, key
 * `linear` or `jira`), read with the caller's own bearer. A token lives in
 * this request's memory only: never stored, never logged, never sent back.
 *
 * Linear runs fixed GraphQL documents only (`LINEAR_DOCUMENTS`), never a
 * caller's query. Its OAuth token rotates under the "one owner renews"
 * protocol (desktop `rotatingCredentialOwner.ts`); when it has run out, this
 * server renews it under that protocol (`linearRenewal.ts`) if the grant names
 * ADE's own client, and the request answers `linear_renewing` meanwhile.
 * Otherwise it answers `linear_needs_renewal`. Jira calls go only to
 * `https://<site>.atlassian.net`.
 */

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TIMEOUT_MS = 15_000;
const JIRA_TIMEOUT_MS = 15_000;
/** A token this close to its expiry is treated as expired: a request can take this long. */
const LINEAR_EXPIRY_MARGIN_MS = 60_000;
const LEGACY_PAGES = 4;
/** Largest answer passed back from Linear or Jira. */
const MAX_UPSTREAM_BYTES = 4_000_000;
/** Largest `filter` a Linear search may carry, as JSON. */
const MAX_FILTER_CHARS = 8_000;

export const LINEAR_NEEDS_RENEWAL_MESSAGE = "Linear needs one of your computers to renew its sign-in. Open ADE on a computer once.";

/* ---- Linear documents: the fields mirror the desktop's linearClientShared.ts and linearQuickView.ts. ---- */

const ISSUE_REF_FIELDS = "id identifier title state { id name type }";
const ISSUE_BASE_FIELDS = `
    id identifier title description url branchName priority createdAt updatedAt dueDate estimate
    archivedAt completedAt canceledAt startedAt
    project { id name slug: slugId }
    team { id key name }
    state { id name type }
    assignee { id name displayName avatarUrl }
    creator { id name displayName }
    labels { nodes { id name color } }
    cycle { id name startsAt endsAt }
    parent { ${ISSUE_REF_FIELDS} }`;
const ISSUE_FIELDS = `${ISSUE_BASE_FIELDS}
    children(first: 25) { nodes { ${ISSUE_REF_FIELDS} } }
    inverseRelations(first: 10) { nodes { type issue { ${ISSUE_REF_FIELDS} } } }`;
const ISSUE_DETAIL_FIELDS = `${ISSUE_BASE_FIELDS}
    children(first: 50) { nodes { ${ISSUE_REF_FIELDS} } }
    relations(first: 25) { nodes { type relatedIssue { ${ISSUE_REF_FIELDS} } } }
    inverseRelations(first: 25) { nodes { type issue { ${ISSUE_REF_FIELDS} } } }`;

type LinearVars = Record<string, unknown>;
type LinearDocument = { query: string; vars: (input: Record<string, unknown>) => LinearVars | string };

const str = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
const first = (value: unknown, max: number, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;
const after = (value: unknown): string | null => str(value, 500);

function filterOf(value: unknown): Record<string, unknown> | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "filter must be an object.";
  return JSON.stringify(value).length > MAX_FILTER_CHARS ? "That filter is too big." : value as Record<string, unknown>;
}

const LINEAR_DOCUMENTS: Record<CloudLinearOp, LinearDocument> = {
  identity: {
    query: "query AdeCloudIdentity { viewer { id name displayName email avatarUrl } organization { id name urlKey logoUrl } }",
    vars: () => ({}),
  },
  teams: {
    query: `query AdeCloudTeams {
      teams(first: 100, includeArchived: false) {
        nodes { id key name displayName color issueCount cyclesEnabled private states { nodes { id name type } } }
      }
    }`,
    vars: () => ({}),
  },
  projects: {
    query: `query AdeCloudProjects {
      projects(first: 50, includeArchived: false) {
        nodes {
          id name slugId url color icon description health progress scope priority priorityLabel
          startDate targetDate issueCountHistory completedIssueCountHistory
          status { name type } lead { id name displayName } teams(first: 4) { nodes { key name } }
        }
      }
    }`,
    vars: () => ({}),
  },
  issues: {
    query: `query AdeCloudIssues($first: Int!, $after: String, $includeArchived: Boolean!, $filter: IssueFilter) {
      issues(first: $first, after: $after, includeArchived: $includeArchived, orderBy: updatedAt, filter: $filter) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    vars: (input) => {
      const filter = filterOf(input.filter);
      if (typeof filter === "string") return filter;
      return { first: first(input.first, 50, 25), after: after(input.after), includeArchived: input.includeArchived === true, filter };
    },
  },
  searchIssues: {
    query: `query AdeCloudSearchIssues($term: String!, $first: Int!, $after: String, $includeArchived: Boolean!, $filter: IssueFilter) {
      searchIssues(term: $term, first: $first, after: $after, includeArchived: $includeArchived, filter: $filter) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    vars: (input) => {
      const term = str(input.term, 500);
      if (!term) return "term is required.";
      const filter = filterOf(input.filter);
      if (typeof filter === "string") return filter;
      return { term, first: first(input.first, 50, 25), after: after(input.after), includeArchived: input.includeArchived === true, filter };
    },
  },
  issue: {
    query: `query AdeCloudIssue($id: String!) { issue(id: $id) { ${ISSUE_DETAIL_FIELDS} } }`,
    vars: (input) => {
      const id = str(input.id, 100);
      return id ? { id } : "id is required.";
    },
  },
  issuesByIds: {
    query: `query AdeCloudIssuesByIds($ids: [ID!]!) { issues(filter: { id: { in: $ids } }, first: 50) { nodes { ${ISSUE_FIELDS} } } }`,
    vars: (input) => {
      const ids = Array.isArray(input.ids) ? input.ids.flatMap((id) => (str(id, 100) ? [str(id, 100)!] : [])) : [];
      return ids.length && ids.length <= 50 ? { ids } : "ids must hold 1 to 50 issue ids.";
    },
  },
  comments: {
    query: `query AdeCloudComments($issueId: String!, $first: Int!, $after: String) {
      issue(id: $issueId) {
        comments(first: $first, after: $after, orderBy: createdAt) {
          pageInfo { hasNextPage endCursor }
          nodes { id body createdAt user { id name displayName avatarUrl } }
        }
      }
    }`,
    vars: (input) => {
      const issueId = str(input.issueId, 100);
      return issueId ? { issueId, first: first(input.first, 50, 50), after: after(input.after) } : "issueId is required.";
    },
  },
  customViews: {
    query: `query AdeCloudCustomViews {
      customViews(first: 50) { nodes { id name description icon color shared modelName filterData team { key } } }
    }`,
    vars: () => ({}),
  },
  notifications: {
    query: `query AdeCloudNotifications($first: Int!) {
      notifications(first: $first, orderBy: createdAt) {
        nodes {
          id type createdAt readAt snoozedUntilAt archivedAt title subtitle url actorAvatarUrl actorInitials isLinearActor
          actor { id name displayName avatarUrl }
          botActor { name }
          ... on IssueNotification {
            issue { id identifier title url state { name type } }
            comment { id body }
          }
        }
      }
    }`,
    vars: (input) => ({ first: first(input.first, 100, 50) }),
  },
};

/* ---- Per-account request budget ---- */

/**
 * Counts one request against the account's minute for `bucket`. True when it
 * is within `limit`. One row per account and bucket; a new minute resets it.
 */
async function takeRequest(env: RelayEnv, userId: string, bucket: string, limit: number, now: number): Promise<boolean> {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const row = await env.DB.prepare(`
    insert into cloud_request_windows (user_id, bucket, window_start, count) values (?, ?, ?, 1)
    on conflict (user_id, bucket) do update set
      count = case when cloud_request_windows.window_start = excluded.window_start then cloud_request_windows.count + 1 else 1 end,
      window_start = excluded.window_start
    returning count
  `).bind(userId, bucket, windowStart).first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/* ---- Vault ---- */

async function readConnection(env: RelayEnv, authorization: string, scope: string, key: "linear" | "jira"): Promise<VaultRecord | null | undefined> {
  const ref = { scope, kind: "integration", key };
  const read = await readVaultItem(env, authorization, ref);
  if (read.ok) return read.value;
  if (read.reason === "failed") return undefined;
  const rows = await readVaultScope(env, authorization, scope, LEGACY_PAGES, { partial: true });
  if (!rows) return undefined;
  return rows.find((row) => row.kind === ref.kind && row.key === ref.key && !row.deleted) ?? null;
}

type LinearToken = { authorization: string; authMode: "manual" | "oauth" };

/**
 * The header Linear takes, or why there is none. An OAuth token is used only
 * well inside its expiry; past it, the caller asks `renewLinearGrant`.
 */
export function linearToken(raw: string | null, now: number): LinearToken | "not_connected" | "needs_renewal" {
  if (!raw) return "not_connected";
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return "not_connected";
    parsed = value as Record<string, unknown>;
  } catch {
    return "not_connected";
  }
  const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
  if (parsed.v !== 1 || !token) return "not_connected";
  if (parsed.authMode === "manual") return { authorization: token.replace(/^bearer\s+/i, ""), authMode: "manual" };
  if (parsed.authMode !== "oauth") return "not_connected";
  const expiresAt = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : NaN;
  // No expiry recorded: Linear says when it is spent (401).
  if (Number.isFinite(expiresAt) && expiresAt <= now + LINEAR_EXPIRY_MARGIN_MS) return "needs_renewal";
  return { authorization: /^bearer\s+/i.test(token) ? token : `Bearer ${token}`, authMode: "oauth" };
}

/* ---- Jira ---- */

/** `https://<site>.atlassian.net` from a stored site URL, or null for anything else (the SSRF guard). */
export function jiraSiteOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(host)) return null;
  return `https://${host}`;
}

type JiraConnection = { origin: string; authorization: string };

function jiraConnectionOf(raw: string | null): JiraConnection | "not_connected" | "bad_site" {
  if (!raw) return "not_connected";
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return "not_connected";
    parsed = value as Record<string, unknown>;
  } catch {
    return "not_connected";
  }
  const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
  const apiToken = typeof parsed.apiToken === "string" ? parsed.apiToken : "";
  if (parsed.v !== 1 || !email || !apiToken) return "not_connected";
  const origin = jiraSiteOrigin(parsed.siteUrl);
  if (!origin) return "bad_site";
  const basic = btoa(String.fromCharCode(...new TextEncoder().encode(`${email}:${apiToken}`)));
  return { origin, authorization: `Basic ${basic}` };
}

const JIRA_FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
const JIRA_ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}-\d{1,9}$/;
const JIRA_DEFAULT_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter", "labels", "parent", "project", "created", "updated"];
const JIRA_ISSUE_FIELDS = "summary,description,status,issuetype,priority,assignee,reporter,labels,parent,project,created,updated,duedate,subtasks,comment";

/* ---- Shared ---- */

async function readUpstream(response: Response): Promise<unknown | null> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_UPSTREAM_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const text = await response.text();
  if (text.length > MAX_UPSTREAM_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const tooMany = () => fail("rate_limited", "Too many Linear and Jira requests from this account in the last minute. Try again in a minute.", 429);
const vaultUnavailable = () => fail("unavailable", "ADE can't reach your account's connections right now. Try again soon.", 503);

async function prepare(request: Request, env: RelayEnv, userId: string, now: number): Promise<
  { ok: true; body: Record<string, unknown>; authorization: string; scope: string } | { ok: false; response: Response }
> {
  if (request.method !== "POST") return { ok: false, response: fail("not_found", "ADE Cloud has no such route.", 404) };
  const authorization = request.headers.get("authorization");
  if (!authorization) return { ok: false, response: fail("unauthorized", "Sign in to ADE to use ADE Cloud.", 401) };
  if (!relayFetch(env)) return { ok: false, response: vaultUnavailable() };
  const body = await readJson(request);
  if (!body) return { ok: false, response: fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400) };
  const scope = accountRepoScopeKey(typeof body.origin === "string" ? body.origin : null);
  if (!scope) return { ok: false, response: fail("bad_request", "That isn't a repository ADE can name.", 400) };
  if (!await takeRequest(env, userId, "integrations", CLOUD_INTEGRATION_REQUESTS_PER_MINUTE, now)) {
    logCloud("cloud.integration_rate_limited", {});
    return { ok: false, response: tooMany() };
  }
  return { ok: true, body, authorization, scope };
}

/** `POST /cloud/integrations/linear/query`. */
export async function routeLinearQuery(request: Request, env: LinearRenewalEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  const prepared = await prepare(request, env, userId, now);
  if (!prepared.ok) return prepared.response;
  const { body, authorization, scope } = prepared;
  const op = typeof body.op === "string" && (CLOUD_LINEAR_OPS as readonly string[]).includes(body.op) ? body.op as CloudLinearOp : null;
  if (!op) return fail("bad_request", "ADE Cloud doesn't run that Linear request.", 400);
  const document = LINEAR_DOCUMENTS[op];
  const vars = document.vars(body.vars && typeof body.vars === "object" && !Array.isArray(body.vars) ? body.vars as Record<string, unknown> : {});
  if (typeof vars === "string") return fail("bad_request", vars, 400);

  const stored = await readConnection(env, authorization, scope, "linear");
  if (stored === undefined) return vaultUnavailable();
  let token = linearToken(stored?.value ?? null, now);
  if (token === "not_connected") {
    return fail("linear_not_connected", "Linear isn't connected for this project. Connect it in ADE on a computer.", 409);
  }
  if (token === "needs_renewal" && stored) {
    const renewal = await renewLinearGrant(env, { authorization, userId, scope, item: stored, now, waitUntil });
    if (renewal === "renewing") return fail("linear_renewing", CLOUD_LINEAR_RENEWING_MESSAGE, 409);
    if (renewal !== "needs_renewal") token = { authorization: `Bearer ${renewal.grant.token}`, authMode: "oauth" };
  }
  if (token === "needs_renewal") {
    logCloud("cloud.linear_needs_renewal", {});
    return fail("linear_needs_renewal", LINEAR_NEEDS_RENEWAL_MESSAGE, 409);
  }

  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: token.authorization, "user-agent": "ADE" },
      body: JSON.stringify({ query: document.query, variables: vars }),
      redirect: "manual",
      signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
    });
  } catch (error) {
    logCloud("cloud.linear_query_failed", { op, error: error instanceof Error ? error.name : "unknown" });
    return fail("unavailable", "ADE can't reach Linear right now. Try again soon.", 503);
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    logCloud("cloud.linear_query_refused", { op, status: 401, authMode: token.authMode });
    return token.authMode === "oauth"
      ? fail("linear_needs_renewal", LINEAR_NEEDS_RENEWAL_MESSAGE, 409)
      : fail("linear_not_connected", "Linear refused this project's API key. Connect Linear again in ADE on a computer.", 409);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    return fail("rate_limited", "Linear asked ADE to slow down. Try again in a minute.", 429);
  }
  const answer = await readUpstream(response) as { data?: unknown; errors?: unknown } | null;
  if (!response.ok || !answer || typeof answer !== "object" || !answer.data || typeof answer.data !== "object") {
    logCloud("cloud.linear_query_refused", { op, status: response.status });
    return fail("integration_failed", "Linear didn't answer that request. Try again soon.", 502);
  }
  const result: CloudLinearQueryResult = { op, data: answer.data as Record<string, unknown>, authMode: token.authMode };
  return json(result);
}

async function jiraCall(env: RelayEnv, prepared: { authorization: string; scope: string }, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<
  { ok: true; origin: string; value: Record<string, unknown> } | { ok: false; response: Response }
> {
  const stored = await readConnection(env, prepared.authorization, prepared.scope, "jira");
  if (stored === undefined) return { ok: false, response: vaultUnavailable() };
  const connection = jiraConnectionOf(stored?.value ?? null);
  if (connection === "not_connected") {
    return { ok: false, response: fail("jira_not_connected", "Jira isn't connected for this project. Connect it in ADE on a computer.", 409) };
  }
  if (connection === "bad_site") {
    logCloud("cloud.jira_site_refused", {});
    return { ok: false, response: fail("jira_site_unsupported", "ADE Cloud reads only Jira sites at atlassian.net. Use ADE on a computer for this Jira site.", 409) };
  }
  let response: Response;
  try {
    response = await fetch(`${connection.origin}${path}`, {
      method: init.method,
      headers: {
        accept: "application/json",
        authorization: connection.authorization,
        "user-agent": "ADE",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // A redirect could leave atlassian.net: it is refused, never followed.
      redirect: "manual",
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    });
  } catch (error) {
    logCloud("cloud.jira_call_failed", { error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, response: fail("unavailable", "ADE can't reach Jira right now. Try again soon.", 503) };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, response: fail("jira_not_connected", "Jira refused this project's sign-in. Connect Jira again in ADE on a computer.", 409) };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, response: fail("not_found", "Jira has no such issue, or this sign-in can't see it.", 404) };
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, response: fail("rate_limited", "Jira asked ADE to slow down. Try again in a minute.", 429) };
  }
  const value = await readUpstream(response);
  if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) {
    logCloud("cloud.jira_call_refused", { status: response.status });
    return { ok: false, response: fail("integration_failed", "Jira didn't answer that request. Try again soon.", 502) };
  }
  return { ok: true, origin: connection.origin, value: value as Record<string, unknown> };
}

/** `POST /cloud/integrations/jira/search`. */
export async function routeJiraSearch(request: Request, env: RelayEnv, userId: string, now: number): Promise<Response> {
  const prepared = await prepare(request, env, userId, now);
  if (!prepared.ok) return prepared.response;
  const { body } = prepared;
  const jql = str(body.jql, 4_000);
  if (!jql) return fail("bad_request", "jql is required.", 400);
  const fields = body.fields === undefined ? JIRA_DEFAULT_FIELDS : Array.isArray(body.fields) ? body.fields : null;
  if (!fields || fields.length > 40 || fields.some((field) => typeof field !== "string" || !JIRA_FIELD.test(field))) {
    return fail("bad_request", "fields must be up to 40 Jira field names.", 400);
  }
  const nextPageToken = body.nextPageToken == null ? null : str(body.nextPageToken, 2_000);
  if (body.nextPageToken != null && !nextPageToken) return fail("bad_request", "nextPageToken can't be read.", 400);
  const called = await jiraCall(env, prepared, "/rest/api/3/search/jql", {
    method: "POST",
    body: { jql, maxResults: first(body.maxResults, 100, 50), fields, ...(nextPageToken ? { nextPageToken } : {}) },
  });
  if (!called.ok) return called.response;
  const result: CloudJiraSearchResult = {
    siteUrl: called.origin,
    issues: Array.isArray(called.value.issues) ? called.value.issues as Record<string, unknown>[] : [],
    nextPageToken: typeof called.value.nextPageToken === "string" ? called.value.nextPageToken : null,
  };
  return json(result);
}

/** `POST /cloud/integrations/jira/issue`: one issue with its comments. */
export async function routeJiraIssue(request: Request, env: RelayEnv, userId: string, now: number): Promise<Response> {
  const prepared = await prepare(request, env, userId, now);
  if (!prepared.ok) return prepared.response;
  const key = typeof prepared.body.key === "string" ? prepared.body.key.trim() : "";
  if (!JIRA_ISSUE_KEY.test(key)) return fail("bad_request", "That isn't a Jira issue key.", 400);
  const called = await jiraCall(env, prepared, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(JIRA_ISSUE_FIELDS)}`, { method: "GET" });
  if (!called.ok) return called.response;
  const result: CloudJiraIssueResult = { siteUrl: called.origin, issue: called.value };
  return json(result);
}
