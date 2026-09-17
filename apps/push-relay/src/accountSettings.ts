/**
 * The account settings store: the half of "sign in once and your setup follows
 * you" that is not a secret.
 *
 * It lives in this Worker rather than in the account directory for one
 * practical reason: the directory's only write route is the machine heartbeat,
 * which the brain alone may call. This Worker already accepts authenticated
 * writes from the brain, the iOS app, and the hosted web client, so a phone can
 * change a setting on the day this ships instead of after a second Worker grows
 * a client-facing write path.
 *
 * Deliberately NOT here: anything machine-scoped. A value that names a path, a
 * port, or a piece of hardware is meaningless on another computer, so it never
 * leaves the machine that owns it. The scope model's other axis — all projects
 * versus this repo — rides in `scope_key`.
 */
import {
  accountPageResult,
  buildAccountPageQuery,
  countAndGuard,
  isRecord,
  json,
  parseAccountScopeKey,
  parseSinceParam,
  requiredString,
  type AttentionRelayEnv,
} from "./attentionShared";

/**
 * One value's ceiling. Generous for a setting (the largest real one is a lane
 * template), small enough that no single key can crowd out an account.
 */
const MAX_SETTING_VALUE_BYTES = 16_000;

/**
 * Everything one account may keep here. Chosen against the real inventory —
 * ADE ships 64 settings, and the repo-scoped ones multiply by repositories — so
 * this is roughly a hundred repositories' worth of headroom, not a limit anyone
 * reaches by using the product.
 */
const MAX_SETTINGS_PER_ACCOUNT = 5_000;

/** One request's ceiling, so a batch cannot become an unbounded transaction. */
const MAX_SETTINGS_PER_WRITE = 200;

/** Bounds a `GET` page. Pulls ride a 30-second heartbeat, so they stay small. */
export const MAX_SETTINGS_PER_READ = 1_000;

const MAX_SETTING_KEY_LENGTH = 200;

/** The tiebreak columns after `updated_at`: the rest of the primary key. */
const SETTING_KEY_COLUMNS = ["scope_key", "setting_key"];

export type AccountSettingRow = {
  scope: string;
  key: string;
  value: unknown;
  updatedAt: string;
  changedAt: string | null;
  writerDeviceId: string | null;
  deleted?: boolean;
};

type ParsedWrite = {
  scope: string;
  key: string;
  valueJson: string;
  changedAt: string | null;
};

function parseSettingKey(value: unknown): string | null {
  const key = requiredString(value, MAX_SETTING_KEY_LENGTH);
  if (!key) return null;
  // The manifest's own vocabulary: dotted, lowercase-ish ids like
  // `lanes-git.auto-rebase`. Rejecting anything else keeps a key from carrying
  // structure the reader would have to parse.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) ? key : null;
}

function parseWriteItem(value: unknown): ParsedWrite | null {
  if (!isRecord(value)) return null;
  const scope = parseAccountScopeKey(value.scope);
  const key = parseSettingKey(value.key);
  if (!scope || !key) return null;
  // `undefined` is not a value — a caller that means "remove this" uses DELETE,
  // so that the reverse of a write is explicit rather than a special case of it.
  if (value.value === undefined) return null;
  let valueJson: string;
  try {
    valueJson = JSON.stringify(value.value);
  } catch {
    return null;
  }
  if (typeof valueJson !== "string" || valueJson.length > MAX_SETTING_VALUE_BYTES) return null;
  const changedAtRaw = typeof value.changedAt === "string" ? value.changedAt.trim() : "";
  const changedAt = changedAtRaw && !Number.isNaN(Date.parse(changedAtRaw))
    ? new Date(changedAtRaw).toISOString()
    : null;
  return { scope, key, valueJson, changedAt };
}

function rowToSetting(row: {
  scope_key: string;
  setting_key: string;
  value_json: string;
  updated_at: string;
  changed_at: string | null;
  writer_device_id: string | null;
  deleted: number;
}): AccountSettingRow {
  let value: unknown = null;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    // A row we cannot parse is reported as null rather than dropped. Dropping
    // it would make a corrupted value indistinguishable from a setting the user
    // never set, and the client would then helpfully "restore" its own default
    // over the top.
    value = null;
  }
  return {
    scope: row.scope_key,
    key: row.setting_key,
    value,
    updatedAt: row.updated_at,
    changedAt: row.changed_at,
    writerDeviceId: row.writer_device_id,
    ...(row.deleted ? { deleted: true } : {}),
  };
}

