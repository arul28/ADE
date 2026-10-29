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

export type ActivityBoardColumn = "needs_you" | "working" | "waiting" | "done";
export type ActivityWaitingReason = "snoozed" | "ci" | "review" | "scheduled" | "subagent";

export const ACTIVITY_BOARD_COLUMNS: readonly ActivityBoardColumn[] = [
  "needs_you",
  "working",
  "waiting",
  "done",
];

export function isActivityBoardColumn(value: unknown): value is ActivityBoardColumn {
  return typeof value === "string"
    && (ACTIVITY_BOARD_COLUMNS as readonly string[]).includes(value);
}

export function isActivityWaitingReason(value: unknown): value is ActivityWaitingReason {
  return value === "snoozed"
    || value === "ci"
    || value === "review"
    || value === "scheduled"
    || value === "subagent";
}

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
  // Optional and additive: the Work-board column the publishing brain computed
  // for an agent item, and why it waits. Absent from older publishers; readers
  // then derive a column from the phase (`activityBoardColumn`).
  boardColumn?: ActivityBoardColumn;
  waitingReason?: ActivityWaitingReason;
  // `message` is a note an agent sent because the user asked to be told
  // (`ade notify` from a chat). Only clients that ask for it receive it; see
  // `snapshotIncludesMessages`.
  kind: "agent" | "pull_request" | "message";
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
 * Stale-write protection for account settings and vault writes.
 *
 * A machine that was offline (or stuck) for days still holds the writes it
 * queued then. Sent now, last-to-arrive-wins would let an eight-day-old value
 * replace a newer one, and for a rotating credential (Linear's refresh token)
 * that signs every machine out. So a client that opts in (`itemResults: true`)
 * tells the Worker when each write was made (`writtenAt`) and when it sent the
 * request (`sentAt`), both on its own clock; the Worker moves `writtenAt` onto
 * its clock by the difference between `sentAt` and its own time, and refuses
 * that one item (never the batch) when the stored row is newer.
 *
 * Correcting by `sentAt` instead of trusting `writtenAt` keeps a machine with a
 * wrong date from losing (or winning) every conflict. The tolerance absorbs the
 * request's own latency: two edits that close together still resolve as before,
 * by arrival.
 */
export const WRITE_CONFLICT_TOLERANCE_MS = 5_000;

/** A threshold no stored stamp reaches: the write is never refused as stale. */
const NO_CONFLICT_CHECK = "9999-12-31T23:59:59.999Z";

export type WriteClock = { nowMs: number; offsetMs: number };

function parseClientTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** This request's correction from the client's clock to the Worker's. */
export function writeClock(sentAt: unknown, nowMs = Date.now()): WriteClock {
  const sent = parseClientTime(sentAt);
  return { nowMs, offsetMs: sent === null ? 0 : nowMs - sent };
}

/**
 * The newest stored `updated_at` a write made at `writtenAt` may still replace.
 * A stored row stamped later than this was written after this write was made.
 * Without a `writtenAt`, nothing is refused (the behaviour before the check).
 */
export function staleWriteThreshold(clock: WriteClock, writtenAt: unknown): string {
  const written = parseClientTime(writtenAt);
  if (written === null) return NO_CONFLICT_CHECK;
  const onWorkerClock = Math.min(clock.nowMs, written + clock.offsetMs);
  return new Date(onWorkerClock + WRITE_CONFLICT_TOLERANCE_MS).toISOString();
}

/** `decodeURIComponent` that answers null for a malformed escape instead of throwing. */
export function decodePathSegment(value: string | undefined): string | null {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    return null;
  }
}

/** One item's verdict in an account write: what to write, or a plain reason it cannot be. */
export type AccountItemVerdict<TWrite> = { ok: true; write: TWrite } | { ok: false; reason: string };

/**
 * One item's outcome in an `itemResults` write, in request order. `stale`
 * carries the stored row so the client can adopt it: the client skipped that
 * key while its own write was queued, so its pull cursor is already past it.
 */
