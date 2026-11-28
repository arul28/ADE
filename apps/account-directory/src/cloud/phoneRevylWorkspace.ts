/**
 * Revyl's workspaces for ADE accounts, and the calls made in them
 * (`phoneRevyl.ts` for phones, `phoneRevylBuild.ts` for builds).
 *
 * ADE's partner key (`REVYL_PARTNER_API_KEY`) lives only here. Each ADE
 * account gets its own Revyl workspace, made for ADE's key under an id
 * (`ade-<userId>`, never an email). The server mints a short session
 * credential for that workspace when it needs one and keeps it in memory only.
 */

import { fail } from "./http";
import { logCloud, reportCloudFailure, type CloudEnv } from "./store";

const REVYL_API_BASE = "https://backend.revyl.ai/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
/** A build's own calls (the source upload, an install of a large app) get longer. */
export const SLOW_REQUEST_TIMEOUT_MS = 120_000;
/** How long a minted session credential is asked for; it is dropped a few minutes early. */
const SESSION_TTL_SECONDS = 7_200;
const SESSION_MARGIN_MS = 5 * 60_000;
/** Revyl's Cloudflare refuses some default user agents. */
const USER_AGENT = "ade-account-directory/1 (+https://ade-app.dev)";

export type RevylAnswer = { status: number; body: Record<string, unknown> | null };

