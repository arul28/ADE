import { isAuthenticationUnavailableError, verifyCallerToken } from "./callerToken";
import type { Env } from "./directory";
import { logDiagnosticsUpload } from "./logging";
import { isLoopbackHostname } from "./trustedOrigin";

/**
 * `POST /diagnostics/upload` — the one-click destination for ADE's already
 * redacted diagnostic report.
 *
 * The report is built and redacted entirely on the user's machine
 * (`apps/ade-cli/src/services/diagnostics/diagnosticReport.ts`), so this route
 * is a write-only sink: it stores bytes it never parses, never indexes and
 * never echoes back. That property is what lets it accept anonymous uploads at
 * all — the alternative is asking a user whose ADE will not start to sign in
 * first, which is exactly the support round-trip this route exists to remove.
 */

/** R2 is optional in the binding type so a Worker deployed before the bucket exists degrades instead of crashing. */
export type DiagnosticsEnv = Env & {
  DIAGNOSTICS?: R2Bucket;
  /** Fleet-wide uploads allowed per UTC day; see `DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT`. */
  DIAGNOSTICS_DAILY_GLOBAL_LIMIT?: string;
};

export const DIAGNOSTICS_UPLOAD_PATH = "/diagnostics/upload";

/**
 * Hard cap on one upload. Real reports are tens of kilobytes (log tails are
 * already truncated by the collector), so half a megabyte is far above the
 * honest ceiling and far below anything worth storing by accident.
 *
 * Applied to the WHOLE request body, because the bytes have to be bounded as
 * they arrive, before anything is parsed. Senders mirror this number in
 * `apps/desktop/src/shared/diagnosticsUpload.ts` and weigh their serialized
 * body against it for that reason — a report that fits with no room for the
 * `{"report":...}` envelope does not fit here.
 */
export const MAX_DIAGNOSTIC_REPORT_BYTES = 512 * 1024;

/** Uploads one identity may store per UTC day. */
export const MAX_DIAGNOSTIC_UPLOADS_PER_DAY = 5;

/**
 * Uploads the WHOLE FLEET may store per UTC day, when
 * `DIAGNOSTICS_DAILY_GLOBAL_LIMIT` is unset or unreadable.
 *
 * The per-identity quota above bounds one caller. This one bounds the bill.
 * Clients now send reports automatically on failure, so a bug that fires for
 * every install at once multiplies "five each" by the install base, and this
 * Worker is the only writer the bucket has — which means this number IS the
 * spend cap rather than an estimate of one:
 *
 *   400 uploads/day × 512 KB/upload × 30-day bucket lifecycle ≈ 6 GB steady
 *   state, against R2's 10 GB free tier.
 *
 * Raising it is a deliberate act with arithmetic attached; see the README.
 */
export const DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT = 400;

/**
 * How many days of budget rows the cron sweep keeps.
 *
 * Only today's row is ever read, so the rest is history kept for one reason: a
 * support question about a fleet-wide refusal is asked days after it happened.
 * A week covers that and keeps the table permanently tiny.
 */
export const DIAGNOSTICS_BUDGET_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

const MAX_METADATA_CHARS = 200;

/**
 * Shape of a `failureCode`, and the whole validation it gets.
 *
 * It is a client-supplied label for an automatic send ("brain_start_timeout"),
 * so it is bound to a shape that is safe as an R2 custom-metadata header value
 * and as a log field, and anything else is DROPPED rather than refused: a
 * report that arrives with a malformed label is still the report support needs,
 * and failing the upload over a cosmetic field would be the auto-send path
 * losing exactly the diagnostics it exists to collect.
 */
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
/**
 * Bound on the per-isolate counter map. An isolate that has seen more distinct
 * uploaders than this is being probed, not used; dropping the whole map costs
 * only the fast path, because the R2 listing below is the authority.
 */
const MAX_TRACKED_IDENTITIES = 5_000;

type DailyUploadCount = { dayKey: string; count: number };

/**
 * Per-isolate upload counters.
 *
 * TRADEOFF, deliberately taken: the device flow rate-limits through a D1 table
 * (`device_approval_rate_limits`), which is durable and global but needs a
 * migration. This route is additive and ships without one, so the limit is
 * enforced in two weaker layers that together are good enough for an abuse
 * bound on a write-only sink:
 *
 * 1. This map — free and exact, but scoped to one isolate and lost when
 *    Cloudflare recycles it.
 * 2. An R2 `list()` on the identity's prefix for the day (below) — durable and
 *    global, and the layer that actually holds the line. It costs one class-A
 *    operation per upload and is not transactional, so a burst of genuinely
 *    simultaneous requests can land a few objects over the cap. For a quota
 *    whose purpose is "one person cannot fill the bucket", overshooting five
 *    by a couple is not a failure mode worth a migration.
 *
 * If diagnostics volume ever justifies exact global counting, move this to the
 * D1 table pattern the device flow already uses.
 */
