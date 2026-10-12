// Approval of a device sign-in from a signed-in ADE app: `/device/approve`.
//
// A person scans the sign-in QR code with a phone that already has their
// account. The app asks what the code is for, the person approves, and Clerk
// signs them in to the sign-in's own page with a one-time ticket, so they type
// no password. The sign-in itself, the code, and the browser page are in
// `deviceAuthorization.ts`; this route only starts one from an app.

import type { CallerAuthenticationResult } from "./callerToken";
import {
  DEVICE_RATE_LIMIT_WINDOW_MS,
  admitApprovalAttempt,
  claimForClerkSignIn,
  clerkOAuthConfig,
  findByUserCode,
  isDeviceAuthorizationExpired,
  isRecord,
  json,
  nonEmptyString,
  normalizeUserCode,
  parseJsonBody,
  resolveDeviceRequestOptions,
  type DeviceAuthorizationEnv,
  type DeviceAuthorizationRequestOptions,
  type DeviceAuthorizationRow,
} from "./deviceAuthorization";

const CLERK_BACKEND_API_URL = "https://api.clerk.com/v1";
/** Long enough to open the sheet on the phone; the ticket is spent at once. */
const APP_APPROVAL_TICKET_TTL_SECONDS = 120;

export type DeviceAppApprovalOptions = Pick<
  DeviceAuthorizationRequestOptions,
  "fetchImpl" | "now" | "randomBytes"
> & {
  /**
   * Verifies the request's account bearer and names its user. Injected so all
   * Clerk token verification stays in `callerToken.ts`.
   */
  authenticateCaller: (request: Request) => Promise<CallerAuthenticationResult>;
};

type ResolvedOptions = ReturnType<typeof resolveDeviceRequestOptions>;

/**
 * Where a sign-in stands for a signed-in ADE app: nobody confirmed the code
 * (`pending`), a confirmation claimed it and its Clerk sign-in is open
 * (`started`), the computer has or can still collect its session (`approved`),
 * or the sign-in ended in an error (`failed`).
 */
type AppApprovalState = "pending" | "started" | "approved" | "failed";

/** What a signed-in app is told about a code: its row and state, or why there is none. */
type AppApprovalLookup =
  | { row: DeviceAuthorizationRow; state: AppApprovalState }
  | { row: null; state: "not_found" | "expired" };

async function lookUpForApp(
  env: DeviceAuthorizationEnv,
  userCode: string,
  now: number,
): Promise<AppApprovalLookup> {
  const row = await findByUserCode(env, userCode);
  if (!row) return { row: null, state: "not_found" };
  // The computer collected its session; that stays true after the code's time.
  if (row.status === "consumed") return { row, state: "approved" };
  // An approved code the computer did not collect in time is gone like any
  // other: `/device/token` refuses it, so the app must not report it as done.
  if (isDeviceAuthorizationExpired(row, now)) return { row: null, state: "expired" };
  if (row.status === "approved") return { row, state: "approved" };
  if (row.status === "error") return { row, state: "failed" };
  const claimed = Boolean(row.code_verifier || row.oauth_state_hash);
  return { row, state: claimed ? "started" : "pending" };
}

function appLookupRefusal(state: "not_found" | "expired"): Response {
  return state === "expired"
    ? json({ error: "expired" }, { status: 410 })
    : json({ error: "not_found" }, { status: 404 });
}

function userCodeRequired(): Response {
  return json({ error: "invalid_request", error_description: "user_code is required" }, { status: 400 });
}

/**
 * Approval from a signed-in ADE app, for a person who scanned the sign-in QR
 * code with a phone that already has their account. Both methods take an
 * account bearer.
 *
 * The browser page (`/device`) stays the path for everything else, and the
 * path the app offers when the POST answers 503.
 */
