// APNs HTTP/2 sender for Cloudflare Workers.
//
// Signs provider JWTs with the .p8 signing key (ES256 via WebCrypto) and sends
// pushes with fetch(), which speaks HTTP/2 to APNs from the Workers runtime.
// Apple requires provider tokens to be re-issued no more often than every
// 20 minutes and no less often than every 60; we cache per-isolate and
// refresh after 45 minutes.

export type ApnsKeyConfig = {
  /** Contents of the .p8 file (PKCS#8 PEM). */
  keyPem: string;
  /** 10-character APNs Key ID for the .p8. */
  keyId: string;
  /** Apple Developer Team ID. */
  teamId: string;
};

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsPushType = "alert" | "background" | "liveactivity";

export type ApnsSendArgs = {
  environment: ApnsEnvironment;
  deviceToken: string;
  topic: string;
  pushType: ApnsPushType;
  /** 10 = immediate, 5 = power-considerate. */
  priority: 10 | 5;
  /** Unix seconds after which APNs discards the push. 0 = deliver once, now. */
  expiration: number;
  collapseId?: string | null;
  payload: Record<string, unknown>;
};

export type ApnsSendResult = {
  ok: boolean;
  status: number;
  apnsId: string | null;
  /** APNs reason string on failure, e.g. "BadDeviceToken", "Unregistered". */
  reason: string | null;
  /** True when the device token is dead and its registration should be dropped. */
  tokenInvalid: boolean;
};

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

const JWT_REFRESH_AFTER_SECONDS = 45 * 60;
// Bound each APNs request so one hung HTTP/2 connection can't stall sequential
// per-device delivery (and the whole publish response) indefinitely.
const APNS_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_INVALID_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

const encoder = new TextEncoder();

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readPkcs8Der(keyPem: string): ArrayBuffer {
  const normalized = keyPem.replace(/\\n/g, "\n").trim();
  const match = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (!match) throw new Error("APNS_KEY must be the PKCS#8 PEM contents of the .p8 signing key.");
  const body = match[1]?.replace(/\s+/g, "") ?? "";
  return base64ToBytes(body).slice().buffer;
}

type CachedJwt = {
  cacheKey: string;
  token: string;
  issuedAtSeconds: number;
};

let cachedJwt: CachedJwt | null = null;

export async function createApnsJwt(config: ApnsKeyConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const cacheKey = `${config.teamId}:${config.keyId}`;
  if (cachedJwt && cachedJwt.cacheKey === cacheKey && nowSeconds - cachedJwt.issuedAtSeconds < JWT_REFRESH_AFTER_SECONDS) {
    return cachedJwt.token;
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    readPkcs8Der(config.keyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const payload = base64UrlEncode(JSON.stringify({ iss: config.teamId, iat: nowSeconds }));
  const signingInput = `${header}.${payload}`;
  // WebCrypto ECDSA emits IEEE P1363 (r||s), which is exactly the JOSE ES256
  // signature encoding — no DER conversion needed.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );
  const token = `${signingInput}.${base64UrlEncode(signature)}`;
  cachedJwt = { cacheKey, token, issuedAtSeconds: nowSeconds };
  return token;
}

/** Test hook: clears the per-isolate provider-token cache. */
export function resetApnsJwtCache(): void {
  cachedJwt = null;
}

export async function sendApnsPush(config: ApnsKeyConfig, args: ApnsSendArgs): Promise<ApnsSendResult> {
  const jwt = await createApnsJwt(config);
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": args.topic,
    "apns-push-type": args.pushType,
    "apns-priority": String(args.priority),
    "apns-expiration": String(Math.max(0, Math.floor(args.expiration))),
    "content-type": "application/json",
  };
  if (args.collapseId) headers["apns-collapse-id"] = args.collapseId.slice(0, 64);
  let response: Response;
  try {
    response = await fetch(`${APNS_HOSTS[args.environment]}/3/device/${encodeURIComponent(args.deviceToken)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args.payload),
      signal: AbortSignal.timeout(APNS_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeout or transport error — return a soft failure so the caller keeps
    // delivering to the remaining devices instead of aborting the whole publish.
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error";
    return { ok: false, status: 0, apnsId: null, reason, tokenInvalid: false };
  }
  const apnsId = response.headers.get("apns-id");
  if (response.ok) {
    return { ok: true, status: response.status, apnsId, reason: null, tokenInvalid: false };
  }
  let reason: string | null = null;
  try {
    const body = (await response.json()) as { reason?: unknown };
    reason = typeof body.reason === "string" ? body.reason : null;
  } catch {
    reason = null;
  }
  return {
    ok: false,
    status: response.status,
    apnsId,
    reason,
    tokenInvalid: response.status === 410 || (reason != null && TOKEN_INVALID_REASONS.has(reason)),
  };
}
