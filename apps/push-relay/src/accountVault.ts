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
 * What is deliberately NOT here: vendor CLI logins for Claude, Codex, and
 * Cursor. Those rotate their refresh tokens and their issuers rate-limit
 * refresh storms — ADE already carries a 24-hour rejection cooldown because of
 * it. The small set of account credentials that ARE safe to share has an
 * explicit owner in the item-kind allowlist below.
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

const MAX_ITEMS_PER_ACCOUNT = 2_000;
const MAX_ITEMS_PER_WRITE = 100;
const MAX_ITEMS_PER_READ = 500;

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
};

type ParsedVaultWrite = {
  scope: string;
  kind: string;
  key: string;
  value: string;
  refreshOwner: string | null;
};

function parseItemKey(value: unknown): string | null {
  const key = requiredString(value, MAX_ITEM_KEY_LENGTH);
  if (!key) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key) ? key : null;
}

function parseWriteItem(value: unknown): ParsedVaultWrite | null {
  if (!isRecord(value)) return null;
  const scope = parseAccountScopeKey(value.scope);
  const key = parseItemKey(value.key);
  const kind = requiredString(value.kind, 32);
  if (!scope || !key || !kind || !ITEM_KINDS.has(kind)) return null;
  const plaintext = typeof value.value === "string" ? value.value : "";
  if (!plaintext || plaintext.length > MAX_VALUE_CHARS) return null;
  // One field carries the credential. A caller offering pre-sealed bytes is
  // assuming an encryption model this Worker does not implement, and accepting
  // it would store something no reader here can ever open.
  if ("ciphertext" in value) return null;
  const refreshOwner = requiredString(value.refreshOwner, 128);
  return { scope, kind, key, value: plaintext, refreshOwner };
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
    select scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner
    from account_vault_items
    where ${query.where}
    order by ${query.orderBy}
    limit ?
  `).bind(...query.bindings).all<{
    scope_key: string;
    item_kind: string;
    item_key: string;
    ciphertext: string;
    updated_at: string;
    writer_device_id: string | null;
    refresh_owner: string | null;
  }>();

  const paged = accountPageResult(rows.results, {
    limit: MAX_ITEMS_PER_READ,
    keyColumns: VAULT_KEY_COLUMNS,
    cursor,
  });
  const items: AccountVaultRow[] = [];
  for (const row of paged.page) {
    items.push({
      scope: row.scope_key,
      kind: row.item_kind,
      key: row.item_key,
      value: await openValue(key, row.ciphertext),
      updatedAt: row.updated_at,
      writerDeviceId: row.writer_device_id,
      refreshOwner: row.refresh_owner,
    });
  }
  return json({
    ok: true,
    items,
    truncated: paged.truncated,
    cursor: paged.cursor,
  });
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

  const parsed: ParsedVaultWrite[] = [];
  for (const item of body.items) {
    const write = parseWriteItem(item);
    // All or nothing, same reasoning as settings: a caller that believes its
    // credential landed, when one silently did not, has a machine that will
    // fail later for no visible reason.
    if (!write) return json({ ok: false, error: "invalid item" }, { status: 400 });
    parsed.push(write);
  }
  if (!parsed.length) return json({ ok: true, written: 0, updatedAt: null });

  if (await countAndGuard({
    env,
    table: "account_vault_items",
    userId,
    adding: parsed.length,
    ceiling: MAX_ITEMS_PER_ACCOUNT + MAX_ITEMS_PER_WRITE,
  })) {
    return json({ ok: false, error: "account vault limit reached" }, { status: 507 });
  }

  const updatedAt = new Date().toISOString();
  // Indexed by position, not by a recomputed composite key: the batch below
  // walks the same array in the same order, so position is already the join.
  const sealed = await Promise.all(parsed.map((write) => sealValue(key, write.value)));
  await env.DB.batch(parsed.map((write, index) => env.DB.prepare(`
    insert into account_vault_items(
      user_id, scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(user_id, scope_key, item_kind, item_key) do update set
      ciphertext = excluded.ciphertext,
      updated_at = excluded.updated_at,
      writer_device_id = excluded.writer_device_id,
      refresh_owner = excluded.refresh_owner
  `).bind(
    userId,
    write.scope,
    write.kind,
    write.key,
    sealed[index]!,
    updatedAt,
    writerDeviceId,
    write.refreshOwner,
  )));

  return json({ ok: true, written: parsed.length, updatedAt });
}

/**
 * Revoking a credential has to be possible from anywhere, including a machine
 * the user no longer has. A vault you can only add to is not a vault.
 */
async function handleDelete(
  env: VaultEnv,
  userId: string,
  scopeRaw: string,
  kindRaw: string,
  keyRaw: string,
): Promise<Response> {
  const scope = parseAccountScopeKey(scopeRaw);
  const key = parseItemKey(keyRaw);
  const kind = requiredString(kindRaw, 32);
  if (!scope || !key || !kind || !ITEM_KINDS.has(kind)) {
    return json({ ok: false, error: "invalid item" }, { status: 400 });
  }
  const result = await env.DB.prepare(`
    delete from account_vault_items
    where user_id = ? and scope_key = ? and item_kind = ? and item_key = ?
  `).bind(userId, scope, kind, key).run();
  return json({ ok: true, deleted: (result.meta?.changes ?? 0) > 0 });
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
  if (route.length === 4 && request.method === "DELETE") {
    return await handleDelete(
      env,
      userId,
      decodeURIComponent(route[1] ?? ""),
      decodeURIComponent(route[2] ?? ""),
      decodeURIComponent(route[3] ?? ""),
    );
  }
  return null;
}

export const accountVaultTestInternals = Object.freeze({
  ITEM_KINDS,
  MAX_VALUE_CHARS,
  MAX_ITEMS_PER_ACCOUNT,
  MAX_ITEMS_PER_READ,
  MAX_ITEMS_PER_WRITE,
  parseWriteItem,
});
