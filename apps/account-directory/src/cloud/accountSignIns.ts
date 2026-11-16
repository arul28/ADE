import { CLOUD_SIGN_INS, type CloudSignInId } from "../../../desktop/src/shared/cloudSignIns";
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
 * computer's brain already use (desktop `cloudSignInStore.ts`,
 * `claudePassStore.ts`): scope `all`, kind `integration`, key
 * `cloud-key-<id>` for a pasted key; kind `provider_login`, key
 * `claude-pass/<12 hex>` for a Claude pass. A value passes through memory
 * only: never stored here, never logged, never sent back. Answers carry
 * status only.
 */

// The two lists are one: a sign-in the desktop adds must be added here too.
type SameIds = [CloudSignInId] extends [CloudAccountSignInId] ? ([CloudAccountSignInId] extends [CloudSignInId] ? true : never) : never;
const SAME_IDS: SameIds = true;
void SAME_IDS;

const SCOPE = "all";
const KEY_KIND = "integration";
const PASS_KIND = "provider_login";
const PASS_PREFIX = "claude-pass/";
/** The single Claude item of older versions; still read as "saved". */
const LEGACY_CLAUDE_KEY = "cloud-claude-token";
/** Claude Code's subscription token (`CLAUDE_TOKEN_PATTERN` in the desktop). */
const CLAUDE_TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/;
/** A pass lasts about a year; the desktop's estimate (`CLAUDE_PASS_LIFETIME_MS`). */
const PASS_LIFETIME_MS = 365 * 24 * 60 * 60_000;
/** The writer the relay records for these writes. */
const WRITER = "ade-directory-web";
const VAULT_PAGES = 4;
const RELAY_TIMEOUT_MS = 8_000;

const keyOf = (id: CloudAccountSignInId): string => `cloud-key-${id}`;

const unavailable = () => fail("unavailable", "ADE can't reach your account's sign-ins right now. Try again soon.", 503);

type VaultItem = { kind?: unknown; key?: unknown; value?: unknown; deleted?: unknown };

/** Every live item of the account-wide vault, or null when the vault didn't answer. */
async function readItems(env: RelayEnv, authorization: string): Promise<VaultItem[] | null> {
  const relay = relayFetch(env);
  if (!relay) return null;
  const items: VaultItem[] = [];
  let since: string | null = null;
  try {
    for (let page = 0; page < VAULT_PAGES; page += 1) {
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

/** `savedAt` of a stored value, or null; never the value. False when it isn't a usable sign-in. */
function savedAtOf(raw: unknown, check: (token: string) => boolean): number | null | false {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (parsed?.v !== 1 || typeof parsed.token !== "string" || !check(parsed.token)) return false;
    const at = parsed.savedAt ?? parsed.renewedAt ?? parsed.createdAt;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return false;
  }
}

async function statusOf(env: RelayEnv, authorization: string): Promise<CloudAccountSignIns> {
  const items = await readItems(env, authorization);
  const found = new Map<string, number | null>();
  let claudePasses = 0;
  let claudeAt: number | null = null;
  for (const item of items ?? []) {
    if (item.kind === PASS_KIND && typeof item.key === "string" && item.key.startsWith(PASS_PREFIX)) {
      const at = savedAtOf(item.value, (token) => CLAUDE_TOKEN.test(token));
      if (at === false) continue;
      claudePasses += 1;
      if (at != null) claudeAt = Math.max(claudeAt ?? 0, at);
      continue;
    }
    if (item.kind !== KEY_KIND || typeof item.key !== "string") continue;
    const at = savedAtOf(item.value, (token) => token.trim().length > 0);
    if (at !== false) found.set(item.key, at);
  }
  const signIns: CloudAccountSignIn[] = CLOUD_SIGN_INS.map((spec) => {
    const id = spec.id as CloudAccountSignInId;
    const claude = id === "claude";
    const saved = claude ? claudePasses > 0 || found.has(LEGACY_CLAUDE_KEY) : found.has(keyOf(id));
    return {
      id,
      label: spec.label,
      providers: [...spec.providers],
      method: spec.method,
      keyName: spec.keyName,
      keyUrl: spec.keyUrl,
      saved,
      savedAt: saved ? (claude ? claudeAt ?? found.get(LEGACY_CLAUDE_KEY) ?? null : found.get(keyOf(id)) ?? null) : null,
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

/** A pasted key, trimmed, or why it can't be one (the desktop's `cleanCloudCloudKey`). */
function cleanKey(raw: unknown): { ok: true; key: string } | { ok: false; message: string } {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { ok: false, message: "Paste the key first." };
  if (/\s/.test(key)) return { ok: false, message: "That has spaces in it. Paste only the key." };
  if (key.length < 8 || key.length > 4096) return { ok: false, message: "That doesn't look like a key. Paste only the key." };
  return { ok: true, key };
}

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A Claude pass as the desktop and the brain read it (`ClaudePassPayload`). The account it is for isn't known here. */
function claudePassValue(token: string, now: number): string {
  return JSON.stringify({
    v: 1,
    kind: "claude_pass",
    token,
    account: { email: null, check: "unchecked", labelSource: "none" },
    createdAt: now,
    renewedAt: null,
    madeOn: null,
    expiresAt: now + PASS_LIFETIME_MS,
    expiresAtSource: "estimate",
  });
}

function signInIdOf(raw: string | undefined): CloudAccountSignInId | null {
  return CLOUD_SIGN_INS.find((spec) => spec.id === raw)?.id as CloudAccountSignInId | undefined ?? null;
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
    const cleaned = cleanKey(body.key);
    if (!cleaned.ok) return fail("bad_request", cleaned.message, 400);
    let landed: boolean;
    if (id === "claude") {
      if (!CLAUDE_TOKEN.test(cleaned.key)) {
        return fail("bad_request", "That isn't a Claude pass. Run `claude setup-token` and paste the token it prints (sk-ant-oat…).", 400);
      }
      landed = await writeItem(env, authorization, { kind: PASS_KIND, key: `${PASS_PREFIX}${randomHex(6)}`, value: claudePassValue(cleaned.key, now) });
    } else {
      landed = await writeItem(env, authorization, { kind: KEY_KIND, key: keyOf(id), value: JSON.stringify({ v: 1, token: cleaned.key, savedAt: now }) });
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
      const keys = items.filter((item) => item.kind === PASS_KIND && typeof item.key === "string" && item.key.startsWith(PASS_PREFIX)).map((item) => item.key as string);
      for (const key of keys) if (!await deleteItem(env, authorization, PASS_KIND, key)) return unavailable();
      if (!await deleteItem(env, authorization, KEY_KIND, LEGACY_CLAUDE_KEY)) return unavailable();
    } else if (!await deleteItem(env, authorization, KEY_KIND, keyOf(id))) {
      return unavailable();
    }
    logCloud("cloud.sign_in_removed", { id });
    return json(await statusOf(env, authorization));
  }
  return fail("not_found", "ADE Cloud has no such sign-in.", 404);
}
