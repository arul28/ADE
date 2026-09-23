import { logUsageResearchUpload } from "./logging";
import {
  clientIdentity,
  DAY_MS,
  dailyLimitVar,
  nonNegativeIntegerVar,
  quotaAddress,
  readBoundedBody,
  secondsUntilNextUtcDay,
  sha256Hex,
  utcDayKey,
} from "./sinkUtils";

/**
 * `POST /usage-research/daily` — one compact usage report per ADE install per
 * local day, kept so the owner can study how to build a model router.
 *
 * Like the diagnostics upload, the route is a write-only sink. It validates the
 * envelope strictly, then stores the `report` object re-serialized compactly
 * and never interprets it. Unlike diagnostics it writes to the SAME D1 database
 * as machines, device authorizations and pairing grants. A full D1 database
 * refuses every write, so sign-in and machine heartbeats would break first.
 * Every limit below exists to keep research data from ever filling the
 * database. The arithmetic is in the README, "Usage research reports".
 *
 * Four bounds, each enforced where a client cannot reach it:
 *
 * 1. Size: 32 KB per request body, counted as the stream arrives.
 * 2. Rows: the primary key is `(install_id, day)`, so a re-send REPLACES and
 *    nothing is ever stored twice. The accepted `day` window is at most nine
 *    UTC dates wide, and the retention sweep deletes rows older than
 *    `USAGE_RESEARCH_RETENTION_DAYS`.
 * 3. Writes: 20 per caller address per UTC day, and
 *    `USAGE_RESEARCH_DAILY_GLOBAL_LIMIT` for the whole fleet. Only writes that
 *    CHANGE a row count. An identical re-send is answered from a read and
 *    claims nothing (see `handleUsageResearchRequest`).
 * 4. Storage: `USAGE_RESEARCH_STORAGE_CEILING_MB` of stored bytes (each report
 *    plus a fixed per-row overhead), claimed against a running total before
 *    every write that grows the table. The write cap alone cannot bound
 *    storage: 20,000 new rows a day for 180 days at 32 KB is over 100 GB, ten
 *    times D1's per-database limit.
 *
 * The route takes no credentials. The senders post without an account token,
 * so the per-caller quota keys on the address alone.
 */

export type UsageResearchEnv = {
  /** Optional in the type so a Worker without the binding answers 503 instead of throwing. */
  DB?: D1Database;
  /** Writes the whole fleet may make per UTC day. `0` stops every write. */
  USAGE_RESEARCH_DAILY_GLOBAL_LIMIT?: string;
  /** Days of reports the cron sweep keeps, counted on the report's `day`. */
  USAGE_RESEARCH_RETENTION_DAYS?: string;
  /** Report bytes the table may hold in total. `0` stops every write that grows it. */
  USAGE_RESEARCH_STORAGE_CEILING_MB?: string;
};

export const USAGE_RESEARCH_DAILY_PATH = "/usage-research/daily";

export const USAGE_RESEARCH_SCHEMA_VERSION = 1;

/**
 * Hard cap on the WHOLE request body, the envelope included. Typical reports
 * are 4–12 KB. The client weighs its serialized body against this number, not
 * only the report inside it.
 */
export const MAX_USAGE_RESEARCH_BODY_BYTES = 32 * 1024;

/**
 * Bytes each stored row counts against the storage ceiling on top of its
 * report: the primary key, the envelope columns, the day-index entry and page
 * slack. Without it, a flood of tiny reports would fill pages the running
 * total never saw.
 */
export const USAGE_RESEARCH_ROW_OVERHEAD_BYTES = 256;

