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

/**
 * The account-scoped stores (`accountSettings.ts`, `accountVault.ts`) share a
 * shape: one row per (scope, key…) per account, ordered by `updated_at`, read a
 * page at a time with a resumable cursor, and guarded by a per-account ceiling.
 * The pieces below are that shape, held in one place so the two modules cannot
 * drift apart — the cursor in particular is easy to get subtly, silently wrong.
 */

export const ACCOUNT_SCOPE_KEY_MAX_LENGTH = 512;

/**
 * `scope_key` is opaque to this Worker, but not arbitrary: it is either
 * "everything" or a normalized repository identity. Validating the shape stops
 * a client inventing a third axis the rest of ADE cannot read, and keeps the
 * column joinable later.
 */
export function parseAccountScopeKey(value: unknown): string | null {
  const scope = requiredString(value, ACCOUNT_SCOPE_KEY_MAX_LENGTH);
  if (!scope) return null;
  if (scope === "all") return scope;
  if (scope.startsWith("repo:") && scope.length > "repo:".length) return scope;
  return null;
}

/**
 * Where a page resumes from. `keys` are the tiebreak columns' values for the
 * last row of the previous page, in the same order the query sorts them.
 *
 * `keys: null` is a legacy cursor — a bare ISO stamp minted before the tiebreak
 * existed. It resumes as a plain `updated_at > stamp`, which is what it always
 * meant. Accepted for one release so an in-flight client is not stranded.
 */
export type AccountPageCursor = { updatedAt: string; keys: string[] | null };

function toBase64Url(text: string): string {
  let binary = "";
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Opaque on purpose: a client that parses a cursor is a client that breaks the
 * next time the tiebreak changes. Base64url so it survives a bare `?since=`
 * with no escaping, which is how every caller writes it.
 */
export function encodeAccountCursor(cursor: AccountPageCursor): string {
  return toBase64Url(JSON.stringify({ v: 1, t: cursor.updatedAt, k: cursor.keys ?? [] }));
}

export function decodeAccountCursor(raw: string | null | undefined): AccountPageCursor | null {
  const value = raw?.trim();
  if (!value) return null;
  const decoded = fromBase64Url(value);
  if (decoded) {
    try {
      const parsed: unknown = JSON.parse(decoded);
      if (
        isRecord(parsed) && parsed.v === 1 && typeof parsed.t === "string"
        && !Number.isNaN(Date.parse(parsed.t)) && Array.isArray(parsed.k)
        && parsed.k.every((entry) => typeof entry === "string")
      ) {
        return { updatedAt: new Date(parsed.t).toISOString(), keys: parsed.k as string[] };
      }
    } catch {
      // Not a composite cursor. Fall through to the legacy stamp reading.
    }
  }
  if (Number.isNaN(Date.parse(value))) return null;
  return { updatedAt: new Date(value).toISOString(), keys: null };
}

/** Reads `?since=` as either a composite cursor or a legacy bare ISO stamp. */
export function parseSinceParam(url: URL): AccountPageCursor | null {
  return decodeAccountCursor(url.searchParams.get("since"));
}

/**
 * Strictly-after in lexicographic order over `columns`, expanded rather than
 * written as an SQL row value so the statement does not depend on how the
 * engine handles `(a, b) > (?, ?)`.
 */
function lexicographicallyAfter(
  columns: string[],
  values: string[],
): { sql: string; bindings: string[] } {
  const clauses: string[] = [];
  const bindings: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const terms: string[] = [];
    for (let prior = 0; prior < index; prior += 1) {
      terms.push(`${columns[prior]} = ?`);
      bindings.push(values[prior]!);
    }
    terms.push(`${columns[index]} > ?`);
    bindings.push(values[index]!);
    clauses.push(`(${terms.join(" and ")})`);
  }
  return { sql: `(${clauses.join(" or ")})`, bindings };
}

/**
 * The `where`/`order by`/bindings for one page of an account-scoped store.
 *
 * `keyColumns` are the tiebreak columns after `updated_at`. They must be the
 * table's remaining primary-key columns: ordering by `updated_at` alone is not
 * a total order, and rows that share a stamp across a page boundary are then
 * skipped forever — the page ends mid-stamp and the next page asks for
 * `updated_at > stamp`, which excludes the rest of them.
 */
export function buildAccountPageQuery(options: {
  userId: string;
  cursor: AccountPageCursor | null;
  scope: string | null;
  keyColumns: string[];
  limit: number;
}): { where: string; orderBy: string; bindings: unknown[] } {
  const { userId, cursor, scope, keyColumns, limit } = options;
  const conditions = ["user_id = ?"];
  const bindings: unknown[] = [userId];
  if (cursor) {
    if (cursor.keys && cursor.keys.length === keyColumns.length) {
      const after = lexicographicallyAfter(["updated_at", ...keyColumns], [
        cursor.updatedAt,
        ...cursor.keys,
      ]);
      conditions.push(after.sql);
      bindings.push(...after.bindings);
    } else {
      // Strictly greater than: a client passes back the newest stamp it holds,
      // and re-sending that row every beat would make an idle account pay for a
      // pull forever.
      conditions.push("updated_at > ?");
      bindings.push(cursor.updatedAt);
    }
  }
  if (scope) {
    conditions.push("scope_key = ?");
    bindings.push(scope);
  }
  bindings.push(limit + 1);
  return {
    where: conditions.join(" and "),
    orderBy: ["updated_at", ...keyColumns].join(" asc, ") + " asc",
    bindings,
  };
}

/**
 * Splits the `limit + 1` rows the page query asked for into the page itself,
 * the explicit `truncated` flag, and the cursor to resume from.
 *
 * `truncated` is explicit rather than inferred from the page being full: a
 * client that guesses will either loop forever on an exactly-full page or stop
 * early on the next one.
 */
export function accountPageResult<T extends Record<string, unknown>>(
  results: T[],
  options: {
    limit: number;
    keyColumns: string[];
    cursor: AccountPageCursor | null;
  },
): { page: T[]; truncated: boolean; cursor: string | null } {
  const page = results.slice(0, options.limit);
  const last = page[page.length - 1];
  const next: AccountPageCursor | null = last
    ? {
      updatedAt: String(last.updated_at),
      keys: options.keyColumns.map((column) => String(last[column] ?? "")),
    }
    : options.cursor;
  return {
    page,
    truncated: results.length > options.limit,
    cursor: next ? encodeAccountCursor(next) : null,
  };
}

/**
 * The per-account ceiling, counted before the write and only against what the
 * batch would add. An account at the ceiling can still change what it already
 * has, because the count cannot tell an update from an insert and refusing both
 * would strand a user at their own limit.
 */
export async function countAndGuard(options: {
  env: AttentionRelayEnv;
  table: string;
  userId: string;
  adding: number;
  ceiling: number;
}): Promise<boolean> {
  const existing = await options.env.DB
    .prepare(`select count(*) as count from ${options.table} where user_id = ?`)
    .bind(options.userId)
    .first<{ count: number }>();
  return (existing?.count ?? 0) + options.adding > options.ceiling;
}
