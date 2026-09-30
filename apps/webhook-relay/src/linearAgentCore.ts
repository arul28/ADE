// Linear agent (actor=app) building blocks: row types, limits, token storage
// and encryption, Linear GraphQL calls, and caller authentication.

import { decodeJwt } from "jose";
import {
  base64Encode,
  base64ToBytes,
  contentLengthExceedsLimit,
  encoder,
  evictExpiredCacheEntries,
  isRecord,
  json,
  readBoolean,
  readNested,
  readString,
  type RelayEnv,
  sha256Hex,
} from "./shared";
import {
  ACCOUNT_TOKEN_HEADER,
  accountTokenCandidates,
  authenticateAccount,
  hasValidBearerAccountToken,
  LINEAR_AUTH_CACHE_TTL_MS,
  linearGraphqlUrl,
  MAX_LINEAR_AUTH_CACHE_ENTRIES,
  readAuthorizationHeader,
  verifyAccountToken,
} from "./auth";

type LinearAgentInstallRow = {
  org_id: string;
  org_name: string | null;
  app_user_id: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
  installed_by_account_id: string | null;
  installed_by_linear_user_id: string | null;
  fallback_mode: string;
  runner_account_id: string | null;
  installed_at: string;
  updated_at: string;
};

export type LinearAgentMemberRow = {
  linear_user_id: string;
  account_id: string;
  display_name: string | null;
  registered_at: string;
  last_seen_at: string;
};

export type LinearAgentSessionRow = {
  session_id: string;
  org_id: string;
  issue_id: string | null;
  issue_identifier: string | null;
  routed_account_id: string | null;
  claimed_by_machine_id: string | null;
  claimed_at: string | null;
  created_at: string;
};

type LinearViewerIdentity = {
  linearUserId: string;
  displayName: string;
  organizationId: string;
  organizationName: string;
};

export type LinearAgentCaller = { accountId: string; viewer: LinearViewerIdentity };

export type LinearAgentActivityInput = {
  content: Record<string, unknown>;
  ephemeral: boolean;
  signal: string | null;
  signalMetadata: Record<string, unknown> | null;
};

type LinearAgentAcknowledgement = { sessionId: string; content: Record<string, unknown> };

export type LinearAgentSessionRoute =
  | { routed: true; accountId: string; acknowledgement: LinearAgentAcknowledgement | null }
  | { routed: false; acknowledgement: LinearAgentAcknowledgement | null };

type LinearAgentFailure = { ok: false; status: number; error: string };
type LinearAgentResult<T> = ({ ok: true } & T) | LinearAgentFailure;
type LinearAgentToken = { accessToken: string; install: LinearAgentInstallRow };

const MAX_LINEAR_AGENT_BODY_BYTES = 64 * 1024;
const LINEAR_AGENT_INVALID_GRANT_GRACE_MS = 45_000;
const LINEAR_AGENT_REFRESH_LEASE_MS = 35_000;
export const MAX_LINEAR_AGENT_TEXT_BYTES = 20 * 1024;
export const MAX_LINEAR_AGENT_TOKEN_LENGTH = 4096;
export const MAX_LINEAR_AGENT_ID_LENGTH = 200;
export const MAX_LINEAR_AGENT_PLAN_STEPS = 50;
export const MAX_LINEAR_AGENT_EXTERNAL_URLS = 20;
export const MAX_LINEAR_AGENT_URL_LENGTH = 2048;
export const MAX_LINEAR_AGENT_LABEL_LENGTH = 200;
export const MAX_LINEAR_AGENT_MEMBERS = 500;
export const LINEAR_AGENT_CLAIM_STALE_MS = 15 * 60_000;
const LINEAR_AGENT_REFRESH_WINDOW_MS = 10 * 60_000;
export const LINEAR_AGENT_SESSION_RETENTION_DAYS = 90;
export const LINEAR_AGENT_ACK_BODY = "On it — ADE is starting a lane for this issue.";
export const LINEAR_AGENT_ACTIVITY_TYPES = new Set(["thought", "action", "elicitation", "response", "error"]);
export const LINEAR_AGENT_EPHEMERAL_TYPES = new Set(["thought", "action"]);
// Linear accepts only these agent-to-human signals (select takes options of { label, value }).
export const LINEAR_AGENT_ELICITATION_SIGNALS = new Set(["select", "auth"]);
export const LINEAR_AGENT_PLAN_STATUSES = new Set(["pending", "inProgress", "completed", "canceled"]);
export const LINEAR_AGENT_SETTLED_STATE_TYPES = new Set(["started", "completed", "canceled"]);
const linearViewerIdentityByTokenHash = new Map<string, LinearViewerIdentity & { expiresAt: number }>();
const linearAgentRefreshByOrganization = new Map<string, Promise<LinearAgentResult<{ accessToken: string }>>>();

