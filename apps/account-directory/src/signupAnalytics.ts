/**
 * `POST /webhooks/clerk` — Clerk's `user.created` webhook, turned into one
 * `ade_signed_up` PostHog event per account.
 *
 * Sign-up happens on Clerk's own pages, so no ADE app sees it; this is the one
 * place that sees every sign-up exactly once. The event goes out under the same
 * distinct id every ADE client identifies with (`ade_user_` + a hash of the
 * Clerk user id, `identifyAccount` in productAnalyticsService.ts and
 * ProductAnalytics.swift), so it lands on the person those clients build.
 *
 * Clerk delivers through Svix: the request is signed with
 * `CLERK_WEBHOOK_SIGNING_SECRET`, and a retried delivery keeps its `svix-id`,
 * which becomes the event's uuid so PostHog keeps one copy. Every other Clerk
 * event type is acknowledged and ignored.
 *
 * Both `CLERK_WEBHOOK_SIGNING_SECRET` and `POSTHOG_PROJECT_TOKEN` must be set;
 * without either the route answers 503 and Clerk keeps retrying for a while.
 */

export type SignupAnalyticsEnv = {
  CLERK_WEBHOOK_SIGNING_SECRET?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
};

const ROUTE = "/webhooks/clerk";
const MAX_BODY_BYTES = 64 * 1024;
/** Svix's own replay window. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const SIGNUP_METHODS = new Set(["google", "github", "apple", "microsoft", "gitlab", "discord", "linear"]);

export function isSignupAnalyticsRequest(url: URL): boolean {
  return url.pathname === ROUTE;
}

const textEncoder = new TextEncoder();

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** Svix: HMAC-SHA256 over `${id}.${timestamp}.${body}`, any `v1,` signature in the header may match. */
export async function verifySvixSignature(args: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
  nowSeconds: number;
}): Promise<boolean> {
  const timestamp = Number(args.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(args.nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return false;
  }
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(args.secret.replace(/^whsec_/, ""));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToBase64(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(`${args.id}.${args.timestamp}.${args.body}`)),
  );
  return args.signatureHeader
    .split(" ")
    .map((part) => part.split(",", 2))
    .some(([version, signature]) => version === "v1" && typeof signature === "string" && constantTimeEqual(signature, expected));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The id every ADE client identifies an account with. Keep in step with `identifyAccount`. */
export async function accountDistinctId(userId: string): Promise<string> {
  return `ade_user_${(await sha256Hex(`ade-product-analytics-account-v1:${userId}`)).slice(0, 32)}`;
}

/** A stable v4-shaped uuid from the delivery id, so a retried delivery is one event. */
async function deliveryUuid(svixId: string): Promise<string> {
  const chars = (await sha256Hex(`ade-signup:${svixId}`)).slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

type ClerkUserCreated = {
  type?: unknown;
  data?: {
    id?: unknown;
    created_at?: unknown;
    external_accounts?: Array<{ provider?: unknown }>;
    password_enabled?: unknown;
  };
};

/** `google`, `github`, … for an OAuth sign-up; `email` otherwise. Never the address. */
export function signupMethod(data: ClerkUserCreated["data"]): string {
  const provider = data?.external_accounts?.[0]?.provider;
  if (typeof provider === "string") {
    const name = provider.replace(/^oauth_/, "").toLowerCase();
    return SIGNUP_METHODS.has(name) ? name : "other_oauth";
  }
  return "email";
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleSignupAnalyticsRequest(
  request: Request,
  env: SignupAnalyticsEnv,
): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const secret = env.CLERK_WEBHOOK_SIGNING_SECRET?.trim();
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!secret || !token || !/^phc_[A-Za-z0-9_-]{8,}$/.test(token)) return json(503, { error: "not_configured" });

  const id = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp") ?? "";
  const signatureHeader = request.headers.get("svix-signature") ?? "";
  if (!id || !timestamp || !signatureHeader) return json(400, { error: "missing_signature" });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  const verified = await verifySvixSignature({
    secret,
    id,
    timestamp,
    body,
    signatureHeader,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified) return json(401, { error: "bad_signature" });

  let payload: ClerkUserCreated;
  try {
    payload = JSON.parse(body) as ClerkUserCreated;
  } catch {
    return json(400, { error: "bad_json" });
  }
  if (payload.type !== "user.created") return json(200, { ignored: true });
  const userId = typeof payload.data?.id === "string" ? payload.data.id.trim() : "";
  if (!userId || userId.length > 512) return json(400, { error: "bad_user" });

  const createdAtMs = typeof payload.data?.created_at === "number" ? payload.data.created_at : null;
  const host = (env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "");
  const capture = {
    api_key: token,
    distinct_id: await accountDistinctId(userId),
    event: "ade_signed_up",
    uuid: await deliveryUuid(id),
    ...(createdAtMs ? { timestamp: new Date(createdAtMs).toISOString() } : {}),
    properties: {
      signup_method: signupMethod(payload.data),
      client: "account",
      interactive: true,
      $set_once: { clerk_user_id: userId, signed_up_at: createdAtMs ? new Date(createdAtMs).toISOString() : null },
      $geoip_disable: true,
    },
  };
  const response = await fetch(`${host}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(capture),
  });
  // A failed capture asks Clerk to deliver again; the uuid keeps it one event.
  if (!response.ok) return json(502, { error: "capture_failed" });
  return json(200, { captured: true });
}
