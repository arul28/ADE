// The Linear GraphQL client, in the plugin's own process.
//
// Plain `fetch` against `api.linear.app` rather than `@linear/sdk`, for the
// reason `ade-cursor-cloud` gives for skipping Cursor's SDK: `fetch` is the
// door the child's network guard watches, so `"network": {"hosts":
// ["api.linear.app"]}` in the manifest is a declaration that is enforced and
// whose refusals reach `ade plugin doctor`. An SDK's own transport is not.
//
// ## The two credential kinds are not interchangeable
//
// Linear takes a personal API key (`lin_api_…`) as a BARE `authorization`
// value and an OAuth access token as `Bearer <token>`. Sending the wrong one
// is a 400 with a message about the header rather than a 401, so a client that
// guessed would report "Linear refused this token" for a token that is fine.
// `LINEAR_AUTH_MODE` — the same `"manual" | "oauth"` vocabulary ADE stores and
// the credential handoff copies — is what decides, and an unknown mode is an
// error rather than a guess.
//
// ## Refresh is this plugin's own network call
//
// The handoff copies the access token, the refresh token, the expiry and the
// client id. It deliberately WITHHOLDS ADE's OAuth client secret, because that
// is ADE's identity to Linear rather than the user's. So the refresh here is a
// public-client PKCE refresh: `grant_type=refresh_token` with `client_id` and
// no secret. See the gap list in the wave report for what happens if Linear
// ever requires the secret on that grant.

"use strict";

const GRAPHQL_URL = "https://api.linear.app/graphql";
const TOKEN_URL = "https://api.linear.app/oauth/token";

/** One request's ceiling. Linear answers a page of issues well inside this. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Attempts after the first, matching the built-in client's budget. */
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_START_MS = 500;
const BACKOFF_CAP_MS = 15_000;
/**
 * Refresh this far before the token actually expires. Same two minutes the
 * built-in uses: long enough to cover a slow request that started just under
 * the wire, short enough not to churn a token every call.
 */
const REFRESH_BUFFER_MS = 2 * 60_000;

/** Secret names. These are the handoff's names, so a handed-over credential needs no copy. */
const SECRET_ACCESS_TOKEN = "LINEAR_ACCESS_TOKEN";
const SECRET_REFRESH_TOKEN = "LINEAR_REFRESH_TOKEN";
const SECRET_EXPIRES_AT = "LINEAR_TOKEN_EXPIRES_AT";
const SECRET_AUTH_MODE = "LINEAR_AUTH_MODE";
const SECRET_CLIENT_ID = "LINEAR_OAUTH_CLIENT_ID";

/** Fields every issue query selects. Kept as one string so two queries cannot drift. */
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  createdAt
  updatedAt
  dueDate
  estimate
  archivedAt
  completedAt
  project { id name }
  team { id key name }
  state { id name type }
  assignee { id name displayName }
  creator { id name displayName }
  labels { nodes { id name color } }
  children { nodes { id identifier title state { id name type } } }