const isolateUploadCounts = new Map<string, DailyUploadCount>();

/** Same `(value, init)` shape as `directory.ts`'s `json`, so the name means one thing here. */
function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Open CORS, on purpose and only here.
 *
 * The desktop "Send to ADE" button runs in Electron's renderer, whose origin is
 * `file://` in a packaged build (`Origin: null`) and `http://localhost:5173` in
 * development, so no fixed allow-list can name it. `*` is safe for this route
 * specifically: it accepts a body and returns an opaque id, it never reads
 * account state, and `*` is incompatible with `credentials: "include"`, so no
 * browser will ever attach ambient cookies to it. Every account route keeps its
 * exact-origin rule in `directory.ts`.
 */
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    vary: "Origin",
  };
}

export function isDiagnosticsRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === DIAGNOSTICS_UPLOAD_PATH;
}

/**
 * Cloudflare sets `cf-connecting-ip` and a client cannot influence it. Off
 * Cloudflare — a local dev run, a proxy in front — there is no trustworthy
 * address at all, so everyone shares one bucket rather than falling back to
 * `x-forwarded-for`: a quota keyed on a header the caller writes is not a quota.
 */
function clientIdentity(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown-client";
}

/**
 * A drive-by POST from some other site's page, which no real ADE client is.
 *
 * `sec-fetch-site` is attached by the browser and cannot be set by the page, so
 * it is the one honest signal here. ADE's own senders are unaffected: the CLI
 * and any non-browser fetch send no such header at all, and the desktop button
 * runs in Electron's renderer, whose two origin shapes — `null` from `file://`
 * in a packaged build and loopback in development — are exempted rather than
 * named by hostname, because that renderer is cross-site to this Worker too.
 */