export const revylConfigured = (env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY">): boolean => Boolean(env.REVYL_PARTNER_API_KEY?.trim());

/** Revyl's id for an ADE account's workspace: 1 to 128 of `[A-Za-z0-9_-]`. */
function externalIdFor(userId: string): string | null {
  const id = `ade-${userId}`;
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function revylFetch(key: string, method: string, path: string, init: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
  const query = init.query && Object.keys(init.query).length ? `?${new URLSearchParams(init.query).toString()}` : "";
  return await fetch(`${REVYL_API_BASE}${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    redirect: "manual",
  });
}

async function answerOf(response: Response): Promise<RevylAnswer> {
  if (response.status >= 300 && response.status < 400) return { status: 502, body: null };
  const parsed = await response.json().catch(() => null) as unknown;
  return { status: response.status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
}

/** A timeout or a dropped connection: answered like a gateway timeout, and logged (the path, never a credential). */
function unreachable(method: string, path: string, error: unknown): RevylAnswer {
  logCloud("cloud.phone_revyl_unreachable", { method, path, message: error instanceof Error ? error.message : "unknown" });
  return { status: 504, body: null };
}

/** A call with ADE's partner key (workspaces and their credentials only). */
export async function partner(env: Pick<CloudEnv, "REVYL_PARTNER_API_KEY">, method: string, path: string, body?: unknown): Promise<RevylAnswer> {
  const key = env.REVYL_PARTNER_API_KEY?.trim();
  if (!key) return { status: 503, body: null };
  try {
    return await answerOf(await revylFetch(key, method, path, { body }));
  } catch (error) {
    return unreachable(method, path, error);
  }
}

/** Revyl's code and words: the partner API's `error` envelope, or the execution API's `detail`. */
export function revylErrorOf(answer: RevylAnswer): { code: string; message: string } {
  const error = answer.body?.error as { code?: unknown; message?: unknown } | undefined;
  const detail = answer.body?.detail;
  const code = typeof error?.code === "string" ? error.code : typeof answer.body?.code === "string" ? answer.body.code : `http_${answer.status}`;
  const message = typeof error?.message === "string" ? error.message
    : typeof detail === "string" ? detail
      : "The phone service did not answer.";
  return { code, message };
}

/* ---- The account's workspace ---- */

export type WorkspaceRow = { user_id: string; external_id: string; app_id: string | null };

/** Session credentials minted this isolate's life, by workspace: never stored. */
const sessionKeys = new Map<string, { secret: string; expiresAt: number }>();

/**
 * The account's Revyl workspace, made on its first phone. `auto` makes a new
 * workspace for an address no Revyl account has: the address is ADE's own
 * (`revyl+<hash>@ade-app.dev`), so the person's email never reaches Revyl.
 */
export async function workspaceOf(env: CloudEnv, userId: string, now: number): Promise<WorkspaceRow | Response> {
  const known = await env.DB.prepare("select user_id, external_id, app_id from cloud_phone_revyl where user_id = ?").bind(userId).first<WorkspaceRow>();
  if (known) return known;
  const externalId = externalIdFor(userId);
  if (!externalId) return fail("phone_unavailable", "The ADE Cloud iPhone can't be used with this account.", 400);
  const hash = (await sha256Hex(`ade-revyl:${userId}`)).slice(0, 16);
  const answer = await partner(env, "POST", "/partner/connections", {
    external_account_id: externalId,
    external_account_name: `ADE account ${hash.slice(0, 8)}`,
    organization_name: `ADE ${hash.slice(0, 8)}`,
    owner_email: `revyl+${hash}@ade-app.dev`,
    mode: "auto",
  });
  const code = revylErrorOf(answer).code;
  if (answer.status !== 201 && !(answer.status === 409 && code === "already_connected")) {
    reportCloudFailure(`cloud.phone_revyl_connect_failed.${code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)}`, { userId, status: answer.status, code }, "cloud-phone");
    return fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. ADE has been told.", 503);
  }
  // Kept only for an account that still exists: one deleted meanwhile has its connection taken back at once.
  const kept = await env.DB.prepare(`
    insert into cloud_phone_revyl (user_id, external_id, app_id, created_at, updated_at)
    select ?, ?, null, ?, ? where exists (select 1 from cloud_accounts where user_id = ? and deleted_at is null)
    on conflict(user_id) do nothing
  `).bind(userId, externalId, now, now, userId).run();
  if ((kept.meta?.changes ?? 0) === 0 && !(await env.DB.prepare("select 1 from cloud_phone_revyl where user_id = ?").bind(userId).first())) {
    const undone = await partner(env, "DELETE", `/partner/connections/${encodeURIComponent(externalId)}`);
    if (undone.status >= 400 && undone.status !== 404) reportCloudFailure("cloud.phone_revyl_orphan_disconnect_failed", { userId, status: undone.status, code: revylErrorOf(undone).code }, "cloud-phone");
    return fail("phone_unavailable", "The ADE Cloud iPhone can't be used with this account.", 400);
  }
  logCloud("cloud.phone_revyl_workspace", { userId, created: answer.status === 201 });
  return { user_id: userId, external_id: externalId, app_id: null };
}

/** A session credential for the workspace: from memory while it lasts, else minted. */
async function workspaceKey(env: CloudEnv, workspace: WorkspaceRow, fresh = false): Promise<string | null> {
  const cached = sessionKeys.get(workspace.external_id);
  if (!fresh && cached && cached.expiresAt - Date.now() > SESSION_MARGIN_MS) return cached.secret;
  sessionKeys.delete(workspace.external_id);
  const answer = await partner(env, "POST", `/partner/connections/${encodeURIComponent(workspace.external_id)}/session-credentials`, { ttl_seconds: SESSION_TTL_SECONDS });
  const credential = answer.body?.credential as { secret?: unknown; expires_at?: unknown } | undefined;
  if (answer.status !== 201 || typeof credential?.secret !== "string") {
    reportCloudFailure("cloud.phone_revyl_credential_failed", { userId: workspace.user_id, status: answer.status, code: revylErrorOf(answer).code }, "cloud-phone");
    return null;
  }
  const expiresAt = typeof credential.expires_at === "string" && Number.isFinite(Date.parse(credential.expires_at))
    ? Date.parse(credential.expires_at)
    : Date.now() + SESSION_TTL_SECONDS * 1000;
  sessionKeys.set(workspace.external_id, { secret: credential.secret, expiresAt });
  return credential.secret;
}

/** One call in the account's workspace; a credential Revyl stopped taking is minted again once. */
export async function workspaceCall(env: CloudEnv, workspace: WorkspaceRow, method: string, path: string, init: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
  let key = await workspaceKey(env, workspace);
  if (!key) return new Response(null, { status: 503 });
  let response = await revylFetch(key, method, path, init);
  if (response.status === 401) {
    key = await workspaceKey(env, workspace, true);
    if (!key) return new Response(null, { status: 503 });
    response = await revylFetch(key, method, path, init);
  }
  return response;
}

export async function workspaceJson(env: CloudEnv, workspace: WorkspaceRow, method: string, path: string, init: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<RevylAnswer> {
  try {
    return await answerOf(await workspaceCall(env, workspace, method, path, init));
  } catch (error) {
    return unreachable(method, path, error);
  }
}

/** The workspace's app that builds go to, made on the first build. */
export async function workspaceApp(env: CloudEnv, workspace: WorkspaceRow, now: number): Promise<string | Response> {
  if (workspace.app_id) return workspace.app_id;
  const made = await workspaceJson(env, workspace, "POST", "/apps/", { body: { name: "ADE builds", platform: "iOS" } });
  // Made already (a first build racing another, or a row made again): Revyl names it.
  const existing = made.status === 409 && typeof made.body?.existing_app_id === "string" ? made.body.existing_app_id : null;
  const id = existing ?? (made.status < 300 && typeof made.body?.id === "string" ? made.body.id : null);
  if (!id) {
    reportCloudFailure("cloud.phone_revyl_app_failed", { userId: workspace.user_id, status: made.status, code: revylErrorOf(made).code }, "cloud-phone");
    return fail("phone_unavailable", "The cloud iPhone couldn't set up its builds. Try again in a moment.", 502);
  }
  await env.DB.prepare("update cloud_phone_revyl set app_id = coalesce(app_id, ?), updated_at = ? where user_id = ?").bind(id, now, workspace.user_id).run();
  const row = await env.DB.prepare("select app_id from cloud_phone_revyl where user_id = ?").bind(workspace.user_id).first<{ app_id: string | null }>();
  workspace.app_id = row?.app_id ?? id;
  return workspace.app_id;
}

/** The account's workspace, or null when it has none yet (no phone ever started there). */
export async function knownWorkspace(env: Pick<CloudEnv, "DB">, userId: string): Promise<WorkspaceRow | null> {
  return await env.DB.prepare("select user_id, external_id, app_id from cloud_phone_revyl where user_id = ?").bind(userId).first<WorkspaceRow>() ?? null;
}

/** A workspace's session credential is forgotten (its account was disconnected). */
export function forgetSessionKey(externalId: string): void {
  sessionKeys.delete(externalId);
}

/* ---- A brain's call (`POST /cloud/phone/call`) ---- */

/** A Revyl job or build id. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const stringArg = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A call's action, its body for Revyl and its query (short lowercase keys and values only). */
export function callParts(body: Record<string, unknown>): { action: string; args: Record<string, unknown>; query: Record<string, string> } {
  const action = typeof body.action === "string" ? body.action : "";
  const args = body.body && typeof body.body === "object" && !Array.isArray(body.body) ? body.body as Record<string, unknown> : {};
  const query = body.query && typeof body.query === "object" && !Array.isArray(body.query)
    ? Object.fromEntries(Object.entries(body.query as Record<string, unknown>).filter((entry): entry is [string, string] => /^[a-z_]{1,40}$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].length <= 200))
    : {};
  return { action, args, query };
}
