// Cursor Cloud webhooks: secret registration, signed ingest, and the event
// stream ADE polls.

import {
  claimPeriodicRun,
  constantTimeEqual,
  contentLengthExceedsLimit,
  type CursorRow,
  DEFAULT_RETENTION_DAYS,
  hasValidGitHubSignatureShape,
  isRecord,
  json,
  parseLimit,
  parseSequenceCursor,
  readString,
  type RelayEnv,
  sha256Hex,
  signGitHubWebhookBody,
  text,
  verifyGitHubSignature,
} from "./shared";
import { authenticateAccount, readBearerToken } from "./auth";

type CursorCloudEventRow = {
  event_seq: number;
  event_id: string;
  event_type: string;
  status: string;
  agent_id: string;
  received_at: string;
  body: string;
};

type CursorWebhookSecretRow = {
  id: string;
  webhook_secret: string;
  account_id: string | null;
};

const MAX_CURSOR_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_CURSOR_REGISTRATION_BODY_BYTES = 16 * 1024;
const MAX_CURSOR_WEBHOOK_SECRET_LENGTH = 512;
const MIN_CURSOR_WEBHOOK_SECRET_LENGTH = 32;
const CURSOR_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;
const CURSOR_ENV_SECRET_ID = "env";

export async function signCursorWebhookBody(secret: string, body: string | ArrayBuffer): Promise<string> {
  return signGitHubWebhookBody(secret, body);
}

function parseCursorWebhookTimestamp(payload: Record<string, unknown>): number | null {
  const raw = payload.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim()) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * How many never-signed-in registrations the legacy scan still tries. Anyone
 * can register one of those, so they are the part of the scan an attacker could
 * grow. The most recently polled ones are the installs that are running now.
 */
const MAX_LEGACY_UNOWNED_SECRETS_SCANNED = 100;
/**
 * How many signed-in registrations the legacy scan tries, most recently used
 * first. Current desktops name their secret, so only old addresses need it.
 */
const MAX_LEGACY_OWNED_SECRETS_SCANNED = 200;
/**
 * Registrations one account keeps: one for each computer (each has its own
 * secret). Past this the least recently used (last poll or registration) is
 * dropped; if that computer is still running, its next poll learns the secret
 * is gone and registers again.
 */
const MAX_CURSOR_SECRETS_PER_ACCOUNT = 32;
/**
 * Each scanned secret hashes the whole body once, so the legacy scan also takes
 * a smaller body. A Cursor status payload is a few KB.
 */
const MAX_LEGACY_CURSOR_WEBHOOK_BODY_BYTES = 64 * 1024;

// The legacy path, for webhook addresses created before they named their
// secret (`?sid=`). Secrets in use: owned by an account, or polled recently.
// Never-used registrations are skipped so an unauthenticated webhook POST
// cannot force a read of every row. Nothing is deleted: an install that falls
// outside the window still receives events again once its next Cursor agent
// uses the new address.
async function listLegacyCursorWebhookSecrets(env: RelayEnv): Promise<CursorWebhookSecretRow[]> {
  const owned = (await env.DB
    .prepare(`
      select id, webhook_secret, account_id
        from cursor_webhook_secrets
       where account_id is not null
       order by max(updated_at, coalesce(last_polled_at, updated_at)) desc
       limit ?
    `)
    .bind(MAX_LEGACY_OWNED_SECRETS_SCANNED)
    .all<CursorWebhookSecretRow>()).results ?? [];
  const unowned = (await env.DB
    .prepare(`
      select id, webhook_secret, account_id
        from cursor_webhook_secrets
       where account_id is null and last_polled_at is not null
       order by last_polled_at desc
       limit ?
    `)
    .bind(MAX_LEGACY_UNOWNED_SECRETS_SCANNED)
    .all<CursorWebhookSecretRow>()).results ?? [];
  return [...owned, ...unowned];
}

/**
 * The secret a delivery was signed with.
 *
 * A webhook address that names its secret (`?sid=<secretId>`, which current
 * desktops put on every Cursor agent they start) is checked against that one
 * row and nothing else. A wrong sid is a mismatch; it never falls back to the
 * scan, so naming a secret can only make a request cheaper.
 */
