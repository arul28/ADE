/**
 * The vault: the half of "sign in once and your setup follows you" that IS a
 * secret.
 *
 * **This is platform encryption, not end-to-end.** Values arrive over TLS and
 * are sealed here with a key this Worker holds, so they are ciphertext at rest
 * in D1 and a database dump alone reveals nothing. An operator who can read the
 * Worker's secret can read the values. That is a real limit and it is stated
 * rather than implied.
 *
 * It is also the only honest option today. End-to-end needs a key the user's
 * machines share and this Worker never sees, and ADE has nothing to derive one
 * from: sign-in is Clerk OAuth, so there is no password, and a device-held key
 * cannot open what a brand-new machine needs to read on first sign-in. Adding a
 * user passphrase is a deliberate later opt-in, and the item shape here already
 * leaves room for it.
 *
 * Kept apart from `accountSettings.ts` even though they share a transport and an
 * account. A settings row is readable JSON any surface may render; a vault row
 * must never appear in a list, a log line, or a diagnostic. One table would put
 * both one query and one permission away from each other.
 *
 * Provider sign-ins (`provider_login`) are opaque here like every other value.
 * Some of them rotate their refresh tokens, and two machines that spend one
 * refresh token sign each other out, so this Worker never refreshes one and the
 * renewal owner is chosen by the clients, not here: the stale-write check below
 * keeps an old copy from replacing a newer one, and `refresh_owner` is stored
 * and returned for the clients to read, never enforced. Each kind has an
 * explicit owner in the item-kind allowlist below.
 *
 * A row's `updated_at` is also its revision. Every change moves it forward, so
 * a revision never comes back, and a write or delete can name the revision it
 * replaces (`ifRevision`). The Worker refuses it as `stale`, with the stored
 * row, when the row changed since then. That is what keeps a machine that
 * decided on an old copy from writing over a newer one, a removal included.
 */
import {
  accountPageResult,
  accountRefusalResult,
  accountWriteResults,
  buildAccountPageQuery,
  countAndGuard,
  decodePathSegment,
  isRecord,
  json,
  parseAccountScopeKey,
  parseSinceParam,
  requiredString,
  staleWriteThreshold,
  writeClock,
  type AccountItemVerdict,
  type AttentionRelayEnv,
} from "./attentionShared";

/**
 * The key this Worker seals vault values with. Required: a vault that silently
 * stored plaintext because a secret was missing would be worse than one that
 * refuses to work, because nobody would find out until it mattered.
 */
type VaultEnv = AttentionRelayEnv & { VAULT_ENCRYPTION_KEY?: string };

const VAULT_AAD = new TextEncoder().encode("ade.account.vault.v1");

async function vaultKey(env: VaultEnv): Promise<CryptoKey | null> {
  const raw = env.VAULT_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  // A 32-byte key, base64. Hashing whatever is configured would accept a weak
  // secret silently; requiring the right shape makes a misconfiguration loud.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** `v1.<iv>.<ciphertext+tag>`, both base64. */
async function sealValue(key: CryptoKey, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: VAULT_AAD },
    key,
    new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>,
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

async function openValue(key: CryptoKey, stored: string): Promise<string | null> {
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]!), additionalData: VAULT_AAD },
      key,
      fromBase64(parts[2]!),
    );
    return new TextDecoder().decode(opened);
  } catch {
    // A row this key cannot open is reported as unreadable rather than dropped:
    // a rotated key must look like "ADE cannot read this", never like "you
    // never saved it", or a client would helpfully overwrite it.
    return null;
  }
}

function vaultUnavailable(): Response {
  return json(
    {
      ok: false,
      error: "vault encryption is not configured",
      code: "vault_unavailable",
      recovery: "The ADE service owner must set VAULT_ENCRYPTION_KEY on the push relay.",
    },
    { status: 503 },
  );
}

