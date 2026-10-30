/**
 * `POST /webhooks/clerk` — Clerk's `user.created` and `user.deleted` webhooks,
 * turned into one `ade_signed_up` / `ade_account_deleted` PostHog event per
 * account.
 *
 * Sign-up happens on Clerk's own pages, so no ADE app sees it; this is the one
 * place that sees every sign-up exactly once. The event goes out under the same
 * distinct id every ADE client identifies with (`ade_user_` + a hash of the
 * Clerk user id, `identifyAccount` in productAnalyticsService.ts and
 * ProductAnalytics.swift), so it lands on the person those clients build.
 *
 * Clerk delivers through Svix: the request is signed with
 * `CLERK_WEBHOOK_SIGNING_SECRET`. The event uuid is derived from the Clerk
 * user id (`signupEventUuid`, `accountDeletedEventUuid`), so a retried
 * delivery and `scripts/analytics/reconcile-signups.mjs`, which backfills
 * sign-ups the webhook missed, all produce the same uuid for one account and
 * PostHog keeps one copy. Every other Clerk event type is acknowledged and
 * ignored.
 *
 * Test and internal accounts carry `ade_internal: true` in their Clerk
 * private or public metadata; the sign-up then carries `is_internal: true`
 * (event property and person property) so dashboards can leave them out.
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

/** A stable v4-shaped uuid from a seed string. */
async function uuidFromSeed(seed: string): Promise<string> {
  const chars = (await sha256Hex(seed)).slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * The `ade_signed_up` uuid for one account. The webhook, its retries and the
 * reconcile backfill (`scripts/analytics/reconcile-signups.mjs`, which copies
 * this) all derive the same one, so PostHog keeps one sign-up per account.
 * PostHog deduplicates on uuid, distinct id, event and the event's day, so
 * the timestamp must also stay Clerk's `created_at` everywhere.
 */
export function signupEventUuid(userId: string): Promise<string> {
  return uuidFromSeed(`ade-signed-up-v1:${userId}`);
}

/** The `ade_account_deleted` uuid for one account, same idea as `signupEventUuid`. */
export function accountDeletedEventUuid(userId: string): Promise<string> {
  return uuidFromSeed(`ade-account-deleted-v1:${userId}`);
}

type ClerkUserData = {
  id?: unknown;
  created_at?: unknown;
  deleted?: unknown;
  external_accounts?: Array<{ provider?: unknown }>;
  password_enabled?: unknown;
  private_metadata?: unknown;
  public_metadata?: unknown;
};

type ClerkUserEvent = {
  type?: unknown;
  /** When Clerk created the event (ms); the same on every retry. */
  timestamp?: unknown;
  data?: ClerkUserData;
};

/**
 * Whether an account is ADE's own (tests, smoke users, the team):
 * `ade_internal: true` in its Clerk private or public metadata.
 */
export function isInternalAccount(data: Pick<ClerkUserData, "private_metadata" | "public_metadata"> | undefined): boolean {
  const flagged = (metadata: unknown): boolean =>
    typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>).ade_internal === true;
  return flagged(data?.private_metadata) || flagged(data?.public_metadata);
}

/** `google`, `github`, … for an OAuth sign-up; `email` otherwise. Never the address. */
export function signupMethod(data: ClerkUserData | undefined): string {
  const provider = data?.external_accounts?.[0]?.provider;
  if (typeof provider === "string") {
    const name = provider.replace(/^oauth_/, "").toLowerCase();
    return SIGNUP_METHODS.has(name) ? name : "other_oauth";
  }
  return "email";
}

/** The body as text, or null past `MAX_BODY_BYTES`; stops reading once it is over. */
async function readBoundedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
  const body = await readBoundedBody(request);
  if (body === null) return json(413, { error: "too_large" });
  const verified = await verifySvixSignature({
    secret,
    id,
    timestamp,
    body,
    signatureHeader,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verified) return json(401, { error: "bad_signature" });

  let payload: ClerkUserEvent;
  try {
    payload = JSON.parse(body) as ClerkUserEvent;
  } catch {
    return json(400, { error: "bad_json" });
  }
  if (payload.type !== "user.created" && payload.type !== "user.deleted") return json(200, { ignored: true });
  const userId = typeof payload.data?.id === "string" ? payload.data.id.trim() : "";
  if (!userId || userId.length > 512) return json(400, { error: "bad_user" });

  const distinctId = await accountDistinctId(userId);
  let capture: Record<string, unknown>;
  if (payload.type === "user.created") {
    const createdAtMs = typeof payload.data?.created_at === "number" ? payload.data.created_at : null;
    const signedUpAt = createdAtMs ? new Date(createdAtMs).toISOString() : null;
    const isInternal = isInternalAccount(payload.data);
    capture = {
      api_key: token,
      distinct_id: distinctId,
      event: "ade_signed_up",
      uuid: await signupEventUuid(userId),
      ...(signedUpAt ? { timestamp: signedUpAt } : {}),
      properties: {
        signup_method: signupMethod(payload.data),
        client: "account",
        interactive: true,
        is_internal: isInternal,
        $set: { is_internal: isInternal },
        $set_once: { clerk_user_id: userId, signed_up_at: signedUpAt },
        $geoip_disable: true,
      },
    };
  } else {
    // Clerk's deleted payload is `{ id, object, deleted: true }`: no metadata
    // and no created_at. The event's own timestamp is the same on a retry, so
    // the retry lands on the same day and PostHog still keeps one.
    const eventMs = typeof payload.timestamp === "number" ? payload.timestamp : null;
    capture = {
      api_key: token,
      distinct_id: distinctId,
      event: "ade_account_deleted",
      uuid: await accountDeletedEventUuid(userId),
      ...(eventMs ? { timestamp: new Date(eventMs).toISOString() } : {}),
      properties: {
        client: "account",
        interactive: true,
        $geoip_disable: true,
      },
    };
  }
  const host = (env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "");
  const response = await fetch(`${host}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(capture),
  });
  // A failed capture asks Clerk to deliver again; the uuid keeps it one event.
  if (!response.ok) return json(502, { error: "capture_failed" });
  // Over its quota PostHog answers 200 and drops the event; Clerk retries for
  // about three days, which usually outlasts it.
  const result = (await response.json().catch(() => null)) as { quota_limited?: unknown } | null;
  if (Array.isArray(result?.quota_limited) && result.quota_limited.length > 0) {
    return json(503, { error: "capture_quota_limited" });
  }
  return json(200, { captured: true });
}