async function matchCursorWebhookSecret(
  env: RelayEnv,
  body: ArrayBuffer,
  signature: string,
  secretId: string | null,
): Promise<CursorWebhookSecretRow | null> {
  const envSecret = env.CURSOR_WEBHOOK_SECRET?.trim() || "";
  if (secretId === CURSOR_ENV_SECRET_ID) {
    return envSecret && await verifyGitHubSignature(envSecret, body, signature)
      ? { id: CURSOR_ENV_SECRET_ID, webhook_secret: envSecret, account_id: null }
      : null;
  }
  if (secretId) {
    const row = await env.DB
      .prepare("select id, webhook_secret, account_id from cursor_webhook_secrets where id = ? limit 1")
      .bind(secretId)
      .first<CursorWebhookSecretRow>();
    return row && await verifyGitHubSignature(row.webhook_secret, body, signature) ? row : null;
  }
  if (envSecret && await verifyGitHubSignature(envSecret, body, signature)) {
    return { id: CURSOR_ENV_SECRET_ID, webhook_secret: envSecret, account_id: null };
  }
  const registered = await listLegacyCursorWebhookSecrets(env);
  for (const row of registered) {
    if (await verifyGitHubSignature(row.webhook_secret, body, signature)) return row;
  }
  return null;
}

/** The registration a poll's bearer secret names, stamped as in use; null when none. */
async function findPolledCursorSecret(
  env: RelayEnv,
  bearer: string,
): Promise<CursorWebhookSecretRow | null> {
  // Indexed point lookup. Reading every registered secret here, once per
  // client poll, was the relay's largest D1 bill line.
  const match = await env.DB
    .prepare("select id, webhook_secret, account_id, last_polled_at from cursor_webhook_secrets where webhook_secret = ? limit 1")
    .bind(bearer)
    .first<CursorWebhookSecretRow & { last_polled_at: string | null }>();
  if (!match || !constantTimeEqual(bearer, match.webhook_secret)) return null;
  try {
    await touchCursorWebhookSecret(env, match.id, match.last_polled_at);
  } catch {
    // Bookkeeping only; a failed stamp must not fail a valid poll.
  }
  return match;
}

async function authorizeCursorEventsRead(
  request: Request,
  env: RelayEnv,
): Promise<{ accountId: string | null; secretId: string | null; secretKnown: boolean } | Response> {
  const accountId = await authenticateAccount(request, env);
  const bearer = readBearerToken(request);
  const envSecret = env.CURSOR_WEBHOOK_SECRET?.trim() || "";
  const bearerIsEnvSecret = Boolean(bearer && envSecret && constantTimeEqual(bearer, envSecret));

  if (accountId) {
    // A signed-in poll still sends its computer's secret. Stamping it keeps the
    // per-account cap dropping only idle computers, and a secret the relay no
    // longer holds tells that computer to register it again. A failed lookup
    // counts as known: it must not fail the poll or start a re-registration.
    let secretKnown = true;
    if (bearer && !bearerIsEnvSecret) {
      try {
        secretKnown = Boolean(await findPolledCursorSecret(env, bearer));
      } catch {
        secretKnown = true;
      }
    }
    return { accountId, secretId: null, secretKnown };
  }
  if (bearerIsEnvSecret) {
    return { accountId: null, secretId: CURSOR_ENV_SECRET_ID, secretKnown: true };
  }
  if (bearer) {
    const match = await findPolledCursorSecret(env, bearer);
    if (match) return { accountId: match.account_id, secretId: match.id, secretKnown: true };
  }
  return json({ ok: false, error: "unauthorized" }, { status: 401 });
}

const CURSOR_SECRET_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const CURSOR_SECRET_IDLE_DAYS = 30;

// Records that a secret is still in use, at most once an hour per secret, so
// the sweep below can tell live installs from abandoned registrations.
async function touchCursorWebhookSecret(env: RelayEnv, id: string, lastPolledAt: string | null): Promise<void> {
  const last = lastPolledAt ? Date.parse(lastPolledAt) : Number.NaN;
  if (Number.isFinite(last) && Date.now() - last < CURSOR_SECRET_TOUCH_INTERVAL_MS) return;
  await env.DB
    .prepare("update cursor_webhook_secrets set last_polled_at = ? where id = ?")
    .bind(new Date().toISOString(), id)
    .run();
}