/**
 * Value ceiling. An OAuth credential envelope is a few hundred bytes; this is
 * generous for a long API key and small enough that no item can crowd out an
 * account. Sealing adds a fixed overhead, so the stored column is bounded too.
 */
const MAX_VALUE_CHARS = 6_000;

/**
 * Kinds that need more room than `MAX_VALUE_CHARS`. A provider sign-in is a
 * whole login file (or a few), not one token: the largest measured one is
 * about 4 KB before the client wraps it. Sealed, the largest value is at most
 * about 4 × 16,000 + 44 characters (UTF-8 then base64), so one row stays far
 * under D1's limits and one item fits a single request under the 256 KiB body
 * limit.
 */
const MAX_VALUE_CHARS_BY_KIND: ReadonlyMap<string, number> = new Map([["provider_login", 16_000]]);

const MAX_ITEMS_PER_ACCOUNT = 2_000;
const MAX_ITEMS_PER_WRITE = 100;
export const MAX_ITEMS_PER_READ = 500;

const MAX_ITEM_KEY_LENGTH = 200;

/** The tiebreak columns after `updated_at`: the rest of the primary key. */
const VAULT_KEY_COLUMNS = ["scope_key", "item_kind", "item_key"];

/**
 * The shapes a vault item can take. Closed on purpose: an unknown kind would be
 * a credential ADE does not know how to refresh, revoke, or show, and accepting
 * one now is how a store grows a category nobody owns.
 */
const ITEM_KINDS = new Set([
  "secret",
  "provider_key",
  "integration",
  "provider_api_key",
  "linear_refresh_token",
  "project_secret",
  // ADE MCP's account secret and its connections (token hashes, never tokens).
  "ade_mcp",
  // A provider sign-in: the login a provider's CLI keeps on disk, carried to
  // the account's other computers and ADE Cloud. The brain's sign-in sync owns
  // the payload and the renewal rules.
  "provider_login",
]);

export type AccountVaultRow = {
  scope: string;
  kind: string;
  key: string;
  /**
   * The plaintext credential, opened with this Worker's key.
   *
   * Null means the stored bytes could not be opened — a rotated or wrong key.
   * That is reported rather than hidden, because a caller that saw the item
   * simply missing would helpfully overwrite a credential that is still good.
   */
  value: string | null;
  updatedAt: string;
  writerDeviceId: string | null;
  refreshOwner: string | null;
  deleted?: boolean;
};

type ParsedVaultWrite = {
  scope: string;
  kind: string;
  key: string;
  value: string;
  refreshOwner: string | null;
  /** Client clock; see `staleWriteThreshold`. */
  writtenAt: unknown;
  /** The revision this write replaces, `VAULT_REVISION_ABSENT`, or null for a write that names none. */
  ifRevision: string | null;
};

/**
 * `ifRevision` for "the client read no row at all". A tombstone is a row: it
 * has a revision, and a client that read one names that.
 */
export const VAULT_REVISION_ABSENT = "absent";

/**
 * A client's `ifRevision`: null when it named none (the write before revisions
 * existed), undefined when what it named is not a revision. A revision is an
 * `updated_at` this Worker returned, so anything that does not parse as a time
 * can never match one and is refused instead of quietly failing every time.
 */
function parseIfRevision(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (value === VAULT_REVISION_ABSENT) return VAULT_REVISION_ABSENT;
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

/**
 * The next `updated_at` of a row that changes: the Worker clock, or one
 * millisecond past the stored stamp when that is not earlier. Two writes in one
 * millisecond (or on two Worker clocks a little apart) would otherwise leave
 * the same stamp, and a client holding that revision would replace the second
 * write without having seen it. Binds the new stamp twice.
 */
const NEXT_UPDATED_AT =
  "max(?, coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', account_vault_items.updated_at, '+0.001 seconds'), ?))";

/**
 * Item keys: one or more `/`-separated segments. The first is the original
 * vocabulary (`anthropic`, `ADE_API_KEY`, `repo-scoped:name`); later ones carry
 * the MCP server registry's `mcp/<server>/<env|header|oauth>/<name>`. No
 * segment is empty or starts with a dot, so a key never holds `..`, `//`, or a
 * leading or trailing `/`, and nothing reading one as a path can be walked out
 * of it.
 */
const ITEM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._:-]*)*$/;

