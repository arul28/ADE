/**
 * Mint short-lived Clerk session JWTs for push-relay deploy smokes.
 *
 * Production Clerk blocks POST /sessions. Development allows it. This helper
 * tries create-session first, then falls back to a one-shot sign-in token
 * redeemed through the Frontend API so a real session exists, then mints a
 * session JWT from that session. Tokens are never printed.
 */

const CLERK_API = "https://api.clerk.com/v1";
const SESSION_TOKEN_TTL_SECONDS = 10 * 60;
const SIGN_IN_TOKEN_TTL_SECONDS = 2 * 60;

export function fail(message) {
  console.error(`Push relay smoke-token mint failed: ${message}`);
  process.exit(1);
}

export function requiredEnv(name, env = process.env) {
  const value = env[name]?.trim() ?? "";
  if (!value) fail(`${name} is required`);
  return value;
}

export function frontendApiHostFromPublishableKey(publishableKey) {
  const match = publishableKey.trim().match(/^pk_(?:test|live)_([A-Za-z0-9+/=]+)$/);
  if (!match) {
    fail("Clerk publishable key is not a pk_test_ / pk_live_ value");
  }
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    fail("Clerk publishable key did not decode");
  }
  const host = decoded.replace(/\$+$/u, "").trim();
  if (!host || host.includes("/") || /\s/.test(host)) {
    fail("Clerk publishable key did not contain a Frontend API host");
  }
  return host;
}

function redactClerkBody(value) {
  if (value == null) return "";
  if (typeof value !== "object") return "[non-object]";
  const keys = Object.keys(value).sort();
  return keys.length > 0 ? keys.join(",") : "[empty]";
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function clerkBackend(secretKey, method, pathname, body) {
  const response = await fetch(`${CLERK_API}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
      "user-agent": "ade-push-relay-deploy-smoke-mint",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await readJson(response);
  return { ok: response.ok, status: response.status, payload };
}

function sessionJwtFromPayload(payload) {
  if (typeof payload?.jwt === "string" && payload.jwt.trim()) return payload.jwt.trim();
  if (typeof payload?.token === "string" && payload.token.trim()) return payload.token.trim();
  return "";
}

function createdSessionId(payload) {
  if (typeof payload?.id === "string" && payload.id.startsWith("sess_")) return payload.id;
  const nested = payload?.response?.created_session_id
    ?? payload?.client?.last_active_session_id
    ?? payload?.created_session_id;
  if (typeof nested === "string" && nested.startsWith("sess_")) return nested;
  const sessions = payload?.client?.sessions;
  if (Array.isArray(sessions)) {
    const id = sessions.find((session) => typeof session?.id === "string")?.id;
    if (typeof id === "string" && id.startsWith("sess_")) return id;
  }
  return "";
}

async function mintJwtFromSession(secretKey, sessionId) {
  const minted = await clerkBackend(
    secretKey,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/tokens`,
    { expires_in_seconds: SESSION_TOKEN_TTL_SECONDS },
  );
  if (!minted.ok) {
    fail(`session token mint returned HTTP ${minted.status} (${clerkErrorCodes(minted.payload)})`);
  }
  const jwt = sessionJwtFromPayload(minted.payload);
  if (!jwt) fail("session token mint returned no jwt");
  return jwt;
}

function clerkErrorCodes(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const codes = errors
    .map((error) => typeof error?.code === "string" ? error.code : "")
    .filter(Boolean);
  return codes.length > 0 ? codes.join(",") : redactClerkBody(payload);
}

function isCreateSessionBlocked(status) {
  return status === 400 || status === 403 || status === 422;
}

async function mintViaCreateSession(secretKey, userId) {
  const created = await clerkBackend(secretKey, "POST", "/sessions", { user_id: userId });
  if (created.status === 401) {
    fail(`create session returned HTTP 401 (${clerkErrorCodes(created.payload)})`);
  }
  if (created.status === 404) {
    fail(`create session returned HTTP 404 (${clerkErrorCodes(created.payload)})`);
  }
  if (!created.ok && isCreateSessionBlocked(created.status)) {
    return null;
  }
  if (!created.ok) {
    fail(`create session returned HTTP ${created.status} (${clerkErrorCodes(created.payload)})`);
  }
  const sessionId = createdSessionId(created.payload);
  if (!sessionId) fail("create session returned no session id");
  return mintJwtFromSession(secretKey, sessionId);
}

async function redeemSignInTicket(publishableKey, ticket) {
  const host = frontendApiHostFromPublishableKey(publishableKey);
  const response = await fetch(`https://${host}/v1/client/sign_ins`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${publishableKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "Clerk-JS-Version": "5.39.0",
      "user-agent": "ade-push-relay-deploy-smoke-mint",
    },
    body: new URLSearchParams({
      strategy: "ticket",
      ticket,
    }).toString(),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    fail(`sign-in ticket redeem returned HTTP ${response.status} (${clerkErrorCodes(payload)})`);
  }
  const sessionId = createdSessionId(payload);
  if (!sessionId) fail("sign-in ticket redeem returned no session id");
  return sessionId;
}

async function mintViaSignInTicket(secretKey, publishableKey, userId) {
  const token = await clerkBackend(secretKey, "POST", "/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: SIGN_IN_TOKEN_TTL_SECONDS,
  });
      if (!token.ok) {
    fail(`sign-in token create returned HTTP ${token.status} (${clerkErrorCodes(token.payload)})`);
  }
  const ticket = typeof token.payload?.token === "string" ? token.payload.token.trim() : "";
  if (!ticket) fail("sign-in token create returned no ticket");
  const sessionId = await redeemSignInTicket(publishableKey, ticket);
  return mintJwtFromSession(secretKey, sessionId);
}