async function handleRead(
  env: AttentionRelayEnv,
  userId: string,
  url: URL,
): Promise<Response> {
  const cursor = parseSinceParam(url);
  const scope = url.searchParams.get("scope")?.trim()
    ? parseAccountScopeKey(url.searchParams.get("scope"))
    : null;
  if (url.searchParams.has("scope") && !scope) {
    return json({ ok: false, error: "invalid scope" }, { status: 400 });
  }

  const query = buildAccountPageQuery({
    userId,
    cursor,
    scope,
    keyColumns: SETTING_KEY_COLUMNS,
    limit: MAX_SETTINGS_PER_READ,
  });
  const rows = await env.DB.prepare(`
    select scope_key, setting_key, value_json, updated_at, changed_at, writer_device_id, deleted
    from account_settings
    where ${query.where}
    order by ${query.orderBy}
    limit ?
  `).bind(...query.bindings).all<{
    scope_key: string;
    setting_key: string;
    value_json: string;
    updated_at: string;
    changed_at: string | null;
    writer_device_id: string | null;
    deleted: number;
  }>();

  const paged = accountPageResult(rows.results, {
    limit: MAX_SETTINGS_PER_READ,
    keyColumns: SETTING_KEY_COLUMNS,
    cursor,
  });
  return json({
    ok: true,
    settings: paged.page.map(rowToSetting),
    truncated: paged.truncated,
    cursor: paged.cursor,
  });
}

async function handleWrite(
  request: Request,
  env: AttentionRelayEnv,
  userId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(body) || !Array.isArray(body.settings)) {
    return json({ ok: false, error: "settings array required" }, { status: 400 });
  }
  if (body.settings.length > MAX_SETTINGS_PER_WRITE) {
    return json(
      { ok: false, error: "too many settings in one write" },
      { status: 413 },
    );
  }
  const writerDeviceId = requiredString(body.deviceId, 128);

  const parsed: ParsedWrite[] = [];
  for (const item of body.settings) {
    const write = parseWriteItem(item);
    // One bad item fails the whole batch. A partial success is the worst
    // outcome here: the caller believes its settings landed, and the one that
    // silently did not is the one it will never look at again.
    if (!write) return json({ ok: false, error: "invalid setting" }, { status: 400 });
    parsed.push(write);
  }
  if (!parsed.length) return json({ ok: true, written: 0, updatedAt: null });

  if (await countAndGuard({
    env,
    table: "account_settings",
    userId,
    adding: parsed.length,
    ceiling: MAX_SETTINGS_PER_ACCOUNT + MAX_SETTINGS_PER_WRITE,
    extraWhere: " and deleted = 0",
  })) {
    return json(
      { ok: false, error: "account settings limit reached" },
      { status: 507 },
    );
  }

  // Stamped here, never by the caller. Machine clocks disagree, and ADE has
  // already had one sync bug caused by trusting a peer's clock for ordering.
  // Last-writer-wins therefore means "last to reach the server", which is
  // well-defined and cannot be moved by a machine with a wrong date.
  const updatedAt = new Date().toISOString();
  await env.DB.batch(parsed.map((write) => env.DB.prepare(`
    insert into account_settings(
      user_id, scope_key, setting_key, value_json, updated_at, changed_at, writer_device_id, deleted
    )
    values (?, ?, ?, ?, ?, ?, ?, 0)
    on conflict(user_id, scope_key, setting_key) do update set
      value_json = excluded.value_json,
      updated_at = excluded.updated_at,
      changed_at = excluded.changed_at,
      writer_device_id = excluded.writer_device_id,
      deleted = 0
  `).bind(
    userId,
    write.scope,
    write.key,
    write.valueJson,
    updatedAt,
    write.changedAt,
    writerDeviceId,
  )));

  return json({ ok: true, written: parsed.length, updatedAt });
}

/**
 * The way out. A setting you can set and never unset is a one-way door, and the
 * reset controls on every preference page need this to mean something.
 */
async function handleDelete(
  env: AttentionRelayEnv,
  userId: string,
  scopeRaw: string,
  keyRaw: string,
): Promise<Response> {
  const scope = parseAccountScopeKey(scopeRaw);
  const key = parseSettingKey(keyRaw);
  if (!scope || !key) {
    return json({ ok: false, error: "invalid setting" }, { status: 400 });
  }
  const updatedAt = new Date().toISOString();
  const result = await env.DB.prepare(`
    update account_settings
    set deleted = 1, value_json = 'null', updated_at = ?, writer_device_id = null
    where user_id = ? and scope_key = ? and setting_key = ? and deleted = 0
  `).bind(updatedAt, userId, scope, key).run();
  // Idempotent on purpose: a retry after a dropped response must not be an
  // error, or a flaky network turns a reset into a stuck one. The row stays as
  // a tombstone so a `since` pull can tell other machines to drop the key.
  return json({ ok: true, deleted: (result.meta?.changes ?? 0) > 0 });
}

/**
 * Routes under `/attention/account/settings`. Returns `null` when the path is
 * not ours, so the caller can keep matching.
 *
 * The caller has already authenticated: `userId` is the verified account, and
 * every statement here is scoped to it. There is no route that names another
 * account, so one cannot be reached by guessing a path.
 */
export async function handleAccountSettingsRoute(
  request: Request,
  env: AttentionRelayEnv,
  url: URL,
  userId: string,
  route: string[],
): Promise<Response | null> {
  if (route[0] !== "settings") return null;

  if (route.length === 1 && request.method === "GET") {
    return await handleRead(env, userId, url);
  }
  if (route.length === 1 && request.method === "PUT") {
    return await handleWrite(request, env, userId);
  }
  if (route.length === 3 && request.method === "DELETE") {
    return await handleDelete(
      env,
      userId,
      decodeURIComponent(route[1] ?? ""),
      decodeURIComponent(route[2] ?? ""),
    );
  }
  return null;
}