function parseItemKey(value: unknown): string | null {
  const key = requiredString(value, MAX_ITEM_KEY_LENGTH);
  if (!key) return null;
  return ITEM_KEY_PATTERN.test(key) ? key : null;
}

type ItemVerdict = AccountItemVerdict<ParsedVaultWrite>;

function checkWriteItem(value: unknown): ItemVerdict {
  if (!isRecord(value)) return { ok: false, reason: "invalid item" };
  // One field carries the credential. A caller offering pre-sealed bytes is
  // assuming an encryption model this Worker does not implement, and accepting
  // it would store something no reader here can ever open.
  if ("ciphertext" in value) return { ok: false, reason: "invalid item" };
  const scope = parseAccountScopeKey(value.scope);
  if (!scope) return { ok: false, reason: "invalid scope" };
  const kind = requiredString(value.kind, 32);
  if (!kind || !ITEM_KINDS.has(kind)) return { ok: false, reason: "unknown kind" };
  const key = parseItemKey(value.key);
  if (!key) return { ok: false, reason: "invalid key" };
  const plaintext = typeof value.value === "string" ? value.value : "";
  if (!plaintext) return { ok: false, reason: "empty value" };
  if (plaintext.length > (MAX_VALUE_CHARS_BY_KIND.get(kind) ?? MAX_VALUE_CHARS)) {
    return { ok: false, reason: "value too large" };
  }
  const refreshOwner = requiredString(value.refreshOwner, 128);
  const ifRevision = parseIfRevision(value.ifRevision);
  if (ifRevision === undefined) return { ok: false, reason: "invalid revision" };
  return {
    ok: true,
    write: { scope, kind, key, value: plaintext, refreshOwner, writtenAt: value.writtenAt, ifRevision },
  };
}

type VaultRowRecord = {
  scope_key: string;
  item_kind: string;
  item_key: string;
  ciphertext: string;
  updated_at: string;
  writer_device_id: string | null;
  refresh_owner: string | null;
  deleted: number;
};

const VAULT_ROW_COLUMNS =
  "scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner, deleted";

async function rowToVaultItem(key: CryptoKey, row: VaultRowRecord): Promise<AccountVaultRow> {
  if (row.deleted) {
    return {
      scope: row.scope_key,
      kind: row.item_kind,
      key: row.item_key,
      value: null,
      updatedAt: row.updated_at,
      writerDeviceId: row.writer_device_id,
      refreshOwner: row.refresh_owner,
      deleted: true,
    };
  }
  return {
    scope: row.scope_key,
    kind: row.item_kind,
    key: row.item_key,
    value: await openValue(key, row.ciphertext),
    updatedAt: row.updated_at,
    writerDeviceId: row.writer_device_id,
    refreshOwner: row.refresh_owner,
  };
}

async function readVaultRow(
  env: VaultEnv,
  userId: string,
  item: { scope: string; kind: string; key: string },
): Promise<VaultRowRecord | null> {
  return await env.DB.prepare(`
    select ${VAULT_ROW_COLUMNS}
    from account_vault_items
    where user_id = ? and scope_key = ? and item_kind = ? and item_key = ?
  `).bind(userId, item.scope, item.kind, item.key).first<VaultRowRecord>();
}

