// Linear org webhooks: registration, ingest, the org event stream, and the
// org subscription socket.

import {
  type AccountMappingRow,
  constantTimeEqual,
  contentLengthExceedsLimit,
  type CursorRow,
  DEFAULT_RETENTION_DAYS,
  encoder,
  isRecord,
  json,
  parseLimit,
  parseSequenceCursor,
  readString,
  type RelayEnv,
  requireWebSocketUpgrade,
  sha256Hex,
  text,
  toHex,
} from "./shared";
import { authenticateAccount, linearGraphqlUrl, readAuthorizationHeader, verifyLinearViewerOrganization } from "./auth";
import { notifyLinearTopic, postLinearAgentAcknowledgement, runAfterResponse } from "./linearAgentCore";
import { linearAgentMemberAccountMatches, routeLinearAgentSessionEvent, subscribeLinearTopic } from "./linearAgent";

type LinearEventRow = {
  event_seq: number;
  event_id: string;
  event_type: string;
  action: string;
  received_at: string;
  body: string;
  routed_account_id?: string | null;
};

type LinearOrganizationRow = {
  webhook_secret: string;
};

const MAX_LINEAR_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_LINEAR_REGISTRATION_BODY_BYTES = 16 * 1024;
const MAX_LINEAR_WEBHOOK_SECRET_LENGTH = 512;
const LINEAR_WEBHOOK_REPLAY_WINDOW_MS = 60_000;
const linearWebhookAuthorityByTokenHash = new Map<string, { expiresAt: number }>();
export async function signLinearWebhookBody(secret: string, body: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? encoder.encode(body) : body;
  return toHex(await crypto.subtle.sign("HMAC", key, data));
}

async function verifyLinearSignature(secret: string, body: ArrayBuffer, signature: string): Promise<boolean> {
  if (!secret.trim() || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = await signLinearWebhookBody(secret, body);
  return constantTimeEqual(expected.toLowerCase(), signature.toLowerCase());
}

async function linearOrganizationAccountMatches(
  env: RelayEnv,
  organizationId: string,
  accountId: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare("select account_id from linear_organizations where org_id = ? limit 1")
    .bind(organizationId)
    .first<AccountMappingRow>();
  return row?.account_id === accountId;
}

// Only workspace admins (or OAuth tokens carrying the admin scope) may read
// webhooks in Linear. Probing that read is how registration proves the caller
// has webhook authority — without it, any workspace member's token could
// overwrite the org's signing secret and silently break ingest verification.
async function verifyLinearWebhookAuthority(
  request: Request,
  env: RelayEnv,
): Promise<{ authorized: true } | { authorized: false; response: Response }> {
  const authorization = readAuthorizationHeader(request);
  const tokenHash = await sha256Hex(authorization);
  const cached = linearWebhookAuthorityByTokenHash.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    return { authorized: true };
  }
  if (cached) linearWebhookAuthorityByTokenHash.delete(tokenHash);
  let response: Response;
  try {
    response = await fetch(linearGraphqlUrl(env), {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "query { webhooks(first: 1) { nodes { id } } }" }),
    });
  } catch {
    return {
      authorized: false,
      response: json({ ok: false, error: "Unable to verify Linear webhook authority" }, { status: 502 }),
    };
  }
  const payload = await response.json().catch(() => null) as { data?: { webhooks?: unknown }; errors?: unknown[] } | null;
  if (!response.ok || !payload || Array.isArray(payload.errors) && payload.errors.length > 0 || payload.data?.webhooks == null) {
    return {
      authorized: false,
      response: json(
        { ok: false, error: "Linear webhook authority required (workspace admin or admin-scoped token)" },
        { status: 403 },
      ),
    };
  }
  linearWebhookAuthorityByTokenHash.set(tokenHash, { expiresAt: Date.now() + 5 * 60_000 });
  return { authorized: true };
}