/** `appVersion`: 1 to this many printable ASCII characters. */
export const MAX_USAGE_RESEARCH_APP_VERSION_CHARS = 40;
/** `platform`: 1 to this many printable ASCII characters. */
export const MAX_USAGE_RESEARCH_PLATFORM_CHARS = 16;
/** `arch`: 1 to this many printable ASCII characters. */
export const MAX_USAGE_RESEARCH_ARCH_CHARS = 16;
/** `utcOffsetMinutes`: an integer from minus this to this (UTC−14 to UTC+14). */
export const MAX_USAGE_RESEARCH_UTC_OFFSET_MINUTES = 14 * 60;
/** `installId`: 32 lowercase hex characters. */
export const USAGE_RESEARCH_INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Every `error` code this route answers with. The desktop client mirrors the ones it acts on. */
export const USAGE_RESEARCH_ERRORS = {
  methodNotAllowed: "usage_research_method_not_allowed",
  unsupportedMediaType: "usage_research_unsupported_media_type",
  invalid: "usage_research_invalid",
  tooLarge: "usage_research_too_large",
  identityLimit: "usage_research_identity_limit",
  dailyLimit: "usage_research_daily_limit",
  storageFull: "usage_research_storage_full",
  unavailable: "usage_research_unavailable",
} as const;

/**
 * Writes one caller address may make per UTC day. A normal install writes once
 * a day and a backfill after a week offline writes up to seven, so twenty
 * leaves room for a few installs sharing one address (an office NAT) without
 * leaving room for a loop.
 */
export const MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY = 20;

/** Fleet-wide writes per UTC day when `USAGE_RESEARCH_DAILY_GLOBAL_LIMIT` is unset or unreadable. */
export const DEFAULT_USAGE_RESEARCH_DAILY_GLOBAL_LIMIT = 20_000;

/** Days of reports kept when `USAGE_RESEARCH_RETENTION_DAYS` is unset or unreadable. */
export const DEFAULT_USAGE_RESEARCH_RETENTION_DAYS = 180;

/**
 * Oldest local day the route accepts, in days before today. It covers a
 * seven-day backfill from an install that was offline for a week, plus one day
 * of slack for a client whose local "today" is behind UTC.
 */
export const USAGE_RESEARCH_MAX_REPORT_AGE_DAYS = 8;

/**
 * Retention is never shorter than the accepted window. Otherwise the sweep
 * could delete a day the route still accepts, and a backfill would re-insert it
 * every minute, spending budget on a row that cannot survive.
 */
export const MIN_USAGE_RESEARCH_RETENTION_DAYS = USAGE_RESEARCH_MAX_REPORT_AGE_DAYS + 1;

/** Upper clamp, so a typo like `1e9` cannot push the sweep cutoff outside `Date`'s range. */
export const MAX_USAGE_RESEARCH_RETENTION_DAYS = 3_650;

/**
 * Report bytes the table may hold when `USAGE_RESEARCH_STORAGE_CEILING_MB` is
 * unset or unreadable. On disk it is ~10–15% more for keys, the day index and
 * page slack. 4 GB of reports is about 4.6 GB on disk, inside the 5 GB of D1
 * storage the Workers Paid plan includes and under half of the 10 GB
 * per-database limit.
 */
export const DEFAULT_USAGE_RESEARCH_STORAGE_CEILING_MB = 4_096;

/**
 * The ceiling cannot be configured past this. 6 GB of reports is about 7 GB on
 * disk, which leaves 3 GB of the 10 GB database for everything else in it. A
 * typo in a var must never be what fills the database.
 */
export const MAX_USAGE_RESEARCH_STORAGE_CEILING_MB = 6_144;

/** Days of fleet-budget rows the sweep keeps (only today's is read; the rest is for support). */
export const USAGE_RESEARCH_BUDGET_RETENTION_DAYS = 7;

/**
 * Report rows the sweep deletes per cron tick. The cron runs every minute, so
 * the sweep can delete 720,000 rows a day, far above the 20,000 a day the fleet
 * cap lets in. Shortening retention on a full table still drains in days, and
 * no single tick holds the database long.
 */
export const USAGE_RESEARCH_SWEEP_BATCH_ROWS = 500;

const HOUR_MS = 3_600_000;
const MB = 1024 * 1024;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * The envelope's complete field list. Any other top-level key is a 400: the
 * envelope is versioned by `schemaVersion`, and `report` is the only place a
 * client may add fields without a version bump. A field this route ignored
 * would be data the client believes is stored and is not.
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "installId",
  "day",
  "appVersion",
  "platform",
  "arch",
  "utcOffsetMinutes",
  "report",
]);

