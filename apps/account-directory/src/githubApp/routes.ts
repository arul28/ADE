import { authenticate } from "../callerToken";
import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "../cloud/http";
import { clerkAccount } from "../laneShares/clerkAccount";
import { logGithubApp } from "../logging";
import { readBoundedBody } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";
import {
  GITHUB_APP_ADOPT_LIMIT_PER_HOUR,
  GITHUB_APP_MAX_BODY_BYTES,
  GITHUB_APP_PATHS,
  GITHUB_APP_RETIRE_LIMIT_PER_HOUR,
  GITHUB_APP_REVOKE_URL,
  GITHUB_APP_SIGN_IN_ID_PATTERN,
  GITHUB_APP_SIGN_IN_LIMIT_PER_10_MIN,
  GITHUB_APP_SIGN_IN_TTL_MS,
  GITHUB_APP_TOKEN_LIMIT_PER_HOUR,
  type GithubAppAdoptResponse,
  type GithubAppClientKind,
  type GithubAppDisconnectResponse,
  type GithubAppSignInReadResponse,
  type GithubAppSignInStartResponse,
  type GithubAppStatusResponse,
  type GithubAppTokenResponse,
} from "./contract";
import {
  deletePreviousToken,
  githubAppRuntime,
  loadGrant,
  overLimit,
  removeGrant,
  saveGrant,
  serveToken,
  type GithubAppEnv,
  type GithubAppRuntime,
} from "./grants";
import { checkToken, deleteToken, exchangeCode, readGithubUser, refreshTokens, type GithubTokens, type GithubUser } from "./oauth";
import { confirmPage, connectedPage, failurePage, installedPage, maskEmail, type FailureKind } from "./pages";
import { constantTimeEqual, randomBase64Url, randomHex, seal, sha256Base64Url, sha256Hex, signInAad, signInTokensAad, unseal } from "./seal";

export type { GithubAppEnv } from "./grants";

/**
 * The ADE GitHub App sign-in that belongs to the account (README, "GitHub
 * App sign-in"; tables in migration 0031; shapes in `contract.ts`).
 *
 * Every bearer route reads only the caller's own grant (`user_id` in every
 * statement). The refresh token and the client secret never leave this
 * Worker: no response, log line or error carries either. Clients get the
 * access token only.
 */

const PREFIX = GITHUB_APP_PATHS.root;

export function isGithubAppRequest(url: URL): boolean {
  return url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
}

type Route =
  | { kind: "signIn" }
  | { kind: "signInRead"; id: string }
  | { kind: "callback" }
  | { kind: "token" }
  | { kind: "status" }
  | { kind: "grant" }
  | { kind: "adopt" }
  | { kind: "retire" }
  | { kind: "installed" };

function matchRoute(path: string): Route | null {
  switch (path) {
    case GITHUB_APP_PATHS.signIn: return { kind: "signIn" };
    case GITHUB_APP_PATHS.callback: return { kind: "callback" };
    case GITHUB_APP_PATHS.token: return { kind: "token" };
    case GITHUB_APP_PATHS.status: return { kind: "status" };
    case GITHUB_APP_PATHS.grant: return { kind: "grant" };
    case GITHUB_APP_PATHS.adopt: return { kind: "adopt" };
    case GITHUB_APP_PATHS.retire: return { kind: "retire" };
    case GITHUB_APP_PATHS.installed: return { kind: "installed" };
  }
  if (path.startsWith(`${GITHUB_APP_PATHS.signIn}/`)) {
    const id = path.slice(GITHUB_APP_PATHS.signIn.length + 1);
    return id && !id.includes("/") ? { kind: "signInRead", id } : null;
  }
  return null;
}

function methodsFor(route: Route): string[] {
  switch (route.kind) {
    case "signInRead":
    case "callback":
    case "status":
    case "installed":
      return ["GET"];
    case "grant":
      return ["DELETE"];
    default:
      return ["POST"];
  }
}

/** Browser pages: GitHub (or the person) navigates here, with no bearer and no CORS. The callback also takes the confirm form's POST. */
const isPage = (route: Route | null): boolean => route?.kind === "callback" || route?.kind === "installed";
/** Machines only: a browser origin may never call these. */
const isMachineOnly = (route: Route | null): boolean => route?.kind === "adopt" || route?.kind === "retire";

