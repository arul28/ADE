import { authenticate, type CallerTokenEnv } from "./callerToken";
import { fail, json } from "./cloud/http";
import { ACCOUNT_DELETE_PATH, type AccountDeleteResponse } from "./clientMinimumContract";
import { readBoundedBody } from "./sinkUtils";
import { trustedHttpsOrigin } from "./trustedOrigin";

/**
 * `POST /account/delete` (`clientMinimumContract.ts`): the signed-in person
 * deletes their own account from the app (App Store guideline 5.1.1(v)).
 *
 * This route only asks Clerk to delete the user. Clerk's `user.deleted`
 * webhook (`signupAnalytics.ts`) then removes everything ADE holds for the
 * account, step by step and safe to repeat, the same path a deletion from
 * Clerk's dashboard takes. A 404 from Clerk means the user is already gone,
 * which is the outcome asked for.
 */

export type AccountSelfDeleteEnv = CallerTokenEnv & {
  CLERK_SECRET_KEY?: string;
  WEB_CLIENT_ORIGIN?: string;
};

const CLERK_BACKEND_API_URL = "https://api.clerk.com/v1";
const CLERK_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_024;

export function isAccountSelfDeleteRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === ACCOUNT_DELETE_PATH;
}

export async function handleAccountSelfDeleteRequest(
  request: Request,
  env: AccountSelfDeleteEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin ? allowedOrigin : null;
  const withCors = (response: Response): Response => {
    if (!corsOrigin) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", corsOrigin);
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  };

  if (request.method === "OPTIONS") {
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't delete accounts.", 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't delete accounts.", 403);
  if (request.method !== "POST") return withCors(fail("bad_request", "That method isn't allowed here.", 405));

  const caller = await authenticate(request, env);
  if (!caller.ok) return withCors(fail("unauthorized", "Sign in to ADE to delete your account.", 401));

  let confirm: unknown = null;
  try {
    const read = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!read.ok) return withCors(fail("bad_request", "That request could not be read.", 400));
    confirm = (JSON.parse(read.text || "{}") as { confirm?: unknown }).confirm;
  } catch {
    return withCors(fail("bad_request", "That request could not be read.", 400));
  }
  if (confirm !== "delete") {
    return withCors(fail("bad_request", "Confirm the deletion to delete your account.", 400));
  }

  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return withCors(fail("unavailable", "ADE can't delete accounts right now. Try again soon.", 503));

  let status = 0;
  try {
    const response = await fetchImpl(`${CLERK_BACKEND_API_URL}/users/${encodeURIComponent(caller.userId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    status = 0;
  }
  if (status !== 200 && status !== 404) {
    console.warn("account.self_delete_failed", JSON.stringify({ status }));
    return withCors(fail("unavailable", "ADE couldn't delete your account. Try again in a minute.", 502));
  }
  console.info("account.self_deleted", JSON.stringify({ alreadyGone: status === 404 }));
  return withCors(json({ deleted: true } satisfies AccountDeleteResponse));
}