const encoder = new TextEncoder();

export function isUsageResearchRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === USAGE_RESEARCH_DAILY_PATH;
}

/**
 * No CORS headers, on purpose. The senders are the desktop main process and the
 * CLI, and neither is a browser. `application/json` is not a CORS-safelisted
 * content type, and this route answers no preflight, so a web page cannot make
 * a visitor's browser write a report. A form or a `no-cors` fetch can only send
 * a safelisted type, which gets a 415.
 */
function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function isJsonContentType(value: string | null): boolean {
  return (value ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Same rule as `DIAGNOSTICS_DAILY_GLOBAL_LIMIT` (`dailyLimitVar`). An unset or
 * unreadable value falls back to the default, so a typo can neither uncap nor
 * close the route. `0` is honored: it is the kill switch.
 */
function dailyGlobalLimit(env: UsageResearchEnv): number {
  return dailyLimitVar(env.USAGE_RESEARCH_DAILY_GLOBAL_LIMIT, DEFAULT_USAGE_RESEARCH_DAILY_GLOBAL_LIMIT);
}

/** Unset or unreadable → 180. Anything else is clamped into [9, 3650], so `0` means "as short as is safe". */
export function usageResearchRetentionDays(env: Pick<UsageResearchEnv, "USAGE_RESEARCH_RETENTION_DAYS">): number {
  const configured = nonNegativeIntegerVar(env.USAGE_RESEARCH_RETENTION_DAYS);
  if (configured === null) return DEFAULT_USAGE_RESEARCH_RETENTION_DAYS;
  return Math.min(
    MAX_USAGE_RESEARCH_RETENTION_DAYS,
    Math.max(MIN_USAGE_RESEARCH_RETENTION_DAYS, configured),
  );
}

/** Unset or unreadable → 4096 MB; `0` stops growth; above 6144 MB is clamped to 6144. */
function storageCeilingBytes(env: UsageResearchEnv): number {
  const configured = nonNegativeIntegerVar(env.USAGE_RESEARCH_STORAGE_CEILING_MB)
    ?? DEFAULT_USAGE_RESEARCH_STORAGE_CEILING_MB;
  return Math.min(configured, MAX_USAGE_RESEARCH_STORAGE_CEILING_MB) * MB;
}

/**
 * The local days the route accepts, as UTC-date strings, inclusive.
 *
 * Local clocks run from UTC−12 to UTC+14, so "today" somewhere on Earth is at
 * most `utcDay(now + 14 h)` and at least `utcDay(now − 12 h)`. The window runs
 * from eight days before the earliest possible "today" to the latest possible
 * one. It is judged against UTC, not against the client's `utcOffsetMinutes`,
 * because that field is only as honest as the client.
 */
export function acceptedUsageResearchDays(nowMs: number): { earliest: string; latest: string } {
  return {
    earliest: utcDayKey(nowMs - 12 * HOUR_MS - USAGE_RESEARCH_MAX_REPORT_AGE_DAYS * DAY_MS),
    latest: utcDayKey(nowMs + 14 * HOUR_MS),
  };
}

/** `YYYY-MM-DD` that names a date that exists: no `2026-02-30`, no `2026-13-01`. */
function isCalendarDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A printable-ASCII label of 1..max characters, or null. */
function boundedLabel(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max && PRINTABLE_ASCII.test(value)
    ? value
    : null;
}

type UsageResearchReport = {
  installId: string;
  day: string;
  appVersion: string;
  platform: string;
  arch: string;
  utcOffsetMinutes: number;
  /** The client's `report` object, re-serialized compactly. */
  report: string;
  /** UTF-8 length of `report`. */
  reportBytes: number;
  /** What the row counts against the storage ceiling: `reportBytes` plus the per-row overhead. */
  storedBytes: number;
};

type ParseResult =
  | { ok: true; value: UsageResearchReport }
  | { ok: false; status: 400 | 413; reason: string };

function invalid(reason: string): ParseResult {
  return { ok: false, status: 400, reason };
}

/**
 * Strict envelope validation. The `reason` goes into the log line only, so a
 * client that drifts from the contract can be diagnosed without logging content.
 */
function parseUsageResearchBody(raw: string, nowMs: number): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid("malformed_json");
  }
  if (!isPlainObject(parsed)) return invalid("not_an_object");
  if (Object.keys(parsed).some((key) => !ENVELOPE_KEYS.has(key))) return invalid("unknown_field");
  if (parsed.schemaVersion !== USAGE_RESEARCH_SCHEMA_VERSION) return invalid("schema_version");

  const installId = parsed.installId;
  if (typeof installId !== "string" || !USAGE_RESEARCH_INSTALL_ID_PATTERN.test(installId)) {
    return invalid("install_id");
  }

  const day = parsed.day;
  if (typeof day !== "string" || !isCalendarDay(day)) return invalid("day");
  // Fixed-width ISO dates compare correctly as strings.
  const accepted = acceptedUsageResearchDays(nowMs);
  if (day < accepted.earliest || day > accepted.latest) return invalid("day_out_of_range");

  const appVersion = boundedLabel(parsed.appVersion, MAX_USAGE_RESEARCH_APP_VERSION_CHARS);
  if (appVersion === null) return invalid("app_version");
  const platform = boundedLabel(parsed.platform, MAX_USAGE_RESEARCH_PLATFORM_CHARS);
  if (platform === null) return invalid("platform");
  const arch = boundedLabel(parsed.arch, MAX_USAGE_RESEARCH_ARCH_CHARS);
  if (arch === null) return invalid("arch");

  const utcOffsetMinutes = parsed.utcOffsetMinutes;
  if (
    typeof utcOffsetMinutes !== "number"
    || !Number.isInteger(utcOffsetMinutes)
    || Math.abs(utcOffsetMinutes) > MAX_USAGE_RESEARCH_UTC_OFFSET_MINUTES
  ) {
    return invalid("utc_offset_minutes");
  }

  if (!isPlainObject(parsed.report)) return invalid("report");
  let report: string;
  try {
    report = JSON.stringify(parsed.report);
  } catch {
    // Nesting too deep for the serializer. The body cap keeps this rare, but it
    // is still the client's shape at fault, not ours.
    return invalid("report");
  }
  const reportBytes = byteLength(report);
  // Re-serializing can GROW a report (`1e20` is written back as twenty-one
  // digits), so the stored bytes are held to the same cap as the body.
  if (reportBytes > MAX_USAGE_RESEARCH_BODY_BYTES) {
    return { ok: false, status: 413, reason: "report_too_large" };
  }

  return {
    ok: true,
    value: {
      installId,
      day,
      appVersion,
      platform,
      arch,
      utcOffsetMinutes,
      report,
      reportBytes,
      storedBytes: reportBytes + USAGE_RESEARCH_ROW_OVERHEAD_BYTES,
    },
  };
}

