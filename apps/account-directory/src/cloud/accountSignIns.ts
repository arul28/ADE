import {
  CLAUDE_PASS_VAULT_KIND,
  CLOUD_SIGN_INS,
  CLOUD_SIGN_IN_KEY_KIND,
  CLOUD_SIGN_IN_VAULT_SCOPE,
  LEGACY_CLAUDE_SIGN_IN_KEY,
  claudePassPayload,
  cleanCloudCloudKey,
  cloudSignInVaultKey,
  encodeCloudSignIn,
  isPastedClaudeToken,
  parseCloudSignIn,
  type CloudSignInId,
} from "../../../desktop/src/shared/cloudSignIns";
import { CLAUDE_PASS_KEY_PREFIX } from "../../../desktop/src/shared/types/providerLogins";
import { randomHex } from "../githubApp/seal";
import type { CloudAccountSignIn, CloudAccountSignInId, CloudAccountSignIns } from "./contract";
import { relayFetch, type RelayEnv } from "./accountVault";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson } from "./http";
import { logCloud } from "./store";

/**
 * The account's ADE Cloud sign-ins, for the web (`/cloud/sign-ins`). The web
 * can't reach the push relay's vault (no CORS there), so this route carries
 * its reads and writes, with the caller's own bearer: the relay takes the
 * account from the token, so a caller only ever reaches its own vault.
 *
 * The items are the ones the desktop's Settings card and every cloud
 * computer's brain already use, in the stored form all three share
 * (desktop `shared/cloudSignIns.ts`): scope `all`, kind `integration`, key
 * `cloud-key-<id>` for a pasted key; kind `provider_login`, key
 * `claude-pass/<12 hex>` for a Claude pass. A value passes through memory
 * only: never stored here, never logged, never sent back. Answers carry
 * status only.
 */

// The two lists are one: a sign-in the desktop adds must be added here too.
type SameIds = [CloudSignInId] extends [CloudAccountSignInId] ? ([CloudAccountSignInId] extends [CloudSignInId] ? true : never) : never;
const SAME_IDS: SameIds = true;
void SAME_IDS;

const SCOPE = CLOUD_SIGN_IN_VAULT_SCOPE;
const KEY_KIND = CLOUD_SIGN_IN_KEY_KIND;
const PASS_KIND = CLAUDE_PASS_VAULT_KIND;
/** The writer the relay records for these writes. */
const WRITER = "ade-directory-web";
/** The relay's pages include deleted rows, so a long-lived vault takes several; past this many the read counts as failed. */
const VAULT_PAGES = 25;
const RELAY_TIMEOUT_MS = 8_000;

const unavailable = () => fail("unavailable", "ADE can't reach your account's sign-ins right now. Try again soon.", 503);

type VaultItem = { kind?: unknown; key?: unknown; value?: unknown; deleted?: unknown };

