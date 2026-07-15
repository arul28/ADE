const DEVICE_CODE_TTL_SECONDS = 10 * 60;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEVICE_SLOW_DOWN_INCREMENT_SECONDS = 5;
const DEVICE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEVICE_CODE_RATE_LIMIT_MAX_ATTEMPTS = 10;
const APPROVAL_RATE_LIMIT_MAX_ATTEMPTS = 10;
const DEVICE_AUTHORIZATION_RETENTION_MS = 60 * 60_000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface DeviceAuthorizationEnv {
  DB: D1Database;
  CLERK_ISSUER: string;
  CLERK_OAUTH_CLIENT_ID: string;
}

export type DeviceAuthorizationRequestOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
};

type DeviceAuthorizationRow = {
  device_code: string;
  user_code: string;
  device_secret_hash: string;
  status: "pending" | "approved" | "consumed" | "expired" | "error";
  code_verifier: string | null;
  oauth_state_hash: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  expires_in: number | null;
  error_message: string | null;
  poll_interval_seconds: number;
  last_polled_at: number | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  consumed_at: number | null;
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location,
      "referrer-policy": "no-referrer",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function normalizeIssuer(raw: string): string {
  const issuer = raw.trim().replace(/\/+$/, "");
  const parsed = new URL(issuer);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    throw new Error("CLERK_ISSUER must use https (http is only allowed for localhost)");
  }
  return issuer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function randomUserCode(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(8);
  const characters = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function normalizeUserCode(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 8) return null;
  for (const character of compact) {
    if (!USER_CODE_ALPHABET.includes(character)) return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function encodeQuery(entries: Array<[string, string]>): string {
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function page(args: { title: string; body: string; status?: number }): Response {
  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${args.title}</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101114; color: #f5f5f5; }
      main { width: min(28rem, calc(100vw - 3rem)); padding: 2rem; border: 1px solid #34363c; border-radius: 1rem; background: #181a1f; }
      h1 { margin-top: 0; font-size: 1.5rem; }
      p { color: #c9cbd1; line-height: 1.5; }
      label { display: block; margin: 1.5rem 0 .5rem; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: .8rem; border: 1px solid #4d5058; border-radius: .5rem; background: #101114; color: inherit; font: inherit; letter-spacing: .12em; text-transform: uppercase; }
      button { width: 100%; margin-top: 1rem; padding: .8rem; border: 0; border-radius: .5rem; background: #f5f5f5; color: #101114; font: inherit; font-weight: 700; cursor: pointer; }
    </style>
  </head>
  <body><main>${args.body}</main></body>
</html>`, args.status ?? 200);
}

function approvalForm(userCode = ""): Response {
  return page({
    title: "Sign in to ADE",
    body: `<h1>Sign in to ADE</h1>
      <p>Enter the code shown by <code>ade login</code> on your other machine.</p>
      <form method="post" action="/device">
        <label for="user_code">Device code</label>
        <input id="user_code" name="user_code" value="${userCode}" autocomplete="one-time-code" maxlength="9" required autofocus>
        <button type="submit">Continue</button>
      </form>`,
  });
}

function approvalMessage(title: string, message: string, status = 200): Response {
  return page({ title, status, body: `<h1>${title}</h1><p>${message}</p>` });
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function changes(result: D1Result): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

export async function cleanupExpiredDeviceAuthorizations(
  env: DeviceAuthorizationEnv,
  now = Date.now(),
): Promise<number> {
  const expired = await env.DB.prepare(`
    update device_authorizations
       set status = 'expired', code_verifier = null, oauth_state_hash = null,
           access_token = null, refresh_token = null
     where expires_at <= ? and status in ('pending', 'approved')
  `).bind(now).run();
  const deletedAuthorizations = await env.DB.prepare(`
    delete from device_authorizations
     where expires_at <= ? and status in ('expired', 'consumed', 'error')
  `).bind(now - DEVICE_AUTHORIZATION_RETENTION_MS).run();
  const deletedRateLimits = await env.DB.prepare(`
    delete from device_approval_rate_limits where window_started_at <= ?
  `).bind(now - DEVICE_RATE_LIMIT_WINDOW_MS).run();
  return changes(expired) + changes(deletedAuthorizations) + changes(deletedRateLimits);
}

async function findByDeviceCode(env: DeviceAuthorizationEnv, deviceCode: string): Promise<DeviceAuthorizationRow | null> {
  return env.DB.prepare("select * from device_authorizations where device_code = ?")
    .bind(deviceCode)
    .first<DeviceAuthorizationRow>();
}

async function findByUserCode(env: DeviceAuthorizationEnv, userCode: string): Promise<DeviceAuthorizationRow | null> {
  return env.DB.prepare("select * from device_authorizations where user_code = ?")
    .bind(userCode)
    .first<DeviceAuthorizationRow>();
}

async function checkDeviceRateLimit(
  request: Request,
  env: DeviceAuthorizationEnv,
  now: number,
  scope: "approval" | "issuance",
  maxAttempts: number,
): Promise<boolean> {
  const clientIdentity = request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown-client";
  const clientHash = await sha256(`${scope}:${clientIdentity}`);
  const admitted = await env.DB.prepare(`
    insert into device_approval_rate_limits (client_hash, window_started_at, attempts)
    values (?, ?, 1)
    on conflict(client_hash) do update set
      window_started_at = case
        when excluded.window_started_at - window_started_at >= ? then excluded.window_started_at
        else window_started_at
      end,
      attempts = case
        when excluded.window_started_at - window_started_at >= ? then 1
        else attempts + 1
      end
    where excluded.window_started_at - window_started_at >= ?
       or attempts < ?
  `).bind(
    clientHash,
    now,
    DEVICE_RATE_LIMIT_WINDOW_MS,
    DEVICE_RATE_LIMIT_WINDOW_MS,
    DEVICE_RATE_LIMIT_WINDOW_MS,
    maxAttempts,
  ).run();
  return changes(admitted) === 1;
}

async function handleDeviceCode(
  request: Request,
  env: DeviceAuthorizationEnv,
  options: Required<Pick<DeviceAuthorizationRequestOptions, "now" | "randomBytes">>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await parseJsonBody(request);
  const deviceSecret = nonEmptyString(body?.device_secret);
  if (!deviceSecret || deviceSecret.length < 32 || deviceSecret.length > 512) {
    return json({ error: "invalid_request", error_description: "device_secret is required" }, { status: 400 });
  }

  const now = options.now();
  if (!(await checkDeviceRateLimit(request, env, now, "issuance", DEVICE_CODE_RATE_LIMIT_MAX_ATTEMPTS))) {
    return json(
      { error: "rate_limited", error_description: "Too many device authorization requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(DEVICE_RATE_LIMIT_WINDOW_MS / 1000) } },
    );
  }
  const expiresAt = now + DEVICE_CODE_TTL_SECONDS * 1000;
  const deviceCode = bytesToBase64Url(options.randomBytes(32));
  const deviceSecretHash = await sha256(deviceSecret);
  let userCode = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    userCode = randomUserCode(options.randomBytes);
    try {
      await env.DB.prepare(`
        insert into device_authorizations (
          device_code, user_code, device_secret_hash, status, poll_interval_seconds,
          created_at, expires_at
        ) values (?, ?, ?, 'pending', ?, ?, ?)
      `).bind(
        deviceCode,
        userCode,
        deviceSecretHash,
        DEVICE_POLL_INTERVAL_SECONDS,
        now,
        expiresAt,
      ).run();
      break;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }

  const origin = new URL(request.url).origin;
  const verificationUri = `${origin}/device`;
  return json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  });
}

async function handleDeviceApproval(
  request: Request,
  env: DeviceAuthorizationEnv,
  options: Required<Pick<DeviceAuthorizationRequestOptions, "now" | "randomBytes">>,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const rawUserCode = url.searchParams.get("user_code");
    if (!rawUserCode) return approvalForm();
    return approvalForm(normalizeUserCode(rawUserCode) ?? "");
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (request.headers.get("origin") !== url.origin) {
    return approvalMessage("Confirmation required", "Open the ADE sign-in page and confirm this device code.", 403);
  }

  let rawUserCode: string | null = null;
  try {
    const value = (await request.formData()).get("user_code");
    rawUserCode = typeof value === "string" ? value : null;
  } catch {
    // Invalid form submissions fall through to the blank confirmation form.
  }
  const userCode = rawUserCode ? normalizeUserCode(rawUserCode) : null;
  if (!userCode) return approvalForm("");

  const now = options.now();
  if (!(await checkDeviceRateLimit(request, env, now, "approval", APPROVAL_RATE_LIMIT_MAX_ATTEMPTS))) {
    return approvalMessage("Try again shortly", "Too many device-code attempts were made from this browser.", 429);
  }
  const row = await findByUserCode(env, userCode);
  if (!row) return approvalMessage("Code not found", "Check the code shown by ADE and try again.", 404);
  if (row.expires_at <= now || row.status === "expired") {
    await env.DB.prepare(`
      update device_authorizations
         set status = 'expired', code_verifier = null, oauth_state_hash = null,
             access_token = null, refresh_token = null
       where device_code = ? and status in ('pending', 'approved')
    `)
      .bind(row.device_code)
      .run();
    return approvalMessage("Code expired", "Return to ADE and start sign-in again.", 410);
  }
  if (row.status !== "pending") {
    return approvalMessage("Code already used", "Return to ADE to continue.", 409);
  }
  if (row.code_verifier || row.oauth_state_hash) {
    return approvalMessage("Sign-in already started", "Finish the Clerk sign-in already open in this browser.", 409);
  }

  let issuer: string;
  try {
    issuer = normalizeIssuer(env.CLERK_ISSUER);
  } catch {
    return approvalMessage("Sign-in unavailable", "ADE account login is not configured.", 503);
  }
  const clientId = env.CLERK_OAUTH_CLIENT_ID.trim();
  if (!clientId) return approvalMessage("Sign-in unavailable", "ADE account login is not configured.", 503);

  const codeVerifier = bytesToBase64Url(options.randomBytes(32));
  const codeChallenge = await sha256(codeVerifier);
  const oauthState = bytesToBase64Url(options.randomBytes(32));
  const oauthStateHash = await sha256(oauthState);
  const updated = await env.DB.prepare(`
    update device_authorizations
       set code_verifier = ?, oauth_state_hash = ?
     where device_code = ? and status = 'pending' and expires_at > ?
       and code_verifier is null and oauth_state_hash is null
  `).bind(codeVerifier, oauthStateHash, row.device_code, now).run();
  if (changes(updated) < 1) return approvalMessage("Code unavailable", "Return to ADE and start sign-in again.", 409);

  const redirectUri = `${url.origin}/device/callback`;
  const authorizeUrl = `${issuer}/oauth/authorize?${encodeQuery([
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["code_challenge", codeChallenge],
    ["code_challenge_method", "S256"],
    ["state", oauthState],
    ["scope", "openid profile email offline_access"],
  ])}`;
  return redirect(authorizeUrl);
}

async function handleDeviceCallback(
  request: Request,
  env: DeviceAuthorizationEnv,
  options: Required<Pick<DeviceAuthorizationRequestOptions, "fetchImpl" | "now">>,
): Promise<Response> {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  const url = new URL(request.url);
  const state = nonEmptyString(url.searchParams.get("state"));
  if (!state) return approvalMessage("Sign-in failed", "The authorization state was missing.", 400);
  const stateHash = await sha256(state);
  const row = await env.DB.prepare("select * from device_authorizations where oauth_state_hash = ?")
    .bind(stateHash)
    .first<DeviceAuthorizationRow>();
  const now = options.now();
  if (!row || !row.code_verifier || row.status !== "pending") {
    return approvalMessage("Sign-in failed", "This device authorization is not valid.", 400);
  }
  if (row.expires_at <= now) {
    await env.DB.prepare(`
      update device_authorizations
         set status = 'expired', code_verifier = null, oauth_state_hash = null,
             access_token = null, refresh_token = null
       where device_code = ?
    `)
      .bind(row.device_code)
      .run();
    return approvalMessage("Code expired", "Return to ADE and start sign-in again.", 410);
  }

  const oauthError = nonEmptyString(url.searchParams.get("error"));
  const code = nonEmptyString(url.searchParams.get("code"));
  if (oauthError || !code) {
    await env.DB.prepare("update device_authorizations set status = 'error', error_message = ? where device_code = ? and status = 'pending'")
      .bind("ADE account sign-in was not completed.", row.device_code)
      .run();
    return approvalMessage("Sign-in cancelled", "Return to ADE and try again.", 400);
  }

  let issuer: string;
  try {
    issuer = normalizeIssuer(env.CLERK_ISSUER);
  } catch {
    await env.DB.prepare("update device_authorizations set status = 'error', error_message = ? where device_code = ? and status = 'pending'")
      .bind("ADE account login is not configured.", row.device_code)
      .run();
    return approvalMessage("Sign-in unavailable", "ADE account login is not configured.", 503);
  }
  const clientId = env.CLERK_OAUTH_CLIENT_ID.trim();
  const redirectUri = `${url.origin}/device/callback`;
  let tokenResponse: Response;
  try {
    tokenResponse = await options.fetchImpl(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: row.code_verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }).toString(),
    });
  } catch {
    await env.DB.prepare("update device_authorizations set status = 'error', error_message = ? where device_code = ? and status = 'pending'")
      .bind("OAuth token exchange failed.", row.device_code)
      .run();
    return approvalMessage("Sign-in failed", "Return to ADE and try again.", 502);
  }
  const rawTokenBody: unknown = await tokenResponse.json().catch(() => ({}));
  const tokenBody = isRecord(rawTokenBody) ? rawTokenBody : {};
  if (!tokenResponse.ok) {
    const message = nonEmptyString(tokenBody.error_description) ?? nonEmptyString(tokenBody.error) ?? "OAuth token exchange failed.";
    await env.DB.prepare("update device_authorizations set status = 'error', error_message = ? where device_code = ? and status = 'pending'")
      .bind(message, row.device_code)
      .run();
    return approvalMessage("Sign-in failed", "Return to ADE and try again.", 502);
  }
  const accessToken = nonEmptyString(tokenBody.access_token);
  const expiresIn = positiveInteger(tokenBody.expires_in);
  if (!accessToken || !expiresIn) {
    await env.DB.prepare("update device_authorizations set status = 'error', error_message = ? where device_code = ? and status = 'pending'")
      .bind("OAuth token response was missing required fields.", row.device_code)
      .run();
    return approvalMessage("Sign-in failed", "Return to ADE and try again.", 502);
  }

  const approved = await env.DB.prepare(`
    update device_authorizations
       set status = 'approved', access_token = ?, refresh_token = ?, token_type = ?,
           expires_in = ?, approved_at = ?, code_verifier = null, oauth_state_hash = null
     where device_code = ? and status = 'pending' and expires_at > ?
  `).bind(
    accessToken,
    nonEmptyString(tokenBody.refresh_token),
    nonEmptyString(tokenBody.token_type) ?? "Bearer",
    expiresIn,
    now,
    row.device_code,
    now,
  ).run();
  if (changes(approved) < 1) return approvalMessage("Code unavailable", "Return to ADE and start sign-in again.", 409);
  return approvalMessage("Signed in to ADE", "You can close this tab and return to ADE.");
}

async function handleDeviceToken(
  request: Request,
  env: DeviceAuthorizationEnv,
  options: Required<Pick<DeviceAuthorizationRequestOptions, "now">>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await parseJsonBody(request);
  const deviceCode = nonEmptyString(body?.device_code);
  const deviceSecret = nonEmptyString(body?.device_secret);
  if (!deviceCode || !deviceSecret) {
    return json({ error: "invalid_request", error_description: "device_code and device_secret are required" }, { status: 400 });
  }
  const row = await findByDeviceCode(env, deviceCode);
  if (!row) return json({ error: "invalid_grant" }, { status: 401 });
  const suppliedSecretHash = await sha256(deviceSecret);
  if (!constantTimeEqual(suppliedSecretHash, row.device_secret_hash)) {
    return json({ error: "invalid_grant" }, { status: 401 });
  }

  const now = options.now();
  if (row.expires_at <= now || row.status === "expired") {
    await env.DB.prepare(`
      update device_authorizations
         set status = 'expired', code_verifier = null, oauth_state_hash = null,
             access_token = null, refresh_token = null
       where device_code = ? and status in ('pending', 'approved')
    `).bind(deviceCode).run();
    return json({ error: "expired" }, { status: 400 });
  }
  if (row.status === "consumed") return json({ error: "invalid_grant" }, { status: 401 });
  if (row.status === "error") {
    return json({ error: "access_denied", error_description: row.error_message ?? "ADE account sign-in failed." }, { status: 400 });
  }

  const intervalMs = row.poll_interval_seconds * 1000;
  if (row.last_polled_at != null && now - row.last_polled_at < intervalMs) {
    const nextInterval = row.poll_interval_seconds + DEVICE_SLOW_DOWN_INCREMENT_SECONDS;
    await env.DB.prepare("update device_authorizations set last_polled_at = ?, poll_interval_seconds = ? where device_code = ?")
      .bind(now, nextInterval, deviceCode)
      .run();
    return json({ error: "slow_down", interval: nextInterval }, { status: 400 });
  }
  await env.DB.prepare("update device_authorizations set last_polled_at = ? where device_code = ?")
    .bind(now, deviceCode)
    .run();

  if (row.status === "pending") {
    return json({ error: "authorization_pending", interval: row.poll_interval_seconds }, { status: 400 });
  }
  if (!row.access_token || !row.expires_in) {
    return json({ error: "server_error" }, { status: 500 });
  }

  let oauthIssuer: string;
  try {
    oauthIssuer = normalizeIssuer(env.CLERK_ISSUER);
  } catch {
    return json({ error: "server_error" }, { status: 500 });
  }
  const oauthClientId = env.CLERK_OAUTH_CLIENT_ID.trim();
  if (!oauthClientId) return json({ error: "server_error" }, { status: 500 });

  const approvedToken = {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    token_type: row.token_type ?? "Bearer",
    expires_in: row.approved_at == null
      ? row.expires_in
      : Math.max(1, Math.ceil((row.approved_at + row.expires_in * 1000 - now) / 1000)),
    oauth_issuer: oauthIssuer,
    oauth_client_id: oauthClientId,
  };

  const consumed = await env.DB.prepare(`
    update device_authorizations
       set status = 'consumed', consumed_at = ?, access_token = null, refresh_token = null
     where device_code = ? and device_secret_hash = ? and status = 'approved'
  `).bind(now, deviceCode, suppliedSecretHash).run();
  if (changes(consumed) < 1) return json({ error: "invalid_grant" }, { status: 401 });
  return json(approvedToken);
}

export async function handleDeviceAuthorizationRequest(
  request: Request,
  env: DeviceAuthorizationEnv,
  options: DeviceAuthorizationRequestOptions = {},
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const resolved = {
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
    randomBytes: options.randomBytes ?? defaultRandomBytes,
  };
  if (pathname === "/device/code") return handleDeviceCode(request, env, resolved);
  if (pathname === "/device") return handleDeviceApproval(request, env, resolved);
  if (pathname === "/device/callback") return handleDeviceCallback(request, env, resolved);
  if (pathname === "/device/token") return handleDeviceToken(request, env, resolved);
  return null;
}

export const deviceAuthorizationInternals = {
  APPROVAL_RATE_LIMIT_MAX_ATTEMPTS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  normalizeUserCode,
};
