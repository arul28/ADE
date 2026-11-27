import { authenticate, type CallerTokenEnv } from "../callerToken";
import {
  ACCOUNT_MODEL_FAVORITE_ID_MAX,
  ACCOUNT_MODEL_FAVORITES_MAX,
  CLOUD_PATHS,
  type AccountModelFavorites,
} from "../cloud/contract";
import { UNREADABLE_REQUEST_MESSAGE, fail, json, readJson, tooManyRequests } from "../cloud/http";
import { logCloud, takeRequest } from "../cloud/store";
import { trustedHttpsOrigin } from "../trustedOrigin";

/**
 * The model picker's favorites, one list per account: the desktop on every
 * computer, the web client and the phone read and change the same list, so a
 * star given on one shows on all of them. Favorites belong to the person, not
 * to a machine (recents stay on each machine).
 *
 * `GET` answers the list. `PUT {add, remove}` changes it: the server applies
 * the change to the list it holds, under the revision it read, so two devices
 * starring at once both land; a write that lost the race reads again and
 * applies its change once more. Refusals a resend can't change answer 4xx
 * (`too_many_favorites` 409, a bad id 400); a list still busy after the
 * retries answers 503 `favorites_busy`, which a client sends again later.
 *
 * Every route takes the account bearer and reads only the caller's row. CORS
 * is the web client's exact origin, for the read and the change.
 */

export type AccountModelFavoritesEnv = CallerTokenEnv & {
  DB: D1Database;
  WEB_CLIENT_ORIGIN?: string;
};

const PATH = CLOUD_PATHS.accountModelFavorites;
/** A write that lost the race to another device's tries again this many times. */
const WRITE_ATTEMPTS = 4;
const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "content-type", "x-ade-correlation-id"]);

export function isAccountModelFavoritesRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === PATH;
}

/** A model id as the pickers send it, or null when it can't be one. */
function modelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ACCOUNT_MODEL_FAVORITE_ID_MAX || /[\p{Cc}\p{Cf}]/u.test(trimmed)) return null;
  return trimmed;
}

/** The ids of `value`, deduplicated in order; null when it isn't a list of ids. */
function idList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ACCOUNT_MODEL_FAVORITES_MAX) return null;
  const out: string[] = [];
  for (const raw of value) {
    const id = modelId(raw);
    if (!id) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The stored list, minus anything this server can't read; a row it can't parse counts as empty, so a save repairs it. */
function storedList(raw: string | null | undefined): string[] {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) as unknown : null;
  } catch {
    parsed = null;
  }
  return Array.isArray(parsed) ? [...new Set(parsed.map(modelId).filter((id): id is string => id != null))] : [];
}

async function readRow(db: D1Database, userId: string): Promise<AccountModelFavorites> {
  const row = await db.prepare("select favorites, revision from account_model_favorites where user_id = ?")
    .bind(userId).first<{ favorites: string; revision: number }>();
  return { favorites: storedList(row?.favorites), revision: row?.revision ?? 0 };
}

export async function handleAccountModelFavoritesRequest(request: Request, env: AccountModelFavoritesEnv): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin ? allowedOrigin : null;
  if (request.method === "OPTIONS") {
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE's model favorites.", 403);
    const method = (request.headers.get("access-control-request-method") ?? "").toUpperCase();
    if (method !== "GET" && method !== "PUT") return fail("bad_request", "That method isn't allowed here.", 405);
    const requested = (request.headers.get("access-control-request-headers") ?? "").split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requested.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) return fail("origin_not_allowed", "Those headers aren't allowed.", 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type, x-ade-correlation-id",
        "access-control-allow-methods": "GET, PUT, OPTIONS",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE's model favorites.", 403);
  if (request.method !== "GET" && request.method !== "PUT") return fail("not_found", "That route was not found on your ADE account.", 404);
  const caller = await authenticate(request, env);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? fail("unavailable", "ADE can't check your sign-in right now. Try again soon.", 503)
      : fail("unauthorized", "Sign in to ADE to see your favorite models.", 401);
  }
  const response = request.method === "GET"
    ? json(await readRow(env.DB, caller.userId))
    : await handlePut(request, env, caller.userId, Date.now());
  if (!corsOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", corsOrigin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handlePut(request: Request, env: AccountModelFavoritesEnv, userId: string, now: number): Promise<Response> {
  if (!await takeRequest(env, userId, "settings", now)) return tooManyRequests();
  const body = await readJson(request);
  const add = idList(body?.add);
  const remove = idList(body?.remove);
  if (!body || !add || !remove || (body.account !== undefined && typeof body.account !== "string")) {
    return fail("bad_request", UNREADABLE_REQUEST_MESSAGE, 400);
  }
  if (body.account !== undefined && body.account !== userId) {
    return fail("account_changed", "These favorites were changed under another ADE account.", 403);
  }
  const removed = new Set(remove);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = await readRow(env.DB, userId);
    const next = current.favorites.filter((id) => !removed.has(id) || add.includes(id));
    for (const id of add) if (!next.includes(id)) next.push(id);
    if (next.length > ACCOUNT_MODEL_FAVORITES_MAX) {
      return fail("too_many_favorites", `You can keep up to ${ACCOUNT_MODEL_FAVORITES_MAX} favorite models. Remove one, then try again.`, 409, { favorites: current });
    }
    // Nothing changes: no write, and the revision stays.
    if (next.length === current.favorites.length && next.every((id, index) => id === current.favorites[index])) return json(current);
    // Lands only on the revision read above (0: no row yet). A device that wrote in between leaves no row returned.
    const written = await env.DB.prepare(`
      insert into account_model_favorites (user_id, favorites, revision, updated_at) values (?, ?, 1, ?)
      on conflict (user_id) do update set favorites = excluded.favorites, revision = account_model_favorites.revision + 1, updated_at = excluded.updated_at
        where account_model_favorites.revision = ?
      returning revision
    `).bind(userId, JSON.stringify(next), now, current.revision).first<{ revision: number }>();
    if (written) return json({ favorites: next, revision: written.revision } satisfies AccountModelFavorites);
  }
  logCloud("account_model_favorites.contended", { userId });
  return fail("favorites_busy", "Your favorite models are changing on another device. Try again.", 503);
}