/** Every live item of the account-wide vault, or null when the vault didn't answer (or had more pages than `VAULT_PAGES`). */
async function readItems(env: RelayEnv, authorization: string): Promise<VaultItem[] | null> {
  const relay = relayFetch(env);
  if (!relay) return null;
  const items: VaultItem[] = [];
  let since: string | null = null;
  try {
    for (let page = 0; ; page += 1) {
      // Still more after the cap: a partial list would read as complete (a delete would miss passes).
      if (page >= VAULT_PAGES) {
        logCloud("cloud.sign_ins_read_too_long", { pages: page });
        return null;
      }
      const url = `${relay.base}/attention/account/vault?scope=${SCOPE}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
      const response = await relay.fetch(url, {
        headers: { accept: "application/json", authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        logCloud("cloud.sign_ins_read_refused", { status: response.status });
        return null;
      }
      const body = await response.json() as { items?: VaultItem[]; truncated?: unknown; cursor?: unknown };
      for (const item of body.items ?? []) if (item.deleted !== true) items.push(item);
      if (body.truncated !== true || typeof body.cursor !== "string") break;
      since = body.cursor;
    }
  } catch (error) {
    logCloud("cloud.sign_ins_read_failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
  return items;
}

async function statusOf(env: RelayEnv, authorization: string): Promise<CloudAccountSignIns> {
  const items = await readItems(env, authorization);
  const found = new Map<string, number | null>();
  let claudePasses = 0;
  let claudeAt: number | null = null;
  for (const item of items ?? []) {
    if (item.kind === PASS_KIND && typeof item.key === "string" && item.key.startsWith(CLAUDE_PASS_KEY_PREFIX)) {
      const stored = parseCloudSignIn(item.value, isPastedClaudeToken);
      if (!stored) continue;
      claudePasses += 1;
      if (stored.savedAt != null) claudeAt = Math.max(claudeAt ?? 0, stored.savedAt);
      continue;
    }
    if (item.kind !== KEY_KIND || typeof item.key !== "string") continue;
    const stored = parseCloudSignIn(item.value, (token) => token.trim().length > 0);
    if (stored) found.set(item.key, stored.savedAt);
  }
  const signIns: CloudAccountSignIn[] = CLOUD_SIGN_INS.map((spec) => {
    const id: CloudAccountSignInId = spec.id;
    const claude = id === "claude";
    const keyOf = cloudSignInVaultKey(id);
    // Claude's own key is the single item of older versions; a pass is its own kind.
    const saved = claude ? claudePasses > 0 || found.has(LEGACY_CLAUDE_SIGN_IN_KEY) : found.has(keyOf);
    return {
      id,
      label: spec.label,
      providers: [...spec.providers],
      method: spec.method,
      keyName: spec.keyName,
      keyUrl: spec.keyUrl,
      saved,
      savedAt: saved ? (claude ? claudeAt ?? found.get(LEGACY_CLAUDE_SIGN_IN_KEY) ?? null : found.get(keyOf) ?? null) : null,
    };
  });
  return { signIns, claudePasses, unknown: items === null };
}

/** One write of one item through the relay. True when it landed. */
async function writeItem(env: RelayEnv, authorization: string, item: { kind: string; key: string; value: string }): Promise<boolean> {
  const relay = relayFetch(env);
  if (!relay) return false;
  const at = new Date().toISOString();
  try {
    const response = await relay.fetch(`${relay.base}/attention/account/vault`, {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json", authorization },
      body: JSON.stringify({ deviceId: WRITER, sentAt: at, items: [{ scope: SCOPE, ...item, writtenAt: at }] }),
      redirect: "manual",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) logCloud("cloud.sign_ins_write_refused", { status: response.status });
    return response.ok;
  } catch (error) {
    logCloud("cloud.sign_ins_write_failed", { error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

async function deleteItem(env: RelayEnv, authorization: string, kind: string, key: string): Promise<boolean> {
  const relay = relayFetch(env);
  if (!relay) return false;
  try {
    const response = await relay.fetch(
      `${relay.base}/attention/account/vault/${SCOPE}/${encodeURIComponent(kind)}/${encodeURIComponent(key)}?deviceId=${WRITER}`,
      { method: "DELETE", headers: { accept: "application/json", authorization }, redirect: "manual", signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) },
    );
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch (error) {
    logCloud("cloud.sign_ins_delete_failed", { error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

function signInIdOf(raw: string | undefined): CloudAccountSignInId | null {
  return CLOUD_SIGN_INS.find((spec) => spec.id === raw)?.id ?? null;
}

/** `/cloud/sign-ins[/:id]`. */
export async function routeAccountSignIns(request: Request, path: string, env: RelayEnv, now: number): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return fail("unauthorized", "Sign in to ADE to use ADE Cloud.", 401);
  if (!relayFetch(env)) return unavailable();
  const rest = path.split("/").slice(3);
  if (rest.length === 0) {
    return request.method === "GET" ? json(await statusOf(env, authorization)) : fail("not_found", "ADE Cloud has no such sign-in.", 404);
  }
  const id = rest.length === 1 ? signInIdOf(rest[0]) : null;
  if (!id) return fail("not_found", "ADE Cloud has no such sign-in.", 404);

  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body) return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
    const cleaned = cleanCloudCloudKey(body.key);
    if (!cleaned.ok) return fail("bad_request", cleaned.message, 400);
    let landed: boolean;
    if (id === "claude") {
      if (!isPastedClaudeToken(cleaned.key)) {
        return fail("bad_request", "That isn't a Claude pass. Run `claude setup-token` and paste the token it prints (sk-ant-oat…).", 400);
      }
      // The account it is for isn't known here: the pass is unchecked, made on no computer.
      const value = JSON.stringify(claudePassPayload({ token: cleaned.key, createdAt: now }));
      landed = await writeItem(env, authorization, { kind: PASS_KIND, key: `${CLAUDE_PASS_KEY_PREFIX}${randomHex(6)}`, value });
    } else {
      landed = await writeItem(env, authorization, { kind: KEY_KIND, key: cloudSignInVaultKey(id), value: encodeCloudSignIn(cleaned.key, now) });
    }
    if (!landed) return unavailable();
    logCloud("cloud.sign_in_saved", { id });
    return json(await statusOf(env, authorization));
  }

  if (request.method === "DELETE") {
    if (id === "claude") {
      // Every pass, and the single item of older versions: the Settings card's Remove.
      const items = await readItems(env, authorization);
      if (!items) return unavailable();
      const keys = items.flatMap((item) => (item.kind === PASS_KIND && typeof item.key === "string" && item.key.startsWith(CLAUDE_PASS_KEY_PREFIX) ? [item.key] : []));
      for (const key of keys) if (!await deleteItem(env, authorization, PASS_KIND, key)) return unavailable();
      if (!await deleteItem(env, authorization, KEY_KIND, LEGACY_CLAUDE_SIGN_IN_KEY)) return unavailable();
    } else if (!await deleteItem(env, authorization, KEY_KIND, cloudSignInVaultKey(id))) {
      return unavailable();
    }
    logCloud("cloud.sign_in_removed", { id });
    return json(await statusOf(env, authorization));
  }
  return fail("not_found", "ADE Cloud has no such sign-in.", 404);
}