// Unowned secrets nobody has polled with for a month are abandoned; a client
// that comes back gets a 401 and re-registers its stored secret.
async function sweepIdleCursorWebhookSecrets(env: RelayEnv): Promise<void> {
  if (!claimPeriodicRun(env.DB, "sweep-cursor-secrets", 60 * 60 * 1000)) return;
  const cutoff = new Date(Date.now() - CURSOR_SECRET_IDLE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare(`
      delete from cursor_webhook_secrets
       where account_id is null
         and coalesce(last_polled_at, registered_at) < ?
    `)
    .bind(cutoff)
    .run();
}

export async function handleCursorRegister(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (contentLengthExceedsLimit(request.headers, MAX_CURSOR_REGISTRATION_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CURSOR_REGISTRATION_BODY_BYTES) {
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
  if (secret.length < MIN_CURSOR_WEBHOOK_SECRET_LENGTH) {
    return json({ ok: false, error: `secret must be at least ${MIN_CURSOR_WEBHOOK_SECRET_LENGTH} characters` }, { status: 400 });
  }
  if (secret.length > MAX_CURSOR_WEBHOOK_SECRET_LENGTH) {
    return json({ ok: false, error: `secret must be at most ${MAX_CURSOR_WEBHOOK_SECRET_LENGTH} characters` }, { status: 400 });
  }

  const accountId = await authenticateAccount(request, env);
  const bearer = readBearerToken(request);
  const envSecret = env.CURSOR_WEBHOOK_SECRET?.trim() || "";
  const bearerMatchesSecret = Boolean(bearer && constantTimeEqual(bearer, secret));
  const bearerMatchesEnv = Boolean(bearer && envSecret && constantTimeEqual(bearer, envSecret));
  if (!accountId && !bearerMatchesSecret && !bearerMatchesEnv) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();
  // One row per secret, so each computer on an account keeps its own. A row
  // that already holds this secret keeps its id: that is a computer
  // registering again, or an `account:<id>` row from before rows were per
  // secret, whose webhook addresses and events still name it.
  const existing = await env.DB
    .prepare("select id from cursor_webhook_secrets where webhook_secret = ? limit 1")
    .bind(secret)
    .first<{ id: string }>();
  const id = existing?.id ?? `secret:${await sha256Hex(secret)}`;
  await env.DB
    .prepare(`
      insert into cursor_webhook_secrets(id, webhook_secret, account_id, registered_at, updated_at, unlinked_account_id)
      values (?, ?, ?, ?, ?, null)
      on conflict(id) do update set
        webhook_secret = excluded.webhook_secret,
        updated_at = excluded.updated_at,
        account_id = case
          when excluded.account_id is null then cursor_webhook_secrets.account_id
          when cursor_webhook_secrets.account_id is not null then cursor_webhook_secrets.account_id
          when cursor_webhook_secrets.unlinked_account_id = excluded.account_id then null
          else excluded.account_id
        end,
        unlinked_account_id = case
          when excluded.account_id is null then cursor_webhook_secrets.unlinked_account_id
          when cursor_webhook_secrets.account_id is not null then cursor_webhook_secrets.unlinked_account_id
          when cursor_webhook_secrets.unlinked_account_id = excluded.account_id then cursor_webhook_secrets.unlinked_account_id
          else null
        end
    `)
    .bind(id, secret, accountId, now, now)
    .run();
  if (accountId) {
    await env.DB
      .prepare(`
        update cursor_events
           set account_id = ?
         where secret_id = ?
           and account_id is null
      `)
      .bind(accountId, id)
      .run();
    await env.DB
      .prepare(`
        delete from cursor_webhook_secrets
         where account_id = ?
           and id not in (
             select id from cursor_webhook_secrets
              where account_id = ?
              order by max(updated_at, coalesce(last_polled_at, updated_at)) desc, id desc
              limit ?
           )
      `)
      .bind(accountId, accountId, MAX_CURSOR_SECRETS_PER_ACCOUNT)
      .run();
  }
  try {
    await sweepIdleCursorWebhookSecrets(env);
  } catch {
    // Sweeping is opportunistic; registration already committed.
  }
  return json({ ok: true, secretId: id });
}

async function pruneOldCursorEvents(env: RelayEnv): Promise<void> {
  const days = Number(env.EVENT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from cursor_events where received_at < ?")
    .bind(cutoff)
    .run();
}

export async function handleCursorWebhook(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (contentLengthExceedsLimit(request.headers, MAX_CURSOR_WEBHOOK_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CURSOR_WEBHOOK_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const signature = request.headers.get("x-webhook-signature")?.trim() ?? "";
  if (!hasValidGitHubSignatureShape(signature)) {
    return json({ ok: false, error: "signature mismatch" }, { status: 401 });
  }
  const secretId = new URL(request.url).searchParams.get("sid")?.trim() || null;
  if (!secretId && body.byteLength > MAX_LEGACY_CURSOR_WEBHOOK_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const matchedSecret = await matchCursorWebhookSecret(env, body, signature, secretId);
  if (!matchedSecret) {
    return json({ ok: false, error: "signature mismatch" }, { status: 401 });
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

  const webhookTimestamp = parseCursorWebhookTimestamp(payload);
  if (webhookTimestamp != null && Math.abs(Date.now() - webhookTimestamp) > CURSOR_WEBHOOK_REPLAY_WINDOW_MS) {
    return json({ ok: false, error: "stale webhook timestamp" }, { status: 401 });
  }

  const eventType = request.headers.get("x-webhook-event")?.trim()
    || readString(payload, "event")
    || "statusChange";
  const status = readString(payload, "status");
  const agentId = readString(payload, "id");
  if (!status || !agentId) {
    return json({ ok: false, error: "id and status are required" }, { status: 400 });
  }
  const eventId = request.headers.get("x-webhook-id")?.trim() || `sha256:${await sha256Hex(body)}`;
  // Per secret: two tenants can receive the same delivery id, and one must not
  // turn the other's real event into a duplicate.
  const existing = await env.DB
    .prepare("select event_id from cursor_events where secret_id = ? and event_id = ? limit 1")
    .bind(matchedSecret.id, eventId)
    .first<{ event_id: string }>();
  if (existing) return json({ ok: true, duplicate: true, eventId });

  const receivedAt = new Date().toISOString();
  await env.DB
    .prepare(`
      insert or ignore into cursor_events(event_id, event_type, status, agent_id, received_at, body, account_id, secret_id)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      eventId,
      eventType,
      status,
      agentId,
      receivedAt,
      rawBody,
      matchedSecret.account_id,
      matchedSecret.id,
    )
    .run();
  await pruneOldCursorEvents(env);
  return json({ ok: true, duplicate: false, eventId });
}

function cursorRowToEvent(row: CursorCloudEventRow): Record<string, unknown> {
  const cursor = `seq:${Math.max(0, Math.trunc(Number(row.event_seq) || 0))}`;
  return {
    cursor,
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status,
    agentId: row.agent_id,
    createdAt: row.received_at,
    body: row.body,
  };
}

function nextCursorCloudCursor(rows: CursorCloudEventRow[], fallback: string): string | null {
  const latest = rows.reduce((max, row) => Math.max(max, Math.trunc(Number(row.event_seq) || 0)), 0);
  return latest > 0 ? `seq:${latest}` : fallback || null;
}

export async function handleListCursorEvents(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const auth = await authorizeCursorEventsRead(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const limit = parseLimit(url);
  const after = url.searchParams.get("after")?.trim() || "";
  const accountPredicate = auth.accountId ? " and account_id = ?" : auth.secretId ? " and secret_id = ?" : "";
  const accountBinding = auth.accountId ? [auth.accountId] : auth.secretId ? [auth.secretId] : [];
  let rows: CursorCloudEventRow[];
  let cursorExpired = false;

  if (after) {
    const sequenceCursor = parseSequenceCursor(after);
    if (sequenceCursor != null) {
      rows = (await env.DB
        .prepare(`
          select rowid as event_seq, event_id, event_type, status, agent_id, received_at, body
            from cursor_events
           where 1 = 1${accountPredicate} and rowid > ?
           order by rowid asc
           limit ?
        `)
        .bind(...accountBinding, sequenceCursor, limit)
        .all<CursorCloudEventRow>()).results ?? [];
    } else {
      const cursor = await env.DB
        .prepare(`select rowid as event_seq, event_id from cursor_events where 1 = 1${accountPredicate} and event_id = ? limit 1`)
        .bind(...accountBinding, after)
        .first<CursorRow>();
      if (cursor) {
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, event_type, status, agent_id, received_at, body
              from cursor_events
             where 1 = 1${accountPredicate} and rowid > ?
             order by rowid asc
             limit ?
          `)
          .bind(...accountBinding, cursor.event_seq, limit)
          .all<CursorCloudEventRow>()).results ?? [];
      } else {
        cursorExpired = true;
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, event_type, status, agent_id, received_at, body
              from cursor_events
             where 1 = 1${accountPredicate}
             order by rowid desc
             limit ?
          `)
          .bind(...accountBinding, limit)
          .all<CursorCloudEventRow>()).results ?? [];
      }
    }
  } else {
    rows = (await env.DB
      .prepare(`
        select rowid as event_seq, event_id, event_type, status, agent_id, received_at, body
          from cursor_events
         where 1 = 1${accountPredicate}
         order by rowid desc
         limit ?
      `)
      .bind(...accountBinding, limit)
      .all<CursorCloudEventRow>()).results ?? [];
  }

  return json({
    events: rows.map(cursorRowToEvent),
    nextCursor: nextCursorCloudCursor(rows, after),
    cursorExpired,
    ...(auth.secretKnown ? {} : { secretKnown: false }),
  });
}