/**
 * The per-caller quota key: a SHA-256 of the caller's address
 * (`cf-connecting-ip`, never a header the caller writes, and an IPv6 address
 * cut to its /64), salted with the UTC day.
 *
 * The day salt means no key can be joined across days. Rows are deleted once
 * their day ends. An address hash is still pseudonymous, not anonymous, because
 * IPv4 is small enough to enumerate, so the one-day retention is what actually
 * protects it.
 */
async function quotaIdentity(request: Request, dayKey: string): Promise<string> {
  return sha256Hex(`ade-usage-research:${dayKey}:${quotaAddress(clientIdentity(request))}`);
}

type Claim = "ok" | "exhausted" | "unavailable";

/**
 * Every claim below is one upsert whose `where` clause makes the check and the
 * increment a single statement, and `changes === 1` is the proof. A read
 * followed by a write lets two concurrent requests both take the last slot.
 * Every claim FAILS CLOSED, because a limit that is skipped whenever D1 errors
 * is not a limit.
 */
async function claimIdentitySlot(db: D1Database, dayKey: string, identity: string): Promise<Claim> {
  try {
    const result = await db.prepare(`
      insert into usage_research_identity_days (day, identity, writes)
      values (?, ?, 1)
      on conflict(day, identity) do update set writes = writes + 1
      where writes < ?
    `).bind(dayKey, identity, MAX_USAGE_RESEARCH_WRITES_PER_IDENTITY).run();
    return (result.meta?.changes ?? 0) === 1 ? "ok" : "exhausted";
  } catch {
    return "unavailable";
  }
}

