import { SignJWT, importPKCS8 } from "jose";

export type FcmServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

export type FcmPush = {
  deviceToken: string;
  data: Record<string, string>;
  priority?: "normal" | "high";
  ttlSeconds?: number;
  collapseKey?: string | null;
};

export type FcmSendResult = {
  ok: boolean;
  status: number;
  messageId: string | null;
  reason: string | null;
  tokenInvalid: boolean;
};

type OAuthToken = { accessToken: string; expiresAt: number };
const tokenCache = new Map<string, OAuthToken>();

export function parseFcmServiceAccount(raw: string | null | undefined): FcmServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const projectId = typeof value.project_id === "string" ? value.project_id.trim() : "";
    const clientEmail = typeof value.client_email === "string" ? value.client_email.trim() : "";
    const privateKey = typeof value.private_key === "string" ? value.private_key.trim() : "";
    const tokenUri = typeof value.token_uri === "string"
      ? value.token_uri.trim()
      : "https://oauth2.googleapis.com/token";
    if (!projectId || !clientEmail || !privateKey || !tokenUri.startsWith("https://")) return null;
    return { projectId, clientEmail, privateKey, tokenUri };
  } catch {
    return null;
  }
}

async function accessToken(
  config: FcmServiceAccount,
  fetchFn: typeof fetch,
  nowMs: number,
): Promise<string> {
  const cached = tokenCache.get(config.clientEmail);
  if (cached && cached.expiresAt - 60_000 > nowMs) return cached.accessToken;
  const nowSeconds = Math.floor(nowMs / 1_000);
  const key = await importPKCS8(config.privateKey, "RS256");
  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(config.clientEmail)
    .setSubject(config.clientEmail)
    .setAudience(config.tokenUri)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3_600)
    .sign(key);
  const response = await fetchFn(config.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const value = typeof body.access_token === "string" ? body.access_token : "";
  if (!response.ok || !value) throw new Error(`FCM OAuth failed (${response.status})`);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3_600;
  tokenCache.set(config.clientEmail, {
    accessToken: value,
    expiresAt: nowMs + Math.max(60, expiresIn) * 1_000,
  });
  return value;
}

function fcmErrorCode(body: Record<string, unknown>): string | null {
  const error = body.error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const details = Array.isArray(record.details) ? record.details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const code = (detail as Record<string, unknown>).errorCode;
    if (typeof code === "string") return code;
  }
  return typeof record.status === "string" ? record.status : null;
}

export async function sendFcmPush(
  config: FcmServiceAccount,
  push: FcmPush,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<FcmSendResult> {
  try {
    const token = await accessToken(config, fetchFn, nowMs);
    const response = await fetchFn(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: push.deviceToken,
            data: push.data,
            android: {
              priority: push.priority ?? "high",
              ttl: `${Math.max(0, Math.trunc(push.ttlSeconds ?? 86_400))}s`,
              ...(push.collapseKey ? { collapse_key: push.collapseKey } : {}),
            },
          },
        }),
      },
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const errorCode = fcmErrorCode(body);
    return {
      ok: response.ok,
      status: response.status,
      messageId: response.ok && typeof body.name === "string" ? body.name : null,
      reason: response.ok ? null : errorCode ?? `HTTP ${response.status}`,
      tokenInvalid: errorCode === "UNREGISTERED",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      messageId: null,
      reason: error instanceof Error ? error.message : "FCM delivery failed",
      tokenInvalid: false,
    };
  }
}

export function clearFcmTokenCacheForTesting(): void {
  tokenCache.clear();
}
