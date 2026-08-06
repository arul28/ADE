/**
 * The small vocabulary `attention.ts` and `liveActivity.ts` both need: the
 * environment shape, the parsed wire item, the text bounds, and the handful of
 * pure helpers that enforce them.
 *
 * This exists so the Live Activity module could be lifted out of a 4,400-line
 * file without either half importing the other. Keep it boring: types, bounds,
 * and pure functions. Anything that touches D1, APNs, or a request belongs in
 * one of the two modules that import this.
 */
import type { ApnsKeyConfig } from "./apns";

export type AttentionRelayEnv = {
  DB: D1Database;
  CLERK_JWKS_URL?: string;
  CLERK_ISSUER?: string;
  CLERK_OAUTH_CLIENT_ID?: string;
  CLERK_SECONDARY_JWKS_URL?: string;
  CLERK_SECONDARY_ISSUER?: string;
  CLERK_SECONDARY_OAUTH_CLIENT_ID?: string;
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_DEFAULT_TOPIC?: string;
  /**
   * REQUIRED for the machine re-pair route. Shared secret proving a request
   * came from the account-directory worker. See `assertDirectoryProvenance`.
   */
  DIRECTORY_AUTH_SECRET?: string;
};

export type AttentionDeviceRow = {
  device_id: string;
  apns_token: string | null;
  push_to_start_token: string | null;
  bundle_id: string;
  aps_environment: string;
  preferences_json: string;
  generation: string;
};

export type OwnedAttentionDeviceRow = AttentionDeviceRow & {
  ownership_epoch: number;
};

export type ParsedAttentionItem = Record<string, unknown> & {
  contractVersion: 1;
  id: string;
  revision: number;
  fingerprint: string;
  contentFingerprint: string;
  alertFingerprint: string;
  activityTier?: "signal" | "ambient" | "idle";
  // Optional and additive. The `AttentionPhase` vocabulary is frozen push wire,
  // so "planning" could not be added to it; the publisher stamps this instead.
  // Absent means "not planning" — planning is NEVER inferred from a phase.
  chatActivityMode?: "planning";
  kind: "agent" | "pull_request";
  eventKind: string;
  phase: string;
  title: string;
  preview: string;
  privacyPreview: string;
  updatedAt: string;
  expiresAt: string | null;
  machine: Record<string, unknown> & { machineKey: string; name: string };
  project: {
    projectId: string;
    /**
     * The publisher's machine-independent id for the project
     * (`deriveProjectId(rootPath)`). It has to survive the relay: `projectId`
     * is a per-machine `randomUUID()` that resolves nowhere but the machine
     * that minted it, so an account-scope reader opening an item from another
     * machine — and every deep link built from one — depends on this field.
     * Optional because an older publisher omits it.
     */
    canonicalId: string | null;
    name: string;
    rootPath: string | null;
  };
  destination: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
};

export const MAX_ID_LENGTH = 256;
export const MAX_TITLE_LENGTH = 180;
export const MAX_PREVIEW_LENGTH = 320;
export const MAX_DETAIL_LENGTH = 1_000;
export const LIVE_ACTIVITY_START_CLAIM_TTL_MS = 30_000;

export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function requiredString(value: unknown, maxLength = MAX_ID_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

export function optionalIsoDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const normalized = requiredString(value, 64);
  if (!normalized || Number.isNaN(Date.parse(normalized))) return undefined;
  return new Date(normalized).toISOString();
}

export function boundedText(value: unknown, maxLength: number): string | null {
  const text = requiredString(value, maxLength * 4);
  if (!text) return null;
  const sanitized = text
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.slice(0, maxLength);
}

export function apnsConfig(env: AttentionRelayEnv): ApnsKeyConfig | null {
  const keyPem = env.APNS_KEY?.trim() ?? "";
  const keyId = env.APNS_KEY_ID?.trim() ?? "";
  const teamId = env.APNS_TEAM_ID?.trim() ?? "";
  return keyPem && keyId && teamId ? { keyPem, keyId, teamId } : null;
}

export function logAttentionDeliveryError(
  surface: "notification" | "live_activity",
  deviceId: string,
  error: unknown,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      svc: "ade-push-relay",
      kind: "attention_delivery_error",
      surface,
      device: deviceId.slice(-6),
      reason: reason.slice(0, 500),
    }));
  } catch {
    console.error("ade-push-relay attention_delivery_error");
  }
}

export function readPreferences(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function preferenceBoolean(
  device: Record<string, unknown>,
  account: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  if (typeof device[key] === "boolean") return device[key];
  if (typeof account[key] === "boolean") return account[key];
  return fallback;
}

export function preferenceNumber(
  device: Record<string, unknown>,
  account: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  if (typeof device[key] === "number" && Number.isFinite(device[key])) return device[key];
  if (typeof account[key] === "number" && Number.isFinite(account[key])) return account[key];
  return fallback;
}