async function claimFleetSlot(db: D1Database, dayKey: string, limit: number): Promise<Claim> {
  try {
    const result = await db.prepare(`
      insert into usage_research_days (day, writes)
      values (?, 1)
      on conflict(day) do update set writes = writes + 1
      where writes < ?
    `).bind(dayKey, limit).run();
    return (result.meta?.changes ?? 0) === 1 ? "ok" : "exhausted";
  } catch {
    return "unavailable";
  }
}

/**
 * Move the running byte total by `delta`, the new row's stored size minus the
 * stored size of the row it replaces. The move is refused when it would carry the
 * total past the ceiling.
 *
 * A write that does not grow the table (`delta <= 0`) is always allowed, even
 * over the ceiling, because it can only help. The totals row is seeded by the
 * migration. The upsert only re-creates it if someone deleted it by hand.
 */
async function claimStorage(db: D1Database, delta: number, ceilingBytes: number): Promise<Claim> {
  if (delta > 0 && ceilingBytes <= 0) return "exhausted";
  try {
    const result = await db.prepare(`
      insert into usage_research_totals (id, bytes)
      values (1, ?)
      on conflict(id) do update set bytes = bytes + ?
      where ? <= 0 or bytes + ? <= ?
    `).bind(Math.max(delta, 0), delta, delta, delta, ceilingBytes).run();
    return (result.meta?.changes ?? 0) === 1 ? "ok" : "exhausted";
  } catch {
    return "unavailable";
  }
}

/**
 * Give claims back when the write they were taken for did not happen, so a
 * refusal the caller did not cause cannot spend the caller's day or the
 * fleet's. The floors (`> 0`, `max(0, …)`) keep a stray refund from ever
 * creating budget nobody claimed. A failed refund is swallowed: the caller is
 * already being told the write failed, and a lost refund errs in the safe
 * direction, with one slot or a few KB of headroom spent early.
 */
async function refund(db: D1Database, sql: string, ...values: unknown[]): Promise<void> {
  try {
    await db.prepare(sql).bind(...values).run();
  } catch {
    // Best effort by design; see above.
  }
}

const REFUND_IDENTITY_SQL = `
  update usage_research_identity_days set writes = writes - 1
  where day = ? and identity = ? and writes > 0
`;
const REFUND_FLEET_SQL = `
  update usage_research_days set writes = writes - 1
  where day = ? and writes > 0
`;
const REFUND_STORAGE_SQL = `
  update usage_research_totals set bytes = max(0, bytes - ?)
  where id = 1
`;

type StoredRow = {
  bytes: number;
  report: string;
  schema_version: number;
  app_version: string | null;
  platform: string | null;
  arch: string | null;
  utc_offset_minutes: number | null;
};

function isSameContent(row: StoredRow, next: UsageResearchReport): boolean {
  return row.report === next.report
    && Number(row.schema_version) === USAGE_RESEARCH_SCHEMA_VERSION
    && row.app_version === next.appVersion
    && row.platform === next.platform
    && row.arch === next.arch
    && Number(row.utc_offset_minutes) === next.utcOffsetMinutes;
}

export type UsageResearchRequestOptions = {
  now?: () => number;
};

/**
 * Write the row as a compare-and-swap on the size the storage claim was
 * computed from, and return `changes`.
 *
 * - No row was read: a plain insert that does nothing on conflict, so a
 *   concurrent first send that got there first is not overwritten.
 * - A row was read: an update that matches only while the row still has the
 *   `bytes` that were read. A concurrent write that changed the row in
 *   between, or a row deleted in between, matches nothing.
 *
 * Either way `changes === 0` means the claimed delta no longer describes the
 * table, so the caller refunds it. That is what keeps the running total equal
 * to `sum(bytes)` under concurrent writes to one install and day.
 */