async function handleRead(
  env: VaultEnv,
  userId: string,
  url: URL,
): Promise<Response> {
  const key = await vaultKey(env);
  if (!key) return vaultUnavailable();
  const cursor = parseSinceParam(url);
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam?.trim() ? parseAccountScopeKey(scopeParam) : null;
  if (scopeParam != null && !scope) {
    return json({ ok: false, error: "invalid scope" }, { status: 400 });
  }

  const query = buildAccountPageQuery({
    userId,
    cursor,
    scope,
    keyColumns: VAULT_KEY_COLUMNS,
    limit: MAX_ITEMS_PER_READ,
  });
  const rows = await env.DB.prepare(`
    select ${VAULT_ROW_COLUMNS}
    from account_vault_items
    where ${query.where}
    order by ${query.orderBy}
    limit ?
  `).bind(...query.bindings).all<VaultRowRecord>();

  const paged = accountPageResult(rows.results, {
    limit: MAX_ITEMS_PER_READ,
    keyColumns: VAULT_KEY_COLUMNS,
    cursor,
  });
  const items: AccountVaultRow[] = [];
  for (const row of paged.page) items.push(await rowToVaultItem(key, row));
  return json({
    ok: true,
    items,
    truncated: paged.truncated,
    cursor: paged.cursor,
  });
}

/**
 * The statement for one write.
 *
 * - `ifRevision` names a revision: change the row only while it still has
 *   that revision. A row this same device wrote last also passes, because the
 *   newer revision is this device's own earlier write (still in flight when
 *   this one was made); another machine's write in between leaves another
 *   device as the last writer. No row at all is refused too: the client read
 *   one, so this is not the row it decided on.
 * - `ifRevision` is `absent`: insert only when there is no row, a tombstone
 *   included. There is no same-device pass here: a client that read no row
 *   may have an empty cache (just signed in), and the row it would replace can
 *   be this device's own older one, a removal included.
 * - No `ifRevision`: the write before revisions existed. The upsert's `where`
 *   refuses only a write made before the stored row (`writtenAt`, with
 *   `itemResults`). A row this same device wrote last is never "newer" than
 *   its own write: its earlier write may still have been in flight when this
 *   one was made. (No `deviceId`: SQL's `= null` is never true, so the full
 *   check holds.)
 */
function vaultWriteStatement(
  env: VaultEnv,
  userId: string,
  write: ParsedVaultWrite,
  sealedValue: string,
  updatedAt: string,
  writerDeviceId: string | null,
  itemResults: boolean,
  clock: ReturnType<typeof writeClock>,
): D1PreparedStatement {
  if (write.ifRevision === VAULT_REVISION_ABSENT) {
    return env.DB.prepare(`
      insert into account_vault_items(
        user_id, scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner, deleted
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, 0)
      on conflict(user_id, scope_key, item_kind, item_key) do nothing
    `).bind(userId, write.scope, write.kind, write.key, sealedValue, updatedAt, writerDeviceId, write.refreshOwner);
  }
  if (write.ifRevision !== null) {
    return env.DB.prepare(`
      update account_vault_items
      set ciphertext = ?, updated_at = ${NEXT_UPDATED_AT}, writer_device_id = ?, refresh_owner = ?, deleted = 0
      where user_id = ? and scope_key = ? and item_kind = ? and item_key = ?
        and (updated_at = ? or writer_device_id = ?)
    `).bind(
      sealedValue,
      updatedAt,
      updatedAt,
      writerDeviceId,
      write.refreshOwner,
      userId,
      write.scope,
      write.kind,
      write.key,
      write.ifRevision,
      writerDeviceId,
    );
  }
  return env.DB.prepare(`
    insert into account_vault_items(
      user_id, scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner, deleted
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, 0)
    on conflict(user_id, scope_key, item_kind, item_key) do update set
      ciphertext = excluded.ciphertext,
      updated_at = ${NEXT_UPDATED_AT},
      writer_device_id = excluded.writer_device_id,
      refresh_owner = excluded.refresh_owner,
      deleted = 0
    where account_vault_items.updated_at <= ? or account_vault_items.writer_device_id = ?
  `).bind(
    userId,
    write.scope,
    write.kind,
    write.key,
    sealedValue,
    updatedAt,
    writerDeviceId,
    write.refreshOwner,
    updatedAt,
    updatedAt,
    itemResults ? staleWriteThreshold(clock, write.writtenAt) : staleWriteThreshold(clock, null),
    writerDeviceId,
  );
}