const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "content-type", "x-ade-correlation-id"]);

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "retry-after");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const notFound = () => fail("not_found", "That was not found.", 404);
const badRequest = (message: string) => fail("bad_request", message, 400);
const notConfigured = () => fail("github_app_not_configured", "GitHub sign-in through ADE is not set up on this server yet.", 503);
const withRetryAfter = (response: Response, seconds: number): Response => {
  response.headers.set("retry-after", String(Math.max(1, Math.ceil(seconds))));
  return response;
};

type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * CORS is the directory's rule: only the hosted web client's exact origin,
 * never `*`; a native caller sends no Origin. `adopt` and `retire` are for
 * machines only. A refused origin is answered before the token or D1 is
 * touched. The two pages take no CORS at all.
 */
export async function handleGithubAppRequest(request: Request, env: GithubAppEnv, waitUntil?: WaitUntil): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const route = matchRoute(path);

  if (route && isPage(route)) {
    if (route.kind === "installed") return request.method === "GET" || request.method === "HEAD" ? installedPage() : notFound();
    // Not HEAD: the GET spends the state and exchanges the code.
    if (request.method === "GET") return handleCallback(request, env, url, waitUntil);
    if (request.method === "POST") return handleConfirm(request, env, waitUntil);
    return notFound();
  }

  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const corsOrigin = route && !isMachineOnly(route) && requestOrigin && allowedOrigin && requestOrigin === allowedOrigin
    ? allowedOrigin
    : null;

  if (request.method === "OPTIONS") {
    if (!route) return notFound();
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE's GitHub sign-in.", 403);
    const methods = methodsFor(route);
    const wanted = request.headers.get("access-control-request-method")?.toUpperCase() ?? "";
    if (!methods.includes(wanted)) return fail("bad_request", "That method isn't allowed here.", 405);
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) {
      return fail("origin_not_allowed", "Those headers aren't allowed.", 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type, x-ade-correlation-id",
        "access-control-allow-methods": `${methods.join(", ")}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE's GitHub sign-in.", 403);

  const response = await routeRequest(request, env, route, waitUntil);
  return corsOrigin ? withCors(response, corsOrigin) : response;
}

async function routeRequest(request: Request, env: GithubAppEnv, route: Route | null, waitUntil?: WaitUntil): Promise<Response> {
  if (!route || !methodsFor(route).includes(request.method)) return notFound();
  const caller = await authenticate(request, env);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? fail("unavailable", "ADE can't check your sign-in right now. Try again soon.", 503)
      : fail("unauthorized", "Sign in to ADE to connect GitHub.", 401);
  }
  const rt = await githubAppRuntime(env);
  if (!rt) return notConfigured();
  const userId = caller.userId;
  const now = Date.now();
  switch (route.kind) {
    case "signIn": return handleSignInStart(request, env, rt, userId, now);
    case "signInRead": return handleSignInRead(rt, userId, route.id, now);
    case "token": return handleToken(request, rt, userId, now);
    case "status": return handleStatus(rt, userId);
    case "grant": return handleDisconnect(rt, userId);
    case "adopt": return handleAdopt(request, rt, userId, now, waitUntil);
    case "retire": return handleRetire(request, rt, userId, now);
    default: return notFound();
  }
}

// ---------------------------------------------------------------------------
// Input

async function readBody(request: Request): Promise<Record<string, unknown> | "too_large" | null> {
  let read: Awaited<ReturnType<typeof readBoundedBody>>;
  try {
    read = await readBoundedBody(request, GITHUB_APP_MAX_BODY_BYTES);
  } catch {
    return null;
  }
  if (!read.ok) return "too_large";
  if (!read.text) return {};
  try {
    const value = JSON.parse(read.text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const CLIENT_KINDS = new Set<GithubAppClientKind>(["desktop", "web", "ios", "cli"]);
/** A GitHub token as GitHub prints it: no spaces, a sane length. */
const TOKEN_SHAPE = /^[A-Za-z0-9_.~+/=-]{20,512}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_RETURN_TO = 2048;

/** ISO text or epoch ms, as the desktop record or a newer client sends it. */
function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `returnTo` for the web: same origin as the web client, an absolute https path, nothing else. */
function parseReturnTo(raw: unknown, allowedOrigin: string | null): string | null | false {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > MAX_RETURN_TO || !allowedOrigin || !raw.startsWith(`${allowedOrigin}/`)) return false;
  try {
    const url = new URL(raw);
    if (url.origin !== allowedOrigin || url.username || url.password) return false;
    url.hash = "";
    url.searchParams.delete("githubSignIn");
    url.searchParams.delete("status");
    return url.toString();
  } catch {
    return false;
  }
}

const rateLimited = (seconds: number) => withRetryAfter(fail("rate_limited", "Too many requests. Try again soon.", 429), seconds);
const githubUnavailable = (seconds: number) =>
  withRetryAfter(fail("github_unavailable", "GitHub isn't answering right now. Try again soon.", 503), seconds);

// ---------------------------------------------------------------------------
// Sign-in

async function handleSignInStart(request: Request, env: GithubAppEnv, rt: GithubAppRuntime, userId: string, now: number): Promise<Response> {
  const body = await readBody(request);
  if (body === "too_large") return fail("too_large", "That request is too large.", 413);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const client = typeof body.client === "string" && CLIENT_KINDS.has(body.client as GithubAppClientKind) ? body.client as GithubAppClientKind : null;
  if (!client) return badRequest("Say which ADE app is signing in: desktop, web, ios or cli.");
  let returnTo: string | null = null;
  if (client === "web") {
    const parsed = parseReturnTo(body.returnTo, trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true }));
    if (parsed === false) return badRequest("The return address must be a page of the ADE web app.");
    returnTo = parsed;
  }
  const wait = await overLimit(rt.db, userId, "sign_in", GITHUB_APP_SIGN_IN_LIMIT_PER_10_MIN, 10 * 60_000, now);
  if (wait) return rateLimited(wait);

  const id = `gs_${randomHex(16)}`;
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(32);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = `${new URL(request.url).origin}${GITHUB_APP_PATHS.callback}`;
  const expiresAt = now + GITHUB_APP_SIGN_IN_TTL_MS;
  await rt.db.prepare(`
    insert into github_app_sign_ins (id, state_hash, user_id, code_verifier_sealed, client_kind, return_to, redirect_uri, status, created_at, expires_at)
    values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(id, await sha256Hex(state), userId, await seal(rt.key, verifier, signInAad(id, userId)), client, returnTo, redirectUri, now, expiresAt).run();

  const authorize = new URL(`${rt.config.webBase}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", rt.config.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  logGithubApp({ event: "github_app.sign_in_started", userId, client });
  const response: GithubAppSignInStartResponse = { signInId: id, authorizeUrl: authorize.toString(), expiresAt };
  return json(response, 201);
}

type SignInRow = {
  id: string;
  user_id: string;
  code_verifier_sealed: string;
  client_kind: GithubAppClientKind;
  return_to: string | null;
  redirect_uri: string;
  status: "pending" | "exchanging" | "confirming" | "done" | "failed" | "expired";
  result_code: "ok" | "denied" | "error" | null;
  github_login: string | null;
  github_user_id: number | null;
  tokens_sealed: string | null;
  confirm_hash: string | null;
  expires_at: number;
};

async function handleSignInRead(rt: GithubAppRuntime, userId: string, id: string, now: number): Promise<Response> {
  if (!GITHUB_APP_SIGN_IN_ID_PATTERN.test(id)) return notFound();
  const row = await rt.db.prepare("select * from github_app_sign_ins where id = ? and user_id = ?").bind(id, userId).first<SignInRow>();
  if (!row) return notFound();
  let status: GithubAppSignInReadResponse["status"];
  if (row.status === "done" || row.status === "failed" || row.status === "expired") status = row.status;
  else if ((row.status === "pending" || row.status === "confirming") && row.expires_at <= now) status = "expired";
  else status = "pending";
  const response: GithubAppSignInReadResponse = { status, resultCode: row.result_code, githubLogin: row.github_login };
  return json(response);
}

/** 303 after the confirm form's POST, so the client page loads with a GET. */
const redirect = (location: string, status: 302 | 303 = 302): Response => new Response(null, {
  status,
  headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
});

/** Where a phone or the web client goes after the callback. Null: show a page (desktop, CLI). */
function clientReturn(row: SignInRow, status: "ok" | "denied" | "error" | "expired"): string | null {
  if (row.client_kind === "ios") {
    return `ade://github/connected?signIn=${encodeURIComponent(row.id)}&status=${status}`;
  }
  if (row.client_kind === "web" && row.return_to) {
    const url = new URL(row.return_to);
    url.searchParams.set("githubSignIn", row.id);
    url.searchParams.set("status", status);
    return url.toString();
  }
  return null;
}

/** The one place `clientReturn` sends the browser, for the confirm page's `form-action`. */
function returnTarget(row: SignInRow): string | null {
  if (row.client_kind === "ios") return "ade:";
  if (row.client_kind === "web" && row.return_to) return new URL(row.return_to).origin;
  return null;
}

/** Ends a sign-in that did not save a grant, and drops the tokens it held. */
async function finishSignIn(rt: GithubAppRuntime, row: SignInRow, status: "failed" | "expired", resultCode: "denied" | "error" | null): Promise<void> {
  await rt.db.prepare(`
    update github_app_sign_ins set status = ?, result_code = ?, tokens_sealed = null, confirm_hash = null
    where id = ? and status in ('pending', 'exchanging', 'confirming')
  `).bind(status, resultCode, row.id).run();
}

function failureResponse(
  row: SignInRow | null,
  kind: FailureKind,
  redirectStatus: 302 | 303 = 302,
  githubCode: string | null = null,
): Response {
  if (row && (kind === "denied" || kind === "error" || kind === "refused" || kind === "github_busy" || kind === "expired")) {
    // Clients know one failure: `error`. The page says which.
    const location = clientReturn(row, kind === "refused" || kind === "github_busy" ? "error" : kind);
    if (location) return redirect(location, redirectStatus);
  }
  return failurePage(kind, githubCode);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Waits before each new `GET /user` with a token GitHub just issued. A 401 or
 * a failed request there is not a refusal: GitHub had answered the exchange a
 * moment before. Bounded well below the callback's own time.
 */
const USER_READ_RETRY_DELAYS_MS = [1_000, 2_500] as const;
/** One more exchange after a 5xx or a network failure: GitHub may never have used the code. */
const EXCHANGE_RETRY_DELAY_MS = 1_000;

/**
 * `GET /github/app/callback?code&state` (or `?error&state`). The state finds
 * the sign-in by its hash and is spent by one conditional update, so it works
 * once and only within ten minutes. The code is exchanged with the client
 * secret and the PKCE verifier; the token's `GET /user` names the GitHub
 * user.
 *
 * The callback has no bearer, and the state only proves that someone started
 * this sign-in, not that this browser's person did: GitHub returns at once,
 * with no prompt, to a person who already authorized the App. So the grant is
 * not saved here. The tokens wait sealed on the sign-in row, and the page asks
 * the person to connect the named GitHub login to the named ADE account
 * (`handleConfirm` saves it).
 */
async function handleCallback(request: Request, env: GithubAppEnv, url: URL, waitUntil?: WaitUntil): Promise<Response> {
  const rt = await githubAppRuntime(env);
  if (!rt) return failurePage("not_configured");
  const state = url.searchParams.get("state") ?? "";
  if (!state || state.length > 128) return failurePage("unknown");
  const stateHash = await sha256Hex(state);
  const row = await rt.db.prepare("select * from github_app_sign_ins where state_hash = ?").bind(stateHash).first<SignInRow>();
  if (!row) {
    logGithubApp({ event: "github_app.sign_in_refused", userId: "unknown", code: "unknown_state" });
    return failurePage("unknown");
  }
  const now = Date.now();
  if (row.status === "expired" || (row.status === "pending" && row.expires_at <= now)) {
    await finishSignIn(rt, row, "expired", null);
    logGithubApp({ event: "github_app.sign_in_refused", userId: row.user_id, code: "expired_state", client: row.client_kind });
    return failureResponse(row, "expired");
  }
  // One use: of two callbacks with the same state only one moves the row on.
  const claim = await rt.db.prepare(`
    update github_app_sign_ins set status = 'exchanging' where id = ? and status = 'pending' and expires_at > ?
  `).bind(row.id, now).run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    logGithubApp({ event: "github_app.sign_in_refused", userId: row.user_id, code: "state_reused", client: row.client_kind });
    return failurePage("used");
  }

  const githubError = url.searchParams.get("error");
  if (githubError) {
    const resultCode = githubError === "access_denied" ? "denied" : "error";
    await finishSignIn(rt, row, "failed", resultCode);
    const oauthError = resultCode === "error" ? githubError.slice(0, 64) : undefined;
    logGithubApp({ event: "github_app.sign_in_failed", userId: row.user_id, client: row.client_kind, kind: resultCode === "denied" ? "denied" : "github_error", oauthError });
    return failureResponse(row, resultCode === "denied" ? "denied" : "refused", 302, oauthError ?? null);
  }
  const code = url.searchParams.get("code") ?? "";
  // The redirect GitHub sends back must be this Worker's own callback, the same URL the sign-in was started with.
  const redirectUri = `${url.origin}${GITHUB_APP_PATHS.callback}`;
  if (!code || code.length > 256 || !constantTimeEqual(redirectUri, row.redirect_uri)) {
    await finishSignIn(rt, row, "failed", "error");
    logGithubApp({ event: "github_app.sign_in_failed", userId: row.user_id, client: row.client_kind, kind: "bad_callback" });
    return failureResponse(row, "error");
  }

  let verifier: string;
  try {
    verifier = await unseal(rt.key, row.code_verifier_sealed, signInAad(row.id, row.user_id));
  } catch {
    await finishSignIn(rt, row, "failed", "error");
    return failureResponse(row, "error");
  }
  const exchange = () => exchangeCode(rt.config, { code, redirectUri: row.redirect_uri, codeVerifier: verifier }, Date.now());
  let exchanged = await exchange();
  let exchangeAttempts = 1;
  if (!exchanged.ok && exchanged.kind === "transient") {
    await pause(EXCHANGE_RETRY_DELAY_MS);
    exchanged = await exchange();
    exchangeAttempts += 1;
  }
  if (!exchanged.ok) {
    await finishSignIn(rt, row, "failed", "error");
    const oauthError = exchanged.kind === "refused" || exchanged.kind === "client_credentials" ? exchanged.oauthError : undefined;
    logGithubApp({
      event: "github_app.sign_in_failed",
      userId: row.user_id,
      client: row.client_kind,
      kind: exchanged.kind,
      oauthError,
      attempts: exchangeAttempts,
      status: exchanged.kind === "transient" ? exchanged.status : undefined,
    });
    // A wrong client id or secret is this Worker's setting, not GitHub refusing the person.
    const kind: FailureKind = exchanged.kind === "refused" ? "refused" : exchanged.kind === "transient" ? "github_busy" : "error";
    return failureResponse(row, kind, 302, exchanged.kind === "refused" ? exchanged.oauthError : null);
  }
  let user = await readGithubUser(rt.config, exchanged.tokens.accessToken);
  let userAttempts = 1;
  for (const delayMs of USER_READ_RETRY_DELAYS_MS) {
    if (user.ok) break;
    await pause(delayMs);
    user = await readGithubUser(rt.config, exchanged.tokens.accessToken);
    userAttempts += 1;
  }
  if (!user.ok) {
    // A token we cannot name is not kept.
    const dropped = deleteToken(rt.config, exchanged.tokens.accessToken);
    if (waitUntil) waitUntil(dropped); else await dropped;
    await finishSignIn(rt, row, "failed", "error");
    logGithubApp({ event: "github_app.sign_in_failed", userId: row.user_id, client: row.client_kind, kind: `user_${user.kind}`, attempts: userAttempts });
    return failureResponse(row, "github_busy");
  }

  const confirm = randomBase64Url(32);
  const held = await rt.db.prepare(`
    update github_app_sign_ins set status = 'confirming', github_login = ?, github_user_id = ?, tokens_sealed = ?, confirm_hash = ?, expires_at = ?
    where id = ? and status = 'exchanging'
  `).bind(
    user.user.login,
    user.user.id,
    await seal(rt.key, JSON.stringify(exchanged.tokens), signInTokensAad(row.id, row.user_id)),
    await sha256Hex(confirm),
    Date.now() + GITHUB_APP_SIGN_IN_TTL_MS,
    row.id,
  ).run();
  if ((held.meta?.changes ?? 0) !== 1) {
    const dropped = deleteToken(rt.config, exchanged.tokens.accessToken);
    if (waitUntil) waitUntil(dropped); else await dropped;
    return failurePage("used");
  }
  const previous = await loadGrant(rt.db, row.user_id);
  const account = await clerkAccount(env, row.user_id);
  return confirmPage({
    identity: { githubLogin: user.user.login, adeAccount: maskEmail(account?.verifiedEmails[0]) },
    replacedLogin: previous && previous.github_user_id !== user.user.id ? previous.github_login : null,
    action: GITHUB_APP_PATHS.callback,
    signInId: row.id,
    confirm,
    returnTarget: returnTarget(row),
  });
}

/**
 * `POST /github/app/callback`: the confirm page's answer. The one-time
 * confirm value is the proof that this browser saw the page, and is spent by
 * one conditional update. Connect saves the held tokens as the account's
 * grant; Cancel, or an answer after ten minutes, deletes the token at GitHub.
 */
async function handleConfirm(request: Request, env: GithubAppEnv, waitUntil?: WaitUntil): Promise<Response> {
  const rt = await githubAppRuntime(env);
  if (!rt) return failurePage("not_configured");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failurePage("unknown");
  }
  const id = String(form.get("signIn") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  const choice = form.get("choice");
  if (!GITHUB_APP_SIGN_IN_ID_PATTERN.test(id) || !confirm || confirm.length > 128 || (choice !== "connect" && choice !== "cancel")) {
    return failurePage("unknown");
  }
  const row = await rt.db.prepare("select * from github_app_sign_ins where id = ?").bind(id).first<SignInRow>();
  if (!row?.confirm_hash || !constantTimeEqual(await sha256Hex(confirm), row.confirm_hash)) {
    return failurePage(row && row.status !== "confirming" && row.status !== "pending" ? "used" : "unknown");
  }
  const now = Date.now();
  const claim = await rt.db.prepare("update github_app_sign_ins set status = 'exchanging', confirm_hash = null where id = ? and status = 'confirming'")
    .bind(row.id).run();
  if ((claim.meta?.changes ?? 0) !== 1 || !row.tokens_sealed || row.github_user_id == null || !row.github_login) {
    return failurePage("used");
  }
  let tokens: GithubTokens;
  try {
    tokens = JSON.parse(await unseal(rt.key, row.tokens_sealed, signInTokensAad(row.id, row.user_id))) as GithubTokens;
  } catch {
    await finishSignIn(rt, row, "failed", "error");
    logGithubApp({ event: "github_app.sign_in_failed", userId: row.user_id, client: row.client_kind, kind: "confirm_tokens_unreadable" });
    return failureResponse(row, "error", 303);
  }
  if (choice === "cancel" || row.expires_at <= now) {
    const dropped = deleteToken(rt.config, tokens.accessToken);
    if (waitUntil) waitUntil(dropped); else await dropped;
    if (choice === "cancel") {
      await finishSignIn(rt, row, "failed", "denied");
      logGithubApp({ event: "github_app.sign_in_failed", userId: row.user_id, client: row.client_kind, kind: "cancelled_at_confirm" });
      return failureResponse(row, "denied", 303);
    }
    await finishSignIn(rt, row, "expired", null);
    logGithubApp({ event: "github_app.sign_in_refused", userId: row.user_id, code: "expired_confirm", client: row.client_kind });
    return failureResponse(row, "expired", 303);
  }

  const user: GithubUser = { id: row.github_user_id, login: row.github_login };
  const { saved, previous } = await saveGrant(rt, row.user_id, user, tokens, "web_flow", Date.now());
  if (!saved) {
    await finishSignIn(rt, row, "failed", "error");
    return failureResponse(row, "error", 303);
  }
  // C13: one live chain per account. Delete the previous token at GitHub
  // (that one token, never the whole authorization).
  if (previous) {
    const cleanup = deletePreviousToken(rt, previous, saved.access_token_sha256);
    if (waitUntil) waitUntil(cleanup); else await cleanup;
  }
  await rt.db.prepare("update github_app_sign_ins set status = 'done', result_code = 'ok', tokens_sealed = null where id = ? and status = 'exchanging'")
    .bind(row.id).run();
  const replacedLogin = previous && previous.github_user_id !== user.id ? previous.github_login : null;
  logGithubApp({
    event: "github_app.sign_in_completed",
    userId: row.user_id,
    client: row.client_kind,
    generation: saved.generation,
    replaced: previous ? (replacedLogin ? "other_github_user" : "same_github_user") : "none",
  });

  const location = clientReturn(row, "ok");
  if (location) return redirect(location, 303);
  const account = await clerkAccount(env, row.user_id);
  return connectedPage({ githubLogin: user.login, adeAccount: maskEmail(account?.verifiedEmails[0]) }, replacedLogin);
}

// ---------------------------------------------------------------------------
// Token, status, disconnect

async function handleToken(request: Request, rt: GithubAppRuntime, userId: string, now: number): Promise<Response> {
  const body = await readBody(request);
  if (body === "too_large") return fail("too_large", "That request is too large.", 413);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (body.reason !== undefined && body.reason !== "expired" && body.reason !== "rejected") return badRequest("The reason must be expired or rejected.");
  let rejectedSha256: string | null = null;
  if (body.reason === "rejected") {
    if (typeof body.rejectedTokenSha256 !== "string" || !SHA256_HEX.test(body.rejectedTokenSha256)) {
      return badRequest("A rejected token needs its SHA-256 in lowercase hex.");
    }
    rejectedSha256 = body.rejectedTokenSha256;
  }
  const wait = await overLimit(rt.db, userId, "token", GITHUB_APP_TOKEN_LIMIT_PER_HOUR, 60 * 60_000, now);
  if (wait) return rateLimited(wait);

  const outcome = await serveToken(rt, userId, { rejectedSha256 }, now);
  switch (outcome.kind) {
    case "token": {
      logGithubApp({ event: "github_app.token_served", userId, generation: outcome.token.generation, reason: outcome.reason });
      const response: GithubAppTokenResponse = outcome.token;
      return json(response);
    }
    case "not_connected":
      return fail("not_connected", "GitHub isn't connected to your ADE account.", 404);
    case "needs_reauth":
      return fail("needs_reauth", "Your GitHub connection ended. Connect GitHub again.", 409, { reason: outcome.reason });
    case "renewing":
      return withRetryAfter(fail("renewing", "ADE is renewing your GitHub sign-in. Try again in a moment.", 503), outcome.retryAfterSec);
    case "unavailable":
      return githubUnavailable(outcome.retryAfterSec);
  }
}

async function handleStatus(rt: GithubAppRuntime, userId: string): Promise<Response> {
  const row = await loadGrant(rt.db, userId);
  const response: GithubAppStatusResponse = row
    ? {
      connected: true,
      state: row.state,
      stateReason: row.state === "needs_reauth" ? row.state_reason : null,
      githubLogin: row.github_login,
      githubUserId: row.github_user_id,
      connectedAt: row.created_at,
      refreshExpiresAt: row.refresh_expires_at,
      origin: row.origin,
    }
    : { connected: false, state: null, stateReason: null, githubLogin: null, githubUserId: null, connectedAt: null, refreshExpiresAt: null, origin: null };
  return json(response);
}

async function handleDisconnect(rt: GithubAppRuntime, userId: string): Promise<Response> {
  const { existed, deletedAtGitHub } = await removeGrant(rt, userId);
  if (existed) logGithubApp({ event: "github_app.disconnected", userId, deletedAtGitHub });
  const response: GithubAppDisconnectResponse = { ok: true, deletedAtGitHub, revokeAtGitHubUrl: GITHUB_APP_REVOKE_URL };
  return json(response);
}

// ---------------------------------------------------------------------------
// Adoption of a machine's device-flow token, and retiring a machine's token

/** Two minutes: the desktop's own "refresh before" margin. */
const ADOPT_FRESH_MARGIN_MS = 2 * 60_000;

async function handleAdopt(request: Request, rt: GithubAppRuntime, userId: string, now: number, waitUntil?: WaitUntil): Promise<Response> {
  const body = await readBody(request);
  if (body === "too_large") return fail("too_large", "That request is too large.", 413);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const accessToken = typeof body.accessToken === "string" && TOKEN_SHAPE.test(body.accessToken) ? body.accessToken : null;
  const refreshToken = typeof body.refreshToken === "string" && TOKEN_SHAPE.test(body.refreshToken) ? body.refreshToken : null;
  const expiresAt = parseTime(body.expiresAt);
  const refreshExpiresAt = parseTime(body.refreshTokenExpiresAt);
  if (!accessToken || !refreshToken || !expiresAt || !refreshExpiresAt) return badRequest("The GitHub sign-in record is incomplete.");
  if (refreshExpiresAt <= now) return fail("refresh_expired", "This GitHub sign-in has ended. Connect GitHub again.", 400);
  const wait = await overLimit(rt.db, userId, "adopt", GITHUB_APP_ADOPT_LIMIT_PER_HOUR, 60 * 60_000, now);
  if (wait) return rateLimited(wait);

  const existing = await loadGrant(rt.db, userId);
  if (existing?.state === "active") {
    // A retry of an adoption that was saved but whose answer was lost: the
    // account holds this very token. Say adopted, so the machine deletes its
    // copy instead of keeping a second holder of the same refresh chain.
    if (existing.access_token_sha256 && constantTimeEqual(await sha256Hex(accessToken), existing.access_token_sha256)) {
      logGithubApp({ event: "github_app.adopted", userId, generation: existing.generation, repeated: true });
      const repeated: GithubAppAdoptResponse = { adopted: true, githubLogin: existing.github_login, generation: existing.generation };
      return json(repeated, 200);
    }
    return fail("already_connected", "Your ADE account already has GitHub connected.", 409, { githubLogin: existing.github_login });
  }

  let tokens: GithubTokens = { accessToken, accessExpiresAt: expiresAt, refreshToken, refreshExpiresAt };
  let user: GithubUser | null = null;
  if (expiresAt - now > ADOPT_FRESH_MARGIN_MS) {
    // The live access token: GitHub says whether it is one of this App's.
    const check = await checkToken(rt.config, accessToken);
    if (check.kind === "transient") return githubUnavailable(60);
    if (check.kind === "invalid") return fail("not_this_app", "GitHub doesn't know this sign-in as one of the ADE GitHub App's.", 400);
    user = check.user;
  } else {
    // The access token is spent or nearly so: one refresh proves the chain
    // is this App's (the client id is part of it) and gives a live token.
    // A device-flow refresh needs no client secret.
    const refreshed = await refreshTokens({ ...rt.config, clientSecret: null }, refreshToken, Date.now());
    if (!refreshed.ok) {
      if (refreshed.kind === "bad_refresh_token") return fail("refresh_expired", "This GitHub sign-in has ended. Connect GitHub again.", 400);
      if (refreshed.kind === "transient") return githubUnavailable(refreshed.retryAfterSec ?? 60);
      return fail("not_this_app", "GitHub doesn't know this sign-in as one of the ADE GitHub App's.", 400);
    }
    tokens = { ...refreshed.tokens, refreshToken: refreshed.tokens.refreshToken ?? refreshToken, refreshExpiresAt: refreshed.tokens.refreshExpiresAt ?? refreshExpiresAt };
  }
  if (!user) {
    const read = await readGithubUser(rt.config, tokens.accessToken);
    if (!read.ok) return read.kind === "transient" ? githubUnavailable(60) : fail("not_this_app", "GitHub doesn't know this sign-in as one of the ADE GitHub App's.", 400);
    user = read.user;
  }

  const { saved, previous } = await saveGrant(rt, userId, user, tokens, "adopted_device_flow", Date.now(), { onlyIfNotActive: true });
  if (!saved) {
    // Another adopt or a sign-in won the race. If this request refreshed,
    // its new token is not the account's: delete it.
    if (tokens.accessToken !== accessToken) {
      const dropped = deleteToken(rt.config, tokens.accessToken);
      if (waitUntil) waitUntil(dropped); else await dropped;
    }
    return fail("already_connected", "Your ADE account already has GitHub connected.", 409, { githubLogin: previous?.github_login ?? "" });
  }
  if (previous) {
    const cleanup = deletePreviousToken(rt, previous, saved.access_token_sha256);
    if (waitUntil) waitUntil(cleanup); else await cleanup;
  }
  logGithubApp({ event: "github_app.adopted", userId, generation: saved.generation, refreshed: tokens.accessToken !== accessToken });
  const response: GithubAppAdoptResponse = { adopted: true, githubLogin: saved.github_login, generation: saved.generation };
  return json(response, 201);
}

async function handleRetire(request: Request, rt: GithubAppRuntime, userId: string, now: number): Promise<Response> {
  const body = await readBody(request);
  if (body === "too_large") return fail("too_large", "That request is too large.", 413);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const accessToken = typeof body.accessToken === "string" && TOKEN_SHAPE.test(body.accessToken) ? body.accessToken : null;
  if (!accessToken) return badRequest("The token to retire is missing.");
  const wait = await overLimit(rt.db, userId, "retire", GITHUB_APP_RETIRE_LIMIT_PER_HOUR, 60 * 60_000, now);
  if (wait) return rateLimited(wait);
  const grant = await loadGrant(rt.db, userId);
  if (grant && grant.access_token_sha256 === await sha256Hex(accessToken)) {
    return fail("live_token", "That token is the one your ADE account uses. Disconnect GitHub instead.", 409);
  }
  if (!(await deleteToken(rt.config, accessToken))) return githubUnavailable(60);
  logGithubApp({ event: "github_app.retired", userId });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