`;

/**
 * One failure a caller can branch on.
 *
 * A `code` rather than a parsed sentence, because the settings panel draws a
 * different state for each: `no_token` points at Connect, `unauthorized` says
 * the credential was refused, `rate_limited` says wait, and everything else is
 * a message beside the rows the reader already has.
 */
class LinearApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "LinearApiError";
    this.code = code;
    if (details && typeof details === "object") Object.assign(this, details);
  }
}

/** True for the one error the panel answers with "connect Linear". */
function isMissingTokenError(error) {
  return Boolean(error) && error.code === "no_token";
}

/**
 * Build the `authorization` value for a token and its mode.
 *
 * Idempotent on an already-prefixed OAuth token and strips a stray prefix from
 * an API key, so a credential a user pasted with "Bearer " in front of it still
 * works. An unknown mode throws rather than passing the token through: a
 * credential whose kind we do not know is one we cannot send correctly.
 */
function authorizationHeader(token, authMode) {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) throw new LinearApiError("no_token", "No Linear credential is stored for this plugin.");
  if (authMode === "oauth") {
    return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
  }
  if (authMode === "manual") {
    return trimmed.replace(/^bearer\s+/i, "");
  }
  throw new LinearApiError(
    "no_token",
    "The stored Linear credential does not say whether it is an API key or an OAuth token.",
  );
}

/** Is this expiry close enough to act on? No expiry means a token that does not expire. */
function tokenNeedsRefresh(expiresAt, nowMs, bufferMs = REFRESH_BUFFER_MS) {
  if (!expiresAt) return false;
  const at = Date.parse(String(expiresAt));
  if (Number.isNaN(at)) return false;
  return nowMs >= at - bufferMs;
}

function firstGraphQLError(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  return errors.length > 0 ? errors[0] : null;
}

/**
 * Turn one non-2xx or GraphQL-error answer into a `LinearApiError`.
 *
 * Linear reports rate limiting three different ways depending on which layer
 * refuses — an HTTP 429, an `extensions.code` of `RATELIMITED`, or a plain
 * sentence — so all three are folded into the one code a caller can wait on.
 */
function errorFor(status, payload, headers) {
  const graphError = firstGraphQLError(payload);
  const message = typeof graphError?.message === "string" ? graphError.message.trim() : "";
  const code = graphError?.extensions?.code ?? null;
  const rateLimited = status === 429
    || code === "RATELIMITED"
    || (message ? /rate\s*limit|too\s*many\s*requests/i.test(message) : false);

  if (rateLimited) {
    return new LinearApiError("rate_limited", message || "Linear is rate limiting this credential.", {
      status,
      retryAfterMs: retryAfterMs(headers),
    });
  }
  if (status === 401 || status === 403 || code === "AUTHENTICATION_ERROR") {
    return new LinearApiError("unauthorized", message || "Linear refused this credential.", { status });
  }
  if (status === 400 || status === 422) {
    return new LinearApiError("validation", message || "Linear refused the request.", { status });
  }
  if (message) return new LinearApiError("http", message, { status });
  return new LinearApiError("http", `Linear returned ${status}.`, { status });
}

/** `Retry-After` in ms, when the server named one. Seconds or an HTTP date. */
function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(BACKOFF_CAP_MS, seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(BACKOFF_CAP_MS, at - Date.now()));
}

/**
 * What Linear says is left of the request budget.
 *
 * The built-in client reads no rate-limit headers at all and finds out it is
 * limited by being refused. Reading them costs nothing and lets the settings
 * panel show the budget before a bulk refresh spends it.
 */
function readRateLimit(headers) {
  const remaining = Number(headers?.get?.("x-ratelimit-requests-remaining"));
  const resetAt = Number(headers?.get?.("x-ratelimit-requests-reset"));
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(resetAt) ? new Date(resetAt).toISOString() : null,
  };
}

/**
 * Build the client.
 *
 * Every dependency is injected so the whole surface is testable with no
 * network: `secrets`, `fetch`, `sleep` and `now` are what the tests replace.
 */
function createLinearApi(options = {}) {
  const {
    secrets,
    fetch: fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    log = () => {},
    graphqlUrl = GRAPHQL_URL,
    tokenUrl = TOKEN_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (!secrets || typeof secrets.get !== "function" || typeof secrets.set !== "function") {
    throw new TypeError("createLinearApi needs a secrets store with get and set");
  }

  /** The last rate-limit reading, for the settings panel. Never a credential. */
  let rateLimit = { remaining: null, resetAt: null };
  /** One refresh at a time inside this process, so a burst does not spend the refresh token twice. */
  let refreshInFlight = null;

  async function readCredential() {
    const [token, authMode, expiresAt, refreshToken, clientId] = await Promise.all([
      secrets.get(SECRET_ACCESS_TOKEN),
      secrets.get(SECRET_AUTH_MODE),
      secrets.get(SECRET_EXPIRES_AT),
      secrets.get(SECRET_REFRESH_TOKEN),
      secrets.get(SECRET_CLIENT_ID),
    ]);
    return {
      token: token ? String(token).trim() : null,
      authMode: authMode === "oauth" ? "oauth" : authMode === "manual" ? "manual" : null,
      expiresAt: expiresAt ? String(expiresAt) : null,
      refreshToken: refreshToken ? String(refreshToken).trim() : null,
      clientId: clientId ? String(clientId).trim() : null,
    };
  }

  async function writeToken({ accessToken, refreshToken, expiresAt }) {
    await secrets.set(SECRET_ACCESS_TOKEN, accessToken);
    await secrets.set(SECRET_AUTH_MODE, "oauth");
    if (refreshToken) await secrets.set(SECRET_REFRESH_TOKEN, refreshToken);
    if (expiresAt) await secrets.set(SECRET_EXPIRES_AT, expiresAt);
  }

  /**
   * Exchange a refresh token for a new access token.
   *
   * Public-client shape: `client_id` and no `client_secret`, because the
   * handoff withholds ADE's. Returns the new credential; throws
   * `unauthorized` when Linear says `invalid_grant`, which is the one failure
   * that means "make the user connect again" rather than "try later".
   */
  async function refreshAccessToken(credential) {
    if (!credential.refreshToken || !credential.clientId) {
      throw new LinearApiError(
        "unauthorized",
        "This Linear connection has expired and has no refresh token. Connect Linear again.",
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
    });
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new LinearApiError("network", `Could not reach Linear to refresh the token: ${error?.message ?? error}`);
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok || !payload?.access_token) {
      const reason = typeof payload?.error === "string" ? payload.error : null;
      if (reason === "invalid_grant") {
        throw new LinearApiError("unauthorized", "Linear rejected the refresh token. Connect Linear again.", {
          invalidGrant: true,
        });
      }
      throw new LinearApiError("http", `Linear refused the token refresh (HTTP ${response.status}).`, {
        status: response.status,
      });
    }
    const expiresAt = Number.isFinite(payload.expires_in)
      ? new Date(now() + payload.expires_in * 1000).toISOString()
      : null;
    const next = {
      accessToken: String(payload.access_token).trim(),
      refreshToken: payload.refresh_token ? String(payload.refresh_token).trim() : credential.refreshToken,
      expiresAt,
    };
    await writeToken(next);
    log("info", "Refreshed the Linear access token.");
    return { ...credential, token: next.accessToken, refreshToken: next.refreshToken, expiresAt, authMode: "oauth" };
  }

  /** Refresh, coalescing concurrent callers onto one network call. */
  async function refreshOnce(credential) {
    if (!refreshInFlight) {
      refreshInFlight = refreshAccessToken(credential).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  /**
   * The credential to send, refreshed first if it is about to expire.
   *
   * A proactive refresh failure is NOT fatal here: the stored token may still
   * have minutes left, and failing the read would turn a slow refresh endpoint
   * into an outage. A token Linear then refuses takes the reactive path below.
   */
  async function currentCredential() {
    let credential = await readCredential();
    if (!credential.token) {
      throw new LinearApiError("no_token", "No Linear credential is stored for this plugin.");
    }
    if (credential.authMode === "oauth" && tokenNeedsRefresh(credential.expiresAt, now())) {
      try {
        credential = await refreshOnce(credential);
      } catch (error) {
        if (error?.invalidGrant) throw error;
        log("warn", `Could not refresh the Linear token ahead of time: ${error?.message ?? error}`);
      }
    }
    return credential;
  }

  /**
   * Run one GraphQL operation, with retries.
   *
   * The retry budget covers transport failures, rate limiting and 5xx. A 4xx
   * other than 429 is the caller's problem and is not retried — retrying a
   * malformed query only spends the rate limit.
   *
   * The 401 path is separate and does not consume the retry budget: an expired
   * OAuth token is refreshed once and the request replayed. `didRefresh`
   * latches so a credential Linear keeps refusing fails on the second answer
   * rather than looping.
   */
  async function request(query, variables, requestOptions = {}) {
    const maxRetries = Number.isInteger(requestOptions.maxRetries)
      ? Math.max(0, requestOptions.maxRetries)
      : DEFAULT_MAX_RETRIES;
    let backoffMs = BACKOFF_START_MS;
    let didRefresh = false;
    let attempt = 0;

    for (;;) {
      const credential = await currentCredential();
      let response;
      let payload = null;
      try {
        response = await fetchImpl(graphqlUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: authorizationHeader(credential.token, credential.authMode),
          },
          body: JSON.stringify({
            query,
            ...(variables ? { variables } : {}),
            ...(requestOptions.operationName ? { operationName: requestOptions.operationName } : {}),
          }),
          ...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
      } catch (error) {
        if (attempt >= maxRetries) {
          throw new LinearApiError("network", `Could not reach Linear: ${error?.message ?? error}`);
        }
        attempt += 1;
        await sleep(backoffMs);
        backoffMs = Math.min(BACKOFF_CAP_MS, backoffMs * 2);
        continue;
      }

      rateLimit = readRateLimit(response.headers);
      const text = await response.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (response.ok && payload && !firstGraphQLError(payload)) {
        return payload.data ?? null;
      }

      const failure = errorFor(response.status, payload, response.headers);

      if (failure.code === "unauthorized" && credential.authMode === "oauth" && !didRefresh) {
        didRefresh = true;
        try {
          await refreshOnce(credential);
          continue;
        } catch (refreshError) {
          throw refreshError;
        }
      }

      const retryable = failure.code === "rate_limited" || (response.status >= 500 && response.status <= 599);
      if (!retryable || attempt >= maxRetries) throw failure;

      attempt += 1;
      await sleep(failure.retryAfterMs ?? backoffMs);
      backoffMs = Math.min(BACKOFF_CAP_MS, backoffMs * 2);
    }
  }

  /* ── Reads ───────────────────────────────────────────────────────────── */

  /**
   * Build Linear's `IssueFilter`.
   *
   * The trailing-digits clause is not a nicety. Linear's `IssueFilter` has no
   * `identifier` field, so a reader typing `ADE-14` cannot be matched on the
   * identifier at all — matching `number: {eq: 14}` beside the text search is
   * what makes typing an issue key find that issue.
   */
  function buildIssueFilter(query) {
    const filter = {};
    if (query.projectId) filter.project = { id: { eq: query.projectId } };
    if (query.teamKey) filter.team = { key: { eq: query.teamKey } };
    if (Array.isArray(query.stateTypes) && query.stateTypes.length > 0) {
      filter.state = { type: { in: query.stateTypes } };
    }
    if (query.assigneeId) filter.assignee = { id: { eq: query.assigneeId } };
    if (Number.isInteger(query.priority) && query.priority >= 0 && query.priority <= 4) {
      filter.priority = { eq: query.priority };
    }
    const text = typeof query.query === "string" ? query.query.trim() : "";
    if (text) {
      const or = [
        { title: { containsIgnoreCase: text } },
        { description: { containsIgnoreCase: text } },
      ];
      const trailingNumber = /(\d+)$/.exec(text);
      if (trailingNumber) or.push({ number: { eq: Number(trailingNumber[1]) } });
      filter.or = or;
    }
    return Object.keys(filter).length > 0 ? filter : null;
  }

  /** One page of issues, newest-updated first. */
  async function searchIssues(query = {}) {
    const first = Math.min(100, Math.max(1, Math.floor(query.first ?? 50)));
    const data = await request(
      `query SearchIssues($first: Int!, $after: String, $includeArchived: Boolean!, $filter: IssueFilter) {
        issues(first: $first, after: $after, includeArchived: $includeArchived, orderBy: updatedAt, filter: $filter) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      {
        first,
        after: query.after ?? null,
        includeArchived: query.includeArchived === true,
        filter: buildIssueFilter(query),
      },
      { maxRetries: 2, operationName: "SearchIssues" },
    );
    return {
      nodes: data?.issues?.nodes ?? [],
      hasNextPage: data?.issues?.pageInfo?.hasNextPage === true,
      endCursor: data?.issues?.pageInfo?.endCursor ?? null,
    };
  }

  /**
   * Walk pages until the ceiling.
   *
   * `maxIssues` is the caller's, not a constant here, because the collection
   * that stores the result has a per-plugin row budget and the ceiling belongs
   * where that budget is known.
   */
  async function searchAllIssues(query = {}, maxIssues = 500) {
    const collected = [];
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const remaining = maxIssues - collected.length;
      if (remaining <= 0) break;
      const result = await searchIssues({ ...query, first: Math.min(100, remaining), after });
      collected.push(...result.nodes);
      if (!result.hasNextPage || !result.endCursor) break;
      after = result.endCursor;
    }
    return collected;
  }

  /** One issue, by UUID or by identifier — Linear's `issue(id:)` resolves both. */
  async function fetchIssueById(issueId) {
    const data = await request(
      `query IssueById($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: issueId },
      { maxRetries: 2, operationName: "IssueById" },
    );
    return data?.issue ?? null;
  }

  /** Several issues at once, for a webhook that named more than one. */
  async function fetchIssuesByIds(issueIds) {
    const ids = [...new Set(issueIds.filter(Boolean))].slice(0, 50);
    if (ids.length === 0) return [];
    const data = await request(
      `query IssuesByIds($ids: [ID!]!) { issues(filter: { id: { in: $ids } }, first: 50) { nodes { ${ISSUE_FIELDS} } } }`,
      { ids },
      { maxRetries: 2, operationName: "IssuesByIds" },
    );
    return data?.issues?.nodes ?? [];
  }

  async function fetchIssueComments(issueId) {
    const data = await request(
      `query IssueComments($issueId: String!) {
        issue(id: $issueId) {
          comments(first: 50, orderBy: createdAt) {
            nodes { id body createdAt user { id name displayName } }
          }
        }
      }`,
      { issueId },
      { maxRetries: 2, operationName: "IssueComments" },
    );
    return data?.issue?.comments?.nodes ?? [];
  }

  /**
   * Teams and their workflow states in one round trip.
   *
   * The built-in fetches these separately and the panel needs both, so one
   * query saves a request against a budget the reader can see running down.
   */
  async function listTeamsAndStates(teamKey = null) {
    const data = teamKey
      ? await request(
        `query TeamStates($teamKey: String!) {
          teams(filter: { key: { eq: $teamKey } }) { nodes { id key name states { nodes { id name type } } } }
        }`,
        { teamKey },
        { maxRetries: 2, operationName: "TeamStates" },
      )
      : await request(
        `query AllTeamStates { teams(first: 100) { nodes { id key name states { nodes { id name type } } } } }`,
        null,
        { maxRetries: 2, operationName: "AllTeamStates" },
      );
    return data?.teams?.nodes ?? [];
  }

  async function listProjects() {
    const data = await request(
      `query Projects { projects(first: 100) { nodes { id name slugId } } }`,
      null,
      { maxRetries: 2, operationName: "Projects" },
    );
    return data?.projects?.nodes ?? [];
  }

  async function listUsers() {
    const data = await request(
      `query Users { users(first: 250, filter: { active: { eq: true } }) { nodes { id name displayName email } } }`,
      null,
      { maxRetries: 2, operationName: "Users" },
    );
    return data?.users?.nodes ?? [];
  }

  async function listLabels(teamKey = null) {
    const data = await request(
      `query Labels { issueLabels(first: 250) { nodes { id name color team { id key } } } }`,
      null,
      { maxRetries: 1, operationName: "Labels" },
    );
    const nodes = data?.issueLabels?.nodes ?? [];
    if (!teamKey) return nodes;
    return nodes.filter((label) => !label?.team?.key || label.team.key === teamKey);
  }

  /** Who this credential is, and which workspace it belongs to. */
  async function getConnectionIdentity() {
    const data = await request(
      `query ConnectionIdentity {
        viewer { id name displayName }
        organization { id name urlKey logoUrl }
      }`,
      null,
      { maxRetries: 1, operationName: "ConnectionIdentity" },
    );
    return {
      viewerId: data?.viewer?.id ?? null,
      viewerName: data?.viewer?.displayName ?? data?.viewer?.name ?? null,
      organizationId: data?.organization?.id ?? null,
      organizationName: data?.organization?.name ?? null,
      organizationUrlKey: data?.organization?.urlKey ?? null,
      organizationLogoUrl: data?.organization?.logoUrl ?? null,
    };
  }

  /* ── Writes ──────────────────────────────────────────────────────────── */

  async function updateIssueState(issueId, stateId) {
    await request(
      `mutation UpdateIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId },
      { maxRetries: 2, operationName: "UpdateIssueState" },
    );
  }

  /**
   * Set an issue's priority.
   *
   * 0..4 only, refused rather than clamped: Linear's scale has 0 meaning "no
   * priority" and 1 meaning urgent, so a caller sending 5 has misunderstood the
   * scale rather than overshot it, and clamping would silently make it "Low".
   */
  async function updateIssuePriority(issueId, priority) {
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new LinearApiError("validation", "A Linear priority is 0 (none) to 4 (low).");
    }
    await request(
      `mutation UpdateIssuePriority($id: String!, $priority: Int!) {
        issueUpdate(id: $id, input: { priority: $priority }) { success }
      }`,
      { id: issueId, priority },
      { maxRetries: 2, operationName: "UpdateIssuePriority" },
    );
  }

  async function updateIssueAssignee(issueId, assigneeId) {
    await request(
      `mutation UpdateIssueAssignee($id: String!, $assigneeId: String) {
        issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
      }`,
      { id: issueId, assigneeId: assigneeId ?? null },
      { maxRetries: 2, operationName: "UpdateIssueAssignee" },
    );
  }

  async function createComment(issueId, body) {
    const data = await request(
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
      }`,
      { issueId, body },
      { maxRetries: 2, operationName: "CreateComment" },
    );
    return data?.commentCreate?.comment?.id ?? null;
  }

  /**
   * Add a label by NAME.
   *
   * Linear's mutation takes label ids, so the name has to be resolved first.
   * A name that matches nothing is a `validation` error naming the label
   * rather than a silent no-op, because "I added it" for a label that does not
   * exist is the failure an agent would report as success.
   */
  async function addLabel(issueId, labelName, teamKey = null) {
    const wanted = String(labelName ?? "").trim().toLowerCase();
    if (!wanted) throw new LinearApiError("validation", "A label name is required.");
    const labels = await listLabels(teamKey);
    const match = labels.find((label) => String(label?.name ?? "").trim().toLowerCase() === wanted);
    if (!match) {
      throw new LinearApiError("validation", `Linear has no label called "${labelName}".`);
    }
    await request(
      `mutation AddIssueLabel($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { addedLabelIds: $labelIds }) { success }
      }`,
      { id: issueId, labelIds: [match.id] },
      { maxRetries: 2, operationName: "AddIssueLabel" },
    );
    return match.id;
  }

  return {
    LinearApiError,
    addLabel,
    createComment,
    fetchIssueById,
    fetchIssueComments,
    fetchIssuesByIds,
    getConnectionIdentity,
    listLabels,
    listProjects,
    listTeamsAndStates,
    listUsers,
    /** The last rate-limit reading. A plain object, never a credential. */
    rateLimitStatus: () => ({ ...rateLimit }),
    readCredential,
    request,
    searchAllIssues,
    searchIssues,
    updateIssueAssignee,
    updateIssuePriority,
    updateIssueState,
    writeToken,
  };
}

module.exports = {
  GRAPHQL_URL,
  ISSUE_FIELDS,
  LinearApiError,
  REFRESH_BUFFER_MS,
  SECRET_ACCESS_TOKEN,
  SECRET_AUTH_MODE,
  SECRET_CLIENT_ID,
  SECRET_EXPIRES_AT,
  SECRET_REFRESH_TOKEN,
  TOKEN_URL,
  authorizationHeader,
  createLinearApi,
  isMissingTokenError,
  tokenNeedsRefresh,
};