async function writeRow(
  db: D1Database,
  report: UsageResearchReport,
  existing: StoredRow | null,
  now: number,
): Promise<number> {
  if (!existing) {
    const inserted = await db.prepare(`
      insert into usage_research_daily (
        install_id, day, schema_version, app_version, platform, arch,
        utc_offset_minutes, report, bytes, received_at, updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(install_id, day) do nothing
    `).bind(
      report.installId,
      report.day,
      USAGE_RESEARCH_SCHEMA_VERSION,
      report.appVersion,
      report.platform,
      report.arch,
      report.utcOffsetMinutes,
      report.report,
      report.storedBytes,
      now,
      now,
    ).run();
    return inserted.meta?.changes ?? 0;
  }
  // `received_at` is deliberately absent: it records the FIRST arrival, and a
  // re-send only moves `updated_at`.
  const updated = await db.prepare(`
    update usage_research_daily set
      schema_version = ?,
      app_version = ?,
      platform = ?,
      arch = ?,
      utc_offset_minutes = ?,
      report = ?,
      bytes = ?,
      updated_at = ?
    where install_id = ? and day = ? and bytes = ?
  `).bind(
    USAGE_RESEARCH_SCHEMA_VERSION,
    report.appVersion,
    report.platform,
    report.arch,
    report.utcOffsetMinutes,
    report.report,
    report.storedBytes,
    now,
    report.installId,
    report.day,
    Number(existing.bytes),
  ).run();
  return updated.meta?.changes ?? 0;
}

/**
 * Status codes (the client mirrors these):
 *
 * - `201 {ok, stored:"inserted"}`: the first report for this install and day.
 * - `200 {ok, stored:"replaced"}`: a re-send. When the content is identical,
 *   nothing is written and no budget is claimed.
 * - `400 usage_research_invalid` (also a body stream that broke mid-read),
 *   `405 …_method_not_allowed`, `413 …_too_large`,
 *   `415 …_unsupported_media_type`.
 * - `429 …_identity_limit` / `…_daily_limit` / `…_storage_full`, each with
 *   `retry-after` set to the seconds until the next UTC midnight.
 * - `503 usage_research_unavailable`: no D1 binding, D1 refused a statement,
 *   or a concurrent write to the same install and day won the race.
 */
