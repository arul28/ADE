// Linear agent (actor=app) routes: webhook session routing, install/status/
// membership/settings, session claim/activity/update/start, and dispatch.

import {
  type AccountMappingRow,
  isRecord,
  json,
  readBoolean,
  readNested,
  readString,
  type RelayEnv,
  requireWebSocketUpgrade,
  text,
} from "./shared";
import {
  authenticateLinearAgentAccount,
  authenticateLinearAgentCaller,
  createLinearAgentActivity,
  encryptLinearAgentToken,
  importLinearAgentTokenKey,
  LINEAR_AGENT_ACK_BODY,
  LINEAR_AGENT_ACTIVITY_TYPES,
  LINEAR_AGENT_CLAIM_STALE_MS,
  LINEAR_AGENT_ELICITATION_SIGNALS,
  LINEAR_AGENT_EPHEMERAL_TYPES,
  LINEAR_AGENT_PLAN_STATUSES,
  LINEAR_AGENT_SESSION_RETENTION_DAYS,
  LINEAR_AGENT_SETTLED_STATE_TYPES,
  type LinearAgentActivityInput,
  type LinearAgentCaller,
  linearAgentError,
  linearAgentFailureResponse,
  linearAgentGraphql,
  type LinearAgentMemberRow,
  type LinearAgentSessionRoute,
  type LinearAgentSessionRow,
  linearGraphqlRequest,
  linearTopicObject,
  MAX_LINEAR_AGENT_EXTERNAL_URLS,
  MAX_LINEAR_AGENT_ID_LENGTH,
  MAX_LINEAR_AGENT_LABEL_LENGTH,
  MAX_LINEAR_AGENT_MEMBERS,
  MAX_LINEAR_AGENT_PLAN_STEPS,
  MAX_LINEAR_AGENT_TEXT_BYTES,
  MAX_LINEAR_AGENT_TOKEN_LENGTH,
  MAX_LINEAR_AGENT_URL_LENGTH,
  normalizeOAuthToken,
  readLinearAgentInstall,
  readLinearAgentJsonBody,
  utf8Length,
} from "./linearAgentCore";

/**
 * Returns null when the event is not an agent-session event the relay can act
 * on (no install, unknown session): the caller then stores it like any other
 * Linear event.
 */