async function handleWrite(
  request: Request,
  env: VaultEnv,
  userId: string,
): Promise<Response> {
  const key = await vaultKey(env);
  if (!key) return vaultUnavailable();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return json({ ok: false, error: "items array required" }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS_PER_WRITE) {
    return json({ ok: false, error: "too many items in one write" }, { status: 413 });
  }
  const writerDeviceId = requiredString(body.deviceId, 128);
  const clock = writeClock(body.sentAt);

  const verdicts = body.items.map(checkWriteItem);
  // Per-item answers are opt-in. A client that does not ask treats a 200 as
  // "every item landed", so it keeps the all-or-nothing answer: a partial
  // success it could not see would drop the refused items from its queue.
  // A write that names a revision can be refused on its own, so naming one
  // asks for them too.
  const itemResults = body.itemResults === true
    || verdicts.some((verdict) => verdict.ok && verdict.write.ifRevision !== null);
  const firstRefusal = verdicts.find((verdict) => !verdict.ok);
  if (firstRefusal && !itemResults) {
    // All or nothing, same reasoning as settings: a caller that believes its
    // credential landed, when one silently did not, has a machine that will
    // fail later for no visible reason. `index` and `reason` say which item, so
    // a client can set it aside instead of resending the batch forever.
    const index = verdicts.indexOf(firstRefusal);
    return json(
      { ok: false, error: "invalid item", index, reason: (firstRefusal as { reason: string }).reason },
      { status: 400 },
    );
  }
  const parsed = verdicts.flatMap((verdict) => (verdict.ok ? [verdict.write] : []));
  if (!parsed.length) {
    return json({
      ok: true,
      written: 0,
      updatedAt: null,
      ...(itemResults ? { results: verdicts.map(accountRefusalResult) } : {}),
    });
  }

  if (await countAndGuard({
    env,
    table: "account_vault_items",
    userId,
    adding: parsed.length,
    ceiling: MAX_ITEMS_PER_ACCOUNT + MAX_ITEMS_PER_WRITE,
    extraWhere: " and deleted = 0",
  })) {
    return json({ ok: false, error: "account vault limit reached" }, { status: 507 });
  }

  const updatedAt = new Date(clock.nowMs).toISOString();
  // Indexed by position, not by a recomputed composite key: the batch below
  // walks the same array in the same order, so position is already the join.
  const sealed = await Promise.all(parsed.map((write) => sealValue(key, write.value)));
  // Each check is its statement's own `where`: atomic per row, so a write
  // racing another machine's cannot slip between a read and a write.
  const outcomes = await env.DB.batch(parsed.map((write, index) =>
    vaultWriteStatement(env, userId, write, sealed[index]!, updatedAt, writerDeviceId, itemResults, clock)));

  if (!itemResults) return json({ ok: true, written: parsed.length, updatedAt });

  const { results, written } = await accountWriteResults(verdicts, outcomes, async (write): Promise<AccountVaultRow | null> => {
    const row = await readVaultRow(env, userId, write);
    return row ? await rowToVaultItem(key, row) : null;
  });
  return json({ ok: true, written, updatedAt: written > 0 ? updatedAt : null, results });
}

/**
 * Revoking a credential has to be possible from anywhere, including a machine
 * the user no longer has. A vault you can only add to is not a vault.
 *
 * With `?writtenAt=` (and `sentAt`), a delete made before the stored row was
 * last written is refused with `409 stale` and the stored row, the same rule as
 * a write: a machine back after days offline must not delete a value another
 * machine set since. A row the deleting device (`?deviceId=`) wrote last is
 * not refused: its own earlier write may have landed after this delete was made.
 *
 * With `?ifRevision=`, the rule is the write's (see `vaultWriteStatement`): the
 * delete goes only while the row still has that revision, or this device wrote
 * it last. `absent` deletes nothing; it answers `stale` when a live row exists.
 * A row that is already a tombstone is not refused: what the delete wanted is
 * already true.
 */