export function linearAgentError(status: number, error: string): Response {
  return json({ ok: false, error }, { status });
}

export function linearAgentFailureResponse(failure: LinearAgentFailure): Response {
  return linearAgentError(failure.status, failure.error);
}

export function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

/** WebCrypto wants an ArrayBuffer-backed view, not a possibly shared buffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function normalizeOAuthToken(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^Bearer\s+/i, "") : "";
}

function linearOAuthTokenUrl(env: RelayEnv): string {
  return new URL("/oauth/token", linearGraphqlUrl(env)).toString();
}

export function linearTopicObject(env: RelayEnv, topic: string): DurableObjectStub {
  return env.REPO_EVENTS.get(env.REPO_EVENTS.idFromName(topic));
}

/** Wake-ups are hints; a dropped one is recovered by the subscriber's safety poll. */
export async function notifyLinearTopic(env: RelayEnv, topic: string, frame: Record<string, unknown>): Promise<void> {
  try {
    const response = await linearTopicObject(env, topic).fetch("https://repo-events.internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, frame }),
    });
    if (!response.ok) throw new Error(`Topic Durable Object returned HTTP ${response.status}`);
  } catch (error) {
    console.warn(JSON.stringify({
      kind: "linear_topic_notify_failed",
      topicKind: topic.slice(0, topic.indexOf(":")),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function runAfterResponse(ctx: ExecutionContext | undefined, task: () => Promise<unknown>): Promise<void> {
  const guarded = task().catch((error: unknown) => {
    console.warn(JSON.stringify({
      kind: "linear_background_task_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  });
  if (ctx) {
    ctx.waitUntil(guarded);
    return;
  }
  await guarded;
}

export async function readLinearAgentJsonBody(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  if (contentLengthExceedsLimit(request.headers, MAX_LINEAR_AGENT_BODY_BYTES)) {
    return { ok: false, response: linearAgentError(413, "payload too large") };
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_LINEAR_AGENT_BODY_BYTES) {
    return { ok: false, response: linearAgentError(413, "payload too large") };
  }
  if (raw.byteLength === 0) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid payload");
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, response: linearAgentError(400, "invalid json") };
  }
}

// --- Token encryption -------------------------------------------------------

export async function importLinearAgentTokenKey(env: RelayEnv): Promise<CryptoKey | null> {
  const raw = env.LINEAR_AGENT_TOKEN_KEY?.trim();
  if (!raw) return null;
  let bytes: ArrayBuffer;
  try {
    bytes = toArrayBuffer(base64ToBytes(raw.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
  if (bytes.byteLength !== 32) return null;
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Binds each ciphertext to its org so a row copied to another org cannot decrypt. */
function linearAgentTokenAad(organizationId: string): ArrayBuffer {
  return toArrayBuffer(encoder.encode(`ade-linear-agent:${organizationId}`));
}

export async function encryptLinearAgentToken(key: CryptoKey, organizationId: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: linearAgentTokenAad(organizationId) },
    key,
    encoder.encode(token),
  );
  return `v1.${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

async function decryptLinearAgentToken(key: CryptoKey, organizationId: string, value: string): Promise<string | null> {
  const [version, ivPart, ciphertextPart] = value.split(".");
  if (version !== "v1" || !ivPart || !ciphertextPart) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(ivPart)), additionalData: linearAgentTokenAad(organizationId) },
      key,
      toArrayBuffer(base64ToBytes(ciphertextPart)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

// --- Linear GraphQL -----------------------------------------------------------

function isLinearAuthenticationError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const extensions = readNested(error, "extensions");
  const type = readString(extensions, "type").toLowerCase();
  const code = readString(extensions, "code").toUpperCase();
  return type === "authentication error" || code === "AUTHENTICATION_ERROR";
}

export async function linearGraphqlRequest(
  env: RelayEnv,
  authorization: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<LinearAgentResult<{ data: Record<string, unknown> }>> {
  let response: Response;
  try {
    response = await fetch(linearGraphqlUrl(env), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
  } catch {
    return { ok: false, status: 502, error: "Linear request failed" };
  }
  const payload = await response.json().catch(() => null) as unknown;
  const record = isRecord(payload) ? payload : null;
  const errors = Array.isArray(record?.errors) ? record.errors : [];
  if (response.status === 401 || response.status === 403 || errors.some(isLinearAuthenticationError)) {
    return { ok: false, status: 401, error: "Linear rejected the token" };
  }
  const data = readNested(record, "data");
  if (!response.ok || errors.length > 0 || !data) {
    const message = readString(isRecord(errors[0]) ? errors[0] : null, "message").slice(0, 300);
    return { ok: false, status: 502, error: message || `Linear request failed (HTTP ${response.status})` };
  }
  return { ok: true, data };
}

/** Like verifyLinearViewerOrganization, but also returns who the viewer is. */
async function verifyLinearViewerIdentity(
  request: Request,
  env: RelayEnv,
): Promise<{ authorized: true; viewer: LinearViewerIdentity } | { authorized: false; response: Response }> {
  const authorization = readAuthorizationHeader(request);
  if (!authorization || await hasValidBearerAccountToken(request, env)) {
    return { authorized: false, response: linearAgentError(401, "Linear authorization token is required") };
  }
  const tokenHash = await sha256Hex(authorization);
  const cached = linearViewerIdentityByTokenHash.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    const { expiresAt: _expiresAt, ...viewer } = cached;
    return { authorized: true, viewer };
  }
  if (cached) linearViewerIdentityByTokenHash.delete(tokenHash);

  const result = await linearGraphqlRequest(
    env,
    authorization,
    "query AdeAgentViewer { viewer { id name displayName organization { id name } } }",
  );
  if (!result.ok) {
    return {
      authorized: false,
      response: result.status === 401
        ? linearAgentError(401, "Invalid Linear authorization token")
        : linearAgentError(502, "Linear authorization check failed"),
    };
  }
  const viewerRecord = readNested(result.data, "viewer");
  const organization = readNested(viewerRecord, "organization");
  const viewer: LinearViewerIdentity = {
    linearUserId: readString(viewerRecord, "id"),
    displayName: readString(viewerRecord, "name") || readString(viewerRecord, "displayName"),
    organizationId: readString(organization, "id"),
    organizationName: readString(organization, "name"),
  };
  if (!viewer.linearUserId || !viewer.organizationId) {
    return { authorized: false, response: linearAgentError(401, "Invalid Linear authorization token") };
  }
  linearViewerIdentityByTokenHash.set(tokenHash, { ...viewer, expiresAt: Date.now() + LINEAR_AUTH_CACHE_TTL_MS });
  evictExpiredCacheEntries(linearViewerIdentityByTokenHash, MAX_LINEAR_AUTH_CACHE_ENTRIES);
  return { authorized: true, viewer };
}

export async function authenticateLinearAgentAccount(
  request: Request,
  env: RelayEnv,
): Promise<{ ok: true; accountId: string } | { ok: false; response: Response }> {
  const accountId = await authenticateAccount(request, env);
  if (!accountId) {
    // Say why (missing, not a JWT, wrong issuer, audience, expired) so a client
    // can show a fix instead of a bare 401. Never echoes the token.
    let reason = "missing";
    const candidates = accountTokenCandidates(request);
    if (!request.headers.get(ACCOUNT_TOKEN_HEADER)) reason = "missing";
    else if (candidates.length === 0) reason = "not_a_jwt";
    else {
      try {
        await verifyAccountToken(candidates[0]!, env);
      } catch (error) {
        reason = error instanceof Error ? error.message.slice(0, 120) : "invalid";
        if (/audience/i.test(reason)) {
          // Client ids are public (they ship in the apps); naming the token's
          // client makes a mismatched relay allowlist fixable.
          try {
            const claims = decodeJwt(candidates[0]!);
            const client = typeof claims.azp === "string" ? claims.azp
              : typeof (claims as Record<string, unknown>).client_id === "string" ? String((claims as Record<string, unknown>).client_id)
                : Array.isArray(claims.aud) ? claims.aud.join(",") : typeof claims.aud === "string" ? claims.aud : null;
            reason = `${reason}; token client ${client ? client.slice(0, 80) : "none"}`;
          } catch {
            // Keep the plain reason.
          }
        }
      }
    }
    return { ok: false, response: json({ ok: false, error: "ADE account token is required", reason }, { status: 401 }) };
  }
  return { ok: true, accountId };
}

export async function authenticateLinearAgentCaller(
  request: Request,
  env: RelayEnv,
): Promise<{ ok: true; caller: LinearAgentCaller } | { ok: false; response: Response }> {
  const account = await authenticateLinearAgentAccount(request, env);
  if (!account.ok) return account;
  const identity = await verifyLinearViewerIdentity(request, env);
  if (!identity.authorized) return { ok: false, response: identity.response };
  return { ok: true, caller: { accountId: account.accountId, viewer: identity.viewer } };
}

// --- Install / token lifecycle ------------------------------------------------

export async function readLinearAgentInstall(env: RelayEnv, organizationId: string): Promise<LinearAgentInstallRow | null> {
  return await env.DB
    .prepare(`
      select org_id, org_name, app_user_id, access_token_enc, refresh_token_enc, expires_at,
             installed_by_account_id, installed_by_linear_user_id, fallback_mode, runner_account_id,
             installed_at, updated_at
        from linear_agent_installs
       where org_id = ?
       limit 1
    `)
    .bind(organizationId)
    .first<LinearAgentInstallRow>();
}

async function refreshLinearAgentToken(
  env: RelayEnv,
  key: CryptoKey,
  install: LinearAgentInstallRow,
  refreshToken: string,
): Promise<LinearAgentResult<{ accessToken: string }>> {
  const inFlight = linearAgentRefreshByOrganization.get(install.org_id);
  if (inFlight) return await inFlight;
  const refresh = refreshLinearAgentTokenOnce(env, key, install, refreshToken);
  linearAgentRefreshByOrganization.set(install.org_id, refresh);
  try {
    return await refresh;
  } finally {
    if (linearAgentRefreshByOrganization.get(install.org_id) === refresh) {
      linearAgentRefreshByOrganization.delete(install.org_id);
    }
  }
}

async function refreshLinearAgentTokenOnce(
  env: RelayEnv,
  key: CryptoKey,
  install: LinearAgentInstallRow,
  refreshToken: string,
): Promise<LinearAgentResult<{ accessToken: string }>> {
  const clientId = env.LINEAR_APP_CLIENT_ID?.trim();
  if (!clientId) return { ok: false, status: 503, error: "agent_not_configured" };
  const updatedAt = Date.parse(install.updated_at);
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt < LINEAR_AGENT_REFRESH_LEASE_MS) {
    return { ok: false, status: 502, error: "Linear token refresh is already in progress" };
  }
  const refreshStartedAt = new Date().toISOString();
  const lease = await env.DB
    .prepare(`
      update linear_agent_installs
         set updated_at = ?
       where org_id = ? and access_token_enc = ? and refresh_token_enc = ? and updated_at = ?
    `)
    .bind(refreshStartedAt, install.org_id, install.access_token_enc, install.refresh_token_enc, install.updated_at)
    .run();
  if (lease.meta?.changes !== 1) {
    const latest = await readLinearAgentInstall(env, install.org_id);
    if (latest?.access_token_enc && (
      latest.access_token_enc !== install.access_token_enc
      || latest.refresh_token_enc !== install.refresh_token_enc
    )) {
      const rotated = await decryptLinearAgentToken(key, install.org_id, latest.access_token_enc);
      if (rotated) return { ok: true, accessToken: rotated };
    }
    return { ok: false, status: 502, error: "Linear token refresh is already in progress" };
  }
  let response: Response;
  try {
    response = await fetch(linearOAuthTokenUrl(env), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 502, error: "Linear token refresh failed" };
  }
  const payload = await response.json().catch(() => null) as unknown;
  const record = isRecord(payload) ? payload : null;
  const accessToken = readString(record, "access_token");
  const now = new Date().toISOString();
  if (!response.ok || !accessToken) {
    if (readString(record, "error") !== "invalid_grant") {
      return { ok: false, status: 502, error: "Linear token refresh failed" };
    }
    // Refresh tokens rotate: a concurrent request may have spent this one a
    // moment ago. Its rotated token is valid, so only a row nobody rotated is
    // really dead.
    const current = await readLinearAgentInstall(env, install.org_id);
    if (current?.access_token_enc && (
      current.access_token_enc !== install.access_token_enc
      || current.refresh_token_enc !== install.refresh_token_enc
    )) {
      const rotated = await decryptLinearAgentToken(key, install.org_id, current.access_token_enc);
      if (rotated) return { ok: true, accessToken: rotated };
    }
    const expiresAt = install.expires_at ? Date.parse(install.expires_at) : Number.NaN;
    if (Number.isFinite(expiresAt) && Date.now() - expiresAt < LINEAR_AGENT_INVALID_GRANT_GRACE_MS) {
      // Give a refresh already in flight in another isolate time to persist its
      // rotated credentials before invalid_grant can clear the install.
      return { ok: false, status: 502, error: "Linear token refresh failed" };
    }
    const cleared = await env.DB
      .prepare(`
        update linear_agent_installs
           set access_token_enc = null, refresh_token_enc = null, expires_at = null, updated_at = ?
         where org_id = ? and access_token_enc = ?
           and refresh_token_enc = ? and updated_at = ?
      `)
      .bind(now, install.org_id, install.access_token_enc, install.refresh_token_enc, refreshStartedAt)
      .run();
    if (cleared.meta?.changes !== 1) {
      const latest = await readLinearAgentInstall(env, install.org_id);
      if (latest?.access_token_enc && (
        latest.access_token_enc !== install.access_token_enc
        || latest.refresh_token_enc !== install.refresh_token_enc
      )) {
        const rotated = await decryptLinearAgentToken(key, install.org_id, latest.access_token_enc);
        if (rotated) return { ok: true, accessToken: rotated };
      }
      return { ok: false, status: 502, error: "Linear token refresh changed concurrently" };
    }
    return { ok: false, status: 409, error: "agent_not_installed" };
  }

  const nextRefreshToken = readString(record, "refresh_token") || refreshToken;
  const expiresIn = Number(record?.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;
  const persisted = await env.DB
    .prepare(`
      update linear_agent_installs
         set access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, updated_at = ?
       where org_id = ? and access_token_enc = ? and refresh_token_enc = ? and updated_at = ?
    `)
    .bind(
      await encryptLinearAgentToken(key, install.org_id, accessToken),
      await encryptLinearAgentToken(key, install.org_id, nextRefreshToken),
      expiresAt,
      now,
      install.org_id,
      install.access_token_enc,
      install.refresh_token_enc,
      refreshStartedAt,
    )
    .run();
  if (persisted.meta?.changes !== 1) {
    const latest = await readLinearAgentInstall(env, install.org_id);
    if (latest?.access_token_enc && (
      latest.access_token_enc !== install.access_token_enc
      || latest.refresh_token_enc !== install.refresh_token_enc
    )) {
      const rotated = await decryptLinearAgentToken(key, install.org_id, latest.access_token_enc);
      if (rotated) return { ok: true, accessToken: rotated };
    }
    return { ok: false, status: 502, error: "Linear token refresh changed concurrently" };
  }
  return { ok: true, accessToken };
}

async function linearAgentAccessToken(
  env: RelayEnv,
  organizationId: string,
  forceRefresh: boolean,
): Promise<LinearAgentResult<LinearAgentToken>> {
  const key = await importLinearAgentTokenKey(env);
  if (!key) return { ok: false, status: 503, error: "agent_not_configured" };
  const install = await readLinearAgentInstall(env, organizationId);
  if (!install?.access_token_enc) return { ok: false, status: 409, error: "agent_not_installed" };
  const accessToken = await decryptLinearAgentToken(key, organizationId, install.access_token_enc);
  if (!accessToken) return { ok: false, status: 500, error: "Linear agent token could not be read" };

  const expiresAt = install.expires_at ? Date.parse(install.expires_at) : Number.NaN;
  const nearExpiry = Number.isFinite(expiresAt) && expiresAt - Date.now() < LINEAR_AGENT_REFRESH_WINDOW_MS;
  if (!forceRefresh && !nearExpiry) return { ok: true, accessToken, install };
  const refreshToken = install.refresh_token_enc
    ? await decryptLinearAgentToken(key, organizationId, install.refresh_token_enc)
    : null;
  if (!refreshToken) return { ok: true, accessToken, install };

  const refreshed = await refreshLinearAgentToken(env, key, install, refreshToken);
  if (refreshed.ok) return { ok: true, accessToken: refreshed.accessToken, install };
  // A transient refresh failure keeps using a token that has not expired yet.
  if (refreshed.status !== 409 && !forceRefresh && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    return { ok: true, accessToken, install };
  }
  return refreshed;
}

export async function linearAgentGraphql(
  env: RelayEnv,
  organizationId: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<LinearAgentResult<{ data: Record<string, unknown>; install: LinearAgentInstallRow }>> {
  let token = await linearAgentAccessToken(env, organizationId, false);
  if (!token.ok) return token;
  let result = await linearGraphqlRequest(env, `Bearer ${token.accessToken}`, query, variables);
  if (!result.ok && result.status === 401) {
    const refreshed = await linearAgentAccessToken(env, organizationId, true);
    if (!refreshed.ok) return refreshed;
    if (refreshed.accessToken !== token.accessToken) {
      token = refreshed;
      result = await linearGraphqlRequest(env, `Bearer ${token.accessToken}`, query, variables);
    }
  }
  if (!result.ok) {
    // A Linear 401 is about the app token, not the caller's ADE credentials.
    return { ok: false, status: result.status === 401 ? 502 : result.status, error: result.status === 401 ? "Linear rejected the agent token" : result.error };
  }
  return { ok: true, data: result.data, install: token.install };
}

export async function createLinearAgentActivity(
  env: RelayEnv,
  organizationId: string,
  sessionId: string,
  activity: LinearAgentActivityInput,
): Promise<LinearAgentResult<{ activityId: string | null }>> {
  // Linear takes signal/signalMetadata beside `content`, not inside it.
  const input: Record<string, unknown> = { agentSessionId: sessionId, content: activity.content };
  if (activity.ephemeral) input.ephemeral = true;
  if (activity.signal) input.signal = activity.signal;
  if (activity.signalMetadata) input.signalMetadata = activity.signalMetadata;
  const result = await linearAgentGraphql(
    env,
    organizationId,
    "mutation AdeAgentActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }",
    { input },
  );
  if (!result.ok) return result;
  const payload = readNested(result.data, "agentActivityCreate");
  if (readBoolean(payload, "success") !== true) {
    return { ok: false, status: 502, error: "Linear did not accept the activity" };
  }
  return { ok: true, activityId: readString(readNested(payload, "agentActivity"), "id") || null };
}

export async function postLinearAgentAcknowledgement(
  env: RelayEnv,
  organizationId: string,
  acknowledgement: LinearAgentAcknowledgement,
): Promise<void> {
  const result = await createLinearAgentActivity(env, organizationId, acknowledgement.sessionId, {
    content: acknowledgement.content,
    ephemeral: false,
    signal: null,
    signalMetadata: null,
  });
  if (!result.ok) {
    console.warn(JSON.stringify({ kind: "linear_agent_ack_failed", status: result.status, error: result.error }));
  }
}

// --- Webhook routing ------------------------------------------------------------