export async function handleLinearOrganizationRegister(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  const auth = await verifyLinearViewerOrganization(request, env);
  if (!auth.authorized) return auth.response;
  const authority = await verifyLinearWebhookAuthority(request, env);
  if (!authority.authorized) return authority.response;
  const accountId = await authenticateAccount(request, env);
  if (contentLengthExceedsLimit(request.headers, MAX_LINEAR_REGISTRATION_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_LINEAR_REGISTRATION_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid payload");
    payload = parsed;
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const secret = typeof payload.secret === "string" ? payload.secret.trim() : "";
  if (!secret) return json({ ok: false, error: "secret is required" }, { status: 400 });
  if (secret.length > MAX_LINEAR_WEBHOOK_SECRET_LENGTH) {
    return json({ ok: false, error: `secret must be at most ${MAX_LINEAR_WEBHOOK_SECRET_LENGTH} characters` }, { status: 400 });
  }

  const now = new Date().toISOString();
  await env.DB
    .prepare(`
      insert into linear_organizations(org_id, webhook_secret, registered_at, updated_at, account_id)
      values (?, ?, ?, ?, ?)
      on conflict(org_id) do update set
        webhook_secret = excluded.webhook_secret,
        updated_at = excluded.updated_at,
        account_id = case
          when excluded.account_id is null then linear_organizations.account_id
          when linear_organizations.account_id is not null then linear_organizations.account_id
          when linear_organizations.unlinked_account_id = excluded.account_id then null
          else excluded.account_id
        end,
        unlinked_account_id = case
          when excluded.account_id is null then linear_organizations.unlinked_account_id
          when linear_organizations.account_id is not null then linear_organizations.unlinked_account_id
          when linear_organizations.unlinked_account_id = excluded.account_id then linear_organizations.unlinked_account_id
          else null
        end
    `)
    .bind(auth.organizationId, secret, now, now, accountId)
    .run();
  if (accountId) {
    await env.DB
      .prepare(`
        update linear_events
           set account_id = ?
         where org_id = ?
           and account_id is null
           and exists (
             select 1
               from linear_organizations
              where org_id = ? and account_id = ?
           )
      `)
      .bind(accountId, auth.organizationId, auth.organizationId, accountId)
      .run();
  }

  return json({ organizationId: auth.organizationId });
}

/**
 * Bounces Linear's OAuth redirect (an https URL Linear accepts) to the ADE app's
 * custom scheme so `ASWebAuthenticationSession` can capture it. Stateless: the
 * PKCE `state` is validated on the desktop, never here. The authorization `code`
 * is PKCE-bound and useless in transit, but MUST NOT be logged regardless.
 */
export function handleLinearOAuthCallback(request: Request): Response {
  if (request.method !== "GET") return text("method not allowed", 405);
  const params = new URL(request.url).searchParams;
  const callback = new URLSearchParams();
  const error = params.get("error");
  if (error) {
    callback.set("error", error);
    const description = params.get("error_description");
    if (description) callback.set("error_description", description);
  } else {
    callback.set("code", params.get("code") ?? "");
  }
  callback.set("state", params.get("state") ?? "");
  // URLSearchParams serializes spaces as "+", but the iOS callback parser reads
  // the custom-scheme URL with URLComponents, which does NOT turn "+" back into
  // a space — so an error like "User declined" would render as "User+declined".
  // Emit %20 for spaces to keep Linear's user-facing error text readable.
  const query = callback.toString().replace(/\+/g, "%20");
  return new Response(null, {
    status: 302,
    headers: { location: `ade://linear-oauth?${query}` },
  });
}

async function pruneOldLinearEvents(env: RelayEnv): Promise<void> {
  const days = Number(env.EVENT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from linear_events where received_at < ?")
    .bind(cutoff)
    .run();
}

export async function handleLinearWebhook(request: Request, env: RelayEnv, ctx?: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (contentLengthExceedsLimit(request.headers, MAX_LINEAR_WEBHOOK_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_LINEAR_WEBHOOK_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const rawBody = new TextDecoder().decode(body);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid payload");
    payload = parsed;
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const organizationId = readString(payload, "organizationId");
  if (!organizationId) return json({ ok: false, error: "organizationId is required" }, { status: 400 });
  const organization = await env.DB
    .prepare("select webhook_secret from linear_organizations where org_id = ? limit 1")
    .bind(organizationId)
    .first<LinearOrganizationRow>();

  // Two legitimate signers: the per-organization secret registered by a
  // workspace webhook, and the ADE Linear OAuth app's single app-level
  // secret (Linear signs every workspace's app deliveries with it, so app
  // deliveries need no prior per-org registration).
  const signature = request.headers.get("linear-signature")?.trim() ?? "";
  const appSecret = env.LINEAR_APP_WEBHOOK_SECRET?.trim() || null;
  // A second OAuth app (e.g. a workspace-owned "ADE" app next to the bundled
  // one) signs with its own secret; accept either.
  const appSecrets = [appSecret, env.LINEAR_APP_WEBHOOK_SECRET_ALT?.trim() || null].filter((value): value is string => Boolean(value));
  const signedByOrganization = organization
    ? await verifyLinearSignature(organization.webhook_secret, body, signature)
    : false;
  let signedByApp = false;
  if (!signedByOrganization) {
    for (const candidate of appSecrets) {
      if (await verifyLinearSignature(candidate, body, signature)) {
        signedByApp = true;
        break;
      }
    }
  }
  if (!signedByOrganization && !signedByApp) {
    // Which secret was tried and missed, never the secrets themselves.
    console.warn("linear_webhook.signature_rejected", {
      organizationId,
      organizationRegistered: Boolean(organization),
      appSecretConfigured: Boolean(appSecret),
      signaturePresent: signature.length > 0,
      signatureHexShaped: /^[0-9a-f]{64}$/i.test(signature),
      // First 8 hex of sha256(secret): lets an operator compare the configured
      // secret with the one Linear shows, without revealing either.
      appSecretFingerprints: await Promise.all(appSecrets.map(async (candidate) => (await sha256Hex(candidate)).slice(0, 8))),
      eventType: request.headers.get("linear-event"),
    });
    if (!organization) {
      // Indistinguishable from an accepted delivery so unauthenticated callers
      // cannot probe which organizations have registered ADE ingestion. Nothing
      // is stored; the registration status endpoint is the debugging surface.
      return json({ ok: true });
    }
    return json({ ok: false, error: "signature mismatch" }, { status: 401 });
  }

  const webhookTimestamp = typeof payload.webhookTimestamp === "number"
    ? payload.webhookTimestamp
    : Number(payload.webhookTimestamp);
  if (!Number.isFinite(webhookTimestamp) || Math.abs(Date.now() - webhookTimestamp) > LINEAR_WEBHOOK_REPLAY_WINDOW_MS) {
    return json({ ok: false, error: "stale webhook timestamp" }, { status: 401 });
  }

  const eventType = request.headers.get("linear-event")?.trim() || readString(payload, "type");
  const action = readString(payload, "action");
  if (!eventType || !action) {
    return json({ ok: false, error: "event type and action are required" }, { status: 400 });
  }
  const eventId = request.headers.get("linear-delivery")?.trim() || `sha256:${await sha256Hex(body)}`;
  const existing = await env.DB
    .prepare("select event_id from linear_events where org_id = ? and event_id = ? limit 1")
    .bind(organizationId, eventId)
    .first<{ event_id: string }>();
  if (existing) return json({ ok: true, duplicate: true, eventId });

  const accountMapping = organization
    ? await env.DB
      .prepare("select account_id from linear_organizations where org_id = ? limit 1")
      .bind(organizationId)
      .first<AccountMappingRow>()
    : null;
  const receivedAt = new Date().toISOString();

  // Agent sessions belong to the person who started them, not to whichever
  // account owns the org mapping: route first, then store under that account.
  const agentRoute = eventType === "AgentSessionEvent"
    ? await routeLinearAgentSessionEvent(env, organizationId, action, payload, receivedAt)
    : null;
  const storedAccountId = agentRoute
    ? (agentRoute.routed ? agentRoute.accountId : null)
    : accountMapping?.account_id ?? null;
  await env.DB
    .prepare(`
      insert or ignore into linear_events(org_id, event_id, event_type, action, received_at, body, account_id, routed_account_id)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      organizationId,
      eventId,
      eventType,
      action,
      receivedAt,
      rawBody,
      storedAccountId,
      agentRoute?.routed ? agentRoute.accountId : null,
    )
    .run();
  await pruneOldLinearEvents(env);

  // Linear retries unless it sees a 2xx within 5 s, and the first agent
  // activity must land within 10 s of `created`: acknowledgements and wake-ups
  // run after the response when the runtime offers waitUntil.
  await runAfterResponse(ctx, async () => {
    const tasks: Promise<unknown>[] = [
      notifyLinearTopic(env, `linear-org:${organizationId}`, { t: "linear_delivery", orgId: organizationId }),
    ];
    if (agentRoute?.routed) {
      tasks.push(notifyLinearTopic(env, `linear-account:${agentRoute.accountId}`, { t: "linear_delivery" }));
    }
    if (agentRoute?.acknowledgement) {
      tasks.push(postLinearAgentAcknowledgement(env, organizationId, agentRoute.acknowledgement));
    }
    await Promise.all(tasks);
  });

  return json({ ok: true, duplicate: false, eventId });
}

function linearRowToEvent(row: LinearEventRow): Record<string, unknown> {
  const cursor = `seq:${Math.max(0, Math.trunc(Number(row.event_seq) || 0))}`;
  return {
    cursor,
    eventId: row.event_id,
    eventType: row.event_type,
    action: row.action,
    createdAt: row.received_at,
    body: row.body,
    routedAccountId: row.routed_account_id ?? null,
  };
}

function nextLinearCursor(rows: LinearEventRow[], fallback: string): string | null {
  const latest = rows.reduce((max, row) => Math.max(max, Math.trunc(Number(row.event_seq) || 0)), 0);
  return latest > 0 ? `seq:${latest}` : fallback || null;
}

type LinearEventsReadAuthorization =
  | { authorized: true; accountId: string | null; routedOnly: boolean }
  | { authorized: false; response: Response };

/**
 * Org-wide reads: a Linear token with webhook authority for the org, or the ADE
 * account that owns the org mapping (scoped to its own rows). With
 * `allowAgentMembers`, an account registered as a Linear agent member of the org
 * may also read, scoped to the agent-session events routed to it.
 */
async function authorizeLinearEventsRead(
  request: Request,
  env: RelayEnv,
  organizationId: string,
  allowAgentMembers: boolean,
): Promise<LinearEventsReadAuthorization> {
  const auth = await verifyLinearViewerOrganization(request, env);
  let legacyError: Response | null = null;
  if (!auth.authorized) {
    legacyError = auth.response;
  } else if (auth.organizationId !== organizationId) {
    legacyError = json({ ok: false, error: "forbidden" }, { status: 403 });
  } else {
    // Membership alone must not expose the org-wide backlog: app-delivered
    // events can include private-team payloads a plain member cannot see in
    // Linear. Reads require the same webhook authority as registration.
    const authority = await verifyLinearWebhookAuthority(request, env);
    if (!authority.authorized) legacyError = authority.response;
  }
  if (!legacyError) return { authorized: true, accountId: null, routedOnly: false };

  const accountId = await authenticateAccount(request, env);
  if (accountId && await linearOrganizationAccountMatches(env, organizationId, accountId)) {
    return { authorized: true, accountId, routedOnly: false };
  }
  if (accountId && allowAgentMembers && await linearAgentMemberAccountMatches(env, organizationId, accountId)) {
    return { authorized: true, accountId, routedOnly: true };
  }
  return { authorized: false, response: legacyError };
}

export async function handleListLinearEvents(
  request: Request,
  env: RelayEnv,
  organizationId: string,
): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const authorization = await authorizeLinearEventsRead(request, env, organizationId, true);
  if (!authorization.authorized) return authorization.response;
  const { accountId, routedOnly } = authorization;

  const url = new URL(request.url);
  const limit = parseLimit(url);
  const after = url.searchParams.get("after")?.trim() || "";
  const accountPredicate = accountId
    ? (routedOnly ? " and routed_account_id = ?" : " and account_id = ?")
    : "";
  const accountBinding = accountId ? [accountId] : [];
  let rows: LinearEventRow[];
  let cursorExpired = false;

  if (after) {
    const sequenceCursor = parseSequenceCursor(after);
    if (sequenceCursor != null) {
      // Cursored reads page OLDEST-first: with desc ordering a page larger
      // than `limit` would advance the cursor past rows it never returned,
      // silently dropping them. Ascending pages + max-seq cursor drain the
      // backlog without gaps.
      rows = (await env.DB
        .prepare(`
          select rowid as event_seq, event_id, event_type, action, received_at, body, routed_account_id
            from linear_events
           where org_id = ?${accountPredicate} and rowid > ?
           order by rowid asc
           limit ?
        `)
        .bind(organizationId, ...accountBinding, sequenceCursor, limit)
        .all<LinearEventRow>()).results ?? [];
    } else {
      const cursor = await env.DB
        .prepare(`select rowid as event_seq, event_id from linear_events where org_id = ?${accountPredicate} and event_id = ? limit 1`)
        .bind(organizationId, ...accountBinding, after)
        .first<CursorRow>();
      if (cursor) {
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, event_type, action, received_at, body, routed_account_id
              from linear_events
             where org_id = ?${accountPredicate} and rowid > ?
             order by rowid asc
             limit ?
          `)
          .bind(organizationId, ...accountBinding, cursor.event_seq, limit)
          .all<LinearEventRow>()).results ?? [];
      } else {
        cursorExpired = true;
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, event_type, action, received_at, body, routed_account_id
              from linear_events
             where org_id = ?${accountPredicate}
             order by rowid desc
             limit ?
          `)
          .bind(organizationId, ...accountBinding, limit)
          .all<LinearEventRow>()).results ?? [];
      }
    }
  } else {
    rows = (await env.DB
      .prepare(`
        select rowid as event_seq, event_id, event_type, action, received_at, body, routed_account_id
          from linear_events
         where org_id = ?${accountPredicate}
         order by rowid desc
         limit ?
      `)
      .bind(organizationId, ...accountBinding, limit)
      .all<LinearEventRow>()).results ?? [];
  }

  return json({
    events: rows.map(linearRowToEvent),
    nextCursor: nextLinearCursor(rows, after),
    cursorExpired,
  });
}

// ---------------------------------------------------------------------------
// Linear agent (actor=app). The relay holds each workspace's app token, routes
// every agent session to the ADE account of the person who started it, posts
// the first acknowledgement inside Linear's window, and proxies the routed
// account's activity writes. D1 stays the durable event stream; the topic
// Durable Objects only carry wake-up hints.
// ---------------------------------------------------------------------------

export async function handleLinearOrganizationSubscription(
  request: Request,
  env: RelayEnv,
  organizationId: string,
): Promise<Response> {
  const upgradeRequired = requireWebSocketUpgrade(request);
  if (upgradeRequired) return upgradeRequired;
  const authorization = await authorizeLinearEventsRead(request, env, organizationId, false);
  if (!authorization.authorized) return authorization.response;
  return await subscribeLinearTopic(env, `linear-org:${organizationId}`);
}