export async function handleDeviceAppApprovalRequest(
  request: Request,
  env: DeviceAuthorizationEnv,
  options: DeviceAppApprovalOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/device/approve") return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const caller = await options.authenticateCaller(request);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? json({ error: "unavailable" }, { status: 503 })
      : json({ error: "unauthorized" }, { status: 401 });
  }
  const resolved = resolveDeviceRequestOptions(options);
  return request.method === "GET"
    ? readAppApproval(request, env, resolved)
    : approveFromApp(request, caller.userId, env, resolved);
}

/**
 * `GET /device/approve?user_code=`: names the computer, so the app can ask
 * before anything changes, and reports the state, so the app can tell when the
 * sign-in it opened has finished. Not rate limited, like the browser page: it
 * changes nothing, and the app repeats it while its sign-in sheet is open.
 */
async function readAppApproval(
  request: Request,
  env: DeviceAuthorizationEnv,
  options: ResolvedOptions,
): Promise<Response> {
  const userCode = normalizeUserCode(new URL(request.url).searchParams.get("user_code") ?? "");
  if (!userCode) return userCodeRequired();
  const found = await lookUpForApp(env, userCode, options.now());
  if (!found.row) return appLookupRefusal(found.state);
  return json({
    status: found.state,
    // The client-chosen name is shown only while the code can be confirmed.
    machine_name: found.state === "pending" ? found.row.machine_name : null,
  });
}

/**
 * `POST /device/approve`: answers with one URL for the app to open in a web
 * sheet. It is a one-time Clerk sign-in ticket for the caller, which continues
 * to this sign-in's authorize URL. The person types no password, and the
 * session the computer receives is the caller's own, because the ticket is
 * minted for the user the bearer was verified as.
 */
async function approveFromApp(
  request: Request,
  callerUserId: string,
  env: DeviceAuthorizationEnv,
  options: ResolvedOptions,
): Promise<Response> {
  const rawUserCode = nonEmptyString((await parseJsonBody(request))?.user_code);
  const userCode = rawUserCode ? normalizeUserCode(rawUserCode) : null;
  if (!userCode) return userCodeRequired();

  const now = options.now();
  if (!(await admitApprovalAttempt(request, env, now))) {
    return json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(DEVICE_RATE_LIMIT_WINDOW_MS / 1000) } },
    );
  }
  const found = await lookUpForApp(env, userCode, now);
  if (!found.row) return appLookupRefusal(found.state);
  if (found.state !== "pending") return json({ error: "already_used" }, { status: 409 });

  // Everything this worker needs is checked before a ticket exists.
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  const oauth = clerkOAuthConfig(env);
  if (!secretKey || !oauth) return json({ error: "unavailable" }, { status: 503 });

  // Ticket first, claim second: a ticket that is never handed out expires on
  // its own, but a claim with no ticket would leave the code unusable in the
  // browser too.
  const ticketUrl = await mintSignInTicketUrl(secretKey, callerUserId, options.fetchImpl);
  if (!ticketUrl) return json({ error: "unavailable" }, { status: 502 });

  const authorizeUrl = await claimForClerkSignIn(
    env,
    oauth,
    found.row.device_code,
    new URL(request.url).origin,
    options,
  );
  if (!authorizeUrl) return json({ error: "already_used" }, { status: 409 });
  ticketUrl.searchParams.set("redirect_url", authorizeUrl);
  return json({ url: ticketUrl.toString(), machine_name: found.row.machine_name });
}

/**
 * Asks Clerk for a one-time sign-in link for `userId`. `null` when Clerk
 * refuses or answers with something that is not an https link; the reason is
 * dropped, because Clerk's error body is not for the caller.
 */
async function mintSignInTicketUrl(
  secretKey: string,
  userId: string,
  fetchImpl: typeof fetch,
): Promise<URL | null> {
  try {
    const response = await fetchImpl(`${CLERK_BACKEND_API_URL}/sign_in_tokens`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_id: userId, expires_in_seconds: APP_APPROVAL_TICKET_TTL_SECONDS }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    const rawUrl = response.ok && isRecord(body) ? nonEmptyString(body.url) : null;
    const url = rawUrl ? new URL(rawUrl) : null;
    return url?.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