export async function handleUsageResearchRequest(
  request: Request,
  env: UsageResearchEnv,
  options: UsageResearchRequestOptions = {},
): Promise<Response> {
  // Exactly one log line per request: every refusal goes through `refuse`, and
  // the three success paths log themselves.
  let bytes = 0;
  const refuse = (
    status: number,
    error: string,
    reason: string,
    headers?: Record<string, string>,
  ): Response => {
    logUsageResearchUpload({ outcome: "rejected", status, reason, bytes });
    return json({ error }, status, headers);
  };

  if (request.method !== "POST") {
    return refuse(405, USAGE_RESEARCH_ERRORS.methodNotAllowed, "method_not_allowed", { allow: "POST" });
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return refuse(415, USAGE_RESEARCH_ERRORS.unsupportedMediaType, "unsupported_media_type");
  }
  const db = env.DB;
  if (!db) return refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "no_database");

  let body: Awaited<ReturnType<typeof readBoundedBody>>;
  try {
    body = await readBoundedBody(request, MAX_USAGE_RESEARCH_BODY_BYTES);
  } catch {
    // The stream broke mid-read, almost always a client that went away. There
    // is nobody to read the answer; the point is the one log line.
    return refuse(400, USAGE_RESEARCH_ERRORS.invalid, "body_unreadable");
  }
  if (!body.ok) {
    bytes = MAX_USAGE_RESEARCH_BODY_BYTES;
    return refuse(413, USAGE_RESEARCH_ERRORS.tooLarge, "body_too_large");
  }
  bytes = byteLength(body.text);

  const now = options.now?.() ?? Date.now();
  const parsed = parseUsageResearchBody(body.text, now);
  if (!parsed.ok) {
    return parsed.status === 413
      ? refuse(413, USAGE_RESEARCH_ERRORS.tooLarge, parsed.reason)
      : refuse(400, USAGE_RESEARCH_ERRORS.invalid, parsed.reason);
  }
  const report = parsed.value;
  bytes = report.reportBytes;

  let existing: StoredRow | null;
  try {
    existing = await db.prepare(`
      select bytes, report, schema_version, app_version, platform, arch, utc_offset_minutes
      from usage_research_daily
      where install_id = ? and day = ?
    `).bind(report.installId, report.day).first<StoredRow>();
  } catch {
    return refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "lookup_failed");
  }

  // Idempotent re-send: the row already says exactly this. The answer is the
  // same `replaced` a changed re-send gets, since the row is what was sent, but
  // nothing is written, so no budget is claimed. A client retrying a send whose
  // response it lost costs one read, and counts against no quota.
  if (existing && isSameContent(existing, report)) {
    logUsageResearchUpload({ outcome: "unchanged", status: 200, bytes });
    return json({ ok: true, stored: "replaced" }, 200);
  }

  const dayKey = utcDayKey(now);
  const retryAfter = { "retry-after": String(secondsUntilNextUtcDay(now)) };

  // A stopped or spent fleet answers from a read, before anything is claimed.
  // Claiming first and refunding would still write two rows per refusal, and
  // a kill switch that keeps writing to the database it protects is not one.
  const fleetLimit = dailyGlobalLimit(env);
  if (fleetLimit <= 0) return refuse(429, USAGE_RESEARCH_ERRORS.dailyLimit, "daily_limit", retryAfter);
  let fleetRow: { writes: number } | null;
  try {
    fleetRow = await db.prepare("select writes from usage_research_days where day = ?")
      .bind(dayKey)
      .first<{ writes: number }>();
  } catch {
    return refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "fleet_budget_unavailable");
  }
  if (Number(fleetRow?.writes ?? 0) >= fleetLimit) {
    return refuse(429, USAGE_RESEARCH_ERRORS.dailyLimit, "daily_limit", retryAfter);
  }

  // Order matters. The caller's own quota comes first, so one sender hammering
  // its limit cannot spend the fleet's budget. The fleet slot and the storage
  // bytes come before the write, which is what makes both caps unraceable.
  // Each refusal returns the claims taken before it.
  const identity = await quotaIdentity(request, dayKey);
  const identityClaim = await claimIdentitySlot(db, dayKey, identity);
  if (identityClaim !== "ok") {
    return identityClaim === "exhausted"
      ? refuse(429, USAGE_RESEARCH_ERRORS.identityLimit, "identity_limit", retryAfter)
      : refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "identity_quota_unavailable");
  }

  const fleetClaim = await claimFleetSlot(db, dayKey, fleetLimit);
  if (fleetClaim !== "ok") {
    await refund(db, REFUND_IDENTITY_SQL, dayKey, identity);
    // A distinct body from the identity 429, as in diagnostics. Only one of
    // the two is about the caller, and backing off its own sends only helps
    // with that one.
    return fleetClaim === "exhausted"
      ? refuse(429, USAGE_RESEARCH_ERRORS.dailyLimit, "daily_limit", retryAfter)
      : refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "fleet_budget_unavailable");
  }

  const delta = report.storedBytes - Number(existing?.bytes ?? 0);
  const storageClaim = await claimStorage(db, delta, storageCeilingBytes(env));
  if (storageClaim !== "ok") {
    await refund(db, REFUND_FLEET_SQL, dayKey);
    await refund(db, REFUND_IDENTITY_SQL, dayKey, identity);
    return storageClaim === "exhausted"
      ? refuse(429, USAGE_RESEARCH_ERRORS.storageFull, "storage_ceiling", retryAfter)
      : refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "storage_total_unavailable");
  }

  const refundAll = async (): Promise<void> => {
    await refund(db, REFUND_STORAGE_SQL, delta);
    await refund(db, REFUND_FLEET_SQL, dayKey);
    await refund(db, REFUND_IDENTITY_SQL, dayKey, identity);
  };
  let changes: number;
  try {
    changes = await writeRow(db, report, existing, now);
  } catch {
    await refundAll();
    return refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "write_failed");
  }
  if (changes !== 1) {
    // Another write to this install and day landed between the read and this
    // one. Its own claim already moved the total, so this one gives back all
    // of its claims; the client retries next hour against the new row.
    await refundAll();
    return refuse(503, USAGE_RESEARCH_ERRORS.unavailable, "write_conflict");
  }

  const inserted = existing === null;
  const status = inserted ? 201 : 200;
  logUsageResearchUpload({ outcome: inserted ? "inserted" : "replaced", status, bytes });
  return json({ ok: true, stored: inserted ? "inserted" : "replaced" }, status);
}