function isCrossSiteBrowserUpload(request: Request): boolean {
  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() !== "cross-site") return false;
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!origin || origin === "null") return false;
  try {
    return !isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return true;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The key segment that both names the uploader and *is* the rate-limit bucket.
 *
 * Signed in, it is the Clerk user id, so support can find every report a user
 * sent. Anonymous, it is a hash of the caller's IP rather than the install id
 * the report carries: an install id is client-supplied and a spammer would
 * simply mint a new one per request, whereas the address is the thing the quota
 * is actually meant to bound. The install id still travels, as metadata.
 */
async function uploadIdentity(request: Request, userId: string | null): Promise<string> {
  if (userId) {
    const safe = userId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    if (safe) return `u-${safe}`;
  }
  return `anon-${(await sha256Hex(clientIdentity(request))).slice(0, 16)}`;
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Seconds until the fleet budget resets.
 *
 * Unix time has no leap seconds, so `nowMs % DAY_MS` is exactly the time since
 * UTC midnight and this is the honest number rather than the flat 86400 the
 * per-identity limit answers. A client refused at 23:59 should retry in a
 * minute, not tomorrow night.
 */
function secondsUntilNextUtcDay(nowMs: number): number {
  return Math.max(1, Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000));
}

/**
 * The configured fleet ceiling.
 *
 * An unset, empty, or unparseable value falls back to the default — a typo in a
 * var must not silently uncap the bill or silently close the route. `0` is
 * honored, on purpose: it is the kill switch that stops every upload without a
 * redeploy of code.
 */
function dailyGlobalLimit(env: DiagnosticsEnv): number {
  const raw = env.DIAGNOSTICS_DAILY_GLOBAL_LIMIT?.trim();
  if (!raw) return DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT;
}

type BudgetClaim = { ok: true } | { ok: false; reason: "exhausted" | "unavailable" };

/**
 * Claim one slot out of today's fleet budget, atomically.
 *
 * The increment and the check are ONE statement — the same upsert idiom
 * `checkDeviceRateLimit` uses — because a read followed by a write lets two
 * concurrent uploads both observe the last free slot, and a spend cap that can
 * be raced is not a cap. `changes === 1` is the whole proof: SQLite applies the
 * `where count < ?` to the `do update`, so a full day changes no row.
 *
 * FAILS CLOSED. A budget that cannot be counted is a budget that is not
 * enforced, and the whole point of this table is that no path to the bucket
 * bypasses it — so a D1 error refuses the upload rather than storing it
 * uncounted. The deploy scripts apply migrations before publishing, so the
 * window where the table does not exist is a deploy that has already failed.
 */
async function claimGlobalBudget(
  env: DiagnosticsEnv,
  dayKey: string,
  limit: number,
): Promise<BudgetClaim> {
  // A configured zero means "store nothing today"; there is no row to write for
  // an upload that will never happen.
  if (limit <= 0) return { ok: false, reason: "exhausted" };
  try {
    const claimed = await env.DB.prepare(`
      insert into diagnostics_upload_days (day, count)
      values (?, 1)
      on conflict(day) do update set count = count + 1
      where count < ?
    `).bind(dayKey, limit).run();
    return (claimed.meta?.changes ?? 0) === 1 ? { ok: true } : { ok: false, reason: "exhausted" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Give the slot back when the write it was claimed for did not happen.
 *
 * The claim has to precede the `put` — that ordering is what makes the cap
 * unraceable — so an R2 failure would otherwise burn budget for bytes nobody
 * can ever read. `count > 0` keeps the row from going negative if a refund ever
 * arrives without a matching claim, and a failed refund is swallowed: the
 * caller is already being told the upload failed, and turning that into a 500
 * would trade an accurate error for a confusing one. The cost of losing a
 * refund is one slot out of the day, which is the safe direction.
 */
async function refundGlobalBudget(env: DiagnosticsEnv, dayKey: string): Promise<void> {
  try {
    await env.DB.prepare(
      "update diagnostics_upload_days set count = count - 1 where day = ? and count > 0",
    ).bind(dayKey).run();
  } catch {
    // Best effort by design; see above.
  }
}

/**
 * Cron sweep: budget rows are write-once-a-day and read only for today.
 *
 * Lexicographic comparison is correct here because the key is a fixed-width
 * ISO date. Today's row is never in range, so a sweep can never free budget the
 * running day has already spent.
 */
export async function cleanupDiagnosticsUploadDays(
  env: { DB: D1Database },
  nowMs = Date.now(),
): Promise<number> {
  const cutoff = utcDayKey(nowMs - DIAGNOSTICS_BUDGET_RETENTION_DAYS * DAY_MS);
  const result = await env.DB
    .prepare("delete from diagnostics_upload_days where day < ?")
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}

function boundedMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // R2 stores custom metadata as HTTP header values, so a control character
  // would be rejected (or silently mangled) at write time. Replaced rather
  // than escaped: this is a label a human reads off the object, not data.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_METADATA_CHARS);
}

/**
 * Was this report sent by a human pressing a button, or by the client deciding
 * on its own that something had broken?
 *
 * Both shapes have to be read because both senders exist: a JSON body carries a
 * real boolean, and the `text/plain` path can only say `?auto=1`. Absent — or
 * anything unrecognized — means manual, which is what every sender that shipped
 * before this flag existed is.
 */
function parseAutoFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/** A `failureCode` that matches `FAILURE_CODE_PATTERN`, or nothing at all. */
function boundedFailureCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return FAILURE_CODE_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Reads at most `MAX_DIAGNOSTIC_REPORT_BYTES + 1` bytes.
 *
 * `content-length` is checked first because it makes the common rejection free,
 * but it is never trusted on its own: a chunked upload carries no length at
 * all, so the stream is counted as it arrives and abandoned the moment it
 * crosses the cap. Buffering whatever the client claimed to send would be the
 * bug the cap exists to prevent.
 */
async function readBoundedBody(
  request: Request,
): Promise<{ ok: true; text: string } | { ok: false; reason: "too_large" }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DIAGNOSTIC_REPORT_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  const body = request.body;
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_DIAGNOSTIC_REPORT_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

type ParsedUpload = {
  report: string;
  installId?: string;
  appVersion?: string;
  /** True when the client sent this on its own; false is a human pressing send. */
  auto: boolean;
  failureCode?: string;
};

/**
 * Two body shapes, because the two senders want different things: the CLI and
 * the desktop button post JSON so they can name the install and app version,
 * and `text/plain` stays supported so a report can be piped straight in with
 * `curl --data-binary @report.md` when someone is debugging this route.
 */
function parseUpload(contentType: string, raw: string, url: URL): ParsedUpload | null {
  const isJson = contentType.toLowerCase().includes("application/json");
  let fields: Record<string, unknown> = {};
  let report: string | null = raw;
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    fields = parsed as Record<string, unknown>;
    report = typeof fields.report === "string" ? fields.report : null;
  }
  if (report === null || !report.trim()) return null;
  return {
    report,
    installId: boundedMetadata(fields.installId ?? url.searchParams.get("installId")),
    appVersion: boundedMetadata(fields.appVersion ?? url.searchParams.get("appVersion")),
    // `??` rather than `||` so an explicit `auto: false` in the body is honored
    // instead of falling through to a query parameter that says otherwise.
    auto: parseAutoFlag(fields.auto ?? url.searchParams.get("auto")),
    failureCode: boundedFailureCode(fields.failureCode ?? url.searchParams.get("failureCode")),
  };
}

async function withinDailyLimit(
  bucket: R2Bucket,
  identity: string,
  prefix: string,
  dayKey: string,
): Promise<boolean> {
  const remembered = isolateUploadCounts.get(identity);
  const rememberedCount = remembered?.dayKey === dayKey ? remembered.count : 0;
  if (rememberedCount >= MAX_DIAGNOSTIC_UPLOADS_PER_DAY) return false;

  // The durable half of the limit. `limit` stops one greedy prefix from
  // listing an unbounded page just to answer a yes/no question.
  const listed = await bucket.list({ prefix, limit: MAX_DIAGNOSTIC_UPLOADS_PER_DAY + 1 });
  const stored = listed.objects.length;
  const count = Math.max(stored, rememberedCount);
  if (isolateUploadCounts.size >= MAX_TRACKED_IDENTITIES) isolateUploadCounts.clear();
  isolateUploadCounts.set(identity, {
    dayKey,
    count: count >= MAX_DIAGNOSTIC_UPLOADS_PER_DAY ? count : count + 1,
  });
  return count < MAX_DIAGNOSTIC_UPLOADS_PER_DAY;
}

export type DiagnosticsRequestOptions = {
  now?: () => number;
  randomId?: () => string;
};

export async function handleDiagnosticsRequest(
  request: Request,
  env: DiagnosticsEnv,
  options: DiagnosticsRequestOptions = {},
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(),
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-ade-correlation-id",
        "access-control-max-age": "600",
      },
    });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, { status: 405 });
  if (isCrossSiteBrowserUpload(request)) {
    return json({ error: "cross-site upload not allowed" }, { status: 403 });
  }

  const bucket = env.DIAGNOSTICS;
  if (!bucket) {
    // The bucket is created as a deploy step (see the README). Until it exists
    // the button must fail politely rather than 500.
    return json({ error: "diagnostics upload unavailable" }, { status: 503 });
  }

  // Authentication is OPTIONAL, but a token that was SENT and does not verify
  // is an error rather than a downgrade: silently storing that report as
  // anonymous would hide a broken sign-in from the very user reporting it.
  // That applies to the header shape as much as to the signature — an
  // `Authorization` this route cannot parse is a client that believes it is
  // signed in, so it is refused rather than quietly demoted to anonymous.
  let userId: string | null = null;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearer = authorization.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? null;
  if (authorization && !bearer) return json({ error: "invalid token" }, { status: 401 });
  if (bearer) {
    try {
      userId = await verifyCallerToken(bearer, env);
    } catch (error) {
      // A Worker with no JWKS URL configured is a deployment fault, not a bad
      // token; the account routes answer 503 for it and so does this one.
      return isAuthenticationUnavailableError(error)
        ? json({ error: "authentication unavailable" }, { status: 503 })
        : json({ error: "invalid token" }, { status: 401 });
    }
  }

  const body = await readBoundedBody(request);
  const identity = await uploadIdentity(request, userId);
  if (!body.ok) {
    logDiagnosticsUpload({
      outcome: "rejected",
      status: 413,
      reason: "too_large",
      identity,
      authenticated: Boolean(userId),
      bytes: MAX_DIAGNOSTIC_REPORT_BYTES,
    });
    return json({ error: "report too large" }, { status: 413 });
  }

  const url = new URL(request.url);
  const parsed = parseUpload(request.headers.get("content-type") ?? "", body.text, url);
  if (!parsed) {
    logDiagnosticsUpload({
      outcome: "rejected",
      status: 400,
      reason: "empty_report",
      identity,
      authenticated: Boolean(userId),
      bytes: body.text.length,
    });
    return json({ error: "missing report" }, { status: 400 });
  }

  const now = options.now?.() ?? Date.now();
  const dayKey = utcDayKey(now);
  const prefix = `reports/${dayKey}/${identity}/`;
  if (!(await withinDailyLimit(bucket, identity, prefix, dayKey))) {
    logDiagnosticsUpload({
      outcome: "rejected",
      status: 429,
      reason: "rate_limited",
      identity,
      authenticated: Boolean(userId),
      bytes: parsed.report.length,
      auto: parsed.auto,
      failureCode: parsed.failureCode,
    });
    return json({ error: "rate limited" }, {
      status: 429,
      headers: { "retry-after": "86400" },
    });
  }

  // The fleet ceiling is claimed AFTER the per-caller quota and BEFORE the put.
  //
  // After, because one caller hammering their own limit must not be able to
  // spend the fleet's budget on requests that were never going to be stored —
  // that would turn a per-caller abuse bound into a fleet-wide denial of
  // service. Before, because the claim is what makes the cap real: every byte
  // that reaches the bucket passes through this statement first, so the day's
  // stored count cannot exceed the day's claimed count.
  const budget = await claimGlobalBudget(env, dayKey, dailyGlobalLimit(env));
  if (!budget.ok) {
    const exhausted = budget.reason === "exhausted";
    logDiagnosticsUpload({
      outcome: "rejected",
      status: exhausted ? 429 : 503,
      reason: exhausted ? "global_budget_exhausted" : "budget_unavailable",
      identity,
      authenticated: Boolean(userId),
      bytes: parsed.report.length,
      auto: parsed.auto,
      failureCode: parsed.failureCode,
    });
    // A DISTINCT 429 body from the per-caller one above. Both mean "not now",
    // but only one of them is about the caller: a client that cannot tell them
    // apart cannot decide whether backing off its own sends would help, and an
    // auto-sender that treats a fleet-wide stop as its own quota would keep
    // retrying forever.
    return exhausted
      ? json({ error: "daily diagnostics budget exhausted" }, {
        status: 429,
        headers: { "retry-after": String(secondsUntilNextUtcDay(now)) },
      })
      : json({ error: "diagnostics upload unavailable" }, { status: 503 });
  }

  const id = options.randomId?.() ?? crypto.randomUUID();
  try {
    await bucket.put(`${prefix}${id}.md`, parsed.report, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: {
        ...(userId ? { userId } : {}),
        ...(parsed.installId ? { installId: parsed.installId } : {}),
        ...(parsed.appVersion ? { appVersion: parsed.appVersion } : {}),
        // Only written when true, so a manual upload's metadata is exactly what
        // it was before this flag existed.
        ...(parsed.auto ? { auto: "true" } : {}),
        ...(parsed.failureCode ? { failureCode: parsed.failureCode } : {}),
      },
    });
  } catch {
    // R2 refused the write. Left unhandled this is the one path that answers
    // without a line, which defeats the point of the log: support could no
    // longer tell "the report never arrived" from "it arrived and the store
    // dropped it". `rejected` because the outcome vocabulary has exactly two
    // values and nothing was stored; the reason carries that this one is ours,
    // not the caller's. 502 rather than the 503 the missing-binding path uses,
    // so a configured bucket having a bad minute stays distinguishable from a
    // bucket that was never created.
    //
    // The budget slot claimed a moment ago is given back: nothing was stored,
    // so nothing should have been spent, and a bucket having a bad hour must
    // not quietly consume the day's ceiling for reports that do not exist.
    await refundGlobalBudget(env, dayKey);
    logDiagnosticsUpload({
      outcome: "rejected",
      status: 502,
      reason: "storage_write_failed",
      identity,
      authenticated: Boolean(userId),
      bytes: parsed.report.length,
      auto: parsed.auto,
      failureCode: parsed.failureCode,
    });
    return json({ error: "diagnostics upload failed" }, { status: 502 });
  }

  logDiagnosticsUpload({
    outcome: "stored",
    status: 200,
    identity,
    authenticated: Boolean(userId),
    bytes: parsed.report.length,
    auto: parsed.auto,
    failureCode: parsed.failureCode,
  });
  // Only the id goes back. The report is never echoed: a route that returned
  // what it stored would be a way to read other people's uploads the moment an
  // id leaked.
  return json({ ok: true, id });
}
