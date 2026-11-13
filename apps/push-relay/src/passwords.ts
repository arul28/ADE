/**
 * Passwords: sealed items and the wrapped vault key, per account.
 *
 * Unlike the account vault (`accountVault.ts`), this Worker never sees an
 * item's contents, not even briefly: items arrive already sealed on the
 * person's device or cloud lane under the account's vault key, and are stored
 * and returned as opaque text. Site names and usernames are inside too.
 *
 * The vault key itself is stored only wrapped. Wrapping and unwrapping happen
 * in a separate Worker (ade-password-key-service) that holds the master
 * secret and nothing else; this Worker holds the wrapped key and decides who
 * may have it opened (a signed-in session of the account). So neither Worker's
 * database or secrets open a vault alone.
 *
 * Every key release is recorded (`password_key_releases`) for the person's
 * Activity view. The "ADE Cloud computers can use Passwords" switch is
 * enforced by the cloud computer's own brain: this Worker sees an account
 * session, not what kind of machine holds it, and says so rather than
 * pretending otherwise.
 *
 * Routes, under the account's authenticated `/attention/account/`:
 *   GET    passwords/items?since=      sealed items, paged by revision
 *   PUT    passwords/items             { items: [{ id, ciphertext, ifRevision?, deleted? }], deviceId? }
 *   POST   passwords/key               { deviceId, machineKind } -> { dek, epoch }
 *   POST   passwords/reset             { deviceId, confirm: "reset" } -> { dek, epoch }
 *   GET    passwords/releases          the last key releases
 */
import * as Sentry from "@sentry/cloudflare";
import {
  accountPageResult,
  buildAccountPageQuery,
  json,
  parseSinceParam,
  type AttentionRelayEnv,
} from "./attentionShared";

export type PasswordsEnv = AttentionRelayEnv & {
  PASSWORD_KEY_SERVICE?: Fetcher;
  KEY_SERVICE_AUTH_SECRET?: string;
};

const MAX_ITEMS_PER_READ = 500;
const MAX_ITEMS_PER_WRITE = 200;
/** A sealed item: small JSON envelope. Generous, but bounded. */
const MAX_CIPHERTEXT_CHARS = 64 * 1024;
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;
const MACHINE_KINDS = new Set(["desktop", "phone", "cloud", "web", "cli"]);
const KEY_COLUMNS = ["item_id"];
/** Strictly after the stored revision, so two writes in one millisecond still advance it. */
const NEXT_UPDATED_AT =
  "max(?, coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', password_items.updated_at, '+0.001 seconds'), ?))";

type ItemRow = { item_id: string; ciphertext: string; updated_at: string; deleted: number };

const unavailable = () => json({ ok: false, error: "passwords unavailable", code: "passwords_unavailable" }, { status: 503 });
const badRequest = (error: string) => json({ ok: false, error }, { status: 400 });

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Call the key service; null when it is unreachable or unconfigured. */
/**
 * The key service could not answer: Passwords is unavailable for everyone
 * until it is fixed, so it is a Sentry issue per cause (the key service has
 * no address of its own; this Worker is the one that sees it fail). Never
 * the account, the key or the body.
 */
function reportKeyServiceFailure(path: string, reason: string): void {
  Sentry.captureMessage(`Passwords key service ${reason}`, {
    level: "error",
    tags: { area: "passwords", key_service_path: path, reason },
    fingerprint: ["passwords", "key-service", reason],
  });
}

