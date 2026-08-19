import { verifyCallerToken, type Env } from "./directory";

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
export type DiagnosticsEnv = Env & { DIAGNOSTICS?: R2Bucket };

export const DIAGNOSTICS_UPLOAD_PATH = "/diagnostics/upload";

/**
 * Hard cap on one report. Real reports are tens of kilobytes (log tails are
 * already truncated by the collector), so half a megabyte is far above the
 * honest ceiling and far below anything worth storing by accident.
 */
export const MAX_DIAGNOSTIC_REPORT_BYTES = 512 * 1024;

/** Uploads one identity may store per UTC day. */
export const MAX_DIAGNOSTIC_UPLOADS_PER_DAY = 5;

const MAX_METADATA_CHARS = 200;
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
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

function clientIdentity(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown-client";
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

function logDiagnosticsUpload(args: {
  outcome: "stored" | "rejected";
  status: number;
  reason?: string;
  identity: string;
  authenticated: boolean;
  bytes: number;
}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "ade-account-directory",
    kind: "diagnostics_upload",
    outcome: args.outcome,
    status: args.status,
    ...(args.reason ? { reason: args.reason } : {}),
    // The identity is already a hash for anonymous callers; a signed-in one is
    // truncated for the same reason every other log line here truncates.
    identity: args.identity.slice(0, 24),
    authenticated: args.authenticated,
    bytes: args.bytes,
  }));
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
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const bucket = env.DIAGNOSTICS;
  if (!bucket) {
    // The bucket is created as a deploy step (see the README). Until it exists
    // the button must fail politely rather than 500.
    return json({ error: "diagnostics upload unavailable" }, 503);
  }

  // Authentication is OPTIONAL, but a token that was SENT and does not verify
  // is an error rather than a downgrade: silently storing that report as
  // anonymous would hide a broken sign-in from the very user reporting it.
  let userId: string | null = null;
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? null;
  if (bearer) {
    try {
      userId = await verifyCallerToken(bearer, env);
    } catch {
      return json({ error: "invalid token" }, 401);
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
    return json({ error: "report too large" }, 413);
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
    return json({ error: "missing report" }, 400);
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
    });
    return new Response(
      JSON.stringify({ error: "rate limited" }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "86400",
          ...corsHeaders(),
        },
      },
    );
  }

  const id = options.randomId?.() ?? crypto.randomUUID();
  await bucket.put(`${prefix}${id}.md`, parsed.report, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: {
      ...(userId ? { userId } : {}),
      ...(parsed.installId ? { installId: parsed.installId } : {}),
      ...(parsed.appVersion ? { appVersion: parsed.appVersion } : {}),
    },
  });

  logDiagnosticsUpload({
    outcome: "stored",
    status: 200,
    identity,
    authenticated: Boolean(userId),
    bytes: parsed.report.length,
  });
  // Only the id goes back. The report is never echoed: a route that returned
  // what it stored would be a way to read other people's uploads the moment an
  // id leaked.
  return json({ ok: true, id });
}