export type UsageResearchSweepResult = {
  /** Report rows deleted for being older than the retention window. */
  reports: number;
  /** Fleet-budget rows deleted (older than seven days). */
  budgetDays: number;
  /** Identity-quota rows deleted (any day before today). */
  identityDays: number;
};

/**
 * Cron sweep, once a minute from the Worker's scheduled handler.
 *
 * One D1 batch, which D1 runs as a single transaction. The first statement
 * subtracts the bytes of the oldest `USAGE_RESEARCH_SWEEP_BATCH_ROWS` expired
 * reports from the running total, and the second deletes exactly those rows.
 * Both select the same rows by the same primary-key order inside one
 * transaction, so the total and the table cannot drift apart here. The
 * delete names its rows through a subquery because D1 caps a statement at 100
 * bound parameters and `DELETE … LIMIT` needs a compile option D1 does not
 * promise.
 *
 * The retention cutoff is on the report's own `day`, and `day < cutoff` keeps
 * the cutoff day itself. Budget rows are keyed on the UTC day of RECEIPT. Only
 * today's row is ever read, and the week of history answers support questions
 * about a fleet-wide refusal. Identity rows hold day-salted hashes that nothing
 * reads after their day ends, so they go at the first sweep of the next day.
 */
export async function cleanupUsageResearch(
  env: Pick<UsageResearchEnv, "DB" | "USAGE_RESEARCH_RETENTION_DAYS">,
  nowMs = Date.now(),
): Promise<UsageResearchSweepResult> {
  const db = env.DB;
  if (!db) return { reports: 0, budgetDays: 0, identityDays: 0 };
  const reportCutoff = utcDayKey(nowMs - usageResearchRetentionDays(env) * DAY_MS);
  const budgetCutoff = utcDayKey(nowMs - USAGE_RESEARCH_BUDGET_RETENTION_DAYS * DAY_MS);
  const identityCutoff = utcDayKey(nowMs);
  const results = await db.batch([
    db.prepare(`
      update usage_research_totals
      set bytes = max(0, bytes - (
        select coalesce(sum(bytes), 0) from (
          select bytes from usage_research_daily
          where day < ?
          order by day, install_id
          limit ?
        )
      ))
      where id = 1
    `).bind(reportCutoff, USAGE_RESEARCH_SWEEP_BATCH_ROWS),
    db.prepare(`
      delete from usage_research_daily
      where (install_id, day) in (
        select install_id, day from usage_research_daily
        where day < ?
        order by day, install_id
        limit ?
      )
    `).bind(reportCutoff, USAGE_RESEARCH_SWEEP_BATCH_ROWS),
    db.prepare("delete from usage_research_days where day < ?").bind(budgetCutoff),
    db.prepare("delete from usage_research_identity_days where day < ?").bind(identityCutoff),
  ]);
  return {
    reports: results[1]?.meta.changes ?? 0,
    budgetDays: results[2]?.meta.changes ?? 0,
    identityDays: results[3]?.meta.changes ?? 0,
  };
}