export async function routeLinearAgentSessionEvent(
  env: RelayEnv,
  organizationId: string,
  action: string,
  payload: Record<string, unknown>,
  receivedAt: string,
): Promise<LinearAgentSessionRoute | null> {
  const agentSession = readNested(payload, "agentSession");
  const sessionId = readString(agentSession, "id");
  if (!sessionId || sessionId.length > MAX_LINEAR_AGENT_ID_LENGTH) return null;

  if (action === "created") {
    const install = await readLinearAgentInstall(env, organizationId);
    if (!install?.access_token_enc) return null;
    const creator = readNested(agentSession, "creator");
    const creatorId = readString(creator, "id") || readString(agentSession, "creatorId");
    const issue = readNested(agentSession, "issue");
    const issueId = readString(issue, "id") || readString(agentSession, "issueId");
    const issueIdentifier = readString(issue, "identifier");
    const member = creatorId
      ? await env.DB
        .prepare("select account_id from linear_agent_members where org_id = ? and linear_user_id = ? limit 1")
        .bind(organizationId, creatorId)
        .first<AccountMappingRow>()
      : null;
    let routedAccountId: string | null = null;
    let routeReason: "member" | "runner" | "unrouted" = "unrouted";
    if (member?.account_id) {
      routedAccountId = member.account_id;
      routeReason = "member";
    } else if (install.fallback_mode === "runner" && install.runner_account_id) {
      routedAccountId = install.runner_account_id;
      routeReason = "runner";
    }

    await env.DB
      .prepare(`
        insert or ignore into linear_agent_sessions(
          session_id, org_id, issue_id, issue_identifier, creator_linear_user_id,
          routed_account_id, route_reason, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        sessionId,
        organizationId,
        issueId || null,
        issueIdentifier || null,
        creatorId || null,
        routedAccountId,
        routeReason,
        receivedAt,
        receivedAt,
      )
      .run();
    // A redelivered `created` (new delivery id, same session) keeps the first
    // routing and must not post a second acknowledgement.
    const session = await readLinearAgentSession(env, sessionId);
    if (!session || session.org_id !== organizationId) return null;
    const fresh = session.created_at === receivedAt;
    const cutoff = new Date(Date.now() - LINEAR_AGENT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("delete from linear_agent_sessions where updated_at < ?").bind(cutoff).run();

    if (session.routed_account_id) {
      return {
        routed: true,
        accountId: session.routed_account_id,
        acknowledgement: fresh ? { sessionId, content: { type: "thought", body: LINEAR_AGENT_ACK_BODY } } : null,
      };
    }
    const creatorName = readString(creator, "name") || "This Linear user";
    return {
      routed: false,
      acknowledgement: fresh
        ? {
          sessionId,
          content: {
            type: "error",
            body: `${creatorName} is not connected to ADE yet. Open ADE → Settings → Integrations → Linear and connect Linear to use the ADE agent.`,
          },
        }
        : null,
    };
  }

  if (action === "prompted") {
    const session = await readLinearAgentSession(env, sessionId);
    if (!session || session.org_id !== organizationId) return null;
    await env.DB
      .prepare("update linear_agent_sessions set updated_at = ? where session_id = ?")
      .bind(receivedAt, sessionId)
      .run();
    return session.routed_account_id
      ? { routed: true, accountId: session.routed_account_id, acknowledgement: null }
      : { routed: false, acknowledgement: null };
  }
  return null;
}

async function readLinearAgentSession(env: RelayEnv, sessionId: string): Promise<LinearAgentSessionRow | null> {
  return await env.DB
    .prepare(`
      select session_id, org_id, issue_id, issue_identifier, routed_account_id,
             claimed_by_machine_id, claimed_at, created_at
        from linear_agent_sessions
       where session_id = ?
       limit 1
    `)
    .bind(sessionId)
    .first<LinearAgentSessionRow>();
}

export async function linearAgentMemberAccountMatches(
  env: RelayEnv,
  organizationId: string,
  accountId: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare("select account_id from linear_agent_members where org_id = ? and account_id = ? limit 1")
    .bind(organizationId, accountId)
    .first<AccountMappingRow>();
  return row?.account_id === accountId;
}

// --- Status / membership / settings ---------------------------------------------

async function linearAgentStatus(env: RelayEnv, caller: LinearAgentCaller): Promise<Record<string, unknown>> {
  const organizationId = caller.viewer.organizationId;
  const install = await readLinearAgentInstall(env, organizationId);
  const members = (await env.DB
    .prepare(`
      select linear_user_id, account_id, display_name, registered_at, last_seen_at
        from linear_agent_members
       where org_id = ?
       order by registered_at asc
       limit ?
    `)
    .bind(organizationId, MAX_LINEAR_AGENT_MEMBERS)
    .all<LinearAgentMemberRow>()).results ?? [];
  const me = members.find((member) => member.linear_user_id === caller.viewer.linearUserId);
  const runnerAccountId = install?.runner_account_id ?? null;
  return {
    ok: true,
    orgId: organizationId,
    orgName: install?.org_name || caller.viewer.organizationName || null,
    installed: Boolean(install?.access_token_enc),
    appUserId: install?.app_user_id ?? null,
    installedAt: install?.installed_at ?? null,
    installedByMe: Boolean(install) && install?.installed_by_account_id === caller.accountId,
    fallbackMode: install?.fallback_mode === "runner" ? "runner" : "reply",
    runnerIsMe: runnerAccountId === caller.accountId,
    runnerConfigured: Boolean(runnerAccountId),
    me: {
      linearUserId: caller.viewer.linearUserId,
      registered: me?.account_id === caller.accountId,
      routedToOtherAccount: Boolean(me) && me?.account_id !== caller.accountId,
    },
    members: members.map((member) => ({
      linearUserId: member.linear_user_id,
      displayName: member.display_name ?? "",
      isMe: member.account_id === caller.accountId,
      registeredAt: member.registered_at,
      lastSeenAt: member.last_seen_at,
    })),
  };
}

/**
 * Maps the caller's Linear user to their ADE account. A row that already
 * routes to a different ADE account changes only with `replace`, so a shared
 * Linear credential never moves someone's delegations silently.
 */
async function upsertLinearAgentMember(
  env: RelayEnv,
  caller: LinearAgentCaller,
  now: string,
  options: { replace: boolean },
): Promise<void> {
  await env.DB
    .prepare(`
      insert into linear_agent_members(org_id, linear_user_id, account_id, display_name, registered_at, last_seen_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(org_id, linear_user_id) do update set
        registered_at = case
          when linear_agent_members.account_id = excluded.account_id then linear_agent_members.registered_at
          else excluded.registered_at
        end,
        account_id = excluded.account_id,
        display_name = excluded.display_name,
        last_seen_at = excluded.last_seen_at
      where linear_agent_members.account_id = excluded.account_id or ? = 1
    `)
    .bind(
      caller.viewer.organizationId,
      caller.viewer.linearUserId,
      caller.accountId,
      caller.viewer.displayName || null,
      now,
      now,
      options.replace ? 1 : 0,
    )
    .run();
}

function parseLinearAgentExpiresAt(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  let milliseconds = Number.NaN;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Accept epoch seconds as well as epoch milliseconds.
    milliseconds = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string") {
    milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds)) return { ok: false };
  return { ok: true, value: new Date(milliseconds).toISOString() };
}

async function handleLinearAgentInstall(request: Request, env: RelayEnv): Promise<Response> {
  const key = await importLinearAgentTokenKey(env);
  if (!key) return linearAgentError(503, "agent_not_configured");
  const auth = await authenticateLinearAgentCaller(request, env);
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const parsed = await readLinearAgentJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const accessToken = normalizeOAuthToken(body.accessToken);
  if (!accessToken || accessToken.length > MAX_LINEAR_AGENT_TOKEN_LENGTH) {
    return linearAgentError(400, "accessToken is required");
  }
  const hasRefreshToken = body.refreshToken !== undefined && body.refreshToken !== null && body.refreshToken !== "";
  const refreshToken = hasRefreshToken ? normalizeOAuthToken(body.refreshToken) : "";
  if (hasRefreshToken && (!refreshToken || refreshToken.length > MAX_LINEAR_AGENT_TOKEN_LENGTH)) {
    return linearAgentError(400, "refreshToken must be a string");
  }
  const expiresAt = parseLinearAgentExpiresAt(body.expiresAt);
  if (!expiresAt.ok) return linearAgentError(400, "expiresAt must be an ISO timestamp or epoch time");

  const app = await linearGraphqlRequest(
    env,
    `Bearer ${accessToken}`,
    "query AdeAgentInstall { viewer { id } organization { id name urlKey } }",
  );
  if (!app.ok) {
    return app.status === 401
      ? linearAgentError(400, "Linear rejected the app token")
      : linearAgentError(502, app.error);
  }
  const appUserId = readString(readNested(app.data, "viewer"), "id");
  const organization = readNested(app.data, "organization");
  const organizationId = readString(organization, "id");
  if (!appUserId || !organizationId) return linearAgentError(502, "Linear returned an incomplete app identity");
  if (organizationId !== caller.viewer.organizationId) {
    return linearAgentError(403, "The app token belongs to a different Linear workspace");
  }

  const now = new Date().toISOString();
  await env.DB
    .prepare(`
      insert into linear_agent_installs(
        org_id, org_name, app_user_id, access_token_enc, refresh_token_enc, expires_at,
        installed_by_account_id, installed_by_linear_user_id, installed_at, updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(org_id) do update set
        org_name = excluded.org_name,
        app_user_id = excluded.app_user_id,
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc,
        expires_at = excluded.expires_at,
        fallback_mode = case
          when linear_agent_installs.installed_by_account_id = excluded.installed_by_account_id then linear_agent_installs.fallback_mode
          else 'reply'
        end,
        runner_account_id = case
          when linear_agent_installs.installed_by_account_id = excluded.installed_by_account_id then linear_agent_installs.runner_account_id
          else null
        end,
        installed_by_account_id = excluded.installed_by_account_id,
        installed_by_linear_user_id = excluded.installed_by_linear_user_id,
        installed_at = excluded.installed_at,
        updated_at = excluded.updated_at
    `)
    .bind(
      organizationId,
      readString(organization, "name") || caller.viewer.organizationName || null,
      appUserId,
      await encryptLinearAgentToken(key, organizationId, accessToken),
      refreshToken ? await encryptLinearAgentToken(key, organizationId, refreshToken) : null,
      expiresAt.value,
      caller.accountId,
      caller.viewer.linearUserId,
      now,
      now,
    )
    .run();
  // Installing is an explicit act by this person, so it may take over their own mapping.
  await upsertLinearAgentMember(env, caller, now, { replace: true });
  return json(await linearAgentStatus(env, caller));
}

async function handleLinearAgentUninstall(request: Request, env: RelayEnv): Promise<Response> {
  const auth = await authenticateLinearAgentCaller(request, env);
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const install = await readLinearAgentInstall(env, caller.viewer.organizationId);
  if (!install) return linearAgentError(404, "agent_not_installed");
  if (install.installed_by_account_id !== caller.accountId) {
    return linearAgentError(403, "Only the account that installed the ADE agent can remove it");
  }
  await env.DB
    .prepare("delete from linear_agent_installs where org_id = ? and installed_by_account_id = ?")
    .bind(caller.viewer.organizationId, caller.accountId)
    .run();
  return json(await linearAgentStatus(env, caller));
}

async function handleLinearAgentStatus(request: Request, env: RelayEnv): Promise<Response> {
  const auth = await authenticateLinearAgentCaller(request, env);
  if (!auth.ok) return auth.response;
  return json(await linearAgentStatus(env, auth.caller));
}

async function handleLinearAgentMemberRegistration(request: Request, env: RelayEnv): Promise<Response> {
  const auth = await authenticateLinearAgentCaller(request, env);
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  if (request.method === "DELETE") {
    await env.DB
      .prepare("delete from linear_agent_members where org_id = ? and linear_user_id = ? and account_id = ?")
      .bind(caller.viewer.organizationId, caller.viewer.linearUserId, caller.accountId)
      .run();
  } else {
    const replace = new URL(request.url).searchParams.get("replace") === "1";
    await upsertLinearAgentMember(env, caller, new Date().toISOString(), { replace });
  }
  return json(await linearAgentStatus(env, caller));
}

async function handleLinearAgentSettings(request: Request, env: RelayEnv): Promise<Response> {
  const auth = await authenticateLinearAgentCaller(request, env);
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const parsed = await readLinearAgentJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (body.fallbackMode !== undefined && body.fallbackMode !== "reply" && body.fallbackMode !== "runner") {
    return linearAgentError(400, "fallbackMode must be 'reply' or 'runner'");
  }
  if (body.runner !== undefined && body.runner !== null && body.runner !== "self") {
    return linearAgentError(400, "runner must be 'self' or null");
  }
  const install = await readLinearAgentInstall(env, caller.viewer.organizationId);
  if (!install) return linearAgentError(404, "agent_not_installed");
  if (install.installed_by_account_id !== caller.accountId) {
    return linearAgentError(403, "Only the account that installed the ADE agent can change its settings");
  }
  const fallbackMode = body.fallbackMode === undefined ? install.fallback_mode : body.fallbackMode;
  const runnerAccountId = body.runner === undefined
    ? install.runner_account_id
    : body.runner === "self" ? caller.accountId : null;
  await env.DB
    .prepare(`
      update linear_agent_installs
         set fallback_mode = ?, runner_account_id = ?, updated_at = ?
       where org_id = ? and installed_by_account_id = ?
    `)
    .bind(fallbackMode, runnerAccountId, new Date().toISOString(), caller.viewer.organizationId, caller.accountId)
    .run();
  return json(await linearAgentStatus(env, caller));
}

// --- Session routes -----------------------------------------------------------------

async function readRoutedLinearAgentSession(
  env: RelayEnv,
  sessionId: string,
  accountId: string,
): Promise<{ ok: true; session: LinearAgentSessionRow } | { ok: false; response: Response }> {
  const session = await readLinearAgentSession(env, sessionId);
  if (!session) return { ok: false, response: linearAgentError(404, "Unknown agent session") };
  if (!session.routed_account_id || session.routed_account_id !== accountId) {
    return { ok: false, response: linearAgentError(403, "forbidden") };
  }
  return { ok: true, session };
}

async function handleLinearAgentClaim(
  env: RelayEnv,
  accountId: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const machineId = readString(body, "machineId");
  if (!machineId || machineId.length > MAX_LINEAR_AGENT_ID_LENGTH) {
    return linearAgentError(400, "machineId is required");
  }
  const routed = await readRoutedLinearAgentSession(env, sessionId, accountId);
  if (!routed.ok) return routed.response;
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - LINEAR_AGENT_CLAIM_STALE_MS).toISOString();
  // First machine wins. Re-claiming from the holder refreshes the claim, and a
  // claim nobody refreshed for 15 minutes is treated as abandoned.
  await env.DB
    .prepare(`
      update linear_agent_sessions
         set claimed_by_machine_id = ?, claimed_at = ?, updated_at = ?
       where session_id = ?
         and routed_account_id = ?
         and (
           claimed_by_machine_id is null
           or claimed_by_machine_id = ?
           or claimed_at is null
           or claimed_at < ?
         )
    `)
    .bind(machineId, nowIso, nowIso, sessionId, accountId, machineId, staleBefore)
    .run();
  const session = await readLinearAgentSession(env, sessionId);
  const claimedByMachineId = session?.claimed_by_machine_id ?? null;
  return json({ ok: true, claimed: claimedByMachineId === machineId, claimedByMachineId });
}

function parseLinearAgentActivity(
  body: Record<string, unknown>,
): { ok: true; activity: LinearAgentActivityInput } | { ok: false; error: string } {
  const content = readNested(body, "content");
  if (!content) return { ok: false, error: "content is required" };
  const type = readString(content, "type");
  if (!LINEAR_AGENT_ACTIVITY_TYPES.has(type)) {
    return { ok: false, error: "content.type must be thought, action, elicitation, response, or error" };
  }
  if (body.ephemeral !== undefined && typeof body.ephemeral !== "boolean") {
    return { ok: false, error: "ephemeral must be a boolean" };
  }
  const ephemeral = body.ephemeral === true;
  if (ephemeral && !LINEAR_AGENT_EPHEMERAL_TYPES.has(type)) {
    return { ok: false, error: "only thought and action activities may be ephemeral" };
  }

  const normalized: Record<string, unknown> = { type };
  const fields: Array<{ key: string; required: boolean; nonEmpty: boolean }> = type === "action"
    ? [
      { key: "action", required: true, nonEmpty: true },
      { key: "parameter", required: true, nonEmpty: false },
      { key: "result", required: false, nonEmpty: false },
    ]
    : [{ key: "body", required: true, nonEmpty: true }];
  for (const field of fields) {
    const value = content[field.key];
    if (value === undefined || value === null) {
      if (field.required) return { ok: false, error: `content.${field.key} is required` };
      continue;
    }
    if (typeof value !== "string" || (field.nonEmpty && !value.trim())) {
      return { ok: false, error: `content.${field.key} must be a${field.nonEmpty ? " non-empty" : ""} string` };
    }
    if (utf8Length(value) > MAX_LINEAR_AGENT_TEXT_BYTES) {
      return { ok: false, error: `content.${field.key} exceeds ${MAX_LINEAR_AGENT_TEXT_BYTES} bytes` };
    }
    normalized[field.key] = value;
  }

  let signal: string | null = null;
  let signalMetadata: Record<string, unknown> | null = null;
  if (type === "elicitation") {
    if (content.signal !== undefined && content.signal !== null) {
      if (typeof content.signal !== "string" || !LINEAR_AGENT_ELICITATION_SIGNALS.has(content.signal)) {
        return { ok: false, error: "content.signal must be 'select' or 'auth'" };
      }
      signal = content.signal;
    }
    if (content.signalMetadata !== undefined && content.signalMetadata !== null) {
      if (!isRecord(content.signalMetadata)) return { ok: false, error: "content.signalMetadata must be an object" };
      if (utf8Length(JSON.stringify(content.signalMetadata)) > MAX_LINEAR_AGENT_TEXT_BYTES) {
        return { ok: false, error: `content.signalMetadata exceeds ${MAX_LINEAR_AGENT_TEXT_BYTES} bytes` };
      }
      signalMetadata = content.signalMetadata;
    }
    if (signal === "select") {
      // Plain strings become { label, value } pairs, the shape Linear requires.
      const rawOptions = Array.isArray(signalMetadata?.options) ? signalMetadata!.options as unknown[] : [];
      const options = rawOptions
        .map((option) => (typeof option === "string"
          ? { label: option, value: option }
          : isRecord(option) && typeof option.label === "string"
            ? { label: option.label, value: typeof option.value === "string" ? option.value : option.label }
            : null))
        .filter((option): option is { label: string; value: string } => option != null);
      if (options.length === 0) return { ok: false, error: "a select elicitation needs options" };
      signalMetadata = { ...(signalMetadata ?? {}), options };
    }
  }
  return { ok: true, activity: { content: normalized, ephemeral, signal, signalMetadata } };
}

function parseLinearAgentExternalUrls(
  value: unknown,
  key: string,
): { ok: true; urls: Array<{ label: string; url: string }> } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_LINEAR_AGENT_EXTERNAL_URLS) {
    return { ok: false, error: `${key} must be an array of at most ${MAX_LINEAR_AGENT_EXTERNAL_URLS} links` };
  }
  const urls: Array<{ label: string; url: string }> = [];
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    const label = readString(record, "label");
    const url = readString(record, "url");
    if (!label || label.length > MAX_LINEAR_AGENT_LABEL_LENGTH || !isHttpUrl(url)) {
      return { ok: false, error: `${key} entries need a label and an http(s) url` };
    }
    urls.push({ label, url });
  }
  return { ok: true, urls };
}

function isHttpUrl(value: string): boolean {
  if (!value || value.length > MAX_LINEAR_AGENT_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parseLinearAgentSessionUpdate(
  body: Record<string, unknown>,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const input: Record<string, unknown> = {};
  if (body.plan !== undefined) {
    if (!Array.isArray(body.plan) || body.plan.length > MAX_LINEAR_AGENT_PLAN_STEPS) {
      return { ok: false, error: `plan must be an array of at most ${MAX_LINEAR_AGENT_PLAN_STEPS} steps` };
    }
    const plan: Array<{ content: string; status: string }> = [];
    for (const step of body.plan) {
      const record = isRecord(step) ? step : null;
      const content = readString(record, "content");
      const status = readString(record, "status");
      if (!content || utf8Length(content) > MAX_LINEAR_AGENT_TEXT_BYTES || !LINEAR_AGENT_PLAN_STATUSES.has(status)) {
        return { ok: false, error: "plan steps need content and a status of pending, inProgress, completed, or canceled" };
      }
      plan.push({ content, status });
    }
    input.plan = plan;
  }
  for (const key of ["externalUrls", "addedExternalUrls"] as const) {
    if (body[key] === undefined) continue;
    const parsed = parseLinearAgentExternalUrls(body[key], key);
    if (!parsed.ok) return parsed;
    input[key] = parsed.urls;
  }
  if (body.removedExternalUrls !== undefined) {
    const removed = body.removedExternalUrls;
    if (
      !Array.isArray(removed)
      || removed.length > MAX_LINEAR_AGENT_EXTERNAL_URLS
      || !removed.every((url) => typeof url === "string" && isHttpUrl(url))
    ) {
      return { ok: false, error: "removedExternalUrls must be an array of http(s) urls" };
    }
    input.removedExternalUrls = removed;
  }
  if (Object.keys(input).length === 0) return { ok: false, error: "nothing to update" };
  return { ok: true, input };
}

async function handleLinearAgentActivity(
  env: RelayEnv,
  accountId: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const routed = await readRoutedLinearAgentSession(env, sessionId, accountId);
  if (!routed.ok) return routed.response;
  const parsed = parseLinearAgentActivity(body);
  if (!parsed.ok) return linearAgentError(400, parsed.error);
  const result = await createLinearAgentActivity(env, routed.session.org_id, sessionId, parsed.activity);
  if (!result.ok) return linearAgentFailureResponse(result);
  return json({ ok: true, activityId: result.activityId });
}

async function handleLinearAgentSessionUpdate(
  env: RelayEnv,
  accountId: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const routed = await readRoutedLinearAgentSession(env, sessionId, accountId);
  if (!routed.ok) return routed.response;
  const parsed = parseLinearAgentSessionUpdate(body);
  if (!parsed.ok) return linearAgentError(400, parsed.error);
  const result = await linearAgentGraphql(
    env,
    routed.session.org_id,
    "mutation AdeAgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
    { id: sessionId, input: parsed.input },
  );
  if (!result.ok) return linearAgentFailureResponse(result);
  if (readBoolean(readNested(result.data, "agentSessionUpdate"), "success") !== true) {
    return linearAgentError(502, "Linear did not accept the session update");
  }
  return json({ ok: true });
}

/**
 * Best effort: moves an unstarted issue to its team's first `started` state and
 * delegates it to the agent when nobody is delegated. Each change is attempted
 * on its own so one refusal does not block the other.
 */
async function handleLinearAgentStart(env: RelayEnv, accountId: string, sessionId: string): Promise<Response> {
  const routed = await readRoutedLinearAgentSession(env, sessionId, accountId);
  if (!routed.ok) return routed.response;
  const { session } = routed;
  if (!session.issue_id) return json({ ok: true, stateChanged: false, stateId: null, delegateChanged: false });

  const issueResult = await linearAgentGraphql(
    env,
    session.org_id,
    "query AdeAgentIssue($id: String!) { issue(id: $id) { id delegate { id } state { id type } team { states { nodes { id type position } } } } }",
    { id: session.issue_id },
  );
  if (!issueResult.ok) return linearAgentFailureResponse(issueResult);
  const issue = readNested(issueResult.data, "issue");
  if (!issue) return linearAgentError(404, "Linear issue not found");

  let stateId: string | null = null;
  const stateType = readString(readNested(issue, "state"), "type");
  if (!LINEAR_AGENT_SETTLED_STATE_TYPES.has(stateType)) {
    const nodes = readNested(readNested(issue, "team"), "states")?.nodes;
    const started = (Array.isArray(nodes) ? nodes : [])
      .filter((node): node is Record<string, unknown> => isRecord(node) && readString(node, "type") === "started")
      .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0))[0];
    stateId = readString(started, "id") || null;
  }
  const delegateId = readNested(issue, "delegate") ? null : issueResult.install.app_user_id;

  const errors: string[] = [];
  const update = async (input: Record<string, unknown>): Promise<boolean> => {
    const result = await linearAgentGraphql(
      env,
      session.org_id,
      "mutation AdeAgentIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      { id: session.issue_id, input },
    );
    if (!result.ok) {
      errors.push(result.error);
      return false;
    }
    const success = readBoolean(readNested(result.data, "issueUpdate"), "success") === true;
    if (!success) errors.push("Linear did not accept the issue update");
    return success;
  };
  const stateChanged = stateId ? await update({ stateId }) : false;
  const delegateChanged = delegateId ? await update({ delegateId }) : false;
  return json({
    ok: true,
    stateChanged,
    stateId: stateChanged ? stateId : null,
    delegateChanged,
    ...(errors.length > 0 ? { errors } : {}),
  });
}

// --- Subscriptions and dispatch -----------------------------------------------------

export async function subscribeLinearTopic(env: RelayEnv, topic: string): Promise<Response> {
  return await linearTopicObject(env, topic).fetch(
    new Request(`https://repo-events.internal/subscribe?topic=${encodeURIComponent(topic)}`, {
      headers: { upgrade: "websocket" },
    }),
  );
}

async function handleLinearAgentSubscription(request: Request, env: RelayEnv): Promise<Response> {
  const upgradeRequired = requireWebSocketUpgrade(request);
  if (upgradeRequired) return upgradeRequired;
  const account = await authenticateLinearAgentAccount(request, env);
  if (!account.ok) return account.response;
  return await subscribeLinearTopic(env, `linear-account:${account.accountId}`);
}

export async function handleLinearAgentRequest(request: Request, env: RelayEnv, pathname: string): Promise<Response> {
  const parts = pathname.split("/").filter(Boolean).slice(2);
  const route = parts.join("/");
  if (route === "install") {
    if (request.method === "POST") return await handleLinearAgentInstall(request, env);
    if (request.method === "DELETE") return await handleLinearAgentUninstall(request, env);
    return text("method not allowed", 405);
  }
  if (route === "status") {
    if (request.method !== "GET") return text("method not allowed", 405);
    return await handleLinearAgentStatus(request, env);
  }
  if (route === "members/register") {
    if (request.method !== "POST" && request.method !== "DELETE") return text("method not allowed", 405);
    return await handleLinearAgentMemberRegistration(request, env);
  }
  if (route === "settings") {
    if (request.method !== "PUT") return text("method not allowed", 405);
    return await handleLinearAgentSettings(request, env);
  }
  if (route === "subscribe") return await handleLinearAgentSubscription(request, env);

  if (parts.length === 3 && parts[0] === "sessions") {
    const action = parts[2];
    if (action !== "claim" && action !== "activities" && action !== "update" && action !== "start") {
      return text("not found", 404);
    }
    if (request.method !== "POST") return text("method not allowed", 405);
    let sessionId = "";
    try {
      sessionId = decodeURIComponent(parts[1] ?? "").trim();
    } catch {
      sessionId = "";
    }
    if (!sessionId || sessionId.length > MAX_LINEAR_AGENT_ID_LENGTH) return linearAgentError(400, "sessionId is invalid");
    const account = await authenticateLinearAgentAccount(request, env);
    if (!account.ok) return account.response;
    if (action === "start") return await handleLinearAgentStart(env, account.accountId, sessionId);
    const parsed = await readLinearAgentJsonBody(request);
    if (!parsed.ok) return parsed.response;
    if (action === "claim") return await handleLinearAgentClaim(env, account.accountId, sessionId, parsed.body);
    if (action === "activities") return await handleLinearAgentActivity(env, account.accountId, sessionId, parsed.body);
    return await handleLinearAgentSessionUpdate(env, account.accountId, sessionId, parsed.body);
  }
  return text("not found", 404);
}