export type AccountWriteResult<TRow> =
  | { status: "written" }
  | { status: "rejected"; reason: string }
  | { status: "stale"; current: TRow | null };

/** The answer for an item that never reached the database: refused, or (when ok) written. */
export function accountRefusalResult<TWrite>(
  verdict: AccountItemVerdict<TWrite>,
): { status: "written" } | { status: "rejected"; reason: string } {
  return verdict.ok ? { status: "written" } : { status: "rejected", reason: verdict.reason };
}

function changesOf(outcome: unknown): number {
  const changes = isRecord(outcome) && isRecord(outcome.meta) ? outcome.meta.changes : undefined;
  return typeof changes === "number" ? changes : 0;
}

/**
 * Per-item answers for an `itemResults` write. `outcomes` are the batch's
 * results for the accepted writes, in order; an upsert that changed nothing
 * lost its `where` to a newer stored row, so that item is `stale` and carries
 * the row `readCurrent` returns.
 */
export async function accountWriteResults<TWrite, TRow>(
  verdicts: ReadonlyArray<AccountItemVerdict<TWrite>>,
  outcomes: readonly unknown[],
  readCurrent: (write: TWrite) => Promise<TRow | null>,
): Promise<{ results: AccountWriteResult<TRow>[]; written: number }> {
  const results: AccountWriteResult<TRow>[] = [];
  let written = 0;
  let parsedIndex = 0;
  for (const verdict of verdicts) {
    if (!verdict.ok) {
      results.push(accountRefusalResult(verdict));
      continue;
    }
    const index = parsedIndex;
    parsedIndex += 1;
    if (changesOf(outcomes[index]) > 0) {
      written += 1;
      results.push({ status: "written" });
      continue;
    }
    results.push({ status: "stale", current: await readCurrent(verdict.write) });
  }
  return { results, written };
}

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
  /** Restrict the count, e.g. live rows only so tombstones do not fill the cap. */
  extraWhere?: string;
}): Promise<boolean> {
  const extra = options.extraWhere ?? "";
  const existing = await options.env.DB
    .prepare(`select count(*) as count from ${options.table} where user_id = ?${extra}`)
    .bind(options.userId)
    .first<{ count: number }>();
  return (existing?.count ?? 0) + options.adding > options.ceiling;
}

/**
 * The newest settings and vault change for an account, piggybacked on the
 * machine's publish response. A brain pulls settings or vault only when one of
 * these moved, instead of polling both every 30 s. Writes and deletes both
 * stamp a server-side updated_at, so tombstones move the mark too.
 *
 * A mark is `<max updated_at>#<rows at that instant>`: two requests can land
 * in the same millisecond, and the pull cursor orders by (updated_at, key), so
 * the count makes the second one move the mark too. Both parts are seeks on
 * (user_id, updated_at), reading only the rows at the newest instant.
 */
export async function accountChangeMarks(
  env: AttentionRelayEnv,
  userId: string,
): Promise<{ accountUserId: string; settings: string | null; vault: string | null }> {
  // `order by … desc limit 1`, not `max()`: inside a subquery D1 does not
  // apply the min/max shortcut and reads every row the user has (measured:
  // 1,001 rows for 1,000 settings, against 3 this way).
  const row = await env.DB.prepare(`
    select
      (select newest || '#' || (select count(*) from account_settings
                                 where user_id = ? and updated_at = newest)
         from (select updated_at as newest from account_settings
                where user_id = ? order by updated_at desc limit 1)) as settings,
      (select newest || '#' || (select count(*) from account_vault_items
                                 where user_id = ? and updated_at = newest)
         from (select updated_at as newest from account_vault_items
                where user_id = ? order by updated_at desc limit 1)) as vault
  `).bind(userId, userId, userId, userId).first<{ settings: string | null; vault: string | null }>();
  return { accountUserId: userId, settings: row?.settings ?? null, vault: row?.vault ?? null };
}