async function handleDelete(
  env: VaultEnv,
  userId: string,
  url: URL,
  scopeRaw: string | null,
  kindRaw: string | null,
  keyRaw: string | null,
): Promise<Response> {
  const scope = parseAccountScopeKey(scopeRaw);
  const key = parseItemKey(keyRaw);
  const kind = requiredString(kindRaw, 32);
  if (!scope || !key || !kind || !ITEM_KINDS.has(kind)) {
    return json({ ok: false, error: "invalid item" }, { status: 400 });
  }
  const ifRevision = parseIfRevision(url.searchParams.get("ifRevision"));
  if (ifRevision === undefined) return json({ ok: false, error: "invalid revision" }, { status: 400 });
  const clock = writeClock(url.searchParams.get("sentAt"));
  const threshold = staleWriteThreshold(clock, url.searchParams.get("writtenAt"));
  const deviceId = requiredString(url.searchParams.get("deviceId"), 128);
  const updatedAt = new Date(clock.nowMs).toISOString();
  let deleted = false;
  if (ifRevision !== VAULT_REVISION_ABSENT) {
    const result = await env.DB.prepare(`
      update account_vault_items
      set deleted = 1, ciphertext = '', updated_at = ${NEXT_UPDATED_AT}, writer_device_id = ?, refresh_owner = null
      where user_id = ? and scope_key = ? and item_kind = ? and item_key = ? and deleted = 0
        and (updated_at ${ifRevision === null ? "<=" : "="} ? or writer_device_id = ?)
    `).bind(
      updatedAt,
      updatedAt,
      deviceId,
      userId,
      scope,
      kind,
      key,
      ifRevision ?? threshold,
      deviceId,
    ).run();
    deleted = (result.meta?.changes ?? 0) > 0;
  }
  const checked = ifRevision !== null || url.searchParams.has("writtenAt");
  if (!deleted && checked) {
    const row = await readVaultRow(env, userId, { scope, kind, key });
    const newer = ifRevision !== null || (row !== null && row.updated_at > threshold);
    if (row && !row.deleted && newer) {
      const sealKey = await vaultKey(env);
      if (!sealKey) return vaultUnavailable();
      return json(
        { ok: false, error: "a newer value exists", code: "stale", current: await rowToVaultItem(sealKey, row) },
        { status: 409 },
      );
    }
  }
  return json({ ok: true, deleted });
}

/**
 * Routes under `/attention/account/vault`. Returns `null` when the path is not
 * ours.
 *
 * The caller has already authenticated; `userId` is the verified account and
 * every statement is scoped to it. No route names another account, so one
 * cannot be reached by guessing a path.
 */
export async function handleAccountVaultRoute(
  request: Request,
  env: VaultEnv,
  url: URL,
  userId: string,
  route: string[],
): Promise<Response | null> {
  if (route[0] !== "vault") return null;

  if (route.length === 1 && request.method === "GET") {
    return await handleRead(env, userId, url);
  }
  if (route.length === 1 && request.method === "PUT") {
    return await handleWrite(request, env, userId);
  }
  // `/vault/<scope>/<kind>/<key>`. A key with `/` in it arrives encoded
  // (`%2F`) and stays one segment; one a proxy decoded on the way arrives as
  // several, and joining them gives back the same key.
  if (route.length >= 4 && request.method === "DELETE") {
    const keySegments = route.slice(3).map(decodePathSegment);
    return await handleDelete(
      env,
      userId,
      url,
      decodePathSegment(route[1]),
      decodePathSegment(route[2]),
      keySegments.some((segment) => segment === null) ? null : keySegments.join("/"),
    );
  }
  return null;
}