export async function mintIssuerSmokeToken({ secretKey, publishableKey, userId, label }) {
  if (!secretKey?.trim()) fail(`${label} Clerk secret key is required`);
  if (!userId?.trim()) fail(`${label} smoke user id is required`);
  const created = await mintViaCreateSession(secretKey.trim(), userId.trim());
  if (created) return created;
  if (!publishableKey?.trim()) {
    fail(`${label} Clerk publishable key is required to mint a production session`);
  }
  return mintViaSignInTicket(secretKey.trim(), publishableKey.trim(), userId.trim());
}

export function smokeMintConfigFromEnv(env = process.env) {
  return {
    primary: {
      label: "primary",
      secretKey: env.CLERK_PROD_SECRET_KEY?.trim() || env.ADE_PUSH_RELAY_PRIMARY_CLERK_SECRET_KEY?.trim() || "",
      publishableKey:
        env.CLERK_PROD_PUBLISHABLE_KEY?.trim()
        || env.ADE_PUSH_RELAY_PRIMARY_CLERK_PUBLISHABLE_KEY?.trim()
        || "",
      userId: env.ADE_PUSH_RELAY_SMOKE_USER_ID?.trim() || "",
    },
    secondary: {
      label: "secondary",
      secretKey: env.CLERK_SECRET_KEY?.trim() || env.ADE_PUSH_RELAY_SECONDARY_CLERK_SECRET_KEY?.trim() || "",
      publishableKey:
        env.CLERK_PUBLISHABLE_KEY?.trim()
        || env.ADE_PUSH_RELAY_SECONDARY_CLERK_PUBLISHABLE_KEY?.trim()
        || "",
      userId: env.ADE_PUSH_RELAY_SECONDARY_SMOKE_USER_ID?.trim() || "",
    },
  };
}

export async function mintDeploySmokeTokens(env = process.env) {
  const config = smokeMintConfigFromEnv(env);
  if (!config.primary.userId) fail("ADE_PUSH_RELAY_SMOKE_USER_ID is required");
  if (!config.secondary.userId) fail("ADE_PUSH_RELAY_SECONDARY_SMOKE_USER_ID is required");
  const primary = await mintIssuerSmokeToken(config.primary);
  const secondary = await mintIssuerSmokeToken(config.secondary);
  return {
    ADE_PUSH_RELAY_SMOKE_TOKEN: primary,
    ADE_PUSH_RELAY_SECONDARY_SMOKE_TOKEN: secondary,
  };
}

export function applySmokeTokensToEnv(tokens, env = process.env) {
  env.ADE_PUSH_RELAY_SMOKE_TOKEN = tokens.ADE_PUSH_RELAY_SMOKE_TOKEN;
  env.ADE_PUSH_RELAY_SECONDARY_SMOKE_TOKEN = tokens.ADE_PUSH_RELAY_SECONDARY_SMOKE_TOKEN;
}