async function keyService(env: PasswordsEnv, path: "/v1/create" | "/v1/unwrap", body: Record<string, string>): Promise<Record<string, string> | null> {
  const auth = env.KEY_SERVICE_AUTH_SECRET?.trim();
  if (!env.PASSWORD_KEY_SERVICE || !auth) {
    reportKeyServiceFailure(path, "not_configured");
    return null;
  }
  try {
    const response = await env.PASSWORD_KEY_SERVICE.fetch(`https://password-key-service.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ade-key-service-auth": auth },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      reportKeyServiceFailure(path, `status_${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, string>;
  } catch (error) {
    reportKeyServiceFailure(path, error instanceof SyntaxError ? "unreadable" : "unreachable");
    return null;
  }
}

/** The account's current key epoch, or null before its first key. */
async function currentEpoch(env: PasswordsEnv, userId: string): Promise<number | null> {
  const row = await env.DB.prepare("select epoch from password_keys where user_id = ?").bind(userId).first<{ epoch: number }>();
  return typeof row?.epoch === "number" ? row.epoch : null;
}

/** The key epoch a sealed envelope names (it is plaintext in the envelope), or null. */
function envelopeEpoch(ciphertext: string): number | null {
  try {
    const parsed = JSON.parse(ciphertext) as { epoch?: unknown };
    return typeof parsed?.epoch === "number" && Number.isSafeInteger(parsed.epoch) ? parsed.epoch : null;
  } catch {
    return null;
  }
}

async function handleRead(env: PasswordsEnv, userId: string, url: URL): Promise<Response> {
  const cursor = parseSinceParam(url);
  const query = buildAccountPageQuery({ userId, cursor, scope: null, keyColumns: KEY_COLUMNS, limit: MAX_ITEMS_PER_READ });
  const rows = await env.DB.prepare(`
    select item_id, ciphertext, updated_at, deleted
    from password_items
    where ${query.where}
    order by ${query.orderBy}
    limit ?
  `).bind(...query.bindings).all<ItemRow>();
  const paged = accountPageResult(rows.results, { limit: MAX_ITEMS_PER_READ, keyColumns: KEY_COLUMNS, cursor });
  return json({
    ok: true,
    items: paged.page.map((row) => ({
      id: row.item_id,
      // A tombstone carries no ciphertext back.
      ciphertext: row.deleted ? null : row.ciphertext,
      revision: row.updated_at,
      deleted: Boolean(row.deleted),
    })),
    truncated: paged.truncated,
    cursor: paged.cursor,
    // A client holding an older key learns a reset happened elsewhere.
    epoch: await currentEpoch(env, userId),
  });
}

/**
 * Batch write. `ifRevision` is the revision the writer decided on:
 * - a revision string: change the row only while it still has it;
 * - "absent": insert only when there is no row (a tombstone counts as a row);
 * - missing: last writer wins.
 * A refused write comes back as `stale` with the stored row, so the writer
 * can merge and retry; nothing is overwritten silently.
 */
async function handleWrite(request: Request, env: PasswordsEnv, userId: string): Promise<Response> {
  const body = await readBody(request);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return badRequest("items required");
  if (items.length > MAX_ITEMS_PER_WRITE) return badRequest("too many items");
  const deviceId = typeof body?.deviceId === "string" && DEVICE_ID_PATTERN.test(body.deviceId) ? body.deviceId : null;
  const now = new Date().toISOString();
  const results: Array<{ id: string; status: "ok" | "stale" | "invalid" | "stale_key"; revision?: string | null; epoch?: number }> = [];
  const epoch = await currentEpoch(env, userId);

  for (const raw of items) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = typeof item.id === "string" ? item.id : "";
    const deleted = item.deleted === true;
    const ciphertext = typeof item.ciphertext === "string" ? item.ciphertext : "";
    const ifRevision = typeof item.ifRevision === "string" ? item.ifRevision : null;
    if (!ITEM_ID_PATTERN.test(id) || (!deleted && (!ciphertext || ciphertext.length > MAX_CIPHERTEXT_CHARS))) {
      results.push({ id, status: "invalid" });
      continue;
    }
    // A write sealed under a key from before the last reset would be unreadable
    // to every computer that holds the new key: refused, and told the epoch.
    const sealedEpoch = deleted ? null : envelopeEpoch(ciphertext);
    if (!deleted && epoch !== null && (sealedEpoch === null || sealedEpoch < epoch)) {
      results.push({ id, status: "stale_key", epoch });
      continue;
    }
    const stored = deleted ? "" : ciphertext;
    let statement: D1PreparedStatement;
    if (ifRevision === "absent") {
      statement = env.DB.prepare(`
        insert into password_items(user_id, item_id, ciphertext, updated_at, writer_device_id, deleted)
        values (?, ?, ?, ?, ?, ?)
        on conflict(user_id, item_id) do nothing
      `).bind(userId, id, stored, now, deviceId, deleted ? 1 : 0);
    } else if (ifRevision) {
      statement = env.DB.prepare(`
        update password_items
        set ciphertext = ?, updated_at = ${NEXT_UPDATED_AT}, writer_device_id = ?, deleted = ?
        where user_id = ? and item_id = ? and updated_at = ?
      `).bind(stored, now, now, deviceId, deleted ? 1 : 0, userId, id, ifRevision);
    } else {
      statement = env.DB.prepare(`
        insert into password_items(user_id, item_id, ciphertext, updated_at, writer_device_id, deleted)
        values (?, ?, ?, ?, ?, ?)
        on conflict(user_id, item_id) do update set
          ciphertext = excluded.ciphertext,
          updated_at = ${NEXT_UPDATED_AT},
          writer_device_id = excluded.writer_device_id,
          deleted = excluded.deleted
      `).bind(userId, id, stored, now, deviceId, deleted ? 1 : 0, now, now);
    }
    const outcome = await statement.run();
    const row = await env.DB.prepare(
      "select updated_at from password_items where user_id = ? and item_id = ?",
    ).bind(userId, id).first<{ updated_at: string }>();
    const changed = (outcome.meta?.changes ?? 0) > 0;
    results.push({ id, status: changed ? "ok" : "stale", revision: row?.updated_at ?? null });
  }
  return json({ ok: true, results });
}

async function recordRelease(env: PasswordsEnv, userId: string, deviceId: string, machineKind: string): Promise<void> {
  await env.DB.prepare(`
    insert into password_key_releases(user_id, device_id, machine_kind, released_at)
    values (?, ?, ?, ?)
  `).bind(userId, deviceId, machineKind, new Date().toISOString()).run();
  // Keep the log bounded per account.
  await env.DB.prepare(`
    delete from password_key_releases
    where user_id = ? and rowid not in (
      select rowid from password_key_releases where user_id = ? order by released_at desc limit 200
    )
  `).bind(userId, userId).run();
}

async function releaseKey(env: PasswordsEnv, userId: string, body: Record<string, unknown> | null, reset: boolean): Promise<Response> {
  const deviceId = typeof body?.deviceId === "string" && DEVICE_ID_PATTERN.test(body.deviceId) ? body.deviceId : null;
  const machineKind = typeof body?.machineKind === "string" && MACHINE_KINDS.has(body.machineKind) ? body.machineKind : null;
  if (!deviceId || !machineKind) return badRequest("deviceId and machineKind required");

  const existing = reset
    ? null
    : await env.DB.prepare("select wrapped_dek, epoch from password_keys where user_id = ?")
      .bind(userId)
      .first<{ wrapped_dek: string; epoch: number }>();

  let dek: string;
  let epoch: number;
  if (existing) {
    const opened = await keyService(env, "/v1/unwrap", { accountId: userId, wrappedDek: existing.wrapped_dek });
    if (!opened?.dek) return unavailable();
    dek = opened.dek;
    epoch = existing.epoch;
  } else {
    const created = await keyService(env, "/v1/create", { accountId: userId });
    if (!created?.dek || !created.wrappedDek) return unavailable();
    const previous = await env.DB.prepare("select epoch from password_keys where user_id = ?")
      .bind(userId)
      .first<{ epoch: number }>();
    epoch = (previous?.epoch ?? 0) + 1;
    // First key (insert only) or a reset (replace and wipe the items). A first
    // key racing another device's first key keeps whichever landed first.
    if (reset) {
      await env.DB.batch([
        env.DB.prepare(`
          insert into password_keys(user_id, wrapped_dek, epoch, created_at) values (?, ?, ?, ?)
          on conflict(user_id) do update set wrapped_dek = excluded.wrapped_dek, epoch = excluded.epoch, created_at = excluded.created_at
        `).bind(userId, created.wrappedDek, epoch, new Date().toISOString()),
        env.DB.prepare(`
          update password_items
          set ciphertext = '', deleted = 1, updated_at = ${NEXT_UPDATED_AT}
          where user_id = ? and deleted = 0
        `).bind(new Date().toISOString(), new Date().toISOString(), userId),
      ]);
      dek = created.dek;
    } else {
      await env.DB.prepare(`
        insert into password_keys(user_id, wrapped_dek, epoch, created_at) values (?, ?, ?, ?)
        on conflict(user_id) do nothing
      `).bind(userId, created.wrappedDek, epoch, new Date().toISOString()).run();
      const winner = await env.DB.prepare("select wrapped_dek, epoch from password_keys where user_id = ?")
        .bind(userId)
        .first<{ wrapped_dek: string; epoch: number }>();
      if (!winner) return unavailable();
      if (winner.wrapped_dek === created.wrappedDek) {
        dek = created.dek;
      } else {
        const opened = await keyService(env, "/v1/unwrap", { accountId: userId, wrappedDek: winner.wrapped_dek });
        if (!opened?.dek) return unavailable();
        dek = opened.dek;
      }
      epoch = winner.epoch;
    }
  }
  await recordRelease(env, userId, deviceId, machineKind);
  return json({ ok: true, dek, epoch });
}

async function handleReleases(env: PasswordsEnv, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(`
    select device_id, machine_kind, released_at from password_key_releases
    where user_id = ? order by released_at desc limit 100
  `).bind(userId).all<{ device_id: string; machine_kind: string; released_at: string }>();
  return json({
    ok: true,
    releases: rows.results.map((row) => ({ deviceId: row.device_id, machineKind: row.machine_kind, at: row.released_at })),
  });
}

export async function handlePasswordsRoute(
  request: Request,
  env: PasswordsEnv,
  url: URL,
  userId: string,
  route: string[],
): Promise<Response | null> {
  if (route[0] !== "passwords") return null;
  const tail = route.slice(1).join("/");
  if (tail === "items" && request.method === "GET") return await handleRead(env, userId, url);
  if (tail === "items" && request.method === "PUT") return await handleWrite(request, env, userId);
  if (tail === "key" && request.method === "POST") return await releaseKey(env, userId, await readBody(request), false);
  if (tail === "reset" && request.method === "POST") {
    const body = await readBody(request);
    if (body?.confirm !== "reset") return badRequest("confirm required");
    return await releaseKey(env, userId, body, true);
  }
  if (tail === "releases" && request.method === "GET") return await handleReleases(env, userId);
  return null;
}
